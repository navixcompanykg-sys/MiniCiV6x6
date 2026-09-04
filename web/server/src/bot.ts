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
import { GameSession, type Proposal } from "./GameSession";
import { builtBy } from "../../src/game/buildings";
import { BUILDINGS } from "../../src/game/buildings";
import { UNITS } from "../../src/game/units";
import { TECH_TREE } from "../../src/game/techtree";
import { REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H } from "../../src/map/mapDoc";
import type { ResourceId } from "../../src/map/types";

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
function computeAiTurnPlan(session: GameSession, playerId: number): AiPlanStep[] {
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

// === Фаза расстановки (без предпросмотра — нет карт, подсвечивать нечего) ======================

function runAiPlacement(session: GameSession, playerId: number) {
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
    if (session.actionsLeft[playerId] <= 0) break;

    let progressed = false;
    const hand = session.hands[playerId];
    for (let i = 0; i < hand.length; i++) {
      const card = hand[i];
      if (!card) continue;
      if (tryPlayCardSlot(session, playerId, i, card.id, reporter)) {
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }

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

// === Дипломатия — предложения, адресованные боту ================================================

function hasTermKind(p: Proposal, kind: string): boolean {
  return p.terms.some((t) => t.kind === kind);
}
function sumTermAmount(p: Proposal, kind: "demandMoney" | "offerMoney"): number {
  return p.terms.filter((t): t is { kind: "demandMoney" | "offerMoney"; amount: number } => t.kind === kind).reduce((s, t) => s + t.amount, 0);
}

/** Правила приняты по прямому запросу дословно:
 * — «принимает предложения о мире если число его юнитов меньше числа игрока с которым он воюет и
 *   хватает денег на перемирие» (условие «Мир»);
 * — «соглашается на все предложения союзов если игрок готов заплатить ему денег равное числу его
 *   населения» (условие «Соглашение» — Agreement/«союз»). */
function shouldAcceptProposal(session: GameSession, p: Proposal): boolean {
  if (hasTermKind(p, "peace")) {
    const myUnits = session.units.filter((u) => u.playerId === p.to).length;
    const theirUnits = session.units.filter((u) => u.playerId === p.from).length;
    const demandTotal = sumTermAmount(p, "demandMoney");
    if (myUnits < theirUnits && session.money[p.to] >= demandTotal) return true;
  }
  if (hasTermKind(p, "agreement")) {
    const myPop = session.cities.filter((c) => c.playerId === p.to).reduce((s, c) => s + c.population, 0);
    if (sumTermAmount(p, "offerMoney") >= myPop) return true;
  }
  return false;
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

function doMandatoryHandoff(session: GameSession, playerId: number, reporter: Reporter) {
  const hand = session.hands[playerId];
  let bestSlot = -1;
  let bestValue = Infinity;
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (!card || card.freeMonarchy) continue;
    const value = CARD_KEEP_PRIORITY[card.id] ?? 3;
    if (value < bestValue) {
      bestValue = value;
      bestSlot = i;
    }
  }
  if (bestSlot === -1) return; // только freeMonarchy-карты в руке — сервер сам не должен был это требовать
  const cardId = hand[bestSlot].id;
  const others = session.players.filter((p) => p.id !== playerId);
  others.sort((a, b) => session.hands[a.id].length - session.hands[b.id].length);
  const target = others[0];
  if (!target) return;
  const payload = { slotIndex: bestSlot, targetPlayerId: target.id };
  const result = session.dispatch("handoffCard", playerId, payload);
  if (result.ok) {
    reporter.step({
      action: "handoffCard",
      payload,
      cardSlotIndex: bestSlot,
      cardId,
      targetKind: "player",
      targetPlayerId: target.id,
      label: `Передал карту «${cardId}» игроку ${target.name}.`,
    });
  }
}

// === Розыгрыш одной карты из руки — диспетчер по card.id ========================================

function tryPlayCardSlot(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  switch (cardId) {
    case "settler":
    case "population":
      return tryGrowAnyCity(session, playerId, slotIndex, cardId, reporter);
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

function tryGrowAnyCity(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const cities = myCities(session, playerId).sort((a, b) => a.population - b.population);
  for (const city of cities) {
    const payload = { slotIndex, cityIds: [city.id] };
    const result = session.dispatch("growCity", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "growCity", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Увеличил население города #${city.id}.` });
      return true;
    }
  }
  return false;
}

function tryBuildUnit(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const city of myCities(session, playerId)) {
    for (const unit of UNITS) {
      const payload = { slotIndex, cityId: city.id, unitId: unit.id };
      const result = session.dispatch("buildUnitCard", playerId, payload);
      if (result.ok) {
        reporter.step({ action: "buildUnitCard", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Построил юнита «${unit.id}» в городе #${city.id}.` });
        return true;
      }
    }
  }
  return false;
}

function tryBuilder(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const b of BUILDINGS) {
    const payload = { slotIndex, buildingId: b.id };
    const result = session.dispatch("buildBuilding", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "buildBuilding", payload, cardSlotIndex: slotIndex, cardId, targetKind: "building", targetBuildingId: b.id, label: `Построил здание «${b.id}».` });
      return true;
    }
  }
  for (const city of myCities(session, playerId)) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = city.regionCol * REGION_SIZE_X + dx;
        const row = city.regionRow * REGION_SIZE_Y + dy;
        const payload = { slotIndex, col, row };
        const result = session.dispatch("chopForest", playerId, payload);
        if (result.ok) {
          reporter.step({ action: "chopForest", payload, cardSlotIndex: slotIndex, cardId, targetKind: "hex", targetCol: col, targetRow: row, label: `Вырубил лес на (${col},${row}).` });
          return true;
        }
      }
    }
  }
  return false;
}

