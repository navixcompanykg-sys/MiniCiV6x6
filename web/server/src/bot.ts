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
import { GameSession, type Proposal, type ProposalTerm, type UnitInstance, type Paradigm, type Religion } from "./GameSession";
import { builtBy, isOwnedBy } from "../../src/game/buildings";
import { BUILDINGS, type BuildingDef } from "../../src/game/buildings";
import { UNITS, CATEGORIES, CATEGORY_META, statsFor } from "../../src/game/units";
import type { UnitCategory } from "../../src/game/units";
import { TECH_TREE } from "../../src/game/techtree";
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
    if (session.actionsLeft[playerId] <= 0) break;

    if (tryActivateKosmodrom(session, playerId, reporter)) continue;
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
 *   населения» (условие «Соглашение» — Agreement/«союз»);
 * — военный AI (§ считает войну/мир, см. considerWarDeclaration/considerPeaceOffers) вдобавок
 *   «принимает любые встречные предложения которые способен исполнить кроме сдачи городов», когда
 *   сам «в проигрышной позиции» (кончились деньги или перевес сил у противника) — те же условия,
 *   что заставляют его САМОГО просить мира, только с чужой инициативы; `demandCity` — это требование
 *   ОТДАТЬ город (не получить, это `giveCity`), его одного исключаем. */
