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
import { createRoom, getRoom, saveRoom, saveSnapshot, createWeGoLobby, getWeGoLobby, claimWeGoSlot, startWeGoLobby, generateToken, type WeGoLobby } from "./rooms";
import type { GameSession } from "./GameSession";
import { prepareNextAiPlanIfNeeded, executeAiPlan, runAutoPlayLoop } from "./bot";
import { toPrivateView } from "./privateView";
import * as weGo from "./weGoRuntime";
import type { RoundReport } from "./weGoRound";
import * as interleavedAi from "./interleavedAi";

interface ClientInfo {
  roomId: string;
  /** Только для WeGo-комнат (см. joinSlot/createWeGoRoom/reconnectSlot) — привязка подключения к
   * КОНКРЕТНОМУ игроку, в отличие от хотсита (см. заголовок файла), где это поле всегда null и
   * action просто доверяет тому playerId, что указал клиент. В WeGo действие от чужого playerId
   * отклоняется ещё до GameSession.dispatch, см. ниже. null — хотсит ИЛИ WeGo-зритель без слота. */
  playerId: number | null;
}

const clients = new Map<WebSocket, ClientInfo>();
const roomSockets = new Map<string, Set<WebSocket>>();
/** Таймер форс-резолюции текущего открытого WeGo-раунда комнаты (roundTimeSec) — отменяется, если
 * все живые люди сдали план раньше (см. readyForRound). Только в памяти процесса, как и весь
 * остальной раунд-рантайм (weGoRuntime.ts) — не персистится. */
const weGoRoundTimers = new Map<string, ReturnType<typeof setTimeout>>();

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(session: GameSession) {
  const sockets = roomSockets.get(session.id);
  if (!sockets) return;
  const msg = JSON.stringify({ type: "state", state: session.toJSON() });
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function joinRoomSocket(ws: WebSocket, roomId: string, playerId: number | null = null) {
  clients.set(ws, { roomId, playerId });
  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  roomSockets.get(roomId)!.add(ws);
}

// === WeGo — рассылка приватного состояния, лобби, таймер раунда ==================================

/** В отличие от broadcastState (хотсит — все видят всё), КАЖДЫЙ сокет получает toPrivateView под
 * СВОЙ playerId (чужие руки скрыты, своя — целиком; без слота — вид зрителя, вообще без рук). Если
 * передан report — только тому сокету, чей playerId есть в report.steps (свой отчёт по раунду,
 * остальные его не видят). deadlineAt/sessionDeadlineAt — для клиентского таймера обратного отсчёта
 * (UI-этап, пока не подключён — поля просто лежат в сообщении). */
function broadcastWeGoState(session: GameSession, report?: RoundReport) {
  const sockets = roomSockets.get(session.id);
  if (!sockets) return;
  const save = session.toJSON();
  for (const ws of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    const info = clients.get(ws);
    const viewerId = info?.playerId ?? null;
    const payload: Record<string, unknown> = {
      type: "state",
      state: toPrivateView(save, viewerId),
      deadlineAt: session.roundDeadline,
    };
    if (report && viewerId !== null && report.steps[viewerId]) {
      payload.report = { order: report.order, steps: report.steps[viewerId] };
    }
    ws.send(JSON.stringify(payload));
  }
}

function lobbyStateMessage(lobby: WeGoLobby) {
  return {
    type: "lobbyState",
    roomId: lobby.id,
    roundTimeSec: lobby.roundTimeSec,
    sessionTimeSec: lobby.sessionTimeSec,
    slots: lobby.slots.map((s) => ({ index: s.playerId, kind: s.kind, name: s.name, color: s.color, connected: s.connected })),
  };
}

function broadcastLobbyState(lobby: WeGoLobby) {
  const sockets = roomSockets.get(lobby.id);
  if (!sockets) return;
  const msg = JSON.stringify(lobbyStateMessage(lobby));
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}

/** Планирует форс-резолюцию текущего раунда через session.roundTimeMs — отменяет предыдущий таймер
 * этой комнаты, если был (readyForRound могло его уже почистить, но на всякий случай идемпотентно). */
function scheduleWeGoDeadline(session: GameSession) {
  const existing = weGoRoundTimers.get(session.id);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    void forceResolveWeGoRound(session.id);
  }, session.roundTimeMs);
  weGoRoundTimers.set(session.id, t);
}

