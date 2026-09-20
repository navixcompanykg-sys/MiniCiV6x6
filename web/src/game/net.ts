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
  /** Фактически пройденные юнитом гексы за этот commandUnit (по прямому запросу — «движение должно
   * случаться в текущем цикле, плюс анимация с учётом местности») — сервер уже применил движение к
   * моменту ответа, это только маршрут для анимации (main.ts playUnitMoveAnimation). `cost` — сколько
   * бюджета хода стоил шаг (дорога/обычная местность/остаток на горе), чтобы тяжёлая местность
   * анимировалась медленнее лёгкой. */
  movedPath?: { col: number; row: number; cost: number }[];
  /** Рабочему не хватило лимита населения на все новые типы региона — клиент должен показать выбор
   * из `options` (до `budget` штук) и повторить workerCollect с chosenTypes. */
  needsResourceChoice?: { cityId: number; budget: number; options: string[]; population: number; usedThisCycle: number };
  /** Конец хода с рукой ≥8 (ТЗ 2.3) — превью последствий сброса вместо немедленного применения, тот
   * же round-trip паттерн, что и needsWarConfirm. См. GameSession.previewHandOverflowDiscard. */
  needsDiscardConfirm?: { consequences: string[]; eliminates: boolean };
  /** Конец хода со складом сверх лимита (ТЗ, по прямому уточнению) — жёсткий отказ, нет пути
   * «подтвердить и продолжить». См. GameSession.endTurn/warehouseCapFor. */
  needsWarehouseTrim?: { total: number; cap: number; overBy: number };
  /** Землетрясение среди катаклизмов «Учёного» (ТЗ §15.1) — только на реальном подтверждении конца
   * хода (не на превью needsDiscardConfirm), чисто для анимации (main.ts playEarthquakeAnimation). */
  earthquakeHexes?: { col: number; row: number }[];
  /** Данные для анимации боя (по прямому запросу — «полоски от юнита к цели, с убыванием защиты,
   * хотя бы секунда анимации») — см. GameSession.ActionResult.combatAnim, main.ts playCombatAnimation. */
  combatAnim?: {
    attacker: { col: number; row: number };
    hits: (
      | { kind: "city"; target: { col: number; row: number }; defenseBefore: number; defenseAfter: number; garrisonBroken: boolean }
      | { kind: "unit"; target: { col: number; row: number }; defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number }
    )[];
    counterOnAttacker?: { defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number };
  };
  /** Ядерный удар (по прямому запросу) — чисто для анимации (main.ts playNuclearStrikeAnimation),
   * весь урон/разрушения уже применены на сервере. `hit:false` — перехвачен ПРО цели, `hexes` пуст.
   * См. GameSession.ActionResult.nuclearStrike. */
  nuclearStrike?: { hit: boolean; target: { col: number; row: number }; hexes: { col: number; row: number }[] };
}

/** Ответ на превью маршрута (по прямому запросу — «при выборе клетки куда переместиться показывай
 * маршрут и число ходов») — `null`, если пути нет (недостижимо/заблокировано). НЕ идёт через
 * ActionResult/pendingResults (см. wsServer.ts) — отдельный канал, чтобы частые запросы при наведении
 * мышью не путались с очередью реальных действий. */
export interface PreviewPathResult {
  path: { col: number; row: number }[];
  cost: number;
  remainingBudget: number;
  moveRange: number;
}

/** Ответ на превью боя (по прямому запросу — «при наведении на противника показывать исход боя
 * цифрами: сколько защиты снимется, отступит ли юнит, кто-то погибнет или ничья») — тот же отдельный
 * канал, что и PreviewPathResult, тем же причинам (частые запросы при наведении мышью). `null`, если
 * исход не посчитать (юнит/цель пропали, не юнит-цель и т.п.) — см. GameSession.previewAttackOutcome. */
export interface PreviewAttackResult {
  defender: { defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number; died: boolean; retreated: boolean };
  attacker?: { defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number; died: boolean };
}

/** Ценность черновика предложения дипломатии с обеих точек зрения (по прямому запросу — окно
 * составления предложения показывает, кто сколько выигрывает/теряет, по той же формуле, что решает
 * дипломатию бота, см. GameSession.proposalNetValueFor через bot.ts). Тот же fire-and-forget канал,
 * что PreviewPathResult/PreviewAttackResult — терм-лист меняется на каждый клик «Добавить». */
export interface ProposalValuePreview {
  mine: number;
  theirs: number;
}

