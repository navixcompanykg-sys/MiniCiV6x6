import { GameSession } from "./GameSession";
import { mulberry32 } from "../../src/map/rand";
import { computeAiTurnPlan } from "./bot";

/** Один шаг записанного плана игрока — тот же формат, что и dispatch-вызов внутри AiPlanStep
 * (bot.ts), только без метаданных для UI-предпросмотра (те нужны только на клиенте). */
export interface RoundPlanStep {
  action: string;
  payload: unknown;
}

export interface RoundStepReport {
  action: string;
  ok: boolean;
  hint?: string;
}

export interface RoundReport {
  /** Порядок, в котором игроки реплеились в этом раунде — детерминированный, но не совпадает с
   * порядком id, чтобы не давать систематического преимущества «первому» при конфликтах на общих
   * ресурсах (рынок/регион/город). */
  order: number[];
  steps: Record<number, RoundStepReport[]>;
}

/** Детерминированный, но не предсказуемый заранее порядок игроков для ОДНОГО раунда — отдельный
 * mulberry32 от session.rngSeed⊕cyclesElapsed, не session.rng(): не потребляет и не смещает игровой
 * RNG-поток сессии (rngCallCount), которым считаются катастрофы и прочая игровая случайность. */
function roundPlayerOrder(session: GameSession, liveIds: number[]): number[] {
  const rng = mulberry32((session.rngSeed ^ session.cyclesElapsed) >>> 0);
  const order = [...liveIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Разрешает один WeGo-раунд на общей (shared) сессии — «слепое планирование → детерминированный
 * реплей», см. план архитектуры. Для каждого живого игрока в детерминированном порядке раунда
 * (roundPlayerOrder) подставляет currentPlayerIndex на него и реплеит его план через ОБЫЧНЫЙ
 * dispatch() — тот же метод, каким сегодня пользуется хотсит и AI-бот, без единой правки боевой/
 * экономической/дипломатической логики: конфликты на общих ресурсах (рынок/регион/осада) решаются
 * сами собой порядком реплея, dispatch просто вернёт ok:false тому, кто попытался позже.
 *
 * `playerPlans` — планы живых людей, успевших сдать ход (см. weGoScheduler.ts, будущий этап). Игрок
 * без записи в этой карте — AI или не успевший вовремя человек — планируется «на месте», заново,
 * уже на состоянии сессии ПОСЛЕ предыдущих игроков этого же раунда (честнее, чем план по снимку
 * начала раунда). После всех игроков — РОВНО ОДИН РАЗ resolveCycleBoundary().
 *
 * Шаг "endTurn" в любом плане (так всегда заканчивается AiPlanStep — см. bot.ts) реплеится как
 * "closeRound": endTurn вызвал бы advanceCurrentPlayer настоящей сессии, что в WeGo-раунде не имеет
 * смысла — переход к следующему раунду делает сам resolveWeGoRound, один раз для всех сразу.
 */
export function resolveWeGoRound(session: GameSession, playerPlans: Map<number, RoundPlanStep[]>): RoundReport {
  const liveIds = session.players.map((p) => p.id).filter((id) => !session.eliminatedPlayers.has(id));
  const order = roundPlayerOrder(session, liveIds);
  const report: RoundReport = { order, steps: {} };

  for (const playerId of order) {
    const idx = session.players.findIndex((p) => p.id === playerId);
    // currentPlayerIndex ДО computeAiTurnPlan — оно клонирует ЖИВОЕ состояние сессии как есть
    // (structuredClone(session.toJSON())), включая currentPlayerIndex на момент вызова; если он
    // всё ещё указывает на предыдущего в порядке раунда игрока, весь план на клоне проваливается
    // на первой же проверке "это точно ход этого playerId?" (dispatch/endTurn), и от AI-игрока не
    // остаётся ни одного шага.
    session.currentPlayerIndex = idx;
    const plan = playerPlans.get(playerId) ?? computeAiTurnPlan(session, playerId).steps;
    const stepReports: RoundStepReport[] = [];
    for (const step of plan) {
      const action = step.action === "endTurn" ? "closeRound" : step.action;
      const result = session.dispatch(action, playerId, step.payload);
      stepReports.push({ action: step.action, ok: result.ok, hint: result.hint });
    }
    report.steps[playerId] = stepReports;
  }

  session.resolveCycleBoundary();
  return report;
}
