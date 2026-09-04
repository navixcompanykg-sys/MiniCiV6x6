// Серверный аналог состояния и логики "МИНИ ЦИВА" (см. план: C:\Users\user\.claude\plans\mighty-snuggling-squid.md).
// Этап 1: хотсит-модель ровно как в клиенте (main.ts) — последовательные ходы, синхронный резолв
// каждого действия — просто теперь состояние живёт здесь, на сервере, а не в вкладке браузера.
// Класс, а не голые переменные модуля (как в main.ts) — сервер держит НЕСКОЛЬКО комнат одновременно.
//
// Схема состояния (см. toJSON/fromJSON) 1-в-1 повторяет SaveGameV1 из main.ts (web/src/game/main.ts) —
// та схема уже была спроектирована как полный снимок партии для сохранения/загрузки, здесь она же
// становится формой, в которой сервер рассылает состояние клиентам.
//
// ПОРТИРОВАНО (Этап 1): фаза расстановки, юниты/бой/движение, постройки, города/терраформинг,
// сбор ресурсов (Рабочий/Склад/Торговец), технологии/парадигма/религия, дипломатия, торговые пути,
// рынок/налоги/катастрофа/мобилизация, конец хода (включая ветку "рука переполнена" —
// resolveHandOverflowDiscard). Все ~45 действий из инвентаризации плана перенесены — см. dispatch().

import { MapDoc, REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H } from "../../src/map/mapDoc";
import type { TileData } from "../../src/map/mapDoc";
import { generateTerrain } from "../../src/map/terrainGenerator";
import { mulberry32 } from "../../src/map/rand";
import { RESOURCES, TERRAIN_BY_ID } from "../../src/map/types";
import type { ResourceId, TerrainId } from "../../src/map/types";
import { freshDeck, shuffle, makeRouteRightCard, makeMonarchyWorkerCard } from "../../src/game/cards";
import type { CardDef } from "../../src/game/cards";
import { TOKEN_VALUES, resolvePlacement } from "../../src/game/placement";
import type { PlacedToken, CityResult, Player, TokenValue } from "../../src/game/placement";
import { BUILDINGS, builtBy, claimBuilding, isOwnedBy } from "../../src/game/buildings";
import type { BuildingCostLine, BuildingOwners } from "../../src/game/buildings";
import { hexNeighbors, hexNeighborsWrapped } from "../../src/map/hexMath";
import { statsFor, UNITS } from "../../src/game/units";
import type { UnitStats } from "../../src/game/units";
import { BRANCHES, TECH_TREE } from "../../src/game/techtree";
import type { TechDef } from "../../src/game/techtree";

const HAND_SIZE = 7;
// По прямому уточнению — база снижена 3 → 2, компенсируется бонусами: Демократия (+1, уже было),
// Религия (+1, новое — стимул её принимать), здание «Управление» (+1 разово за ход, платно) — до
// 5 действий суммарно при всех трёх сразу (не 6 — см. отчёт: перечисленные источники дают 2+1+1+1=5,
// уточнил у пользователя расхождение с озвученным «до 6»).
const ACTIONS_PER_TURN = 2;
/** «Мобилизация» — безлимитные действия на этот ход (ТЗ 3.2.6). Настоящий `Infinity` не переживает
 * JSON.stringify (сериализуется в `null`), из-за чего клиент после broadcast видел actionsLeft как
 * 0 — «действия обнулились» вместо «стали безлимитными» (по прямому уточнению — явный баг).
 * Конечный «достаточно большой» лимит сериализуется нормально и на практике неотличим от истинной
 * бесконечности за один ход. */
const UNLIMITED_ACTIONS = 999;
// По прямому уточнению — раздача 3 карты (не 2), но 1 из них ОБЯЗАНА тут же уйти другому игроку
// (см. handoffCard/mustHandoff), так что чистый прирост руки — те же 2, что и раньше.
const CARDS_DEALT_PER_TURN = 3;

export type Phase = "placement" | "playing";
export type Paradigm = "monotheism" | "monarchy" | "parliamentarism" | "democracy" | "fascism" | "communism";
export type Religion = "judaism" | "buddhism" | "christianity" | "islam" | "confucianism" | "atheism";
export type Agreement = "openBorders" | "vassalage" | "mutualDefense" | "tradeUnion" | "scienceCoop" | "union";

export interface City {
  id: number;
  playerId: number;
  regionCol: number;
  regionRow: number;
  col: number;
  row: number;
  population: number;
  isCapital: boolean;
}

export type UnitCategory = "support" | "ranged" | "mobile" | "assault" | "defense" | "ship";
export interface UnitInstance {
  id: number;
  playerId: number;
  cityId: number | null;
  category: UnitCategory;
  epoch: 1 | 2 | 3 | 4 | 5 | 6;
  col: number;
  row: number;
  hp: number;
  defending: boolean;
  /** Пиратство/грабёж (по прямому запросу) — юнит (корабль или сухопутный, флажок один и тот же,
   * разница только в подписи кнопки) на гексе торгового маршрута перехватывает 1💰 с каждого
   * розыгрыша «Торговца», который получает доход через этот маршрут, см. traderTrade. */
  raiding: boolean;
  moveOrder: { path: { col: number; row: number }[]; nextIndex: number } | null;
  /** Ручное «сделать активным юнитом гарнизона» (по прямому запросу) — если задано, ПЕРЕБИВАЕТ
   * обычную сортировку очереди по id (по времени постройки). Ниже — значит раньше в очереди, т.е.
   * активнее; новые назначения всегда получают ЕЩЁ более низкое значение (`nextGarrisonRank`,
   * монотонно убывает), так что последнее ручное назначение всегда побеждает. См.
   * `cityGarrisonQueue`/`promoteGarrisonUnit`. */
  garrisonRank?: number;
}

export interface Relation {
  war: boolean;
  agreements: Set<Agreement>;
}
export type ProposalTerm =
  | { kind: "agreement"; agreement: Agreement }
  | { kind: "peace" }
  | { kind: "demandMoney"; amount: number }
  | { kind: "offerMoney"; amount: number }
  | { kind: "giveCity"; cityId: number }
  | { kind: "demandCity"; cityId: number }
  | { kind: "demandResource"; resource: ResourceId; qty: number }
  | { kind: "giveResource"; resource: ResourceId; qty: number };
export interface Proposal {
  id: number;
  from: number;
  to: number;
  terms: ProposalTerm[];
  ultimatum: boolean;
}

export const WORLD_SELLER = -1;

/** TODO: `MarketListing` ниже — плоский интерфейс, а не размеченное объединение (как в main.ts:
 * CardListing | ResourceListing) — при переносе рынка/карт целиком стоит выправить на настоящий
 * discriminated union; сейчас narrowing по `kind` не работает, отсюда `!` на resource/sellerSlotIndex
 * в spend-planning ниже (safe в рантайме — kind проверяется до чтения, просто TS этого не видит). */
export interface MarketListing {
  id: number;
  sellerId: number;
  price: number;
  kind: "card" | "resource";
  card?: CardDef;
  sellerSlotIndex?: number;
  resource?: ResourceId;
}
export interface SpendPlanItem {
  resource: ResourceId;
  source: "access" | "warehouse" | "market";
  cityId?: number;
  listingId?: number;
}

export interface TradeRoute {
  id: number;
  playerId: number;
  techId: string;
  category: "land" | "sea" | "universal";
  fromCityId: number;
  toCityId: number;
  path: { col: number; row: number }[];
}

/** Route-building step after researching a route tech (main.ts:pendingRoute) — waits for the
 * player to pick 2 of their own cities via a follow-up `pickRouteCities` action. Genuinely
 * server-side state (not client UI): it's set by `researchTech`/`confirmResearch` and consumed by
 * a LATER, separate action call — unlike the single-click card flows, this really does span two
 * round-trips, so it can't be collapsed into one action's parameters. */
export interface PendingRoute {
  playerId: number;
  techId: string;
  category: "land" | "sea" | "universal";
}

/** «Соберите налоги» outstanding shortfall (main.ts:pendingTaxShortfall) — real authoritative
 * state: the player pays it down one unit/building at a time via separate `resolveTaxShortfall`
 * calls, so it must persist on the server between those calls, not just in client UI. */
export interface PendingTaxShortfall {
  playerId: number;
  remaining: number;
}

/** «Катастрофа» pay-or-accept choice (main.ts:pendingCatastrophe) — same reasoning as above. */
export interface PendingCatastrophe {
  playerId: number;
}

/** Совет ООН — резолюции (ТЗ §15.3). Параметры — объединение всех 10 видов в одном интерфейсе
 * (каждый вид читает только свои поля, см. validateOonResolutionParams/applyOonResolutionEffect). */
export type OonResolutionType =
  | "openTrade"
  | "worldLeader"
  | "banNuclear"
  | "neutralWaters"
  | "sanctions"
  | "greenAgenda"
  | "priceRegulation"
  | "armsLimit"
  | "aid"
  | "credit";
export interface OonResolutionParams {
  /** worldLeader (кто станет лидером) / sanctions (кого санкционировать) / aid (кто получатель). */
  targetPlayerId?: number;
  /** priceRegulation. */
  resource?: ResourceId;
  price?: number;
  /** armsLimit — максимум юнитов на игрока. */
  limit?: number;
  /** aid — сумма с КАЖДОЙ страны получателю; credit — множитель к населению. */
  amount?: number;
}
export interface PendingOonResolution {
  id: number;
  type: OonResolutionType;
  params: OonResolutionParams;
  /** playerId → голос «за»/«против»; вес голоса = население игрока (totalPopulationOf), не «1
   * игрок — 1 голос». Инициатор (генсек) голосует «за» автоматически при выкладке. */
  votes: Record<number, boolean>;
}

/** Полный снимок партии — форма и сообщений WebSocket "state", и файла на диске (rooms.ts). */
export interface SaveGameV1 {
  version: 1;
  players: { name: string; color: number }[];
  phase: Phase;
  currentPlayerIndex: number;
  winner: number | null;
  /** Тип победы (по прямому запросу — «дашборд результатов с типом победы») — человекочитаемая
   * подпись, устанавливается В ТОТ ЖЕ МОМЕНТ, что и winner, на каждом из путей победы (territorial/
   * space/oon). null, если winner ещё null. */
  winnerType: string | null;
  turnsRemaining: number;
  mapTiles: TileData[][];
  placedTokens: PlacedToken[];
  cityResults: CityResult[];
  cities: City[];
  nextCityId: number;
  units: UnitInstance[];
  nextUnitId: number;
  market: MarketListing[];
  nextListingId: number;
  tradeRoutes: TradeRoute[];
  nextRouteId: number;
  warehouse: Record<number, Partial<Record<ResourceId, number>>>;
  money: Record<number, number>;
  hands: Record<number, CardDef[]>;
  deck: CardDef[];
  actionsLeft: Record<number, number>;
  researchedTechs: Record<number, string[]>;
  buildingOwners: BuildingOwners;
  playerParadigm: Record<number, Paradigm | null>;
  playerReligion: Record<number, Religion | null>;
  religionFounder: Partial<Record<Religion, number>>;
  /** Кто ЛИЧНО первым в партии открыл данную технологию — решает право основать религию
   * (RELIGION_FOUNDING_TECHS) и авто-прокладку торгового маршрута (researchTech). Технологию можно
   * переоткрыть повторно (юниты/здания достаются как обычно), но эти бонусы — только тому, для
   * кого этот ключ был впервые проставлен. */
  techDiscoverer: Record<string, number>;
  relations: Record<string, { war: boolean; agreements: Agreement[] }>;
  pendingProposals: Proposal[];
  nextProposalId: number;
  skippedTurn: number[];
  /** Почему у playerId стоит skippedTurn — только для текста модалки (см. pendingSkipTurnReason). */
  skipTurnReason: Partial<Record<number, "paradigm" | "mobilization">>;
  /** playerId, чей ход прямо сейчас заморожен на модалке «Ход пропущен» (см. advanceCurrentPlayer) —
   * null, если сейчас ничей ход не пропускается. */
  pendingSkipTurn: number | null;
  pendingSkipTurnReason: "paradigm" | "mobilization" | null;
  accessUsed: string[];
  productionUsedThisCycle: string[];
  landedThisCycle: number[];
  outOfMoveThisCycle: number[];
  /** Сколько бюджета хода (moveRange) юнит УЖЕ потратил в ЭТОМ цикле — по прямому запросу «движение
   * должно случаться в текущем цикле» commandUnit теперь исполняет приказ сразу, а не откладывает его
   * до границы цикла; без этого счётчика повторный приказ тому же юниту в том же ходу давал бы ему
   * СВЕЖИЙ moveRange заново (обходя лимит хода за цикл). Общий с автопродолжением приказа, если путь
   * длиннее одного бюджета — оно тоже тратит отсюда же на границе следующего цикла. */
  moveBudgetUsedThisCycle: [number, number][];
  /** Кто уже отдавал приказ (движение/атака/оборона/грабёж) в ТЕКУЩЕМ цикле — по прямому запросу,
   * гейтит `promoteGarrisonUnit`: снять текущего активного юнита с поста и поставить другого можно,
   * только пока текущий активный ЕЩЁ НЕ действовал в этом цикле. */
  unitActedThisCycle: number[];
  nextGarrisonRank: number;
  hexDefense: [string, number][];
  /** Осада города (по прямому уточнению, см. commandUnit/resolveCombat) — «гарнизон» города это его
   * население, отдельного юнита-гарнизона не существует. Буфер защиты города на ЭТОТ цикл, ключ —
   * id города; separate от hexDefense (тот — для реальных юнитов на гексе), иначе бой с размещённым
   * защитником в городе примешивал бы свой остаток буфера к осаде города после его гибели. */
  citySiegeBuffer: [number, number][];
  /** Уничтоженные (население упало до 0) города — по прямому уточнению «руины на клетке»: город как
   * игровой объект удаляется полностью (см. destroyCity), а клетка остаётся отмеченной как руины —
   * обычная проходимая местность с визуальной пометкой, не отдельный тип террейна карты. */
  ruins: { col: number; row: number }[];
  /** Игроки, выбывшие из партии (по прямому уточнению — «вымирание из-за эффектов сброса, войны или
   * катастроф») — потеряли ВСЕ города, см. handleCityLoss. Юниты/маршруты/здания у них уже сняты,
   * поле только для уведомления клиентов (модалка «выбыл») и на будущее для UI/AI-заглушки хода. */
  eliminatedPlayers: number[];
  upravlenieUsedThisTurn: number[];
  mustHandoff: number[];
  spaceComponents: Record<number, number>;
  /** Ядерный арсенал (ТЗ 4.4) — накопительный стокпайл за партию, тем же паттерном, что и
   * spaceComponents. Только счётчик: сам удар по цели (см. 4.4 "Применение ЯО") сознательно НЕ
   * реализован в этом шаге — нет ни боевой системы, ни системы целей, чтобы к нему прицепиться. */
  nuclearWeapons: Record<number, number>;
  /** Совет ООН — кандидаты/генсек/резолюции (ТЗ §15.3, заменяет прежнюю простую модель голосования). */
  oonCandidate1Id: number | null;
  oonCandidate2Id: number | null;
  /** Только для клиента — computed `effectiveOonCandidate2Id()` на момент снимка (динамический
   * автоподбор, пока `oonCandidate2Id` ещё null); fromJSON не восстанавливает, пересчитывается сама. */
  oonEffectiveCandidate2Id: number | null;
  oonSecretaryGeneralId: number | null;
  pendingOonResolution: PendingOonResolution | null;
  nextOonResolutionId: number;
  oonOpenTradeActive: boolean;
  oonNuclearBanActive: boolean;
  oonNeutralWatersActive: boolean;
  oonSanctionedPlayerId: number | null;
  oonGreenAgendaActive: boolean;
  oonPriceRegulation: { resource: ResourceId; price: number } | null;
  oonArmsLimit: number | null;
  pendingRoute: PendingRoute | null;
  pendingTaxShortfall: PendingTaxShortfall | null;
  pendingCatastrophe: PendingCatastrophe | null;
  /** Только для сервера — Seed текущего RNG сессии, чтобы перезапуск процесса не менял продолжение
   * детерминированной последовательности (хотя для Этапа 1 это не критично: карта уже сгенерирована
   * и лежит в mapTiles, а не перегенерируется при загрузке). */
  rngSeed: number;
  rngCallCount: number;
}

/** Результат применения действия — `hint` уходит ТОЛЬКО инициатору (как раньше setHint() в
 * браузере), состояние рассылается всем в комнате отдельным сообщением. `needsWarConfirm` — см.
 * ниже: window.confirm() существовал только в браузере, здесь это явный round-trip клиент↔сервер. */
export interface ActionResult {
  ok: boolean;
  hint?: string;
  needsWarConfirm?: { targetPlayerId: number; reason: string };
  /** Поддержка в этом конкретном бою (по прямому запросу — «анимация линиями... чтоб было видно
   * какие юниты оказали поддержку») — одна запись на каждого поддержавшего, `from` — его позиция,
   * `to` — позиция того, кого он поддержал (атакующий или защитник). Клиент рисует линию на каждую
   * запись поверх карты; чисто визуальные данные, ни на что в состоянии партии не влияют. */
  supportLines?: { from: { col: number; row: number }; to: { col: number; row: number } }[];
  /** Данные для анимации боя (по прямому запросу — «полоски от юнита к цели, с отображаемым
   * убыванием защиты, хотя бы секунда анимации») — чисто отображение, ни на что в состоянии партии
   * не влияет: сама атака (`resolveCombat`) уже применена и посчитана целиком ДО того, как эти
   * данные собраны, здесь только моментальные снимки до/после каждого удара. `hits` — 1 запись на
   * каждую задетую цель (несколько только у AoE — Дальняя атака/Корабли бьют по всем на клетке
   * разом); `counterOnAttacker` — только для обычного (не AoE) боя, если защитник выжил и ударил в
   * ответ. Юнитная защита (`hexDefense`) и городской буфер осады (`citySiegeBuffer`) — РАЗНЫЕ шкалы
   * (`kind` их различает), но клиент анимирует оба одним и тем же «полоска-от-атакующего-к-цели +
   * убывающая полоска защиты» языком. */
  combatAnim?: {
    attacker: { col: number; row: number };
    hits: (
      | { kind: "city"; target: { col: number; row: number }; defenseBefore: number; defenseAfter: number; garrisonBroken: boolean }
      | { kind: "unit"; target: { col: number; row: number }; defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number }
    )[];
    counterOnAttacker?: { defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number };
  };
  /** Фактически пройденные юнитом гексы за ЭТОТ вызов commandUnit (по прямому запросу — «движение
   * должно случаться в текущем цикле, а не в следующем, плюс анимация с учётом местности») — сервер
   * теперь исполняет приказ на движение сразу (см. walkUnitAlongOrder), а не откладывает его целиком
   * до границы цикла, поэтому знает точный пройденный путь и может отдать его клиенту для анимации.
   * `cost` — сколько бюджета хода стоил именно этот шаг (0.5 по дороге, полный остаток на горе без
   * дороги, обычная стоимость местности иначе) — клиент использует его, чтобы шаг по лёгкой местности
   * анимировался быстрее шага по тяжёлой, вместо одинаковой длительности на каждый гекс. Пусто/undefined,
   * если приказ не был движением (атака и т.д.) или юнит не смог сделать ни шага (бюджет уже исчерпан). */
  movedPath?: { col: number; row: number; cost: number }[];
  /** Рабочему не хватило лимита населения, чтобы добыть все новые типы региона сразу — клиент
   * должен показать выбор из `options` (до `budget` штук) и повторить workerCollect с chosenTypes. */
  needsResourceChoice?: { cityId: number; budget: number; options: ResourceId[]; population: number; usedThisCycle: number };
  /** Конец хода с рукой ≥8 (ТЗ 2.3) — тот же round-trip паттерн, что и needsWarConfirm: `endTurn`
   * БЕЗ `confirmed` возвращает превью последствий вместо того, чтобы применить их сразу («фильтр от
   * случайного проматывания», по прямому уточнению) — детерминированный дословный прогон того же
   * `resolveHandOverflowDiscard` на клоне сессии (см. previewHandOverflowDiscard), реальный вызов
   * повторяет его на живой сессии только с `confirmed: true`. Закрытие окна клиентом ничего не меняет
   * (превью не трогает реальный RNG/состояние) — те же последствия наступят, если позже игрок всё же
   * подтвердит конец хода с той же рукой. */
  needsDiscardConfirm?: { consequences: string[]; eliminates: boolean };
  /** Конец хода со складом сверх лимита (по прямому уточнению) — в процессе хода лимит не проверяется
   * вообще (см. addToWarehouse), только здесь: `endTurn` отказывает НАСТОЯЩИМ образом (нет пути
   * «подтвердить и продолжить», в отличие от needsDiscardConfirm) — игрок обязан продать `overBy`
   * единиц ресурсов (любых) на бирже и повторить конец хода. */
  needsWarehouseTrim?: { total: number; cap: number; overBy: number };
  /** Землетрясение среди катаклизмов «Учёного» (ТЗ §15.1) — регионы, которые тряхнуло в этом
   * подтверждённом сбросе, чисто для анимации на клиенте (см. playEarthquakeAnimation, main.ts);
   * ни на что в состоянии партии не влияет. Только на РЕАЛЬНОМ подтверждении (`endTurn` с
   * `confirmed: true`), не на превью (`needsDiscardConfirm`) — превью считается на клоне сессии и
   * никакой анимации не должно вызывать. */
  earthquakeHexes?: { col: number; row: number }[];
}

function replaceRecord<T>(target: Record<string, T>, source: Record<string, T>) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}
function replaceSet<T>(target: Set<T>, values: T[]) {
  target.clear();
  for (const v of values) target.add(v);
}

export class GameSession {
  readonly id: string;
  players: Player[];

  phase: Phase = "placement";
  currentPlayerIndex = 0;
  winner: number | null = null;
  winnerType: string | null = null;
  turnsRemaining = 60;

  doc = new MapDoc();
  placedTokens: PlacedToken[] = [];
  cityResults: CityResult[] = [];
  cities: City[] = [];
  nextCityId = 1;

  units: UnitInstance[] = [];
  nextUnitId = 1;
  landedThisCycle = new Set<number>();
  outOfMoveThisCycle = new Set<number>();
  moveBudgetUsedThisCycle = new Map<number, number>();
  unitActedThisCycle = new Set<number>();
  /** Монотонно убывает при каждом `promoteGarrisonUnit` — см. UnitInstance.garrisonRank. */
  nextGarrisonRank = -1;
  hexDefense = new Map<string, number>();
  citySiegeBuffer = new Map<number, number>();
  ruins: { col: number; row: number }[] = [];
  eliminatedPlayers = new Set<number>();

  market: MarketListing[] = [];
  nextListingId = 1;
  tradeRoutes: TradeRoute[] = [];
  nextRouteId = 1;

  buildingOwners: BuildingOwners = {};
  deck: CardDef[];
  hands: Record<number, CardDef[]> = {};
  actionsLeft: Record<number, number> = {};
  money: Record<number, number> = {};
  warehouse: Record<number, Partial<Record<ResourceId, number>>> = {};

  researchedTechs: Record<number, Set<string>> = {};
  playerParadigm: Record<number, Paradigm | null> = {};
  playerReligion: Record<number, Religion | null> = {};
  religionFounder: Partial<Record<Religion, number>> = {};
  techDiscoverer: Record<string, number> = {};
  /** Здание «Управление» — купленное доп. действие, не более раза за ход (по прямому уточнению). */
  upravlenieUsedThisTurn = new Set<number>();
  /** Обязательная передача карты (ТЗ 2.3, «не реализовано» → реализовано по прямому уточнению) —
   * кто ОБЯЗАН отдать 1 карту, прежде чем сможет сделать хоть что-то ещё в своём ходу. Выставляется
   * в endTurn сразу после раздачи 3 карт (см. CARDS_DEALT_PER_TURN); снимается только handoffCard. */
  mustHandoff = new Set<number>();
  spaceComponents: Record<number, number> = {};
  nuclearWeapons: Record<number, number> = {};
  oonCandidate1Id: number | null = null;
  oonCandidate2Id: number | null = null;
  oonSecretaryGeneralId: number | null = null;
  pendingOonResolution: PendingOonResolution | null = null;
  nextOonResolutionId = 1;
  oonOpenTradeActive = false;
  oonNuclearBanActive = false;
  oonNeutralWatersActive = false;
  oonSanctionedPlayerId: number | null = null;
  oonGreenAgendaActive = false;
  oonPriceRegulation: { resource: ResourceId; price: number } | null = null;
  oonArmsLimit: number | null = null;

  relations: Record<string, Relation> = {};
  pendingProposals: Proposal[] = [];
  nextProposalId = 1;

  skippedTurn = new Set<number>();
  skipTurnReason: Partial<Record<number, "paradigm" | "mobilization">> = {};
  pendingSkipTurn: number | null = null;
  pendingSkipTurnReason: "paradigm" | "mobilization" | null = null;
  accessUsed = new Set<string>();
  productionUsedThisCycle = new Set<string>();

  pendingRoute: PendingRoute | null = null;
  pendingTaxShortfall: PendingTaxShortfall | null = null;
  pendingCatastrophe: PendingCatastrophe | null = null;

  private rngSeed: number;
  private rngCallCount = 0;
  private rngFn: () => number;

  constructor(id: string, players: Player[], seed = Date.now() ^ (Math.random() * 0xffffffff)) {
    this.id = id;
    this.players = players;
    this.rngSeed = seed >>> 0;
    this.rngFn = mulberry32(this.rngSeed);

    for (const p of players) {
      this.spaceComponents[p.id] = 0;
      this.nuclearWeapons[p.id] = 0;
      this.researchedTechs[p.id] = new Set();
      this.playerParadigm[p.id] = null;
      this.playerReligion[p.id] = null;
      this.hands[p.id] = [];
      this.actionsLeft[p.id] = ACTIONS_PER_TURN;
      this.money[p.id] = 0;
      this.warehouse[p.id] = {};
    }

    this.deck = shuffle(freshDeck(), this.rng);
    generateTerrain(this.doc, this.rng);
  }

  /** Единый детерминированный RNG сессии — ВСЕ игровые случайности (генерация карты, катастрофы,
   * рост леса и т.п.) обязаны идти через него, не через голый Math.random(), иначе partия
   * непортируема между процессами/перезапусками сервера (ТЗ §8.1 «единый Seed для всех случайных
   * событий» — здесь пока один сервер-владелец состояния, но тот же принцип уже нужен просто чтобы
   * состояние было воспроизводимо). */
  private rng = (): number => {
    this.rngCallCount++;
    return this.rngFn();
  };

  // === Фаза расстановки (ТЗ 1.2/2) — жетоны ставок → resolvePlacement → первые города ==========