/** Разбивка дохода торговой сети «Торговца» (по прямому запросу — окно выбора ресурсов для торговли
 * с выведением дохода/списка городов сети/долей других игроков) — зеркалит серверный
 * `GameSession.TradeIncomeBreakdown`; `resource`/`cityId`/`playerId` типизированы широко (`string`/
 * `number`), т.к. net.ts — общий транспортный слой, конкретные типы (ResourceId и т.п.) определены
 * в main.ts. `null` — цель (город) пропала к моменту ответа. */
export interface TradeTradePreview {
  networkCities: { cityId: number; playerId: number; population: number }[];
  available: { resource: string; source: "access" | "warehouse" }[];
  selected: string[];
  grossIncome: number;
  tollBreakdown: { playerId: number; amount: number }[];
  raiderBreakdown: { playerId: number; unitId: number; amount: number }[];
  playerShare: number;
}

// Форма ровно как SaveGameV1 на сервере — здесь не импортируем сам класс (клиенту не нужна игровая
// логика, только снимок), поэтому просто `any`-подобный широкий тип с полями, которые главный файл
// читает напрямую.
export type ServerState = any;

/** Отчёт по завершённому WeGo-раунду (по прямому запросу — «показывай итог раунда как AI-план,
 * только за себя») — свой, персональный: `steps[i].action` — записанное действие ("endTurn" у
 * AI-плана реплеится сервером как "closeRound", но в отчёте остаётся исходное имя для читаемости),
 * `ok:false` — шаг не применился (конфликт с чужим действием того же раунда, см. weGoRound.ts). */
export interface WeGoRoundReport {
  order: number[];
  steps: { action: string; ok: boolean; hint?: string }[];
}

let ws: WebSocket | null = null;
let currentRoomId: string | null = null;
const stateListeners: ((state: ServerState, deadlineAt?: number | null, report?: WeGoRoundReport) => void)[] = [];
const errorListeners: ((message: string) => void)[] = [];
const connectionListeners: ((connected: boolean) => void)[] = [];
const lobbyListeners: ((msg: { roomId: string; roundTimeSec: number; sessionTimeSec: number; slots: WeGoLobbySlotView[] }) => void)[] = [];
const pendingResults: ((r: ActionResult) => void)[] = [];
const previewPathListeners: ((requestId: number, result: PreviewPathResult | null) => void)[] = [];
const previewAttackListeners: ((requestId: number, result: PreviewAttackResult | null) => void)[] = [];
const previewProposalValueListeners: ((requestId: number, result: ProposalValuePreview) => void)[] = [];
const previewTraderTradeListeners: ((requestId: number, result: TradeTradePreview | null) => void)[] = [];
let nextPreviewRequestId = 1;
let myWeGoPlayerId: number | null = null;

export interface WeGoLobbySlotView {
  index: number;
  kind: "human" | "ai" | "open";
  name: string;
  color: number;
  connected: boolean;
}

export function roomId(): string | null {
  return currentRoomId;
}
export function isConnected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
export function onState(cb: (state: ServerState, deadlineAt?: number | null, report?: WeGoRoundReport) => void) {
  stateListeners.push(cb);
}
export function onError(cb: (message: string) => void) {
  errorListeners.push(cb);
}
/** Только для WeGo-лобби (до старта партии) — состав слотов (человек/AI/открыт), см. rooms.ts
 * WeGoLobby. Рассылается на любое изменение (joinSlot/startWeGoRoom), пока партия не началась. */
export function onLobbyState(cb: (msg: { roomId: string; roundTimeSec: number; sessionTimeSec: number; slots: WeGoLobbySlotView[] }) => void) {
  lobbyListeners.push(cb);
}
/** playerId, за которого действует ЭТА вкладка в WeGo-комнате (в отличие от хотсита, где playerId
 * всегда = currentPlayerIndex, см. main.ts) — null до joinSlot/createWeGoRoom/reconnectSlot, либо в
 * хотсит-комнатах (где привязки нет вовсе, см. wsServer.ts). */