function shouldAcceptProposal(session: GameSession, p: Proposal): boolean {
  if (hasTermKind(p, "peace")) {
    const myUnits = session.units.filter((u) => u.playerId === p.to).length;
    const theirUnits = session.units.filter((u) => u.playerId === p.from).length;
    const demandTotal = sumTermAmount(p, "demandMoney");
    if (myUnits < theirUnits && session.money[p.to] >= demandTotal) return true;
    const desperate = session.money[p.to] <= 0 || myUnits < theirUnits;
    if (desperate && !p.terms.some((t) => t.kind === "demandCity")) return true;
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

const REGION_NEIGHBOR_OFFSETS: [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Регионы, граничащие со своими (по сетке регионов), но не свои — «приграничные» для решений об
 * обороне/соседях. Не включает диагональные соседи — тот же явный компромисс, что и everywhere else
 * this session, где точная гекс-геометрия не нужна ради простой эвристики. */
function borderRegionsOf(session: GameSession, playerId: number): { rc: number; rr: number }[] {
  const own = ownedRegionsOf(session, playerId);
  const seen = new Set<string>();
  const result: { rc: number; rr: number }[] = [];
  for (const key of own) {
    const [rc, rr] = key.split(",").map(Number);
    for (const [drc, drr] of REGION_NEIGHBOR_OFFSETS) {
      const nrc = rc + drc;
      const nrr = rr + drr;
      if (nrc < 0 || nrc >= REGION_GRID_W || nrr < 0 || nrr >= REGION_GRID_H) continue;
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

const PEACE_TRUCE_DURATION = 6; // «перемирие на 6 ходов» (по прямому запросу)

/** Ищет мира (по прямому запросу): «если кончились деньги» или «если перевес сил перешёл
 * противнику» — предлагает все деньги ИЛИ (если денег нет) самый большой запас склада, за перемирие
 * на 6 циклов. «Достигнув цели — предлагает мир» — цель определяется захватом территории (этап
 * движения войск, ещё не реализован) — пока не проверяется. */
function considerPeaceOffers(session: GameSession, playerId: number, reporter: Reporter) {
  for (const p of session.players) {
    if (p.id === playerId) continue;
    if (!session.relationOf(playerId, p.id).war) continue;
    if (session.pendingProposals.some((pr) => pr.from === playerId && pr.to === p.id)) continue; // уже предложил, ждём ответа
    const myUnits = countUnitsOf(session, playerId);
    const theirUnits = countUnitsOf(session, p.id);
    const myMoney = session.money[playerId];
    const outOfMoney = myMoney <= 0;
    const outmatched = myUnits < theirUnits;
    if (!outOfMoney && !outmatched) continue;

    const terms: ProposalTerm[] = [{ kind: "peace", duration: PEACE_TRUCE_DURATION }];
    if (myMoney > 0) {
      terms.push({ kind: "offerMoney", amount: myMoney });
    } else {
      const stock = (Object.entries(session.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(([, q]) => (q ?? 0) > 0).sort((a, b) => b[1] - a[1]);
      if (stock.length) terms.push({ kind: "giveResource", resource: stock[0][0], qty: stock[0][1] });
    }
    const payload = { to: p.id, terms, ultimatum: false };
    const result = session.dispatch("sendProposal", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "sendProposal",
        payload,
        targetKind: "proposal",
        targetPlayerId: p.id,
        label: `Предложил мир игроку ${p.name} (${outOfMoney ? "кончились деньги" : "перевес сил у противника"}) — перемирие на ${PEACE_TRUCE_DURATION} циклов.`,
      });
    }
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
const RELIGION_CHANGE_COOLDOWN_CYCLES = 6;

/** Может ли игрок ОСНОВАТЬ ещё не основанную религию прямо сейчас (см. GameSession.adoptReligion) —
 * личный первооткрыватель одной из 3 религиозных технологий, ещё ни разу не основавший свою. */
function canFoundOwnReligion(session: GameSession, playerId: number): boolean {
  if (Object.values(session.religionFounder).includes(playerId)) return false;
  return RELIGION_FOUNDING_TECHS.some((t) => session.techDiscoverer[t] === playerId);
}

/** Религия САМОГО СИЛЬНОГО (по числу юнитов) приграничного соседа — «религия соседа, наиболее
 * сильного по армии» (по прямому запросу); атеистов и соседей без религии пропускает — примкнуть к
 * «отсутствию религии» смысла нет. */
function strongestNeighborReligion(session: GameSession, playerId: number): Religion | null {
  const withReligion = neighborPlayerIds(session, playerId)
    .filter((id) => session.playerReligion[id] && session.playerReligion[id] !== "atheism")
    .sort((a, b) => countUnitsOf(session, b) - countUnitsOf(session, a));
  return withReligion.length ? (session.playerReligion[withReligion[0]] as Religion) : null;
}

/** По прямому запросу: своя религия в приоритете, если её можно ОСНОВАТЬ прямо сейчас; иначе —
 * религия сильнейшего по армии соседа. Меняет уже принятую религию не чаще раза в
 * RELIGION_CHANGE_COOLDOWN_CYCLES циклов (самый первый выбор — из «нет религии» — этим не
 * ограничен). */
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
    session.aiReligionLockUntilCycle[playerId] = session.cyclesElapsed + RELIGION_CHANGE_COOLDOWN_CYCLES;
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

/** Приоритет категории юнита для карты «Воин» (по прямому запросу):
 * 1. Оборонительные — если враг копит силы у границы (hasBorderThreat).
 * 2. Флот — 1 на город, но не больше 1/3 от общей армии кораблями (остальное — сухопутные).
 * 3. Штурмовые/Поддержка — в равной пропорции, начиная со Штурмовых.
 * Дальше — все прочие категории как запасной вариант (чтобы карта не блокировалась насмерть, если
 * все приоритетные варианты почему-то недоступны, напр. все города без выхода в море). */
function decideUnitCategoryPriority(session: GameSession, playerId: number): UnitCategory[] {
  const priority: UnitCategory[] = [];
  if (hasBorderThreat(session, playerId)) priority.push("defense");

  const myUnits = session.units.filter((u) => u.playerId === playerId);
  const totalArmy = myUnits.length;
  const shipCount = myUnits.filter((u) => u.category === "ship").length;
  const myCityCount = session.cities.filter((c) => c.playerId === playerId).length;
  if (shipCount < myCityCount && shipCount < totalArmy / 3) priority.push("ship");

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

function nearestOwnCity(session: GameSession, playerId: number, col: number, row: number) {
  const cities = session.cities.filter((c) => c.playerId === playerId);
  if (!cities.length) return null;
  return cities.slice().sort((a, b) => session.hexDistance(col, row, a.col, a.row) - session.hexDistance(col, row, b.col, b.row))[0];
}

/** Приказ одному юниту — по прямому запросу, в таком порядке:
 * 1. Мир с владельцем территории, на которой юнит сейчас стоит (по региону, то же приближение, что
 *    и everywhere в этом файле) — отвести домой, в ближайший свой город («При объявлении мира ВСЕ
 *    военные юниты на территории врага перемещаются в ближайший свой город»).
 * 2. Атака — если в досягаемости есть цель среди тех, с кем сейчас война (см. attackCandidatesFor),
 *    берём с максимальным приоритетом.
 * 3. Марш — если войны с кем-то нет, но ведётся другая война, выдвигаемся к самому ценному фронту.
 * 4. Оборона — если угроза на границе (см. hasBorderThreat) и делать больше нечего, встаём в
 *    «Оборону» на месте.
 * Юнит с уже активным moveOrder или без хода в этом цикле пропускается — новый приказ ему не нужен
 * (см. заголовок секции) либо невозможен, dispatch всё равно откажет мягко. */
function decideAndIssueUnitOrder(session: GameSession, playerId: number, unit: UnitInstance, reporter: Reporter) {
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

  const candidates = attackCandidatesFor(session, playerId, unit);
  if (candidates.length) {
    const best = candidates.slice().sort((a, b) => b.score - a.score)[0];
    const payload = { unitId: unit.id, col: best.col, row: best.row };
    const result = session.dispatch("commandUnit", playerId, payload);
    if (result.ok) {
      reporter.step({
        action: "commandUnit",
        payload,
        sourceUnitId: unit.id,
        sourceCol: unit.col,
        sourceRow: unit.row,
        targetKind: "hex",
        targetCol: best.col,
        targetRow: best.row,
        label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) атакует ${best.isCity ? "город" : "юнита"} на (${best.col},${best.row}).`,
      });
      return;
    }
  }

  const front = nearestWarTargetHex(session, playerId);
  if (front && !(unit.category === "defense" && hasBorderThreat(session, playerId))) {
    // commandUnit К САМОЙ вражеской клетке всегда трактуется как атака (проверяет дальность боя, не
    // прокладывает маршрут) — пока цель ещё далеко, целимся в один из СОСЕДНИХ (пустых/проходимых)
    // гексов: туда сервер честно строит маршрут с автопродолжением по циклам (см. заголовок секции).
    // Пробуем всех до 6 соседей по очереди — какой-то да свободен/проходим.
    for (const [col, row] of hexNeighborsWrapped(front.col, front.row, MAP_WIDTH, MAP_HEIGHT)) {
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
          label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) выдвигается к фронту у города на (${front.col},${front.row}).`,
        });
        return;
      }
    }
  }

  if (hasBorderThreat(session, playerId) && !unit.defending) {
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
        label: `Юнит #${unit.id} (${CATEGORY_META[unit.category].label}) встал в оборону — угроза на границе.`,
      });
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
  return false;
}

/** Цель передачи — «сосед, у которого больше всего войск в видимой области» (по прямому запросу; в
 * этой игре нет тумана войны — юниты видны всем всегда, см. СПРАВОЧНИК §15.1, так что «видимая
 * область» это просто вся партия); откатывается на прежнее правило («у кого меньше карт в руке»),
 * если соседей по границе регионов ещё нет (самое начало партии). */
function handoffTarget(session: GameSession, playerId: number) {
  const neighbors = neighborPlayerIds(session, playerId);
  if (neighbors.length) {
    return session.players
      .filter((p) => neighbors.includes(p.id))
      .sort((a, b) => countUnitsOf(session, b.id) - countUnitsOf(session, a.id))[0];
  }
  return session.players
    .filter((p) => p.id !== playerId)
    .sort((a, b) => session.hands[a.id].length - session.hands[b.id].length)[0];
}

function doMandatoryHandoff(session: GameSession, playerId: number, reporter: Reporter) {
  const hand = session.hands[playerId];
  let bestSlot = -1;
  let bestValue = Infinity;
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (!card || card.freeMonarchy) continue;
    // Неиграбельная в этот ход карта события — первая на выход, ниже любого значения статичной
    // таблицы приоритетов (по прямому запросу, см. looksUnplayableThisTurn).
    const value = card.kind === "event" && looksUnplayableThisTurn(session, playerId, card) ? -1 : (CARD_KEEP_PRIORITY[card.id] ?? 3);
    if (value < bestValue) {
      bestValue = value;
      bestSlot = i;
    }
  }
  if (bestSlot === -1) return; // только freeMonarchy-карты в руке — сервер сам не должен был это требовать
  const cardId = hand[bestSlot].id;
  const target = handoffTarget(session, playerId);
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

// === Приоритет розыгрыша карт за ход (по прямому запросу — «очередь приоритета карт») ===========
// Порядок дословно: наука (если не хватает ресурсов — рабочий вместо неё в этот же заход) →
// население → поселенец → строитель (реально доходит до него только когда действия ещё остались, а
// выше по списку играть уже нечего — это и так само получается из порядка) → налоги → торговец →
// всё остальное вперемешку, что получится сыграть (включая рабочего, лесоводство, торговый путь,
// катастрофу, мобилизацию, право маршрута). «Деньги на закуп недостающих ресурсов тратит только если
// больше 5 карт на руках» — ЕЩЁ НЕ РЕАЛИЗОВАНО (см. ЦИВА-ЖУРНАЛ §27): planBuildingSpend уже сама
// умеет докупать на рынке за деньги, но общая для людей и бота, гейтить её отдельно под бота размером
// руки — отдельная более инвазивная правка.
const MASTER_CARD_PRIORITY = ["scientist", "population", "settler", "builder", "taxes", "trader"];

/** Разыгрывает первую карту указанного id, для которой найдётся играбельный слот в руке (в руке
 * может быть несколько копий одной и той же карты) — тот же tryPlayCardSlot, просто перебор слотов
 * идёт СНАЧАЛА по нужному id, а не по позиции в руке. */
function tryPlayCardId(session: GameSession, playerId: number, cardId: string, reporter: Reporter): boolean {
  const hand = session.hands[playerId];
  for (let i = 0; i < hand.length; i++) {
    if (hand[i]?.id === cardId && tryPlayCardSlot(session, playerId, i, cardId, reporter)) return true;
  }
  return false;
}

/** Выбор ОДНОЙ карты для розыгрыша за этот заход общего цикла хода — по приоритету выше, с двумя
 * исключениями по прямому запросу: не удалась «Наука» или «Строитель» (типично — не хватило
 * ресурсов) — тут же, тем же заходом, пробует «Рабочего» вместо спуска ниже по списку. Если ничего
 * из приоритета не сыграло — играет что получится из ОСТАЛЬНЫХ карт руки в случайном порядке. */
function pickAndPlayNextCard(session: GameSession, playerId: number, reporter: Reporter): boolean {
  const hand = session.hands[playerId];
  for (const cardId of MASTER_CARD_PRIORITY) {
    if (!hand.some((c) => c?.id === cardId)) continue;
    if (tryPlayCardId(session, playerId, cardId, reporter)) return true;
    if ((cardId === "scientist" || cardId === "builder") && tryPlayCardId(session, playerId, "worker", reporter)) return true;
  }
  const rest = [...new Set(hand.filter((c): c is CardDef => !!c && !MASTER_CARD_PRIORITY.includes(c.id)).map((c) => c.id))];
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
      reporter.step({ action: "growCity", payload, cardSlotIndex: slotIndex, cardId, targetKind: "city", targetCityId: city.id, label: `Увеличил население города #${city.id}.` });
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
  const candidates = borderRegionsOf(session, playerId)
    .filter(({ rc, rr }) => !session.cities.some((c) => c.regionCol === rc && c.regionRow === rr))
    .sort((a, b) => settlerRegionScore(session, a.rc, a.rr, ownedCounts) - settlerRegionScore(session, b.rc, b.rr, ownedCounts));
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
        label: `Основал новое поселение в регионе (${rc},${rr}).`,
      });
      return true;
    }
  }
  return tryGrowAnyCity(session, playerId, slotIndex, cardId, reporter);
}

/** Состав армии по прямому запросу (см. decideUnitCategoryPriority) — пробует категории в порядке
 * приоритета, внутри категории берёт лучший (старшая эпоха) доступный юнит первым, перебирая города
 * — при активной войне ближайший к фронту город идёт первым («новые юниты... производятся в
 * ближайшем городе», по прямому запросу), иначе порядок городов произвольный; если предпочтительная
 * категория недоступна нигде (нет технологии/ресурсов/выхода в море для кораблей), переходит к
 * следующей по приоритету, а не блокирует карту «Воин» насмерть. */
function tryBuildUnit(session: GameSession, playerId: number, slotIndex: number, cardId: string, reporter: Reporter): boolean {
  const priority = decideUnitCategoryPriority(session, playerId);
  const front = nearestWarTargetHex(session, playerId);
  const cities = myCities(session, playerId).slice();
  if (front) cities.sort((a, b) => session.hexDistance(a.col, a.row, front.col, front.row) - session.hexDistance(b.col, b.row, front.col, front.row));
  for (const category of priority) {
    const unitsOfCategory = UNITS.filter((u) => u.category === category).sort((a, b) => b.epoch - a.epoch);
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
            label: `Построил юнита «${unit.id}» (${CATEGORY_META[category].label}) в городе #${city.id}.`,
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
          reporter.step({ action: "plantForest", payload, cardSlotIndex: slotIndex, cardId, targetKind: "hex", targetCol: col, targetRow: row, label: `Посадил лес на (${col},${row}).` });
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
  const adjacency = new Map<number, number[]>();
  for (const r of session.tradeRoutes) {
    if (!adjacency.has(r.fromCityId)) adjacency.set(r.fromCityId, []);
    if (!adjacency.has(r.toCityId)) adjacency.set(r.toCityId, []);
    adjacency.get(r.fromCityId)!.push(r.toCityId);
    adjacency.get(r.toCityId)!.push(r.fromCityId);
  }
  const seen = new Set<number>([own[0].id]);
  const queue = [own[0].id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return own.every((c) => seen.has(c.id));
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