function tryWorkerCollect(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const city of myCities(session, playerId)) {
    const payload: Record<string, unknown> = { slotIndex, cityId: city.id };
    let result = session.dispatch("workerCollect", playerId, payload);
    if (result.ok) {
      reporter.step({ action: "workerCollect", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Рабочий собрал ресурсы в городе #${city.id}.` });
      return true;
    }
    if (result.needsResourceChoice) {
      const { budget, options } = result.needsResourceChoice;
      const payload2 = { slotIndex, cityId: city.id, chosenTypes: options.slice(0, budget) };
      result = session.dispatch("workerCollect", playerId, payload2);
      if (result.ok) {
        reporter.step({ action: "workerCollect", payload: payload2, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Рабочий собрал выбранные ресурсы в городе #${city.id}.` });
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

function tryResearch(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const researched = session.researchedTechs[playerId];
  for (const tech of TECH_TREE) {
    if (researched.has(tech.id)) continue;
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
      if (to.id === from.id) continue;
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
          reporter.step({ action: "plantForest", payload, cardSlotIndex: slotIndex, cardId, targetKind: "hex", targetCol: col, targetRow: row, label: `Посадил лес на (${col},${row}).` });
          return true;
        }
      }
    }
  }
  return false;
}

function tryLayTradeRoute(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const from of myCities(session, playerId)) {
    for (const to of session.cities) {
      if (to.id === from.id) continue;
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

function tryRouteRight(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  for (const from of myCities(session, playerId)) {
    for (const to of session.cities) {
      if (to.id === from.id) continue;
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
  if (session.money[playerId] < 20) return false;
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
 * стратегические ресурсы стройки/исследований. */
const NEEDED_RESOURCES: ResourceId[] = ["grain", "livestock", "fruit", "vegetables", "fish", "shellfish", "wood", "silicates", "metalOre"];

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

  for (const resource of NEEDED_RESOURCES) {
    if ((session.warehouse[playerId]?.[resource] ?? 0) > 0) continue;
    const listing = session.market
      .filter((l) => l.kind === "resource" && l.resource === resource && l.sellerId !== playerId)
      .sort((a, b) => a.price - b.price)[0];
    if (!listing) continue;
    if (session.money[playerId] - listing.price < MARKET_MONEY_RESERVE) continue;
    const payload = { listingId: listing.id };
    const result = session.dispatch("buyListing", playerId, payload);
    if (result.ok) reporter.step({ action: "buyListing", payload, targetKind: "market", targetResource: resource, label: `Купил 1×${resource} за ${listing.price}💰 на бирже.` });
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
