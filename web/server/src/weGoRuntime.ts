import { GameSession, type ActionResult } from "./GameSession";
import { resolveWeGoRound, type RoundPlanStep, type RoundReport } from "./weGoRound";
import { openNewRound, accountRoundTime } from "./weGoScheduler";

/** Приватное состояние ОДНОГО живого человека в ТЕКУЩЕМ открытом раунде — его personal-клон
 * (structuredClone на момент открытия раунда) плюс записанные на нём успешные шаги, см. weGoRound.ts
 * RoundPlanStep. Не персистится (как и pendingAiPlan/autoAiRunning в wsServer.ts) — временное
 * состояние процесса, живёт только пока раунд открыт. */
interface PlayerRoundState {
  clone: GameSession;
  steps: RoundPlanStep[];
  /** unix ms момента "Готово" (readyForRound); null — план ещё не сдан. */
  readyAt: number | null;
}

interface RoomRuntime {
  players: Map<number, PlayerRoundState>;
}

const runtimes = new Map<string, RoomRuntime>();

/** Кому вообще открывается приватное окно планирования — живые люди, не переведённые под
 * перманентный AI (aiControlled, см. weGoScheduler.ts). Исходные AI-слоты (Player.isAI) и выбывшие
 * (eliminatedPlayers) сюда не попадают — resolveWeGoRound планирует их сам через computeAiTurnPlan
 * в момент резолюции раунда, см. weGoRound.ts. */
function humanPlayerIds(session: GameSession): number[] {
  return session.players.filter((p) => !p.isAI && !session.eliminatedPlayers.has(p.id) && !session.aiControlled.has(p.id)).map((p) => p.id);
}

function makeClone(session: GameSession, playerId: number): GameSession {
  const clone = GameSession.fromJSON(session.id, structuredClone(session.toJSON()));
  clone.currentPlayerIndex = clone.players.findIndex((p) => p.id === playerId);
  return clone;
}

/** Открывает новое окно планирования — свежий приватный клон на каждого живого человека (см.
 * humanPlayerIds), взамен предыдущего раунда (если был — resolveOpenRound уже удалил старую
 * запись). Также выставляет roundDeadline/roundOpenedAt на сессии (weGoScheduler.openNewRound). */
export function openRound(session: GameSession, now: number) {
  openNewRound(session, now);
  const players = new Map<number, PlayerRoundState>();
  for (const id of humanPlayerIds(session)) players.set(id, { clone: makeClone(session, id), steps: [], readyAt: null });
  runtimes.set(session.id, { players });
}

export function hasOpenRound(session: GameSession): boolean {
  return runtimes.has(session.id);
}

/** Применяет игровое действие человека к ЕГО ПРИВАТНОМУ клону раунда, не к общей сессии — приватность
 * (никто другой не видит промежуточных решений до резолюции раунда) и свобода передумать/переиграть
 * до сдачи плана (клон просто заменяется свежим на следующий openRound). Возвращает null, если для
 * этого playerId раунд сейчас не открыт (AI/aiControlled/выбыл — вызывающий код решает, что ответить
 * сокету в этом случае). */
export function applyAction(session: GameSession, playerId: number, action: string, payload: unknown): ActionResult | null {
  const state = runtimes.get(session.id)?.players.get(playerId);
  if (!state) return null;
  if (state.readyAt !== null) return { ok: false, hint: "План этого раунда уже сдан — дождитесь следующего раунда." };
  const result = state.clone.dispatch(action, playerId, payload);
  if (result.ok) state.steps.push({ action, payload });
  return result;
}

/** Для previewPath/previewAttack — эти запросы тоже обязаны читать ПРИВАТНЫЙ клон игрока, а не общую
 * сессию (план, риск "утечка через preview": иначе предпросмотр мог бы случайно отразить последствия
 * ещё не резолвленных ходов других игроков этого же раунда). null — раунд не открыт для playerId. */
export function getClone(session: GameSession, playerId: number): GameSession | null {
  return runtimes.get(session.id)?.players.get(playerId)?.clone ?? null;
}

/** Сдача плана ("Готово" — readyForRound). Возвращает true, если ЭТИМ сигналом закрылись ВСЕ живые
 * люди этого раунда — тогда резолюцию можно запускать немедленно, не дожидаясь таймера. false и для
 * "ещё не все готовы", и для "раунд не открыт / игрок уже сдавал" (не идемпотентно повторно). */
export function markReady(session: GameSession, playerId: number, now: number): boolean {
  const runtime = runtimes.get(session.id);
  const state = runtime?.players.get(playerId);
  if (!runtime || !state || state.readyAt !== null) return false;
  state.readyAt = now;
  return [...runtime.players.values()].every((s) => s.readyAt !== null);
}

/**
 * Резолюция открытого раунда — импользует шаги ТОЛЬКО тех, кто реально сдал план (readyAt!==null);
 * остальные живые люди (не успели до таймера/дисконнект) остаются без записи в playerPlans —
 * resolveWeGoRound сам доигрывает их через computeAiTurnPlan, как и AI-слоты (см. weGoRound.ts).
 * Списывает время планирования каждому живому игроку (accountRoundTime — переводит под перманентный
 * AI тех, кто исчерпал сессионный лимит, см. weGoScheduler.ts), затем закрывает раунд (удаляет
 * клоны). Не открывает следующий раунд сама — это решение вызывающей стороны (wsServer.ts),
 * зависящее от того, объявлен ли уже победитель.
 */
export function resolveOpenRound(session: GameSession, now: number): RoundReport {
  const runtime = runtimes.get(session.id);
  const playerPlans = new Map<number, RoundPlanStep[]>();
  const readyAt = new Map<number, number>();
  const liveIds = session.players.map((p) => p.id).filter((id) => !session.eliminatedPlayers.has(id));
  if (runtime) {
    for (const [playerId, state] of runtime.players) {
      if (state.readyAt !== null) {
        playerPlans.set(playerId, state.steps);
        readyAt.set(playerId, state.readyAt);
      }
    }
  }
  accountRoundTime(session, liveIds, readyAt, now);
  const report = resolveWeGoRound(session, playerPlans);
  runtimes.delete(session.id);
  return report;
}

export function clearRuntime(roomId: string) {
  runtimes.delete(roomId);
}
