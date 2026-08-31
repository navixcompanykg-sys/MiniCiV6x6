// Тонкий WebSocket-клиент — main.ts больше не хранит состояние партии сам, только зеркалит то, что
// прислал сервер (`web/server`), и шлёт туда действия. См. план: C:\Users\user\.claude\plans\mighty-snuggling-squid.md.
//
// Один активный запрос за раз (никогда не шлём вторую команду, не дождавшись ответа на первую) —
// поэтому очередь resolve-колбэков без id корреляции полностью безопасна: следующий "result" всегда
// относится к следующему по очереди "action".

export interface ActionResult {
  ok: boolean;
  hint?: string;
  needsWarConfirm?: { targetPlayerId: number; reason: string };
  /** Линии поддержки в этом бою (по прямому запросу — анимация, чисто отображение) — main.ts рисует
   * по одной линии на каждую запись поверх карты, ни на что в состоянии партии не влияет. */
  supportLines?: { from: { col: number; row: number }; to: { col: number; row: number } }[];
  /** Рабочему не хватило лимита населения на все новые типы региона — клиент должен показать выбор
   * из `options` (до `budget` штук) и повторить workerCollect с chosenTypes. */
  needsResourceChoice?: { cityId: number; budget: number; options: string[]; population: number; usedThisCycle: number };
}

// Форма ровно как SaveGameV1 на сервере — здесь не импортируем сам класс (клиенту не нужна игровая
// логика, только снимок), поэтому просто `any`-подобный широкий тип с полями, которые главный файл
// читает напрямую.
export type ServerState = any;

let ws: WebSocket | null = null;
let currentRoomId: string | null = null;
const stateListeners: ((state: ServerState) => void)[] = [];
const errorListeners: ((message: string) => void)[] = [];
const connectionListeners: ((connected: boolean) => void)[] = [];
const pendingResults: ((r: ActionResult) => void)[] = [];

export function roomId(): string | null {
  return currentRoomId;
}
export function isConnected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
export function onState(cb: (state: ServerState) => void) {
  stateListeners.push(cb);
}
export function onError(cb: (message: string) => void) {
  errorListeners.push(cb);
}
/** По прямому запросу — сервер перезапускается по ходу разработки (правки применяются только
 * рестартом), а сокет раньше просто умирал молча (никакого автопереподключения не было — только
 * ручной F5 возвращал партию). cb(false) — соединение оборвалось (комната ждёт переподключения),
 * cb(true) — переподключились и подтянули актуальное состояние. */
export function onConnectionChange(cb: (connected: boolean) => void) {
  connectionListeners.push(cb);
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Пробует восстановить соединение и вернуться в ту же комнату каждые 1.5с, пока не получится —
 * сервер мог быть ещё не поднят (перезапуск в процессе), поэтому не сдаётся после первой неудачи. */
function scheduleReconnect() {
  if (reconnectTimer || !currentRoomId) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const targetRoom = currentRoomId;
    if (!targetRoom) return;
    try {
      const socket = await ensureSocket();
      const wait = waitForOnce(socket, "joined");
      socket.send(JSON.stringify({ type: "join", roomId: targetRoom }));
      const msg = await wait;
      if (msg.type === "error") {
        scheduleReconnect();
        return;
      }
      for (const cb of stateListeners) cb(msg.state);
      for (const cb of connectionListeners) cb(true);
    } catch {
      scheduleReconnect();
    }
  }, 1500);
}

const WS_URL = `ws://${location.hostname}:8787/ws`;

function ensureSocket(): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    socket.addEventListener("open", () => {
      ws = socket;
      resolve(socket);
    });
    socket.addEventListener("error", () => reject(new Error("Не удалось подключиться к серверу игры.")));
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "state") {
        for (const cb of stateListeners) cb(msg.state);
      } else if (msg.type === "result") {
        const resolve = pendingResults.shift();
        if (resolve) resolve({ ok: msg.ok, hint: msg.hint, needsWarConfirm: msg.needsWarConfirm, supportLines: msg.supportLines, needsResourceChoice: msg.needsResourceChoice });
      } else if (msg.type === "error") {
        for (const cb of errorListeners) cb(msg.message);
      }
      // "joined" обрабатывается отдельно, напрямую в connectAndCreate/connectAndJoin ниже — тем же
      // сокетом, тем же listener'ом на один экземпляр (once), см. waitFor.
    });
    socket.addEventListener("close", () => {
      if (ws !== socket) return; // старый, уже заменённый сокет — не наш случай
      ws = null;
      // Любой активный запрос, ждавший ответа на этом сокете, никогда его не получит — освобождаем,
      // иначе следующий clic/UI навсегда завис бы на pending-промисе (см. sendAction).
      while (pendingResults.length) pendingResults.shift()!({ ok: false, hint: "Соединение с сервером разорвано." });
      if (currentRoomId) {
        for (const cb of connectionListeners) cb(false);
        scheduleReconnect();
      }
    });
  });
}

function waitForOnce(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === type) {
        socket.removeEventListener("message", handler);
        resolve(msg);
      } else if (msg.type === "error") {
        socket.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    socket.addEventListener("message", handler);
  });
}

/** Новая партия — создаёт комнату на сервере, возвращает её id и стартовый снимок состояния. */
export async function createRoom(players: { name: string; color: number }[]): Promise<{ roomId: string; state: ServerState } | { error: string }> {
  const socket = await ensureSocket();
  const wait = waitForOnce(socket, "joined");
  socket.send(JSON.stringify({ type: "create", players }));
  const msg = await wait;
  if (msg.type === "error") return { error: msg.message };
  currentRoomId = msg.roomId;
  return { roomId: msg.roomId, state: msg.state };
}

/** Продолжить существующую комнату (F5 в игре, «Загрузить игру» из start.html, второй игрок за тем
 * же столом открывший свою вкладку — Этап 2). */
export async function joinRoom(id: string): Promise<{ roomId: string; state: ServerState } | { error: string }> {
  const socket = await ensureSocket();
  const wait = waitForOnce(socket, "joined");
  socket.send(JSON.stringify({ type: "join", roomId: id }));
  const msg = await wait;
  if (msg.type === "error") return { error: msg.message };
  currentRoomId = msg.roomId;
  return { roomId: msg.roomId, state: msg.state };
}

/** Отправляет действие ЗА playerId (хотсит — один браузер играет за всех по очереди, см. wsServer.ts)
 * и ждёт именно его результат (не следующую трансляцию state — та тоже придёт, отдельно, через
 * onState). Сервер — источник правды; локально ничего не меняем до его ответа. */
export function sendAction(action: string, playerId: number, payload: Record<string, unknown> = {}): Promise<ActionResult> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, hint: "Нет соединения с сервером." });
  return new Promise((resolve) => {
    pendingResults.push(resolve);
    ws!.send(JSON.stringify({ type: "action", action, playerId, payload }));
  });
}

export async function listRooms(): Promise<{ id: string; players: string[]; phase: string; savedAt: string }[]> {
  const res = await fetch(`http://${location.hostname}:8787/api/rooms`);
  return res.json();
}
