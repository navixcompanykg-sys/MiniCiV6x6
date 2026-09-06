// Протокол: один тип сообщения на каждое направление (см. план — сложность делегируется Этапу 2).
//
// Клиент → сервер:
//   { type: "create", players: {name,color,isAI?}[], autoPlayAI?: boolean }   — autoPlayAI: режим
//     «Против AI» (см. bot.ts driveAiTurns) вместо обычного хотсита
//   { type: "join", roomId: string }
//   { type: "action", action: string, playerId: number, payload: any }   — только после join/create
//     (action: "confirmAiTurn" — особый случай, не игровое действие, см. ниже про bot.ts/pendingAiPlan)
//   { type: "previewPath", requestId, playerId, unitId, col, row }       — см. ниже, отдельно от action
//   { type: "previewAttack", requestId, playerId, unitId, col, row }     — см. ниже, тот же приём для боя
//   { type: "saveSnapshot" }                                            — см. ниже, «Сохранить партию»
//
// Сервер → клиент:
//   { type: "joined", roomId, state }                    — ответ на create/join
//   { type: "state", state }                              — рассылается ВСЕМ в комнате после действия
//   { type: "result", ok, hint?, needsWarConfirm? }        — ТОЛЬКО инициатору действия
//   { type: "previewPathResult", requestId, path?, cost?, remainingBudget?, moveRange? } — ответ на previewPath
//   { type: "previewAttackResult", requestId, defender?, attacker? } — ответ на previewAttack
//   { type: "snapshotSaved", roomId }                     — ответ на saveSnapshot (id новой сохранённой копии)
//   { type: "error", message }
//
// previewPath — НЕ обычное действие (не идёт через dispatch/session.dispatch, ничего не мутирует и не
// сохраняется/не рассылается остальным) — по прямому запросу «при выборе клетки куда переместиться
// показывай маршрут и число ходов»: клиент шлёт его при каждой смене наведённого гекса, пока выбран
// свой юнит, а обычный "action"/"result" — строго один в один момент, без этого частые запросы
// наведения мышью либо блокировали бы очередь реальных действий, либо путали бы порядок ответов.
// requestId — клиент сам генерирует и просто игнорирует устаревшие ответы (не совпал с последним
// отправленным), не полагаясь на порядок доставки вообще.
//
// Хотсит — ОДНА вкладка действует за ВСЕХ игроков по очереди (все за одним экраном, ТЗ «За одним
// компьютером»), поэтому playerId НЕ привязывается к сокету при join/create (в отличие от настоящей
// многопользовательской комнаты, где у каждого подключения был бы свой игрок с проверкой личности —
// это Этап 2, симультанные ходы через интернет). Здесь клиенту доверяют то, каким игроком он
// представляется в каждом отдельном action-сообщении — ровно как сейчас в main.ts один и тот же
// браузер отдаёт команды за текущего currentPlayerIndex безо всякой аутентификации. Игровая логика
// (`GameSession.dispatch`) всё равно проверяет "это точно ход этого playerId?" в каждом методе — так
// что подмена id ничего не даёт, просто получит { ok: false, hint: "Сейчас не ваш ход." }.

import type { WebSocket, WebSocketServer } from "ws";
import { createRoom, getRoom, saveRoom, saveSnapshot } from "./rooms";
import type { GameSession } from "./GameSession";
import { prepareNextAiPlanIfNeeded, executeAiPlan, runAutoPlayLoop } from "./bot";

interface ClientInfo {
  roomId: string;
}

