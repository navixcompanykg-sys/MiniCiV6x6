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
import { GameSession, type Proposal, type ProposalTerm, type UnitInstance, type Paradigm, type Religion, type Agreement, type MarketListing, type City } from "./GameSession";
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
      session.pendingAiPlan = { playerId: current.id, steps: computeAiTurnPlan(session, current.id) };
      return;
    }
    return;
  }
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
 * нативно), так что клон и оригинал больше не делят ни одного изменяемого объекта. */
export function computeAiTurnPlan(session: GameSession, playerId: number): AiPlanStep[] {
  const snapshot = structuredClone(session.toJSON());
  const clone = GameSession.fromJSON(session.id, snapshot);
  const steps: AiPlanStep[] = [];
  runAiTurnLogic(clone, playerId, makePlanReporter(steps));
  return steps;
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
  const steps = computeAiTurnPlan(session, playerId);
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
    const col = rc * REGION_SIZE_X + Math.floor(REGION_SIZE_X / 2);
    const row = rr * REGION_SIZE_Y + Math.floor(REGION_SIZE_Y / 2);
    const result = session.dispatch("placeToken", playerId, { col, row });
    if (result.ok) {
      placed++;
      log(`Разместил жетон #${placed} в регионе (${rc},${rr}).`);
    }
  }
}

// === Игровая фаза — вся логика одного хода, параметризована Reporter'ом ========================

function runAiTurnLogic(session: GameSession, playerId: number, reporter: Reporter) {
  resolveHazards(session, playerId, reporter);
  resolveIncomingProposals(session, playerId, reporter);
  considerPeaceOffers(session, playerId, reporter);
  considerWarDeclaration(session, playerId, reporter);
  considerDiplomacyDeals(session, playerId, reporter);
  considerParadigm(session, playerId, reporter);
  considerReligion(session, playerId, reporter);
  considerCommunismCity(session, playerId, reporter);

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
    if (!pickAndPlayNextCard(session, playerId, reporter)) break;
  }

  runMilitaryOrders(session, playerId, reporter);
  marketPass(session, playerId, reporter);
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

