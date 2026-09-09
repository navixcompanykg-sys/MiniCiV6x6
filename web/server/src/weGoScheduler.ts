import { GameSession } from "./GameSession";

/**
 * Чистые функции таймеров WeGo — принимают `now` явным параметром, НЕ читают Date.now() внутри
 * бизнес-логики (по плану — чтобы тестировать прохождение времени без реального sleep). Реальные
 * setTimeout/интервалы опроса — задача wsServer.ts (следующий этап), эти функции лишь принимают
 * решение "пора?" и обновляют персистентные поля сессии (roundDeadline/spentPlanningMs/
 * aiControlled), см. GameSession.ts.
 */

/** Открывает новое окно планирования раунда — вызывается сразу после resolveWeGoRound. */
export function openNewRound(session: GameSession, now: number) {
  session.roundOpenedAt = now;
  session.roundDeadline = now + session.roundTimeMs;
}

/** true, если раундовый таймер (roundTimeSec, по умолчанию 3 мин) истёк — пора форсировать
 * резолюцию раунда, не дожидаясь оставшихся неготовых игроков (см. resolveWeGoRound: они
 * доигрываются через computeAiTurnPlan). */
export function isRoundDeadlinePassed(session: GameSession, now: number): boolean {
  return session.roundDeadline !== null && now >= session.roundDeadline;
}

/**
 * Списывает потраченное на планирование время каждому живому игроку и переводит под перманентный
 * AI (aiControlled) тех, кто исчерпал сессионный лимит (sessionTimeMs, по умолчанию 90 мин
 * суммарно за партию). Вызывается один раз при закрытии раунда (после resolveWeGoRound, до
 * openNewRound для следующего).
 *
 * `readyAt` — playerId → unix ms момента, когда игрок сам сдал план (`readyForRound`); отсутствие
 * записи означает игрок не успел — ему засчитывается ПОЛНОЕ окно раунда (`roundTimeMs`), как и
 * требует план ("по истечению таймера 1 хода ход доходит AI"). Уже находящиеся под aiControlled
 * игроки время не тратят вовсе — им никогда не открывается окно планирования (см. план, §6).
 */
export function accountRoundTime(session: GameSession, liveIds: number[], readyAt: Map<number, number>, now: number) {
  const opened = session.roundOpenedAt ?? now;
  for (const id of liveIds) {
    if (session.aiControlled.has(id)) continue;
    const finishedAt = readyAt.get(id) ?? now;
    const spent = Math.max(0, Math.min(finishedAt - opened, session.roundTimeMs));
    session.spentPlanningMs[id] = (session.spentPlanningMs[id] ?? 0) + spent;
    if (session.spentPlanningMs[id] >= session.sessionTimeMs) session.aiControlled.add(id);
  }
}