export function myWeGoPlayer(): number | null {
  return myWeGoPlayerId;
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

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

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
        // deadlineAt/report — только в WeGo-комнатах (см. wsServer.ts broadcastWeGoState); в хотсите
        // оба всегда undefined, слушатели их просто не используют.
        for (const cb of stateListeners) cb(msg.state, msg.deadlineAt, msg.report);
      } else if (msg.type === "lobbyState") {
        for (const cb of lobbyListeners) cb(msg);
      } else if (msg.type === "result") {
        const resolve = pendingResults.shift();
        if (resolve)
          resolve({
            ok: msg.ok,
            hint: msg.hint,
            needsWarConfirm: msg.needsWarConfirm,
            supportLines: msg.supportLines,
            needsResourceChoice: msg.needsResourceChoice,
            needsDiscardConfirm: msg.needsDiscardConfirm,
            needsWarehouseTrim: msg.needsWarehouseTrim,
            earthquakeHexes: msg.earthquakeHexes,
            movedPath: msg.movedPath,
            combatAnim: msg.combatAnim,
          });
      } else if (msg.type === "previewPathResult") {
        const result: PreviewPathResult | null = msg.path ? { path: msg.path, cost: msg.cost, remainingBudget: msg.remainingBudget, moveRange: msg.moveRange } : null;
        for (const cb of previewPathListeners) cb(msg.requestId, result);
      } else if (msg.type === "previewAttackResult") {
        const result: PreviewAttackResult | null = msg.defender ? { defender: msg.defender, attacker: msg.attacker } : null;
        for (const cb of previewAttackListeners) cb(msg.requestId, result);
      } else if (msg.type === "previewProposalValueResult") {
        for (const cb of previewProposalValueListeners) cb(msg.requestId, { mine: msg.mine, theirs: msg.theirs });
      } else if (msg.type === "previewTraderTradeResult") {
        for (const cb of previewTraderTradeListeners) cb(msg.requestId, msg.breakdown ?? null);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Общая отправка create/join с несколькими попытками (по прямому запросу — «текущая сессия
 * потерялась»: сервер иногда на секунду-другую недоступен ровно в момент открытия страницы
 * (перезапуск в процессе разработки, см. onConnectionChange у уже открытой сессии), а самый первый
 * join/create раньше проваливался с первой же попытки и сразу кидал игрока обратно в меню, хотя
 * партия цела на диске (см. rooms.ts persist). Ретраится ТОЛЬКО сам коннект (ensureSocket) — если
 * сервер уже ответил своей явной ошибкой (например «комната не найдена»), это не транзиентная
 * проблема, и мы её сразу возвращаем, не тратя лишние секунды на ретраи впустую. */
async function connectAndSend(payload: Record<string, unknown>, attempts = 5): Promise<{ type: "joined"; roomId: string; state: ServerState } | { error: string }> {
  let lastError = "Не удалось подключиться к серверу игры.";
  for (let i = 0; i < attempts; i++) {
    let socket: WebSocket;
    try {
      socket = await ensureSocket();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (i < attempts - 1) await sleep(1000);
      continue;
    }
    const wait = waitForOnce(socket, "joined");
    socket.send(JSON.stringify(payload));
    const msg = await wait;
    if (msg.type === "error") return { error: msg.message };
    return msg;
  }
  return { error: lastError };
}

/** Новая партия — создаёт комнату на сервере, возвращает её id и стартовый снимок состояния.
 * `autoPlayAI` — режим «Против AI» (ходы AI-игроков применяются сами, с паузой между действиями, не
 * ждут подтверждения человеком) вместо обычного хотсита (по умолчанию, false). */
export async function createRoom(
  players: { name: string; color: number; isAI?: boolean }[],
  autoPlayAI = false
): Promise<{ roomId: string; state: ServerState } | { error: string }> {
  const msg = await connectAndSend({ type: "create", players, autoPlayAI });
  if ("error" in msg) return msg;
  currentRoomId = msg.roomId;
  return { roomId: msg.roomId, state: msg.state };
}

/** Продолжить существующую комнату (F5 в игре, «Загрузить игру» из start.html, второй игрок за тем
 * же столом открывший свою вкладку — Этап 2). */
export async function joinRoom(id: string): Promise<{ roomId: string; state: ServerState } | { error: string }> {
  const msg = await connectAndSend({ type: "join", roomId: id });
  if ("error" in msg) return msg;
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

/** Превью маршрута юнита (по прямому запросу — «показывай маршрут и число ходов»), не действие —
 * fire-and-forget, без промиса и без очереди pendingResults (см. wsServer.ts doc — отдельный канал
 * специально для частых запросов при наведении мышью). Возвращает id этого конкретного запроса —
 * вызывающий код (main.ts) сам решает, какой из пришедших через onPreviewPath ответов ещё актуален
 * (последний отправленный), остальные просто игнорирует. */
export function requestPreviewPath(playerId: number, unitId: number, col: number, row: number): number {
  const requestId = nextPreviewRequestId++;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "previewPath", requestId, playerId, unitId, col, row }));
  return requestId;
}
export function onPreviewPath(cb: (requestId: number, result: PreviewPathResult | null) => void) {
  previewPathListeners.push(cb);
}