/** 1. Город — население × число СТРАТЕГИЧЕСКИХ ресурсов в его регионе (0, если таких нет вовсе). */
function valueOfCity(session: GameSession, city: { population: number; regionCol: number; regionRow: number }): number {
  const strategicCount = session.resourcesInRegion(city.regionCol, city.regionRow).filter((r) => RESOURCE_CATEGORY.get(r) === "strategic").length;
  return city.population * strategicCount;
}
/** 2. Юнит — одинаково для всех категорий, 2 × эпоха. */
function valueOfUnit(unit: { epoch: number }): number {
  return 2 * unit.epoch;
}
/** 3. Деньги — 1:1. */
function valueOfMoney(amount: number): number {
  return amount;
}
/** 4. Технология — эпоха × 2. */
function valueOfTechByEpoch(epoch: number): number {
  return epoch * 2;
}
/** 5. Открытые границы — фиксированно. */
const VALUE_OPEN_BORDERS = 2;

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
/** 6. Торговый союз — число городов торговой сети × 2 (сеть, в которую входит указанный город). */
function valueOfTradeUnion(session: GameSession, cityId: number): number {
  return tradeNetworkCityIds(session, cityId).size * 2;
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
/** 10. Ресурс — средняя биржевая стоимость (среднее цены среди активных лотов этого ресурса на
 * рынке прямо сейчас); нет активных лотов — фиксированный базовый ориентир (тот же, что «Рынок»
 * использует для продажи излишков, см. SELL_PRICE ниже). */
const FALLBACK_RESOURCE_VALUE = 4;
function valueOfResource(session: GameSession, resource: ResourceId): number {
  const listings = session.market.filter((l) => l.kind === "resource" && l.resource === resource);
  if (!listings.length) return FALLBACK_RESOURCE_VALUE;
  return listings.reduce((s, l) => s + l.price, 0) / listings.length;
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
/** 12/13. Карта — действие +5, событие −5 (событие «стоит» отрицательно: это то, от чего хочется
 * избавиться, см. §15.4/looksUnplayableThisTurn — согласуется с этим же знаком). Не участвует ни в
 * одном из 5 сценариев §8 ниже (в текущем словаре ProposalTerm карту нельзя ни предложить, ни
 * потребовать сделкой) — экспортирована как часть общей библиотеки ценности объектов на будущее. */
export function valueOfCard(card: { kind: "action" | "event" }): number {
  return card.kind === "event" ? -5 : 5;
}
/** 14. Здание — ценность ресурсов на его постройку (п.10 на каждую строку цены; `category`/`anyOf`
 * строки — конкретный ресурс заранее не известен, берётся базовый ориентир/самый дешёвый вариант
 * соответственно, не точная сумма). Как и valueOfCard выше — пока не участвует ни в одном сценарии
 * (здание тоже нельзя предложить в сделке текущим словарём ProposalTerm), экспортирована на будущее. */
export function valueOfBuilding(session: GameSession, building: BuildingDef): number {
  let total = 0;
  for (const line of building.costLines) {
    if (line.kind === "specific") total += valueOfResource(session, line.resource as ResourceId) * line.count;
    else if (line.kind === "category") total += FALLBACK_RESOURCE_VALUE * line.count;
    else if (line.kind === "anyOf") total += Math.min(...line.resources.map((r) => valueOfResource(session, r as ResourceId))) * line.count;
  }
  return total;
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
      const myCity = myCities(session, viewerId)[0];
      return myCity ? valueOfTradeUnion(session, myCity.id) : 0;
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
  }
}
/** Суммарная ценность целого предложения с точки зрения `viewerId`. */
function proposalNetValueFor(session: GameSession, viewerId: number, p: { from: number; to: number; terms: ProposalTerm[] }): number {
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
  return proposalNetValueFor(session, p.to, p) >= 0;
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

const STRATEGIC_RESOURCES_FOR_WAR: ResourceId[] = ["metalOre", "silicates", "hydrocarbons", "preciousMetals", "uranium", "rareEarth", "electricity"];

/** Есть ли у игрока хотя бы 1 гекс с этим ресурсом в одном из СВОИХ регионов — географическое
 * приближение «обладает ресурсом» (без учёта технологии добычи — «жадность» касается территории, не
 * того, готов ли игрок её прямо сейчас разрабатывать). */
function hasResourceInOwnTerritory(session: GameSession, playerId: number, resource: ResourceId): boolean {
  for (const region of ownedRegionsOf(session, playerId)) {
    const [rc, rr] = region.split(",").map(Number);
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        if (session.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).resource === resource) return true;
      }
    }
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

const WAR_MONEY_THRESHOLD = 30; // «денег хватает на военную операцию» (по прямому запросу)
const WAR_FORCE_RATIO = 2; // «силы AI выше более чем вдвое»
const CHALLENGE_FORCE_RATIO = 0.9; // условие 3 — «военные силы равны или чуть превосходят»
const TERRITORIAL_VICTORY_WATCH_CITIES = 8; // «один из игроков достиг 8 поселений»

/** Условия объявления войны — по прямому запросу дословно, 3 причины:
 * 1. Нет стратегического ресурса, у более СЛАБОГО (по числу юнитов) соседа есть.
 * 2. Некуда расти — все свои города на пределе вместимости, но в руке есть карта поселения.
 * 3. Соперник близок к территориальной победе (≥8 городов), силы примерно равны — можно помешать.
 * Условия 1/2 требуют общий порог «сила ×2 + запас денег»; условие 3 — свой, более мягкий порог
 * (паритет сил), т.к. цель не завоевание, а срыв чужой победы. Возвращает первую применимую пару
 * цель+причина или null — по одной попытке объявления войны за ход, не заваливаем сразу всех. */
function considerWarTargets(session: GameSession, playerId: number): { targetId: number; reason: string } | null {
  const myUnits = countUnitsOf(session, playerId);

  for (const p of session.players) {
    if (p.id === playerId) continue;
    const theirCities = session.cities.filter((c) => c.playerId === p.id).length;
    if (theirCities < TERRITORIAL_VICTORY_WATCH_CITIES) continue;
    const theirUnits = countUnitsOf(session, p.id);
    if (myUnits >= theirUnits * CHALLENGE_FORCE_RATIO) return { targetId: p.id, reason: "рядом территориальная победа соперника" };
  }

  if (myUnits <= 0 || session.money[playerId] < WAR_MONEY_THRESHOLD) return null;
  const neighbors = neighborPlayerIds(session, playerId);
  const weakerNeighbors = neighbors.filter((id) => myUnits > countUnitsOf(session, id) * WAR_FORCE_RATIO);
  if (!weakerNeighbors.length) return null;

  for (const resource of STRATEGIC_RESOURCES_FOR_WAR) {
    if (hasResourceInOwnTerritory(session, playerId, resource)) continue;
    for (const targetId of weakerNeighbors) {
      if (hasResourceInOwnTerritory(session, targetId, resource)) return { targetId, reason: `нехватка ресурса «${resource}»` };
    }
  }

  const myCities = session.cities.filter((c) => c.playerId === playerId);
  const hasSettlerCard = session.hands[playerId]?.some((c) => c.id === "settler" || c.id === "population");
  const capacity = cityCapacityForApprox(session, playerId);
  const allCitiesFull = myCities.length > 0 && myCities.every((c) => c.population >= capacity);
  if (hasSettlerCard && allCitiesFull) {
    const target = weakerNeighbors.slice().sort((a, b) => countUnitsOf(session, a) - countUnitsOf(session, b))[0];
    return { targetId: target, reason: "некуда расти — нужна территория" };
  }

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

/** Ищет мира (по прямому запросу): «если кончились деньги» или «если перевес сил перешёл
 * противнику» — предлагает все деньги ИЛИ (если денег нет) самый большой запас склада, за перемирие
 * на 6 циклов. «Достигнув цели — предлагает мир» — цель определяется захватом территории (этап
 * движения войск, ещё не реализован) — пока не проверяется. */
function considerPeaceOffers(session: GameSession, playerId: number, reporter: Reporter) {
  for (const p of session.players) {
    if (p.id === playerId) continue;
    if (!session.relationOf(playerId, p.id).war) continue;
    const myUnits = countUnitsOf(session, playerId);
    const theirUnits = countUnitsOf(session, p.id);
    const myMoney = session.money[playerId];
    const outOfMoney = myMoney <= 0;
    const outmatched = myUnits < theirUnits;
    if (!outOfMoney && !outmatched) continue;

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

    const payload = { to: p.id, terms, ultimatum: false };
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
function proposeAgreement(session: GameSession, playerId: number, targetId: number, agreement: Agreement, reporter: Reporter, reason: string): boolean {
  if (session.pendingProposals.some((pr) => pr.from === playerId && pr.to === targetId)) return false;
  const terms: ProposalTerm[] = [{ kind: "agreement", agreement }];
  const payload = { to: targetId, terms, ultimatum: false };
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
    (id) => id !== threat.id && !session.relationOf(playerId, id).war && !session.relationOf(playerId, id).agreements.has("mutualDefense")
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
    (p) => p.id !== playerId && p.id !== strongest.id && !session.relationOf(playerId, p.id).war && !session.relationOf(playerId, p.id).agreements.has("mutualDefense")
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
    if (proposeAgreement(session, playerId, partnerId, "tradeUnion", reporter, "уже связаны общей торговой сетью")) return true;
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
        (session.researchedTechs[p.id]?.size ?? 0) > myCount
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

function considerDiplomacyDeals(session: GameSession, playerId: number, reporter: Reporter) {
  const scenarios = [considerDefensePactAfterTruce, considerBalanceOfPowerAlliance, considerTradeUnionForSharedNetwork, considerScienceCoopWhenBehind, considerJointWarAlliance];
  for (const scenario of scenarios) {
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

/** Парламентаризм бесполезен («активация уже построенных зданий не тратит действие») без построек —
 * по прямому запросу переходит на него, только если построено хотя бы 2 здания, иначе пропускает его
 * принятие до следующей, более передовой парадигмы (см. considerParadigm — «пропускает» здесь просто
 * значит «не входит в число кандидатов», следующая по эпохе доступная берётся как обычно). Остальные
 * парадигмы такого условия не имеют. */
function paradigmViable(session: GameSession, playerId: number, paradigm: Paradigm): boolean {
  if (paradigm === "parliamentarism") return builtBy(session.buildingOwners, playerId).length >= 2;
  return true;
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
const KOSMODROM_RESOURCES: ResourceId[] = ["hydrocarbons", "rareEarth", "metalOre", "uranium"];

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
    reporter.step({ action: "chooseCommunismCity", payload, targetKind: "city", targetCityId: best.id, label: `Выбрал город #${best.id} доп. источником ресурсов Коммунизма — под Космодром.` });
  }
}

/** Космодром — по прямому запросу «высший приоритет строительство деталей корабля»: пробуется КАЖДЫЙ
 * заход цикла розыгрыша, раньше любой карты (см. runAiTurnLogic) — если здание есть и хватает
 * ресурсов/действия, всегда предпочитается любой карте. */
function tryActivateKosmodrom(session: GameSession, playerId: number, reporter: Reporter): boolean {
  if (!isOwnedBy(session.buildingOwners, "kosmodrom", playerId)) return false;
  const result = session.dispatch("activateKosmodrom", playerId, {});
  if (result.ok) {
    reporter.step({
      action: "activateKosmodrom",
      payload: {},
      targetKind: "building",
      targetBuildingId: "kosmodrom",
      label: `Построил деталь корабля (Космодром) — ${result.hint ?? ""}`,
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
 * нужно переломить ход войны, а не по первому попавшемуся. AI никогда не производит новые бомбы сам
 * (activateYadernyiArsenal) — только использует то, что уже накоплено (человеком или предыдущими
 * ходами), не расходуя Уран/Металл на это без отдельного запроса. */
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

function decideUnitCategoryPriority(session: GameSession, playerId: number): UnitCategory[] {
  const priority: UnitCategory[] = [];
  if (
    session.researchedTechs[playerId].has("Мореплавание") &&
    session.units.some((u) => u.playerId === playerId && strandedShipNeed(session, playerId, u))
  ) {
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
  if (hasBorderThreat(session, playerId) && defenseCount < defenseCap) priority.push("defense");

  const totalArmy = myUnits.length;
  const shipCount = myUnits.filter((u) => u.category === "ship").length;
  const myCityCount = session.cities.filter((c) => c.playerId === playerId).length;
  if (!priority.includes("ship") && shipCount < myCityCount && shipCount < totalArmy / 3) priority.push("ship");

  const assaultCount = myUnits.filter((u) => u.category === "assault").length;
  const supportCount = myUnits.filter((u) => u.category === "support").length;
  priority.push(assaultCount <= supportCount ? "assault" : "support");
  priority.push(assaultCount <= supportCount ? "support" : "assault");

  for (const c of CATEGORIES) if (!priority.includes(c)) priority.push(c);
  return priority;
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
 * вызывающий код не должен применять эту проверку к целям-городам. */
function simulateAttackOutcome(session: GameSession, playerId: number, unit: UnitInstance, target: { col: number; row: number }): { targetDied: boolean } | null {
  const defenders = session.units.filter((u) => u.col === target.col && u.row === target.row && u.playerId !== playerId);
  if (!defenders.length) return null;
  const targetUnit = defenders.slice().sort((a, b) => b.hp - a.hp)[0];
  const clone = GameSession.fromJSON(session.id, structuredClone(session.toJSON()));
  const result = clone.dispatch("commandUnit", playerId, { unitId: unit.id, col: target.col, row: target.row });
  if (!result.ok) return null;
  return { targetDied: !clone.units.some((u) => u.id === targetUnit.id) };
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
  let best: { total: number; col: number; row: number } | null = null;
  for (const entry of byRegion.values()) if (!best || entry.total > best.total) best = entry;
  return best;
}

/** «Фронт» для решений о постройке/движении войск — по прямому запросу предпочитает регион реального
 * скопления вражеских войск (см. strongestEnemyForceHex); если противник ещё нигде не показался
 * (война только объявлена, боевых действий не было) — тот же запасной ориентир, что и раньше, самый
 * населённый вражеский город (см. nearestWarTargetHex), чтобы фронт вообще было куда назначить —
 * `total` в этом случае `undefined` («сила противника здесь ещё не известна», см. `marchIsSuicidal`
 * ниже — без известной силы марш не блокируется, ведь оценивать реально не по чему). */
function warFrontHex(session: GameSession, playerId: number): { col: number; row: number; total?: number } | null {
  return strongestEnemyForceHex(session, playerId) ?? nearestWarTargetHex(session, playerId);
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

/** Зеркалит приватный GameSession.isInhabitedRegion — региону нужно ≥3 тайлов суши, иначе город там
 * основать физически нельзя (`foundCity` откажет). */
function isInhabitedRegion(session: GameSession, rc: number, rr: number): boolean {
  let land = 0;
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      if (session.isLandTile(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy)) land++;
    }
  }
  return land >= 3;
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
    ({ rc, rr }) => !session.cities.some((c) => c.regionCol === rc && c.regionRow === rr) && isInhabitedRegion(session, rc, rr) && regionHasFoundableTile(session, rc, rr)
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
 * всё равно откажет мягко. */
function decideAndIssueUnitOrder(session: GameSession, playerId: number, unit: UnitInstance, reporter: Reporter) {
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
          label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) прервал марш и отступает в город #${home.id} — он сейчас без охраны.`,
        });
        return;
      }
    }
  }

  if (unit.moveOrder || session.outOfMoveThisCycle.has(unit.id)) return;

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
          label: `Отвёл юнита #${unit.id} (${CATEGORY_META[unit.category].label}) домой в город #${home.id} — мир с игроком ${foreignOwner}.`,
        });
      }
      return;
    }
  }

  const candidates = attackCandidatesFor(session, playerId, unit)
    .slice()
    .sort((a, b) => b.score - a.score);
  for (const cand of candidates) {
    // По прямому запросу — живой баг-репорт: «копейщику не хватит сил выбить воина, атака не имеет
    // смысла, пока не наберётся сил поддержки или для добивания» — атакуем юнита (не город, см.
    // simulateAttackOutcome) только если ЭТОТ конкретный удар реально его убьёт; иначе бой всё равно
    // закончится встречным контрударом по правилам GameSession.resolveCombat (defender.hp>0 → всегда
    // отвечает), и бессмысленный размен не приближает победу — юнит пробует следующего кандидата, а
    // если ни один не смертелен, идёт дальше по приоритету (марш к фронту/оборона) вместо атаки в лоб.
    if (!cand.isCity) {
      const outcome = simulateAttackOutcome(session, playerId, unit, cand);
      if (outcome && !outcome.targetDied) continue;
    }
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
        label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) атакует ${cand.isCity ? "город" : "юнита"} на (${cand.col},${cand.row}).`,
      });
      return;
    }
  }

  // Угроза ИМЕННО в регионе, где сейчас стоит этот юнит (не глобальная сводка по всей партии, см.
  // isFrontRegion) — по прямому запросу: «если нет превосходства сил, нужно перебрасывать туда силы
  // других городов, если бюджет позволяет». Раньше здесь стояла ГЛОБАЛЬНАЯ hasBorderThreat — юнит в
  // мирном тыловом городе, пока где-то на ДРУГОМ краю партии шла война, ошибочно считался «на
  // границе» и просто вставал в оборону НА МЕСТЕ, вместо марша к фронту, хотя никакой угрозы там, где
  // он стоит, не было. Теперь оборона на месте — только когда угроза реально В ЭТОМ регионе; иначе
  // юнит идёт маршем к фронту наравне со всеми остальными — это и есть переброска резервов из тыла.
  const ownRegionThreatened = isFrontRegion(session, playerId, region.rc, region.rr);
  const front = warFrontHex(session, playerId);
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
          label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) выдвигается к фронту у (${front.col},${front.row}).`,
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

function runMilitaryOrders(session: GameSession, playerId: number, reporter: Reporter) {
  const myUnits = session.units.filter((u) => u.playerId === playerId);
  const sorted = myUnits.slice().sort((a, b) => (UNIT_ORDER_PRIORITY[a.category] ?? 9) - (UNIT_ORDER_PRIORITY[b.category] ?? 9));
  for (const unit of sorted) decideAndIssueUnitOrder(session, playerId, unit, reporter);
}

// === Обязательная передача карты (mustHandoff) — отдаёт наименее полезную ======================

const CARD_KEEP_PRIORITY: Record<string, number> = {
  catastrophe: 0,
  tradeRoute: 1,
  routeRight: 1,
  forestGrowth: 2,
  population: 2,
  worker: 3,
  trader: 3,
  taxes: 3,
  mobilization: 3,
  warrior: 4,
  builder: 4,
  settler: 4,
  scientist: 5,
};

/** Есть ли у игрока уже действующая торговая сеть (хотя бы 1 свой город соединён маршрутом хотя бы с
 * одним другим городом) — по прямому запросу («Торговый путь важнее Торговца, пока маршрутов нет —
 * торговцу нечем пользоваться; когда маршруты уже есть, разумнее отдать Торговый путь и использовать
 * Торговца, задействуя уже построенную сеть»). Переиспользует ту же BFS, что и valueOfTradeUnion. */
function hasTradeNetwork(session: GameSession, playerId: number): boolean {
  return myCities(session, playerId).some((c) => tradeNetworkCityIds(session, c.id).size > 1);
}

/** «Торговый путь»/«Право прокладки маршрута» против «Торговца» — приоритет хранения между ними
 * ЗАВИСИТ от того, есть ли уже сеть (см. hasTradeNetwork), а не фиксирован статичной таблицей выше:
 * сети ещё нет — «Торговый путь» ценнее «Налогов»/«Строителя» (уровень 4, как «Воин»/«Поселенец») —
 * его есть смысл сохранить, чтобы построить первую сеть, а «Торговец» пока бесполезен (уровень 1,
 * первый кандидат на передачу среди «обычных» карт); сеть уже есть — наоборот, «Торговый путь» может
 * подождать (уровень 1), а «Торговец» стоит сохранить, чтобы получать доход с уже готовой сети
 * (уровень 4). Это НЕ отменяет CARD_KEEP_PRIORITY для остальных карт — «Катастрофа»/неиграбельное
 * событие/«Рост леса»/«Население» по-прежнему уходят раньше обоих в любом случае (по прямому
 * запросу — «естественно, если дошло до сброса ТАКИХ важных карт и нет карт похуже»). */
function cardKeepValue(session: GameSession, playerId: number, cardId: string): number {
  if (cardId === "tradeRoute" || cardId === "routeRight") return hasTradeNetwork(session, playerId) ? 1 : 4;
  if (cardId === "trader") return hasTradeNetwork(session, playerId) ? 4 : 1;
  return CARD_KEEP_PRIORITY[cardId] ?? 3;
}

/** Карта категории «событие» (по прямому запросу — «избавиться от карт событий, которые не может
 * разыграть в этом ходу за счёт запасов на складе») — грубая, но дешёвая (без реального dispatch,
 * который во время mustHandoff всё равно ничего кроме handoffCard не пропустит) прикидка «хватит ли
 * склада»: только warehouse, без доступа к региону/рынку — реальный розыгрыш может оказаться чуть
 * удачливее этой оценки, это ожидаемо консервативное приближение, не точный повтор planFoodSpend. */
function looksUnplayableThisTurn(session: GameSession, playerId: number, card: CardDef): boolean {
  const warehouse = session.warehouse[playerId] ?? {};
  if (card.id === "mobilization") return session.money[playerId] < 20;
  if (card.id === "forestGrowth") {
    const foodTotal = Object.entries(warehouse).reduce((sum, [id, qty]) => sum + (RESOURCE_CATEGORY.get(id as ResourceId) === "food" ? qty : 0), 0);
    return foodTotal < 2;
  }
  if (card.id === "population") {
    const smallestPop = Math.min(...myCities(session, playerId).map((c) => c.population));
    if (!isFinite(smallestPop)) return false;
    const foodTypes = new Set(Object.entries(warehouse).filter(([id, qty]) => qty > 0 && RESOURCE_CATEGORY.get(id as ResourceId) === "food").map(([id]) => id));
    return foodTypes.size < smallestPop;
  }
  // По прямому запросу — живой баг-репорт: «зачем передавать фиолетовому Рабочего — это ценная
  // карта, которую можно сыграть» — «Рабочий» не «событие» (kind: "action"), поэтому раньше вообще
  // не попадал под эту проверку и всегда оценивался только по статичной таблице (`worker: 3`),
  // независимо от того, есть ли ему что реально собрать прямо сейчас. Тот же критерий «стоит ли
  // собирать», что уже использует сам розыгрыш «Рабочего» (§41/§43, `harvestableResourcesFor`/
  // `isWorthCollecting`) — если ни в одном своём городе нечего добыть из того, что действительно
  // нужно (еда — всегда, остальное — пока не избыток), карта реально бесполезна прямо сейчас.
  if (card.id === "worker") {
    return !myCities(session, playerId).some((c) => session.harvestableResourcesFor(playerId, c.id).some((r) => isWorthCollecting(session, playerId, r)));
  }
  return false;
}

/** Кандидаты на передачу, В ПОРЯДКЕ предпочтения — «сосед, у которого больше всего войск в видимой
 * области» (по прямому запросу; в этой игре нет тумана войны — юниты видны всем всегда, см.
 * СПРАВОЧНИК §15.1, так что «видимая область» это просто вся партия); откатывается на прежнее
 * правило («у кого меньше карт в руке»), если соседей по границе регионов ещё нет (самое начало
 * партии). Возвращает ВЕСЬ отсортированный список, не только первого — по прямому запросу, живой
 * баг-репорт («жёлтый вообще не играет карт») — если единственный кандидат оказывается ИМЕННО тем,
 * кто когда-то дал выбранную карту (сервер честно отказывает возвращать карту туда же, откуда она
 * пришла — см. GameSession.handoffCard), нужен запасной вариант, а не тупик. */
function handoffTargetsInOrder(session: GameSession, playerId: number) {
  const neighbors = neighborPlayerIds(session, playerId);
  // Выбывший (см. GameSession.eliminatedPlayers) игрок — не кандидат: у него уже нет городов, так что
  // per-city neighborPlayerIds его и так никогда не вернёт, но запасной путь ниже (нет соседей вовсе)
  // перебирает ВСЕХ игроков без разбора — явная проверка нужна именно там (по прямому запросу: «нужно
  // убрать после смерти игрока из выбора, кому передавать карту»; сервер и так откажет, см.
  // handoffCard, но без этой проверки бот тратил бы попытку на заведомый отказ).
  const alive = (p: { id: number }) => !session.eliminatedPlayers.has(p.id);
  const base = neighbors.length
    ? session.players.filter((p) => neighbors.includes(p.id) && alive(p)).sort((a, b) => countUnitsOf(session, b.id) - countUnitsOf(session, a.id))
    : session.players.filter((p) => p.id !== playerId && alive(p)).sort((a, b) => session.hands[a.id].length - session.hands[b.id].length);
  // По прямому запросу дословно — «передавать карты негативные или бесполезные логичнее врагу,
  // замедляя его, и только если таких нет — передавать другим»: враг (сейчас идёт война) — ПЕРВЫЙ
  // кандидат на передачу, впереди всех остальных; сортировка стабильна (Array.prototype.sort,
  // ES2019+), так что прежний порядок ВНУТРИ каждой из двух групп (война/не война) не теряется.
  return base.slice().sort((a, b) => (session.relationOf(playerId, a.id).war ? 0 : 1) - (session.relationOf(playerId, b.id).war ? 0 : 1));
}

/** Общий алгоритм «оценка бесполезных карт в руке» для обязательной передачи — по прямому запросу
 * дословно (живой баг-репорт: «зачем передавать фиолетовому Рабочего — это ценная карта, которую
 * можно сыграть, в то время как у него другие карты висят в руке, которых ему не сыграть вообще; это
 * ошибка логики в оценке, нужен алгоритм, решающий именно эту задачу»). Порядок значимости:
 * 1. «Катастрофа» — всегда −2, безусловно (см. ниже).
 * 2. Неиграбельная ПРЯМО СЕЙЧАС карта события ИЛИ «Рабочий», которому реально нечего добыть
 *    (`looksUnplayableThisTurn`, теперь покрывает и «Рабочего» тоже) — −1.
 * 3. Повторная (2-я и далее) копия ОДНОГО И ТОГО ЖЕ id в руке — между −1 и 1, упорядочена ВНУТРИ
 *    себя по той же статичной таблице (`cardKeepValue`, ниже приоритет — раньше уходит с рук): если
 *    карта уже есть, лишний экземпляр почти всегда избыточен («на руках сразу несколько «Строителей»,
 *    а разыграть за ход получится один») — это и есть тот самый общий признак «бесполезности»,
 *    который раньше нигде не учитывался, из-за чего единственный ценный «Рабочий» мог уйти впереди
 *    явно лишних дублей. По прямому запросу (живой баг-репорт: «у жёлтого есть 2 карты «Рост леса» —
 *    менее важные, чем «Рабочий», нелогично отдавать «Рабочего»») — если ОБА дубля-кандидата
 *    (например, лишний «Рабочий» И лишний «Рост леса») играбельны прямо сейчас, раньше они оба
 *    получали ОДНО и то же значение 0 и различались только порядком в руке (случайно, не по смыслу);
 *    теперь дубль карты с более низким приоритетом хранения («Рост леса», 2) уходит раньше дубля
 *    карты с более высоким («Рабочий», 3), а не наоборот.
 * 4. Иначе — обычная статичная таблица ценности хранения (`cardKeepValue`, 1-5).
 * Так «ценная и играбельная прямо сейчас» карта (пункт 4, значение ≥1) никогда не обгонит ни
 * неиграбельную (−1), ни лишнюю копию чего-то ещё (пункт 3) — именно то, чего не хватало раньше. */
function doMandatoryHandoff(session: GameSession, playerId: number, reporter: Reporter) {
  const hand = session.hands[playerId];
  const candidates: { slot: number; cardId: string; value: number }[] = [];
  const seenCardIds = new Set<string>();
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (!card || card.freeMonarchy) continue;
    const isDuplicate = seenCardIds.has(card.id);
    seenCardIds.add(card.id);
    // «Катастрофа» — ВСЕГДА первый кандидат на передачу, даже раньше карты события, которую нечем
    // сыграть в этот ход (по прямому запросу — живой баг-репорт: «планирует отдать Мобилизацию, но
    // она не такая опасная, как Катастрофа, логичнее отдать её»): передача — единственный БЕЗОПАСНЫЙ
    // способ избавиться от «Катастрофы» вовсе без последствий (см. §15.4 — она больше не разыгрывается
    // активно именно поэтому); просто «неиграбельная в этот ход» карта (например, «Мобилизация» без
    // денег) не так опасна — она успешно уйдёт с рук чуть позже, без всякого эффекта.
    const value =
      card.id === "catastrophe"
        ? -2
        : (card.kind === "event" || card.id === "worker") && looksUnplayableThisTurn(session, playerId, card)
          ? -1 // Неиграбельная в этот ход карта события (или бесполезный «Рабочий») — см. looksUnplayableThisTurn.
          : isDuplicate
            ? -1 + cardKeepValue(session, playerId, card.id) / 10 // Лишняя копия — см. доку функции выше, упорядочена по важности типа.
            : cardKeepValue(session, playerId, card.id);
    candidates.push({ slot: i, cardId: card.id, value });
  }
  if (!candidates.length) return; // только freeMonarchy-карты в руке — сервер сам не должен был это требовать
  candidates.sort((a, b) => a.value - b.value);
  const targets = handoffTargetsInOrder(session, playerId);
  if (!targets.length) return;

  // По прямому запросу — живой баг-репорт («жёлтый на руках 10 карт с actionsLeft=3, но вообще не
  // играет карт»): раньше здесь бралась ТОЛЬКО лучшая карта и ТОЛЬКО первый (сильнейший) сосед — если
  // ИМЕННО эта пара оказывалась запрещённой (сервер не даёт вернуть карту тому, кто её когда-то дал,
  // см. GameSession.handoffCard `receivedFrom`), функция просто молча выходила, `mustHandoff` не
  // снимался, а внешний цикл (runAiTurnLogic) заходил на СЛЕДУЮЩУЮ итерацию с АБСОЛЮТНО тем же
  // состоянием — то есть выбирал ТУ ЖЕ пару и снова получал отказ, так по кругу все 80 попыток
  // guard'а, ни разу не добираясь до розыгрыша карт вообще. Теперь перебираются все пары карта×цель
  // в порядке убывания предпочтения (лучшая карта сначала, среди её целей — сильнейший сосед
  // сначала), пропуская только заведомо запрещённые (тот же `target.id === card.receivedFrom`, без
  // лишнего дорогого dispatch на заведомый провал), и останавливаются на первой реально успешной.
  for (const cand of candidates) {
    const card = hand[cand.slot];
    for (const target of targets) {
      if (card.receivedFrom === target.id) continue;
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
        return;
      }
    }
  }
  // Совсем ничего не подошло (теоретический край — например, единственный сосед оказался дарителем
  // КАЖДОЙ карты в руке разом) — mustHandoff останется висеть до следующего конца хода, как и раньше
  // в этом крайнем случае; guard в runAiTurnLogic не даёт зациклиться бесконечно.
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

/** Полный порядок целей бота — по прямому запросу дословно:
 * 1. Экспансия — занятие свободных территорий («Поселенец», основание).
 * 2. Безопасность — паритет сил, если сосед сильнее более чем вдвое, ИЛИ идёт война и враг уже у
 *    границы/города (по прямому запросу, живой баг-репорт — «идёт война, противник уже у города,
 *    нужно строить воинов, приоритет должен смещаться на воинов»; раньше учитывалось только общее
 *    соотношение сил по всей партии, не факт реальной угрозы конкретному городу) — «Воин»,
 *    оборонительно. Идёт ЛЮБАЯ война (не только под угрозой прямо сейчас) — сразу следом «Налоги»
 *    («если игрок в войне, сбор денег нужно поднять в приоритетах выше, сразу после создания солдат»,
 *    по прямому запросу — армия требует денег на содержание и постройку, военный бюджет важнее
 *    обычной экономики).
 * 3. Разгрузка руки, если карт уже больше 5 — играть БЕЗОПАСНЫЕ карты событий/остатков технологий
 *    («Рост леса», «Торговый путь», «Право прокладки маршрута», «Мобилизация» — если по деньгам
 *    доступна), пока получается, чтобы не разбухать дальше к вынужденному сбросу руки (ТЗ 2.3.1) при
 *    8+ картах. «Катастрофа» сюда НЕ входит (живой баг-репорт — «планирует отдать Мобилизацию, но она
 *    не такая опасная, как Катастрофа, логичнее отдать её»): активно РАЗЫГРЫВАТЬ «Катастрофу» самому
 *    себе — не «избавление», а гарантированный негативный эффект (см. GameSession.applyCatastropheLoss
 *    — может стереть целый город) — единственный по-настоящему безопасный способ от неё избавиться —
 *    передать её другому игроку при вынужденной передаче (`doMandatoryHandoff` теперь всегда выбирает
 *    её первой, см. cardKeepValue), а не играть.
 * 4. Рост населения, чтобы извлекать больше ресурсов («Население»/«Поселенец» — рост, если экспансия
 *    (цель 1) недоступна).
 * 5. Наука и новые открытия («Учёный»).
 * 6. Торговые пути («Торговый путь»/«Право прокладки маршрута»).
 * 7. Строительство зданий («Строитель»).
 * 8. Доход — налоги (если ещё не поднялись в приоритет целью 2) или торговцы.
 * 9. Военное превосходство для захвата, если расширяться больше некуда («Воин», наступательно —
 *    та же карта, что и в цели 2, но по другой причине; не дублируется, если уже добавлена там).
 * 10. Извлечение ресурсов для разнообразия склада («Рабочий») — САМЫЙ низкий приоритет: «рабочий
 *     собирает ресурс ПОД ЗАДАЧУ, а не просто ресурс лишь бы собрать» — как отдельная, самостоятельная
 *     цель играется, только если цели 1-9 сейчас недостижимы; как СРЕДСТВО для целей 1/4/5/7/9 (не
 *     хватило ресурсов на «Поселенца»/«Население»/«Учёного»/«Строителя»/«Воина») он по-прежнему
 *     пробуется куда раньше, в тот же заход, что и раньше — см. pickAndPlayNextCard ниже. */
function masterCardPriorityFor(session: GameSession, playerId: number): string[] {
  const priority: string[] = [];
  const canExpand = unclaimedNearbyRegions(session, playerId).length > 0;
  const atWar = isAtWar(session, playerId);
  const handOverloaded = session.hands[playerId].length > 5;

  // По прямому запросу — живой баг-репорт: «„Население“ пойдёт в сброс с негативным эффектом (−1
  // население ВСЕХ городов, см. cards.ts), но AI её не разыгрывает, хотя может сыграть даже без
  // „Рабочего“» — раньше «Население» не входило в цель 3 вовсе (было упущено при её вводе), а даже
  // после исправления этого само по себе не решило бы: «Поселенец» (цель 1) идёт ПЕРВЫМ в списке, и
  // его СОБСТВЕННЫЙ фолбэк на рост населения (см. tryFoundOrGrowCity) — та же самая механика, что и у
  // «Населения», за тот же город и тот же пищевой доступ — успевал «съесть» единственную доступную
  // возможность роста раньше, чем очередь вообще доходила до «Населения» (проверено на живой партии:
  // «Поселенец» вырастил город #12 до предела вместимости первым же действием, «Население» после
  // этого не находило уже ни одного города с местом для роста). Поэтому здесь, а не только в цели 3,
  // «Население» при перегруженной руке пробуется ПЕРВЫМ из всех — раньше даже «Поселенца» — если
  // карта вообще есть в руке: у него есть реальная цена невезения (штраф на вынужденный сброс), у
  // рядового хода «Поселенца» ради роста населения (не основания!) — нет.
  if (handOverloaded && session.hands[playerId].some((c) => c?.id === "population")) priority.push("population");
  if (canExpand) priority.push("settler"); // 1. Экспансия
  if (needsForceParity(session, playerId) || (atWar && hasBorderThreat(session, playerId))) priority.push("warrior"); // 2. Безопасность
  if (atWar) priority.push("taxes"); // 2. Военный бюджет — сразу после солдат, пока идёт война
  if (handOverloaded) {
    // 3. Разгрузка руки — БЕЗОПАСНЫЕ карты событий/остатков; «Катастрофу» сюда намеренно не берём.
    for (const id of ["tradeRoute", "mobilization", "forestGrowth", "routeRight"]) priority.push(id);
  }
  if (!priority.includes("population")) priority.push("population"); // 4. Рост населения (не дублируется, если уже поднят выше)
  if (!canExpand) priority.push("settler"); // 4. (та же цель — рост, раз основать уже негде)
  priority.push("scientist"); // 5. Наука
  for (const id of ["tradeRoute", "routeRight"]) if (!priority.includes(id)) priority.push(id); // 6. Торговые пути (не дублируются, если уже подняты целью 3)
  priority.push("builder"); // 7. Строительство
  if (!priority.includes("taxes")) priority.push("taxes"); // 8. Доход (не дублируется, если уже поднят целью 2)
  priority.push("trader");
  if (!canExpand && !priority.includes("warrior")) priority.push("warrior"); // 9. Военное превосходство
  priority.push("worker"); // 10. Разнообразие склада — самый низкий приоритет

  return priority;
}

/** Разыгрывает первую карту указанного id, для которой найдётся играбельный слот в руке (в руке
 * может быть несколько копий одной и той же карты) — тот же tryPlayCardSlot, просто перебор слотов
 * идёт СНАЧАЛА по нужному id, а не по позиции в руке. */
/** Среди НЕСКОЛЬКИХ слотов руки с одним и тем же id — обычная (настоящая, из колоды) карта пробуется
 * РАНЬШЕ бесплатной (`freeMonarchy`/`freeFascism`, по прямому запросу — живой баг-репорт: «зелёный
 * играет Рабочего, который даётся Монархией, хотя есть обычные Рабочие — обычные в приоритете, чтобы
 * снизить число карт в руке»): бесплатная карта, СЫГРАННАЯ или нет, восстанавливается заново каждый
 * ЦИКЛ (`GameSession.grantMonarchyWorkerCards`/`grantFascismWarriorCard` — ровно 1 штука на игрока,
 * пока действует парадигма) и наравне с обычными считается в лимит руки (`handCountedSize`) — то есть
 * сама по себе НЕ помогает надолго снизить число карт: разыгранная сейчас, она просто вернётся на
 * следующем цикле. Настоящая же карта, будучи разыграна, пропадает НАВСЕГДА — это и есть реальный
 * прогресс к тому, чтобы рука не переполнялась (см. mustHandoff/resolveHandOverflowDiscard). */
function tryPlayCardId(session: GameSession, playerId: number, cardId: string, reporter: Reporter): boolean {
  const hand = session.hands[playerId];
  const isFree = (c: CardDef) => c.freeMonarchy || c.freeFascism;
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
 * («Поселенец», «Население», «Учёный», «Строитель», «Воин») — тут же, тем же заходом, пробует
 * «Рабочего» вместо спуска ниже по списку («Рабочий — средство для цели, а не самоцель», по прямому
 * запросу: единственная причина вообще играть его ВНЕ собственной, самой низкой цели 10 — обслужить
 * цель, которой прямо сейчас не хватило ресурсов). Для «Поселенца» это даёт саму комбинацию «сначала
 * Рабочий за пищевым ресурсом, потом Поселенец» — на СЛЕДУЮЩЕМ заходе того же хода «Поселенец» снова
 * наверху приоритета и, если ресурса теперь хватает, успешно основывает город. Если ничего из
 * приоритета не сыграло — играет что получится из ОСТАЛЬНЫХ карт руки в случайном порядке (по
 * прямому запросу это и есть цель 10 — «Рабочий» как самостоятельная цель тоже только отсюда). */
const RESOURCE_HUNGRY_CARDS = new Set(["scientist", "builder", "settler", "population", "warrior", "tradeRoute"]);
/** Из RESOURCE_HUNGRY_CARDS — только эти двум реально не хватает именно ЕДЫ (основание/рост города
 * прямо требуют категорию "food" в стоимости, см. GameSession) — используется и приоритетом выбора
 * ресурса Рабочим (ниже), и ограничением объёма сбора «про запас под эту цель» (см. foodGrowthGap). */
const FOOD_TARGET_CARDS = new Set(["settler", "population"]);

/** «Строитель» — единственная карта из RESOURCE_HUNGRY_CARDS, которая может провалиться НЕ из-за
 * нехватки ресурсов вовсе: если ни одно ещё не построенное здание сейчас не открыто технологией
 * (§5), а запасной вариант — вырубка леса — намеренно пропущен из-за избытка дерева на складе (§41,
 * `isWorthCollecting`), «Рабочий»-фолбэк ниже НИЧЕМ не поможет — собирать ему было бы нечего под
 * задачу (живой баг-репорт: «собирает еду для Строителя, хотя еды уже достаточно» — настоящая
 * причина провала была не в еде, а в этом гейте, «Рабочий» просто не разбирал причину и всё равно
 * пытался). Возвращает true, только если хотя бы одно ещё не построенное здание технологически
 * доступно ПРЯМО СЕЙЧАС (значит, дело действительно может быть в ресурсах на него) — либо вырубка
 * леса всё ещё имеет смысл (дерева не избыток). */
function builderCouldUseWorker(session: GameSession, playerId: number): boolean {
  const techReady = buildingPriorityOrder(session, playerId).some(
    (b) => !isOwnedBy(session.buildingOwners, b.id, playerId) && (b.tech === null || session.researchedTechs[playerId].has(b.tech))
  );
  return techReady || isWorthCollecting(session, playerId, "wood");
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

/** Сколько ещё РАЗНЫХ пищевых видов реально не хватает, чтобы «Население»/«Поселенец» (рост) стали
 * играбельны у ближайшего годного города (тот же порядок цели, что и сам рост — тир региона, потом
 * наименьшее население, см. tryGrowAnyCity) — по прямому запросу, живой баг-репорт: «зелёный собирает
 * много разных пищевых ресурсов для карты «Население», явно больше, чем требуется — часть уже есть на
 * складе, куда будет применяться карта; лишний Рабочий лучше сыграть на другую карту или собрать
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

function pickAndPlayNextCard(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const hand = session.hands[playerId];
  const priority = masterCardPriorityFor(session, playerId);
  for (const cardId of priority) {
    if (!hand.some((c) => c?.id === cardId)) continue;
    if (tryPlayCardId(session, playerId, cardId, reporter)) return true;
    if (
      RESOURCE_HUNGRY_CARDS.has(cardId) &&
      (cardId !== "builder" || builderCouldUseWorker(session, playerId)) &&
      (cardId !== "tradeRoute" || tradeRouteCouldUseWorker(session, playerId)) &&
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
  const rest = [...new Set(hand.filter((c): c is CardDef => !!c && !priority.includes(c.id)).map((c) => c.id))];
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const cardId of rest) {
    if (tryPlayCardId(session, playerId, cardId, reporter)) return true;
  }
  return false;
}

// === Розыгрыш одной карты из руки — диспетчер по card.id ========================================

function tryPlayCardSlot(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  switch (cardId) {
    case "population":
      return tryGrowAnyCity(session, playerId, slotIndex, cardId, reporter);
    case "settler":
      return tryFoundOrGrowCity(session, playerId, slotIndex, cardId, reporter);
    case "warrior":
      return tryBuildUnit(session, playerId, slotIndex, cardId, reporter);
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
    case "mobilization":
      return tryMobilize(session, playerId, slotIndex, cardId, reporter);
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
 * (ничего из вышеперечисленного) — используется картой «Население» ниже. */
function cityResourceTier(session: GameSession, city: { regionCol: number; regionRow: number }): number {
  const categories = new Set(session.resourcesInRegion(city.regionCol, city.regionRow).map((r) => RESOURCE_CATEGORY.get(r)));
  if (categories.has("strategic")) return 0;
  if (categories.has("food")) return 1;
  if (categories.has("trade")) return 2;
  return 3;
}

/** Карта «Население» — по прямому запросу «распределять равномерно население, поднимая в первую
 * очередь там, где стратегические ресурсы, потом пищевые, потом торговые»: сортировка по тиру
 * ресурса региона (см. cityResourceTier), а внутри тира — по возрастанию населения («равномерно»,
 * тот же смысл, что и в прежней версии этой функции, только теперь не единственный критерий). */
function tryGrowAnyCity(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const cities = myCities(session, playerId).sort((a, b) => cityResourceTier(session, a) - cityResourceTier(session, b) || a.population - b.population);
  for (const city of cities) {
    const payload = { slotIndex, cityIds: [city.id] };
    const result = session.dispatch("growCity", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "growCity", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Увеличил население города #${city.id}.${marketSpendNote(result)}` });
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

/** По прямому запросу дословно — приоритет региона под НОВОЕ поселение: «в первую очередь закрывая
 * потребность в металлической руде, потом углеводородах и потом уране и редкоземельных металлах, и
 * уже по остаточному — каких ресурсов не хватает или меньше». Тиры 0-3 — регион содержит один из 4
 * перечисленных ресурсов, в этом порядке; иначе — тир 4+ по возрастанию (меньше = приоритетнее),
 * смещённый на количество уже имеющихся у игрока тайлов самого дефицитного ресурса этого региона
 * («не хватает или меньше» — чем меньше уже есть, тем более приоритетен регион). */
const SETTLER_RESOURCE_GAP_PRIORITY: ResourceId[] = ["metalOre", "hydrocarbons", "uranium", "rareEarth"];
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
  for (const { rc, rr } of candidates) {
    const col = rc * REGION_SIZE_X + Math.floor(REGION_SIZE_X / 2);
    const row = rr * REGION_SIZE_Y + Math.floor(REGION_SIZE_Y / 2);
    const payload = { slotIndex, col, row };
    const result = session.dispatch("foundCity", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "foundCity",
        payload,
        cardSlotIndex: slotIndex,
        cardId,
        targetKind: "hex",
        targetCol: col,
        targetRow: row,
        label: `Основал новое поселение в регионе (${rc},${rr}).${marketSpendNote(result)}`,
      });
      return true;
    }
  }
  return tryGrowAnyCity(session, playerId, slotIndex, cardId, reporter);
}

/** Налоговый доход игрока (см. GameSession.collectTaxes — приближение: `totalPopulationOf ×
 * aiIncomeMultiplier`, продублировано здесь как маленькая approximation-таблица, тем же приёмом,
 * что и everywhere else в этом файле) — используется бюджетной проверкой армии ниже. */
function taxIncomeEstimate(session: GameSession, playerId: number): number {
  const pop = myCities(session, playerId).reduce((sum, c) => sum + c.population, 0);
  const isAI = session.players.find((p) => p.id === playerId)?.isAI;
  return pop * (isAI ? 2 : 1);
}
/** По прямому запросу — «строят воинов только если позволяет бюджет... если армия будет требовать
 * более половины дохода, её лучше не растить»: содержание юнита в GameSession.collectTaxes стоит
 * ровно 1💰 за штуку, независимо от категории/эпохи, так что порог — просто «число юнитов (+ тот,
 * что собираемся построить) не больше половины налогового дохода». Дохода вообще нет (0 или меньше)
 * — тем более не растим. */
function armyWithinTaxBudget(session: GameSession, playerId: number, extraUnits = 1): boolean {
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
        next.push([nc, nr]);
        if (session.unitPassable(unit, nc, nr) && session.canEnterHex(unit, nc, nr, true)) {
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
      label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) выведен из переполненного гарнизона города #${city.id} на защищённый гекс (${dest.col},${dest.row}), чтобы освободить место.`,
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

function tryBuildUnit(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (!armyWithinTaxBudget(session, playerId)) return false;
  const priority = decideUnitCategoryPriority(session, playerId);
  const front = warFrontHex(session, playerId);
  const cities = myCities(session, playerId).slice();
  if (front) cities.sort((a, b) => session.hexDistance(a.col, a.row, front.col, front.row) - session.hexDistance(b.col, b.row, front.col, front.row));
  for (const category of priority) {
    // Только СТАРШАЯ доступная эпоха ЭТОЙ категории — устаревшие (дешёвые) варианты больше не
    // пробуются вовсе, сервер их всё равно отклонит (см. GameSession.buildUnitCard), так что раньше
    // это были просто холостые dispatch-попытки; выше этой эпохи юнит категории и так недостижим
    // (тех.гейт).
    const currentEpoch = bestUnitEpochFor(session, playerId, category);
    const unitsOfCategory = UNITS.filter((u) => u.category === category && u.epoch === currentEpoch);
    for (const city of cities) {
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
            label: `Построил юнита «${unit.id}» (${CATEGORY_META[category].label}) в городе #${city.id}.${marketSpendNote(result)}`,
          });
          return true;
        }
      }
    }
  }
  return false;
}

