// Реестр комнат (партий) в памяти процесса + персист на диск — сервер не теряет партию ни при
// обновлении страницы клиентом (для этого и вся эта работа), ни при перезапуске самого процесса
// (см. план, этап "Персистенция").

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GameSession } from "./GameSession";
import type { Player } from "../../src/game/placement";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

const rooms = new Map<string, GameSession>();

function randomRoomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function persist(session: GameSession) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${session.id}.json`);
  await fs.writeFile(file, JSON.stringify(session.toJSON()), "utf-8");
}

export async function createRoom(players: { name: string; color: number; isAI?: boolean }[], autoPlayAI = false): Promise<GameSession> {
  let id = randomRoomId();
  while (rooms.has(id)) id = randomRoomId();
  const playerList: Player[] = players.map((p, i) => ({ id: i, name: p.name, color: p.color, isAI: p.isAI }));
  const session = new GameSession(id, playerList);
  session.autoPlayAI = autoPlayAI;
  rooms.set(id, session);
  await persist(session);
  return session;
}

/** Сохранение партии «в файл» (по прямому запросу — «кнопка сохранить партию, чтоб файлом можно
 * было сохранить, без выбора папки, а системно заданная внутри проекта») — клонирует ТЕКУЩЕЕ
 * состояние комнаты под НОВЫМ отдельным id и кладёт рядом с обычными комнатами в тот же `DATA_DIR`
 * (`web/server/data/`, тот же файл, что и обычный автосейв — сохранение НЕ отдельный формат). Игрок
 * продолжает играть в исходной комнате как ни в чём не бывало — она живёт своей жизнью и дальше
 * автосохраняется на каждое действие (см. persist выше); снимок — независимая, замороженная в этот
 * момент копия, к которой можно вернуться позже через «Загрузить игру» (listRooms ниже отдаёт оба
 * вида файлов вперемешку — для игрока это просто ещё одна сохранённая партия, разницы нет). */
export async function saveSnapshot(session: GameSession): Promise<string> {
  let id = randomRoomId();
  while (rooms.has(id)) id = randomRoomId();
  const snapshot = GameSession.fromJSON(id, structuredClone(session.toJSON()));
  rooms.set(id, snapshot);
  await persist(snapshot);
  return id;
}

/** В памяти уже есть — отдаём как есть; иначе пробуем поднять с диска (сервер только что
 * перезапустился) — если и там нет, комнаты не существует. */
export async function getRoom(id: string): Promise<GameSession | null> {
  const cached = rooms.get(id);
  if (cached) return cached;
  try {
    const file = path.join(DATA_DIR, `${id}.json`);
    const raw = await fs.readFile(file, "utf-8");
    const session = GameSession.fromJSON(id, JSON.parse(raw));
    rooms.set(id, session);
    return session;
  } catch {
    return null;
  }
}

export async function saveRoom(session: GameSession): Promise<void> {
  await persist(session);
}

/** Удаление сохранения (по прямому запросу — «в разделе сохранения добавь функцию удалить
 * сохранение») — снимает комнату из памяти (если партия ещё живёт в процессе — второй запрос
 * getRoom(id) больше её не найдёт) и удаляет файл с диска (тот же DATA_DIR, что и persist/listRooms
 * выше — снимки «Сохранить партию» и обычные автосохранённые партии лежат вперемешку, разницы для
 * удаления нет). Отсутствующий файл — не ошибка (уже удалено/никогда не было — тот же результат). */
export async function deleteRoom(id: string): Promise<void> {
  rooms.delete(id);
  try {
    await fs.unlink(path.join(DATA_DIR, `${id}.json`));
  } catch {
    /* файла и так нет — ничего делать не нужно */
  }
}

// === WeGo-лобби (сетевые слоты) — до старта партии GameSession ещё не существует ==================
//
// Слот "open" — свободное место, ждёт, что кто-то перейдёт по ссылке и займёт его (claimWeGoSlot).
// Как только все "open" слоты закрыты (заняты людьми ИЛИ хост нажал "начать досрочно" —
// startWeGoLobby конвертирует оставшиеся "open" в "ai") — строится настоящая GameSession с ТЕМ ЖЕ
// id, что и у лобби, и с этого момента getRoom(id) находит её как обычную комнату; сама WeGoLobby
// остаётся в реестре лишь как источник данных для уже неактуального экрана лобби (started: true).
// Не персистится на диск — как и pendingAiPlan/autoAiRunning (см. wsServer.ts), это временное
// состояние ДО начала партии; если сервер перезапустится посреди набора игроков, лобби нужно
// создать заново (сама партия, once started, персистится как обычно).

export interface WeGoSlot {
  kind: "human" | "ai" | "open";
  name: string;
  color: number;
  /** Индекс = будущий Player.id после старта партии — фиксирован с момента создания лобби. */
  playerId: number;
  /** Есть ли сейчас живое WebSocket-подключение за этим человеком (для "ai"/"open" всегда false). */
  connected: boolean;
  /** Секрет для reconnectSlot — выдаётся claimWeGoSlot один раз при занятии слота. */
  reconnectToken?: string;
}

export interface WeGoLobby {
  id: string;
  slots: WeGoSlot[];
  roundTimeSec: number;
  sessionTimeSec: number;
  started: boolean;
}

const lobbies = new Map<string, WeGoLobby>();
const FALLBACK_PALETTE = [0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4];

/** Секрет для привязки WebSocket-подключения к конкретному слоту (claimWeGoSlot/reconnectSlot,
 * wsServer.ts) — не криптографический токен сессии, просто «угадать сложнее, чем перебрать id
 * комнаты» (та же модель доверия, что и у самого roomId, см. randomRoomId выше). */
export function generateToken(): string {
  return `${randomRoomId()}${randomRoomId()}`;
}

export function createWeGoLobby(
  slots: { kind: "human" | "ai" | "open"; name?: string; color?: number }[],
  roundTimeSec: number,
  sessionTimeSec: number
): WeGoLobby {
  let id = randomRoomId();
  while (lobbies.has(id) || rooms.has(id)) id = randomRoomId();
  const lobby: WeGoLobby = {
    id,
    roundTimeSec,
    sessionTimeSec,
    started: false,
    slots: slots.map((s, i) => ({
      kind: s.kind,
      name: s.name?.trim() || (s.kind === "ai" ? `AI ${i + 1}` : `Игрок ${i + 1}`),
      color: s.color ?? FALLBACK_PALETTE[i % FALLBACK_PALETTE.length],
      playerId: i,
      connected: s.kind === "human",
    })),
  };
  lobbies.set(id, lobby);
  return lobby;
}

export function getWeGoLobby(id: string): WeGoLobby | undefined {
  return lobbies.get(id);
}

/** Занимает конкретный свободный слот — возвращает reconnectToken (клиент хранит в localStorage,
 * чтобы восстановить привязку после F5/разрыва связи, см. reconnectSlot в wsServer.ts). Гонка двух
 * одновременных claimWeGoSlot на один слот невозможна: Node.js обрабатывает оба входящих WS-сообщения
 * последовательно (весь путь от чтения slot.kind до его записи — синхронный код, без await между
 * ними), так что второй вызов всегда видит уже "human", а не "open". */
export function claimWeGoSlot(lobby: WeGoLobby, slotIndex: number, name: string, color: number): { ok: true; token: string } | { ok: false; hint: string } {
  const slot = lobby.slots[slotIndex];
  if (!slot) return { ok: false, hint: "Такого слота нет." };
  if (slot.kind !== "open") return { ok: false, hint: "Слот уже занят — выберите другой." };
  const token = generateToken();
  slot.kind = "human";
  slot.name = name.trim() || slot.name;
  slot.color = color;
  slot.connected = true;
  slot.reconnectToken = token;
  return { ok: true, token };
}

/** Строит настоящую GameSession из лобби — оставшиеся "open" слоты (никто не успел/не захотел
 * занять) конвертируются в AI, как явно предусмотрено дизайном («открыть слоты для людей и
 * поставить AI»). ID партии — ТОТ ЖЕ, что и у лобби (ссылка, которую разослал хост, продолжает
 * работать без смены урла). maxTurns жёстко 40 для WeGo (по прямому запросу пользователя),
 * не настраивается через лобби. */
export async function startWeGoLobby(lobby: WeGoLobby): Promise<GameSession> {
  for (const slot of lobby.slots) {
    if (slot.kind === "open") slot.kind = "ai";
  }
  const playerList: Player[] = lobby.slots.map((s) => ({ id: s.playerId, name: s.name, color: s.color, isAI: s.kind === "ai" }));
  const session = new GameSession(lobby.id, playerList, undefined, 40);
  session.mode = "wego";
  session.roundTimeMs = lobby.roundTimeSec * 1000;
  session.sessionTimeMs = lobby.sessionTimeSec * 1000;
  rooms.set(lobby.id, session);
  await persist(session);
  lobby.started = true;
  return session;
}

export async function listRooms(): Promise<{ id: string; players: string[]; phase: string; savedAt: string }[]> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const files = await fs.readdir(DATA_DIR);
  const out: { id: string; players: string[]; phase: string; savedAt: string }[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const stat = await fs.stat(path.join(DATA_DIR, f));
      const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), "utf-8"));
      out.push({ id: f.replace(/\.json$/, ""), players: raw.players.map((p: { name: string }) => p.name), phase: raw.phase, savedAt: stat.mtime.toISOString() });
    } catch {
      /* повреждённый файл — пропускаем */
    }
  }
  out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return out;
}