  private isInhabitedRegion(rc: number, rr: number): boolean {
    let land = 0;
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const t = this.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).terrain;
        if (t !== "ocean" && t !== "iceOcean") land++;
      }
    }
    return land >= 3;
  }

  isLandTile(col: number, row: number): boolean {
    const t = this.doc.get(col, row).terrain;
    return t !== "ocean" && t !== "iceOcean";
  }

  /** "Тундра под льдом" (mapDoc.ts, iceCover) — суша, но город на ней ставить нельзя. */
  canFoundCityAt(col: number, row: number): boolean {
    return this.isLandTile(col, row) && !this.doc.get(col, row).iceCover;
  }

  private regionHasFoundableTile(rc: number, rr: number): boolean {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) for (let dy = 0; dy < REGION_SIZE_Y; dy++) if (this.canFoundCityAt(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy)) return true;
    return false;
  }

  /** По прямому запросу («иначе игрок становится пленником отсутствия еды») — стартовый посев не
   * должен позволять поставить жетон на регион вообще без ЗЕМНОЙ пищи: морская (рыба/крабы) не
   * считается, потому что «Мореплавание» ещё не открыто в начале партии, и новый игрок оказался бы
   * без единого доступного пищевого ресурса до тех пор, пока не исследует эту технологию. */
  private regionHasLandFood(rc: number, rr: number): boolean {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const r = this.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).resource;
        if (!r) continue;
        const meta = GameSession.RESOURCE_META.get(r)!;
        if (meta.category === "food" && !meta.requiresWater) return true;
      }
    }
    return false;
  }

  /** Без hexToPixel (клиентская геометрия рендера) сервер не выбирает "ближайший к клику" тайл —
   * этим полноценно занимается клиент при формировании клика; сервер получает уже готовые col/row
   * и только проверяет их через canFoundCityAt. Если клиент прислал непригодный тайл — берём первый
   * подходящий в регионе как разумный запасной вариант (тот же результат, что даёт land TileForClick
   * в main.ts, когда клик пришёлся не на сушу). */
  private landTileForRegion(rc: number, rr: number, clickCol: number, clickRow: number): { col: number; row: number } {
    if (this.canFoundCityAt(clickCol, clickRow)) return { col: clickCol, row: clickRow };
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const c = rc * REGION_SIZE_X + dx;
        const r = rr * REGION_SIZE_Y + dy;
        if (this.canFoundCityAt(c, r)) return { col: c, row: r };
      }
    }
    return { col: clickCol, row: clickRow };
  }

  private nextTokenValueFor(playerId: number): TokenValue | null {
    const count = this.placedTokens.filter((t) => t.playerId === playerId).length;
    return count < 3 ? TOKEN_VALUES[count] : null;
  }

  placeToken(playerId: number, clickCol: number, clickRow: number): ActionResult {
    if (this.phase !== "placement") return { ok: false, hint: "Фаза расстановки уже завершена." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const value = this.nextTokenValueFor(playerId);
    if (value === null) return { ok: false, hint: "У вас уже все 3 жетона расставлены." };
    const rc = Math.floor(clickCol / REGION_SIZE_X);
    const rr = Math.floor(clickRow / REGION_SIZE_Y);
    if (!this.isInhabitedRegion(rc, rr)) return { ok: false, hint: "Города можно основать только в обитаемом регионе (суши ≥ 3 тайлов) — попробуйте другой регион." };
    if (!this.regionHasFoundableTile(rc, rr)) return { ok: false, hint: "Вся суша этого региона подо льдом — город здесь поставить нельзя, попробуйте другой регион." };
    if (!this.regionHasLandFood(rc, rr)) return { ok: false, hint: "В этом регионе нет земной пищи (только морская, если вообще есть) — без «Мореплавания» город здесь останется без еды, попробуйте другой регион." };
    if (this.placedTokens.some((t) => t.playerId === playerId && t.regionCol === rc && t.regionRow === rr)) {
      return { ok: false, hint: "В этом регионе у вас уже есть жетон — только 1 жетон на регион." };
    }
    const { col, row } = this.landTileForRegion(rc, rr, clickCol, clickRow);
    this.placedTokens.push({ playerId, value, regionCol: rc, regionRow: rr, col, row });

    if (this.nextTokenValueFor(playerId) !== null) return { ok: true };
    // Это был 3-й жетон игрока — ход переходит дальше автоматически, кнопка не нужна (как в клиенте).
    this.currentPlayerIndex++;
    if (this.currentPlayerIndex >= this.players.length) {
      this.resolvePlacementPhase();
    }
    return { ok: true };
  }

  /** Постановка города на гекс с лесом автоматически вырубает его (по прямому запросу) — тот же
   * выход, что и явная вырубка Строителем, 2 Леса на склад владельца города. */
  private clearForestUnderCity(city: City) {
    const tile = this.doc.get(city.col, city.row);
    if (!tile.forest) return;
    this.doc.set(city.col, city.row, { forest: false });
    this.addToWarehouse(city.playerId, "wood", 2);
  }

  private resolvePlacementPhase() {
    this.cityResults = resolvePlacement(this.placedTokens, this.rng);
    this.cities = this.cityResults.map((r) => ({
      id: this.nextCityId++,
      playerId: r.playerId,
      regionCol: r.regionCol,
      regionRow: r.regionRow,
      col: r.col,
      row: r.row,
      population: 1,
      isCapital: true,
    }));
    for (const c of this.cities) this.clearForestUnderCity(c);
    // ТЗ: как только все стартовые (1 ур.) города основаны, каждый игрок берёт 2 карты — самая
    // первая раздача партии, отдельная от обычного цикла «3 карты, 1 отдать» (CARDS_DEALT_PER_TURN
    // ниже): отдавать пока некому и нечего, обязательная передача с неё не начинается.
    const INITIAL_HAND_DEAL = 2;
    for (const p of this.players) {
      for (let i = 0; i < INITIAL_HAND_DEAL && this.hands[p.id].length < HAND_SIZE; i++) {
        const card = this.deck.shift();
        if (!card) break;
        this.hands[p.id].push(card);
      }
    }
    this.seedStartingMarket();
    this.phase = "playing";
    this.currentPlayerIndex = 0;
  }

  /** Постоянные лоты биржи (по прямому уточнению, заменяет прежнюю версию — «не так много», 5 партий
   * по всем 20 ресурсам было лишним) — ровно 6 видов ресурса, ПОСТОЯННО доступных на бирже по 1
   * единице от казны/мира (`sellerId: WORLD_SELLER`): Злаки, Рыба, Овощи, Силикаты, Металлические
   * руды, Хлопок. Цена растёт с КАЖДОЙ покупкой ЛЮБЫМ игроком (см. buyListing — лот не просто
   * исчезает, а тут же появляется заново по цене price+WORLD_MARKET_PRICE_STEP), без верхнего предела
   * (в отличие от обычных лотов игроков, которые капаются на 10, см. sellResource). Стартовая цена и
   * шаг роста — предположение (в правке не заданы явно): 1💰 и +1💰 за покупку соответственно. */
  private static WORLD_MARKET_RESOURCES: ResourceId[] = ["grain", "fish", "vegetables", "silicates", "metalOre", "cotton"];
  private static WORLD_MARKET_START_PRICE = 1;
  private static WORLD_MARKET_PRICE_STEP = 1;
  private seedStartingMarket() {
    for (const resource of GameSession.WORLD_MARKET_RESOURCES) {
      this.market.push({ id: this.nextListingId++, sellerId: WORLD_SELLER, kind: "resource", resource, price: GameSession.WORLD_MARKET_START_PRICE });
    }
  }

  // === Ресурсы региона / доступ / трата (ТЗ 3.1/7.1/7.2) — общий фундамент для построек и юнитов ===

  private static RESOURCE_META = new Map(RESOURCES.map((r) => [r.id, r]));
  static MAX_CITIES = 8;
  static WAREHOUSE_CAP = 6;
  static WAREHOUSE_CAP_WITH_SKLAD = 12;
  static MAX_ROUTE_HEXES = 12;
  /** Which tech adopts which paradigm (ТЗ 11.6) — портировано из PARADIGM_META (main.ts), только
   * поле `tech`, нужное для серверной валидации; человекочитаемые label/effect остаются чисто
   * клиентским справочником (main.ts уже их показывает). */
  private static PARADIGM_META: Record<Paradigm, { tech: string }> = {
    monotheism: { tech: "Мистицизм" },
    monarchy: { tech: "Богословие" },
    parliamentarism: { tech: "Экономика" },
    democracy: { tech: "Права человека" },
    fascism: { tech: "Идеология" },
    communism: { tech: "Коммунизм" },
  };

  private resourceTileBlocked(col: number, row: number, ownerId: number): boolean {
    return this.units.some((u) => u.col === col && u.row === row && u.playerId !== ownerId && this.relationOf(u.playerId, ownerId).war);
  }

  /** Сколько ЕЩЁ НОВЫХ типов ресурсов город может обработать в этом цикле (ТЗ 7.2 — «город
   * обрабатывает не больше N типов за цикл», N = население). Уже добытые в этом цикле типы бюджет
   * не расходуют повторно. Используется планировщиками трат: раньше лимит применялся вслепую внутри
   * `resourcesInRegion` (capToCity) ПО ПОРЯДКУ СКАНИРОВАНИЯ тайлов — из-за этого регион со
   * «рыба, крабы, злаки» при населении 1 отдавал только рыбу, а если у игрока нет «Мореплавания»,
   * рыба ещё и не добывается, и злаки рядом становились недоступны вовсе (по прямому запросу — «в
   * столице есть злаки, а Учёный не играется»). Теперь планировщик берёт ВСЕ пригодные типы региона
   * и сам следит за лимитом, выбирая то, что реально нужно для оплаты. */
  private accessBudgetFor(cityId: number): number {
    const city = this.cities.find((c) => c.id === cityId);
    if (!city) return 0;
    return Math.max(0, city.population - this.accessTypesUsedThisCycle(city.id));
  }

  accessTypesUsedThisCycle(cityId: number): number {
    let count = 0;
    for (const key of this.accessUsed) if (key.startsWith(`${cityId}:`)) count++;
    return count;
  }

  /** `blockedForPlayerId` отфильтровывает клетки, заблокированные вражеским юнитом. `capToCity`
   * ограничивает число ВОЗВРАЩАЕМЫХ типов населением города (ТЗ 7.2). */
  resourcesInRegion(rc: number, rr: number, blockedForPlayerId?: number, capToCity?: City): ResourceId[] {
    const tiles: ResourceId[] = [];
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = rc * REGION_SIZE_X + dx;
        const row = rr * REGION_SIZE_Y + dy;
        const r = this.doc.get(col, row).resource;
        if (!r) continue;
        if (blockedForPlayerId !== undefined && this.resourceTileBlocked(col, row, blockedForPlayerId)) continue;
        tiles.push(r);
      }
    }
    if (!capToCity) return tiles;
    let budget = Math.max(0, capToCity.population - this.accessTypesUsedThisCycle(capToCity.id));
    const allowedNewTypes = new Set<ResourceId>();
    const out: ResourceId[] = [];
    for (const r of tiles) {
      if (this.accessUsed.has(`${capToCity.id}:${r}`) || allowedNewTypes.has(r)) {
        out.push(r);
        continue;
      }
      if (budget <= 0) continue;
      allowedNewTypes.add(r);
      budget--;
      out.push(r);
    }
    return out;
  }

  /** Мореплавание/Горное дело гейтят доступ к морским/стратегическим ресурсам (Технологии.md). */
  resourceIsExtractable(playerId: number, id: ResourceId): boolean {
    const meta = GameSession.RESOURCE_META.get(id)!;
    if (meta.category === "strategic") return this.researchedTechs[playerId].has("Горное дело");
    if (meta.requiresWater) return this.researchedTechs[playerId].has("Мореплавание");
    return true;
  }

  private regionHasAnyCity(rc: number, rr: number): boolean {
    return this.cities.some((c) => c.regionCol === rc && c.regionRow === rr);
  }

  /** Запрет основания города в регионе, где стоит вражеский юнит (по прямому запросу) — «враг» тем
   * же критерием, что и везде в клиенте (`resourceTileBlocked`/`canEnterHex`): игрок, с которым
   * идёт война, а не просто «любой другой игрок». Ищет по всем гексам региона, не только по
   * конкретной клетке основания. */
  private regionHasEnemyUnit(rc: number, rr: number, playerId: number): boolean {
    return this.units.some(
      (u) =>
        u.playerId !== playerId &&
        this.relationOf(u.playerId, playerId).war &&
        Math.floor(u.col / REGION_SIZE_X) === rc &&
        Math.floor(u.row / REGION_SIZE_Y) === rr
    );
  }

  capitalCityOf(playerId: number): City | undefined {
    return this.cities.find((c) => c.playerId === playerId && c.isCapital);
  }

  /** «Карта круглая» — но только запад-восток (по прямому уточнению): соседство региональных
   * колонок заворачивается через шов REGION_GRID_W (запад ↔ восток), а вот строки (север-юг, где
   * по краям карты полярный лёд) НЕ заворачиваются — через лёд к другому полюсу не поселиться. */
  private regionsAdjacent(rc1: number, rr1: number, rc2: number, rr2: number): boolean {
    const colDist = Math.min(Math.abs(rc1 - rc2), REGION_GRID_W - Math.abs(rc1 - rc2));
    return colDist <= 1 && Math.abs(rr1 - rr2) <= 1 && !(rc1 === rc2 && rr1 === rr2);
  }

  private playerHasCityAdjacentTo(playerId: number, rc: number, rr: number): boolean {
    return this.cities.some((c) => c.playerId === playerId && this.regionsAdjacent(c.regionCol, c.regionRow, rc, rr));
  }

  /** Число карт в руке, которые СЧИТАЮТСЯ в лимит (HAND_SIZE/переполнение) — «Право прокладки
   * маршрута» (routeRight) явно исключено по прямому уточнению («не считается в лимит»). Бесплатный
   * «Рабочий» Монархии (freeMonarchy) — по прямому уточнению («иначе имбово со Складом») СЧИТАЕТСЯ
   * в лимит наравне с обычными картами: фактически сокращает лимит обычных карт с 7 до 6, пока
   * парадигма активна и карта лежит в руке. Не защищает от негативного эффекта сброса — см.
   * resolveHandOverflowDiscard (neutralized). */
  private handCountedSize(playerId: number): number {
    return this.hands[playerId].filter((c) => c.id !== "routeRight").length;
  }
  /** Монархия (по прямому запросу, заменяет старую защиту юнитов ×2) — 1 бесплатная карта «Рабочий»
   * в руке, минтится напрямую (не из колоды, см. makeMonarchyWorkerCard), обновляется каждый ЦИКЛ
   * (вызывается только из endTurn на обороте currentPlayerIndex в 0, не на каждый ход): если игрок
   * её уже разыграл в прошлом цикле (или только что принял парадигму) — выдаём новую; если она
   * всё ещё лежит неиграной — вторая не добавляется (ровно 1 штука на игрока). Не учитывается в
   * handCountedSize и не может быть передана/продана (handoffCard/sellCard) — не провоцирует
   * переполнение руки и не эксплуатируется передачей ради повторной выдачи. */
  private grantMonarchyWorkerCards() {
    for (const p of this.players) {
      if (this.playerParadigm[p.id] !== "monarchy") continue;
      if (this.hands[p.id].some((c) => c.freeMonarchy)) continue;
      this.hands[p.id].push(makeMonarchyWorkerCard());
    }
  }
  /** Коммунизм (по прямому запросу — упрощение парадигмы, заменяет старый доступ ко всей торговой
   * сети через `ownRouteComponent`) — добываемые (`resourceIsExtractable`) типы РЕГИОНА СТОЛИЦЫ
   * трактуются как всегда лежащие на складе в неограниченном количестве: «ресурсы 1 города постоянно
   * присутствуют на складе сверх лимита». Пересчитывается от ТЕКУЩЕЙ столицы каждый раз (не
   * фиксируется в момент принятия парадигмы) — потеря/смена столицы просто меняет набор типов, без
   * отдельного состояния для отслеживания. Пусто, если игрок не Коммунист или ещё без столицы. */
  private communismCapitalTypes(playerId: number): ResourceId[] {
    if (this.playerParadigm[playerId] !== "communism") return [];
    const capital = this.capitalCityOf(playerId);
    if (!capital) return [];
    return [...new Set(this.resourcesInRegion(capital.regionCol, capital.regionRow, playerId))].filter((r) => this.resourceIsExtractable(playerId, r));
  }
  /** Виртуальный склад для ПОДБОРА кандидатов при планировании трат (planFoodSpend/planResourceSpend/
   * planBuildingSpend/торговые ресурсы «Торгового пути») — обычный склад плюс, у Коммунистов,
   * «бесконечный» остаток по типам региона столицы (см. communismCapitalTypes). НЕ для списания —
   * реальное списание (commitSpend→takeFromWarehouse) молча не проверяет свой возврат, так что уже
   * нулевой настоящий остаток такого типа просто не уходит в минус, а план всё равно считается
   * оплаченным (ровно смысл «бесконечный тап»); takeFromWarehouse по-прежнему читает НАСТОЯЩИЙ склад. */
  private static COMMUNISM_INFINITE_QTY = 999;
  private effectiveWarehouseFor(playerId: number): Partial<Record<ResourceId, number>> {
    const infiniteTypes = this.communismCapitalTypes(playerId);
    if (!infiniteTypes.length) return this.warehouse[playerId] ?? {};
    const out = { ...(this.warehouse[playerId] ?? {}) };
    for (const r of infiniteTypes) out[r] = Math.max(out[r] ?? 0, GameSession.COMMUNISM_INFINITE_QTY);
    return out;
  }
  private warehouseCapFor(playerId: number): number {
    const base = isOwnedBy(this.buildingOwners, "sklad", playerId) ? GameSession.WAREHOUSE_CAP_WITH_SKLAD : GameSession.WAREHOUSE_CAP;
    return base + this.communismCapitalTypes(playerId).length;
  }
  private warehouseTotal(playerId: number): number {
    return Object.values(this.warehouse[playerId] ?? {}).reduce((sum: number, qty) => sum + (qty ?? 0), 0);
  }
  /** По прямому уточнению — лимит склада больше НЕ проверяется здесь (раньше молча обрезал/терял
   * добытое сверх лимита, что и было неудобно): в процессе хода склад может свободно превышать лимит,
   * ограничение проверяется только в конце хода (см. endTurn/needsWarehouseTrim) — игрок сам решает,
   * когда и что продать, а не теряет добычу молча посреди хода. */
  addToWarehouse(playerId: number, resource: ResourceId, qty: number) {
    const w = this.warehouse[playerId];
    w[resource] = (w[resource] ?? 0) + qty;
  }
  private takeFromWarehouse(playerId: number, resource: ResourceId, qty: number): boolean {
    const w = this.warehouse[playerId];
    if ((w[resource] ?? 0) < qty) return false;
    w[resource]! -= qty;
    return true;
  }

  private shiftListingSlotsAfterRemoval(playerId: number, removedIndex: number) {
    for (const l of this.market) {
      if (l.kind === "card" && l.sellerId === playerId && l.sellerSlotIndex! > removedIndex) l.sellerSlotIndex!--;
    }
  }
  private consumeHandCard(playerId: number, slotIndex: number) {
    const hand = this.hands[playerId];
    const card = hand[slotIndex];
    if (card) {
      hand.splice(slotIndex, 1);
      this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
      // Бесплатный «Рабочий» Монархии (freeMonarchy) не из колоды — попадание в this.deck задвоило
      // бы обычные копии «Рабочего» навсегда; он просто исчезает, следующий выдаст grantMonarchyWorkerCards.
      if (!card.freeMonarchy) {
        card.receivedFrom = undefined; // назад в колоду — история передачи (ТЗ 2.3) не переживает цикл
        this.deck.push(card);
      }
    }
    this.actionsLeft[playerId]--;
  }

  // === Spend-planning (доступ региона → склад → рынок), ТЗ 3.1/5.1/7.1 ==========================

  /** Промтовары (Фабрика) — универсальный ресурс-джокер (по прямому уточнению): засчитывается за ЛЮБОЙ
   * требуемый ресурс, КРОМЕ урана/углеводородов/электричества. Джокер не удваивается никакими техами
   * добычи (Гончарное дело/Индустриализация/Гильдии/Генная инженерия) — это уже так само по себе,
   * `activateProductionBuilding` кладёт на склад фиксированное `b.produces.qty`, вообще не проходя
   * через `extractionMultiplier` (тот участвует только в добыче Рабочим/Складом с карты региона, а
   * Промтовары там просто не бывают — не размещаются генератором, `targetCount: 0`). */
  private static JOKER_EXCLUDED_RESOURCES: ResourceId[] = ["uranium", "hydrocarbons", "electricity"];
  /** Оборачивает произвольный `match` требования джокером: сначала пробуем обычное совпадение, если
   * кандидат — Промтовары, разрешаем ЕГО, только если у этого требования есть хоть один реально
   * подходящий ресурс ВНЕ исключённой тройки (иначе требование по смыслу — именно один из этих трёх,
   * джокер туда не годится: «anyOf(Углеводороды,Электричество)», «Уран» и т.п.). */
  private matchWithJoker(match: (id: ResourceId) => boolean): (id: ResourceId) => boolean {
    return (id: ResourceId) => {
      if (match(id)) return true;
      if (id !== "promtovary") return false;
      return RESOURCES.some((r) => match(r.id) && !GameSession.JOKER_EXCLUDED_RESOURCES.includes(r.id));
    };
  }
  private static reqCategory(label: string, category: "food" | "trade" | "strategic") {
    return { label, match: (r: ResourceId) => GameSession.RESOURCE_META.get(r)!.category === category };
  }
  private static reqSpecific(label: string, id: ResourceId) {
    return { label, match: (r: ResourceId) => r === id };
  }
  static EPOCH_UNIT_COST: Record<number, { money: number; resources: { label: string; match: (id: ResourceId) => boolean }[] }> = {
    1: { money: 0, resources: [GameSession.reqCategory("Еда", "food")] },
    2: { money: 0, resources: [GameSession.reqCategory("Еда", "food"), GameSession.reqSpecific("Металл", "metalOre")] },
    3: { money: 0, resources: [GameSession.reqSpecific("Металл", "metalOre"), GameSession.reqCategory("Торговый", "trade")] },
    4: { money: 1, resources: [GameSession.reqSpecific("Углеводороды", "hydrocarbons")] },
    5: { money: 1, resources: [GameSession.reqSpecific("Металл", "metalOre"), GameSession.reqSpecific("Углеводороды", "hydrocarbons")] },
    6: { money: 1, resources: [GameSession.reqSpecific("Металл", "metalOre"), GameSession.reqSpecific("Углеводороды", "hydrocarbons"), GameSession.reqSpecific("Редкоземельные", "rareEarth")] },
  };
  /** «Деревянные» корабли (Галера Э1, Каравелла Э2, Фрегат Э3 — до стали, см. Линкор/«Сталь» с Э4) —
   * по прямому запросу «для деревянных кораблей 1 металл замени на лес»: те же деньги, тот же
   * остальной состав цены эпохи, только Металл → Лес. Галера (Э1) была просто 1 едой — по прямому
   * уточнению теперь тоже 1 Лес (полностью заменяет еду, не добавляется к ней). */
  static WOODEN_SHIP_RESOURCE_COST: Record<number, { label: string; match: (id: ResourceId) => boolean }[]> = {
    1: [GameSession.reqSpecific("Лес", "wood")],
    2: [GameSession.reqCategory("Еда", "food"), GameSession.reqSpecific("Лес", "wood")],
    3: [GameSession.reqSpecific("Лес", "wood"), GameSession.reqCategory("Торговый", "trade")],
  };
  /** Дальняя атака Э1/Э2 (Катапульта/Требушет) — по прямому уточнению «по аналогии с кораблями»: тот
   * же паттерн замены на Лес, что и у деревянных кораблей выше (Э1 — еда полностью заменена на Лес,
   * Э2 — металл заменён на Лес, еда остаётся). С Э3 (Пушка, порох) уже не дерево — своя обычная цена. */
  static WOODEN_RANGED_RESOURCE_COST: Record<number, { label: string; match: (id: ResourceId) => boolean }[]> = {
    1: [GameSession.reqSpecific("Лес", "wood")],
    2: [GameSession.reqCategory("Еда", "food"), GameSession.reqSpecific("Лес", "wood")],
  };

  /** Access ограничен ОДНИМ городом (его собственный регион) — предпочитается складу, тот — рынку.
   * `source.id` может быть id ещё не созданного города (основание — см. foundCity), но у такого
   * города ЕЩЁ НЕТ инфраструктуры добычи на месте — по прямому уточнению («для поселенца нужен
   * пищевой ресурс на складе, а не клети куда ставится поселение») `foundCity` передаёт
   * `allowAccess=false`, так что доступ региона пропускается целиком и цена берётся только со
   * склада/рынка; `growCity` (уже существующий город) продолжает использовать доступ как обычно. */
  private planFoodSpend(playerId: number, source: { id: number; regionCol: number; regionRow: number }, slots: number, requireDistinct: boolean, allowAccess: boolean = true): SpendPlanItem[] | null {
    const chosenTypes = new Set<ResourceId>();
    const plan: SpendPlanItem[] = [];
    let moneyBudget = this.money[playerId];

    // Список НЕ обрезан лимитом населения заранее (никакого capToCity) — лимит соблюдается ниже,
    // при выборе, чтобы бюджет города не расходовался на тип, который для этой оплаты не годится
    // (см. accessBudgetFor).
    const accessCandidates: { resource: ResourceId }[] = [];
    let accessBudget = 0;
    if (allowAccess) {
      accessBudget = this.accessBudgetFor(source.id);
      for (const r of new Set(this.resourcesInRegion(source.regionCol, source.regionRow, playerId))) {
        if (GameSession.RESOURCE_META.get(r)!.category !== "food") continue;
        if (!this.resourceIsExtractable(playerId, r)) continue;
        if (this.accessUsed.has(`${source.id}:${r}`)) continue;
        accessCandidates.push({ resource: r });
      }
    }
    // Промтовары — джокер (по прямому уточнению), еда в исключённую тройку (уран/углеводороды/
    // электричество) не входит, так что здесь тоже годится наравне с настоящей едой.
    const isFoodOrJoker = this.matchWithJoker((id) => GameSession.RESOURCE_META.get(id)!.category === "food");
    const warehouseCandidates = (Object.entries(this.effectiveWarehouseFor(playerId)) as [ResourceId, number][])
      .filter(([id, qty]) => qty > 0 && isFoodOrJoker(id))
      .map(([id]) => id);
    const marketCandidates = this.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId && isFoodOrJoker(l.resource!))
      .sort((a, b) => a.price - b.price);

    for (let i = 0; i < slots; i++) {
      const okType = (r: ResourceId) => !requireDistinct || !chosenTypes.has(r);
      // Каждый доступ = один новый тип, обработанный городом в этом цикле, — не больше, чем
      // позволяет население (accessBudget).
      const accessPick = accessBudget > 0 ? accessCandidates.find((a) => okType(a.resource)) : undefined;
      if (accessPick) {
        plan.push({ resource: accessPick.resource, source: "access", cityId: source.id });
        chosenTypes.add(accessPick.resource);
        accessCandidates.splice(accessCandidates.indexOf(accessPick), 1);
        accessBudget--;
        continue;
      }
      const whPick = warehouseCandidates.find((r) => okType(r));
      if (whPick) {
        plan.push({ resource: whPick, source: "warehouse" });
        chosenTypes.add(whPick);
        warehouseCandidates.splice(warehouseCandidates.indexOf(whPick), 1);
        continue;
      }
      const mPick = marketCandidates.find((l) => okType(l.resource!) && l.price <= moneyBudget);
      if (mPick) {
        plan.push({ resource: mPick.resource!, source: "market", listingId: mPick.id });
        chosenTypes.add(mPick.resource!);
        moneyBudget -= mPick.price;
        marketCandidates.splice(marketCandidates.indexOf(mPick), 1);
        continue;
      }
      return null;
    }
    return plan;
  }

  /** Человекочитаемое объяснение отказа planFoodSpend (по прямому запросу — «нужна подсказка, которая
   * явно объяснит игроку, почему добыча не удалась») — раньше просто говорило «не набралось N видов
   * пищи», не упоминая ПОЧЕМУ: город обрабатывает не больше `population` НОВЫХ типов ресурса за весь
   * ЦИКЛ (ТЗ 7.2), а не за это конкретное действие — лимит общий на все траты города за цикл, так что
   * даже нетронутые типы в регионе могут быть недоступны, если бюджет уже потрачен на что-то другое
   * (не обязательно на еду — здание/юнит/исследование тоже расходуют тот же бюджет). */
  private explainFoodShortfall(city: City, slots: number, requireDistinct: boolean): string {
    const usedTypes = [...this.accessUsed].filter((k) => k.startsWith(`${city.id}:`)).map((k) => k.split(":")[1] as ResourceId);
    const usedLabel = usedTypes.length ? usedTypes.map((r) => GameSession.RESOURCE_META.get(r)?.label ?? r).join(", ") : "ничего";
    const need = requireDistinct ? `${slots} разных видов пищи` : `${slots} пищевых ресурсов (не обязательно разных)`;
    return (
      `Нужно ${need} для города — этого не набралось. ` +
      `Город обрабатывает не больше ${city.population} НОВЫХ типов ресурса за весь текущий цикл (не за это действие, ТЗ 7.2) — ` +
      `в этом цикле уже занято: ${usedLabel} (${usedTypes.length}/${city.population}). ` +
      `Остальные типы региона освободятся только со следующего цикла; сейчас можно взять недостающее только со склада или рынка, если там есть еда.`
    );
  }

  private commitSpend(playerId: number, plan: SpendPlanItem[]) {
    for (const item of plan) {
      if (item.source === "access") {
        this.accessUsed.add(`${item.cityId}:${item.resource}`);
      } else if (item.source === "warehouse") {
        this.takeFromWarehouse(playerId, item.resource, 1);
      } else {
        const listing = this.market.find((l) => l.id === item.listingId);
        if (!listing) continue;
        this.money[playerId] -= listing.price;
        if (listing.sellerId !== WORLD_SELLER) this.money[listing.sellerId] += listing.price;
        this.market.splice(this.market.indexOf(listing), 1);
        // Тот же авто-возобновляемый лот, что и в buyListing — цена этих 6 постоянных ресурсов
        // растёт с любой покупкой, включая автоматическую (оплата цены здания/юнита/исследования).
        if (listing.sellerId === WORLD_SELLER && listing.kind === "resource" && GameSession.WORLD_MARKET_RESOURCES.includes(listing.resource!)) {
          this.market.push({ id: this.nextListingId++, sellerId: WORLD_SELLER, kind: "resource", resource: listing.resource!, price: listing.price + GameSession.WORLD_MARKET_PRICE_STEP });
        }
      }
    }
  }

  /** Обобщение planFoodSpend на произвольные требования (цена юнита по эпохе, 7.1). */
  private planResourceSpend(playerId: number, source: { id: number; regionCol: number; regionRow: number }, reqs: { label: string; match: (id: ResourceId) => boolean }[]): SpendPlanItem[] | null {
    const plan: SpendPlanItem[] = [];
    let moneyBudget = this.money[playerId];
    // Без предварительной обрезки лимитом населения — лимит соблюдается при выборе (accessBudget),
    // см. accessBudgetFor: иначе бюджет города тратился бы на негодный для этой цены тип.
    let accessBudget = this.accessBudgetFor(source.id);
    const accessCandidates: { resource: ResourceId }[] = [];
    for (const r of new Set(this.resourcesInRegion(source.regionCol, source.regionRow, playerId))) {
      if (!this.resourceIsExtractable(playerId, r)) continue;
      if (this.accessUsed.has(`${source.id}:${r}`)) continue;
      accessCandidates.push({ resource: r });
    }
    const warehouseCandidates: ResourceId[] = [];
    for (const [id, qty] of Object.entries(this.effectiveWarehouseFor(playerId)) as [ResourceId, number][]) {
      for (let i = 0; i < qty; i++) warehouseCandidates.push(id);
    }
    const marketCandidates = this.market.filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId).sort((a, b) => a.price - b.price);

    for (const req of reqs) {
      const match = this.matchWithJoker(req.match);
      const aIdx = accessBudget > 0 ? accessCandidates.findIndex((a) => match(a.resource)) : -1;
      if (aIdx >= 0) {
        accessBudget--;
        const a = accessCandidates.splice(aIdx, 1)[0];
        plan.push({ resource: a.resource, source: "access", cityId: source.id });
        continue;
      }
      const wIdx = warehouseCandidates.findIndex((r) => match(r));
      if (wIdx >= 0) {
        const r = warehouseCandidates.splice(wIdx, 1)[0];
        plan.push({ resource: r, source: "warehouse" });
        continue;
      }
      const mIdx = marketCandidates.findIndex((l) => match(l.resource!) && l.price <= moneyBudget);
      if (mIdx >= 0) {
        const l = marketCandidates.splice(mIdx, 1)[0];
        moneyBudget -= l.price;
        plan.push({ resource: l.resource!, source: "market", listingId: l.id });
        continue;
      }
      return null;
    }
    return plan;
  }

  // === Города/Поселенец (ТЗ 3.1.1) ================================================================

  foundCity(playerId: number, slotIndex: number, clickCol: number, clickRow: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "settler" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Поселенец» недоступна в этом слоте." };
    const rc = Math.floor(clickCol / REGION_SIZE_X);
    const rr = Math.floor(clickRow / REGION_SIZE_Y);
    if (!this.isInhabitedRegion(rc, rr)) return { ok: false, hint: "Регион непригоден для поселения — нужно ≥3 тайлов суши." };
    if (!this.regionHasFoundableTile(rc, rr)) return { ok: false, hint: "Вся суша этого региона подо льдом — город здесь поставить нельзя." };
    if (this.regionHasAnyCity(rc, rr)) return { ok: false, hint: "В этом регионе уже есть город — только 1 город на регион." };
    if (this.regionHasEnemyUnit(rc, rr, playerId)) return { ok: false, hint: "В этом регионе стоит вражеский юнит — сначала выбейте его или найдите другой регион." };
    if (!this.playerHasCityAdjacentTo(playerId, rc, rr)) return { ok: false, hint: "Регион должен примыкать к одному из ваших городов." };

    const newCityId = this.nextCityId;
    const plan = this.planFoodSpend(playerId, { id: newCityId, regionCol: rc, regionRow: rr }, 1, false, false);
    if (!plan) return { ok: false, hint: "Нет ни одного пищевого ресурса на складе или рынке — региона, куда ставится город, это не касается: там ещё нет инфраструктуры добычи." };

    const { col, row } = this.landTileForRegion(rc, rr, clickCol, clickRow);
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
    this.nextCityId++;
    const newCity: City = { id: newCityId, playerId, regionCol: rc, regionRow: rr, col, row, population: 1, isCapital: false };
    this.cities.push(newCity);
    this.clearForestUnderCity(newCity);

    this.checkTerritorialVictory(playerId);
    return { ok: true };
  }

  /** Общая точка объявления победы (по прямому запросу — «дашборд результатов с типом победы») —
   * держит `winner`/`winnerType` синхронными на всех путях победы разом, не только territorial.
   * Не перезаписывает уже объявленную победу (первый победитель остаётся первым). */
  private declareVictory(playerId: number, type: string) {
    if (this.winner !== null) return;
    this.winner = playerId;
    this.winnerType = type;
  }

  /** [ИСПРАВЛЕНО] Территориальная победа (9-й город, ТЗ §9/§13) раньше проверялась ТОЛЬКО при
   * основании нового города («Поселенец») — захват чужого города войной (walkUnitAlongOrder) или
   * мирная передача по дипломатии (giveCity/demandCity) тоже могут довести игрока до 9 городов, но
   * победу не объявляли. Вызывается из foundCity И transferCity — единственных двух мест, что могут
   * увеличить число городов игрока. */
  private checkTerritorialVictory(playerId: number) {
    if (this.cities.filter((c) => c.playerId === playerId).length >= GameSession.MAX_CITIES + 1) {
      this.declareVictory(playerId, `Территориальная победа — ${GameSession.MAX_CITIES + 1}-й город`);
    }
  }

  /** Поселенец's grow branch AND the event card «Население» — same mechanic (pay N distinct food
   * types, N = city's population), portированный из tryGrowCity/startSettlerGrow/startPopulationGrow.
   * `pendingCardAction`'s `citiesLeft`/`grownCityIds` (Монотеизм lets one play grow 2 DIFFERENT
   * cities) collapse into a single call taking every target city up front — `cityIds.length` must be
   * 1, or 2 only under Монотеизм — rather than main.ts's two separate sequential clicks, since this
   * class of action never mutates state on a failure path (see class doc). To stay atomic across
   * potentially-shared warehouse/market resources between the two cities, this snapshots and rolls
   * back if the second city's plan fails after the first already committed. */
  /** Технологии «Вместимость города N → N+1» (Технологии.md) — по прямому запросу («красный без
   * Каменной кладки увеличил население до 2 — проверка не работает?») здесь раньше не было вообще
   * никакой проверки, `growCity` просто безусловно инкрементировал население. Базовая вместимость 1
   * без технологий; каждая из 5 добавляет +1, независимо друг от друга (не обязательно по порядку —
   * хотя по дереву технологий именно так и получится, раз это одна и та же ветка). */
  private static CITY_CAPACITY_TECHS = ["Каменная кладка", "Стандартизация", "Городское планирование", "Медицина", "Космонавтика"];
  private cityCapacityFor(playerId: number): number {
    return 1 + GameSession.CITY_CAPACITY_TECHS.filter((t) => this.researchedTechs[playerId].has(t)).length;
  }
  growCity(playerId: number, slotIndex: number, cityIds: number[]): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || (card.id !== "settler" && card.id !== "population") || this.actionsLeft[playerId] <= 0) {
      return { ok: false, hint: "Эта карта недоступна для роста населения в этом слоте." };
    }
    const maxCities = this.playerParadigm[playerId] === "monotheism" ? 2 : 1;
    const uniqueIds = [...new Set(cityIds)];
    if (uniqueIds.length < 1 || uniqueIds.length > maxCities) return { ok: false, hint: `Нужно выбрать от 1 до ${maxCities} город(ов).` };
    const targets: City[] = [];
    const capacity = this.cityCapacityFor(playerId);
    for (const id of uniqueIds) {
      const city = this.cities.find((c) => c.id === id && c.playerId === playerId);
      if (!city) return { ok: false, hint: "Можно увеличивать население только в своих городах." };
      if (city.population >= capacity) return { ok: false, hint: `Вместимость города исчерпана (${capacity}) — нужна следующая технология вместимости («Каменная кладка»/«Стандартизация»/…), чтобы расти дальше.` };
      targets.push(city);
    }

    const accessSnapshot = new Set(this.accessUsed);
    const warehouseSnapshot = { ...this.warehouse[playerId] };
    const marketSnapshot = this.market.slice();
    const moneySnapshot = this.money[playerId];
    for (const city of targets) {
      const plan = this.planFoodSpend(playerId, city, city.population, true);
      if (!plan) {
        replaceSet(this.accessUsed, [...accessSnapshot]);
        this.warehouse[playerId] = warehouseSnapshot;
        this.market = marketSnapshot;
        this.money[playerId] = moneySnapshot;
        return { ok: false, hint: this.explainFoodShortfall(city, city.population, true) };
      }
      this.commitSpend(playerId, plan);
      city.population++;
    }
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** «Рост леса», positive branch (ТЗ 3.2.4) — портирован из tryPlantForest. Pay 2 food (any
   * type(s), not required distinct), plant forest on the clicked hex. Scoped to whichever of the
   * player's own cities owns that hex's region. */
  plantForest(playerId: number, slotIndex: number, clickCol: number, clickRow: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "forestGrowth" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Рост леса» недоступна в этом слоте." };
    const rc = Math.floor(clickCol / REGION_SIZE_X);
    const rr = Math.floor(clickRow / REGION_SIZE_Y);
    const city = this.cityAtRegion(rc, rr);
    if (!city || city.playerId !== playerId) return { ok: false, hint: "Сажать лес можно только на своей территории — в регионе со своим городом." };
    const tile = this.doc.get(clickCol, clickRow);
    if (!TERRAIN_BY_ID[tile.terrain].canHaveForest || tile.forest) return { ok: false, hint: "Здесь нельзя посадить лес — нужна Равнина или Холмы без леса." };
    const plan = this.planFoodSpend(playerId, city, 2, false);
    if (!plan) return { ok: false, hint: this.explainFoodShortfall(city, 2, false) };
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
    this.doc.set(clickCol, clickRow, { forest: true });
    // «Зелёная повестка» (ООН, ТЗ §15.3 — «эффект удваивается») — карта здесь всегда сажает ровно 1
    // гекс (оверлей, не количество), поэтому удвоение реализовано как ВТОРОЙ гекс леса, посаженный
    // автоматически в том же регионе (случайный подходящий, не выбираемый игроком) — трактовка не
    // расписана явно на своём шаге, единственный разумный смысл «удвоения» для этой механики.
    if (this.oonGreenAgendaActive) {
      const extra: { col: number; row: number }[] = [];
      for (let dx = 0; dx < REGION_SIZE_X; dx++) {
        for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
          const col = rc * REGION_SIZE_X + dx;
          const row = rr * REGION_SIZE_Y + dy;
          if (col === clickCol && row === clickRow) continue;
          const t = this.doc.get(col, row);
          if (TERRAIN_BY_ID[t.terrain].canHaveForest && !t.forest) extra.push({ col, row });
        }
      }
      if (extra.length) {
        const pick = extra[Math.floor(this.rng() * extra.length)];
        this.doc.set(pick.col, pick.row, { forest: true });
      }
    }
    return { ok: true };
  }

  /** «Рост леса», второе применение — по прямому запросу, доступно только игрокам с «Генная
   * инженерия»: вместо посадки леса за 2 еды из региона города берёт 1 ЛЮБОЙ пищевой ресурс СО
   * СКЛАДА (игрок сам выбирает тип) и кладёт его на подходящий пустой гекс своей территории —
   * «возвращая ресурсы на карту». Терраин должен соответствовать типу ресурса (requiresWater →
   * открытая вода, иначе любая незаледенелая суша), на гексе ещё не должно быть ресурса. Тот же
   * card+action расход, что у обычной посадки леса — альтернативное применение той же карты. */
  growResourceOnHex(playerId: number, slotIndex: number, clickCol: number, clickRow: number, resource: ResourceId): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "forestGrowth" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Рост леса» недоступна в этом слоте." };
    if (!this.researchedTechs[playerId].has("Генная инженерия")) return { ok: false, hint: "Нужна технология «Генная инженерия»." };
    const meta = GameSession.RESOURCE_META.get(resource);
    if (!meta || meta.category !== "food") return { ok: false, hint: "Вырастить можно только пищевой ресурс." };
    if ((this.warehouse[playerId]?.[resource] ?? 0) < 1) return { ok: false, hint: `На складе нет «${meta.label}».` };
    const rc = Math.floor(clickCol / REGION_SIZE_X);
    const rr = Math.floor(clickRow / REGION_SIZE_Y);
    const city = this.cityAtRegion(rc, rr);
    if (!city || city.playerId !== playerId) return { ok: false, hint: "Выращивать можно только на своей территории — в регионе со своим городом." };
    const tile = this.doc.get(clickCol, clickRow);
    if (tile.resource) return { ok: false, hint: "На этом гексе уже есть ресурс." };
    if (tile.terrain === "iceOcean" || tile.iceCover) return { ok: false, hint: "На льду ничего не растёт." };
    if (meta.requiresWater ? tile.terrain !== "ocean" : tile.terrain === "ocean") {
      return { ok: false, hint: `«${meta.label}» ${meta.requiresWater ? "можно вырастить только на открытой воде" : "можно вырастить только на суше"}.` };
    }
    this.takeFromWarehouse(playerId, resource, 1);
    this.doc.set(clickCol, clickRow, { resource });
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** «Рост леса», negative branch — only via forced discard (resolveHandOverflowDiscard) — портирован
   * из degradeForestOrLand. Scoped to the player's own territory (all regions with one of their
   * cities). Uses this.rng(), never Math.random(). */
  private degradeForestOrLand(playerId: number): string {
    const myRegions = new Set(this.cities.filter((c) => c.playerId === playerId).map((c) => `${c.regionCol},${c.regionRow}`));
    const forestTiles: { col: number; row: number }[] = [];
    const plainsTiles: { col: number; row: number }[] = [];
    for (const key of myRegions) {
      const [rc, rr] = key.split(",").map(Number);
      for (let dx = 0; dx < REGION_SIZE_X; dx++) {
        for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
          const col = rc * REGION_SIZE_X + dx;
          const row = rr * REGION_SIZE_Y + dy;
          const t = this.doc.get(col, row);
          if (t.forest) forestTiles.push({ col, row });
          else if (t.terrain === "plains") plainsTiles.push({ col, row });
        }
      }
    }
    if (forestTiles.length) {
      const pick = forestTiles[Math.floor(this.rng() * forestTiles.length)];
      this.doc.set(pick.col, pick.row, { forest: false });
      return "лес на одном гексе вашей территории вырублен.";
    }
    if (!plainsTiles.length) return "деградировать было нечего — ни леса, ни равнин на вашей территории.";
    const pick = plainsTiles[Math.floor(this.rng() * plainsTiles.length)];
    const hadResource = this.doc.get(pick.col, pick.row).resource;
    this.doc.set(pick.col, pick.row, { terrain: "desert", resource: undefined });
    return hadResource
      ? `гекс равнины превращён в пустыню, ресурс «${GameSession.RESOURCE_META.get(hadResource)!.label}» исчез с карты.`
      : "гекс равнины превращён в пустыню.";
  }

  // === Катаклизмы (ТЗ §15.1 — эффект сброса «Учёного») ===========================================

  private static CATACLYSM_TYPES = ["iceMelt", "volcano", "degradation", "pandemic", "resourceDepletion", "earthquake"] as const;
  private static CATACLYSM_LABEL: Record<(typeof GameSession.CATACLYSM_TYPES)[number], string> = {
    iceMelt: "Таяние льдов",
    volcano: "Извержение вулкана",
    degradation: "Деградация",
    pandemic: "Пандемия",
    resourceDepletion: "Истощение ресурсов",
    earthquake: "Землетрясение",
  };
  private static DEGRADE_CHAIN: Partial<Record<TerrainId, TerrainId>> = {
    mountains: "hills",
    hills: "plains",
    plains: "desert",
    desert: "ocean",
  };

  /** Топит гекс вместе со всем, что на нём стоит (ТЗ §15.1, «Таяние льдов»/«Деградация» → пустыня →
   * море) — уничтожает город, если он там был (`destroyCity`, снимает и висящую после нeё запись
   * `ruins` — тайл уходит под воду, а не остаётся сушей с руинами), топит юнитов без исключений. */
  private sinkTileUnderwater(col: number, row: number) {
    const city = this.cityAt(col, row);
    if (city) this.destroyCity(city);
    this.units = this.units.filter((u) => !(u.col === col && u.row === row));
    this.doc.set(col, row, { terrain: "ocean", resource: undefined, forest: false, iceCover: false, volcano: false });
    this.ruins = this.ruins.filter((r) => !(r.col === col && r.row === row));
  }

  /** 1. Таяние льдов — ДВА независимых эффекта разом (прямое уточнение — «и лёд тает, и пустыня
   * тонет», не альтернатива): полярный лёд тает (iceOcean → ocean, либо тундра под льдом
   * открывается), И ОТДЕЛЬНО случайный гекс пустыни уходит под воду вместе со всем, что на нём. */
  private cataclysmIceMelt(): string {
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const iceCandidates: { col: number; row: number; kind: "ocean" | "cover" }[] = [];
    const desertCandidates: { col: number; row: number }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        const t = this.doc.get(col, row);
        if (t.terrain === "iceOcean") iceCandidates.push({ col, row, kind: "ocean" });
        else if (t.terrain === "tundra" && t.iceCover) iceCandidates.push({ col, row, kind: "cover" });
        else if (t.terrain === "desert") desertCandidates.push({ col, row });
      }
    }
    const parts: string[] = [];
    if (iceCandidates.length) {
      const pick = iceCandidates[Math.floor(this.rng() * iceCandidates.length)];
      if (pick.kind === "ocean") {
        this.doc.set(pick.col, pick.row, { terrain: "ocean" });
        parts.push("гекс полярной шапки растаял в море");
      } else {
        this.doc.set(pick.col, pick.row, { iceCover: false });
        parts.push("лёд над тундрой растаял, тундра открылась");
      }
    } else parts.push("полярного льда на карте не осталось — таять нечему");
    if (desertCandidates.length) {
      const pick = desertCandidates[Math.floor(this.rng() * desertCandidates.length)];
      this.sinkTileUnderwater(pick.col, pick.row);
      parts.push("гекс пустыни ушёл под воду вместе со всем, что на нём было");
    } else parts.push("пустыни на карте не осталось — тонуть нечему");
    return parts.join("; ") + ".";
  }

  /** 2. Извержение вулкана — случайная НЕвулканическая Гора становится вулканом (оверлей, см.
   * mapDoc.ts `volcano`): ресурс снимается, гекс непроходим (`unitPassable`). Гор без вулкана не
   * осталось — случайные Холмы становятся новыми Горами (могут стать вулканом в будущем). */
  private cataclysmVolcano(): string {
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const mountainCandidates: { col: number; row: number }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        const t = this.doc.get(col, row);
        if (t.terrain === "mountains" && !t.volcano) mountainCandidates.push({ col, row });
      }
    }
    if (mountainCandidates.length) {
      const pick = mountainCandidates[Math.floor(this.rng() * mountainCandidates.length)];
      this.doc.set(pick.col, pick.row, { volcano: true, resource: undefined });
      return "гора превратилась в вулкан — ресурс уничтожен, гекс непроходим.";
    }
    const hillsCandidates: { col: number; row: number }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        if (this.doc.get(col, row).terrain === "hills") hillsCandidates.push({ col, row });
      }
    }
    if (!hillsCandidates.length) return "гор и холмов на карте не осталось — извергаться нечему.";
    const pick = hillsCandidates[Math.floor(this.rng() * hillsCandidates.length)];
    this.doc.set(pick.col, pick.row, { terrain: "mountains", forest: false });
    return "гор без вулкана не осталось — случайные холмы превратились в новые горы.";
  }

  /** 3. Деградация — случайный гекс суши: лес есть → лес исчезает; леса нет → рельеф деградирует на
   * 1 ступень по цепочке Горы → Холмы → Равнина → Пустыня → Море (затопление — как «Таяние льдов»,
   * см. `sinkTileUnderwater`). Тундра в цепочку не входит (не уточнено на своём шаге) — эффекта нет. */
  private cataclysmDegradation(): string {
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const candidates: { col: number; row: number }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        if (this.isLandTile(col, row)) candidates.push({ col, row });
      }
    }
    if (!candidates.length) return "суши на карте не осталось — деградировать нечего.";
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    const t = this.doc.get(pick.col, pick.row);
    if (t.forest) {
      this.doc.set(pick.col, pick.row, { forest: false });
      return "лес на случайном гексе исчез.";
    }
    const next = GameSession.DEGRADE_CHAIN[t.terrain];
    if (!next) return "выпавший гекс не деградирует по этой цепочке — эффекта нет.";
    if (next === "ocean") {
      this.sinkTileUnderwater(pick.col, pick.row);
      return "гекс пустыни затоплен вместе со всем, что на нём было.";
    }
    const hadResource = t.resource;
    this.doc.set(pick.col, pick.row, { terrain: next, resource: undefined, volcano: false });
    return `гекс деградировал: ${TERRAIN_BY_ID[t.terrain].label} → ${TERRAIN_BY_ID[next].label}${hadResource ? `, ресурс «${GameSession.RESOURCE_META.get(hadResource)!.label}» исчез` : ""}.`;
  }

  /** 4. Пандемия — случайный город ЛЮБОГО игрока теряет 1 населения, не ниже 1 (не убивает город
   * сама по себе — отдельно от `applyDiscardPopulationLoss`, у которой нижней границы нет). */
  private cataclysmPandemic(): string {
    if (!this.cities.length) return "городов на карте нет — эпидемии некого поразить.";
    const pick = this.cities[Math.floor(this.rng() * this.cities.length)];
    if (pick.population <= 1) return "выпавший город уже на минимуме населения — эффекта нет.";
    pick.population -= 1;
    const owner = this.players.find((p) => p.id === pick.playerId);
    return `город игрока «${owner?.name ?? pick.playerId}» теряет 1 населения (пандемия).`;
  }

  /** 5. Истощение ресурсов — 1 случайный ресурс (конкретный экземпляр на тайле, не весь тип) исчезает. */
  private cataclysmResourceDepletion(): string {
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const candidates: { col: number; row: number; resource: ResourceId }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        const r = this.doc.get(col, row).resource;
        if (r) candidates.push({ col, row, resource: r });
      }
    }
    if (!candidates.length) return "ресурсов на карте не осталось — истощать нечего.";
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    this.doc.set(pick.col, pick.row, { resource: undefined });
    return `ресурс «${GameSession.RESOURCE_META.get(pick.resource)!.label}» исчез с карты.`;
  }

  /** 6. Землетрясение — случайный РЕГИОН (включая морские и необитаемые). Здания рушатся, только
   * если задет регион СТОЛИЦЫ игрока (прямое уточнение — снимает вопрос «здания привязаны к игроку/
   * столице, не к городу»); город в регионе (любой, не только столица) теряет 1 населения, если его
   * размер больше 1. Возвращает задетый регион отдельно (`hex`) — main.ts анимирует тряску по нему. */
  private cataclysmEarthquake(): { text: string; hex: { col: number; row: number } } {
    const rc = Math.floor(this.rng() * REGION_GRID_W);
    const rr = Math.floor(this.rng() * REGION_GRID_H);
    const hex = { col: rc * REGION_SIZE_X, row: rr * REGION_SIZE_Y };
    const city = this.cityAtRegion(rc, rr);
    if (!city) return { text: `землетрясение в необитаемом регионе (${rc + 1}.${rr + 1}) — эффекта на постройки/население нет.`, hex };
    const parts: string[] = [`землетрясение в регионе (${rc + 1}.${rr + 1})`];
    if (city.isCapital) {
      const owned = builtBy(this.buildingOwners, city.playerId);
      for (const b of owned) this.buildingOwners[b.id].splice(this.buildingOwners[b.id].indexOf(city.playerId), 1);
      parts.push(owned.length ? `в столице — все её здания разрушены (${owned.length})` : "в столице, но зданий там не было");
    }
    if (city.population > 1) {
      city.population -= 1;
      parts.push("город теряет 1 населения");
    }
    return { text: parts.join(", ") + ".", hex };
  }

  private applyOneCataclysm(type: (typeof GameSession.CATACLYSM_TYPES)[number]): { text: string; hex?: { col: number; row: number } } {
    switch (type) {
      case "iceMelt":
        return { text: this.cataclysmIceMelt() };
      case "volcano":
        return { text: this.cataclysmVolcano() };
      case "degradation":
        return { text: this.cataclysmDegradation() };
      case "pandemic":
        return { text: this.cataclysmPandemic() };
      case "resourceDepletion":
        return { text: this.cataclysmResourceDepletion() };
      case "earthquake":
        return this.cataclysmEarthquake();
    }
  }

  /** Разыгрывает всю пачку катаклизмов ЗА ОДИН сброшенный «Учёный» (ТЗ §15.1) — count = текущая
   * максимальная эпоха сбросившего игрока (`playerEpoch`). Каждый бросок — независимый случайный
   * выбор одного из 6 видов, повторы разрешены (прямое уточнение — «в том и фишка»). Магнитуда
   * эффекта КАЖДОГО выпавшего вида = эпоха × сколько раз именно этот вид выпал в этой пачке (прямое
   * уточнение) — реализовано как «применить однократный эффект этого вида МАГНИТУДА раз подряд»,
   * единая трактовка для всех 6 видов (как именно каждый вид масштабируется по числу применений —
   * не расписано отдельно на своём шаге, единый принцип счёл достаточным). Эффекты глобальные — не
   * только для сбросившего игрока, см. `applyOneCataclysm`/сами функции катаклизмов. */
  private resolveCataclysmBatch(playerId: number): { log: string[]; earthquakeHexes: { col: number; row: number }[] } {
    const epoch = this.playerEpoch(playerId);
    const rolls: (typeof GameSession.CATACLYSM_TYPES)[number][] = [];
    for (let i = 0; i < epoch; i++) {
      rolls.push(GameSession.CATACLYSM_TYPES[Math.floor(this.rng() * GameSession.CATACLYSM_TYPES.length)]);
    }
    const occurrences = new Map<(typeof GameSession.CATACLYSM_TYPES)[number], number>();
    for (const t of rolls) occurrences.set(t, (occurrences.get(t) ?? 0) + 1);
    const log: string[] = [];
    const earthquakeHexes: { col: number; row: number }[] = [];
    for (const [type, count] of occurrences) {
      const magnitude = epoch * count;
      const lines: string[] = [];
      for (let i = 0; i < magnitude; i++) {
        const result = this.applyOneCataclysm(type);
        lines.push(result.text);
        if (result.hex) earthquakeHexes.push(result.hex);
      }
      log.push(`${GameSession.CATACLYSM_LABEL[type]} ×${count} (магнитуда ${magnitude}): ${lines.join(" ")}`);
    }
    return { log, earthquakeHexes };
  }

  // === Ресурсы: Рабочий/Склад/Торговец (ТЗ 3.1.2/3.1.3/3.1.6) ====================================

  /** Each ×2 tech is independent and stacks multiplicatively (портирован из extractionMultiplier).
   * [ИСПРАВЛЕНО] Больше НЕ множитель количества за одну добычу — по прямому уточнению «удвоенная
   * добыча не даёт ×2 за раз, а позволяет 1 ресурс добыть дважды за цикл, и каждый раз это тратит
   * свой слот лимита населения» (раньше `qty = extractionMultiplier(...)` мгновенно удваивал
   * количество ОДНИМ слотом бюджета — население 1 могло получить 2 единицы за один пик, что и
   * обходило лимит §7.2). Теперь это значение читает `maxHarvestsOf` ниже: обычный тип — максимум 1
   * раз за цикл, как и раньше, удвоенный технологией — максимум 2 раза, каждый раз ровно 1 единица. */
  private extractionMultiplier(playerId: number, id: ResourceId): number {
    const meta = GameSession.RESOURCE_META.get(id)!;
    const has = (tech: string) => this.researchedTechs[playerId].has(tech);
    let mult = 1;
    if (has("Гончарное дело") && (id === "grain" || id === "vegetables" || id === "fruit")) mult *= 2;
    if (has("Навигация") && meta.requiresWater) mult *= 2;
    if (has("Индустриализация") && meta.category === "strategic") mult *= 2;
    if (has("Гильдии") && meta.category === "trade") mult *= 2;
    if (has("Генная инженерия") && meta.category === "food") mult *= 2;
    return mult;
  }

  /** Максимум добыч этого типа В ЭТОМ ГОРОДЕ за один цикл — 1 обычно, 2 при действующей технологии
   * удвоения (см. extractionMultiplier). */
  private maxHarvestsOf(playerId: number, resource: ResourceId): number {
    return this.extractionMultiplier(playerId, resource) >= 2 ? 2 : 1;
  }
  /** Сколько раз этот тип УЖЕ добыт в этом городе в этом цикле (0, 1 или 2) — второе использование
   * помечается ОТДЕЛЬНЫМ ключом `${cityId}:${resource}:2` поверх обычного `${cityId}:${resource}`
   * в том же `accessUsed`: любой другой потребитель accessUsed (оплата карт доступом,
   * tradeNetworkOf/traderTrade) проверяет только обычный ключ и не подозревает о существовании
   * второго — для них ничего не меняется, доступ к типу «занят» после первого же использования, как
   * и раньше. `accessTypesUsedThisCycle` считает ОБА ключа (оба начинаются с `${cityId}:`), так что
   * второе использование честно тратит ещё один слот лимита населения (ТЗ §7.2). */
  private harvestsUsed(cityId: number, resource: ResourceId): number {
    let n = 0;
    if (this.accessUsed.has(`${cityId}:${resource}`)) n++;
    if (this.accessUsed.has(`${cityId}:${resource}:2`)) n++;
    return n;
  }
  /** Помечает ОДНУ новую добычу этого типа — первую (базовый ключ) или вторую (`:2`), смотря что уже
   * занято. Вызывать только для ДЕЙСТВИТЕЛЬНО новых добыч этого действия (не для «бесплатного»
   * повторного подтверждения уже использованных слотов — см. вызовы ниже, alreadyUsed=true их
   * пропускает). */
  private markHarvestUsedOnce(cityId: number, resource: ResourceId) {
    const base = `${cityId}:${resource}`;
    if (!this.accessUsed.has(base)) {
      this.accessUsed.add(base);
      return;
    }
    this.accessUsed.add(`${base}:2`);
  }

  /** Everything a region would yield right now — портирован из collectibleResourcesIn, теперь по
   * слотам (см. maxHarvestsOf/harvestsUsed), не по qty-множителю. Уже занятые в этом цикле слоты
   * (alreadyUsed) добавляются в результат БЕСПЛАТНО (повторное подтверждение, тот же принцип, что
   * был и раньше), новые — только пока хватает лимита населения города. Shared by «Рабочий» (free)
   * and Склад's paid version below. */
  private collectibleResourcesIn(playerId: number, city: City): { resource: ResourceId; alreadyUsed: boolean }[] {
    const out: { resource: ResourceId; alreadyUsed: boolean }[] = [];
    let budget = this.accessBudgetFor(city.id);
    for (const r of new Set(this.resourcesInRegion(city.regionCol, city.regionRow, playerId))) {
      if (!this.resourceIsExtractable(playerId, r)) continue;
      const used = this.harvestsUsed(city.id, r);
      const max = this.maxHarvestsOf(playerId, r);
      for (let slot = 0; slot < used; slot++) out.push({ resource: r, alreadyUsed: true });
      for (let slot = used; slot < max && budget > 0; slot++) {
        out.push({ resource: r, alreadyUsed: false });
        budget--;
      }
    }
    return out;
  }

  /** Нераспределённые по лимиту населения кандидаты — портирован для выбора игроком (по прямому
   * уточнению): в отличие от `collectibleResourcesIn`, НЕ применяет лимит населения сам (это раньше
   * молча делал `resourcesInRegion`'s capToCity, в порядке сканирования тайлов региона — из-за чего,
   * например, морские ресурсы могли не попасть в добычу просто потому, что земные раньше встретились
   * при сканировании, а не из-за нехватки технологии). Уже добытые в этом цикле СЛОТЫ (alreadyUsed)
   * бюджета не расходуют — по одной записи на КАЖДЫЙ слот (см. maxHarvestsOf/harvestsUsed): обычный
   * тип отдаёт 1 запись, удвоенный технологией — 2 (одна уже занятая + одна ещё свободная, либо обе
   * свободные, либо обе уже заняты — смотря сколько раз его уже добывали в этом цикле). */
  private uncappedCollectibleCandidatesIn(playerId: number, city: City): { resource: ResourceId; alreadyUsed: boolean }[] {
    const out: { resource: ResourceId; alreadyUsed: boolean }[] = [];
    for (const r of new Set(this.resourcesInRegion(city.regionCol, city.regionRow, playerId))) {
      if (!this.resourceIsExtractable(playerId, r)) continue;
      const used = this.harvestsUsed(city.id, r);
      const max = this.maxHarvestsOf(playerId, r);
      for (let slot = 0; slot < max; slot++) out.push({ resource: r, alreadyUsed: slot < used });
    }
    return out;
  }

  /** Рабочий (free — costs the card + 1 action) — портирован из tryWorkerCollect. Если новых (ещё не
   * добытых в этом цикле) типов больше, чем позволяет лимит населения города, выбор — за игроком
   * (`chosenTypes`, по прямому уточнению): без выбора действие возвращает `needsResourceChoice` с
   * бюджетом и вариантами, ничего не тратя и не добывая. */
  workerCollect(playerId: number, slotIndex: number, cityId: number, chosenTypes?: ResourceId[]): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "worker" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Рабочий» недоступна в этом слоте." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Можно собирать ресурсы только в своих городах." };

    const candidates = this.uncappedCollectibleCandidatesIn(playerId, city);
    const alreadyUsed = candidates.filter((c) => c.alreadyUsed);
    const fresh = candidates.filter((c) => !c.alreadyUsed);
    const budget = Math.max(0, city.population - this.accessTypesUsedThisCycle(city.id));

    // [ИСПРАВЛЕНО] fresh — теперь одна ЗАПИСЬ НА КАЖДЫЙ ЕЩЁ СВОБОДНЫЙ СЛОТ (не на тип), поэтому
    // удвоенный технологией тип занимает 2 позиции в этом списке, если он ещё вообще не добывался
    // в этом цикле — по прямому уточнению «удвоенная добыча не даёт ×2 за раз, а позволяет 1 ресурс
    // добыть дважды за цикл, каждый раз тратя свой слот лимита населения».
    let collected: { resource: ResourceId; alreadyUsed: boolean }[];
    if (fresh.length <= budget) {
      collected = candidates;
    } else if (budget <= 0) {
      // Бюджет уже исчерпан в этом цикле (accessTypesUsedThisCycle >= population) — выбирать не из
      // чего, предлагать пустой выбор (budget=0) не нужно: раньше это открывало модалку с ЗАРАНЕЕ
      // отключёнными чекбоксами (по прямому запросу — «не ставится галочка... клик ничего не
      // делает»), хотя по сути там нечего было выбирать. Просто добираем уже использованные типы.
      collected = alreadyUsed;
    } else if (!chosenTypes) {
      return {
        ok: false,
        hint: `В регионе больше новых видов/добыч ресурсов (${fresh.length}), чем позволяет население города (${budget}) — выберите, какие добыть.`,
        // population/usedThisCycle — по прямому запросу показываем в модалке «использовано X из Y»,
        // чтобы игрок видел, какие города в этом цикле уже задействованы, а какие ещё свободны.
        // options может содержать один и тот же тип дважды (удвоенный технологией, ещё ни разу не
        // добытый в этом цикле) — ровно по одному варианту на каждый ещё свободный слот.
        needsResourceChoice: {
          cityId,
          budget,
          options: fresh.map((c) => c.resource),
          population: city.population,
          usedThisCycle: this.accessTypesUsedThisCycle(city.id),
        },
      };
    } else {
      // chosenTypes — теперь мультимножество (один и тот же тип МОЖЕТ повториться дважды, ровно по
      // числу свободных слотов этого типа, которые игрок хочет занять). Проверяем по числу вхождений
      // каждого типа, а не по факту присутствия — раньше `chosenTypes.length === chosenSet.size`
      // прямо запрещало повторы.
      const freshCountByResource = new Map<ResourceId, number>();
      for (const c of fresh) freshCountByResource.set(c.resource, (freshCountByResource.get(c.resource) ?? 0) + 1);
      const chosenCountByResource = new Map<ResourceId, number>();
      for (const r of chosenTypes) chosenCountByResource.set(r, (chosenCountByResource.get(r) ?? 0) + 1);
      const validChosen =
        chosenTypes.length <= budget &&
        [...chosenCountByResource.entries()].every(([r, n]) => n <= (freshCountByResource.get(r) ?? 0));
      if (!validChosen) return { ok: false, hint: "Некорректный выбор ресурсов для добычи." };
      collected = [...alreadyUsed, ...chosenTypes.map((r) => ({ resource: r, alreadyUsed: false }))];
    }

    for (const { resource, alreadyUsed: wasUsed } of collected) {
      if (!wasUsed) this.markHarvestUsedOnce(city.id, resource);
      this.addToWarehouse(playerId, resource, 1);
    }
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** Строитель, альтернативное применение — перенесено с Рабочего по прямому запросу («рабочие
   * очень нужны, тратить их на лес невыгодно — ведёт к нехватке леса»): клик по гексу с лесом на
   * своей территории вырубает его (2 Леса на склад), но теперь не бесплатно, как было у Рабочего —
   * 1 еды за вырубку (доступ региона города → склад → рынок, тот же порядок, что и у planFoodSpend
   * везде ещё). Тот же card+action расход, что и обычная стройка/добыча силикатов — альтернативное
   * применение той же карты «Строитель», не отдельная карта. */
  chopForest(playerId: number, slotIndex: number, col: number, row: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "builder" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Строитель» недоступна в этом слоте." };
    if (!this.doc.get(col, row).forest) return { ok: false, hint: "На этом гексе нет леса." };
    const rc = Math.floor(col / REGION_SIZE_X);
    const rr = Math.floor(row / REGION_SIZE_Y);
    const city = this.cityAtRegion(rc, rr);
    if (!city || city.playerId !== playerId) return { ok: false, hint: "Можно вырубать лес только на своей территории — в регионе со своим городом." };
    const plan = this.planFoodSpend(playerId, city, 1, false);
    if (!plan) return { ok: false, hint: this.explainFoodShortfall(city, 1, false) };
    this.commitSpend(playerId, plan);
    this.doc.set(col, row, { forest: false });
    this.addToWarehouse(playerId, "wood", 2);
    this.consumeHandCard(playerId, slotIndex);
    const cascadeHint = this.cascadeLastForestLoss(rc, rr);
    return { ok: true, hint: cascadeHint ?? undefined };
  }

  /** Вырубка последнего леса в регионе (по прямому уточнению) — если после вырубки в регионе не
   * осталось леса вовсе, случайная равнина региона опустынивается (ресурс на ней, если был, пропадает
   * вместе с ней); равнин в регионе нет — исчезает случайный ресурс где-нибудь в регионе. Только
   * `chopForest` (явная вырубка Строителем) — автоочистка леса под новым городом (clearForestUnderCity)
   * и штрафной эффект сброса карты «Рост леса» (degradeForestOrLand) этот каскад не запускают, по
   * прямому уточнению речь шла именно про вырубку. Uses this.rng(), never Math.random(). */
  private cascadeLastForestLoss(rc: number, rr: number): string | null {
    let hasForest = false;
    const plainsTiles: { col: number; row: number }[] = [];
    const resourceTiles: { col: number; row: number }[] = [];
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = rc * REGION_SIZE_X + dx;
        const row = rr * REGION_SIZE_Y + dy;
        const t = this.doc.get(col, row);
        if (t.forest) hasForest = true;
        if (t.terrain === "plains") plainsTiles.push({ col, row });
        if (t.resource) resourceTiles.push({ col, row });
      }
    }
    if (hasForest) return null;
    if (plainsTiles.length) {
      const pick = plainsTiles[Math.floor(this.rng() * plainsTiles.length)];
      const hadResource = this.doc.get(pick.col, pick.row).resource;
      this.doc.set(pick.col, pick.row, { terrain: "desert", resource: undefined });
      return hadResource
        ? `Последний лес в регионе вырублен — случайная равнина опустынилась, ресурс «${GameSession.RESOURCE_META.get(hadResource)!.label}» на ней исчез.`
        : "Последний лес в регионе вырублен — случайная равнина опустынилась.";
    }
    if (!resourceTiles.length) return "Последний лес в регионе вырублен — деградировать больше нечего (нет ни равнин, ни ресурсов в регионе).";
    const pick = resourceTiles[Math.floor(this.rng() * resourceTiles.length)];
    const lost = this.doc.get(pick.col, pick.row).resource!;
    this.doc.set(pick.col, pick.row, { resource: undefined });
    return `Последний лес в регионе вырублен — равнин в регионе нет, случайный ресурс региона («${GameSession.RESOURCE_META.get(lost)!.label}») исчез.`;
  }

  /** Склад's paid alternative to «Рабочий» — портирован из trySkladCollect. No card/hand slot — costs
   * 1 действие + 1💰 per unit collected, all-or-nothing. */
  skladCollect(playerId: number, cityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "sklad", playerId)) return { ok: false, hint: "У вас нет Склада." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Можно добывать только в своих городах." };
    const collected = this.collectibleResourcesIn(playerId, city);
    if (!collected.length) return { ok: false, hint: "В этом регионе сейчас нечего добывать — либо всё уже добыто в этом цикле, либо не хватает технологии добычи." };
    // [ИСПРАВЛЕНО] 1💰 за каждую ЗАПИСЬ (= единицу) — раньше qty удвоенного типа считался за одну
    // запись ценой в те же деньги, что и 1 единица обычного, теперь удвоенный тип — 2 отдельные
    // записи по 1💰 каждая, ровно по факту добытых единиц (см. extractionMultiplier выше).
    const totalCost = collected.length;
    if (this.money[playerId] < totalCost) return { ok: false, hint: `Не хватает денег: нужно ${totalCost} 💰 (по 1 за каждую добытую единицу).` };
    this.money[playerId] -= totalCost;
    for (const { resource, alreadyUsed } of collected) {
      if (!alreadyUsed) this.markHarvestUsedOnce(city.id, resource);
      this.addToWarehouse(playerId, resource, 1);
    }
    this.spendBuildingAction(playerId);
    return { ok: true };
  }

  /** Единство торговой сети (по прямому запросу — исправление бага): раньше сюда попадали ВСЕ
   * города ВСЕХ остальных игроков без разбора («любой другой игрок — торговый союзник», старый
   * placeholder), что делало сеть фиктивно «всегда общей на всех». Правильно — единый BFS по
   * ГЛОБАЛЬНОМУ графу маршрутов (рёбра — маршруты ЛЮБОГО владельца, не только кликнувшего игрока),
   * НО с проверкой торгового соглашения на каждой границе владения (по прямому уточнению «торговля
   * работает по всей сети если есть торговое соглашение, а не только своими») — BFS заходит в
   * город чужого игрока только если у играющего есть с ним `tradeUnion`; своя сеть без единого
   * такого соглашения устроена как раньше (просто BFS по своим+ничьим-чужим маршрутам не заходит
   * дальше первой чужой границы). Часть городов может быть в одной сети, часть в другой, а может
   * быть и все в одной — зависит и от того, как проложены маршруты, и от актуальной дипломатии. */
  private tradeNetworkOf(clickedCity: City): { cities: City[]; tollOwners: number[] } {
    const byId = new Map(this.cities.map((c) => [c.id, c]));
    const adjacency = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a)!.push(b);
    };
    for (const r of this.tradeRoutes) {
      // Узлы вдоль гексов маршрута — если путь физически проходит через клетку ещё одного
      // (третьего) города, тот тоже входит в сеть (ТЗ §14 п.11), а не только два города-конца.
      const nodeIds: number[] = [];
      for (const hex of r.path) {
        const city = this.cities.find((c) => c.col === hex.col && c.row === hex.row);
        if (city && !nodeIds.includes(city.id)) nodeIds.push(city.id);
      }
      if (!nodeIds.includes(r.fromCityId)) nodeIds.unshift(r.fromCityId);
      if (!nodeIds.includes(r.toCityId)) nodeIds.push(r.toCityId);
      for (let i = 0; i < nodeIds.length - 1; i++) {
        link(nodeIds[i], nodeIds[i + 1]);
        link(nodeIds[i + 1], nodeIds[i]);
      }
    }
    const selfId = clickedCity.playerId;
    const visited = new Set<number>([clickedCity.id]);
    const queue = [clickedCity.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (visited.has(next)) continue;
        const nextCity = byId.get(next);
        if (!nextCity) continue;
        if (nextCity.playerId !== selfId && !this.oonOpenTradeActive && !this.relationOf(selfId, nextCity.playerId).agreements.has("tradeUnion")) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    const netCities = [...visited].map((id) => byId.get(id)).filter((c): c is City => !!c);
    const tollOwners = [...new Set(netCities.filter((c) => c.playerId !== clickedCity.playerId).map((c) => c.playerId))];
    return { cities: netCities, tollOwners };
  }

  /** Торговец — портирован из tryTraderTrade. */
  traderTrade(playerId: number, slotIndex: number, cityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "trader" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Торговец» недоступна в этом слоте." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Можно торговать только через свой город." };

    // Доход по-прежнему считается ПО ВСЕЙ сети (network.length ниже) — это и есть смысл карты: шире
    // сеть, дороже каждый разыгранный тип. Но по прямому запросу (упрощение источников ресурсов —
    // «убери логику, где ресурсы берутся с нескольких городов одновременно») сами СПИСЫВАЕМЫЕ типы
    // теперь идут ТОЛЬКО из региона конкретного выбранного города, а не из любого города сети — как
    // и у любой другой карты, доступ → склад (эффективный, с бонусом Коммунизма).
    const { cities: network, tollOwners } = this.tradeNetworkOf(city);
    const totalPop = network.reduce((sum, c) => sum + c.population, 0);
    const uniqueSource = new Map<ResourceId, { from: "access"; cityId: number } | { from: "warehouse" }>();
    // 4-й аргумент (capToCity) ограничивает список НОВЫМИ типами не больше населения города (ТЗ 7.2)
    // — раньше это соблюдалось «по построению» (только capToCity.population новых типов возвращалось
    // на КАЖДЫЙ город сети отдельно), теперь единственный источник — этот city, так что убрать
    // capToCity означало бы вообще снять лимит популяции для Торговца.
    for (const r of new Set(this.resourcesInRegion(city.regionCol, city.regionRow, playerId, city))) {
      if (GameSession.RESOURCE_META.get(r)!.category !== "trade") continue;
      if (!this.resourceIsExtractable(playerId, r)) continue;
      if (this.accessUsed.has(`${city.id}:${r}`)) continue;
      uniqueSource.set(r, { from: "access", cityId: city.id });
    }
    for (const [id, qty] of Object.entries(this.effectiveWarehouseFor(playerId)) as [ResourceId, number][]) {
      if (qty > 0 && GameSession.RESOURCE_META.get(id)!.category === "trade" && !uniqueSource.has(id)) uniqueSource.set(id, { from: "warehouse" });
    }

    // По прямому уточнению — если в сети (и складе) нет ни одного торгового ресурса, карта не
    // разыгрывается вовсе (действие и карта остаются нетронутыми), а не тратится впустую на доход 0.
    if (uniqueSource.size === 0) return { ok: false, hint: "В торговой сети (и на складе) нет ни одного торгового ресурса — играть нечем." };

    const uniqueCount = uniqueSource.size;
    const grossIncome = Math.min(network.length * uniqueCount, totalPop);
    for (const [resource, src] of uniqueSource) {
      if (src.from === "access") this.accessUsed.add(`${src.cityId}:${resource}`);
      else this.takeFromWarehouse(playerId, resource, 1);
    }

    let remaining = grossIncome;
    for (const ownerId of tollOwners) {
      if (remaining <= 0) break;
      remaining -= 1;
      this.money[ownerId] += 1;
    }
    // Пиратство/грабёж (по прямому запросу) — юнит ЧУЖОГО игрока с raiding=true, стоящий на гексе
    // пути ЛЮБОГО маршрута этой сети (оба конца которого — города сети), перехватывает 1💰 из доли
    // ИМЕННО играющего («тот кто сыграл карту теряет это золото»), не из долей союзников по толлу.
    // Несколько юнитов на разных гексах маршрута — несколько перехватов; один и тот же юнит считается
    // не больше раза, даже если на его гексе пересекается несколько маршрутов сети.
    const networkIds = new Set(network.map((c) => c.id));
    const raiderUnitIds = new Set<number>();
    for (const route of this.tradeRoutes) {
      if (!networkIds.has(route.fromCityId) || !networkIds.has(route.toCityId)) continue;
      for (const { col, row } of route.path) {
        for (const u of this.units) {
          if (u.playerId !== playerId && u.raiding && u.col === col && u.row === row) raiderUnitIds.add(u.id);
        }
      }
    }
    for (const uid of raiderUnitIds) {
      if (remaining <= 0) break;
      const raider = this.units.find((u) => u.id === uid);
      if (!raider) continue;
      remaining -= 1;
      this.money[raider.playerId] += 1;
    }
    this.money[playerId] += remaining;
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  // === Постройки (ТЗ 3.1.4/3.1.5/4.4) =============================================================

  /** Строитель's price model — портирован из planBuildingSpend. `source` — один город (стройка/
   * здание/исследование — всегда столица; добыча силикатов Строителем — конкретный выбранный город).
   * Массив источников больше не используется по прямому запросу («убери логику, где ресурсы берутся
   * с нескольких городов одновременно») — раньше сюда передавалась вся торговая сеть при Коммунизме
   * (`ownRouteComponent`), теперь у Коммунизма другой, более простой бонус (см. communismCapitalTypes/
   * effectiveWarehouseFor) — тип остался массивом только чтобы не трогать сигнатуру лишний раз. */
  private planBuildingSpend(playerId: number, source: { id: number; regionCol: number; regionRow: number } | { id: number; regionCol: number; regionRow: number }[], lines: BuildingCostLine[]): SpendPlanItem[] | null {
    const plan: SpendPlanItem[] = [];
    let moneyBudget = this.money[playerId];
    const sources = Array.isArray(source) ? source : [source];

    // Без предварительной обрезки лимитом населения — лимит соблюдается при выборе, ПО КАЖДОМУ
    // городу отдельно (accessBudgetLeft), см. accessBudgetFor.
    const accessBudgetLeft = new Map<number, number>();
    const accessCandidates: { resource: ResourceId; cityId: number }[] = [];
    for (const src of sources) {
      accessBudgetLeft.set(src.id, this.accessBudgetFor(src.id));
      for (const r of new Set(this.resourcesInRegion(src.regionCol, src.regionRow, playerId))) {
        if (!this.resourceIsExtractable(playerId, r)) continue;
        if (this.accessUsed.has(`${src.id}:${r}`)) continue;
        accessCandidates.push({ resource: r, cityId: src.id });
      }
    }
    const warehouseCandidates: ResourceId[] = [];
    for (const [id, qty] of Object.entries(this.effectiveWarehouseFor(playerId)) as [ResourceId, number][]) {
      for (let i = 0; i < qty; i++) warehouseCandidates.push(id);
    }
    const marketCandidates = this.market.filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId).sort((a, b) => a.price - b.price);

    const pickOne = (rawMatch: (id: ResourceId) => boolean): boolean => {
      const match = this.matchWithJoker(rawMatch);
      const aIdx = accessCandidates.findIndex((a) => match(a.resource) && (accessBudgetLeft.get(a.cityId) ?? 0) > 0);
      if (aIdx >= 0) {
        const a = accessCandidates.splice(aIdx, 1)[0];
        accessBudgetLeft.set(a.cityId, (accessBudgetLeft.get(a.cityId) ?? 0) - 1);
        plan.push({ resource: a.resource, source: "access", cityId: a.cityId });
        return true;
      }
      const wIdx = warehouseCandidates.findIndex((r) => match(r));
      if (wIdx >= 0) {
        const r = warehouseCandidates.splice(wIdx, 1)[0];
        plan.push({ resource: r, source: "warehouse" });
        return true;
      }
      const mIdx = marketCandidates.findIndex((l) => match(l.resource!) && l.price <= moneyBudget);
      if (mIdx >= 0) {
        const l = marketCandidates.splice(mIdx, 1)[0];
        moneyBudget -= l.price;
        plan.push({ resource: l.resource!, source: "market", listingId: l.id });
        return true;
      }
      return false;
    };

    for (const line of lines) {
      if (line.kind === "specific") {
        for (let i = 0; i < line.count; i++) {
          if (!pickOne((r) => r === line.resource)) return null;
        }
      } else if (line.kind === "anyOf") {
        // «Эквивалентны друг другу» (по прямому запросу) — любая комбинация ресурсов из списка,
        // не обязательно одного и того же, без требования различности (в отличие от category ниже).
        for (let i = 0; i < line.count; i++) {
          if (!pickOne((r) => (line.resources as ResourceId[]).includes(r))) return null;
        }
      } else {
        const chosen = new Set<ResourceId>();
        for (let i = 0; i < line.count; i++) {
          if (!pickOne((r) => GameSession.RESOURCE_META.get(r)!.category === line.category && !chosen.has(r))) return null;
          chosen.add(plan[plan.length - 1].resource);
        }
      }
    }
    return plan;
  }

  /** Строитель — портирован из onBuildingClick's build branch (free-cell case). Claims one of up
   * to `MAX_BUILDING_OWNERS` slots and pays for it. Парламентаризм's once-per-turn free build
   * (refunds the action `consumeHandCard` just spent) — портировано как есть. */
  buildBuilding(playerId: number, slotIndex: number, buildingId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "builder" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Строитель» недоступна в этом слоте." };
    if (isOwnedBy(this.buildingOwners, buildingId, playerId)) return { ok: false, hint: "У вас уже есть это здание." };
    const def = BUILDINGS.find((b) => b.id === buildingId);
    const capital = this.capitalCityOf(playerId);
    if (!def || !capital) return { ok: false, hint: "Здание не найдено, или ещё нет столицы." };
    // По прямому запросу («для строительства здания списывается только в столице и со склада») —
    // Коммунизм больше не расширяет доступ на всю торговую сеть, у него отдельный бонус вместо этого
    // (communismCapitalTypes/effectiveWarehouseFor).
    const plan = this.planBuildingSpend(playerId, capital, def.costLines);
    if (!plan) return { ok: false, hint: `Не набралось ресурсов на «${def.name}» (${def.cost}) — ни в столице, ни на складе, ни на рынке.` };
    if (!claimBuilding(this.buildingOwners, buildingId, playerId)) return { ok: false, hint: "Здание уже занято двумя другими игроками." };
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
    // Совет ООН (ТЗ §15.3) — первый построивший становится кандидатом №1 и сразу запускает первые
    // выборы генсека; второй реальный строитель фиксирует кандидата №2 (заменяет динамический
    // автоподбор effectiveOonCandidate2Id, но НЕ переизбирает уже состоявшегося генсека).
    if (buildingId === "oon") {
      if (this.oonCandidate1Id === null) {
        this.oonCandidate1Id = playerId;
        this.holdFirstOonElection();
      } else if (this.oonCandidate2Id === null && playerId !== this.oonCandidate1Id) {
        this.oonCandidate2Id = playerId;
      }
    }
    return { ok: true };
  }

  private regionHasMountains(rc: number, rr: number): boolean {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        if (this.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).terrain === "mountains") return true;
      }
    }
    return false;
  }

  /** Строитель, альтернативное применение (по прямому уточнению — «силикатов критично не хватает»,
   * позже сбалансировано тем же уточнением — «даётся даром... давай хотя бы 1 еды забирать... и
   * лишь 1 единицу силикатов, иначе эта карта выгоднее шахты силикатной»): вместо стройки добывает
   * 1 Силикат на склад за 1 пищевой ресурс (доступ города → склад → рынок, тот же порядок, что и у
   * цены здания), если в регионе выбранного своего города есть гора. Тот же расход карты+действия,
   * что у обычной стройки; требует «Горное дело», как и любая другая добыча стратегических
   * ресурсов (resourceIsExtractable). */
  mineMountainsForSilicates(playerId: number, slotIndex: number, cityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "builder" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Строитель» недоступна в этом слоте." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Можно добывать только в своих городах." };
    if (!this.regionHasMountains(city.regionCol, city.regionRow)) return { ok: false, hint: "В регионе этого города нет гор." };
    if (!this.researchedTechs[playerId].has("Горное дело")) return { ok: false, hint: "Нужна технология «Горное дело»." };
    const plan = this.planBuildingSpend(playerId, city, [{ kind: "category", category: "food", count: 2 }]);
    if (!plan) return { ok: false, hint: "Не хватает 2 пищевых ресурсов — ни в регионе города, ни на складе, ни на рынке." };
    this.commitSpend(playerId, plan);
    this.addToWarehouse(playerId, "silicates", 1);
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** Здания, которые ПОТРЕБЛЯЮТ 1 Электричество, чтобы произвести свою продукцию (ТЗ 4.4 — «для
   * радиовышки и фабрики нужно 1 единица электричество») — в отличие от ГЭС/АЭС, которые
   * электричество производят, а не тратят. */
  private static ELECTRICITY_CONSUMING_BUILDINGS = new Set(["fabrika", "radiovyshka"]);

  /** «Управление» — купить +1 действие в этот ход за 2 💰 (ТЗ 4.4 «полная сверка цены активации» —
   * теперь число задано явно; было 3 — мой более ранний дефолт до сверки таблицы), не более раза за
   * ход — сбрасывается вместе с upravlenieUsedThisTurn в endTurn. */
  static UPRAVLENIE_ACTION_PRICE = 2;
  useUpravlenie(playerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "upravlenie", playerId)) return { ok: false, hint: "У вас нет здания «Управление»." };
    if (this.upravlenieUsedThisTurn.has(playerId)) return { ok: false, hint: "Уже куплено доп. действие в этом ходу — снова можно со следующего." };
    if (this.money[playerId] < GameSession.UPRAVLENIE_ACTION_PRICE) return { ok: false, hint: `Не хватает денег (нужно ${GameSession.UPRAVLENIE_ACTION_PRICE} 💰).` };
    this.money[playerId] -= GameSession.UPRAVLENIE_ACTION_PRICE;
    this.actionsLeft[playerId]++;
    this.upravlenieUsedThisTurn.add(playerId);
    return { ok: true };
  }

  /** Парламентаризм (переработано по прямому запросу — заменяет старый «первая стройка за ход
   * бесплатна»): активация УЖЕ ПОСТРОЕННЫХ зданий вовсе не тратит очков действия. Игрок может в свой
   * ход использовать любое число зданий (не ограничено одним разом) — каждое по-прежнему платит свою
   * обычную цену использования (деньги/ресурсы/карту) и подчиняется своему собственному лимиту
   * частоты, если он есть (например, раз за цикл у производственных зданий) — снимается только сам
   * action point. Единая точка входа вместо повтора одной и той же пары проверок в каждом useX/
   * activateX ниже. */
  private buildingActionGate(playerId: number): ActionResult | null {
    if (this.playerParadigm[playerId] === "parliamentarism") return null;
    if (this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Действий не осталось в этом ходу." };
    return null;
  }
  private spendBuildingAction(playerId: number) {
    if (this.playerParadigm[playerId] !== "parliamentarism") this.actionsLeft[playerId]--;
  }

  /** ГЭС/АЭС/Фабрика click — портирован из activateProductionBuilding. Продукция теперь идёт прямо
   * на склад (`warehouse`), а не в отдельный контур `buildingResources` — иначе она копилась без
   * возможности её потратить (по прямому уточнению — «как они могут копиться, если нет выгрузки на
   * склад»); Электричество (стратегическое) и Промтовары (торговое) — теперь обычные ресурсы. */
  activateProductionBuilding(playerId: number, buildingId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const b = BUILDINGS.find((x) => x.id === buildingId);
    if (!b || !b.produces || !isOwnedBy(this.buildingOwners, buildingId, playerId)) return { ok: false, hint: "Это здание вам не принадлежит или ничего не производит." };
    const cycleKey = `${buildingId}:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: `${b.name} уже произвело ресурс в этом цикле — снова можно только со следующего.` };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    if (this.money[playerId] < 1) return { ok: false, hint: "Не хватает денег — активация здания стоит 1 💰." };
    const needsElectricity = GameSession.ELECTRICITY_CONSUMING_BUILDINGS.has(buildingId);
    if (needsElectricity && (this.warehouse[playerId]?.electricity ?? 0) < 1) {
      return { ok: false, hint: `${b.name} требует 1 Электричество со склада, чтобы произвести продукцию — сейчас его нет.` };
    }
    this.money[playerId] -= 1;
    this.spendBuildingAction(playerId);
    this.productionUsedThisCycle.add(cycleKey);
    if (needsElectricity) this.takeFromWarehouse(playerId, "electricity", 1);
    this.addToWarehouse(playerId, b.produces.resource, b.produces.qty);
    return { ok: true };
  }

  /** Рынок (ТЗ 4.4, схема 4 «разовая сделка за деньги») — продаёт 1 торговый ресурс со склада за
   * фиксированные +2💰, не завязано на цикл (можно повторять, пока хватает действий и склада). */
  useRynok(playerId: number, resource: ResourceId): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "rynok", playerId)) return { ok: false, hint: "У вас нет здания «Рынок»." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    if (GameSession.RESOURCE_META.get(resource)?.category !== "trade") return { ok: false, hint: "Рынок продаёт только торговые ресурсы." };
    if (!this.takeFromWarehouse(playerId, resource, 1)) return { ok: false, hint: "Этого ресурса нет на складе." };
    this.spendBuildingAction(playerId);
    this.money[playerId] += 2;
    return { ok: true };
  }

  /** Ядерный арсенал (ТЗ 4.4, схема 3 «ресурсное производство без денег, без лимита цикла») —
   * платит 2 Уран + 1 Металл (доступ → склад → рынок, из региона столицы, как у Строителя/Учёного)
   * за +1 действие потраченное, копит стокпайл. Само применение ЯО — намеренно НЕ реализовано здесь
   * (ТЗ 4.4 «Применение ЯО»: нет ни боевой системы, ни системы целей, чтобы к нему прицепиться). */
  private static YADERNYI_ARSENAL_COST: BuildingCostLine[] = [
    { kind: "specific", resource: "uranium", count: 2 },
    { kind: "specific", resource: "metalOre", count: 1 },
  ];
  activateYadernyiArsenal(playerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "yadernyi_arsenal", playerId)) return { ok: false, hint: "У вас нет здания «Ядерный арсенал»." };
    if (this.oonNuclearBanActive) return { ok: false, hint: "Резолюция ООН «Запрет ядерного оружия» действует — новое ЯО производить нельзя." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const capital = this.capitalCityOf(playerId);
    if (!capital) return { ok: false, hint: "Ещё нет столицы." };
    const plan = this.planBuildingSpend(playerId, capital, GameSession.YADERNYI_ARSENAL_COST);
    if (!plan) return { ok: false, hint: "Не набралось ресурсов (2 Уран + 1 Металл) — ни в столице, ни на складе, ни на рынке." };
    this.commitSpend(playerId, plan);
    this.spendBuildingAction(playerId);
    this.nuclearWeapons[playerId] = (this.nuclearWeapons[playerId] ?? 0) + 1;
    return { ok: true };
  }

  /** Аэропорт (ТЗ 4.4) — переброска 1 своего юнита СО СТОЛИЦЫ на любую клетку карты: сектор
   * нейтрален или свой (чужой — блокируется без «Открытых границ», дипломатии для активного запроса
   * нет, поэтому просто блокируется, как и в commandUnit); на клетке нет юнита другого игрока.
   * Цена активации не была указана явно в таблице ТЗ («не уточнено — предполагаемый дефолт») — без
   * денег, 1 действие, без лимита цикла, ровно как написано, только число «сколько действий» было
   * уже дано (1); дефолт, который я добавил сам — требование пройти обычную проверку проходимости
   * гекса для типа юнита (unitPassable), чтобы, например, пехота не телепортировалась в океан. */
  useAeroport(playerId: number, unitId: number, col: number, row: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "aeroport", playerId)) return { ok: false, hint: "У вас нет здания «Аэропорт»." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return { ok: false, hint: "Юнит не найден." };
    const capital = this.capitalCityOf(playerId);
    if (!capital || unit.col !== capital.col || unit.row !== capital.row) return { ok: false, hint: "Перебросить можно только юнита, стоящего сейчас в столице." };
    if (!this.isUnitCommandable(unit)) return { ok: false, hint: "Юниты в резерве гарнизона нельзя выбрать напрямую." };
    const targetOwner = this.territoryOwnerOf(col, row);
    if (targetOwner !== null && targetOwner !== playerId && !this.relationOf(playerId, targetOwner).agreements.has("openBorders")) {
      return { ok: false, hint: "Чужой сектор без «Открытых границ» — переброска заблокирована." };
    }
    if (this.units.some((u) => u.col === col && u.row === row && u.playerId !== playerId)) {
      return { ok: false, hint: "На клетке уже стоит юнит другого игрока." };
    }
    if (!this.unitPassable(unit, col, row)) return { ok: false, hint: "Этот юнит не может оказаться на такой клетке." };
    this.spendBuildingAction(playerId);
    unit.col = col;
    unit.row = row;
    unit.moveOrder = null;
    unit.defending = false;
    return { ok: true };
  }

  /** Храм (ТЗ 4.4/4.5, схема 5 «сжечь карту → доход») — сжигает 1 любую карту из руки (обычный
   * сброс на дно колоды через consumeHandCard, без штрафных эффектов «руки переполнена») и платит
   * +1💰 за каждый город любого игрока, чья религия совпадает с религией владельца Храма. Атеист
   * (или ещё не выбравший религию) — сравнивать не с чем, доход 0 (ТЗ формулировка «нет религии» не
   * совпадает ни с кем, включая другого атеиста). */
  useHram(playerId: number, slotIndex: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "hram", playerId)) return { ok: false, hint: "У вас нет здания «Храм»." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const card = this.hands[playerId][slotIndex];
    if (!card) return { ok: false, hint: "В этом слоте руки нет карты." };
    const religion = this.playerReligion[playerId];
    const income = religion === null || religion === "atheism" ? 0 : this.cities.filter((c) => this.playerReligion[c.playerId] === religion).length;
    this.consumeHandCard(playerId, slotIndex); // всегда тратит 1 action — при Парламентаризме компенсируем ниже
    if (this.playerParadigm[playerId] === "parliamentarism") this.actionsLeft[playerId]++;
    this.money[playerId] += income;
    return { ok: true, hint: income > 0 ? `Сожжено «${card.label}» — доход +${income} 💰 (единоверные города).` : "Сожжено — доход 0 (нет религии или единоверцев)." };
  }

  /** Университет (ТЗ 4.4, схема 4) — то же открытие технологии, что «Учёный» (тот же
   * availableResearchFor/researchTech, та же механика лидерства по веткам), но через здание и с
   * доплатой 5💰 сверху обычной цены исследования, без траты карты из руки. Доплата резервируется
   * ДО планирования цены исследования, чтобы дешёвая покупка ресурса на рынке (тоже за деньги) не
   * могла тайком залезть в зарезервированные 5💰. */
  useUniversitet(playerId: number, techId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "universitet", playerId)) return { ok: false, hint: "У вас нет здания «Университет»." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const tech = this.availableResearchFor(playerId).find((t) => t.id === techId);
    if (!tech) return { ok: false, hint: "Эта технология сейчас недоступна для исследования." };
    const capital = this.capitalCityOf(playerId);
    if (!capital) return { ok: false, hint: "Ещё нет столицы." };
    if (this.money[playerId] < 5) return { ok: false, hint: "Не хватает денег на доплату (нужно 5 💰 сверху цены исследования)." };
    this.money[playerId] -= 5;
    // Тот же доступ, что и у обычного «Учёного» (см. confirmResearch) — Университет отличается
    // только доплатой 5💰, не источником ресурсов. По прямому запросу («наука списывается только со
    // столицы и склада») — только столица, не все города игрока разом.
    const plan = this.planBuildingSpend(playerId, capital, GameSession.RESEARCH_COST_LINES[tech.epoch]);
    if (!plan) {
      this.money[playerId] += 5;
      return { ok: false, hint: `Не набралось ресурсов на исследование (эпоха ${tech.epoch}) — ни в столице, ни на складе, ни на рынке.` };
    }
    this.commitSpend(playerId, plan);
    this.spendBuildingAction(playerId);
    this.researchTech(playerId, techId);
    return { ok: true };
  }

  /** Интернет (ТЗ 4.4, схема 4) — 1 действие + 5💰, получить все технологии выбранного игрока,
   * которых у себя ещё нет; если таких нет вовсе — активировать нельзя, деньги не списываются (по
   * прямому тексту таблицы). По разности множеств, а не по сравнению глубины веток — с тех пор как
   * технологию можно переоткрыть не по личному порядку (см. branchGroupDepth), у игрока могут быть
   * «дыры» в ветке, и сравнение чистой глубины перестало быть надёжным. Первооткрывателем
   * (religion/маршрут) подтянутые технологии не делают — researchTech сам решает это по
   * techDiscoverer, здесь на это не влияем. */
  useInternet(playerId: number, targetPlayerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "internet", playerId)) return { ok: false, hint: "У вас нет здания «Интернет»." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const target = this.players.find((p) => p.id === targetPlayerId);
    if (!target || targetPlayerId === playerId) return { ok: false, hint: "Выберите другого игрока." };
    if (this.money[playerId] < 5) return { ok: false, hint: "Не хватает денег (нужно 5 💰)." };
    const catchUp: string[] = [];
    for (const b of BRANCHES) {
      for (const t of this.branchTechOrder(b)) {
        if (this.researchedTechs[targetPlayerId].has(t.id) && !this.researchedTechs[playerId].has(t.id)) catchUp.push(t.id);
      }
    }
    if (!catchUp.length) return { ok: false, hint: "У выбранного игрока нет технологий, которых нет у вас — сравниваться не с чем." };
    this.money[playerId] -= 5;
    this.spendBuildingAction(playerId);
    for (const techId of catchUp) this.researchTech(playerId, techId);
    return { ok: true, hint: `Подтянуто технологий: ${catchUp.length}.` };
  }

  /** Космодром (ТЗ 4.4) — 1 действие, без денег, без лимита цикла — +1 компонент корабля,
   * накопительно за партию; 3 компонента = 🏆 победа через космос (ранее не подключено, только
   * счётчик spaceComponents заводился и никогда не рос — см. ТЗ §13 «защита Космонавтики от
   * ядерного оружия»). Цена активации — структурная форма таблицы 4.4 (1 Углеводороды + 2
   * Редкоземельные + 2 Металла + 1 Уран). */
  private static KOSMODROM_COST: BuildingCostLine[] = [
    { kind: "specific", resource: "hydrocarbons", count: 1 },
    { kind: "specific", resource: "rareEarth", count: 2 },
    { kind: "specific", resource: "metalOre", count: 2 },
    { kind: "specific", resource: "uranium", count: 1 },
  ];
  static SPACE_VICTORY_COMPONENTS = 3;
  activateKosmodrom(playerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "kosmodrom", playerId)) return { ok: false, hint: "У вас нет здания «Космодром»." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const capital = this.capitalCityOf(playerId);
    if (!capital) return { ok: false, hint: "Ещё нет столицы." };
    const plan = this.planBuildingSpend(playerId, capital, GameSession.KOSMODROM_COST);
    if (!plan) return { ok: false, hint: "Не набралось ресурсов (1 Углеводороды + 2 Редкоземельные + 2 Металла + 1 Уран) — ни в столице, ни на складе, ни на рынке." };
    this.commitSpend(playerId, plan);
    this.spendBuildingAction(playerId);
    this.spaceComponents[playerId] = (this.spaceComponents[playerId] ?? 0) + 1;
    if (this.spaceComponents[playerId] >= GameSession.SPACE_VICTORY_COMPONENTS) this.declareVictory(playerId, `Космическая победа — ${GameSession.SPACE_VICTORY_COMPONENTS} компонента корабля`);
    return { ok: true, hint: `Компонентов корабля: ${this.spaceComponents[playerId]}/${GameSession.SPACE_VICTORY_COMPONENTS}.` };
  }

  // === Совет ООН — кандидаты, генсек, резолюции (ТЗ §15.3, заменяет старую простую модель) =======

  private static OON_RESOLUTION_LABEL: Record<OonResolutionType, string> = {
    openTrade: "Открытая торговля",
    worldLeader: "Выборы мирового лидера",
    banNuclear: "Запрет ядерного оружия",
    neutralWaters: "Нейтральные воды",
    sanctions: "Санкции на страну",
    greenAgenda: "Зелёная повестка",
    priceRegulation: "Регуляция цен",
    armsLimit: "Сдерживание вооружений",
    aid: "Помощь",
    credit: "Кредитование",
  };
  static OON_RESOLUTION_MONEY_COST = 10;

  /** Кандидат №2 (ТЗ §15.3) — пока никто не построил ВТОРОЕ здание ООН, вычисляется динамически:
   * среди всех активных (не выбывших) игроков, кроме кандидата №1 — по населению, при равенстве по
   * числу городов («территорий» — не уточнено, регионов или городов; взято 1:1 к городам, см. п.5
   * ТЗ 1.3), при равенстве и этого — по числу военных юнитов. Может смениться в любой момент, пока
   * не зафиксирован реальной постройкой (`oonCandidate2Id`, см. `buildBuilding`). */
  effectiveOonCandidate2Id(): number | null {
    if (this.oonCandidate2Id !== null) return this.oonCandidate2Id;
    const pool = this.players.filter((p) => p.id !== this.oonCandidate1Id && !this.eliminatedPlayers.has(p.id));
    if (!pool.length) return null;
    const scoreOf = (id: number) => ({
      pop: this.totalPopulationOf(id),
      territory: this.cities.filter((c) => c.playerId === id).length,
      mil: this.units.filter((u) => u.playerId === id).length,
    });
    let best = pool[0];
    let bestScore = scoreOf(best.id);
    for (const p of pool.slice(1)) {
      const s = scoreOf(p.id);
      if (s.pop > bestScore.pop || (s.pop === bestScore.pop && s.territory > bestScore.territory) || (s.pop === bestScore.pop && s.territory === bestScore.territory && s.mil > bestScore.mil)) {
        best = p;
        bestScore = s;
      }
    }
    return best.id;
  }

  /** Первые выборы генсека — ровно один раз, при постройке ПЕРВОГО здания ООН (кандидатом №1).
   * **Не уточнено на своём шаге**, как именно проходят выборы (голосуют ли все игроки тем же весом
   * населения, что и резолюции) — упрощено до прямого сравнения населения двух кандидатов НА ЭТОТ
   * МОМЕНТ (кандидат №1 побеждает при равенстве, раз построил первым); пост не переизбирается дальше
   * в рамках этой реализации (тоже не уточнено). */
  private holdFirstOonElection() {
    const c1 = this.oonCandidate1Id;
    if (c1 === null) return;
    const c2 = this.effectiveOonCandidate2Id();
    this.oonSecretaryGeneralId = c2 !== null && this.totalPopulationOf(c2) > this.totalPopulationOf(c1) ? c2 : c1;
  }

  /** Выкладка резолюции (ТЗ §15.3) — только текущий генсек, 1 действие + 10💰, списывается сразу
   * независимо от исхода голосования (не уточнено явно, но по аналогии с остальными платными
   * действиями в этом клиенте). Генсек голосует «за» автоматически (тот же паттерн, что у старой
   * модели голосования ООН/предложений дипломатии). */
  proposeOonResolution(playerId: number, type: OonResolutionType, params: OonResolutionParams): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (this.oonSecretaryGeneralId !== playerId) return { ok: false, hint: "Резолюции выносит только действующий генеральный секретарь ООН." };
    if (this.pendingOonResolution) return { ok: false, hint: "Уже выносится резолюция — дождитесь её завершения." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    if (this.money[playerId] < GameSession.OON_RESOLUTION_MONEY_COST) return { ok: false, hint: `Не хватает денег (нужно ${GameSession.OON_RESOLUTION_MONEY_COST} 💰).` };
    const paramsError = this.validateOonResolutionParams(type, params);
    if (paramsError) return { ok: false, hint: paramsError };
    this.spendBuildingAction(playerId);
    this.money[playerId] -= GameSession.OON_RESOLUTION_MONEY_COST;
    this.pendingOonResolution = { id: this.nextOonResolutionId++, type, params, votes: { [playerId]: true } };
    const label = GameSession.OON_RESOLUTION_LABEL[type];
    this.tallyOonResolution();
    return { ok: true, hint: this.pendingOonResolution ? `Резолюция «${label}» вынесена на голосование.` : `Резолюция «${label}» принята сразу — вашего голоса «за» уже хватило.` };
  }

  private validateOonResolutionParams(type: OonResolutionType, params: OonResolutionParams): string | null {
    switch (type) {
      case "worldLeader":
      case "sanctions":
        if (params.targetPlayerId === undefined || !this.players.some((p) => p.id === params.targetPlayerId)) return "Нужно выбрать игрока.";
        return null;
      case "priceRegulation":
        if (!params.resource || !Number.isInteger(params.price) || (params.price ?? 0) < 1) return "Нужно выбрать ресурс и целую цену от 1.";
        return null;
      case "armsLimit":
        if (!Number.isInteger(params.limit) || (params.limit ?? -1) < 0) return "Нужен лимит юнитов — целое число от 0.";
        return null;
      case "aid":
        if (params.targetPlayerId === undefined || !this.players.some((p) => p.id === params.targetPlayerId) || !Number.isInteger(params.amount) || (params.amount ?? 0) < 1) {
          return "Нужны получатель и сумма (целое число от 1).";
        }
        return null;
      case "credit":
        if (!Number.isInteger(params.amount) || (params.amount ?? 0) < 1) return "Нужен множитель — целое число от 1.";
        return null;
      default:
        return null;
    }
  }

  voteOonResolution(playerId: number, inFavor: boolean): ActionResult {
    if (!this.pendingOonResolution) return { ok: false, hint: "Сейчас не выносится ни одна резолюция ООН." };
    if (playerId in this.pendingOonResolution.votes) return { ok: false, hint: "Вы уже проголосовали." };
    this.pendingOonResolution.votes[playerId] = inFavor;
    this.tallyOonResolution();
    return { ok: true };
  }

  /** Порог принятия — ≥60% от суммарного населения ВСЕХ активных (не выбывших) игроков (вес голоса
   * каждого = его население, «за себя голосовать можно», не проголосовавшие/воздержавшиеся просто
   * не считаются «за»). Принимается сразу, как только порог набран, не дожидаясь остальных; когда
   * все проголосовали и порог не набран — резолюция закрывается без эффекта. */
  private tallyOonResolution() {
    const res = this.pendingOonResolution;
    if (!res) return;
    const eligible = this.players.filter((p) => !this.eliminatedPlayers.has(p.id));
    const totalWeight = eligible.reduce((sum, p) => sum + this.totalPopulationOf(p.id), 0);
    const forWeight = Object.entries(res.votes)
      .filter(([, v]) => v)
      .reduce((sum, [id]) => sum + this.totalPopulationOf(+id), 0);
    if (totalWeight > 0 && forWeight * 100 >= totalWeight * 60) {
      this.applyOonResolutionEffect(res);
      this.pendingOonResolution = null;
      return;
    }
    if (Object.keys(res.votes).length >= eligible.length) this.pendingOonResolution = null;
  }

  private applyOonResolutionEffect(res: PendingOonResolution) {
    switch (res.type) {
      case "openTrade":
        this.oonOpenTradeActive = true;
        break;
      case "worldLeader":
        // 🏆 Путь победы «ООН» (ТЗ §15.2 п.1) — подтверждено прямым уточнением: раз голосовать за
        // себя можно, игрок с 60% населения планеты лично побеждает этой резолюцией без чужих голосов.
        if (res.params.targetPlayerId !== undefined) this.declareVictory(res.params.targetPlayerId, "Дипломатическая победа — резолюция Совета ООН «Мировой лидер»");
        break;
      case "banNuclear":
        this.oonNuclearBanActive = true;
        break;
      case "neutralWaters":
        this.oonNeutralWatersActive = true;
        break;
      case "sanctions":
        if (res.params.targetPlayerId !== undefined) {
          this.oonSanctionedPlayerId = res.params.targetPlayerId;
          for (const p of this.players) {
            if (p.id === res.params.targetPlayerId) continue;
            this.relationOf(p.id, res.params.targetPlayerId).agreements.clear();
          }
        }
        break;
      case "greenAgenda":
        this.oonGreenAgendaActive = true;
        break;
      case "priceRegulation":
        if (res.params.resource && res.params.price !== undefined) {
          this.oonPriceRegulation = { resource: res.params.resource, price: res.params.price };
          for (const l of this.market) if (l.kind === "resource" && l.resource === res.params.resource) l.price = res.params.price;
        }
        break;
      case "armsLimit":
        if (res.params.limit !== undefined) this.oonArmsLimit = res.params.limit;
        break;
      case "aid":
        if (res.params.targetPlayerId !== undefined && res.params.amount !== undefined) {
          const recipient = res.params.targetPlayerId;
          for (const p of this.players) {
            if (p.id === recipient) continue;
            const pay = Math.min(this.money[p.id], res.params.amount);
            this.money[p.id] -= pay;
            this.money[recipient] += pay;
          }
        }
        break;
      case "credit":
        if (res.params.amount !== undefined) {
          for (const p of this.players) this.money[p.id] += this.totalPopulationOf(p.id) * res.params.amount!;
        }
        break;
    }
  }

  // === Юниты: движение, бой, гарнизон (ТЗ 5.2/5.3/6/9) ===========================================

  /** Рыцарство/Сталь (по прямому запросу) — первооткрыватель технологии получает постоянный бонус
   * до конца партии: +1 урон юнитами категории «Мобильные» (Рыцарство), +1 дальность атаки
   * категориями «Дальняя атака» (артиллерия) и «Корабли» (Сталь). techDiscoverer уже хранит, кто
   * ЛИЧНО первым открыл технологию (см. grantSingleTech) — отдельное состояние не нужно, флаг это
   * он сам. Копия statsFor(), не мутация — тот же объект возвращается из нескольких мест кода. */
  private unitStats(u: UnitInstance): UnitStats {
    const stats = { ...statsFor(u.category, u.epoch) };
    if (u.category === "mobile" && this.techDiscoverer["Рыцарство"] === u.playerId) stats.attack += 1;
    if ((u.category === "ranged" || u.category === "ship") && this.techDiscoverer["Сталь"] === u.playerId) stats.attackRange += 1;
    return stats;
  }

  isSeaTile(col: number, row: number): boolean {
    return this.doc.get(col, row).terrain === "ocean";
  }

  /** «Земля круглая» (по прямому запросу) — та же обёртка над hexNeighborsWrapped, что и в клиенте
   * (main.ts), только сервер держит свой собственный MAP_WIDTH/MAP_HEIGHT через this.doc.tiles. */
  private hexNeighborsGameplay(col: number, row: number): [number, number][] {
    return hexNeighborsWrapped(col, row, this.doc.tiles.length, this.doc.tiles[0].length);
  }

  private isCoastalSeaTile(col: number, row: number): boolean {
    return this.isSeaTile(col, row) && this.hexNeighborsGameplay(col, row).some(([nc, nr]) => this.isLandTile(nc, nr));
  }

  unitPassable(mover: UnitInstance, col: number, row: number): boolean {
    if (this.doc.get(col, row).volcano) return false; // Извержение вулкана (§15.1) — гекс непроходим
    if (mover.category === "ship") {
      if (this.cityAt(col, row)) return true;
      if (mover.epoch === 1) return this.isCoastalSeaTile(col, row);
      return this.isSeaTile(col, row);
    }
    if (this.isLandTile(col, row)) return true;
    return this.isSeaTile(col, row) && this.units.some((u) => u.category === "ship" && u.col === col && u.row === row);
  }

  /** `isDestination` (по прямому запросу — «сквозь своих юнитов можно проходить, если гекс не
   * конечная точка маршрута и там не 2 юнита») — гекс лимитирован максимум 2 юнитами (см. ниже), но
   * запрет «нельзя ВСТАТЬ на клетку, где уже стоит твой же юнит» имеет смысл только когда движение
   * реально ЗАКАНЧИВАЕТСЯ здесь: транзитом (не финальная точка приказа) через клетку с ОДНИМ своим
   * юнитом пройти можно — сам факт прохода не создаёт постоянного стека 2 своих на одной клетке,
   * юнит просто идёт дальше в том же вызове. По умолчанию true (все существующие вызовы, кроме
   * прицельно переданного false в computeUnitPath/walkUnitAlongOrder для промежуточных шагов
   * маршрута, остаются как раньше — валидируют именно точку остановки). */
  canEnterHex(mover: UnitInstance, col: number, row: number, isDestination = true): boolean {
    if (this.units.some((u) => u.col === col && u.row === row && u.playerId !== mover.playerId && this.relationOf(u.playerId, mover.playerId).war)) return false;
    const city = this.cityAt(col, row);
    if (city) {
      // Живой баг-репорт — «проход корабля через чужой город перекрасил его» (не только для кораблей —
      // тот же вызов используется для ЛЮБОГО типа юнита и на КАЖДОМ шаге маршрута, не только на
      // конечной клетке, см. computeUnitPath/walkUnitAlongOrder). Чужой город раньше был проходим
      // безусловно (return true чуть выше, без проверки войны/границ вообще) — попутный шаг ЧЕРЕЗ
      // город на пути к другой цели тем самым обходил и требование «Открытых границ»/войны (оно
      // проверялось только для КОНЕЧНОЙ клетки маршрута, в commandUnit), и — раз клетка физически
      // «посещалась» — попутно захватывал город через ту же логику прибытия, что и намеренный вход
      // после пробития осады (walkUnitAlongOrder). Теперь чужой город проходим только если: свой
      // (это ветка city.playerId !== mover.playerId ниже её не касается), ЕСТЬ «Открытые границы»,
      // ИЛИ гарнизон УЖЕ пробит в ЭТОМ цикле (citySiegeBuffer, тот же признак «можно зайти и
      // захватить», что и в commandUnit/resolveCombat) — просто состояние войны само по себе, БЕЗ
      // пробитого гарнизона, вход не открывает (по прямому уточнению — гулять по чужому городу
      // разрешает мир/открытые границы, а не факт войны; захват — только через реальный бой).
      if (city.playerId !== mover.playerId) {
        const openBorders = this.relationOf(mover.playerId, city.playerId).agreements.has("openBorders");
        const siegeBroken = this.citySiegeBuffer.has(city.id) && this.citySiegeBuffer.get(city.id)! <= 0;
        if (!openBorders && !siegeBroken) return false;
      }
      return true;
    }
    if (mover.category !== "ship" && this.isSeaTile(col, row)) {
      const ship = this.units.find((u) => u.category === "ship" && u.playerId === mover.playerId && u.col === col && u.row === row);
      if (!ship) return false;
      const rider = this.units.find((u) => u.category !== "ship" && u.col === col && u.row === row && u.id !== mover.id);
      return !rider;
    }
    const occupants = this.unitsAt(col, row);
    if (occupants.length >= 2) return false;
    if (isDestination && occupants.some((u) => u.playerId === mover.playerId)) return false;
    return true;
  }

  /** «Высадка в горы» (по прямому запросу — «горы нужно запретить как место высадки, только если
   * там не стоит город») — сухопутный юнит не может сойти С МОРЯ (гекс, на котором он «на борту»,
   * см. isAboardShip) СРАЗУ на гекс гор без города — слишком крутой берег для высадки без порта.
   * Обычное пешее движение ПО СУШЕ в горы (откуда угодно, не с моря) этим правилом не задето — там
   * уже есть отдельная цена «съедает весь остаток хода» (isBarrierMountain), просто дороже, не
   * запрещено вовсе. */
  private isMountainLandingBlocked(mover: UnitInstance, fromCol: number, fromRow: number, toCol: number, toRow: number): boolean {
    if (mover.category === "ship") return false;
    if (!this.isSeaTile(fromCol, fromRow)) return false;
    return this.doc.get(toCol, toRow).terrain === "mountains" && !this.cityAt(toCol, toRow);
  }

  private shipSpawnHex(city: City): { col: number; row: number } | null {
    const candidates = this.hexNeighborsGameplay(city.col, city.row)
      .filter(([nc, nr]) => this.isSeaTile(nc, nr) && this.unitsAt(nc, nr).length < 2)
      .map(([col, row]) => ({ col, row }));
    if (!candidates.length) return null;
    const shoreCount = (c: number, r: number) => this.hexNeighborsGameplay(c, r).filter(([nc, nr]) => this.isLandTile(nc, nr)).length;
    candidates.sort((a, b) => shoreCount(b.col, b.row) - shoreCount(a.col, a.row));
    return candidates[0];
  }

  private isRoadHex(col: number, row: number): boolean {
    return this.tradeRoutes.some((r) => r.path.some((p) => p.col === col && p.row === row));
  }
  private ownRoadHex(playerId: number, col: number, row: number): boolean {
    return this.tradeRoutes.some((r) => r.playerId === playerId && r.path.some((p) => p.col === col && p.row === row));
  }
  private isBarrierMountain(col: number, row: number): boolean {
    return this.doc.get(col, row).terrain === "mountains" && !this.isRoadHex(col, row);
  }
  private terrainMoveCost(col: number, row: number): number {
    const tile = this.doc.get(col, row);
    let cost = tile.terrain === "hills" ? 2 : 1;
    if (tile.forest) cost += 1;
    return cost;
  }

  unitsAt(col: number, row: number): UnitInstance[] {
    return this.units.filter((u) => u.col === col && u.row === row);
  }
  cityAt(col: number, row: number): City | undefined {
    return this.cities.find((c) => c.col === col && c.row === row);
  }
  private cityAtRegion(rc: number, rr: number): City | undefined {
    return this.cities.find((c) => c.regionCol === rc && c.regionRow === rr);
  }
  private territoryOwnerOf(col: number, row: number): number | null {
    const rc = Math.floor(col / REGION_SIZE_X);
    const rr = Math.floor(row / REGION_SIZE_Y);
    const city = this.cityAtRegion(rc, rr);
    return city ? city.playerId : null;
  }
  private isAboardShip(u: UnitInstance): boolean {
    return u.category !== "ship" && this.isSeaTile(u.col, u.row);
  }

  /** По прямому уточнению — «одному игроку не нужно открывать всю ветку [эпохи] самому, учитываются
   * открытия других игроков»: считается по ЛЮБОМУ игроку, открывшему технологию этой эпохи/ветки, а
   * не только по тому, для кого сейчас считается maxEligibleEpoch. В отличие от canAdvanceBranch
   * (там у каждого игрока своя глубина в ветке) — здесь порог общий на всех, так что как только
   * группа целиком коснулась 3-4 веток эпохи N, следующая эпоха открывается сразу всем. */
  private branchesTouchedInEpoch(epoch: number): number {
    return BRANCHES.filter((b) => TECH_TREE.some((t) => t.branch === b && t.epoch === epoch && this.players.some((p) => this.researchedTechs[p.id].has(t.id)))).length;
  }
  private maxEligibleEpoch(_playerId: number): number {
    let epoch = 1;
    while (epoch < 6 && this.branchesTouchedInEpoch(epoch) >= 3) epoch++;
    return epoch;
  }

  private hexKey(col: number, row: number): string {
    return `${col},${row}`;
  }
  private computeFreshHexDefense(col: number, row: number, context: UnitInstance): number {
    const tile = this.doc.get(col, row);
    const stats = this.unitStats(context);
    let base = stats.armorMultiplier > 1 ? stats.armorMultiplier : 1;
    const hasCity = !!this.cityAt(col, row);
    let bonus = 0;
    if (this.isSeaTile(col, row)) {
      const shores = this.hexNeighborsGameplay(col, row).filter(([nc, nr]) => this.isLandTile(nc, nr)).length;
      bonus += Math.max(0, shores - 1);
    } else {
      const dugIn = tile.terrain !== "desert" && tile.terrain !== "tundra";
      if (dugIn || hasCity) {
        if (tile.forest) bonus += 1;
        if (tile.terrain === "hills") bonus += 1;
        if (tile.terrain === "mountains") bonus += 2;
        if (hasCity) bonus += 1;
        if (this.territoryOwnerOf(col, row) === context.playerId) bonus += 1;
        if (isOwnedBy(this.buildingOwners, "fort", context.playerId)) bonus += this.maxEligibleEpoch(context.playerId);
        if (this.ownRoadHex(context.playerId, col, row)) bonus += 1;
      }
    }
    let total = base + bonus;
    if (context.defending) total *= 2;
    return Math.max(0, total);
  }
  /** Базовая «сила гарнизона» города — по прямому уточнению это НЕ отдельный юнит: гарнизон города
   * равен его населению. Больше население — крепче держится город; та же логика бонусов местности,
   * что и у computeFreshHexDefense (город всегда «защищается», отсюда финальный ×2). */
  private cityGarrisonDefense(city: City): number {
    const tile = this.doc.get(city.col, city.row);
    let base = Math.max(1, city.population);
    let bonus = 1; // сам факт города
    if (tile.terrain === "hills") bonus += 1;
    if (tile.terrain === "mountains") bonus += 2;
    if (this.territoryOwnerOf(city.col, city.row) === city.playerId) bonus += 1;
    if (isOwnedBy(this.buildingOwners, "fort", city.playerId)) bonus += this.maxEligibleEpoch(city.playerId);
    if (this.ownRoadHex(city.playerId, city.col, city.row)) bonus += 1;
    return (base + bonus) * 2;
  }
  /** Буфер осады НА ЭТОТ ЦИКЛ — заводится один раз при первом ударе по безоружному городу, копится
   * (несколько атакующих в одном цикле пробивают его совместно), сбрасывается в endTurn() вместе с
   * hexDefense при обороте цикла — тогда же, если население всё ещё > 0, город «восстанавливает»
   * гарнизон заново из уже сниженного населения (см. resolveCombat/commandUnit — «в новом цикле там
   * снова будет гарнизон, но уже с меньшими силами», по прямому уточнению). */
  private citySiegeDefense(city: City): number {
    if (!this.citySiegeBuffer.has(city.id)) this.citySiegeBuffer.set(city.id, this.cityGarrisonDefense(city));
    return this.citySiegeBuffer.get(city.id)!;
  }
  /** Население упало до 0 (по прямому уточнению) — город уничтожен целиком (не просто беззащитен):
   * снимается как игровой объект, торговые маршруты через него рвутся, юниты резерва отвязываются
   * (остаются на карте обычными юнитами), клетка помечается руинами (визуально, не тип террейна). */
  private destroyCity(city: City) {
    const ownerId = city.playerId;
    const wasCapital = city.isCapital;
    this.ruins.push({ col: city.col, row: city.row });
    this.tradeRoutes = this.tradeRoutes.filter((r) => r.fromCityId !== city.id && r.toCityId !== city.id);
    for (const u of this.units) if (u.cityId === city.id) u.cityId = null;
    this.citySiegeBuffer.delete(city.id);
    this.cities = this.cities.filter((c) => c.id !== city.id);
    this.handleCityLoss(ownerId, wasCapital);
  }
  /** Последствия потери города (по прямому уточнению — «вымирание из-за эффектов сброса, войны или
   * катастроф») — вызывается ПОСЛЕ того, как город уже убран из `this.cities` (уничтожен) или сменил
   * `playerId` (захват/дипломатия). Если у игрока остались другие города и потерян был именно
   * столичный — случайный из оставшихся становится новой столицей, здания старой столицы теряются
   * (в этой модели все здания принадлежат игроку глобально, а не привязаны к городу — фактически
   * «привязаны к столице», поэтому теряются целиком со сменой столицы). Городов не осталось совсем —
   * полное выбывание: юниты, торговые маршруты и оставшиеся здания снимаются, id попадает в
   * `eliminatedPlayers` (клиент показывает уведомление всем поверх карты). */
  private handleCityLoss(oldOwnerId: number, wasCapital: boolean) {
    const remaining = this.cities.filter((c) => c.playerId === oldOwnerId);
    if (!remaining.length) {
      this.units = this.units.filter((u) => u.playerId !== oldOwnerId);
      this.tradeRoutes = this.tradeRoutes.filter((r) => r.playerId !== oldOwnerId);
      for (const b of builtBy(this.buildingOwners, oldOwnerId)) this.buildingOwners[b.id].splice(this.buildingOwners[b.id].indexOf(oldOwnerId), 1);
      this.eliminatedPlayers.add(oldOwnerId);
      return;
    }
    if (wasCapital) {
      const newCapital = remaining[Math.floor(this.rng() * remaining.length)];
      newCapital.isCapital = true;
      for (const b of builtBy(this.buildingOwners, oldOwnerId)) this.buildingOwners[b.id].splice(this.buildingOwners[b.id].indexOf(oldOwnerId), 1);
    }
  }
  /** Мирная передача города (дипломатия — giveCity/demandCity) — тот же учёт потери столицы/
   * выбывания, что и у военного захвата (см. resolveUnitMovementForCycle), просто без движения юнита. */
  private transferCity(city: City, newOwnerId: number) {
    const oldOwnerId = city.playerId;
    const wasCapital = city.isCapital;
    city.playerId = newOwnerId;
    city.isCapital = false;
    this.citySiegeBuffer.delete(city.id);
    this.handleCityLoss(oldOwnerId, wasCapital);
    this.checkTerritorialVictory(newOwnerId);
  }
  private peekHexDefense(u: UnitInstance): number {
    const key = this.hexKey(u.col, u.row);
    if (!this.hexDefense.has(key)) this.hexDefense.set(key, this.computeFreshHexDefense(u.col, u.row, u));
    return this.hexDefense.get(key)!;
  }
  unitTotalDefense(u: UnitInstance): number {
    return this.peekHexDefense(u);
  }
  /** `doubleDefenseDamage` (Дальняя атака/артиллерия, по прямому уточнению) — удваивает ТОЛЬКО ту
   * часть урона, что идёт на снятие защиты (буфер гекса), а не то, что доходит до HP: если защиты
   * хватило бы пережить обычный урон, но не удвоенный — буфер обнуляется полностью (защита ломается
   * быстрее), но цель в этом же ударе всё равно не получает урона по HP сверх того, что дал бы
   * обычный (неудвоенный) урон — доходит до HP ровно `amount`, не `amount*2`. */
  private applyDamage(target: UnitInstance, amount: number, doubleDefenseDamage = false): number {
    const key = this.hexKey(target.col, target.row);
    const buffer = this.hexDefense.has(key) ? this.hexDefense.get(key)! : this.computeFreshHexDefense(target.col, target.row, target);
    const defenseStrip = doubleDefenseDamage ? amount * 2 : amount;
    const afterBuffer = Math.max(0, buffer - defenseStrip);
    const overflow = Math.max(0, amount - buffer);
    this.hexDefense.set(key, afterBuffer);
    const hpLoss = Math.min(target.hp, overflow);
    target.hp -= hpLoss;
    return hpLoss;
  }
  private removeDeadUnits(dead: UnitInstance[]) {
    const deadShips = dead.filter((u) => u.hp <= 0 && u.category === "ship");
    const deadIds = new Set(dead.filter((u) => u.hp <= 0).map((u) => u.id));
    for (const ship of deadShips) {
      for (const u of this.units) if (u.category !== "ship" && u.col === ship.col && u.row === ship.row) deadIds.add(u.id);
    }
    if (!deadIds.size) return;
    this.units = this.units.filter((u) => !deadIds.has(u.id));
  }

  private cityGarrisonQueue(cityCol: number, cityRow: number): UnitInstance[] {
    return this.unitsAt(cityCol, cityRow).sort((a, b) => (a.garrisonRank ?? a.id) - (b.garrisonRank ?? b.id));
  }
  private isUnitCommandable(u: UnitInstance): boolean {
    const city = this.cityAt(u.col, u.row);
    if (!city) return true;
    return this.cityGarrisonQueue(city.col, city.row)[0]?.id === u.id;
  }

  effectiveAttackRange(u: UnitInstance): number {
    const stats = this.unitStats(u);
    const onHills = stats.attackRange > 1 && this.doc.get(u.col, u.row).terrain === "hills";
    return stats.attackRange + (onHills ? 1 : 0);
  }

  hexDistance(fromCol: number, fromRow: number, toCol: number, toRow: number, maxRadius = 20): number {
    if (fromCol === toCol && fromRow === toRow) return 0;
    const visited = new Set<string>([`${fromCol},${fromRow}`]);
    let frontier: [number, number][] = [[fromCol, fromRow]];
    for (let dist = 1; dist <= maxRadius && frontier.length; dist++) {
      const next: [number, number][] = [];
      for (const [c, r] of frontier) {
        for (const [nc, nr] of this.hexNeighborsGameplay(c, r)) {
          const key = `${nc},${nr}`;
          if (visited.has(key)) continue;
          if (nc === toCol && nr === toRow) return dist;
          visited.add(key);
          next.push([nc, nr]);
        }
      }
      frontier = next;
    }
    return Infinity;
  }

  /** Поддержка (по прямому уточнению — «проще в понимании и реализации», заменяет прежнюю версию
   * «ближайший один союзник любой категории, не более раза за цикл на юнита поддержки»):
   * - Увеличивает урон ТОЛЬКО Штурмовых и Мобильных (`u`, кому ищем поддержку) — не бьёт сама,
   *   именно баф урона; корабли и остальные категории поддержку не получают вообще.
   * - Считает ВСЕХ подходящих союзников поддержки в радиусе разом (не только ближайшего одного) —
   *   каждый даёт +1, суммарно.
   * - Один и тот же юнит поддержки может поддержать сколько угодно раз за цикл — лимита «раз за
   *   цикл» больше нет (`supportUsedThisCycle` снят как понятие).
   */
  private supportersFor(u: UnitInstance): UnitInstance[] {
    if (u.category !== "assault" && u.category !== "mobile") return [];
    return this.units.filter((s) => {
      if (s.playerId !== u.playerId || s.id === u.id || this.isAboardShip(s)) return false;
      // Резервный юнит гарнизона (§6.8 «не оказывают поддержки») — пока не выведен из города
      // обычным перемещением, в бою не участвует ни как цель отдельно от гарнизона-по-населению,
      // ни как источник поддержки соседям.
      if (!this.isUnitCommandable(s)) return false;
      const stats = this.unitStats(s);
      if (stats.supportBonus <= 0) return false;
      const d = this.hexDistance(s.col, s.row, u.col, u.row, stats.supportRadius + 1);
      return d <= stats.supportRadius;
    });
  }

  /** Перемещение ИЛИ атака военным юнитом стоит 1💰 (по прямому уточнению — «универсализируем,
   * других ресурсов не надо»). Поддержка (support-юнит без атаки не проходит через этот вызов
   * вовсе) и оборона (toggleDefend) остаются бесплатными — ни один из них сюда не заходит.
   * Раньше здесь стояла привязка к последнему стратегическому ресурсу цены юнита эпохи, добываемому
   * с домашнего города игрока (`unitActivationReq`, удалена) — из-за чего движение/атака молча
   * отказывали с «не хватает снабжения», если у ДОМАШНЕГО города конкретно этого ресурса не
   * находилось: это и было причиной «юниты не двигаются». */
  private chargeUnitActivation(unit: UnitInstance): boolean {
    if (this.money[unit.playerId] < 1) return false;
    this.money[unit.playerId] -= 1;
    return true;
  }

  /** Превью маршрута ДО отправки реального приказа (по прямому запросу — «при выборе клетки куда
   * переместиться показывай маршрут и число ходов») — чисто чтение, никакого мутирования состояния
   * (та же причина, по которой это НЕ идёт через обычный `dispatch`/`action`, см. wsServer.ts:
   * отдельный WS-канал "previewPath", чтобы частые запросы при наведении мышью не мешали очереди
   * реальных действий игрока). Переиспользует ровно ту же приватную `computeUnitPath`, которую
   * использует настоящее движение (`commandUnit`) — значит превью НИКОГДА не разойдётся с тем, что
   * реально случится при клике: те же правила проходимости/границ/захвата (`unitPassable`/
   * `canEnterHex`), без дублирования этой логики на клиенте (клиент раньше как раз содержал такую
   * копию — снята как мёртвый код при переходе на server-authoritative движение). */
  previewUnitPath(playerId: number, unitId: number, col: number, row: number): { path: { col: number; row: number }[]; cost: number; remainingBudget: number; moveRange: number } | null {
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return null;
    const result = this.computeUnitPath(unit, col, row);
    if (!result) return null;
    const stats = this.unitStats(unit);
    const remainingBudget = Math.max(0, stats.moveRange - (this.moveBudgetUsedThisCycle.get(unit.id) ?? 0));
    return { path: result.path, cost: result.cost, remainingBudget, moveRange: stats.moveRange };
  }

  private computeUnitPath(mover: UnitInstance, toCol: number, toRow: number, maxSearchCost = 60): { path: { col: number; row: number }[]; cost: number } | null {
    if (toCol < 0 || toCol >= this.doc.tiles.length || toRow < 0 || toRow >= this.doc.tiles[0].length) return null;
    const startKey = `${mover.col},${mover.row}`;
    const endKey = `${toCol},${toRow}`;
    if (startKey === endKey) return { path: [], cost: 0 };
    if (!this.unitPassable(mover, toCol, toRow) || !this.canEnterHex(mover, toCol, toRow)) return null;

    const dist = new Map<string, number>([[startKey, 0]]);
    const parent = new Map<string, string | null>([[startKey, null]]);
    const frontier: string[] = [startKey];
    while (frontier.length) {
      frontier.sort((a, b) => dist.get(a)! - dist.get(b)!);
      const key = frontier.shift()!;
      if (key === endKey) break;
      const d = dist.get(key)!;
      if (d > maxSearchCost) continue;
      const [col, row] = key.split(",").map(Number);
      for (const [nc, nr] of this.hexNeighborsGameplay(col, row)) {
        const nk = `${nc},${nr}`;
        const isDest = nk === endKey;
        if (!this.unitPassable(mover, nc, nr)) continue;
        // По прямому запросу — canEnterHex теперь спрашивается для КАЖДОГО кандидата, включая саму
        // конечную точку (раньше конечная точка вообще не проверялась здесь, полагаясь на отдельную
        // валидацию у вызывающего — но «нельзя ВСТАТЬ на клетку своего же юнита» нигде больше не
        // проверялась вовсе, см. doc canEnterHex): isDest передаётся как isDestination — не финальные
        // шаги маршрута теперь МОГУТ пройти сквозь клетку с одним своим юнитом (транзитом), финальная
        // точка — по-прежнему нет.
        if (!this.canEnterHex(mover, nc, nr, isDest)) continue;
        if (this.isMountainLandingBlocked(mover, col, row, nc, nr)) continue;
        const stepCost = this.isRoadHex(nc, nr) ? 0.5 : this.isBarrierMountain(nc, nr) ? this.unitStats(mover).moveRange : this.terrainMoveCost(nc, nr);
        const nd = d + stepCost;
        if (!dist.has(nk) || nd < dist.get(nk)!) {
          dist.set(nk, nd);
          parent.set(nk, key);
          if (!frontier.includes(nk)) frontier.push(nk);
        }
      }
    }
    if (!dist.has(endKey)) return null;
    const path: { col: number; row: number }[] = [];
    let k: string | null = endKey;
    while (k && k !== startKey) {
      const [c, r] = k.split(",").map(Number);
      path.unshift({ col: c, row: r });
      k = parent.get(k) ?? null;
    }
    return { path, cost: dist.get(endKey)! };
  }

  /** Проводит юнита по его текущему приказу (`unit.moveOrder`) настолько далеко, насколько хватает
   * ОСТАВШЕГОСЯ на этот цикл бюджета хода (`moveBudgetUsedThisCycle` — общий счётчик, см. его doc).
   * По прямому запросу («движение должно случаться в текущем цикле, а не в следующем») вызывается
   * СРАЗУ из `commandUnit`, а не только на границе цикла — раньше вся эта логика жила только в
   * `resolveUnitMovementForCycle` и юнит физически не сдвигался с места до конца всего круга ходов.
   * Оставлена как отдельный метод, потому что она НУЖНА и на границе цикла тоже — если путь длиннее
   * одного бюджета хода, остаток автопродолжается в начале следующего цикла тем же приказом, уже со
   * свежим бюджетом. Возвращает фактически пройденные гексы (для клиентской анимации, ActionResult.
   * movedPath) — стоимость шага включена, чтобы клиент мог анимировать тяжёлую местность медленнее. */
  private walkUnitAlongOrder(u: UnitInstance): { col: number; row: number; cost: number }[] {
    const steps: { col: number; row: number; cost: number }[] = [];
    if (!u.moveOrder) return steps;
    const stats = this.unitStats(u);
    let budget = stats.moveRange - (this.moveBudgetUsedThisCycle.get(u.id) ?? 0);
    let wasAboard = this.isAboardShip(u);
    while (budget > 0 && u.moveOrder && u.moveOrder.nextIndex < u.moveOrder.path.length) {
      const next = u.moveOrder.path[u.moveOrder.nextIndex];
      // isDestination — тот же смысл, что в computeUnitPath: только последний шаг ВСЕГО маршрута
      // (не только этого вызова — короткий на бюджет цикла всё равно останавливается досрочно и
      // ниже, см. shortOnBudget) считается «точкой остановки» для запрета вставать на клетку своего
      // же юнита; сквозь такую клетку транзитом пройти можно.
      const isLastStepOfOrder = u.moveOrder.nextIndex === u.moveOrder.path.length - 1;
      if (!this.unitPassable(u, next.col, next.row) || !this.canEnterHex(u, next.col, next.row, isLastStepOfOrder) || this.isMountainLandingBlocked(u, u.col, u.row, next.col, next.row)) {
        u.moveOrder = null;
        break;
      }
      const stepCost = this.isRoadHex(next.col, next.row) ? 0.5 : this.isBarrierMountain(next.col, next.row) ? budget : this.terrainMoveCost(next.col, next.row);
      const shortOnBudget = stepCost > budget;
      const spent = shortOnBudget ? budget : stepCost;
      budget = shortOnBudget ? 0 : budget - stepCost;
      this.moveBudgetUsedThisCycle.set(u.id, (this.moveBudgetUsedThisCycle.get(u.id) ?? 0) + spent);
      u.col = next.col;
      u.row = next.row;
      u.moveOrder.nextIndex++;
      steps.push({ col: u.col, row: u.row, cost: spent });
      if (shortOnBudget) this.outOfMoveThisCycle.add(u.id);
      // Захват — ТОЛЬКО если этот шаг — действительно ПОСЛЕДНИЙ гекс приказа (настоящая конечная
      // цель, которую игрок кликнул), а не просто попутный проход. Живой баг-репорт — «проход
      // корабля через чужой город перекрасил его»: chужой город с недавних пор проходим при войне/
      // открытых границах/пробитом гарнизоне (см. canEnterHex), но раньше ЭТА проверка захвата
      // срабатывала на КАЖДОМ шаге пути, включая чисто транзитные — юнит, которому просто было по
      // пути через клетку города, «захватывал» её мимоходом. commandUnit пускает движение НА город
      // (как на конечную цель) только когда гарнизон (население) уже пробит на этот цикл
      // (citySiegeBuffer <= 0) и в городе нет вражеских юнитов; повторная проверка на защитников
      // здесь — подстраховка на случай, если что-то встало в город за этот же ход между приказом и
      // разрешением движения. Население при захвате НЕ обнуляется — переходит новому владельцу как есть.
      const isFinalDestination = !u.moveOrder || u.moveOrder.nextIndex >= u.moveOrder.path.length;
      const arrivedCity = this.cityAt(u.col, u.row);
      if (isFinalDestination && arrivedCity && arrivedCity.playerId !== u.playerId && !this.units.some((o) => o.id !== u.id && o.col === u.col && o.row === u.row && o.playerId === arrivedCity.playerId)) {
        this.transferCity(arrivedCity, u.playerId);
      }
      if (shortOnBudget) break;
      const nowAboard = this.isAboardShip(u);
      if (wasAboard && !nowAboard) {
        this.landedThisCycle.add(u.id);
        break;
      }
      wasAboard = nowAboard;
    }
    if (u.moveOrder && u.moveOrder.nextIndex >= u.moveOrder.path.length) u.moveOrder = null;
    return steps;
  }

  /** Конец цикла (ТЗ 5.3/9) — вызывается из endTurn() при обороте currentPlayerIndex на 0. Теперь
   * это только автопродолжение приказов, которые не поместились в бюджет хода СВОЕГО цикла (см.
   * walkUnitAlongOrder) — обычное движение уже исполнилось мгновенно внутри commandUnit. */
  private resolveUnitMovementForCycle() {
    for (const u of this.units) {
      if (u.moveOrder) this.walkUnitAlongOrder(u);
    }
  }

  /** Возвращает данные для анимации линий поддержки и самого боя (по прямому запросу) — чисто
   * отображение, commandUnit прокидывает их в ActionResult как есть; сама атака применяется и
   * считается здесь же, как и раньше, `combatAnim` только собирает моментальные снимки до/после
   * (см. doc у ActionResult.combatAnim). */
  private resolveCombat(
    attacker: UnitInstance,
    col: number,
    row: number
  ): {
    lines: { from: { col: number; row: number }; to: { col: number; row: number } }[];
    hint?: string;
    anim: ActionResult["combatAnim"];
  } {
    const stats = this.unitStats(attacker);
    const atkPower = Math.max(0, stats.attack - (attacker.category === "ship" ? 1 : 0));
    // Дальняя атака (категория, не корабли — те тематически «плавающая артиллерия», но отдельная
    // механика) — удваивает урон на снятие защиты, см. applyDamage. По прямому уточнению.
    const atkDoubleDefense = attacker.category === "ranged";
    // Дистанция ЭТОГО конкретного удара — отступление/принуждение к отходу работает только в упор
    // (dist<=1): дальнобойные бьют издалека, но не «наступают» и не могут заставить отступить (по
    // прямому уточнению) — только урон, независимо от исхода по HP.
    const dist = this.hexDistance(attacker.col, attacker.row, col, row, this.effectiveAttackRange(attacker) + 1);
    const city = this.cityAt(col, row);
    const defenders = this.unitsAt(col, row).filter((u) => u.playerId !== attacker.playerId);
    const supportLines: { from: { col: number; row: number }; to: { col: number; row: number } }[] = [];
    const attackerPos = { col: attacker.col, row: attacker.row };

    if (!defenders.length && city) {
      // Гарнизон = население города (по прямому уточнению, никаких отдельных юнитов) — атака бьёт по
      // общему буферу осады ЭТОГО цикла (копится за несколько ударов, как обычная защита гекса).
      // Пробитие буфера в 0 — «победа над гарнизоном», снимает РОВНО 1 население (не по урону), и
      // город становится целью для входа (см. commandUnit) до конца этого цикла — не успеют зайти,
      // на новом цикле гарнизон соберётся заново из уже меньшего населения.
      const atkSupporters = this.supportersFor(attacker);
      for (const s of atkSupporters) supportLines.push({ from: { col: s.col, row: s.row }, to: { col: attacker.col, row: attacker.row } });
      const dmg = atkPower + atkSupporters.length;
      const buffer = this.citySiegeDefense(city);
      const wasBroken = buffer <= 0;
      const defenseStrip = atkDoubleDefense ? dmg * 2 : dmg;
      const afterBuffer = Math.max(0, buffer - defenseStrip);
      this.citySiegeBuffer.set(city.id, afterBuffer);
      let hint: string | undefined;
      let garrisonBroken = false;
      if (!wasBroken && afterBuffer <= 0 && city.population > 0) {
        garrisonBroken = true;
        city.population -= 1;
        if (city.population <= 0) {
          this.destroyCity(city);
          hint = "Население города обнулилось — город уничтожен, на его месте руины.";
        } else {
          hint = "Гарнизон города пал! Заведите юнита в город до конца этого хода, чтобы захватить его — иначе к новому циклу гарнизон соберётся заново (уже слабее).";
        }
      }
      const anim: ActionResult["combatAnim"] = {
        attacker: attackerPos,
        hits: [{ kind: "city", target: { col, row }, defenseBefore: buffer, defenseAfter: afterBuffer, garrisonBroken }],
      };
      return { lines: supportLines, hint, anim };
    }
    if (!defenders.length) return { lines: supportLines, anim: { attacker: attackerPos, hits: [] } };

    const order = defenders.slice().sort((a, b) => b.hp - a.hp);

    if (stats.aoe) {
      // AoE (Дальняя атака/Корабли) — бьёт по площади, поддержку не получает в принципе
      // (supportersFor уже вернёт [] для этих категорий) — но урон дальнобойных всё равно удвоен
      // на защиту, как и в обычном бою.
      const dmgEach = atkPower;
      const hits: NonNullable<ActionResult["combatAnim"]>["hits"] = [];
      for (const d of order) {
        const defenseBefore = this.unitTotalDefense(d);
        const hpBefore = d.hp;
        this.applyDamage(d, dmgEach, atkDoubleDefense);
        hits.push({ kind: "unit", target: { col: d.col, row: d.row }, defenseBefore, defenseAfter: this.unitTotalDefense(d), hpBefore, hpAfter: d.hp, hpMax: this.unitStats(d).hp });
      }
      this.removeDeadUnits(order);
      return { lines: supportLines, anim: { attacker: attackerPos, hits } };
    }

    const defender = order[0];
    const atkSupporters = this.supportersFor(attacker);
    const defSupporters = defender.playerId !== attacker.playerId ? this.supportersFor(defender) : [];
    for (const s of atkSupporters) supportLines.push({ from: { col: s.col, row: s.row }, to: { col: attacker.col, row: attacker.row } });
    for (const s of defSupporters) supportLines.push({ from: { col: s.col, row: s.row }, to: { col: defender.col, row: defender.row } });

    const defDefenseBefore = this.unitTotalDefense(defender);
    const defHpBefore = defender.hp;
    const defHpMax = this.unitStats(defender).hp;
    this.applyDamage(defender, atkPower + atkSupporters.length, atkDoubleDefense);
    let counterOnAttacker: NonNullable<ActionResult["combatAnim"]>["counterOnAttacker"];
    if (defender.hp > 0) {
      const defStats = this.unitStats(defender);
      const defDoubleDefense = defender.category === "ranged";
      const atkDefenseBefore = this.unitTotalDefense(attacker);
      const atkHpBefore = attacker.hp;
      this.applyDamage(attacker, defStats.attack + defSupporters.length, defDoubleDefense);
      counterOnAttacker = { defenseBefore: atkDefenseBefore, defenseAfter: this.unitTotalDefense(attacker), hpBefore: atkHpBefore, hpAfter: attacker.hp, hpMax: this.unitStats(attacker).hp };
      if (dist <= 1 && attacker.hp > 0 && defender.hp > 0 && defender.hp <= attacker.hp) {
        const spot = this.hexNeighborsGameplay(defender.col, defender.row).find(([nc, nr]) => this.unitPassable(defender, nc, nr) && this.canEnterHex(defender, nc, nr));
        if (spot) {
          defender.col = spot[0];
          defender.row = spot[1];
        } else {
          defender.hp = 0;
        }
      }
    }
    this.units = this.units.filter((u) => u.hp > 0);
    const anim: ActionResult["combatAnim"] = {
      attacker: attackerPos,
      hits: [{ kind: "unit", target: { col, row }, defenseBefore: defDefenseBefore, defenseAfter: this.unitTotalDefense(defender), hpBefore: defHpBefore, hpAfter: defender.hp, hpMax: defHpMax }],
      counterOnAttacker,
    };
    return { lines: supportLines, anim };
  }

  /** Постройка юнита («Воин», ТЗ 5.1) — портирован из main.ts:buildUnit. */
  buildUnitCard(playerId: number, slotIndex: number, cityId: number, unitId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "warrior" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Воин» недоступна в этом слоте." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Город не найден." };
    const unit = UNITS.find((u) => u.id === unitId);
    if (!unit) return { ok: false, hint: "Такого юнита не существует." };
    if (this.oonArmsLimit !== null && this.units.filter((u) => u.playerId === playerId).length >= this.oonArmsLimit) {
      return { ok: false, hint: `Резолюция ООН «Сдерживание вооружений» ограничивает армию ${this.oonArmsLimit} юнитами — лимит уже достигнут (старые юниты не распускаются, но новые строить нельзя).` };
    }
    const cost = GameSession.EPOCH_UNIT_COST[unit.epoch];
    const woodenOverride =
      unit.category === "ship" ? GameSession.WOODEN_SHIP_RESOURCE_COST[unit.epoch] : unit.category === "ranged" ? GameSession.WOODEN_RANGED_RESOURCE_COST[unit.epoch] : undefined;
    const resources = woodenOverride ?? cost.resources;

    if (unit.category === "ship" && !this.shipSpawnHex(city)) return { ok: false, hint: "У этого города нет свободного моря рядом — корабль строить негде." };
    if (this.money[playerId] < cost.money) return { ok: false, hint: `Не хватает денег (нужно ${cost.money} 💰).` };
    const plan = this.planResourceSpend(playerId, city, resources);
    if (!plan) return { ok: false, hint: "Не набралось нужных ресурсов." };

    this.money[playerId] -= cost.money;
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
    const unitCount = this.playerParadigm[playerId] === "fascism" ? 2 : 1;
    for (let i = 0; i < unitCount; i++) {
      const spot = unit.category === "ship" ? this.shipSpawnHex(city) : null;
      this.units.push({
        id: this.nextUnitId++,
        playerId,
        cityId: city.id,
        category: unit.category,
        epoch: unit.epoch,
        col: spot ? spot.col : city.col,
        row: spot ? spot.row : city.row,
        hp: statsFor(unit.category, unit.epoch).hp,
        defending: false,
        raiding: false,
        moveOrder: null,
      });
    }
    return { ok: true };
  }

  /** Казарма (ТЗ 4.4) — «без карты» аналог карты «Воин»: та же цена по эпохе, тот же выбор категории
   * юнита, тот же лимит ООН «Сдерживание вооружений» и бонус Фашизма (2 юнита за цену 1) — просто
   * действие тратится ЗДАНИЕМ (`buildingActionGate`/`spendBuildingAction`, с поправкой на бесплатную
   * активацию у Парламентаризма), а не картой из руки. Живой баг-репорт — «построил Казарму, но нет
   * кнопки воспользоваться» — эффект был описан в buildings.ts, но ни разу не реализован ни на
   * сервере, ни в клиенте (BUILDING_USE_LABEL не содержал кazarma вовсе). Здание общее на игрока, не
   * привязано к конкретному городу (см. buildings.ts) — юнит можно построить в ЛЮБОМ своём городе,
   * не обязательно в том, где физически стоит Казарма. */
  useKazarma(playerId: number, cityId: number, unitId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "kazarma", playerId)) return { ok: false, hint: "У вас нет здания «Казарма»." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Город не найден." };
    const unit = UNITS.find((u) => u.id === unitId);
    if (!unit) return { ok: false, hint: "Такого юнита не существует." };
    if (this.oonArmsLimit !== null && this.units.filter((u) => u.playerId === playerId).length >= this.oonArmsLimit) {
      return { ok: false, hint: `Резолюция ООН «Сдерживание вооружений» ограничивает армию ${this.oonArmsLimit} юнитами — лимит уже достигнут (старые юниты не распускаются, но новые строить нельзя).` };
    }
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const cost = GameSession.EPOCH_UNIT_COST[unit.epoch];
    const woodenOverride =
      unit.category === "ship" ? GameSession.WOODEN_SHIP_RESOURCE_COST[unit.epoch] : unit.category === "ranged" ? GameSession.WOODEN_RANGED_RESOURCE_COST[unit.epoch] : undefined;
    const resources = woodenOverride ?? cost.resources;
    if (unit.category === "ship" && !this.shipSpawnHex(city)) return { ok: false, hint: "У этого города нет свободного моря рядом — корабль строить негде." };
    if (this.money[playerId] < cost.money) return { ok: false, hint: `Не хватает денег (нужно ${cost.money} 💰).` };
    const plan = this.planResourceSpend(playerId, city, resources);
    if (!plan) return { ok: false, hint: "Не набралось нужных ресурсов." };

    this.money[playerId] -= cost.money;
    this.commitSpend(playerId, plan);
    this.spendBuildingAction(playerId);
    const unitCount = this.playerParadigm[playerId] === "fascism" ? 2 : 1;
    for (let i = 0; i < unitCount; i++) {
      const spot = unit.category === "ship" ? this.shipSpawnHex(city) : null;
      this.units.push({
        id: this.nextUnitId++,
        playerId,
        cityId: city.id,
        category: unit.category,
        epoch: unit.epoch,
        col: spot ? spot.col : city.col,
        row: spot ? spot.row : city.row,
        hp: statsFor(unit.category, unit.epoch).hp,
        defending: false,
        raiding: false,
        moveOrder: null,
      });
    }
    return { ok: true };
  }

  /** Клик по цели уже выбранным юнитом (ТЗ 5.3/6) — портирован из tryCommandSelectedUnit. Объявление
   * войны — раньше блокирующий window.confirm() в браузере; здесь явный round-trip: если требуется
   * подтверждение и войны ещё нет, действие НЕ применяется, возвращается needsWarConfirm — клиент
   * показывает confirm(), при согласии шлёт action "declareWar", затем повторяет этот же вызов. */
  commandUnit(playerId: number, unitId: number, col: number, row: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    let unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return { ok: false, hint: "Юнит не найден." };
    // По прямому запросу — «если в качестве цели корабля выбрана суша, он должен сделать туда
    // высадку юнита на борту»: корабль сам физически не может встать на обычную сушу (unitPassable —
    // только море/город), так что если выбран именно корабль, а цель — суша, приказ ретранслируется
    // юниту на его борту (тот же гекс, категория не «ship»), если такой есть — вся дальнейшая логика
    // ниже (граница/осада/бой/движение) отрабатывает уже за НЕГО, ровно как если бы игрок сразу
    // выбрал этого пассажира. Раньше выбор корабля с сушей в качестве цели просто падал с общим
    // «путь заблокирован», даже когда пассажир на борту был и мог бы туда дойти.
    if (unit.category === "ship" && !this.unitPassable(unit, col, row)) {
      const rider = this.units.find((u) => u.id !== unit!.id && u.playerId === playerId && u.category !== "ship" && u.col === unit!.col && u.row === unit!.row);
      if (rider) unit = rider;
      else return { ok: false, hint: "Корабль сам не может зайти на сушу (только в город-гавань), а юнита на борту сейчас нет — некого высаживать." };
    }
    // Резервный юнит гарнизона (не голова очереди) — по прямому уточнению (ТЗ §14 п.1) его можно
    // вызвать из модалки города вне очереди, НО только ОДНИМ приказом: покинуть город обычным
    // перемещением. Атаковать, обороняться и оказывать поддержку он не может, пока физически не
    // выведен за пределы гекса города — это разруливается ниже (isEnemyTarget-ветка требует
    // commandable, а move-ветка для резерва дополнительно требует, чтобы цель была НЕ той же
    // городской клеткой).
    const commandable = this.isUnitCommandable(unit);
    if (this.landedThisCycle.has(unit.id)) return { ok: false, hint: "Этот юнит только что высадился на берег — ход исчерпан до начала следующего цикла." };

    const defenderCity = this.cityAt(col, row);
    const defenders = this.unitsAt(col, row).filter((u) => u.playerId !== playerId);
    // Гарнизон города = его население (по прямому уточнению) — своего буфера осады на ЭТОТ цикл
    // (citySiegeBuffer) ещё не пробивали ⇒ город обычная цель для атаки. Как только буфер пробит
    // (см. resolveCombat) — на ОСТАТОК этого цикла город становится целью для ВХОДА (перемещение),
    // а не для удара; не успели зайти до обнуления цикла — на новом буфер соберётся заново, снова
    // придётся пробивать (уже с меньшими силами, т.к. население после пробития -1).
    const citySiegeBroken = !!defenderCity && this.citySiegeBuffer.has(defenderCity.id) && this.citySiegeBuffer.get(defenderCity.id)! <= 0;
    const isEnemyTarget = defenders.length > 0 || (!!defenderCity && defenderCity.playerId !== playerId && !citySiegeBroken);

    if (isEnemyTarget) {
      if (!commandable) return { ok: false, hint: "Юнит в резерве гарнизона не может атаковать — сначала выведите его из города обычным перемещением." };
      if (this.outOfMoveThisCycle.has(unit.id)) return { ok: false, hint: "Юниту не хватило хода на этот гекс в этом цикле — атаковать он пока не может." };
      if (this.isAboardShip(unit)) return { ok: false, hint: "Юнит на борту корабля не может атаковать — сначала высадка на берег." };
      const targetPlayerId = defenders[0]?.playerId ?? defenderCity!.playerId;
      const stats = this.unitStats(unit);
      if (stats.attack <= 0) return { ok: false, hint: "Этот юнит не может атаковать." };
      const range = this.effectiveAttackRange(unit);
      const dist = this.hexDistance(unit.col, unit.row, col, row, range + 1);
      if (dist > range) return { ok: false, hint: `Цель вне дальности удара (${range}) — подведите юнита ближе.` };
      // Условие видимости (по прямому уточнению, ТЗ 6.6) — только для ударов НЕ в упор: нужен свой
      // юнит любой категории (включая корабли), стоящий в гексе, СОСЕДНЕМ С ЦЕЛЬЮ, — «передаёт
      // позицию». В упор (dist<=1) юнит и так сам видит соседний гекс, спотер не нужен.
      if (dist > 1) {
        const hasSpotter = this.hexNeighborsGameplay(col, row).some(([nc, nr]) => this.units.some((u) => u.playerId === playerId && u.col === nc && u.row === nr));
        if (!hasSpotter) return { ok: false, hint: "Нет видимости цели — нужен свой юнит в гексе, соседнем с целью (любой категории, включая корабли)." };
      }
      if (!this.relationOf(playerId, targetPlayerId).war) {
        return { ok: false, needsWarConfirm: { targetPlayerId, reason: "атака" } };
      }
      if (!this.chargeUnitActivation(unit)) return { ok: false, hint: "Не хватает денег (нужен 1💰) — атака невозможна." };
      this.unitActedThisCycle.add(unit.id);
      unit.defending = false; // любое действие юнита снимает «Оборону» (по прямому уточнению) — атака не исключение
      const combat = this.resolveCombat(unit, col, row);
      return { ok: true, supportLines: combat.lines.length ? combat.lines : undefined, hint: combat.hint, combatAnim: combat.anim };
    }

    if (!commandable) {
      // Резерву разрешён только уход С клетки города — цель обязана отличаться от текущего гекса,
      // иначе это была бы попытка «встать в оборону на месте» без выхода, что как раз запрещено.
      const homeCity = this.cityAt(unit.col, unit.row);
      if (homeCity && homeCity.col === col && homeCity.row === row) {
        return { ok: false, hint: "Юнит в резерве гарнизона нельзя выбрать напрямую — доступен только приказ покинуть город." };
      }
    }
    // Бюджет хода на ЭТОТ цикл уже исчерпан (движение теперь исполняется мгновенно, см. ниже — этот
    // юнит либо уже прошёл свой moveRange в этом же ходу, либо доел его автопродолжением с прошлого
    // цикла на границе). Считаем остаток бюджета напрямую, а не только по outOfMoveThisCycle — тот
    // флаг ставится лишь при НЕПОЛНОМ последнем шаге (не хватило на конкретный гекс), а юнит вполне
    // может ровно докрутить свой moveRange целыми шагами и остаться с бюджетом 0 без этого флага;
    // без прямой проверки второй приказ в тот же ход тихо спишет 1💰 и никуда не сдвинет юнита.
    const remainingMoveBudget = this.unitStats(unit).moveRange - (this.moveBudgetUsedThisCycle.get(unit.id) ?? 0);
    if (remainingMoveBudget <= 0) return { ok: false, hint: "Юниту не хватило хода в этом цикле — новый приказ движения можно отдать только со следующего цикла." };
    // «Нейтральные воды» (ООН, ТЗ §15.3) — перемещение по морю разрешено всем везде независимо от
    // договоров о границах, КРОМЕ захода в чужие города (те по-прежнему требуют войны/захвата).
    const neutralWatersBypass = this.oonNeutralWatersActive && this.isSeaTile(col, row) && !this.cityAt(col, row);
    const targetOwner = this.territoryOwnerOf(col, row);
    if (!neutralWatersBypass && targetOwner !== null && targetOwner !== playerId && !this.relationOf(playerId, targetOwner).agreements.has("openBorders")) {
      if (!this.relationOf(playerId, targetOwner).war) {
        return { ok: false, needsWarConfirm: { targetPlayerId: targetOwner, reason: "вход на чужую территорию без «Открытых границ»" } };
      }
    }
    const result = this.computeUnitPath(unit, col, row);
    if (!result || !result.path.length) {
      // [ИСПРАВЛЕНО] Подсказка была одна общая на все случаи «не дойти» — по прямому запросу
      // («проверь, что модалка объясняет, почему корабль не может туда попасть») разобрана на
      // конкретные причины там, где они легко узнаваемы прямо здесь, а не только «путь заблокирован».
      if (unit.category === "ship" && unit.epoch === 1 && this.isSeaTile(col, row) && !this.isCoastalSeaTile(col, row)) {
        return { ok: false, hint: "Галера (Э1) плавает только вдоль берега — эта клетка открытого моря слишком далеко от суши. С Каравеллы (Э2) это ограничение снимается." };
      }
      if (unit.category !== "ship" && this.isSeaTile(col, row) && !this.cityAt(col, row)) {
        return { ok: false, hint: "Сухопутный юнит не может зайти в открытое море — только на клетку города (гавань) или на клетку своего корабля (мост)." };
      }
      // По прямому запросу — «горы нужно запретить как место высадки, только если там не стоит
      // город, модалка должна давать соответствующую подсказку» (см. isMountainLandingBlocked).
      if (this.isAboardShip(unit) && this.doc.get(col, row).terrain === "mountains" && !this.cityAt(col, row)) {
        return { ok: false, hint: "Нельзя высадиться с корабля прямо в горы без города — слишком крутой берег. Высадитесь на другую соседнюю клетку суши, а дальше в горы уже пешком (дороже хода, но не запрещено)." };
      }
      return { ok: false, hint: "Туда не дойти — путь блокирован или недоступен для этого юнита." };
    }
    if (!this.chargeUnitActivation(unit)) return { ok: false, hint: "Не хватает денег (нужен 1💰) — приказ не отдан." };
    this.unitActedThisCycle.add(unit.id);
    unit.moveOrder = { path: result.path, nextIndex: 0 };
    unit.defending = false;
    // По прямому запросу — движение случается СРАЗУ, в этом же цикле, а не откладывается целиком до
    // границы следующего (см. walkUnitAlongOrder). Если путь длиннее бюджета хода на этот цикл,
    // остаток остаётся в unit.moveOrder и автопродолжится на будущих границах цикла, как и раньше.
    const movedPath = this.walkUnitAlongOrder(unit);
    const captured = citySiegeBroken && !!defenderCity && defenderCity.playerId === unit.playerId;
    let hint: string | undefined;
    if (citySiegeBroken && defenderCity) {
      hint = captured
        ? "Гарнизон пробит — город захвачен!"
        : "Приказ на захват отдан — юнит доберётся и войдёт в город, как только хватит хода (не успеет в этом цикле — гарнизон к новому циклу соберётся заново).";
    }
    return { ok: true, hint, movedPath: movedPath.length ? movedPath : undefined };
  }

  declareWar(playerId: number, targetId: number): ActionResult {
    const rel = this.relationOf(playerId, targetId);
    rel.war = true;
    rel.agreements.clear();
    return { ok: true };
  }

  private pairKey(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }
  private relationOf(a: number, b: number): Relation {
    const k = this.pairKey(a, b);
    if (!this.relations[k]) this.relations[k] = { war: false, agreements: new Set() };
    return this.relations[k];
  }

  toggleDefend(playerId: number, unitId: number): ActionResult {
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return { ok: false, hint: "Юнит не найден." };
    if (!this.isUnitCommandable(unit)) return { ok: false, hint: "Юнит в резерве гарнизона не может встать в оборону, пока не выведен из города." };
    if (this.outOfMoveThisCycle.has(unit.id)) return { ok: false, hint: "Не хватило хода на этот гекс — оборона недоступна до нового цикла." };
    unit.defending = !unit.defending;
    unit.moveOrder = null;
    this.unitActedThisCycle.add(unit.id);
    return { ok: true };
  }

  /** Пиратство (корабль)/грабёж (сухопутный) — по прямому запросу: пока включено, юнит перехватывает
   * 1💰 с любого розыгрыша «Торговца» другим игроком, чей маршрут проходит через гекс этого юнита
   * (см. traderTrade). Тот же переключатель-паттерн, что toggleDefend. */
  toggleRaid(playerId: number, unitId: number): ActionResult {
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return { ok: false, hint: "Юнит не найден." };
    if (!this.isUnitCommandable(unit)) return { ok: false, hint: "Юнит в резерве гарнизона не может грабить/пиратствовать, пока не выведен из города." };
    if (this.outOfMoveThisCycle.has(unit.id)) return { ok: false, hint: "Не хватило хода на этот гекс — недоступно до нового цикла." };
    unit.raiding = !unit.raiding;
    unit.moveOrder = null;
    unit.defending = false; // любое действие юнита снимает «Оборону» (по прямому уточнению)
    this.unitActedThisCycle.add(unit.id);
    return { ok: true };
  }

  /** Ручная смена активного юнита гарнизона (по прямому запросу) — «сделать верхним юнитом другого,
   * текущий уйдёт в запас». Разрешено, только пока ТЕКУЩИЙ активный юнит ЕЩЁ НЕ действовал в этом
   * цикле (`unitActedThisCycle`) — иначе правило «активен только один» можно было бы обходить,
   * подставляя нового бойца сразу после того, как предыдущий уже отыграл своё. Уходящий в запас
   * теряет «Оборону» (defending=false) — эта команда даёт эффект только активному юниту (удвоение
   * защиты, §6.8); «Грабёж»/«Пиратство» НЕ снимается — это пассивный эффект по позиции клетки, не
   * требует активного статуса (см. traderTrade). Бесплатно — не тратит действие/деньги, это выбор
   * КОГО из уже стоящих в городе юнитов игрок хочет иметь возможность применить, а не новый приказ. */
  promoteGarrisonUnit(playerId: number, unitId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return { ok: false, hint: "Юнит не найден." };
    const city = this.cityAt(unit.col, unit.row);
    if (!city) return { ok: false, hint: "Смена активного юнита доступна только в гарнизоне города." };
    const queue = this.cityGarrisonQueue(city.col, city.row);
    const current = queue[0];
    if (!current) return { ok: false, hint: "В городе нет юнитов." };
    if (current.id === unit.id) return { ok: false, hint: "Этот юнит уже активен." };
    if (this.unitActedThisCycle.has(current.id)) {
      return { ok: false, hint: "Текущий активный юнит уже действовал в этом цикле — сменить его можно только со следующего цикла." };
    }
    current.defending = false;
    unit.garrisonRank = this.nextGarrisonRank--;
    return { ok: true };
  }

  buyListing(playerId: number, listingId: number): ActionResult {
    const listing = this.market.find((l) => l.id === listingId);
    if (!listing || listing.sellerId === playerId) return { ok: false, hint: "Лот недоступен." };
    if (this.money[playerId] < listing.price) return { ok: false, hint: "Недостаточно денег для покупки этого лота." };
    if (listing.kind === "card") {
      // По прямому уточнению — «не режь получение карт сверх лимита, это игрок сам не должен
      // допускать, а не сервер»: раньше здесь блокировалась покупка при заполненной руке, что било
      // ту же механику, что и капание раздачи (уже исправлено, см. endTurn) — предел 7 карт
      // проверяется только в конце СВОЕГО хода игрока (resolveHandOverflowDiscard), не на приёме.
      this.hands[playerId].push(listing.card!);
      const sellerHand = this.hands[listing.sellerId];
      sellerHand.splice(listing.sellerSlotIndex!, 1);
      this.shiftListingSlotsAfterRemoval(listing.sellerId, listing.sellerSlotIndex!);
    } else {
      this.addToWarehouse(playerId, listing.resource!, 1);
    }
    this.money[playerId] -= listing.price;
    if (listing.sellerId !== WORLD_SELLER) this.money[listing.sellerId] += listing.price;
    this.market.splice(this.market.indexOf(listing), 1);
    // Постоянные лоты биржи (см. seedStartingMarket) не пропадают навсегда — тут же появляются заново
    // по более высокой цене, без верхнего предела (в отличие от обычных лотов игроков, капнутых на 10).
    if (listing.sellerId === WORLD_SELLER && listing.kind === "resource" && GameSession.WORLD_MARKET_RESOURCES.includes(listing.resource!)) {
      // «Регуляция цен» (ООН, ТЗ §15.3) — если на этот ресурс действует фиксированная цена, мировой
      // лот возобновляется по НЕЙ, а не растёт на обычный шаг.
      const priceReg = this.oonPriceRegulation;
      const regulated = priceReg && priceReg.resource === listing.resource ? priceReg.price : null;
      this.market.push({
        id: this.nextListingId++,
        sellerId: WORLD_SELLER,
        kind: "resource",
        resource: listing.resource!,
        price: regulated ?? listing.price + GameSession.WORLD_MARKET_PRICE_STEP,
      });
    }
    return { ok: true };
  }

  /** Обязательная передача карты (ТЗ 2.3) — единственное действие, разрешённое пока `mustHandoff`
   * не снят (см. gate в dispatch()). Не тратит действий и не отнимает карту-эффект — просто меняет
   * владельца одной карты в руке. */
  handoffCard(playerId: number, slotIndex: number, targetPlayerId: number): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!this.mustHandoff.has(playerId)) return { ok: false, hint: "Сейчас нечего передавать." };
    if (targetPlayerId === playerId) return { ok: false, hint: "Нельзя передать карту самому себе." };
    if (!this.players[targetPlayerId]) return { ok: false, hint: "Такого игрока нет." };
    const hand = this.hands[playerId];
    const card = hand[slotIndex];
    if (!card) return { ok: false, hint: "Такой карты нет в руке." };
    if (card.freeMonarchy) return { ok: false, hint: "Бесплатного «Рабочего» Монархии нельзя передать другому игроку — выберите другую карту." };
    // Запрет — на КОНКРЕТНУЮ карту, не на игрока целиком (по прямому уточнению): нельзя вернуть
    // ИМЕННО ЭТОТ экземпляр обратно тому, кто его вам дал; другую карту тому же игроку — можно.
    // `receivedFrom` живёт на самой карте (см. cards.ts) и чистится, когда она уходит в сброс —
    // возврат снимает блокировку, ровно как и передача этой же карты дальше третьему игроку.
    if (card.receivedFrom === targetPlayerId) {
      return { ok: false, hint: `Нельзя вернуть эту карту обратно ${this.players[targetPlayerId].name} — именно он(а) дал(а) вам её в прошлый раз. Выберите другую карту или другого игрока.` };
    }
    // Передача — принудительная (не выбор игрока-дарителя), поэтому «рука уже полна» её не
    // блокирует (по прямому уточнению — «8-ю карту можно»): получатель просто дойдёт до 8 карт и
    // сбросит всю руку на своём следующем конце хода, как обычно (ТЗ 2.3.1) — не другое исключение.
    hand.splice(slotIndex, 1);
    this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
    card.receivedFrom = playerId;
    this.hands[targetPlayerId].push(card);
    this.mustHandoff.delete(playerId);
    return { ok: true };
  }

  playCard(playerId: number, slotIndex: number): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const hand = this.hands[playerId];
    const card = hand[slotIndex];
    if (!card || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Эту карту сейчас нельзя сыграть." };
    card.receivedFrom = undefined;
    this.deck.push(card);
    hand.splice(slotIndex, 1);
    this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
    this.actionsLeft[playerId]--;
    return { ok: true };
  }

  // === Технологии / гос. управление (ТЗ 4.2/11.6) =================================================

  private branchTechOrder(branch: TechDef["branch"]): TechDef[] {
    return TECH_TREE.filter((t) => t.branch === branch); // TECH_TREE уже в порядке эпох
  }
  /** Сколько позиций ветки подряд от начала уже коллективно закрыты — КЕМ УГОДНО, каждая позиция
   * может быть закрыта РАЗНЫМИ игроками (это не «сколько технологий у ОДНОГО игрока», а «докуда
   * партия в целом дошла БЕЗ ПРОПУСКОВ»). По прямому уточнению технология
   * на позиции N становится доступна для исследования ЛЮБОМУ игроку, если позиция N−1 той же ветки
   * уже исследована кем-то (не обязательно тем же игроком) — значит окно допустимых позиций для
   * исследования это [0 .. branchGroupDepth] включительно (см. availableResearchFor ниже): позиция
   * branchGroupDepth — это ровно то самое «ещё никем не открытое», позиции до неё — уже известные
   * партии, но каждый игрок лично может их не иметь (и переоткрыть, см. researchTech). */
  private branchGroupDepth(branch: TechDef["branch"]): number {
    const order = this.branchTechOrder(branch);
    let depth = 0;
    while (depth < order.length && this.players.some((p) => this.researchedTechs[p.id].has(order[depth].id))) depth++;
    return depth;
  }
  /** Портирован из availableResearchFor — по прямому уточнению («если игроками уже открыты
   * Бронзовое дело, Колесо и Каменная кладка — неважно кем — то уже доступны Горное дело,
   * Письменность и Мистицизм, а Гончарное дело нет, раз Мореплавание никем не открыто») предлагает
   * КАЖДУЮ технологию от начала ветки до branchGroupDepth ВКЛЮЧИТЕЛЬНО, которой у ИГРОКА ещё нет —
   * не бесплатно, каждую всё ещё нужно исследовать за карту+действие+ресурсы (см. confirmResearch).
   * Технологию, которую уже открыл кто-то другой, можно открыть повторно (получить её юнитов/
   * здания), но бонус первооткрывателя (авто-маршрут, право основать религию) при этом не
   * достаётся — см. researchTech, гейт на techDiscoverer. Может вернуть больше одной строки на
   * одну ветку — это ожидаемо, значит игрок отстал сразу на несколько позиций. */
  private availableResearchFor(playerId: number): TechDef[] {
    const maxEpoch = this.maxEligibleEpoch(playerId);
    const out: TechDef[] = [];
    for (const b of BRANCHES) {
      const order = this.branchTechOrder(b);
      const groupDepth = this.branchGroupDepth(b);
      for (let idx = 0; idx <= groupDepth && idx < order.length; idx++) {
        const t = order[idx];
        if (this.researchedTechs[playerId].has(t.id)) continue;
        if (t.epoch > maxEpoch) continue;
        out.push(t);
      }
    }
    return out;
  }
  private playerEpoch(playerId: number): TechDef["epoch"] {
    let max: TechDef["epoch"] = 1;
    for (const techId of this.researchedTechs[playerId]) {
      const t = TECH_TREE.find((x) => x.id === techId);
      if (t && t.epoch > max) max = t.epoch;
    }
    return max;
  }
  /** Портирован из upgradePlayerUnits — исследование, поднимающее эпоху, мгновенно апгрейдит уже
   * существующих юнитов этого игрока. */
  private upgradePlayerUnits(playerId: number, newEpoch: TechDef["epoch"]) {
    for (const u of this.units) {
      if (u.playerId === playerId && u.epoch < newEpoch) {
        u.epoch = newEpoch;
        u.hp = statsFor(u.category, u.epoch).hp;
      }
    }
  }
  /** Портирован из researchTech — вызывается только из confirmResearch ниже (карта+действие уже
   * списаны там). **Автоматическая раздача технологий ниже по ветке — ВСЕМ игрокам, не только
   * исследовавшему (прямое уточнение пользователя, много раз переформулированное, отменяет более
   * раннюю трактовку п.5 ТЗ §14 — «открытость технологии не значит бесплатную раздачу»):**
   * - Сам исследующий игрок при выборе технологии на позиции P своей ветки ВСЕГДА получает заодно и
   *   все позиции 0..P-1 той же ветки, которых у него ещё нет лично (см. `grantWithBackfill`).
   * - **Если это НОВАЯ технология — ещё никем в партии не открытая** (`isNewFrontier`, продвигает
   *   коллективную границу ветки на 1 дальше) — ВСЕ ОСТАЛЬНЫЕ игроки тоже автоматически и бесплатно
   *   получают себе все позиции 0..P-1 той же ветки, которых у них ещё нет («Красный открыл
   *   Мистицизм — значит Каменная кладка (позиция перед ним) должна быть открыта у всех остальных»).
   *   Сама позиция P при этом остаётся личной у того, кто её открыл первым — не раздаётся другим
   *   автоматически, им всё ещё нужно исследовать её самим (тогда сработает уже не isNewFrontier-
   *   ветка, а обычный личный бэкфилл выше). */
  private researchTech(playerId: number, techId: string) {
    const tech = TECH_TREE.find((t) => t.id === techId);
    const isNewFrontier = !!tech && this.techDiscoverer[techId] === undefined;
    this.grantWithBackfill(playerId, techId);
    if (isNewFrontier && tech) {
      const order = this.branchTechOrder(tech.branch);
      const myIdx = order.findIndex((t) => t.id === techId);
      for (const p of this.players) {
        if (p.id === playerId) continue;
        const before = this.playerEpoch(p.id);
        for (let i = 0; i < myIdx; i++) {
          const backTech = order[i];
          if (!this.researchedTechs[p.id].has(backTech.id)) this.grantSingleTech(p.id, backTech.id);
        }
        const after = this.playerEpoch(p.id);
        if (after > before) this.upgradePlayerUnits(p.id, after);
      }
    }
  }

  /** Раздаёт `techId` игроку playerId, ПЕРЕД этим бесплатно добирая все позиции его ветки ниже,
   * которых у него ещё нет (см. `grantSingleTech` — те же бонусы первооткрывателя на каждую).
   * Эпоха игрока пересчитывается ОДИН раз в конце, по итогу всей пачки, не после каждой технологии. */
  private grantWithBackfill(playerId: number, techId: string) {
    const before = this.playerEpoch(playerId);
    const tech = TECH_TREE.find((t) => t.id === techId);
    if (tech) {
      const order = this.branchTechOrder(tech.branch);
      const myIdx = order.findIndex((t) => t.id === techId);
      for (let i = 0; i < myIdx; i++) {
        const backTech = order[i];
        if (!this.researchedTechs[playerId].has(backTech.id)) this.grantSingleTech(playerId, backTech.id);
      }
    }
    this.grantSingleTech(playerId, techId);
    const after = this.playerEpoch(playerId);
    if (after > before) this.upgradePlayerUnits(playerId, after);
  }

  /** Один грант технологии игроку — бонусы первооткрывателя (право основать религию/авто-маршрут/
   * «Философия»), БЕЗ пересчёта эпохи (её считает вызывающий `researchTech` один раз на всю пачку,
   * см. выше). Кто ЛИЧНО первым в партии открыл технологию — решает ДВЕ вещи: право ОСНОВАТЬ религию
   * (adoptReligion, RELIGION_FOUNDING_TECHS) и авто-прокладку торгового маршрута ниже. Технологию
   * МОЖНО переоткрыть повторно (юниты/здания достаются как обычно), но бонус первооткрывателя —
   * только тому, для кого этот if сработал — isFirstDiscovery. */
  private grantSingleTech(playerId: number, techId: string) {
    const isFirstDiscovery = this.techDiscoverer[techId] === undefined;
    if (isFirstDiscovery) this.techDiscoverer[techId] = playerId;
    this.researchedTechs[playerId].add(techId);
    const tech = TECH_TREE.find((t) => t.id === techId);
    // [ИСПРАВЛЕНО] Право прокладки маршрута — только личному первооткрывателю технологии (по
    // прямому уточнению), тем же принципом, что и бонус религии/«Философии» ниже (isFirstDiscovery).
    // Раньше право доставалось ЛЮБОМУ игроку, кто когда-либо исследовал маршрутную технологию —
    // из-за этого маршрут одной и той же технологии могли проложить сразу несколько игроков.
    // Если городов меньше 2 — право не пропадает молча, а сразу превращается в карту «Право
    // прокладки маршрута» (тот же путь, что и «маршрут геометрически не проложен» в pickRouteCities).
    if (tech?.route && isFirstDiscovery) {
      const myCities = this.cities.filter((c) => c.playerId === playerId);
      if (myCities.length >= 2) {
        this.pendingRoute = { playerId, techId, category: tech.route };
      } else {
        this.hands[playerId].push(makeRouteRightCard(techId, tech.route));
      }
    }
    // «Философия»/«Медицина» (techtree.ts, у обеих дословно «Разовый прирост населения +1 во всех
    // городах» в описании) — разовый прирост населения +1 во всех городах ПЕРВООТКРЫВАТЕЛЯ (по
    // прямому уточнению, тот же принцип «бонус — только isFirstDiscovery», что у маршрута/религии
    // выше); переоткрывшим технологию повторно эффект не положен. Живой баг-репорт — «синий открыл
    // Медицину, но не получил прирост» — эффект был описан в techtree.ts с самого начала (Медицина —
    // ещё и CITY_CAPACITY_TECHS, та половина эффекта работала), но сама раздача населения была
    // подключена только для «Философии», Медицину код здесь не проверял вовсе.
    if ((techId === "Философия" || techId === "Медицина") && isFirstDiscovery) {
      for (const c of this.cities) if (c.playerId === playerId) c.population += 1;
    }
    // «Письменность» (по прямому запросу) — первооткрыватель разово получает 1💰 за каждый
    // существующий на этот момент город любого другого игрока (нет тумана войны на счёт «видимый» —
    // считаются все чужие города, где бы они ни стояли).
    if (techId === "Письменность" && isFirstDiscovery) {
      this.money[playerId] += this.cities.filter((c) => c.playerId !== playerId).length;
    }
    // «Массмедиа» (по прямому запросу) — первооткрыватель разово получает 3 Контента на склад.
    if (techId === "Массмедиа" && isFirstDiscovery) {
      this.addToWarehouse(playerId, "content", 3);
    }
    // «Кодекс законов» бонус первооткрывателя (сокращение вдвое содержания построек/юнитов) —
    // применяется через techDiscoverer прямо в collectTaxes, здесь ничего дополнительно ставить не
    // нужно. «Рыцарство»/«Сталь» бонусы (урон/дальность) — применяются через techDiscoverer прямо в
    // unitStats. Все три постоянные «до конца партии», а не разовые, поэтому не нуждаются в
    // отдельном состоянии — сам techDiscoverer[techId] === playerId уже и есть флаг.
  }

  /** Структурная форма EPOCH_RESEARCH_COST (techtree.ts, человекочитаемые строки) — реально
   * СПИСЫВАЕТСЯ, а не только показывается. По прямому уточнению — Электричество больше не
   * обязательная строка цены (эпохи 5-6 требовали конкретно его, а производят его только ГЭС/АЭС,
   * из-за чего ветки без доступа к этим зданиям не могли исследовать вообще ничего с эпохи 5):
   * вместо него — Углеводороды, с ВОЗМОЖНОСТЬЮ замены на Электричество, они эквивалентны друг
   * другу (`anyOf`, buildings.ts). */
  private static RESEARCH_COST_LINES: Record<number, BuildingCostLine[]> = {
    1: [{ kind: "category", category: "food", count: 1 }],
    2: [{ kind: "category", category: "food", count: 1 }, { kind: "category", category: "strategic", count: 1 }],
    3: [{ kind: "category", category: "food", count: 1 }, { kind: "category", category: "strategic", count: 1 }, { kind: "category", category: "trade", count: 1 }],
    4: [{ kind: "category", category: "food", count: 1 }, { kind: "category", category: "strategic", count: 2 }, { kind: "category", category: "trade", count: 1 }],
    5: [{ kind: "category", category: "food", count: 1 }, { kind: "category", category: "strategic", count: 2 }, { kind: "anyOf", resources: ["hydrocarbons", "electricity"], count: 1 }],
    6: [
      { kind: "category", category: "food", count: 1 },
      { kind: "specific", resource: "rareEarth", count: 1 },
      { kind: "specific", resource: "uranium", count: 1 },
      { kind: "anyOf", resources: ["hydrocarbons", "electricity"], count: 1 },
    ],
  };

  /** Учёный — портирован из confirmResearch (в main.ts делится на startScientistPick + сам
   * confirmResearch; здесь один вызов, техId уже выбран клиентом из availableResearchFor). */
  confirmResearch(playerId: number, slotIndex: number, techId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "scientist" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Учёный» недоступна в этом слоте." };
    const tech = this.availableResearchFor(playerId).find((t) => t.id === techId);
    if (!tech) return { ok: false, hint: "Эта технология сейчас недоступна для исследования." };
    const capital = this.capitalCityOf(playerId);
    if (!capital) return { ok: false, hint: "Ещё нет столицы." };
    // [ИСПРАВЛЕНО, по прямому запросу] Раньше доступ для исследования брался со ВСЕХ городов игрока
    // разом (см. п.20 ЦИВА-ЖУРНАЛ.md) — по прямому уточнению это и есть та самая «логика, где ресурсы
    // берутся с нескольких городов одновременно», которую просили убрать во всей игре разом: «наука
    // списывается только со столицы и склада». У столицы с маленьким населением доступен только
    // столько НОВЫХ типов за цикл, сколько её население (accessBudgetFor) — не набралось прямо
    // сейчас, наберётся со следующего цикла или можно докупить на рынке/со склада.
    const costLines = GameSession.RESEARCH_COST_LINES[tech.epoch];
    const plan = this.planBuildingSpend(playerId, capital, costLines);
    if (!plan) return { ok: false, hint: `Не набралось ресурсов на исследование (эпоха ${tech.epoch}) — ни в столице, ни на складе, ни на рынке.` };
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
    this.researchTech(playerId, techId);
    return { ok: true };
  }

  /** Портирован из pickRouteCity — main.ts collects the 2 endpoint clicks one at a time (updating
   * local `pendingRoute.fromCityId` in between, no server-visible effect until the 2nd click), so
   * unlike growCity this collapses cleanly into one call taking both cities. */
  pickRouteCities(playerId: number, fromCityId: number, toCityId: number): ActionResult {
    if (!this.pendingRoute || this.pendingRoute.playerId !== playerId) return { ok: false, hint: "Сейчас нет технологии, ожидающей прокладки маршрута." };
    if (fromCityId === toCityId) return { ok: false, hint: "Второй город должен отличаться от первого." };
    const from = this.cities.find((c) => c.id === fromCityId && c.playerId === playerId);
    // Второй город — по прямому уточнению — не обязан быть своим: маршрут можно тянуть и к городу
    // другого игрока (доход по нему пойдёт по общей сети, см. tradeNetworkOf, только при наличии
    // торгового соглашения). Воюющим сторонам маршрут всё же недоступен.
    const to = this.cities.find((c) => c.id === toCityId);
    if (!from || !to) return { ok: false, hint: "Первый город должен быть своим, второй — любой существующий город." };
    if (to.playerId !== playerId && this.relationOf(playerId, to.playerId).war) {
      return { ok: false, hint: "Нельзя строить торговый маршрут к городу игрока, с которым идёт война." };
    }
    const { techId, category } = this.pendingRoute;
    const path = this.findRoutePath(from.col, from.row, to.col, to.row, category);
    this.pendingRoute = null;
    if (!path) {
      // По прямому уточнению — если маршрут некуда было проложить, право прокладки не пропадает, а
      // превращается в карту в руке (не считается в лимит руки, см. handCountedSize): можно
      // попробовать позже с другой парой городов, продать на рынке или передать другому игроку.
      this.hands[playerId].push(makeRouteRightCard(techId, category));
      return {
        ok: true,
        hint: `Маршрут не проложен — нет пути ≤ ${GameSession.MAX_ROUTE_HEXES} гексов без смешения суши/моря между этими городами. Право прокладки сохранено картой в руке.`,
      };
    }
    this.tradeRoutes.push({ id: this.nextRouteId++, playerId, techId, category, fromCityId: from.id, toCityId: to.id, path });
    return { ok: true };
  }

  /** Разыгрыш карты «Право прокладки маршрута» (см. makeRouteRightCard/pickRouteCities выше) — тот
   * же путь, только источник techId/category не this.pendingRoute, а сама карта. При неудаче карта
   * остаётся в руке (пробуйте другую пару городов) и действие не списывается — как и у остальных 6
   * карт действий, «не набралось» не тратит ни карту, ни действие. */
  playRouteRightCard(playerId: number, slotIndex: number, fromCityId: number, toCityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "routeRight" || !card.routeTechId || !card.routeCategory) {
      return { ok: false, hint: "В этом слоте нет карты «Право прокладки маршрута»." };
    }
    if (this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Действий не осталось в этом ходу." };
    if (fromCityId === toCityId) return { ok: false, hint: "Второй город должен отличаться от первого." };
    const from = this.cities.find((c) => c.id === fromCityId && c.playerId === playerId);
    const to = this.cities.find((c) => c.id === toCityId);
    if (!from || !to) return { ok: false, hint: "Первый город должен быть своим, второй — любой существующий город." };
    if (to.playerId !== playerId && this.relationOf(playerId, to.playerId).war) {
      return { ok: false, hint: "Нельзя строить торговый маршрут к городу игрока, с которым идёт война." };
    }
    const path = this.findRoutePath(from.col, from.row, to.col, to.row, card.routeCategory);
    if (!path) {
      const mixNote = card.routeCategory === "universal" ? " без смешения суши/моря" : "";
      return { ok: false, hint: `Маршрут не проложен — нет пути ≤ ${GameSession.MAX_ROUTE_HEXES} гексов${mixNote} между этими городами. Карта остаётся в руке.` };
    }
    this.tradeRoutes.push({ id: this.nextRouteId++, playerId, techId: card.routeTechId, category: card.routeCategory, fromCityId: from.id, toCityId: to.id, path });
    this.hands[playerId].splice(slotIndex, 1);
    this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
    this.actionsLeft[playerId]--;
    return { ok: true };
  }

  /** Портировано из adoptParadigm — includes the "skip next turn" penalty for the switch itself.
   * Никакого ограничения «уже принята другим игроком» — по прямому уточнению парадигма НЕ
   * эксклюзивна (в отличие от религии — там первую НЕОСНОВАННУЮ религию может основать только
   * личный первооткрыватель, см. adoptReligion): любой игрок с нужной технологией может принять
   * любую доступную ему парадигму независимо от выбора остальных игроков. */
  adoptParadigm(playerId: number, paradigm: Paradigm): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!this.researchedTechs[playerId].has(GameSession.PARADIGM_META[paradigm].tech)) return { ok: false, hint: "Технология для этой парадигмы ещё не исследована." };
    if (this.playerParadigm[playerId] === paradigm) return { ok: false, hint: "Эта парадигма уже принята." };
    this.playerParadigm[playerId] = paradigm;
    this.skippedTurn.add(playerId);
    this.skipTurnReason[playerId] = "paradigm";
    // Монархия даёт бесплатного «Рабочего» сразу при принятии, не дожидаясь конца цикла (дальше он
    // обновляется в endTurn'е, см. grantMonarchyWorkerCards).
    this.grantMonarchyWorkerCards();
    // Коммунизм больше НЕ сбрасывает религию — по прямому уточнению религия независима от текущей
    // парадигмы, в т.ч. Коммунизма (раньше он и блокировал выбор, и снимал уже принятую — оба
    // ограничения сняты, см. adoptReligion).
    return { ok: true };
  }

  /** По прямому уточнению — не только «Мистицизм»: три технологии ветки «религия» (эпохи 1-2) дают
   * право основать новую религию — «Мистицизм», «Философия», «Богословие». Любая из трёх, личным
   * (платным) исследованием, не бесплатной догонкой. */
  private static RELIGION_FOUNDING_TECHS = ["Мистицизм", "Философия", "Богословие"];
  /** Портировано из adoptReligion — по прямому уточнению разделено на два разных права: ОСНОВАТЬ
   * ещё никем не открытую религию может только тот, кто ЛИЧНО (платно, не бесплатной догонкой)
   * первым в партии исследовал одну из RELIGION_FOUNDING_TECHS (см. techDiscoverer/researchTech) —
   * «раньше можно было выбрать любую [религию], даже не открыв [её]». ПРИМКНУТЬ к уже основанной
   * религии (кем угодно) может ЛЮБОЙ игрок — по прямому уточнению религия не привязана ни к
   * парадигме (в т.ч. Коммунизму — раньше блокировал религию вообще, это снято), ни к наличию у
   * игрока технологии «Мистицизм» («принять монотеизм [парадигму] может любой, у кого открыта
   * технология, но религию — независимо от того, открыт ли у него монотеизм»). Парадигма и религия —
   * две полностью независимые системы, единственное пересечение — три технологии дают ПРАВО
   * ОСНОВАТЬ (ниже), не право примкнуть. */
  adoptReligion(playerId: number, religion: Religion): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (this.playerReligion[playerId] === religion) return { ok: false, hint: "Эта религия уже принята." };
    const alreadyFounded = this.religionFounder[religion] !== undefined;
    // Один игрок основывает не больше ОДНОЙ религии за партию (по прямому уточнению «у нас только 1
    // религия основана была, почему их стало две» — раньше первооткрыватель, переключаясь на другую
    // ещё не основанную религию, основывал и её тоже, плодя религии одним игроком).
    const alreadyFoundedByMe = Object.values(this.religionFounder).includes(playerId);
    const canFound = !alreadyFoundedByMe && GameSession.RELIGION_FOUNDING_TECHS.some((t) => this.techDiscoverer[t] === playerId);
    if (!alreadyFounded && !canFound) {
      return {
        ok: false,
        hint: alreadyFoundedByMe
          ? "Вы уже основали свою религию — основать вторую нельзя, можно только примкнуть к уже существующей."
          : "Основать ещё не открытую религию может только первооткрыватель «Мистицизма»/«Философии»/«Богословия» — вам доступно только присоединение к уже открытой религии.",
      };
    }
    this.playerReligion[playerId] = religion;
    if (!alreadyFounded) this.religionFounder[religion] = playerId;
    return { ok: true };
  }

  // === Дипломатия (ТЗ 11.7) =======================================================================

  /** Портировано из applyProposalTerms. */
  private applyProposalTerms(p: Proposal) {
    for (const term of p.terms) {
      if (term.kind === "agreement") {
        this.relationOf(p.from, p.to).agreements.add(term.agreement);
      } else if (term.kind === "peace") {
        this.relationOf(p.from, p.to).war = false;
      } else if (term.kind === "demandMoney") {
        const pay = Math.min(term.amount, this.money[p.to]);
        this.money[p.to] -= pay;
        this.money[p.from] += pay;
      } else if (term.kind === "offerMoney") {
        const pay = Math.min(term.amount, this.money[p.from]);
        this.money[p.from] -= pay;
        this.money[p.to] += pay;
      } else if (term.kind === "giveCity") {
        const c = this.cities.find((c) => c.id === term.cityId);
        if (c && c.playerId === p.from) this.transferCity(c, p.to);
      } else if (term.kind === "demandCity") {
        const c = this.cities.find((c) => c.id === term.cityId);
        if (c && c.playerId === p.to) this.transferCity(c, p.from);
      } else if (term.kind === "demandResource") {
        const qty = Math.min(term.qty, this.warehouse[p.to][term.resource] ?? 0);
        if (qty > 0 && this.takeFromWarehouse(p.to, term.resource, qty)) this.addToWarehouse(p.from, term.resource, qty);
      } else if (term.kind === "giveResource") {
        const qty = Math.min(term.qty, this.warehouse[p.from][term.resource] ?? 0);
        if (qty > 0 && this.takeFromWarehouse(p.from, term.resource, qty)) this.addToWarehouse(p.to, term.resource, qty);
      }
    }
  }

  /** Портировано из sendProposal. */
  sendProposal(playerId: number, to: number, terms: ProposalTerm[], ultimatum: boolean): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!terms.length) return { ok: false, hint: "Предложение не может быть пустым." };
    if (this.oonSanctionedPlayerId !== null && (playerId === this.oonSanctionedPlayerId || to === this.oonSanctionedPlayerId)) {
      return { ok: false, hint: "Резолюция ООН «Санкции» запрещает любую дипломатию с этим игроком." };
    }
    this.pendingProposals.push({ id: this.nextProposalId++, from: playerId, to, terms, ultimatum });
    return { ok: true };
  }

  /** Портировано из resolveProposal — принимает/отклоняет предложение, адресованное playerId
   * (в main.ts это негласно гарантировано тем, что модалка открывается только получателю в начале
   * его хода; сервер проверяет `p.to === playerId` явно). */
  resolveProposal(playerId: number, id: number, accepted: boolean): ActionResult {
    const idx = this.pendingProposals.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, hint: "Предложение не найдено — возможно, уже решено." };
    const p = this.pendingProposals[idx];
    if (p.to !== playerId) return { ok: false, hint: "Это предложение адресовано не вам." };
    this.pendingProposals.splice(idx, 1);
    if (accepted) this.applyProposalTerms(p);
    else if (p.ultimatum) this.declareWar(p.from, p.to);
    return { ok: true };
  }

  /** Портировано из breakOffRelations — тот же паттерн, что и уже перенесённый declareWar (никакой
   * проверки хода: разрыв соглашений, как и объявление войны, одностороннее мгновенное действие). */
  breakOffRelations(playerId: number, targetId: number): ActionResult {
    const rel = this.relationOf(playerId, targetId);
    rel.war = false;
    rel.agreements.clear();
    return { ok: true };
  }

  // === Торговые пути (ТЗ 4.1) =====================================================================

  /** Shortest hex path — портирован из findRoutePath. Деliberately НЕ через hexNeighborsGameplay
   * (не оборачивается вокруг карты) — см. комментарий у hexNeighborsGameplay выше и main.ts.
   * `category` здесь уже КОНКРЕТНАЯ (land/sea) — «universal» разруливает вызывающий findRoutePath
   * ниже, отдельным поиском на каждый вариант (см. его doc — почему НЕ единый проход с «любая клетка
   * проходима»). */
  private findRoutePathByCategory(fromCol: number, fromRow: number, toCol: number, toRow: number, category: "land" | "sea"): { col: number; row: number }[] | null {
    const passable = (col: number, row: number) => (category === "land" ? this.isLandTile(col, row) : this.isSeaTile(col, row));
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const startKey = `${fromCol},${fromRow}`;
    const endKey = `${toCol},${toRow}`;
    if (startKey === endKey) return [{ col: fromCol, row: fromRow }];

    const parent = new Map<string, string | null>();
    parent.set(startKey, null);
    let frontier = [startKey];
    for (let step = 0; step < GameSession.MAX_ROUTE_HEXES && frontier.length; step++) {
      const next: string[] = [];
      for (const key of frontier) {
        const [col, row] = key.split(",").map(Number);
        for (const [nc, nr] of hexNeighbors(col, row)) {
          if (nc < 0 || nc >= width || nr < 0 || nr >= height) continue;
          const nk = `${nc},${nr}`;
          if (parent.has(nk)) continue;
          const isEndpoint = nk === endKey;
          if (!isEndpoint && !passable(nc, nr)) continue;
          parent.set(nk, key);
          if (isEndpoint) {
            const path: { col: number; row: number }[] = [];
            let k: string | null = nk;
            while (k) {
              const [c, r] = k.split(",").map(Number);
              path.unshift({ col: c, row: r });
              k = parent.get(k) ?? null;
            }
            return path;
          }
          next.push(nk);
        }
      }
      frontier = next;
    }
    return null;
  }

  /** «Универсальный» маршрут (Торговый путь/Банковское дело/Авиация/Космонавтика) НЕ смешивает сушу
   * и море В ОДНОМ пути (по прямому уточнению — «либо суша, либо море, просто универсальный
   * позволяет выбрать 1 из 2») — считает ОБА варианта отдельными поисками (land-only, sea-only) и
   * берёт тот, что короче; если проходим только один — берёт его, если ни один — маршрута нет.
   * land/sea категории (обычные технологии-маршруты) — как раньше, один прямой поиск по своей
   * местности. */
  private findRoutePath(fromCol: number, fromRow: number, toCol: number, toRow: number, category: TradeRoute["category"]): { col: number; row: number }[] | null {
    if (category !== "universal") return this.findRoutePathByCategory(fromCol, fromRow, toCol, toRow, category);
    const landPath = this.findRoutePathByCategory(fromCol, fromRow, toCol, toRow, "land");
    const seaPath = this.findRoutePathByCategory(fromCol, fromRow, toCol, toRow, "sea");
    if (landPath && seaPath) return landPath.length <= seaPath.length ? landPath : seaPath;
    return landPath ?? seaPath;
  }

  /** Число РАЗНЫХ видов торгового ресурса на складе (каждый вид считается один раз, сколько бы
   * единиц его ни было) — цена всех трёх действий карты «Торговый путь» ниже: «2 РАЗНЫХ торговых
   * ресурса», не любые 2 единицы (по прямому уточнению переосмысления карты). Читает эффективный
   * склад (effectiveWarehouseFor) — у Коммунистов добываемые типы столицы считаются лежащими на
   * складе всегда, как и везде. */
  private uniqueTradeResourceTypeCount(playerId: number): number {
    return (Object.entries(this.effectiveWarehouseFor(playerId)) as [ResourceId, number][]).filter(
      ([id, qty]) => (qty ?? 0) > 0 && GameSession.RESOURCE_META.get(id)!.category === "trade"
    ).length;
  }
  /** Списывает по 1 единице с `count` РАЗНЫХ видов торгового ресурса (не `count` единиц одного и
   * того же вида) — вызывающий обязан сперва убедиться через uniqueTradeResourceTypeCount. Через
   * takeFromWarehouse (не прямая арифметика) — «бесконечные» типы Коммунизма могут не иметь
   * настоящего остатка вовсе, там взятие просто no-op'ается, а не уходит в минус. */
  private spendUniqueTradeResourcesFromWarehouse(playerId: number, count: number): boolean {
    const types = (Object.entries(this.effectiveWarehouseFor(playerId)) as [ResourceId, number][]).filter(
      ([id, qty]) => (qty ?? 0) > 0 && GameSession.RESOURCE_META.get(id)!.category === "trade"
    );
    if (types.length < count) return false;
    for (let i = 0; i < count; i++) this.takeFromWarehouse(playerId, types[i][0], 1);
    return true;
  }

  /** Карта «Торговый путь» переосмыслена (по прямому запросу — раньше умела только «перенаправить
   * существующий путь» или «оставить как есть», из-за чего была бесполезна, пока в партии не
   * проложен хотя бы один маршрут вообще): теперь три равноценных действия на выбор — проложить
   * новый (этот метод), перенаправить существующий (redirectTradeRoute) или удалить существующий
   * (deleteTradeRoute) — каждое стоит 2 РАЗНЫХ торговых ресурса. Новый маршрут всегда категории
   * «universal» (не завязан на технологию, как маршруты Банковского дела/Авиации/Космонавтики) —
   * значит выбирается более короткий из ДВУХ чистых вариантов (целиком по суше или целиком по морю),
   * а не любая технология конкретно ограничена одним из них, см. findRoutePath. */
  layNewTradeRoute(playerId: number, slotIndex: number, fromCityId: number, toCityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "tradeRoute" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Торговый путь» недоступна в этом слоте." };
    if (this.uniqueTradeResourceTypeCount(playerId) < 2) return { ok: false, hint: "Нужно 2 РАЗНЫХ вида торгового ресурса на складе — карту сыграть нельзя." };
    if (fromCityId === toCityId) return { ok: false, hint: "Второй город должен отличаться от первого." };
    const from = this.cities.find((c) => c.id === fromCityId && c.playerId === playerId);
    const to = this.cities.find((c) => c.id === toCityId);
    if (!from || !to) return { ok: false, hint: "Первый город должен быть своим, второй — любой существующий город." };
    if (to.playerId !== playerId && this.relationOf(playerId, to.playerId).war) {
      return { ok: false, hint: "Нельзя проложить торговый маршрут к городу игрока, с которым идёт война." };
    }
    const path = this.findRoutePath(from.col, from.row, to.col, to.row, "universal");
    if (!path) return { ok: false, hint: `Маршрут не проложен — нет пути ≤ ${GameSession.MAX_ROUTE_HEXES} гексов без смешения суши/моря между этими городами. Карта остаётся в руке.` };
    if (!this.spendUniqueTradeResourcesFromWarehouse(playerId, 2)) return { ok: false, hint: "Торговых ресурсов на складе стало меньше 2 разных видов — маршрут не проложен." };
    this.tradeRoutes.push({ id: this.nextRouteId++, playerId, techId: card.label, category: "universal", fromCityId: from.id, toCityId: to.id, path });
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** Портировано из pickRedirectCity — main.ts's 2-step target pick (which city is a route endpoint,
   * then the replacement) collapses into one call: `oldEndpointCityId` says WHICH end to replace
   * (equivalent to main.ts's step-1 city click), `newCityId` is the replacement (step-2 click).
   * [ИСПРАВЛЕНО, по прямому уточнению] Новый конец маршрута теперь может принадлежать ЛЮБОМУ игроку,
   * не обязательно исходному владельцу пути — маршрут при этом целиком переходит новому владельцу
   * (`route.playerId`), так карта становится инструментом отбора чужих торговых путей себе, а не
   * только их перестройки внутри сети исходного владельца. */
  redirectTradeRoute(playerId: number, slotIndex: number, routeId: number, oldEndpointCityId: number, newCityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "tradeRoute" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Торговый путь» недоступна в этом слоте." };
    if (this.uniqueTradeResourceTypeCount(playerId) < 2) return { ok: false, hint: "Нужно 2 РАЗНЫХ вида торгового ресурса на складе — карту сыграть нельзя." };
    if (!this.tradeRoutes.length) return { ok: false, hint: "На карте нет ни одного торгового пути — перенаправлять нечего." };
    const route = this.tradeRoutes.find((r) => r.id === routeId);
    if (!route) return { ok: false, hint: "Такого маршрута не существует." };
    if (oldEndpointCityId !== route.fromCityId && oldEndpointCityId !== route.toCityId) return { ok: false, hint: "Этот город не является концом выбранного пути." };
    const newCity = this.cities.find((c) => c.id === newCityId);
    if (!newCity) return { ok: false, hint: "Такого города не существует." };
    const fixedCityId = route.fromCityId === oldEndpointCityId ? route.toCityId : route.fromCityId;
    if (newCityId === oldEndpointCityId || newCityId === fixedCityId) return { ok: false, hint: "Этот город уже один из концов пути — выберите другой." };
    if (!this.spendUniqueTradeResourcesFromWarehouse(playerId, 2)) return { ok: false, hint: "Торговых ресурсов на складе стало меньше 2 разных видов — перенаправить не вышло." };
    const fixedCity = this.cities.find((c) => c.id === fixedCityId)!;
    const path = this.findRoutePath(fixedCity.col, fixedCity.row, newCity.col, newCity.row, route.category);
    this.consumeHandCard(playerId, slotIndex);
    if (!path) return { ok: false, hint: `Перенаправить некуда (нет пути ≤ ${GameSession.MAX_ROUTE_HEXES} гексов до нового города) — маршрут остался как был.` };
    if (route.fromCityId === oldEndpointCityId) route.fromCityId = newCityId;
    else route.toCityId = newCityId;
    route.path = path;
    route.playerId = newCity.playerId;
    return { ok: true };
  }

  /** Удаление существующего торгового пути — третье из трёх равноценных действий карты «Торговый
   * путь» (см. layNewTradeRoute), тем же принципом «чей угодно маршрут», что и у перенаправления
   * выше: платящий игрок не обязан быть его владельцем. */
  deleteTradeRoute(playerId: number, slotIndex: number, routeId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "tradeRoute" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Торговый путь» недоступна в этом слоте." };
    if (this.uniqueTradeResourceTypeCount(playerId) < 2) return { ok: false, hint: "Нужно 2 РАЗНЫХ вида торгового ресурса на складе — карту сыграть нельзя." };
    if (!this.tradeRoutes.length) return { ok: false, hint: "На карте нет ни одного торгового пути — удалять нечего." };
    const idx = this.tradeRoutes.findIndex((r) => r.id === routeId);
    if (idx === -1) return { ok: false, hint: "Такого маршрута не существует." };
    if (!this.spendUniqueTradeResourcesFromWarehouse(playerId, 2)) return { ok: false, hint: "Торговых ресурсов на складе стало меньше 2 разных видов — удалить не вышло." };
    this.tradeRoutes.splice(idx, 1);
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  private applyTradeRouteNegative(playerId: number): string {
    if (this.money[playerId] > 0) {
      this.money[playerId] = 0;
      return "денежный баланс обнулён.";
    }
    if (this.warehouseTotal(playerId) > 0) {
      this.warehouse[playerId] = {};
      return "денег не было — склад опустошён.";
    }
    return "терять было нечего — эффекта нет.";
  }

  // === Экономика: продажа, налоги, катастрофа, мобилизация (ТЗ 3.2/11.5) =========================

  /** Портировано из startSellCard+finalizeSellListing — main.ts's price-picker modal collapses into
   * one call, price already chosen client-side. */
  sellCard(playerId: number, slotIndex: number, price: number): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!Number.isInteger(price) || price < 1 || price > 10) return { ok: false, hint: "Цена должна быть целым числом от 1 до 10." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.kind !== "action") return { ok: false, hint: "Эту карту нельзя выставить на продажу." };
    if (card.freeMonarchy) return { ok: false, hint: "Бесплатного «Рабочего» Монархии нельзя продать." };
    if (this.market.some((l) => l.kind === "card" && l.sellerId === playerId && l.sellerSlotIndex === slotIndex)) return { ok: false, hint: "Эта карта уже выставлена на продажу." };
    this.market.push({ id: this.nextListingId++, sellerId: playerId, kind: "card", card, price, sellerSlotIndex: slotIndex });
    return { ok: true };
  }

  /** Портировано из startSellResource+finalizeSellListing. */
  sellResource(playerId: number, resource: ResourceId, price: number): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    // «Регуляция цен» (ООН, ТЗ §15.3) — жёстко фиксирует цену конкретного ресурса на бирже, игрок
    // при выставлении лота этого ресурса больше не выбирает цену сам.
    const regulated = this.oonPriceRegulation?.resource === resource ? this.oonPriceRegulation.price : null;
    const finalPrice = regulated ?? price;
    if (!Number.isInteger(finalPrice) || finalPrice < 1 || (regulated === null && finalPrice > 10)) return { ok: false, hint: "Цена должна быть целым числом от 1 до 10." };
    if (!this.takeFromWarehouse(playerId, resource, 1)) return { ok: false, hint: "Ресурс закончился на складе." };
    this.market.push({ id: this.nextListingId++, sellerId: playerId, kind: "resource", resource, price: finalPrice });
    return { ok: true };
  }

  private totalPopulationOf(playerId: number): number {
    return this.cities.filter((c) => c.playerId === playerId).reduce((sum, c) => sum + c.population, 0);
  }

  /** «Соберите налоги» — портировано из collectTaxes. `interactive`: true (voluntary play) may leave
   * a this.pendingTaxShortfall for resolveTaxShortfall; false (forced discard) auto-picks newest
   * units first, then buildings — no ActionResult/hint involved, this is an internal helper. */
  private collectTaxes(playerId: number, interactive: boolean): string {
    const income = this.totalPopulationOf(playerId);
    this.money[playerId] += income;
    const rawUpkeep = this.units.filter((u) => u.playerId === playerId).length + builtBy(this.buildingOwners, playerId).length;
    // «Кодекс законов» (по прямому запросу) — первооткрыватель технологии платит вдвое меньше за
    // содержание построек и юнитов, до конца партии (округление вниз — в пользу игрока).
    const upkeep = this.techDiscoverer["Кодекс законов"] === playerId ? Math.floor(rawUpkeep / 2) : rawUpkeep;
    if (this.money[playerId] >= upkeep) {
      this.money[playerId] -= upkeep;
      return `+${income} 💰 населения, −${upkeep} 💰 содержания.`;
    }
    const shortfall = upkeep - this.money[playerId];
    this.money[playerId] = 0;
    if (interactive) {
      this.pendingTaxShortfall = { playerId, remaining: shortfall };
      return `+${income} 💰 населения, но на содержание (${upkeep} 💰) не хватило ${shortfall} — придётся списать войска или здания.`;
    }
    let left = shortfall;
    let removedUnits = 0;
    const mine = this.units.filter((u) => u.playerId === playerId);
    while (left > 0 && mine.length) {
      const u = mine.pop()!;
      this.units.splice(this.units.indexOf(u), 1);
      removedUnits++;
      left--;
    }
    let removedBuildings = 0;
    while (left > 0) {
      const owned = builtBy(this.buildingOwners, playerId);
      if (!owned.length) break;
      const b = owned[0];
      this.buildingOwners[b.id].splice(this.buildingOwners[b.id].indexOf(playerId), 1);
      removedBuildings++;
      left--;
    }
    return `+${income} 💰 населения, не хватило ${shortfall} 💰 на содержание (${upkeep}) — списано юнитов: ${removedUnits}, зданий: ${removedBuildings}.`;
  }

  /** Портировано из startTaxCollection. */
  collectTaxesCard(playerId: number, slotIndex: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "taxes" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Налоги» недоступна в этом слоте." };
    this.collectTaxes(playerId, true);
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** Портировано из removeForTaxShortfall — пока this.pendingTaxShortfall не обнулится, списывает
   * по одному юниту/зданию за вызов. */
  resolveTaxShortfall(playerId: number, target: { unitId?: number; buildingId?: string }): ActionResult {
    if (!this.pendingTaxShortfall || this.pendingTaxShortfall.playerId !== playerId) return { ok: false, hint: "Сейчас нет недоимки по налогам." };
    if (target.unitId !== undefined) {
      const idx = this.units.findIndex((u) => u.id === target.unitId && u.playerId === playerId);
      if (idx === -1) return { ok: false, hint: "Юнит не найден." };
      this.units.splice(idx, 1);
    } else if (target.buildingId) {
      const owners = this.buildingOwners[target.buildingId];
      const i = owners ? owners.indexOf(playerId) : -1;
      if (i === -1) return { ok: false, hint: "Это здание вам не принадлежит." };
      owners.splice(i, 1);
    } else {
      return { ok: false, hint: "Нужно выбрать юнит или здание для списания." };
    }
    this.pendingTaxShortfall.remaining--;
    const stillOwesSomething = this.units.some((u) => u.playerId === playerId) || builtBy(this.buildingOwners, playerId).length > 0;
    if (this.pendingTaxShortfall.remaining <= 0 || !stillOwesSomething) this.pendingTaxShortfall = null;
    return { ok: true };
  }

  /** [ИСПРАВЛЕНО] Было 2 Силиката — по прямому уточнению цена сменена на 1 Лес + 1 Силикат (разные
   * ресурсы, не 2 одного типа). [ИСПРАВЛЕНО ещё раз, по прямому запросу] Раньше цена бралась СТРОГО
   * со склада (без доступа к региону вообще) — теперь как у остальных карт: «катастрофа только со
   * столицы и склада» — доступ к региону столицы, потом склад (эффективный — с бонусом Коммунизма),
   * потом рынок за деньги, тем же planBuildingSpend, что и у зданий/исследования. */
  private static CATASTROPHE_AVERT_COST: BuildingCostLine[] = [
    { kind: "specific", resource: "wood", count: 1 },
    { kind: "specific", resource: "silicates", count: 1 },
  ];
  private planCatastropheAvert(playerId: number): SpendPlanItem[] | null {
    const capital = this.capitalCityOf(playerId);
    if (!capital) return null;
    return this.planBuildingSpend(playerId, capital, GameSession.CATASTROPHE_AVERT_COST);
  }
  /** Портировано из applyCatastropheLoss — использует this.rng(), не Math.random().
   * [ИСПРАВЛЕНО] Столицу эта карта больше не может уничтожить (по прямому уточнению) — население
   * столицы этим эффектом никогда не опускается ниже 1, город не исчезает. Если у игрока только
   * столица — эффект просто не даёт городу пропасть (население может упасть, но не до 0). Если
   * есть другие города — цель выбирается случайно среди ВСЕХ, но если выпала столица и у нее и так
   * ≤3 населения (эффект бы просто «впустую» уткнулся в пол 1) — цель перевыбирается среди
   * НЕ-столичных городов, чтобы эффект не пропадал зря. Не-столичные города по-прежнему могут быть
   * уничтожены полностью, без изменений. */
  private applyCatastropheLoss(playerId: number): string {
    const owned = builtBy(this.buildingOwners, playerId);
    if (owned.length) {
      const b = owned[Math.floor(this.rng() * owned.length)];
      this.buildingOwners[b.id].splice(this.buildingOwners[b.id].indexOf(playerId), 1);
      return `здание «${b.name}» потеряно.`;
    }
    const myCities = this.cities.filter((c) => c.playerId === playerId);
    if (!myCities.length) return "терять было нечего — ни зданий, ни городов.";
    const capital = myCities.find((c) => c.isCapital);
    let city = myCities[Math.floor(this.rng() * myCities.length)];
    if (capital && city.id === capital.id && capital.population <= 3) {
      const others = myCities.filter((c) => c.id !== capital.id);
      if (others.length) city = others[Math.floor(this.rng() * others.length)];
    }
    if (capital && city.id === capital.id) {
      const before = city.population;
      city.population = Math.max(1, city.population - 3);
      return before === city.population
        ? "столица и так уже на минимуме населения (1) — эта карта не может её уничтожить, эффекта нет."
        : `столица теряет население (было ${before}, стало ${city.population}) — эта карта не может уничтожить столицу.`;
    }
    if (city.population < 3) {
      this.destroyCity(city);
      return "случайный город исчез вовсе (население было меньше 3) — на его месте руины.";
    }
    city.population -= 3;
    if (city.population <= 0) {
      this.destroyCity(city);
      return "случайный город потерял 3 населения и обнулился — исчез вовсе, на его месте руины.";
    }
    return `случайный город потерял 3 населения (осталось ${city.population}).`;
  }
  /** Портировано из resolveCatastrophe. `interactive`: true sets this.pendingCatastrophe for
   * resolveCatastropheChoice; false (forced discard) resolves immediately. */
  private resolveCatastrophe(playerId: number, interactive: boolean): string {
    if (interactive) {
      this.pendingCatastrophe = { playerId };
      return "Стихийное бедствие! Заплатить 1 Лес + 1 Силикат или принять последствия?";
    }
    const plan = this.planCatastropheAvert(playerId);
    if (plan) {
      this.commitSpend(playerId, plan);
      return "катастрофа предотвращена автоматически — списаны 1 Лес + 1 Силикат.";
    }
    return this.applyCatastropheLoss(playerId);
  }

  /** Портировано из startCatastrophe. */
  playCatastropheCard(playerId: number, slotIndex: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "catastrophe" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Катастрофа» недоступна в этом слоте." };
    this.resolveCatastrophe(playerId, true);
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** Портировано из resolveCatastropheChoice. */
  resolveCatastropheChoice(playerId: number, choice: "pay" | "accept"): ActionResult {
    if (!this.pendingCatastrophe || this.pendingCatastrophe.playerId !== playerId) return { ok: false, hint: "Сейчас нет ожидающей катастрофы." };
    let hint: string;
    const plan = choice === "pay" ? this.planCatastropheAvert(playerId) : null;
    if (plan) {
      this.commitSpend(playerId, plan);
      hint = "Катастрофа предотвращена — списаны 1 Лес + 1 Силикат, других последствий нет.";
    } else {
      hint = `Последствия приняты: ${this.applyCatastropheLoss(playerId)}`;
    }
    this.pendingCatastrophe = null;
    // Без явного hint игрок не понимал бы, что выбор вообще применился (окно просто закрывается) —
    // по прямому запросу.
    return { ok: true, hint };
  }

  /** Портировано из startMobilization. */
  mobilize(playerId: number, slotIndex: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "mobilization" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Мобилизация» недоступна в этом слоте." };
    if (this.money[playerId] < 10) return { ok: false, hint: "Не хватает денег — Мобилизация стоит 10 💰." };
    this.money[playerId] -= 10;
    this.actionsLeft[playerId] = UNLIMITED_ACTIONS;
    for (const b of builtBy(this.buildingOwners, playerId)) {
      if (b.produces) this.productionUsedThisCycle.delete(`${b.id}:${playerId}`);
    }
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  private applyMobilizationNegative(playerId: number): string {
    this.skippedTurn.add(playerId);
    this.skipTurnReason[playerId] = "mobilization";
    return "следующий ход этого игрока будет пропущен.";
  }

  /** Портировано из growRandomForest (Строитель's discard effect) — использует this.rng(). */
  private growRandomForest(): boolean {
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const candidates: { col: number; row: number }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        const t = this.doc.get(col, row);
        if (TERRAIN_BY_ID[t.terrain].canHaveForest && !t.forest) candidates.push({ col, row });
      }
    }
    if (!candidates.length) return false;
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    this.doc.set(pick.col, pick.row, { forest: true });
    return true;
  }

  /** −1 населению КАЖДОГО города игрока (негативный эффект сброса карты «Население»/«Поселенец») —
   * БЕЗ пола в 1 (по прямому уточнению — «вымирание из-за эффектов сброса, войны или катастроф»):
   * город, дошедший до 0, уничтожается целиком (см. destroyCity/handleCityLoss), это может дойти
   * вплоть до полного выбывания игрока, если это лишает его последнего города. Снимок списка городов
   * берётся ДО цикла — destroyCity переприсваивает this.cities новым массивом, но уже взятый снимок
   * этим не портится. */
  private applyDiscardPopulationLoss(playerId: number): string {
    const mine = this.cities.filter((c) => c.playerId === playerId);
    if (!mine.length) return "городов не было — эффекта нет.";
    let destroyed = 0;
    for (const c of mine) {
      c.population -= 1;
      if (c.population <= 0) {
        destroyed++;
        this.destroyCity(c);
      }
    }
    return destroyed > 0
      ? `население всех городов −1; из них уничтожено обнулившихся городов: ${destroyed}.`
      : "население всех городов −1.";
  }

  /** Hand-overflow discard (ТЗ 2.3) — портировано из resolveHandOverflowDiscard, вызывается только
   * из endTurn() ниже, когда рука ≥8. Не отдельное игровое действие (нет своего ActionResult), но
   * теперь ВОЗВРАЩАЕТ список описаний последствий (по карте) — тот же метод используется и для
   * реального сброса (на живой сессии), и для превью (на клоне, см. previewHandOverflowDiscard), так
   * что предсказание гарантированно совпадает с тем, что случится по-настоящему. */
  private resolveHandOverflowDiscard(playerId: number): { log: string[]; earthquakeHexes: { col: number; row: number }[] } {
    const hand = this.hands[playerId];
    // «Право прокладки маршрута» не считается в лимит руки (handCountedSize) — не должно и уходить
    // в этот сброс: это не обычная карта колоды, попадание в this.deck её бы испортило. Бесплатный
    // «Рабочий» Монархии (freeMonarchy), в отличие от routeRight, ПО ПРЯМОМУ УТОЧНЕНИЮ считается в
    // лимит руки и сбрасывается наравне с обычными картами — просто не возвращается в общую колоду
    // (иначе задваивал бы обычные копии «Рабочего» навсегда, см. consumeHandCard), а исчезает;
    // следующая появится в начале следующего цикла (grantMonarchyWorkerCards).
    const kept = hand.filter((c) => c.id === "routeRight");
    const discarded = hand.filter((c) => c.id !== "routeRight");
    hand.length = 0;
    hand.push(...kept);
    for (const card of discarded) {
      if (!card.freeMonarchy) {
        card.receivedFrom = undefined;
        this.deck.push(card);
      }
    }
    for (let i = this.market.length - 1; i >= 0; i--) {
      const l = this.market[i];
      if (l.kind === "card" && l.sellerId === playerId) this.market.splice(i, 1);
    }
    const log: string[] = [];
    const earthquakeHexes: { col: number; row: number }[] = [];
    if (!discarded.length) return { log, earthquakeHexes };
    log.push(`Сброшено карт: ${discarded.length} (уходят на дно колоды; «Право прокладки маршрута» в лимит руки не считается и не сбрасывается).`);
    // Бесплатный «Рабочий» Монархии НЕ защищает от негативного эффекта — нейтрализация срабатывает
    // только от НАСТОЯЩЕГО «Рабочего» (по прямому уточнению, «иначе имбово со Складом»).
    const neutralized = discarded.some((c) => c.id === "worker" && !c.freeMonarchy);
    if (neutralized) log.push("Среди сброшенных есть «Рабочий» — по этому сбросу негативный эффект обычных (не событийных) карт нейтрализован (включая катаклизмы «Учёного», ТЗ §15.1).");
    for (const card of discarded) {
      if (card.kind === "event") {
        if (card.id === "population") {
          log.push(`«${card.label}»: ${this.applyDiscardPopulationLoss(playerId)}`);
        } else if (card.id === "taxes") {
          log.push(`«${card.label}»: ${this.collectTaxes(playerId, false)}`);
        } else if (card.id === "catastrophe") {
          log.push(`«${card.label}»: ${this.resolveCatastrophe(playerId, false)}`);
        } else if (card.id === "forestGrowth") {
          log.push(`«${card.label}»: ${this.degradeForestOrLand(playerId)}`);
        } else if (card.id === "tradeRoute") {
          log.push(`«${card.label}»: ${this.applyTradeRouteNegative(playerId)}`);
        } else if (card.id === "mobilization") {
          log.push(`«${card.label}»: ${this.applyMobilizationNegative(playerId)}`);
        }
        continue;
      }
      if (neutralized) continue;
      if (card.id === "settler") {
        log.push(`«${card.label}»: ${this.applyDiscardPopulationLoss(playerId)}`);
      } else if (card.id === "warrior") {
        const mine = this.units.filter((u) => u.playerId === playerId);
        const affordable = Math.min(mine.length, this.money[playerId]);
        this.money[playerId] -= affordable;
        const disbandCount = mine.length - affordable;
        for (let i = 0; i < disbandCount; i++) {
          const u = mine[mine.length - 1 - i];
          this.units.splice(this.units.indexOf(u), 1);
        }
        log.push(
          `«${card.label}»: содержание оплачено за ${affordable} юнит(ов) (−${affordable}💰)` +
            (disbandCount ? `, распущено без оплаты: ${disbandCount}.` : ".")
        );
      } else if (card.id === "builder") {
        const grew = this.growRandomForest();
        log.push(`«${card.label}»: ${grew ? "лес вырос на случайной подходящей клетке карты." : "не нашлось подходящей клетки — эффекта нет."}`);
      } else if (card.id === "scientist") {
        const batch = this.resolveCataclysmBatch(playerId);
        earthquakeHexes.push(...batch.earthquakeHexes);
        log.push(`«${card.label}»: вскрывает катаклизмы (эпоха ${this.playerEpoch(playerId)}). ${batch.log.join(" ")}`);
      }
      // trader: эффекта нет (заглушка, ТЗ §14 п.9 «Новое, ещё не в коде») — в лог не попадает.
    }
    if (this.eliminatedPlayers.has(playerId)) log.push("⚠ Этот сброс лишил вас всех городов — вы выбываете из партии.");
    return { log, earthquakeHexes };
  }

  /** Превью последствий переполнения руки (ТЗ 2.3, «фильтр от случайного проматывания», по прямому
   * уточнению) — детерминированный дословный прогон resolveHandOverflowDiscard на ПОЛНОМ клоне сессии
   * (через toJSON/fromJSON — тот же путь, что при перезапуске сервера, RNG форкается ровно с текущей
   * позиции по rngCallCount). Реальную сессию не трогает вообще — можно звать сколько угодно раз, вызов
   * ничего не расходует и не сдвигает RNG; результат будет идентичен реальному сбросу, ЕСЛИ рука и
   * позиция RNG к моменту реального подтверждения не изменятся (в пределах одного хода того же игрока
   * это гарантировано — ходить между просмотром и подтверждением больше некому). */
  private previewHandOverflowDiscard(playerId: number): { consequences: string[]; eliminates: boolean } {
    // ВАЖНО: toJSON()/fromJSON() — неглубокое копирование (снимок переиспользует те же вложенные
    // массивы/объекты, что и живая сессия, это нормально для сохранения на диск, где старая сессия
    // тут же выбрасывается) — без structuredClone здесь клон делил бы, например, тот же массив руки
    // с живой сессией, и resolveHandOverflowDiscard на клоне тут же испортил бы и настоящую руку.
    const clone = GameSession.fromJSON(this.id, structuredClone(this.toJSON()));
    const { log: consequences } = clone.resolveHandOverflowDiscard(playerId);
    return { consequences, eliminates: clone.eliminatedPlayers.has(playerId) };
  }

  // === Конец хода (ТЗ 5.3/9) =====================================================================

  /** Общий переход хода вперёд, включая границу цикла — используется и обычным endTurn ниже, и
   * «пропуском» хода игрока с активным skippedTurn (см. endTurn). Вынесено отдельно, чтобы оборот
   * цикла (сбросы/счётчики на границе) считался ОДИНАКОВО в обоих путях — раньше у guard-цикла
   * пропуска был урезанный набор сбросов границы цикла (не сбрасывал landedThisCycle и т.п.), что
   * было отдельным багом.
   *
   * Пропуск хода (смена парадигмы/штраф «Мобилизации», ТЗ 11.6) — по прямому запросу игрок
   * по-прежнему должен САМ нажать «Пропустить», а не тихо перепрыгиваться сервером: если новый
   * currentPlayerIndex стоит в skippedTurn, флаг СРАЗУ переносится в отдельное pendingSkipTurn (а не
   * остаётся в skippedTurn) — иначе endTurn ниже не мог бы отличить «игрок только что поставил флаг
   * САМ СЕБЕ посреди своего текущего хода» (при принятии парадигмы) от «мы только что пришли на его
   * замороженный ход» — тот же playerId совпал бы в обоих случаях. pendingSkipTurn же выставляется
   * ИСКЛЮЧИТЕЛЬНО здесь, в момент прихода на ход, поэтому однозначен. */
  private advanceCurrentPlayer() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    if (this.currentPlayerIndex === 0) {
      this.accessUsed.clear();
      this.productionUsedThisCycle.clear();
      // ТЗ §15.2 п.4 — счётчик считает ПОЛНЫЕ циклы (круг ходов всех игроков), не отдельные ходы;
      // раньше убывал на 1 за каждый отдельный ход (см. §14 п.7 старой редакции) — исправлено.
      if (this.turnsRemaining > 0) this.turnsRemaining--;
      // Сброс — ДО resolveUnitMovementForCycle(), иначе только что выставленные в ЭТОМ цикле флаги
      // тут же стирались бы (см. main.ts, тот же баг был найден и исправлен там же в этом сеансе).
      this.landedThisCycle.clear();
      this.outOfMoveThisCycle.clear();
      this.moveBudgetUsedThisCycle.clear();
      this.unitActedThisCycle.clear();
      this.hexDefense.clear();
      this.citySiegeBuffer.clear();
      for (const u of this.units) u.hp = this.unitStats(u).hp;
      this.resolveUnitMovementForCycle();
      this.grantMonarchyWorkerCards();
    }
    const arrivedId = this.players[this.currentPlayerIndex].id;
    if (this.skippedTurn.has(arrivedId)) {
      this.skippedTurn.delete(arrivedId);
      this.pendingSkipTurn = arrivedId;
      this.pendingSkipTurnReason = this.skipTurnReason[arrivedId] ?? null;
      delete this.skipTurnReason[arrivedId];
    }
  }

  endTurn(playerId: number, confirmed = false): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Ход недоступен до конца расстановки." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    // Клик «Пропустить» в замороженном ходу (см. advanceCurrentPlayer выше) — короткий путь без
    // раздачи карт/обязательной передачи/проверок склада и руки, только сам переход хода.
    if (this.pendingSkipTurn === playerId) {
      this.pendingSkipTurn = null;
      this.pendingSkipTurnReason = null;
      this.advanceCurrentPlayer();
      return { ok: true };
    }
    const player = this.players[this.currentPlayerIndex];
    // Склад сверх лимита — жёсткий отказ, БЕЗ пути «подтвердить и продолжить» (в отличие от
    // needsDiscardConfirm ниже): в процессе хода лимит не проверяется вовсе (addToWarehouse), только
    // здесь, в конце — игрок обязан продать лишнее на бирже и повторить конец хода. Проверяется даже
    // при confirmed:true (нет обхода) — иначе подтверждение сброса руки могло бы протащить конец хода
    // мимо этой проверки.
    const cap = this.warehouseCapFor(player.id);
    const total = this.warehouseTotal(player.id);
    if (total > cap) {
      return { ok: false, needsWarehouseTrim: { total, cap, overBy: total - cap } };
    }
    // Рука ≥8 — сначала окно последствий, реальный сброс только по подтверждению (см. ActionResult.
    // needsDiscardConfirm/previewHandOverflowDiscard) — «фильтр от случайного проматывания», по
    // прямому уточнению. Ничего не меняем в состоянии до этой проверки — иначе даже непринятый вызов
    // уже тратил бы ход/карты.
    if (this.handCountedSize(player.id) >= 8 && !confirmed) {
      return { ok: false, needsDiscardConfirm: this.previewHandOverflowDiscard(player.id) };
    }
    const hand = this.hands[player.id];
    let earthquakeHexes: { col: number; row: number }[] = [];
    if (this.handCountedSize(player.id) >= 8) {
      earthquakeHexes = this.resolveHandOverflowDiscard(player.id).earthquakeHexes;
    } else {
      // Раздача — ВСЕГДА полные CARDS_DEALT_PER_TURN карт, поверх уже раздутой чужими передачами
      // руки, а не только до HAND_SIZE (по прямому уточнению — «раздача должна идти поверх руки»;
      // раньше здесь стоял `counted < HAND_SIZE`, что тихо срезало добор, если рука уже подросла от
      // handoff'ов). Единственная защита от бесконечного роста — проверка «8 и больше» выше, которая
      // сработает уже на СЛЕДУЮЩЕМ конце хода этого игрока, если рука после этой раздачи ушла за 8.
      for (let dealt = 0; dealt < CARDS_DEALT_PER_TURN; dealt++) {
        const next = this.deck.shift();
        if (!next) break;
        hand.push(next);
      }
      // Обязательная передача (по прямому уточнению) — только если реально есть что отдать; хотя
      // бы 1 карта в руке у игрока (иначе пустая рука после сброса/минимального добора блокировала
      // бы его без возможности выполнить требование). Бесплатный «Рабочий» Монархии (freeMonarchy) не
      // считается — его нельзя передать (см. handoffCard), иначе рука из одной такой карты требовала
      // бы передачи без единого варианта её выполнить.
      if (hand.some((c) => !c.freeMonarchy)) this.mustHandoff.add(player.id);
    }
    this.actionsLeft[this.currentPlayerIndex] =
      ACTIONS_PER_TURN + (this.playerParadigm[player.id] === "democracy" ? 1 : 0) + (this.playerReligion[player.id] !== null ? 1 : 0);
    this.upravlenieUsedThisTurn.delete(player.id);
    this.advanceCurrentPlayer();
    return { ok: true, earthquakeHexes: earthquakeHexes.length ? earthquakeHexes : undefined };
  }

  // === Сериализация — форма сообщения "state" и файла на диске (rooms.ts) =======================

  toJSON(): SaveGameV1 {
    return {
      version: 1,
      players: this.players.map((p) => ({ name: p.name, color: p.color })),
      phase: this.phase,
      currentPlayerIndex: this.currentPlayerIndex,
      winner: this.winner,
      winnerType: this.winnerType,
      turnsRemaining: this.turnsRemaining,
      mapTiles: this.doc.tiles,
      placedTokens: this.placedTokens,
      cityResults: this.cityResults,
      cities: this.cities,
      nextCityId: this.nextCityId,
      units: this.units,
      nextUnitId: this.nextUnitId,
      market: this.market,
      nextListingId: this.nextListingId,
      tradeRoutes: this.tradeRoutes,
      nextRouteId: this.nextRouteId,
      warehouse: this.warehouse,
      money: this.money,
      hands: this.hands,
      deck: this.deck,
      actionsLeft: this.actionsLeft,
      researchedTechs: Object.fromEntries(Object.entries(this.researchedTechs).map(([id, set]) => [id, [...set]])),
      buildingOwners: this.buildingOwners,
      playerParadigm: this.playerParadigm,
      playerReligion: this.playerReligion,
      religionFounder: this.religionFounder,
      techDiscoverer: this.techDiscoverer,
      relations: Object.fromEntries(Object.entries(this.relations).map(([k, r]) => [k, { war: r.war, agreements: [...r.agreements] }])),
      pendingProposals: this.pendingProposals,
      nextProposalId: this.nextProposalId,
      skippedTurn: [...this.skippedTurn],
      accessUsed: [...this.accessUsed],
      productionUsedThisCycle: [...this.productionUsedThisCycle],
      landedThisCycle: [...this.landedThisCycle],
      outOfMoveThisCycle: [...this.outOfMoveThisCycle],
      moveBudgetUsedThisCycle: [...this.moveBudgetUsedThisCycle.entries()],
      unitActedThisCycle: [...this.unitActedThisCycle],
      nextGarrisonRank: this.nextGarrisonRank,
      hexDefense: [...this.hexDefense.entries()],
      citySiegeBuffer: [...this.citySiegeBuffer.entries()],
      ruins: this.ruins,
      eliminatedPlayers: [...this.eliminatedPlayers],
      upravlenieUsedThisTurn: [...this.upravlenieUsedThisTurn],
      mustHandoff: [...this.mustHandoff],
      spaceComponents: this.spaceComponents,
      nuclearWeapons: this.nuclearWeapons,
      oonCandidate1Id: this.oonCandidate1Id,
      oonCandidate2Id: this.oonCandidate2Id,
      oonEffectiveCandidate2Id: this.effectiveOonCandidate2Id(),
      oonSecretaryGeneralId: this.oonSecretaryGeneralId,
      pendingOonResolution: this.pendingOonResolution,
      nextOonResolutionId: this.nextOonResolutionId,
      oonOpenTradeActive: this.oonOpenTradeActive,
      oonNuclearBanActive: this.oonNuclearBanActive,
      oonNeutralWatersActive: this.oonNeutralWatersActive,
      oonSanctionedPlayerId: this.oonSanctionedPlayerId,
      oonGreenAgendaActive: this.oonGreenAgendaActive,
      oonPriceRegulation: this.oonPriceRegulation,
      oonArmsLimit: this.oonArmsLimit,
      pendingRoute: this.pendingRoute,
      pendingTaxShortfall: this.pendingTaxShortfall,
      pendingCatastrophe: this.pendingCatastrophe,
      pendingSkipTurn: this.pendingSkipTurn,
      pendingSkipTurnReason: this.pendingSkipTurnReason,
      skipTurnReason: this.skipTurnReason,
      rngSeed: this.rngSeed,
      rngCallCount: this.rngCallCount,
    };
  }

  /** Восстанавливает состояние сессии из снимка (перезапуск сервера / загрузка сохранённой
   * комнаты) — RNG воссоздаётся из того же seed и "прокручивается" на rngCallCount вызовов вперёд,
   * чтобы следующая случайность в партии была именно той, что была бы без перезапуска. */
  static fromJSON(id: string, save: SaveGameV1): GameSession {
    const players: Player[] = save.players.map((p, i) => ({ id: i, name: p.name, color: p.color }));
    const session = new GameSession(id, players, save.rngSeed);
    session.phase = save.phase;
    session.currentPlayerIndex = save.currentPlayerIndex;
    session.winner = save.winner;
    session.winnerType = save.winnerType ?? null;
    session.turnsRemaining = save.turnsRemaining;
    session.doc.tiles = save.mapTiles;
    session.placedTokens = save.placedTokens;
    session.cityResults = save.cityResults;
    session.cities = save.cities;
    session.nextCityId = save.nextCityId;
    session.units = save.units;
    // Партии, сохранённые до появления поля raiding, приходят без него — undefined уже ведёт себя
    // как false везде, где юнит читается, но явный false честнее для сериализации назад.
    for (const u of session.units) if ((u as { raiding?: boolean }).raiding === undefined) u.raiding = false;
    session.nextUnitId = save.nextUnitId;
    session.market = save.market;
    session.nextListingId = save.nextListingId;
    session.tradeRoutes = save.tradeRoutes;
    session.nextRouteId = save.nextRouteId;
    replaceRecord(session.warehouse, save.warehouse);
    replaceRecord(session.money, save.money);
    replaceRecord(session.hands, save.hands);
    session.deck = save.deck;
    replaceRecord(session.actionsLeft, save.actionsLeft);
    for (const k of Object.keys(session.researchedTechs)) delete session.researchedTechs[+k];
    for (const [pid, arr] of Object.entries(save.researchedTechs)) session.researchedTechs[+pid] = new Set(arr);
    replaceRecord(session.buildingOwners, save.buildingOwners);
    replaceRecord(session.playerParadigm, save.playerParadigm);
    replaceRecord(session.playerReligion, save.playerReligion);
    Object.assign(session.religionFounder, save.religionFounder);
    Object.assign(session.techDiscoverer, save.techDiscoverer ?? {});
    for (const [k, r] of Object.entries(save.relations)) session.relations[k] = { war: r.war, agreements: new Set(r.agreements) };
    session.pendingProposals = save.pendingProposals;
    session.nextProposalId = save.nextProposalId;
    replaceSet(session.skippedTurn, save.skippedTurn);
    replaceSet(session.accessUsed, save.accessUsed);
    replaceSet(session.productionUsedThisCycle, save.productionUsedThisCycle);
    replaceSet(session.landedThisCycle, save.landedThisCycle);
    replaceSet(session.outOfMoveThisCycle, save.outOfMoveThisCycle);
    session.moveBudgetUsedThisCycle.clear();
    for (const [k, v] of save.moveBudgetUsedThisCycle ?? []) session.moveBudgetUsedThisCycle.set(k, v);
    replaceSet(session.unitActedThisCycle, save.unitActedThisCycle ?? []);
    session.nextGarrisonRank = save.nextGarrisonRank ?? -1;
    session.hexDefense.clear();
    for (const [k, v] of save.hexDefense) session.hexDefense.set(k, v);
    session.citySiegeBuffer.clear();
    for (const [k, v] of save.citySiegeBuffer ?? []) session.citySiegeBuffer.set(k, v);
    session.ruins = save.ruins ?? [];
    replaceSet(session.eliminatedPlayers, save.eliminatedPlayers ?? []);
    replaceSet(session.upravlenieUsedThisTurn, save.upravlenieUsedThisTurn ?? []);
    replaceSet(session.mustHandoff, save.mustHandoff ?? []);
    replaceRecord(session.spaceComponents, save.spaceComponents);
    replaceRecord(session.nuclearWeapons, save.nuclearWeapons ?? {});
    session.oonCandidate1Id = save.oonCandidate1Id ?? null;
    session.oonCandidate2Id = save.oonCandidate2Id ?? null;
    session.oonSecretaryGeneralId = save.oonSecretaryGeneralId ?? null;
    session.pendingOonResolution = save.pendingOonResolution ?? null;
    session.nextOonResolutionId = save.nextOonResolutionId ?? 1;
    session.oonOpenTradeActive = save.oonOpenTradeActive ?? false;
    session.oonNuclearBanActive = save.oonNuclearBanActive ?? false;
    session.oonNeutralWatersActive = save.oonNeutralWatersActive ?? false;
    session.oonSanctionedPlayerId = save.oonSanctionedPlayerId ?? null;
    session.oonGreenAgendaActive = save.oonGreenAgendaActive ?? false;
    session.oonPriceRegulation = save.oonPriceRegulation ?? null;
    session.oonArmsLimit = save.oonArmsLimit ?? null;
    session.pendingRoute = save.pendingRoute ?? null;
    session.pendingTaxShortfall = save.pendingTaxShortfall ?? null;
    session.pendingCatastrophe = save.pendingCatastrophe ?? null;
    session.pendingSkipTurn = save.pendingSkipTurn ?? null;
    session.pendingSkipTurnReason = save.pendingSkipTurnReason ?? null;
    session.skipTurnReason = save.skipTurnReason ?? {};
    for (let i = 0; i < save.rngCallCount; i++) session.rng();
    // Партии, сохранённые до появления techDiscoverer, не знают, кто ЛИЧНО открыл религиозные
    // технологии — историю не восстановить, поэтому назначаем первооткрывателем первого по id
    // игрока, у кого технология уже есть (детерминированное, разумное решение задним числом).
    for (const techId of GameSession.RELIGION_FOUNDING_TECHS) {
      if (session.techDiscoverer[techId] !== undefined) continue;
      const holder = session.players.find((p) => session.researchedTechs[p.id]?.has(techId));
      if (holder) session.techDiscoverer[techId] = holder.id;
    }
    return session;
  }

  /** Единая точка входа для WebSocket-протокола (wsServer.ts) — имя действия = имя метода. */
  dispatch(action: string, playerId: number, payload: any): ActionResult {
    // Обязательная передача карты (ТЗ 2.3) блокирует ВООБЩЕ ВСЁ остальное для текущего игрока,
    // пока не выполнена — по прямому уточнению «без этого он не может начать ходить». Исключение —
    // клик «Пропустить» в замороженном ходу (pendingSkipTurn, см. advanceCurrentPlayer/endTurn): в
    // этом ходу «нельзя сделать вообще ничего», включая передачу карты (модалка пропуска блокирует
    // клики по руке) — без этого исключения игрок оказывался бы в тупике: пропустить нельзя, пока не
    // передал карту, а передать нельзя, пока не закрыта модалка пропуска, которую нечем закрыть.
    // Сама недоимка никуда не девается — просто ждёт его следующего РЕАЛЬНОГО хода.
    if (action !== "handoffCard" && !(action === "endTurn" && this.pendingSkipTurn === playerId) && this.mustHandoff.has(playerId) && this.players[this.currentPlayerIndex]?.id === playerId) {
      return { ok: false, hint: "Сначала передайте 1 карту другому игроку — кликните карту в руке и выберите получателя." };
    }
    switch (action) {
      case "handoffCard":
        return this.handoffCard(playerId, payload.slotIndex, payload.targetPlayerId);
      case "placeToken":
        return this.placeToken(playerId, payload.col, payload.row);
      case "endTurn":
        return this.endTurn(playerId, !!payload.confirmed);
      case "foundCity":
        return this.foundCity(playerId, payload.slotIndex, payload.col, payload.row);
      case "buildUnitCard":
        return this.buildUnitCard(playerId, payload.slotIndex, payload.cityId, payload.unitId);
      case "useKazarma":
        return this.useKazarma(playerId, payload.cityId, payload.unitId);
      case "commandUnit":
        return this.commandUnit(playerId, payload.unitId, payload.col, payload.row);
      case "toggleDefend":
        return this.toggleDefend(playerId, payload.unitId);
      case "toggleRaid":
        return this.toggleRaid(playerId, payload.unitId);
      case "promoteGarrisonUnit":
        return this.promoteGarrisonUnit(playerId, payload.unitId);
      case "declareWar":
        return this.declareWar(playerId, payload.targetId);
      case "buyListing":
        return this.buyListing(playerId, payload.listingId);
      case "playCard":
        return this.playCard(playerId, payload.slotIndex);
      case "growCity":
        return this.growCity(playerId, payload.slotIndex, payload.cityIds);
      case "plantForest":
        return this.plantForest(playerId, payload.slotIndex, payload.col, payload.row);
      case "growResourceOnHex":
        return this.growResourceOnHex(playerId, payload.slotIndex, payload.col, payload.row, payload.resource);
      case "workerCollect":
        return this.workerCollect(playerId, payload.slotIndex, payload.cityId, payload.chosenTypes);
      case "chopForest":
        return this.chopForest(playerId, payload.slotIndex, payload.col, payload.row);
      case "skladCollect":
        return this.skladCollect(playerId, payload.cityId);
      case "traderTrade":
        return this.traderTrade(playerId, payload.slotIndex, payload.cityId);
      case "buildBuilding":
        return this.buildBuilding(playerId, payload.slotIndex, payload.buildingId);
      case "mineMountainsForSilicates":
        return this.mineMountainsForSilicates(playerId, payload.slotIndex, payload.cityId);
      case "activateProductionBuilding":
        return this.activateProductionBuilding(playerId, payload.buildingId);
      case "useUpravlenie":
        return this.useUpravlenie(playerId);
      case "useRynok":
        return this.useRynok(playerId, payload.resource);
      case "activateYadernyiArsenal":
        return this.activateYadernyiArsenal(playerId);
      case "useAeroport":
        return this.useAeroport(playerId, payload.unitId, payload.col, payload.row);
      case "useHram":
        return this.useHram(playerId, payload.slotIndex);
      case "useUniversitet":
        return this.useUniversitet(playerId, payload.techId);
      case "useInternet":
        return this.useInternet(playerId, payload.targetPlayerId);
      case "activateKosmodrom":
        return this.activateKosmodrom(playerId);
      case "proposeOonResolution":
        return this.proposeOonResolution(playerId, payload.resolutionType, payload.params ?? {});
      case "voteOonResolution":
        return this.voteOonResolution(playerId, payload.inFavor);
      case "confirmResearch":
        return this.confirmResearch(playerId, payload.slotIndex, payload.techId);
      case "pickRouteCities":
        return this.pickRouteCities(playerId, payload.fromCityId, payload.toCityId);
      case "playRouteRightCard":
        return this.playRouteRightCard(playerId, payload.slotIndex, payload.fromCityId, payload.toCityId);
      case "adoptParadigm":
        return this.adoptParadigm(playerId, payload.paradigm);
      case "adoptReligion":
        return this.adoptReligion(playerId, payload.religion);
      case "sendProposal":
        return this.sendProposal(playerId, payload.to, payload.terms, payload.ultimatum);
      case "resolveProposal":
        return this.resolveProposal(playerId, payload.id, payload.accepted);
      case "breakOffRelations":
        return this.breakOffRelations(playerId, payload.targetId);
      case "layNewTradeRoute":
        return this.layNewTradeRoute(playerId, payload.slotIndex, payload.fromCityId, payload.toCityId);
      case "redirectTradeRoute":
        return this.redirectTradeRoute(playerId, payload.slotIndex, payload.routeId, payload.oldEndpointCityId, payload.newCityId);
      case "deleteTradeRoute":
        return this.deleteTradeRoute(playerId, payload.slotIndex, payload.routeId);
      case "sellCard":
        return this.sellCard(playerId, payload.slotIndex, payload.price);
      case "sellResource":
        return this.sellResource(playerId, payload.resource, payload.price);
      case "collectTaxesCard":
        return this.collectTaxesCard(playerId, payload.slotIndex);
      case "resolveTaxShortfall":
        return this.resolveTaxShortfall(playerId, payload.target ?? {});
      case "playCatastropheCard":
        return this.playCatastropheCard(playerId, payload.slotIndex);
      case "resolveCatastropheChoice":
        return this.resolveCatastropheChoice(playerId, payload.choice);
      case "mobilize":
        return this.mobilize(playerId, payload.slotIndex);
      default:
        return { ok: false, hint: `Действие "${action}" пока не перенесено на сервер.` };
    }
  }
}