/** «Отстаёт в войсках» (по прямому запросу, для приоритета Казармы ниже) — своих юнитов меньше, чем
 * у самого сильного из остальных игроков; та же метрика «сила = число юнитов», что и everywhere else
 * в военных решениях бота (см. §22 ЦИВА-ЖУРНАЛ). */
function isBehindInTroops(session: GameSession, playerId: number): boolean {
  const others = session.players.filter((p) => p.id !== playerId).map((p) => countUnitsOf(session, p.id));
  return others.length > 0 && countUnitsOf(session, playerId) < Math.max(...others);
}

/** По прямому запросу дословно — «если есть религия, в первую очередь Храм; потом, если отстаёт в
 * войсках, Казарма; потом Склад; потом Рынок; потом остальные здания в порядке их открытия» (эпоха
 * технологии по возрастанию — ближайшая к «порядку открытия» метрика, которая у нас уже есть).
 * Условные пункты (Храм/Казарма) просто пропускаются, если условие не выполнено — не «откладываются
 * в конец», а не участвуют в приоритете вовсе в этот ход. */
const BUILDER_UNCONDITIONAL_TOP_IDS = ["sklad", "rynok"];
function buildingPriorityOrder(session: GameSession, playerId: number): BuildingDef[] {
  const topIds: string[] = [];
  if (session.playerReligion[playerId]) topIds.push("hram");
  if (isBehindInTroops(session, playerId)) topIds.push("kazarma");
  topIds.push(...BUILDER_UNCONDITIONAL_TOP_IDS);
  const top = topIds.map((id) => BUILDINGS.find((b) => b.id === id)).filter((b): b is BuildingDef => !!b);
  const rest = BUILDINGS.filter((b) => !topIds.includes(b.id)).sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
  return [...top, ...rest];
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
  // targetCount:0, дерево на карте не сеется вовсе, только рубкой) — по прямому запросу («у жёлтого
  // уже много дерева, а он всё ещё добывает — нужно разнообразие»): раз ни одно здание не построилось
  // (в т.ч. из-за нового гейта по технологии, см. §5 — теперь чаще проваливается, чем раньше), не
  // рубим лес просто чтобы что-то сыграть, если дерева на складе и так уже достаточно — см.
  // isWorthCollecting (тот же порог/резон, что и у tryWorkerCollect выше).
  if (!isWorthCollecting(session, playerId, "wood")) return false;
  for (const city of myCities(session, playerId)) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = city.regionCol * REGION_SIZE_X + dx;
        const row = city.regionRow * REGION_SIZE_Y + dy;
        const payload = { slotIndex, col, row };
        const result = session.dispatch("chopForest", playerId, payload);
        if (result.ok) {
          reporter.step({ action: "chopForest", payload, cardSlotIndex: slotIndex, cardId, targetKind: "hex", targetCol: col, targetRow: row, label: `Вырубил лес на (${col},${row}).${marketSpendNote(result)}` });
          return true;
        }
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
  population: "«Население»",
  scientist: "«Учёный»",
  builder: "«Строитель»",
  warrior: "«Воин»",
  tradeRoute: "«Торговый путь»",
};