/** Срабатывает по истечении раундового таймера — резолюция раунда как есть (неготовые живые люди
 * доигрываются AI, см. weGoRuntime.resolveOpenRound/weGoRound.computeAiTurnPlan), рассылка, и если
 * победитель ещё не объявлен — сразу открывается следующий раунд с новым таймером. */
async function forceResolveWeGoRound(roomId: string) {
  weGoRoundTimers.delete(roomId);
  const session = await getRoom(roomId);
  if (!session || session.mode !== "wego" || session.winner !== null || !weGo.hasOpenRound(session)) return;
  const now = Date.now();
  const report = weGo.resolveOpenRound(session, now);
  await saveRoom(session);
  broadcastWeGoState(session, report);
  if (session.winner === null) {
    weGo.openRound(session, now);
    await saveRoom(session);
    broadcastWeGoState(session);
    scheduleWeGoDeadline(session);
  }
}

/** Все "open" слоты только что закрылись (последним joinSlot ИЛИ явным startWeGoRoom хоста,
 * конвертирующим остаток в AI) — строит настоящую GameSession и открывает самый первый раунд.
 * Расстановка (`placement`) в WeGo намеренно остаётся ПОСЛЕДОВАТЕЛЬНОЙ, как в хотсите (см. комментарий
 * в обработчике "action" ниже) — раунд-движок включается только когда phase дойдёт до "playing". */