/** Превью исхода боя (по прямому запросу — «при наведении на противника показывать исход боя»), тот
 * же fire-and-forget паттерн, что requestPreviewPath, тем же причинам. */
export function requestPreviewAttack(playerId: number, unitId: number, col: number, row: number): number {
  const requestId = nextPreviewRequestId++;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "previewAttack", requestId, playerId, unitId, col, row }));
  return requestId;
}
export function onPreviewAttack(cb: (requestId: number, result: PreviewAttackResult | null) => void) {
  previewAttackListeners.push(cb);
}

/** Превью ценности черновика предложения (по прямому запросу — окно составления предложения), тот же
 * fire-and-forget паттерн — `terms` типизирован широко (`unknown[]`), т.к. конкретный `ProposalTerm`
 * определён в main.ts, а net.ts — общий транспортный слой, ему знать его форму не нужно. */
export function requestPreviewProposalValue(from: number, to: number, terms: unknown[]): number {
  const requestId = nextPreviewRequestId++;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "previewProposalValue", requestId, from, to, terms }));
  return requestId;
}
export function onPreviewProposalValue(cb: (requestId: number, result: ProposalValuePreview) => void) {
  previewProposalValueListeners.push(cb);
}

/** Превью разбивки дохода «Торговца» (по прямому запросу — окно выбора ресурсов), тот же
 * fire-and-forget паттерн — `resources` не передан значит «все доступные» (то же, что реальная игра
 * карты без явного выбора). */
export function requestPreviewTraderTrade(playerId: number, cityId: number, resources?: string[]): number {
  const requestId = nextPreviewRequestId++;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "previewTraderTrade", requestId, playerId, cityId, resources }));
  return requestId;
}
export function onPreviewTraderTrade(cb: (requestId: number, result: TradeTradePreview | null) => void) {
  previewTraderTradeListeners.push(cb);
}

export async function listRooms(): Promise<{ id: string; players: string[]; phase: string; savedAt: string }[]> {
  const res = await fetch(`/api/rooms`);
  return res.json();
}

/** Удаление сохранения (по прямому запросу — «в разделе сохранения добавь функцию удалить
 * сохранение») — см. rooms.ts: deleteRoom/index.ts DELETE /api/rooms/<id>. */
export async function deleteRoom(id: string): Promise<{ ok: true } | { error: string }> {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) return { error: `Сервер ответил ${res.status}.` };
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** «Сохранить партию» (по прямому запросу — «чтоб файлом можно было сохранить, без выбора папки, а
 * системно заданная внутри проекта») — клонирует ТЕКУЩУЮ комнату под новым id на сервере (см.
 * GameSession.saveSnapshot); игрок остаётся в исходной комнате, продолжает играть как ни в чём не
 * бывало — снимок просто добавляется в список, который «Загрузить игру» на start.html показывает
 * целиком (см. listRooms выше), а не только последнюю партию. */
export async function saveSnapshot(): Promise<{ roomId: string } | { error: string }> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return { error: "Нет соединения с сервером." };
  const wait = waitForOnce(ws, "snapshotSaved");
  ws.send(JSON.stringify({ type: "saveSnapshot" }));
  const msg = await wait;
  if (msg.type === "error") return { error: msg.message };
  return { roomId: msg.roomId };
}

// === WeGo — лобби со слотами (отдельная сетевая ветка от create/join выше, см. заголовок файла) ===

function reconnectStorageKey(id: string): string {
  return `civa-wego-reconnect:${id}`;
}

/** Общий хвост для createWeGoRoom/joinWeGoSlot — обе получают в ответ "joined" с playerId и
 * reconnectToken (в отличие от обычных create/join хотсита, где привязки к игроку нет вовсе), и обе
 * должны сохранить токен в localStorage для reconnectWeGoSlot (F5/разрыв связи). */