/** Подпись «зачем» к шагу «Рабочий собрал...» — по прямому запросу («уточни в плане хода, какой
 * именно ресурс собирается рабочим и для какого целевого действия») — играет ли «Рабочий» как
 * СРЕДСТВО для другой карты (см. `forCardId`/CARD_GOAL_LABEL) или как самостоятельная цель 10
 * (разнообразие склада, см. §15.4) — оба случая теперь явно подписываются, а не просто «собрал
 * ресурсы». */
function workerPurposeLabel(forCardId: string | undefined): string {
  if (forCardId) return ` — не хватило ресурса для карты ${CARD_GOAL_LABEL[forCardId] ?? `«${forCardId}»`}`;
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
function prioritizeCitiesForWorker(session: GameSession, playerId: number, cities: City[], forCardId: string | undefined): City[] {
  if (forCardId && FOOD_TARGET_CARDS.has(forCardId)) return cities;
  const needsHydrocarbons = forCardId === "scientist" && needsHydrocarbonsForResearch(session, playerId);
  const needsUranium = forCardId === "scientist" && needsUraniumForResearch(session, playerId);
  if (needsHydrocarbons || needsUranium) {
    const canSupplySpecific = (city: City) =>
      session.harvestableResourcesFor(playerId, city.id).some((r) => (needsHydrocarbons && (r === "hydrocarbons" || r === "electricity")) || (needsUranium && r === "uranium"));
    return cities.slice().sort((a, b) => Number(canSupplySpecific(b)) - Number(canSupplySpecific(a)));
  }
  if (forCardId === "tradeRoute") {
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

/** Рабочий, альтернативное применение — «добыть Редкоземельные из Равнины» (GameSession.mineRareEarth,
 * требует «Индустриализация») — по прямому запросу: «AI использует только тогда, когда есть равнина
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
 * GameSession.mineRareEarth (см. её проверки). Первая подходящая, порядок сканирования тайлов
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
  if (session.researchedTechs[playerId].has("Индустриализация") && needsRareEarthForResearch(session, playerId)) {
    for (const city of myCities(session, playerId)) {
      const spot = findBarePlainsForMining(session, city);
      if (!spot) continue;
      const payload = { slotIndex, col: spot.col, row: spot.row };
      const result = session.dispatch("mineRareEarth", playerId, payload);
      if (result.ok) {
        reporter.step({
          action: "mineRareEarth",
          payload,
          cardSlotIndex: slotIndex,
          cardId,
          targetKind: "hex",
          targetCol: spot.col,
          targetRow: spot.row,
          label: `Рабочий добыл 1 Редкоземельные на (${spot.col},${spot.row}) — равнина опустынена${workerPurposeLabel(forCardId)}.`,
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
        label: `Рабочий собрал ${resourceListLabel(preview)} в городе #${city.id}${workerPurposeLabel(forCardId)}.`,
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
        if (forCardId === "tradeRoute") {
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
          label: `Рабочий собрал ${resourceListLabel(chosen)} в городе #${city.id}${workerPurposeLabel(forCardId)}.`,
        });
        return true;
      }
    }
  }
  return false;
}

function tryTrade(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const city of myCities(session, playerId)) {
    const payload = { slotIndex, cityId: city.id };
    const result = session.dispatch("traderTrade", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "traderTrade", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Торговец сыграл в городе #${city.id}.` });
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

function tryPickRouteCities(session: GameSession, playerId: number, reporter: Reporter) {
  const cities = myCities(session, playerId);
  for (const from of cities) {
    for (const to of session.cities) {
      if (to.id === from.id || !canLayTradeRouteTo(session, playerId, to.playerId)) continue;
      const payload = { fromCityId: from.id, toCityId: to.id };
      const result = session.dispatch("pickRouteCities", playerId, payload);
      if (result.ok) {
        reporter.step({ action: "pickRouteCities", payload, targetKind: "city", targetCityId: to.id, label: `Проложил маршрут между городами #${from.id} и #${to.id}.` });
        return;
      }
    }
  }
}

function tryPlantForest(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const city of myCities(session, playerId)) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = city.regionCol * REGION_SIZE_X + dx;
        const row = city.regionRow * REGION_SIZE_Y + dy;
        const payload = { slotIndex, col, row };
        const result = session.dispatch("plantForest", playerId, payload);
        if (result.ok) {
          reporter.step({ action: "plantForest", payload, cardSlotIndex: slotIndex, cardId, targetKind: "hex", targetCol: col, targetRow: row, label: `Посадил лес на (${col},${row}).${marketSpendNote(result)}` });
          return true;
        }
      }
    }
  }
  return false;
}

/** «Строить торговые сети к соседям» — по прямому запросу: путь к ЧУЖОМУ городу закладывается только
 * если с его владельцем уже действует торговый союз, либо когда ВСЕ свои города уже соединены друг с
 * другом (см. ownCitiesFullyConnected) — тогда расширение сети наружу оправдано. Путь МЕЖДУ своими
 * городами всегда разрешён без ограничений. */
function canLayTradeRouteTo(session: GameSession, playerId: number, toPlayerId: number): boolean {
  if (toPlayerId === playerId) return true;
  if (session.relationOf(playerId, toPlayerId).agreements.has("tradeUnion")) return true;
  return ownCitiesFullyConnected(session, playerId);
}

/** Связаны ли все свои города друг с другом хотя бы одной цепочкой торговых путей — BFS по графу
 * существующих маршрутов (любых, не только между своими городами — путь через чужой город-хаб тоже
 * считается связью). */
function ownCitiesFullyConnected(session: GameSession, playerId: number): boolean {
  const own = myCities(session, playerId);
  if (own.length <= 1) return true;
  const network = tradeNetworkCityIds(session, own[0].id);
  return own.every((c) => network.has(c.id));
}

/** Карта «Торговый путь» во время войны — по прямому запросу («убирать торговые сети врага... если
 * идёт война»): пробует УДАЛИТЬ чей-то существующий маршрут, если его владелец сейчас в состоянии
 * войны с ботом (deleteTradeRoute — «чей угодно маршрут», платящий не обязан им владеть, см.
 * GameSession.deleteTradeRoute); только если удалять нечего/не на что — как раньше, прокладывает
 * новую свою сеть (canLayTradeRouteTo). */
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
      if (to.id === from.id || !canLayTradeRouteTo(session, playerId, to.playerId)) continue;
      const payload = { slotIndex, fromCityId: from.id, toCityId: to.id };
      const result = session.dispatch("layNewTradeRoute", playerId, payload);
      if (result.ok) {
        reporter.step({ action: "layNewTradeRoute", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: to.id, label: `Проложил торговый путь #${from.id} → #${to.id}.` });
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
      if (to.id === from.id || !canLayTradeRouteTo(session, playerId, to.playerId)) continue;
      const payload = { slotIndex, fromCityId: from.id, toCityId: to.id };
      const result = session.dispatch("playRouteRightCard", playerId, payload);
      if (result.ok) {
        reporter.step({ action: "playRouteRightCard", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: to.id, label: `Разыграл «Право прокладки маршрута» между #${from.id} и #${to.id}.` });
        return true;
      }
    }
  }
  return false;
}

function tryTaxes(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const payload = { slotIndex };
  const result = session.dispatch("collectTaxesCard", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "collectTaxesCard", payload, cardSlotIndex: slotIndex, cardId, targetKind: "none", label: `Собрал налоги: ${result.hint ?? ""}` });
    return true;
  }
  return false;
}

