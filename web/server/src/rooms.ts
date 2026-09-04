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

export async function createRoom(players: { name: string; color: number; isAI?: boolean }[]): Promise<GameSession> {
  let id = randomRoomId();
  while (rooms.has(id)) id = randomRoomId();
  const playerList: Player[] = players.map((p, i) => ({ id: i, name: p.name, color: p.color, isAI: p.isAI }));
  const session = new GameSession(id, playerList);
  rooms.set(id, session);
  await persist(session);
  return session;
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