const clients = new Map<WebSocket, ClientInfo>();
const roomSockets = new Map<string, Set<WebSocket>>();

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(session: GameSession) {
  const sockets = roomSockets.get(session.id);
  if (!sockets) return;
  const msg = JSON.stringify({ type: "state", state: session.toJSON() });
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function joinRoomSocket(ws: WebSocket, roomId: string) {
  clients.set(ws, { roomId });
  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  roomSockets.get(roomId)!.add(ws);
}

/** Комнаты, где сейчас уже крутится фоновый цикл автоигры AI (см. runAutoPlayLoop) — только по
 * прямому запросу, режим «Против AI» (session.autoPlayAI). Не даёт запустить второй параллельный
 * цикл на ту же комнату (create/join/action могут прийти, пока предыдущий вызов ещё не завершился —
 * цикл асинхронный, с паузами между шагами, см. bot.ts). Чисто в памяти процесса, не персистится —
 * если сервер перезапустился посреди автохода, следующий join/action просто начнёт цикл заново. */
const autoAiRunning = new Set<string>();

/** Единая точка «что делать с ходом AI после действия» — ветвится по режиму партии (по прямому
 * запросу — «в режиме за одним столом игрок видит ходы ИИ... режим против AI игрок не видит»):
 * обычный хотсит останавливается на предпросмотре и ждёт кнопку (как раньше), «Против AI»
 * запускает фоновый автоцикл (fire-and-forget — не await'ится, чтобы не блокировать ответ на само
 * действие человека; цикл сам сохраняет/рассылает состояние после каждого своего шага). */
function driveAiTurns(session: GameSession) {
  if (session.autoPlayAI) {
    if (autoAiRunning.has(session.id)) return;
    autoAiRunning.add(session.id);
    runAutoPlayLoop(session, async () => {
      await saveRoom(session);
      broadcastState(session);
    }).finally(() => autoAiRunning.delete(session.id));
  } else {
    prepareNextAiPlanIfNeeded(session);
  }
}

export function attachGameProtocol(wss: WebSocketServer) {
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Некорректный JSON." });
        return;
      }

      try {
        if (msg.type === "create") {
          const players = msg.players as { name: string; color: number; isAI?: boolean }[];
          if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
            send(ws, { type: "error", message: "Нужно от 2 до 6 игроков." });
            return;
          }
          const session = await createRoom(players, !!msg.autoPlayAI);
          // Если самый первый игрок — бот (простой AI, см. bot.ts): расстановка (без карт, нечего
          // подсвечивать) доигрывается сама. Дальше — по режиму партии (см. driveAiTurns): хотсит
          // останавливается на предпросмотре хода и ждёт подтверждения кнопкой ("confirmAiTurn"),
          // «Против AI» доигрывает ходы бота сама в фоне, с паузой между действиями.
          driveAiTurns(session);
          await saveRoom(session);
          joinRoomSocket(ws, session.id);
          send(ws, { type: "joined", roomId: session.id, state: session.toJSON() });
          return;
        }

        if (msg.type === "join") {
          const session = await getRoom(msg.roomId);
          if (!session) {
            send(ws, { type: "error", message: `Комната "${msg.roomId}" не найдена.` });
            return;
          }
          // Сервер мог перезапуститься с зависшим на AI-ходе состоянием (pendingAiPlan и
          // autoAiRunning не персистятся, см. GameSession.ts/выше) — досчитываем/перезапускаем, если
          // сейчас снова очередь AI.
          driveAiTurns(session);
          joinRoomSocket(ws, session.id);
          send(ws, { type: "joined", roomId: session.id, state: session.toJSON() });
          return;
        }

        if (msg.type === "previewPath") {
          const info = clients.get(ws);
          if (!info) return;
          const session = await getRoom(info.roomId);
          if (!session) return;
          const preview = session.previewUnitPath(Number(msg.playerId), Number(msg.unitId), Number(msg.col), Number(msg.row));
          send(ws, { type: "previewPathResult", requestId: msg.requestId, ...(preview ?? {}) });
          return;
        }

        if (msg.type === "previewAttack") {
          const info = clients.get(ws);
          if (!info) return;
          const session = await getRoom(info.roomId);
          if (!session) return;
          const preview = session.previewAttackOutcome(Number(msg.playerId), Number(msg.unitId), Number(msg.col), Number(msg.row));
          send(ws, { type: "previewAttackResult", requestId: msg.requestId, ...(preview ?? {}) });
          return;
        }

        if (msg.type === "saveSnapshot") {
          const info = clients.get(ws);
          if (!info) return;
          const session = await getRoom(info.roomId);
          if (!session) return;
          const snapshotId = await saveSnapshot(session);
          send(ws, { type: "snapshotSaved", roomId: snapshotId });
          return;
        }

        if (msg.type === "action") {
          const info = clients.get(ws);
          if (!info) {
            send(ws, { type: "error", message: "Сначала join/create." });
            return;
          }
          const session = await getRoom(info.roomId);
          if (!session) {
            send(ws, { type: "error", message: "Комната пропала (перезапуск сервера?)." });
            return;
          }
          const playerId = Number(msg.playerId);

          // "confirmAiTurn" — не игровое действие (не идёт в GameSession.dispatch — оркестрация
          // бота, не игровая логика): нажатие кнопки «Подтвердить ход AI» в клиенте (по прямому
          // запросу — «AI сам пока не перематывает... все ходы совершаются после кнопки завершить
          // ход»). Реально совершает ход, ранее лишь показанный предпросмотром (session.pendingAiPlan),
          // затем — как и у обычного действия — доводит очередь до следующего игрока-человека или
          // до нового предпросмотра, если дальше снова AI.
          if (String(msg.action) === "confirmAiTurn") {
            const plan = session.pendingAiPlan;
            if (!plan || plan.playerId !== playerId || session.players[session.currentPlayerIndex]?.id !== playerId) {
              send(ws, { type: "result", ok: false, hint: "Нет ожидающего хода AI для этого игрока." });
              return;
            }
            executeAiPlan(session, playerId);
            send(ws, { type: "result", ok: true });
            driveAiTurns(session);
            await saveRoom(session);
            broadcastState(session);
            return;
          }

          const result = session.dispatch(String(msg.action), playerId, msg.payload ?? {});
          send(ws, { type: "result", ...result });
          if (result.ok) {
            await saveRoom(session);
            broadcastState(session); // отражаем СОБСТВЕННОЕ действие человека сразу, отдельно от того, что сделает driveAiTurns дальше
            // Если очередь после этого действия дошла до AI-игрока — по режиму партии либо считаем
            // и запоминаем предпросмотр его хода и ждём кнопку (хотсит), либо запускаем фоновый
            // автоцикл (см. driveAiTurns) — тот сам досохранит/разошлёт состояние по каждому шагу.
            driveAiTurns(session);
            if (!session.autoPlayAI) {
              await saveRoom(session);
              broadcastState(session);
            }
          }
          return;
        }

        send(ws, { type: "error", message: `Неизвестный тип сообщения: ${msg.type}` });
      } catch (err) {
        send(ws, { type: "error", message: `Ошибка сервера: ${String(err)}` });
      }
    });

    ws.on("close", () => {
      const info = clients.get(ws);
      if (info) roomSockets.get(info.roomId)?.delete(ws);
      clients.delete(ws);
    });
  });
}