async function startAndBroadcastWeGoGame(lobby: WeGoLobby) {
  const session = await startWeGoLobby(lobby);
  broadcastLobbyState(lobby);
  broadcastWeGoState(session);
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
    (async () => {
      // «Против AI» + интерливинг (interleavedAi.ts, по прямому запросу — «имитируем
      // одновременность») — currentPlayerIndex, дойдя сюда естественным путём, может указывать на
      // AI, чей ход в ЭТОМ цикле УЖЕ полностью доигран интерливингом во время хода человека (см.
      // action-обработчик ниже). Такого пропускаем БЕЗ нового runAutoPlayLoop — тот заново раздал
      // бы карты/сбросил бюджет, задвоив уже применённое. Останавливаемся на первом ещё НЕ
      // доигранном AI (обычный случай — самый первый ход партии, если он сразу AI, до того как
      // человек вообще успел сходить хоть раз) — им runAutoPlayLoop отрабатывает как раньше.
      let guard = 0;
      let skipped = false;
      while (guard++ <= session.players.length) {
        const current = session.players[session.currentPlayerIndex];
        if (!current?.isAI || !interleavedAi.isDoneThisCycle(session, current.id)) break;
        session.advanceCurrentPlayer();
        skipped = true;
      }
      // Пропуск сам по себе мутирует currentPlayerIndex — если runAutoPlayLoop дальше окажется
      // нечего делать (все AI на очереди уже доиграны, впереди человек), это единственный шанс
      // сохранить/разослать сдвиг очереди, иначе индикатор «чей ход» на клиентах не обновится.
      if (skipped) {
        await saveRoom(session);
        broadcastState(session);
      }
      const beforeLoopIndex = session.currentPlayerIndex;
      await runAutoPlayLoop(session, async () => {
        await saveRoom(session);
        broadcastState(session);
      });
      // runAutoPlayLoop провёл ПОЛНЫМ старым ходом (реальный endTurn) каждого AI от beforeLoopIndex
      // до текущего currentPlayerIndex (там, где остановилась — человек или конец партии) — отмечаем
      // их доигранными в interleavedAi, иначе следующее действие человека (stepAllAi) дало бы им ЕЩЁ
      // один раунд действий в этом же цикле (задвоение раздачи карт/сброса бюджета).
      if (session.winner === null) {
        let idx = beforeLoopIndex;
        for (let i = 0; i < session.players.length && idx !== session.currentPlayerIndex; i++) {
          const p = session.players[idx];
          if (p.isAI) interleavedAi.markDone(session, p.id);
          idx = (idx + 1) % session.players.length;
        }
      }
    })().finally(() => autoAiRunning.delete(session.id));
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
          if (session.mode === "wego") {
            // Защита от утечки приватности (не только UX-заглушка): даже если клиент по ошибке/
            // старой логике зайдёт в WeGo-комнату обычным "join" (playerId не привязывается — см.
            // joinSlot/reconnectSlot для настоящего входа своим игроком), состояние всё равно уходит
            // ЧЕРЕЗ toPrivateView как зрителю (viewerId:null — вообще без чьей-либо руки), никогда
            // сырым session.toJSON().
            joinRoomSocket(ws, session.id, null);
            send(ws, { type: "joined", roomId: session.id, state: toPrivateView(session.toJSON(), null) });
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

        // === WeGo — лобби со слотами (отдельная ветка от create/join выше, см. заголовок файла) ===

        if (msg.type === "createWeGoRoom") {
          const slots = msg.slots as { kind: "human" | "ai" | "open"; name?: string; color?: number }[];
          if (!Array.isArray(slots) || slots.length < 2 || slots.length > 6) {
            send(ws, { type: "error", message: "Нужно от 2 до 6 слотов." });
            return;
          }
          // Слот 0 — сам создатель (та же вкладка, что шлёт createWeGoRoom): клиент обязан описать
          // себя первым слотом с kind:"human", иначе непонятно, за какого игрока привязывать ЭТОТ
          // сокет — остальные слоты люди заходят по ссылке позже (joinSlot).
          if (!slots[0] || slots[0].kind !== "human") {
            send(ws, { type: "error", message: 'Слот 0 обязан описывать создателя комнаты (kind: "human").' });
            return;
          }
          const roundTimeSec = Number(msg.roundTimeSec) || 180;
          const sessionTimeSec = Number(msg.sessionTimeSec) || 5400;
          const lobby = createWeGoLobby(slots, roundTimeSec, sessionTimeSec);
          const token = generateToken();
          lobby.slots[0].reconnectToken = token;
          joinRoomSocket(ws, lobby.id, 0);
          send(ws, { type: "joined", roomId: lobby.id, playerId: 0, reconnectToken: token });
          if (lobby.slots.every((s) => s.kind !== "open")) await startAndBroadcastWeGoGame(lobby);
          else broadcastLobbyState(lobby);
          return;
        }

        if (msg.type === "peekLobby") {
          // Только посмотреть состав слотов ДО присоединения (экран «Присоединиться по ссылке») —
          // НЕ регистрирует сокет в roomSockets/clients вовсе, joinSlot делает это отдельно, когда
          // человек реально выбрал конкретный слот.
          const lobby = getWeGoLobby(String(msg.roomId));
          if (!lobby) {
            send(ws, { type: "error", message: `Лобби "${msg.roomId}" не найдено — партия уже началась или ссылка неверна.` });
            return;
          }
          send(ws, lobbyStateMessage(lobby));
          return;
        }

        if (msg.type === "joinSlot") {
          const lobby = getWeGoLobby(String(msg.roomId));
          if (!lobby) {
            send(ws, { type: "error", message: `Лобби "${msg.roomId}" не найдено — партия уже началась или ссылка неверна.` });
            return;
          }
          const slotIndex = Number(msg.slotIndex);
          const claim = claimWeGoSlot(lobby, slotIndex, String(msg.name ?? ""), Number(msg.color ?? 0));
          if (!claim.ok) {
            send(ws, { type: "error", message: claim.hint });
            return;
          }
          joinRoomSocket(ws, lobby.id, slotIndex);
          send(ws, { type: "joined", roomId: lobby.id, playerId: slotIndex, reconnectToken: claim.token });
          if (lobby.slots.every((s) => s.kind !== "open")) await startAndBroadcastWeGoGame(lobby);
          else broadcastLobbyState(lobby);
          return;
        }

        if (msg.type === "startWeGoRoom") {
          // Хост нажал «Начать досрочно» — оставшиеся "open" слоты конвертируются в AI прямо в
          // startWeGoLobby. Досрочный старт может запустить только создатель (playerId 0, слот 0).
          const info = clients.get(ws);
          if (!info || info.playerId !== 0) return;
          const lobby = getWeGoLobby(info.roomId);
          if (!lobby || lobby.started) return;
          await startAndBroadcastWeGoGame(lobby);
          return;
        }

        if (msg.type === "reconnectSlot") {
          // Лобби остаётся в реестре (getWeGoLobby) НАВСЕГДА после старта (см. rooms.ts) — тот же
          // reconnectToken работает и посреди партии, не только до старта.
          const roomId = String(msg.roomId);
          const playerId = Number(msg.playerId);
          const lobby = getWeGoLobby(roomId);
          const slot = lobby?.slots[playerId];
          if (!slot || !slot.reconnectToken || slot.reconnectToken !== String(msg.reconnectToken ?? "")) {
            send(ws, { type: "error", message: "Не удалось переподключиться — неверная ссылка." });
            return;
          }
          joinRoomSocket(ws, roomId, playerId);
          const session = await getRoom(roomId);
          send(ws, {
            type: "joined",
            roomId,
            playerId,
            state: session ? toPrivateView(session.toJSON(), playerId) : undefined,
            // Дедлайн ТЕКУЩЕГО открытого раунда — сразу при переподключении (F5/разрыв связи), не
            // дожидаясь чьего-то следующего действия для первой рассылки с deadlineAt.
            deadlineAt: session?.roundDeadline ?? null,
          });
          return;
        }

        if (msg.type === "readyForRound") {
          const info = clients.get(ws);
          if (!info || info.playerId === null) return;
          const session = await getRoom(info.roomId);
          if (!session || session.mode !== "wego") return;
          const now = Date.now();
          const allReady = weGo.markReady(session, info.playerId, now);
          if (!allReady) {
            send(ws, { type: "result", ok: true });
            return;
          }
          send(ws, { type: "result", ok: true });
          const timer = weGoRoundTimers.get(session.id);
          if (timer) clearTimeout(timer);
          weGoRoundTimers.delete(session.id);
          const report = weGo.resolveOpenRound(session, now);
          await saveRoom(session);
          broadcastWeGoState(session, report);
          if (session.winner === null) {
            weGo.openRound(session, now);
            await saveRoom(session);
            broadcastWeGoState(session);
            scheduleWeGoDeadline(session);
          }
          return;
        }

        if (msg.type === "previewPath") {
          const info = clients.get(ws);
          if (!info) return;
          const session = await getRoom(info.roomId);
          if (!session) return;
          // WeGo, раунд открыт для этого сокета — считаем на ЕГО приватном клоне, не на общей
          // сессии (иначе можно увидеть последствия ещё не резолвленных ходов других, см. план).
          const target = session.mode === "wego" && info.playerId !== null ? (weGo.getClone(session, info.playerId) ?? session) : session;
          const preview = target.previewUnitPath(Number(msg.playerId), Number(msg.unitId), Number(msg.col), Number(msg.row));
          send(ws, { type: "previewPathResult", requestId: msg.requestId, ...(preview ?? {}) });
          return;
        }

        if (msg.type === "previewAttack") {
          const info = clients.get(ws);
          if (!info) return;
          const session = await getRoom(info.roomId);
          if (!session) return;
          const target = session.mode === "wego" && info.playerId !== null ? (weGo.getClone(session, info.playerId) ?? session) : session;
          const preview = target.previewAttackOutcome(Number(msg.playerId), Number(msg.unitId), Number(msg.col), Number(msg.row));
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

          if (session.mode === "wego") {
            // Дыра «playerId не привязан к сокету» (см. заголовок файла, хотсит) здесь закрыта:
            // подмена чужого playerId отклоняется ДО обращения к игровой логике вовсе.
            if (info.playerId === null || info.playerId !== playerId) {
              send(ws, { type: "result", ok: false, hint: "Действие не за вашего игрока." });
              return;
            }
            if (session.phase === "playing") {
              // Игровая фаза — действие идёт на ПРИВАТНЫЙ клон текущего раунда этого игрока, не на
              // общую сессию (см. weGoRuntime.ts) — раунд ещё не резолвится, план просто копится.
              const result = weGo.applyAction(session, playerId, String(msg.action), msg.payload ?? {});
              send(ws, { type: "result", ...(result ?? { ok: false, hint: "Раунд сейчас закрыт — дождитесь следующего." }) });
              return;
            }
            // "placement" — по прямому упрощению (план архитектуры) расстановка в WeGo остаётся
            // ПОСЛЕДОВАТЕЛЬНОЙ, как в хотсите: жетоны не несут карточной/денежной информации, прятать
            // тут нечего (чужие жетоны и так не показываются клиенту — см. СПРАВОЧНИК §1), а городить
            // отдельный раунд-движок ради короткой блиц-фазы без действий смысла не имеет. Действие
            // идёт прямо на общую сессию, как у хотсита ниже, но с приватной рассылкой.
            const result = session.dispatch(String(msg.action), playerId, msg.payload ?? {});
            send(ws, { type: "result", ...result });
            if (result.ok) {
              await saveRoom(session);
              // (session.phase as string) — TS иначе считает phase всё ещё сузившимся до "placement"
              // из проверки выше и не видит, что dispatch() мог его реально сменить на "playing".
              if ((session.phase as string) === "playing" && !weGo.hasOpenRound(session)) {
                // Это последнее действие расстановки — переход в "playing". Открываем самый первый
                // WeGo-раунд партии ДО рассылки — иначе ушло бы промежуточное состояние с
                // phase:"playing", но ещё БЕЗ дедлайна раунда (openRound их выставляет), лишняя и
                // сбивающая с толку рассылка ради одного и того же события.
                weGo.openRound(session, Date.now());
                await saveRoom(session);
                scheduleWeGoDeadline(session);
              }
              broadcastWeGoState(session);
            }
            return;
          }

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
            if (session.autoPlayAI && String(msg.action) !== "endTurn") {
              // «Против AI» + интерливинг (по прямому запросу — «имитируем одновременность»): это
              // действие человека НЕ было концом его хода — каждый ещё не доигравший в этом цикле AI
              // делает РОВНО ОДИН свой шаг вдогонку (не весь ход разом), см. interleavedAi.ts.
              interleavedAi.stepAllAi(session);
              await saveRoom(session);
              broadcastState(session);
              return;
            }
            if (session.autoPlayAI && String(msg.action) === "endTurn") {
              // Человек только что реально завершил ход — доигрываем ОСТАВШИЕСЯ шаги любого AI, чей
              // план в этом цикле ещё не исчерпан (человек сделал меньше действий, чем шагов в плане
              // AI — интерливинг не успел раздать всё). driveAiTurns ниже дальше сам разберётся с
              // натуральным следующим игроком (пропустит уже доигранных, посчитает свежих).
              await interleavedAi.finishRemainingAi(session, async () => {
                await saveRoom(session);
                broadcastState(session);
              });
            }
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
