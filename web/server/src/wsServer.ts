// Протокол: один тип сообщения на каждое направление (см. план — сложность делегируется Этапу 2).
//
// Клиент → сервер:
//   { type: "create", players: {name,color}[] }
//   { type: "join", roomId: string }
//   { type: "action", action: string, playerId: number, payload: any }   — только после join/create
//   { type: "previewPath", requestId, playerId, unitId, col, row }       — см. ниже, отдельно от action
//
// Сервер → клиент:
//   { type: "joined", roomId, state }                    — ответ на create/join
//   { type: "state", state }                              — рассылается ВСЕМ в комнате после действия
//   { type: "result", ok, hint?, needsWarConfirm? }        — ТОЛЬКО инициатору действия
//   { type: "previewPathResult", requestId, path?, cost?, remainingBudget?, moveRange? } — ответ на previewPath
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
import { createRoom, getRoom, saveRoom } from "./rooms";
import type { GameSession } from "./GameSession";

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
          const players = msg.players as { name: string; color: number }[];
          if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
            send(ws, { type: "error", message: "Нужно от 2 до 6 игроков." });
            return;
          }
          const session = await createRoom(players);
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
          const result = session.dispatch(String(msg.action), playerId, msg.payload ?? {});
          send(ws, { type: "result", ...result });
          if (result.ok) {
            await saveRoom(session);
            broadcastState(session);
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