async function sendAndBindSlot(payload: Record<string, unknown>): Promise<{ roomId: string; playerId: number } | { error: string }> {
  let socket: WebSocket;
  try {
    socket = await ensureSocket();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const wait = waitForOnce(socket, "joined");
  socket.send(JSON.stringify(payload));
  const msg = await wait;
  if (msg.type === "error") return { error: msg.message };
  currentRoomId = msg.roomId;
  myWeGoPlayerId = msg.playerId;
  if (msg.reconnectToken) localStorage.setItem(reconnectStorageKey(msg.roomId), JSON.stringify({ playerId: msg.playerId, token: msg.reconnectToken }));
  return { roomId: msg.roomId, playerId: msg.playerId };
}

/** Создаёт WeGo-лобби — `slots[0]` обязан описывать самого создателя (kind:"human", та же вкладка,
 * что шлёт этот запрос) — остальные слоты люди занимают позже по ссылке (joinWeGoSlot). Если среди
 * слотов вообще нет "open" (сразу все — люди/AI), партия стартует немедленно на сервере. */
export async function createWeGoRoom(
  slots: { kind: "human" | "ai" | "open"; name?: string; color?: number }[],
  roundTimeSec = 180,
  sessionTimeSec = 5400
): Promise<{ roomId: string; playerId: number } | { error: string }> {
  return sendAndBindSlot({ type: "createWeGoRoom", slots, roundTimeSec, sessionTimeSec });
}

/** Смотрит состав слотов лобби ДО присоединения (экран «Присоединиться по ссылке» — сначала нужно
 * показать, какие слоты вообще свободны) — не занимает никакой слот и не привязывает playerId. */
export async function peekWeGoLobby(roomId: string): Promise<{ roomId: string; roundTimeSec: number; sessionTimeSec: number; slots: WeGoLobbySlotView[] } | { error: string }> {
  let socket: WebSocket;
  try {
    socket = await ensureSocket();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const wait = waitForOnce(socket, "lobbyState");
  socket.send(JSON.stringify({ type: "peekLobby", roomId }));
  const msg = await wait;
  if (msg.type === "error") return { error: msg.message };
  return msg;
}

/** Занимает конкретный свободный слот существующего лобби (переход по ссылке-приглашению). */
export async function joinWeGoSlot(roomId: string, slotIndex: number, name: string, color: number): Promise<{ roomId: string; playerId: number } | { error: string }> {
  return sendAndBindSlot({ type: "joinSlot", roomId, slotIndex, name, color });
}

/** Восстанавливает привязку к своему слоту после F5/разрыва связи, по токену из localStorage (см.
 * sendAndBindSlot). null — для этой комнаты токена нет вовсе (чужая ссылка, другая вкладка, не
 * WeGo) — вызывающий код тогда идёт обычным joinRoom (зритель, без привязки к игроку). */
export async function reconnectWeGoSlot(
  roomId: string
): Promise<{ roomId: string; playerId: number; state: ServerState; deadlineAt: number | null } | { error: string } | null> {
  const raw = localStorage.getItem(reconnectStorageKey(roomId));
  if (!raw) return null;
  const { playerId, token } = JSON.parse(raw) as { playerId: number; token: string };
  let socket: WebSocket;
  try {
    socket = await ensureSocket();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const wait = waitForOnce(socket, "joined");
  socket.send(JSON.stringify({ type: "reconnectSlot", roomId, playerId, reconnectToken: token }));
  const msg = await wait;
  if (msg.type === "error") return { error: msg.message };
  currentRoomId = msg.roomId;
  myWeGoPlayerId = msg.playerId;
  return { roomId: msg.roomId, playerId: msg.playerId, state: msg.state, deadlineAt: msg.deadlineAt ?? null };
}

/** Хост нажал «Начать досрочно» — оставшиеся "open" слоты конвертируются в AI на сервере
 * (rooms.ts startWeGoLobby), партия стартует сразу же. Fire-and-forget — итог придёт как обычно
 * через onState/onLobbyState. */
export function startWeGoRoomEarly() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "startWeGoRoom" }));
}

/** «Готово» — сдать план этого раунда, не дожидаясь остальных живых игроков или раундового таймера
 * (по прямому запросу — «предельное время на 1 ход 3 минуты»). Итог самого раунда (кто что успел,
 * report) придёт отдельно всем сразу через onState, когда раунд реально резолвится — этот промис
 * лишь подтверждает, что план принят. */
export function submitReadyForRound(): Promise<ActionResult> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, hint: "Нет соединения с сервером." });
  return new Promise((resolve) => {
    pendingResults.push(resolve);
    ws!.send(JSON.stringify({ type: "readyForRound" }));
  });
}