function tryCatastrophe(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const payload = { slotIndex };
  const result = session.dispatch("playCatastropheCard", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "playCatastropheCard", payload, cardSlotIndex: slotIndex, cardId, targetKind: "none", label: `Разыграл карту «Катастрофа» (последствия — отдельным шагом).` });
    return true;
  }
  return false;
}

/** Мобилизация даёт неограниченные действия за 10💰 без побочного вреда для сыгравшего (негативная
 * ветка бьёт только по игроку, у которого карту забрали принудительно при переборе руки — не сюда,
 * см. cards.ts) — играем её, только если денег хватает с запасом (после покупки должно остаться
 * ≥10💰), чтобы не спускать в ноль казну ради одного дополнительного круга действий. */
function tryMobilize(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  if (session.money[playerId] < 20 + reservedMoneyForPendingProposals(session, playerId)) return false;
  const payload = { slotIndex };
  const result = session.dispatch("mobilize", playerId, payload);
  if (result.ok) {
    reporter.step({ action: "mobilize", payload, cardSlotIndex: slotIndex, cardId, targetKind: "none", label: `Разыграл «Мобилизацию» — действия этого хода без ограничения.` });
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
 * списку — здесь остались только НЕпищевые нужды, каждая сама по себе. */
const NEEDED_RESOURCES: ResourceId[] = ["wood", "silicates", "metalOre"];
/** По прямому запросу — живой баг-репорт: «синий хочет купить злаки для еды, но на рынке есть
 * овощи [дешевле]» — раньше еда докупалась по ЭТОМУ фиксированному списку id один за другим (злаки
 * первыми), поэтому при пустом складе бот покупал именно злаки, даже когда на бирже был дешевле
 * ЛЮБОЙ другой вид еды — а для любой пищевой нужды (`planFoodSpend`/`isFoodOrJoker`) вид совершенно
 * не важен, только категория "food". Ниже вместо перебора по видам — одна покупка САМОГО ДЕШЁВОГО
 * лота ЛЮБОГО пищевого вида, если на складе нет еды вовсе. */
const FOOD_NEEDED_RESOURCES: ResourceId[] = ["grain", "livestock", "fruit", "vegetables", "fish", "shellfish"];

function marketPass(session: GameSession, playerId: number, reporter: Reporter) {
  const warehouse = session.warehouse[playerId] ?? {};
  for (const [resource, qty] of Object.entries(warehouse) as [ResourceId, number][]) {
    if (!qty || qty <= SURPLUS_KEEP_PER_RESOURCE) continue;
    let toSell = qty - SURPLUS_KEEP_PER_RESOURCE;
    while (toSell > 0) {
      const payload = { resource, price: SELL_PRICE };
      const result = session.dispatch("sellResource", playerId, payload);
      if (!result.ok) break;
      toSell--;
      reporter.step({ action: "sellResource", payload, targetKind: "market", targetResource: resource, label: `Выставил на продажу 1×${resource} за ${SELL_PRICE}💰.` });
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
      const payload = { resource, price: 3 };
      const result = session.dispatch("sellResource", playerId, payload);
      if (!result.ok) break;
      left--;
      reporter.step({ action: "sellResource", payload, targetKind: "market", targetResource: resource, label: `Продал 1×${resource} за 3💰 (превышение лимита склада).` });
    }
    if (left <= 0) break;
  }
}
