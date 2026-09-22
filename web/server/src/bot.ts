// Простой эвристический AI (по прямому запросу — «Сделай простого AI который играет карты...») —
// ходит вместо реального человека за игрока с Player.isAI===true (см. placement.ts). Работает
// ИСКЛЮЧИТЕЛЬНО через GameSession.dispatch, ровно как обычный клиент — никаких привилегированных
// обходов проверок, любая попытка может законно провалиться (`ok:false`), это ожидаемо и не ошибка.
//
// Стратегия «подбора цели» везде одна и та же — перебор кандидатов (свои города, виды юнитов,
// технологии, здания) с реальным dispatch-вызовом на каждый и остановкой на первом успехе.
//
// Предпросмотр хода (по прямому запросу — «прежде чем ходить подсвечивай какие карты куда хочет
// сыграть AI... AI пока не перематывает сам, все ходы совершаются после кнопки завершить ход») —
// ход бота теперь двухфазный:
//   1. computeAiTurnPlan() прогоняет ВСЮ логику хода на ОДНОРАЗОВОМ КЛОНЕ сессии (GameSession.
//      fromJSON(toJSON()) — тот же сид и то же число уже потраченных вызовов rng(), поэтому клон
//      детерминированно продолжает ТУ ЖЕ случайную последовательность, что и оригинал) и просто
//      ЗАПОМИНАЕТ каждый успешный dispatch-вызов (действие+payload+то, что нужно клиенту для
//      отрисовки линии/подписи) — состояние настоящей сессии при этом не трогается вообще.
//   2. executeAiPlan() позже (по кнопке игрока — см. wsServer.ts "confirmAiTurn") просто ПОВТОРЯЕТ
//      ровно эти же dispatch-вызовы на настоящей сессии — раз между планированием и подтверждением
//      состояние партии не менялось (это единолично ход этого AI, играть больше некому), поток
//      rng() продолжается в точности с того же места, так что результат идентичен предпросмотру
//      бит-в-бит, включая случайные исходы (катастрофа и т.п.).
//
// Лог действий (по прямому запросу — «Пиши лог действий AI чтоб проанализировать игру») пишется
// ТОЛЬКО при реальном выполнении (executeAiPlan), не при планировании на одноразовом клоне — один
// файл на комнату, web/server/data/ai-log-<roomId>.txt, построчно, дописывается синхронно.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GameSession,
  CARDS_DEALT_PER_TURN,
  HAND_SIZE,
  type Proposal,
  type ProposalTerm,
  type UnitInstance,
  type Paradigm,
  type Religion,
  type Agreement,
  type MarketListing,
  type City,
  type OonResolutionType,
  type OonResolutionParams,
  type WarPlan,
  type PendingWarPlanInfo,
  type PendingBorderThreatInfo,
  type Army,
  type ArmyTemplate,
  type Fleet,
  type ArmyBuildOrder,
} from "./GameSession";
import { freshDeck } from "../../src/game/cards";
import { builtBy, isOwnedBy } from "../../src/game/buildings";
import { BUILDINGS, type BuildingDef } from "../../src/game/buildings";
import { UNITS, CATEGORIES, CATEGORY_META, statsFor } from "../../src/game/units";
import type { UnitCategory } from "../../src/game/units";
import { TECH_TREE, BRANCHES } from "../../src/game/techtree";
import type { TechDef } from "../../src/game/techtree";
import { REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H, MAP_WIDTH, MAP_HEIGHT } from "../../src/map/mapDoc";
import { hexNeighborsWrapped } from "../../src/map/hexMath";
import { RESOURCES, type ResourceId } from "../../src/map/types";
import type { CardDef } from "../../src/game/cards";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
let dataDirEnsured = false;

/** Что рисовать на клиенте для этого шага (по прямому запросу): «city»/«hex»/«building»/«tech» —
 * линия от карты к цели; «player» — карта передаётся другому игроку (большая стрелка над картой,
 * см. main.ts); «market»/«proposal»/«none» — только текстовая строка в списке, без линии (нет
 * осмысленной точки на экране, куда указывать). */
export type AiPlanTargetKind = "city" | "hex" | "building" | "tech" | "player" | "market" | "proposal" | "paradigm" | "none";

export interface AiPlanStep {
  /** 1-based — порядок розыгрыша, тот самый номер на линии. */
  order: number;
  /** Имя действия и payload — ровно то, что уйдёт в GameSession.dispatch при подтверждении хода. */
  action: string;
  payload: Record<string, unknown>;
  /** Слот карты в руке НА МОМЕНТ этого шага (для подсветки карты и последующих шагов той же руки —
   * индексы сдвигаются по мере розыгрыша, каждый шаг помнит свой актуальный на тот момент индекс). */
  cardSlotIndex?: number;
  cardId?: string;
  /** Приказ юниту (commandUnit/toggleDefend, по прямому запросу — «команды военным юнитам так же
   * отмечаются на карте... какой юнит куда собирается идти») — в отличие от карточных шагов, здесь
   * НЕТ слота руки: линия должна идти от ТЕКУЩЕЙ клетки юнита (запомненной на момент планирования,
   * не пересчитанной из текущего состояния — юнит мог с тех пор ещё не сдвинуться в настоящей
   * сессии, но порядок шагов в плане уже определён) к цели. */
  sourceUnitId?: number;
  sourceCol?: number;
  sourceRow?: number;
  /** Использование ЗДАНИЯ без карты (Космодром/Ядерный арсенал/Склад и т.п., см. §5 «Здания») — по
   * прямому запросу («использование зданий в план тоже пиши, и если здание действует на город или
   * гекс, так же стрелку строй как от карты»): здесь тоже нет карты в руке, линия должна идти от
   * ИКОНКИ ЭТОГО ЗДАНИЯ в панели построек (`.bld[data-bld=...]`, main.ts), а не от карты и не от
   * юнита. Здание, действующее САМО НА СЕБЯ (Космодром — цель тоже "building" и targetBuildingId
   * совпадает с этим полем), линии не получает вовсе, только подсветку/бейдж — стрелка в никуда была
   * бы бессмысленна. */
  sourceBuildingId?: string;
  targetKind: AiPlanTargetKind;
  targetCityId?: number;
  targetCol?: number;
  targetRow?: number;
  targetBuildingId?: string;
  targetTechId?: string;
  targetPlayerId?: number;
  targetResource?: ResourceId;
  /** Человекочитаемое описание — и для списка на клиенте, и (при исполнении) для файла лога. */
  label: string;
}

interface Reporter {
  step(meta: Omit<AiPlanStep, "order">): void;
}

function makePlanReporter(steps: AiPlanStep[]): Reporter {
  return {
    step(meta) {
      steps.push({ ...meta, order: steps.length + 1 });
    },
  };
}

function makeFileLogger(session: GameSession, playerId: number) {
  const name = session.players.find((p) => p.id === playerId)?.name ?? `Игрок ${playerId}`;
  const file = path.join(DATA_DIR, `ai-log-${session.id}.txt`);
  return (message: string) => {
    try {
      if (!dataDirEnsured) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        dataDirEnsured = true;
      }
      fs.appendFileSync(file, `[${new Date().toISOString()} цикл ${session.cyclesElapsed} ${name}] ${message}\n`, "utf-8");
    } catch {
      /* лог — вспомогательная диагностика, не должен ронять ход бота */
    }
  };
}

/** Сводка для предпросмотра хода (§15.6 СПРАВОЧНИКА, `PendingWarPlanInfo`) — по прямому уточнению:
 * «план войны — это не война, это подготовка к экспансии, и она ВСЕГДА ведётся, а у тебя ни у кого не
 * отображается» — формальный `session.warPlans[playerId]` заводится ТОЛЬКО при плохих отношениях
 * (`considerWarPlan`, `relationScoreOf < TRIBUTE_RELATION_MIN`, см. её doc) — при нейтральных и
 * хороших отношениях к цели этого объекта нет вовсе, хотя САМА ЦЕЛЬ (куда расширяться/чей ресурс
 * нужен) `findResourceShortageTarget`/`findExpansionTarget` продолжают вычислять и предлагать
 * дипломатии (вежливая просьба/дань-ультиматум) каждый ход — это и должно быть видно человеку
 * ВСЕГДА, не только когда дело дошло до военной эскалации. Формальный план (если есть) — приоритетнее
 * и помечен `isFormalPlan: true`; иначе — тот же кандидат, что сейчас использовала бы дипломатия,
 * `isFormalPlan: false` (человеку показывается тем же приёмом, просто без силового значения). */
function computePendingWarPlanInfo(session: GameSession, playerId: number): PendingWarPlanInfo | null {
  const wp = session.warPlans[playerId];
  if (wp) {
    const city = warPlanCityOf(session, wp);
    return {
      targetPlayerId: wp.targetId,
      cause: wp.cause,
      resource: wp.resource ?? null,
      regionCol: wp.regionCol,
      regionRow: wp.regionRow,
      targetCityCol: city?.col ?? null,
      targetCityRow: city?.row ?? null,
      requiresNavy: wp.requiresNavy,
      isFormalPlan: true,
    };
  }
  const found = findResourceShortageTarget(session, playerId);
  const candidate = found ?? findExpansionTarget(session, playerId);
  if (!candidate) return null;
  const city = session.cities.find((c) => c.playerId === candidate.targetId && c.regionCol === candidate.regionCol && c.regionRow === candidate.regionRow) ?? null;
  return {
    targetPlayerId: candidate.targetId,
    cause: found ? "resourceShortage" : "expansion",
    resource: found ? found.resource : null,
    regionCol: candidate.regionCol,
    regionRow: candidate.regionRow,
    targetCityCol: city?.col ?? null,
    targetCityRow: city?.row ?? null,
    requiresNavy: planRequiresNavy(session, playerId, candidate.regionCol, candidate.regionRow),
    isFormalPlan: false,
  };
}

/** Точка входа для wsServer.ts — вызывается после create/join/action/confirmAiTurn: пока текущий
 * игрок — бот, продвигает партию. Расстановка (нет карт, нечего подсвечивать) по-прежнему
 * выполняется сразу целиком; игровая фаза теперь ОСТАНАВЛИВАЕТСЯ на первом же AI-игроке и только
 * ЗАПОМИНАЕТ план его хода (`session.pendingAiPlan`) — сам ход не совершается, пока игрок не нажмёт
 * подтверждение (см. executeAiPlan/wsServer.ts "confirmAiTurn"). guard — защита от зависания при
 * непредвиденном баге, не настоящий бесконечный цикл. */
export function prepareNextAiPlanIfNeeded(session: GameSession): void {
  let guard = 0;
  while (guard++ < 200) {
    if (session.winner !== null) {
      session.pendingAiPlan = null;
      return;
    }
    const current = session.players[session.currentPlayerIndex];
    if (!current || !current.isAI) {
      session.pendingAiPlan = null;
      return;
    }
    if (session.phase === "placement") {
      runAiPlacement(session, current.id);
      continue; // расстановка не требует подтверждения — идём дальше, пока не дойдём до playing
    }
    if (session.phase === "playing") {
      if (session.pendingAiPlan?.playerId === current.id) return; // план уже посчитан — ждём кнопку
      const plan = computeAiTurnPlan(session, current.id);
      session.pendingAiPlan = {
        playerId: current.id,
        steps: plan.steps,
        strategicPriority: plan.strategicPriority,
        warPlan: computePendingWarPlanInfo(session, current.id),
        borderThreat: findBorderThreatRegion(session, current.id),
      };
      return;
    }
    return;
  }
}

/** Армии/флоты (§15.9а) — синхронизация AI-памяти НА НАСТОЯЩЕЙ сессии, вызывается ПЕРВОЙ строкой
 * `computeAiTurnPlan`, ДО клонирования (см. её doc ниже) — по прямому уточнению (живая правка на этом
 * же заходе, тот же класс проблемы, что уже когда-то чинили для `diplomacyAttemptMemory`): всё, что
 * `runAiTurnLogic` мутирует НАПРЯМУЮ (не через `session.dispatch`, у которого шаг честно реплеится при
 * подтверждении хода), физически не может произойти внутри клона планирования — клон выбрасывается
 * сразу после возврата шагов, а сами шаги при подтверждении лишь ПОВТОРЯЮТ записанные dispatch-вызовы,
 * не выполняют `runAiTurnLogic` заново. Чистка (`pruneArmies` — погибшие члены/слияние остатков),
 * пары кораблей (`pairFreeShipsIntoFleets`) и заявки на постройку (`ensureArmyBuildOrders`) поэтому
 * выполняются здесь, на РЕАЛЬНОМ `session`, — клон, созданный чуть ниже, унаследует уже
 * синхронизированный результат тем же путём, каким наследует любое другое поле настоящей сессии. */
function syncAiMemoryBeforePlanning(session: GameSession, playerId: number) {
  pruneArmies(session, playerId);
  pairFreeShipsIntoFleets(session, playerId);
  ensureArmyBuildOrders(session, playerId);
}

/** Прогоняет весь ход AI-игрока на клоне сессии, ничего не меняя в настоящей — возвращает
 * запомненные шаги для показа игроку.
 *
 * [ИСПРАВЛЕНО] `session.toJSON()` НЕ делает глубокую копию — большинство полей (`hands`, `cities`,
 * `units`, `doc.tiles`, ...) в нём это ПРЯМЫЕ ссылки на живые массивы/объекты настоящей сессии
 * (`GameSession.fromJSON(id, save)` дальше просто присваивает эти же ссылки полям клона, см. его
 * тело). Без structuredClone здесь розыгрыш карт на «клоне» — growCity's `city.population++`,
 * buildUnitCard's `this.units.push(...)`, chopForest's `this.doc.set(...)` и т.п. — на самом деле
 * мутировал НАСТОЯЩУЮ сессию прямо во время планирования, до всякого подтверждения игроком (живой
 * баг-репорт при разработке — карта числилась разыгранной уже на предпросмотре, а при подтверждении
 * повторный dispatch того же слота честно проваливался «карта недоступна», т.к. её уже съел клон).
 * structuredClone здесь — глубокая копия ВСЕГО дерева (массивы/объекты/Set/Map — все поддерживаются
 * нативно), так что клон и оригинал больше не делят ни одного изменяемого объекта.
 *
 * `strategicPriority` (по прямому запросу) — метка общего стратегического режима, вычисляется ОДИН
 * РАЗ, ДО розыгрыша шагов (см. computeStrategicPriority) — заголовок предпросмотра хода, показывает
 * человеку, чем сейчас руководствуется бот. Сами шаги ниже (masterCardPriorityFor/
 * decideUnitCategoryPriority) пересчитывают режим заново на каждый свой вызов, а не читают это
 * значение — если что-то посреди хода само сменит режим (например, была объявлена война), их
 * решения это сразу отразят; значение здесь — снимок «на начало хода», для заголовка. */
export function computeAiTurnPlan(session: GameSession, playerId: number): { steps: AiPlanStep[]; strategicPriority: StrategicPriority } {
  // Армии/флоты (§15.9а) — синхронизируются на НАСТОЯЩЕЙ сессии, ДО клонирования ниже (см. доку
  // syncAiMemoryBeforePlanning — почему это не может подождать и произойти внутри клона, как раньше).
  syncAiMemoryBeforePlanning(session, playerId);
  const snapshot = structuredClone(session.toJSON());
  const clone = GameSession.fromJSON(session.id, snapshot);
  const strategicPriority = computeStrategicPriority(clone, playerId);
  const steps: AiPlanStep[] = [];
  const reporter = makePlanReporter(steps);
  // Заморож. ход (смена парадигмы/религии — «революция», штраф «Мобилизации», ТЗ 11.6) — по прямому
  // уточнению единственное допустимое действие в такой ход — сам переход хода без раздачи карт/
  // бюджета (см. GameSession.endTurn — коротким путём, когда `pendingSkipTurn === playerId`; тот же
  // путь, что у человека при клике «Пропустить» в модалке). [ИСПРАВЛЕНО, живой баг-репорт — «колода
  // худеет при смене парадигмы/религии, хотя ТЗ прямо запрещает выдавать карты игроку, пропускающему
  // ход»] — раньше это нигде не проверялось: `runAiTurnLogic` ничего не знает о `pendingSkipTurn` и
  // честно доигрывал «замороженный» ход как обычный — карты из руки, добор с пустой руки через
  // `tryDrawCardFromDeck` (реально тратит колоду!), дипломатия, даже повторная смена парадигмы/
  // религии. Единственное, что реально блокировалось — раздача карт НА СЛЕДУЮЩИЙ ход внутри самого
  // финального `endTurn`; всё, что бот успевал сделать ДО него в тот же ход, оставалось в силе —
  // прямое нарушение ТЗ, просто внешне выглядевшее как «пропуск» (в предпросмотре хода до этой правки
  // было полно шагов, ход всё равно завершался «Пропустить»-кнопкой в UI, только для человека, а бот
  // это игнорировал). Теперь ход, начинающийся с `pendingSkipTurn === playerId`, сразу сводится к
  // одному-единственному `endTurn` — ровно тому же короткому пути, что у человека.
  if (clone.pendingSkipTurn === playerId) {
    endBotTurn(clone, playerId, reporter);
    return { steps, strategicPriority };
  }
  runAiTurnLogic(clone, playerId, reporter);
  return { steps, strategicPriority };
}

/** Действительно совершает ход — повторяет ровно те dispatch-вызовы, что были записаны при
 * планировании (см. заголовок файла — почему это даёт идентичный результат), на этот раз на
 * настоящей сессии, и пишет каждый шаг в файловый лог. */
export function executeAiPlan(session: GameSession, playerId: number): void {
  const plan = session.pendingAiPlan;
  session.pendingAiPlan = null;
  if (!plan || plan.playerId !== playerId) return;
  const log = makeFileLogger(session, playerId);
  log(`--- Ход начинается ---`);
  for (const step of plan.steps) {
    const result = session.dispatch(step.action, playerId, step.payload);
    log(`${step.label}${result.ok ? "" : ` (не удалось повторить: ${result.hint ?? "?"})`}`);
  }
  log(`--- Ход завершён ---`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Пауза между действиями AI в режиме «Против AI» (по прямому запросу — «каждая команда с небольшой
 * задержкой имитируя игрока») — не настраивается извне, единое значение для всей игры. */
const AUTO_PLAY_STEP_DELAY_MS = 900;

/** «Против AI» (по прямому запросу): в отличие от хотсита (executeAiPlan — весь ход одним рывком по
 * кнопке подтверждения), здесь план считается и сразу проигрывается сам, шаг за шагом, с паузой
 * между ними — `onBroadcast` вызывается после КАЖДОГО применённого шага (обычно — сохранить и
 * разослать состояние), так что человек на экране видит происходящее постепенно, в темпе реального
 * игрока, а не одним скачком. `session.pendingAiPlan` здесь вообще не используется и не
 * выставляется — в хотсите это и есть сам предпросмотр (см. prepareNextAiPlanIfNeeded), а «Против
 * AI» по прямому запросу («игрок не видит как ходит ИИ») никакого предпросмотра не показывает. */
export async function playAiTurnPaced(session: GameSession, playerId: number, onBroadcast: () => Promise<void>): Promise<void> {
  const { steps } = computeAiTurnPlan(session, playerId);
  const log = makeFileLogger(session, playerId);
  log(`--- Ход начинается (авто, "Против AI") ---`);
  for (const step of steps) {
    await sleep(AUTO_PLAY_STEP_DELAY_MS);
    const result = session.dispatch(step.action, playerId, step.payload);
    log(`${step.label}${result.ok ? "" : ` (не удалось повторить: ${result.hint ?? "?"})`}`);
    await onBroadcast();
  }
  log(`--- Ход завершён ---`);
}

/** Полный автоматический цикл ходов AI-игроков в режиме «Против AI» — вызывается из wsServer.ts
 * (fire-and-forget, не await'ится вызывающим кодом целиком) после create/join/action, пока
 * currentPlayerIndex указывает на AI: расстановка доигрывается сразу целиком (нет карт, задержка не
 * нужна), игровые ходы — по одному действию с паузой (см. playAiTurnPaced). Останавливается сама,
 * как только очередь дошла до человека или партия закончилась — вызывающий код просто один раз
 * запускает цикл и забывает про него, дальше он сам ведёт себя до конца. guard — защита от
 * зависания, не настоящий бесконечный цикл. */
export async function runAutoPlayLoop(session: GameSession, onBroadcast: () => Promise<void>): Promise<void> {
  let guard = 0;
  while (guard++ < 200) {
    if (session.winner !== null) return;
    const current = session.players[session.currentPlayerIndex];
    if (!current || !current.isAI) return;
    if (session.phase === "placement") {
      runAiPlacement(session, current.id);
      await onBroadcast();
      continue;
    }
    if (session.phase !== "playing") return;
    await playAiTurnPaced(session, current.id, onBroadcast);
  }
}

// === Фаза расстановки (без предпросмотра — нет карт, подсвечивать нечего) ======================

export function runAiPlacement(session: GameSession, playerId: number) {
  const log = makeFileLogger(session, playerId);
  const regions: { rc: number; rr: number }[] = [];
  for (let rc = 0; rc < REGION_GRID_W; rc++) for (let rr = 0; rr < REGION_GRID_H; rr++) regions.push({ rc, rr });
  for (let i = regions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [regions[i], regions[j]] = [regions[j], regions[i]];
  }
  let placed = 0;
  for (const { rc, rr } of regions) {
    if (placed >= 3) break;
    if (session.players[session.currentPlayerIndex]?.id !== playerId) break;
    const site = session.pickCitySiteInRegion(rc, rr) ?? {
      col: rc * REGION_SIZE_X + Math.floor(REGION_SIZE_X / 2),
      row: rr * REGION_SIZE_Y + Math.floor(REGION_SIZE_Y / 2),
    };
    const result = session.dispatch("placeToken", playerId, { col: site.col, row: site.row });
    if (result.ok) {
      placed++;
      log(`Разместил жетон #${placed} в регионе (${rc},${rr}).`);
    }
  }
}

// === Игровая фаза — вся логика одного хода, параметризована Reporter'ом ========================

function runAiTurnLogic(session: GameSession, playerId: number, reporter: Reporter) {
  resolveHazards(session, playerId, reporter);
  considerOonVote(session, playerId, reporter);
  considerOonWorldLeaderVote(session, playerId, reporter);
  considerOonSecretaryVote(session, playerId, reporter);
  resolveIncomingProposals(session, playerId, reporter);
  considerWarPlan(session, playerId, reporter);
  considerWarDeclaration(session, playerId, reporter);
  // Армии/флоты (§15.9а) — НЕ здесь: чистка/заявки на постройку (pruneArmies/pairFreeShipsIntoFleets/
  // ensureArmyBuildOrders) должны мутировать НАСТОЯЩУЮ сессию, а эта функция целиком выполняется на
  // ОДНОРАЗОВОМ КЛОНЕ (см. computeAiTurnPlan) — прямая мутация здесь была бы видна только внутри
  // текущего планирования и никогда не долетела бы до настоящей партии (тот же класс бага, что раньше
  // чинили для diplomacyAttemptMemory). Вместо этого — syncAiMemoryBeforePlanning вызывается РАНЬШЕ,
  // на настоящей сессии, ДО клонирования (см. её вызов в computeAiTurnPlan) — клон уже видит
  // синхронизированный результат к этому месту, как будто вызов был здесь.
  // considerPeaceOffers/considerRelationDiplomacy (предложения, СОДЕРЖАЩИЕ offerMoney) НЕ здесь —
  // см. их вызов в конце функции, после трат хода.
  considerParadigm(session, playerId, reporter);
  considerReligion(session, playerId, reporter);
  considerCommunismCity(session, playerId, reporter);

  // Юниты, УЖЕ существовавшие на начало хода — приказы (в т.ч. атаки) ИМ раньше давались только ПОСЛЕ
  // всего карточного цикла ниже (розыгрыш карт, рост/постройка городов, «Торговец» — всё это тратит
  // деньги, включая докупку на бирже недостающих ресурсов) — по прямому запросу, живой баг-репорт:
  // «оранжевый в свой ход не захватил город, хотя точно мог» — юнит, стоящий вплотную к вражескому
  // городу и способный его атаковать, проигрывал в очереди за одним и тем же кошельком карточным
  // тратам этого же хода (каждый приказ юниту, включая атаку, стоит ровно 1💰, см.
  // GameSession.chargeUnitActivation) — к моменту, когда очередь доходила до него в `runMilitaryOrders`
  // (раньше вызывался ЕДИНСТВЕННЫЙ раз, уже после цикла), денег часто просто не оставалось, и приказ
  // ТИХО проваливался (тот же `commandUnit`, что и для игрока-человека, тем же кодом путём просто
  // падает на следующего кандидата/в оборону — без единой строчки в плане, объясняющей нехватку денег).
  // Теперь такие юниты получают приказы ЗДЕСЬ, ДО карточного цикла — первыми претендуют на бюджет хода,
  // а не последними. Юниты, построенные КАРТОЙ уже В ЭТОМ ходу (которых здесь физически ещё не
  // существует), как и раньше получают свой приказ сразу после цикла (см. вызов `runMilitaryOrders`
  // ниже, уже с обратным фильтром) — тем же ходом, без задержки на цикл.
  const unitsAtTurnStart = new Set(session.units.filter((u) => u.playerId === playerId).map((u) => u.id));
  runMilitaryOrders(session, playerId, reporter, (id) => unitsAtTurnStart.has(id));

  let guard = 0;
  while (session.players[session.currentPlayerIndex]?.id === playerId && guard++ < 80) {
    if (session.mustHandoff.has(playerId)) {
      doMandatoryHandoff(session, playerId, reporter);
      continue;
    }
    if (session.pendingTaxShortfall?.playerId === playerId || session.pendingCatastrophe?.playerId === playerId) {
      resolveHazards(session, playerId, reporter);
      continue;
    }
    if (session.pendingRoute?.playerId === playerId) {
      tryPickRouteCities(session, playerId, reporter);
      continue;
    }
    if (session.actionsLeft[playerId] <= 0) {
      // «Право прокладки маршрута» — по прямому запросу («это не карта, а остаточное право»)
      // бесплатно по действиям (GameSession.playRouteRightCard больше не проверяет/не списывает
      // actionsLeft) — единственная карта, которую всё ещё стоит попробовать сыграть, даже когда
      // обычные действия хода уже кончились; если карты в руке нет или разыграть некуда — честно
      // останавливаемся, как и раньше.
      if (tryAnyRouteRight(session, playerId, reporter)) continue;
      break;
    }

    if (tryActivateKosmodrom(session, playerId, reporter)) continue;
    if (tryLaunchNuclearStrike(session, playerId, reporter)) continue;
    if (tryActivateYadernyiArsenal(session, playerId, reporter)) continue;
    if (tryProposeOonResolution(session, playerId, reporter)) continue;
    // Карты-средства («Право прокладки», «Мобилизация») — до основного цикла: они не тратят действие
    // либо снимают сам лимит действий, поэтому не должны конкурировать за место в приоритете.
    if (playEnablerCards(session, playerId, reporter)) continue;
    if (pickAndPlayNextCard(session, playerId, reporter)) continue;
    if (tryActivateProductionBuildings(session, playerId, reporter)) continue;
    // По прямому запросу — «не должно быть несыгранного действия, если есть что играть»: в руке
    // реально нечего сыграть (см. pickAndPlayNextCard, включая её собственный «Рабочий»-фолбэк), но
    // действие ещё осталось — последний резерв: Склад (см. trySkladCollect выше), если он построен.
    if (trySkladCollect(session, playerId, reporter)) continue;
    // По прямому запросу («получить карту за действие с колоды... AI тоже добавь такую функцию») —
    // ЕЩЁ один резерв ПЕРЕД тем, как честно сдаться: рука к этому моменту пуста (иначе выше уже
    // что-то сыграло бы) — тот самый случай, для которого добор и завели («уже нет карт на руке, а
    // действия ещё есть»). Требует пустую руку (см. GameSession.drawCardFromDeck) — ЛЮБАЯ карта в
    // руке, включая бесплатные freeMonarchy/freeFascism/freeEducation, блокирует добор, поэтому
    // здесь достаточно просто попробовать и разобрать отказ (колода пуста/рука не пуста), не
    // дублируя проверку заранее.
    if (tryDrawCardFromDeck(session, playerId, reporter)) continue;
    // По прямому запросу («в плане пунктов, затрачивающих действие, меньше, чем actionsLeft — а
    // явного объяснения куда делось действие нет») — до этой правки такой обрыв цикла был ПОЛНОСТЬЮ
    // МОЛЧАЛИВЫМ: ни один шаг плана не сообщал, что действие(я) остались неиспользованными и
    // почему — со стороны выглядело так, будто бот просто не доиграл ход, хотя причина честная
    // (нечего сыграть, Склад/добор тоже не помогли — см. trySkladCollect/tryDrawCardFromDeck выше).
    // Теперь явный шаг в плане.
    if (session.actionsLeft[playerId] > 0) {
      reporter.step({
        action: "noop",
        payload: {},
        targetKind: "none",
        label: `Осталось неиспользованных действий: ${session.actionsLeft[playerId]} — в руке и на складе прямо сейчас больше нечем воспользоваться${session.hands[playerId].length === 0 ? ", колода тоже пуста" : ""}.`,
      });
    }
    break;
  }

  // Только юниты, ПОЯВИВШИЕСЯ за карточный цикл выше (постройка юнита картой/армией) — уже
  // существовавшие на начало хода получили приказ раньше (см. вызов до цикла) и здесь не трогаются
  // повторно (`unitsAtTurnStart` — тот же Set, отбор строго дополняющий).
  runMilitaryOrders(session, playerId, reporter, (id) => !unitsAtTurnStart.has(id));
  tryWarChestFireSale(session, playerId, reporter);
  marketPass(session, playerId, reporter);
  // По прямому запросу — живой баг-репорт «предложения дипломатии идут с суммами, которых уже нет у
  // AI»: считаются ПОСЛЕ всех трат хода (карты/юниты/военный сундук/биржа), а не в начале — иначе
  // offerMoney в предложении опирался на баланс ДО расходов этого же хода, и к моменту, когда
  // получатель решал принять (часто позже, на своём ходу), обещанных денег уже не было (сервер и так
  // атомарно отказывает в приёме без денег, см. GameSession.proposalUnaffordableReason, но сама
  // попытка предложения уже была основана на устаревшей сумме). `reservedMoneyForPendingProposals`
  // защищает только ДОБРОВОЛЬНЫЕ траты СЛЕДУЮЩИХ ходов (Мобилизация/биржа про запас, см. её доку) —
  // трату карт/юнитов ЭТОГО ЖЕ хода она не резервирует, поэтому единственный надёжный фикс — считать
  // предложение, когда все траты хода уже случились.
  considerPeaceOffers(session, playerId, reporter);
  considerRelationDiplomacy(session, playerId, reporter);
  endBotTurn(session, playerId, reporter);
}

// === Опасности, которые нужно разрешить независимо от того, чей сейчас ход =====================

function resolveHazards(session: GameSession, playerId: number, reporter: Reporter) {
  if (session.pendingCatastrophe?.playerId === playerId) {
    const result = session.dispatch("resolveCatastropheChoice", playerId, { choice: "pay" });
    if (result.ok) {
      reporter.step({
        action: "resolveCatastropheChoice",
        payload: { choice: "pay" },
        targetKind: "none",
        label: `Катастрофа: ${result.hint ?? "разрешена."}`,
      });
    }
  }
  if (session.pendingTaxShortfall?.playerId === playerId) {
    let guard = 0;
    while (session.pendingTaxShortfall?.playerId === playerId && guard++ < 50) {
      const unit = session.units.find((u) => u.playerId === playerId);
      if (unit) {
        const payload = { target: { unitId: unit.id } };
        const result = session.dispatch("resolveTaxShortfall", playerId, payload);
        if (result.ok) reporter.step({ action: "resolveTaxShortfall", payload, targetKind: "none", label: `Недоимка по налогам: списан юнит #${unit.id}.` });
        continue;
      }
      const building = builtBy(session.buildingOwners, playerId)[0];
      if (building) {
        const payload = { target: { buildingId: building.id } };
        const result = session.dispatch("resolveTaxShortfall", playerId, payload);
        if (result.ok) reporter.step({ action: "resolveTaxShortfall", payload, targetKind: "building", targetBuildingId: building.id, label: `Недоимка по налогам: списано здание «${building.id}».` });
        continue;
      }
      break;
    }
  }
}

// === Система ценности объектов (по прямому запросу) ==============================================
// «Определим условную ценность тех или иных объектов в игре... позволит взвешивать дипломатические
// решения, торговаться за мир, войну, оборону, дипломатию, предлагая или прося что-то взамен» — все
// формулы ниже дословно по прямому запросу (нумерация — как в исходном списке пользователя).
// Полное текущее поведение — ЦИВА-СПРАВОЧНИК.md §8.1 «Ценность объектов».
//
// Простые формулы (1/2/3/4/5/10/12/13/14 — не зависящие от AI-специфичных понятий вроде «сосед»/
// «угроза»/«ветка лидерства») вынесены в общий `valuation.ts` (по прямому запросу — система
// отношений AI: фактор «дань/подарок» нужен ВНУТРИ GameSession, не только здесь) — реэкспортированы
// отсюда же, чтобы не переписывать десятки мест использования в этом файле.
export { valueOfCity, valueOfUnit, valueOfMoney, valueOfTechByEpoch, VALUE_OPEN_BORDERS, valueOfResource, FALLBACK_RESOURCE_VALUE, valueOfCard, valueOfBuilding } from "./valuation";
import { valueOfCity, valueOfUnit, valueOfMoney, valueOfTechByEpoch, valueOfResource, VALUE_OPEN_BORDERS, FALLBACK_RESOURCE_VALUE } from "./valuation";

/** Все города, связанные торговыми путями (`session.tradeRoutes`) с городом `startCityId`, включая
 * его самого — BFS по графу маршрутов; используется и для ценности Торгового союза (п.6), и для
 * проверки «все свои города уже соединены» (§15.5, приоритет прокладки новых путей). */
function tradeNetworkCityIds(session: GameSession, startCityId: number): Set<number> {
  const adjacency = new Map<number, number[]>();
  for (const r of session.tradeRoutes) {
    if (!adjacency.has(r.fromCityId)) adjacency.set(r.fromCityId, []);
    if (!adjacency.has(r.toCityId)) adjacency.set(r.toCityId, []);
    adjacency.get(r.fromCityId)!.push(r.toCityId);
    adjacency.get(r.toCityId)!.push(r.fromCityId);
  }
  const seen = new Set<number>([startCityId]);
  const queue = [startCityId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
/** Тот же BFS, что и tradeNetworkCityIds выше, но с остановкой на границе владения — не пересекает
 * в город ЧУЖОГО игрока, если между ним и стартовым владельцем ещё нет `tradeUnion` (точная копия
 * правила `GameSession.tradeNetworkOf`, только по id городов, без tollOwners — нужен размер сети
 * КАК ОНА ЕСТЬ СЕЙЧАС, без гипотетического союза, в отличие от голого tradeNetworkCityIds, который
 * всегда считает полную физическую сеть, как если бы союз уже был везде на пути). */
function tradeNetworkSizeRespectingOwnership(session: GameSession, startCityId: number): number {
  const byId = new Map(session.cities.map((c) => [c.id, c]));
  const startOwner = byId.get(startCityId)?.playerId;
  const adjacency = new Map<number, number[]>();
  for (const r of session.tradeRoutes) {
    if (!adjacency.has(r.fromCityId)) adjacency.set(r.fromCityId, []);
    if (!adjacency.has(r.toCityId)) adjacency.set(r.toCityId, []);
    adjacency.get(r.fromCityId)!.push(r.toCityId);
    adjacency.get(r.toCityId)!.push(r.fromCityId);
  }
  const seen = new Set<number>([startCityId]);
  const queue = [startCityId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (seen.has(next)) continue;
      const nextCity = byId.get(next);
      if (!nextCity) continue;
      if (nextCity.playerId !== startOwner && !session.relationOf(startOwner!, nextCity.playerId).agreements.has("tradeUnion")) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size;
}

/** Доля карты «Торговец» в полной колоде (по прямому запросу — «бот должен брать в расчёт
 * потенциальный доход на оставшуюся партию с учётом вероятности выпадения карты Торговец, это
 * мощный приток дохода»). Вычисляется раз при загрузке модуля — состав колоды не меняется в
 * процессе партии. */
const TRADER_SHARE_OF_DECK = freshDeck().filter((c) => c.id === "trader").length / freshDeck().length;

/** 6, переработано (по прямому запросу — учесть вероятность «Торговца» и оставшееся время партии,
 * а не разовую статичную ценность сети). Ожидаемый ДОХОД от «Торговца» за всю ОСТАВШУЮСЯ партию при
 * данном размере сети: сколько раз карта реалистично выпадет (раздача за ход × доля в колоде ×
 * оставшиеся ходы) × средний доход ОДНОГО розыгрыша при этом размере сети (та же пропорция, что и
 * была у старой формулы `networkSize × 2` — шире сеть, дороже разыгранный тип, см.
 * `GameSession.applyTradeNetworkIncome`). */
function expectedTradeIncomeValue(session: GameSession, networkSize: number): number {
  const remainingTurns = Math.max(0, session.turnsRemaining);
  const expectedTraderDraws = remainingTurns * CARDS_DEALT_PER_TURN * TRADER_SHARE_OF_DECK;
  const incomePerPlay = networkSize * 2;
  return expectedTraderDraws * incomePerPlay;
}

/** Асимметрия выгоды торгового союза (по прямому запросу — «сеть одного игрока больше другой, нужно
 * оценивать, кто больше выигрывает, есть смысл попросить компенсацию вперёд»): для каждой стороны —
 * разница между СЕТЬЮ КАК ЕСТЬ СЕЙЧАС (без союза, tradeNetworkSizeRespectingOwnership) и полной
 * ФИЗИЧЕСКОЙ сетью, ЕСЛИ БЫ союз связал их (tradeNetworkCityIds, не смотрит на владение вовсе) — той
 * же приближённой мерой, что и раньше у valueOfTradeUnion, просто теперь взвешенной по ожидаемому
 * доходу (expectedTradeIncomeValue), а не голым размером. Третьи игроки на пути между myCity/
 * otherCity (если есть) в этом приближении трактуются как уже доступные — не идеально точно, но тот
 * же порядок допущения, что и остальные пороги системы отношений (донастраивается на плейтесте). */
function tradeUnionGains(session: GameSession, playerId: number, otherId: number): { myGain: number; theirGain: number; combinedSize: number } | null {
  const myCity = myCities(session, playerId)[0];
  const otherCity = myCities(session, otherId)[0];
  if (!myCity || !otherCity) return null;
  const combinedSize = tradeNetworkCityIds(session, myCity.id).size;
  const myStandalone = tradeNetworkSizeRespectingOwnership(session, myCity.id);
  const theirStandalone = tradeNetworkSizeRespectingOwnership(session, otherCity.id);
  const myGain = expectedTradeIncomeValue(session, combinedSize) - expectedTradeIncomeValue(session, myStandalone);
  const theirGain = expectedTradeIncomeValue(session, combinedSize) - expectedTradeIncomeValue(session, theirStandalone);
  return { myGain, theirGain, combinedSize };
}

/** Самая глубокая (по эпохе) исследованная технология игрока в этой ветке — 0, если в ветке у него
 * вообще ничего нет. */
function branchDepthOf(session: GameSession, playerId: number, branch: TechDef["branch"]): number {
  let maxEpoch = 0;
  for (const tech of TECH_TREE) {
    if (tech.branch === branch && session.researchedTechs[playerId]?.has(tech.id)) maxEpoch = Math.max(maxEpoch, tech.epoch);
  }
  return maxEpoch;
}
/** Кто сейчас дальше всех продвинулся в этой ветке — null при ничьей или если в ветке ни у кого
 * ничего нет («лидерство» должно быть однозначным, не размытым между несколькими). */
function branchLeaderOf(session: GameSession, branch: TechDef["branch"]): number | null {
  let best = 0;
  let leader: number | null = null;
  let tie = false;
  for (const p of session.players) {
    const depth = branchDepthOf(session, p.id, branch);
    if (depth > best) {
      best = depth;
      leader = p.id;
      tie = false;
    } else if (depth === best && depth > 0) {
      tie = true;
    }
  }
  return tie ? null : leader;
}
/** 11 (заменяет черновую формулу из п.7 — по прямому уточнению). Научное сотрудничество — число
 * веток, где игрок сейчас лидер, умноженное на СОВОКУПНУЮ ценность (п.4) технологий, в которых он
 * лидирует — т.е. чем в большем числе веток и чем глубже он впереди остальных, тем ценнее для
 * партнёра сотрудничество именно с ним (см. valueOfAgreementFor — ценность считается ПО ДАЮЩЕЙ
 * стороне, а не по получающей). */
function valueOfScienceCoopLeadership(session: GameSession, playerId: number): number {
  let leadershipCount = 0;
  let combinedValue = 0;
  for (const branch of BRANCHES) {
    if (branchLeaderOf(session, branch) === playerId) {
      leadershipCount++;
      combinedValue += valueOfTechByEpoch(branchDepthOf(session, playerId, branch));
    }
  }
  return leadershipCount * combinedValue;
}

/** Регион считается «фронтом» относительно угрозы `threatId` (или относительно ЛЮБОГО, с кем сейчас
 * война, если threatId не задан) — там стоит юнит угрозы, либо это приграничный (сетка регионов)
 * регион, а угроза вообще сосед. Используется, чтобы «за исключением юнитов, стоящих в городах в
 * регионах, где не ведутся боевые действия» (п.9) можно было проверить буквально. */
function isFrontRegion(session: GameSession, playerId: number, rc: number, rr: number, threatId?: number): boolean {
  const threats = threatId !== undefined ? [threatId] : session.players.filter((p) => p.id !== playerId && session.relationOf(playerId, p.id).war).map((p) => p.id);
  if (!threats.length) return false;
  const border = borderRegionsOf(session, playerId);
  const neighbors = neighborPlayerIds(session, playerId);
  for (const t of threats) {
    if (unitsInRegion(session, rc, rr).some((u) => u.playerId === t)) return true;
    if (neighbors.includes(t) && border.some((b) => b.rc === rc && b.rr === rr)) return true;
  }
  return false;
}
/** Суммарная ценность юнитов игрока (п.2) — `excludeSafeGarrisons` пропускает юнитов, которые сейчас
 * сидят гарнизоном В ГОРОДЕ вне фронта (п.9, «за исключением юнитов в городах в регионах, где не
 * ведутся боевые действия»); юниты в поле (без cityId) и юниты на фронте считаются всегда. */
function militaryPower(session: GameSession, playerId: number, opts?: { excludeSafeGarrisons?: boolean; threatId?: number }): number {
  let total = 0;
  for (const u of session.units) {
    if (u.playerId !== playerId) continue;
    if (opts?.excludeSafeGarrisons && u.cityId != null) {
      const city = session.cities.find((c) => c.id === u.cityId);
      if (city && !isFrontRegion(session, playerId, city.regionCol, city.regionRow, opts.threatId)) continue;
    }
    total += valueOfUnit(u);
  }
  return total;
}
/** 8. Война — разница в военной мощи (сумма ценности всех юнитов) сторон. */
function valueOfWar(session: GameSession, a: number, b: number): number {
  return Math.abs(militaryPower(session, a) - militaryPower(session, b));
}
/** Ценность всего склада + денег игрока (п.10 применяется к каждому виду ресурса на складе). */
function warehouseValue(session: GameSession, playerId: number): number {
  let total = valueOfMoney(session.money[playerId] ?? 0);
  for (const [id, qty] of Object.entries(session.warehouse[playerId] ?? {})) {
    total += valueOfResource(session, id as ResourceId) * (qty ?? 0);
  }
  return total;
}
/** 9. Мир — ценность всех ресурсов и денег на складе, умноженная на соотношение сил сторон (сильнее
 * противник относительно меня — тем ценнее мир), военная мощь считается БЕЗ безопасных гарнизонов
 * (см. militaryPower/isFrontRegion) — по прямому запросу дословно. Считается с точки зрения `me`
 * (это его склад и его знаменатель соотношения). */
function valueOfPeaceToMe(session: GameSession, me: number, enemy: number): number {
  const myPower = militaryPower(session, me, { excludeSafeGarrisons: true, threatId: enemy }) || 1;
  const enemyPower = militaryPower(session, enemy, { excludeSafeGarrisons: true, threatId: me });
  return warehouseValue(session, me) * (enemyPower / myPower);
}
/** 15. Оборонительный пакт (тем же — наступательный «Союз», отдельной формулы для него не давали) —
 * разница в военной мощи между тем, кто заключает пакт, и тем, из-за кого («против кого») он
 * заключается — буквально та же формула, что и «ценность войны» (п.8) выше, просто в другом
 * контексте применения (не «стоит ли воевать», а «насколько нужен союзник против конкретной
 * угрозы»). */
function valueOfDefensivePact(session: GameSession, proposerId: number, threatId: number): number {
  return valueOfWar(session, proposerId, threatId);
}

/** Самый опасный сосед/противник игрока — воюющий (в приоритете) или просто граничащий с наибольшей
 * военной мощью — approximation «угрозы» для generic-оценки Совместной обороны/Союза, когда
 * конкретная угроза не задана контекстом (см. valueOfAgreementFor). Сценарии §8.1/8.2/8.5 ниже
 * считают угрозу/цель точно, этим приближением не пользуются. */
function primaryThreatOf(session: GameSession, playerId: number): number | null {
  const atWar = session.players.filter((p) => p.id !== playerId && session.relationOf(playerId, p.id).war);
  const pool = atWar.length ? atWar : session.players.filter((p) => p.id !== playerId && neighborPlayerIds(session, playerId).includes(p.id));
  if (!pool.length) return null;
  return pool.sort((a, b) => militaryPower(session, b.id) - militaryPower(session, a.id))[0].id;
}
/** Ценность соглашения `agreement` с точки зрения `viewerId`, партнёр — `otherId`. */
function valueOfAgreementFor(session: GameSession, viewerId: number, otherId: number, agreement: Agreement): number {
  switch (agreement) {
    case "openBorders":
      return VALUE_OPEN_BORDERS;
    case "tradeUnion": {
      // По прямому запросу — не голый размер сети, а ОЖИДАЕМЫЙ ДОХОД от неё за оставшуюся партию
      // (см. tradeUnionGains/expectedTradeIncomeValue) — конкретно МОЙ выигрыш (прирост, не общий
      // размер объединённой сети), симметрично считается и с точки зрения `otherId` тем же вызовом
      // с переставленными аргументами (используется отдельно, см. considerTradeUnionForSharedNetwork
      // и shouldAcceptProposal — там же и берётся асимметрия).
      const gains = tradeUnionGains(session, viewerId, otherId);
      return gains ? gains.myGain : 0;
    }
    case "scienceCoop":
      // Ценность для VIEWER — то, что может дать ПАРТНЁР (его лидерства), не свои собственные.
      return valueOfScienceCoopLeadership(session, otherId);
    case "mutualDefense":
    case "union": {
      const threat = primaryThreatOf(session, viewerId);
      return threat !== null ? valueOfDefensivePact(session, viewerId, threat) : 0;
    }
    case "vassalage":
      return 0; // design-only — вне этой задачи, см. ЦИВА ТЗ.md §6
  }
}

// === Отношения AI — гейты дипломатии по уровню (по прямому запросу) ==============================
// «AI не заключит торговое соглашение без доп условий с тем с кем у него плохие и хуже отношения, и
// не откроет границы при враждебном отношении. AI предлагает сотрудничество только тем с кем у него
// отношения выше нейтральных.» Полное текущее поведение — ЦИВА-СПРАВОЧНИК.md §8.3.
//
// Проверяется мнением `viewerId` (принимающего решение) о `otherId` — вызывается с обеих сторон
// (когда бот САМ предлагает — его мнение о партнёре; когда бот РЕШАЕТ принять — его мнение об
// отправителе), так что итог симметричен без отдельной двусторонней проверки внутри функции.
// `hasCompensation` — в предложении, кроме самого соглашения, есть хоть один терм, реально что-то
// передающий (деньги/ресурс/город) — «доп условия», снимающие гейт ИМЕННО для tradeUnion.
function relationAllowsAgreement(session: GameSession, viewerId: number, otherId: number, agreement: Agreement, hasCompensation: boolean): boolean {
  const myOpinion = session.relationScoreOf(viewerId, otherId);
  if (agreement === "tradeUnion" && !hasCompensation) return myOpinion >= 40;
  if (agreement === "openBorders") return myOpinion >= 20;
  if (agreement === "scienceCoop") return myOpinion > 60;
  return true;
}
/** Ценность ОДНОГО условия предложения с точки зрения `viewerId` (положительно — он выигрывает,
 * отрицательно — теряет) — учитывает, кем в самом предложении (`from`/`to`) является viewer. */
function termValueFor(session: GameSession, viewerId: number, p: { from: number; to: number }, term: ProposalTerm): number {
  const iAmFrom = viewerId === p.from;
  const otherId = iAmFrom ? p.to : p.from;
  switch (term.kind) {
    case "offerMoney":
      return iAmFrom ? -valueOfMoney(term.amount) : valueOfMoney(term.amount);
    case "demandMoney":
      return iAmFrom ? valueOfMoney(term.amount) : -valueOfMoney(term.amount);
    case "giveResource": {
      const v = valueOfResource(session, term.resource) * term.qty;
      return iAmFrom ? -v : v;
    }
    case "demandResource": {
      const v = valueOfResource(session, term.resource) * term.qty;
      return iAmFrom ? v : -v;
    }
    case "giveCity": {
      const city = session.cities.find((c) => c.id === term.cityId);
      const v = city ? valueOfCity(session, city) : 0;
      return iAmFrom ? -v : v;
    }
    case "demandCity": {
      const city = session.cities.find((c) => c.id === term.cityId);
      const v = city ? valueOfCity(session, city) : 0;
      return iAmFrom ? v : -v;
    }
    case "peace":
      return valueOfPeaceToMe(session, viewerId, otherId);
    case "agreement":
      return valueOfAgreementFor(session, viewerId, otherId, term.agreement);
    // Обещания (Отношения AI, фактор 9) — ЗДЕСЬ только приблизительная заглушка для общего пути
    // принятия чужого предложения (shouldAcceptProposal); собственная бесповодная оценка «когда
    // просить/соглашаться» для каждого из 5 видов — отдельные функции этапа 9 (7-приоритетный
    // список), с учётом баланса сил/отношений, а не одной этой цифрой. Даю ОБЕЩАНИЕ (не я — from,
    // значит я — акцептор, беру на себя обязательство) — цена умеренной сдержанности; ПОЛУЧАЮ
    // обещание (я — from, запросил) — симметрично положительно.
    case "promiseNoSettle":
    case "promiseNoAttack":
    case "promiseNoEventCards":
      return iAmFrom ? 3 : -3;
    case "promiseGiveCardType":
    case "promiseListResource":
      return iAmFrom ? 3 : -3;
    // «Призыв на войну»/«Совместное нападение» (по прямому запросу, НОВЫЕ) — не «стоят» ничего в
    // системе ценности объектов (§8.1) намеренно: пригодность оценивается ОТДЕЛЬНЫМИ правилами
    // (см. shouldAcceptProposal ниже — сила/отношения/переброска), не суммой ценности условий.
    case "callToWar":
    case "jointAttack":
      return 0;
    // «Прекратить торговлю с врагом» (по прямому запросу) — в отличие от двух военных термов выше,
    // цена тут вполне считаема обычной системой ценности: тот, кого просят, теряет РОВНО свои
    // действующие соглашения с третьим игроком, каждое по своей же цене (`valueOfAgreementFor`) —
    // нет соглашений, значит и просьба ничего не стоит (0, соглашается охотно). Просящий получает
    // умеренную выгоду: связи врага слабеют, но сам он ничего не приобретает напрямую.
    case "breakTiesWith": {
      if (iAmFrom) return 3;
      let loss = 0;
      for (const agreement of session.relationOf(viewerId, term.targetId).agreements) {
        loss += valueOfAgreementFor(session, viewerId, term.targetId, agreement);
      }
      return -loss;
    }
  }
}
/** Суммарная ценность целого предложения с точки зрения `viewerId`. Экспортирована — используется не
 * только ботом: `wsServer.ts` вызывает её напрямую (в обход dispatch, как и previewPath/previewAttack,
 * см. заголовок wsServer.ts) для живого предпросмотра ценности в композере предложения человека
 * (main.ts — окно «Отправить предложение»), с обеих точек зрения сразу (`from` и `to`). */
export function proposalNetValueFor(session: GameSession, viewerId: number, p: { from: number; to: number; terms: ProposalTerm[] }): number {
  return p.terms.reduce((sum, t) => sum + termValueFor(session, viewerId, p, t), 0);
}

// === Дипломатия — предложения, адресованные боту ================================================

/** По прямому запросу — заменяет прежний набор отдельных ad hoc условий («мир — если слабее и
 * хватает денег», «соглашение — если заплатили ≥ населения») ЕДИНОЙ системой ценности объектов
 * (см. § выше): предложение принимается, если суммарная ценность того, что получает игрок,
 * не меньше суммарной ценности того, что он отдаёт (`proposalNetValueFor` ≥ 0) — и то же самое
 * значение используют сценарии §8.1-8.5 ниже, когда САМИ составляют предложение, так что обе
 * стороны сделки судят по одной и той же линейке. Требование сдать город (`demandCity`) — по
 * прежнему принципу жёсткое вето независимо от общей суммы: слишком необратимо, чтобы разменивать
 * на условную оценку. */
function shouldAcceptProposal(session: GameSession, p: Proposal): boolean {
  if (p.terms.some((t) => t.kind === "demandCity")) return false;
  // «Вступление в чужую войну по призыву»/«Совместное нападение» (по прямому запросу, «План войны»,
  // НОВЫЕ) — целиком СВОИ правила приёма, не общая сумма ценности (`termValueFor` намеренно
  // возвращает 0 для обоих, см. doc там же), решение принимается ЗДЕСЬ и возвращается СРАЗУ, минуя
  // обычный путь ниже (единственный терм такого рода в предложении — сложить его с другими условиями
  // в одну сделку не предусмотрено, как и для demandCity выше).
  for (const t of p.terms) {
    if (t.kind === "callToWar") {
      // «Баланс сил» (по прямому запросу §4.5/§5.1 — «AI могут оказывать поддержку, чтоб не допустить
      // усиления другого игрока») — цель уже обгоняет остальных по росту (GameSession.
      // isOutgrowingOthers, тот же предикат, что питает дрейф trust «Баланс сил») — тогда вступление в
      // войну против неё выгодно САМО ПО СЕБЕ, не только вынужденно слабому: снимает ограничение
      // «≤2 города» (та причина рассчитана именно на вынужденно слабых, эта — на стратегическую
      // тревогу, разные мотивы).
      const containment = session.isOutgrowingOthers(t.targetId);
      if (!containment && myCities(session, p.to).length > 2) return false;
      if (countUnitsOf(session, p.to) <= 0) return false; // «есть войска»
      if (session.relationScoreOf(p.to, t.targetId) >= 60) return false; // отношения с противником — нейтральные и хуже
      const combined = countUnitsOf(session, p.from) + countUnitsOf(session, p.to);
      const forceOk = combined > countUnitsOf(session, t.targetId) * WAR_PLAN_FORCE_RATIO; // «их совокупная мощь превосходит противника»
      // «Дипломатическое давление» (§4.4) — приложенная к этому же предложению оплата (offerMoney/
      // giveResource) может компенсировать недостающий перевес сил, если её ценность сопоставима с
      // «ценой войны» (valueOfWar с МОЕЙ, получателя, точки зрения) — иначе платное давление ничем не
      // отличалось бы от бесплатного призыва (considerCallToWar), а значит не стоило бы своей цены.
      const paymentValue = p.terms.reduce((sum, x) => sum + (x.kind === "offerMoney" ? valueOfMoney(x.amount) : x.kind === "giveResource" ? valueOfResource(session, x.resource) * x.qty : 0), 0);
      if (!forceOk && !containment && paymentValue < valueOfWar(session, p.to, t.targetId)) return false;
      if (!envHasMoneyPerUnit(session, p.to)) return false; // «хватает денег» — 1 на каждого своего юнита
      if (!canReachPlayerByLand(session, p.to, t.targetId) && !session.units.some((u) => u.playerId === p.to && u.category === "ship")) return false; // «кораблей, если нужно»
      return true;
    }
    if (t.kind === "jointAttack") {
      if (!neighborPlayerIds(session, p.to).includes(t.targetId)) return false; // третий должен граничить и со мной
      if (session.relationScoreOf(p.to, p.from) <= session.relationScoreOf(p.to, t.targetId)) return false; // отношения с партнёром лучше, чем с целью
      const combined = countUnitsOf(session, p.from) + countUnitsOf(session, p.to);
      if (combined <= countUnitsOf(session, t.targetId) * WAR_PLAN_FORCE_RATIO) return false; // превосходство совокупных сил
      return true;
    }
  }
  // Отношения AI — гейты по уровню (см. relationAllowsAgreement) — проверяются ДО суммы ценности:
  // соглашение, запрещённое текущим уровнем отношений, отклоняется независимо от того, насколько
  // «выгодной» иначе выглядит сделка.
  const hasCompensation = p.terms.length > 1;
  for (const t of p.terms) {
    if (t.kind === "agreement" && !relationAllowsAgreement(session, p.to, p.from, t.agreement, hasCompensation)) return false;
    // «Подготовка к войне» (по прямому запросу) — AI не заключает «Совместную оборону» с тем, на кого
    // сам уже готовит нападение (session.warPlans[p.to] — активный План войны, см. considerWarPlan):
    // пакт с будущей жертвой бессмысленен (declareWar сама его просто молча снимет при объявлении, см.
    // rel.agreements.clear() там же — но раз AI и так планирует эту войну, заключать пакт незачем).
    // Отправляющая сторона (bot.ts: considerDefensePactAfterTruce/considerBalanceOfPowerAlliance) уже
    // не предложит ТАКОМУ партнёру сама — это симметричный гейт на приёме входящего предложения.
    if (t.kind === "agreement" && t.agreement === "mutualDefense" && session.warPlans[p.to]?.targetId === p.from) return false;
  }
  // Отношения AI — асимметрия выгоды торгового союза (по прямому запросу, см. tradeUnionGains): я —
  // получатель этого предложения (p.to); если Я выигрываю от объединения сетей МЕНЬШЕ отправителя,
  // а предложение «голое» (без компенсирующих условий) — понижаю чистую ценность на ту же разницу,
  // естественно повышая шанс отказа (не поддаётся уже valueOfAgreementFor, т.к. та считает только
  // МОЙ выигрыш, не сравнение с чужим).
  let asymmetryPenalty = 0;
  if (!hasCompensation) {
    for (const t of p.terms) {
      if (t.kind !== "agreement" || t.agreement !== "tradeUnion") continue;
      const gains = tradeUnionGains(session, p.to, p.from);
      if (gains && gains.theirGain > gains.myGain) asymmetryPenalty += gains.theirGain - gains.myGain;
    }
  }
  // Отношения AI — обещания (приоритетный список, п.1-5): за исключением promiseNoEventCards (своё
  // отдельное правило чуть ниже — специально по прямому запросу отличается от общего гейта), любое
  // ДРУГОЕ обещание — добровольное обязательство, при плохих отношениях (силовые инструменты вместо
  // кооперативных) не берётся вовсе, независимо от суммы ценности.
  for (const t of p.terms) {
    if (
      (t.kind === "promiseNoSettle" || t.kind === "promiseNoAttack" || t.kind === "promiseGiveCardType" || t.kind === "promiseListResource") &&
      !isPeacefulDiplomacyViable(session, p.to, p.from)
    ) {
      return false;
    }
    // п.1 — «не даст обещание [не селиться], если у цели [он сам, p.to] уже вдвое больше регионов,
    // чем у просящего [p.from]» — жёсткое вето независимо от отношений/суммы: слишком выгодно
    // просящему за счёт заведомо слабейшего требовать уступки территории.
    if (t.kind === "promiseNoSettle" && myCities(session, p.to).length >= myCities(session, p.from).length * 2) return false;
    // п.4 — «принимается при отношении нейтральном+, ИЛИ если у просящего больше войск, даже если
    // отношения хуже» — собственное правило, НЕ общий гейт выше (specifically overrides it).
    if (t.kind === "promiseNoEventCards") {
      const relationOk = session.relationScoreOf(p.to, p.from) >= 40;
      const outgunned = countUnitsOf(session, p.from) > countUnitsOf(session, p.to);
      if (!relationOk && !outgunned) return false;
    }
  }
  return proposalNetValueFor(session, p.to, p) - asymmetryPenalty >= 0;
}

function resolveIncomingProposals(session: GameSession, playerId: number, reporter: Reporter) {
  const mine = session.pendingProposals.filter((p) => p.to === playerId);
  for (const p of mine) {
    const accept = shouldAcceptProposal(session, p);
    const payload = { id: p.id, accepted: accept };
    const result = session.dispatch("resolveProposal", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "resolveProposal",
        payload,
        targetKind: "proposal",
        targetPlayerId: p.from,
        label: `Предложение #${p.id} от игрока ${p.from}: ${accept ? "принято" : "отклонено"}.`,
      });
    }
  }
}

// === Совет ООН — голосование бота и стремление к дипломатической победе (по прямому запросу) =====

/** Совет ООН — голосование по резолюции: временная мера, БЕЗ оценки выгодности конкретных эффектов
 * резолюций (по прямому запросу) — «голосует за резолюции тех с кем он дружественен, против того с
 * кем не дружественен, воздерживается к нейтральным» — судит по отношению к АВТОРУ резолюции
 * (`proposerId`), не по её типу/параметрам. Голос ничего не стоит (`GameSession.voteOonResolution` не
 * тратит действия/деньги) — голосует сразу, как появилась возможность, один раз за резолюцию.
 * Нейтральное отношение голосует ПРОТИВ, не «воздерживается» (по прямому запросу — «нейтралы
 * голосуют против, зафиксируй это»; текущая модель голоса — только за/против, без отдельного
 * состояния «воздержался», см. `voteOonResolution`/`PendingOonResolution.votes: Record<number,
 * boolean>`) — по-другому здесь и нельзя: если бы нейтральный AI НИКОГДА не голосовал вовсе,
 * резолюция зависала бы `pendingOonResolution` навечно, блокируя все будущие резолюции партии (см.
 * `tallyOonResolution` — ждёт голоса ВСЕХ активных игроков, §12 СПРАВОЧНИКА). Из позиции самого
 * исхода партии разницы нет — порог считает только «за», и «против»/«не проголосовал бы» дают ровно
 * тот же результат; подпись шага плана раньше говорила «воздерживается» для нейтральных — сама
 * ветка кода вводила в заблуждение (обещала третье состояние, которого в игре не существует),
 * исправлено на честное «против». */
function considerOonVote(session: GameSession, playerId: number, reporter: Reporter): void {
  const res = session.pendingOonResolution;
  if (!res || playerId in res.votes) return;
  // «Мировой лидер» — выбор МЕЖДУ ДВУМЯ кандидатами, не «за/против» резолюции как таковой; своя
  // отдельная функция ниже (considerOonWorldLeaderVote), тот же принцип, что и considerOonSecretaryVote.
  if (res.type === "worldLeader") return;
  const tier = session.relationTierOf(session.relationScoreOf(playerId, res.proposerId));
  const inFavor = tier === "good" || tier === "friendly" || tier === "allied";
  const payload = { inFavor };
  const result = session.dispatch("voteOonResolution", playerId, payload);
  if (!result.ok) return;
  const proposerName = session.players.find((p) => p.id === res.proposerId)?.name ?? `игрок ${res.proposerId}`;
  reporter.step({
    action: "voteOonResolution",
    payload,
    targetKind: "proposal",
    targetPlayerId: res.proposerId,
    label: `Резолюция ООН от игрока ${proposerName}: голосует ${inFavor ? "за" : "против"}.`,
  });
}

/** Выборы генсека ООН — тот же принцип, что considerOonVote (временная мера, без оценки выгодности,
 * только по отношению): сравнивает отношение к обоим кандидатам, голосует за того, к кому оно лучше
 * (ничья — кандидат №1, тот же тай-брейк, что и на сервере в tallyOonSecretaryElection). */
function considerOonSecretaryVote(session: GameSession, playerId: number, reporter: Reporter): void {
  const el = session.pendingOonSecretaryElection;
  if (!el || playerId in el.votes) return;
  const s1 = session.relationScoreOf(playerId, el.candidate1Id);
  const s2 = session.relationScoreOf(playerId, el.candidate2Id);
  const candidateId = s2 > s1 ? el.candidate2Id : el.candidate1Id;
  const payload = { candidateId };
  const result = session.dispatch("voteOonSecretaryGeneral", playerId, payload);
  if (!result.ok) return;
  const candidateName = session.players.find((p) => p.id === candidateId)?.name ?? `игрок ${candidateId}`;
  reporter.step({
    action: "voteOonSecretaryGeneral",
    payload,
    targetKind: "player",
    targetPlayerId: candidateId,
    label: `Выборы генсека ООН: голосует за ${candidateName}.`,
  });
}

/** «Мировой лидер» — тот же принцип, что considerOonSecretaryVote (сравнение отношения к обоим
 * кандидатам, ничья → кандидат №1): своя функция, а не considerOonVote, потому что здесь выбор
 * МЕЖДУ ДВУМЯ кандидатами (голос — candidateId), не «за/против» резолюции. По прямому запросу — эта
 * резолюция сама по себе даёт победу в партии, так что AI-кандидат голосует за СЕБЯ, если он один из
 * двух (собственная выгода важнее отношения к себе, которое здесь не определено/бессмысленно). */
function considerOonWorldLeaderVote(session: GameSession, playerId: number, reporter: Reporter): void {
  const res = session.pendingOonResolution;
  if (!res || res.type !== "worldLeader" || playerId in res.votes) return;
  const c1 = res.candidate1Id!;
  const c2 = res.candidate2Id!;
  const candidateId = playerId === c1 ? c1 : playerId === c2 ? c2 : session.relationScoreOf(playerId, c2) > session.relationScoreOf(playerId, c1) ? c2 : c1;
  const payload = { candidateId };
  const result = session.dispatch("voteOonWorldLeader", playerId, payload);
  if (!result.ok) return;
  const candidateName = session.players.find((p) => p.id === candidateId)?.name ?? `игрок ${candidateId}`;
  reporter.step({
    action: "voteOonWorldLeader",
    payload,
    targetKind: "player",
    targetPlayerId: candidateId,
    label: `Выборы мирового лидера: голосует за ${candidateName}.`,
  });
}

/** Выносит «Выборы мирового лидера» — по прямому запросу переработано в настоящие выборы МЕЖДУ
 * ДВУМЯ кандидатами (те же 2, что и на выборах генсека — см. GameSession.proposeOonResolution),
 * больше не «резолюция на себя» с одним целевым игроком: параметры не нужны, кандидаты считаются
 * сервером сам. */
function proposeOonWorldLeader(session: GameSession, playerId: number, reporter: Reporter, reason: string): boolean {
  const payload = { resolutionType: "worldLeader" as const, params: {} };
  const result = session.dispatch("proposeOonResolution", playerId, payload);
  if (!result.ok) return false;
  reporter.step({ action: "proposeOonResolution", payload, targetKind: "none", label: `Выносит резолюцию ООН «Выборы мирового лидера» (${reason}).` });
  return true;
}

/** Валидные параметры под случайный тип резолюции (по прямому запросу — «AI пока играет случайную
 * резолюцию» — БЕЗ оценки выгодности, просто что-то проходящее `validateOonResolutionParams`). Null,
 * если для этого типа прямо сейчас нет подходящей цели (например sanctions/aid без других живых
 * игроков) — тогда сценарий пробует следующий тип из перебора (см. tryProposeOonResolution). */
function randomOonResolutionParams(session: GameSession, playerId: number, type: OonResolutionType): OonResolutionParams | null {
  const others = session.players.filter((p) => p.id !== playerId && !session.eliminatedPlayers.has(p.id));
  switch (type) {
    case "sanctions":
      return others.length ? { targetPlayerId: others[Math.floor(Math.random() * others.length)].id } : null;
    case "aid":
      return others.length ? { targetPlayerId: others[Math.floor(Math.random() * others.length)].id, amount: 5 } : null;
    case "priceRegulation":
      return { resource: RESOURCES[Math.floor(Math.random() * RESOURCES.length)].id, price: FALLBACK_RESOURCE_VALUE };
    case "armsLimit":
      return { limit: countUnitsOf(session, playerId) + 5 };
    case "credit":
      return { amount: 1 };
    default:
      return {};
  }
}

/** Все типы резолюций, кроме «Выборы мирового лидера» — им AI распоряжается отдельно (см. ниже),
 * случайный выбор идёт только среди этих 9. */
const RANDOM_OON_TYPES: OonResolutionType[] = ["openTrade", "banNuclear", "neutralWaters", "sanctions", "greenAgenda", "priceRegulation", "armsLimit", "aid", "credit"];

/** Совет ООН — генсек-бот стремится к дипломатической победе через «Выборы мирового лидера» (по
 * прямому запросу — «научи AI это тоже делать для дипломатической победы его»; переработано под
 * настоящие выборы между двумя кандидатами — см. considerOonWorldLeaderVote, победа не гарантирована
 * даже если генсек сам один из кандидатов), а в промежутках — играет случайную ДРУГУЮ резолюцию (по
 * прямому запросу — «AI пока играет случайную
 * резолюцию, чередуя каждый раз с выборами мирового лидера»; временная мера, БЕЗ оценки выгодности
 * конкретных эффектов — тот же принцип, что и у голосования, см. considerOonVote). Правило «не два
 * раза подряд» (см. GameSession.lastOonResolutionType) само собой создаёт чередование: пока последней
 * была НЕ «Мировой лидер» — генсек всегда пробует именно её (первая резолюция партии обязана быть
 * ей же, см. GameSession.proposeOonResolution — совпадает само собой); когда последней была ОНА —
 * подряд её вынести нельзя, поэтому в этот раз — случайный ДРУГОЙ тип. */
function tryProposeOonResolution(session: GameSession, playerId: number, reporter: Reporter): boolean {
  if (session.oonSecretaryGeneralId !== playerId) return false;
  if (session.pendingOonResolution) return false;
  if (session.actionsLeft[playerId] <= 0) return false;
  if (session.money[playerId] < GameSession.OON_RESOLUTION_MONEY_COST) return false;

  if (session.lastOonResolutionType !== "worldLeader") {
    return proposeOonWorldLeader(session, playerId, reporter, session.lastOonResolutionType === null ? "первая резолюция партии обязательна" : "чередование с случайными резолюциями");
  }
  // Последней была "worldLeader" — повтор подряд запрещён, перебираем случайный порядок ОСТАЛЬНЫХ
  // типов, пока какой-то не пройдёт валидацию (нет живой цели под sanctions/aid — редкий край случай
  // при 1 живом игроке, тогда просто ничего не выносим в этот заход).
  const shuffled = [...RANDOM_OON_TYPES].sort(() => Math.random() - 0.5);
  for (const type of shuffled) {
    const params = randomOonResolutionParams(session, playerId, type);
    if (!params) continue;
    const payload = { resolutionType: type, params };
    const result = session.dispatch("proposeOonResolution", playerId, payload);
    if (!result.ok) continue;
    reporter.step({ action: "proposeOonResolution", payload, targetKind: "none", label: `Выносит случайную резолюцию ООН «${type}» — чередование с «Мировой лидер».` });
    return true;
  }
  return false;
}

// === Военные решения (по прямому запросу — «научить AI управлять юнитами», этап 1: производство
// состава армии + условия войны/мира, БЕЗ движения войск — оно отдельным этапом позже) ============
//
// «Своя территория»/«граница»/«сосед» здесь везде — приближение по СЕТКЕ РЕГИОНОВ (те же 4×3-гекс
// блоки, что использует вся остальная игра — доступ к ресурсам, вместимость города и т.д.), не по
// точной гекс-границе: регион «свой», если в нём есть город игрока; «приграничный» — сосед по сетке
// регионов (не по диагонали) с как минимум одним «своим». Этого достаточно для решений уровня
// «строить оборону/начинать войну», не требует портирования точной клиентской логики владения
// гексом (territoryOwnerOf и т.п. остаются private — не нужны на этом уровне детализации).

function countUnitsOf(session: GameSession, playerId: number): number {
  return session.units.filter((u) => u.playerId === playerId).length;
}

function ownedRegionsOf(session: GameSession, playerId: number): Set<string> {
  return new Set(session.cities.filter((c) => c.playerId === playerId).map((c) => `${c.regionCol},${c.regionRow}`));
}

/** По прямому запросу — живой баг-репорт («не все территории освоены, но бот идёт растить население
 * вместо расселения») — раньше здесь был только 5-окрестный (без диагоналей) набор смещений, «тот же
 * явный компромисс, что и everywhere else в этой сессии, где точная гекс-геометрия не нужна ради
 * простой эвристики». Оказалось, что это НЕ безобидное упрощение: `GameSession.regionsAdjacent`
 * (приватный, но авторитетный — именно по нему `foundCity`/`playerHasCityAdjacentTo` реально решает,
 * можно ли поставить город) считает соседними ВСЕ 8 регионов вокруг (`colDist<=1 && rowDist<=1`),
 * включая диагональные — так что бот с 5-окрестным набором был слеп к части реально доступных для
 * расселения регионов и ошибочно скатывался на рост населения, посчитав расселяться некуда. Теперь
 * полный Мур-набор (8 соседей), чтобы `unclaimedNearbyRegions`/`borderRegionsOf` не расходились с тем,
 * что реально проверяет сервер. */
const REGION_NEIGHBOR_OFFSETS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Колонки регионов заворачиваются через шов REGION_GRID_W (запад↔восток — «земля круглая»), строки
 * — НЕТ (север-юг, полярный лёд по краям, через полюс не соседствуют) — тот же асимметричный тор,
 * что уже применяет GameSession.regionsAdjacent/hexNeighborsWrapped (живой баг-репорт: «земля
 * круглая, а этот регион слева через шов не считался приграничным» — раньше здесь заворота не было
 * вовсе, отрезало реально доступные для расселения/угрозы регионы у самого края карты). */
function wrapRegionCol(rc: number): number {
  return ((rc % REGION_GRID_W) + REGION_GRID_W) % REGION_GRID_W;
}

/** Регионы, граничащие со своими (по сетке регионов, с заворотом по долготе — см. wrapRegionCol, и
 * полным 8-соседним набором — см. REGION_NEIGHBOR_OFFSETS), но не свои — «приграничные» для решений
 * об обороне/соседях/расселении. */
function borderRegionsOf(session: GameSession, playerId: number): { rc: number; rr: number }[] {
  const own = ownedRegionsOf(session, playerId);
  const seen = new Set<string>();
  const result: { rc: number; rr: number }[] = [];
  for (const key of own) {
    const [rc, rr] = key.split(",").map(Number);
    for (const [drc, drr] of REGION_NEIGHBOR_OFFSETS) {
      const nrr = rr + drr;
      if (nrr < 0 || nrr >= REGION_GRID_H) continue;
      const nrc = wrapRegionCol(rc + drc);
      const nkey = `${nrc},${nrr}`;
      if (own.has(nkey) || seen.has(nkey)) continue;
      seen.add(nkey);
      result.push({ rc: nrc, rr: nrr });
    }
  }
  return result;
}

function unitsInRegion(session: GameSession, rc: number, rr: number) {
  return session.units.filter((u) => Math.floor(u.col / REGION_SIZE_X) === rc && Math.floor(u.row / REGION_SIZE_Y) === rr);
}

function localForceAt(session: GameSession, playerId: number, rc: number, rr: number): number {
  return unitsInRegion(session, rc, rr).filter((u) => u.playerId === playerId).length;
}

/** Локальный перевес сил для КОНКРЕТНОЙ военной цели (по прямому запросу — «считаем не общее число
 * юнитов, а число юнитов в видимых регионах»: подготовка к войне концентрирует ударную группировку у
 * ОДНОГО региона захвата, остальные города держат свой отдельный паритет обороны отдельно —
 * `DEFENSE_TO_OFFENSE_RATIO` — поэтому общий счёт юнитов по игроку целиком не отражает реальный
 * расклад именно этой кампании: слабый по общей армии противник может быть локально силён у самой
 * цели, а сильный — locally беззащитен именно там) — свои юниты В регионе цели И в СВОИХ регионах,
 * ГРАНИЧАЩИХ с ним (`REGION_NEIGHBOR_OFFSETS` — реальный плацдарм, откуда войска физически способны
 * дойти без долгой переброски через весь материк), суммой. */
function localCampaignForce(session: GameSession, playerId: number, regionCol: number, regionRow: number): number {
  let total = localForceAt(session, playerId, regionCol, regionRow);
  const owned = ownedRegionsOf(session, playerId);
  for (const [drc, drr] of REGION_NEIGHBOR_OFFSETS) {
    const nrr = regionRow + drr;
    if (nrr < 0 || nrr >= REGION_GRID_H) continue;
    const nrc = wrapRegionCol(regionCol + drc);
    if (!owned.has(`${nrc},${nrr}`)) continue;
    total += localForceAt(session, playerId, nrc, nrr);
  }
  return total;
}

/** Защитники ИМЕННО региона цели (не вся армия защищающегося по игре) — та половина локального
 * сравнения, что и `localCampaignForce` выше, только без плацдарма (обороняющемуся некуда стягивать
 * силы заранее — регион либо уже защищён, либо нет). */
function localDefenseForce(session: GameSession, targetId: number, regionCol: number, regionRow: number): number {
  return localForceAt(session, targetId, regionCol, regionRow);
}

const WAR_CAMPAIGN_MONEY_PER_UNIT = 3; // «денег должно хватать на переброску юнитов кампании» (по прямому запросу) — грубая оценка: марш+атака, несколько приказов на юнита по 1💰 (см. GameSession.commandUnit/chargeUnitActivation), не фиксированный банк независимо от размера похода
function campaignMoneyNeeded(unitsInvolved: number): number {
  return Math.max(1, unitsInvolved) * WAR_CAMPAIGN_MONEY_PER_UNIT;
}

/** Города-плацдармы АКТИВНОГО «Плана войны» — свои города В самом регионе цели плана И в регионах,
 * ГРАНИЧАЩИХ с ним (`REGION_NEIGHBOR_OFFSETS`, тот же плацдарм, что и `localCampaignForce`) — сюда
 * стягивается ударная группировка (`tryStageForWarPlan`), значит именно тут может физически не
 * хватить места под накопленных юнитов. */
/** Принимает голый регион `{regionCol,regionRow}`, а не весь `WarPlan` (использует только эти два
 * поля) — по прямому уточнению нужна и ДО того, как план формально создан (см. `findResourceShortageTarget`
 * ниже: «рассредоточить некуда» само по себе — достаточная причина начать войну немедленно, ждать
 * формального перевеса необязательно), не только для уже существующего `session.warPlans[playerId]`. */
function warPlanStagingCities(session: GameSession, playerId: number, region: { regionCol: number; regionRow: number }): City[] {
  return myCities(session, playerId).filter((c) => {
    if (c.regionCol === region.regionCol && c.regionRow === region.regionRow) return true;
    return REGION_NEIGHBOR_OFFSETS.some(([drc, drr]) => {
      const nrr = region.regionRow + drr;
      if (nrr < 0 || nrr >= REGION_GRID_H) return false;
      return c.regionCol === wrapRegionCol(region.regionCol + drc) && c.regionRow === nrr;
    });
  });
}

/** «Рассредоточить в городах-плацдармах региона ДЕЙСТВИТЕЛЬНО некуда» (по прямому уточнению —
 * предыдущая версия этой проверки была неверной: «гарнизон полон» САМ ПО СЕБЕ не повод для
 * немедленной войны — юнита почти всегда можно рассредоточить, эвакуировав на защищённый гекс рядом
 * (`findEvictionHex`, тот же приём, что и `evictOneGarrisonUnit` при обычной постройке), и копить
 * перевес дальше как обычно. Немедленная война нужна ТОЛЬКО когда рассредоточить действительно
 * некуда — эвакуация не находит гекс НИ В ОДНОМ переполненном городе-плацдарме. Нет ни одного
 * переполненного плацдарма (или плацдармов вовсе нет) — `false`, копить/ждать можно спокойно. */
function warPlanStagingHasNoRoom(session: GameSession, playerId: number, region: { regionCol: number; regionRow: number }): boolean {
  const staging = warPlanStagingCities(session, playerId, region);
  if (!staging.length) return false;
  const full = staging.filter((c) => session.unitsAt(c.col, c.row).length >= GameSession.CITY_GARRISON_CAP);
  if (!full.length) return false;
  return full.every((c) => {
    const unit = session.unitsAt(c.col, c.row).sort((a, b) => a.id - b.id)[0];
    return !unit || findEvictionHex(session, unit) === null;
  });
}

/** `playerId` имеет город В регионе (rc,rr) ИЛИ в одном из 8 соседних (тем же заворотом по
 * долготе/набором смещений, что и borderRegionsOf выше) — approximation `GameSession.
 * playerHasCityAdjacentTo` (приватный) для решений этого файла, где точная авторитетная проверка не
 * нужна (отношения AI, п.1 приоритетного списка — «кому предложить обещание не селиться»). */
function hasCityAdjacentToRegion(session: GameSession, playerId: number, rc: number, rr: number): boolean {
  for (const [drc, drr] of [[0, 0] as [number, number], ...REGION_NEIGHBOR_OFFSETS]) {
    const nrr = rr + drr;
    if (nrr < 0 || nrr >= REGION_GRID_H) continue;
    const nrc = wrapRegionCol(rc + drc);
    if (session.cities.some((c) => c.playerId === playerId && c.regionCol === nrc && c.regionRow === nrr)) return true;
  }
  return false;
}

/** «Если компьютер видит накопление сил у приграничных к нему регионов» (по прямому запросу) —
 * считает чужих юнитов во всех регионах, граничащих со своими, против своих юнитов там же; больше
 * чужих — сигнал строить Оборонительных вместо обычной пропорции Штурмовые/Поддержка. */
function hasBorderThreat(session: GameSession, playerId: number): boolean {
  let enemy = 0;
  let mine = 0;
  for (const { rc, rr } of borderRegionsOf(session, playerId)) {
    for (const u of unitsInRegion(session, rc, rr)) {
      if (u.playerId === playerId) mine++;
      else enemy++;
    }
  }
  return enemy > mine;
}

/** КОНКРЕТНЫЙ приграничный регион «напряжения обороны» для предпросмотра хода (по прямому запросу —
 * «регион напряжения атаки ИЛИ обороны») — тот же признак, что и `hasBorderThreat` выше (чужих
 * юнитов в приграничных регионах больше своих), но здесь нужен САМ регион с наибольшим скоплением
 * чужих, не просто общий булев факт по всем разом. `null` — чужих юнитов ни в одном приграничном
 * регионе нет вовсе. */
function findBorderThreatRegion(session: GameSession, playerId: number): PendingBorderThreatInfo | null {
  let best: PendingBorderThreatInfo | null = null;
  for (const { rc, rr } of borderRegionsOf(session, playerId)) {
    const byEnemy = new Map<number, number>();
    for (const u of unitsInRegion(session, rc, rr)) {
      if (u.playerId === playerId) continue;
      byEnemy.set(u.playerId, (byEnemy.get(u.playerId) ?? 0) + 1);
    }
    for (const [enemyPlayerId, enemyUnits] of byEnemy) {
      if (!best || enemyUnits > best.enemyUnits) best = { regionCol: rc, regionRow: rr, enemyPlayerId, enemyUnits };
    }
  }
  return best;
}

/** Те же 5 технологий вместимости города, что GameSession.CITY_CAPACITY_TECHS (private, поэтому
 * список продублирован здесь — держать в синхроне при правке технологий вместимости). */
const CITY_CAPACITY_TECHS_APPROX = ["Каменная кладка", "Стандартизация", "Городское планирование", "Медицина", "Космонавтика"];
function cityCapacityForApprox(session: GameSession, playerId: number): number {
  return 1 + CITY_CAPACITY_TECHS_APPROX.filter((t) => session.researchedTechs[playerId]?.has(t)).length;
}

/** Кто из других игроков граничит со мной (по сетке регионов) — есть город в одном из моих
 * приграничных регионов. */
function neighborPlayerIds(session: GameSession, playerId: number): number[] {
  const border = borderRegionsOf(session, playerId);
  const ids = new Set<number>();
  for (const { rc, rr } of border) {
    for (const c of session.cities) {
      if (c.playerId !== playerId && c.regionCol === rc && c.regionRow === rr) ids.add(c.playerId);
    }
  }
  return [...ids];
}

// По прямому запросу — силикаты и электричество исключены из поводов для войны (недостаточно
// критичны, в отличие от остальных 5 видов).
const STRATEGIC_RESOURCES_FOR_WAR: ResourceId[] = ["metalOre", "hydrocarbons", "preciousMetals", "uranium", "rareEarth"];

/** С какой эпохи ресурс вообще СТАНОВИТСЯ критичным — раньше воевать за него незачем (по прямому
 * уточнению: «критичность доступа к ресурсам: металлические руды с 1 эпохи актуально, углеводороды
 * с 3 эпохи, редкоземельные с 5 эпохи»). Совпадает с реальной ценой юнитов по эпохам
 * (`GameSession.EPOCH_UNIT_COST`): Металл нужен уже юнитам Э2, Углеводороды — с Э4, Редкоземельные —
 * только Э6, поэтому идти воевать за них СИЛЬНО заранее — трата бюджета впустую. Драгоценные металлы
 * (третий источник дохода, §10) и Уран (ядерный арсенал, поздняя игра) пользователем отдельно не
 * названы — пороги выведены по смыслу их применения, поправить их можно только здесь. */
const RESOURCE_RELEVANT_FROM_EPOCH: Record<string, number> = {
  metalOre: 1,
  hydrocarbons: 3,
  preciousMetals: 1,
  uranium: 5,
  rareEarth: 5,
};

/** Зеркалит приватный `GameSession.playerEpoch` (не экспортирован — тот же приём, что и everywhere в
 * этом файле): старшая эпоха среди ИССЛЕДОВАННЫХ игроком технологий. */
function playerEpochOf(session: GameSession, playerId: number): number {
  let max = 1;
  for (const techId of session.researchedTechs[playerId]) {
    const t = TECH_TREE.find((x) => x.id === techId);
    if (t && t.epoch > max) max = t.epoch;
  }
  return max;
}

/** Можно ли добыть ресурс САМОМУ, без войны (по прямому уточнению — «есть альтернативные способы
 * добычи, их нужно учитывать»): «Геологоразведка» даёт картой «Рабочий» добычу ЛЮБОГО стратегического
 * ресурса на выбор из гекса Равнины (см. §3/§15.4 СПРАВОЧНИКА) — ЕДИНСТВЕННАЯ технология с этим
 * эффектом и ЕДИНСТВЕННЫЙ её эффект (по прямому уточнению — «убирай из Индустриализации, пусть будет
 * только в Геологоразведке», а следом отдельно «убирай» и про альтернативное применение карты
 * «Строитель» — оба варианта существовали недолго в рамках одной сессии и оба сняты). Есть такая
 * возможность — воевать за этот ресурс незачем, он добывается своими руками. */
function hasAlternativeExtraction(session: GameSession, playerId: number): boolean {
  return session.researchedTechs[playerId].has("Геологоразведка");
}

/** Есть ли в ЭТОМ конкретном регионе хотя бы 1 гекс с ресурсом — общий примитив, используется и
 * «обладает ресурсом где-то на территории» (hasResourceInOwnTerritory), и точечной проверкой одного
 * приграничного региона цели (considerWarTargets, причина «нехватка ресурса»). */
function regionHasResource(session: GameSession, rc: number, rr: number, resource: ResourceId): boolean {
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      if (session.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).resource === resource) return true;
    }
  }
  return false;
}
/** Сколько гексов леса сейчас в этом регионе — по прямому запросу используется «Строителем», чтобы
 * никогда не срубить ПОСЛЕДНИЙ лес региона (см. tryBuilder — вырубка последнего запускает штрафной
 * каскад, GameSession.cascadeLastForestLoss). */
function forestTileCountInRegion(session: GameSession, rc: number, rr: number): number {
  let count = 0;
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      if (session.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).forest) count++;
    }
  }
  return count;
}
/** Есть ли у игрока хотя бы 1 гекс с этим ресурсом в одном из СВОИХ регионов — географическое
 * приближение «обладает ресурсом» (без учёта технологии добычи — «жадность» касается территории, не
 * того, готов ли игрок её прямо сейчас разрабатывать). */
function hasResourceInOwnTerritory(session: GameSession, playerId: number, resource: ResourceId): boolean {
  for (const region of ownedRegionsOf(session, playerId)) {
    const [rc, rr] = region.split(",").map(Number);
    if (regionHasResource(session, rc, rr, resource)) return true;
  }
  return false;
}

/** category ("food"/"strategic"/"trade") по id ресурса — используется приоритетом карт (§ ниже) для
 * решений, для которых важен ТИП ресурса, а не конкретный вид. */
const RESOURCE_CATEGORY = new Map(RESOURCES.map((r) => [r.id, r.category]));
const RESOURCE_LABEL = new Map(RESOURCES.map((r) => [r.id, r.label]));
/** `targetCount` (сколько тайлов этого вида генератор карты обычно сеет) как мера редкости — меньше
 * значение, реже вид встречается на карте. Используется выбором «Рабочего» про запас (см. ниже). */
const RESOURCE_RARITY = new Map(RESOURCES.map((r) => [r.id, r.targetCount]));
/** Суммарный запас склада по ВСЕМ видам ресурса одной категории (food/strategic/trade) — 0 значит
 * «этой категории на складе нет ВООБЩЕ ни одного вида». Общий помощник для «Рабочего» — и выбора
 * ГОРОДА (см. `tryWorkerCollect`, cityCanSupplyMissingCategory), и выбора ТИПА внутри города
 * (`needsResourceChoice`), чтобы не разъезжаться в двух местах. */
function warehouseCategoryTotal(session: GameSession, playerId: number, category: string | undefined): number {
  return RESOURCES.filter((r) => r.category === category).reduce((sum, r) => sum + (session.warehouse[playerId]?.[r.id] ?? 0), 0);
}

/** По прямому запросу — живой баг-репорт: «в плане пропущен шаг покупки на бирже» (склад был пуст,
 * но действие всё равно прошло за счёт автопокупки рынком за деньги, см. `ActionResult.spent`/«Доступ
 * → склад → рынок» в СПРАВОЧНИКЕ) — приписывает к подписи шага явное перечисление того, что реально
 * куплено на бирже (склад/доступ региона — ожидаемый путь по умолчанию, не нуждается в пометке).
 * Пустая строка, если рыночных покупок в этом действии не было. */
function marketSpendNote(result: { spent?: { resource: ResourceId; source: string; price?: number }[] }): string {
  const bought = (result.spent ?? []).filter((s) => s.source === "market");
  if (!bought.length) return "";
  const parts = bought.map((s) => `1×${RESOURCE_LABEL.get(s.resource) ?? s.resource}${s.price !== undefined ? ` за ${s.price}💰` : ""}`);
  return ` (склада не хватило — куплено на бирже: ${parts.join(", ")})`;
}

const WAR_FORCE_RATIO = 2; // «силы AI выше более чем вдвое»
const CHALLENGE_FORCE_RATIO = 0.9; // условие 3 — «военные силы равны или чуть превосходят»
const TERRITORIAL_VICTORY_WATCH_CITIES = 8; // «один из игроков достиг 8 поселений»
/** «Сдерживание лидера» (§5.2, по прямому запросу) — смягчённый (не обойдённый целиком, как у
 * Ненависти/Отчаяния) порог перевеса для целей, которые одновременно (а) уже в плохих отношениях
 * (< TRIBUTE_RELATION_MIN) И (б) обгоняют остальных по росту веса (`session.isOutgrowingOthers` —
 * тот же предикат, что питает континуальный дрейф trust «Баланс сил», GameSession.
 * applyPowerBalanceFactors). Мягче обычного WAR_FORCE_RATIO(2), жёстче паритета Отчаяния/срыва
 * территориальной победы (CHALLENGE_FORCE_RATIO=0.9) — цель не гарантированная победа и не последний
 * шанс, а превентивное недопущение чужого снежного кома. */
const CONTAINMENT_FORCE_RATIO = 1.5;

/** Причина «нехватка стратегического ресурса» — по прямому запросу БОЛЬШЕ НЕ объявляет войну
 * мгновенно, а заводит «План войны» (`considerWarPlan` ниже, ЦИВА-СПРАВОЧНИК §15.2) — накопление
 * перевеса сил перед реальным объявлением. Вынесена из `considerWarTargets` в отдельную функцию,
 * т.к. это единственная из 3 причин, которой теперь нужно многоходовое состояние; остальные 2
 * («некуда расти»/«территориальная победа») остаются мгновенными, см. `considerWarTargets` ниже.
 * Порог силы×2/денег — ЛОКАЛЬНЫЙ, по прямому запросу («считаем не общее число юнитов, а число
 * юнитов в видимых регионах — противника нужно время и деньги перебросить») — свои юниты в регионе
 * захвата и в своих соседних с ним регионах (`localCampaignForce`) против защитников именно ЭТОГО
 * региона (`localDefenseForce`), а не общий счёт по игроку целиком; денег должно хватать на
 * переброску именно этой группировки (`campaignMoneyNeeded`), не фиксированный банк. Возвращает
 * конкретный регион с ресурсом (не просто игрока) — нужен для `WarPlan.regionCol/regionRow`. */
function findResourceShortageTarget(session: GameSession, playerId: number): { targetId: number; resource: ResourceId; regionCol: number; regionRow: number } | null {
  if (countUnitsOf(session, playerId) <= 0) return null;
  // По прямому запросу — два дополнительных условия (обязательны вместе с «не владею / сосед
  // владеет»): мирная экспансия (свободный регион под заселение) предпочтительнее войны, если
  // доступна; регион с ресурсом у цели должен быть ПРИГРАНИЧНЫМ (реально захватываемым одной
  // кампанией), не просто «где-то на её территории».
  if (unclaimedNearbyRegions(session, playerId).length) return null;
  const neighbors = neighborPlayerIds(session, playerId);
  const epoch = playerEpochOf(session, playerId);
  for (const resource of STRATEGIC_RESOURCES_FOR_WAR) {
    // Актуальность по эпохе и альтернативная добыча (по прямому уточнению, см. доку обеих функций
    // выше) — ресурс, который этой эпохе ещё не нужен ИЛИ который игрок умеет добыть сам, поводом для
    // войны не является вовсе.
    if (epoch < (RESOURCE_RELEVANT_FROM_EPOCH[resource] ?? 1)) continue;
    if (hasAlternativeExtraction(session, playerId)) continue;
    if (hasResourceInOwnTerritory(session, playerId, resource)) continue;
    // По прямому уточнению, живой баг-репорт — «металлическая руда всегда есть на бирже (мировой
    // рынок её вечно доливает, GameSession.WORLD_MARKET_RESOURCES), так что мирная альтернатива
    // должна считаться по деньгам на балансе, что считается доступной, пока денег хватает»: раньше
    // проверялся сам факт наличия лота, без цены вовсе — металл (единственный из 5 стратегических
    // ресурсов войны, состоящий ОДНОВРЕМЕННО и в вечно доливаемом мировом списке) тем самым НИКОГДА
    // не мог завести войну/план по этой причине, даже если денег на реальную покупку не хватало ни
    // на один лот. Теперь мирная альтернатива считается доступной только если СВОИХ денег хватает
    // хотя бы на один конкретный лот — иначе это не настоящая альтернатива войне.
    if (session.market.some((l) => l.kind === "resource" && l.resource === resource && session.money[playerId] >= l.price)) continue;
    for (const targetId of neighbors) {
      for (const { rc, rr } of borderRegionsOf(session, playerId)) {
        if (!session.cities.some((c) => c.playerId === targetId && c.regionCol === rc && c.regionRow === rr)) continue;
        if (!regionHasResource(session, rc, rr, resource)) continue;
        // Локальный перевес сил ИМЕННО в регионе захвата (по прямому запросу — «считаем не общее
        // число юнитов, мы считаем число юнитов в видимых регионах, потому что противника нужно
        // время и деньги перебросить»), не общий счёт по игроку целиком (см. localCampaignForce/
        // localDefenseForce выше) — та же кратность WAR_FORCE_RATIO, только локально; денег должно
        // хватать на переброску именно ЭТОЙ группировки (campaignMoneyNeeded), не фиксированный банк.
        const myLocal = localCampaignForce(session, playerId, rc, rr);
        const theirLocal = localDefenseForce(session, targetId, rc, rr);
        const forceReady = myLocal > theirLocal * WAR_FORCE_RATIO && session.money[playerId] >= campaignMoneyNeeded(myLocal);
        // «Рассредоточить в городах-плацдармах этого региона действительно некуда» (по прямому
        // уточнению — «нужен юнит в регионе войны, а рассредоточить войска из города некуда, это
        // автоматом война») — та же ситуация, что и в considerWarPlan для УЖЕ существующего плана
        // (warPlanStagingHasNoRoom), только ПРОВЕРЯЕТСЯ ЗАРАНЕЕ, ещё до формального создания плана —
        // ждать перевеса бессмысленно, если копить в плацдарме физически уже негде: этого одного
        // условия достаточно, даже если перевес/деньги ещё не набраны.
        if (!forceReady && !warPlanStagingHasNoRoom(session, playerId, { regionCol: rc, regionRow: rr })) continue;
        return { targetId, resource, regionCol: rc, regionRow: rr };
      }
    }
  }
  return null;
}

/** Условия МГНОВЕННОГО объявления войны — по прямому запросу дословно, 2 из исходных 3 причин
 * (третья, «нехватка ресурса», теперь заводит «План войны», см. `findResourceShortageTarget`/
 * `considerWarPlan` выше):
 * 1. Некуда расти — все свои города на пределе вместимости, но в руке есть карта поселения.
 * 2. Соперник близок к территориальной победе (≥8 городов), силы примерно равны — можно помешать.
 * Условие 1 требует общий порог «сила ×2 + денег хотя бы 1 на каждого своего юнита»
 * (`envHasMoneyPerUnit` — по прямому уточнению, никакого отдельного плоского числа); условие 2 —
 * свой, более мягкий порог (паритет сил), т.к. цель не завоевание, а срыв чужой победы. Возвращает первую применимую пару
 * цель+причина или null — по одной попытке объявления войны за ход, не заваливаем сразу всех. */
function considerWarTargets(session: GameSession, playerId: number): { targetId: number; reason: string } | null {
  // Отношения AI — ненависть (по прямому запросу, шкала 0-10 = «Ненависть»): «приоритет смещается
  // на войну» — обходит ОБЫЧНЫЕ причины и пороги (деньги 1 на юнит/myUnits<=0/сила соперника)
  // целиком, возвращается СРАЗУ, если такой враг есть и с ним ещё не идёт война.
  const hatedId = hasHatedEnemyOf(session, playerId);
  if (hatedId !== null && !session.relationOf(playerId, hatedId).war) {
    const hatedPlayer = session.players.find((p) => p.id === hatedId)!;
    return { targetId: hatedId, reason: `ненависть к игроку ${hatedPlayer.name}` };
  }

  const myUnits = countUnitsOf(session, playerId);

  // «Отчаяние» (по прямому запросу §1.1) — свой вес (playerWeightOf — военная сила + население +
  // технологии, предпочтено числу городов именно из-за динамичности населения, см. её доку в
  // valuation.ts) не менее 5 циклов подряд держится ниже 60% среднего по живым соперникам
  // (GameSession.isDesperate/applyPowerBalanceFactors) — снимает обычный порог перевеса до паритета
  // (та же CHALLENGE_FORCE_RATIO, что и у «помешать территориальной победе» ниже — рискованная война
  // лучше гарантированного поражения). Цель — самый слабый ДОСТИЖИМЫЙ (приграничный) сосед, кроме
  // самого близкого союзника (closestAllyOf — топить единственного друга саморазрушительно даже в
  // отчаянии, та же исключающая логика, что и у «экспансии при 7 городах», findExpansionTarget).
  if (session.isDesperate(playerId)) {
    const ally = closestAllyOf(session, playerId);
    const candidates = neighborPlayerIds(session, playerId).filter(
      (id) => id !== ally && !session.relationOf(playerId, id).war && myUnits >= countUnitsOf(session, id) * CHALLENGE_FORCE_RATIO
    );
    if (candidates.length) {
      const target = candidates.slice().sort((a, b) => countUnitsOf(session, a) - countUnitsOf(session, b))[0];
      const targetPlayer = session.players.find((p) => p.id === target)!;
      return { targetId: target, reason: `отчаяние — рискованная война лучше верного поражения (${targetPlayer.name})` };
    }
  }

  for (const p of session.players) {
    if (p.id === playerId) continue;
    const theirCities = session.cities.filter((c) => c.playerId === p.id).length;
    if (theirCities < TERRITORIAL_VICTORY_WATCH_CITIES) continue;
    const theirUnits = countUnitsOf(session, p.id);
    if (myUnits >= theirUnits * CHALLENGE_FORCE_RATIO) return { targetId: p.id, reason: "рядом территориальная победа соперника" };
  }

  if (myUnits <= 0 || !envHasMoneyPerUnit(session, playerId)) return null;
  const neighbors = neighborPlayerIds(session, playerId);

  // «Сдерживание лидера» (по прямому запросу §5.2) — смягчённый (не обойдённый целиком) порог для
  // целей, к которым и так плохие отношения (< TRIBUTE_RELATION_MIN, та же граница, что открывает
  // «План войны» ниже) И кто прямо сейчас обгоняет остальных по росту веса (isOutgrowingOthers, тот же
  // предикат, что питает дрейф trust «Баланс сил») — превентивная война против назревающего снежного
  // кома, не обязательно самого слабого соседа. Проверяется РАНЬШЕ обычного «Некуда расти» ниже —
  // стратегическая, не демографическая причина.
  const containmentTargets = neighbors.filter(
    (id) => session.relationScoreOf(playerId, id) < TRIBUTE_RELATION_MIN && session.isOutgrowingOthers(id) && myUnits > countUnitsOf(session, id) * CONTAINMENT_FORCE_RATIO
  );
  if (containmentTargets.length) {
    const target = containmentTargets.slice().sort((a, b) => countUnitsOf(session, a) - countUnitsOf(session, b))[0];
    const targetPlayer = session.players.find((p) => p.id === target)!;
    return { targetId: target, reason: `сдерживание лидера — ${targetPlayer.name} слишком быстро растёт` };
  }

  const weakerNeighbors = neighbors.filter((id) => myUnits > countUnitsOf(session, id) * WAR_FORCE_RATIO);
  if (!weakerNeighbors.length) return null;

  const myCities = session.cities.filter((c) => c.playerId === playerId);
  const hasSettlerCard = session.hands[playerId]?.some((c) => c.id === "settler");
  const capacity = cityCapacityForApprox(session, playerId);
  const allCitiesFull = myCities.length > 0 && myCities.every((c) => c.population >= capacity);
  if (hasSettlerCard && allCitiesFull) {
    const target = weakerNeighbors.slice().sort((a, b) => countUnitsOf(session, a) - countUnitsOf(session, b))[0];
    return { targetId: target, reason: "некуда расти — нужна территория" };
  }

  return null;
}

const WAR_PLAN_FORCE_RATIO = 1.5; // «перевес 1 к 1.5» — та же метрика «сила = число юнитов», что и WAR_FORCE_RATIO
/** «Закрывающееся окно возможностей» (по прямому запросу §1.2) — план должен быть активен минимум
 * столько циклов, прежде чем «устойчивое сокращение разрыва» (3 замера подряд) вообще начинает что-то
 * значить (иначе шум первых 1-2 ходов после создания плана ловился бы как «окно закрывается»). */
const WAR_PLAN_WINDOW_MIN_AGE = 6;
/** Устойчивое сокращение разрыва (см. выше) при плане ≥WAR_PLAN_WINDOW_MIN_AGE циклов — требуемый
 * перевес для объявления снижается до этого значения вместо обычного WAR_PLAN_FORCE_RATIO (не ниже
 * паритета 1.0 в принципе — план всё ещё не бьёт заведомо слабее себя). */
const WAR_PLAN_PRESS_EARLY_RATIO = 1.3;
/** Тот же сигнал (устойчивое сокращение + минимальный возраст), но соотношение УЖЕ упало ниже этого
 * порога (не просто «не набрал 1.5», а объективно ослаб относительно момента создания плана) — план
 * признаётся обречённым и снимается без объявления войны, см. `WAR_PLAN_COOLDOWN_CYCLES` ниже. */
const WAR_PLAN_ABANDON_RATIO = 0.7;
/** После добровольного снятия обречённого плана (см. выше) — на столько циклов блокируется повторное
 * создание плана с ТЕМ ЖЕ поводом и ТОЙ ЖЕ целью (иначе findResourceShortageTarget/findExpansionTarget
 * пересоздали бы тот же обречённый план на следующий же ход). */
const WAR_PLAN_COOLDOWN_CYCLES = 10;

/** Текущее соотношение сил «План войны» (свои/чужие юниты, та же метрика, что и readiness-проверка) —
 * безопасно для случая theirs===0 (JSON не переживает Infinity — сериализация тихо превратила бы его в
 * null). */
function planForceRatio(session: GameSession, playerId: number, targetId: number): number {
  const mine = countUnitsOf(session, playerId);
  const theirs = countUnitsOf(session, targetId);
  if (theirs <= 0) return mine > 0 ? 999 : 1;
  return mine / theirs;
}
/** Устойчивое (3 замера подряд, не разовый шум одного хода) сокращение соотношения сил плана. */
function warPlanRatioDeclining(plan: WarPlan): boolean {
  const h = plan.ratioHistory;
  return h.length >= 3 && h[h.length - 3] > h[h.length - 2] && h[h.length - 2] > h[h.length - 1];
}
/** Граница «нейтральных» отношений (по прямому запросу) — НИЖЕ неё «План войны» заводится напрямую
 * (отношения уже плохие, дипломатия бессмысленна), а В ДИАПАЗОНЕ [TRIBUTE_RELATION_MIN, 60) сперва
 * пробуется требование дани-ультиматума (`considerRequestCardOrResource`) — ни настолько хорошие,
 * чтобы просто вежливо попросить (см. ветку `>=60` там же), ни настолько плохие, чтобы сразу решить
 * силой без предупреждения. */
const TRIBUTE_RELATION_MIN = 40;
const EXPANSION_WATCH_CITIES = 7; // «у игрока 7 городов — начинает готовить захват ещё двух регионов»

/** Живой ИГРОК, к которому у `playerId` САМОЕ высокое личное отношение (`relationScoreOf`, §8.3) —
 * по прямому запросу («экспансия применяется против любого игрока, кроме союзника — самой высокой
 * дружбы»). Ничьей между несколькими одинаково любимыми не разбирается специально — берётся первый
 * попавшийся из них (не критично: экспансия просто исключит ОДНОГО конкретного, не пул кандидатов). */
function closestAllyOf(session: GameSession, playerId: number): number | null {
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const p of session.players) {
    if (p.id === playerId || session.eliminatedPlayers.has(p.id)) continue;
    const score = session.relationScoreOf(playerId, p.id);
    if (score > bestScore) {
      bestScore = score;
      best = p.id;
    }
  }
  return best;
}

/** Причина «экспансия при 7 городах» (по прямому запросу) — своих городов ≥7, хочет захватить ещё 2
 * региона (`WarPlan.citiesWanted`, второй регион — задел на будущее, план пока нацелен только на
 * первый). Цель — самый слабый (`countUnitsOf`) ЖИВОЙ игрок КРОМЕ самого близкого союзника.
 *
 * **Регион цели обязан быть ДОСТИЖИМЫМ для предварительного сосредоточения войск** (по прямому
 * уточнению — «война должна строиться на прилегающих, а не далёких регионах, если нет открытых
 * границ, чтоб там разместить войска заранее»): либо он ПРИГРАНИЧНЫЙ для меня (`borderRegionsOf` —
 * войска можно подтянуть по своей территории вплотную и ударить), либо с владельцем есть «Открытые
 * границы» (тогда можно пройти его территорией и встать где угодно). Раньше ограничения не было
 * вовсе — «явно допускает морское вторжение»: на реальном сейве это дало жёлтому (7 городов, восток
 * карты) цель на ПРОТИВОПОЛОЖНОМ конце карты без единого соглашения о проходе — план, к региону
 * которого войска физически не могут подойти, копил перевес вечно и никогда не превращался в войну.
 * Ни один регион цели не достижим — цель просто не берётся (`null`), причина не срабатывает. */
function findExpansionTarget(session: GameSession, playerId: number, ignoreReach = false): { targetId: number; regionCol: number; regionRow: number } | null {
  const myCities = session.cities.filter((c) => c.playerId === playerId);
  if (myCities.length < EXPANSION_WATCH_CITIES) return null;
  const ally = closestAllyOf(session, playerId);
  const rivals = session.players.filter((p) => p.id !== playerId && p.id !== ally && !session.eliminatedPlayers.has(p.id));
  if (!rivals.length) return null;
  const border = new Set(borderRegionsOf(session, playerId).map(({ rc, rr }) => `${rc},${rr}`));
  // `ignoreReach` (по прямому уточнению — «открытых границ можно и требовать или купить, так что
  // цели дипломатии могут быть промежуточными») — тот же выбор цели, но БЕЗ фильтра достижимости:
  // нужен дипломатии, чтобы понять, С КЕМ именно добиваться «Открытых границ» ради прохода к цели,
  // которая иначе просто отбрасывается (см. `considerOpenBorders`).
  const reachable = (target: { id: number }, city: City) =>
    ignoreReach || border.has(`${city.regionCol},${city.regionRow}`) || session.relationOf(playerId, target.id).agreements.has("openBorders");
  for (const target of rivals.slice().sort((a, b) => countUnitsOf(session, a.id) - countUnitsOf(session, b.id))) {
    const targetCities = session.cities.filter((c) => c.playerId === target.id && reachable(target, c));
    if (!targetCities.length) continue;
    const nearest = targetCities.slice().sort(
      (a, b) =>
        Math.min(...myCities.map((m) => session.hexDistance(m.col, m.row, a.col, a.row))) - Math.min(...myCities.map((m) => session.hexDistance(m.col, m.row, b.col, b.row)))
    )[0];
    return { targetId: target.id, regionCol: nearest.regionCol, regionRow: nearest.regionRow };
  }
  return null;
}

/** Регион цели плана всё ещё захватываемая причина — перепроверяется КАЖДЫЙ ход, пока план активен
 * (не только в момент создания). Любое из условий ниже снимает план (см. `considerWarPlan`) —
 * накопление войск ради уже неактуальной причины бессмысленно. */
function warPlanCauseStillValid(session: GameSession, playerId: number, plan: WarPlan): boolean {
  if (plan.cause === "resourceShortage") {
    if (!plan.resource) return false;
    // Гейт по отношениям (по прямому запросу) — специфичен именно этой причине, см. considerWarPlan.
    if (session.relationScoreOf(playerId, plan.targetId) >= 60) return false;
    // Те же два условия, что и при создании плана (`findResourceShortageTarget`) — держим в синхроне:
    // ресурс стал добываться самому (открылась «Геологоразведка»/«Индустриализация») или этой эпохе
    // он ещё вовсе не нужен — копить войска ради него больше незачем.
    if (hasAlternativeExtraction(session, playerId)) return false;
    if (playerEpochOf(session, playerId) < (RESOURCE_RELEVANT_FROM_EPOCH[plan.resource] ?? 1)) return false;
    if (hasResourceInOwnTerritory(session, playerId, plan.resource)) return false;
    // Биржа считается АЛЬТЕРНАТИВОЙ, только если денег реально хватает хотя бы на один лот — та же
    // проверка, что и при создании плана (см. её доку там: металл на мировом рынке есть всегда).
    if (session.market.some((l) => l.kind === "resource" && l.resource === plan.resource && session.money[playerId] >= l.price)) return false;
    if (unclaimedNearbyRegions(session, playerId).length) return false;
    return session.cities.some((c) => c.playerId === plan.targetId && c.regionCol === plan.regionCol && c.regionRow === plan.regionRow);
  }
  if (plan.cause === "expansion") {
    if (session.cities.filter((c) => c.playerId === playerId).length < EXPANSION_WATCH_CITIES) return false;
    if (closestAllyOf(session, playerId) === plan.targetId) return false; // отношения сместились — цель стала САМЫМ близким союзником
    // Регион цели должен ОСТАВАТЬСЯ достижимым для сосредоточения войск (то же условие, что и при
    // выборе цели в findExpansionTarget — иначе план зависает на недостижимом регионе навсегда):
    // приграничный мне ЛИБО есть «Открытые границы» с владельцем (в т.ч. если их отозвали — план
    // снимается сам, а дипломатия может добиться их заново и завести план снова).
    const reachable =
      borderRegionsOf(session, playerId).some(({ rc, rr }) => rc === plan.regionCol && rr === plan.regionRow) ||
      session.relationOf(playerId, plan.targetId).agreements.has("openBorders");
    if (!reachable) return false;
    return session.cities.some((c) => c.playerId === plan.targetId);
  }
  return false;
}

/** Нужна ли переброска флотом до конкретного региона — по прямому запросу, переиспользует уже
 * существующий BFS-примитив связности по суше (`landComponentOf`, см. `strandedShipNeed` выше):
 * ни один тайл целевого региона не входит в land-компоненту моего (первого) города — только морем. */
function planRequiresNavy(session: GameSession, playerId: number, regionCol: number, regionRow: number): boolean {
  const myCity = myCities(session, playerId)[0];
  if (!myCity) return true;
  const component = landComponentOf(session, myCity.col, myCity.row);
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      if (component.has(`${regionCol * REGION_SIZE_X + dx},${regionRow * REGION_SIZE_Y + dy}`)) return false;
    }
  }
  return true;
}

/** По прямому запросу — «План войны»: могу ли я (playerId) дойти по суше хоть до одного города
 * targetId — переиспользует уже существующий `landComponentOf` (тот же примитив, что `planRequiresNavy`
 * выше и `isIsolatedFromOwnCities`). Своих городов нет вовсе — считается «не могу» (нет откуда мерить). */
function canReachPlayerByLand(session: GameSession, playerId: number, targetId: number): boolean {
  const myCity = myCities(session, playerId)[0];
  if (!myCity) return false;
  const component = landComponentOf(session, myCity.col, myCity.row);
  return session.cities.some((c) => c.playerId === targetId && component.has(`${c.col},${c.row}`));
}

/** Готов ли активный «План войны» объявить войну ПРЯМО СЕЙЧАС — то же самое решение, что принимает
 * `considerWarPlan` перед реальным `dispatch("declareWar", ...)`, но БЕЗ побочных эффектов (не
 * трогает `ratioHistory`/не снимает план при упадке — только читает уже накопленную историю на
 * момент вызова). Переиспользуется `computeStrategicPriority` (по прямому запросу — «режим ВОЙНА
 * подразумевает, что игрок уже в войне или объявит её в этом ходе, а не подготовку к ней»): раньше
 * режим ВОЙНА определялся абстрактным «есть перевес сил и деньги на армию» (`envHasConcentratedAttackAdvantage`
 * + `envHasMoneyPerUnit`), никак не связанным с тем, есть ли у игрока реальный повод/цель войны —
 * мог показывать ВОЙНА игроку, у которого нет НИ активной войны, НИ созревшего «Плана войны», НИ
 * немедленного повода (`considerWarTargets`), то есть фактически ещё готовящемуся, а не воюющему. */
function warPlanReadyToDeclare(session: GameSession, playerId: number, existing: WarPlan): boolean {
  const myUnits = countUnitsOf(session, playerId);
  const theirUnits = countUnitsOf(session, existing.targetId);
  const planAge = session.cyclesElapsed - existing.createdAtCycle;
  const declining = planAge >= WAR_PLAN_WINDOW_MIN_AGE && warPlanRatioDeclining(existing);
  const requiredRatio = declining ? WAR_PLAN_PRESS_EARLY_RATIO : WAR_PLAN_FORCE_RATIO;
  const forceReady = myUnits >= theirUnits * requiredRatio;
  const stuck = warPlanStagingHasNoRoom(session, playerId, existing);
  if (!forceReady && !stuck) return false;
  if (!stuck && session.money[playerId] < campaignMoneyNeeded(myUnits)) return false;
  return true;
}

/** «План войны» (по прямому запросу — многоходовая подготовка вместо мгновенного объявления, см.
 * ЦИВА-СПРАВОЧНИК §15.2) — вызывается РАНЬШЕ `considerWarDeclaration`. Один активный план на игрока
 * (`session.warPlans`). Гейт по отношениям — план заводится, только если `relationScoreOf(меня, цель)
 * < TRIBUTE_RELATION_MIN` (Плохие и ниже, см. её doc); хорошие отношения (≥60) решаются дипломатией
 * (`considerRequestCardOrResource`, вежливая просьба), нейтральные [40,60) — требованием дани-
 * ультиматума (там же), не войной напрямую. */
function considerWarPlan(session: GameSession, playerId: number, reporter: Reporter) {
  const existing = session.warPlans[playerId];
  if (existing) {
    const target = session.players.find((p) => p.id === existing.targetId);
    const stillValid =
      !!target && !session.eliminatedPlayers.has(existing.targetId) && !session.relationOf(playerId, existing.targetId).war && warPlanCauseStillValid(session, playerId, existing);
    if (!stillValid) {
      delete session.warPlans[playerId];
      return;
    }
    // «Закрывающееся окно возможностей» (по прямому запросу §1.2) — замер соотношения сил не чаще
    // раза за цикл (считерWarPlan вызывается несколько раз за ход, см. доку lastRatioSampleCycle).
    if (session.cyclesElapsed !== existing.lastRatioSampleCycle) {
      existing.ratioHistory.push(planForceRatio(session, playerId, existing.targetId));
      if (existing.ratioHistory.length > 3) existing.ratioHistory.shift();
      existing.lastRatioSampleCycle = session.cyclesElapsed;
    }
    const planAge = session.cyclesElapsed - existing.createdAtCycle;
    const declining = planAge >= WAR_PLAN_WINDOW_MIN_AGE && warPlanRatioDeclining(existing);
    const latestRatio = existing.ratioHistory[existing.ratioHistory.length - 1] ?? planForceRatio(session, playerId, existing.targetId);
    // Цель растёт быстрее, чем я коплю перевес (устойчиво, не разовый шум) И план УЖЕ заметно слабее,
    // чем в момент создания (не просто «ещё не набрал 1.5», а объективно ослаб) — план обречён, ждать
    // дальше бессмысленно: снимается БЕЗ объявления войны, повторное создание с этим же поводом/целью
    // блокируется на WAR_PLAN_COOLDOWN_CYCLES (иначе findResourceShortageTarget/findExpansionTarget
    // пересоздали бы тот же план на следующий же ход, см. доку константы).
    if (declining && latestRatio < WAR_PLAN_ABANDON_RATIO) {
      session.warPlanCooldowns[`${playerId}:${existing.targetId}`] = session.cyclesElapsed + WAR_PLAN_COOLDOWN_CYCLES;
      delete session.warPlans[playerId];
      return;
    }
    // Готовность объявить — вынесена в отдельный `warPlanReadyToDeclare` (переиспользуется
    // `computeStrategicPriority`, см. её доку), сюда возвращает то же самое решение.
    if (!warPlanReadyToDeclare(session, playerId, existing)) return; // перевес ещё не набран/рассредоточить есть куда/денег нет — просто ждём (влияние на постройку/перемещение — следующий шаг)
    // Рассредоточить в городах-плацдармах плана ДЕЙСТВИТЕЛЬНО некуда (по прямому уточнению — «если
    // в городах, примыкающих к региону планируемой войны, нет места под юнитов, их можно
    // рассредоточить; а вот если рассредоточить нельзя, это мгновенно начинает войну») — тут нужен
    // только для подписи шага плана ниже (сама готовность уже решена выше).
    const stuck = warPlanStagingHasNoRoom(session, playerId, existing);
    const payload = { targetId: existing.targetId };
    const result = session.dispatch("declareWar", playerId, payload);
    delete session.warPlans[playerId];
    if (result.ok) {
      reporter.step({
        action: "declareWar",
        payload,
        targetKind: "player",
        targetPlayerId: existing.targetId,
        label: stuck
          ? `Объявил войну игроку ${target!.name} — план войны: рассредоточить накопленные силы больше некуда, ждать дальше нельзя.`
          : `Объявил войну игроку ${target!.name} — план войны выполнен, перевес сил набран.`,
      });
    }
    return;
  }

  const found = findResourceShortageTarget(session, playerId);
  // Порог отношений опущен с <60 до <TRIBUTE_RELATION_MIN=40 (по прямому запросу) — диапазон [40,60)
  // теперь принадлежит требованию дани-ультиматума (см. считающую его же findResourceShortageTarget
  // ветку в considerRequestCardOrResource): отказ по ультиматуму объявляет войну автоматически сам
  // (GameSession.resolveProposal), так что «План войны» для ЭТОЙ причины в этом промежутке просто не
  // нужен — ультиматум ИЛИ уже идёт, ИЛИ уже привёл к войне напрямую.
  // «Закрывающееся окно возможностей» (§1.2) — план с этим же поводом и той же целью только что
  // признан обречённым и добровольно снят (см. ветку `declining && latestRatio < WAR_PLAN_ABANDON_RATIO`
  // выше) — не пересоздаём его немедленно на следующий же ход, ждём кулдаун.
  const resourceCooldownUntil = found ? session.warPlanCooldowns[`${playerId}:${found.targetId}`] : undefined;
  if (found && resourceCooldownUntil !== undefined && session.cyclesElapsed < resourceCooldownUntil) {
    // повод ещё формально применим, но эта цель на кулдауне — дальше по функции для НЕЁ ничего не делаем
  } else if (found && session.relationScoreOf(playerId, found.targetId) < TRIBUTE_RELATION_MIN) {
    const newPlan: WarPlan = {
      targetId: found.targetId,
      cause: "resourceShortage",
      resource: found.resource,
      regionCol: found.regionCol,
      regionRow: found.regionRow,
      citiesWanted: 1,
      requiresNavy: planRequiresNavy(session, playerId, found.regionCol, found.regionRow),
      createdAtCycle: session.cyclesElapsed,
      ratioAtCreation: planForceRatio(session, playerId, found.targetId),
      ratioHistory: [planForceRatio(session, playerId, found.targetId)],
      lastRatioSampleCycle: session.cyclesElapsed,
    };
    session.warPlans[playerId] = newPlan;
    // «Рассредоточить некуда» уже СЕЙЧАС, в момент создания плана (по прямому уточнению — «нужен
    // юнит в регионе войны, а рассредоточить войска из города некуда, это автоматом война») — не
    // ждём следующего хода (когда сработала бы та же проверка в ветке «план уже существует» выше):
    // объявляем войну немедленно, тем же приёмом.
    if (warPlanStagingHasNoRoom(session, playerId, newPlan)) {
      const target = session.players.find((p) => p.id === newPlan.targetId)!;
      const payload = { targetId: newPlan.targetId };
      const result = session.dispatch("declareWar", playerId, payload);
      delete session.warPlans[playerId];
      if (result.ok) {
        reporter.step({
          action: "declareWar",
          payload,
          targetKind: "player",
          targetPlayerId: newPlan.targetId,
          label: `Объявил войну игроку ${target.name} — рассредоточить накопленные силы у цели больше некуда, ждать перевеса нельзя.`,
        });
      }
    }
    return;
  }

  const expansion = findExpansionTarget(session, playerId);
  // «Закрывающееся окно возможностей» (§1.2) — тот же кулдаун, что и для «нехватки ресурса» выше.
  const expansionCooldownUntil = expansion ? session.warPlanCooldowns[`${playerId}:${expansion.targetId}`] : undefined;
  if (expansion && (expansionCooldownUntil === undefined || session.cyclesElapsed >= expansionCooldownUntil)) {
    session.warPlans[playerId] = {
      targetId: expansion.targetId,
      cause: "expansion",
      regionCol: expansion.regionCol,
      regionRow: expansion.regionRow,
      citiesWanted: 2,
      requiresNavy: planRequiresNavy(session, playerId, expansion.regionCol, expansion.regionRow),
      createdAtCycle: session.cyclesElapsed,
      ratioAtCreation: planForceRatio(session, playerId, expansion.targetId),
      ratioHistory: [planForceRatio(session, playerId, expansion.targetId)],
      lastRatioSampleCycle: session.cyclesElapsed,
    };
  }
}

/** Конкретный город цели плана — единственный в её регионе (`WarPlan.regionCol/regionRow`), по
 * которому и считается дальность обстрела/переброски. */
function warPlanCityOf(session: GameSession, plan: WarPlan): City | null {
  return session.cities.find((c) => c.playerId === plan.targetId && c.regionCol === plan.regionCol && c.regionRow === plan.regionRow) ?? null;
}

/** Стягивание сил к активному плану войны, ПОКА перевес ещё не набран (по прямому запросу) —
 * возвращает true, если юнит получил приказ (вызывающий код должен считать ход юнита завершённым).
 * Штурмовые/Мобильные при `requiresNavy` — грузятся на ближайший СВОЙ корабль без пассажира (посадка
 * уже существующий побочный эффект обычного перемещения на клетку корабля, см. `GameSession.
 * unitPassable`/`isAboardShip` — здесь просто выдаётся приказ дойти до этой клетки). Дальняя атака/
 * Поддержка — выдвигаются на клетку в пределах дальности выстрела от города цели, если такая ещё не
 * достигнута; легальность остановки там (своя территория/открытые границы союзника/ничья
 * необитаемая) целиком проверяет сам `commandUnit` — здесь только перебор кандидатов по расстоянию,
 * ближайший к юниту сначала, до первого реально принятого сервером. */
/** Общее ядро «выдвинуться к цели, если ещё не в позиции» — переиспользуется «Планом войны» (до
 * объявления, `tryStageForWarPlan`) и активной «Армией» (после объявления, §15.9а, `tryStageForArmy`).
 * Штурмовые/Мобильные при `requiresNavy` — грузятся на ближайший свой корабль без пассажира (посадка —
 * существующий побочный эффект `commandUnit` на клетку корабля, `target` этой ветке не нужен вовсе —
 * `null` допустим). Дальняя атака/Поддержка — выдвигаются на клетку в пределах дальности выстрела от
 * `target`, если такая ещё не достигнута (`target === null` — этой ветке просто нечего делать). */
function stageUnitTowardTarget(
  session: GameSession,
  playerId: number,
  unit: UnitInstance,
  target: { col: number; row: number } | null,
  requiresNavy: boolean,
  reporter: Reporter,
  reasonLabel: string
): boolean {
  if (requiresNavy && (unit.category === "assault" || unit.category === "mobile")) {
    const freeShip = session.units
      .filter(
        (u) =>
          u.category === "ship" &&
          u.playerId === playerId &&
          !(u.col === unit.col && u.row === unit.row) &&
          !session.units.some((r) => r.category !== "ship" && r.col === u.col && r.row === u.row)
      )
      .sort((a, b) => session.hexDistance(unit.col, unit.row, a.col, a.row) - session.hexDistance(unit.col, unit.row, b.col, b.row))[0];
    if (!freeShip) return false;
    const payload = { unitId: unit.id, col: freeShip.col, row: freeShip.row };
    const result = session.dispatch("commandUnit", playerId, payload);
    if (!result.ok) return false;
    reporter.step({
      action: "commandUnit",
      payload,
      sourceUnitId: unit.id,
      sourceCol: unit.col,
      sourceRow: unit.row,
      targetKind: "hex",
      targetCol: freeShip.col,
      targetRow: freeShip.row,
      label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) грузится на корабль — ${reasonLabel}.`,
    });
    return true;
  }
  if (target && (unit.category === "ranged" || unit.category === "support")) {
    const range = session.effectiveAttackRange(unit);
    if (session.hexDistance(unit.col, unit.row, target.col, target.row) <= range) return false; // уже в радиусе
    const candidates: { col: number; row: number; dist: number }[] = [];
    for (let dr = -range; dr <= range; dr++) {
      const row = target.row + dr;
      if (row < 0 || row >= MAP_HEIGHT) continue;
      for (let dc = -range; dc <= range; dc++) {
        const col = ((target.col + dc) % MAP_WIDTH + MAP_WIDTH) % MAP_WIDTH;
        if (col === target.col && row === target.row) continue;
        if (session.hexDistance(col, row, target.col, target.row) > range) continue;
        if (!session.isLandTile(col, row)) continue;
        candidates.push({ col, row, dist: session.hexDistance(unit.col, unit.row, col, row) });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    for (const cand of candidates) {
      const payload = { unitId: unit.id, col: cand.col, row: cand.row };
      const result = session.dispatch("commandUnit", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "commandUnit",
          payload,
          sourceUnitId: unit.id,
          sourceCol: unit.col,
          sourceRow: unit.row,
          targetKind: "hex",
          targetCol: cand.col,
          targetRow: cand.row,
          label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) выдвигается на позицию для обстрела — ${reasonLabel}.`,
        });
        return true;
      }
    }
  }
  return false;
}

function tryStageForWarPlan(session: GameSession, playerId: number, unit: UnitInstance, plan: WarPlan, reporter: Reporter): boolean {
  const city = warPlanCityOf(session, plan);
  return stageUnitTowardTarget(session, playerId, unit, city, plan.requiresNavy, reporter, "план войны требует переброски");
}

// === Армии и флоты (§15.9а, по прямому запросу — продолжение «Плана войны»: теперь уже ВЕДЕНИЕ, не
// только подготовка) ==============================================================================

/** Состав каждого из 6 шаблонов (по прямому запросу) — корабли («Десантная») сюда НЕ входят, см. doc
 * `Fleet`/`Army` в GameSession.ts: переброска — отдельная, персистентная сущность, армия её лишь
 * временно занимает под рейс. */
const ARMY_TEMPLATE_COMPOSITION: Record<ArmyTemplate, UnitCategory[]> = {
  amphibious: ["assault", "ranged"],
  fieldArtillery: ["ranged", "mobile"],
  assaultFar: ["assault", "support"],
  assaultNear: ["assault", "ranged"],
  cleanup: ["assault", "support", "support"],
  defensive: ["defense", "ranged"],
  mobile: ["mobile", "mobile", "mobile"],
};
const ARMY_TEMPLATE_LABEL: Record<ArmyTemplate, string> = {
  amphibious: "Десантная",
  fieldArtillery: "Полевая артиллерия",
  assaultFar: "Штурмовая (дальняя)",
  assaultNear: "Штурмовая (ближняя)",
  cleanup: "Группа зачистки",
  defensive: "Оборонительная",
  mobile: "Мобильная",
};
/** Лимит состава одной армии (по прямому запросу — «лимит армии одной 4 юнита»; больше сил
 * противника в регионе — задействовать НЕСКОЛЬКО армий, не раздувать одну сверх лимита). */
const ARMY_MAX_MEMBERS = 4;

/** Живые члены армии — по прямому уточнению (живая правка на этом же заходе): членство читается
 * напрямую с юнитов (`UnitInstance.armyId`), не с отдельного массива — тот мутировался бы только на
 * клоне планирования хода бота и никогда не доходил бы до настоящей партии (см. доку `Army` в
 * GameSession.ts). Юнит числится в армии, только пока жив — погибшие сами выпадают из этого списка,
 * отдельной чистки `memberUnitIds` не нужно. */
function armyMembersOf(session: GameSession, armyId: number): UnitInstance[] {
  return session.units.filter((u) => u.armyId === armyId);
}

/** Недостающие относительно шаблона категории (по прямому запросу §1 — «армия может быть неполной»:
 * действует любым составом от 2 до ARMY_MAX_MEMBERS, роль без состава просто не выполняется) — с
 * учётом кратности (например «Группа зачистки» просит 2 Поддержки). */
function armyMissingCategories(session: GameSession, template: ArmyTemplate, armyId: number): UnitCategory[] {
  const remaining = ARMY_TEMPLATE_COMPOSITION[template].slice();
  for (const u of armyMembersOf(session, armyId)) {
    const idx = remaining.indexOf(u.category);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  return remaining;
}

/** Выбор шаблона наступательной армии под конкретную кампанию (по прямому запросу — «каждый военный
 * план подразумевает свою стратегию строительства армии»): регион цели недостижим по суше — Десантная
 * (требует переброски, `planRequiresNavy` — тот же признак, что и у «Плана войны»); у меня в регионе
 * УЖЕ подавляющий (3×) локальный перевес — Группа зачистки (сопротивление уже сломлено, нужно быстро
 * дозачистить); я в Отчаянии (§1.1) — Мобильная (быстрый решающий инструмент, а не методичная осада);
 * у цели высокое население (крепкий гарнизон, §6.9 — гарнизон = население) — Полевая артиллерия
 * (размягчить перед штурмом); иначе — Штурмовая группа, партнёр по расстоянию (Артиллерия медленная —
 * только для близких операций, Поддержка — для дальних). */
function chooseArmyTemplate(session: GameSession, playerId: number, targetId: number, regionCol: number, regionRow: number): ArmyTemplate {
  if (planRequiresNavy(session, playerId, regionCol, regionRow)) return "amphibious";
  const localMine = localCampaignForce(session, playerId, regionCol, regionRow);
  const localTheirs = localDefenseForce(session, targetId, regionCol, regionRow);
  if (localTheirs > 0 && localMine > localTheirs * 3) return "cleanup";
  if (session.isDesperate(playerId)) return "mobile";
  const city = session.cities.find((c) => c.playerId === targetId && c.regionCol === regionCol && c.regionRow === regionRow);
  if (city && city.population >= 6) return "fieldArtillery";
  const myCity = myCities(session, playerId)[0];
  const dist = myCity && city ? session.hexDistance(myCity.col, myCity.row, city.col, city.row) : 0;
  return dist > 4 ? "assaultFar" : "assaultNear";
}

/** Заявки на постройку армий (по прямому запросу §3.4/§5 — «строятся по одной, не параллельно»,
 * «пополнение прямо в процессе боя») — вызывается раз за ход бота, до цикла розыгрыша карт (тот же
 * принцип, что и considerWarPlan/considerWarDeclaration), в этом порядке:
 * 1. Оборона — любой свой город, только что попавший в `isFrontRegion` (§15.2), без уже существующей
 *    Оборонительной армии/заявки именно на него — новая заявка вставляется В НАЧАЛО очереди
 *    (прерывает уже идущий наступательный проект — реальная защита важнее продолжения наступления).
 * 2. Очередь после этого не пуста — на сегодня хватит, наступательные заявки не трогаем (проектное
 *    мышление — по одной за раз).
 * 3. Пополнение существующей НЕПОЛНОЙ активной армии — раньше нового наступательного проекта: потери
 *    в бою латаются прежде, чем начинается что-то новое.
 * 4. Новый наступательный проект — по одному на каждого противника, с которым идёт война и у которого
 *    ещё вовсе нет ни армии, ни заявки; шаблон — `chooseArmyTemplate`; останавливается на первом же
 *    найденном поводе (один проект за ход, как и остальные «по одному» решения бота). */
/** `Army` и её первая `ArmyBuildOrder` создаются ВМЕСТЕ, `armyId` сразу указывает на реальную запись —
 * по прямому уточнению (живая правка на этом же заходе): эта функция вызывается НАПРЯМУЮ на настоящей
 * сессии (см. `bot.ts: syncAiMemoryBeforePlanning`), не на клоне планирования — значит создание здесь
 * ПЕРСИСТЕНТНО, без нужды в отдельном «ленивом создании армии при первом юните» (как было раньше). */
function pushNewArmyOrder(
  session: GameSession,
  queue: ArmyBuildOrder[],
  playerId: number,
  template: ArmyTemplate,
  targetPlayerId: number | null,
  targetRegionCol: number | null,
  targetRegionRow: number | null,
  homeCityId: number | null,
  atFront: boolean
) {
  const newArmy: Army = { id: session.nextArmyId++, playerId, template, targetPlayerId, targetRegionCol, targetRegionRow, homeCityId, createdAtCycle: session.cyclesElapsed };
  session.armies.push(newArmy);
  const order: ArmyBuildOrder = {
    id: session.nextArmyBuildOrderId++,
    playerId,
    template,
    targetPlayerId,
    targetRegionCol,
    targetRegionRow,
    homeCityId,
    armyId: newArmy.id,
    createdAtCycle: session.cyclesElapsed,
  };
  if (atFront) queue.unshift(order);
  else queue.push(order);
}

function ensureArmyBuildOrders(session: GameSession, playerId: number) {
  const queue = session.armyBuildQueue[playerId] ?? (session.armyBuildQueue[playerId] = []);

  for (const city of session.cities.filter((c) => c.playerId === playerId)) {
    if (!isFrontRegion(session, playerId, city.regionCol, city.regionRow)) continue;
    const hasDefender =
      session.armies.some((a) => a.playerId === playerId && a.template === "defensive" && a.homeCityId === city.id) ||
      queue.some((o) => o.template === "defensive" && o.homeCityId === city.id);
    if (hasDefender) continue;
    pushNewArmyOrder(session, queue, playerId, "defensive", null, null, null, city.id, true);
  }
  if (queue.length) return;

  const understaffed = session.armies.find((a) => a.playerId === playerId && armyMissingCategories(session, a.template, a.id).length > 0);
  if (understaffed) {
    queue.push({
      id: session.nextArmyBuildOrderId++,
      playerId,
      template: understaffed.template,
      targetPlayerId: understaffed.targetPlayerId,
      targetRegionCol: understaffed.targetRegionCol,
      targetRegionRow: understaffed.targetRegionRow,
      homeCityId: understaffed.homeCityId,
      armyId: understaffed.id,
      createdAtCycle: session.cyclesElapsed,
    });
    return;
  }

  for (const enemy of session.players.filter((p) => p.id !== playerId && session.relationOf(playerId, p.id).war)) {
    const hasSomething = session.armies.some((a) => a.playerId === playerId && a.targetPlayerId === enemy.id) || queue.some((o) => o.targetPlayerId === enemy.id);
    if (hasSomething) continue;
    const border = borderRegionsOf(session, playerId)
      .map(({ rc, rr }) => ({ rc, rr, city: session.cities.find((c) => c.playerId === enemy.id && c.regionCol === rc && c.regionRow === rr) }))
      .find((r) => r.city);
    const fallbackCity = session.cities.find((c) => c.playerId === enemy.id);
    const regionCol = border?.rc ?? fallbackCity?.regionCol ?? null;
    const regionRow = border?.rr ?? fallbackCity?.regionRow ?? null;
    if (regionCol === null || regionRow === null) continue;
    pushNewArmyOrder(session, queue, playerId, chooseArmyTemplate(session, playerId, enemy.id, regionCol, regionRow), enemy.id, regionCol, regionRow, null, false);
    return;
  }
}

/** Чистка армий/очереди (по прямому запросу §4 — «части армий когда остался всего 1 юнит примыкают к
 * другим армиям или отсыпают для переформирования») — вызывается раз за ход, после боевых действий:
 * 1. Остаток в 1 юнита — «армия» по определению начинается от 2 (см. doc `Army`) — пробует слиться с
 *    соседней армией той же цели с местом под лимитом (в пределах 2 гексов, переставляя `unit.armyId`
 *    на её id); не вышло — расформировывается (`unit.armyId = null`, юнит возвращается к обычной
 *    пожюнитной логике до следующего слияния/новой заявки).
 * 2. Пустые записи (0 живых членов — погибли все, или единственный только что расформирован п.1)
 *    убираются; заявки без живой армии снимаются целиком (не «отвязываются» — раз `Army` и
 *    `ArmyBuildOrder` теперь создаются паройвместе, вернуть заявку сиротой уже некому — новый повод
 *    в §4 списка ensureArmyBuildOrders заведёт новую пару заново); заявки на недостижимую/неактуальную
 *    цель (мир, выбывание, потеря города обороны) снимаются; заявки на УЖЕ полный состав снимаются
 *    (проект выполнен). */
function pruneArmies(session: GameSession, playerId: number) {
  for (const army of session.armies.filter((a) => a.playerId === playerId)) {
    const members = armyMembersOf(session, army.id);
    if (members.length !== 1) continue;
    const lone = members[0];
    const mergeTarget = session.armies.find((other) => {
      if (other.id === army.id || other.playerId !== playerId) return false;
      const otherMembers = armyMembersOf(session, other.id);
      if (!otherMembers.length || otherMembers.length >= ARMY_MAX_MEMBERS) return false;
      if (other.targetPlayerId !== army.targetPlayerId || other.homeCityId !== army.homeCityId) return false;
      return otherMembers.some((u) => session.hexDistance(u.col, u.row, lone.col, lone.row) <= 2);
    });
    lone.armyId = mergeTarget ? mergeTarget.id : null;
  }
  session.armies = session.armies.filter((a) => a.playerId !== playerId || armyMembersOf(session, a.id).length >= 2);

  const queue = session.armyBuildQueue[playerId];
  if (!queue) return;
  session.armyBuildQueue[playerId] = queue.filter((order) => {
    const army = session.armies.find((a) => a.id === order.armyId);
    if (!army) return false;
    if (order.targetPlayerId !== null) {
      if (session.eliminatedPlayers.has(order.targetPlayerId)) return false;
      if (!session.relationOf(playerId, order.targetPlayerId).war) return false;
    }
    if (order.homeCityId !== null && !session.cities.some((c) => c.id === order.homeCityId && c.playerId === playerId)) return false;
    if (armyMissingCategories(session, order.template, order.armyId).length === 0) return false;
    return true;
  });
}

/** Цель армии (по прямому запросу — аналог `warFrontHex`, но НА КОНКРЕТНУЮ армию/кампанию, не на всю
 * партию разом; несколько армий могут одновременно бить по одной и той же цели, каждая считает своё,
 * §5). Оборонительная — свой город, который держит; наступательная — тот же приоритет «вернуть
 * захваченный город» (§3.1), что и у общего `warFrontHex`, но СКОПИРОВАННЫЙ на конкретную цель этой
 * армии, иначе — город плана в своём регионе, иначе — ближайший к армии живой город цели. */
function armyTargetHex(session: GameSession, army: Army): { col: number; row: number; total?: number } | null {
  if (army.template === "defensive") {
    const city = army.homeCityId !== null ? session.cities.find((c) => c.id === army.homeCityId) : null;
    return city ? { col: city.col, row: city.row } : null;
  }
  if (army.targetPlayerId === null) return null;
  const recapture = session.recentCityLosses
    .filter((loss) => loss.oldOwnerId === army.playerId && loss.newOwnerId === army.targetPlayerId)
    .sort((a, b) => a.cycle - b.cycle)[0];
  if (recapture) {
    const city = session.cities.find((c) => c.id === recapture.cityId);
    if (city && city.playerId !== army.playerId && session.relationOf(army.playerId, city.playerId).war) {
      let total = 0;
      const rc = Math.floor(city.col / REGION_SIZE_X);
      const rr = Math.floor(city.row / REGION_SIZE_Y);
      for (const u of session.units) if (u.playerId === city.playerId && Math.floor(u.col / REGION_SIZE_X) === rc && Math.floor(u.row / REGION_SIZE_Y) === rr) total += valueOfUnit(u);
      return { col: city.col, row: city.row, total };
    }
  }
  if (army.targetRegionCol !== null && army.targetRegionRow !== null) {
    const city = session.cities.find((c) => c.playerId === army.targetPlayerId && c.regionCol === army.targetRegionCol && c.regionRow === army.targetRegionRow);
    if (city) return { col: city.col, row: city.row };
  }
  const anchorUnit = armyMembersOf(session, army.id)[0];
  const targetCities = session.cities.filter((c) => c.playerId === army.targetPlayerId);
  if (!targetCities.length) return null;
  const nearest = anchorUnit
    ? targetCities.slice().sort((a, b) => session.hexDistance(anchorUnit.col, anchorUnit.row, a.col, a.row) - session.hexDistance(anchorUnit.col, anchorUnit.row, b.col, b.row))[0]
    : targetCities[0];
  return { col: nearest.col, row: nearest.row };
}

/** Требуется ли переброска флотом ИМЕННО этому юниту до цели армии — по прямому уточнению (живая
 * правка на этом же заходе): в отличие от `WarPlan.requiresNavy` (посчитан один раз при создании
 * плана, от ПЕРВОГО своего города — годится для довоенного стягивания, когда все обычно ещё дома),
 * активная армия воюет много ходов подряд, и часть её членов к этому моменту уже вполне может стоять
 * на нужном берегу (переброшена раньше/родилась в приморском городе рядом) — считать по устаревшему
 * флагу заставило бы уже высадившегося юнита снова лезть на корабль. Проверяется заново каждый раз,
 * от ТЕКУЩЕЙ позиции именно этого юнита (`landComponentOf`, тот же BFS-примитив связности по суше). */
function tryStageForArmy(session: GameSession, playerId: number, unit: UnitInstance, army: Army, reporter: Reporter): boolean {
  const target = armyTargetHex(session, army);
  const needsNavy = target !== null && (unit.category === "assault" || unit.category === "mobile") && !landComponentOf(session, unit.col, unit.row).has(`${target.col},${target.row}`);
  return stageUnitTowardTarget(session, playerId, unit, target, needsNavy, reporter, `армия «${ARMY_TEMPLATE_LABEL[army.template]}» требует переброски`);
}

// === Флоты (§15.9а, по прямому запросу — «держать корабли парами», «флот после переброски не
// бездействует») ===================================================================================

/** Пары кораблей (по прямому запросу — «держать корабли парами, так как один корабль не уничтожит
 * другой без второго») — вызывается раз за ход: чистит погибших из существующих флотов, доукомплектовывает
 * овдовевший (1 корабль) флот ближайшим свободным, из оставшихся свободных кораблей формирует новые
 * пары. Свободный — без пассажира и ещё не в составе никакого флота. */
function pairFreeShipsIntoFleets(session: GameSession, playerId: number) {
  for (const fleet of session.fleets) {
    if (fleet.playerId !== playerId) continue;
    fleet.shipUnitIds = fleet.shipUnitIds.filter((id) => session.units.some((u) => u.id === id));
  }
  session.fleets = session.fleets.filter((f) => f.playerId !== playerId || f.shipUnitIds.length > 0);

  const inFleet = new Set(session.fleets.filter((f) => f.playerId === playerId).flatMap((f) => f.shipUnitIds));
  const freeShips = session.units.filter(
    (u) => u.playerId === playerId && u.category === "ship" && !inFleet.has(u.id) && !session.units.some((r) => r.category !== "ship" && r.col === u.col && r.row === u.row)
  );

  for (const fleet of session.fleets.filter((f) => f.playerId === playerId && f.shipUnitIds.length === 1)) {
    const anchor = session.units.find((u) => u.id === fleet.shipUnitIds[0]);
    if (!anchor) continue;
    const nearestIdx = freeShips
      .map((s, i) => ({ i, dist: session.hexDistance(anchor.col, anchor.row, s.col, s.row) }))
      .sort((a, b) => a.dist - b.dist)[0]?.i;
    if (nearestIdx === undefined) continue;
    fleet.shipUnitIds.push(freeShips[nearestIdx].id);
    freeShips.splice(nearestIdx, 1);
  }
  while (freeShips.length >= 2) {
    const a = freeShips.shift()!;
    const b = freeShips.shift()!;
    session.fleets.push({ id: session.nextFleetId++, playerId, shipUnitIds: [a.id, b.id], createdAtCycle: session.cyclesElapsed });
  }
}

/** Регион-«театр» флота (по прямому уточнению — «важно чтоб корабли не бегали по карте за другим
 * флотом, важно придерживаться региона войны и плана военной кампании, иначе игрок будет одним флотом
 * гонять другие корабли как можно дольше, лишь бы не допустить набегов») — регион цели ближайшей (по
 * позиции кораблей флота) наступательной армии ЭТОГО игрока; нет ни одной наступательной армии с
 * заданной целью вовсе — `null` (флот тогда просто бездействует по этой логике, обычный generic-марш
 * `warFrontHex` ниже подхватывает как раньше). */
function fleetTheaterRegion(session: GameSession, fleet: Fleet): { rc: number; rr: number; targetPlayerId: number } | null {
  const candidates = session.armies.filter((a) => a.playerId === fleet.playerId && a.targetPlayerId !== null && a.targetRegionCol !== null && a.targetRegionRow !== null);
  if (!candidates.length) return null;
  const anchor = session.units.find((u) => fleet.shipUnitIds.includes(u.id));
  let best = candidates[0];
  if (anchor) {
    let bestDist = Infinity;
    for (const a of candidates) {
      const hex = armyTargetHex(session, a);
      const dist = hex ? session.hexDistance(anchor.col, anchor.row, hex.col, hex.row) : Infinity;
      if (dist < bestDist) {
        bestDist = dist;
        best = a;
      }
    }
  }
  return { rc: best.targetRegionCol!, rr: best.targetRegionRow!, targetPlayerId: best.targetPlayerId! };
}

/** Цель свободного (без пассажира) корабля флота (по прямому уточнению — приоритет: поддержка своей
 * осады → охота на вражеский флот, ТОЛЬКО если он уже в этом же регионе → набег/сжигание прибрежного
 * города цели) — всё СТРОГО в пределах региона-театра (см. doc выше), никогда за его пределами. */
function fleetTargetHex(session: GameSession, fleet: Fleet): { col: number; row: number } | null {
  const theater = fleetTheaterRegion(session, fleet);
  if (!theater) return null;
  const inTheater = (col: number, row: number) => Math.floor(col / REGION_SIZE_X) === theater.rc && Math.floor(row / REGION_SIZE_Y) === theater.rr;

  const siegedCity = session.cities.find((c) => c.playerId === theater.targetPlayerId && inTheater(c.col, c.row) && session.citySiegeBuffer.has(c.id));
  if (siegedCity) return { col: siegedCity.col, row: siegedCity.row };

  const enemyShip = session.units.find((u) => u.playerId === theater.targetPlayerId && u.category === "ship" && inTheater(u.col, u.row));
  if (enemyShip) return { col: enemyShip.col, row: enemyShip.row };

  const raidCity = session.cities.find((c) => c.playerId === theater.targetPlayerId && inTheater(c.col, c.row));
  if (raidCity) return { col: raidCity.col, row: raidCity.row };

  return null;
}

function considerWarDeclaration(session: GameSession, playerId: number, reporter: Reporter) {
  const target = considerWarTargets(session, playerId);
  if (!target) return;
  const payload = { targetId: target.targetId };
  const result = session.dispatch("declareWar", playerId, payload);
  if (result.ok) {
    const targetName = session.players.find((p) => p.id === target.targetId)?.name ?? `игрок ${target.targetId}`;
    reporter.step({ action: "declareWar", payload, targetKind: "player", targetPlayerId: target.targetId, label: `Объявил войну игроку ${targetName} (${target.reason}).` });
  }
}

/** Сумма денег, уже обещанных в СВОИХ ЖЕ ещё не решённых предложениях (`offerMoney`) — по прямому
 * запросу, живой баг-репорт: «предложил мир за 7💰, но к моменту, когда получатель решил принять,
 * этих денег уже не осталось — нужно учитывать траты, прежде чем предлагать» (сервер и так атомарно
 * отказывает в приёме, если денег не хватает, см. GameSession.proposalUnaffordableReason — но САМ
 * бот продолжает как ни в чём не бывало тратить деньги на СЛЕДУЮЩИХ ходах, пока получатель тянет с
 * ответом, и обещание тихо перестаёт быть выполнимым). Используется, чтобы бот не пускал уже
 * обещанные деньги на ДОБРОВОЛЬНЫЕ покупки — не трогает списание цены карт/зданий (то, что бот и так
 * обязан заплатить ради уже начатого приоритета, см. §15.4) — только «Мобилизацию» и биржевую
 * докупку про запас (marketPass) ниже, где трата необязательна и её можно просто пропустить в этот
 * заход. */
function reservedMoneyForPendingProposals(session: GameSession, playerId: number): number {
  let reserved = 0;
  for (const p of session.pendingProposals) {
    if (p.from !== playerId) continue;
    for (const term of p.terms) if (term.kind === "offerMoney") reserved += term.amount;
  }
  return reserved;
}

const PEACE_TRUCE_DURATION = 6; // «перемирие на 6 ходов» (по прямому запросу)
/** «Зависшая война» (по прямому запросу §4.1/4.2) — при этом значении `peaceOfferStreak` включается
 * платное дипломатическое давление на третьих игроков (см. `considerDiplomaticPressure`) — раньше
 * наблюдаемого живого случая зависания на ~20 циклов подряд (реальный сейв, лог решений), чтобы
 * эскалация срабатывала заметно раньше стагнации, а не после неё. */
const PEACE_ESCALATION_PRESSURE_STREAK = 8;
/** Следующая ступень (по прямому запросу) — мирное предложение реально бесполезно уже очень долго:
 * вместо ежецикловой мольбы (спам без результата) — throttle раз в `PEACE_FREEZE_THROTTLE_CYCLES`. */
const PEACE_ESCALATION_FREEZE_STREAK = 18;
const PEACE_FREEZE_THROTTLE_CYCLES = 4;
/** «Мир победителя» (по прямому запросу §4.3) — противник ослаблен до этой доли моей военной мощи. */
const DOMINANT_WAR_RATIO = 0.4;

/** Ищет мира (по прямому запросу): «если кончились деньги» или «если перевес сил перешёл
 * противнику» — предлагает все деньги ИЛИ (если денег нет) самый большой запас склада, за перемирие
 * на 6 циклов. «Достигнув цели — предлагает мир» — цель определяется захватом территории (этап
 * движения войск, ещё не реализован) — пока не проверяется. */
function considerPeaceOffers(session: GameSession, playerId: number, reporter: Reporter) {
  for (const p of session.players) {
    if (p.id === playerId) continue;
    const streakKey = `${playerId}:${p.id}`;
    if (!session.relationOf(playerId, p.id).war) {
      // Мир (снова) наступил — счётчик «зависшей войны» (§4.1) больше не актуален, следующая война с
      // тем же игроком должна начинать эскалацию с нуля, не наследовать старую.
      if (session.peaceOfferStreak[streakKey] !== undefined) {
        delete session.peaceOfferStreak[streakKey];
        delete session.peaceOfferStreakCycle[streakKey];
      }
      continue;
    }
    // Минимальная длительность войны (по прямому запросу — «AI не присылает предложения мира первые 3
    // хода [после начала войны или после отказа от мира]») — session.relationOf(...).noPeaceBeforeCycle,
    // см. GameSession.declareWar/resolveProposal.
    const noPeaceBeforeCycle = session.relationOf(playerId, p.id).noPeaceBeforeCycle;
    if (noPeaceBeforeCycle !== undefined && session.cyclesElapsed < noPeaceBeforeCycle) continue;
    const myUnits = countUnitsOf(session, playerId);
    const theirUnits = countUnitsOf(session, p.id);
    const myMoney = session.money[playerId];
    const outOfMoney = myMoney <= 0;
    const outmatched = myUnits < theirUnits;

    // «Мир победителя» (по прямому запросу §4.3) — я явно доминирую (противник ослаблен ниже
    // DOMINANT_WAR_RATIO моей военной мощи) И противник САМ не предлагал мир мне в последние 3 цикла
    // (нет его предложения с условием "peace" в очереди ко мне) — вместо обычного безвозмездного
    // предложения (веткой ниже, рассчитанной на МОЮ слабость) отправляю мир С ТРЕБОВАНИЕМ, тем же
    // лимитом `valueOfWar`, что и обычная компенсация — просто теперь я требую, а не плачу.
    const theirPower = militaryPower(session, p.id);
    const myPower = militaryPower(session, playerId);
    const dominant = myPower > 0 && theirPower <= myPower * DOMINANT_WAR_RATIO;
    const theyOfferedPeaceRecently = session.pendingProposals.some((pr) => pr.from === p.id && pr.to === playerId && pr.terms.some((t) => t.kind === "peace"));
    if (dominant && !theyOfferedPeaceRecently && !wasAttemptedRecently(session, playerId, p.id, "dominantPeace")) {
      const demand = Math.max(1, Math.round(valueOfWar(session, playerId, p.id)));
      const terms: ProposalTerm[] = [{ kind: "peace", duration: PEACE_TRUCE_DURATION }, { kind: "demandMoney", amount: demand }];
      const text = `Предложил мир игроку ${p.name} на своих условиях (${demand}💰 контрибуции) — явное военное превосходство.`;
      if (sendScenarioProposal(session, playerId, p.id, terms, "dominantPeace", reporter, text)) return;
      continue;
    }

    if (!outOfMoney && !outmatched) continue;

    // «Зависшая война» (по прямому запросу §4.1) — считается РАЗ за цикл (эта функция может
    // вызываться несколько раз за один ход, тот же guard-цикл, что и у considerWarPlan).
    if (session.peaceOfferStreakCycle[streakKey] !== session.cyclesElapsed) {
      session.peaceOfferStreak[streakKey] = (session.peaceOfferStreak[streakKey] ?? 0) + 1;
      session.peaceOfferStreakCycle[streakKey] = session.cyclesElapsed;
    }
    const streak = session.peaceOfferStreak[streakKey] ?? 0;
    // «Заморозка» (§4.2, последняя ступень) — мир так и не удаётся уже очень долго: вместо спама
    // одним и тем же предложением каждый цикл — throttle. Не блокирует «Мир победителя» выше (та
    // ветка уже вернулась/continue'нула раньше) и не блокирует переход к платному давлению ниже (та
    // эскалация — отдельное действие за ход, эта функция лишь решает, слать ли САМО предложение мира).
    if (streak >= PEACE_ESCALATION_FREEZE_STREAK && streak % PEACE_FREEZE_THROTTLE_CYCLES !== 0) continue;

    // По прямому запросу — живой баг-репорт: «нет действия переотправки предложения мира с отменой
    // предыдущего» — раньше уже отправленное, но ещё НЕ решённое получателем предложение блокировало
    // ЛЮБУЮ новую попытку до тех пор, пока получатель сам его не отклонит (мог тянуть с ответом сколь
    // угодно долго, а условия — деньги/баланс сил — у отправителя тем временем менялись). Теперь
    // старое предложение ЭТОМУ ЖЕ игроку сначала отзывается (`GameSession.cancelProposal`, новое
    // действие), а взамен сразу отправляется новое, актуальное — но только если условия РЕАЛЬНО
    // изменились (сумма денег/ресурса), иначе отзыв-и-повтор ничего не меняет и просто спамит логом.
    const pendingIdx = session.pendingProposals.findIndex((pr) => pr.from === playerId && pr.to === p.id);
    const pending = pendingIdx !== -1 ? session.pendingProposals[pendingIdx] : null;

    // Сумма предложения ограничена ЦЕННОСТЬЮ мира (п.9, `valueOfWar` — та же разница военной мощи,
    // что и «стоит ли воевать») — по прямому запросу: «отдача всего золота за мир — много, лучше все
    // золото, но не больше, чем ценность разницы в силах военных» — раньше предлагались ВСЕ деньги
    // (или весь самый большой запас склада) безусловно, даже когда перевес противника был небольшим
    // и та же самая цена мира была бы куда дешевле; хотя бы 1 единица — токен всё равно предлагается,
    // даже если военный перевес почти нулевой (сам факт предложения мира важнее символической суммы).
    const warGap = Math.max(1, Math.round(valueOfWar(session, playerId, p.id)));
    const terms: ProposalTerm[] = [{ kind: "peace", duration: PEACE_TRUCE_DURATION }];
    if (myMoney > 0) {
      terms.push({ kind: "offerMoney", amount: Math.min(myMoney, warGap) });
    } else {
      const stock = (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(([, q]) => (q ?? 0) > 0).sort((a, b) => b[1] - a[1]);
      if (stock.length) {
        const [resource, qty] = stock[0];
        const capByValue = Math.max(1, Math.round(warGap / valueOfResource(session, resource)));
        terms.push({ kind: "giveResource", resource, qty: Math.min(qty, capByValue) });
      }
    }
    // Условия не изменились с прошлого (ещё не решённого) предложения — отзывать и слать заново
    // незачем, тот же текст только спамил бы лог одним и тем же по кругу каждый ход.
    if (pending && JSON.stringify(pending.terms) === JSON.stringify(terms)) continue;
    // [ИСПРАВЛЕНО, живой баг-репорт — «наблюдается зацикливание дипломатических предложений»] — если
    // получатель предложение ОТКЛОНИЛ (не просто ещё не ответил), `pending` уже не находится, и
    // проверка выше (сравнение терминов с ещё висящим предложением) НЕ срабатывает вовсе — раньше
    // здесь не было вообще никакой памяти о недавнем отказе, и почти идентичное предложение мира
    // уходило заново на СЛЕДУЮЩИЙ ЖЕ ход, пока ситуация (деньги/перевес) не менялась — то есть
    // потенциально каждый ход подряд. Тот же кулдаун, что и у остальных сценариев дипломатии.
    if (!pending && wasAttemptedRecently(session, playerId, p.id, "peace")) continue;

    if (pending) {
      const cancelResult = session.dispatch("cancelProposal", playerId, { id: pending.id });
      if (!cancelResult.ok) continue;
      reporter.step({
        action: "cancelProposal",
        payload: { id: pending.id },
        targetKind: "proposal",
        targetPlayerId: p.id,
        label: `Отозвал прежнее предложение мира игроку ${p.name} — условия изменились.`,
      });
    }

    const payload = { to: p.id, terms, ultimatum: false, scenarioKey: "peace" };
    const result = session.dispatch("sendProposal", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "sendProposal",
        payload,
        targetKind: "proposal",
        targetPlayerId: p.id,
        label: `${pending ? "Переотправил" : "Предложил"} мир игроку ${p.name} (${outOfMoney ? "кончились деньги" : "перевес сил у противника"}) — перемирие на ${PEACE_TRUCE_DURATION} циклов.`,
      });
    }
  }
}

// === Инициатива в дипломатии — бот САМ предлагает соглашения (по прямому запросу) ================
// «Прописываем алгоритм, который будет заключать соглашения между игроком и компьютерными игроками
// и между компьютерными игроками» — 5 сценариев дословно по прямому запросу, ниже в том же порядке.
// Не более ОДНОГО отправленного предложения за ход (тот же принцип, что у considerWarDeclaration —
// не заваливаем всех сразу) — проверяются по очереди, первый применимый выигрывает.

const AGREEMENT_LABELS: Record<Agreement, string> = {
  openBorders: "Открытые границы",
  vassalage: "Вассалитет",
  mutualDefense: "Совместную оборону",
  tradeUnion: "Торговый союз",
  scienceCoop: "Научное сотрудничество",
  union: "Союз",
};

/** Голое предложение одного соглашения, без встречных условий — сумма подбирается не здесь: обе
 * стороны судят по одной и той же `proposalNetValueFor` (см. shouldAcceptProposal), так что если
 * сделка того стоит по системе ценности, её примут и без довеска. Не шлёт повторно, если этому же
 * игроку уже отправлено неотвеченное предложение. */
// === Отношения AI — приоритетный список дипломатии (по прямому запросу) — инфраструктура =========
// «Дипломатическое общение сводится только к силовым инструментам, если отношения плохие» — общий
// порог, ниже которого КООПЕРАТИВНАЯ дипломатия (соглашения/обещания/просьбы) не предлагается вовсе
// (силовые инструменты — дань/война — им не подчиняются, у них своя логика).
const PEACEFUL_DIPLOMACY_MIN_RELATION = 20;
function isPeacefulDiplomacyViable(session: GameSession, playerId: number, targetId: number): boolean {
  return session.relationScoreOf(playerId, targetId) >= PEACEFUL_DIPLOMACY_MIN_RELATION;
}

/** Кулдаун одной и той же дипломатической просьбы одному и тому же адресату (по прямому запросу —
 * «нет смысла просить второй раз, если отказали», «рассылка не каждый ход, пока условие не
 * изменилось») — тот же порядок величины, что и «не чаще раза в 6 циклов» у требования дани (п.3
 * приоритетного списка) — единая память на все виды запросов, см. `session.diplomacyAttemptMemory`. */
const DIPLOMACY_ATTEMPT_COOLDOWN_CYCLES = 6;
function diplomacyAttemptKey(from: number, to: number, scenarioKey: string): string {
  return `${from}:${to}:${scenarioKey}`;
}
function wasAttemptedRecently(session: GameSession, from: number, to: number, scenarioKey: string): boolean {
  const last = session.diplomacyAttemptMemory[diplomacyAttemptKey(from, to, scenarioKey)];
  return last !== undefined && session.cyclesElapsed - last < DIPLOMACY_ATTEMPT_COOLDOWN_CYCLES;
}
// Штамп попытки — см. GameSession.sendProposal(scenarioKey) — не здесь: сайд-эффект в bot.ts не
// долетал бы до настоящей сессии, см. doc у sendScenarioProposal ниже.

/** Небольшой фиксированный подарок-подсластитель к дипломатическому запросу (по прямому запросу —
 * «разрешить делать встречные предложения в виде денег или ресурсов за его взятие») — добавляется
 * САМИМ просящим, если отношения с адресатом ещё не «хорошие» (см. RelationTier) — усиливает шанс
 * принятия через общий `proposalNetValueFor`, а не отдельная логика согласия под каждый вид запроса.
 * Пусто, если денег и так не хватает — не пытается занять, просто идёт без подарка. */
const DIPLOMACY_SWEETENER_AMOUNT = 5;
function diplomacySweetenerFor(session: GameSession, playerId: number, targetId: number): ProposalTerm[] {
  if (session.relationScoreOf(playerId, targetId) >= 60) return [];
  if (session.money[playerId] < DIPLOMACY_SWEETENER_AMOUNT) return [];
  return [{ kind: "offerMoney", amount: DIPLOMACY_SWEETENER_AMOUNT }];
}

/** Общая отправка «одноразового» дипломатического запроса (обещание/дань/etc, не голое соглашение —
 * для тех см. proposeAgreement) — де-дуп по уже висящему предложению И по кулдауну недавней попытки
 * (см. выше), помечает попытку СРАЗУ (успех ли, отказ dispatch — неважно: тот же структурный отказ,
 * например нет контакта, повторится и на следующий ход, спамить смысла нет). */
function sendScenarioProposal(
  session: GameSession,
  playerId: number,
  targetId: number,
  terms: ProposalTerm[],
  scenarioKey: string,
  reporter: Reporter,
  label: string,
  ultimatum = false
): boolean {
  if (session.pendingProposals.some((pr) => pr.from === playerId && pr.to === targetId)) return false;
  if (wasAttemptedRecently(session, playerId, targetId, scenarioKey)) return false;
  // `scenarioKey` идёт В ПРЕДЛОЖЕНИИ (не отдельным сайд-эффектом здесь) — планирование хода
  // (computeAiTurnPlan) выполняется на ОДНОРАЗОВОМ КЛОНЕ сессии, который выбрасывается сразу после
  // возврата плана; штамп памяти попыток должен произойти ВНУТРИ реального dispatch, который
  // ПОВТОРНО прогоняется на настоящей сессии (см. GameSession.sendProposal, её doc) — иначе, как и
  // было до этого исправления, память попыток жила только на клоне и никогда не долетала до
  // настоящей игры (проверено полным AI-vs-AI прогоном, см. ЦИВА-ЖУРНАЛ).
  // `ultimatum` (по прямому запросу, «требование дани») — необязательный, по умолчанию `false` (все
  // существующие вызовы не передают его и ведут себя как раньше); `true` — отказ получателя
  // автоматически объявляет войну от имени ЭТОГО игрока (см. GameSession.resolveProposal).
  const payload = { to: targetId, terms, ultimatum, scenarioKey };
  const result = session.dispatch("sendProposal", playerId, payload);
  if (!result.ok) return false;
  reporter.step({ action: "sendProposal", payload, targetKind: "proposal", targetPlayerId: targetId, label });
  return true;
}

/** `extraTerm` (по прямому запросу — асимметрия выгоды торгового союза, см. tradeUnionGains) —
 * необязательное дополнительное условие компенсации в ТОМ ЖЕ предложении, не отдельным сообщением;
 * остальные 4 сценария вызывают без него, поведение для них не меняется. */
/** [ИСПРАВЛЕНО, живой баг-репорт — «наблюдается зацикливание дипломатических предложений, отклонение
 * должно закрывать повторное предложение»] — раньше единственным гейтом было «нет уже висящего
 * предложения этому же игроку» (`pendingProposals.some`), а это условие снова становится ложным В ТОТ
 * ЖЕ МОМЕНТ, когда предложение решается (принято или ОТКЛОНЕНО) — никакой памяти о недавнем отказе не
 * было вовсе, в отличие от `sendScenarioProposal` (обещания/дань/требования и т.п.), которая ВСЕГДА
 * сверяется с `wasAttemptedRecently` и штампует попытку через `scenarioKey`. `proposeAgreement`
 * обслуживает почти все 7 сценариев `considerDiplomacyDeals` (оборонный союз, альянс, торговый союз,
 * научное сотрудничество, совместная война, открытые границы) — без этой памяти отклонённое
 * соглашение немедленно становилось кандидатом для точно такого же предложения на следующий же ход,
 * до бесконечности. Теперь — тот же кулдаун (`DIPLOMACY_ATTEMPT_COOLDOWN_CYCLES=6`), ключ —
 * `agreement:<тип>` (по ТИПУ соглашения, не по вызвавшему сценарию — предлагать тот же «Оборонный
 * союз» тому же игроку слишком часто спамно независимо от повода). */
function proposeAgreement(session: GameSession, playerId: number, targetId: number, agreement: Agreement, reporter: Reporter, reason: string, extraTerm?: ProposalTerm): boolean {
  // Отношения AI — плохие отношения оставляют только силовые инструменты (по прямому запросу) —
  // кооперативное соглашение (тем более голое) не предлагается вовсе ниже этого порога.
  if (!isPeacefulDiplomacyViable(session, playerId, targetId)) return false;
  if (session.pendingProposals.some((pr) => pr.from === playerId && pr.to === targetId)) return false;
  const scenarioKey = `agreement:${agreement}`;
  if (wasAttemptedRecently(session, playerId, targetId, scenarioKey)) return false;
  const terms: ProposalTerm[] = [{ kind: "agreement", agreement }, ...(extraTerm ? [extraTerm] : [])];
  const payload = { to: targetId, terms, ultimatum: false, scenarioKey };
  const result = session.dispatch("sendProposal", playerId, payload);
  if (!result.ok) return false;
  const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
  reporter.step({
    action: "sendProposal",
    payload,
    targetKind: "proposal",
    targetPlayerId: targetId,
    label: `Предложил «${AGREEMENT_LABELS[agreement]}» игроку ${targetName} (${reason}).`,
  });
  return true;
}

/** 8.1 «Заключено перемирие после войны — нужно укрепить оборону оборонительным союзом»: среди
 * недавних противников (действующий truceUntilCycle — война закончилась перемирием, не полным
 * миром, угроза может вернуться) берёт самого сильного как «угрозу»; союзником зовёт сильнейшего из
 * приграничных соседей, который ещё не в Совместной обороне с ботом и не сам эта угроза. Не
 * пытается, если пакт по системе ценности (п.15) вообще ничего не стоит (искать не от кого). */
function considerDefensePactAfterTruce(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const exEnemies = session.players.filter((p) => {
    if (p.id === playerId) return false;
    const rel = session.relationOf(playerId, p.id);
    return !rel.war && rel.truceUntilCycle !== undefined && session.cyclesElapsed < rel.truceUntilCycle;
  });
  if (!exEnemies.length) return false;
  const threat = exEnemies.sort((a, b) => militaryPower(session, b.id) - militaryPower(session, a.id))[0];
  if (valueOfDefensivePact(session, playerId, threat.id) <= 0) return false;
  const candidates = neighborPlayerIds(session, playerId).filter(
    (id) =>
      id !== threat.id &&
      id !== session.warPlans[playerId]?.targetId &&
      !session.relationOf(playerId, id).war &&
      !session.relationOf(playerId, id).agreements.has("mutualDefense")
  );
  if (!candidates.length) return false;
  const partner = candidates.sort((a, b) => militaryPower(session, b) - militaryPower(session, a))[0];
  return proposeAgreement(session, playerId, partner, "mutualDefense", reporter, `укрепить оборону после перемирия с игроком ${threat.name}`);
}

/** 8.2 «Один игрок сильнее войсками, чем ВСЕ остальные вместе — слабым следует объединиться»: если
 * бот не сам этот гегемон, ищет другого «слабого» (не гегемона) соседа для Совместной обороны. */
function considerBalanceOfPowerAlliance(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const powers = session.players.map((p) => ({ id: p.id, power: militaryPower(session, p.id) }));
  const strongest = powers.slice().sort((a, b) => b.power - a.power)[0];
  if (!strongest || strongest.id === playerId) return false;
  const sumOthers = powers.filter((p) => p.id !== strongest.id).reduce((s, p) => s + p.power, 0);
  if (strongest.power <= sumOthers) return false;
  const candidates = powers.filter(
    (p) =>
      p.id !== playerId &&
      p.id !== strongest.id &&
      p.id !== session.warPlans[playerId]?.targetId &&
      !session.relationOf(playerId, p.id).war &&
      !session.relationOf(playerId, p.id).agreements.has("mutualDefense")
  );
  if (!candidates.length) return false;
  const strongestPlayer = session.players.find((p) => p.id === strongest.id)!;
  return proposeAgreement(session, playerId, candidates[0].id, "mutualDefense", reporter, `объединиться против гегемона ${strongestPlayer.name}`);
}

/** 8.3 «Игроки имеют совместную торговую сеть — нужно заключить торговый договор»: любой другой
 * игрок, чей город уже связан с одним из своих торговым путём (`session.tradeRoutes` — сама сеть уже
 * существует физически), но Торгового союза с ним ещё нет. */
function considerTradeUnionForSharedNetwork(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const myCityIds = new Set(myCities(session, playerId).map((c) => c.id));
  const partners = new Set<number>();
  for (const r of session.tradeRoutes) {
    const from = session.cities.find((c) => c.id === r.fromCityId);
    const to = session.cities.find((c) => c.id === r.toCityId);
    if (!from || !to) continue;
    if (myCityIds.has(from.id) && to.playerId !== playerId) partners.add(to.playerId);
    if (myCityIds.has(to.id) && from.playerId !== playerId) partners.add(from.playerId);
  }
  for (const partnerId of partners) {
    const rel = session.relationOf(playerId, partnerId);
    if (rel.war || rel.agreements.has("tradeUnion")) continue;
    // Отношения AI — асимметрия выгоды (по прямому запросу, см. tradeUnionGains): если партнёр
    // выигрывает от объединения сетей БОЛЬШЕ меня — прикладываю требование денег компенсацией в ТОМ
    // ЖЕ предложении (снимает и гейт «без доп условий» ниже — теперь предложение НЕ голое).
    const gains = tradeUnionGains(session, playerId, partnerId);
    const hasCompensation = !!gains && gains.theirGain > gains.myGain;
    const extraTerm: ProposalTerm | undefined = hasCompensation
      ? { kind: "demandMoney", amount: Math.max(1, Math.round(gains!.theirGain - gains!.myGain)) }
      : undefined;
    // Отношения AI — гейт (см. relationAllowsAgreement): «голое» предложение (без компенсации) не
    // суётся тем, с кем плохие отношения и хуже; с компенсацией — гейт для tradeUnion не действует.
    if (!relationAllowsAgreement(session, playerId, partnerId, "tradeUnion", hasCompensation)) continue;
    if (proposeAgreement(session, playerId, partnerId, "tradeUnion", reporter, "уже связаны общей торговой сетью", extraTerm)) return true;
  }
  return false;
}

/** 8.4 «Игрок хочет получить технологию за счёт научного сотрудничества, раз не хватает ресурсов на
 * собственную науку»: отстаёт числом исследованных технологий от кого-то из остальных — предлагает
 * Научное сотрудничество самому продвинутому (реально расшаривает технологии, см.
 * GameSession.grantScienceCoopTechSharing). */
function considerScienceCoopWhenBehind(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const myCount = session.researchedTechs[playerId]?.size ?? 0;
  const candidates = session.players
    .filter(
      (p) =>
        p.id !== playerId &&
        !session.relationOf(playerId, p.id).war &&
        !session.relationOf(playerId, p.id).agreements.has("scienceCoop") &&
        (session.researchedTechs[p.id]?.size ?? 0) > myCount &&
        // Отношения AI — гейт: «предлагает сотрудничество только тем, с кем отношения выше нейтральных».
        relationAllowsAgreement(session, playerId, p.id, "scienceCoop", false)
    )
    .sort((a, b) => (session.researchedTechs[b.id]?.size ?? 0) - (session.researchedTechs[a.id]?.size ?? 0));
  if (!candidates.length) return false;
  return proposeAgreement(session, playerId, candidates[0].id, "scienceCoop", reporter, "отстаёт в науке — получить технологии через сотрудничество");
}

/** 8.5 «Планируется война — нужен союзник, чтобы напасть на врага вдвоём»: переиспользует
 * considerWarTargets (та же цель, что бот и так собрался бы атаковать сам) и ищет ДРУГОГО игрока,
 * тоже граничащего с этой целью, для наступательного «Союза» (см. GameSession.cascadeAllianceWar —
 * в отличие от Совместной обороны, «Союз» втягивает партнёра в войну, когда войну объявляет САМ
 * БОТ, а не когда на партнёра напали). */
function considerJointWarAlliance(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const target = considerWarTargets(session, playerId);
  if (!target) return false;
  const candidates = session.players.filter(
    (p) =>
      p.id !== playerId &&
      p.id !== target.targetId &&
      !session.relationOf(playerId, p.id).war &&
      !session.relationOf(playerId, p.id).agreements.has("union") &&
      neighborPlayerIds(session, p.id).includes(target.targetId)
  );
  if (!candidates.length) return false;
  const targetPlayer = session.players.find((p) => p.id === target.targetId)!;
  return proposeAgreement(session, playerId, candidates[0].id, "union", reporter, `совместное нападение на игрока ${targetPlayer.name}`);
}

/** По прямому запросу — «нужно добавить действие: открытые границы предлагают игроки всем соседям, с
 * которыми не планируют войны и отношения нейтральные и лучше» — первый сосед БЕЗ этого соглашения, с
 * которым нет войны, кто НЕ является целью моего «Плана войны» (`session.warPlans[playerId]` —
 * предлагать открыть границы тому, кого сам собираюсь атаковать, бессмысленно), и моё отношение к
 * нему «нейтральные» и выше (`relationScoreOf` >= 40 — та же граница, что и `TRIBUTE_RELATION_MIN`:
 * ниже неё дипломатия и так уступает силовым инструментам, см. `isPeacefulDiplomacyViable`/
 * `relationAllowsAgreement`, которые `proposeAgreement` и так проверяет сам). */
function considerOpenBorders(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const plan = session.warPlans[playerId];
  const canOffer = (targetId: number) => {
    const rel = session.relationOf(playerId, targetId);
    if (rel.war || rel.agreements.has("openBorders")) return false;
    if (plan && plan.targetId === targetId) return false;
    return session.relationScoreOf(playerId, targetId) >= TRIBUTE_RELATION_MIN;
  };

  // ПРОМЕЖУТОЧНАЯ ЦЕЛЬ ДИПЛОМАТИИ (по прямому уточнению — «план войны должен предусматривать
  // доступность региона, включая открытые границы; открытых границ можно и требовать или купить, так
  // что цели дипломатии могут быть промежуточными»): если цель экспансии существует, но отбрасывается
  // ИМЕННО из-за недостижимости (`findExpansionTarget` без фильтра достижимости возвращает её, а с
  // фильтром — нет или другую), то проход через её территорию и есть ближайшая задача — предлагаем
  // «Открытые границы» ЕЙ, причём сразу С ДОПЛАТОЙ (`diplomacySweetenerFor` — «купить проход»), а не
  // голым соглашением, чтобы повысить шанс согласия. Такое предложение идёт ПЕРЕД обычным перебором
  // соседей — это прямой шаг к выполнению плана, а не просто дружественный жест.
  const blocked = findExpansionTarget(session, playerId, true);
  const reachableNow = findExpansionTarget(session, playerId);
  if (blocked && blocked.targetId !== reachableNow?.targetId && canOffer(blocked.targetId)) {
    const extra = diplomacySweetenerFor(session, playerId, blocked.targetId)[0];
    if (proposeAgreement(session, playerId, blocked.targetId, "openBorders", reporter, "нужен проход к региону, который планируется занять", extra)) return true;
  }

  for (const targetId of neighborPlayerIds(session, playerId)) {
    if (!canOffer(targetId)) continue;
    if (proposeAgreement(session, playerId, targetId, "openBorders", reporter, "нейтральные отношения и лучше, войны не планируется")) return true;
  }
  return false;
}

/** По прямому уточнению — «Открытые границы отменяются с тем, кто воюет с союзником (хорошие
 * отношения и друг), если отношения с этим игроком хуже»: для КАЖДОГО, с кем у меня уже действуют
 * «Открытые границы», если он СЕЙЧАС воюет с кем-то третьим, к кому моё отношение ЛУЧШЕ, чем к нему
 * самому — соглашение разрывается. «Друг»/«лучше» здесь не отдельный жёсткий тир — сравнение прямое
 * (`relationScoreOf`), по прямому уточнению не завязано на конкретный порог. */
function considerRevokeOpenBordersOverFriendWar(session: GameSession, playerId: number, reporter: Reporter): boolean {
  for (const p of session.players) {
    if (p.id === playerId || session.eliminatedPlayers.has(p.id)) continue;
    if (!session.relationOf(playerId, p.id).agreements.has("openBorders")) continue;
    const myScoreOfP = session.relationScoreOf(playerId, p.id);
    const betterFriendAtWar = session.players.find(
      (f) => f.id !== playerId && f.id !== p.id && session.relationOf(p.id, f.id).war && session.relationScoreOf(playerId, f.id) > myScoreOfP
    );
    if (!betterFriendAtWar) continue;
    const payload = { otherId: p.id, agreement: "openBorders" as const };
    const result = session.dispatch("breakAgreement", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "breakAgreement",
        payload,
        targetKind: "player",
        targetPlayerId: p.id,
        label: `Разорвал «Открытые границы» с игроком ${p.name} — он воюет с игроком ${betterFriendAtWar.name}, к которому отношение лучше.`,
      });
      return true;
    }
  }
  return false;
}

/** Приоритет 6 из 7 (по прямому запросу — сюда переехали 5 старых сценариев без изменения
 * собственной логики, гейт по отношениям и кулдаун теперь общие через proposeAgreement выше).
 * `considerRevokeOpenBordersOverFriendWar`/`considerOpenBorders` добавлены отдельной правкой —
 * разрыв (защитная реакция) ПЕРЕД остальными, предложение открыть границы (инициатива) ПОСЛЕ. */
// === Отношения AI — приоритетный список из 7 дипломатических действий (по прямому запросу) =======
// Раз в ход, ПЕРВОЕ применимое действие из 7 (в этом порядке) — и только оно, не более одного
// отправленного предложения/действия за ход (тот же принцип, что и у considerDiplomacyDeals выше).
// Каждый сценарий обязан САМ решить, когда включаться (триггер) и когда МОЛЧАТЬ — либо условие
// неприменимо прямо сейчас, либо был недавний отказ (см. wasAttemptedRecently), либо отношения ушли
// в силовую зону (см. isPeacefulDiplomacyViable, не касается силовых пп.3/7).

/** П.1 — просит соседа, чей город тоже примыкает к региону, который бот сам планирует занять
 * следующим (тот же кандидат, что выбрал бы `unclaimedNearbyRegions`/`settlerRegionScore`),
 * пообещать туда не селиться (3 цикла). Вето по разнице регионов и относительная отмена — уже в
 * `shouldAcceptProposal` (см. её doc). */
function considerPromiseNoSettle(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const candidates = unclaimedNearbyRegions(session, playerId);
  if (!candidates.length) return false;
  const owned = new Map<ResourceId, number>();
  const best = candidates.slice().sort((a, b) => settlerRegionScore(session, b.rc, b.rr, owned) - settlerRegionScore(session, a.rc, a.rr, owned))[0];
  for (const targetId of neighborPlayerIds(session, playerId)) {
    if (!isPeacefulDiplomacyViable(session, playerId, targetId)) continue;
    if (!hasCityAdjacentToRegion(session, targetId, best.rc, best.rr)) continue;
    if (wasAttemptedRecently(session, playerId, targetId, "promiseNoSettle")) continue;
    const terms: ProposalTerm[] = [{ kind: "promiseNoSettle", regionCol: best.rc, regionRow: best.rr, duration: 3 }, ...diplomacySweetenerFor(session, playerId, targetId)];
    const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
    if (sendScenarioProposal(session, playerId, targetId, terms, "promiseNoSettle", reporter, `Просит игрока ${targetName} обещать не селиться в регионе (${best.rc},${best.rr}) — сам планирует туда расселиться.`)) return true;
  }
  return false;
}

/** П.2 — сосед накопил ≥2× войск и ≥3 юнита именно в приграничном регионе — просит его обещать не
 * нападать (3 цикла). Отказ → максимальный приоритет обороны (см. facesUnprotectedAggressiveNeighbor
 * в decideUnitCategoryPriority — читает ту же память попыток). Не демандит дань в этом же
 * предложении → всегда добавляет подарок (см. diplomacySweetenerFor). */
function considerPromiseNoAttack(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const myUnits = countUnitsOf(session, playerId);
  const border = borderRegionsOf(session, playerId);
  for (const targetId of neighborPlayerIds(session, playerId)) {
    if (session.relationOf(playerId, targetId).war) continue;
    if (!isPeacefulDiplomacyViable(session, playerId, targetId)) continue;
    const theirUnits = countUnitsOf(session, targetId);
    if (theirUnits < myUnits * WAR_FORCE_RATIO) continue;
    const theirUnitsAtBorder = border.flatMap(({ rc, rr }) => unitsInRegion(session, rc, rr)).filter((u) => u.playerId === targetId).length;
    if (theirUnitsAtBorder < 3) continue;
    if (wasAttemptedRecently(session, playerId, targetId, "promiseNoAttack")) continue;
    const terms: ProposalTerm[] = [{ kind: "promiseNoAttack", duration: 3 }, ...diplomacySweetenerFor(session, playerId, targetId)];
    const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
    if (sendScenarioProposal(session, playerId, targetId, terms, "promiseNoAttack", reporter, `Просит игрока ${targetName} обещать не нападать — накопил войска у границы.`)) return true;
  }
  return false;
}

/** П.3 — силовой инструмент (не гейтится отношениями): у кого войск вдвое+ меньше моих — требует 1
 * ресурс со склада (если есть) или 20% денег (минимум 1). Не чаще раза в 6 циклов на пару — тот же
 * общий кулдаун, что у остальных сценариев (см. wasAttemptedRecently). */
function considerDemandTribute(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const myUnits = countUnitsOf(session, playerId);
  for (const targetId of neighborPlayerIds(session, playerId)) {
    if (session.relationOf(playerId, targetId).war) continue;
    const theirUnits = countUnitsOf(session, targetId);
    if (myUnits < theirUnits * WAR_FORCE_RATIO) continue;
    if (wasAttemptedRecently(session, playerId, targetId, "demandTribute")) continue;
    const stock = (Object.entries(session.warehouse[targetId] ?? {}) as [ResourceId, number][]).find(([, qty]) => (qty ?? 0) > 0);
    const terms: ProposalTerm[] = stock ? [{ kind: "demandResource", resource: stock[0], qty: 1 }] : [{ kind: "demandMoney", amount: Math.max(1, Math.floor(session.money[targetId] * 0.2)) }];
    const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
    if (sendScenarioProposal(session, playerId, targetId, terms, "demandTribute", reporter, `Требует дань у игрока ${targetName} — его войско вдвое слабее.`)) return true;
  }
  return false;
}

/** П.4 — просит соседа пообещать НЕ передавать карты событий (3 цикла) ЕМУ САМОМУ (по прямому
 * запросу — «сейчас игроки просят за других игроков не передавать карты событий, а должны просить
 * за себя»): получение карты события через обязательную передачу обычно НЕ в радость получателю
 * (см. GameSession.handoffCard — падение отношений −1 у принявшего именно за это), так что просить
 * защитить ТРЕТЬЮ сторону было нелогично — своя собственная выгода прямая и очевидная, чужая
 * (прежняя версия — «худший по отношению противник») просителя не касается вовсе. Критерий
 * согласия — своё правило в shouldAcceptProposal (не общий гейт), само оно не завязано на то, КТО
 * именно excludedPlayerId — работает одинаково для любого значения. */
function considerPromiseNoEventCards(session: GameSession, playerId: number, reporter: Reporter): boolean {
  for (const targetId of neighborPlayerIds(session, playerId)) {
    // Триггер (по прямому уточнению — «проверь логику дипломатии, она работает в никуда»): просить
    // ИМЕЕТ СМЫСЛ только у того, кто РЕАЛЬНО уже сбрасывал мне карты событий — карта с пометкой
    // `receivedFrom === targetId` прямо сейчас в руке. Раньше условия не было ВООБЩЕ: сценарий слал
    // просьбу каждому соседу просто потому, что кулдаун истёк, и, стоя 4-м из 9 в строго
    // приоритетном списке «первый применимый и только он», почти каждый ход съедал единственное
    // дипломатическое действие — до пп.5-9 (запрос ресурса, дань-ультиматум, КООПЕРАТИВНЫЕ
    // соглашения, призыв на войну) очередь практически никогда не доходила. Это и была главная
    // причина, по которой за всю партию не заключалось ни одного соглашения.
    const dumpedEventCardsOnMe = (session.hands[playerId] ?? []).some((c) => c?.kind === "event" && c.receivedFrom === targetId);
    if (!dumpedEventCardsOnMe) continue;
    if (wasAttemptedRecently(session, playerId, targetId, "promiseNoEventCards")) continue;
    const terms: ProposalTerm[] = [{ kind: "promiseNoEventCards", excludedPlayerId: playerId, duration: 3 }, ...diplomacySweetenerFor(session, playerId, targetId)];
    const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
    if (sendScenarioProposal(session, playerId, targetId, terms, "promiseNoEventCards", reporter, `Просит игрока ${targetName} не передавать карты событий ему самому.`)) return true;
  }
  return false;
}

/** П.5 — просит нужную карту («Торговец», если своя сеть уже есть, а карты в руке нет) или нужный
 * ресурс (категория, которой на складе нет вовсе) — обещание передать/выставить через 3 цикла. */
/** «ПЕРЕДАЧА КАРТ» (пункт листа «Режимы и приоритеты») — просьба к соседу отдать карту нужного типа.
 * Сейчас единственный реально востребованный тип — «Торговец» при уже готовой торговой сети: есть
 * чем пользоваться, но нечем сыграть. Не нашлось ни одного адресата (отношения ниже порога, кулдаун
 * недавней такой же просьбы, карта и так есть) — возвращает false, и приоритетный список идёт дальше. */
function considerRequestCardFromOthers(session: GameSession, playerId: number, reporter: Reporter): boolean {
  if (!hasTradeNetwork(session, playerId) || session.hands[playerId]?.some((c) => c.id === "trader")) return false;
  for (const targetId of neighborPlayerIds(session, playerId)) {
    if (!isPeacefulDiplomacyViable(session, playerId, targetId)) continue;
    if (wasAttemptedRecently(session, playerId, targetId, "requestCard:trader")) continue;
    const terms: ProposalTerm[] = [{ kind: "promiseGiveCardType", cardId: "trader", duration: 3 }, ...diplomacySweetenerFor(session, playerId, targetId)];
    const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
    if (sendScenarioProposal(session, playerId, targetId, terms, "requestCard:trader", reporter, `Просит у игрока ${targetName} карту «Торговец» — есть готовая торговая сеть, но карты нет.`)) return true;
  }
  return false;
}

/** «РЕСУРСЫ НА БИРЖУ» (пункт листа) — просьба выставить нужный ресурс на биржу (`promiseListResource`),
 * мирная альтернатива войне за доступ. Две причины, обе через один и тот же терм: не хватает
 * КОНКРЕТНОГО стратегического ресурса (та же причина, что завела бы «План войны», но отношения с
 * обладателем хорошие, ≥60 — вместо накопления войск просим по-хорошему), либо на складе вовсе нет
 * целой КАТЕГОРИИ ресурсов. Ни одного подходящего адресата — false, список идёт дальше. */
function considerRequestResourceListing(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const shortage = findResourceShortageTarget(session, playerId);
  if (shortage && session.relationScoreOf(playerId, shortage.targetId) >= 60) {
    const scenarioKey = `requestStrategicResource:${shortage.resource}`;
    if (!wasAttemptedRecently(session, playerId, shortage.targetId, scenarioKey)) {
      const terms: ProposalTerm[] = [{ kind: "promiseListResource", resource: shortage.resource, duration: 3 }, ...diplomacySweetenerFor(session, playerId, shortage.targetId)];
      const targetName = session.players.find((p) => p.id === shortage.targetId)?.name ?? `игрок ${shortage.targetId}`;
      const text = `Просит у игрока ${targetName} выставить на бирже ${RESOURCE_LABEL.get(shortage.resource) ?? shortage.resource} — нехватка стратегического ресурса, но отношения хорошие.`;
      if (sendScenarioProposal(session, playerId, shortage.targetId, terms, scenarioKey, reporter, text)) return true;
    }
  }
  for (const category of ["food", "strategic", "trade"] as const) {
    if (warehouseCategoryTotal(session, playerId, category) > 0) continue;
    for (const targetId of neighborPlayerIds(session, playerId)) {
      if (!isPeacefulDiplomacyViable(session, playerId, targetId)) continue;
      const scenarioKey = `requestResource:${category}`;
      if (wasAttemptedRecently(session, playerId, targetId, scenarioKey)) continue;
      // По прямому запросу — живой баг-репорт: «просьба выложить ресурсы на биржу должна быть
      // осмысленной, для ресурсов, которых уже нет на бирже, а то AI просит рандомные ресурсы» —
      // раньше здесь брался ПЕРВЫЙ по порядку `RESOURCES` вид категории, который вообще есть у цели в
      // территории, не считаясь с тем, продаёт ли она (или кто угодно ещё) этот же вид ПРЯМО СЕЙЧАС:
      // просьба «выставь X» была бессмысленна, если X и так уже лежит на бирже лотом — достаточно
      // было просто купить (см. `marketPass`). Теперь вид, уже представленный ЛЮБЫМ активным лотом на
      // бирже, из кандидатов исключается — просьба имеет смысл, только когда добыть этот вид иначе,
      // кроме как через территорию/склад цели, реально неоткуда.
      const resource = RESOURCES.find(
        (r) => r.category === category && hasResourceInOwnTerritory(session, targetId, r.id) && !session.market.some((l) => l.kind === "resource" && l.resource === r.id)
      )?.id;
      if (!resource) continue;
      const terms: ProposalTerm[] = [{ kind: "promiseListResource", resource, duration: 3 }, ...diplomacySweetenerFor(session, playerId, targetId)];
      const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
      if (sendScenarioProposal(session, playerId, targetId, terms, scenarioKey, reporter, `Просит у игрока ${targetName} выставить на бирже ${RESOURCE_LABEL.get(resource) ?? resource} — своей категории на складе вовсе нет.`)) return true;
    }
  }
  return false;
}

/** «ТРЕБОВАНИЯ РЕСУРСОВ» (пункт листа), жёсткая половина — дань-ультиматум: та же нехватка, что и у
 * просьбы выше, но отношения уже не настолько хороши для вежливого варианта (<60) и ещё не настолько
 * плохи, чтобы `considerWarPlan` завёл войну без предупреждения (≥TRIBUTE_RELATION_MIN=40) — ровно
 * диапазон [40,60). `ultimatum: true` — отказ АВТОМАТИЧЕСКИ объявляет войну (GameSession.
 * resolveProposal), отдельного объявления не требуется. */
function considerResourceTributeUltimatum(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const shortage = findResourceShortageTarget(session, playerId);
  if (!shortage) return false;
  const score = session.relationScoreOf(playerId, shortage.targetId);
  if (score < TRIBUTE_RELATION_MIN || score >= 60) return false;
  const scenarioKey = `resourceTributeUltimatum:${shortage.resource}`;
  if (wasAttemptedRecently(session, playerId, shortage.targetId, scenarioKey)) return false;
  const amount = Math.max(1, Math.round(2 * valueOfResource(session, shortage.resource)));
  const terms: ProposalTerm[] = [{ kind: "demandMoney", amount }];
  const targetName = session.players.find((p) => p.id === shortage.targetId)?.name ?? `игрок ${shortage.targetId}`;
  const text = `Требует у игрока ${targetName} дань ${amount}💰 (2× стоимость ${RESOURCE_LABEL.get(shortage.resource) ?? shortage.resource}) — нехватка стратегического ресурса, отношения нейтральные; отказ — война.`;
  return sendScenarioProposal(session, playerId, shortage.targetId, terms, scenarioKey, reporter, text, true);
}

/** П.7 — при враждебных отношениях/ненависти (см. PEACEFUL_DIPLOMACY_MIN_RELATION) разрывает УЖЕ
 * действующее соглашение (любое одно за раз — по одному за ход, как и остальные) — «дипломатическое
 * общение сводится к силовым инструментам», кооперативные связи с таким партнёром не нужны. */
function considerDowngradeHostileRelations(session: GameSession, playerId: number, reporter: Reporter): boolean {
  for (const p of session.players) {
    if (p.id === playerId || session.eliminatedPlayers.has(p.id)) continue;
    if (isPeacefulDiplomacyViable(session, playerId, p.id)) continue;
    const rel = session.relationOf(playerId, p.id);
    const agreement = [...rel.agreements][0];
    if (!agreement) continue;
    const payload = { otherId: p.id, agreement };
    const result = session.dispatch("breakAgreement", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "breakAgreement",
        payload,
        targetKind: "player",
        targetPlayerId: p.id,
        label: `Разорвал «${AGREEMENT_LABELS[agreement]}» с игроком ${p.name} — отношения враждебны, только силовые инструменты.`,
      });
      return true;
    }
  }
  return false;
}

/** Оркестратор — заменяет прямой вызов considerDiplomacyDeals в runAiTurnLogic (см. её doc): 5
 * старых сценариев стали ОДНИМ (6-м) пунктом этого списка, не отдельным вызовом. */
/** «Вступление в чужую войну по призыву» — сторона ИНИЦИАТОРА (по прямому запросу, «План войны»,
 * НОВОЕ) — уже воюю с кем-то, ищу слабого (≤2 города, есть войска) живого игрока, ещё не воюющего с
 * этим же противником, и прошу его вступить на моей стороне. Пригодность решает исключительно
 * получатель (см. shouldAcceptProposal) — здесь просто перебор кандидатов, первый успешно
 * отправленный останавливает перебор (та же экономия dispatch/анти-спам, что и everywhere в файле). */
function considerCallToWar(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const enemies = session.players.filter((p) => p.id !== playerId && session.relationOf(playerId, p.id).war);
  for (const enemy of enemies) {
    const candidates = session.players.filter(
      (p) =>
        p.id !== playerId &&
        p.id !== enemy.id &&
        !session.eliminatedPlayers.has(p.id) &&
        !session.relationOf(p.id, enemy.id).war &&
        myCities(session, p.id).length <= 2 &&
        countUnitsOf(session, p.id) > 0
    );
    for (const candidate of candidates) {
      if (!isPeacefulDiplomacyViable(session, playerId, candidate.id)) continue;
      const terms: ProposalTerm[] = [{ kind: "callToWar", targetId: enemy.id }];
      if (sendScenarioProposal(session, playerId, candidate.id, terms, `callToWar:${enemy.id}`, reporter, `Попросил игрока ${candidate.name} вступить в войну против ${enemy.name}.`)) return true;
    }
  }
  return false;
}

/** «Дипломатическое давление» (по прямому запросу §4.4) — следующая ступень эскалации после
 * бесплатного `considerCallToWar` выше: война с `enemy` зависла (`peaceOfferStreak` ≥
 * PEACE_ESCALATION_PRESSURE_STREAK — та же память, что копит `considerPeaceOffers`) — вместо
 * дальнейшей ежецикловой мольбы о мире рассылаю ТРЕТЬИМ игрокам (не самому противнику) ПЛАТНОЕ
 * приглашение вступить в войну: тот же терм `callToWar`, что и бесплатный призыв, но с приложенной
 * оплатой (offerMoney, лимит той же `valueOfWar`, что и у обычной компенсации за мир — не переплачиваю
 * больше, чем сама война стоит) и БЕЗ ограничения «≤2 города» на кандидатов из considerCallToWar (это
 * не «призыв слабого на подмогу», а «покупка союзника» — решение о пригодности всё равно принимает
 * получатель, см. shouldAcceptProposal: платёж/баланс сил компенсируют отсутствие превосходства сил). */
function considerDiplomaticPressure(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const stuckEnemies = session.players.filter(
    (p) => p.id !== playerId && session.relationOf(playerId, p.id).war && (session.peaceOfferStreak[`${playerId}:${p.id}`] ?? 0) >= PEACE_ESCALATION_PRESSURE_STREAK
  );
  for (const enemy of stuckEnemies) {
    const candidates = session.players.filter((p) => p.id !== playerId && p.id !== enemy.id && !session.eliminatedPlayers.has(p.id) && !session.relationOf(p.id, enemy.id).war);
    for (const candidate of candidates) {
      const scenarioKey = `diplomaticPressure:${enemy.id}`;
      if (wasAttemptedRecently(session, playerId, candidate.id, scenarioKey)) continue;
      const warGap = Math.max(1, Math.round(valueOfWar(session, playerId, enemy.id)));
      const terms: ProposalTerm[] = [{ kind: "callToWar", targetId: enemy.id }];
      if (session.money[playerId] > 0) terms.push({ kind: "offerMoney", amount: Math.min(session.money[playerId], warGap) });
      const text = `Предложил игроку ${candidate.name} оплату за вступление в войну против ${enemy.name} — своя мольба о мире не помогает уже ${session.peaceOfferStreak[`${playerId}:${enemy.id}`]} циклов.`;
      if (sendScenarioProposal(session, playerId, candidate.id, terms, scenarioKey, reporter, text)) return true;
    }
  }
  return false;
}

/** «Совместное нападение» — сторона ИНИЦИАТОРА (по прямому запросу, «План войны», НОВОЕ) — третий
 * (потенциальная цель) граничит и со мной, и с партнёром, а моё отношение к партнёру ЛУЧШЕ, чем к
 * этому третьему — предлагаю партнёру ударить вместе. Симметричная проверка на стороне партнёра —
 * тоже в shouldAcceptProposal. Не предлагается, если я уже воюю с третьим (см. sendProposal-гейт). */
/** «ПРЕКРАТИТЬ ТОРГОВЛЮ С ВРАГОМ» (пункт листа «Режимы и приоритеты» в режимах ОБОРОНА/ПОДГОТОВКА/
 * ВОЙНА) — просьба к третьей стороне разорвать ВСЕ её соглашения с моим врагом (`breakTiesWith`,
 * см. GameSession.applyProposalTerms: принятие рвёт их немедленно, это разовое действие, не обещание).
 *
 * «Враг» — тот, с кем я УЖЕ воюю; войны нет — цель активного «Плана войны» (в ОБОРОНЕ/ПОДГОТОВКЕ
 * реальной войны может ещё не быть, но ослаблять будущего противника уже осмысленно). Адресат —
 * сосед, который (а) сам не воюет со мной, (б) реально имеет хоть одно соглашение с этим врагом
 * (иначе просьба бессмысленна и только тратит дипломатическое действие) и (в) относится ко мне
 * лучше, чем я к врагу — просить рвать связи у того, кто дружит с врагом сильнее, чем со мной,
 * бесполезно. Ни одного такого адресата — false, приоритетный список идёт дальше. */
function considerBreakTiesWithEnemy(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const enemyIds = session.players.filter((p) => p.id !== playerId && session.relationOf(playerId, p.id).war).map((p) => p.id);
  const planTarget = session.warPlans[playerId]?.targetId;
  if (!enemyIds.length && planTarget !== undefined) enemyIds.push(planTarget);
  for (const enemyId of enemyIds) {
    const enemyName = session.players.find((p) => p.id === enemyId)?.name ?? `игрок ${enemyId}`;
    for (const targetId of neighborPlayerIds(session, playerId)) {
      if (targetId === enemyId) continue;
      if (session.relationOf(playerId, targetId).war) continue;
      if (!isPeacefulDiplomacyViable(session, playerId, targetId)) continue;
      if (session.relationOf(targetId, enemyId).agreements.size === 0) continue;
      if (session.relationScoreOf(targetId, playerId) <= session.relationScoreOf(targetId, enemyId)) continue;
      const scenarioKey = `breakTiesWith:${enemyId}`;
      if (wasAttemptedRecently(session, playerId, targetId, scenarioKey)) continue;
      const terms: ProposalTerm[] = [{ kind: "breakTiesWith", targetId: enemyId }, ...diplomacySweetenerFor(session, playerId, targetId)];
      const targetName = session.players.find((p) => p.id === targetId)?.name ?? `игрок ${targetId}`;
      const text = `Просит игрока ${targetName} разорвать все соглашения с ${enemyName} — прекратить торговлю с врагом.`;
      if (sendScenarioProposal(session, playerId, targetId, terms, scenarioKey, reporter, text)) return true;
    }
  }
  return false;
}

function considerJointAttack(session: GameSession, playerId: number, reporter: Reporter): boolean {
  for (const thirdId of neighborPlayerIds(session, playerId)) {
    if (session.relationOf(playerId, thirdId).war) continue;
    const partners = session.players.filter(
      (p) =>
        p.id !== playerId &&
        p.id !== thirdId &&
        !session.eliminatedPlayers.has(p.id) &&
        !session.relationOf(p.id, thirdId).war &&
        neighborPlayerIds(session, p.id).includes(thirdId) &&
        session.relationScoreOf(playerId, p.id) > session.relationScoreOf(playerId, thirdId)
    );
    for (const partner of partners) {
      if (!isPeacefulDiplomacyViable(session, playerId, partner.id)) continue;
      const terms: ProposalTerm[] = [{ kind: "jointAttack", targetId: thirdId }];
      const thirdName = session.players.find((p) => p.id === thirdId)!.name;
      if (sendScenarioProposal(session, playerId, partner.id, terms, `jointAttack:${thirdId}`, reporter, `Предложил игроку ${partner.name} совместное нападение на ${thirdName}.`)) return true;
    }
  }
  return false;
}

/** ДВЕ независимые категории вместо одного строго приоритетного списка (по прямому уточнению —
 * «игрок каждый ход должен стремиться совершать по 1 дипломатическому действию, если ему это
 * доступно» + «проверь логику дипломатии и войны, обе как будто инвалиды, работают, но в никуда»).
 *
 * Причина правки — прогон всех 5 AI на реальном сейве партии (11 циклов, НИ ОДНОГО заключённого
 * соглашения ни у одной из 15 пар, при том что технологии соглашений открыты у всех, контакт есть, а
 * отношения преимущественно «хорошие»): все боты каждый ход застревали на пп.2-4 (просьбы/дань), а
 * кооперативные соглашения (бывший п.6) при правиле «первый применимый и только он» не получали хода
 * практически никогда. Теперь ситуативные/силовые сценарии (просьбы, дань, разрывы, призывы к войне)
 * и КООПЕРАТИВНЫЕ соглашения разыгрываются как две отдельные очереди: из каждой — не более одного
 * действия за ход, но они больше не конкурируют друг с другом за один-единственный слот. */
type DiplomacyScenario = (session: GameSession, playerId: number, reporter: Reporter) => boolean;

/** ПОРЯДОК ДИПЛОМАТИЧЕСКИХ ДЕЙСТВИЙ по стратегиям — дословно лист «Режимы и приоритеты», сверху вниз.
 * Как и у карт, это ЕДИНСТВЕННОЕ место, где задаётся порядок: каждый сценарий сам решает, применим
 * ли он (`return false` — не применим), а список решает, в какую очередь его спрашивать.
 *
 * ЗАЩИТА ОТ ЗАЦИКЛИВАНИЯ на верхних пунктах (по прямому уточнению — «отказ или некому предложить,
 * кто согласится из-за отношений — идёт дальше по списку») обеспечена самими сценариями и работает
 * на трёх уровнях сразу: неприменимое условие → false; отношения ниже порога кооперативной дипломатии
 * (`isPeacefulDiplomacyViable`) → адресат пропускается, кончились адресаты → false; недавняя такая же
 * просьба тому же игроку (`wasAttemptedRecently`, кулдаун DIPLOMACY_ATTEMPT_COOLDOWN_CYCLES=6, штамп
 * ставится при ЛЮБОМ исходе, включая отказ) → адресат пропускается. Поэтому верхний пункт не может
 * заблокировать список: он либо сработал один раз, либо честно уступил очередь следующему.
 *
 * Соответствие названий таблицы сценариям: Договор о занятии территории → `considerPromiseNoSettle`;
 * Не передавать карты → `considerPromiseNoEventCards`; Ресурсы на биржу →
 * `considerRequestResourceListing`; Требования ресурсов → `considerResourceTributeUltimatum` +
 * `considerDemandTribute`; Открытые границы → `considerOpenBorders`; Альянс →
 * `considerBalanceOfPowerAlliance`; Научное сотрудничество → `considerScienceCoopWhenBehind`;
 * Оборонный (Оборонительный) союз → `considerDefensePactAfterTruce`; Торговое соглашение →
 * `considerTradeUnionForSharedNetwork`; Обещание не нападения → `considerPromiseNoAttack`;
 * Передача карт → `considerRequestCardFromOthers`; Совместное нападение или помощь →
 * `considerJointAttack`/`considerCallToWar`/`considerJointWarAlliance`; Прекратить торговлю с врагом →
 * `considerBreakTiesWithEnemy`.
 *
 * Отличия от буквы таблицы, внесённые осознанно:
 * — в столбце ПОБЕДА «Научное сотрудничество» указано дважды (4-я и 8-я строки) — учтено один раз. */
const DIPLOMACY_PRIORITY_BY_MODE: Record<StrategicPriority, DiplomacyScenario[]> = {
  expansion: [
    considerPromiseNoSettle,
    considerPromiseNoEventCards,
    considerRequestResourceListing,
    considerResourceTributeUltimatum,
    considerDemandTribute,
    considerOpenBorders,
    considerBalanceOfPowerAlliance,
    considerScienceCoopWhenBehind,
    considerDefensePactAfterTruce,
    considerTradeUnionForSharedNetwork,
    considerPromiseNoAttack,
  ],
  victory: [
    considerDefensePactAfterTruce,
    considerTradeUnionForSharedNetwork,
    considerOpenBorders,
    considerScienceCoopWhenBehind,
    considerPromiseNoEventCards,
    considerRequestResourceListing,
    considerResourceTributeUltimatum,
    considerDemandTribute,
    considerRequestCardFromOthers,
    considerBalanceOfPowerAlliance,
  ],
  development: [
    considerDefensePactAfterTruce,
    considerTradeUnionForSharedNetwork,
    considerScienceCoopWhenBehind,
    considerPromiseNoAttack,
    considerRequestCardFromOthers,
    considerOpenBorders,
    considerPromiseNoEventCards,
    considerRequestResourceListing,
    considerBalanceOfPowerAlliance,
    considerResourceTributeUltimatum,
    considerDemandTribute,
  ],
  defense: [
    considerDefensePactAfterTruce,
    considerDiplomaticPressure,
    considerPromiseNoAttack,
    considerBalanceOfPowerAlliance,
    considerTradeUnionForSharedNetwork,
    considerBreakTiesWithEnemy,
    considerRequestCardFromOthers,
    considerScienceCoopWhenBehind,
    considerPromiseNoEventCards,
    considerOpenBorders,
    considerResourceTributeUltimatum,
    considerDemandTribute,
  ],
  warPrep: [
    considerDiplomaticPressure,
    considerScienceCoopWhenBehind,
    considerOpenBorders,
    considerDefensePactAfterTruce,
    considerResourceTributeUltimatum,
    considerDemandTribute,
    considerBreakTiesWithEnemy,
    considerTradeUnionForSharedNetwork,
    considerRequestCardFromOthers,
    considerRequestResourceListing,
    considerBalanceOfPowerAlliance,
    considerPromiseNoEventCards,
  ],
  war: [
    considerJointAttack,
    considerCallToWar,
    considerDiplomaticPressure,
    considerJointWarAlliance,
    considerBreakTiesWithEnemy,
    considerOpenBorders,
    considerScienceCoopWhenBehind,
    considerRequestCardFromOthers,
    considerResourceTributeUltimatum,
    considerDemandTribute,
    considerPromiseNoAttack,
    considerBalanceOfPowerAlliance,
    considerPromiseNoEventCards,
    considerRequestResourceListing,
  ],
};

/** Одно дипломатическое действие за ход — первое применимое из списка текущей стратегии.
 * Две РЕАКЦИИ, которых в таблице нет (она описывает, что предлагать, а не как реагировать), идут до
 * списка и списком не ограничены: разрыв «Открытых границ» с тем, кто воюет с более близким мне
 * игроком, и разрыв кооперативных соглашений при враждебных отношениях. */
function considerRelationDiplomacy(session: GameSession, playerId: number, reporter: Reporter) {
  if (considerRevokeOpenBordersOverFriendWar(session, playerId, reporter)) return;
  if (considerDowngradeHostileRelations(session, playerId, reporter)) return;
  for (const scenario of DIPLOMACY_PRIORITY_BY_MODE[computeStrategicPriority(session, playerId)]) {
    if (scenario(session, playerId, reporter)) return;
  }
}

// === Парадигма, религия, Коммунизм — административные решения бота (по прямому запросу) ==========
// Все три ничего не стоят (не тратят actionsLeft/карту) — вызываются один раз в начале хода, до
// цикла розыгрыша карт, тем же местом, что considerPeaceOffers/considerWarDeclaration выше.

/** Технология + эпоха каждой парадигмы — server-side дубликат client-side PARADIGM_META (main.ts,
 * там же ещё label/effect для UI, здесь не нужны) — bot.ts не может импортировать браузерный
 * main.ts, держать в синхроне при правке парадигм. */
const PARADIGM_TECH_EPOCH: Record<Paradigm, { tech: string; epoch: number }> = {
  monotheism: { tech: "Мистицизм", epoch: 1 },
  monarchy: { tech: "Богословие", epoch: 2 },
  parliamentarism: { tech: "Экономика", epoch: 3 },
  democracy: { tech: "Права человека", epoch: 5 },
  fascism: { tech: "Идеология", epoch: 5 },
  communism: { tech: "Коммунизм", epoch: 6 },
};

/** Сила по числу юнитов у самого сильного ИЗ ОСТАЛЬНЫХ игроков («лидера») — та же метрика «сила =
 * число юнитов», что и everywhere в военных решениях бота (§22 ЦИВА-ЖУРНАЛ). Игроков больше нет
 * вовсе (партия на одного) — 0, «отставания» тогда в принципе не бывает. */
function strongestOtherForce(session: GameSession, playerId: number): number {
  const others = session.players.filter((p) => p.id !== playerId).map((p) => countUnitsOf(session, p.id));
  return others.length ? Math.max(...others) : 0;
}

/** Условие принятия КАЖДОЙ парадигмы — по прямому запросу дословно (было: любая парадигма годна,
 * как только исследована технология, кроме Парламентаризма — тому уже требовалось хотя бы 2 своих
 * здания). «Если условия пересекаются, берёт более современную по эпохе» ничего специально считать
 * не заставляет — `considerParadigm` ниже и так сортирует всех ГОДНЫХ кандидатов по убыванию эпохи и
 * берёт первого; когда несколько условий совпадают одновременно (буквально у Монархии/Демократии —
 * условие одно и то же), выигрывает просто более поздняя по эпохе среди них.
 * - **Монотеизм** — БОЛЬШИНСТВО своих городов население ≤3.
 * - **Монархия** и **Демократия** — одно и то же условие: более 3 поселений ИЛИ все поселения
 *   население >3.
 * - **Парламентаризм** — ≥3 своих здания (было ≥2).
 * - **Фашизм** — ЛЮБОЕ из двух (по прямому запросу): свои войска (число юнитов) более чем вдвое
 *   МЕНЬШЕ, чем у сильнейшего из ОСТАЛЬНЫХ игроков («лидера», тот же порог `WAR_FORCE_RATIO`, что и
 *   everywhere в военных решениях бота) — ИЛИ содержание (юниты+здания, с учётом уже имеющегося
 *   «Кодекс законов») превышает половину налогового дохода (Фашизм вдвое сокращает именно этот
 *   расход, см. GameSession.collectTaxes — прямая экономическая причина принять её). Единственная
 *   парадигма, исключённая из общего запрета смены во время войны (см. GameSession.adoptParadigm) —
 *   военная слабость как раз и обнаруживается чаще всего во время войны.
 * - **Коммунизм** — НЕ отстаёт от лидера (отрицание условия Фашизма выше) И НЕ основатель религии
 *   (`religionFounder`, см. §7) И ≥3 своих поселения.
 * Своих городов нет вовсе — все условия с порогом по городам считаются НЕ выполненными (пустой
 * список — не «большинство» и не «все»). */
function paradigmViable(session: GameSession, playerId: number, paradigm: Paradigm): boolean {
  const cities = myCities(session, playerId);
  switch (paradigm) {
    case "monotheism": {
      if (!cities.length) return false;
      const small = cities.filter((c) => c.population <= 3).length;
      return small > cities.length - small;
    }
    case "monarchy":
    case "democracy":
      return cities.length > 3 || (cities.length > 0 && cities.every((c) => c.population > 3));
    case "parliamentarism":
      return builtBy(session.buildingOwners, playerId).length >= 3;
    case "fascism": {
      if (strongestOtherForce(session, playerId) > countUnitsOf(session, playerId) * WAR_FORCE_RATIO) return true;
      const income = taxIncomeEstimate(session, playerId);
      return income > 0 && unitsAndBuildingsUpkeepEstimate(session, playerId) > income / 2;
    }
    case "communism": {
      if (strongestOtherForce(session, playerId) > countUnitsOf(session, playerId) * WAR_FORCE_RATIO) return false;
      if (Object.values(session.religionFounder).includes(playerId)) return false;
      return cities.length >= 3;
    }
  }
}

/** По прямому запросу — «по парадигмам берёт самую крутую из доступных»: среди парадигм, чья
 * технология уже исследована И которые сейчас имеют смысл (paradigmViable), берёт с максимальной
 * эпохой; ничего не делает, если уже стоит на ней самой (в т.ч. если лучший кандидат недостижим —
 * тогда просто остаётся на текущей, ждёт следующего апгрейда). */
function considerParadigm(session: GameSession, playerId: number, reporter: Reporter) {
  const researched = session.researchedTechs[playerId];
  const candidates = (Object.keys(PARADIGM_TECH_EPOCH) as Paradigm[]).filter(
    (p) => researched.has(PARADIGM_TECH_EPOCH[p].tech) && paradigmViable(session, playerId, p)
  );
  if (!candidates.length) return;
  const best = candidates.sort((a, b) => PARADIGM_TECH_EPOCH[b].epoch - PARADIGM_TECH_EPOCH[a].epoch)[0];
  if (session.playerParadigm[playerId] === best) return;
  const payload = { paradigm: best };
  const result = session.dispatch("adoptParadigm", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "adoptParadigm", payload, targetKind: "none", label: `Принял парадигму «${best}» — самая продвинутая из доступных.` });
  }
}

const RELIGION_FOUNDING_TECHS = ["Мистицизм", "Философия", "Богословие"];
const RELIGION_CANDIDATES: Religion[] = ["judaism", "buddhism", "christianity", "islam", "confucianism"];

/** Может ли игрок ОСНОВАТЬ ещё не основанную религию прямо сейчас (см. GameSession.adoptReligion) —
 * личный первооткрыватель одной из 3 религиозных технологий, ещё ни разу не основавший свою. */
function canFoundOwnReligion(session: GameSession, playerId: number): boolean {
  if (Object.values(session.religionFounder).includes(playerId)) return false;
  return RELIGION_FOUNDING_TECHS.some((t) => session.techDiscoverer[t] === playerId);
}

/** Религия САМОГО СИЛЬНОГО (по числу юнитов) приграничного соседа — «религия соседа, наиболее
 * сильного по армии» (по прямому запросу); атеистов и соседей без религии пропускает — примкнуть к
 * «отсутствию религии» смысла нет.
 * «Соседи принимают решение принимать её или нет» (по прямому запросу, живой баг-репорт — «компьютер
 * открыл монотеизм, но не открыл религии»): решение — не слепое копирование ЛЮБОГО соседа, а именно
 * решение, поэтому сосед, с которым сейчас ВОЙНА, из рассмотрения исключается целиком — веру врага не
 * принимают, даже если он самый сильный по армии (тогда решение — рассмотреть следующего по силе
 * соседа с религией, а если таких нет вовсе — не принимать ничью религию в этот заход). */
function strongestNeighborReligion(session: GameSession, playerId: number): Religion | null {
  const withReligion = neighborPlayerIds(session, playerId)
    .filter((id) => session.playerReligion[id] && session.playerReligion[id] !== "atheism" && !session.relationOf(playerId, id).war)
    .sort((a, b) => countUnitsOf(session, b) - countUnitsOf(session, a));
  return withReligion.length ? (session.playerReligion[withReligion[0]] as Religion) : null;
}

/** По прямому запросу: своя религия в приоритете, если её можно ОСНОВАТЬ прямо сейчас; иначе —
 * религия сильнейшего по армии соседа. Меняет уже принятую религию не чаще раза в
 * `GameSession.RELIGION_CHANGE_COOLDOWN_CYCLES` циклов (самый первый выбор — из «нет религии» — этим
 * не ограничен) — саму блокировку выставляет `adoptReligion` внутри GameSession, а не этот код (живой
 * баг-репорт — «компы постоянно меняют религии, теряя ходы»: раньше блокировка выставлялась ЗДЕСЬ,
 * ПОСЛЕ dispatch, но во время планирования хода AI dispatch идёт на одноразовый КЛОН, который потом
 * выбрасывается — реальную партию воспроизводит только записанный список действий, а прямая мутация
 * поля клона в него не попадает; кулдаун ни разу не срабатывал по-настоящему, и каждая переоценка
 * религии заново пропускала ход игроку — см. adoptReligion). */
function considerReligion(session: GameSession, playerId: number, reporter: Reporter) {
  // Коммунизм (по прямому уточнению — «AI при коммунизме атеист») — под ним бонус действия даёт
  // ТОЛЬКО Атеизм (см. GameSession.adoptParadigm/endTurn, `paradigmViable` уже не даёт боту принять
  // Коммунизм, если он основатель религии); менять религию вручную дальше нет смысла — только
  // потерять бонус ради чего-то, что боту всё равно не принадлежит (соседняя религия). Бот просто
  // остаётся Атеистом, пока действует эта парадигма.
  if (session.playerParadigm[playerId] === "communism") return;
  const current = session.playerReligion[playerId];
  let target: Religion | null = null;
  if (canFoundOwnReligion(session, playerId)) {
    target = RELIGION_CANDIDATES.find((r) => session.religionFounder[r] === undefined) ?? null;
  }
  if (!target) target = strongestNeighborReligion(session, playerId);
  if (!target || target === current) return;
  if (current !== null && (session.aiReligionLockUntilCycle[playerId] ?? 0) > session.cyclesElapsed) return;
  const payload = { religion: target };
  const result = session.dispatch("adoptReligion", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "adoptReligion", payload, targetKind: "none", label: `Принял религию «${target}».` });
  }
}

/** Ресурсы, нужные Космодрому (GameSession.KOSMODROM_COST, продублировано — private) — по ним ниже
 * выбирается второй город Коммунизма. */
const KOSMODROM_RESOURCES: ResourceId[] = ["hydrocarbons", "rareEarth", "metalOre"];

/** По прямому запросу — «при выборе коммунизма выбирать город, в котором больше всего нужных
 * ресурсов для этого производства [Космодрома]»: среди своих НЕстоличных городов берёт тот, чей
 * регион содержит больше всего разных ресурсов из KOSMODROM_RESOURCES (столица участвует в бонусе
 * Коммунизма и так, см. GameSession.communismCapitalTypes — этот выбор её не заменяет, а дополняет).
 * Не выбирает никого, если ни один не даёт вообще ничего полезного. Свободно меняет выбор при
 * появлении более удачного города — в отличие от религии, здесь запрос не просил ограничивать частоту. */
function considerCommunismCity(session: GameSession, playerId: number, reporter: Reporter) {
  if (session.playerParadigm[playerId] !== "communism") return;
  const candidates = myCities(session, playerId).filter((c) => !c.isCapital);
  if (!candidates.length) return;
  const score = (c: { regionCol: number; regionRow: number }) => session.resourcesInRegion(c.regionCol, c.regionRow).filter((r) => KOSMODROM_RESOURCES.includes(r)).length;
  const best = candidates.sort((a, b) => score(b) - score(a))[0];
  if (score(best) <= 0 || session.communismExtraCityId[playerId] === best.id) return;
  const payload = { cityId: best.id };
  const result = session.dispatch("chooseCommunismCity", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "chooseCommunismCity", payload, targetKind: "city", targetCityId: best.id, label: `Выбрал город (${best.col},${best.row}) доп. источником ресурсов Коммунизма — под Космодром.` });
  }
}

/** Космодром — по прямому запросу «высший приоритет строительство деталей корабля»: пробуется КАЖДЫЙ
 * заход цикла розыгрыша, раньше любой карты (см. runAiTurnLogic) — если здание есть и хватает
 * ресурсов/действия, всегда предпочитается любой карте. Не больше 1 раза за цикл (см. buildings.ts) —
 * дальнейшие заходы того же хода просто получают отказ и код переходит к другим приоритетам. */
function tryActivateKosmodrom(session: GameSession, playerId: number, reporter: Reporter): boolean {
  if (!isOwnedBy(session.buildingOwners, "kosmodrom", playerId)) return false;
  const result = session.dispatch("activateKosmodrom", playerId, {});
  if (result.ok) {
    reporter.step({
      action: "activateKosmodrom",
      payload: {},
      sourceBuildingId: "kosmodrom",
      targetKind: "building",
      targetBuildingId: "kosmodrom",
      label: `Построил деталь корабля (Космодром) — ${result.hint ?? ""}`,
    });
    return true;
  }
  return false;
}

/** Ядерный арсенал, ПРОИЗВОДСТВО ЯО в запас (по прямому запросу — «проверь, умеет ли AI делать
 * атомные бомбы и применять их»: применять уже умел, см. `tryLaunchNuclearStrike` ниже, а
 * производить — не умел вовсе, только расходовал то, что накопил человек/более ранняя версия бота).
 * Тратит дефицитный Уран (не продаётся на постоянных лотах биржи, см. §10 ЦИВА-СПРАВОЧНИК) — не
 * копится бесцельно каждый ход, только при реальной военной надобности: идёт война с противником,
 * чья военная мощь выше собственной (`facesWarWithSuperiorEnemy`, то же условие, что и у
 * Фортификации в `buildingPriorityOrder`/у самого удара ниже). Не больше 1 раза за цикл (см.
 * buildings.ts) — пробуется в каждом заходе цикла розыгрыша, но реально производит не больше одной
 * бомбы за ход, дальнейшие заходы получают отказ. */
function tryActivateYadernyiArsenal(session: GameSession, playerId: number, reporter: Reporter): boolean {
  if (!isOwnedBy(session.buildingOwners, "yadernyi_arsenal", playerId)) return false;
  if (!facesWarWithSuperiorEnemy(session, playerId)) return false;
  const result = session.dispatch("activateYadernyiArsenal", playerId, {});
  if (result.ok) {
    reporter.step({
      action: "activateYadernyiArsenal",
      payload: {},
      sourceBuildingId: "yadernyi_arsenal",
      targetKind: "none",
      label: `Произвёл ядерное оружие в запас (${session.nuclearWeapons[playerId] ?? 0} в запасе).${marketSpendNote(result)}`,
    });
    return true;
  }
  return false;
}

/** Ядерный арсенал, применение накопленного ЯО — по прямому запросу: «может применяться и AI, если
 * в войне силы противника превосходят его собственные... бьёт не по своей территории, а противнику,
 * в первую очередь уничтожая столицу». Пробуется как ОТДЕЛЬНАЯ карта в основном цикле розыгрыша
 * (тот же приём, что и tryActivateKosmodrom выше, но ниже него по приоритету — тот уже занял
 * «высший приоритет» по отдельному прямому запросу) — у бомбы нет цены здания, только цена самого
 * удара (GameSession.launchNuclearStrike сам проверяет действие/деньги/войну/цель). Только ЛУЧШИЙ
 * (самый сильный) из превосходящих врагов — если таких несколько, бьёт туда, где реальнее всего
 * нужно переломить ход войны, а не по первому попавшемуся. */
function tryLaunchNuclearStrike(session: GameSession, playerId: number, reporter: Reporter): boolean {
  if ((session.nuclearWeapons[playerId] ?? 0) <= 0) return false;
  const myPower = militaryPower(session, playerId);
  const enemyId = session.players
    .filter((p) => p.id !== playerId && session.relationOf(playerId, p.id).war && militaryPower(session, p.id) > myPower)
    .sort((a, b) => militaryPower(session, b.id) - militaryPower(session, a.id))[0]?.id;
  if (enemyId === undefined) return false;
  const target = session.capitalCityOf(enemyId) ?? session.cities.find((c) => c.playerId === enemyId);
  if (!target) return false;
  const payload = { col: target.col, row: target.row };
  const result = session.dispatch("launchNuclearStrike", playerId, payload);
  if (result.ok) {
    reporter.step({
      action: "launchNuclearStrike",
      payload,
      sourceBuildingId: "yadernyi_arsenal",
      targetKind: "hex",
      targetCol: target.col,
      targetRow: target.row,
      label: `Нанёс ядерный удар по (${target.col},${target.row}) — ${result.hint ?? ""}`,
    });
    return true;
  }
  return false;
}

/** BFS-компонента гексов, удовлетворяющих `passable` (та же обёртка hexNeighborsWrapped/«земля
 * круглая», что и everywhere в этом файле) — общий примитив для «острова без выхода к морю» ниже. */
function tileComponent(passable: (col: number, row: number) => boolean, ...starts: [number, number][]): Set<string> {
  const seen = new Set<string>();
  const stack: [number, number][] = [];
  for (const [c, r] of starts) {
    const key = `${c},${r}`;
    if (!seen.has(key)) {
      seen.add(key);
      stack.push([c, r]);
    }
  }
  while (stack.length) {
    const [c, r] = stack.pop()!;
    for (const [nc, nr] of hexNeighborsWrapped(c, r, MAP_WIDTH, MAP_HEIGHT)) {
      const nkey = `${nc},${nr}`;
      if (seen.has(nkey) || !passable(nc, nr)) continue;
      seen.add(nkey);
      stack.push([nc, nr]);
    }
  }
  return seen;
}

function landComponentOf(session: GameSession, col: number, row: number): Set<string> {
  return tileComponent((c, r) => session.isLandTile(c, r), [col, row]);
}

/** Морская клетка суши-виду («прибрежная») — та же формула, что и приватный GameSession.isCoastalSeaTile
 * (не экспортирован, поэтому продублировано здесь, тем же приёмом, что и everywhere в этом файле):
 * Галера (Э1) плавает только по такой сети, Каравелла (Э2, «Компас») — по любому морю. */
function isCoastalSea(session: GameSession, col: number, row: number): boolean {
  return session.isSeaTile(col, row) && hexNeighborsWrapped(col, row, MAP_WIDTH, MAP_HEIGHT).some(([nc, nr]) => session.isLandTile(nc, nr));
}

/** Достижима ли клетка `toCol,toRow` Галерой (Э1) от острова `fromLandComponent` — то есть существует
 * ли сплошная прибрежная морская сеть (см. isCoastalSea) от одного берега до другого, ни разу не
 * выходя в открытое море. Если нет — нужна Каравелла (Э2, «Компас»), см. shipTechNeededFor. */
function galleyCanReach(session: GameSession, fromLandComponent: Set<string>, toCol: number, toRow: number): boolean {
  const shores: [number, number][] = [];
  for (const key of fromLandComponent) {
    const [c, r] = key.split(",").map(Number);
    for (const [nc, nr] of hexNeighborsWrapped(c, r, MAP_WIDTH, MAP_HEIGHT)) {
      if (isCoastalSea(session, nc, nr)) shores.push([nc, nr]);
    }
  }
  if (!shores.length) return false;
  const coastalNet = tileComponent((c, r) => isCoastalSea(session, c, r), ...shores);
  return hexNeighborsWrapped(toCol, toRow, MAP_WIDTH, MAP_HEIGHT).some(([nc, nr]) => coastalNet.has(`${nc},${nr}`));
}

/** «Юнит заперт на острове, окружённом морем — ему не выйти» (по прямому запросу, живой баг-репорт).
 * Возвращает клетку, куда юнит реально хочет попасть, но не может по суше и своего корабля под ногами
 * у него нет — `null`, если юнит и так куда-то доедет сам (нет нужды в корабле) или ему вовсе некуда
 * податься (нет ни фронта войны, ни свободных для заселения регионов — тогда decideAndIssueUnitOrder
 * и так оставит его на месте, без всякого отношения к морю). Цель — тот же приоритет, что и у самого
 * decideAndIssueUnitOrder (сначала фронт войны, потом ближайший регион под заселение, см. §15.3). */
function strandedShipNeed(session: GameSession, playerId: number, unit: UnitInstance): { col: number; row: number } | null {
  if (unit.category === "ship") return null;
  if (session.units.some((u) => u.category === "ship" && u.playerId === playerId && u.col === unit.col && u.row === unit.row)) return null;
  const component = landComponentOf(session, unit.col, unit.row);

  const front = warFrontHex(session, playerId);
  if (front) return component.has(`${front.col},${front.row}`) ? null : front;

  let firstUnreachable: { col: number; row: number } | null = null;
  for (const { rc, rr } of unclaimedNearbyRegions(session, playerId)) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = rc * REGION_SIZE_X + dx;
        const row = rr * REGION_SIZE_Y + dy;
        if (!session.isLandTile(col, row)) continue;
        if (component.has(`${col},${row}`)) return null;
        if (!firstUnreachable) firstUnreachable = { col, row };
      }
    }
  }
  return firstUnreachable;
}

/** Юнит физически ОТРЕЗАН по суше ОТ ВСЕХ остальных своих городов (по прямому запросу — «если юнит
 * строится на островах, с которого нет доступа к другим городам, к нему нужно строить корабль, когда
 * будет возможность») — отдельное условие от `strandedShipNeed` выше: тот смотрит, может ли юнит
 * дойти до КОНКРЕТНОЙ цели (фронт/свободный регион) и не находит её вовсе, если целей сейчас нет;
 * это — про изоляцию от СВОИХ ГОРОДОВ саму по себе, безусловно, даже если юниту прямо сейчас
 * действительно некуда идти. Единственный город (сравнивать не с чем) — не считается изоляцией. */
function isIsolatedFromOwnCities(session: GameSession, playerId: number, unit: UnitInstance): boolean {
  if (unit.category === "ship") return false;
  const otherCities = myCities(session, playerId).filter((c) => c.id !== unit.cityId);
  if (!otherCities.length) return false;
  const component = landComponentOf(session, unit.col, unit.row);
  return !otherCities.some((c) => component.has(`${c.col},${c.row}`));
}

/** Технология, нужная застрявшему юниту (см. strandedShipNeed), чтобы для него вообще было кому его
 * перевезти — `null`, когда либо юнит не застрял, либо ему уже есть на чём выйти прямо сейчас. Сначала
 * «Мореплавание» (без неё не строится вообще ни один корабль), потом, если Галерой до цели по прибрежной
 * сети не добраться (см. galleyCanReach), «Компас» под Каравеллу — «если галерами в нужный район не
 * выйти», по прямому запросу дословно. */
function shipTechNeededFor(session: GameSession, playerId: number, unit: UnitInstance): string | null {
  const dest = strandedShipNeed(session, playerId, unit);
  if (!dest) return null;
  const researched = session.researchedTechs[playerId];
  if (!researched.has("Мореплавание")) return "Мореплавание";
  if (galleyCanReach(session, landComponentOf(session, unit.col, unit.row), dest.col, dest.row)) return null;
  return researched.has("Компас") ? null : "Компас";
}

/** Приоритет категории юнита для карты «Воин» (по прямому запросу):
 * 0. Застрял на острове без выхода к морю, а строить корабль уже можно (Мореплавание открыто, см.
 *    strandedShipNeed/shipTechNeededFor) — важнее даже обороны, иначе юнит так и простоит без дела.
 * 1. Оборонительные — если враг копит силы у границы (hasBorderThreat).
 * 2. Флот — 1 на город, но не больше 1/3 от общей армии кораблями (остальное — сухопутные).
 * 3. Штурмовые/Поддержка — в равной пропорции, начиная со Штурмовых.
 * Дальше — все прочие категории как запасной вариант (чтобы карта не блокировалась насмерть, если
 * все приоритетные варианты почему-то недоступны, напр. все города без выхода в море). Какой ИМЕННО
 * город получит новый корабль здесь не уточняется — решает общий перебор городов в tryBuildUnit
 * (ближайший к фронту, если война есть, иначе произвольный) — попадание рядом с конкретным застрявшим
 * юнитом не гарантировано, только рост флота в целом; более точный адресный выбор — на будущее. */
/** «Достаточно 1 обороняющегося на 3 наступающих» (по прямому запросу дословно) — минимум 1
 * защитник допускается всегда (даже если своих наступающих юнитов ещё вовсе нет — угроза на границе
 * не должна оставаться совсем без ответа), а дальше — не больше 1 защитника на каждые
 * DEFENSE_TO_OFFENSE_RATIO наступающих (штурмовые/мобильные/дальняя атака — все, кто реально может
 * атаковать, не только «Штурмовые»). */
const DEFENSE_TO_OFFENSE_RATIO = 3;

/** Отношения AI — «отказ [обещать не нападать] → максимальный приоритет обороны» (приоритетный
 * список, п.2): попросили недавно (см. wasAttemptedRecently), но защиты сейчас НЕТ (не согласился —
 * либо явно отказал, либо обещание с тех пор истекло/было нарушено) — сигнал уровнем выше
 * `hasBorderThreat`, снимает defenseCap целиком (см. decideUnitCategoryPriority ниже). */
function hasActiveNoAttackProtectionFrom(session: GameSession, playerId: number, neighborId: number): boolean {
  return session.activePromises.some((p) => p.kind === "noAttack" && p.by === neighborId && p.to === playerId);
}
function facesUnprotectedAggressiveNeighbor(session: GameSession, playerId: number): boolean {
  return neighborPlayerIds(session, playerId).some(
    (nid) => wasAttemptedRecently(session, playerId, nid, "promiseNoAttack") && !hasActiveNoAttackProtectionFrom(session, playerId, nid)
  );
}

function decideUnitCategoryPriority(session: GameSession, playerId: number): UnitCategory[] {
  const priority: UnitCategory[] = [];
  // П.0 «Флот — юнит застрял на острове»: поднимаем «Корабли» в самое начало, только если свободных
  // (без пассажира на борту) кораблей МЕНЬШЕ, чем юнитов, которых реально нужно вывезти (по прямому
  // уточнению — живой баг-репорт: «оранжевый строит 3-й корабль? Зачем — он может посадить юнита в
  // корабль, потом построить юнита и тоже посадить»): раньше условие было «есть хоть один
  // изолированный юнит» БЕЗ учёта уже построенного флота, и корабли продолжали строиться сверх всякой
  // надобности, пока изоляция не исчезнет — а исчезает она только ПОСЛЕ фактической перевозки.
  // Считаем не САМИ юниты, а разорванные КУСКИ суши, на которых они заперты (уникальные
  // land-компоненты): взаимная изоляция двух своих городов делает «застрявшими» сразу все юниты по
  // обе стороны, но перевозка нужна не каждому из них — достаточно одного свободного корабля на
  // каждый такой кусок, чтобы связать империю.
  const strandedComponents = new Set<string>();
  for (const u of session.units) {
    if (u.playerId !== playerId || u.category === "ship") continue;
    if (!strandedShipNeed(session, playerId, u) && !isIsolatedFromOwnCities(session, playerId, u)) continue;
    const component = [...landComponentOf(session, u.col, u.row)].sort()[0] ?? `${u.col},${u.row}`;
    strandedComponents.add(component);
  }
  const freeShips = session.units.filter(
    (u) => u.playerId === playerId && u.category === "ship" && !session.units.some((r) => r.category !== "ship" && r.col === u.col && r.row === u.row)
  ).length;
  if (session.researchedTechs[playerId].has("Мореплавание") && strandedComponents.size > 0 && freeShips < strandedComponents.size) {
    priority.push("ship");
  }

  const myUnits = session.units.filter((u) => u.playerId === playerId);
  const defenseCount = myUnits.filter((u) => u.category === "defense").length;
  const offenseCount = myUnits.filter((u) => u.category === "assault" || u.category === "mobile" || u.category === "ranged").length;
  // По прямому запросу — живой баг-репорт: «жёлтый строит только оборонительных юнитов — не
  // разумно, получается не планирует контратаковать; достаточно 1 обороняющегося на 3 наступающих,
  // дальше нужно готовить контратаку, иначе в одной обороне войны не победить» — раньше «Оборона»
  // получала абсолютный приоритет БЕЗ ограничения, пока где-то на границе есть угроза (`hasBorderThreat`
  // почти всегда истинна на протяжении всей войны) — армия могла до бесконечности состоять из одних
  // защитников. Теперь оборона в приоритете, только пока их количество ЕЩЁ НЕ набрало это
  // соотношение (см. DEFENSE_TO_OFFENSE_RATIO) — дальше приоритет естественно уходит на
  // штурмовые/поддержку ниже, готовя контрудар, а не копит защитников без счёта.
  const defenseCap = Math.max(1, Math.floor(offenseCount / DEFENSE_TO_OFFENSE_RATIO));
  // Отношения AI — отказ на «обещание не нападать» снимает defenseCap целиком (см.
  // facesUnprotectedAggressiveNeighbor выше) — максимальный приоритет обороны, а не просто «в
  // приоритете, пока не набралось соотношение».
  if ((hasBorderThreat(session, playerId) && defenseCount < defenseCap) || facesUnprotectedAggressiveNeighbor(session, playerId)) priority.push("defense");

  const shipCount = myUnits.filter((u) => u.category === "ship").length;
  // Единая норма флота (см. `requiredShipCount` — 1:2 у морских участков, 1:3 у остальных) — тот же
  // расчёт, что и у `tryEnsureMinimumShips`, которая для карты «Воин» пробуется ЕЩЁ РАНЬШЕ (до самого
  // `decideUnitCategoryPriority`, см. `tryPlayCardSlot`); эта строка — лишь запасной путь для случаев,
  // когда категория выбирается БЕЗ прохода через ту гарантию (например diagnostics/иные вызовы ниже).
  if (!priority.includes("ship") && shipCount < requiredShipCount(session, playerId)) priority.push("ship");

  const assaultCount = myUnits.filter((u) => u.category === "assault").length;
  const mobileCount = myUnits.filter((u) => u.category === "mobile").length;
  const rangedCount = myUnits.filter((u) => u.category === "ranged").length;
  const supportCount = myUnits.filter((u) => u.category === "support").length;

  // «План войны» (по прямому запросу — активный план ещё не набрал нужный перевес 1:1.5, см.
  // considerWarPlan/WAR_PLAN_FORCE_RATIO) — Штурмовые/Мобильные/Дальняя атака приоритетнее обычного
  // равновесия Штурмовые/Поддержка ниже (накопление перевеса важнее органического роста армии в обе
  // стороны поровну); среди этих трёх наступательных категорий первой идёт та, которой сейчас меньше
  // всего (по прямому запросу, живой баг-репорт — «зачем было строить два штурмовика подряд, к
  // штурмовикам лучше комбинировать поддержку или артиллерию»: раньше Штурмовые шли здесь ВСЕГДА
  // первыми безусловно, Мобильные вторыми, Дальняя атака в этой ветке вообще не участвовала — если
  // Мобильные были недоступны (нет технологии/ресурса), состав перевеса скатывался в одни Штурмовые
  // подряд); requiresNavy и своего флота ещё не хватит перевезти уже накопленную группу (по 1 месту на
  // юнита, грубая оценка — точной вместимости корабля в этой игре нет) — Флот приоритетнее обычной
  // квоты (той же категории, что и strandedShipNeed выше, но по другой причине).
  const plan = session.warPlans[playerId];
  const planNeedsForce = !!plan && countUnitsOf(session, playerId) < countUnitsOf(session, plan.targetId) * WAR_PLAN_FORCE_RATIO;
  if (planNeedsForce) {
    const offense: { cat: UnitCategory; count: number }[] = [
      { cat: "assault", count: assaultCount },
      { cat: "mobile", count: mobileCount },
      { cat: "ranged", count: rangedCount },
    ];
    offense.sort((a, b) => a.count - b.count);
    for (const { cat } of offense) if (!priority.includes(cat)) priority.push(cat);
    if (plan!.requiresNavy && !priority.includes("ship")) {
      const offenseUnits = assaultCount + mobileCount + rangedCount;
      if (shipCount < offenseUnits) priority.push("ship");
    }
  }

  // Обычная (без активного плана войны) наступательная квота — по прямому запросу расширена со
  // «Штурмовые/Поддержка поровну» до «Штурмовые/Поддержка/Дальняя атака поровну», той же причине, что
  // и выше: первой идёт категория, которой сейчас меньше всего, чтобы состав естественно чередовался,
  // а не рос одной категорией подряд.
  const offenseTail: { cat: UnitCategory; count: number }[] = [
    { cat: "assault", count: assaultCount },
    { cat: "support", count: supportCount },
    { cat: "ranged", count: rangedCount },
  ];
  offenseTail.sort((a, b) => a.count - b.count);
  for (const { cat } of offenseTail) if (!priority.includes(cat)) priority.push(cat);

  for (const c of CATEGORIES) if (!priority.includes(c)) priority.push(c);
  return applyStrategicPriorityToUnits(priority, computeStrategicPriority(session, playerId));
}

// === Управление юнитами — этап 2 (по прямому запросу — «научить AI управлять юнитами», движение и
// бой). Один приказ на юнит за ход, юнитам с уже активным moveOrder новый не выдаётся — сервер сам
// довозит юнита до цели за несколько циклов, если бюджета хода не хватило на весь путь сразу (см.
// ТЗ «маршрут длиннее одного бюджета хода продолжается автоматически»), так что достаточно выдать
// цель один раз. Никакой отдельной симуляции боя — commandUnit применяется по-настоящему (на клоне
// планирования, как и всё остальное в этом файле), поэтому исход атаки (урон, контрудар, бонус
// поддержки) всегда точный, не оценка. ============================================================

/** Штурмовые/Мобильные обрабатываются первыми (передний край, «Штурмовые ударяют первыми»),
 * Поддержка — следом, Дальняя атака/Корабли/Оборонительные — последними (держатся в тылу/на месте,
 * см. ЦИВА-ЖУРНАЛ §23 design-заметки по тактике). Порядок ОБРАБОТКИ, не порядок хода на карте —
 * при текущей мгновенной модели движения (не WeGo) это и есть практический эквивалент «идут первыми
 * в колонне»: их приказы применяются раньше, значит место для остальных освобождается/занимается в
 * первую очередь. */
const UNIT_ORDER_PRIORITY: Record<UnitCategory, number> = { assault: 0, mobile: 0, support: 1, ranged: 2, ship: 2, defense: 3 };

/** Приоритет целей дальней атаки/кораблей (по прямому запросу — «выбить максимум мобильных, потом
 * корабли, потом другую артиллерию, потом поддержку, потом уже солдат»). */
const RANGED_TARGET_PRIORITY: UnitCategory[] = ["mobile", "ship", "ranged", "support", "assault", "defense"];
/** Приоритет целей конницы (по прямому запросу — «бьёт по уязвимым юнитам чтоб выбить поддержку и
 * артиллерию»). */
const CAVALRY_TARGET_PRIORITY: UnitCategory[] = ["support", "ranged", "mobile", "ship", "assault", "defense"];

function scoreTargetForAttacker(attackerCategory: UnitCategory, targetCategory: UnitCategory): number {
  const list = attackerCategory === "ranged" || attackerCategory === "ship" ? RANGED_TARGET_PRIORITY : attackerCategory === "mobile" ? CAVALRY_TARGET_PRIORITY : null;
  if (!list) return 0; // Штурмовые/Оборонительные/Поддержка — цель не разбирается, бьют что в досягаемости
  const idx = list.indexOf(targetCategory);
  return idx === -1 ? 0 : list.length - idx; // раньше в списке приоритета = больше очков
}

interface AttackCandidate {
  col: number;
  row: number;
  score: number;
  isCity: boolean;
}

/** Все клетки в пределах реальной (с учётом технологий — effectiveAttackRange публичный) дальности
 * атаки юнита, где есть кого/что атаковать среди игроков, с которыми playerId сейчас в состоянии
 * войны — с очками по приоритету цели (см. scoreTargetForAttacker). Клетка со СВОИМ городом
 * противника (не только юнитом) получает наивысший приоритет всегда — «при штурме города все
 * усилия бросаются на город» (по прямому запросу); фактический бой на этой клетке всё равно решит
 * сервер — если там ещё стоит гарнизонный юнит, достанется сначала ему (см. commandUnit). */
function attackCandidatesFor(session: GameSession, playerId: number, unit: UnitInstance): AttackCandidate[] {
  const stats = statsFor(unit.category, unit.epoch);
  if (stats.attack <= 0) return [];
  const range = session.effectiveAttackRange(unit);
  const seen = new Set<string>();
  const out: AttackCandidate[] = [];
  const consider = (col: number, row: number, isCity: boolean, ownerId: number) => {
    if (!session.relationOf(playerId, ownerId).war) return;
    const key = `${col},${row}`;
    if (seen.has(key)) return;
    const dist = session.hexDistance(unit.col, unit.row, col, row, range + 1);
    if (dist > range) return;
    // Целеуказание (ТЗ 6.6, уже реализовано в commandUnit) — удар НЕ в упор требует своего юнита в
    // гексе, соседнем с целью, иначе dispatch честно откажет; проверяем здесь заранее, чтобы не
    // предпочесть цель без целеуказания цели В УПОР, которая реально доступна прямо сейчас.
    if (dist > 1) {
      const hasSpotter = session.units.some((u) => u.playerId === playerId && session.hexDistance(u.col, u.row, col, row, 2) <= 1);
      if (!hasSpotter) return;
    }
    seen.add(key);
    const defenders = session.unitsAt(col, row).filter((u) => u.playerId !== playerId);
    const score = isCity ? 1000 : Math.max(0, ...defenders.map((d) => scoreTargetForAttacker(unit.category, d.category)));
    out.push({ col, row, score, isCity });
  };
  for (const u of session.units) if (u.playerId !== playerId) consider(u.col, u.row, false, u.playerId);
  for (const c of session.cities) if (c.playerId !== playerId) consider(c.col, c.row, true, c.playerId);
  return out;
}

/** Симулирует исход атаки НА КЛОНЕ (бой в этой игре детерминированный, без `rng()` — см.
 * `GameSession.resolveCombat`, весь урон считается напрямую по статам/поддержке) — по прямому
 * запросу: «нужно учитывать при плане нападения, удастся ли серией атак уничтожить юнита — если нет,
 * лучше занять оборону до появления союзных юнитов». Раз бой детерминирован, клон даёт ТОЧНЫЙ, а не
 * приблизительный исход (в т.ч. уже учитывает бонус поддержки — «добивание»/«есть поддержка»
 * проходят сами собой, без отдельного кода под них). Только для юнитов — города осаждаются по буферу
 * гарнизона ПОСТЕПЕННО по дизайну (см. resolveCombat), «убить с одного удара» для них не показатель,
 * вызывающий код не должен применять эту проверку к целям-городам.
 *
 * `targetRetreated` (по прямому запросу, живой баг-репорт — «у оранжевого было множество войск, он
 * мог взять и город, и юнитов уничтожить, но получилось уничтожить лишь одного») — раньше функция не
 * знала о принудительном отступлении защитника (`GameSession.resolveCombat`: удар в упор, где
 * атакующий переживает контрудар И его оставшееся HP ≥ оставшегося HP защитника, сдвигает защитника
 * на соседний гекс, а если сдвинуться некуда — добивает) — вызывающий код (`decideAndIssueUnitOrder`)
 * трактовал ЛЮБОЙ исход «атакующий выжил» как оправданную «безопасную» атаку, включая случаи, где
 * удар не убивает и не сдвигает защитника ВООБЩЕ НИКАК — просто царапина, которая полностью исчезает
 * на границе цикла (HP юнитов сбрасывается на полное, см. `comboKillAvailable`) без всякого следа.
 * Несколько юнитов дальше по очереди раз за разом наносили именно такие «пустые» удары по разным
 * целям вместо того, чтобы либо сосредоточить огонь на одной цели ради настоящего убийства/отступления,
 * либо вообще не атаковать. */
function simulateAttackOutcome(
  session: GameSession,
  playerId: number,
  unit: UnitInstance,
  target: { col: number; row: number }
): { targetDied: boolean; targetRetreated: boolean; attackerSurvived: boolean } | null {
  const defenders = session.units.filter((u) => u.col === target.col && u.row === target.row && u.playerId !== playerId);
  if (!defenders.length) return null;
  const targetUnit = defenders.slice().sort((a, b) => b.hp - a.hp)[0];
  const clone = GameSession.fromJSON(session.id, structuredClone(session.toJSON()));
  const result = clone.dispatch("commandUnit", playerId, { unitId: unit.id, col: target.col, row: target.row });
  if (!result.ok) return null;
  const targetAfter = clone.units.find((u) => u.id === targetUnit.id);
  return {
    targetDied: !targetAfter,
    targetRetreated: !!targetAfter && (targetAfter.col !== target.col || targetAfter.row !== target.row),
    attackerSurvived: clone.units.some((u) => u.id === unit.id),
  };
}

/** «Комбинированное добивание» (по прямому запросу §3.2 — исправление собственной ошибки: HP юнитов
 * сбрасывается на полное В НАЧАЛЕ КАЖДОГО ЦИКЛА, GameSession.resolveCycleBoundary — рана НЕ переживает
 * границу цикла, «добьём в следующем цикле» физически не работает; добивание имеет смысл СТРОГО в
 * пределах ЭТОГО ЖЕ хода) — удар неудачника-одиночки (`unit`) всё равно стоит наносить, если среди ещё
 * не походивших в этот ход своих юнитов в пределах дальности до той же цели найдётся последовательность
 * ударов (пробуется на ОДНОМ клоне, порядок кандидатов — тот же UNIT_ORDER_PRIORITY, что и у реальной
 * очереди `runMilitaryOrders`, чтобы предсказание совпадало с тем, что реально произойдёт этим же
 * ходом), гарантированно добивающая цель — И суммарная ЦЕННОСТЬ погибших в процессе своих юнитов
 * (`valueOfUnit`) не превышает ценности убитой цели (не размениваем дорогого юнита на дешёвого).
 *
 * [ИСПРАВЛЕНО, тот же баг-репорт, что у `simulateAttackOutcome` выше — «уничтожен лишь один юнит»] —
 * «добита» цель проверялась по КЛЕТКЕ (`target.col`/`target.row`), а не по id самой цели: если первый
 * удар цепочки не убивал защитника, а заставлял его ОТСТУПИТЬ (`GameSession.resolveCombat`, тот же
 * механизм отступления, что и в `simulateAttackOutcome`), клетка тоже пустела — код ошибочно трактовал
 * это как «уже добит» (`break`) и в итоге сообщал вызывающему коду `targetDead: true`, хотя цель на
 * самом деле жива и просто передвинулась. Теперь и промежуточная, и финальная проверка идут по id
 * самой цели (`targetUnit.id`), а не по клетке — отступление больше не маскируется под смерть; каждый
 * следующий удар цепочки при этом целится в ТЕКУЩУЮ позицию цели (`targetNow`), а не в исходную. */
function comboKillAvailable(session: GameSession, playerId: number, unit: UnitInstance, target: { col: number; row: number }): boolean {
  const defenders = session.units.filter((u) => u.col === target.col && u.row === target.row && u.playerId !== playerId);
  const targetUnit = defenders.slice().sort((a, b) => b.hp - a.hp)[0];
  if (!targetUnit) return false;
  const targetValue = valueOfUnit(targetUnit);
  const helpers = session.units
    .filter((u) => u.playerId === playerId && u.id !== unit.id && !u.moveOrder && !session.outOfMoveThisCycle.has(u.id))
    .filter((u) => {
      const stats = statsFor(u.category, u.epoch);
      if (stats.attack <= 0) return false;
      const range = session.effectiveAttackRange(u);
      return session.hexDistance(u.col, u.row, target.col, target.row, range + 1) <= range;
    })
    .sort((a, b) => (UNIT_ORDER_PRIORITY[a.category] ?? 9) - (UNIT_ORDER_PRIORITY[b.category] ?? 9));
  if (!helpers.length) return false;

  const clone = GameSession.fromJSON(session.id, structuredClone(session.toJSON()));
  let lostValue = 0;
  const first = clone.dispatch("commandUnit", playerId, { unitId: unit.id, col: target.col, row: target.row });
  if (!first.ok) return false;
  if (!clone.units.some((u) => u.id === unit.id)) lostValue += valueOfUnit(unit);
  for (const helper of helpers) {
    const targetNow = clone.units.find((u) => u.id === targetUnit.id);
    if (!targetNow) break; // уже добит
    if (!clone.units.some((u) => u.id === helper.id)) continue; // сам погиб раньше в этой же цепочке
    const result = clone.dispatch("commandUnit", playerId, { unitId: helper.id, col: targetNow.col, row: targetNow.row });
    if (!result.ok) continue;
    if (!clone.units.some((u) => u.id === helper.id)) lostValue += valueOfUnit(helper);
  }
  const targetDead = !clone.units.some((u) => u.id === targetUnit.id);
  return targetDead && lostValue <= targetValue;
}

/** «Наиболее ценный» фронт при войне на несколько направлений (по прямому запросу — «взвешивается
 * наиболее ценный по ресурсам, торговым путям и населению») — приближено населением города (проще
 * всего публично доступная мера важности региона); все свободные юниты выдвигаются на этот ОДИН
 * фронт разом (полноценное распределение по нескольким одновременным направлениям — отдельная
 * задача на будущее, см. ЦИВА-ЖУРНАЛ §23). */
function nearestWarTargetHex(session: GameSession, playerId: number): { col: number; row: number } | null {
  const enemyCities = session.cities.filter((c) => c.playerId !== playerId && session.relationOf(playerId, c.playerId).war);
  if (!enemyCities.length) return null;
  return enemyCities.slice().sort((a, b) => b.population - a.population)[0];
}

/** Регион (сетка регионов), где у противника, с которым идёт война, реально СКОПЛЕНО больше всего
 * военной силы (сумма ценности юнитов, `valueOfUnit`, — та же метрика «сила», что и everywhere else)
 * — по прямому запросу: «нужно смотреть, в каком именно регионе у противника больше сил, и строить
 * там (или в соседнем) военных юнитов», вместо прежнего приближения «где у противника самый
 * населённый ГОРОД» (нередко далёкий от реальной линии соприкосновения войск). Возвращает позицию
 * одного из юнитов этого региона как ориентир — `null`, если у противников не видно вообще ни одного
 * юнита (война объявлена, но боевых действий ещё не было — тогда вызывающий код сам решает, падать
 * ли на nearestWarTargetHex). */
function strongestEnemyForceHex(session: GameSession, playerId: number): { col: number; row: number; total: number } | null {
  const enemyUnits = session.units.filter((u) => u.playerId !== playerId && session.relationOf(playerId, u.playerId).war);
  if (!enemyUnits.length) return null;
  const byRegion = new Map<string, { total: number; col: number; row: number }>();
  for (const u of enemyUnits) {
    const key = `${Math.floor(u.col / REGION_SIZE_X)},${Math.floor(u.row / REGION_SIZE_Y)}`;
    const entry = byRegion.get(key) ?? { total: 0, col: u.col, row: u.row };
    entry.total += valueOfUnit(u);
    byRegion.set(key, entry);
  }
  // «Резервы идут туда, где нехватка больше» (по прямому запросу §3.3) — ранжируем не по чистому
  // скоплению врага, а по ДЕФИЦИТУ (вражеская сила минус МОЯ в том же регионе): регион, где враг
  // сосредоточен, но я и сам там хорошо обороняюсь, менее приоритетен, чем регион с меньшим скоплением
  // врага, но вовсе без защитников — иначе резервы вечно шли бы на уже укреплённый участок, оставляя
  // реально дырявую границу без внимания.
  let best: { total: number; col: number; row: number } | null = null;
  let bestDeficit = -Infinity;
  for (const [key, entry] of byRegion) {
    let myForceHere = 0;
    for (const u of session.units) if (u.playerId === playerId && `${Math.floor(u.col / REGION_SIZE_X)},${Math.floor(u.row / REGION_SIZE_Y)}` === key) myForceHere += valueOfUnit(u);
    const deficit = entry.total - myForceHere;
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = entry;
    }
  }
  return best;
}

/** «Фронт» для решений о постройке/движении войск — по прямому запросу предпочитает регион реального
 * скопления вражеских войск (см. strongestEnemyForceHex); если противник ещё нигде не показался
 * (война только объявлена, боевых действий не было) — тот же запасной ориентир, что и раньше, самый
 * населённый вражеский город (см. nearestWarTargetHex), чтобы фронт вообще было куда назначить —
 * `total` в этом случае `undefined` («сила противника здесь ещё не известна», см. `marchIsSuicidal`
 * ниже — без известной силы марш не блокируется, ведь оценивать реально не по чему). */
/** «Вернуть захваченный город» (по прямому запросу §3.1) — свой БЫВШИЙ город (журнал `session.
 * recentCityLosses`, GameSession.transferCity/pruneCityLossJournal), сейчас у игрока, с которым ИДЁТ
 * война прямо сейчас (мир с текущим владельцем — марш туда снова стал бы атакой без войны, не повод) —
 * приоритет ВЫШЕ обычного скопления вражеской силы (§3.3): не просто «где врага больше», а «что
 * забрали лично у меня». Несколько таких городов сразу — берётся САМЫЙ СТАРЫЙ (дольше всего в руках
 * врага). `total` — реальная сила противника В ЭТОМ регионе (та же региональная сумма, что и
 * strongestEnemyForceHex, не `undefined`) — марш на пустой, брошенный без гарнизона город не
 * заблокируется `marchIsSuicidal` (0 > ничего не превышает), а на реально укреплённый — заблокируется
 * как обычно, если сил объективно не хватает. */
function recapturePriorityHex(session: GameSession, playerId: number): { col: number; row: number; total: number } | null {
  const mine = session.recentCityLosses.filter((loss) => loss.oldOwnerId === playerId).sort((a, b) => a.cycle - b.cycle);
  for (const loss of mine) {
    const city = session.cities.find((c) => c.id === loss.cityId);
    if (!city || city.playerId === playerId || !session.relationOf(playerId, city.playerId).war) continue;
    const rc = Math.floor(city.col / REGION_SIZE_X);
    const rr = Math.floor(city.row / REGION_SIZE_Y);
    let total = 0;
    for (const u of session.units) if (u.playerId === city.playerId && Math.floor(u.col / REGION_SIZE_X) === rc && Math.floor(u.row / REGION_SIZE_Y) === rr) total += valueOfUnit(u);
    return { col: city.col, row: city.row, total };
  }
  return null;
}

function warFrontHex(session: GameSession, playerId: number): { col: number; row: number; total?: number } | null {
  return recapturePriorityHex(session, playerId) ?? strongestEnemyForceHex(session, playerId) ?? nearestWarTargetHex(session, playerId);
}

// === ЭКСПЕРИМЕНТАЛЬНАЯ регионная классификация войны (задел под сравнение алгоритмов) ===========
//
// По прямому запросу заказчика — «AI распыляет силы и строит юнитов не там где надо»: живой тест на
// реальных сейвах (`gw2ve6.json`, 2 одновременные войны) показал, что `warFrontHex`/`strongestEnemyForceHex`
// выше считают ОДИН глобальный «фронт» (сильнейшее скопление ЛЮБОГО воюющего противника) — при войне
// на 2+ фронта разом все свободные юниты и вся приоритетная постройка тянутся к ОДНОМУ, самому
// сильному скоплению врага, а второй фронт (даже физически более БЛИЗКИЙ конкретному юниту/городу)
// не получает вообще никакого внимания, пока не «победит» в сравнении суммарной силы. Ниже —
// НЕ замена существующей логике (`warFrontHex` и всё, что на ней завязано — `armyTargetHex`/
// `fleetTargetHex`/staging остаются как есть, они уже per-army/per-fleet, то есть свои для каждой
// кампании), а ДОПОЛНИТЕЛЬНЫЙ слой для юнитов и городов, которые ни в какую армию/флот не входят —
// используется ТОЛЬКО когда `newWarAiEnabled(session)` истинно (см. её doc), чтобы сравнить обе
// версии на одном и том же реальном сейве без риска для уже работающей продакшен-логики.
/** Включатель экспериментальной ветки — намеренно НЕ константа и НЕ настройка игры, а свойство
 * самого объекта сессии (`(session as any).__newWarAI`), проставляемое ТОЛЬКО тестовым скриптом
 * сравнения (`_war_test_lib.ts`) перед прогоном партии. В обычной игре (человек или сервер) это
 * свойство никогда не устанавливается, поэтому весь блок ниже не влияет на настоящих игроков, пока
 * эксперимент не подтверждён и код не перенесён в основной путь по итогам сравнения. */
function newWarAiEnabled(session: GameSession): boolean {
  return (session as any).__newWarAI === true;
}

/** Регион (сетка регионов) реального скопления силы КОНКРЕТНОГО врага `enemyId` — тот же принцип,
 * что `strongestEnemyForceHex`, но БЕЗ смешивания сразу всех воюющих противников в одну сумму: при
 * 2+ одновременных войнах у каждого врага теперь СВОЙ отдельный ориентир, не общий на всех. */
function enemyForceHexFor(session: GameSession, enemyId: number): { col: number; row: number; total: number } | null {
  const enemyUnits = session.units.filter((u) => u.playerId === enemyId);
  if (!enemyUnits.length) return null;
  const byRegion = new Map<string, { total: number; col: number; row: number }>();
  for (const u of enemyUnits) {
    const key = `${Math.floor(u.col / REGION_SIZE_X)},${Math.floor(u.row / REGION_SIZE_Y)}`;
    const entry = byRegion.get(key) ?? { total: 0, col: u.col, row: u.row };
    entry.total += valueOfUnit(u);
    byRegion.set(key, entry);
  }
  let best: { total: number; col: number; row: number } | null = null;
  for (const entry of byRegion.values()) if (!best || entry.total > best.total) best = entry;
  return best;
}
/** Ближайший вражеский ГОРОД конкретного `enemyId` (не любого воюющего) — тот же фолбэк-принцип,
 * что `nearestWarTargetHex`, но per-enemy и по РАССТОЯНИЮ от `fromCol/fromRow`, а не по населению —
 * «ближайшая цель этого конкретного фронта», не «самый жирный город в целом на всей карте». */
function nearestEnemyCityHexFor(session: GameSession, enemyId: number, fromCol: number, fromRow: number): { col: number; row: number } | null {
  const enemyCities = session.cities.filter((c) => c.playerId === enemyId);
  if (!enemyCities.length) return null;
  return enemyCities.slice().sort((a, b) => session.hexDistance(fromCol, fromRow, a.col, a.row, 40) - session.hexDistance(fromCol, fromRow, b.col, b.row, 40))[0];
}

/** По прямому запросу — «раздельный фронтир на каждого врага»: вместо ОДНОГО глобального
 * `warFrontHex` (сильнейшее скопление ЛЮБОГО противника), каждый юнит без армии/флота нацеливается
 * на БЛИЖАЙШИЙ К НЕМУ САМОМУ фронт СРЕДИ ВСЕХ активных врагов — так второй (более слабый суммарно,
 * но физически более близкий этому конкретному юниту) фронт тоже получает подкрепления, а не
 * остаётся голым, пока не «победит» первый в сравнении суммарной силы по всей карте. Возврат домой
 * за потерянным городом (`recapturePriorityHex`) — уже per-enemy по своей природе (конкретный
 * захваченный город одного конкретного врага), поэтому проверяется первым, поверх этой логики. Нет
 * ни одного активного врага — обычный фолбэк `warFrontHex` (нейтральный маршрут, §3.4 «застолбить
 * регион» и т.п. уже сами разбираются с этим случаем). */
function nearestFrontForUnit(session: GameSession, playerId: number, unit: UnitInstance): { col: number; row: number; total?: number } | null {
  const recapture = recapturePriorityHex(session, playerId);
  if (recapture) return recapture;
  const enemies = session.players.filter((p) => p.id !== playerId && !session.eliminatedPlayers.has(p.id) && session.relationOf(playerId, p.id).war);
  if (!enemies.length) return warFrontHex(session, playerId);
  let best: { col: number; row: number; total?: number } | null = null;
  let bestDist = Infinity;
  for (const e of enemies) {
    const hex = enemyForceHexFor(session, e.id) ?? nearestEnemyCityHexFor(session, e.id, unit.col, unit.row);
    if (!hex) continue;
    const d = session.hexDistance(unit.col, unit.row, hex.col, hex.row, 40);
    if (d < bestDist) {
      bestDist = d;
      best = hex;
    }
  }
  return best ?? warFrontHex(session, playerId);
}

/** Зоны войны (по прямому запросу заказчика — Тыл/Зона напряжения/Прифронтовая/Фронтир/Осаждённый
 * город) — используется для приоритета выбора ГОРОДА при постройке юнита И для очереди категорий по
 * зоне (см. `tryBuildUnitByZone` ниже): 0 = Осаждённый (свой город, где враг физически стоит в том же
 * регионе — реальный шанс потерять его СЕЙЧАС), 1 = Прифронтовая (свой город, регион которого граничит
 * с регионом, где у КАКОГО-ТО активного врага есть юниты/город — тот регион и есть её «Фронтир»),
 * 2 = Зона напряжения (свой город, регион которого граничит с регионом, где у любого игрока — не
 * обязательно врага — превосходство сил ×2 над моим тут же, или граничит с совсем ничейным регионом),
 * 3 = Тыл (всё остальное). Меньшее число — выше приоритет постройки. `frontierRegions` — ВСЕ соседние
 * регионы, из-за которых город получил тир 1 (нужно `tryBuildUnitByZone`, чтобы решить, соединена ли
 * Прифронтовая зона с Фронтиром сушей или морем — см. её doc); пусто для тиров 0/2/3. */
function warZoneInfoFor(
  session: GameSession,
  playerId: number,
  city: { regionCol: number; regionRow: number }
): { tier: 0 | 1 | 2 | 3; frontierRegions: { rc: number; rr: number }[] } {
  const rc = city.regionCol;
  const rr = city.regionRow;
  if (unitsInRegion(session, rc, rr).some((u) => u.playerId !== playerId && session.relationOf(playerId, u.playerId).war)) return { tier: 0, frontierRegions: [] };
  const neighbors = REGION_NEIGHBOR_OFFSETS.map(([drc, drr]) => ({ rc: wrapRegionCol(rc + drc), rr: rr + drr })).filter((n) => n.rr >= 0 && n.rr < REGION_GRID_H);
  const frontierRegions: { rc: number; rr: number }[] = [];
  let sawTension = false;
  const myForceHere = unitsInRegion(session, rc, rr)
    .filter((u) => u.playerId === playerId)
    .reduce((s, u) => s + valueOfUnit(u), 0);
  for (const n of neighbors) {
    const unitsThere = unitsInRegion(session, n.rc, n.rr);
    const hasEnemyCity = session.cities.some((c) => c.regionCol === n.rc && c.regionRow === n.rr && c.playerId !== playerId && session.relationOf(playerId, c.playerId).war);
    if (hasEnemyCity || unitsThere.some((u) => u.playerId !== playerId && session.relationOf(playerId, u.playerId).war)) frontierRegions.push(n);
    if (!unitsThere.length && !session.cities.some((c) => c.regionCol === n.rc && c.regionRow === n.rr)) sawTension = true;
    for (const otherId of new Set(unitsThere.filter((u) => u.playerId !== playerId).map((u) => u.playerId))) {
      const theirForce = unitsThere.filter((u) => u.playerId === otherId).reduce((s, u) => s + valueOfUnit(u), 0);
      if (theirForce > myForceHere * 2) sawTension = true;
    }
  }
  if (frontierRegions.length) return { tier: 1, frontierRegions };
  if (sawTension) return { tier: 2, frontierRegions: [] };
  return { tier: 3, frontierRegions: [] };
}
function warZoneTierOf(session: GameSession, playerId: number, city: { regionCol: number; regionRow: number }): 0 | 1 | 2 | 3 {
  return warZoneInfoFor(session, playerId, city).tier;
}

/** Шаблон постройки по зоне (по прямому запросу заказчика — «сделаем акцент строительства юнитов на
 * конкретные регионы», список категорий на каждую зону, боевая/движенческая логика юнитов НЕ меняется
 * вовсе) — три именованных шаблона, каждый используется как круговая очередь (см.
 * `GameSession.warZoneBuildIndex`, `tryBuildUnitByZone`):
 * - `rear` (Тыл, тир 3) — Оборонительный, Корабль, Артиллерия, Поддержка, Корабль, Мобильный.
 * - `frontlineLand` (Прифронтовая/Зона напряжения, когда Фронтир соединён с городом сушей, ИЛИ у Зоны
 *   напряжения — своего Фронтира нет вовсе, см. `warZoneBuildKeyFor`) — Штурмовой, Поддержка,
 *   Мобильный, Артиллерия, Поддержка, Корабль, Штурмовой.
 * - `frontlineSea` (Прифронтовая, когда ВСЕ её Фронтиры отделены морем — нет сухопутного пути от
 *   города ни к одному из них) — Штурмовой, Артиллерия, Корабль, Артиллерия, Корабль, Поддержка,
 *   Корабль.
 * Осаждённый город (тир 0) своего шаблона не имеет — обслуживается прежней логикой (`decideUnitCategoryPriority`,
 * без изменений) уже за счёт того, что и раньше сортировался первым по расстоянию. */
type ZoneBuildKey = "rear" | "frontlineLand" | "frontlineSea";
const ZONE_BUILD_ORDER: Record<ZoneBuildKey, UnitCategory[]> = {
  rear: ["defense", "ship", "ranged", "support", "ship", "mobile"],
  frontlineLand: ["assault", "support", "mobile", "ranged", "support", "ship", "assault"],
  frontlineSea: ["assault", "ranged", "ship", "ranged", "ship", "support", "ship"],
};

/** Соединена ли Прифронтовая зона с её Фронтиром сушей — хотя бы один из `frontierRegions` имеет
 * земляной тайл в ТОЙ ЖЕ сухопутной компоненте (`landComponentOf`), что и сам город: тогда штурмовой
 * юнит может дойти до фронта пешком, без корабля, и шаблон `frontlineLand` уместен. Если ни один
 * Фронтир не достижим по суше — только `frontlineSea` (корабли неизбежны, штурмовой без них бесполезен
 * дальше берега). Регион без единого сухопутного тайла (весь океан) считается недостижимым по суше. */
function frontierConnectedByLand(session: GameSession, city: { col: number; row: number }, frontierRegions: { rc: number; rr: number }[]): boolean {
  const component = landComponentOf(session, city.col, city.row);
  for (const { rc, rr } of frontierRegions) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = rc * REGION_SIZE_X + dx;
        const row = rr * REGION_SIZE_Y + dy;
        if (component.has(`${col},${row}`)) return true;
      }
    }
  }
  return false;
}

/** Какой шаблон (см. `ZONE_BUILD_ORDER`) обслуживает тир 1/2/3 у конкретного города — тиру 0
 * (Осаждённый) шаблона нет, `null`. Зона напряжения по прямому уточнению использует ТОТ ЖЕ шаблон, что
 * и Прифронтовая — общий `frontlineLand` (у неё, в отличие от Прифронтовой, нет привязанного Фронтира,
 * сухопутность проверять не к чему). */
function warZoneBuildKeyFor(session: GameSession, city: City, info: { tier: 0 | 1 | 2 | 3; frontierRegions: { rc: number; rr: number }[] }): ZoneBuildKey | null {
  if (info.tier === 1) return frontierConnectedByLand(session, city, info.frontierRegions) ? "frontlineLand" : "frontlineSea";
  if (info.tier === 2) return "frontlineLand";
  if (info.tier === 3) return "rear";
  return null;
}

/** Требуемое число кораблей игрока (по прямому запросу — живой баг-репорт: «почему AI не строят
 * корабли? За всю партию ни одного даже у морских держав»; уточнение соотношений — «на морские клетки
 * отделённые от суши других игроков 1 корабль на 2 юнита сухопутного, для остальных участков
 * гарантировать 1 корабль на 3 юнитов сухопутных»). Каждый сухопутный юнит относится к «морскому»
 * (более строгая квота 1:2) участку, если его ближайший свой город классифицируется как `frontlineSea`
 * (тир 1, ВСЕ фронтиры зоны отделены морем — см. `warZoneBuildKeyFor`/`frontierConnectedByLand`, тот
 * же признак, что определяет шаблон постройки зоны); иначе — «остальные участки», квота 1:3. Итог —
 * сумма округлённых вверх долей по каждой группе, не общий плоский счёт по всей армии сразу. */
function requiredShipCount(session: GameSession, playerId: number): number {
  const cities = myCities(session, playerId);
  if (!cities.length) return 0;
  const seaSeparatedCityIds = new Set<number>();
  for (const tier of [1, 2, 3] as const) {
    const citiesInTier = cities.filter((c) => warZoneTierOf(session, playerId, c) === tier);
    if (!citiesInTier.length) continue;
    const info = warZoneInfoFor(session, playerId, citiesInTier[0]);
    if (warZoneBuildKeyFor(session, citiesInTier[0], info) === "frontlineSea") {
      for (const c of citiesInTier) seaSeparatedCityIds.add(c.id);
    }
  }
  let seaSeparatedLand = 0;
  let otherLand = 0;
  for (const u of session.units) {
    if (u.playerId !== playerId || u.category === "ship") continue;
    let nearest: City | null = null;
    let nearestDist = Infinity;
    for (const c of cities) {
      const d = session.hexDistance(u.col, u.row, c.col, c.row);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = c;
      }
    }
    if (nearest && seaSeparatedCityIds.has(nearest.id)) seaSeparatedLand++;
    else otherLand++;
  }
  return Math.ceil(seaSeparatedLand / 2) + Math.ceil(otherLand / 3);
}

/** Гарантия минимального флота (см. `requiredShipCount` выше) — независимо от того, чья сейчас
 * очередь в круговом шаблоне зоны (`ZONE_BUILD_ORDER`/`tryBuildUnitByZone`, где «Корабль» — лишь 1
 * позиция из 6-7 и может подолгу не доходить своей очереди, особенно если счётчик обнуляется при
 * каждой смене ключа ротации — война началась/закончилась, фронт сменил геометрию). Пробуется ПЕРВЫМ
 * в цепочке построения юнита картой «Воин», раньше очереди армий и зонной ротации — не хватает
 * кораблей до нормы, строим корабль СЕЙЧАС же; норма уже выполнена — тут же уступает место обычной
 * логике без единого изменения в её поведении. */
function tryEnsureMinimumShips(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (!session.researchedTechs[playerId].has("Мореплавание")) return false;
  const shipCount = session.units.filter((u) => u.playerId === playerId && u.category === "ship").length;
  if (shipCount >= requiredShipCount(session, playerId)) return false;
  const currentEpoch = bestUnitEpochFor(session, playerId, "ship");
  const unitsOfCategory = UNITS.filter((u) => u.category === "ship" && u.epoch === currentEpoch);
  if (!unitsOfCategory.length) return false;
  const front = warFrontHex(session, playerId);
  const cities = myCities(session, playerId)
    .slice()
    .sort((a, b) => (front ? session.hexDistance(a.col, a.row, front.col, front.row) - session.hexDistance(b.col, b.row, front.col, front.row) : 0));
  for (const city of cities) {
    for (const unit of unitsOfCategory) {
      const payload = { slotIndex, cityId: city.id, unitId: unit.id };
      const result = session.dispatch("buildUnitCard", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "buildUnitCard",
          payload,
          cardSlotIndex: slotIndex,
          cardId,
          targetKind: "city",
          targetCityId: city.id,
          label: `Построил юнита «${unit.id}» (Корабли) в городе (${city.col},${city.row}) — минимальная квота флота.${marketSpendNote(result)}`,
        });
        return true;
      }
    }
  }
  return false;
}

/** Одинокий марш к фронту опасен без всякого смысла (по прямому запросу — живой баг-репорт: «новый
 * Секироносец может уничтожить лучника, но туда ещё нужно дойти, а там превосходящие силы, которые
 * могут уничтожить его на подступе — нет смысла идти атаковать превосходящие силы там, где нет
 * родного города для обороны») — марш ЭТОГО юнита к фронту считается самоубийственным, если известная
 * сила противника в регионе фронта (см. warFrontHex/strongestEnemyForceHex) превышает ценность самого
 * юнита В СТОЛЬКО РАЗ, сколько задаёт порог (`SUICIDAL_MARCH_RATIO`) — порог зависит от того, есть ли
 * рядом с фронтом (свой ИЛИ приграничный регион, см. borderRegionsOf/ownedRegionsOf) свой город: город
 * рядом даёт куда отступить чинить раны или спрятаться гарнизоном, поэтому порог там мягче, но НЕ
 * снимается целиком — простое соседство региона на сетке (тем более с учётом заворота карты) само по
 * себе не спасёт от-настоящего разгрома силами в разы больше, даже если технически «рядом» есть
 * город (живой пример: скопление противника впятеро сильнее одного нового «Секироносца», и город
 * действительно оказался в 2-3 гексах — но этого недостаточно, когда перевес настолько велик). Сила
 * противника НЕ известна (война только объявлена, боевых действий ещё не было,
 * `warFrontHex.total===undefined`) — марш не блокируется вовсе, оценивать реально не по чему, а
 * закрепиться на будущем фронте всё равно нужно с чего-то начать. */
const SUICIDAL_MARCH_RATIO_NO_CITY = 1.5;
const SUICIDAL_MARCH_RATIO_WITH_CITY = 3;
function marchIsSuicidal(session: GameSession, playerId: number, unit: UnitInstance, front: { col: number; row: number; total?: number }): boolean {
  if (front.total === undefined) return false;
  const frontRegion = { rc: Math.floor(front.col / REGION_SIZE_X), rr: Math.floor(front.row / REGION_SIZE_Y) };
  const key = `${frontRegion.rc},${frontRegion.rr}`;
  const cityNearby = ownedRegionsOf(session, playerId).has(key) || borderRegionsOf(session, playerId).some((r) => r.rc === frontRegion.rc && r.rr === frontRegion.rr);
  const ratio = cityNearby ? SUICIDAL_MARCH_RATIO_WITH_CITY : SUICIDAL_MARCH_RATIO_NO_CITY;
  return front.total > valueOfUnit(unit) * ratio;
}

function nearestOwnCity(session: GameSession, playerId: number, col: number, row: number) {
  const cities = session.cities.filter((c) => c.playerId === playerId);
  if (!cities.length) return null;
  return cities.slice().sort((a, b) => session.hexDistance(col, row, a.col, a.row) - session.hexDistance(col, row, b.col, b.row))[0];
}

/** Зеркалит приватный GameSession.isInhabitedRegion — по прямому запросу заселяемость решает
 * количество РЕСУРСОВ в регионе, не суши (после подъёма уровня моря суша может уйти ниже старого
 * порога, а ресурс на оставшемся тайле — остаться). */
function isInhabitedRegion(session: GameSession, rc: number, rr: number): boolean {
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      if (session.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).resource) return true;
    }
  }
  return false;
}
/** Зеркалит приватный GameSession.regionHasFoundableTile — вся суша региона может оказаться подо
 * льдом (тундра+iceCover), тогда основать город тоже негде, несмотря на ≥3 тайла суши формально. */
function regionHasFoundableTile(session: GameSession, rc: number, rr: number): boolean {
  for (let dx = 0; dx < REGION_SIZE_X; dx++) for (let dy = 0; dy < REGION_SIZE_Y; dy++) if (session.canFoundCityAt(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy)) return true;
  return false;
}

/** Приграничные регионы (см. borderRegionsOf), где ещё нет города НИ У КОГО — «регионы потенциального
 * заселения», те же кандидаты, что уже использует Поселенец (tryFoundOrGrowCity), переиспользуем тот
 * же критерий вместо отдельного. По прямому запросу — живой баг-репорт: «юнит собирается застолбить
 * регион под заселение, но это не заселяемый регион» — раньше сюда попадал ЛЮБОЙ приграничный регион
 * без города, даже почти целиком океан (1 гекс суши из 12) — settler такой регион и не пробовал бы
 * (foundCity отказал бы по ≥3 тайлам суши, tryFoundOrGrowCity тихо перешёл бы к следующему кандидату),
 * но «Застолбить регион» (п.5 decideAndIssueUnitOrder, юниту больше нечем заняться) слепо шёл на
 * единственный гекс суши такого региона — марш ради региона, где город физически никогда не появится.
 * Теперь оба фильтра из foundCity (≥3 тайла суши, хотя бы один НЕ подо льдом) применяются здесь же —
 * значит и «Застолбить» больше не идёт в заведомо непригодные регионы. */
function unclaimedNearbyRegions(session: GameSession, playerId: number): { rc: number; rr: number }[] {
  return borderRegionsOf(session, playerId).filter(
    ({ rc, rr }) =>
      !session.cities.some((c) => c.regionCol === rc && c.regionRow === rr) &&
      isInhabitedRegion(session, rc, rr) &&
      regionHasFoundableTile(session, rc, rr) &&
      // Живой баг-репорт (по прямому запросу) — AI принял 5💰 за обещание «не селиться в регионе
      // (5,3)» (promiseNoSettle) и ТЕМ ЖЕ ходом основал там город, немедленно нарушив только что
      // принятое обещание: `unclaimedNearbyRegions` не знала о собственных активных обещаниях этого
      // игрока вовсе, считая регион свободным кандидатом наравне со всеми. Само основание такого
      // города промах не блокирует (`GameSession.foundCity` по-прежнему только штрафует пост-фактум
      // через `breakPromise`, по дизайну — «может быть нарушено, если планы изменились», см. её
      // doc) — но AI не должен ВЫБИРАТЬ регион, где сам обещал не селиться, как обычного кандидата.
      !session.activePromises.some((p) => p.kind === "noSettle" && p.by === playerId && p.regionCol === rc && p.regionRow === rr)
  );
}

/** Стоит ли СЕЙЧАС хоть один свой юнит (не считая `excludeUnitId`, если он сам стоит именно там —
 * «если он останется, город и так под охраной, но нас интересует, что будет, когда ЭТОТ юнит уйдёт»)
 * в конкретном городе — по прямому запросу, живой баг-репорт: «юнит в опасном положении, ему нечего
 * охранять — регион пуст, у противника численный перевес, стоит на пустыне и не сможет занять
 * обороны; разумнее отступить и занять оборону в городе, который СЕЙЧАС лишён охраны». Намеренно про
 * КОНКРЕТНЫЙ (ближайший/родной) город юнита, а не «хоть один город империи вообще» — иначе защитник
 * города А не отступал бы, пока где-то далеко в городе Б стоит вообще любой другой юнит. */
function cityIsGuarded(session: GameSession, playerId: number, city: { col: number; row: number }, excludeUnitId: number): boolean {
  return session.units.some((u) => u.playerId === playerId && u.id !== excludeUnitId && u.col === city.col && u.row === city.row);
}

/** Приказ одному юниту — по прямому запросу, в таком порядке:
 * 0. «Оборонительный» юнит, чей ближайший/родной город (см. nearestOwnCity) СЕЙЧАС не охраняется НИ
 *    ОДНИМ своим юнитом, кроме него самого — прерывает уже идущий марш (если он есть) и отступает
 *    туда вместо продолжения пути; юнит уже стоит в этом городе — этот пункт не мешает остальной
 *    логике ниже (он и так на месте, «отступать» некуда).
 * 1. Мир с владельцем территории, на которой юнит сейчас стоит (по региону, то же приближение, что
 *    и everywhere в этом файле) — отвести домой, в ближайший свой город («При объявлении мира ВСЕ
 *    военные юниты на территории врага перемещаются в ближайший свой город»).
 * 2. Атака — если в досягаемости есть цель среди тех, с кем сейчас война (см. attackCandidatesFor),
 *    берём с максимальным приоритетом.
 * 3. Марш — если войны с кем-то нет, но ведётся другая война, выдвигаемся к самому ценному фронту
 *    (кроме «Оборонительного», чей ближайший город остался бы без защиты — см. п.0).
 * 4. Оборона — если угроза на границе (см. hasBorderThreat) и делать больше нечего, встаём в
 *    «Оборону» на месте.
 * 5. Иначе — юниту совсем нечего делать: застолбить ближайший ещё не занятый регион потенциального
 *    заселения (по прямому запросу — см. unclaimedNearbyRegions), чтобы не дать другому игроку
 *    основать там город раньше.
 * Юнит с уже активным moveOrder или без хода в этом цикле пропускается (кроме п.0 выше, который
 * прерывает марш явно) — новый приказ ему не нужен (см. заголовок секции) либо невозможен, dispatch
 * всё равно откажет мягко.
 *
 * [ИСПРАВЛЕНО, живой баг-репорт — «исчезает пехота в кораблях при длительном путешествии»] —
 * пассажир на борту корабля НЕ имеет собственного `moveOrder` (его тащит только сам корабль, шаг за
 * шагом, см. `GameSession.walkUnitAlongOrder`) — значит проверка выше («уже есть moveOrder — пропустить»)
 * его НЕ ловит, и без отдельной проверки этот же цикл честно пытался выдать пассажиру СОБСТВЕННЫЙ
 * приказ, как обычному сухопутному юниту. Обычно путь физически не находится (открытое море без
 * корабля непроходимо для суши) и попытка тихо проваливается — но чем ДОЛЬШЕ длится плавание (больше
 * ходов этого игрока приходится на путь корабля), тем больше шансов, что КАКАЯ-то из веток ниже (п.5
 * «застолбить регион» и т.п.) всё же найдёт для пассажира формально валидную, но бессмысленную цель и
 * уведёт его С клетки корабля на открытую воду без судна — там он окончательно замирает без единого
 * доступного хода, что и выглядит как «пехота пропала». */
/** Пробует атаковать ЛУЧШУЮ доступную цель ПРЯМО С ТЕКУЩЕЙ позиции юнита, без какого-либо
 * перемещения перед атакой — сама атака (`commandUnit` на вражескую клетку, см. GameSession) сама
 * решает, нужен ли подход, если цель вне дальности. Вынесено из `decideAndIssueUnitOrder` в отдельную
 * функцию (по прямому запросу — «сейчас юниты с корабля не могут атаковать город [делать высадку в
 * бой], нужно дать им такую возможность и проверить что AI тоже умеет это делать») — та же самая
 * логика выбора и оценки цели нужна ДВАЖДЫ: обычным юнитам (на своём обычном месте в приоритете,
 * между переброской к плану/армии и маршем к фронту) И пассажирам на борту корабля (см. её вызов в
 * начале `decideAndIssueUnitOrder` — для них это ЕДИНСТВЕННОЕ, что вообще проверяется, раньше не
 * проверялось совсем). Возвращает true, только если приказ реально отдан (атака удалась). */
function tryAttackFromCurrentPosition(session: GameSession, playerId: number, unit: UnitInstance, reporter: Reporter): boolean {
  const candidates = attackCandidatesFor(session, playerId, unit)
    .slice()
    .sort((a, b) => b.score - a.score);
  for (const cand of candidates) {
    // По прямому запросу — живой баг-репорт: «копейщику не хватит сил выбить воина, атака не имеет
    // смысла, пока не наберётся сил поддержки или для добивания» — атакуем юнита (не город, см.
    // simulateAttackOutcome), только если выполняется ХОТЯ БЫ ОДНО (§3.2, по прямому уточнению —
    // исправление собственной ошибки насчёт «добьём в следующем цикле», HP сбрасывается на границе
    // цикла, рана не переживает её): (а) этот удар убивает цель сам по себе — как раньше; (б) удар НЕ
    // убивает, но принудительно СДВИГАЕТ цель с гекса (`targetRetreated` — реальное отступление,
    // GameSession.resolveCombat, а не просто «мой юнит пережил контрудар», см. п.2 ниже — почему
    // именно это, а не голое «выжил», является тем самым «безопасным давлением без риска, которое
    // ничем не жертвует»); (в) мой юнит контрудар не переживёт, но комбинированная цепочка ударов ЕЩЁ
    // НЕ походивших в этот ход своих юнитов добивает цель В ЭТОМ ЖЕ ходу с потерями не дороже самой
    // цели (`comboKillAvailable`). Ни одно из трёх — бой всё равно закончится встречным контрударом
    // (GameSession.resolveCombat: defender.hp>0 → всегда отвечает) без всякой пользы — юнит пробует
    // следующего кандидата, а если ни один не подходит, идёт дальше по приоритету (марш к фронту/
    // оборона) вместо бессмысленного размена.
    //
    // [ИСПРАВЛЕНО, живой баг-репорт — «у оранжевого было множество войск, он мог взять и город, и
    // юнитов уничтожить, но получилось уничтожить лишь одного»] — раньше пункт (б) проверялся как
    // голое «мой юнит переживает контрудар» (`outcome.attackerSurvived`), БЕЗ проверки, что удар
    // реально хоть что-то меняет: `GameSession.resolveCombat` сдвигает защитника ТОЛЬКО если удар в
    // упор, атакующий выжил, И его оставшееся HP ≥ оставшегося HP защитника — при любом другом раскладе
    // (например слабая Поддержка бьёт защищённого Оборонительного) атакующий преспокойно «переживает»
    // контрудар, а защитник просто стоит на месте с чуть меньшим HP, которое полностью восстановится
    // на границе цикла ещё до его следующего хода — чистая трата действия и 1💰 без единого следа.
    // Несколько юнитов подряд размазывали удары по РАЗНЫМ целям именно так, вместо того чтобы либо
    // сосредоточить огонь ради настоящего убийства/отступления, либо вообще поберечь действие.
    if (!cand.isCity) {
      const outcome = simulateAttackOutcome(session, playerId, unit, cand);
      if (outcome && !outcome.targetDied && !outcome.targetRetreated && !comboKillAvailable(session, playerId, unit, cand)) continue;
    }
    const payload = { unitId: unit.id, col: cand.col, row: cand.row };
    const beforeCol = unit.col;
    const beforeRow = unit.row;
    const result = session.dispatch("commandUnit", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "commandUnit",
        payload,
        sourceUnitId: unit.id,
        sourceCol: unit.col,
        sourceRow: unit.row,
        targetKind: "hex",
        targetCol: cand.col,
        targetRow: cand.row,
        label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) атакует ${cand.isCity ? "город" : "юнита"} на (${cand.col},${cand.row}).`,
      });
      // Живой баг-репорт — «дожать осаду»: атака и движение — РАЗНЫЕ бюджеты (см. §9 «Порядок одной
      // атаки» — атаку можно отдать до ИЛИ после обычного перемещения тем же юнитом), но этот юнит уже
      // получил свой ЕДИНСТВЕННЫЙ вызов decideAndIssueUnitOrder в этот ход (см. runMilitaryOrders —
      // один проход по юнитам) — без явного добора здесь атака, только что пробившая буфер осады
      // (см. resolveCombat), так и осталась бы непройденным окном захвата до конца ЭТОГО же цикла:
      // юнит остаётся стоять на месте после атаки (не заходит сам), а следующего свободного юнита с
      // этой же целью в очереди может не найтись вовсе — итог наблюдался живьём (`_verify_captureTest`)
      // как «противник методично дожимает гарнизон города несколько циклов, но так ни разу и не заходит
      // — население доходит до 0, город не захвачен, а уничтожен». Раз атакующий физически не сдвинулся
      // (beforeCol/beforeRow всё ещё его позиция), тот же юнит пробует зайти СРАЗУ ЖЕ — если буфер
      // именно этой атакой обнулился и хода ещё хватает, second dispatch на ту же цель, ранее шедший
      // атакой (isEnemyTarget), теперь честно пойдёт движением (см. commandUnit: citySiegeBroken) и
      // либо дойдёт и захватит в этот же ход, либо просто откажет (не хватило хода/пути нет) — в этом
      // случае ничего не теряем, юнит и так уже был неподвижен весь остаток хода. Пассажир на борту
      // корабля (см. вызов из decideAndIssueUnitOrder ниже) физически зайти так не может (сухопутный
      // юнит не проходит открытое море вовсе, см. unitPassable) — followUp там просто откажет, ничего
      // не теряем и в этом случае.
      if (cand.isCity && unit.col === beforeCol && unit.row === beforeRow && !session.outOfMoveThisCycle.has(unit.id)) {
        const city = session.cityAt(cand.col, cand.row);
        const justBroken = !!city && city.playerId !== playerId && (session.citySiegeBuffer.get(city.id) ?? 1) <= 0;
        if (justBroken) {
          const followUp = session.dispatch("commandUnit", playerId, payload);
          if (followUp.ok) {
            const captured = session.cityAt(cand.col, cand.row)?.playerId === playerId;
            reporter.step({
              action: "commandUnit",
              payload,
              sourceUnitId: unit.id,
              sourceCol: cand.col,
              sourceRow: cand.row,
              targetKind: "hex",
              targetCol: cand.col,
              targetRow: cand.row,
              label: captured
                ? `Юнит #${unit.id} добивает осаду и входит в город (${cand.col},${cand.row}) — захвачен!`
                : `Юнит #${unit.id} пробует зайти в город (${cand.col},${cand.row}) следом за пробитой осадой.`,
            });
          }
        }
      }
      return true;
    }
  }
  return false;
}

function decideAndIssueUnitOrder(session: GameSession, playerId: number, unit: UnitInstance, reporter: Reporter) {
  // Пассажир на борту корабля (по прямому запросу — «юниты с корабля не могут атаковать город, делать
  // высадку в бой — нужно дать им такую возможность») — единственное, что для него вообще
  // проверяется: атака ПРЯМО С БОРТА, если враг уже в досягаемости (тот же расчёт дальности/подхода,
  // что и у любого другого юнита, см. GameSession.commandUnit — атака НЕ требует физически сойти на
  // берег). Не удалось — юнит просто ждёт, пока корабль довезёт его до берега (см. doc isRidingShip
  // ниже — самостоятельный ПРИКАЗ ДВИЖЕНИЯ для пассажира по-прежнему запрещён целиком, только атака).
  if (isRidingShip(session, unit)) {
    tryAttackFromCurrentPosition(session, playerId, unit, reporter);
    return;
  }
  const homeCity = nearestOwnCity(session, playerId, unit.col, unit.row);
  if (unit.category === "defense" && !session.outOfMoveThisCycle.has(unit.id) && homeCity && !cityIsGuarded(session, playerId, homeCity, unit.id)) {
    const home = homeCity;
    if (home.col !== unit.col || home.row !== unit.row) {
      const payload = { unitId: unit.id, col: home.col, row: home.row };
      const result = session.dispatch("commandUnit", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "commandUnit",
          payload,
          sourceUnitId: unit.id,
          sourceCol: unit.col,
          sourceRow: unit.row,
          targetKind: "hex",
          targetCol: home.col,
          targetRow: home.row,
          label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) прервал марш и отступает в город (${home.col},${home.row}) — он сейчас без охраны.`,
        });
        return;
      }
    }
  }

  if (unit.moveOrder || session.outOfMoveThisCycle.has(unit.id)) return;

  // «План войны» (по прямому запросу) — пока перевес ещё не набран, свободный юнит нужной категории
  // стягивается к плану (переброска флотом/выход на дальность обстрела) РАНЬШЕ обычного марша к
  // фронту/обороны — сама война ещё не объявлена, значит фронта войны с этой целью и так нет.
  const warPlan = session.warPlans[playerId];
  if (warPlan && !session.relationOf(playerId, warPlan.targetId).war && tryStageForWarPlan(session, playerId, unit, warPlan, reporter)) return;

  // Активная «Армия» (§15.9а) — тот же принцип, но ПОСЛЕ объявления войны: свободный член выдвигается
  // к цели АРМИИ (переброска флотом/выход на дальность обстрела), раньше обычного марша/атаки — сам
  // юнит ещё не в позиции для роли, которую эта армия от него требует. Самокорректируется каждый ход
  // (`tryStageForArmy` смотрит на ТЕКУЩУЮ позицию, не на устаревший флаг) — уже прибывшему/не
  // нуждающемуся в переброске юниту эта проверка ничего не сделает, он падает дальше по коду как обычно.
  const memberArmy = unit.armyId !== null ? session.armies.find((a) => a.id === unit.armyId) : undefined;
  if (memberArmy && tryStageForArmy(session, playerId, unit, memberArmy, reporter)) return;

  const region = { rc: Math.floor(unit.col / REGION_SIZE_X), rr: Math.floor(unit.row / REGION_SIZE_Y) };
  const foreignOwner = session.cities.find((c) => c.regionCol === region.rc && c.regionRow === region.rr && c.playerId !== playerId)?.playerId;
  if (foreignOwner !== undefined && !session.relationOf(playerId, foreignOwner).war) {
    const home = nearestOwnCity(session, playerId, unit.col, unit.row);
    if (home && (home.col !== unit.col || home.row !== unit.row)) {
      const payload = { unitId: unit.id, col: home.col, row: home.row };
      const result = session.dispatch("commandUnit", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "commandUnit",
          payload,
          sourceUnitId: unit.id,
          sourceCol: unit.col,
          sourceRow: unit.row,
          targetKind: "hex",
          targetCol: home.col,
          targetRow: home.row,
          label: `Отвёл юнита #${unit.id} (${CATEGORY_META[unit.category].label}) домой в город (${home.col},${home.row}) — мир с игроком ${foreignOwner}.`,
        });
      }
      return;
    }
  }

  if (tryAttackFromCurrentPosition(session, playerId, unit, reporter)) return;

  // Угроза ИМЕННО в регионе, где сейчас стоит этот юнит (не глобальная сводка по всей партии, см.
  // isFrontRegion) — по прямому запросу: «если нет превосходства сил, нужно перебрасывать туда силы
  // других городов, если бюджет позволяет». Раньше здесь стояла ГЛОБАЛЬНАЯ hasBorderThreat — юнит в
  // мирном тыловом городе, пока где-то на ДРУГОМ краю партии шла война, ошибочно считался «на
  // границе» и просто вставал в оборону НА МЕСТЕ, вместо марша к фронту, хотя никакой угрозы там, где
  // он стоит, не было. Теперь оборона на месте — только когда угроза реально В ЭТОМ регионе; иначе
  // юнит идёт маршем к фронту наравне со всеми остальными — это и есть переброска резервов из тыла.
  const ownRegionThreatened = isFrontRegion(session, playerId, region.rc, region.rr);
  // Цель марша для члена армии/флота — своя, не общий `warFrontHex` на всю партию (§15.9а, по прямому
  // запросу «просто каждая ведёт свой расчёт»): у члена армии — цель ЕГО армии; у корабля БЕЗ армии —
  // если везёт своего пассажира-члена какой-то армии, доставка приоритетнее собственных задач флота
  // (иначе пассажира унесёт не туда — задачи флота не знают о конкретной высадке); иначе, если корабль
  // в составе флота — цель флота (поддержка осады/охота на вражеский флот/набег, строго в пределах
  // региона-театра, см. fleetTargetHex — «не гоняться за вражеским флотом по всей карте»); ни то ни
  // другое — обычный generic-фронт, как и раньше.
  const carriedPassenger =
    unit.category === "ship" ? session.units.find((u) => u.col === unit.col && u.row === unit.row && u.playerId === playerId && u.category !== "ship") : undefined;
  const passengerArmy = carriedPassenger?.armyId != null ? session.armies.find((a) => a.id === carriedPassenger.armyId) : undefined;
  const myFleet = unit.category === "ship" ? session.fleets.find((f) => f.playerId === playerId && f.shipUnitIds.includes(unit.id)) : undefined;
  const genericFront = newWarAiEnabled(session) ? nearestFrontForUnit(session, playerId, unit) : warFrontHex(session, playerId);
  const front = memberArmy
    ? armyTargetHex(session, memberArmy)
    : passengerArmy
      ? armyTargetHex(session, passengerArmy)
      : myFleet
        ? (fleetTargetHex(session, myFleet) ?? genericFront)
        : genericFront;
  // По прямому запросу — живой баг-репорт: «зачем кораблю двигаться? он и так в зоне боевых действий,
  // на максимально защищённом гексе — проще встать в оборону, чем делать действие, которое не улучшит
  // позицию и не нанесёт урона» — если юнит УЖЕ в упор (≤1 гекс) от `front`, «марш к фронту» ничего не
  // меняет: атака уже была опробована чуть выше (п.2, до этого места код не доходит, если удар вышел
  // смертельным) и не удалась, а шаг на соседний с `front` гекс — просто топтание на месте за 1💰 без
  // выгоды, тем же принципом для ЛЮБОЙ категории, не только Кораблей. Дальше по коду это тоже считается
  // «на фронте» для решения об обороне (см. `alreadyAtFront` ниже), даже если сам регион юнита формально
  // не входит в isFrontRegion (та смотрит на баланс сил ПО РЕГИОНУ в целом, а не просто «рядом ли враг»).
  const alreadyAtFront = !!front && session.hexDistance(unit.col, unit.row, front.col, front.row, 2) <= 1;
  // По прямому запросу (см. п.0 выше, тот же баг-репорт) — «Оборонительный» также не отправляется
  // маршем к фронту, если его ближайший/родной город сейчас без единого защитника: без этой проверки
  // юнит после отступления п.0 (или свежепостроенный «Оборонительный» без локальной угрозы) тут же
  // получал бы этот же марш-приказ снова, отступал бы на следующем ходу через п.0 — и так по кругу,
  // без всякого толку, каждый раз тратя 1💰 на приказ.
  //
  // Одинокий марш к фронту без шансов и без своего города рядом — тоже не отправляется, теперь для
  // ЛЮБОЙ категории (см. marchIsSuicidal, тот же баг-репорт про «Секироносца» и «превосходящие силы»
  // на подступе) — юнит вместо этого падает к п.4 (оборона дома/у ближайшего города) или п.5.
  if (front && !alreadyAtFront && !marchIsSuicidal(session, playerId, unit, front) && !(unit.category === "defense" && (ownRegionThreatened || (homeCity && !cityIsGuarded(session, playerId, homeCity, unit.id))))) {
    // commandUnit К САМОЙ вражеской клетке всегда трактуется как атака (проверяет дальность боя, не
    // прокладывает маршрут) — пока цель ещё далеко, целимся в один из СОСЕДНИХ (пустых/проходимых)
    // гексов: туда сервер честно строит маршрут с автопродолжением по циклам (см. заголовок секции).
    // Пробуем всех до 6 соседей по очереди — какой-то да свободен/проходим.
    //
    // По прямому запросу — живой баг-репорт: «юнит собирается идти в клетку, где стоит юнит
    // противника — зачем?» — СОСЕДНИЙ с фронтом гекс тоже может оказаться занят врагом (скопление
    // войск редко ограничивается ровно одной клеткой), а commandUnit одинаково трактует ЛЮБУЮ занятую
    // врагом клетку как атаку — независимо от того, что это «просто марш» с точки зрения этого пункта.
    // Такая атака идёт В ОБХОД проверки «бить только насмерть» (п.2 выше, `simulateAttackOutcome`) —
    // марш попросту не должен натыкаться на бой вовсе, это не его задача. Пропускаем любой сосед с
    // чужим юнитом или чужим городом — там либо уже отработал (или откажется) п.2, либо это и правда
    // не место для движения.
    for (const [col, row] of hexNeighborsWrapped(front.col, front.row, MAP_WIDTH, MAP_HEIGHT)) {
      if (session.units.some((u) => u.col === col && u.row === row && u.playerId !== playerId)) continue;
      const targetCity = session.cityAt(col, row);
      if (targetCity && targetCity.playerId !== playerId) continue;
      const payload = { unitId: unit.id, col, row };
      const result = session.dispatch("commandUnit", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "commandUnit",
          payload,
          sourceUnitId: unit.id,
          sourceCol: unit.col,
          sourceRow: unit.row,
          targetKind: "hex",
          targetCol: col,
          targetRow: row,
          // По прямому запросу — живой баг-репорт «координаты юнитов в плане не совпадают с
          // координатами на карте»: подпись раньше показывала координаты САМОГО фронта (`front`), а
          // не реальную цель приказа — юнит целится в СОСЕДНИЙ с фронтом гекс (см. цикл выше, зайти
          // прямо НА фронт означало бы атаку), так что `targetCol/targetRow` (уже показанные на карте
          // синей линией/маркером) почти всегда отличались от подписанных в тексте координат.
          label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) выдвигается к фронту (${col},${row}).`,
        });
        return;
      }
    }
  }

  // По прямому запросу (тот же баг-репорт, см. п.0 выше) — «Последний» защитник своего ближайшего/
  // родного города (никто другой его сейчас не охраняет) встаёт в оборону НА МЕСТЕ и без локальной
  // угрозы в регионе, вместо того чтобы уйти застолбить пустой регион (следующий пункт ниже) и снова
  // оставить этот город без единого защитника. `alreadyAtFront` (см. выше) — та же причина, по которой
  // марш к фронту был пропущен: юнит уже в упор от цели, атака не смертельна, дальше топтаться некуда —
  // логичнее занять оборону тут же, а не пытаться застолбить регион (следующий пункт).
  if ((ownRegionThreatened || alreadyAtFront || (unit.category === "defense" && homeCity && !cityIsGuarded(session, playerId, homeCity, unit.id))) && !unit.defending) {
    const payload = { unitId: unit.id };
    const result = session.dispatch("toggleDefend", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "toggleDefend",
        payload,
        sourceUnitId: unit.id,
        sourceCol: unit.col,
        sourceRow: unit.row,
        targetKind: "none",
        label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) встал в оборону — угроза в этом регионе.`,
      });
    }
    return;
  }

  // По прямому запросу — «если воины стоят без дела, лучше занять ими регионы потенциального
  // заселения, если там нет других юнитов, чтоб застолбить область за собою и не дать построить там
  // поселение другим»: юниту совсем нечего делать (не воюет, не отводится домой, граница спокойна) —
  // выдвигается в ближайший приграничный регион, где ещё нет города НИ У КОГО (те же кандидаты, что
  // и у Поселенца, см. tryFoundOrGrowCity) и где сейчас вообще нет юнитов — ни своих, ни чужих (не
  // лезем туда, где уже кто-то есть — там и так уже «застолблено» или идёт спор).
  for (const { rc, rr } of unclaimedNearbyRegions(session, playerId)) {
    if (unitsInRegion(session, rc, rr).length) continue;
    // Центр региона не всегда суша (регион может быть смешанным/прибрежным) — commandUnit (в отличие
    // от foundCity) сам тайл под ногами не подбирает, так что перебираем все тайлы региона, пока
    // какой-то не окажется и сушей, и реально досягаемым (то же самое уже делает tryBuilder/
    // tryPlantForest для тайлов в РЕГИОНЕ СВОЕГО города — здесь тот же перебор, только для чужого
    // ещё не занятого региона).
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = rc * REGION_SIZE_X + dx;
        const row = rr * REGION_SIZE_Y + dy;
        if (!session.isLandTile(col, row)) continue;
        const payload = { unitId: unit.id, col, row };
        const result = session.dispatch("commandUnit", playerId, payload);
        if (!result.ok) continue;
        reporter.step({
          action: "commandUnit",
          payload,
          sourceUnitId: unit.id,
          sourceCol: unit.col,
          sourceRow: unit.row,
          targetKind: "hex",
          targetCol: col,
          targetRow: row,
          label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) без дела — застолбил регион (${rc},${rr}) под будущее поселение.`,
        });
        return;
      }
    }
  }
}

/** Юнит физически стоит на клетке СВОЕГО корабля (пассажир на борту) — по прямому уточнению нужен
 * именно этот, более строгий признак, не `GameSession.isAboardShip` (та приватная и, к тому же,
 * сверяет только «клетка морская», не факт, что корабль реально там стоит — на практике почти всегда
 * совпадает, раз сухопутный юнит физически не может оказаться на воде иначе, но здесь дешевле и
 * надёжнее проверить корабль напрямую, раз речь именно о том, кто им распоряжается). */
function isRidingShip(session: GameSession, unit: UnitInstance): boolean {
  if (unit.category === "ship" || !session.isSeaTile(unit.col, unit.row)) return false;
  return session.units.some((s) => s.category === "ship" && s.playerId === unit.playerId && s.col === unit.col && s.row === unit.row);
}

/** `unitIdFilter` (по прямому запросу, живой баг-репорт — «оранжевый в свой ход не захватил город, хотя
 * точно мог») — необязательный отбор по id, чтобы вызвать эту функцию ДВАЖДЫ за ход (см. её вызовы в
 * `runAiTurnLogic`) без двойной обработки одного и того же юнита. */
function runMilitaryOrders(session: GameSession, playerId: number, reporter: Reporter, unitIdFilter?: (id: number) => boolean) {
  const myUnits = session.units.filter((u) => u.playerId === playerId && (!unitIdFilter || unitIdFilter(u.id)));
  const sorted = myUnits.slice().sort((a, b) => (UNIT_ORDER_PRIORITY[a.category] ?? 9) - (UNIT_ORDER_PRIORITY[b.category] ?? 9));
  for (const unit of sorted) decideAndIssueUnitOrder(session, playerId, unit, reporter);
}

// === Обязательная передача карты (mustHandoff) — отдаёт наименее полезную ======================

/** Есть ли у игрока уже действующая торговая сеть (хотя бы 1 свой город соединён маршрутом хотя бы с
 * одним другим городом). Переиспользует ту же BFS, что и tradeNetworkCityIds. */
function hasTradeNetwork(session: GameSession, playerId: number): boolean {
  return myCities(session, playerId).some((c) => tradeNetworkCityIds(session, c.id).size > 1);
}

/** Кандидаты на передачу, В ПОРЯДКЕ предпочтения — по прямому запросу карта СОБЫТИЯ уходит самому НЕ
 * дружественному игроку (моё мнение о нём ниже всех, `relationScoreOf`, §8.3), карта ДЕЙСТВИЯ —
 * самому дружественному (это разворот прежнего правила «сильнейшему соседу»/«врагу по войне» —
 * заменено целиком, не добавлено поверх). Пул кандидатов — как и раньше: соседи по границе регионов,
 * откат на «всех живых игроков», если соседей ещё нет (самое начало партии) — оба случая сортируются
 * по одному и тому же критерию отношения, только сам пул кандидатов разный. Возвращает ВЕСЬ
 * отсортированный список, не только первого — по прямому запросу, живой баг-репорт («жёлтый вообще
 * не играет карт») — если единственный кандидат оказывается ИМЕННО тем, кто когда-то дал выбранную
 * карту (сервер честно отказывает возвращать карту туда же, откуда она пришла — см.
 * GameSession.handoffCard) или недавно уже получал карту от этого игрока (см. lastHandoffCycle),
 * нужен запасной вариант, а не тупик. */
function sortHandoffCandidates<T extends { id: number }>(session: GameSession, playerId: number, cardKind: "action" | "event", pool: T[]): T[] {
  return pool.slice().sort((a, b) => {
    const scoreA = session.relationScoreOf(playerId, a.id);
    const scoreB = session.relationScoreOf(playerId, b.id);
    return cardKind === "event" ? scoreA - scoreB : scoreB - scoreA;
  });
}
/** Карты события, чей эффект ВСЕГДА направлен против того, кто их держит/играет (у «Катастрофы» это
 * написано прямым текстом в её описании) — используется только `doMandatoryHandoff` ниже, чтобы
 * предпочесть отдать именно их, а не выгодные события вроде «Налогов»/«Торговца». */
const HAZARD_EVENT_CARDS = new Set(["catastrophe"]);

/** Кандидаты на передачу карты — ВСЕ живые игроки, без ограничения соседством/контактом (по прямому
 * запросу — «я могу передать карту любому игроку в начале хода, значит и AI должен; правило
 * видимости работает только для дипломатии»): в отличие от дипломатических соглашений
 * (`GameSession.hasContactWith`) и сделок биржи между игроками, обязательная передача карты
 * (`handoffCard`) серверной проверки видимости/контакта не имеет вовсе — человек может выбрать любого
 * оставшегося в партии игрока, и бот должен иметь тот же выбор, не только приграничных соседей. */
function handoffTargetsInOrder(session: GameSession, playerId: number, cardKind: "action" | "event") {
  const pool = session.players.filter((p) => p.id !== playerId && !session.eliminatedPlayers.has(p.id));
  return sortHandoffCandidates(session, playerId, cardKind, pool);
}

function doMandatoryHandoff(session: GameSession, playerId: number, reporter: Reporter) {
  const hand = session.hands[playerId];

  // По прямому запросу — «есть ещё передача по просьбе, учти это»: активное обещание «передать
  // карту X игроку Y» (promiseGiveCardType, §8.5) — если карта X СЕЙЧАС в руке, пробуем исполнить
  // обещание ПЕРВЫМ делом, раньше обычного приоритета по ценности/отношениям (та же mustHandoff —
  // другого пути раздать карту вне вынужденного сброса нет; `GameSession.handoffCard` и так уже
  // опортунистически засчитывает совпадение как исполнение, здесь — целенаправленная попытка этого
  // добиться, а не полагаться на случайное совпадение обычного правила «событие/действие → нужному
  // игроку по отношениям» ниже). Несколько обещаний сразу — пробуются по порядку истечения (скорее
  // сгорающие первыми), пропуская запрещённые пары (`receivedFrom`/`lastHandoffCycle`) тем же
  // приёмом, что и обычный цикл ниже; не нашлось ни одной исполнимой — переходим к обычной логике.
  const duePromises = session.activePromises
    .filter((p) => p.kind === "giveCardType" && p.by === playerId && p.cardId !== undefined)
    .sort((a, b) => a.expiresAtCycle - b.expiresAtCycle);
  for (const promise of duePromises) {
    const target = session.players.find((p) => p.id === promise.to && !session.eliminatedPlayers.has(p.id));
    if (!target) continue;
    const slot = hand.findIndex((c) => c && !c.freeMonarchy && c.id === promise.cardId);
    if (slot === -1) continue;
    const card = hand[slot];
    if (card.receivedFrom === target.id) continue;
    const lastCycle = session.lastHandoffCycle[`${playerId}:${target.id}`];
    if (lastCycle !== undefined && session.cyclesElapsed - lastCycle < 2) continue;
    const payload = { slotIndex: slot, targetPlayerId: target.id };
    const result = session.dispatch("handoffCard", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "handoffCard",
        payload,
        cardSlotIndex: slot,
        cardId: card.id,
        targetKind: "player",
        targetPlayerId: target.id,
        label: `Передал карту «${card.id}» игроку ${target.name} — исполняя обещание.`,
      });
      return;
    }
  }

  // ПЕРЕДАЧА КАРТЫ — трёхступенчатая лестница из листа «Режимы и приоритеты», дословно:
  // «Сначала отдавать лишние карты событий → потом отдавать дубли → потом отдавать карты низкого
  // приоритета». Никакой отдельной таблицы «ценности хранения», проверок играбельности и защит под
  // конкретные карты здесь больше нет — всё решает ОДИН порядок, тот же, что и для розыгрыша
  // (`cardPriorityFor` текущей стратегии), поэтому «отдать то, что сам собирался сыграть первым»
  // структурно невозможно.
  //
  // «Лишняя» карта события — событие, стоящее в НИЖНЕЙ ПОЛОВИНЕ списка текущей стратегии (по прямому
  // уточнению: события в игре — это и «Налоги»/«Торговый путь»/«Распродажа», которые в большинстве
  // режимов стоят в самом верху и отдаваться не должны; «лишние» — те, что режим и так задвинул вниз,
  // обычно «Катастрофа»/«Рост леса»/«Мобилизация»). Внутри каждой ступени первой уходит карта с самым
  // НИЗКИМ приоритетом розыгрыша.
  //
  // Исключение — «опасные» карты события (`HAZARD_EVENT_CARDS`, по прямому запросу, живой баг-репорт:
  // «может скинуть Катастрофу, зачем отдавать Налоги ещё и врагу») — их эффект ВСЕГДА направлен
  // ПРОТИВ того, кто их держит/играет (у «Катастрофы» это написано прямым текстом в её описании), в
  // отличие от «Налогов»/«Торговца»/«Торгового пути» (те, наоборот, приносят пользу играющему) — по
  // приоритету розыгрыша `cardPriorityFor` это неразличимо (там царит порядок «что сыграть самому», а
  // не «что не жалко отдать»), из-за чего лестница выше регулярно выбирала отдать врагу выгодную
  // карту вместо вредной просто потому, что та выгодная карта у ЭТОЙ стратегии стоит чуть ниже по
  // приоритету игры. Это НЕ та же защита, что была убрана из общего порядка выше («не резервировать
  // Катастрофу — иначе копится на руках, не играется и не передаётся») — здесь ровно противоположный
  // эффект: карта из этого списка получает наивысший приоритет ИМЕННО на передачу (а не защиту от
  // неё), никак не влияя на обычный розыгрыш/`cardPriorityFor`.
  const candidates: { slot: number; cardId: string; rank: number; depth: number }[] = [];
  const priority = cardPriorityFor(session, playerId);
  const lowerHalfFrom = Math.ceil(priority.length / 2);
  // Вне списка режима карта может оказаться по двум РАЗНЫМ причинам, и трактуются они противоположно:
  // карты-средства (ENABLER_CARDS — «Право прокладки»/«Мобилизация») не входят в приоритет потому, что
  // разыгрываются ДО него и ничего у него не отнимают — их держим (глубина −1, выше первой позиции
  // списка); любая другая отсутствующая карта режиму просто не нужна (например «Поселенец» везде,
  // кроме ЭКСПАНСИИ — основывать всё равно негде) — она и есть самый низкий приоритет.
  const depthOf = (cardId: string) => {
    if (ENABLER_CARDS.has(cardId)) return -1;
    const idx = priority.indexOf(cardId);
    return idx === -1 ? priority.length : idx;
  };
  const seenCardIds = new Set<string>();
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    // Бесплатные карты парадигм/технологий передать нельзя вовсе (см. GameSession.handoffCard) —
    // в кандидаты не берём, иначе лучший по лестнице выбор тратился бы на заведомо отказной dispatch.
    if (!card || card.freeMonarchy || card.freeFascism || card.freeEducation || card.freeBuilding || card.freeParliamentarism || card.freeForestGrowth) continue;
    const isDuplicate = seenCardIds.has(card.id);
    seenCardIds.add(card.id);
    const depth = depthOf(card.id);
    // Никакого исключения для «Катастрофы» (или любой другой конкретной карты) здесь больше нет — по
    // прямому запросу («AI в погоне за приоритетом розыгрыша допускает накопление опасных карт на
    // руках», живой баг-репорт): прежняя защита «резолвится сама — держим на rank 3, ниже вообще
    // всего, пусть дойдёт очередь в обычном розыгрыше этим же ходом» предполагала, что до низа списка
    // приоритета розыгрыша (`cardPriorityFor`) в текущем заходе гарантированно дойдёт очередь — а если
    // `actionsLeft` заканчивается раньше (обычное дело: «Катастрофа»/«Распродажа» стоят последними
    // почти в каждом режиме), карта оставалась защищённой от передачи НЕОГРАНИЧЕННО долго, не играясь
    // и не уходя с рук — то самое накопление. Теперь единая лестница, дословно:
    //
    // «Рабочий» — отдельное исключение из общего правила «чем ниже приоритет розыгрыша, тем раньше
    // уходит на передачу» (по прямому запросу, живой баг-репорт: «жёлтый отдаёт рабочего, хотя мог бы
    // собрать им торговый ресурс и построить торговый путь вместо того, чтобы просто скипать ход —
    // рабочего отдают в последнюю очередь или если есть дубли»): «Рабочий» почти everywhere стоит в
    // самом низу `cardPriorityFor` (не карта-цель сама по себе, а средство добычи под ДРУГИЕ карты,
    // см. RESOURCE_HUNGRY_CARDS/tryWorkerCollect в pickAndPlayNextCard), поэтому старая лестница
    // (низкий приоритет розыгрыша → первый на передачу) отдавала его при первой возможности — именно
    // тогда, когда он мог понадобиться позже в этом же ходу, чтобы добыть недостающий ресурс под более
    // приоритетную карту (тот самый «Торговый путь» из баг-репорта). Держим до последнего — как
    // ENABLER_CARDS (rank 3, хуже обычного rank 2 — уходит, только если больше отдавать НЕЧЕГО), но
    // ДУБЛЬ (2-я и далее копия «Рабочего» в руке) ведёт себя как обычный дубль (rank 1) — свободно
    // уходит, единственный экземпляр в руке остаётся под рукой для сбора ресурса.
    // «Мёртвый груз» (по прямому запросу, живой баг-репорт: «зачем отдавать Строителя — карту
    // действия, когда есть Население, которую всё равно не сыграть — лучше отдать её») — карта, чей
    // ресурсный гейт прямо сейчас точно не закрыть (склад+рынок, `cardIsDeadWeight`), уходит ДО
    // дублей и до статичной «нижней половины» режима — держать её в руке бессмысленно, вне
    // зависимости от того, насколько высоко она стоит в приоритете розыгрыша текущей стратегии.
    const rank = HAZARD_EVENT_CARDS.has(card.id)
      ? -1
      : cardIsDeadWeight(session, playerId, card.id)
        ? -0.5
        : card.kind === "event" && depth >= lowerHalfFrom
          ? 0
          : isDuplicate
            ? 1
            : card.id === "worker"
              ? 3
              : 2;
    candidates.push({ slot: i, cardId: card.id, rank, depth });
  }
  if (!candidates.length) return; // только непередаваемые бесплатные карты — сервер сам не должен был это требовать
  candidates.sort((a, b) => a.rank - b.rank || b.depth - a.depth);

  // По прямому запросу — живой баг-репорт («жёлтый на руках 10 карт с actionsLeft=3, но вообще не
  // играет карт»): раньше здесь бралась ТОЛЬКО лучшая карта и ТОЛЬКО первый (сильнейший) сосед — если
  // ИМЕННО эта пара оказывалась запрещённой (сервер не даёт вернуть карту тому, кто её когда-то дал,
  // см. GameSession.handoffCard `receivedFrom`), функция просто молча выходила, `mustHandoff` не
  // снимался, а внешний цикл (runAiTurnLogic) заходил на СЛЕДУЮЩУЮ итерацию с АБСОЛЮТНО тем же
  // состоянием — то есть выбирал ТУ ЖЕ пару и снова получал отказ, так по кругу все 80 попыток
  // guard'а, ни разу не добираясь до розыгрыша карт вообще. Теперь перебираются все пары карта×цель
  // в порядке убывания предпочтения (лучшая карта сначала, среди её целей — по прямому запросу самый
  // НЕ дружественный для карты события / самый дружественный для карты действия, см.
  // handoffTargetsInOrder — порядок целей зависит от ВИДА конкретной карты-кандидата, считается
  // заново на каждую), пропуская только заведомо запрещённые (`target.id === card.receivedFrom`, или
  // недавняя передача этому же получателю — `lastHandoffCycle`, минимум 1 цикл пропуска, см.
  // GameSession.handoffCard — без лишнего дорогого dispatch на заведомый провал), и останавливаются
  // на первой реально успешной.
  const tryPools = (targetsFor: (cardKind: "action" | "event") => { id: number; name: string }[]) => {
    for (const cand of candidates) {
      const card = hand[cand.slot];
      const targets = targetsFor(card.kind);
      for (const target of targets) {
        if (card.receivedFrom === target.id) continue;
        const lastCycle = session.lastHandoffCycle[`${playerId}:${target.id}`];
        if (lastCycle !== undefined && session.cyclesElapsed - lastCycle < 2) continue;
        const payload = { slotIndex: cand.slot, targetPlayerId: target.id };
        const result = session.dispatch("handoffCard", playerId, payload);
        if (result.ok) {
          reporter.step({
            action: "handoffCard",
            payload,
            cardSlotIndex: cand.slot,
            cardId: cand.cardId,
            targetKind: "player",
            targetPlayerId: target.id,
            label: `Передал карту «${cand.cardId}» игроку ${target.name}.`,
          });
          return true;
        }
      }
    }
    return false;
  };
  if (tryPools((cardKind) => handoffTargetsInOrder(session, playerId, cardKind))) return;
  // Совсем ничего не подошло (теоретический край — например, ВСЕ живые игроки партии разом оказались
  // запрещены для КАЖДОЙ карты в руке) — mustHandoff останется висеть до следующего конца хода, как и
  // раньше в этом крайнем случае; guard в runAiTurnLogic не даёт зациклиться бесконечно.
}

// === Приоритет розыгрыша карт за ход (по прямому запросу — «очередь приоритета карт», позже
// полностью переработано по прямому запросу дословно: «AI должен стремиться к ЗАДАЧАМ, а карта —
// средство, а не самоцель» — старая версия просто перечисляла карты в фиксированном порядке; новая
// строит список динамически из 10 целей по убыванию важности, дословно по прямому запросу) =========

/** Цель 2/9 (Безопасность / Военное превосходство) — «паритет сил: если есть войска у соседа, а у
 * себя меньше чем вдвое» — та же метрика и тот же порог (`WAR_FORCE_RATIO=2`), что и everywhere else
 * в военных решениях бота (§22 ЦИВА-ЖУРНАЛ — «сила = число юнитов»), только с точки зрения СЛАБОЙ
 * стороны: сосед сильнее МЕНЯ более чем вдвое, а не наоборот (это уже проверяет considerWarTargets). */
function needsForceParity(session: GameSession, playerId: number): boolean {
  const myForce = countUnitsOf(session, playerId);
  return neighborPlayerIds(session, playerId).some((id) => countUnitsOf(session, id) > myForce * WAR_FORCE_RATIO);
}

function isAtWar(session: GameSession, playerId: number): boolean {
  return session.players.some((p) => p.id !== playerId && session.relationOf(playerId, p.id).war);
}

// === Стратегия хода AI — ЕДИНСТВЕННАЯ точка принятия тактических решений ========================
// Вся тактика бота сведена к одному циклу: СРЕДА → СТРАТЕГИЯ → ПРИОРИТЕТ (карт / дипломатии /
// передачи карты). Источник — лист «Режимы и приоритеты» (таблица заказчика), перенесён сюда
// дословно. ГЛАВНОЕ ПРАВИЛО СОПРОВОЖДЕНИЯ: если поведение бота нужно изменить — меняется ТАБЛИЦА
// (условия среды ниже либо порядок в CARD_PRIORITY_BY_MODE/DIPLOMACY_PRIORITY_BY_MODE), а НЕ
// добавляется новое частное условие в код. Никаких параллельных «бустов», порогов дохода и
// исключений поверх списка быть не должно — именно их наслоение и было причиной постоянных
// противоречий в поведении (см. ЦИВА-ЖУРНАЛ, §172).
//
// Пересчитывается заново на каждое обращение, не персистится — полностью определяется текущим
// состоянием партии.

export type StrategicPriority = "expansion" | "victory" | "development" | "defense" | "warPrep" | "war";

/** Человекочитаемые подписи — дублируются клиентской копией (main.ts, тот же приём, что и везде в
 * этом файле для приватной/серверной логики, которую клиент не может импортировать напрямую). */
export const STRATEGIC_PRIORITY_LABELS: Record<StrategicPriority, string> = {
  expansion: "🏕 Экспансия",
  victory: "🏛 Победа",
  development: "📈 Развитие",
  defense: "🛡 Оборона",
  warPrep: "🛠 Подготовка",
  war: "⚔ Война",
};

// --- Условия среды — ровно строки таблицы, по одной функции на строку ---------------------------

/** «Есть свободные регионы к заселению». */
function envHasFreeRegions(session: GameSession, playerId: number): boolean {
  return unclaimedNearbyRegions(session, playerId).length > 0;
}

/** «Есть здание ООН». */
function envHasOon(session: GameSession, playerId: number): boolean {
  return isOwnedBy(session.buildingOwners, "oon", playerId);
}

/** «Доступны все стратегические ресурсы эпохи» — по каждому виду, который в текущей эпохе игрока уже
 * актуален (RESOURCE_RELEVANT_FROM_EPOCH), должен быть либо доступ на своей территории, либо
 * собственная альтернативная добыча (`hasAlternativeExtraction` — «Геологоразведка»/
 * «Индустриализация»). Драгоценные металлы в счёт не идут вовсе: их не требует ни одна
 * технология/здание/карта (см. СПРАВОЧНИК §6) — это чистый источник денег, а не «доступ к ресурсу
 * эпохи» (та же причина, по которой их нет и в `RESOURCE_RELEVANT_FROM_EPOCH` изначально).
 *
 * [ИСПРАВЛЕНО, живой баг-репорт — «зелёный застрял в режиме „война“, но воевать не с кем и не на
 * что»] — список раньше включал Силикаты, хотя по прямому уточнению («силикаты и электричество
 * исключены из поводов для войны — недостаточно критичны», см. доку `STRATEGIC_RESOURCES_FOR_WAR`)
 * Силикаты НИКОГДА не могут стать целью `findResourceShortageTarget`/«Плана войны» — нехватка именно
 * их держала игрока в режиме ВОЙНА/ПОДГОТОВКА бесконечно, а сама война эту нехватку никогда бы не
 * решила (к тому же Силикаты — один из 6 вечно доливаемых лотов Мирового рынка, купить проще, чем
 * воевать). Убраны — список сузился до 4 видов, все входящие и в `STRATEGIC_RESOURCES_FOR_WAR`
 * (Драгоценные металлы туда не переносим — см. причину исключения выше, войну они оправдывают только
 * как источник ДОХОДА, не как «недостающий ресурс эпохи»). */
const EPOCH_CRITICAL_RESOURCES: ResourceId[] = ["metalOre", "hydrocarbons", "uranium", "rareEarth"];
function envHasAllEpochResources(session: GameSession, playerId: number): boolean {
  const epoch = playerEpochOf(session, playerId);
  for (const resource of EPOCH_CRITICAL_RESOURCES) {
    if (epoch < (RESOURCE_RELEVANT_FROM_EPOCH[resource] ?? 1)) continue;
    if (hasResourceInOwnTerritory(session, playerId, resource)) continue;
    if (hasAlternativeExtraction(session, playerId)) continue;
    return false;
  }
  return true;
}

/** «Есть угроза захвата региона (юнитов в 2 и более раз больше)» — тот же `needsForceParity`. */
function envRegionUnderThreat(session: GameSession, playerId: number): boolean {
  return needsForceParity(session, playerId);
}

/** «Есть 1 денег на каждого юнита» — казна покрывает содержание текущей армии. */
function envHasMoneyPerUnit(session: GameSession, playerId: number): boolean {
  return session.money[playerId] >= countUnitsOf(session, playerId);
}

/** Порядок проверки — слева направо по столбцам таблицы, первая подошедшая стратегия побеждает.
 * Шаги 3-6 взаимоисключающие и покрывают все комбинации, поэтому «ни одна не подошла» невозможно:
 * ресурсы эпохи в порядке → РАЗВИТИЕ/ОБОРОНА (по наличию угрозы), не в порядке → ВОЙНА либо ПОДГОТОВКА.
 *
 * **ВОЙНА = игрок уже воюет ИЛИ реально объявит войну в этот же ход** (по прямому запросу, живой
 * баг-репорт: «у синего стоит режим война, но он фактически ни с кем не воюет — режим подразумевает,
 * что игрок уже в войне или объявит её в этом ходе, а не подготовку к ней»). [ИСПРАВЛЕНО] — раньше
 * было `envHasConcentratedAttackAdvantage && envHasMoneyPerUnit`: абстрактная «есть перевес сил
 * где-то и деньги на армию», СОВСЕМ не связанная с тем, есть ли у игрока реальная цель/повод войны —
 * это условие спокойно выполнялось у игрока, у которого нет ни одной активной войны, ни «Плана
 * войны» вообще, ни немедленного повода объявить её прямо сейчас (никто не ненавистен, не отчаяние,
 * никто не растёт в лидеры, есть куда расширяться и т.п. — все реальные пути к войне молчат). Три
 * реальных источника войны в этот ход: `isAtWar` (уже воюет с кем-то — режим ВОЙНА не про то, кто
 * сейчас побеждает, а про сам факт боевых действий), готовый к объявлению `session.warPlans[playerId]`
 * (`warPlanReadyToDeclare`, многоходовой план, см. её доку), либо немедленный повод БЕЗ
 * предварительного плана (`considerWarTargets` — ненависть/отчаяние/сдерживание лидера/предотвращение
 * территориальной победы соперника/некуда расти; сам факт непустого результата гарантирует, что
 * `considerWarDeclaration` в этот же ход реально объявит войну этой цели, никакой дополнительной
 * проверки не требуется). Ничего из этого не подошло — ПОДГОТОВКА, даже если абстрактный перевес сил
 * уже есть: значит воевать пока не с кем/не за что, это и есть по определению «подготовка», не война. */
function computeStrategicPriority(session: GameSession, playerId: number): StrategicPriority {
  if (envHasFreeRegions(session, playerId)) return "expansion";
  if (envHasOon(session, playerId)) return "victory";
  if (envHasAllEpochResources(session, playerId)) return envRegionUnderThreat(session, playerId) ? "defense" : "development";
  const activePlan = session.warPlans[playerId];
  const willDeclareViaPlan = !!activePlan && warPlanReadyToDeclare(session, playerId, activePlan);
  const atWarOrDeclaring = isAtWar(session, playerId) || willDeclareViaPlan || considerWarTargets(session, playerId) !== null;
  return atWarOrDeclaring ? "war" : "warPrep";
}

/** ПОРЯДОК РАЗЫГРЫВАНИЯ КАРТ по стратегиям — дословно лист «Режимы и приоритеты», сверху вниз.
 * Это ЕДИНСТВЕННОЕ место, где задаётся, что бот играет раньше, а что позже: никаких «бустов»,
 * порогов дохода и частных исключений поверх этих списков нет и быть не должно.
 *
 * Дословно из исходной Google-таблицы заказчика («Режимы и приоритеты», лист «Card priority»,
 * https://docs.google.com/spreadsheets/d/1XFEq2oL23C1SZVuxGz8zWtafpPvACD04ANyV8q-fnlo) — по прямому
 * запросу («буквально как на картинке») сверено построчно с CSV-экспортом листа, включая 2 позиции,
 * которые при более раннем ручном переносе таблицы в текст были ошибочно продублированы внутри
 * колонки вместо разных карт (ОБОРОНА строка 6 — «Строитель», не второй «Сбор налогов»; ПОДГОТОВКА
 * строка 8 — «Торговый путь», не второй «Сбор рес прозапас»).
 *
 * Соответствие названий таблицы картам игры: Заселить регион → `settler`; Рост населения →
 * `settler`* (см. сноску); Научное открытие → `scientist`; Торговый путь → `tradeRoute`; Сбор налогов →
 * `taxes`; Торговец → `trader`; Юнит → `warrior`; Сбор рес про запас → `worker` (розыгрыш
 * «Рабочего» как самоцели, ради разнообразия склада); Строитель → `builder`; Посадка леса →
 * `forestGrowth`; Устранение катастрофы → `catastrophe` (розыгрыш карты с оплатой 1 Лес + 1 Силикат
 * — «устранить опасность», см. cards.ts).
 *
 * *«Рост населения» (таблица заказчика) как ОТДЕЛЬНАЯ карта в игре больше не существует — везде, где
 * в таблице стоит «Рост населения», здесь стоит `settler`: `tryFoundOrGrowCity` (розыгрыш «Поселенца»)
 * сам проверяет, есть ли ещё куда основать город (§ ниже, `unclaimedNearbyRegions`), и если некуда —
 * падает на `tryGrowAnyCity» (рост населения СУЩЕСТВУЮЩЕГО города) — тот самый фолбэк. Вне Экспансии
 * основать точно негде (иначе режим был бы Экспансией), поэтому сам розыгрыш карты автоматически
 * решит, основывать или расти, в зависимости от текущего режима. Карта `population` («Население»,
 * заменила невостребованную «Мобилизацию», по прямому запросу) — НЕ то же самое и не в этой сноске:
 * растит население СРАЗУ ВСЕХ своих городов на 1 (до потолка 6, а не обычной вместимости), за N
 * разных пищевых видов (N = число городов), одним платежом, без выбора цели — стоит своей ОБЫЧНОЙ
 * позицией в каждом списке ниже, а не веткой `settler`.
 *
 * «Распродажа» (`sale`) — карта, которой в исходной таблице заказчика нет вовсе (появилась в игре уже
 * после неё, см. GameSession.playSaleCard: платит по 1 ресурсу каждой из 3 категорий и сбрасывает всю
 * остальную руку ради денег). Раз готовой позиции для неё в листе нет, по отдельному прямому запросу
 * (не связанному с буквой таблицы) она вставлена прямо ПЕРЕД «Катастрофой» в каждом списке — играется,
 * когда всё приоритетнее уже разыграно или недоступно, тем же «последний резерв» смыслом, что и сама
 * «Катастрофа» правее её.
 *
 * Вне этих списков намеренно оставлена ОДНА карта-средство, которая не конкурирует за приоритет, а
 * РАСШИРЯЕТ возможности хода и потому пробуется до основного цикла (см. playEnablerCards):
 * «Право прокладки маршрута» (`routeRight` — вовсе не тратит действие). Там же, по сноске таблицы,
 * живёт правило «не хватает ресурса на приоритетную карту → сначала Рабочий/Строитель, затем биржа».
 *
 * Никакой зависящей от состояния позиции («Сбор налогов» по знаку дохода и т.п.) в листе нет —
 * прежняя версия (`taxes+`/`taxes-` в столбце ВОЙНА) была основана на более раннем ручном переносе
 * таблицы, разошедшемся с реальным листом; убрана целиком, «Сбор налогов» — одна позиция `taxes`,
 * как и в любом другом режиме. */
const CARD_PRIORITY_BY_MODE: Record<StrategicPriority, string[]> = {
  expansion: ["settler", "population", "scientist", "tradeRoute", "trader", "sale", "catastrophe", "taxes", "warrior", "builder", "forestGrowth", "worker"],
  victory: ["scientist", "tradeRoute", "settler", "population", "trader", "sale", "catastrophe", "taxes", "builder", "forestGrowth", "warrior", "worker"],
  development: ["scientist", "settler", "population", "builder", "tradeRoute", "sale", "catastrophe", "trader", "taxes", "warrior", "forestGrowth", "worker"],
  defense: ["settler", "population", "scientist", "warrior", "tradeRoute", "sale", "catastrophe", "builder", "trader", "taxes", "forestGrowth", "worker"],
  warPrep: ["settler", "population", "scientist", "builder", "warrior", "sale", "catastrophe", "trader", "taxes", "tradeRoute", "forestGrowth", "worker"],
  war: ["warrior", "settler", "population", "scientist", "trader", "sale", "catastrophe", "tradeRoute", "forestGrowth", "builder", "worker", "taxes"],
};

/** Готовый порядок карт для текущей стратегии — сама таблица, с ОДНИМ разрешением позиции: при
 * большой руке «Распродажа» поднимается на самый верх, НО только на ПОСЛЕДНЕМ действии хода
 * (`actionsLeft <= 1`) — по прямому уточнению («лучше играть её последним действием, так AI хотя бы
 * успеет что-то ещё сделать»). Раньше поднималась на верх при ЛЮБОМ оставшемся действии, как только
 * рука доросла до порога — из-за жадного «Распродажа прямо сейчас» AI играл её ПЕРВЫМ действием хода
 * и терял шанс разыграть другие ценные карты (Поселенец/Учёный и т.п.) этим же ходом: «Распродажа»
 * сбрасывает «всю ОСТАЛЬНУЮ руку» (см. cards.ts) СРАЗУ по розыгрышу, так что всё, что не сыграно ДО
 * нее в этот же ход, теряется без своего эффекта.
 *
 * Исходная причина порога (живой баг-репорт: «у жёлтого на руках много карт, сыграв все он всё равно
 * в конце больше лимита, но есть карта «Распродажа», а он её не играет») никуда не делась — при
 * большой руке с несколькими играбельными высокоприоритетными картами КАЖДЫЙ заход успешно играет
 * что-то другое, и «Распродажа» (обычная позиция — см. CARD_PRIORITY_BY_MODE) рискует не получить
 * СВОЕГО действия НИ РАЗУ за весь ход, пока переполнение не превратится в вынужденный сброс руки
 * (ТЗ 2.3) с негативными эффектами карт (§15.4/§2 СПРАВОЧНИКА) вместо честных 2💰 за каждую. Проверка
 * на ПОСЛЕДНЕМ действии хода (`actionsLeft<=1`) гарантирует ровно то же самое (если к концу хода рука
 * всё ещё ≥HAND_SIZE=7 — «Распродажа» точно получит слово), просто позволяя более ценным картам
 * сыграть первыми на РАННИХ действиях того же хода, если они и так добрались бы до розыгрыша. Порог —
 * тот же `HAND_SIZE=7`, что и у аварийной применимости «Налогов» (`taxesApplicable`) — рука уже на
 * грани вынужденного сброса (≥8).
 *
 * Второе такое же разрешение — «Воин», тем же приёмом, ТОЛЬКО на последнем действии хода (по прямому
 * запросу — живой баг-репорт: «почему AI не строят корабли? За всю партию ни одного даже у морских
 * держав»): `tryEnsureMinimumShips` (см. её doc) гарантирует, что РАЗЫГРАННЫЙ «Воин» при нехватке
 * флота (`requiredShipCount`) построит именно Корабль, но саму карту ещё нужно ДОИГРАТЬ — в мирном
 * режиме «Воин» стоит почти в самом низу `CARD_PRIORITY_BY_MODE`, и при большой руке с несколькими
 * играбельными картами до него часто не доходит очередь ни разу за весь ход, так что нехватка флота
 * никогда не закрывается. На последнем действии, если флота всё ещё не хватает, «Воин» поднимается в
 * начало списка — тем же самым «последний шанс сыграть» приёмом, что и у «Распродажи» выше. Обе
 * проверки независимы и могут сработать в один и тот же заход — «Распродажа» тогда стоит первой
 * (побег от вынужденного сброса руки срочнее одного хода промедления с флотом), «Воин» — сразу за ней. */
function cardPriorityFor(session: GameSession, playerId: number): string[] {
  const base = CARD_PRIORITY_BY_MODE[computeStrategicPriority(session, playerId)];
  if (session.actionsLeft[playerId] > 1) return base;
  let result = base;
  const shipDeficit =
    session.researchedTechs[playerId].has("Мореплавание") && session.units.filter((u) => u.playerId === playerId && u.category === "ship").length < requiredShipCount(session, playerId);
  if (shipDeficit) result = ["warrior", ...result.filter((id) => id !== "warrior")];
  if (session.hands[playerId].length >= HAND_SIZE) result = ["sale", ...result.filter((id) => id !== "sale")];
  return result;
}

/** Стратегический приоритет → какие категории юнитов поднять к началу очереди (см.
 * decideUnitCategoryPriority). «Война»/«Подготовка к войне» — наступательные категории вперёд,
 * готовить или наращивать армию (Дальняя атака добавлена той же правкой, что и чередование
 * Штурмовые/Поддержка/Дальняя атака по счётчику в decideUnitCategoryPriority — раньше отсутствовала
 * здесь вовсе, из-за чего в этом режиме демоутилась ниже Обороны/Флота независимо от того, что решило
 * чередование). Флот добавлен той же логикой (по прямому уточнению, живой баг-репорт — «зачем лучник,
 * если корабль критичнее»): у `decideUnitCategoryPriority` есть СВОИ веские причины поднять «ship» в
 * самое начало — застрявший/изолированный юнит нуждается в переброске, или план войны требует флота
 * для переброски всей группировки (`plan.requiresNavy`) — раньше это решение здесь безусловно
 * перечёркивалось: Флот не входил в буст-набор и демоутился НИЖЕ всех 4 наступательных категорий
 * независимо от того, насколько критична причина. Без ship в наборе бот предпочитал строить
 * Поддержку/Дальнюю атаку в бесполезном месте вместо решения реальной проблемы связности армии.
 * «Оборона» — оборонительные категории, догнать соседа не рискуя. */
const UNIT_PRIORITY_BOOST: Partial<Record<StrategicPriority, UnitCategory[]>> = {
  war: ["assault", "mobile", "ranged", "support", "ship"],
  warPrep: ["assault", "mobile", "ranged", "support", "ship"],
  defense: ["defense"],
};
/** НЕ переиспользует общий `boostToFront` (тот навязывает СВОЙ фиксированный порядок среди
 * поднятых элементов) — здесь порядок внутри поднятой группы должен остаться тем, что уже посчитал
 * decideUnitCategoryPriority (чередование по счётчику юнитов каждой категории), «поднять к началу»
 * должно означать только «эта группа впереди Обороны/Флота-по-остаточной-квоте», не «Штурмовые
 * всегда первыми независимо от счёта» — та фиксация была самой причиной бага «строит одни Штурмовые
 * подряд» в режиме «Подготовка к войне» (см. doc выше). */
function applyStrategicPriorityToUnits(priority: UnitCategory[], mode: StrategicPriority): UnitCategory[] {
  const boost = UNIT_PRIORITY_BOOST[mode];
  if (!boost) return priority;
  const boosted = new Set(boost);
  const front = priority.filter((c) => boosted.has(c));
  const rest = priority.filter((c) => !boosted.has(c));
  return [...front, ...rest];
}

/** Разыгрывает первую карту указанного id, для которой найдётся играбельный слот в руке (в руке
 * может быть несколько копий одной и той же карты) — тот же tryPlayCardSlot, просто перебор слотов
 * идёт СНАЧАЛА по нужному id, а не по позиции в руке. */
/** Среди НЕСКОЛЬКИХ слотов руки с одним и тем же id — обычная (настоящая, из колоды) карта пробуется
 * РАНЬШЕ бесплатной (`freeMonarchy`/`freeFascism`/`freeParliamentarism`, по прямому запросу — живой
 * баг-репорт: «зелёный играет Рабочего, который даётся Монархией, хотя есть обычные Рабочие —
 * обычные в приоритете, чтобы снизить число карт в руке»): бесплатная карта, СЫГРАННАЯ или нет,
 * восстанавливается заново каждый ЦИКЛ (`GameSession.grantMonarchyWorkerCards`/
 * `grantFascismWarriorCards`/`grantParliamentarismBuilderCards` — ровно 1 штука на игрока, пока
 * действует парадигма) и наравне с обычными считается в лимит руки (`handCountedSize`) — то есть
 * сама по себе НЕ помогает надолго снизить число карт: разыгранная сейчас, она просто вернётся на
 * следующем цикле. Настоящая же карта, будучи разыграна, пропадает НАВСЕГДА — это и есть реальный
 * прогресс к тому, чтобы рука не переполнялась (см. mustHandoff/resolveHandOverflowDiscard).
 * `freeEducation`/`freeBuilding`/`freeForestGrowth` сюда намеренно НЕ входят — те одноразовые (не
 * восстанавливаются), розыгрыш даёт тот же самый постоянный прогресс, что и обычная карта. */
function tryPlayCardId(session: GameSession, playerId: number, cardId: string, reporter: Reporter): boolean {
  const hand = session.hands[playerId];
  const isFree = (c: CardDef) => c.freeMonarchy || c.freeFascism || c.freeParliamentarism;
  for (const preferFree of [false, true]) {
    for (let i = 0; i < hand.length; i++) {
      const card = hand[i];
      if (card?.id === cardId && !!isFree(card) === preferFree && tryPlayCardSlot(session, playerId, i, cardId, reporter)) return true;
    }
  }
  return false;
}

/** Выбор ОДНОЙ карты для розыгрыша за этот заход общего цикла хода — по приоритету выше, с
 * исключениями по прямому запросу: не удалась карта, которая обычно упирается в нехватку РЕСУРСОВ
 * («Поселенец», «Учёный», «Строитель», «Воин», «Торговый путь», «Торговец») — тут же, тем же
 * заходом, пробует «Рабочего» вместо спуска ниже по списку («Рабочий — средство для цели, а не
 * самоцель», по прямому запросу: единственная причина вообще играть его ВНЕ собственной, самой
 * низкой цели — обслужить цель, которой прямо сейчас не хватило ресурсов). Для «Поселенца» это даёт
 * саму комбинацию «сначала Рабочий за пищевым ресурсом, потом Поселенец» — на СЛЕДУЮЩЕМ заходе того
 * же хода «Поселенец» снова наверху приоритета и, если ресурса теперь хватает, успешно основывает
 * город.
 *
 * [ИСПРАВЛЕНО, живой баг-репорт — «AI не активно играет «Торговца» — проверить, идёт ли сбор
 * торговых ресурсов под него»] — «Торговец» здесь раньше не было вовсе: `GameSession.traderTrade`
 * честно отказывает разыгрывать карту, если во всей торговой сети И на складе нет НИ ОДНОГО
 * торгового ресурса («играть нечем») — а без этой записи «Рабочий» никогда не пытался проактивно
 * добыть торговый ресурс СПЕЦИАЛЬНО ради «Торговца»: если у игрока не оказалось ни единого торгового
 * ресурса на старте (не повезло с регионом), карта простаивала в руке НЕОГРАНИЧЕННО долго, раз за
 * разом проваливаясь по одной и той же причине — то самое «AI не играет Торговца». */
const RESOURCE_HUNGRY_CARDS = new Set(["scientist", "builder", "settler", "warrior", "tradeRoute", "trader"]);
/** Из RESOURCE_HUNGRY_CARDS — только эти двум реально не хватает именно ЕДЫ (основание/рост города
 * прямо требуют категорию "food" в стоимости, см. GameSession) — используется и приоритетом выбора
 * ресурса Рабочим (ниже), и ограничением объёма сбора «про запас под эту цель» (см. foodGrowthGap). */
const FOOD_TARGET_CARDS = new Set(["settler"]);

/** «Строитель» — единственная карта из RESOURCE_HUNGRY_CARDS, которая может провалиться НЕ из-за
 * нехватки ресурсов вовсе: если ни одно ещё не построенное здание сейчас не открыто технологией
 * (§5), а запасной вариант — вырубка леса — не входит в недостачу никакой текущей цели (см.
 * `builderMissingResourceIds`/tryBuilder — никакого «про запас» по общему порогу склада больше нет),
 * «Рабочий»-фолбэк ниже НИЧЕМ не поможет — собирать ему было бы нечего под задачу (живой баг-репорт:
 * «собирает еду для Строителя, хотя еды уже достаточно» — настоящая причина провала была не в еде, а
 * в этом гейте, «Рабочий» просто не разбирал причину и всё равно пытался). Возвращает true, только
 * если хотя бы одно ещё не построенное здание технологически доступно ПРЯМО СЕЙЧАС (значит, дело
 * действительно может быть в ресурсах на него) — либо вырубка леса всё ещё осмысленна (дерево реально
 * входит в недостачу текущей цели; на практике это условие подразумевает techReady само по себе —
 * missingResourceIds пуст без построечной цели, — но проверяется отдельно, а не через устаревший
 * складской порог, чтобы не разойтись с реальным условием в tryBuilder). */
function builderCouldUseWorker(session: GameSession, playerId: number): boolean {
  const techReady = buildingPriorityOrder(session, playerId).some(
    (b) => !isOwnedBy(session.buildingOwners, b.id, playerId) && (b.tech === null || session.researchedTechs[playerId].has(b.tech))
  );
  return techReady || builderMissingResourceIds(session, playerId).has("wood");
}

/** Число РАЗНЫХ видов торгового ресурса на складе — «Торговый путь» (любой из 3 режимов — новый/
 * перенаправить/удалить) требует ровно 2 (см. `GameSession.layNewTradeRoute`: «Нужно 2 РАЗНЫХ вида
 * торгового ресурса на складе»). */
function distinctTradeResourceCount(session: GameSession, playerId: number): number {
  return new Set(
    (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(([id, qty]) => qty > 0 && RESOURCE_CATEGORY.get(id) === "trade").map(([id]) => id)
  ).size;
}

/** «Торговый путь» — единственная причина, по которой «Рабочему»-СРЕДСТВУ вообще есть смысл сюда
 * помогать — нехватка РАЗНЫХ видов торгового ресурса на складе (см. distinctTradeResourceCount); уже
 * 2+ — карта отказала по чему-то другому (нет допустимой пары городов/пути, война с единственным
 * кандидатом и т.п.), собирать ещё ресурсы незачем. */
function tradeRouteCouldUseWorker(session: GameSession, playerId: number): boolean {
  return distinctTradeResourceCount(session, playerId) < 2;
}

/** «Население» реально неиграбельна ПРЯМО СЕЙЧАС — та же проверка, что и сам `GameSession.
 * usePopulationCard` (N = число городов РАЗНЫХ пищевых, `allowAccess=false` — доступ региона в этой
 * карте не участвует вовсе, только склад и рынок), только как read-only предсказание для приоритета
 * передачи карты ниже (`doMandatoryHandoff`), без реальной траты. Жадный выбор «сначала бесплатное
 * с о склада, недостающее — самые дешёвые НОВЫЕ виды рынка по возрастанию цены» — тот же результат
 * по достижимости count'а, что и настоящий перебор в `planFoodSpend` (порядок конкретных ресурсов
 * внутри платежа роли не играет, важно только само число различных видов). */
function populationCardUnplayable(session: GameSession, playerId: number): boolean {
  const req = myCities(session, playerId).length;
  if (req === 0) return true;
  const isFoodOrJoker = (id: ResourceId) => RESOURCE_CATEGORY.get(id) === "food" || id === "promtovary";
  const warehouseTypes = new Set(
    (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(([id, qty]) => qty > 0 && isFoodOrJoker(id)).map(([id]) => id)
  );
  let need = req - warehouseTypes.size;
  if (need <= 0) return false;
  let moneyBudget = session.money[playerId];
  const marketPricesByType = new Map<ResourceId, number>();
  for (const l of session.market) {
    if (l.kind !== "resource" || l.sellerId === playerId || !l.resource || !isFoodOrJoker(l.resource) || warehouseTypes.has(l.resource)) continue;
    const best = marketPricesByType.get(l.resource);
    if (best === undefined || l.price < best) marketPricesByType.set(l.resource, l.price);
  }
  const cheapestFirst = [...marketPricesByType.values()].sort((a, b) => a - b);
  for (const price of cheapestFirst) {
    if (need <= 0) break;
    if (price > moneyBudget) break;
    moneyBudget -= price;
    need--;
  }
  return need > 0;
}

/** Общая проверка «карта прямо сейчас мёртвый груз» — для `doMandatoryHandoff`: только те карты, чей
 * гейт «хватает ли ресурсов» дёшево и точно проверяется без побочных эффектов (склад/рынок/деньги,
 * без учёта конкретной цели на карте — «Строитель»/«Учёный»/«Воин» сюда НЕ входят, их неиграбельность
 * зависит от выбора конкретной цели, а не только от склада). По прямому запросу — живой баг-репорт:
 * «зачем отдавать Строителя (карту действия), когда есть Население, которую всё равно не сыграть —
 * лучше отдать её» — прежняя лестница ранжирует ТОЛЬКО по статичной позиции в приоритете розыгрыша
 * текущего режима, не глядя, реально ли карту можно сыграть ПРЯМО СЕЙЧАС: «Население» почти everywhere
 * стоит высоко в списке (то есть НЕ считается «лишней» по правилу «нижняя половина» ниже), из-за чего
 * дубль другой, вполне играбельной карты уходил на передачу раньше, чем годами простаивающее без
 * ресурсов «Население». */
function cardIsDeadWeight(session: GameSession, playerId: number, cardId: string): boolean {
  if (cardId === "population") return populationCardUnplayable(session, playerId);
  if (cardId === "tradeRoute") return distinctTradeResourceCount(session, playerId) < 2;
  return false;
}

/** С эпохи 5 цена исследования (`GameSession.RESEARCH_COST_LINES`, приватная — не дублируется здесь
 * целиком, только этот конкретный факт) требует СПЕЦИФИЧНО Углеводороды ИЛИ Электричество (1 из
 * двух, не любой другой стратегический вид) — по прямому запросу, живой баг-репорт: «жёлтому не
 * хватает на карту «Учёный», хотя та же куча разных ресурсов» — «куча» была из Редкоземельных
 * (тоже категория "strategic"), из-за чего общая проверка «категория не набрана» (§56-72,
 * `warehouseCategoryTotal`) считала стратегическую нужду уже закрытой, хотя реально не хватало
 * именно ЭТОГО конкретного вида. Признак «пора охотиться за Углеводородами специально» — на руках
 * НЕТ ни одной технологии дешевле эпохи 5 (значит, ближайшая реально доступная — уже 5+, и она ТОЧНО
 * потребует этот anyOf) — и на складе нет ни Углеводородов, ни Электричества вовсе. */
function needsHydrocarbonsForResearch(session: GameSession, playerId: number): boolean {
  const researched = session.researchedTechs[playerId];
  if (TECH_TREE.some((t) => t.epoch < 5 && !researched.has(t.id))) return false;
  const warehouse = session.warehouse[playerId] ?? {};
  return (warehouse.hydrocarbons ?? 0) === 0 && (warehouse.electricity ?? 0) === 0;
}

/** Тот же принцип, что needsHydrocarbonsForResearch/needsRareEarthForResearch, для ТРЕТЬЕЙ
 * специфичной строки цены эпохи 6 (`RESEARCH_COST_LINES[6]`) — Уран. По прямому запросу — живой
 * баг-репорт: «не оптимальное использование рабочих сейчас для открытия научного, можно
 * распределить их так, чтоб хватило на открытие, если купить недостающее на бирже» — расследование
 * показало, что Металл (тоже нужен эпохе 6) РЕАЛЬНО докупается автоматом с рынка внутри
 * confirmResearch (см. §10 «Доступ → склад → рынок», планBuildingSpend), значит гоняться Рабочим
 * именно за ним не нужно — рынок сам справится, если хватит денег. А вот Уран (как и Редкоземельные)
 * — НЕ один из 6 постоянных лотов «Мирового рынка» (см. §10 — там только Злаки/Рыба/Овощи/
 * Силикаты/Металл/Хлопок), купить его гарантированно НЕЛЬЗЯ (разве что случайно нашёлся лот другого
 * игрока) — без специального приоритета Рабочий мог продолжать собирать уже профицитную категорию
 * (обычная проверка «хватает ли категории strategic» уже удовлетворена одними Углеводородами/
 * Редкоземельными, хотя Урана нет ни единицы) вместо того, чтобы охотиться именно за Ураном. */
function needsUraniumForResearch(session: GameSession, playerId: number): boolean {
  const researched = session.researchedTechs[playerId];
  if (TECH_TREE.some((t) => t.epoch < 6 && !researched.has(t.id))) return false;
  const warehouse = session.warehouse[playerId] ?? {};
  return (warehouse.uranium ?? 0) === 0;
}

/** Сколько ещё РАЗНЫХ пищевых видов реально не хватает, чтобы рост населения (фолбэк «Поселенца»,
 * когда расширяться уже некуда, см. tryGrowAnyCity) стал играбелен у ближайшего годного города (тот
 * же порядок цели, что и сам рост — тир региона, потом наименьшее население) — по прямому запросу,
 * живой баг-репорт: «зелёный собирает много разных пищевых ресурсов для роста, явно больше, чем
 * требуется — часть уже есть на складе; лишний Рабочий лучше сыграть на другую карту или собрать
 * впрок». Консервативная ВЕРХНЯЯ оценка по одному складу (не дублирует приватную `planFoodSpend` —
 * та ещё учитывает доступ региона за цикл и рынок, здесь не воспроизводится намеренно, чтобы не
 * разъезжаться с авторитетной проверкой в GameSession): если различных пищевых видов на складе УЖЕ
 * не меньше населения этого города, считаем нехватку нулевой — Рабочему сюда, скорее всего, нести
 * уже нечего (реальная причина отказа `growCity` — не еда, а что-то ещё, например вместимость города,
 * и добыча ещё еды это не решит). Нет ни одного своего города — нехватка тоже 0 (расти некуда). */
function foodGrowthGap(session: GameSession, playerId: number): number {
  const cities = myCities(session, playerId).sort((a, b) => cityResourceTier(session, a) - cityResourceTier(session, b) || a.population - b.population);
  const city = cities[0];
  if (!city) return 0;
  const distinctFoodOwned = new Set(
    (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][])
      .filter(([id, qty]) => qty > 0 && RESOURCE_CATEGORY.get(id) === "food")
      .map(([id]) => id)
  ).size;
  return Math.max(0, city.population - distinctFoodOwned);
}

/** Карта-СРЕДСТВО, не участвующая в приоритете (см. доку CARD_PRIORITY_BY_MODE) — пробуется ДО
 * основного цикла, потому что не конкурирует с ним за действие, а расширяет сам ход: «Право
 * прокладки маршрута» действия не тратит вовсе. Несбрасываемая: держать её в руке до вынужденного
 * сброса — гарантированный штраф (см. cards.ts), поэтому разыгрывается при первой же реальной
 * возможности. */
const ENABLER_CARDS = new Set(["routeRight"]);
function playEnablerCards(session: GameSession, playerId: number, reporter: Reporter): boolean {
  for (const cardId of ENABLER_CARDS) {
    if (!session.hands[playerId].some((c) => c?.id === cardId)) continue;
    if (tryPlayCardId(session, playerId, cardId, reporter)) return true;
  }
  return false;
}

/** ЕДИНЫЙ цикл выбора карты: идём по списку текущей стратегии сверху вниз и играем первую, что
 * реально получилась. Если карта есть в руке, но не сыграла из-за НЕХВАТКИ РЕСУРСА — по сноске
 * таблицы сначала пробуем добыть нужное «Рабочим» (он же умеет целиться именно под эту карту, см.
 * `forCardId`), и только потом идём дальше по списку; автопокупка недостающего на бирже происходит
 * внутри самого действия (GameSession, доступ → склад → рынок) и отдельного шага не требует.
 *
 * Никакого запасного «переберём остальные карты руки как попало» здесь больше нет: все 12 карт игры
 * присутствуют в каждом списке режима (плюс карта-средство выше), поэтому перебор списка и есть
 * полный перебор руки — в порядке, заданном стратегией, а не случайном.
 *
 * **Рабочего шлём, только если реальная причина провала — именно нехватка РЕСУРСА**, не что-то ещё
 * (по прямому запросу — живой баг-репорт: «фиолетовому грозит вынужденный сброс, а он вместо Учёного/
 * Поселенца [оба реально играбельны] тратит все 3 действия на Рабочих ради Воина») — Воин может
 * провалиться и БЕЗ нехватки ресурса (`armyWithinTaxBudget` — армия уже съедает половину налогового
 * дохода; перевес по активному «Плану войны» уже набран, `WAR_PLAN_FORCE_RATIO`), а прежняя проверка
 * `RESOURCE_HUNGRY_CARDS.has("warrior")` срабатывала БЕЗУСЛОВНО на любой провал: Рабочий уходил
 * собирать ресурс, которого и так хватало, воин всё равно не строился по НАСТОЯЩЕЙ (бюджетной)
 * причине, а цикл — раз `tryWorkerCollect` вернул true (действие потрачено не впустую формально) —
 * останавливался на этом же «заходе», так и не добравшись до следующих карт списка. На СЛЕДУЮЩЕМ
 * заходе того же хода список снова начинается с Воина (он топ приоритета в ВОЙНЕ/ПОДГОТОВКЕ) — тот
 * же бесполезный Рабочий-фолбэк повторяется, пока не кончатся действия или карты «Рабочий» в руке,
 * ни разу не дойдя до Поселенца/Учёного ниже по списку. Тот же класс защиты уже существовал для
 * «Строителя»/«Торгового пути» (`builderCouldUseWorker`/`tradeRouteCouldUseWorker` ниже) — Воину
 * настоящей проверки не хватало, добавлена симметрично (`warriorMissingResourceIds(...).size > 0`,
 * та же диагностика, что уже показывает конкретную нехватку в плане хода). */
/** «Распродажа» (`trySaleCard`) сбрасывает ВСЮ остальную руку, но бесплатные бонусные карты парадигм/
 * технологий (freeMonarchy/freeFascism/freeEducation/freeBuilding/freeParliamentarism/freeForestGrowth)
 * не приносят с неё НИ КОПЕЙКИ — «исчезают без денег» (`GameSession.playSaleCard`) — по прямому
 * запросу, живой баг-репорт: «может сыграть рабочего, что даётся парадигмой, а уже потом сыграть
 * распродажу» — приоритет розыгрыша (`CARD_PRIORITY_BY_MODE`) ставит «Распродажу» ВЫШЕ обычного
 * «Рабочего» почти everywhere, и если в руке лежит именно БЕСПЛАТНЫЙ бонусный «Рабочий» (Монархия),
 * очередь до него по общему приоритету просто не доходила — «Распродажа» срабатывала первой и
 * бесплатно сбрасывала его В НИКУДА, не давая ни его собственной пользы (сбор ресурсов региона), ни
 * денег взамен. Играть такую карту РАНЬШЕ «Распродажи» абсолютно бесплатно с точки зрения самой
 * «Распродажи» — сброшенных ЗА ДЕНЬГИ карт становится на одну меньше, но эта карта и так стоила бы
 * 0💰, так что итоговая выручка не меняется, а бонусный эффект больше не пропадает зря.
 *
 * Вызывается из `pickAndPlayNextCard` ТОЛЬКО когда в ходу останется ещё хотя бы одно действие ПОСЛЕ
 * этого (`actionsLeft > 1`) — по прямому запросу, живой баг-репорт: «распродажа теперь в конце, AI
 * часто её забывает». Раз «Распродажа» намеренно поднимается в приоритете именно на ПОСЛЕДНЕМ
 * действии хода (см. `cardPriorityFor`), эта функция вызывалась бы как раз ТОГДА — и, найдя бесплатную
 * бонусную карту, играла бы её ВМЕСТО «Распродажи» этим самым последним действием: сама «Распродажа»
 * оставалась несыгранной (действий на неё уже не осталось), хотя именно её розыгрыш последним
 * действием хода и должен был гарантироваться. На последнем действии играть саму «Распродажу»
 * напрямую строго не хуже — не потому, что бонусная карта после неё внутри Распродажи бесплатна
 * (это по-прежнему так), а потому, что «сыграть бонусную карту вместо Распродажи и оставить саму
 * Распродажу на руке до следующего хода» не лучше, чем «сыграть Распродажу, бонусная карта уйдёт
 * бесплатно вместе с остальной рукой» — то же нулевое финансовое отличие, но без риска остаться
 * с раздутой рукой ещё на ход. */
function tryPlayAnyFreeBonusCard(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const hand = session.hands[playerId];
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (!card) continue;
    if (!(card.freeMonarchy || card.freeFascism || card.freeEducation || card.freeBuilding || card.freeParliamentarism || card.freeForestGrowth)) continue;
    if (tryPlayCardSlot(session, playerId, i, card.id, reporter)) return true;
  }
  return false;
}

function pickAndPlayNextCard(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const hand = session.hands[playerId];
  // Резерв доступа столицы под гарантированную «Распродажу» последним действием хода (по прямому
  // запросу, живой баг-репорт: «фиолетовый по-прежнему не играет распродажу» — приоритет уже поднимал
  // «Распродажу» на последнее действие верно, см. cardPriorityFor, но к этому моменту её собственную
  // цену (1 Еда + 1 Стратегический + 1 Торговый через доступ СТОЛИЦЫ, см. GameSession.playSaleCard)
  // было уже нечем закрыть — «Рабочий»-подстраховка (ветка RESOURCE_HUNGRY_CARDS ниже) на РАННИХ
  // действиях того же хода выгребала весь бюджет доступа столицы (population-лимит, общий на ВСЕ виды
  // ресурсов города за цикл, см. accessTypesUsedThisCycle) ради карты, которая в итоге ВСЁ РАВНО не
  // сыграла («не хватило Стратегический для «Учёный»» — расход впустую). Пока рука ещё большая
  // (≥HAND_SIZE, «Распродажа» будет поднята позже) и «Распродажа» ещё лежит в руке несыгранной, этот
  // подстраховочный сбор просто пропускается — карта-цель (Учёный/Строитель/...) в этом заходе честно
  // проваливается и уступает очередь ниже по списку, но доступ столицы доживает до момента, когда
  // «Распродажа» реально его востребует.
  const reserveAccessForSale = hand.length >= HAND_SIZE && hand.some((c) => c?.id === "sale");
  for (const cardId of cardPriorityFor(session, playerId)) {
    if (!hand.some((c) => c?.id === cardId)) continue;
    if (cardId === "sale" && session.actionsLeft[playerId] > 1 && tryPlayAnyFreeBonusCard(session, playerId, reporter)) return true;
    if (tryPlayCardId(session, playerId, cardId, reporter)) return true;
    if (
      !reserveAccessForSale &&
      RESOURCE_HUNGRY_CARDS.has(cardId) &&
      (cardId !== "builder" || builderCouldUseWorker(session, playerId)) &&
      (cardId !== "tradeRoute" || tradeRouteCouldUseWorker(session, playerId)) &&
      (cardId !== "warrior" || warriorMissingResourceIds(session, playerId).size > 0) &&
      (!FOOD_TARGET_CARDS.has(cardId) || foodGrowthGap(session, playerId) > 0)
    ) {
      // Напрямую в tryWorkerCollect (не через tryPlayCardId) — чтобы передать `forCardId` и подписать
      // в плане, ДЛЯ КАКОЙ карты «Рабочий» на самом деле собирает ресурс (по прямому запросу). Тот же
      // приоритет «обычная карта раньше бесплатной Монархии», что и в tryPlayCardId (см. его доку) —
      // здесь свой отдельный поиск слота (без tryPlayCardId), так что приоритет продублирован.
      const normalWorkerSlot = hand.findIndex((c) => c?.id === "worker" && !c.freeMonarchy);
      const workerSlot = normalWorkerSlot !== -1 ? normalWorkerSlot : hand.findIndex((c) => c?.id === "worker");
      if (workerSlot !== -1 && tryWorkerCollect(session, playerId, workerSlot, "worker", reporter, cardId)) return true;
    }
  }
  return false;
}

// === Розыгрыш одной карты из руки — диспетчер по card.id ========================================

function tryPlayCardSlot(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  switch (cardId) {
    case "sale":
      return trySaleCard(session, playerId, slotIndex, cardId, reporter);
    case "settler":
      return tryFoundOrGrowCity(session, playerId, slotIndex, cardId, reporter);
    case "warrior":
      return (
        tryBuildArmyUnit(session, playerId, slotIndex, cardId, reporter) ||
        tryEnsureMinimumShips(session, playerId, slotIndex, cardId, reporter) ||
        tryBuildUnitByZone(session, playerId, slotIndex, cardId, reporter) ||
        tryBuildUnit(session, playerId, slotIndex, cardId, reporter)
      );
    case "builder":
      return tryBuilder(session, playerId, slotIndex, cardId, reporter);
    case "worker":
      return tryWorkerCollect(session, playerId, slotIndex, cardId, reporter);
    case "trader":
      return tryTrade(session, playerId, slotIndex, cardId, reporter);
    case "scientist":
      return tryResearch(session, playerId, slotIndex, cardId, reporter);
    case "forestGrowth":
      return tryPlantForest(session, playerId, slotIndex, cardId, reporter);
    case "tradeRoute":
      return tryLayTradeRoute(session, playerId, slotIndex, cardId, reporter);
    case "taxes":
      return tryTaxes(session, playerId, slotIndex, cardId, reporter);
    case "catastrophe":
      return tryCatastrophe(session, playerId, slotIndex, cardId, reporter);
    case "population":
      return tryPopulationCard(session, playerId, slotIndex, cardId, reporter);
    case "routeRight":
      return tryRouteRight(session, playerId, slotIndex, cardId, reporter);
    default:
      return false;
  }
}

function myCities(session: GameSession, playerId: number) {
  return session.cities.filter((c) => c.playerId === playerId);
}

/** category региона города — 0 (стратегические ресурсы в наличии) / 1 (пищевые) / 2 (торговые) / 3
 * (ничего из вышеперечисленного) — используется фолбэком роста «Поселенца» ниже. */
function cityResourceTier(session: GameSession, city: { regionCol: number; regionRow: number }): number {
  const categories = new Set(session.resourcesInRegion(city.regionCol, city.regionRow).map((r) => RESOURCE_CATEGORY.get(r)));
  if (categories.has("strategic")) return 0;
  if (categories.has("food")) return 1;
  if (categories.has("trade")) return 2;
  return 3;
}

/** Рост населения без основания города (фолбэк «Поселенца», когда расширяться уже некуда, см.
 * tryFoundOrGrowCity) — по прямому запросу «распределять равномерно население, поднимая в первую
 * очередь там, где стратегические ресурсы, потом пищевые, потом торговые»: сортировка по тиру
 * ресурса региона (см. cityResourceTier), а внутри тира — по возрастанию населения. */
function tryGrowAnyCity(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const cities = myCities(session, playerId).sort((a, b) => cityResourceTier(session, a) - cityResourceTier(session, b) || a.population - b.population);
  for (const city of cities) {
    const payload = { slotIndex, cityIds: [city.id] };
    const result = session.dispatch("growCity", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "growCity", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Увеличил население города (${city.col},${city.row}).${marketSpendNote(result)}` });
      return true;
    }
  }
  return false;
}

/** Ресурс → сколько тайлов этого вида уже есть в СВОИХ регионах игрока — метрика «нехватки» для
 * остаточного принципа приоритета поселенца ниже. */
function ownedResourceCounts(session: GameSession, playerId: number): Map<ResourceId, number> {
  const counts = new Map<ResourceId, number>();
  for (const region of ownedRegionsOf(session, playerId)) {
    const [rc, rr] = region.split(",").map(Number);
    for (const r of session.resourcesInRegion(rc, rr)) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return counts;
}

/** По прямому запросу дословно — приоритет региона под НОВОЕ поселение: «если нет металлических
 * руд, занять регион с металлом; если металл уже есть или недоступен, следующий — углеводороды; за
 * ними платина [Драгоценные металлы] и уран», и уже по остаточному — каких ресурсов не хватает или
 * меньше. Тиры 0-3 — регион содержит один из 4 перечисленных ресурсов, в этом порядке (по прямому
 * уточнению — «платина и уран» заменили «уран и редкоземельные»: Редкоземельные больше не отдельный
 * именованный тир, попадают в общий остаточный принцип наравне со всем прочим); иначе — тир 4+ по
 * возрастанию (меньше = приоритетнее), смещённый на количество уже имеющихся у игрока тайлов самого
 * дефицитного ресурса этого региона («не хватает или меньше» — чем меньше уже есть, тем более
 * приоритетен регион). */
const SETTLER_RESOURCE_GAP_PRIORITY: ResourceId[] = ["metalOre", "hydrocarbons", "preciousMetals", "uranium"];
function settlerRegionScore(session: GameSession, rc: number, rr: number, ownedCounts: Map<ResourceId, number>): number {
  const resources = new Set(session.resourcesInRegion(rc, rr));
  for (let i = 0; i < SETTLER_RESOURCE_GAP_PRIORITY.length; i++) {
    if (resources.has(SETTLER_RESOURCE_GAP_PRIORITY[i])) return i;
  }
  if (!resources.size) return 100;
  let minCount = Infinity;
  for (const r of resources) minCount = Math.min(minCount, ownedCounts.get(r) ?? 0);
  return SETTLER_RESOURCE_GAP_PRIORITY.length + minCount;
}

/** Карта «Поселенец» — по прямому запросу приоритет НОВОМУ поселению (закрывает пробелы в ресурсах,
 * см. settlerRegionScore) над ростом населения существующих городов; клик целится в примерный центр
 * региона — foundCity сам находит ближайший подходящий тайл суши внутри него (landTileForRegion).
 * Рост населения — запасной вариант, если ни в одном приграничном свободном регионе город поставить
 * не вышло (весь лёд, враг рядом, или свободных регионов не осталось вовсе). */
function tryFoundOrGrowCity(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const ownedCounts = ownedResourceCounts(session, playerId);
  const candidates = unclaimedNearbyRegions(session, playerId).sort(
    (a, b) => settlerRegionScore(session, a.rc, a.rr, ownedCounts) - settlerRegionScore(session, b.rc, b.rr, ownedCounts)
  );
  let blockedByFood = false;
  for (const { rc, rr } of candidates) {
    const site = session.pickCitySiteInRegion(rc, rr) ?? {
      col: rc * REGION_SIZE_X + Math.floor(REGION_SIZE_X / 2),
      row: rr * REGION_SIZE_Y + Math.floor(REGION_SIZE_Y / 2),
    };
    const payload = { slotIndex, col: site.col, row: site.row };
    const result = session.dispatch("foundCity", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "foundCity",
        payload,
        cardSlotIndex: slotIndex,
        cardId,
        targetKind: "hex",
        targetCol: site.col,
        targetRow: site.row,
        label: `Основал новое поселение в регионе (${rc},${rr}).${marketSpendNote(result)}`,
      });
      return true;
    }
    // GameSession.foundCity намеренно платит ТОЛЬКО со склада/рынка, не доступом региона (см. её
    // комментарий — «для поселенца нужен ресурс со склада, а не с клетки, куда ставится поселение»).
    if (result.hint?.includes("Нет ни одного пищевого ресурса")) blockedByFood = true;
  }
  // По прямому запросу («AI толкается от задачи, задача высшего приоритета — занятие новых
  // территорий, Рабочий должен обслужить интересы ИМЕННО этой задачи») — живой баг-репорт: были
  // валидные незанятые регионы (candidates непуст), но основание срывалось ИСКЛЮЧИТЕЛЬНО из-за
  // нехватки еды на складе — и функция молча откатывалась на рост населения, ни разу не дав внешнему
  // RESOURCE_HUNGRY_CARDS-фолбэку (pickAndPlayNextCard) попробовать «Рабочего» под эту же карту.
  // Хуже того — сам рост (tryGrowAnyCity/GameSession.growCity) платит ДОСТУПОМ региона (в отличие от
  // foundCity), который может СЪЕСТЬ тот самый единственный пищевой вид региона МИМО склада — начисто
  // отрезая основание в этом же цикле, хотя причина была всего лишь «ещё не собрано на склад».
  // Теперь при «есть куда, но не с чем» возвращаем false вместо тихого отката — внешний фолбэк сам
  // пошлёт «Рабочего» ЗА ЕДОЙ НА СКЛАД (а не через доступ), и на следующем заходе того же хода
  // «Поселенец» получит реальный шанс основать город по-настоящему. Откат на рост остаётся ТОЛЬКО
  // когда валидных регионов вообще нет (candidates пуст) — тот случай, для которого он и задумывался.
  if (candidates.length > 0 && blockedByFood) return false;
  return tryGrowAnyCity(session, playerId, slotIndex, cardId, reporter);
}

/** Налоговый доход игрока (см. GameSession.collectTaxes — приближение: `totalPopulationOf ×
 * aiIncomeMultiplier`, продублировано здесь как маленькая approximation-таблица, тем же приёмом,
 * что и everywhere else в этом файле) — используется бюджетной проверкой армии ниже и позицией
 * «Сбор налогов» в режиме ВОЙНА (по знаку дохода, см. cardPriorityFor). */
function taxIncomeEstimate(session: GameSession, playerId: number): number {
  const pop = myCities(session, playerId).reduce((sum, c) => sum + c.population, 0);
  const isAI = session.players.find((p) => p.id === playerId)?.isAI;
  return pop * (isAI ? 2 : 1);
}

/** Реальное содержание (юниты + здания) ДО фашистской скидки (та ещё не применена — используется,
 * чтобы РЕШИТЬ, принимать ли Фашизм) — с учётом «Кодекс законов» у этого игрока, тем же округлением
 * вниз, что и GameSession.collectTaxes. */
function unitsAndBuildingsUpkeepEstimate(session: GameSession, playerId: number): number {
  const raw = countUnitsOf(session, playerId) + builtBy(session.buildingOwners, playerId).length;
  return session.techDiscoverer["Кодекс законов"] === playerId ? Math.floor(raw / 2) : raw;
}

/** Отношения AI — ненависть (по прямому запросу, шкала 0-10 = «Ненависть», см. RelationTier): «если
 * AI с кем-то в ненавистных отношениях, приоритет смещается на войну, и AI наращивает армию сколько
 * может, даже если не позволяет бюджет (не играет налоги из-за убытка)» — первый живой игрок с таким
 * мнением о нём (null, если такого нет). Первый попавшийся, а не «самый ненавистный» — по формулировке
 * достаточно самого ФАКТА ненависти к кому-то, не важно, к кому именно из нескольких. */
function hasHatedEnemyOf(session: GameSession, playerId: number): number | null {
  const hated = session.players.find((p) => p.id !== playerId && !session.eliminatedPlayers.has(p.id) && session.relationScoreOf(playerId, p.id) < 10);
  return hated ? hated.id : null;
}

/** По прямому запросу — «строят воинов только если позволяет бюджет... если армия будет требовать
 * более половины дохода, её лучше не растить»: содержание юнита в GameSession.collectTaxes стоит
 * ровно 1💰 за штуку, независимо от категории/эпохи, так что порог — просто «число юнитов (+ тот,
 * что собираемся построить) не больше половины налогового дохода». Дохода вообще нет (0 или меньше)
 * — тем более не растим. Отношения AI — ненависть (см. hasHatedEnemyOf выше) ОБХОДИТ этот бюджетный
 * потолок целиком, по прямому запросу («наращивает армию сколько может, даже если не позволяет
 * бюджет»). */
function armyWithinTaxBudget(session: GameSession, playerId: number, extraUnits = 1): boolean {
  if (hasHatedEnemyOf(session, playerId) !== null) return true;
  const income = taxIncomeEstimate(session, playerId);
  if (income <= 0) return false;
  return countUnitsOf(session, playerId) + extraUnits <= income / 2;
}

/** Состав армии по прямому запросу (см. decideUnitCategoryPriority) — пробует категории в порядке
 * приоритета, внутри категории берёт лучший (старшая эпоха) доступный юнит первым, перебирая города
 * — при активной войне ближайший к ФРОНТУ город идёт первым («новые юниты... производятся в
 * ближайшем городе», по прямому запросу; «нужно смотреть, в каком именно регионе у противника больше
 * сил, и строить там или в соседнем» — см. warFrontHex/strongestEnemyForceHex: фронт теперь это
 * регион реального скопления вражеских ВОЙСК, а не просто самый населённый вражеский город), иначе
 * порядок городов произвольный; если предпочтительная категория недоступна нигде (нет
 * технологии/ресурсов/выхода в море для кораблей), переходит к следующей по приоритету, а не
 * блокирует карту «Воин» насмерть. Не строит вовсе, если это вывело бы армию за налоговый бюджет (см.
 * armyWithinTaxBudget, по прямому запросу). */
/** По прямому запросу — «выводить из переполненного гарнизона на самый защищённый ближайший
 * свободный гекс» (гарнизон ограничен `GameSession.CITY_GARRISON_CAP`=2, оба юнита в пределах лимита
 * полноценно командуемы — см. её doc): BFS расширяющимися кольцами вокруг `unit`, среди РЕАЛЬНО
 * проходимых и свободных для него гексов (`canEnterHex`/`unitPassable` — те же проверки, что и
 * настоящее движение, значит путь туда гарантированно существует) очередного кольца выбирает тот, где
 * защита местности (`computeFreshHexTerrainDefense`) максимальна; при равенстве — первый найденный.
 * `null`, если в пределах MAX_EVICTION_RING колец вообще некуда деться. */
/** Зеркалит приватный `GameSession.territoryOwnerOf` (не экспортирован, тот же приём, что и everywhere
 * в этом файле — например `isCoastalSea` зеркалит `isCoastalSeaTile`) — чья территория лежит на этом
 * гексе (по региону — город владельца в том же регионе), `null` — ничья. */
function territoryOwnerOf(session: GameSession, col: number, row: number): number | null {
  const rc = Math.floor(col / REGION_SIZE_X);
  const rr = Math.floor(row / REGION_SIZE_Y);
  return session.cities.find((c) => c.regionCol === rc && c.regionRow === rr)?.playerId ?? null;
}

/** Та же проверка, что и в `GameSession.commandUnit` перед реальным перемещением (без неё
 * — «нейтральные воды» ООН — той нет смысла здесь: она только для морских клеток без города, не для
 * сухопутной эвакуации гарнизона) — гекс на чужой территории без «Открытых границ» И без войны с её
 * владельцем реально недостижим (сервер откажет `needsWarConfirm`), даже если физически проходим и
 * свободен. По прямому уточнению, живой баг-репорт — «зачем лучник, если остров»: изначальный `дальний`
 * ход построения приводил к тому, что `findEvictionHex` предлагал именно такой недостижимый гекс на
 * территории соседа, `evictOneGarrisonUnit` тихо проваливался (see её dispatch), гарнизон оставался
 * полон, и `tryBuildUnit` откатывался на другой, менее подходящий город (в этом случае — изолированный
 * остров) вместо столицы. */
function evictionHexReachable(session: GameSession, playerId: number, col: number, row: number): boolean {
  const owner = territoryOwnerOf(session, col, row);
  if (owner === null || owner === playerId) return true;
  const rel = session.relationOf(playerId, owner);
  return rel.war || rel.agreements.has("openBorders") || rel.agreements.has("vassalage");
}

const MAX_EVICTION_RING = 6;
function findEvictionHex(session: GameSession, unit: UnitInstance): { col: number; row: number } | null {
  const seen = new Set<string>([`${unit.col},${unit.row}`]);
  let frontier: [number, number][] = [[unit.col, unit.row]];
  for (let ring = 0; ring < MAX_EVICTION_RING && frontier.length; ring++) {
    const next: [number, number][] = [];
    const candidates: { col: number; row: number; defense: number }[] = [];
    for (const [c, r] of frontier) {
      for (const [nc, nr] of hexNeighborsWrapped(c, r, MAP_WIDTH, MAP_HEIGHT)) {
        const key = `${nc},${nr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Расширять фронт ДАЛЬШЕ можно только через реально проходимые (для этого юнита) клетки — по
        // прямому уточнению, живой баг-репорт «зачем лучник, если остров»: раньше фронт расширялся
        // геометрически через ЛЮБЫЕ клетки независимо от проходимости (проходимость проверялась
        // только у САМОГО кандидата, не у пути к нему) — кольцевой BFS «просвечивал» море/чужую
        // клетку насквозь и предлагал гекс, который выглядел близким по сетке колец, но реально не
        // связан сушей вовсе (см. `GameSession.computeUnitPath` — та же связность, что и здесь,
        // должна проверяться, иначе предложенный гекс окажется недостижим: `commandUnit` откажет
        // «Туда не дойти», эвакуация тихо провалится, и `tryBuildUnit` откатится на другой, менее
        // подходящий город). Теперь и расширение фронта требует прохода (`unitPassable`/`canEnterHex`
        // транзитом, isDestination=false) — то же самое, что реально проверяет путь `computeUnitPath`.
        if (!session.unitPassable(unit, nc, nr) || !session.canEnterHex(unit, nc, nr, false)) continue;
        next.push([nc, nr]);
        if (session.canEnterHex(unit, nc, nr, true) && evictionHexReachable(session, unit.playerId, nc, nr)) {
          candidates.push({ col: nc, row: nr, defense: session.computeFreshHexTerrainDefense(nc, nr, unit) });
        }
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.defense - a.defense);
      return { col: candidates[0].col, row: candidates[0].row };
    }
    frontier = next;
  }
  return null;
}

/** Эвакуирует ОДНОГО юнита из уже полного (`CITY_GARRISON_CAP`) гарнизона на самый защищённый
 * ближайший свободный гекс (см. findEvictionHex выше), чтобы освободить место под новую постройку —
 * по прямому запросу: «если AI хочет построить юнита в городе, а там уже два юнита — 1 выводить из
 * города на самый защищённый ближайший свободный гекс». Кого именно — самый СТАРЫЙ (наименьший id,
 * построен раньше остальных): оба юнита гарнизона в пределах лимита равноценны по возможностям
 * (полноценно ходят/атакуют/обороняются/поддерживают, см. doc CITY_GARRISON_CAP), так что порядок
 * эвакуации произвольный, лишь бы детерминированный. Свободного гекса рядом не нашлось — тихо ничего
 * не делает (последующий `buildUnitCard` всё равно откажет своим обычным «гарнизон полон», ничего не
 * ломается, просто застройка в этом городе в этот заход не получится). */
function evictOneGarrisonUnit(session: GameSession, playerId: number, city: City, reporter: Reporter): void {
  const garrison = session.unitsAt(city.col, city.row).sort((a, b) => a.id - b.id);
  const unit = garrison[0];
  if (!unit) return;
  const dest = findEvictionHex(session, unit);
  if (!dest) return;
  const payload = { unitId: unit.id, col: dest.col, row: dest.row };
  const result = session.dispatch("commandUnit", playerId, payload);
  if (result.ok) {
    reporter.step({
      action: "commandUnit",
      payload,
      sourceUnitId: unit.id,
      sourceCol: city.col,
      sourceRow: city.row,
      targetKind: "hex",
      targetCol: dest.col,
      targetRow: dest.row,
      label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) выведен из переполненного гарнизона города (${city.col},${city.row}) на защищённый гекс (${dest.col},${dest.row}), чтобы освободить место.`,
    });
  }
}

/** Зеркалит приватный GameSession.bestUnitEpochFor — старшая эпоха ИМЕННО ЭТОЙ категории, доступная
 * игроку прямо сейчас (среди юнитов категории, чья технология уже исследована). НЕ общая эпоха
 * игрока по всем веткам разом (playerEpoch) — по прямому запросу, живой баг-репорт: «ты не верно
 * понял правило, имеется в виду не эпоха по максимальной технологии, а максимальный юнит исходя из
 * изученных технологий, ты всё поломал» (см. doc в GameSession.bestUnitEpochFor — та же ошибка
 * ломала постройку ЛЮБОЙ категории, чья ветка ещё не догнала общую эпоху игрока). Единственная эпоха,
 * которую `GameSession.buildUnitCard`/`useKazarma` теперь принимают для этой категории. */
function bestUnitEpochFor(session: GameSession, playerId: number, category: UnitCategory): TechDef["epoch"] {
  let max: TechDef["epoch"] = 1;
  for (const u of UNITS) {
    if (u.category !== category) continue;
    if (u.tech !== null && !session.researchedTechs[playerId].has(u.tech)) continue;
    if (u.epoch > max) max = u.epoch;
  }
  return max;
}

/** Ближайший ориентир для сортировки городов-кандидатов под заявку армии (по прямому запросу §5 —
 * пополнение идёт К армии, а не в произвольный город): позиция первого члена уже существующей армии
 * (стягиваем новых членов туда, где армия сейчас), иначе — свой город обороны (Оборонительная), иначе
 * — город цели в её регионе (наступательная, армия ещё не начата). */
function armyOrderAnchorHex(session: GameSession, order: ArmyBuildOrder, army: Army | null): { col: number; row: number } | null {
  const firstMember = army ? armyMembersOf(session, army.id)[0] : undefined;
  if (firstMember) return { col: firstMember.col, row: firstMember.row };
  if (order.homeCityId !== null) {
    const c = session.cities.find((x) => x.id === order.homeCityId);
    if (c) return { col: c.col, row: c.row };
  }
  if (order.targetPlayerId !== null && order.targetRegionCol !== null && order.targetRegionRow !== null) {
    const city = session.cities.find((c) => c.playerId === order.targetPlayerId && c.regionCol === order.targetRegionCol && c.regionRow === order.targetRegionRow);
    if (city) return { col: city.col, row: city.row };
  }
  return null;
}

/** Постройка юнита ПОД ГОЛОВУ очереди армий (`session.armyBuildQueue`, §15.9а) — пробуется РАНЬШЕ
 * обычного `tryBuildUnit` (см. `tryPlayCardSlot`, кейс «warrior»): если заявка есть, приоритет карты
 * «Воин» отдаётся целиком её недостающей категории (§1 — «армия может быть неполной», строится по
 * одной категории за постройку, как и всё остальное), город — ближайший свой к `armyOrderAnchorHex`.
 * Нет активной заявки, состав уже полон, или подходящего города/эпохи нет — возвращает `false`,
 * вызывающий код падает на обычный `tryBuildUnit`. */
function tryBuildArmyUnit(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (!armyWithinTaxBudget(session, playerId)) return false;
  const queue = session.armyBuildQueue[playerId];
  if (!queue || !queue.length) return false;
  const order = queue[0];
  const army = session.armies.find((a) => a.id === order.armyId) ?? null;
  if (!army) return false; // армия/заявка расформированы позже своего создания в этом же ходу — не должно происходить, но не ломаемся
  if (armyMembersOf(session, army.id).length >= ARMY_MAX_MEMBERS) return false;
  const missing = armyMissingCategories(session, order.template, army.id);
  if (!missing.length) return false;
  const category = missing[0];

  const anchor = armyOrderAnchorHex(session, order, army);
  const cities = myCities(session, playerId).slice();
  if (anchor) cities.sort((a, b) => session.hexDistance(a.col, a.row, anchor.col, anchor.row) - session.hexDistance(b.col, b.row, anchor.col, anchor.row));
  if (!cities.length) return false;

  const currentEpoch = bestUnitEpochFor(session, playerId, category);
  const unitsOfCategory = UNITS.filter((u) => u.category === category && u.epoch === currentEpoch);
  if (!unitsOfCategory.length) return false;

  for (const city of cities) {
    if (session.unitsAt(city.col, city.row).length >= GameSession.CITY_GARRISON_CAP) {
      evictOneGarrisonUnit(session, playerId, city, reporter);
    }
    for (const unitDef of unitsOfCategory) {
      // `armyId` идёт В PAYLOAD (не отдельной мутацией после dispatch) — по прямому уточнению (живая
      // правка на этом же заходе): планирование хода бота выполняется на ОДНОРАЗОВОМ КЛОНЕ сессии
      // (см. computeAiTurnPlan), а payload этого шага честно РЕПЛЕИТСЯ на настоящей сессии при
      // подтверждении хода (executeAiPlan/playAiTurnPaced/weGoRound) — значит только то, что реально
      // ушло В САМ dispatch, персистентно доживает до настоящей партии; отдельная мутация массива
      // членства рядом с dispatch (как было раньше) жила бы только на клоне и терялась бы бесследно.
      const payload = { slotIndex, cityId: city.id, unitId: unitDef.id, armyId: army.id };
      const result = session.dispatch("buildUnitCard", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "buildUnitCard",
          payload,
          cardSlotIndex: slotIndex,
          cardId,
          targetKind: "city",
          targetCityId: city.id,
          label: `Построил юнита «${unitDef.id}» (${CATEGORY_META[category].label}) в городе (${city.col},${city.row}) — армия «${ARMY_TEMPLATE_LABEL[order.template]}».${marketSpendNote(result)}`,
        });
        return true;
      }
    }
  }
  return false;
}

const ZONE_TIER_LABEL: Record<1 | 2 | 3, string> = { 1: "Прифронтовая", 2: "Зона напряжения", 3: "Тыл" };

/** Постройка юнита с упором на регион (по прямому запросу заказчика — «сделаем акцент строительства
 * юнитов на конкретные регионы», боевая/движенческая логика юнитов НЕ меняется вовсе, только выбор
 * ЧТО и ГДЕ строить карте «Воин») — пробуется ПЕРЕД обычным приоритетом (см. её вызов ниже, до
 * `tryBuildUnit`); тот остаётся полноценным фолбэком, если строить по зоне нечего/не с чего.
 *
 * Тиры зон пробуются в порядке приоритета — Прифронтовая(1) → Зона напряжения(2) → Тыл(3); Осаждённый
 * (тир 0) своего шаблона не имеет, обслуживается обычным `tryBuildUnit` (тот и без того сортирует его
 * города первыми). Все свои города ОДНОГО тира делят ОДНУ круговую позицию в шаблоне зоны
 * (`GameSession.warZoneBuildIndex`, ключ "${playerId}:${buildKey}" — ПО ШАБЛОНУ, не по номеру тира,
 * см. её doc ниже — тиры 1 и 2 при сухопутном фронтире делят один и тот же шаблон `frontlineLand`),
 * а не считают её каждый по отдельности.
 *
 * «Чтоб алгоритм не вставал» (по прямому уточнению): не хватило ресурсов/денег на категорию текущей
 * позиции ни в одном городе тира (`buildUnitCard` вернул `ok:false` везде) — в ЭТОМ ЖЕ заходе
 * пробуется СЛЕДУЮЩАЯ позиция шаблона, и так по кругу максимум по разу на каждую (не бесконечный
 * цикл), прежде чем перейти к следующему тиру. Позиция сдвигается ПЕРСИСТЕНТНО (на следующий заход)
 * только при УСПЕШНОЙ постройке — на позицию СРАЗУ ПОСЛЕ успешной, не на ту, что была пропущена как
 * неудачная попытка в этом же заходе. */
function tryBuildUnitByZone(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (!armyWithinTaxBudget(session, playerId)) return false;
  const activePlan = session.warPlans[playerId];
  if (activePlan && countUnitsOf(session, playerId) >= countUnitsOf(session, activePlan.targetId) * WAR_PLAN_FORCE_RATIO) return false;

  const front = warFrontHex(session, playerId);
  const allCities = myCities(session, playerId);
  const isolatedUnit = session.researchedTechs[playerId].has("Мореплавание")
    ? (session.units.find((u) => u.playerId === playerId && isIsolatedFromOwnCities(session, playerId, u)) ?? null)
    : null;

  for (const tier of [1, 2, 3] as const) {
    const citiesInTier = allCities.filter((c) => warZoneTierOf(session, playerId, c) === tier);
    if (!citiesInTier.length) continue;
    // Шаблон берётся по ПЕРВОМУ городу тира как представительный — тем же приближением, что и общий
    // счётчик «на зону, не на город» выше (тир 2/3 у всех городов одного игрока и так одинаковы;
    // тир 1 в теории может различаться по конкретному Фронтиру разных городов, но это тот же уровень
    // приближения, что и общий круговой счётчик).
    const info = warZoneInfoFor(session, playerId, citiesInTier[0]);
    const buildKey = warZoneBuildKeyFor(session, citiesInTier[0], info);
    if (!buildKey) continue;
    const template = ZONE_BUILD_ORDER[buildKey];

    const orderedCities = citiesInTier
      .slice()
      .sort((a, b) => (front ? session.hexDistance(a.col, a.row, front.col, front.row) - session.hexDistance(b.col, b.row, front.col, front.row) : 0));
    const shipOrderedCities = isolatedUnit
      ? citiesInTier.slice().sort((a, b) => session.hexDistance(a.col, a.row, isolatedUnit.col, isolatedUnit.row) - session.hexDistance(b.col, b.row, isolatedUnit.col, isolatedUnit.row))
      : orderedCities;

    // Ключ круговой очереди — по САМОМУ ШАБЛОНУ (`buildKey`), не по номеру зоны (по прямому запросу,
    // живой баг-репорт — «вижу у фиолетового и синего множество юнитов, но все Штурмовые»): тиры 1
    // (Прифронтовая) и 2 (Зона напряжения) при сухопутном фронтире используют ОДИН И ТОТ ЖЕ шаблон
    // `frontlineLand`, но раньше вели по НЕЙ ДВЕ РАЗНЫЕ очереди — `"${playerId}:1"` и `"${playerId}:2"`
    // — а тир города (`warZoneTierOf`) пересчитывается заново каждый ход и колеблется между 1 и 2 при
    // любом сдвиге линии фронта (обычное дело в затяжной войне). Игрок, чей тир так колебался, гонял
    // обе очереди вперемешку, и каждая то и дело обрывалась и начиналась заново с позиции 0 — а на
    // позиции 0 в ОБОИХ боевых шаблонах (`frontlineLand`/`frontlineSea`) стоит именно «Штурмовой»,
    // отсюда перекос состава армии в одну эту категорию. Теперь тир 1 и тир 2 с одинаковым `buildKey`
    // делят ОДНУ и ту же очередь — переключение между ними больше не сбрасывает прогресс ротации.
    const key = `${playerId}:${buildKey}`;
    const startIdx = session.warZoneBuildIndex[key] ?? 0;
    for (let step = 0; step < template.length; step++) {
      const idx = (startIdx + step) % template.length;
      const category = template[idx];
      const currentEpoch = bestUnitEpochFor(session, playerId, category);
      const unitsOfCategory = UNITS.filter((u) => u.category === category && u.epoch === currentEpoch);
      if (!unitsOfCategory.length) continue; // категория ещё технологически недостижима — пропускаем позицию, не встаём
      const citiesForCategory = category === "ship" ? shipOrderedCities : orderedCities;
      for (const city of citiesForCategory) {
        if (category !== "ship" && session.unitsAt(city.col, city.row).length >= GameSession.CITY_GARRISON_CAP) {
          evictOneGarrisonUnit(session, playerId, city, reporter);
        }
        for (const unit of unitsOfCategory) {
          const payload = { slotIndex, cityId: city.id, unitId: unit.id };
          const result = session.dispatch("buildUnitCard", playerId, payload);
          if (result.ok) {
            session.warZoneBuildIndex[key] = (idx + 1) % template.length;
            reporter.step({
              action: "buildUnitCard",
              payload,
              cardSlotIndex: slotIndex,
              cardId,
              targetKind: "city",
              targetCityId: city.id,
              label: `Построил юнита «${unit.id}» (${CATEGORY_META[category].label}) в городе (${city.col},${city.row}) — очередь региона (${ZONE_TIER_LABEL[tier]}).${marketSpendNote(result)}`,
            });
            return true;
          }
          // «Всеобщая воинская повинность» — тот же денежный фолбэк, что и в tryBuildUnit ниже, той же
          // осторожной эвристикой (население города к концу хода > 3).
          if (category !== "ship" && session.researchedTechs[playerId].has("Всеобщая воинская повинность") && city.population - 1 > 3) {
            const moneyResult = session.dispatch("buyUnitWithMoney", playerId, payload);
            if (moneyResult.ok) {
              session.warZoneBuildIndex[key] = (idx + 1) % template.length;
              reporter.step({
                action: "buyUnitWithMoney",
                payload,
                cardSlotIndex: slotIndex,
                cardId,
                targetKind: "city",
                targetCityId: city.id,
                label: `Не хватило ресурсов — купил юнита «${unit.id}» (${CATEGORY_META[category].label}) в городе (${city.col},${city.row}) за деньги — очередь региона (${ZONE_TIER_LABEL[tier]}).`,
              });
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

function tryBuildUnit(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (!armyWithinTaxBudget(session, playerId)) return false;
  // «Рост войск не должен быть бесконечным: если касательно плана войны их достаточно, Воин играется
  // в последнюю очередь, чтоб не растить лишних расходов» (по прямому запросу). Это условие
  // ПРИМЕНИМОСТИ карты, а не приоритета — поэтому живёт здесь, рядом с бюджетным гейтом выше, а не
  // в списках §15.6: перевес по активному «Плану войны» уже набран (`WAR_PLAN_FORCE_RATIO`, та же
  // метрика, что и в considerWarPlan) — каждый следующий юнит только ест содержание (1💰/ход).
  const activePlan = session.warPlans[playerId];
  if (activePlan && countUnitsOf(session, playerId) >= countUnitsOf(session, activePlan.targetId) * WAR_PLAN_FORCE_RATIO) return false;
  const priority = decideUnitCategoryPriority(session, playerId);
  const front = warFrontHex(session, playerId);
  // Юнит, изолированный от всех своих городов (по прямому запросу) — при постройке КОРАБЛЯ по этой
  // причине города сортируются по близости именно к НЕМУ, а не к фронту/произвольно (раньше, как и у
  // strandedShipNeed, «какой именно город получит корабль» не уточнялось вовсе).
  const isolatedUnit = session.researchedTechs[playerId].has("Мореплавание")
    ? (session.units.find((u) => u.playerId === playerId && isIsolatedFromOwnCities(session, playerId, u)) ?? null)
    : null;
  // По прямому уточнению — живой баг-репорт: «зачем лучник, если остров — на острове он бесполезен».
  // Причина — сортировка по близости к изолированному юниту раньше применялась к ОБЩЕМУ списку
  // cities целиком, использованному ВСЕМИ категориями ниже, хотя по документированному замыслу
  // (см. коммент выше) она должна была влиять ТОЛЬКО на выбор города для Корабля-спасателя:
  // изолированный остров — ближайший город К САМОМУ СЕБЕ (дистанция 0), поэтому любая другая
  // категория (Поддержка и т.п.), для которой на острове нет ни фронта, ни союзников для баффа,
  // ошибочно оказывалась там же. Теперь сортировка по изолированному юниту — ОТДЕЛЬНЫЙ список
  // (`shipCities`), используемый НИЖЕ только для category==="ship"; все прочие категории видят
  // обычный список, отсортированный по фронту (или в исходном порядке, если фронта нет).
  const cities = myCities(session, playerId).slice();
  if (newWarAiEnabled(session)) {
    // ЭКСПЕРИМЕНТАЛЬНО (см. warZoneTierOf) — сперва по зоне (Осаждённый → Прифронтовая → Напряжение
    // → Тыл), внутри одной зоны — прежний тай-брейк по расстоянию до фронта.
    cities.sort((a, b) => {
      const tierDiff = warZoneTierOf(session, playerId, a) - warZoneTierOf(session, playerId, b);
      if (tierDiff !== 0) return tierDiff;
      if (!front) return 0;
      return session.hexDistance(a.col, a.row, front.col, front.row) - session.hexDistance(b.col, b.row, front.col, front.row);
    });
  } else if (front) {
    cities.sort((a, b) => session.hexDistance(a.col, a.row, front.col, front.row) - session.hexDistance(b.col, b.row, front.col, front.row));
  }
  const shipCities = isolatedUnit
    ? myCities(session, playerId)
        .slice()
        .sort((a, b) => session.hexDistance(a.col, a.row, isolatedUnit.col, isolatedUnit.row) - session.hexDistance(b.col, b.row, isolatedUnit.col, isolatedUnit.row))
    : cities;
  // Активный «План войны» (по прямому уточнению — «не должен строить юнита в городе не по плану,
  // это противоречит плану, распыляя силы») — для категорий, которые реально стягиваются к плану
  // (`tryStageForWarPlan`: Штурмовые/Мобильные/Дальняя атака/Поддержка), список городов ОГРАНИЧЕН
  // городами-плацдармами плана (`warPlanStagingCities`) целиком — прочие свои города (например,
  // изолированный остров вне плацдарма) не рассматриваются вовсе для ЭТИХ категорий, пока план
  // активен: накопление ударной силы не должно рассеиваться по городам, никак не относящимся к
  // конкретной кампании. Плацдармов нет вовсе (редкий случай) — ограничение снимается, лучше
  // построить где угодно, чем не строить. Оборонительные/Корабли не сюда — они не участвуют в
  // переброске к плану (Оборона держит паритет в СВОЁМ городе, Корабли адресуются отдельно, см.
  // isolatedUnit выше и tryStageForWarPlan).
  const plan = session.warPlans[playerId];
  const planStaging = plan ? new Set(warPlanStagingCities(session, playerId, plan)) : null;
  const stagingCities = planStaging && planStaging.size ? planStaging : null; // плацдармов нет вовсе (редкий случай) — ограничение снимается целиком, лучше построить где угодно, чем не строить вовсе
  for (const category of priority) {
    // Только СТАРШАЯ доступная эпоха ЭТОЙ категории — устаревшие (дешёвые) варианты больше не
    // пробуются вовсе, сервер их всё равно отклонит (см. GameSession.buildUnitCard), так что раньше
    // это были просто холостые dispatch-попытки; выше этой эпохи юнит категории и так недостижим
    // (тех.гейт).
    const currentEpoch = bestUnitEpochFor(session, playerId, category);
    const unitsOfCategory = UNITS.filter((u) => u.category === category && u.epoch === currentEpoch);
    const stagesForPlan = stagingCities && (category === "assault" || category === "mobile" || category === "ranged" || category === "support");
    const baseCities = category === "ship" ? shipCities : cities;
    const orderedCities = stagesForPlan ? baseCities.filter((c) => stagingCities!.has(c)) : baseCities;
    for (const city of orderedCities) {
      // Гарнизон полон — для некорабельных юнитов (корабли спавнятся рядом в море, см.
      // GameSession.shipSpawnHex, гарнизон города их не касается) сначала выводим одного уже
      // стоящего, иначе buildUnitCard откажет («Гарнизон города полон»).
      if (category !== "ship" && session.unitsAt(city.col, city.row).length >= GameSession.CITY_GARRISON_CAP) {
        evictOneGarrisonUnit(session, playerId, city, reporter);
      }
      for (const unit of unitsOfCategory) {
        const payload = { slotIndex, cityId: city.id, unitId: unit.id };
        const result = session.dispatch("buildUnitCard", playerId, payload);
        if (result.ok) {
          reporter.step({
            action: "buildUnitCard",
            payload,
            cardSlotIndex: slotIndex,
            cardId,
            targetKind: "city",
            targetCityId: city.id,
            label: `Построил юнита «${unit.id}» (${CATEGORY_META[category].label}) в городе (${city.col},${city.row}).${marketSpendNote(result)}`,
          });
          return true;
        }
        // «Всеобщая воинская повинность» — по прямому запросу, альтернатива обычной постройке, когда
        // ресурсов не хватило: купить юнита за деньги (эпоха × 2💰) + 1 население города. AI НЕ
        // использует это, если население города к концу этого хода окажется ≤3 (население города
        // сейчас, приближённо — без учёта прочих действий этого же хода) — «игрок если хочет пусть
        // использует», для бота это осторожная эвристика, не жёсткое правило движка (сервер сам
        // допускает вплоть до population > 1, см. GameSession.buyUnitWithMoney). Корабли этим путём
        // не покупаются (unitsOfCategory той же категории — "ship" сервер отклонит сам).
        if (category !== "ship" && session.researchedTechs[playerId].has("Всеобщая воинская повинность") && city.population - 1 > 3) {
          const moneyResult = session.dispatch("buyUnitWithMoney", playerId, payload);
          if (moneyResult.ok) {
            reporter.step({
              action: "buyUnitWithMoney",
              payload,
              cardSlotIndex: slotIndex,
              cardId,
              targetKind: "city",
              targetCityId: city.id,
              label: `Не хватило ресурсов — купил юнита «${unit.id}» (${CATEGORY_META[category].label}) в городе (${city.col},${city.row}) за деньги (население города −1).`,
            });
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** «Война против игрока с превосходящими силами» (по прямому запросу, условие приоритета
 * Фортификации ниже) — тот же `militaryPower`, что и everywhere else в оценке угроз (§8.1), а не
 * простое число юнитов: идёт война хотя бы с одним противником, чья военная мощь выше собственной. */
function facesWarWithSuperiorEnemy(session: GameSession, playerId: number): boolean {
  const myPower = militaryPower(session, playerId);
  return session.players.some((p) => p.id !== playerId && session.relationOf(playerId, p.id).war && militaryPower(session, p.id) > myPower);
}

/** По прямому запросу дословно — фиксированный порядок: ООН → Космодром → Храм (только если этот
 * игрок сам ОСНОВАТЕЛЬ какой-либо религии, не просто «есть религия», см. `religionFounder`/§7) →
 * Фортификация (только во время войны против игрока с превосходящими силами) → Казарма → Склад →
 * источник энергии (АЭС ИЛИ ГЭС — что угодно из двух; уже есть один, второй не нужен вовсе) →
 * Фабрика → Рынок (добавлен отдельным пунктом следом за Фабрикой по прямому уточнению — раньше
 * проваливался в общий хвост наравне со всем остальным) → остальные здания, начиная от САМЫХ
 * ПОЗДНИХ по эпохе (было — от самых ранних). Условные пункты (Храм/Фортификация/энергия) просто
 * пропускаются, если условие не выполнено — не «откладываются в конец», а не участвуют в приоритете
 * вовсе в этот заход.
 *
 * [ИСПРАВЛЕНО, живой баг-репорт §118 продолжение — «оранжевый всё ещё пытается построить
 * университет, хотя у него уже есть потребитель энергии без источника, по идее ресурсов ему хватит
 * при грамотном менеджменте»] — раньше АЭС/ГЭС были просто ВЫШЕ по списку, но список не
 * ОБРЫВАЛСЯ: если оба варианта источника оказывались недоступны ПРЯМО СЕЙЧАС (не хватило, например,
 * металла в этом ходу), `tryBuilder` просто проваливался дальше по списку и строил что угодно ещё
 * подешевле (Университет и т.п.) — «соглашался» на замену вместо того, чтобы КОПИТЬ на источник.
 * Теперь, пока есть потребитель БЕЗ источника, список ОБРЫВАЕТСЯ на АЭС/ГЭС — Казарма/Склад ещё
 * пробуются (дёшевы, обычно уже есть или не мешают), но дальше (Фабрика/Рынок/остальное, включая
 * Университет) не предлагается вовсе: если источник энергии в этот ход не по карману, `tryBuilder`
 * падает на рубку леса/ничего не делает, а не хватает что подешевле — ресурсы копятся на источник
 * (и Рабочий уже целится именно в него, см. builderMissingResourceIds/§118) вместо того, чтобы уйти
 * на случайную замену.
 *
 * [ИСПРАВЛЕНО, живой баг-репорт — «зелёный собрался строить казарму, но у него уже есть Фашизм — с
 * открытием Фашизма Казарма должна падать в приоритет в самый низ»] — под Фашизмом играть «Воина»
 * почти никогда не приходится: каждый цикл и так даётся бесплатная карта «Воин» (см. §6 «Фашизм»,
 * `grantFascismWarriorCards`), а Казарма — это именно замена карте «Воин» (строит юнита БЕЗ карты за
 * ту же цену), то есть под активным Фашизмом её функция почти целиком дублируется бесплатной картой
 * — не бесполезна совсем (свободна от лимита руки/цикла бесплатной карты), но приоритет резко падает.
 * Казарма при Фашизме убрана из «топа» и добавлена В САМЫЙ КОНЕЦ списка (после «остальных» по
 * эпохе) — пробуется, только если вообще ничего другое в очереди не подошло. */
function buildingPriorityOrder(session: GameSession, playerId: number): BuildingDef[] {
  const isFascist = session.playerParadigm[playerId] === "fascism";
  const kazarma = BUILDINGS.find((b) => b.id === "kazarma")!;
  const topIds: string[] = ["oon", "kosmodrom"];
  if (Object.values(session.religionFounder).includes(playerId)) topIds.push("hram");
  if (facesWarWithSuperiorEnemy(session, playerId)) topIds.push("fort");
  if (!isFascist) topIds.push("kazarma");
  topIds.push("sklad");
  const hasEnergy = hasEnergyAccess(session, playerId);
  if (!hasEnergy) topIds.push("aes", "ges");
  const top = topIds.map((id) => BUILDINGS.find((b) => b.id === id)).filter((b): b is BuildingDef => !!b);
  if (builderHasEnergyConsumerWithoutSource(session, playerId)) return isFascist ? [...top, kazarma] : top;
  topIds.push("rynok");
  // Фабрика/Радиовышка бесполезны без источника энергии (Электричество/Углеводороды
  // взаимозаменяемы) — по прямому уточнению «нет смысла строить», не предлагаются вовсе, пока
  // источника нет ни в каком виде.
  if (hasEnergy) topIds.push("fabrika");
  const excludeIds = new Set(topIds);
  excludeIds.add("kazarma");
  if (hasEnergy) {
    excludeIds.add("aes");
    excludeIds.add("ges");
  } else {
    excludeIds.add("fabrika");
    excludeIds.add("radiovyshka");
  }
  const fullTop = topIds.map((id) => BUILDINGS.find((b) => b.id === id)).filter((b): b is BuildingDef => !!b);
  const rest = BUILDINGS.filter((b) => !excludeIds.has(b.id)).sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0));
  return isFascist ? [...fullTop, ...rest, kazarma] : [...fullTop, ...rest];
}

function tryBuilder(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const b of buildingPriorityOrder(session, playerId)) {
    const payload = { slotIndex, buildingId: b.id };
    const result = session.dispatch("buildBuilding", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "buildBuilding", payload, cardSlotIndex: slotIndex, cardId, targetKind: "building", targetBuildingId: b.id, label: `Построил здание «${b.id}».${marketSpendNote(result)}` });
      return true;
    }
  }
  // Вырубка леса — ЕДИНСТВЕННЫЙ источник дерева у Строителя (не добывается через «Рабочего» —
  // targetCount:0, дерево на карте не сеется вовсе, только рубкой). [ИСПРАВЛЕНО, по прямому запросу
  // — живой баг-репорт: «во-первых про запас нужно рубить и набирать силикаты, иначе AI так не
  // накопит. У фиолетового есть горы, и он может копить силикаты. Запрещено рубить последний лес в
  // регионе, в остальном на вырубку не должно быть ограничений»] — раньше рубка срабатывала ТОЛЬКО
  // когда дерево реально числилось недостающим для текущей приоритетной цели постройки
  // (`builderMissingResourceIds`) — если этой целью оказывалось здание, которому дерево вообще не
  // нужно (например «Фортификация» — только Силикаты+Металл), рубка не пробовалась вовсе, хотя дерево
  // пригодилось бы ДРУГИМ зданиям в очереди позже. Теперь рубка — проактивный запас, без привязки к
  // конкретной цели, единственное ограничение — не рубить последний лес региона (см. ниже).
  const citiesByForest = myCities(session, playerId)
    .map((city) => ({ city, forestCount: forestTileCountInRegion(session, city.regionCol, city.regionRow) }))
    .filter((c) => c.forestCount >= 2)
    .sort((a, b) => b.forestCount - a.forestCount);
  for (const { city } of citiesByForest) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = city.regionCol * REGION_SIZE_X + dx;
        const row = city.regionRow * REGION_SIZE_Y + dy;
        const payload = { slotIndex, col, row };
        const result = session.dispatch("chopForest", playerId, payload);
        if (result.ok) {
          reporter.step({ action: "chopForest", payload, cardSlotIndex: slotIndex, cardId, targetKind: "hex", targetCol: col, targetRow: row, label: `Вырубил лес на (${col},${row}) — запас на будущие постройки.${marketSpendNote(result)}` });
          return true;
        }
      }
    }
  }
  // Добыча силикатов в горах (`GameSession.mineMountainsForSilicates`) — та же проактивная логика,
  // что и рубка леса выше (по тому же прямому запросу): раньше эта серверная возможность вообще не
  // была подключена к AI (только человек мог её выбрать в интерфейсе) — Строитель с горами в регионе,
  // но без цели, которой СЕЙЧАС не хватает именно силикатов, никогда не пробовал добыть их про запас,
  // хотя силикаты — самый частый ингредиент построек (почти в каждом здании) и типичное узкое место.
  // Требует «Горное дело» и 2 пищевых ресурса — тот же гейт, что сервер и так проверяет сам.
  if (session.researchedTechs[playerId].has("Горное дело")) {
    for (const city of myCities(session, playerId)) {
      const payload = { slotIndex, cityId: city.id };
      const result = session.dispatch("mineMountainsForSilicates", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "mineMountainsForSilicates",
          payload,
          cardSlotIndex: slotIndex,
          cardId,
          targetKind: "city",
          targetCityId: city.id,
          label: `Добыл 1 Силикат в горах региона города (${city.col},${city.row}) — запас на будущие постройки.`,
        });
        return true;
      }
    }
  }
  return false;
}

/** «Уже достаточно» на складе (по прямому запросу — живой баг-репорт: «у жёлтого уже много дерева, а
 * он рабочим ещё добывает — нужно стремиться к разнообразию ресурсов на складе») — не жёсткий лимит,
 * просто порог, ниже которого тип всё ещё считается «нужным». Еда — всегда нужна (растит города,
 * освобождает Поселенца/Население, см. §15.4), остальное — только пока на складе меньше порога. */
const WAREHOUSE_ABUNDANT_THRESHOLD = 3;
function isWorthCollecting(session: GameSession, playerId: number, resource: ResourceId): boolean {
  if (RESOURCE_CATEGORY.get(resource) === "food") return true;
  return (session.warehouse[playerId]?.[resource] ?? 0) < WAREHOUSE_ABUNDANT_THRESHOLD;
}

/** Человекочитаемое название цели, ради которой «Рабочий» сыграл как СРЕДСТВО (см. RESOURCE_HUNGRY_CARDS
 * в pickAndPlayNextCard) — по прямому запросу («уточни в плане хода, какой именно ресурс собирается
 * рабочим и для какого целевого действия»), используется только в подписи шага плана. */
const CARD_GOAL_LABEL: Record<string, string> = {
  settler: "«Поселенец»",
  scientist: "«Учёный»",
  builder: "«Строитель»",
  warrior: "«Воин»",
  tradeRoute: "«Торговый путь»",
  trader: "«Торговец»",
};

/** Подпись «зачем» к шагу «Рабочий собрал...» — по прямому запросу («уточни в плане хода, какой
 * именно ресурс собирается рабочим и для какого целевого действия») — играет ли «Рабочий» как
 * СРЕДСТВО для другой карты (см. `forCardId`/CARD_GOAL_LABEL) или как самостоятельная цель 10
 * (разнообразие склада, см. §15.4) — оба случая теперь явно подписываются, а не просто «собрал
 * ресурсы». */
/** Какого именно ресурса не хватает КОНКРЕТНОЙ карте (`forCardId`) — по прямому запросу («когда
 * пишешь „не хватило ресурса“, пиши каких именно») вместо безликого «ресурса». Best-effort: для карт
 * с выбором ВНУТРИ карты (какого юнита строить — «Воин», какое здание — «Строитель», какую
 * технологию — «Учёный») берётся тот же кандидат по приоритету, что попробовал бы сам розыгрыш (см.
 * decideUnitCategoryPriority/buildingPriorityOrder/порядок tryResearch выше) — подпись может разойтись
 * с настоящим dispatch, только если внутри карты реально выбирается ДРУГОЙ кандидат (несколько
 * городов/юнитов разной цены) — не критично, это подсказка в плане хода, не гарантия точности. */
function cardMissingResourceLabels(session: GameSession, playerId: number, forCardId: string | undefined): string[] {
  if (!forCardId) return [];
  switch (forCardId) {
    case "settler":
      return ["Еда"];
    case "tradeRoute":
      return ["Торговый (второй отличный вид)"];
    case "trader":
      return ["Торговый (любой вид)"];
    case "warrior": {
      const category = decideUnitCategoryPriority(session, playerId)[0];
      const city = myCities(session, playerId)[0];
      if (!category || !city) return [];
      return session.missingUnitCostLabels(playerId, city.id, category, bestUnitEpochFor(session, playerId, category));
    }
    case "builder": {
      const building = buildingPriorityOrder(session, playerId).find(
        (b) => !isOwnedBy(session.buildingOwners, b.id, playerId) && (b.tech === null || session.researchedTechs[playerId].has(b.tech))
      );
      return building ? session.missingBuildingCostLabels(playerId, building.id) : [];
    }
    case "scientist": {
      const researched = session.researchedTechs[playerId];
      const remaining = TECH_TREE.filter((t) => !researched.has(t.id));
      const frontier = remaining.filter((t) => session.techDiscoverer[t.id] === undefined).sort((a, b) => a.epoch - b.epoch);
      const rest = remaining.filter((t) => session.techDiscoverer[t.id] !== undefined).sort((a, b) => a.epoch - b.epoch);
      const tech = [...frontier, ...rest][0];
      return tech ? session.missingResearchCostLabels(playerId, tech.epoch) : [];
    }
    default:
      return [];
  }
}

function workerPurposeLabel(session: GameSession, playerId: number, forCardId: string | undefined): string {
  if (forCardId) {
    const missing = cardMissingResourceLabels(session, playerId, forCardId);
    const what = missing.length ? missing.join(", ") : "ресурса";
    return ` — не хватило ${what} для карты ${CARD_GOAL_LABEL[forCardId] ?? `«${forCardId}»`}`;
  }
  return " — про запас (разнообразие склада)";
}

function resourceListLabel(resources: ResourceId[]): string {
  return resources.map((r) => `1×${RESOURCE_LABEL.get(r) ?? r}`).join(", ");
}

/** Порядок городов для «Рабочего» — по прямому запросу, живой баг-репорт: «зелёный собирает кучу
 * ресурсов, но не те, что нужны для «Учёного», хотя технически возможно» — раньше города перебирались
 * в произвольном (порядке создания) фиксированном порядке, и «Рабочий» останавливался на ПЕРВОМ же
 * городе, где было хоть что-то «стоящее сбора» (еда стоит ВСЕГДА, см. isWorthCollecting) — даже если
 * в регионе этого города физически НЕТ ресурса категории, которой на складе не хватает совсем (0
 * единиц), а ресурс этой категории есть в регионе СОВСЕМ ДРУГОГО города, до которого очередь так и не
 * доходила (не хватало «Рабочих» карт в руке на все города разом). Три «Рабочих» подряд собирали еду
 * и стратегические ресурсы в трёх городах без единого торгового вида, хотя четвёртый город region-ом
 * как раз давал хлопок/специи — просто не успевали до него дойти. Для forCardId, которому реально
 * нужна не еда (см. FOOD_TARGET_CARDS) — города, чей регион способен дать хоть один вид ещё НЕ
 * НАБРАННОЙ до порога (`< WAREHOUSE_ABUNDANT_THRESHOLD=3` суммарно по категории, а не строго «0» —
 * см. живой баг-репорт ниже, почему именно порог, а не факт присутствия хоть одной единицы), идут
 * ПЕРВЫМИ; для FOOD_TARGET_CARDS порядок городов не трогается (там и так всё решает еда, см. ниже).
 * [ИСПРАВЛЕНО, по прямому запросу — живые баг-репорты: «зелёный собирает ресурсы, но одну еду — надо
 * стремиться сначала к разнообразию типов (стратегические/торговые), потом уже еды», «зелёный весь
 * ход тратит на сбор, а мог бы сделать научное открытие»] — старая проверка «категория отсутствует
 * СОВСЕМ» (0 суммарно) считала категорию «уже не нуждающейся» после ПЕРВОЙ ЖЕ добытой единицы, хотя
 * многим целям (эпоха 4+ исследования — 2 стратегических сразу, см. RESEARCH_COST_LINES) нужно БОЛЬШЕ
 * одной: 1-й «Рабочий» брал 1 стратегический (правильно), но 2-й и 3-й уже не считали категорию
 * дефицитной (1 не равно 0) и уходили собирать первую попавшуюся еду — «Учёный» так и не наигрывался
 * весь ход, несмотря на несколько «Рабочих» подряд.
 * **«Торговый путь» — особый случай**, тоже по прямому запросу («жёлтый играет Торговца, хотя
 * разумнее сначала проложить Торговый путь, если это возможно») — карте не хватает не «хоть сколько-то
 * торгового», а именно ВТОРОГО РАЗНОГО вида (см. `GameSession.layNewTradeRoute`/`distinctTradeResourceCount`);
 * общая проверка «категория отсутствует совсем» здесь бесполезна, если на складе уже есть 1 торговый
 * вид (категория НЕ «отсутствует», но нужного РАЗНООБРАЗИЯ всё ещё нет) — вместо неё города, чей
 * регион даёт торговый вид, КОТОРОГО ЕЩЁ НЕТ на складе (по id, не по категории), идут первыми.
 * **«Учёный» с эпохи 5 — тоже особый случай**, по прямому запросу («жёлтому не хватает на карту
 * «Учёный», хотя та же куча разных ресурсов») — см. `needsHydrocarbonsForResearch`: цена исследования
 * с этой эпохи требует СПЕЦИФИЧНО Углеводороды/Электричество, а не любой стратегический вид — «куча»
 * могла быть сплошь из Редкоземельных (тоже "strategic"), не покрывая именно эту строку цены. */
/** Какие ИМЕННО виды ресурсов ещё не хватает для СЛЕДУЮЩЕЙ попытки построить «Воина» — по прямому
 * запросу («если для воина не хватает металла и углеводородов, зачем рабочий добывает торговые и
 * пищевые ресурсы») — та же категория/эпоха, что реально попробует `tryBuildUnit`
 * (`decideUnitCategoryPriority`/`bestUnitEpochFor`), любой свой город как ориентир (нужен только
 * список ВИДОВ ресурса, не точный расчёт по конкретному городу — см. doc `GameSession.
 * missingUnitCostResourceIds`/`cardMissingResourceLabels`, тот же best-effort). */
function warriorMissingResourceIds(session: GameSession, playerId: number): Set<ResourceId> {
  const category = decideUnitCategoryPriority(session, playerId)[0];
  const city = myCities(session, playerId)[0];
  if (!category || !city) return new Set();
  return new Set(session.missingUnitCostResourceIds(playerId, city.id, category, bestUnitEpochFor(session, playerId, category)));
}

/** Здание, которое реально попробует СЛЕДУЮЩИМ `tryBuilder` — первое в `buildingPriorityOrder`, ещё
 * не построенное и уже открытое по технологии (тот же признак, что `builderCouldUseWorker` уже
 * использует для решения «стоит ли вообще пробовать Рабочего»). */
function builderNextBuildingId(session: GameSession, playerId: number): string | undefined {
  return buildingPriorityOrder(session, playerId).find((b) => !isOwnedBy(session.buildingOwners, b.id, playerId) && (b.tech === null || session.researchedTechs[playerId].has(b.tech)))?.id;
}

/** Здания, чья функция требует Электричество или Углеводороды для активации (§5, взаимозаменяемы по
 * прямому уточнению) — «потребители энергии» в терминах живого баг-репорта ниже. */
const ENERGY_CONSUMER_BUILDING_IDS = ["radiovyshka", "fabrika", "rynok"];
/** Есть ли у игрока ЛЮБОЙ источник энергии — построенные АЭС/ГЭС (производят Электричество) ИЛИ
 * territory-доступ к Углеводородам (полностью взаимозаменяемы с Электричеством везде в игре — по
 * прямому уточнению, «одно полностью может заменить другое»). Гейтится «Горным делом», как и любая
 * добыча стратегических ресурсов (resourceIsExtractable). */
function hasEnergyAccess(session: GameSession, playerId: number): boolean {
  if (isOwnedBy(session.buildingOwners, "aes", playerId) || isOwnedBy(session.buildingOwners, "ges", playerId)) return true;
  return session.resourceIsExtractable(playerId, "hydrocarbons") && hasResourceInOwnTerritory(session, playerId, "hydrocarbons");
}
/** У игрока уже есть построенное здание, которому для работы нужна энергия, а самого источника (АЭС/
 * ГЭС ИЛИ доступных Углеводородов) ещё нет — «есть потребитель, нет источника», ровно формулировка
 * запроса. */
function builderHasEnergyConsumerWithoutSource(session: GameSession, playerId: number): boolean {
  if (hasEnergyAccess(session, playerId)) return false;
  return ENERGY_CONSUMER_BUILDING_IDS.some((id) => isOwnedBy(session.buildingOwners, id, playerId));
}

/** Какие ИМЕННО виды ресурсов ещё не хватает для СЛЕДУЮЩЕЙ попытки построить здание — по прямому
 * запросу (живой баг-репорт: «зелёный хочет построить университет, но в приоритетах — раз уже есть
 * здание-потребитель энергии, нужен её источник; он вполне может построить ГЭС [а ещё лучше АЭС],
 * для этого достаточно возможностей — учти это в алгоритме»). Two слоя:
 * 1. Если уже есть здание-потребитель энергии, а источника нет — цель ВСЕГДА источник (АЭС
 *    предпочтительнее ГЭС, по прямому уточнению «а ещё лучше АЭС»), НЕЗАВИСИМО от общего
 *    `buildingPriorityOrder` — тот СТАВИТ АЭС/ГЭС раньше «остальных» и без потребителя (§106), но
 *    первым в очереди у него может стоять что-то куда более дорогое/далёкое (например ООН — тоже
 *    безусловный топ-приоритет §106), и Рабочий добывал бы под НЕГО, а не под дешёвый и реально
 *    достижимый источник энергии рядом. Эта проверка сознательно ИГНОРИРУЕТ общий приоритет ради
 *    конкретного случая из запроса, а не переставляет buildingPriorityOrder целиком.
 * 2. Иначе — здание, которое реально попробует СЛЕДУЮЩИМ `tryBuilder` (`builderNextBuildingId`), тот
 *    же класс диагностики, что уже решался для «Воина» (`warriorMissingResourceIds` выше) — общее
 *    правило «любая недобранная категория» (ниже) не отличало нужный конкретный вид от чего угодно
 *    ещё дефицитного.
 *
 * [ИСПРАВЛЕНО, тот же живой баг-репорт про ГЭС] — п.1 раньше ВСЕГДА возвращал недостачу АЭС первой,
 * если она вообще не пустая (`if (ids.length) return`) — а она НЕ пустая почти всегда, раз мы вообще
 * дошли до этой функции (сама постройка АЭС/ГЭС уже провалилась в `tryBuilder`, значит недостача
 * гарантированно есть у ХОТЯ БЫ ОДНОГО). На практике это значило «Рабочий/рубка леса всегда гонятся
 * за АЭС», даже если АЭС упирается в дефицитный Уран (не продаётся на Мировом рынке — только если
 * повезёт с чужим лотом), а ГЭС тем временем реально ближе к постройке (не хватает только Силикатов/
 * Металла/Леса — все покупаемые/рубимые). Теперь считается недостача ОБЕИХ и выбирается та, где
 * РЕАЛЬНО МЕНЬШЕ разных видов не хватает («ещё лучше АЭС» по прямому уточнению — при равенстве или
 * если у ГЭС недостачи нет вовсе, побеждает АЭС) — цель Рабочего/рубки леса всегда та, что ближе к
 * завершению, а не жёстко зафиксированная АЭС. */
function builderMissingResourceIds(session: GameSession, playerId: number): Set<ResourceId> {
  if (builderHasEnergyConsumerWithoutSource(session, playerId)) {
    const aesMissing = session.missingBuildingCostResourceIds(playerId, "aes");
    const gesMissing = session.missingBuildingCostResourceIds(playerId, "ges");
    if (aesMissing.length || gesMissing.length) {
      // ГЭС побеждает, только если у неё СТРОГО меньше недостающих видов (реально ближе к постройке,
      // 0 < N включительно — ГЭС уже ничего не недостаёт); при равенстве — побеждает АЭС («ещё лучше
      // АЭС», по прямому уточнению).
      return new Set(gesMissing.length < aesMissing.length ? gesMissing : aesMissing);
    }
  }
  const buildingId = builderNextBuildingId(session, playerId);
  if (!buildingId) return new Set();
  return new Set(session.missingBuildingCostResourceIds(playerId, buildingId));
}

function prioritizeCitiesForWorker(session: GameSession, playerId: number, cities: City[], forCardId: string | undefined): City[] {
  if (forCardId && FOOD_TARGET_CARDS.has(forCardId)) return cities;
  const needsHydrocarbons = forCardId === "scientist" && needsHydrocarbonsForResearch(session, playerId);
  const needsUranium = forCardId === "scientist" && needsUraniumForResearch(session, playerId);
  if (needsHydrocarbons || needsUranium) {
    const canSupplySpecific = (city: City) =>
      session.harvestableResourcesFor(playerId, city.id).some((r) => (needsHydrocarbons && (r === "hydrocarbons" || r === "electricity")) || (needsUranium && r === "uranium"));
    return cities.slice().sort((a, b) => Number(canSupplySpecific(b)) - Number(canSupplySpecific(a)));
  }
  if (forCardId === "warrior") {
    const needed = warriorMissingResourceIds(session, playerId);
    if (needed.size) {
      const canSupplyNeeded = (city: City) => session.harvestableResourcesFor(playerId, city.id).some((r) => needed.has(r));
      return cities.slice().sort((a, b) => Number(canSupplyNeeded(b)) - Number(canSupplyNeeded(a)));
    }
  }
  if (forCardId === "builder") {
    const needed = builderMissingResourceIds(session, playerId);
    if (needed.size) {
      const canSupplyNeeded = (city: City) => session.harvestableResourcesFor(playerId, city.id).some((r) => needed.has(r));
      return cities.slice().sort((a, b) => Number(canSupplyNeeded(b)) - Number(canSupplyNeeded(a)));
    }
  }
  if (forCardId === "tradeRoute" || forCardId === "trader") {
    // «Торговец» (по прямому запросу — тот же приоритет диверсификации, что и у «Торгового пути»
    // выше): ему тоже выгоднее НОВЫЙ, ещё не имеющийся вид — доход считается по уникальным типам, не
    // по количеству одного и того же — но, в отличие от «Торгового пути» (которому НУЖНЫ именно 2
    // РАЗНЫХ вида, иначе карта не разыгрывается вовсе), «Торговцу» хватит и любого ОДНОГО торгового
    // вида, лишь бы было чем торговать (см. GameSession.traderTrade — отказывает только при полном
    // отсутствии торгового ресурса и в сети, и на складе).
    const ownedTradeIds = new Set(
      (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(([id, qty]) => qty > 0 && RESOURCE_CATEGORY.get(id) === "trade").map(([id]) => id)
    );
    const canSupplyNewTradeType = (city: City) =>
      session.harvestableResourcesFor(playerId, city.id).some((r) => RESOURCE_CATEGORY.get(r) === "trade" && !ownedTradeIds.has(r));
    return cities.slice().sort((a, b) => Number(canSupplyNewTradeType(b)) - Number(canSupplyNewTradeType(a)));
  }
  const canSupplyUnderstockedCategory = (city: City) =>
    session.harvestableResourcesFor(playerId, city.id).some((r) => warehouseCategoryTotal(session, playerId, RESOURCE_CATEGORY.get(r)) < WAREHOUSE_ABUNDANT_THRESHOLD);
  return cities.slice().sort((a, b) => Number(canSupplyUnderstockedCategory(b)) - Number(canSupplyUnderstockedCategory(a)));
}

/** Рабочий, альтернативное применение — «добыть Редкоземельные из Равнины» (GameSession.mineStrategicResource,
 * требует «Геологоразведка») — по прямому запросу: «AI использует только тогда, когда есть равнина
 * без ресурсов и нужны редкоземельные для открытия технологии». Тот же принцип, что и
 * needsHydrocarbonsForResearch выше: ближайшая реально доступная технология уже эпохи 6 (единственная,
 * чья цена требует Редкоземельные СПЕЦИФИЧНО — см. RESEARCH_COST_LINES[6]), а на складе их нет вовсе. */
function needsRareEarthForResearch(session: GameSession, playerId: number): boolean {
  const researched = session.researchedTechs[playerId];
  if (TECH_TREE.some((t) => t.epoch < 6 && !researched.has(t.id))) return false;
  const warehouse = session.warehouse[playerId] ?? {};
  return (warehouse.rareEarth ?? 0) === 0;
}
/** Равнина без ресурса и без леса в регионе города — единственный тип гекса, годный для
 * GameSession.mineStrategicResource (см. её проверки). Первая подходящая, порядок сканирования тайлов
 * региона — не важно какая именно, здесь нет конкурирующего приоритета между клетками. */
function findBarePlainsForMining(session: GameSession, city: City): { col: number; row: number } | null {
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      const col = city.regionCol * REGION_SIZE_X + dx;
      const row = city.regionRow * REGION_SIZE_Y + dy;
      const tile = session.doc.get(col, row);
      if (tile.terrain === "plains" && !tile.resource && !tile.forest) return { col, row };
    }
  }
  return null;
}

function tryWorkerCollect(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter, forCardId?: string): boolean {
  // Добыча редкоземельных (опустынивание равнины) — только когда это реально помогает ЦЕЛИ
  // текущего «Рабочего»: сам по себе (forCardId не задан, играет ради разнообразия склада, см. §15.4)
  // или явно ради «Учёного» (единственная карта, которой редкоземельные нужны напрямую). Живой
  // баг-репорт: «Рабочий» played specifically to unblock «Воин» во время войны вместо этого добывал
  // редкоземельные (не хватало для «Воин» они и не могли — ветка срабатывала БЕЗУСЛОВНО по общему
  // нед остатку редкоземельных для будущего исследования), тратя единственное действие впустую и
  // роняя приоритет «Воина» ниже более слабых карт в очереди — если forCardId указывает на другую
  // карту (не «Учёный»), эта ветка должна уступить обычному сбору ниже, который реально ищет ресурс,
  // нужный ИМЕННО forCardId.
  // «Воин» эпохи 6 — та же зависимость от Редкоземельных, что и у «Учёного» (EPOCH_UNIT_COST[6]
  // требует их наравне с Металлом/Углеводородами, см. GameSession) — по прямому запросу («разреши
  // копать редкоземельные для юнитов, если ИИ в состоянии войны, если ещё нельзя — иначе на поздних
  // стадиях войска перестанут расти»): без этого исключения условие ниже (только «Учёный»/без цели)
  // навсегда блокировало ЕДИНСТВЕННЫЙ надёжный источник Редкоземельных для «Воина» этой эпохи —
  // они не продаются на постоянных лотах биржи (§10), и без прицельной добычи армия физически не
  // может расти дальше эпохи 6.
  const rareEarthForWarrior = forCardId === "warrior" && warriorMissingResourceIds(session, playerId).has("rareEarth");
  const rareEarthForScientist = (!forCardId || forCardId === "scientist") && needsRareEarthForResearch(session, playerId);
  if (session.researchedTechs[playerId].has("Геологоразведка") && (rareEarthForScientist || rareEarthForWarrior)) {
    for (const city of myCities(session, playerId)) {
      const spot = findBarePlainsForMining(session, city);
      if (!spot) continue;
      const payload = { slotIndex, col: spot.col, row: spot.row, resource: "rareEarth" as ResourceId };
      const result = session.dispatch("mineStrategicResource", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "mineStrategicResource",
          payload,
          cardSlotIndex: slotIndex,
          cardId,
          targetKind: "hex",
          targetCol: spot.col,
          targetRow: spot.row,
          label: `Рабочий добыл 1 Редкоземельные на (${spot.col},${spot.row}) — равнина опустынена${workerPurposeLabel(session, playerId, forCardId)}.`,
        });
        return true;
      }
    }
  }
  for (const city of prioritizeCitiesForWorker(session, playerId, myCities(session, playerId), forCardId)) {
    // Превью (см. GameSession.harvestableResourcesFor, УЖЕ учитывает лимит населения города — не
    // только «что технически можно добыть», но и «остался ли вообще бюджет в этом цикле») ДО
    // настоящего dispatch — по прямому запросу: и если в городе прямо сейчас нечего добыть НОВОГО
    // (бюджет уже занят — например, вторым «Рабочим» подряд на город с населением 1, живой
    // баг-репорт), и если единственное доступное — то, чего на складе и так уже достаточно (и это не
    // еда), играть «Рабочего» здесь смысла нет — карта и действие лучше достанутся чему-то более
    // полезному (см. pickAndPlayNextCard).
    const preview = session.harvestableResourcesFor(playerId, city.id);
    if (!preview.some((r) => isWorthCollecting(session, playerId, r))) continue;

    const payload: Record<string, unknown> = { slotIndex, cityId: city.id };
    let result = session.dispatch("workerCollect", playerId, payload);
    if (result.ok) {
      // Без выбора — сервер сам собрал ВСЁ, что показало превью (см. GameSession.workerCollect:
      // fresh.length<=budget), так что превью и есть точный список того, что реально добыто.
      reporter.step({
        action: "workerCollect",
        payload,
        cardSlotIndex: slotIndex,
        cardId,
        targetKind: "city",
        targetCityId: city.id,
        label: `Рабочий собрал ${resourceListLabel(preview)} в городе (${city.col},${city.row})${workerPurposeLabel(session, playerId, forCardId)}.`,
      });
      return true;
    }
    if (result.needsResourceChoice) {
      const { budget, options } = result.needsResourceChoice;
      // forCardId — «Поселенец»/«Население» — им ДЕЙСТВИТЕЛЬНО (см. GameSession: основание/рост
      // города прямо требуют категорию "food" среди своей стоимости) не хватает именно еды, поэтому
      // здесь по прямому запросу приоритетно добывается еда, а среди остального — то, чего на складе
      // МЕНЬШЕ («разнообразие»): без этого выбор шёл просто по порядку выдачи options, из-за чего
      // сыгранный Рабочий мог не принести ни грамма еды (не помочь застрявшему «Поселенцу», хотя
      // пищевой ресурс реально был доступен) или без толку удвоить уже избыточный запас одного вида.
      //
      // Иначе (forCardId — «Учёный»/«Строитель»/«Воин», реальная нехватка которых заранее НЕ известна
      // и еда тут ни при чём, либо forCardId вовсе не задан — «Рабочий» играет сам по себе ради цели 10
      // «про запас», см. §15.4) — еда никакой конкретной карте здесь не нужна, поэтому её приоритет над
      // остальным неуместен (живой баг-репорт: «Рабочий собирает еду для карты «Учёный»/«планирует
      // собрать домашних животных, хотя их на складе уже 2, а торговых ресурсов нет вообще — логичнее
      // хлопок»). Вместо «еда, потом дефицит конкретного вида» — сперва КЛАСС ресурса (food/strategic/
      // trade), которого на складе МЕНЬШЕ порога (`WAREHOUSE_ABUNDANT_THRESHOLD=3` суммарно по всем
      // видам класса — НЕ строго «0»: по прямому запросу, живой баг-репорт «зелёный весь ход тратит на
      // сбор, а мог бы сделать научное открытие» — многим целям (эпоха 4+ исследования нужны сразу 2
      // стратегических, RESEARCH_COST_LINES) недостаточно одной-единственной добытой единицы, а старая
      // проверка «строго 0» считала категорию закрытой уже после первой), и только среди равных по
      // этому признаку — редкость конкретного вида (`RESOURCE_RARITY`, меньше — реже встречается на
      // карте).
      // «Торговый путь» — не хватает не категории вообще (см. warehouseCategoryTotal), а ВТОРОГО
      // РАЗНОГО вида торгового ресурса (см. `distinctTradeResourceCount`/`prioritizeCitiesForWorker`
      // выше — тот же живой баг-репорт «жёлтый играет Торговца, хотя разумнее сначала проложить
      // Торговый путь»): вид торговой категории, которого ЕЩЁ НЕТ на складе (по id), — первый
      // приоритет, вид, который уже есть (лишний дубль для ЭТОЙ цели, второй экземпляр не даёт нового
      // РАЗНООБРАЗИЯ), — как и всё остальное, по общим правилам ниже.
      const ownedTradeIds = new Set(
        (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(([id, qty]) => qty > 0 && RESOURCE_CATEGORY.get(id) === "trade").map(([id]) => id)
      );
      const foodThenScarcest = options.slice().sort((a, b) => {
        if (forCardId && FOOD_TARGET_CARDS.has(forCardId)) {
          const af = RESOURCE_CATEGORY.get(a) === "food" ? 0 : 1;
          const bf = RESOURCE_CATEGORY.get(b) === "food" ? 0 : 1;
          if (af !== bf) return af - bf;
          const haveA = session.warehouse[playerId]?.[a] ?? 0;
          const haveB = session.warehouse[playerId]?.[b] ?? 0;
          return haveA - haveB;
        }
        if (forCardId === "tradeRoute" || forCardId === "trader") {
          const newTradeA = RESOURCE_CATEGORY.get(a) === "trade" && !ownedTradeIds.has(a) ? 0 : 1;
          const newTradeB = RESOURCE_CATEGORY.get(b) === "trade" && !ownedTradeIds.has(b) ? 0 : 1;
          if (newTradeA !== newTradeB) return newTradeA - newTradeB;
        }
        // Эпоха 5+ исследования нужен СПЕЦИФИЧНО 1 из Углеводороды/Электричество — «стратегической»
        // категории вообще (Редкоземельные, Металл и т.п.) для ЭТОЙ конкретной строки цены мало (см.
        // needsHydrocarbonsForResearch выше, тот же баг-репорт «жёлтому не хватает на Учёного»).
        if (forCardId === "scientist" && needsHydrocarbonsForResearch(session, playerId)) {
          const hcA = a === "hydrocarbons" || a === "electricity" ? 0 : 1;
          const hcB = b === "hydrocarbons" || b === "electricity" ? 0 : 1;
          if (hcA !== hcB) return hcA - hcB;
        }
        // Эпоха 6 — та же логика для Урана (см. needsUraniumForResearch): в отличие от Металла (тот
        // реально докупается с рынка внутри confirmResearch), Уран НЕ входит в 6 постоянных лотов
        // «Мирового рынка» — без специального приоритета Рабочий мог продолжать собирать уже
        // профицитную "strategic" категорию, не тронув Уран вовсе.
        if (forCardId === "scientist" && needsUraniumForResearch(session, playerId)) {
          const uA = a === "uranium" ? 0 : 1;
          const uB = b === "uranium" ? 0 : 1;
          if (uA !== uB) return uA - uB;
        }
        // «Воин» — та же логика: реальная нехватка (Металл/Углеводороды и т.п., см.
        // warriorMissingResourceIds выше) конкретна, «стратегическая категория вообще» здесь
        // недостаточна (живой баг-репорт: «для воина не хватает металла и углеводородов, зачем
        // рабочий добывает торговые и пищевые ресурсы» — общее правило ниже просто искало ЛЮБОЙ
        // недобранный класс склада, а Торговый/Пищевой были дефицитны сильнее Стратегического).
        if (forCardId === "warrior") {
          const needed = warriorMissingResourceIds(session, playerId);
          const wA = needed.has(a) ? 0 : 1;
          const wB = needed.has(b) ? 0 : 1;
          if (wA !== wB) return wA - wB;
        }
        // «Строитель» — та же логика: следующее здание в очереди (buildingPriorityOrder, §106) —
        // конкретное, а не «любая недобранная категория» (живой баг-репорт: «зелёный хочет
        // построить Университет, но раз уже есть здание-потребитель энергии, нужен её источник —
        // ГЭС/АЭС, для этого хватает возможностей»).
        if (forCardId === "builder") {
          const needed = builderMissingResourceIds(session, playerId);
          const bA = needed.has(a) ? 0 : 1;
          const bB = needed.has(b) ? 0 : 1;
          if (bA !== bB) return bA - bB;
        }
        const missingA = warehouseCategoryTotal(session, playerId, RESOURCE_CATEGORY.get(a)) < WAREHOUSE_ABUNDANT_THRESHOLD ? 0 : 1;
        const missingB = warehouseCategoryTotal(session, playerId, RESOURCE_CATEGORY.get(b)) < WAREHOUSE_ABUNDANT_THRESHOLD ? 0 : 1;
        if (missingA !== missingB) return missingA - missingB;
        return (RESOURCE_RARITY.get(a) ?? 99) - (RESOURCE_RARITY.get(b) ?? 99);
      });
      const chosen = foodThenScarcest.slice(0, budget);
      const payload2 = { slotIndex, cityId: city.id, chosenTypes: chosen };
      result = session.dispatch("workerCollect", playerId, payload2);
      if (result.ok) {
        reporter.step({
          action: "workerCollect",
          payload: payload2,
          cardSlotIndex: slotIndex,
          cardId,
          targetKind: "city",
          targetCityId: city.id,
          label: `Рабочий собрал ${resourceListLabel(chosen)} в городе (${city.col},${city.row})${workerPurposeLabel(session, playerId, forCardId)}.`,
        });
        return true;
      }
    }
  }
  return false;
}

/** Здания-«краны» (ГЭС/АЭС/Фабрика/Радиовышка/Рынок) — по прямому запросу «научи AI всегда
 * использовать здания если они есть и их можно применить», при этом «в приоритете использование
 * карт и уже потом... здания, если только здания не нужны для того, чтоб получить ресурсы, нужные
 * для того, чтоб сыграть карту». Реализовано местом в основном цикле хода (см. её вызов выше,
 * СРАЗУ ПОСЛЕ `pickAndPlayNextCard`, а не до неё) — раз это шаг внутри `while`-цикла, а не разовая
 * проверка, порядок вызовов сам по себе даёт обе половины требования: (1) карты пробуются раньше
 * зданий на КАЖДОМ заходе, (2) если здание что-то производит, следующий заход того же хода снова
 * начинается с карт — та, что не хватало ресурса секунду назад, получает новый шанс уже с
 * пополненным складом, без отдельного «здание нужно ради карты» условия. ГЭС/АЭС пробуются раньше
 * Фабрики/Радиовышки/Рынка — производят именно то Электричество, которое тем трём и нужно для
 * активации (см. §5 ЦИВА-СПРАВОЧНИК — Углеводороды/Электричество взаимозаменяемы). Каждое здание
 * ограничено своим обычным лимитом (≤1/цикл у всех пятерых) — сервер сам отказывает, если уже
 * использовано, здесь порядок просто определяет, какое пробуется первым. НЕ включены сюда (осознанно
 * — не «крутящие ресурс», а требующие отдельного тактического решения): Казарма/Аэропорт/Ядерный
 * арсенал (уже свои шаги, см. tryActivateYadernyiArsenal/§15.7), Университет/Интернет (недешёвые,
 * 5💰, нужна оценка «а стоит ли»), Управление (эскалирующая цена, нужна оценка «а не переплата ли»),
 * Храм (сжигает карту из руки — не однозначно полезно). */
function tryActivateProductionBuildings(session: GameSession, playerId: number, reporter: Reporter): boolean {
  for (const buildingId of ["ges", "aes", "fabrika", "radiovyshka"]) {
    if (!isOwnedBy(session.buildingOwners, buildingId, playerId)) continue;
    const payload = { buildingId };
    const result = session.dispatch("activateProductionBuilding", playerId, payload);
    if (result.ok) {
      const def = BUILDINGS.find((b) => b.id === buildingId)!;
      reporter.step({
        action: "activateProductionBuilding",
        payload,
        sourceBuildingId: buildingId,
        targetKind: "none",
        label: `${def.name} активирована.${marketSpendNote(result)}`,
      });
      return true;
    }
  }
  if (isOwnedBy(session.buildingOwners, "rynok", playerId)) {
    for (const city of myCities(session, playerId)) {
      const payload = { cityId: city.id };
      const result = session.dispatch("useRynok", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "useRynok",
          payload,
          sourceBuildingId: "rynok",
          targetKind: "city",
          targetCityId: city.id,
          label: `Рынок отработал в городе (${city.col},${city.row}).${marketSpendNote(result)}`,
        });
        return true;
      }
    }
  }
  return false;
}

/** Склад — последний резерв на действие, когда в руке реально нечего сыграть (не только карт нет, но
 * и обычный «Рабочий»-фолбэк уже исчерпан — см. pickAndPlayNextCard/tryWorkerCollect выше) — по
 * прямому запросу («у оранжевого остаётся несыгранное действие, такого быть не должно, если есть что
 * играть... задействовать склад, чтоб получить больше ресурсов и выставить их на продажу или
 * запастись на будущее»). Тот же платный аналог «Рабочего» (`GameSession.skladCollect`, §5 «Склад» —
 * 1 действие + 1💰 за КАЖДУЮ добытую единицу), что доступен человеку кнопкой в самом здании — просто
 * без карты и слота руки. Пробуется, только если Склад построен вовсе (иначе действие и правда
 * потратить некуда).
 *
 * Приоритет городов — та же цель, что мог преследовать несыгранный «Воин» (по прямому уточнению:
 * «согласно приоритетам, если воина построить нельзя, надо действовать, но ресурсы собирать под
 * воина, чтоб если что построить его легче было в следующем ходу — это ЕСЛИ карта уже есть в руке,
 * иначе нельзя строить план наперёд, не зная, выпадет ли, и [только] если это состояние войны») —
 * ТОЛЬКО когда карта «Воин» ПРЯМО СЕЙЧАС лежит в руке (не план на ещё не вышедшую карту) И идёт
 * война: тот же приоритет городов и та же подпись «не хватило X для карты «Воин»», что и у обычного
 * Рабочего-СРЕДСТВА (`prioritizeCitiesForWorker`/`workerPurposeLabel`, forCardId="warrior"). Иначе —
 * просто общий приоритет «разнообразие склада» (цель 10, §15.4), тот же, что у самостоятельного
 * «Рабочего» без цели. */
function trySkladCollect(session: GameSession, playerId: number, reporter: Reporter): boolean {
  if (!isOwnedBy(session.buildingOwners, "sklad", playerId)) return false;
  const forWarrior = isAtWar(session, playerId) && session.hands[playerId].some((c) => c?.id === "warrior");
  const cities = prioritizeCitiesForWorker(session, playerId, myCities(session, playerId), forWarrior ? "warrior" : undefined);
  for (const city of cities) {
    const preview = session.harvestableResourcesFor(playerId, city.id);
    if (!preview.some((r) => isWorthCollecting(session, playerId, r))) continue;
    const payload = { cityId: city.id };
    const result = session.dispatch("skladCollect", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "skladCollect",
        payload,
        sourceBuildingId: "sklad",
        targetKind: "city",
        targetCityId: city.id,
        label: `Склад собрал ${resourceListLabel(preview)} в городе (${city.col},${city.row}) за ${preview.length}💰${forWarrior ? workerPurposeLabel(session, playerId, "warrior") : " — про запас (разнообразие склада)"}.`,
      });
      return true;
    }
  }
  return false;
}

/** Добор карты с колоды за 1 действие (по прямому запросу — «AI тоже добавь такую функцию») —
 * последний резерв ПЕРЕД тем, как честно признать неиспользованное действие: доступно только с
 * пустой рукой (см. GameSession.drawCardFromDeck) — если рука не пуста или колода пуста, сервер
 * просто откажет, здесь это не проверяется заранее отдельно. */
function tryDrawCardFromDeck(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const payload = {};
  const result = session.dispatch("drawCardFromDeck", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "drawCardFromDeck", payload, targetKind: "none", label: `Рука пуста — взял карту с колоды.` });
    return true;
  }
  return false;
}

function tryTrade(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const city of myCities(session, playerId)) {
    const payload = { slotIndex, cityId: city.id };
    const result = session.dispatch("traderTrade", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "traderTrade", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Торговец сыграл в городе (${city.col},${city.row}).` });
      return true;
    }
  }
  return false;
}

function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** По прямому запросу — «стремится открывать те, что ещё не открыли другие игроки; если такие не
 * тянутся по цене — рандомно что попроще» (живой баг-репорт: «почему все компьютеры стремятся
 * сначала Бронзовое литьё пройти» — раньше был просто первый неисследованный этим игроком элемент
 * TECH_TREE, один и тот же порядок массива у всех ботов сразу). Сначала пробует технологии, которых
 * ЕЩЁ НИКТО в партии не открыл (`techDiscoverer[id] === undefined` — бонус первооткрывателя —
 * авто-маршрут/право основать религию/эффект «Философии» — достаётся только ему), от младшей эпохи к
 * старшей и вперемешку внутри одной эпохи («попроще» — дешевле, значит скорее хватит ресурсов на
 * реальный `confirmResearch`, а не просто на попытку). Не набралось ни одной (все недоступны по
 * ресурсам/ветка ещё не дошла) — тот же порядок (эпоха, затем вперемешку) среди технологий, которые
 * уже открыл кто-то другой. */
function tryResearch(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const researched = session.researchedTechs[playerId];
  const remaining = TECH_TREE.filter((t) => !researched.has(t.id));
  // «Учёный», эндгейм-выбор (по прямому запросу) — буквально ВСЕ технологии партии уже открыты этим
  // игроком, confirmResearch играть нечего вовсе — вместо того чтобы просто не сыграть карту, бот
  // выбирает 1 из 4 фиксированных эффектов (см. tryScientistEndgameEffect ниже).
  if (!remaining.length) return tryScientistEndgameEffect(session, playerId, slotIndex, cardId, reporter);

  // По прямому запросу — юнит застрял на острове без корабля (см. shipTechNeededFor): нужная морская
  // технология важнее даже frontier-приоритета ниже, иначе юнит может простоять без дела очень долго.
  const neededShipTechs = new Set(
    session.units
      .filter((u) => u.playerId === playerId)
      .map((u) => shipTechNeededFor(session, playerId, u))
      .filter((id): id is string => id !== null)
  );
  for (const techId of neededShipTechs) {
    const tech = remaining.find((t) => t.id === techId);
    if (!tech) continue;
    const payload = { slotIndex, techId: tech.id };
    const result = session.dispatch("confirmResearch", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "confirmResearch",
        payload,
        cardSlotIndex: slotIndex,
        cardId,
        targetKind: "tech",
        targetTechId: tech.id,
        label: `Исследовал технологию «${tech.id}» — нужна юниту, застрявшему на острове без корабля.`,
      });
      if (session.pendingRoute?.playerId === playerId) tryPickRouteCities(session, playerId, reporter);
      return true;
    }
  }

  const byEpochThenRandom = (list: typeof TECH_TREE) => shuffled(list).sort((a, b) => a.epoch - b.epoch);
  const frontier = byEpochThenRandom(remaining.filter((t) => session.techDiscoverer[t.id] === undefined));
  const rest = byEpochThenRandom(remaining.filter((t) => session.techDiscoverer[t.id] !== undefined));
  for (const tech of [...frontier, ...rest]) {
    const payload = { slotIndex, techId: tech.id };
    const result = session.dispatch("confirmResearch", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "confirmResearch", payload, cardSlotIndex: slotIndex, cardId, targetKind: "tech", targetTechId: tech.id, label: `Исследовал технологию «${tech.id}».` });
      if (session.pendingRoute?.playerId === playerId) tryPickRouteCities(session, playerId, reporter);
      return true;
    }
  }
  return false;
}

/** «Учёный», эндгейм-выбор — простая эвристика между 4 фиксированных эффектов (см.
 * GameSession.useScientistEndgameEffect): военный бонус, если идёт война или бот готовится к ней
 * (§15.6 «Война»/«Подготовка к войне» — стратегический приоритет уже посчитан computeStrategicPriority);
 * иначе обмен колоды, если рука уже тонкая (<3 карт — объективная причина пополнить); иначе рост
 * населения, если есть хотя бы один свой город ещё не на пределе вместимости (6 — гарантированно,
 * раз все 5 технологий вместимости уже открыты, см. условие вызова в tryResearch выше); иначе
 * бесплатные карты «Рост леса» — безопасный запасной вариант, никогда не проваливается технически. */
function tryScientistEndgameEffect(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const mode = computeStrategicPriority(session, playerId);
  const choice: 1 | 2 | 3 | 4 =
    mode === "war" || mode === "warPrep"
      ? 2
      : session.hands[playerId].length < 3
        ? 3
        : myCities(session, playerId).some((c) => c.population < 6)
          ? 1
          : 4;
  const payload = { slotIndex, choice };
  const result = session.dispatch("useScientistEndgameEffect", playerId, payload);
  if (!result.ok) return false;
  reporter.step({
    action: "useScientistEndgameEffect",
    payload,
    cardSlotIndex: slotIndex,
    cardId,
    targetKind: "none",
    label: `Учёный: особый эффект №${choice}.${result.hint ? ` ${result.hint}` : ""}`,
  });
  return true;
}

function tryPickRouteCities(session: GameSession, playerId: number, reporter: Reporter) {
  const cities = myCities(session, playerId);
  for (const from of cities) {
    for (const to of session.cities) {
      if (to.id === from.id) continue;
      const payload = { fromCityId: from.id, toCityId: to.id };
      const result = session.dispatch("pickRouteCities", playerId, payload);
      if (result.ok) {
        reporter.step({ action: "pickRouteCities", payload, targetKind: "city", targetCityId: to.id, label: `Проложил маршрут между городами (${from.col},${from.row}) и (${to.col},${to.row}).` });
        return;
      }
    }
  }
}

function tryPlantForest(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  // Бонус «Учёного» (эндгейм-выбор №4, см. cards.ts CardDef.freeForestGrowth) — та же цель, но без
  // ресурсов/действия; иначе бот дошёл бы обычным confirmResearch-путём до plantForest и заплатил бы
  // за карту, которая уже бесплатна.
  const isFree = !!session.hands[playerId][slotIndex]?.freeForestGrowth;
  const action = isFree ? "plantFreeForest" : "plantForest";
  // По прямому запросу — живой баг-репорт: «оранжевый хочет посадить лес в 12,12, но там город и
  // идёт война; нельзя садить лес... в регионе, где есть вражеские юниты во время войны» — регион
  // сейчас реально ПОД УГРОЗОЙ (`isFrontRegion`, та же метрика, что и everywhere в военных решениях
  // бота) явно не время тратить действие на лесоводство, там нужнее оборона/подкрепление.
  for (const city of myCities(session, playerId).filter((c) => !isFrontRegion(session, playerId, c.regionCol, c.regionRow))) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = city.regionCol * REGION_SIZE_X + dx;
        const row = city.regionRow * REGION_SIZE_Y + dy;
        const payload = { slotIndex, col, row };
        const result = session.dispatch(action, playerId, payload);
        if (result.ok) {
          reporter.step({ action, payload, cardSlotIndex: slotIndex, cardId, targetKind: "hex", targetCol: col, targetRow: row, label: `Посадил лес на (${col},${row}).${marketSpendNote(result)}` });
          return true;
        }
      }
    }
  }
  return false;
}

/** [УБРАНО, по прямому запросу — живой баг-репорт: «к чужим городам может проложить маршрут только
 * при действующем торговом союзе, так как к другим проложить не может — а без торгового союза
 * разумно проложить [маршрут] и потом предложить торговый союз, раз есть путь»] — раньше здесь стоял
 * `canLayTradeRouteTo`: путь к ЧУЖОМУ городу закладывался только если с его владельцем уже действует
 * торговый союз, либо когда ВСЕ свои города уже соединены друг с другом (тогда расширение сети наружу
 * считалось оправданным). На практике это создавало тупик — если свои города физически не связаны по
 * суше/морю между собой (разные острова), а торгового союза с соседом ещё нет, бот вообще никогда не
 * мог проложить ПЕРВЫЙ маршрут к чужому городу, а значит и не мог создать ту самую связь, которая
 * (см. §8.6 п.4, `considerTradeUnionForSharedNetwork`) как раз и служит поводом ПРЕДЛОЖИТЬ торговый
 * союз — «Право прокладки маршрута»/«Торговый путь» простаивали в руке навсегда без единого валидного
 * хода. Теперь путь к чужому городу закладывается так же свободно, как и между своими (единственная
 * оставшаяся проверка — не идти в город самого себя, `to.id === from.id`; война с конкретным
 * владельцем по-прежнему отдельно проверяется на сервере, `GameSession.playRouteRightCard`/
 * `layNewTradeRoute`, здесь не дублируется). */

/** Карта «Торговый путь» во время войны — по прямому запросу («убирать торговые сети врага... если
 * идёт война»): пробует УДАЛИТЬ чей-то существующий маршрут, если его владелец сейчас в состоянии
 * войны с ботом (deleteTradeRoute — «чей угодно маршрут», платящий не обязан им владеть, см.
 * GameSession.deleteTradeRoute); только если удалять нечего/не на что — как раньше, прокладывает
 * новую свою сеть. */
function tryDeleteEnemyTradeRoute(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const route of session.tradeRoutes.filter((r) => session.relationOf(playerId, r.playerId).war)) {
    const payload = { slotIndex, routeId: route.id };
    const result = session.dispatch("deleteTradeRoute", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "deleteTradeRoute",
        payload,
        cardSlotIndex: slotIndex,
        cardId,
        targetKind: "city",
        targetCityId: route.toCityId,
        label: `Разорвал торговый путь противника (маршрут #${route.id}) — идёт война.`,
      });
      return true;
    }
  }
  return false;
}

function tryLayTradeRoute(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (tryDeleteEnemyTradeRoute(session, playerId, slotIndex, cardId, reporter)) return true;
  for (const from of myCities(session, playerId)) {
    for (const to of session.cities) {
      if (to.id === from.id) continue;
      const payload = { slotIndex, fromCityId: from.id, toCityId: to.id };
      const result = session.dispatch("layNewTradeRoute", playerId, payload);
      if (result.ok) {
        reporter.step({ action: "layNewTradeRoute", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: to.id, label: `Проложил торговый путь (${from.col},${from.row}) → (${to.col},${to.row}).` });
        return true;
      }
    }
  }
  return false;
}

/** Находит СЛОТ «Права прокладки маршрута» сама (в отличие от остальных tryXxx — тем, ей передаёт
 * slotIndex общий диспетчер tryPlayCardSlot) — нужна отдельно, чтобы попробовать сыграть её ДАЖЕ
 * когда обычные actionsLeft уже кончились (см. runAiTurnLogic — карта бесплатна по действиям, по
 * прямому запросу). */
function tryAnyRouteRight(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const slotIndex = session.hands[playerId].findIndex((c) => c?.id === "routeRight");
  if (slotIndex === -1) return false;
  return tryRouteRight(session, playerId, slotIndex, "routeRight", reporter);
}

function tryRouteRight(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const from of myCities(session, playerId)) {
    for (const to of session.cities) {
      if (to.id === from.id) continue;
      const payload = { slotIndex, fromCityId: from.id, toCityId: to.id };
      const result = session.dispatch("playRouteRightCard", playerId, payload);
      if (result.ok) {
        reporter.step({ action: "playRouteRightCard", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: to.id, label: `Разыграл «Право прокладки маршрута» между (${from.col},${from.row}) и (${to.col},${to.row}).` });
        return true;
      }
    }
  }
  return false;
}

/** «Налоги» — условие ПРИМЕНИМОСТИ карты (не приоритета, поэтому в списки §15.6 не входит, как и два
 * похожих гейта выше): доход должен быть хотя бы положительным (`taxIncomeEstimate`), ИНАЧЕ — играть
 * себе в убыток осмысленно только как последнее средство разгрузить руку перед вынужденным сбросом
 * (по прямому запросу — «для налогов всё равно нужен порог дохода, иначе играется только если нужно
 * не допустить достижения лимита карт»). «Близко к лимиту» — рука уже не меньше HAND_SIZE=7 (тот же
 * порог, что запускает вынужденный сброс на конце хода, `GameSession.handCountedSize`); при доходе
 * ≤0 и руке меньше этого порога карта не играется вовсе, уходит по обычной лестнице приоритета/
 * передачи ниже. */
function taxesApplicable(session: GameSession, playerId: number): boolean {
  if (taxIncomeEstimate(session, playerId) > 0) return true;
  return session.hands[playerId].length >= HAND_SIZE;
}

function tryTaxes(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (!taxesApplicable(session, playerId)) return false;
  const payload = { slotIndex };
  const result = session.dispatch("collectTaxesCard", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "collectTaxesCard", payload, cardSlotIndex: slotIndex, cardId, targetKind: "none", label: `Собрал налоги: ${result.hint ?? ""}` });
    return true;
  }
  return false;
}

/** «Устранение катастрофы» (последний пункт списка приоритета в каждом режиме, §15.6) — розыгрыш
 * карты РАДИ ОПЛАТЫ отвода (1 Лес + 1 Силикат), а не ради принятия последствий. Оплату обязательно
 * проверить ЗАРАНЕЕ: `resolveCatastropheChoice("pay")` при нехватке ресурсов молча применяет
 * последствия (случайное своё здание уничтожено, либо город теряет 3 населения — вплоть до
 * исчезновения города, кроме столицы) и всё равно отвечает ok, так что отличить «предотвратил» от
 * «разрушил сам себе город» постфактум нельзя. Нечем платить — карта не играется вовсе и остаётся
 * кандидатом на передачу (по лестнице §15.4 она и так уходит первой: событие из нижней половины
 * списка) — ровно то же поведение, что было до появления этого пункта в приоритете. */
/** «Играть Катастрофу стоит, только если исход предсказуемо безобиден» (по прямому запросу —
 * «принять негативный эффект, ведь он не имеет последствий»): не только оплата (`canAvertCatastrophe`
 * — 1 Лес + 1 Силикат), но и ветка «принять последствия» может оказаться настоящим холостым выстрелом
 * (`GameSession.catastropheAcceptIsHarmless` — своих зданий нет, единственный город — столица на полу
 * населения). Розыгрыш карты (`playCatastropheCard`) сам решение не принимает — он только заводит
 * `pendingCatastrophe`; фактическое разрешение (заплатить, если можется, иначе принять) происходит
 * позже тем же ходом внутри `resolveHazards` — тому НЕ нужно знать, какая из двух причин здесь
 * сработала, `resolveCatastropheChoice("pay")` сам молча падает на «принять», если платить нечем. */
function catastropheSafelyResolvable(session: GameSession, playerId: number): boolean {
  return session.canAvertCatastrophe(playerId) || session.catastropheAcceptIsHarmless(playerId);
}
function tryCatastrophe(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (!catastropheSafelyResolvable(session, playerId)) return false;
  const payload = { slotIndex };
  const result = session.dispatch("playCatastropheCard", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "playCatastropheCard", payload, cardSlotIndex: slotIndex, cardId, targetKind: "none", label: `Разыграл карту «Катастрофа» (последствия — отдельным шагом).` });
    return true;
  }
  return false;
}

/** «Распродажа» — последний пункт списка приоритета в каждом режиме, перед «Катастрофой» (по
 * прямому запросу). Играется, только если реально ЕСТЬ что сбрасывать — сама карта уходит из руки
 * при розыгрыше (`consumeHandCard`), так что «пустой» розыгрыш (0 карт сброшено, 0💰 получено) имел
 * бы смысл ТОЛЬКО когда в руке больше вообще ничего играбельного не осталось, а такой розыгрыш и так
 * оказался бы последним в очереди приоритета — если он вообще случился, значит все карты приоритетнее
 * либо отсутствуют, либо уже не сыграли в этот заход. Ресурсы (по 1 Еда/Стратегический/Торговый)
 * проверяет сам dispatch — сколько-то из руки останется несброшенным, только если денег/ресурсов не
 * хватило даже на саму карту, тогда розыгрыш просто не удаётся целиком (`result.ok === false`). */
function trySaleCard(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (session.hands[playerId].filter((c) => c && c.id !== "routeRight" && c.id !== "sale").length === 0) return false;
  const payload = { slotIndex };
  const result = session.dispatch("playSaleCard", playerId, payload);
  if (result.ok) {
    reporter.step({
      action: "playSaleCard",
      payload,
      cardSlotIndex: slotIndex,
      cardId,
      targetKind: "none",
      label: `Разыграл «Распродажу»: ${result.hint ?? ""}${marketSpendNote(result)}`,
    });
    return true;
  }
  return false;
}

/** «Население» (заменила невостребованную «Мобилизацию», по прямому запросу) — без цели, без
 * дополнительного AI-гейта сверх того, что уже проверяет сам сервер (N разных пищевых видов, N =
 * число городов, см. GameSession.usePopulationCard) — набралось нужное разнообразие на складе/бирже,
 * дальше играется как обычная приоритетная карта. */
function tryPopulationCard(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const payload = { slotIndex };
  const result = session.dispatch("usePopulationCard", playerId, payload);
  if (result.ok) {
    reporter.step({
      action: "usePopulationCard",
      payload,
      cardSlotIndex: slotIndex,
      cardId,
      targetKind: "none",
      label: `Разыграл «Население» — население всех городов +1 (не выше 6).${marketSpendNote(result)}`,
    });
    return true;
  }
  return false;
}

// === Биржа — продажа излишков и докупка нехватающего (действий не тратит) ======================

/** Держим на складе не больше этого числа единиц любого одного ресурса — остальное выставляем на
 * продажу (по прямому запросу — «выставляет на продажу лишние ресурсы»); WAREHOUSE_CAP = 6 общей
 * суммой по всем видам сразу, так что запас в 3 на тип уже сам по себе разумный потолок для 1-2
 * видов, не считая небольшой люфт под конец хода — endBotTurn всё равно досасывает остаток, если
 * needsWarehouseTrim всё же сработает. */
const SURPLUS_KEEP_PER_RESOURCE = 3;
const SELL_PRICE = 4;
const MARKET_MONEY_RESERVE = 5;
/** Ресурсы, которые бот докупает на бирже, если их вовсе нет на складе (по прямому запросу —
 * «скупает то чего не хватает если нужно с биржи») — еда (иначе города не растут) и самые ходовые
 * стратегические ресурсы стройки/исследований. Пищевые виды (см. `FOOD_NEEDED_RESOURCES` ниже)
 * докупаются ОДНОЙ группой (любой вид еды взаимозаменяем, см. `planFoodSpend`), а не по этому
 * списку — здесь остались только НЕпищевые нужды, каждая сама по себе.
 *
 * [ИСПРАВЛЕНО — рецидив §41/tryBuilder, живой баг-репорт «жёлтый докупает дерево, хотя оно уже было
 * на складе и в руке 2 «Рабочих»»] — «Лес» здесь раньше стоял наравне с Силикатами/Металлом, но это
 * не одна и та же ситуация: Силикаты/Металл — обычные гексовые ресурсы, «Рабочий» добывает их
 * бесплатно повторно каждый цикл, а этот список — лишь СТРАХОВКА «пока Рабочий не добрался», разумная
 * для них. Лес — не гексовый ресурс вовсе (targetCount:0), его единственный источник — вырубка леса
 * («Строитель», необратима, только по реальной нужде, см. tryBuilder/builderMissingResourceIds) или
 * основание города на лесу; держать его «про запас» на складе смысла не имеет — ровно то же
 * рассуждение, что и в tryBuilder. Без этой правки бот, законно потратив Лес на реальную цель (стройку
 * деревянного корабля/здания), тут же покупал его обратно на бирже за деньги, хотя тратить его больше
 * было не на что — пустая трата хода/денег. */
const NEEDED_RESOURCES: ResourceId[] = ["silicates", "metalOre"];
/** По прямому запросу — живой баг-репорт: «синий хочет купить злаки для еды, но на рынке есть
 * овощи [дешевле]» — раньше еда докупалась по ЭТОМУ фиксированному списку id один за другим (злаки
 * первыми), поэтому при пустом складе бот покупал именно злаки, даже когда на бирже был дешевле
 * ЛЮБОЙ другой вид еды — а для любой пищевой нужды (`planFoodSpend`/`isFoodOrJoker`) вид совершенно
 * не важен, только категория "food". Ниже вместо перебора по видам — одна покупка САМОГО ДЕШЁВОГО
 * лота ЛЮБОГО пищевого вида, если на складе нет еды вовсе. */
const FOOD_NEEDED_RESOURCES: ResourceId[] = ["grain", "livestock", "fruit", "vegetables", "fish", "shellfish"];

/** Цена, по которой бот выставляет ИЗЛИШЕК ресурса на продажу (по прямому запросу, вместо плоской
 * SELL_PRICE для всех подряд): обычно СРЕДНЯЯ цена уже АКТИВНЫХ лотов ИМЕННО ЭТОГО ресурса на бирже
 * прямо сейчас (округлённо) — конкурентная цена по факту спроса, не наугад; лотов этого ресурса нет
 * вовсе — фиксированный ориентир `SELL_PRICE` (тот же принцип «нет данных — дефолт», что и у
 * `valueOfResource`, §8.1). Ровно ОДИН активный лот этого ресурса — усреднение по единственной точке
 * ненадёжно (по прямому уточнению — «представлен единично на бирже»): вместо этого берётся
 * МАКСИМАЛЬНАЯ цена среди активных лотов ТОГО ЖЕ КЛАССА (food/strategic/trade), минус 1 — «раз
 * данных по самому ресурсу почти нет, ориентируемся на потолок всего класса, но чуть ниже». Итог
 * всегда зажат в допустимый диапазон цены лота [1, 10], см. `GameSession.sellResource`. */
function surplusSellPrice(session: GameSession, resource: ResourceId): number {
  const sameResourceListings = session.market.filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.resource === resource);
  if (sameResourceListings.length === 0) return SELL_PRICE;
  if (sameResourceListings.length === 1) {
    const category = RESOURCE_CATEGORY.get(resource);
    const sameCategoryPrices = session.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && RESOURCE_CATEGORY.get(l.resource!) === category)
      .map((l) => l.price);
    return Math.max(1, Math.min(10, Math.max(...sameCategoryPrices) - 1));
  }
  const avg = sameResourceListings.reduce((sum, l) => sum + l.price, 0) / sameResourceListings.length;
  return Math.max(1, Math.min(10, Math.round(avg)));
}

/** «Военный сундук» (по прямому запросу — «если нет денег на войну, добавить в приоритеты после
 * роста населения продажу ресурсов, которых больше 1, с дисконтом на 1 дешевле рыночной; раз уж он
 * в статусе войны — пусть действует») — пока стратегия ВОЙНА/ПОДГОТОВКА (`computeStrategicPriority`),
 * выставляет на биржу ровно СТОЛЬКО ресурсов, сколько нужно, чтобы покрыть цену переброски своей
 * армии (`campaignMoneyNeeded` — тот же расчёт «3💰 на юнита», что и готовность похода/плана войны),
 * НЕ БОЛЬШЕ.
 *
 * [ИСПРАВЛЕНО, живой баг-репорт — «AI забивает на всё и играет одних Рабочих»] — раньше условие входа
 * было `!envHasMoneyPerUnit` (деньги < числа юнитов, другой критерий — «содержание армии», не
 * переброска), а сам цикл распродажи вообще не проверял, сколько уже удалось выручить: он БЕЗУСЛОВНО
 * сбрасывал ЛЮБОЙ ресурс, которого больше 1, до 1 штуки — весь склад целиком, каждый заход. Но
 * `sellResource` только ВЫСТАВЛЯЕТ лот — деньги приходят лишь когда лот кто-то купит, не сразу; в
 * ОДНОМ и том же ходу (`session.money[playerId]` тут же после выставления) касса не растёт вовсе, а
 * значит условие входа (что бы оно ни проверяло) остаётся ложным КАЖДЫЙ ход подряд — функция
 * срабатывала на КАЖДОМ ходу в режиме ВОЙНА/ПОДГОТОВКА, пока казна физически не могла угнаться (никто
 * не обязан скупать лоты сразу), вычищая склад под ноль постоянно: любая карта, которой нужен
 * складской ресурс («Строитель», «Учёный», «Торговый путь»…), проваливалась КАЖДЫЙ ход, а «Рабочий»
 * (несклад-зависимая карта сбора) оставался единственной реально играбельной.
 *
 * Теперь цель — `campaignMoneyNeeded(countUnitsOf)`, а «уже выручено» считает не только наличные, но
 * и цену уже ВЫСТАВЛЕННЫХ (ещё не купленных) своих лотов на бирже (`pendingListingsValue`) — тот
 * потенциальный доход, что и так в пути. Как только (касса + лоты в ожидании покупателя) достигают
 * цели — распродажа останавливается СРАЗУ, не трогая остаток склада (следующий заход снова проверит
 * то же условие и, если казна/лоты с тех пор не изменились, просто ничего не сделает — не будет
 * бесконечно перевыставлять то, что и так уже на бирже). Одна и та же формула — и условие входа, и
 * условие остановки цикла: перебор идёт по видам ресурса, сбрасывая до 1 штуки, но прерывается, как
 * только цель достигнута, не обязательно проходя весь склад. Драгоценные металлы не трогает — у них
 * отдельный, более выгодный канал (`cashInPreciousMetals`, см. marketPass ниже). Действий не тратит —
 * биржа, как и обычная распродажа излишков, доступна в любой момент хода. Вызывается ДО marketPass. */
function tryWarChestFireSale(session: GameSession, playerId: number, reporter: Reporter) {
  const mode = computeStrategicPriority(session, playerId);
  if (mode !== "war" && mode !== "warPrep") return;
  const target = campaignMoneyNeeded(countUnitsOf(session, playerId));
  const pendingListingsValue = session.market.filter((l) => l.sellerId === playerId).reduce((sum, l) => sum + l.price, 0);
  let raised = session.money[playerId] + pendingListingsValue;
  if (raised >= target) return;
  const warehouse = session.warehouse[playerId] ?? {};
  for (const [resource, qty] of Object.entries(warehouse) as [ResourceId, number][]) {
    if (raised >= target) return;
    if (resource === "preciousMetals") continue;
    if (!qty || qty <= 1) continue;
    let toSell = qty - 1;
    while (toSell > 0 && raised < target) {
      const price = Math.max(1, surplusSellPrice(session, resource) - 1);
      const payload = { resource, price };
      const result = session.dispatch("sellResource", playerId, payload);
      if (!result.ok) break;
      toSell--;
      raised += price;
      reporter.step({
        action: "sellResource",
        payload,
        targetKind: "market",
        targetResource: resource,
        label: `Военный сундук: выставил на продажу 1×${resource} за ${price}💰 (дисконт — нужны деньги на переброску армии).`,
      });
    }
  }
}

function marketPass(session: GameSession, playerId: number, reporter: Reporter) {
  const warehouse = session.warehouse[playerId] ?? {};
  // Драгоценные металлы (по прямому запросу — «третий источник дохода», конвертируются напрямую в
  // деньги, не через биржу вовсе, см. GameSession.cashInPreciousMetals) — у ресурса нет никакого
  // другого применения в игре (ни одна технология/здание/карта его не требует), поэтому бот
  // обменивает ВЕСЬ остаток целиком каждый ход, без резерва — в отличие от обычных торговых
  // излишков ниже (SURPLUS_KEEP_PER_RESOURCE), которые ещё могут пригодиться для построек/маршрутов.
  const preciousQty = warehouse.preciousMetals ?? 0;
  if (preciousQty > 0) {
    const payload = { qty: preciousQty };
    const result = session.dispatch("cashInPreciousMetals", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "cashInPreciousMetals",
        payload,
        targetKind: "market",
        targetResource: "preciousMetals",
        label: `Обменял ${preciousQty}×Драгоценные металлы на деньги.`,
      });
    }
  }
  for (const [resource, qty] of Object.entries(warehouse) as [ResourceId, number][]) {
    if (resource === "preciousMetals") continue; // обработано выше отдельно
    if (!qty || qty <= SURPLUS_KEEP_PER_RESOURCE) continue;
    let toSell = qty - SURPLUS_KEEP_PER_RESOURCE;
    while (toSell > 0) {
      const price = surplusSellPrice(session, resource);
      const payload = { resource, price };
      const result = session.dispatch("sellResource", playerId, payload);
      if (!result.ok) break;
      toSell--;
      reporter.step({ action: "sellResource", payload, targetKind: "market", targetResource: resource, label: `Выставил на продажу 1×${resource} за ${price}💰.` });
    }
  }

  const buyCheapest = (resource: ResourceId, listing: MarketListing & { kind: "resource" }) => {
    if (session.money[playerId] - listing.price < MARKET_MONEY_RESERVE + reservedMoneyForPendingProposals(session, playerId)) return;
    const payload = { listingId: listing.id };
    const result = session.dispatch("buyListing", playerId, payload);
    if (result.ok) reporter.step({ action: "buyListing", payload, targetKind: "market", targetResource: resource, label: `Купил 1×${resource} за ${listing.price}💰 на бирже.` });
  };

  const hasAnyFood = FOOD_NEEDED_RESOURCES.some((r) => (warehouse[r] ?? 0) > 0);
  if (!hasAnyFood) {
    const cheapestFood = session.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId && FOOD_NEEDED_RESOURCES.includes(l.resource!))
      .sort((a, b) => a.price - b.price)[0];
    if (cheapestFood) buyCheapest(cheapestFood.resource!, cheapestFood);
  }

  for (const resource of NEEDED_RESOURCES) {
    if ((session.warehouse[playerId]?.[resource] ?? 0) > 0) continue;
    const listing = session.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.resource === resource && l.sellerId !== playerId)
      .sort((a, b) => a.price - b.price)[0];
    if (!listing) continue;
    buyCheapest(resource, listing);
  }
}

// === Конец хода — досдаёт лишний склад / подтверждает сброс руки, если сервер их потребовал ====

function endBotTurn(session: GameSession, playerId: number, reporter: Reporter) {
  let payload: Record<string, unknown> = {};
  let result = session.dispatch("endTurn", playerId, payload);
  let guard = 0;
  while (!result.ok && guard++ < 20) {
    if (result.needsWarehouseTrim) {
      forceSellOverflow(session, playerId, result.needsWarehouseTrim.overBy, reporter);
      payload = {};
      result = session.dispatch("endTurn", playerId, payload);
    } else if (result.needsDiscardConfirm) {
      payload = { confirmed: true };
      result = session.dispatch("endTurn", playerId, payload);
    } else {
      return; // не удалось — план обрывается здесь, endTurn просто не попадёт в шаги
    }
  }
  if (result.ok) reporter.step({ action: "endTurn", payload, targetKind: "none", label: "Завершение хода." });
}

function forceSellOverflow(session: GameSession, playerId: number, overBy: number, reporter: Reporter) {
  const entries = (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);
  let left = overBy;
  for (const [resource] of entries) {
    while (left > 0) {
      // Драгоценные металлы больше не выставляются на биржу (см. GameSession.sellResource) — здесь
      // это единственное МЕСТО, где `sellResource` вызывался безусловно на ЛЮБОЙ ресурс склада; без
      // этой ветки бот застревал бы, не в силах снизить склад ниже лимита, если излишек именно в них.
      const payload = resource === "preciousMetals" ? { qty: 1 } : { resource, price: 3 };
      const result = session.dispatch(resource === "preciousMetals" ? "cashInPreciousMetals" : "sellResource", playerId, payload);
      if (!result.ok) break;
      left--;
      reporter.step({
        action: resource === "preciousMetals" ? "cashInPreciousMetals" : "sellResource",
        payload,
        targetKind: "market",
        targetResource: resource,
        label:
          resource === "preciousMetals" ? "Обменял 1×Драгоценные металлы на деньги (превышение лимита склада)." : `Продал 1×${resource} за 3💰 (превышение лимита склада).`,
      });
    }
    if (left <= 0) break;
  }
}
