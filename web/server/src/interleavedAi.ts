import { GameSession } from "./GameSession";
import { computeAiTurnPlan, type AiPlanStep } from "./bot";

/**
 * «Против AI» (по прямому запросу — «имитируем одновременность ходов тем что игрок делает 1 действие
 * и каждый AI делает 1 действие, и после всех ходов игрока доигрывает остальные действия если
 * остались») — вместо старой модели «сначала весь ход человека, потом весь ход каждого AI по
 * очереди» (bot.ts: runAutoPlayLoop/playAiTurnPaced), здесь КАЖДОЕ действие человека внутри его же
 * хода triggers ровно ОДИН шаг плана каждого ещё не доигравшего в этом цикле AI — человек видит, как
 * AI действуют между его собственными кликами, а не одним рывком после конца его хода. Когда человек
 * реально завершает ход (endTurn), любой AI, чей план ещё не исчерпан (человек сделал меньше действий,
 * чем было шагов в плане AI), доигрывает остаток разом — см. finishRemainingAi.
 *
 * Планы (`computeAiTurnPlan`) считаются ЛЕНИВО, по одному на AI, при первом обращении к нему в
 * рамках цикла — на ТЕКУЩЕМ состоянии сессии на тот момент (уже включающем всё, что успели сделать
 * человек и другие AI до этого шага), не на снимке начала хода. Тот же приём "impersonate и dispatch
 * на общей сессии", что и в weGoRound.ts — переиспользует существующий dispatch() без единой правки
 * боевой/экономической логики; терминальный шаг плана "endTurn" реплеится как "closeRound" (не
 * продвигает currentPlayerIndex по-настоящему — иначе улетели бы прямо на следующего игрока посреди
 * хода человека), тот же трюк, каким weGoRound.ts переигрывает AI-план на общей сессии.
 */

interface AiPlanCursor {
  steps: AiPlanStep[];
  nextIndex: number;
}

interface RoomInterleaveState {
  /** session.cyclesElapsed, на котором это состояние построено — при смене цикла создаётся заново
   * (новый круг ходов — каждый AI имеет право снова действовать). */
  cycle: number;
  cursors: Map<number, AiPlanCursor>;
  /** AI, чей план в ЭТОМ цикле уже полностью доигран (интерливингом или finishRemainingAi) — им
   * больше не нужен новый план и не нужно повторное исполнение при driveAiTurns (bot.ts). */
  done: Set<number>;
}

const states = new Map<string, RoomInterleaveState>();

function getState(session: GameSession): RoomInterleaveState {
  let s = states.get(session.id);
  if (!s || s.cycle !== session.cyclesElapsed) {
    s = { cycle: session.cyclesElapsed, cursors: new Map(), done: new Set() };
    states.set(session.id, s);
  }
  return s;
}

function cursorFor(session: GameSession, aiId: number, state: RoomInterleaveState): AiPlanCursor {
  let cursor = state.cursors.get(aiId);
  if (!cursor) {
    // currentPlayerIndex ДО computeAiTurnPlan — оно клонирует ЖИВОЕ состояние сессии как есть,
    // включая currentPlayerIndex на момент вызова; если он всё ещё указывает на человека (а не на
    // этого AI), весь план проваливается на первой же проверке "это точно ход этого playerId?"
    // внутри планирования (тот же баг уже находили и чинили в weGoRound.ts).
    const savedIndex = session.currentPlayerIndex;
    session.currentPlayerIndex = session.players.findIndex((p) => p.id === aiId);
    cursor = { steps: computeAiTurnPlan(session, aiId).steps, nextIndex: 0 };
    session.currentPlayerIndex = savedIndex;
    state.cursors.set(aiId, cursor);
  }
  return cursor;
}

function dispatchOneStep(session: GameSession, aiId: number, cursor: AiPlanCursor) {
  const aiIdx = session.players.findIndex((p) => p.id === aiId);
  session.currentPlayerIndex = aiIdx;
  const step = cursor.steps[cursor.nextIndex++];
  const action = step.action === "endTurn" ? "closeRound" : step.action;
  session.dispatch(action, aiId, step.payload);
}

/** true — этот AI в текущем цикле УЖЕ полностью доиграл (через интерливинг или finishRemainingAi) —
 * driveAiTurns (bot.ts/wsServer.ts) должен пропустить его без нового computeAiTurnPlan, иначе раздача
 * карт/сброс бюджета применились бы ему ДВАЖДЫ за один цикл. */
export function isDoneThisCycle(session: GameSession, aiId: number): boolean {
  return getState(session).done.has(aiId);
}

/** Отмечает AI доигранным в этом цикле БЕЗ применения плана — для случаев, когда его полный ход уже
 * применён каким-то ДРУГИМ путём (bot.ts: runAutoPlayLoop, старый способ полного хода разом — им всё
 * ещё пользуется самый первый ход партии, если он сразу AI, до того как человек вообще успел
 * сходить). Без этой отметки interleavedAi дал(а) бы такому AI ЕЩЁ один раунд действий в том же
 * цикле при следующем действии человека. */
export function markDone(session: GameSession, aiId: number) {
  getState(session).done.add(aiId);
}

/** Ровно ОДИН шаг плана КАЖДОГО ещё не доигравшего в этом цикле AI — вызывается после успешного
 * действия человека, которое НЕ было его собственным endTurn (тот случай — см. finishRemainingAi).
 * currentPlayerIndex временно переключается на каждого AI по очереди и восстанавливается на человека
 * в конце — сам человек за это время не двигается по очереди (endTurn здесь не вызывается вовсе). */
export function stepAllAi(session: GameSession) {
  const state = getState(session);
  const humanIndex = session.currentPlayerIndex;
  for (const p of session.players) {
    if (!p.isAI || state.done.has(p.id)) continue;
    const cursor = cursorFor(session, p.id, state);
    if (cursor.nextIndex >= cursor.steps.length) {
      state.done.add(p.id);
      continue;
    }
    dispatchOneStep(session, p.id, cursor);
    if (cursor.nextIndex >= cursor.steps.length) state.done.add(p.id);
  }
  session.currentPlayerIndex = humanIndex;
}

/** Человек только что по-настоящему завершил ход (endTurn уже применён, currentPlayerIndex уже
 * сдвинут дальше по-настоящему) — доигрывает ОСТАВШИЕСЯ шаги любого AI, чей план в этом цикле ещё не
 * исчерпан (человек сделал МЕНЬШЕ действий, чем было шагов в плане AI — интерливинг не успел раздать
 * всё). `onBroadcast` вызывается после каждого шага, тем же паттерном, что и старый playAiTurnPaced —
 * человек видит происходящее, не одним немым скачком. currentPlayerIndex восстанавливается на то
 * значение, что было ПОСЛЕ настоящего endTurn (натуральный следующий игрок), не трогается сверх
 * необходимого для самого доигрывания. */
export async function finishRemainingAi(session: GameSession, onBroadcast: () => Promise<void>): Promise<void> {
  const state = getState(session);
  const restoreIndex = session.currentPlayerIndex;
  for (const p of session.players) {
    if (!p.isAI || state.done.has(p.id)) continue;
    const cursor = cursorFor(session, p.id, state);
    while (cursor.nextIndex < cursor.steps.length) {
      dispatchOneStep(session, p.id, cursor);
      await onBroadcast();
    }
    state.done.add(p.id);
  }
  session.currentPlayerIndex = restoreIndex;
}
