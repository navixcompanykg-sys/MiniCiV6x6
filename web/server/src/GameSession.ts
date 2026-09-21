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
import {
  freshDeck,
  shuffle,
  makeRouteRightCard,
  makeMonarchyWorkerCard,
  makeFascismWarriorCard,
  makeFreeEducationCard,
  makeFreeBuildingCard,
  makeParliamentarismBuilderCard,
  makeFreeForestGrowthCard,
} from "../../src/game/cards";
import type { CardDef } from "../../src/game/cards";
import { TOKEN_VALUES, resolvePlacement } from "../../src/game/placement";
import type { PlacedToken, CityResult, Player, TokenValue } from "../../src/game/placement";
import { BUILDINGS, builtBy, claimBuilding, isOwnedBy } from "../../src/game/buildings";
import type { BuildingCostLine, BuildingOwners } from "../../src/game/buildings";
import { hexNeighborsWrapped } from "../../src/map/hexMath";
import { valueOfMoney, valueOfResource, playerWeightOf } from "./valuation";
import { statsFor, UNITS } from "../../src/game/units";
import type { UnitStats } from "../../src/game/units";
import { BRANCHES, TECH_TREE, CITY_CAPACITY_TECHS } from "../../src/game/techtree";
import type { AiPlanStep, StrategicPriority } from "./bot";
import type { TechDef } from "../../src/game/techtree";

export const HAND_SIZE = 7;
// По прямому уточнению — база снижена 3 → 2, компенсируется бонусами: Демократия (+1, уже было),
// Религия (+1, новое — стимул её принимать), здание «Управление» (+1 разово за ход, платно) — до
// 5 действий суммарно при всех трёх сразу (не 6 — см. отчёт: перечисленные источники дают 2+1+1+1=5,
// уточнил у пользователя расхождение с озвученным «до 6»).
const ACTIONS_PER_TURN = 2;
// По прямому уточнению — раздача 3 карты (не 2), но 1 из них ОБЯЗАНА тут же уйти другому игроку
// (см. handoffCard/mustHandoff), так что чистый прирост руки — те же 2, что и раньше.
export const CARDS_DEALT_PER_TURN = 3;

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
  /** Член «Армии» бота (§15.9а, `bot.ts: Army`) — `null` для юнитов вне формирования. Нейтральное
   * поле движка (как `cityId` — просто группирующий id, механику самого боя/движения не меняет),
   * заполняется опционально в payload `buildUnitCard`/`buyUnitWithMoney` при постройке, чтобы
   * членство ПЕРСИСТЕНТНО переживало реплей хода бота (см. доку `bot.ts: tryBuildArmyUnit` — почему
   * это не может быть отдельной, только-в-памяти-бота мутацией). */
  armyId: number | null;
}

/** Журнал ключевых событий партии (по прямому запросу — «сохранения хранят только последнее
 * состояние, нужно вести лог ключевых событий, чтобы можно было реконструировать историю всей
 * партии») — копится ВНУТРИ одного сохранения (persist на каждое действие, см. rooms.ts) с самого
 * начала игровой фазы и никогда не усекается (в отличие от `recentCityLosses` — та память чисто
 * тактическая, для AI, и сознательно недолговечная). Освещает: начало/конец войн, заключение
 * соглашений, захват/потерю городов и юнитов, дипломатические предложения (отправку, принятие,
 * отказ, с условиями). `text` уже готовый человекочитаемый текст на русском — отдельной структуры
 * под каждый тип события не заведено (только логирование/чтение, машинно не разбирается). */
export interface GameLogEntry {
  cycle: number;
  text: string;
}

/** Снимок количественного состояния ОДНОГО игрока на границе цикла — см. `CycleStateSnapshot`. Карты/
 * розыгрыши намеренно НЕ входят (по прямому запросу — «какие карты, как были сыграны хранить не надо,
 * для анализа это не важно»): это лог для анализа ТАКТИКИ (как идёт война, чем человек отличается от
 * AI), а не полный пошаговый реплей партии. */
export interface PlayerCycleState {
  money: number;
  /** Позиции и население каждого города игрока — по прямому запросу «сохраняй позиции городов,
   * население». */
  cities: { id: number; col: number; row: number; population: number }[];
  /** Остатки на складе — по прямому запросу «остатки на складе». Копия (не ссылка на живой объект). */
  warehouse: Partial<Record<ResourceId, number>>;
  /** Число и положение юнитов — по прямому запросу. Категория рядом с координатами — без нужды
   * анализировать состав армии по чистым числам пришлось бы пересчитывать это заново. */
  units: { col: number; row: number; category: UnitCategory }[];
  /** «Положение на научном треке» — число исследованных технологий на каждую из 4 веток (индекс —
   * `TechDef.branch`, 0-3), не сами id технологий (для анализа темпа исследований чисел достаточно,
   * конкретные технологии видны из `researchedTechs` в самом снимке состояния сессии). */
  researchedTechsByBranch: [number, number, number, number];
}

/** Снимок КОЛИЧЕСТВЕННОГО состояния партии на КАЖДОЙ границе цикла (по прямому запросу — «лог для
 * анализа тактики», отдельно от `GameLogEntry` выше: тот — КАЧЕСТВЕННЫЕ события «что произошло», этот
 * — количественный срез «как всё выглядело» на конкретный момент, чтобы сравнивать темп игры человека
 * и AI по циклам). Копится ВНУТРИ одного сохранения (см. GameLogEntry) начиная с первой границы цикла,
 * никогда не усекается. Только живые (не выбывшие) на момент снимка игроки — у выбывшего с этого
 * момента нет содержательного состояния для сравнения. */
export interface CycleStateSnapshot {
  cycle: number;
  players: Record<number, PlayerCycleState>;
}

export interface Relation {
  war: boolean;
  agreements: Set<Agreement>;
  /** Цикл (this.cyclesElapsed), до которого действует перемирие между этой парой — заключено через
   * ProposalTerm "peace" с указанным сроком (по прямому запросу, 2-6 циклов). undefined — перемирия
   * либо не было, либо оно уже истекло / было заключено без срока (старые предложения без duration —
   * «текущее перемирие пока не засчитывай», по прямому уточнению). Пока `cyclesElapsed < это число`,
   * declareWar между этой парой запрещён. */
  truceUntilCycle?: number;
  /** Минимальная длительность войны (по прямому запросу — «война длится минимум 3 цикла, нельзя
   * заключить мир раньше, AI не присылает предложения мира первые 3 хода») — цикл (`cyclesElapsed`),
   * раньше которого мир между этой парой заключить нельзя (см. `resolveProposal`) и AI не отправляет
   * предложение с условием "peace" (см. `bot.ts: considerPeaceOffers`). Выставляется в `declareWar` на
   * САМОЕ первое объявление войны этой паре (`cyclesElapsed + 3`) и заново продлевается на ещё
   * `cyclesElapsed + 3` при КАЖДОМ отклонении предложения мира, пока война продолжается (см.
   * `resolveProposal` — «после отказа от мира война длится ещё 3 хода минимум и снова 3 цикла нельзя
   * посылать предложения о мире»). undefined/уже прошедший цикл — ограничения нет. */
  noPeaceBeforeCycle?: number;
}

// === Отношения AI — числовая АСИММЕТРИЧНАЯ шкала 0-100 (по прямому запросу) ======================
// В отличие от `Relation` выше (СИММЕТРИЧНЫЙ факт партии — война/соглашения одинаковы для обеих
// сторон пары, см. `relationOf`/`pairKey` ниже) — это ЛИЧНОЕ мнение ОДНОГО игрока о ДРУГОМ, у
// каждой упорядоченной пары своё число (моё мнение о соседе ≠ его мнение обо мне). Старт всем — 50
// (нейтрально), пока ни один фактор ещё не сработал — запись в `relationScores` не материализуется
// заранее (нет смысла на 30 пар при 6 игроках, но и не обязательно), `relationScoreOf` просто отдаёт
// дефолт 50 для отсутствующего ключа. Публично видно всем клиентам (как и `relations`,
// `privateView.ts` их не фильтрует) — по прямому запросу, отображается на линиях дипломатии.
export type RelationTier = "hate" | "hostile" | "bad" | "neutral" | "good" | "friendly" | "allied";

export type ProposalTerm =
  | { kind: "agreement"; agreement: Agreement }
  /** `duration` — срок перемирия в циклах, 2-6 включительно (по прямому запросу) — пока он не
   * истёк, ни одна сторона не может объявить войну другой снова (см. declareWar). */
  | { kind: "peace"; duration: number }
  | { kind: "demandMoney"; amount: number }
  | { kind: "offerMoney"; amount: number }
  | { kind: "giveCity"; cityId: number }
  | { kind: "demandCity"; cityId: number }
  | { kind: "demandResource"; resource: ResourceId; qty: number }
  | { kind: "giveResource"; resource: ResourceId; qty: number }
  // === Отношения AI — система обещаний (по прямому запросу, фактор 9) — `from` ДАЁТ обещание, `to`
  // ПОЛУЧАЕТ его (тот, в чьих интересах оно исполняется) — принятое (`resolveProposal`, accepted)
  // порождает запись в `activePromises` (см. AiPromise ниже), applyProposalTerms. `duration` — срок
  // действия в циклах для 3 «не-делай»-обещаний ниже; `promiseGiveCardType`/`promiseListResource` —
  // разовые, «до истечения `duration` должен исполнить, иначе это и есть нарушение».
  | { kind: "promiseNoSettle"; regionCol: number; regionRow: number; duration: number }
  | { kind: "promiseNoAttack"; duration: number }
  /** `excludedPlayerId` — конкретный третий игрок, которому ДАЮЩИЙ обещание не должен передавать
   * карты событий (не «вообще никому») — по прямому запросу («не делиться картами... с тем, с кем у
   * НЕГО [просящего] наихудшие отношения» — третья сторона, отдельная и от `from`, и от `to`). */
  | { kind: "promiseNoEventCards"; excludedPlayerId: number; duration: number }
  | { kind: "promiseGiveCardType"; cardId: string; duration: number }
  | { kind: "promiseListResource"; resource: ResourceId; duration: number }
  // === «План войны» — вступление в чужую войну по призыву и совместное нападение (по прямому
  // запросу, НОВЫЕ) — оба принятия НЕМЕДЛЕННО объявляют войну (см. applyProposalTerms), не через
  // систему обещаний/ценности выше — эти два терма не «стоят» ничего в системе ценности объектов
  // (§8.1), сама пригодность оценивается ботом отдельными правилами при приёме (см. bot.ts).
  /** Отправитель УЖЕ воюет с `targetId` и просит получателя присоединиться на его стороне —
   * принятие объявляет войну `targetId` ОТ ПОЛУЧАТЕЛЯ (не от отправителя — тот уже воюет). */
  | { kind: "callToWar"; targetId: number }
  /** Ни отправитель, ни получатель ещё не воюют с `targetId` — принятие объявляет войну ОТ ОБЕИХ
   * сторон предложения одновременно. */
  | { kind: "jointAttack"; targetId: number }
  /** «Прекратить торговлю с врагом» (по прямому запросу) — отправитель требует, чтобы ПОЛУЧАТЕЛЬ
   * порвал связи с третьим игроком `targetId` (как правило — врагом отправителя). Принятие НЕМЕДЛЕННО
   * разрывает ВСЕ действующие соглашения получателя с `targetId` (`relationOf(to, targetId).agreements`
   * — Открытые границы/Вассалитет/Совместная оборона/Торговый союз/Научное сотрудничество/Союз), без
   * системы обещаний: это разовое действие, а не обязательство на срок. Войны не объявляет и
   * заключать новые соглашения позже не запрещает. */
  | { kind: "breakTiesWith"; targetId: number };
export interface Proposal {
  id: number;
  from: number;
  to: number;
  terms: ProposalTerm[];
  ultimatum: boolean;
}

/** Оповещение о глобальном событии — катаклизмы от сброшенного по переполнению руки «Учёного»
 * (resolveHandOverflowDiscard) и, по прямому запросу («выборы прошли, но кто генсек? нужно
 * объявлять всем (кроме AI)»; «нужно писать результаты голосования по резолюциям, включая мирового
 * лидера, кто за что проголосовал и каков итог»), результат выборов генсека ООН
 * (`tallyOonSecretaryElection`/`holdOonElection`) и итог голосования по резолюции ООН
 * (`tallyOonResolution`) — висит у КАЖДОГО живого игрока-человека независимо, пока он сам не закроет
 * окно (dismissGlobalEvent добавляет его в dismissedBy; запись удаляется из очереди, только когда её
 * закрыли ВСЕ живые люди — AI это окно не видит и в dismissedBy не попадает, см. dismissGlobalEvent).
 * `hexes` для обоих видов ООН-событий всегда пуст — не привязаны к месту на карте, подсветки не
 * требуют. */
export interface PendingGlobalEvent {
  id: number;
  kind: "cataclysm" | "oonSecretaryElected" | "oonResolutionResult";
  sourcePlayerId: number;
  description: string;
  hexes: { col: number; row: number }[];
  dismissedBy: number[];
}

/** Отношения AI — активное обещание (создано принятием одного из 5 promise*-термов выше, см.
 * applyProposalTerms). `by` — кто ДАЛ обещание (обязан, может нарушить — не блокируется, только
 * штраф пост-фактум); `to` — кому обещали (в чьих интересах). Не-делай-обещания (noSettle/noAttack/
 * noEventCards) считаются ВЫПОЛНЕННЫМИ, если дожили до `expiresAtCycle` без нарушения (см.
 * resolveCycleBoundary); giveCardType/listResource — наоборот, «до `expiresAtCycle` должны
 * ИСПОЛНИТЬСЯ, иначе сам факт истечения — и есть нарушение» (см. handoffCard/sellListing). */
export interface AiPromise {
  id: number;
  by: number;
  to: number;
  kind: "noSettle" | "noAttack" | "noEventCards" | "giveCardType" | "listResource";
  expiresAtCycle: number;
  regionCol?: number;
  regionRow?: number;
  excludedPlayerId?: number;
  cardId?: string;
  resource?: ResourceId;
}

/** «План войны» (по прямому запросу — многоходовая подготовка к войне вместо мгновенного объявления
 * по факту условия, см. ЦИВА-СПРАВОЧНИК §15.2): один активный план на игрока одновременно. Живёт на
 * сессии (не в модуле bot.ts) тем же принципом, что и `diplomacyAttemptMemory`/`lastHandoffCycle` —
 * своя память на каждую партию/комнату. Игровую логику саму по себе не меняет — это чисто AI-память,
 * управляется и читается только `bot.ts`. */
/** Запись журнала военных потерь городов (по прямому запросу §3.1/§2.1) — один военный захват города.
 * Живёт ограниченное время (см. `GameSession.pruneCityLossJournal`, вызывается из
 * `resolveCycleBoundary`): удаляется, когда `oldOwnerId` отбивает город назад, город разрушен, или
 * запись просто устарела (>CITY_LOSS_JOURNAL_MAX_AGE циклов) — иначе список рос бы неограниченно за
 * долгую партию, а мотивация «вернуть» давно нерелевантного захвата бота не интересует. */
export interface CityLossRecord {
  cityId: number;
  col: number;
  row: number;
  regionCol: number;
  regionRow: number;
  oldOwnerId: number;
  newOwnerId: number;
  cycle: number;
}

export interface WarPlan {
  targetId: number;
  cause: "resourceShortage" | "expansion";
  resource?: ResourceId;
  /** Конкретный (приграничный) регион цели, который планируется захватить. */
  regionCol: number;
  regionRow: number;
  citiesWanted: number;
  /** Своя land-компонента (`bot.ts: landComponentOf`) не пересекается с городом цели — нужна переброска флотом. */
  requiresNavy: boolean;
  createdAtCycle: number;
  /** «Закрывающееся окно возможностей» (по прямому запросу §1.2, bot.ts: considerWarPlan) — соотношение
   * сил (свои/чужие юниты, та же метрика, что и порог готовности плана) в момент СОЗДАНИЯ плана —
   * опорная точка, относительно которой считается, растёт разрыв или сокращается. */
  ratioAtCreation: number;
  /** Последние 3 замера соотношения сил (по одному за цикл, пока план жив) — используется, чтобы
   * поймать УСТОЙЧИВОЕ (3 замера подряд) сокращение разрыва, не разовый шум одного хода. Последний
   * элемент — самый свежий замер. */
  ratioHistory: number[];
  /** Цикл последнего замера `ratioHistory` — `considerWarPlan` вызывается потенциально несколько раз
   * за один ход (цикл guard-цикла в runAiTurnLogic), без этой отметки один и тот же цикл писался бы в
   * историю несколько раз подряд, ломая «3 замера = 3 цикла». */
  lastRatioSampleCycle: number;
}

/** Шесть шаблонов «Армии» (по прямому запросу, продолжение «Плана войны» — теперь уже ВЕДЕНИЕ, не
 * только подготовка к войне) — состав каждого см. `bot.ts: ARMY_TEMPLATE_COMPOSITION`. Корабли
 * («Десантная») в состав армии НЕ входят — переброска обслуживается отдельной персистентной сущностью
 * `Fleet` (см. ниже), которую армия лишь временно занимает под рейс; между рейсами флот сам решает,
 * чем заниматься (поддержка осады/охота на вражеский флот/набег). */
export type ArmyTemplate = "amphibious" | "fieldArtillery" | "assaultFar" | "assaultNear" | "cleanup" | "defensive" | "mobile";

/** Действующее формирование — по прямому запросу «армия может быть неполной»: живёт и действует с
 * любым числом членов от 2 (ниже — просто свободный юнит, обычная пожюнитная логика, отдельно не
 * трекается) до лимита 4; роль, для которой не хватает состава (например Десантная без Артиллерии),
 * просто не выполняется, остальные роли работают тем, что есть. **Состав НЕ хранится здесь отдельным
 * массивом** — членство читается напрямую с юнитов (`UnitInstance.armyId === Army.id`, `bot.ts:
 * armyMembersOf`) — раньше был отдельный `memberUnitIds`, но эта запись мутировалась бы только на
 * клоне планирования хода бота (см. `bot.ts: computeAiTurnPlan`, structuredClone) и никогда не
 * доходила бы до настоящей партии; `armyId` юнита, наоборот, персистентно проставляется РЕАЛЬНЫМ
 * dispatch (`buildUnitCard`/`buyUnitWithMoney`), который честно реплеится при подтверждении хода. */
export interface Army {
  id: number;
  playerId: number;
  template: ArmyTemplate;
  /** Противник (наступательные шаблоны) — `null` у Оборонительной (та привязана к городу, не к цели). */
  targetPlayerId: number | null;
  /** Регион цели (наступательные шаблоны) — `null` у Оборонительной. */
  targetRegionCol: number | null;
  targetRegionRow: number | null;
  /** Свой город, который держит Оборонительная армия — `null` у наступательных шаблонов. */
  homeCityId: number | null;
  createdAtCycle: number;
}

/** Персистентная пара (иногда больше) кораблей одного игрока (по прямому запросу — «держать корабли
 * парами, так как один корабль не уничтожит другой без второго») — живёт САМА ПО СЕБЕ, не как часть
 * конкретной `Army`: между перевозками занимается собственными задачами (§15.9а — поддержка своей
 * осады/охота на вражеский флот/набег на прибрежные города). `Army` при необходимости переброски
 * (см. `bot.ts: ferryArmyMembers`) просто пользуется свободным (без пассажира) кораблём ближайшего
 * флота — явного состояния «занят перевозкой» не заводится, это читается каждый ход по факту (несёт
 * ли корабль пассажира прямо сейчас). */
export interface Fleet {
  id: number;
  playerId: number;
  shipUnitIds: number[];
  createdAtCycle: number;
}

/** Заявка на постройку армии (по прямому запросу §3.4/§5 — «строятся по одной, не параллельно») —
 * `session.armyBuildQueue[playerId]`, обычный МАССИВ (не Set/Map) в порядке очереди: голова — то, что
 * сейчас строится, приоритет постройки юнита картой «Воин» отдаётся ИМЕННО её недостающей категории
 * (см. `bot.ts: tryBuildArmyUnit`). `armyId` заполняется СРАЗУ при создании заявки (вместе с самой
 * `Army`, см. `bot.ts: ensureArmyBuildOrders` — обе создаются на НАСТОЯЩЕЙ сессии, не на клоне
 * планирования, см. доку `Army` выше про то, почему это важно), не лениво по первому юниту — заявка
 * остаётся в очереди (не считается «выполненной» просто так), пока состав не достигнет полного шаблона
 * ИЛИ война с целью не кончится/город обороны не потерян (тогда заявка снимается — см. `bot.ts:
 * pruneArmies`). Оборонительная заявка на новый угрожаемый город вставляется В НАЧАЛО очереди
 * (прерывает уже идущий наступательный проект) — реальная защита важнее продолжения наступления. */
export interface ArmyBuildOrder {
  id: number;
  playerId: number;
  template: ArmyTemplate;
  targetPlayerId: number | null;
  targetRegionCol: number | null;
  targetRegionRow: number | null;
  homeCityId: number | null;
  armyId: number;
  createdAtCycle: number;
}

/** Сводка активного «Плана войны» для предпросмотра хода AI (по прямому запросу — «добавь где
 * подготовка к войне или война, чтоб было видно, какой город планируется захватить и ради какого
 * ресурса, чтоб понимать, соответствует ли строительство плану»). Считается один раз вместе с самим
 * планом хода (`bot.ts: prepareNextAiPlanIfNeeded`), не заново на каждый рендер — `targetCityCol/Row`
 * — `null`, если у цели почему-то уже нет города именно в этом регионе (план на грани снятия). */
export interface PendingWarPlanInfo {
  targetPlayerId: number;
  cause: WarPlan["cause"];
  resource: ResourceId | null;
  regionCol: number;
  regionRow: number;
  targetCityCol: number | null;
  targetCityRow: number | null;
  requiresNavy: boolean;
  /** По прямому уточнению — «план войны — это не война, это подготовка к экспансии, и она ВСЕГДА
   * ведётся» — `true`, если это настоящий `session.warPlans[playerId]` (отношения уже испортились
   * настолько, что копится военный перевес/действует военное давление); `false` — это только ТЕКУЩИЙ
   * кандидат `findResourceShortageTarget`/`findExpansionTarget`, которым сейчас руководствуется
   * дипломатия (вежливая просьба/дань-ультиматум), а не формальный план — показывается тем же
   * приёмом, чтобы цель была видна ВСЕГДА, а не только когда дошло до военной эскалации. */
  isFormalPlan: boolean;
}

/** Регион «напряжения обороны» для предпросмотра хода AI (по прямому запросу — «надпись в три
 * строки: приоритет / регион напряжения (атаки ИЛИ обороны) / игрок и ресурс») — приграничный регион
 * с наибольшим скоплением чужих юнитов, тот же признак, что уже использует `bot.ts: hasBorderThreat`
 * (сумма чужих > своих во ВСЕХ приграничных регионах разом), только здесь — САМ КОНКРЕТНЫЙ регион, а
 * не булево по всем сразу. `null` — ни в одном приграничном регионе чужих юнитов вовсе нет. */
export interface PendingBorderThreatInfo {
  regionCol: number;
  regionRow: number;
  enemyPlayerId: number;
  enemyUnits: number;
}

/** Разбивка дохода торговой сети (по прямому запросу — окно составления «Торговца» человеком) — см.
 * `GameSession.computeTradeIncomeBreakdown`/`previewTraderTradeIncome`. */
export interface TradeIncomeBreakdown {
  networkCities: { cityId: number; playerId: number; population: number }[];
  /** Все ДОСТУПНЫЕ уникальные торговые виды (город+склад), не только выбранные — нужно для чекбоксов. */
  available: { resource: ResourceId; source: "access" | "warehouse" }[];
  /** Подмножество `available`, реально пущенное в оборот в ЭТОМ расчёте. */
  selected: ResourceId[];
  grossIncome: number;
  tollBreakdown: { playerId: number; amount: number }[];
  raiderBreakdown: { playerId: number; unitId: number; amount: number }[];
  /** Итоговая доля играющего — после толлов/грабежа, с гандикапом бота (если применим). */
  playerShare: number;
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
  /** Только для `source === "market"` — цена лота в момент покупки (по прямому запросу: «в плане
   * пропущен шаг покупки на бирже» — без цены здесь нечем было бы подписать её в предпросмотре
   * хода AI, см. ActionResult.spent). */
  price?: number;
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
  /** Кто вынес резолюцию (действующий генсек на момент выкладки) — нужен AI для голосования по
   * отношению к автору (см. bot.ts: considerOonVote), не только для истории. */
  proposerId: number;
  /** playerId → голос «за»/«против»; вес голоса = население игрока (totalPopulationOf), не «1
   * игрок — 1 голос». Инициатор (генсек) голосует «за» автоматически при выкладке — КРОМЕ
   * «Мирового лидера» (см. candidate1Id/candidate2Id ниже), там `true`/`false` значит «за
   * candidate1Id»/«за candidate2Id», а не «за»/«против» резолюции как таковой. */
  votes: Record<number, boolean>;
  /** ТОЛЬКО для type === "worldLeader" (по прямому запросу — «выдвигая эту резолюцию игроки
   * голосуют за двух лидеров, набравший более 80% побеждает»): те же 2 кандидата, что и на выборах
   * генсека (oonCandidate1Id/effectiveOonCandidate2Id — владелец 1-го здания ООН и лидер по
   * населению среди остальных, тай-брейк по городам/юнитам), зафиксированные в момент выкладки —
   * дальнейшее движение effectiveOonCandidate2Id (население меняется) эту КОНКРЕТНУЮ резолюцию уже
   * не задевает, только следующую. `votes[playerId] === true` — голос за candidate1Id, `false` — за
   * candidate2Id (голосовать «против обоих» нельзя — модель ровно та же, что и у выборов генсека). */
  candidate1Id?: number;
  candidate2Id?: number;
}

/** Выборы генерального секретаря ООН (заменяет прежнее мгновенное сравнение населения — см.
 * holdOonElection) — настоящее голосование по тому же принципу, что и резолюции выше: вес голоса =
 * население, но выбор БИНАРНЫЙ (за одного из двух кандидатов, не «за/против»). Открывается
 * holdOonElection и живёт, пока не проголосуют либо все ещё активные игроки, либо у одного из
 * кандидатов не наберётся более половины суммарного веса (см. tallyOonSecretaryElection). */
export interface PendingOonSecretaryElection {
  id: number;
  candidate1Id: number;
  candidate2Id: number;
  /** playerId → id кандидата, за которого он проголосовал (один из двух выше). */
  votes: Record<number, number>;
}

/** Полный снимок партии — форма и сообщений WebSocket "state", и файла на диске (rooms.ts). */
export interface SaveGameV1 {
  version: 1;
  players: { name: string; color: number; isAI?: boolean }[];
  autoPlayAI?: boolean;
  /** Режим партии — "hotseat" (по умолчанию, покрывает и «За одним компьютером», и «Против AI»,
   * см. autoPlayAI) или "wego" (сетевые слоты, приватные руки, одновременное разрешение раундов —
   * см. weGoRound.ts). Отсутствует в старых сохранённых файлах — трактуется как "hotseat". */
  mode?: "hotseat" | "wego";
  /** Таймеры WeGo (weGoScheduler.ts) — не используются вне mode==="wego". roundDeadline/roundOpenedAt
   * — unix ms, границы ТЕКУЩЕГО открытого раунда (null — раунд не открыт/партия не WeGo).
   * roundTimeMs/sessionTimeMs — настройки комнаты (по умолчанию 3мин/90мин, см. конструктор).
   * spentPlanningMs — накопленное по каждому игроку суммарное время планирования за партию.
   * aiControlled — кто перманентно перешёл под AI из-за исчерпания sessionTimeMs (отдельно от
   * исходного Player.isAI — см. weGoScheduler.ts). */
  roundDeadline?: number | null;
  roundOpenedAt?: number | null;
  roundTimeMs?: number;
  sessionTimeMs?: number;
  spentPlanningMs?: Record<number, number>;
  aiControlled?: number[];
  phase: Phase;
  currentPlayerIndex: number;
  winner: number | null;
  /** Тип победы (по прямому запросу — «дашборд результатов с типом победы») — человекочитаемая
   * подпись, устанавливается В ТОТ ЖЕ МОМЕНТ, что и winner, на каждом из путей победы (territorial/
   * space/oon). null, если winner ещё null. */
  winnerType: string | null;
  /** Все победители при ничьей по лимиту раундов WeGo (см. declareTurnLimitDraw) — все неисключённые
   * (не eliminatedPlayers) игроки сразу. У обычных путей победы (territorial/space/oon) содержит
   * ровно [winner]. Отсутствует в старых сохранённых файлах — восстанавливается из winner. */
  winners?: number[];
  turnsRemaining: number;
  /** Исходный лимит раундов партии (см. конструктор) — только для человекочитаемого текста ничьей
   * (declareTurnLimitDraw); сама остановка считается по turnsRemaining===0, не по этому полю.
   * Отсутствует в старых сохранённых файлах — трактуется как старый дефолт 60. */
  maxTurns?: number;
  /** Монотонно растущий счётчик ПОЛНЫХ циклов с начала партии (в отличие от turnsRemaining — тот
   * убывает и мог бы в теории стартовать не с 60) — нужен как абсолютная точка отсчёта для срока
   * перемирия (Relation.truceUntilCycle, см. declareWar). */
  cyclesElapsed: number;
  /** Журнал ключевых событий партии — см. `GameLogEntry`. Опционально, отсутствует в старых
   * сохранённых файлах — трактуется как «истории до этого момента ещё нет» (не восстанавливается
   * задним числом, партия просто продолжает копить журнал с этой точки). */
  eventLog?: GameLogEntry[];
  /** Снимки количественного состояния по циклам — см. `CycleStateSnapshot`. Опционально, отсутствует
   * в старых сохранённых файлах — трактуется как «снимков до этого момента ещё нет». */
  cycleLog?: CycleStateSnapshot[];
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
  /** Коммунизм (grantCommunismResourceIncome) — сколько единиц каждого типа на складе игрока сейчас
   * защищены от продажи на бирже (см. communismProtectedQty/sellResource), т.к. пришли от бонуса
   * парадигмы, а не от собственной добычи/покупки. Не больше настоящего остатка на складе. */
  communismBonusHeld: Record<number, Partial<Record<ResourceId, number>>>;
  /** Коммунизм (по прямому запросу — «дополнительно к столице выбирается город») — id ВТОРОГО
   * города, чей регион тоже участвует в бонусе (см. communismCapitalTypes); столица при этом не
   * меняется и продолжает участвовать сама по себе — это ДОБАВКА, не замена. `undefined`/отсутствие
   * ключа — доп. город ещё не выбран (только столица). См. GameSession.chooseCommunismCity. */
  communismExtraCityId?: Record<number, number>;
  /** Бот (по прямому запросу — «меняет религию не чаще 1 раза в 6 циклов») — playerId → номер цикла
   * (cyclesElapsed), раньше которого бот религию больше не меняет; чисто поведенческая память бота
   * (bot.ts: considerReligion), для людей ничего не значит и ни на что не влияет. */
  aiReligionLockUntilCycle?: Record<number, number>;
  money: Record<number, number>;
  hands: Record<number, CardDef[]>;
  deck: CardDef[];
  actionsLeft: Record<number, number>;
  /** Сколько действий было ВСЕГО в начале этого хода (2 база + Демократия + Религия, тот же расчёт,
   * что и actionsLeft, см. endTurn) — по прямому запросу «кружков должно быть равно числу действий,
   * а не max(2, остаток)»: actionsLeft один только УБЫВАЕТ по ходу игры, без этого поля клиент не
   * мог бы отличить «было 3, потратил 1» от «было и есть 2». НЕ уменьшается при трате действий,
   * только пересчитывается заново на следующий свой конец хода. */
  actionsTotal: Record<number, number>;
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
  relations: Record<string, { war: boolean; agreements: Agreement[]; truceUntilCycle?: number; noPeaceBeforeCycle?: number }>;
  /** Отношения AI — асимметричная шкала 0-100, ключ "${fromId}:${toId}" (см. класс ниже). Опционально
   * — отсутствует в старых сохранённых файлах, трактуется как «все пары по умолчанию 50». */
  relationScores?: Record<string, number>;
  /** Отношения AI — активные обещания. Опционально — отсутствует в старых сохранённых файлах. */
  activePromises?: AiPromise[];
  nextPromiseId?: number;
  /** Отношения AI — память попыток дипломатических запросов бота. Опционально — отсутствует в
   * старых сохранённых файлах, трактуется как «попыток ещё не было». */
  diplomacyAttemptMemory?: Record<string, number>;
  /** По прямому запросу — «нельзя передавать карту одному и тому же игроку два цикла подряд, минимум
   * через 1» (обязательная передача, ТЗ 2.3): цикл последней передачи, ключ `"${from}:${to}"`.
   * Опционально — отсутствует в старых сохранённых файлах, трактуется как «передач ещё не было». */
  lastHandoffCycle?: Record<string, number>;
  /** «План войны» (по прямому запросу) — один активный план на игрока, ключ `playerId`. Опционально —
   * отсутствует в старых сохранённых файлах, трактуется как «планов ещё нет». */
  warPlans?: Partial<Record<number, WarPlan>>;
  /** Кулдаун пересоздания «Плана войны» после добровольного снятия (§1.2) — опционально, отсутствует в
   * старых файлах, трактуется как «кулдаунов нет». */
  warPlanCooldowns?: Record<string, number>;
  /** Постройка юнитов по зонам фронта (`GameSession.warZoneBuildIndex`) — опционально, отсутствует в
   * старых файлах, трактуется как «очереди ещё не начаты» (каждая зона просто стартует с 0-й позиции
   * своего шаблона). */
  warZoneBuildIndex?: Record<string, number>;
  /** История веса игрока (§1.1/§5.1) — опционально, отсутствует в старых файлах, трактуется как «истории
   * ещё нет» (не критично — она просто начнёт копиться заново со следующего цикла). */
  weightHistory?: Partial<Record<number, number[]>>;
  /** Цикл начала Отчаяния (§1.1) — опционально, отсутствует в старых файлах. */
  weakSinceCycle?: Partial<Record<number, number>>;
  /** Живой флаг Отчаяния (§1.1) — опционально, отсутствует в старых файлах. */
  desperatePlayers?: number[];
  /** Зависшая война (§4.1) — опционально, отсутствует в старых файлах. */
  peaceOfferStreak?: Record<string, number>;
  peaceOfferStreakCycle?: Record<string, number>;
  /** Журнал военных потерь городов (§3.1/§2.1) — опционально, отсутствует в старых файлах. */
  recentCityLosses?: CityLossRecord[];
  /** Армии/флоты/очередь построек (§15.9а) — опционально, отсутствует в старых файлах. */
  armies?: Army[];
  nextArmyId?: number;
  fleets?: Fleet[];
  nextFleetId?: number;
  armyBuildQueue?: Partial<Record<number, ArmyBuildOrder[]>>;
  nextArmyBuildOrderId?: number;
  pendingProposals: Proposal[];
  nextProposalId: number;
  /** Опционально — отсутствует в старых сохранённых файлах, трактуется как «событий ещё нет». */
  pendingGlobalEvents?: PendingGlobalEvent[];
  nextGlobalEventId?: number;
  skippedTurn: number[];
  /** Почему у playerId стоит skippedTurn — только для текста модалки (см. pendingSkipTurnReason). */
  skipTurnReason: Partial<Record<number, "paradigm" | "religion">>;
  /** playerId, чей ход прямо сейчас заморожен на модалке «Ход пропущен» (см. advanceCurrentPlayer) —
   * null, если сейчас ничей ход не пропускается. */
  pendingSkipTurn: number | null;
  pendingSkipTurnReason: "paradigm" | "religion" | null;
  accessUsed: string[];
  productionUsedThisCycle: string[];
  /** Города, уже использовавшие альтернативную покупку юнита за деньги («Воин» + «Всеобщая воинская
   * повинность», по прямому запросу «нельзя использовать в тот же цикл дважды и более в одном
   * городе») в ЭТОМ цикле — см. buyUnitWithMoney. */
  conscriptionUsedThisCycle: number[];
  landedThisCycle: number[];
  outOfMoveThisCycle: number[];
  /** Сколько бюджета хода (moveRange) юнит УЖЕ потратил в ЭТОМ цикле — по прямому запросу «движение
   * должно случаться в текущем цикле» commandUnit теперь исполняет приказ сразу, а не откладывает его
   * до границы цикла; без этого счётчика повторный приказ тому же юниту в том же ходу давал бы ему
   * СВЕЖИЙ moveRange заново (обходя лимит хода за цикл). Общий с автопродолжением приказа, если путь
   * длиннее одного бюджета — оно тоже тратит отсюда же на границе следующего цикла. */
  moveBudgetUsedThisCycle: [number, number][];
  /** Кто уже отдавал приказ (движение/атака/оборона/грабёж) в ТЕКУЩЕМ цикле. */
  unitActedThisCycle: number[];
  /** Кто уже АТАКОВАЛ в ТЕКУЩЕМ цикле — по прямому запросу («атака завершает ход, нельзя атаковать
   * одним юнитом дважды») отдельный флаг именно под атаку, а не переиспользование
   * unitActedThisCycle: тот флаг ставится и движением/обороной/грабежом, и если гейтить атаку по
   * нему, обычный «подошёл и ударил в тот же ход» (движение → атака) сломался бы вместе с
   * повторной атакой. */
  attackedThisCycle: number[];
  /** Защита МЕСТНОСТИ (гекс) — общая для ВСЕХ юнитов на клетке, не зависит от того, какой из них
   * сейчас обороняется (по прямому запросу — «свойства защиты местности привязаны к гексу, а не
   * юниту»). См. unitDefendBuffer для отдельного персонального бонуса «Обороны». */
  hexDefense: [string, number][];
  /** Личный бонус конкретного юнита от команды «Оборона» (по прямому запросу) — отдельная от
   * hexDefense шкала, ключ — id юнита: снимается ВТОРЫМ, после местности, ДО здоровья (см.
   * applyDamage). Не завязана на гекс — если на клетке 2 юнита и только один обороняется, бонус
   * есть только у него, второй после общей местности сразу принимает урон по HP. */
  unitDefendBuffer: [number, number][];
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
  /** «Учёный», выбор 2 из 4 эффектов, доступных после того, как ВСЕ технологии партии уже открыты
   * этим игроком (см. useScientistEndgameEffect) — постоянный, до конца партии, +1 урона и +1HP
   * всем СВОИМ юнитам (unitStats). Не про технологию — обычный per-player флаг, тем же паттерном
   * персистентности, что eliminatedPlayers выше. */
  scientistCombatBonusPlayers: number[];
  upravlenieUsesThisCycle: Record<number, number>;
  mustHandoff: number[];
  /** «Распродажа», вынужденный сброс (см. resolveHandOverflowDiscard/playSaleCard в cards.ts) — по
   * прямому запросу глобальный негативный эффект «все игроки получают по 1 карте дополнительно в
   * следующем цикле», отложенный до реальной границы цикла (см. resolveCycleBoundary/
   * finalizeCardsAndBudget). `pendingBonusCardNextCycle` — взведён, ждёт ближайшей границы цикла;
   * `bonusCardOwed` — набор playerId, которым уже причитается лишняя карта на их следующей раздаче
   * этого цикла (снимается по мере выдачи, по одному на игрока). */
  pendingBonusCardNextCycle: boolean;
  bonusCardOwed: number[];
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
  /** Цикл следующего переизбрания генсека (по прямому запросу — «выборы каждые 5 циклов после
   * первых») — null, пока первых выборов не было вовсе. Опционально — отсутствует в старых
   * сохранённых файлах, трактуется как «переизбрание не запланировано» (у старых партий с уже
   * избранным генсеком следующее переизбрание не наступит, пока кто-то не пересоздаст сессию —
   * приемлемо, это не критичная игровая механика). */
  oonNextElectionCycle?: number | null;
  /** Опционально — отсутствует в старых сохранённых файлах, трактуется как «выборы сейчас не идут». */
  pendingOonSecretaryElection?: PendingOonSecretaryElection | null;
  nextOonSecretaryElectionId?: number;
  pendingOonResolution: PendingOonResolution | null;
  nextOonResolutionId: number;
  /** Тип ПОСЛЕДНЕЙ вынесенной резолюции (независимо от исхода голосования) — по прямому запросу
   * («запрети выносить одни и те же резолюции два раза подряд, минимум через одну») — null, если
   * резолюций в этой партии ещё не было вовсе (тогда следующая обязана быть "worldLeader", см.
   * proposeOonResolution). Опционально — отсутствует в старых сохранённых файлах, трактуется как
   * «резолюций ещё не было». */
  lastOonResolutionType?: OonResolutionType | null;
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
  /** Предпросмотр хода AI, только для сообщения "state" клиенту — не персистится через fromJSON
   * (см. поле класса выше), при загрузке всегда приходит `undefined`/пересчитывается заново.
   * `strategicPriority` — по прямому запросу: метка общего стратегического режима, которым в этот
   * ход руководствуется бот (см. bot.ts: computeStrategicPriority) — вычисляется один раз, ДО
   * розыгрыша шагов, показывается человеку слева от колоды карт (main.ts). */
  pendingAiPlan?: { playerId: number; steps: AiPlanStep[]; strategicPriority: StrategicPriority; warPlan?: PendingWarPlanInfo | null; borderThreat?: PendingBorderThreatInfo | null } | null;
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
  /** Ресурсы, реально списанные этим действием через commitSpend (по прямому запросу — живой
   * баг-репорт: «в плане пропущен шаг покупки на бирже», когда склад пуст, а действие всё равно
   * прошло за счёт автопокупки на рынке за деньги, см. «Доступ → склад → рынок» в СПРАВОЧНИКЕ) —
   * только у действий, которые реально тратят ресурсы через planFoodSpend/planResourceSpend; `bot.ts`
   * использует это, чтобы приписать явную пометку о покупке к шагу предпросмотра хода AI. */
  spent?: SpendPlanItem[];
  /** Поддержка в этом конкретном бою (по прямому запросу — «анимация линиями... чтоб было видно
   * какие юниты оказали поддержку») — одна запись на каждого поддержавшего, `from` — его позиция,
   * `to` — позиция того, кого он поддержал (атакующий или защитник). Клиент рисует линию на каждую
   * запись поверх карты; чисто визуальные данные, ни на что в состоянии партии не влияют. */
  supportLines?: { from: { col: number; row: number }; to: { col: number; row: number } }[];
  /** Данные для анимации боя (по прямому запросу — «полоски от юнита к цели, с отображаемым
   * убыванием защиты, хотя бы секунда анимации») — чисто отображение, ни на что в состоянии партии
   * не влияет: сама атака (`resolveCombat`) уже применена и посчитана целиком ДО того, как эти
   * данные собраны, здесь только моментальные снимки до/после каждого удара. `hits` — 1 запись на
   * каждую задетую цель (несколько только у AoE — сейчас только Корабли бьют по всем на клетке
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
  /** Ядерный удар (Ядерный арсенал) — чисто для анимации на клиенте (взрыв на цели/соседях), ни на
   * что в состоянии партии не влияет — весь урон/разрушения уже применены к моменту ответа. `hit:
   * false` — перехвачен ПРО «Космодрома» цели, `hexes` в этом случае пуст (взрыва не было). См.
   * GameSession.launchNuclearStrike. */
  nuclearStrike?: { hit: boolean; target: { col: number; row: number }; hexes: { col: number; row: number }[] };
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
  /** Режим партии «Против AI» (по прямому запросу) — в отличие от обычного хотсита, где AI-игроки
   * останавливаются на предпросмотре хода и ждут кнопку (см. bot.ts pendingAiPlan/confirmAiTurn),
   * здесь их ходы применяются автоматически, по одному действию с паузой (см. wsServer.ts
   * driveAutoPlay/bot.ts playAiTurnPaced) — имитирует темп настоящего игрока, не мгновенный рывок.
   * Устанавливается один раз при создании комнаты (см. rooms.ts), общий на всю партию (не за
   * игрока) — то же самое, что выбор экрана «Против AI» вместо «За одним компьютером» в меню. */
  autoPlayAI = false;

  /** Режим партии, см. SaveGameV1.mode. Устанавливается один раз при создании комнаты, общий на всю
   * партию. "hotseat" — старый путь (endTurn/advanceCurrentPlayer, нефильтрованный broadcastState).
   * "wego" — сетевой режим с раундами, см. weGoRound.ts (пока не подключён нигде, поле только
   * персистится). */
  mode: "hotseat" | "wego" = "hotseat";

  // Таймеры WeGo (см. weGoScheduler.ts) — только для mode==="wego", хотсит/«Против AI» их не читают
  // и не пишут вовсе. roundDeadline/roundOpenedAt — null, пока раунд не открыт (openNewRound).
  roundDeadline: number | null = null;
  roundOpenedAt: number | null = null;
  roundTimeMs = 180_000; // 3 минуты
  sessionTimeMs = 5_400_000; // 90 минут
  spentPlanningMs: Record<number, number> = {};
  aiControlled = new Set<number>();

  phase: Phase = "placement";
  currentPlayerIndex = 0;
  winner: number | null = null;
  winnerType: string | null = null;
  winners: number[] = [];
  turnsRemaining = 60;
  maxTurns = 60;
  cyclesElapsed = 0;

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
  attackedThisCycle = new Set<number>();
  hexDefense = new Map<string, number>();
  unitDefendBuffer = new Map<number, number>();
  citySiegeBuffer = new Map<number, number>();
  ruins: { col: number; row: number }[] = [];
  eliminatedPlayers = new Set<number>();
  scientistCombatBonusPlayers = new Set<number>();

  market: MarketListing[] = [];
  nextListingId = 1;
  tradeRoutes: TradeRoute[] = [];
  nextRouteId = 1;

  buildingOwners: BuildingOwners = {};
  deck: CardDef[];
  hands: Record<number, CardDef[]> = {};
  actionsLeft: Record<number, number> = {};
  actionsTotal: Record<number, number> = {};
  money: Record<number, number> = {};
  warehouse: Record<number, Partial<Record<ResourceId, number>>> = {};
  communismBonusHeld: Record<number, Partial<Record<ResourceId, number>>> = {};
  communismExtraCityId: Record<number, number> = {};
  aiReligionLockUntilCycle: Record<number, number> = {};

  researchedTechs: Record<number, Set<string>> = {};
  playerParadigm: Record<number, Paradigm | null> = {};
  playerReligion: Record<number, Religion | null> = {};
  religionFounder: Partial<Record<Religion, number>> = {};
  techDiscoverer: Record<string, number> = {};
  /** Здание «Управление» — сколько раз игрок уже воспользовался ЛЮБОЙ из его 2 функций (доп.
   * действие / добор карты с колоды) в ЭТОМ цикле — общий счётчик на обе функции, растёт ценой
   * (см. `upravlenieNextPrice`). Сбрасывается раз в цикл (`resolveCycleBoundary`), не за ход —
   * в отличие от остальных зданий, «Управление» не лимитировано разом за ход/цикл вовсе, только
   * ценой. */
  upravlenieUsesThisCycle: Record<number, number> = {};
  /** Обязательная передача карты (ТЗ 2.3, «не реализовано» → реализовано по прямому уточнению) —
   * кто ОБЯЗАН отдать 1 карту, прежде чем сможет сделать хоть что-то ещё в своём ходу. Выставляется
   * в endTurn сразу после раздачи 3 карт (см. CARDS_DEALT_PER_TURN); снимается только handoffCard. */
  mustHandoff = new Set<number>();
  pendingBonusCardNextCycle = false;
  bonusCardOwed = new Set<number>();
  spaceComponents: Record<number, number> = {};
  nuclearWeapons: Record<number, number> = {};
  oonCandidate1Id: number | null = null;
  oonCandidate2Id: number | null = null;
  oonSecretaryGeneralId: number | null = null;
  oonNextElectionCycle: number | null = null;
  pendingOonSecretaryElection: PendingOonSecretaryElection | null = null;
  nextOonSecretaryElectionId = 1;
  pendingOonResolution: PendingOonResolution | null = null;
  nextOonResolutionId = 1;
  lastOonResolutionType: OonResolutionType | null = null;
  oonOpenTradeActive = false;
  oonNuclearBanActive = false;
  oonNeutralWatersActive = false;
  oonSanctionedPlayerId: number | null = null;
  oonGreenAgendaActive = false;
  oonPriceRegulation: { resource: ResourceId; price: number } | null = null;
  oonArmsLimit: number | null = null;

  /** Журнал ключевых событий партии — см. `GameLogEntry`. Публично видим всем клиентам, как и
   * `relations`/`relationScores` (privateView.ts их не фильтрует) — история партии не секрет ни от
   * кого. */
  eventLog: GameLogEntry[] = [];
  /** Снимки количественного состояния по циклам — см. `CycleStateSnapshot`. Тот же принцип
   * публичности, что и `eventLog`. */
  cycleLog: CycleStateSnapshot[] = [];
  relations: Record<string, Relation> = {};
  /** Отношения AI — асимметричная шкала (см. RelationTier выше и методы ниже, у relationOf). */
  relationScores: Record<string, number> = {};
  /** Отношения AI — активные обещания (см. AiPromise выше). */
  activePromises: AiPromise[] = [];
  nextPromiseId = 1;
  /** Отношения AI — память попыток дипломатических запросов AI-бота (по прямому запросу — «нет
   * смысла просить второй раз, если отказали», «рассылка не каждый ход, пока условие не изменилось»)
   * — ключ "${from}:${to}:${scenarioKey}", значение — цикл ПОСЛЕДНЕЙ попытки (успешной или
   * отклонённой — неважно, сам факт недавней попытки уже достаточен, см. bot.ts). Не влияет на
   * игровую логику саму по себе — чисто AI-эвристика, живёт на сессии (не в модуле bot.ts), чтобы
   * верно сериализоваться отдельно на каждую партию/комнату (а не делиться памятью между разными
   * одновременными играми на одном сервере). */
  diplomacyAttemptMemory: Record<string, number> = {};
  /** По прямому запросу — «нельзя передавать карту одному и тому же игроку два цикла подряд, минимум
   * через 1» (обязательная передача, ТЗ 2.3): ключ `"${from}:${to}"`, значение — цикл последней
   * передачи именно этому получателю (независимо от того, какая карта). См. `handoffCard`. */
  lastHandoffCycle: Record<string, number> = {};
  /** «План войны» (по прямому запросу) — один активный план на игрока, ключ `playerId`. См. `WarPlan`. */
  warPlans: Partial<Record<number, WarPlan>> = {};
  /** Кулдаун повторного создания «Плана войны» с тем же поводом/целью после того, как план был
   * добровольно снят из-за «закрывающегося окна возможностей» (§1.2, bot.ts: considerWarPlan) — ключ
   * `"${playerId}:${targetId}"`, значение — цикл, до которого (не включительно) создание плана с этой
   * ЖЕ целью заблокировано; без этого `findResourceShortageTarget`/`findExpansionTarget` пересоздали бы
   * тот же обречённый план на следующий же ход. */
  warPlanCooldowns: Record<string, number> = {};
  /** Постройка юнитов по зонам фронта (по прямому запросу — «зона напряжения/прифронтовая/тыл»,
   * bot.ts: `tryBuildUnitByZone`) — один общий круговой счётчик позиции в шаблоне зоны на пару
   * `"${playerId}:${tier}"` (tier — 1 Прифронтовая/2 Зона напряжения/3 Тыл; 0 Осаждённый город своего
   * шаблона не имеет), не на конкретный город: любой город игрока в этой зоне обслуживает ОДНУ общую
   * очередь категорий, независимо от того, в каком именно городе реально нашлось место построить. */
  warZoneBuildIndex: Record<string, number> = {};
  /** История «веса» игрока (`playerWeightOf`, valuation.ts) по последним циклам — окно
   * POWER_HISTORY_WINDOW записей, последняя = снимок текущего цикла. Нужна Отчаянию (§1.1) и
   * континуальному фактору «Баланс сил» (§5.1/§8.3, см. applyPowerBalanceFactors). */
  weightHistory: Partial<Record<number, number[]>> = {};
  /** Цикл, с которого вес игрока непрерывно держится ниже порога входа в Отчаяние (§1.1) — ключ
   * отсутствует, если порог сейчас не нарушен. Снимается при восстановлении выше порога выхода
   * (гистерезис — см. applyPowerBalanceFactors). */
  weakSinceCycle: Partial<Record<number, number>> = {};
  /** Живой флаг «Отчаяния» (§1.1, bot.ts: considerWarTargets) — персистентный, не пересчитывается на
   * лету при каждом чтении (иначе гистерезис входа/выхода не работал бы). См. `isDesperate`. */
  desperatePlayers = new Set<number>();
  /** «Зависшая война» (по прямому запросу §4.1) — сколько циклов ПОДРЯД мирное предложение playerId
   * игроку targetId не приводит к миру (отклонено или провисело без ответа) — ключ `"${playerId}:${targetId}"`.
   * Обнуляется/удаляется, как только между парой снова мир. См. bot.ts: considerPeaceOffers. */
  peaceOfferStreak: Record<string, number> = {};
  /** Цикл последнего инкремента `peaceOfferStreak` — `considerPeaceOffers` может вызываться несколько
   * раз за один ход (тот же guard-цикл, что и у considerWarPlan), без отметки один и тот же цикл
   * засчитывался бы несколько раз. */
  peaceOfferStreakCycle: Record<string, number> = {};
  /** Журнал военных потерь городов (§3.1/§2.1) — см. `CityLossRecord`. */
  recentCityLosses: CityLossRecord[] = [];
  /** Действующие формирования (§15.9а) — см. `Army`. */
  armies: Army[] = [];
  nextArmyId = 1;
  /** Персистентные пары кораблей (§15.9а) — см. `Fleet`. */
  fleets: Fleet[] = [];
  nextFleetId = 1;
  /** Очередь заявок на постройку армий, ключ `playerId` (§15.9а) — см. `ArmyBuildOrder`. */
  armyBuildQueue: Partial<Record<number, ArmyBuildOrder[]>> = {};
  nextArmyBuildOrderId = 1;
  pendingProposals: Proposal[] = [];
  nextProposalId = 1;
  pendingGlobalEvents: PendingGlobalEvent[] = [];
  nextGlobalEventId = 1;

  skippedTurn = new Set<number>();
  skipTurnReason: Partial<Record<number, "paradigm" | "religion">> = {};
  pendingSkipTurn: number | null = null;
  pendingSkipTurnReason: "paradigm" | "religion" | null = null;
  accessUsed = new Set<string>();
  productionUsedThisCycle = new Set<string>();
  conscriptionUsedThisCycle = new Set<number>();

  pendingRoute: PendingRoute | null = null;
  pendingTaxShortfall: PendingTaxShortfall | null = null;
  pendingCatastrophe: PendingCatastrophe | null = null;
  /** Предпросмотр хода AI (по прямому запросу — «прежде чем ходить подсвечивай какие карты куда
   * хочет сыграть AI») — заполняется bot.ts (`prepareNextAiPlanIfNeeded`) на клоне сессии, ничего
   * не меняя в этой; сам ход совершается только по явному действию "confirmAiTurn" (перехватывается
   * в wsServer.ts ДО обычного dispatch, не часть игровой логики). Не персистится через fromJSON —
   * после перезапуска сервера просто пересчитывается заново при следующем join/action. */
  pendingAiPlan: { playerId: number; steps: AiPlanStep[]; strategicPriority: StrategicPriority; warPlan?: PendingWarPlanInfo | null; borderThreat?: PendingBorderThreatInfo | null } | null = null;

  // rngSeed — публичное (не private) чтение: само значение уже публично через toJSON() (часть
  // SaveGameV1), weGoRound.ts использует его для отдельного, не завязанного на игровой RNG-поток
  // (rngCallCount) детерминированного порядка игроков раунда. rngFn/rngCallCount остаются private —
  // это мутируемое состояние генератора, трогать которое напрямую снаружи не должно ничего.
  rngSeed: number;
  private rngCallCount = 0;
  private rngFn: () => number;

  constructor(id: string, players: Player[], seed = Date.now() ^ (Math.random() * 0xffffffff), maxTurns = 60) {
    this.id = id;
    this.players = players;
    this.rngSeed = seed >>> 0;
    this.rngFn = mulberry32(this.rngSeed);
    this.maxTurns = maxTurns;
    this.turnsRemaining = maxTurns;

    for (const p of players) {
      this.spaceComponents[p.id] = 0;
      this.nuclearWeapons[p.id] = 0;
      this.researchedTechs[p.id] = new Set();
      this.playerParadigm[p.id] = null;
      this.playerReligion[p.id] = null;
      this.hands[p.id] = [];
      this.actionsLeft[p.id] = ACTIONS_PER_TURN;
      this.actionsTotal[p.id] = ACTIONS_PER_TURN;
      this.money[p.id] = 0;
      this.warehouse[p.id] = {};
      this.communismBonusHeld[p.id] = {};
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

  /** По прямому запросу — заселяемость решает КОЛИЧЕСТВО РЕСУРСОВ в регионе, не количество суши:
   * при подъёме уровня моря часть тайлов уходит под воду, и раньше жилой регион (генерировался с
   * ≥3 тайлами суши) мог упасть ниже этого порога и стать «незаселяемым», даже если оставшаяся суша
   * всё ещё несёт ресурс(ы) — регион явно ещё годен для города. Генерация карты (terrainGenerator.ts)
   * по-прежнему гарантирует ровно 20 регионов с ≥3 тайлами суши на старте — это ПОРОГ РАЗДАЧИ ресурсов,
   * не эта проверка; здесь же, во время партии, играет роль только фактическое наличие ресурса. */
  private isInhabitedRegion(rc: number, rr: number): boolean {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        if (this.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).resource) return true;
      }
    }
    return false;
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

  /** Выбор КОНКРЕТНОГО гекса под город внутри региона для AI (жетон в фазе расстановки —
   * `bot.ts: runAiPlacement`, и карта «Поселенец» — `bot.ts: tryFoundOrGrowCity`) — по прямому
   * запросу: если в регионе есть торговый ресурс (`category === "trade"`), углеводороды или
   * металлические руды — приоритет гексу с выходом к морю (хотя бы один сосед — морской тайл); среди
   * таких кандидатов (или среди всех, если морских соседей ни у одного нет) — холмы+лес, иначе просто
   * холмы, иначе равнина, иначе первый подходящий гекс региона вообще. Если в регионе таких ресурсов
   * нет — гекс с максимальной защитой местности (`computeFreshHexTerrainDefense`, без привязки к
   * конкретному юниту — своей территории/форта/дороги тут ещё нет, город не основан). Игрока (клик по
   * конкретному тайлу) НЕ касается — human-клик уже обрабатывается напрямую в `landTileForRegion` выше
   * (клик на валидный тайл используется как есть); это только для AI, который целится в регион, а не
   * в конкретный гекс. `null` — в регионе вообще нет пригодной для основания суши. */
  pickCitySiteInRegion(rc: number, rr: number): { col: number; row: number } | null {
    const candidates: { col: number; row: number }[] = [];
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = rc * REGION_SIZE_X + dx;
        const row = rr * REGION_SIZE_Y + dy;
        if (this.canFoundCityAt(col, row)) candidates.push({ col, row });
      }
    }
    if (!candidates.length) return null;

    let hasKeyResource = false;
    for (let dx = 0; dx < REGION_SIZE_X && !hasKeyResource; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y && !hasKeyResource; dy++) {
        const resource = this.doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).resource;
        if (!resource) continue;
        const meta = GameSession.RESOURCE_META.get(resource)!;
        if (meta.category === "trade" || resource === "hydrocarbons" || resource === "metalOre") hasKeyResource = true;
      }
    }

    if (!hasKeyResource) {
      let best = candidates[0];
      let bestScore = -1;
      for (const c of candidates) {
        const score = this.computeFreshHexTerrainDefense(c.col, c.row, { playerId: -1 });
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      return best;
    }

    const hasSeaAccess = (c: { col: number; row: number }) => this.hexNeighborsGameplay(c.col, c.row).some(([nc, nr]) => this.isSeaTile(nc, nr));
    const coastal = candidates.filter(hasSeaAccess);
    const pool = coastal.length ? coastal : candidates;
    const hillsAndForest = pool.filter((c) => {
      const tile = this.doc.get(c.col, c.row);
      return tile.terrain === "hills" && tile.forest;
    });
    if (hillsAndForest.length) return hillsAndForest[0];
    const hills = pool.filter((c) => this.doc.get(c.col, c.row).terrain === "hills");
    if (hills.length) return hills[0];
    const plains = pool.filter((c) => this.doc.get(c.col, c.row).terrain === "plains");
    if (plains.length) return plains[0];
    return pool[0];
  }

  /** По прямому запросу — живой баг-репорт «у игрока нет поселений после расстановки»: если все 3
   * жетона игрока не выиграли НИ ОДНОГО региона (биты более старшими/равными жетонами соперников,
   * см. `resolvePlacement` в placement.ts), он раньше оставался вообще без стартового города. Теперь
   * такому игроку город ставится в случайном ещё СВОБОДНОМ регионе — тем же набором проверок
   * жилости, что и у ручной постановки жетона (есть ресурс, есть суша не подо льдом, есть земная
   * пища), не занятом ни одним из уже разрешённых результатов торгов И не занятом другим таким же
   * игроком в этом же проходе. Гекс внутри региона — тем же `pickCitySiteInRegion`, что и для
   * AI-жетона/карты «Поселенец». Если подходящих свободных регионов физически не осталось (крайне
   * маленькая/плотно занятая карта) — игрок так и остаётся без города, как раньше. */
  private assignFallbackStartingCities(results: CityResult[]) {
    const missing = this.players.filter((p) => !results.some((r) => r.playerId === p.id));
    if (!missing.length) return;
    const occupied = new Set(results.map((r) => `${r.regionCol},${r.regionRow}`));
    const free: { rc: number; rr: number }[] = [];
    for (let rc = 0; rc < REGION_GRID_W; rc++) {
      for (let rr = 0; rr < REGION_GRID_H; rr++) {
        if (occupied.has(`${rc},${rr}`)) continue;
        if (!this.isInhabitedRegion(rc, rr)) continue;
        if (!this.regionHasFoundableTile(rc, rr)) continue;
        if (!this.regionHasLandFood(rc, rr)) continue;
        free.push({ rc, rr });
      }
    }
    for (const p of missing) {
      if (!free.length) break;
      const idx = Math.floor(this.rng() * free.length);
      const { rc, rr } = free.splice(idx, 1)[0];
      const site = this.pickCitySiteInRegion(rc, rr);
      if (!site) continue;
      results.push({ playerId: p.id, regionCol: rc, regionRow: rr, col: site.col, row: site.row, randomTiebreak: true });
    }
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
    if (!this.isInhabitedRegion(rc, rr)) return { ok: false, hint: "Города можно основать только в регионе хотя бы с одним ресурсом — попробуйте другой регион." };
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
    this.assignFallbackStartingCities(this.cityResults);
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
  /** Минимальная длительность войны в циклах (по прямому запросу) — см. `declareWar`/`resolveProposal`
   * (`Relation.noPeaceBeforeCycle`) и `bot.ts: considerPeaceOffers`. */
  static WAR_MIN_DURATION_CYCLES = 3;
  static WAREHOUSE_CAP = 6;
  static WAREHOUSE_CAP_WITH_SKLAD = 12;
  static MAX_ROUTE_HEXES = 12;
  /** По прямому запросу — «количество юнитов в городе ограничить двумя, разрешить им ходить
   * полноценно, оказывать поддержку, атаковать и стрелять»: раньше в городе мог стоять ЛЮБОЙ юнитов
   * (без предела), но командовать напрямую можно было только «головой очереди» (см. историю —
   * garrisonRank/cityGarrisonQueue/promoteGarrisonUnit, удалены этой правкой) — остальные считались
   * «резервом», не атаковали/не оборонялись/не поддерживали. Теперь вместо очереди — тот же лимит,
   * что и на ЛЮБОМ обычном гексе карты (`canEnterHex`, «максимум 2 юнита»), просто явно применённый
   * и к городским клеткам тоже (их раньше пропускали без проверки числа) — ОБА юнита в пределах этого
   * лимита полностью командуемы, никакого разделения на «активного» и «запасного» больше нет. */
  static CITY_GARRISON_CAP = 2;
  /** «Откуп даёт защиту» (по прямому уточнению — «сократить срок мира/перемирия до 3 циклов — это
   * когда игрок отдаёт ресурс по требованию, это даёт защиту от нападения на 3 цикла»): реально
   * выплаченная дань (`demandResource`/`demandMoney`, применяется в `applyProposalTerms`) ставит
   * паре тот же `Relation.truceUntilCycle`, что и обычное перемирие — `declareWar` его уже
   * проверяет, отдельного механизма не понадобилось. Уже действующее БОЛЕЕ ДОЛГОЕ перемирие не
   * укорачивается (берётся максимум из двух). */
  static TRIBUTE_PROTECTION_CYCLES = 3;
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
  /** Тот же приём, что и PARADIGM_META выше, только для соглашений (ТЗ 11.7) — портировано из
   * AGREEMENT_META (main.ts), только поле `tech`. [ИСПРАВЛЕНО, живой баг-репорт — «зелёный
   * предлагает Научное сотрудничество, хотя у людей эта функция недоступна без технологии»]:
   * раньше требование технологии было только клиентской подсказкой в композере предложения (человек
   * не мог даже нажать кнопку без неё) — сервер (`sendProposal`) вообще не проверял, так что бот
   * (шлёт `sendProposal` напрямую, в обход этого композера) мог предложить любое соглашение без
   * технологии вовсе, человек в той же ситуации — не мог. Теперь проверяется ЗДЕСЬ, одинаково для
   * всех — по технологии ОТПРАВИТЕЛЯ (`from`), как и было в клиентской подсказке. */
  private static AGREEMENT_META: Record<Agreement, { label: string; tech: string }> = {
    openBorders: { label: "Открытые границы", tech: "Письменность" },
    vassalage: { label: "Вассалитет", tech: "Феодализм" },
    mutualDefense: { label: "Совместная оборона", tech: "Кодекс законов" },
    tradeUnion: { label: "Торговый союз", tech: "Гильдии" },
    scienceCoop: { label: "Научное сотрудничество", tech: "Образование" },
    union: { label: "Союз", tech: "Коммунизм" },
  };

  private static UNIT_CATEGORY_LABEL: Record<UnitCategory, string> = {
    support: "Поддержка",
    ranged: "Артиллерия",
    mobile: "Мобильный",
    assault: "Штурмовой",
    defense: "Оборонительный",
    ship: "Корабль",
  };

  /** См. `GameLogEntry` — общая точка добавления записи в журнал партии. */
  private logEvent(text: string) {
    this.eventLog.push({ cycle: this.cyclesElapsed, text });
  }

  private playerName(id: number): string {
    return this.players.find((p) => p.id === id)?.name ?? `игрок ${id}`;
  }

  /** Человекочитаемое описание условий предложения (по прямому запросу — «лог с условиями») —
   * используется и при отправке, и при принятии/отказе (см. `sendProposal`/`resolveProposal`), чтобы
   * запись в журнале сразу называла, ЧТО именно предлагалось, а не только сам факт «было предложение». */
  private describeProposalTerms(terms: ProposalTerm[]): string {
    return terms
      .map((t) => {
        switch (t.kind) {
          case "agreement":
            return GameSession.AGREEMENT_META[t.agreement].label;
          case "peace":
            return `мир (перемирие на ${t.duration} цикл.)`;
          case "demandMoney":
            return `требует ${t.amount}💰`;
          case "offerMoney":
            return `предлагает ${t.amount}💰`;
          case "giveCity":
            return `отдаёт город (id ${t.cityId})`;
          case "demandCity":
            return `требует город (id ${t.cityId})`;
          case "demandResource":
            return `требует ${t.qty}× ${GameSession.RESOURCE_META.get(t.resource)?.label ?? t.resource}`;
          case "giveResource":
            return `отдаёт ${t.qty}× ${GameSession.RESOURCE_META.get(t.resource)?.label ?? t.resource}`;
          case "promiseNoSettle":
            return `обещание не селиться в регионе (${t.regionCol},${t.regionRow})`;
          case "promiseNoAttack":
            return "обещание не нападать";
          case "promiseNoEventCards":
            return "обещание не делиться картами событий";
          case "promiseGiveCardType":
            return `обещание отдать карту «${t.cardId}»`;
          case "promiseListResource":
            return `обещание выставить на биржу ${GameSession.RESOURCE_META.get(t.resource)?.label ?? t.resource}`;
          case "callToWar":
            return `призыв к войне против ${this.playerName(t.targetId)}`;
          case "jointAttack":
            return `совместное нападение на ${this.playerName(t.targetId)}`;
          case "breakTiesWith":
            return `разорвать связи с ${this.playerName(t.targetId)}`;
        }
      })
      .join(", ");
  }

  private resourceTileBlocked(col: number, row: number, ownerId: number): boolean {
    return this.units.some((u) => u.col === col && u.row === row && u.playerId !== ownerId && this.relationOf(u.playerId, ownerId).war);
  }

  /** «Истощение ресурсов» (доку см. `TileData.resourceBlocked`, `cataclysmResourceDepletion`) —
   * снимает блокировку с ОДНОГО перечёркнутого тайла нужного вида в регионе, если такой нашёлся.
   * Вызывается из `workerCollect`/`skladCollect` ПЕРЕД начислением ресурса на склад за эту запись:
   * если в регионе есть заблокированный тайл этого вида, добыча тратится на снятие блокировки (склад
   * не пополняется — «вместо добычи происходит восстановление добычи», по прямому запросу), иначе
   * добыча идёт как обычно. Слот лимита населения и стоимость (для Склада) при этом всё равно
   * расходуются — попытка добычи состоялась, просто её результат другой. */
  private restoreOneBlockedResourceHex(rc: number, rr: number, resource: ResourceId): boolean {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const col = rc * REGION_SIZE_X + dx;
        const row = rr * REGION_SIZE_Y + dy;
        const t = this.doc.get(col, row);
        if (t.resource === resource && t.resourceBlocked) {
          this.doc.set(col, row, { resourceBlocked: false });
          return true;
        }
      }
    }
    return false;
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
  /** [ИЗМЕНЕНО ПО ПРЯМОМУ ЗАПРОСУ] Раньше блокировала основание поселения только юнитом игрока, с
   * которым сейчас ВОЙНА — по прямому запросу («хочет построить поселение там, где нельзя — там
   * юниты другого игрока, правила запрещают стройку») правило шире: ЛЮБОЙ юнит ЛЮБОГО другого игрока
   * в регионе блокирует основание там, независимо от войны/мира — регион с чужими юнитами не считается
   * свободным для колонизации. */
  private regionHasForeignUnit(rc: number, rr: number, playerId: number): boolean {
    return this.units.some((u) => u.playerId !== playerId && Math.floor(u.col / REGION_SIZE_X) === rc && Math.floor(u.row / REGION_SIZE_Y) === rr);
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

  /** Отношения AI — фактор 3 (по прямому запросу, «юнит построен у моей границы −1») — общий хук на
   * ВСЕ 3 пути постройки нового юнита у города (buildUnitCard/призыв за деньги/useKazarma): у ВСЕХ
   * живых игроков, чей город примыкает к региону города постройки. */
  private applyUnitBuiltBorderFactor(playerId: number, city: { regionCol: number; regionRow: number }) {
    for (const p of this.players) {
      if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
      if (this.playerHasCityAdjacentTo(p.id, city.regionCol, city.regionRow)) this.adjustRelationScore(p.id, playerId, -1, "юнит построен у моей границы");
    }
  }

  /** Отношения AI — фактор 4 (по прямому запросу, «юнит убран у моей границы +1», зеркало фактора 3
   * выше) — «убран» здесь в смысле движения ПРОЧЬ от границы (постройку/распуск считает
   * applyUnitBuiltBorderFactor). Вызывается из commandUnit с регионом юнита ДО/ПОСЛЕ одного шага
   * приказа — многоцикличные приказы просто заходят сюда снова на каждом следующем шаге. */
  private applyUnitBorderMoveFactor(playerId: number, beforeRc: number, beforeRr: number, afterRc: number, afterRr: number) {
    if (beforeRc === afterRc && beforeRr === afterRr) return;
    for (const p of this.players) {
      if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
      const wasNear = this.playerHasCityAdjacentTo(p.id, beforeRc, beforeRr);
      const isNear = this.playerHasCityAdjacentTo(p.id, afterRc, afterRr);
      if (isNear && !wasNear) this.adjustRelationScore(p.id, playerId, -1, "юнит подошёл к моей границе");
      else if (wasNear && !isNear) this.adjustRelationScore(p.id, playerId, 1, "юнит отошёл от моей границы");
    }
  }

  /** Число карт в руке, которые СЧИТАЮТСЯ в лимит (HAND_SIZE/переполнение) — «Право прокладки
   * маршрута» (routeRight) явно исключено по прямому уточнению («не считается в лимит»). Бесплатный
   * «Рабочий» Монархии (freeMonarchy) — по прямому уточнению («иначе имбово со Складом») СЧИТАЕТСЯ
   * в лимит наравне с обычными картами: фактически сокращает лимит обычных карт с 7 до 6, пока
   * парадигма активна и карта лежит в руке. */
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
  /** Фашизм (по прямому запросу, заменяет прежний бонус «Воин строит сразу 2 юнита за ту же цену») —
   * 1 бесплатная карта «Воин» в руке, тот же приём и те же правила, что и grantMonarchyWorkerCards
   * выше (см. CardDef.freeFascism в cards.ts): выдаётся, только если такой карты сейчас в руке нет
   * (сыграна в прошлом цикле или парадигма только что принята) — ровно 1 штука на игрока за раз. */
  private grantFascismWarriorCards() {
    for (const p of this.players) {
      if (this.playerParadigm[p.id] !== "fascism") continue;
      if (this.hands[p.id].some((c) => c.freeFascism)) continue;
      this.hands[p.id].push(makeFascismWarriorCard());
    }
  }
  /** Парламентаризм (по прямому запросу — «сделай постоянную карту строителя как рабочий у
   * монархии») — тот же приём и те же правила, что и grantMonarchyWorkerCards/grantFascismWarriorCards
   * выше (см. CardDef.freeParliamentarism в cards.ts): выдаётся, только если такой карты сейчас в
   * руке нет (сыграна в прошлом цикле или парадигма только что принята) — ровно 1 штука на игрока
   * за раз. */
  private grantParliamentarismBuilderCards() {
    for (const p of this.players) {
      if (this.playerParadigm[p.id] !== "parliamentarism") continue;
      if (this.hands[p.id].some((c) => c.freeParliamentarism)) continue;
      this.hands[p.id].push(makeParliamentarismBuilderCard());
    }
  }
  /** [ИСПРАВЛЕНО, живой баг-репорт — «при смене парадигмы парламентаризм не исчезает строитель
   * какое-то время»] — grantMonarchyWorkerCards/grantFascismWarriorCards/grantParliamentarismBuilderCards
   * выше только ДОБАВЛЯЮТ бесплатную карту НОВОЙ парадигмы, но никогда не убирали бесплатную карту
   * СТАРОЙ, если та ещё лежала в руке неиграной на момент смены — freeParliamentarism/freeMonarchy/
   * freeFascism висели в руке до тех пор, пока игрок сам её не разыграет (см. consumeHandCard, где
   * такие карты просто исчезают, не уходя в колоду). Зовётся из adoptParadigm ДО granCards новой
   * парадигмы — снимает именно те бесплатные карты трёх видов, что не соответствуют вновь принятой
   * парадигме (не может задеть карту, которая только что выдана этим же вызовом, — та появляется
   * позже). Слоты рынка (shiftListingSlotsAfterRemoval) — на случай, хотя сами эти карты продать
   * нельзя (см. sellCard/handoffCard), другие карты в руке ПОСЛЕ снятой карты всё равно сдвигаются. */
  private discardStaleParadigmCards(playerId: number, activeParadigm: Paradigm) {
    const hand = this.hands[playerId];
    for (let i = hand.length - 1; i >= 0; i--) {
      const c = hand[i];
      const stale =
        (c.freeMonarchy && activeParadigm !== "monarchy") ||
        (c.freeFascism && activeParadigm !== "fascism") ||
        (c.freeParliamentarism && activeParadigm !== "parliamentarism");
      if (stale) {
        hand.splice(i, 1);
        this.shiftListingSlotsAfterRemoval(playerId, i);
      }
    }
  }

  /** По прямому запросу — сделать «Научное сотрудничество» реально действующим (было design-only):
   * раз за цикл (та же точка вызова, что и grantCommunismResourceIncome/grantMonarchyWorkerCards)
   * каждый участник действующего соглашения `scienceCoop` бесплатно (без карты/действия/ресурсов,
   * без бонуса первооткрывателя — techDiscoverer уже занят партнёром) получает те технологии из
   * своего же `availableResearchFor` (то есть уже коллективно доступные позиции веток — не любые
   * технологии партнёра целиком, эпохи не перескакиваются), которыми партнёр уже владеет, а этот
   * игрок ещё нет. Симметрично — если оба участника соглашения отстают друг от друга в разных
   * ветках, каждый подтягивает своё. */
  private grantScienceCoopTechSharing() {
    for (const p of this.players) {
      for (const other of this.players) {
        if (other.id === p.id) continue;
        if (!this.relationOf(p.id, other.id).agreements.has("scienceCoop")) continue;
        for (const tech of this.availableResearchFor(p.id)) {
          if (this.researchedTechs[other.id].has(tech.id) && !this.researchedTechs[p.id].has(tech.id)) {
            this.researchTech(p.id, tech.id);
          }
        }
      }
    }
  }

  /** Коммунизм (по прямому запросу — упрощение парадигмы, заменяет старый доступ ко всей торговой
   * сети через `ownRouteComponent`) — добываемые (`resourceIsExtractable`) типы РЕГИОНА СТОЛИЦЫ, плюс
   * (по отдельному прямому запросу — «дополнительно к столице выбирается город, столица остаётся
   * прежней») типы региона ВТОРОГО, отдельно выбранного города, если он выбран (см.
   * communismExtraCityId/chooseCommunismCity) — объединение множеств, не замена. Пересчитывается от
   * ТЕКУЩЕЙ столицы/выбранного города каждый раз (не фиксируется в момент выбора) — потеря любого из
   * них просто меняет набор типов, без отдельного состояния для отслеживания. Пусто, если игрок не
   * Коммунист или ещё без столицы. */
  private communismCapitalTypes(playerId: number): ResourceId[] {
    if (this.playerParadigm[playerId] !== "communism") return [];
    const capital = this.capitalCityOf(playerId);
    if (!capital) return [];
    const sources = [capital];
    const extraCityId = this.communismExtraCityId[playerId];
    if (extraCityId !== undefined) {
      const extra = this.cities.find((c) => c.id === extraCityId && c.playerId === playerId);
      if (extra) sources.push(extra);
    }
    const types = new Set<ResourceId>();
    for (const city of sources) for (const r of this.resourcesInRegion(city.regionCol, city.regionRow, playerId)) types.add(r);
    return [...types].filter((r) => this.resourceIsExtractable(playerId, r));
  }

  /** Коммунизм — выбор ВТОРОГО города для communismCapitalTypes (по прямому запросу, см. там же);
   * столица не трогается и продолжает участвовать сама по себе. Свободное административное решение —
   * без цены, без действия, без «революционного» пропуска хода (в отличие от смены самой парадигмы/
   * религии) и без ограничения на частоту смены — тот же дух, что и выбор цели у уже существующих
   * «бесплатных» решений (см. adoptParadigm/adoptReligion, тоже без actionsLeft-гейта). */
  chooseCommunismCity(playerId: number, cityId: number): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (this.playerParadigm[playerId] !== "communism") return { ok: false, hint: "Доступно только при парадигме «Коммунизм»." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Это не ваш город." };
    if (city.isCapital) return { ok: false, hint: "Столица и так уже участвует — выберите ДРУГОЙ свой город." };
    this.communismExtraCityId[playerId] = cityId;
    return { ok: true };
  }
  /** [ИСПРАВЛЕНО, по прямому уточнению] Раньше — виртуальный «бесконечный» остаток, не связанный с
   * циклами (число всегда 999 в кандидатах планировщика трат). По уточнению — «не в неограниченном
   * количестве, восполняются каждый цикл» — переделано на НАСТОЯЩЕЕ начисление, по одной РЕАЛЬНОЙ
   * защищённой единице каждого типа `communismCapitalTypes` ОДНОВРЕМЕННО, не более — НЕ накопление:
   * потраченная единица восполняется заново со следующего цикла, непотраченная просто остаётся той
   * же одной единицей (второй сверху НЕ добавляется, пока первая ещё лежит на складе). [ИСПРАВЛЕНО
   * ЕЩЁ РАЗ, живой баг-репорт — «при Коммунизме склад переполняется защищёнными ресурсами, и игрок
   * навсегда зависает, не может завершить ход»] — раньше эта функция ошибочно добавляла +1 БЕЗУСЛОВНО
   * каждый цикл, не проверяя, осталась ли с прошлого цикла уже непотраченная защищённая единица —
   * если игрок (особенно AI, которому нечем было воспользоваться именно этим видом) не тратил
   * конкретный вид несколько циклов подряд, защищённый остаток по нему рос без предела (2, 3, 4...),
   * пока не превышал `warehouseCapFor` — а та считает запас РОВНО под 1 защищённую единицу на тип
   * (`base + communismCapitalTypes(...).length`), не под растущий архив. Дальше `sellResource`
   * отклоняет ЛЮБУЮ попытку продать хоть одну из них (все они защищены), `endTurn`/`forceSellOverflow`
   * не находят, что продать — склад НАВСЕГДА выше лимита, ход невозможно завершить никогда. Теперь
   * начисление ПРОВЕРЯЕТ остаток: уже есть непотраченная защищённая единица этого типа — новая не
   * добавляется вовсе (склад и не растёт, и не переполняется); потрачена (или её никогда не было) —
   * добавляется ровно одна. */
  private grantCommunismResourceIncome() {
    for (const p of this.players) {
      const held = this.communismBonusHeld[p.id];
      for (const r of this.communismCapitalTypes(p.id)) {
        if (this.communismProtectedQty(p.id, r) >= 1) continue; // прошлая единица ещё не потрачена — ждём, не копим вторую
        this.addToWarehouse(p.id, r, 1);
        held[r] = 1;
      }
    }
  }
  /** Сколько единиц конкретного типа на складе игрока СЕЙЧАС защищены от продажи (см.
   * grantCommunismResourceIncome/sellResource) — не больше настоящего остатка: обычная трата
   * (стройка/юнит/исследование/...) не отличает защищённые единицы от обычных и просто уменьшает
   * общее число, так что если остаток упал ниже 1 (единица потрачена), защищать больше нечего —
   * `grantCommunismResourceIncome` увидит это в следующем цикле и восполнит заново. `held` (за счёт
   * исправленного начисления выше) сам по себе никогда не превышает 1 — `Math.min` здесь чисто
   * защитный, на случай рассинхронизации данных старого сейва. */
  private communismProtectedQty(playerId: number, resource: ResourceId): number {
    const held = this.communismBonusHeld[playerId]?.[resource] ?? 0;
    return Math.min(held, this.warehouse[playerId]?.[resource] ?? 0, 1);
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
      // Бесплатные «Рабочий»/«Воин» (freeMonarchy/freeFascism) не из колоды — попадание в this.deck
      // задвоило бы обычные копии навсегда; они просто исчезают, следующий цикл выдаст новую (см.
      // grantMonarchyWorkerCards/grantFascismWarriorCards).
      if (!card.freeMonarchy && !card.freeFascism && !card.freeEducation && !card.freeBuilding && !card.freeParliamentarism && !card.freeForestGrowth) {
        card.receivedFrom = undefined; // назад в колоду — история передачи (ТЗ 2.3) не переживает цикл
        this.deck.push(card);
      }
    }
    this.actionsLeft[playerId]--;
  }

  // === Spend-planning (доступ региона → склад → рынок), ТЗ 3.1/5.1/7.1 ==========================

  /** Промтовары (Фабрика) — универсальный ресурс-джокер (по прямому уточнению): засчитывается за ЛЮБОЙ
   * требуемый ресурс, КРОМЕ урана/углеводородов/электричества. Джокер не удваивается никакими техами
   * добычи (Гончарное дело/Навигация/Индустриализация/Гильдии) — это уже так само по себе,
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
  /** По прямому уточнению — Электричество эквивалентно Углеводородам во ВСЕХ ценах, где встречаются
   * Углеводороды (уже так у построек/исследований, см. useRynok/RESEARCH_COST_LINES), в том числе у
   * цены юнитов Э4-6 (ниже) — раньше там стояло reqSpecific именно на hydrocarbons, Электричество не
   * принималось совсем, хотя оба ресурса «энергетические» и по смыслу заменяют друг друга. */
  private static reqAnyOf(label: string, ids: ResourceId[]) {
    return { label, match: (r: ResourceId) => ids.includes(r) };
  }
  static EPOCH_UNIT_COST: Record<number, { money: number; resources: { label: string; match: (id: ResourceId) => boolean }[] }> = {
    1: { money: 0, resources: [GameSession.reqCategory("Еда", "food")] },
    2: { money: 0, resources: [GameSession.reqCategory("Еда", "food"), GameSession.reqSpecific("Металл", "metalOre")] },
    3: { money: 0, resources: [GameSession.reqSpecific("Металл", "metalOre"), GameSession.reqCategory("Торговый", "trade")] },
    4: { money: 2, resources: [GameSession.reqSpecific("Металл", "metalOre"), GameSession.reqAnyOf("Углеводороды/Электричество", ["hydrocarbons", "electricity"])] },
    5: { money: 1, resources: [GameSession.reqSpecific("Металл", "metalOre"), GameSession.reqAnyOf("Углеводороды/Электричество", ["hydrocarbons", "electricity"])] },
    6: { money: 1, resources: [GameSession.reqSpecific("Металл", "metalOre"), GameSession.reqAnyOf("Углеводороды/Электричество", ["hydrocarbons", "electricity"]), GameSession.reqSpecific("Редкоземельные", "rareEarth")] },
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
    const warehouseCandidates = (Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][])
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
        plan.push({ resource: mPick.resource!, source: "market", listingId: mPick.id, price: mPick.price });
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
        // «Банковское дело» — та же скидка 2💰 (не ниже 1), что и в buyListing, тот же принцип:
        // только для Мирового рынка, цена восстановления лота не затронута.
        const payPrice =
          listing.sellerId === WORLD_SELLER && this.techDiscoverer["Банковское дело"] === playerId ? Math.max(1, listing.price - 2) : listing.price;
        this.money[playerId] -= payPrice;
        if (listing.sellerId !== WORLD_SELLER) this.money[listing.sellerId] += payPrice;
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
    for (const [id, qty] of Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][]) {
      for (let i = 0; i < qty; i++) warehouseCandidates.push(id);
    }
    const marketCandidates = this.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId)
      .sort((a, b) => a.price - b.price);

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
        plan.push({ resource: l.resource!, source: "market", listingId: l.id, price: l.price });
        continue;
      }
      return null;
    }
    return plan;
  }

  /** Диагностика для человекочитаемых подписей плана хода бота (`bot.ts`, «не хватило X для карты
   * Y» — по прямому запросу «пиши, каких именно ресурсов не хватило») — то же самое разрешение
   * доступ→склад→рынок, что и planResourceSpend выше, но вместо остановки на первой непройденной
   * линии проходит ВСЕ и возвращает МЕТКИ (`label`) тех линий, что реально не закрылись. Не тратит
   * ничего и не строит план (`plan.push` нигде) — только диагностика, состояние партии не меняет. */
  private unresolvedRequirementLabels(playerId: number, source: { id: number; regionCol: number; regionRow: number }, reqs: { label: string; match: (id: ResourceId) => boolean }[]): string[] {
    let moneyBudget = this.money[playerId];
    let accessBudget = this.accessBudgetFor(source.id);
    const accessCandidates: { resource: ResourceId }[] = [];
    for (const r of new Set(this.resourcesInRegion(source.regionCol, source.regionRow, playerId))) {
      if (!this.resourceIsExtractable(playerId, r)) continue;
      if (this.accessUsed.has(`${source.id}:${r}`)) continue;
      accessCandidates.push({ resource: r });
    }
    const warehouseCandidates: ResourceId[] = [];
    for (const [id, qty] of Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][]) {
      for (let i = 0; i < qty; i++) warehouseCandidates.push(id);
    }
    const marketCandidates = this.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId)
      .sort((a, b) => a.price - b.price);

    const missing = new Set<string>();
    for (const req of reqs) {
      const match = this.matchWithJoker(req.match);
      const aIdx = accessBudget > 0 ? accessCandidates.findIndex((a) => match(a.resource)) : -1;
      if (aIdx >= 0) {
        accessBudget--;
        accessCandidates.splice(aIdx, 1);
        continue;
      }
      const wIdx = warehouseCandidates.findIndex((r) => match(r));
      if (wIdx >= 0) {
        warehouseCandidates.splice(wIdx, 1);
        continue;
      }
      const mIdx = marketCandidates.findIndex((l) => match(l.resource!) && l.price <= moneyBudget);
      if (mIdx >= 0) {
        moneyBudget -= marketCandidates[mIdx].price;
        marketCandidates.splice(mIdx, 1);
        continue;
      }
      missing.add(req.label);
    }
    return [...missing];
  }

  /** Те же строки цены, что реально применяет buildUnitCard/useKazarma для этой категории/эпохи
   * (с поправкой на «деревянную» цену Кораблей/Дальней атаки) — общий кусок для обеих обёрток ниже. */
  private unitCostLines(category: UnitCategory, epoch: number): { label: string; match: (id: ResourceId) => boolean }[] | undefined {
    const cost = GameSession.EPOCH_UNIT_COST[epoch];
    if (!cost) return undefined;
    const woodenOverride =
      category === "ship" ? GameSession.WOODEN_SHIP_RESOURCE_COST[epoch] : category === "ranged" ? GameSession.WOODEN_RANGED_RESOURCE_COST[epoch] : undefined;
    return woodenOverride ?? cost.resources;
  }

  /** Публичная обёртка `unresolvedRequirementLabels` для цены юнита (`bot.ts`, подпись «Рабочего»-
   * СРЕДСТВА для карты «Воин») — то же самое разрешение цены, что и buildUnitCard/useKazarma. */
  missingUnitCostLabels(playerId: number, cityId: number, category: UnitCategory, epoch: number): string[] {
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    const resources = this.unitCostLines(category, epoch);
    if (!city || !resources) return [];
    return this.unresolvedRequirementLabels(playerId, city, resources);
  }

  /** Какие ИМЕННО виды ресурсов (`ResourceId`, не просто метка) реально закрыли бы ещё не хватающие
   * линии цены юнита данной категории/эпохи — по прямому запросу («если для воина не хватает металла
   * и углеводородов, зачем рабочий добывает торговые и пищевые ресурсы») для прицельного выбора
   * города/типа «Рабочим»-СРЕДСТВОМ под «Воина» (`bot.ts: prioritizeCitiesForWorker`/
   * `needsResourceChoice`), вместо общего «разнообразие склада», не различающего нужный ресурс от
   * любого другого. */
  missingUnitCostResourceIds(playerId: number, cityId: number, category: UnitCategory, epoch: number): ResourceId[] {
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    const resources = this.unitCostLines(category, epoch);
    if (!city || !resources) return [];
    const missingLabels = new Set(this.unresolvedRequirementLabels(playerId, city, resources));
    if (!missingLabels.size) return [];
    const ids = new Set<ResourceId>();
    for (const req of resources) {
      if (!missingLabels.has(req.label)) continue;
      for (const r of RESOURCES) if (req.match(r.id)) ids.add(r.id);
    }
    return [...ids];
  }

  // === Города/Поселенец (ТЗ 3.1.1) ================================================================

  foundCity(playerId: number, slotIndex: number, clickCol: number, clickRow: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "settler" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Поселенец» недоступна в этом слоте." };
    const rc = Math.floor(clickCol / REGION_SIZE_X);
    const rr = Math.floor(clickRow / REGION_SIZE_Y);
    if (!this.isInhabitedRegion(rc, rr)) return { ok: false, hint: "Регион непригоден для поселения — нужен хотя бы 1 ресурс." };
    if (!this.regionHasFoundableTile(rc, rr)) return { ok: false, hint: "Вся суша этого региона подо льдом — город здесь поставить нельзя." };
    if (this.regionHasAnyCity(rc, rr)) return { ok: false, hint: "В этом регионе уже есть город — только 1 город на регион." };
    if (this.regionHasForeignUnit(rc, rr, playerId)) return { ok: false, hint: "В этом регионе стоит юнит другого игрока — сначала он должен уйти (или его нужно выбить), либо выберите другой регион." };
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

    // Отношения AI — фактор 1 (по прямому запросу, «занял регион у МОИХ границ −3») — у ВСЕХ живых
    // игроков (не только AI), у кого этот новый регион примыкает к одному из ИХ городов — та же
    // проверка, что и «регион должен примыкать к вашему» выше, просто для КАЖДОГО другого игрока.
    for (const p of this.players) {
      if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
      if (this.playerHasCityAdjacentTo(p.id, rc, rr)) this.adjustRelationScore(p.id, playerId, -3, "занял регион у моих границ");
    }
    // Отношения AI — нарушение обещания «не селиться в этом регионе» (promiseNoSettle) — сам факт
    // основания города в ЭТОМ ИМЕННО регионе кем-то, кто это обещал (`by === playerId`), независимо
    // от того, кто (и был ли живым) наблюдатель выше — не блокирует основание, только штраф пост-
    // фактум (по прямому запросу — «может быть нарушено, если планы изменились»).
    for (const promise of [...this.activePromises]) {
      if (promise.kind === "noSettle" && promise.by === playerId && promise.regionCol === rc && promise.regionRow === rr) this.breakPromise(promise);
    }
    // «Обещание не селиться» (ещё не принятое, только ВИСЯЩЕЕ предложение) — раз в регионе теперь
    // город (только 1 на регион, см. проверку выше), просить кого-либо не селиться там больше не
    // имеет смысла ФИЗИЧЕСКИ, независимо от того, кто именно основал город — сам проситель (по
    // прямому запросу, живой баг-репорт: «просит не селиться в регионе, который уже сам заселил») или
    // кто-то третий. Снимаем такие предложения целиком, а не оставляем висеть до решения получателя.
    this.pendingProposals = this.pendingProposals.filter((p) => !p.terms.some((t) => t.kind === "promiseNoSettle" && t.regionCol === rc && t.regionRow === rr));
    this.checkTerritorialVictory(playerId);
    return { ok: true, spent: plan };
  }

  /** Общая точка объявления победы (по прямому запросу — «дашборд результатов с типом победы») —
   * держит `winner`/`winnerType` синхронными на всех путях победы разом, не только territorial.
   * Не перезаписывает уже объявленную победу (первый победитель остаётся первым). */
  private declareVictory(playerId: number, type: string) {
    if (this.winner !== null) return;
    this.winner = playerId;
    this.winnerType = type;
    this.winners = [playerId];
  }

  /** Ничья по истечении лимита раундов — только режим WeGo (см. resolveCycleBoundary), хотсит/
   * «Против AI» лимит раундов не проверяют вовсе (turnsRemaining там чисто информационный счётчик,
   * как и было раньше). Победители — ВСЕ игроки, не потерявшие все города к этому моменту; кто уже
   * выбыл (eliminatedPlayers) — не входит, как явно требовалось. */
  private declareTurnLimitDraw() {
    if (this.winner !== null) return;
    const survivors = this.players.filter((p) => !this.eliminatedPlayers.has(p.id)).map((p) => p.id);
    this.winners = survivors;
    this.winner = survivors[0] ?? null;
    this.winnerType = `Ничья по лимиту партии — ${this.maxTurns} раундов`;
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
  private cityCapacityFor(playerId: number): number {
    return 1 + CITY_CAPACITY_TECHS.filter((t) => this.researchedTechs[playerId].has(t)).length;
  }
  growCity(playerId: number, slotIndex: number, cityIds: number[]): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "settler" || this.actionsLeft[playerId] <= 0) {
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
    const spent: SpendPlanItem[] = [];
    for (const city of targets) {
      const req = city.population;
      const plan = this.planFoodSpend(playerId, city, req, true);
      if (!plan) {
        replaceSet(this.accessUsed, [...accessSnapshot]);
        this.warehouse[playerId] = warehouseSnapshot;
        this.market = marketSnapshot;
        this.money[playerId] = moneySnapshot;
        return { ok: false, hint: this.explainFoodShortfall(city, req, true) };
      }
      this.commitSpend(playerId, plan);
      spent.push(...plan);
      city.population++;
    }
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true, spent };
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
    // Живой баг-репорт: «Оранжевый хочет посадить лес в 12,12, но там город» — клетка ЛЮБОГО города
    // (терраин под ним по-прежнему Равнина/Холмы, а лес там нулевой после основания, см.
    // clearForestUnderCity, так что оба условия ниже молча пропускали её).
    if (this.cityAt(clickCol, clickRow)) return { ok: false, hint: "На клетке города лес не сажают." };
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
    return { ok: true, spent: plan };
  }

  /** Розыгрыш бесплатной карты «Рост леса» — эндгейм-бонус «Учёного» (по прямому запросу, см.
   * cards.ts CardDef.freeForestGrowth и GameSession.useScientistEndgameEffect) — тот же выбор гекса,
   * что и обычная посадка plantForest выше, но БЕЗ цены (ни ресурсов, ни действия) и БЕЗ ограничения
   * `actionsLeft > 0`, тем же приёмом, что и playFreeEducationCard/playFreeBuildingCard. Карта
   * одноразовая (выдаются сразу 2 штуки, каждая расходуется отдельно): успешный розыгрыш просто
   * убирает её из руки напрямую (не consumeHandCard). «Зелёная повестка» ООН по-прежнему удваивает
   * эффект, тем же приёмом, что и у обычной посадки — это правило про сам мир, не про оплату. */
  plantFreeForest(playerId: number, slotIndex: number, clickCol: number, clickRow: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || !card.freeForestGrowth) return { ok: false, hint: "В этом слоте нет бесплатной карты «Рост леса»." };
    const rc = Math.floor(clickCol / REGION_SIZE_X);
    const rr = Math.floor(clickRow / REGION_SIZE_Y);
    const city = this.cityAtRegion(rc, rr);
    if (!city || city.playerId !== playerId) return { ok: false, hint: "Сажать лес можно только на своей территории — в регионе со своим городом." };
    if (this.cityAt(clickCol, clickRow)) return { ok: false, hint: "На клетке города лес не сажают." };
    const tile = this.doc.get(clickCol, clickRow);
    if (!TERRAIN_BY_ID[tile.terrain].canHaveForest || tile.forest) return { ok: false, hint: "Здесь нельзя посадить лес — нужна Равнина или Холмы без леса." };
    this.hands[playerId].splice(slotIndex, 1);
    this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
    this.doc.set(clickCol, clickRow, { forest: true });
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

  /** «Рост леса», третье применение — по прямому запросу, доступно только игрокам с «Генная
   * инженерия»: превращает клетку Пустыни на своей территории в Равнину за 2 пищевых ресурса (доступ
   * выбранного своего города → склад → рынок). Тот же card+action расход, что и у обычной посадки
   * леса — альтернативное применение той же карты, не отдельная карта. */
  convertDesertToPlains(playerId: number, slotIndex: number, cityId: number, clickCol: number, clickRow: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "forestGrowth" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Рост леса» недоступна в этом слоте." };
    if (!this.researchedTechs[playerId].has("Генная инженерия")) return { ok: false, hint: "Нужна технология «Генная инженерия»." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Оплатить можно только через свой город." };
    const rc = Math.floor(clickCol / REGION_SIZE_X);
    const rr = Math.floor(clickRow / REGION_SIZE_Y);
    const targetCity = this.cityAtRegion(rc, rr);
    if (!targetCity || targetCity.playerId !== playerId) return { ok: false, hint: "Превращать можно только на своей территории — в регионе со своим городом." };
    if (this.doc.get(clickCol, clickRow).terrain !== "desert") return { ok: false, hint: "Это не Пустыня." };
    const plan = this.planBuildingSpend(playerId, city, [{ kind: "category", category: "food", count: 2 }]);
    if (!plan) return { ok: false, hint: "Не хватает 2 пищевых ресурсов — ни в регионе города, ни на складе, ни на рынке." };
    this.commitSpend(playerId, plan);
    this.doc.set(clickCol, clickRow, { terrain: "plains" });
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true, spent: plan };
  }

  /** Рабочий, альтернативное применение — по прямому запросу, доступно только с «Геологоразведка»
   * (перенесено сюда из «Индустриализация» и обобщено с «только Редкоземельные» на любой стратегический
   * ресурс на выбор игрока): вместо сбора доступа региона добывает 1 единицу выбранного стратегического
   * ресурса из клетки Равнины БЕЗ ресурса на своей территории, необратимо превращая её в Пустыню (тот
   * же приём, что и природная деградация региона, см. cascadeLastForestLoss/degradeForestOrLand —
   * только направленно, по выбору игрока, а не случайно, и без предварительной вырубки леса как
   * условия). Тот же card+action расход, что у обычного сбора Рабочим — альтернативное применение той
   * же карты, не отдельная карта. */
  mineStrategicResource(playerId: number, slotIndex: number, col: number, row: number, resource: ResourceId): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "worker" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Рабочий» недоступна в этом слоте." };
    // «Геологоразведка» — ЕДИНСТВЕННАЯ технология, открывающая добычу любого ресурса из пула ниже
    // (по прямому уточнению — «убирай из Индустриализации, пусть будет только в Геологоразведке»;
    // ранее рассматривался (и был на короткое время реализован) альтернативный путь через
    // «Индустриализация» специально для Редкоземельных — снят по прямому запросу, нет смысла
    // держать в коде и справочнике отменённую логику).
    if (!this.researchedTechs[playerId].has("Геологоразведка")) {
      return { ok: false, hint: "Нужна технология «Геологоразведка»." };
    }
    if (!GameSession.GEO_SURVEY_RESOURCE_POOL.includes(resource)) return { ok: false, hint: "Недопустимый тип ресурса." };
    const rc = Math.floor(col / REGION_SIZE_X);
    const rr = Math.floor(row / REGION_SIZE_Y);
    const city = this.cityAtRegion(rc, rr);
    if (!city || city.playerId !== playerId) return { ok: false, hint: "Добывать можно только на своей территории — в регионе со своим городом." };
    const tile = this.doc.get(col, row);
    if (tile.terrain !== "plains") return { ok: false, hint: "Стратегический ресурс можно добыть только из Равнины." };
    if (tile.resource) return { ok: false, hint: "На этом гексе уже есть ресурс." };
    if (tile.forest) return { ok: false, hint: "Здесь растёт лес — сначала сведите его (карта «Строитель»)." };
    this.doc.set(col, row, { terrain: "desert", resource: undefined });
    this.addToWarehouse(playerId, resource, 1);
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true, hint: `Равнина опустынена — добыта 1 единица (${GameSession.RESOURCE_META.get(resource)?.label ?? resource}).` };
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
  /** Возвращает текст + один затронутый гекс для оповещения о глобальном событии (см.
   * resolveHandOverflowDiscard/pendingGlobalEvents) — сам эффект может задеть ДВА гекса (лёд и
   * пустыня независимо), но для одной общей метки на карте достаточно любого из них; берём последний
   * реально применённый (упрощение того же рода, что и остальные «не расписано по шагам» места этого
   * блока). */
  private cataclysmIceMelt(): { text: string; hex?: { col: number; row: number } } {
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
    let hex: { col: number; row: number } | undefined;
    if (iceCandidates.length) {
      const pick = iceCandidates[Math.floor(this.rng() * iceCandidates.length)];
      hex = { col: pick.col, row: pick.row };
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
      hex = { col: pick.col, row: pick.row };
      this.sinkTileUnderwater(pick.col, pick.row);
      parts.push("гекс пустыни ушёл под воду вместе со всем, что на нём было");
    } else parts.push("пустыни на карте не осталось — тонуть нечему");
    return { text: parts.join("; ") + ".", hex };
  }

  /** 2. Извержение вулкана — случайная НЕвулканическая Гора становится вулканом (оверлей, см.
   * mapDoc.ts `volcano`): ресурс снимается, гекс непроходим (`unitPassable`). Гор без вулкана не
   * осталось — случайные Холмы становятся новыми Горами (могут стать вулканом в будущем). */
  private cataclysmVolcano(): { text: string; hex?: { col: number; row: number } } {
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
      return { text: "гора превратилась в вулкан — ресурс уничтожен, гекс непроходим.", hex: pick };
    }
    const hillsCandidates: { col: number; row: number }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        if (this.doc.get(col, row).terrain === "hills") hillsCandidates.push({ col, row });
      }
    }
    if (!hillsCandidates.length) return { text: "гор и холмов на карте не осталось — извергаться нечему." };
    const pick = hillsCandidates[Math.floor(this.rng() * hillsCandidates.length)];
    this.doc.set(pick.col, pick.row, { terrain: "mountains", forest: false });
    return { text: "гор без вулкана не осталось — случайные холмы превратились в новые горы.", hex: pick };
  }

  /** 3. Деградация — случайный гекс суши: лес есть → лес исчезает; леса нет → рельеф деградирует на
   * 1 ступень по цепочке Горы → Холмы → Равнина → Пустыня → Море (затопление — как «Таяние льдов»,
   * см. `sinkTileUnderwater`). Тундра в цепочку не входит (не уточнено на своём шаге) — эффекта нет. */
  private cataclysmDegradation(): { text: string; hex?: { col: number; row: number } } {
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const candidates: { col: number; row: number }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        if (this.isLandTile(col, row)) candidates.push({ col, row });
      }
    }
    if (!candidates.length) return { text: "суши на карте не осталось — деградировать нечего." };
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    const t = this.doc.get(pick.col, pick.row);
    if (t.forest) {
      this.doc.set(pick.col, pick.row, { forest: false });
      return { text: "лес на случайном гексе исчез.", hex: pick };
    }
    const next = GameSession.DEGRADE_CHAIN[t.terrain];
    if (!next) return { text: "выпавший гекс не деградирует по этой цепочке — эффекта нет.", hex: pick };
    if (next === "ocean") {
      this.sinkTileUnderwater(pick.col, pick.row);
      return { text: "гекс пустыни затоплен вместе со всем, что на нём было.", hex: pick };
    }
    const hadResource = t.resource;
    this.doc.set(pick.col, pick.row, { terrain: next, resource: undefined, volcano: false });
    return {
      text: `гекс деградировал: ${TERRAIN_BY_ID[t.terrain].label} → ${TERRAIN_BY_ID[next].label}${hadResource ? `, ресурс «${GameSession.RESOURCE_META.get(hadResource)!.label}» исчез` : ""}.`,
      hex: pick,
    };
  }

  /** 4. Пандемия — случайный город ЛЮБОГО игрока теряет 1 населения, не ниже 1 (не убивает город
   * сама по себе — отдельно от `applyDiscardPopulationLoss`, у которой нижней границы нет). */
  private cataclysmPandemic(): { text: string; hex?: { col: number; row: number } } {
    if (!this.cities.length) return { text: "городов на карте нет — эпидемии некого поразить." };
    const pick = this.cities[Math.floor(this.rng() * this.cities.length)];
    const hex = { col: pick.col, row: pick.row };
    if (pick.population <= 1) return { text: "выпавший город уже на минимуме населения — эффекта нет.", hex };
    pick.population -= 1;
    const owner = this.players.find((p) => p.id === pick.playerId);
    return { text: `город игрока «${owner?.name ?? pick.playerId}» теряет 1 населения (пандемия).`, hex };
  }

  /** 5. Истощение ресурсов — 1 случайный ресурс (конкретный экземпляр на тайле, не весь тип) БЛОКИРУЕТСЯ
   * (не исчезает — по прямому запросу, см. доку `TileData.resourceBlocked`): уже заблокированные
   * тайлы не попадают в кандидаты повторно (блокировать нечего уточнять дважды). */
  private cataclysmResourceDepletion(): { text: string; hex?: { col: number; row: number } } {
    const width = this.doc.tiles.length;
    const height = this.doc.tiles[0].length;
    const candidates: { col: number; row: number; resource: ResourceId }[] = [];
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        const t = this.doc.get(col, row);
        if (t.resource && !t.resourceBlocked) candidates.push({ col, row, resource: t.resource });
      }
    }
    if (!candidates.length) return { text: "незаблокированных ресурсов на карте не осталось — истощать нечего." };
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    this.doc.set(pick.col, pick.row, { resourceBlocked: true });
    return {
      text: `ресурс «${GameSession.RESOURCE_META.get(pick.resource)!.label}» заблокирован (перечёркнут) — добыча временно недоступна, первая попытка добыть его снимет блокировку вместо единицы на склад.`,
      hex: { col: pick.col, row: pick.row },
    };
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
        return this.cataclysmIceMelt();
      case "volcano":
        return this.cataclysmVolcano();
      case "degradation":
        return this.cataclysmDegradation();
      case "pandemic":
        return this.cataclysmPandemic();
      case "resourceDepletion":
        return this.cataclysmResourceDepletion();
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
  private resolveCataclysmBatch(playerId: number): { log: string[]; earthquakeHexes: { col: number; row: number }[]; allHexes: { col: number; row: number }[] } {
    const epoch = this.playerEpoch(playerId);
    const rolls: (typeof GameSession.CATACLYSM_TYPES)[number][] = [];
    for (let i = 0; i < epoch; i++) {
      rolls.push(GameSession.CATACLYSM_TYPES[Math.floor(this.rng() * GameSession.CATACLYSM_TYPES.length)]);
    }
    const occurrences = new Map<(typeof GameSession.CATACLYSM_TYPES)[number], number>();
    for (const t of rolls) occurrences.set(t, (occurrences.get(t) ?? 0) + 1);
    const log: string[] = [];
    // earthquakeHexes — только землетрясения (main.ts проигрывает по ним тряску, playEarthquakeAnimation,
    // прежнее поведение не трогаем); allHexes — ВСЕ затронутые гексы любого из 6 видов катаклизма, для
    // оповещения о глобальном событии (см. resolveHandOverflowDiscard/pendingGlobalEvents) — иначе 5 из
    // 6 видов катаклизма вообще никак не подсвечивались бы игрокам на карте.
    const earthquakeHexes: { col: number; row: number }[] = [];
    const allHexes: { col: number; row: number }[] = [];
    for (const [type, count] of occurrences) {
      const magnitude = epoch * count;
      const lines: string[] = [];
      for (let i = 0; i < magnitude; i++) {
        const result = this.applyOneCataclysm(type);
        lines.push(result.text);
        if (result.hex) {
          if (type === "earthquake") earthquakeHexes.push(result.hex);
          allHexes.push(result.hex);
        }
      }
      log.push(`${GameSession.CATACLYSM_LABEL[type]} ×${count} (магнитуда ${magnitude}): ${lines.join(" ")}`);
    }
    return { log, earthquakeHexes, allHexes };
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

  /** Нераспределённые по лимиту населения кандидаты — общий источник и для «Рабочего»
   * (`workerCollect`, бесплатно), и для Склада (`skladCollect`, платно — 1💰 за единицу, по прямому
   * запросу — «Склад должен работать точно как Рабочий, на выбор, а не по порядку сканирования
   * тайлов» — раньше у Склада был свой, более примитивный путь, `collectibleResourcesIn`, молча
   * обрезанный лимитом населения В ПОРЯДКЕ СКАНИРОВАНИЯ тайлов региона, без права выбора; удалён).
   * НЕ применяет лимит населения сам (это раньше молча делал `resourcesInRegion`'s capToCity, в
   * порядке сканирования тайлов региона — из-за чего, например, морские ресурсы могли не попасть в
   * добычу просто потому, что земные раньше встретились при сканировании, а не из-за нехватки
   * технологии). Уже добытые в этом цикле СЛОТЫ (alreadyUsed) бюджета не расходуют — по одной записи
   * на КАЖДЫЙ слот (см. maxHarvestsOf/harvestsUsed): обычный тип отдаёт 1 запись, удвоенный
   * технологией — 2 (одна уже занятая + одна ещё свободная, либо обе свободные, либо обе уже заняты
   * — смотря сколько раз его уже добывали в этом цикле). */
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

  /** Только для превью (по прямому запросу — «нужно стремиться к разнообразию ресурсов на складе,
   * зачем добывать лес, которого и так уже 3»): какие НОВЫЕ (ещё не добытые в этом цикле) типы
   * ресурса реально добудет `workerCollect` в этом городе прямо сейчас — без побочных эффектов, не
   * тратит карту/действие. `bot.ts` использует это, чтобы решить, стоит ли вообще играть «Рабочего»
   * здесь, ДО того как дёрнуть настоящий workerCollect (который при малом числе вариантов добывает
   * молча, без возможности передумать после факта — см. комментарий там). */
  harvestableResourcesFor(playerId: number, cityId: number): ResourceId[] {
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return [];
    // Бюджет города (лимит населения) — по прямому запросу («второй Рабочий на тот же город с
    // населением 1 всё равно что-то показывал добываемым») — `uncappedCollectibleCandidatesIn`
    // сознательно игнорирует этот лимит (он для другого — сырой список кандидатов на выбор), но
    // ПРЕВЬЮ обязано его учитывать, иначе оно и после исчерпания бюджета этим же циклом продолжает
    // показывать «доступные» типы, хотя реальный workerCollect ими уже не даст воспользоваться.
    if (Math.max(0, city.population - this.accessTypesUsedThisCycle(city.id)) <= 0) return [];
    return this.uncappedCollectibleCandidatesIn(playerId, city)
      .filter((c) => !c.alreadyUsed)
      .map((c) => c.resource);
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

    // [ИСПРАВЛЕНО, живой баг-репорт — «AI собирал ресурс, но он не поступил на склад»] Раньше эта
    // проверка отсутствовала: если в регионе города вообще нечего собирать (нет доступных по
    // технологии ресурсов, либо всё уже добыто в этом цикле), `collected` получался пустым, но карта
    // и действие всё равно списывались, а `ok:true` создавал впечатление успешного сбора — притом что
    // склад не менялся ни на единицу. Теперь в этом случае карта не разыгрывается вовсе. [ИСПРАВЛЕНО
    // ЕЩЁ РАЗ, живой баг-репорт — «сыграл Рабочего дважды на город с населением 1, второй раз явно
    // не должен был ничего добыть»]: одной пустоты `collected` было недостаточно — `collected` может
    // быть НЕ пустым, но целиком состоять из УЖЕ добытых в этом цикле слотов (`alreadyUsed: true`,
    // см. uncappedCollectibleCandidatesIn — они попадают в `collected` «бесплатным подтверждением»
    // наравне со свежими, по конструкции; ниже они больше не зачисляются на склад повторно, но карта
    // без этой проверки всё равно сыграла бы «успешно», ничего не изменив). */
    if (!collected.some((c) => !c.alreadyUsed)) {
      return { ok: false, hint: "В регионе этого города нечего собирать нового — нет доступных по технологии ресурсов, или всё уже добыто в этом цикле." };
    }

    // [ИСПРАВЛЕНО, живой баг-репорт — «второй Рабочий на тот же город всё равно что-то добыл, хотя
    // лимит населения уже исчерпан первым»] — `collected` может содержать уже добытые в этом цикле
    // слоты (alreadyUsed: true, см. выше) наравне со свежими; раньше склад пополнялся БЕЗУСЛОВНО для
    // каждой записи `collected`, из-за чего повторный вызов (второй «Рабочий», либо Склад после
    // «Рабочего» на тот же тип) молча удваивал/утраивал уже полученный ресурс без каких-либо новых
    // затрат — эксплойт, который можно было повторять сколько угодно раз подряд. Теперь склад
    // пополняется ТОЛЬКО за реально НОВЫЕ добычи этого вызова — уже занятые слоты лишь «бесплатно
    // подтверждаются» (не мешают действию пройти), но больше не дают повторную единицу ресурса.
    for (const { resource, alreadyUsed: wasUsed } of collected) {
      if (wasUsed) continue;
      this.markHarvestUsedOnce(city.id, resource);
      // «Истощение ресурсов» — если в регионе есть заблокированный тайл этого вида, добыча снимает
      // блокировку вместо начисления единицы (см. restoreOneBlockedResourceHex/TileData.resourceBlocked).
      if (this.restoreOneBlockedResourceHex(city.regionCol, city.regionRow, resource)) continue;
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
    return { ok: true, hint: cascadeHint ?? undefined, spent: plan };
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

  /** Добор карты с колоды за 1 действие — по прямому запросу («на случай когда уже нет карт на руке
   * а действия ещё есть»), доступно КЛИКОМ ПО КОЛОДЕ, только пока рука ПОЛНОСТЬЮ пуста (`hand.length
   * === 0`, буквально «нет карт на руке» — не считанный размер без бесплатных карт парадигм, а
   * реально ни одной карты вообще). Колода — общая очередь без отдельной колоды сброса (карты
   * возвращаются в её хвост при розыгрыше/сбросе, см. `consumeHandCard`) — если она закончилась,
   * взять просто нечего; хинт явно это называет, клиент показывает его в окне подсказок (тем же
   * путём, что и любой другой отказ действия). */
  drawCardFromDeck(playerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Действий не осталось в этом ходу." };
    if (this.hands[playerId].length > 0) return { ok: false, hint: "Добор с колоды доступен, только пока на руке совсем нет карт." };
    const card = this.deck.shift();
    if (!card) return { ok: false, hint: "Колода пуста — брать больше неоткуда." };
    this.hands[playerId].push(card);
    this.actionsLeft[playerId]--;
    return { ok: true, hint: `Взята карта «${card.label}».` };
  }

  /** Склад's paid alternative to «Рабочий» — портирован из trySkladCollect. No card/hand slot — costs
   * 1 действие + 1💰 per unit collected.
   *
   * [ИСПРАВЛЕНО, живой баг-репорт — «Склад собирает ресурсы по порядку, а не на выбор, как
   * Рабочий»] — раньше использовал `collectibleResourcesIn` (порядок сканирования тайлов региона,
   * молча обрезанный лимитом населения — то, что попало в бюджет ПЕРВЫМ по порядку тайлов, то и
   * добыто, без права игрока выбрать другое) вместо `uncappedCollectibleCandidatesIn` — того же
   * источника кандидатов, что и `workerCollect`. Теперь Склад — ТОЧНО тот же выбор, что у «Рабочего»
   * (включая пищевые виды наравне со всеми остальными — они тоже полноценные кандидаты, никак не
   * исключены): типов больше, чем позволяет бюджет населения города — `needsResourceChoice` с тем же
   * форматом, что у `workerCollect` (клиент использует ту же модалку выбора); отличие от «Рабочего» —
   * только в цене (1💰 за каждую НОВУЮ единицу вместо бесплатно) и в отсутствии карты/слота. */
  skladCollect(playerId: number, cityId: number, chosenTypes?: ResourceId[]): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "sklad", playerId)) return { ok: false, hint: "У вас нет Склада." };
    const cycleKey = `sklad:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Склад уже использован в этом цикле — снова можно только со следующего." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Можно добывать только в своих городах." };

    const candidates = this.uncappedCollectibleCandidatesIn(playerId, city);
    const alreadyUsed = candidates.filter((c) => c.alreadyUsed);
    const fresh = candidates.filter((c) => !c.alreadyUsed);
    const budget = Math.max(0, city.population - this.accessTypesUsedThisCycle(city.id));

    let collected: { resource: ResourceId; alreadyUsed: boolean }[];
    if (fresh.length <= budget) {
      collected = candidates;
    } else if (budget <= 0) {
      collected = alreadyUsed;
    } else if (!chosenTypes) {
      return {
        ok: false,
        hint: `В регионе больше новых видов/добыч ресурсов (${fresh.length}), чем позволяет население города (${budget}) — выберите, какие добыть.`,
        needsResourceChoice: {
          cityId,
          budget,
          options: fresh.map((c) => c.resource),
          population: city.population,
          usedThisCycle: this.accessTypesUsedThisCycle(city.id),
        },
      };
    } else {
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

    // [ИСПРАВЛЕНО, тот же живой баг-репорт, что и у workerCollect выше — «повторный сбор на тот же
    // город удваивал уже полученный ресурс»]: `collected` может содержать уже добытые в этом цикле
    // слоты (`alreadyUsed: true` — «бесплатное подтверждение», не расходует бюджет населения) наравне
    // со свежими; раньше за них и деньги списывались, и склад пополнялся ПОВТОРНО, хотя ничего нового
    // не добывалось. Теперь считаются/зачисляются только реально НОВЫЕ записи; если новых нет вовсе —
    // действие недоступно.
    const freshCollected = collected.filter((c) => !c.alreadyUsed);
    if (!freshCollected.length) return { ok: false, hint: "В этом регионе сейчас нечего добывать нового — либо всё уже добыто в этом цикле, либо не хватает технологии добычи." };
    // 1💰 за каждую НОВУЮ запись (= единицу) — удвоенный технологией тип считается как 2 отдельные
    // единицы по 1💰 каждая, ровно по факту добытых единиц (см. extractionMultiplier выше).
    const totalCost = freshCollected.length;
    if (this.money[playerId] < totalCost) return { ok: false, hint: `Не хватает денег: нужно ${totalCost} 💰 (по 1 за каждую добытую единицу).` };
    this.money[playerId] -= totalCost;
    for (const { resource } of freshCollected) {
      this.markHarvestUsedOnce(city.id, resource);
      // «Истощение ресурсов» — та же логика, что и в workerCollect выше (доплата за попытку остаётся,
      // но склад не пополняется — заблокированный тайл просто разблокировался).
      if (this.restoreOneBlockedResourceHex(city.regionCol, city.regionRow, resource)) continue;
      this.addToWarehouse(playerId, resource, 1);
    }
    this.spendBuildingAction(playerId);
    this.productionUsedThisCycle.add(cycleKey);
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
  /** Маршрут «заблокирован в войне» (по прямому запросу) — на любом гексе его пути стоит юнит,
   * воюющий с ВЛАДЕЛЬЦЕМ маршрута (r.playerId, не с обоими городами-концами — маршрут принадлежит
   * тому, кто его проложил). Заблокированный маршрут целиком выпадает из графа узлов ниже — не
   * считается ни для дохода торговой сети (tradeNetworkOf), ни для контакта биржи/дипломатии
   * (hasRouteNetworkContactWith) — та же физическая связь, тот же разрыв. */
  private isRouteBlocked(r: TradeRoute): boolean {
    return r.path.some((hex) =>
      this.units.some((u) => u.col === hex.col && u.row === hex.row && u.playerId !== r.playerId && this.relationOf(u.playerId, r.playerId).war)
    );
  }

  /** Граф городов-узлов по ДЕЙСТВУЮЩИМ (не заблокированным) торговым маршрутам — общий первый шаг
   * для tradeNetworkOf (доход Торговца/Рынка, есть доп. фильтр по tradeUnion при переходе между
   * игроками) и hasRouteNetworkContactWith (контакт биржи/дипломатии — по прямому запросу, БЕЗ
   * этого доп. фильтра: сам факт физически проложенного маршрута между городами двух игроков уже
   * означает «в одной транспортной сети», отдельного соглашения для этого не требуется). */
  private routeGraphAdjacency(): Map<number, number[]> {
    const adjacency = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a)!.push(b);
    };
    for (const r of this.tradeRoutes) {
      if (this.isRouteBlocked(r)) continue;
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
    return adjacency;
  }

  /** [ИСПРАВЛЕНО, по прямому уточнению — «за каждый маршрут другого игрока, используемый в сети,
   * ему в казну 1 ед. за счёт того, кто сыграл карту торговца»] — толл считается ЗА КАЖДЫЙ
   * использованный маршрут ЧУЖОГО владельца (`TradeRoute.playerId`, маршрут может принадлежать не
   * тому игроку, чьи города он соединяет — см. «Перенаправить путь»), не один раз за КАЖДОГО
   * отдельного владельца города сети. Если у одного игрока в сети окажется несколько СВОИХ
   * маршрутов — он получает толл за КАЖДЫЙ из них (`tollRouteOwners` — плоский список, с
   * повторами, не `Set`). Маршрут считается «использованным», если он не заблокирован войной и ОБА
   * его конца входят в достигнутую BFS сеть городов (та же проверка, что уже применяется чуть ниже
   * для перехвата рейдером — `networkIds.has(fromCityId) && networkIds.has(toCityId)`). */
  private tradeNetworkOf(clickedCity: City): { cities: City[]; tollRouteOwners: number[] } {
    const byId = new Map(this.cities.map((c) => [c.id, c]));
    const adjacency = this.routeGraphAdjacency();
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
    const tollRouteOwners = this.tradeRoutes
      .filter((r) => r.playerId !== selfId && visited.has(r.fromCityId) && visited.has(r.toCityId) && !this.isRouteBlocked(r))
      .map((r) => r.playerId);
    return { cities: netCities, tollRouteOwners };
  }

  /** Игрок physически связан с другим торговым маршрутом (свой город — свой/чужой город по пути
   * незаблокированных маршрутов) — БЕЗ требования «Торговый союз» (то отдельный, более узкий фильтр
   * именно для дохода торговой сети, см. tradeNetworkOf). Используется только для «контакта» —
   * условия доступности сделок биржи и дипломатических предложений, см. hasContactWith. */
  private hasRouteNetworkContactWith(playerId: number, otherId: number): boolean {
    const myCityIds = this.cities.filter((c) => c.playerId === playerId).map((c) => c.id);
    if (!myCityIds.length) return false;
    const adjacency = this.routeGraphAdjacency();
    const byId = new Map(this.cities.map((c) => [c.id, c]));
    const visited = new Set<number>(myCityIds);
    const queue = [...myCityIds];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        if (byId.get(next)?.playerId === otherId) return true;
        queue.push(next);
      }
    }
    return false;
  }

  /** Территория (регион с городом) этого игрока физически прилегает к территории другого игрока —
   * хотя бы одна пара гексов их регионов — соседи на карте (`hexNeighborsGameplay`, учитывает
   * заворот по долготе). Используется только для «контакта», см. hasContactWith. */
  private areNeighbors(playerId: number, otherId: number): boolean {
    for (const c of this.cities) {
      if (c.playerId !== playerId) continue;
      for (let dx = 0; dx < REGION_SIZE_X; dx++) {
        for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
          const col = c.regionCol * REGION_SIZE_X + dx;
          const row = c.regionRow * REGION_SIZE_Y + dy;
          for (const [nc, nr] of this.hexNeighborsGameplay(col, row)) {
            if (this.territoryOwnerOf(nc, nr) === otherId) return true;
          }
        }
      }
    }
    return false;
  }

  /** «Контакт» между двумя игроками (по прямому запросу — правило видимости касается ТОЛЬКО
   * дипломатии, ни передачи карт, ни биржи) — общая граница территорий ИЛИ прямой торговый маршрут
   * между их городами. Требуется только для дипломатических СОГЛАШЕНИЙ (sendProposal, term.kind ===
   * "agreement") — не для мира/войны, те доступны с кем угодно всегда. Технология «Радио» снимает
   * это требование для дипломатии. Биржа (сделки «игрок ↔ игрок», buyListing/marketCandidates) —
   * общая независимо от контакта/видимости, тем же принципом, что и мировой рынок (WORLD_SELLER);
   * обязательная передача карты (handoffCard) видимостью тоже никогда не ограничивалась — тот же
   * пул получателей, что доступен человеку. */
  private hasContactWith(playerId: number, otherId: number): boolean {
    return this.areNeighbors(playerId, otherId) || this.hasRouteNetworkContactWith(playerId, otherId);
  }

  /** Общее ядро дохода торговой сети — используется и картой «Торговец» (traderTrade), и зданием
   * «Рынок» (useRynok — по прямому запросу «сделай равным по эффекту применения Торговцу»): считает
   * уникальные торговые типы, доступные через регион ВЫБРАННОГО города (доступ → склад, как и у
   * любой другой карты — Коммунизм подкидывает туда настоящие единицы каждый цикл, см.
   * grantCommunismResourceIncome), списывает их, платит толл/грабёж, начисляет остаток игроку (с
   * гандикапом бота). Доход считается ПО ВСЕЙ сети (`network.length`) — шире сеть, дороже каждый
   * разыгранный тип; сами списываемые типы — только из региона ЭТОГО города (по прямому запросу,
   * упрощение источников ресурсов — «убери логику, где ресурсы берутся с нескольких городов
   * одновременно»). Не проверяет карту/здание/действие/доп. цену — это на вызывающей стороне;
   * возвращает `false`, если играть нечем (в сети и на складе нет ни одного торгового ресурса) —
   * состояние партии в этом случае НЕ меняется, вызывающая сторона не списывает свою цену. */
  /** Чистый расчёт дохода торговой сети — БЕЗ побочных эффектов (ничего не списывает/не платит),
   * используется и настоящим применением (`applyTradeNetworkIncome`, платит по этой же разбивке), и
   * превью для игрока-человека (по прямому запросу — «функция выбора ресурсов для торговли с
   * выведением дохода и списка городов в сети, сколько получат другие игроки и сколько игрок,
   * который сыграл карту»; `previewTraderTradeIncome` ниже). `selectedResources` — конкретные виды,
   * которые игрок решил пустить в оборот (не более доступных); не передан — считает ПО ВСЕМ
   * доступным (прежнее, автоматическое поведение — так по-прежнему играет бот и Рынок-здание). */
  private computeTradeIncomeBreakdown(playerId: number, city: City, selectedResources?: Set<ResourceId>): TradeIncomeBreakdown {
    const { cities: network, tollRouteOwners } = this.tradeNetworkOf(city);
    const totalPop = network.reduce((sum, c) => sum + c.population, 0);
    const available: { resource: ResourceId; source: "access" | "warehouse" }[] = [];
    const seen = new Set<ResourceId>();
    // 4-й аргумент (capToCity) ограничивает список НОВЫМИ типами не больше населения города (ТЗ 7.2).
    for (const r of new Set(this.resourcesInRegion(city.regionCol, city.regionRow, playerId, city))) {
      if (GameSession.RESOURCE_META.get(r)!.category !== "trade") continue;
      if (!this.resourceIsExtractable(playerId, r)) continue;
      if (this.accessUsed.has(`${city.id}:${r}`)) continue;
      seen.add(r);
      available.push({ resource: r, source: "access" });
    }
    for (const [id, qty] of Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][]) {
      if (qty > 0 && GameSession.RESOURCE_META.get(id)!.category === "trade" && !seen.has(id)) {
        seen.add(id as ResourceId);
        available.push({ resource: id as ResourceId, source: "warehouse" });
      }
    }

    const selected = selectedResources ? available.filter((a) => selectedResources.has(a.resource)) : available;
    const grossIncome = Math.min(network.length * selected.length, totalPop);

    let remaining = grossIncome;
    const tollBreakdown: { playerId: number; amount: number }[] = [];
    for (const ownerId of tollRouteOwners) {
      if (remaining <= 0) break;
      remaining -= 1;
      tollBreakdown.push({ playerId: ownerId, amount: 1 });
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
    const raiderBreakdown: { playerId: number; unitId: number; amount: number }[] = [];
    for (const uid of raiderUnitIds) {
      if (remaining <= 0) break;
      const raider = this.units.find((u) => u.id === uid);
      if (!raider) continue;
      remaining -= 1;
      raiderBreakdown.push({ playerId: raider.playerId, unitId: uid, amount: 1 });
    }
    // Гандикап бота (см. aiIncomeMultiplier) — только на СВОЮ долю после толлов/грабежа, не на то,
    // что достаётся другим владельцам маршрута или рейдерам.
    const playerShare = remaining * this.aiIncomeMultiplier(playerId);

    return {
      networkCities: network.map((c) => ({ cityId: c.id, playerId: c.playerId, population: c.population })),
      available,
      selected: selected.map((a) => a.resource),
      grossIncome,
      tollBreakdown,
      raiderBreakdown,
      playerShare,
    };
  }

  /** Превью разбивки дохода до реальной игры карты (по прямому запросу) — read-only, вызывается
   * отдельным каналом от `wsServer.ts` (в обход dispatch, тем же приёмом, что previewPath/
   * previewAttack/previewProposalValue), пересчитывается на каждое изменение выбора игрока. */
  previewTraderTradeIncome(playerId: number, cityId: number, resources?: ResourceId[]): TradeIncomeBreakdown | null {
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return null;
    return this.computeTradeIncomeBreakdown(playerId, city, resources ? new Set(resources) : undefined);
  }

  private applyTradeNetworkIncome(playerId: number, city: City, selectedResources?: Set<ResourceId>): boolean {
    const breakdown = this.computeTradeIncomeBreakdown(playerId, city, selectedResources);
    if (breakdown.selected.length === 0) return false;
    for (const resource of breakdown.selected) {
      const info = breakdown.available.find((a) => a.resource === resource)!;
      if (info.source === "access") this.accessUsed.add(`${city.id}:${resource}`);
      else this.takeFromWarehouse(playerId, resource, 1);
    }
    for (const t of breakdown.tollBreakdown) this.money[t.playerId] += t.amount;
    for (const r of breakdown.raiderBreakdown) this.money[r.playerId] += r.amount;
    this.money[playerId] += breakdown.playerShare;
    return true;
  }

  /** Торговец — портирован из tryTraderTrade, доход считает applyTradeNetworkIncome (см. её doc). */
  /** `resources` (по прямому запросу — «функция выбора ресурсов для торговли») — необязательный
   * список конкретных видов, которые игрок решил пустить в оборот; не передан — по-прежнему
   * автоматически ВСЕ доступные (так играет бот — не в курсе этого параметра вовсе, и здание
   * «Рынок», см. useRynok — ему выбор не предлагался и не предлагается). */
  traderTrade(playerId: number, slotIndex: number, cityId: number, resources?: ResourceId[]): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "trader" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Торговец» недоступна в этом слоте." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Можно торговать только через свой город." };
    // По прямому уточнению — если в сети (и складе) нет ни одного торгового ресурса, карта не
    // разыгрывается вовсе (действие и карта остаются нетронутыми), а не тратится впустую на доход 0.
    if (!this.applyTradeNetworkIncome(playerId, city, resources ? new Set(resources) : undefined)) {
      return { ok: false, hint: "В торговой сети (и на складе) нет ни одного торгового ресурса — играть нечем." };
    }
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  // === Постройки (ТЗ 3.1.4/3.1.5/4.4) =============================================================

  /** Строитель's price model — портирован из planBuildingSpend. `source` — один город (стройка/
   * здание/исследование — всегда столица; добыча силикатов Строителем — конкретный выбранный город).
   * Массив источников больше не используется по прямому запросу («убери логику, где ресурсы берутся
   * с нескольких городов одновременно») — раньше сюда передавалась вся торговая сеть при Коммунизме
   * (`ownRouteComponent`), теперь у Коммунизма другой, более простой бонус (см. communismCapitalTypes/
   * grantCommunismResourceIncome) — тип остался массивом только чтобы не трогать сигнатуру лишний раз. */
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
    for (const [id, qty] of Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][]) {
      for (let i = 0; i < qty; i++) warehouseCandidates.push(id);
    }
    const marketCandidates = this.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId)
      .sort((a, b) => a.price - b.price);

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
        plan.push({ resource: l.resource!, source: "market", listingId: l.id, price: l.price });
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

  /** Человекочитаемая метка одной линии `BuildingCostLine` — для диагностики ниже (какая ИМЕННО
   * позиция цены не закрылась), не для реального списания. */
  private static buildingCostLineLabel(line: BuildingCostLine): string {
    if (line.kind === "specific") return GameSession.RESOURCE_META.get(line.resource as ResourceId)?.label ?? line.resource;
    if (line.kind === "anyOf") return line.resources.map((r) => GameSession.RESOURCE_META.get(r as ResourceId)?.label ?? r).join("/");
    const CATEGORY_LABEL: Record<string, string> = { food: "Еда", trade: "Торговый", strategic: "Стратегический" };
    return CATEGORY_LABEL[line.category] ?? line.category;
  }

  /** Диагностика для человекочитаемых подписей плана хода бота (`bot.ts`, «не хватило X для карты
   * Y» — по прямому запросу) — тот же перебор доступ→склад→рынок, что и planBuildingSpend выше, но
   * вместо остановки на первой непройденной линии проходит ВСЕ и возвращает МЕТКИ несомкнутых линий.
   * Не тратит ничего и не строит план — только диагностика. */
  private unresolvedBuildingRequirementLabels(playerId: number, sources: { id: number; regionCol: number; regionRow: number }[], lines: BuildingCostLine[]): string[] {
    let moneyBudget = this.money[playerId];
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
    for (const [id, qty] of Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][]) {
      for (let i = 0; i < qty; i++) warehouseCandidates.push(id);
    }
    const marketCandidates = this.market
      .filter((l): l is MarketListing & { kind: "resource" } => l.kind === "resource" && l.sellerId !== playerId)
      .sort((a, b) => a.price - b.price);

    const pickOne = (rawMatch: (id: ResourceId) => boolean): ResourceId | null => {
      const match = this.matchWithJoker(rawMatch);
      const aIdx = accessCandidates.findIndex((a) => match(a.resource) && (accessBudgetLeft.get(a.cityId) ?? 0) > 0);
      if (aIdx >= 0) {
        const a = accessCandidates.splice(aIdx, 1)[0];
        accessBudgetLeft.set(a.cityId, (accessBudgetLeft.get(a.cityId) ?? 0) - 1);
        return a.resource;
      }
      const wIdx = warehouseCandidates.findIndex((r) => match(r));
      if (wIdx >= 0) return warehouseCandidates.splice(wIdx, 1)[0];
      const mIdx = marketCandidates.findIndex((l) => match(l.resource!) && l.price <= moneyBudget);
      if (mIdx >= 0) {
        const l = marketCandidates.splice(mIdx, 1)[0];
        moneyBudget -= l.price;
        return l.resource!;
      }
      return null;
    };

    const missing = new Set<string>();
    for (const line of lines) {
      const label = GameSession.buildingCostLineLabel(line);
      if (line.kind === "specific") {
        for (let i = 0; i < line.count; i++) {
          if (pickOne((r) => r === line.resource) === null) {
            missing.add(label);
            break;
          }
        }
      } else if (line.kind === "anyOf") {
        for (let i = 0; i < line.count; i++) {
          if (pickOne((r) => (line.resources as ResourceId[]).includes(r)) === null) {
            missing.add(label);
            break;
          }
        }
      } else {
        const chosen = new Set<ResourceId>();
        for (let i = 0; i < line.count; i++) {
          const picked = pickOne((r) => GameSession.RESOURCE_META.get(r)!.category === line.category && !chosen.has(r));
          if (picked === null) {
            missing.add(label);
            break;
          }
          chosen.add(picked);
        }
      }
    }
    return [...missing];
  }

  /** Публичная обёртка `unresolvedBuildingRequirementLabels` для здания (`bot.ts`, подпись
   * «Рабочего»-СРЕДСТВА для карты «Строитель»). */
  missingBuildingCostLabels(playerId: number, buildingId: string): string[] {
    const def = BUILDINGS.find((b) => b.id === buildingId);
    const capital = this.capitalCityOf(playerId);
    if (!def || !capital) return [];
    return this.unresolvedBuildingRequirementLabels(playerId, [capital], def.costLines);
  }

  /** Те же недостающие линии цены здания, что и `missingBuildingCostLabels`, только КОНКРЕТНЫМИ
   * `ResourceId` вместо текстовых меток (тот же приём, что и `missingUnitCostResourceIds` выше) —
   * по прямому запросу («раз уже есть здание-потребитель энергии, значит нужен источник — учти это
   * в алгоритме») для прицельного выбора города/типа «Рабочим»-СРЕДСТВОМ под «Строителя»
   * (`bot.ts: builderMissingResourceIds`), вместо общего «разнообразие склада». */
  missingBuildingCostResourceIds(playerId: number, buildingId: string): ResourceId[] {
    const def = BUILDINGS.find((b) => b.id === buildingId);
    const capital = this.capitalCityOf(playerId);
    if (!def || !capital) return [];
    const lines = def.costLines;
    const missingLabels = new Set(this.unresolvedBuildingRequirementLabels(playerId, [capital], lines));
    if (!missingLabels.size) return [];
    const ids = new Set<ResourceId>();
    for (const line of lines) {
      if (!missingLabels.has(GameSession.buildingCostLineLabel(line))) continue;
      if (line.kind === "specific") ids.add(line.resource as ResourceId);
      else if (line.kind === "anyOf") for (const r of line.resources) ids.add(r as ResourceId);
      else for (const r of RESOURCES) if (GameSession.RESOURCE_META.get(r.id)!.category === line.category) ids.add(r.id);
    }
    return [...ids];
  }

  /** Публичная обёртка `unresolvedBuildingRequirementLabels` для исследования (`bot.ts`, подпись
   * «Рабочего»-СРЕДСТВА для карты «Учёный»). */
  missingResearchCostLabels(playerId: number, epoch: number): string[] {
    const capital = this.capitalCityOf(playerId);
    const lines = GameSession.RESEARCH_COST_LINES[epoch];
    if (!capital || !lines) return [];
    return this.unresolvedBuildingRequirementLabels(playerId, [capital], lines);
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
    if (def.tech !== null && !this.researchedTechs[playerId].has(def.tech)) {
      return { ok: false, hint: `Здание «${def.name}» открывается технологией «${def.tech}» — она ещё не исследована.` };
    }
    // По прямому запросу («для строительства здания списывается только в столице и со склада») —
    // Коммунизм больше не расширяет доступ на всю торговую сеть, у него отдельный бонус вместо этого
    // (communismCapitalTypes/grantCommunismResourceIncome).
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
        this.holdOonElection();
        // Первые выборы — сразу; следующие — через 5 циклов, дальше сама себя переносит (см.
        // resolveCycleBoundary).
        this.oonNextElectionCycle = this.cyclesElapsed + GameSession.OON_ELECTION_INTERVAL_CYCLES;
      } else if (this.oonCandidate2Id === null && playerId !== this.oonCandidate1Id) {
        this.oonCandidate2Id = playerId;
      }
    }
    return { ok: true, spent: plan };
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

  /** Здания, которые ПОТРЕБЛЯЮТ 1 единицу энергии, чтобы произвести свою продукцию (ТЗ 4.4 — «для
   * радиовышки и фабрики нужно 1 единица электричество»; по прямому уточнению — Углеводороды и
   * Электричество полностью взаимозаменяемы как источник энергии, предпочитаются Углеводороды, если
   * есть оба, тот же приём, что у Рынка) — в отличие от ГЭС/АЭС, которые электричество производят, а
   * не тратят. */
  private static ELECTRICITY_CONSUMING_BUILDINGS = new Set(["fabrika", "radiovyshka"]);

  /** Цена активации зданий-«кранов» в 💰 (по умолчанию 1, см. activateProductionBuilding). ГЭС/АЭС —
   * по прямому запросу повышены отдельно от общей базы: «извлечение электричества с ГЭС стоит 1
   * деньги, это мало, повышаем до 3; с АЭС 2 электричества — до 5» — привязано к тому, СКОЛЬКО
   * электричества здание выдаёт за клик (ГЭС 1шт/3💰, АЭС 2шт/5💰), а не к общей для всех зданий базе. */
  private static PRODUCTION_BUILDING_MONEY_COST: Record<string, number> = { ges: 3, aes: 5 };

  /** «Управление» — 2 функции: +1 действие в этот ход, или добор 1 карты с колоды (по прямому
   * запросу — «ещё одна функция... тоже стоит 5»). База обеих — 5💰 (ТЗ 4.4 «полная сверка цены
   * активации»). В отличие от остальных зданий, не лимитировано разом за ход/цикл вовсе — можно
   * пользоваться СКОЛЬКО УГОДНО раз за цикл, но цена КАЖДОГО следующего использования (любой из 2
   * функций, общий счётчик — `upravlenieUsesThisCycle`) растёт кратно базе: 5, 10, 15, 20, 25...
   * Счётчик сбрасывается раз в цикл (resolveCycleBoundary), не за ход. */
  static UPRAVLENIE_ACTION_PRICE = 5;
  private upravlenieNextPrice(playerId: number): number {
    return GameSession.UPRAVLENIE_ACTION_PRICE * ((this.upravlenieUsesThisCycle[playerId] ?? 0) + 1);
  }
  useUpravlenie(playerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "upravlenie", playerId)) return { ok: false, hint: "У вас нет здания «Управление»." };
    const price = this.upravlenieNextPrice(playerId);
    if (this.money[playerId] < price) return { ok: false, hint: `Не хватает денег (нужно ${price} 💰).` };
    this.money[playerId] -= price;
    this.actionsLeft[playerId]++;
    this.actionsTotal[playerId]++; // реально поднимает лимит на этот ход, не просто возврат — кружков должно стать больше
    this.upravlenieUsesThisCycle[playerId] = (this.upravlenieUsesThisCycle[playerId] ?? 0) + 1;
    return { ok: true };
  }

  /** «Управление», вторая функция — добор 1 карты с колоды за ту же эскалирующую цену, что и первая
   * (общий счётчик, см. doc выше). В отличие от `drawCardFromDeck` (бесплатный добор при ПУСТОЙ
   * руке) — доступно при любом размере руки, но платно и без ограничения по руке (переполнение ≥8
   * обрабатывается как обычно в конце хода). */
  useUpravlenieDrawCard(playerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "upravlenie", playerId)) return { ok: false, hint: "У вас нет здания «Управление»." };
    const price = this.upravlenieNextPrice(playerId);
    if (this.money[playerId] < price) return { ok: false, hint: `Не хватает денег (нужно ${price} 💰).` };
    if (!this.deck.length) return { ok: false, hint: "Колода пуста — брать больше неоткуда." };
    const card = this.deck.shift()!;
    this.money[playerId] -= price;
    this.hands[playerId].push(card);
    this.upravlenieUsesThisCycle[playerId] = (this.upravlenieUsesThisCycle[playerId] ?? 0) + 1;
    return { ok: true, hint: `Взята карта «${card.label}».` };
  }

  /** Активация УЖЕ ПОСТРОЕННЫХ зданий не тратит очков действия — для всех игроков, независимо от
   * парадигмы. Игрок может в свой ход использовать любое число зданий (не ограничено одним разом) —
   * каждое по-прежнему платит свою обычную цену использования (деньги/ресурсы/карту) и подчиняется
   * своему собственному лимиту частоты, если он есть (например, раз за цикл у производственных
   * зданий). Единая точка входа вместо повтора одной и той же пары проверок в каждом useX/activateX
   * ниже. */
  private buildingActionGate(_playerId: number): ActionResult | null {
    return null;
  }
  private spendBuildingAction(_playerId: number) {
    // намеренно no-op — активация зданий бесплатна по очкам действия для всех
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
    const cost = GameSession.PRODUCTION_BUILDING_MONEY_COST[buildingId] ?? 1;
    if (this.money[playerId] < cost) return { ok: false, hint: `Не хватает денег — активация здания стоит ${cost} 💰.` };
    const needsEnergy = GameSession.ELECTRICITY_CONSUMING_BUILDINGS.has(buildingId);
    const hasHydrocarbons = (this.warehouse[playerId]?.hydrocarbons ?? 0) > 0;
    const hasElectricity = (this.warehouse[playerId]?.electricity ?? 0) > 0;
    if (needsEnergy && !hasHydrocarbons && !hasElectricity) {
      return { ok: false, hint: `${b.name} требует 1 Углеводороды или 1 Электричество со склада, чтобы произвести продукцию — сейчас нет ни того, ни другого.` };
    }
    this.money[playerId] -= cost;
    this.spendBuildingAction(playerId);
    this.productionUsedThisCycle.add(cycleKey);
    if (needsEnergy) this.takeFromWarehouse(playerId, hasHydrocarbons ? "hydrocarbons" : "electricity", 1);
    this.addToWarehouse(playerId, b.produces.resource, b.produces.qty);
    return { ok: true };
  }

  /** Рынок — по прямому запросу «сделай равным по эффекту применения Торговцу, только его
   * применение требует Углеводородов или Электричества помимо действия»: раньше была отдельная
   * простая схема «продать 1 торговый ресурс со склада за фиксированные +2💰» (ТЗ 4.4, схема 4,
   * «без завязки на цикл вообще» — безопасно без цикл-лимита именно потому, что расходовала
   * конкретный конечный ресурс со склада, сама себя ограничивала запасом), теперь — буквально тот
   * же доход торговой сети, что и у карты «Торговец» (см. applyTradeNetworkIncome), только БЕЗ
   * карты (здание — 1 действие, `buildingActionGate`, как у остальных зданий-активаций) и с
   * дополнительной ценой сверх действия — 1 Углеводороды ИЛИ 1 Электричество со склада
   * (предпочитается Углеводороды, если есть оба).
   * [ИСПРАВЛЕНО, живой баг-репорт — «каждое здание за цикл можно сыграть лишь раз, сейчас это
   * правило работает не для всех зданий»] — доход торговой сети НЕ тратит сам маршрут/сеть (в
   * отличие от старой схемы «продать 1 ресурс»), так что при достатке Углеводородов/Электричества
   * на складе и действий за ход тот же самый доход можно было выжимать из ОДНОЙ и той же торговой
   * сети сколько угодно раз за один цикл — старое «без лимита цикла» имело смысл только для старой,
   * самоограничивающейся конечным складом схемы и не перенеслось на новую. Теперь — как у
   * ГЭС/АЭС/Фабрики/Радиовышки, не больше 1 раза за цикл на игрока (тот же `productionUsedThisCycle`,
   * просто с ключом `rynok:playerId` вместо id здания-производителя — семантически то же самое
   * «использовано в этом цикле», не отдельный флаг). */
  useRynok(playerId: number, cityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "rynok", playerId)) return { ok: false, hint: "У вас нет здания «Рынок»." };
    const cycleKey = `rynok:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Рынок уже торговал в этом цикле — снова можно только со следующего." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Можно торговать только через свой город." };
    const hasHydrocarbons = (this.warehouse[playerId]?.hydrocarbons ?? 0) > 0;
    const hasElectricity = (this.warehouse[playerId]?.electricity ?? 0) > 0;
    if (!hasHydrocarbons && !hasElectricity) return { ok: false, hint: "Нужны Углеводороды или Электричество на складе." };
    if (!this.applyTradeNetworkIncome(playerId, city)) return { ok: false, hint: "В торговой сети (и на складе) нет ни одного торгового ресурса — играть нечем." };
    this.takeFromWarehouse(playerId, hasHydrocarbons ? "hydrocarbons" : "electricity", 1);
    this.spendBuildingAction(playerId);
    this.productionUsedThisCycle.add(cycleKey);
    return { ok: true };
  }

  /** Ядерный арсенал (ТЗ 4.4, схема 3 «ресурсное производство без денег, без лимита цикла») —
   * платит 2 Уран + 1 Металл (доступ → склад → рынок, из региона столицы, как у Строителя/Учёного)
   * за +1 действие потраченное, копит стокпайл. Само применение ЯО — см. launchNuclearStrike ниже
   * (по прямому запросу, живой баг-репорт: «построил Ядерный арсенал, но не могу воспользоваться им
   * для постройки ядерной бомбы — нет кнопки»; раньше действительно не было — только счётчик). */
  private static YADERNYI_ARSENAL_COST: BuildingCostLine[] = [
    { kind: "specific", resource: "uranium", count: 2 },
    { kind: "specific", resource: "metalOre", count: 1 },
  ];
  activateYadernyiArsenal(playerId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "yadernyi_arsenal", playerId)) return { ok: false, hint: "У вас нет здания «Ядерный арсенал»." };
    if (this.oonNuclearBanActive) return { ok: false, hint: "Резолюция ООН «Запрет ядерного оружия» действует — новое ЯО производить нельзя." };
    const cycleKey = `yadernyi_arsenal:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Ядерный арсенал уже использован в этом цикле — снова можно только со следующего." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const capital = this.capitalCityOf(playerId);
    if (!capital) return { ok: false, hint: "Ещё нет столицы." };
    const plan = this.planBuildingSpend(playerId, capital, GameSession.YADERNYI_ARSENAL_COST);
    if (!plan) return { ok: false, hint: "Не набралось ресурсов (2 Уран + 1 Металл) — ни в столице, ни на складе, ни на рынке." };
    this.commitSpend(playerId, plan);
    this.spendBuildingAction(playerId);
    this.productionUsedThisCycle.add(cycleKey);
    this.nuclearWeapons[playerId] = (this.nuclearWeapons[playerId] ?? 0) + 1;
    return { ok: true };
  }

  private static NUCLEAR_STRIKE_MONEY_COST = 2;
  private static NUCLEAR_STRIKE_TARGET_DAMAGE = 12;
  private static NUCLEAR_STRIKE_NEIGHBOR_DAMAGE = 6;
  private static NUCLEAR_STRIKE_TARGET_POP_LOSS = 2;
  private static NUCLEAR_STRIKE_NEIGHBOR_POP_LOSS = 1;
  /** Шанс перехвата ПРО «Космодрома» цели (по прямому уточнению) — если цель владеет «Космодромом»,
   * удар попадает только в 40% случаев (иначе — всегда). Не путать с design-only «Космонавтика даёт
   * 50%/100% неуязвимость» из старого черновика ТЗ (§4.4) — эта, более ранняя, версия механики так и
   * осталась нереализованной; по прямому уточнению используется другая, более простая привязка к
   * зданию «Космодром», не к технологии/лидерству в ветке. */
  private static NUCLEAR_STRIKE_SPACEPORT_HIT_CHANCE = 0.4;

  /** Применение ЯО из запаса «Ядерного арсенала» (по прямому запросу, живой баг-репорт — см. doc
   * activateYadernyiArsenal). Отдельная «карта», не занимающая слот руки — количество бомб в запасе
   * (`nuclearWeapons[playerId]`) само по себе и есть доступность кнопки на клиенте. Цель обязана
   * быть на территории игрока, с которым СЕЙЧАС идёт война (не по своей и не по нейтральной/мирной —
   * по прямому уточнению), удар считается 1 действием (`buildingActionGate`, то же, что у остальных
   * зданий) + 10💰 сверху, независимо от исхода (бомба тратится из запаса, даже если промах). AI
   * (см. bot.ts) может применять её сам, если оценивает силы противника выше своих. */
  launchNuclearStrike(playerId: number, col: number, row: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if ((this.nuclearWeapons[playerId] ?? 0) <= 0) return { ok: false, hint: "Нет ядерного оружия в запасе — сначала постройте его («Ядерный арсенал»)." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    if (this.money[playerId] < GameSession.NUCLEAR_STRIKE_MONEY_COST) {
      return { ok: false, hint: `Не хватает денег для запуска (нужно ${GameSession.NUCLEAR_STRIKE_MONEY_COST}💰).` };
    }
    const targetOwner = this.territoryOwnerOf(col, row);
    if (targetOwner === null || targetOwner === playerId || !this.relationOf(playerId, targetOwner).war) {
      return { ok: false, hint: "Целью может быть только территория противника, с которым сейчас идёт война." };
    }
    this.money[playerId] -= GameSession.NUCLEAR_STRIKE_MONEY_COST;
    this.nuclearWeapons[playerId]--;
    this.spendBuildingAction(playerId);
    // Отношения AI — фактор 12 (по прямому запросу, «применил ЯО −3 за каждый факт применения») —
    // сам ФАКТ ЗАПУСКА, не попадания (оружие уже потрачено, намерение агрессии состоялось, даже
    // если ПРО «Космодрома» перехватит ракету ниже) — применяется у ВСЕХ живых наблюдателей (символ
    // агрессии для всей партии, не только у той стороны, чья территория пострадала).
    for (const p of this.players) {
      if (this.eliminatedPlayers.has(p.id) || p.id === playerId) continue;
      this.adjustRelationScore(p.id, playerId, -3, "применил ЯО");
    }
    const targetOwnsSpaceport = isOwnedBy(this.buildingOwners, "kosmodrom", targetOwner);
    const hit = !targetOwnsSpaceport || this.rng() < GameSession.NUCLEAR_STRIKE_SPACEPORT_HIT_CHANCE;
    if (!hit) {
      return { ok: true, hint: "ПРО «Космодрома» цели перехватила ракету — удар не достиг цели.", nuclearStrike: { hit: false, target: { col, row }, hexes: [] } };
    }
    const neighbors = this.hexNeighborsGameplay(col, row);
    const affectedUnits: UnitInstance[] = [];
    let killed = 0;
    const targetUnits = this.units.filter((u) => u.col === col && u.row === row);
    for (const u of targetUnits) {
      const defense = this.peekHexDefense(u);
      u.hp -= Math.max(0, GameSession.NUCLEAR_STRIKE_TARGET_DAMAGE - defense);
      affectedUnits.push(u);
      if (u.hp <= 0) killed++;
    }
    this.hexDefense.set(this.hexKey(col, row), 0);
    for (const [nc, nr] of neighbors) {
      const neighborUnits = this.units.filter((u) => u.col === nc && u.row === nr);
      for (const u of neighborUnits) {
        const defense = this.peekHexDefense(u);
        u.hp -= Math.max(0, GameSession.NUCLEAR_STRIKE_NEIGHBOR_DAMAGE - defense);
        affectedUnits.push(u);
        if (u.hp <= 0) killed++;
      }
    }
    this.removeDeadUnits(affectedUnits);

    // По прямому уточнению — лес выжигает не только на самой цели, но и во всём радиусе удара (target
    // + 6 соседей); терраин-цепочка (равнина→пустыня/горы→холмы/холмы→равнина) — только на самой
    // цели, у соседей просто сгорает лес, ландшафт не меняется.
    const tile = this.doc.get(col, row);
    const terrainDowngrade: Partial<Record<TerrainId, TerrainId>> = { plains: "desert", mountains: "hills", hills: "plains" };
    this.doc.set(col, row, { forest: false, ...(terrainDowngrade[tile.terrain] ? { terrain: terrainDowngrade[tile.terrain] } : {}) });
    for (const [nc, nr] of neighbors) this.doc.set(nc, nr, { forest: false });
    // «Разнос ветром радиации» (по прямому уточнению) — 1 СЛУЧАЙНАЯ равнина среди соседей (не сама
    // цель — та уже обработана строкой выше) опустынивается, независимо от того, есть юниты/город на
    // ней или нет; ресурс на ней (если был) пропадает вместе с ней — тот же приём, что и у
    // cascadeLastForestLoss/degradeForestOrLand (естественная деградация региона). По прямому
    // уточнению — «если ядерному оружию негде делать пустыню дополнительную, расширяй радиус
    // поиска равнины» — если среди ближних 6 соседей равнины нет вовсе (море/горы/пустыня кругом),
    // ищет расширяющимися кольцами ДАЛЬШЕ от цели (тот же BFS-приём, что findEvictionHex/
    // findBarePlainsForMining в bot.ts), пока не найдёт равнину или не упрётся в предел колец —
    // эффект не должен просто пропадать только из-за неудачного рельефа вокруг цели. Uses this.rng().
    const RADIATION_DRIFT_MAX_RING = 8;
    let plainsCandidates = neighbors.filter(([nc, nr]) => this.doc.get(nc, nr).terrain === "plains");
    if (!plainsCandidates.length) {
      const seen = new Set<string>([this.hexKey(col, row), ...neighbors.map(([nc, nr]) => this.hexKey(nc, nr))]);
      let frontier = neighbors;
      for (let ring = 0; ring < RADIATION_DRIFT_MAX_RING && frontier.length && !plainsCandidates.length; ring++) {
        const next: [number, number][] = [];
        for (const [c, r] of frontier) {
          for (const [nc, nr] of this.hexNeighborsGameplay(c, r)) {
            const key = this.hexKey(nc, nr);
            if (seen.has(key)) continue;
            seen.add(key);
            next.push([nc, nr]);
            if (this.doc.get(nc, nr).terrain === "plains") plainsCandidates.push([nc, nr]);
          }
        }
        frontier = next;
      }
    }
    if (plainsCandidates.length) {
      const [dc, dr] = plainsCandidates[Math.floor(this.rng() * plainsCandidates.length)];
      this.doc.set(dc, dr, { terrain: "desert", resource: undefined });
    }

    let cityHint = "";
    const targetCity = this.cityAt(col, row);
    if (targetCity) {
      // Столица — здания игрока-владельца привязаны к ней целиком в этой модели (buildingOwners
      // глобален на игрока, не на город, см. handleCityLoss) — прямой удар по столице срывает их ВСЕ,
      // независимо от того, выживет ли сама столица после потери населения ниже.
      if (targetCity.isCapital) {
        for (const b of builtBy(this.buildingOwners, targetOwner)) this.buildingOwners[b.id].splice(this.buildingOwners[b.id].indexOf(targetOwner), 1);
        cityHint = " Столица противника лишилась всех зданий.";
      }
      targetCity.population -= GameSession.NUCLEAR_STRIKE_TARGET_POP_LOSS;
      if (targetCity.population <= 0) {
        this.destroyCity(targetCity);
        cityHint += " Город уничтожен целиком.";
      }
    }
    for (const [nc, nr] of neighbors) {
      const neighborCity = this.cityAt(nc, nr);
      if (!neighborCity) continue;
      neighborCity.population -= GameSession.NUCLEAR_STRIKE_NEIGHBOR_POP_LOSS;
      if (neighborCity.population <= 0) this.destroyCity(neighborCity);
    }

    return {
      ok: true,
      hint: `Ядерный удар по (${col},${row}) — погибло юнитов: ${killed}.${cityHint}`,
      nuclearStrike: { hit: true, target: { col, row }, hexes: [{ col, row }, ...neighbors.map(([c, r]) => ({ col: c, row: r }))] },
    };
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
    const cycleKey = `aeroport:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Аэропорт уже использован в этом цикле — снова можно только со следующего." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return { ok: false, hint: "Юнит не найден." };
    const capital = this.capitalCityOf(playerId);
    if (!capital || unit.col !== capital.col || unit.row !== capital.row) return { ok: false, hint: "Перебросить можно только юнита, стоящего сейчас в столице." };
    const targetOwner = this.territoryOwnerOf(col, row);
    if (targetOwner !== null && !this.canTraverseTerritoryOf(playerId, targetOwner)) {
      return { ok: false, hint: "Чужой сектор без «Открытых границ»/Вассалитета/войны — переброска заблокирована." };
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
    this.productionUsedThisCycle.add(cycleKey);
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
    const cycleKey = `hram:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Храм уже использован в этом цикле — снова можно только со следующего." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const card = this.hands[playerId][slotIndex];
    if (!card) return { ok: false, hint: "В этом слоте руки нет карты." };
    const religion = this.playerReligion[playerId];
    const income = religion === null || religion === "atheism" ? 0 : this.cities.filter((c) => this.playerReligion[c.playerId] === religion).length;
    this.consumeHandCard(playerId, slotIndex); // всегда тратит 1 action — при Парламентаризме компенсируем ниже
    if (this.playerParadigm[playerId] === "parliamentarism") this.actionsLeft[playerId]++;
    this.money[playerId] += income;
    this.productionUsedThisCycle.add(cycleKey);
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
    const cycleKey = `universitet:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Университет уже использован в этом цикле — снова можно только со следующего." };
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
    this.productionUsedThisCycle.add(cycleKey);
    const hint = this.researchTech(playerId, techId);
    return { ok: true, hint };
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
    const cycleKey = `internet:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Интернет уже использован в этом цикле — снова можно только со следующего." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const target = this.players.find((p) => p.id === targetPlayerId);
    if (!target || targetPlayerId === playerId) return { ok: false, hint: "Выберите другого игрока." };
    if (this.eliminatedPlayers.has(targetPlayerId)) return { ok: false, hint: "Этот игрок выбыл из партии — сравниваться не с кем." };
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
    this.productionUsedThisCycle.add(cycleKey);
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
    const cycleKey = `kosmodrom:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Космодром уже использован в этом цикле — снова можно только со следующего." };
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    const capital = this.capitalCityOf(playerId);
    if (!capital) return { ok: false, hint: "Ещё нет столицы." };
    const plan = this.planBuildingSpend(playerId, capital, GameSession.KOSMODROM_COST);
    if (!plan) return { ok: false, hint: "Не набралось ресурсов (1 Углеводороды + 2 Редкоземельные + 2 Металла + 1 Уран) — ни в столице, ни на складе, ни на рынке." };
    this.commitSpend(playerId, plan);
    this.spendBuildingAction(playerId);
    this.productionUsedThisCycle.add(cycleKey);
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
  /** Обычный порог принятия резолюции — ≥60% суммарного населения. «Мировой лидер» — единственное
   * исключение (по прямому запросу — «для лидерства в ООН нужно набрать более 80% голосов»): раз эта
   * резолюция сама по себе даёт победу в партии (§13), для нее порог строго ВЫШЕ обычного и строго
   * БОЛЬШЕ (не ≥), не ≥60% — см. tallyOonResolution. */
  static OON_RESOLUTION_THRESHOLD_PERCENT = 60;
  static OON_WORLD_LEADER_THRESHOLD_PERCENT = 80;

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

  /** Интервал переизбрания генсека ООН (по прямому запросу — «выборы происходят каждые 5 циклов»
   * после первых). Первые выборы — не по интервалу, а сразу в момент постройки первого здания ООН
   * (см. buildBuilding). */
  static OON_ELECTION_INTERVAL_CYCLES = 5;

  /** Выборы генсека — настоящее голосование (по прямому баг-репорту: раньше подменялись мгновенным
   * сравнением населения двух кандидатов, без участия игроков — см. историю в ЦИВА-ЖУРНАЛ.md).
   * Переиспользуется и для первых выборов (при постройке первого здания ООН, см. buildBuilding), и
   * для периодических переизбраний каждые 5 циклов (см. resolveCycleBoundary/oonNextElectionCycle).
   * Если кандидата №2 физически ещё нет (некому противостоять) — генсеком становится кандидат №1 без
   * голосования, как и раньше. Если предыдущие выборы почему-то ещё не завершились — не открываем
   * поверх них новые (страхует периодическое переизбрание от повторного триггера). */
  private holdOonElection() {
    const c1 = this.oonCandidate1Id;
    if (c1 === null) return;
    const c2 = this.effectiveOonCandidate2Id();
    if (c2 === null) {
      this.oonSecretaryGeneralId = c1;
      this.announceOonSecretaryElected(c1);
      return;
    }
    if (this.pendingOonSecretaryElection) return;
    this.pendingOonSecretaryElection = { id: this.nextOonSecretaryElectionId++, candidate1Id: c1, candidate2Id: c2, votes: {} };
  }

  /** Оповещение о результате выборов генсека ООН (по прямому запросу — «выборы прошли, но кто
   * генсек? нужно объявлять всем (кроме AI)»; следом отдельно уточнено — «и голос каждого живого
   * игрока, голоса всех игроков даже AI, чтоб игрок видел кто за кого» — та же логика, что уже
   * действует для резолюций, см. `announceOonResolutionResult`) — тот же `pendingGlobalEvents`, что и
   * у катаклизмов (§11), просто без привязанных гексов: висит у КАЖДОГО живого игрока-человека
   * независимо, пока он сам не закроет («Понятно»); AI не оповещается (но его голос, как и голос
   * любого другого игрока, ВИДЕН в тексте — «не оповещается» относится к тому, кто ВИДИТ окно, не к
   * тому, чьи голоса в нём перечислены). Вызывается из ОБОИХ путей, которыми генсек может смениться —
   * `holdOonElection` (кандидата №2 физически нет, победа без голосования — `el` не передаётся,
   * голосования не было вовсе) и `tallyOonSecretaryElection` (настоящее голосование завершилось —
   * `el` передаётся, голоса перечисляются по ВСЕМ ещё живым игрокам, не только проголосовавшим:
   * выборы могли завершиться ДОСРОЧНО, до того как ответили все, см. tallyOonSecretaryElection). */
  private announceOonSecretaryElected(winnerId: number, el?: PendingOonSecretaryElection) {
    const name = this.players.find((p) => p.id === winnerId)?.name ?? `игрок ${winnerId}`;
    let votesText = "";
    if (el) {
      const eligible = this.players.filter((p) => !this.eliminatedPlayers.has(p.id));
      const votes = eligible
        .map((p) => {
          const candidateId = el.votes[p.id];
          if (candidateId === undefined) return `${p.name} — не голосовал`;
          const candidateName = this.players.find((c) => c.id === candidateId)?.name ?? `игрок ${candidateId}`;
          return `${p.name} — за ${candidateName}`;
        })
        .join("; ");
      votesText = ` Голоса: ${votes}.`;
    }
    this.pendingGlobalEvents.push({
      id: this.nextGlobalEventId++,
      kind: "oonSecretaryElected",
      sourcePlayerId: winnerId,
      description: `🏛 Выборы генерального секретаря ООН завершены — новый генеральный секретарь: ${name}.${votesText}`,
      hexes: [],
      dismissedBy: [],
    });
  }

  /** Голос за одного из двух кандидатов в текущих выборах генсека — вес = население голосующего, тот
   * же паттерн, что voteOonResolution/tallyOonResolution, но выбор бинарный (кандидат, не «за/против»). */
  voteOonSecretaryGeneral(playerId: number, candidateId: number): ActionResult {
    const el = this.pendingOonSecretaryElection;
    if (!el) return { ok: false, hint: "Сейчас не идут выборы генсека ООН." };
    if (playerId in el.votes) return { ok: false, hint: "Вы уже проголосовали." };
    if (candidateId !== el.candidate1Id && candidateId !== el.candidate2Id) return { ok: false, hint: "Голосовать можно только за одного из двух кандидатов." };
    el.votes[playerId] = candidateId;
    this.tallyOonSecretaryElection();
    return { ok: true };
  }

  /** Завершается, ТОЛЬКО когда проголосовали ВСЕ ещё активные игроки — ни один вес не «гарантирует»
   * исход раньше срока (по прямому запросу — живой баг-репорт: «что значит не успел проголосовать?
   * результат должен фиксироваться, когда проголосовали все, т.е. все совершили ход»). [ИСПРАВЛЕНО]
   * — раньше завершалось ДОСРОЧНО, как только у одного кандидата набиралось больше половины
   * суммарного веса всех активных (остальным математически не догнать), из-за чего часть игроков
   * (чей ход ещё не подошёл в этом круге) физически не успевала проголосовать вовсе — на реальной
   * партии выборы/резолюция завершались, а 2 из 6 живых игроков ни разу не увидели окно голосования.
   * Победитель — больший вес, ничья (в т.ч. если вообще никто не проголосовал) — кандидат №1, тот же
   * тай-брейк, что был у прежнего сравнения населения. */
  private tallyOonSecretaryElection() {
    const el = this.pendingOonSecretaryElection;
    if (!el) return;
    const eligible = this.players.filter((p) => !this.eliminatedPlayers.has(p.id));
    if (Object.keys(el.votes).length < eligible.length) return; // ждём, пока проголосуют все ещё активные
    const weightFor = (candidateId: number) =>
      Object.entries(el.votes)
        .filter(([, v]) => v === candidateId)
        .reduce((sum, [id]) => sum + this.totalPopulationOf(+id), 0);
    const w1 = weightFor(el.candidate1Id);
    const w2 = weightFor(el.candidate2Id);
    const winnerId = w2 > w1 ? el.candidate2Id : el.candidate1Id;
    this.oonSecretaryGeneralId = winnerId;
    this.pendingOonSecretaryElection = null;
    this.announceOonSecretaryElected(winnerId, el);
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
    // По прямому запросу — первая резолюция партии обязана быть «Выборы мирового лидера» (не выбор
    // генсека, системное правило), а одна и та же резолюция не может выноситься два раза подряд —
    // минимум одна другая между повторами (см. lastOonResolutionType, обновляется ниже независимо от
    // исхода голосования — сам факт «вынесения», не «принятия»).
    if (this.lastOonResolutionType === null && type !== "worldLeader") {
      return { ok: false, hint: "Первая резолюция партии обязана быть «Выборы мирового лидера»." };
    }
    if (type === this.lastOonResolutionType) {
      return { ok: false, hint: "Нельзя выносить одну и ту же резолюцию два раза подряд — нужна минимум одна другая между повторами." };
    }
    const gate = this.buildingActionGate(playerId);
    if (gate) return gate;
    if (this.money[playerId] < GameSession.OON_RESOLUTION_MONEY_COST) return { ok: false, hint: `Не хватает денег (нужно ${GameSession.OON_RESOLUTION_MONEY_COST} 💰).` };
    const paramsError = this.validateOonResolutionParams(type, params);
    if (paramsError) return { ok: false, hint: paramsError };
    this.spendBuildingAction(playerId);
    this.money[playerId] -= GameSession.OON_RESOLUTION_MONEY_COST;
    if (type === "worldLeader") {
      // Кандидаты фиксируются в момент выкладки (см. doc PendingOonResolution) — та же пара, что
      // выбрала бы прямо сейчас выборы генсека. Генсек голосует автоматически, ТОЛЬКО если он сам
      // один из двух кандидатов (иначе не за кого «автоматически» — оставляем его голос открытым,
      // как и у всех остальных); секретарь по построению почти всегда один из двух (см. doc), но
      // effectiveOonCandidate2Id динамический и в редком крае мог сместиться после его собственных
      // выборов — на этот случай явный голос не проставляем, а не гадаем.
      const candidate1Id = this.oonCandidate1Id!;
      const candidate2Id = this.effectiveOonCandidate2Id()!;
      const votes: Record<number, boolean> = playerId === candidate1Id ? { [playerId]: true } : playerId === candidate2Id ? { [playerId]: false } : {};
      this.pendingOonResolution = { id: this.nextOonResolutionId++, type, params, proposerId: playerId, votes, candidate1Id, candidate2Id };
    } else {
      this.pendingOonResolution = { id: this.nextOonResolutionId++, type, params, proposerId: playerId, votes: { [playerId]: true } };
    }
    this.lastOonResolutionType = type;
    const label = GameSession.OON_RESOLUTION_LABEL[type];
    this.tallyOonResolution();
    return { ok: true, hint: this.pendingOonResolution ? `Резолюция «${label}» вынесена на голосование.` : `Резолюция «${label}» принята сразу — вашего голоса «за» уже хватило.` };
  }

  private validateOonResolutionParams(type: OonResolutionType, params: OonResolutionParams): string | null {
    switch (type) {
      case "worldLeader":
        // Кандидаты — те же 2, что и на выборах генсека (см. doc PendingOonResolution) — не выбор
        // игрока-параметра, а автоматический расчёт; проверяем только что второй кандидат физически
        // существует (иначе выборы бессмысленны — единственный кандидат победил бы без единого
        // голоса, а Мировой лидер сам по себе даёт победу в партии, это не годится как «по умолчанию»).
        if (this.oonCandidate1Id === null || this.effectiveOonCandidate2Id() === null) {
          return "Нужен второй кандидат (игрок с зданием ООН или лидер по населению) — выборы мирового лидера пока не с кем проводить.";
        }
        return null;
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
    if (this.pendingOonResolution.type === "worldLeader") return { ok: false, hint: "«Мировой лидер» — выборы между двумя кандидатами, используйте voteOonWorldLeader." };
    if (playerId in this.pendingOonResolution.votes) return { ok: false, hint: "Вы уже проголосовали." };
    this.pendingOonResolution.votes[playerId] = inFavor;
    this.tallyOonResolution();
    return { ok: true };
  }

  /** Голос за одного из двух кандидатов на «Мирового лидера» — та же модель, что и у выборов
   * генсека (voteOonSecretaryGeneral): бинарный выбор, вес = население голосующего. `votes[playerId]`
   * хранит `true` за candidate1Id / `false` за candidate2Id (см. doc PendingOonResolution). */
  voteOonWorldLeader(playerId: number, candidateId: number): ActionResult {
    const res = this.pendingOonResolution;
    if (!res || res.type !== "worldLeader") return { ok: false, hint: "Сейчас не идут выборы мирового лидера." };
    if (playerId in res.votes) return { ok: false, hint: "Вы уже проголосовали." };
    if (candidateId !== res.candidate1Id && candidateId !== res.candidate2Id) return { ok: false, hint: "Голосовать можно только за одного из двух кандидатов." };
    res.votes[playerId] = candidateId === res.candidate1Id;
    this.tallyOonResolution();
    return { ok: true };
  }

  /** Порог принятия — ≥60% от суммарного населения ВСЕХ активных (не выбывших) игроков (вес голоса
   * каждого = его население, «за себя голосовать можно», не проголосовавшие/воздержавшиеся просто
   * не считаются «за»). **«Мировой лидер» — исключение**, строго БОЛЬШЕ 80%, не ≥60% (по прямому
   * запросу — «для лидерства в ООН нужно набрать более 80% голосов»; см. `OON_WORLD_LEADER_THRESHOLD_PERCENT`
   * — эта резолюция сама по себе даёт победу в партии, §13, порог для неё намеренно выше и строже:
   * `>`, не `>=`, ровно 80.0% не хватает). Завершается, ТОЛЬКО когда проголосовали ВСЕ ещё активные
   * игроки — по прямому запросу, живой баг-репорт: «что значит не успел проголосовать? результат
   * должен фиксироваться, когда проголосовали все, т.е. все совершили ход». [ИСПРАВЛЕНО] — раньше
   * принималась ДОСРОЧНО, как только порог набирался, не дожидаясь остальных (тот же класс бага, что
   * и в tallyOonSecretaryElection, см. её доку) — на реальной партии резолюция «Мировой лидер»
   * победила после голоса 3-го из 5 живых AI, 2 оставшихся так и не увидели окно голосования вовсе. */
  private tallyOonResolution() {
    const res = this.pendingOonResolution;
    if (!res) return;
    const eligible = this.players.filter((p) => !this.eliminatedPlayers.has(p.id));
    if (Object.keys(res.votes).length < eligible.length) return; // ждём, пока проголосуют все ещё активные
    const totalWeight = eligible.reduce((sum, p) => sum + this.totalPopulationOf(p.id), 0);
    const forWeight = Object.entries(res.votes)
      .filter(([, v]) => v)
      .reduce((sum, [id]) => sum + this.totalPopulationOf(+id), 0);
    // «Мировой лидер» — выбор МЕЖДУ ДВУМЯ кандидатами (candidate1Id получает true, candidate2Id —
    // false, см. doc voteOonWorldLeader), не «за резолюцию в целом» — оба веса вместе дают 100% от
    // totalWeight (голосование ждёт абсолютно всех, «против обоих» невозможно), так что победить
    // может ЛЮБОЙ из двух, если наберёт строго больше 80% — проверяем оба веса, не только forWeight.
    const accepted =
      totalWeight > 0 &&
      (res.type === "worldLeader"
        ? forWeight * 100 > totalWeight * GameSession.OON_WORLD_LEADER_THRESHOLD_PERCENT ||
          (totalWeight - forWeight) * 100 > totalWeight * GameSession.OON_WORLD_LEADER_THRESHOLD_PERCENT
        : forWeight * 100 >= totalWeight * GameSession.OON_RESOLUTION_THRESHOLD_PERCENT);
    if (accepted) this.applyOonResolutionEffect(res, forWeight, totalWeight);
    this.pendingOonResolution = null;
    this.announceOonResolutionResult(res, eligible, accepted);
  }

  /** Оповещение об итоге голосования по резолюции ООН — кто за что проголосовал и чем кончилось (по
   * прямому запросу — «нужно писать результаты голосования по резолюциям, включая мирового лидера,
   * кто за что проголосовал и каков итог»). Тот же `pendingGlobalEvents`, что у катаклизмов (§11) и
   * выборов генсека (§12) — окно «🌍 Глобальное событие» у каждого живого человека независимо, AI не
   * оповещается. Голоса перечисляются по ВСЕМ ещё живым игрокам (`eligible`), не только по
   * проголосовавшим — резолюция могла набрать порог ДОСРОЧНО (`tallyOonResolution`, ≥60% веса раньше,
   * чем ответили все), так что часть игроков законно остаётся «не голосовал». */
  private announceOonResolutionResult(res: PendingOonResolution, eligible: Player[], accepted: boolean) {
    const label = GameSession.OON_RESOLUTION_LABEL[res.type];
    const proposerName = this.players.find((p) => p.id === res.proposerId)?.name ?? `игрок ${res.proposerId}`;
    // «Мировой лидер» — голос это выбор МЕЖДУ ДВУМЯ кандидатами, не «за»/«против» самой резолюции
    // (см. voteOonWorldLeader) — показываем имя выбранного кандидата, тем же паттерном, что и у
    // announceOonSecretaryElected.
    const candidateName = (id: number | undefined) => (id !== undefined ? this.players.find((p) => p.id === id)?.name ?? `игрок ${id}` : "?");
    const votesText = eligible
      .map((p) => {
        const v = res.votes[p.id];
        if (v === undefined) return `${p.name} — не голосовал`;
        if (res.type === "worldLeader") return `${p.name} — за ${candidateName(v ? res.candidate1Id : res.candidate2Id)}`;
        return `${p.name} — ${v ? "за" : "против"}`;
      })
      .join("; ");
    this.pendingGlobalEvents.push({
      id: this.nextGlobalEventId++,
      kind: "oonResolutionResult",
      sourcePlayerId: res.proposerId,
      description: `🏛 Резолюция ООН «${label}» (внёс ${proposerName}) — ${accepted ? "ПРИНЯТА" : "ОТКЛОНЕНА"}. Голоса: ${votesText}.`,
      hexes: [],
      dismissedBy: [],
    });
  }

  private applyOonResolutionEffect(res: PendingOonResolution, forWeight?: number, totalWeight?: number) {
    switch (res.type) {
      case "openTrade":
        this.oonOpenTradeActive = true;
        break;
      case "worldLeader": {
        // 🏆 Путь победы «ООН» (ТЗ §15.2 п.1, переработано по прямому запросу — «выдвигая эту
        // резолюцию игроки голосуют за двух лидеров, набравший более 80% побеждает») — победитель —
        // тот из двух кандидатов (candidate1Id/candidate2Id), чей вес голосов больше; вызывается
        // только когда tallyOonResolution уже подтвердил, что этот вес строго больше 80%.
        const winnerId = (forWeight ?? 0) > (totalWeight ?? 0) - (forWeight ?? 0) ? res.candidate1Id : res.candidate2Id;
        if (winnerId !== undefined) this.declareVictory(winnerId, "Дипломатическая победа — резолюция Совета ООН «Мировой лидер»");
        break;
      }
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
    // «Рыцарство» — по прямому уточнению «+1 урона всем штурмовым и мобильным, а не только
    // мобильным» (было только mobile). Первооткрывателю, постоянно до конца партии.
    if ((u.category === "mobile" || u.category === "assault") && this.techDiscoverer["Рыцарство"] === u.playerId) stats.attack += 1;
    // «Сталь» — по прямому запросу заменено с бонуса дальности на бонус урона артиллерии и кораблям.
    if ((u.category === "ranged" || u.category === "ship") && this.techDiscoverer["Сталь"] === u.playerId) stats.attack += 1;
    // «Порох» — по прямому запросу, первооткрывателю: +1 дальность атаки артиллерией («Дальняя атака»).
    if (u.category === "ranged" && this.techDiscoverer["Порох"] === u.playerId) stats.attackRange += 1;
    // «Двигатель внутреннего сгорания» — по прямому запросу, первооткрывателю: +1 скорость ВСЕМ
    // своим юнитам (все категории), постоянно до конца партии.
    if (this.techDiscoverer["Двигатель внутреннего сгорания"] === u.playerId) stats.moveRange += 1;
    // «Кибернетика» — по прямому запросу («это плюсом к тому эффекту что уже есть»), для ЛЮБОГО
    // исследовавшего (не только первооткрывателя): +1 радиус поддержки.
    if (this.researchedTechs[u.playerId].has("Кибернетика")) stats.supportRadius += 1;
    // «Дредноуты» (была «Ядерный синтез», по прямому запросу переименована) — для ЛЮБОГО
    // исследовавшего: дальность атаки кораблей увеличена до 2 (было 1 у всех эпох).
    if (u.category === "ship" && this.researchedTechs[u.playerId].has("Дредноуты")) stats.attackRange = Math.max(stats.attackRange, 2);
    // «Нарезное оружие» — по прямому запросу, для ЛЮБОГО исследовавшего: +1 урон юнитам поддержки.
    if (u.category === "support" && this.researchedTechs[u.playerId].has("Нарезное оружие")) stats.attack += 1;
    // «Железные дороги» — по прямому запросу, для ЛЮБОГО исследовавшего: +1 скорость перемещения
    // сухопутным юнитам (не кораблям) на своей территории. Считается по ТЕКУЩЕЙ позиции юнита (не
    // кораблям) в начале расчёта хода — не пересчитывается по ходу самого пути, если юнит выходит за
    // пределы территории посреди маршрута (упрощение — полноценный учёт потребовал бы менять цену
    // каждого шага пути в зависимости от территории, см. computeUnitPath).
    if (u.category !== "ship" && this.researchedTechs[u.playerId].has("Железные дороги") && this.territoryOwnerOf(u.col, u.row) === u.playerId) {
      stats.moveRange += 1;
    }
    // Выход из города — по прямому запросу («юнитам выходящим с города дай бонус +1 скорости, если
    // они оттуда начали ход — проход мимо не даёт — для рассеивания и контратак, небольшой бонус
    // стороне обороны») — +1 скорость, если юнит СЕЙЧАС стоит на гексе города (своего или чужого —
    // не уточнено чьего именно). Тот же приём, что и «Железные дороги» выше: считается по ТЕКУЩЕЙ
    // позиции в момент расчёта бюджета хода (начало движения/продолжения), не по всему пути — юнит,
    // просто проходящий ЧЕРЕЗ город транзитом (в середине уже начатого маршрута), к этому моменту
    // уже не стоит на гексе города при следующем пересчёте бюджета, бонус не получает повторно.
    if (this.cityAt(u.col, u.row)) stats.moveRange += 1;
    // «Учёный», выбор 2 из 4 эндгейм-эффектов (по прямому запросу, см. useScientistEndgameEffect) —
    // +1 урона и +1HP ВСЕМ своим юнитам, постоянно до конца партии.
    if (this.scientistCombatBonusPlayers.has(u.playerId)) {
      stats.attack += 1;
      stats.hp += 1;
    }
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
    if (this.isSeaTile(col, row) && this.units.some((u) => u.category === "ship" && u.col === col && u.row === row)) return true;
    // «Робототехника» — по прямому запросу, для ЛЮБОГО исследовавшего: штурмовые и мобильные юниты
    // могут пересекать пролив в 1 водный гекс (без корабля), если этот гекс прибрежный (граничит с
    // сушей хотя бы с одной стороны — упрощение точного «ровно 1 гекс воды до земли» до уже
    // существующего понятия isCoastalSeaTile, не пересчитывая весь путь заново здесь).
    if (
      (mover.category === "assault" || mover.category === "mobile") &&
      this.researchedTechs[mover.playerId].has("Робототехника") &&
      this.isCoastalSeaTile(col, row)
    ) {
      return true;
    }
    return false;
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
        const siegeBroken = this.citySiegeBuffer.has(city.id) && this.citySiegeBuffer.get(city.id)! <= 0;
        if (!this.canTraverseTerritoryOf(mover.playerId, city.playerId) && !siegeBroken) return false;
      } else if (isDestination) {
        // По прямому запросу — гарнизон СВОЕГО города ограничен CITY_GARRISON_CAP юнитами, тот же
        // лимит, что и на любом обычном гексе карты чуть ниже (`occupants.length >= 2`) — раньше
        // городские клетки были единственным исключением без проверки числа вовсе (см. doc
        // CITY_GARRISON_CAP). Только для точки ОСТАНОВКИ — транзит через свой же город не создаёт
        // постоянного стека, как и везде по этой функции.
        const occupants = this.unitsAt(col, row);
        if (occupants.length >= GameSession.CITY_GARRISON_CAP && !occupants.some((u) => u.id === mover.id)) return false;
      }
      return true;
    }
    // [ИСПРАВЛЕНО, живой баг-репорт — «юниты AI ходят и плавают по территориям других AI и игрока
    // без соглашения об открытых границах, если конечная точка маршрута нейтральная или союзная»] —
    // раньше территория проверялась ТОЛЬКО на конечной точке всего приказа (commandUnit) и при входе
    // в чужой ГОРОД (ветка выше); открытая (не городская) чужая территория на ПРОМЕЖУТОЧНЫХ шагах
    // маршрута не проверялась вовсе — юнит мог пройти транзитом через целый чужой регион без единого
    // договора, если сама цель маршрута лежала уже за его пределами (своя/нейтральная/третья
    // сторона). canEnterHex вызывается на КАЖДОМ шаге (см. computeUnitPath/walkUnitAlongOrder), так
    // что этой одной проверки достаточно, чтобы закрыть транзит целиком, не только конечную точку.
    // «Нейтральные воды» (ООН, ТЗ §15.3) — то же исключение, что и раньше стояло только на конечной
    // точке приказа (commandUnit) — открытое море проходимо всем независимо от границ, чужие ГОРОДА
    // это не касается (та ветка выше, до этой проверки, уже не пропустила бы её сюда без разрешения).
    const neutralWatersBypass = this.oonNeutralWatersActive && this.isSeaTile(col, row);
    const territoryOwner = neutralWatersBypass ? null : this.territoryOwnerOf(col, row);
    if (territoryOwner !== null && !this.canTraverseTerritoryOf(mover.playerId, territoryOwner)) return false;
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

  /** Живой баг-репорт (по прямому уточнению) — «у оранжевого с зелёным нет открытой границы, но
   * корабль стоит [в его регионе] — нельзя строить/оканчивать ход на чужой территории без
   * соглашения»: корабль СПАВНИТСЯ рядом с городом при постройке (не «идёт» туда обычным приказом),
   * поэтому обычная проверка территории в `commandUnit` (`territoryOwnerOf`/«Открытые границы»/война)
   * тут просто не применяется вовсе — если у города-строителя рядом с морем оказывалась чужая
   * территория без соглашения, корабль преспокойно там материализовывался. Теперь кандидаты СНАЧАЛА
   * фильтруются по тому же правилу, что и обычный вход на клетку (ничья/своя/с «Открытыми границами»/
   * уже идёт война — можно; чужая без всего этого — нельзя); годных вообще не осталось — откат на
   * старый (без территориального фильтра) список, лучше поставить корабль хоть куда-то официально
   * своим/ничьим морем, чем не построить вовсе (тот же принцип «лучше не блокировать насмерть», что
   * и everywhere в приоритетах бота) — на практике это тупиковый край: город с морем ТОЛЬКО в чужой
   * акватории без единого нейтрального/своего гекса рядом. */
  private shipSpawnHex(city: City): { col: number; row: number } | null {
    // Живой баг-репорт (по прямому уточнению) — «у жёлтого два корабля в 1 клетке, это запрещено —
    // 2 юнита в 1 клетке разрешено только для городов и если корабль везёт юнита (юнит погружен на
    // борт) или это юниты разных игроков»: `canEnterHex` (реальное перемещение через `commandUnit`)
    // это уже и так соблюдает — `occupants.some(u => u.playerId === mover.playerId)` блокирует вход
    // НА клетку, где уже стоит СВОЙ юнит, вне города, кроме случая посадки (обрабатывается отдельной
    // веткой ДЛЯ НЕ-корабля). Спавн при постройке этой же проверки не делал вовсе — старый фильтр
    // `unitsAt < 2` пропускал клетку, даже если единственный на ней уже занятый слот — мой же
    // собственный, ранее построенный корабль (что и произошло: 2-й корабль спавнился на клетке 1-го).
    const all = this.hexNeighborsGameplay(city.col, city.row)
      .filter(([nc, nr]) => this.isSeaTile(nc, nr) && !this.units.some((u) => u.playerId === city.playerId && u.col === nc && u.row === nr))
      .map(([col, row]) => ({ col, row }));
    if (!all.length) return null;
    const allowedByTerritory = ({ col, row }: { col: number; row: number }) => {
      const owner = this.territoryOwnerOf(col, row);
      return owner === null || this.canTraverseTerritoryOf(city.playerId, owner);
    };
    const candidates = all.filter(allowedByTerritory);
    const pool = candidates.length ? candidates : all;
    const shoreCount = (c: number, r: number) => this.hexNeighborsGameplay(c, r).filter(([nc, nr]) => this.isLandTile(nc, nr)).length;
    pool.sort((a, b) => shoreCount(b.col, b.row) - shoreCount(a.col, a.row));
    return pool[0];
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

  /** Разрешение зайти на чужую территорию — ровно 3 условия (по прямому запросу, живой баг-репорт
   * «юниты ходят и плавают по чужим территориям без соглашения об открытых границах, если конечная
   * точка маршрута нейтральная/своя — движение возможно только при открытых границах, сюзерену по
   * территории вассала, или в случае войны»): «Открытые границы», «Вассалитет» (в этой модели —
   * симметричное соглашение без хранимого направления сюзерен/вассал, см. ЦИВА-СПРАВОЧНИК §8.2 —
   * упрощённо считается взаимным пропуском для обеих сторон, а не только сюзерена), или уже идущая
   * война. Общий источник истины для ЛЮБОЙ проверки территории при движении — раньше она стояла ТОЛЬКО
   * на конечной точке приказа (commandUnit) и на входе в чужой ГОРОД (canEnterHex), а промежуточные
   * шаги маршрута по открытой чужой территории вообще не проверялись — юнит мог пройти транзитом через
   * чужой регион без единого договора, если сама цель маршрута лежала уже за его пределами. */
  private canTraverseTerritoryOf(moverId: number, ownerId: number): boolean {
    if (moverId === ownerId) return true;
    const rel = this.relationOf(moverId, ownerId);
    return rel.war || rel.agreements.has("openBorders") || rel.agreements.has("vassalage");
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
  /** Защита МЕСТНОСТИ (гекс) — по прямому запросу: привязана только к клетке, не к конкретному
   * юниту. Ни базовая защита юнита (defenseBonus), ни личная команда «Оборона» сюда не входят —
   * это отдельный, персональный бонус (см. unitDefendBase/peekDefendBuffer ниже). Задумано для
   * будущей сессии с одновременными ходами (WeGo) — юнит может зайти на клетку или уйти с неё прямо
   * посреди «хода», а местность при этом одна на всех, кто там окажется, до конца цикла. `context`
   * нужен только чтобы разрешить владельческие бонусы (своя территория/форт/дорога) — они одинаковы
   * для любого юнита ОДНОГО и того же игрока на этой клетке, что и делает эту защиту общей «на
   * гекс», а не персональной. */
  /** Публична (была private) с прямого запроса — «выводить юнита из переполненного гарнизона на
   * самый защищённый ближайший свободный гекс»: `bot.ts` переиспользует эту же формулу для оценки
   * кандидатов на эвакуацию, вместо того чтобы дублировать её отдельно. */
  computeFreshHexTerrainDefense(col: number, row: number, context: { playerId: number }): number {
    const tile = this.doc.get(col, row);
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
    return Math.max(0, bonus);
  }
  /** Личный бонус «Обороны» — плоское число единиц защиты (не множитель, по прямому запросу
   * «защита при уходе в оборону теперь не удвоение, а конкретный плюс к защите»), растёт по эпохам
   * у КАЖДОЙ категории отдельно (units.ts, лист 6), а не только у «Оборонительных», как раньше —
   * это размер ЛИЧНОГО бонуса «Обороны» (см. peekDefendBuffer), не часть защиты местности. */
  private unitDefendBase(u: UnitInstance): number {
    return this.unitStats(u).defenseBonus;
  }
  /** Базовая «сила гарнизона» города — по прямому уточнению это НЕ отдельный юнит: гарнизон города
   * равен его населению. Больше население — крепче держится город. По прямому запросу — местность
   * (bonus) здесь БЕЗ удвоения (та же логика, что и computeFreshHexTerrainDefense — она привязана к
   * клетке, не к гарнизону); удваивается только сама база гарнизона (город «всегда обороняется»,
   * тот же смысл, что личный бонус «Обороны» у обычного юнита, см. unitDefendBase). */
  private cityGarrisonDefense(city: City): number {
    const tile = this.doc.get(city.col, city.row);
    const base = Math.max(1, city.population);
    let bonus = 1; // сам факт города
    if (tile.terrain === "hills") bonus += 1;
    if (tile.terrain === "mountains") bonus += 2;
    if (this.territoryOwnerOf(city.col, city.row) === city.playerId) bonus += 1;
    if (isOwnedBy(this.buildingOwners, "fort", city.playerId)) bonus += this.maxEligibleEpoch(city.playerId);
    if (this.ownRoadHex(city.playerId, city.col, city.row)) bonus += 1;
    return bonus + base * 2;
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
   * выбывания, что и у военного захвата (см. resolveUnitMovementForCycle), просто без движения юнита.
   * `cause` — по прямому запросу (отношения AI, фактор 8: «захват города −10» / «передача +10»):
   * захват войной бьёт по мнению ЖЕРТВЫ (`oldOwnerId`) об агрессоре (`newOwnerId`); мирная передача
   * поднимает мнение ПОЛУЧИВШЕГО (`newOwnerId`) о дарителе (`oldOwnerId`) — единственная точка, где
   * ОБА пути реально сходятся (см. вызовы ниже — захват из walkUnitAlongOrder, передача из
   * applyProposalTerms), поэтому фактор считается прямо здесь, а не в каждом вызывающем месте. */
  private transferCity(city: City, newOwnerId: number, cause: "conquest" | "deal") {
    const oldOwnerId = city.playerId;
    const wasCapital = city.isCapital;
    city.playerId = newOwnerId;
    city.isCapital = false;
    this.citySiegeBuffer.delete(city.id);
    this.handleCityLoss(oldOwnerId, wasCapital);
    this.checkTerritorialVictory(newOwnerId);
    if (cause === "conquest") {
      this.adjustRelationScore(oldOwnerId, newOwnerId, -10, "захват города");
      // Журнал военных потерь городов (по прямому запросу §3.1/§2.1, bot.ts: «вернуть захваченный
      // город» — приоритет фронта у наступления и у резервов обороны) — только `conquest` (мирная
      // передача сделкой — не повод отбивать город назад силой). Обрезается по возрасту в
      // `resolveCycleBoundary` (см. её вызов ниже), не растёт неограниченно за долгую партию.
      this.recentCityLosses.push({ cityId: city.id, col: city.col, row: city.row, regionCol: city.regionCol, regionRow: city.regionRow, oldOwnerId, newOwnerId, cycle: this.cyclesElapsed });
      this.logEvent(`Город: ${this.playerName(newOwnerId)} захватил город (id ${city.id}) у ${this.playerName(oldOwnerId)}.`);
    } else {
      this.adjustRelationScore(newOwnerId, oldOwnerId, 10, "передача города");
      this.logEvent(`Город: ${this.playerName(oldOwnerId)} передал город (id ${city.id}) игроку ${this.playerName(newOwnerId)} по соглашению.`);
    }
  }
  /** BFS расширяющимися кольцами вокруг юнита среди РЕАЛЬНО проходимых для него гексов
   * (`canEnterHex`/`unitPassable` — та же связность, что и настоящее движение, путь туда гарантированно
   * существует), выбирает максимально защищённый местностью (`computeFreshHexTerrainDefense`) среди
   * кандидатов ближайшего кольца, где нашёлся хоть один; при равенстве — первый найденный. Тот же
   * алгоритм, что `bot.ts: findEvictionHex` (эвакуация переполненного гарнизона города) — здесь
   * отдельная копия, т.к. должен жить в движке и срабатывать САМ, не только по инициативе бота (см.
   * `evictTrespassersAfterPeace` ниже). `null` — в пределах `MAX_EVICTION_RING` колец решительно некуда
   * деться (крайний случай, оставляем юнита на месте, не ломая партию). */
  private static readonly MAX_EVICTION_RING = 6;
  private findFreeNonForeignHex(unit: UnitInstance): { col: number; row: number } | null {
    const seen = new Set<string>([`${unit.col},${unit.row}`]);
    let frontier: [number, number][] = [[unit.col, unit.row]];
    for (let ring = 0; ring < GameSession.MAX_EVICTION_RING && frontier.length; ring++) {
      const next: [number, number][] = [];
      const candidates: { col: number; row: number; defense: number }[] = [];
      for (const [c, r] of frontier) {
        for (const [nc, nr] of this.hexNeighborsGameplay(c, r)) {
          const key = `${nc},${nr}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!this.unitPassable(unit, nc, nr) || !this.canEnterHex(unit, nc, nr, false)) continue;
          next.push([nc, nr]);
          if (this.canEnterHex(unit, nc, nr, true)) {
            candidates.push({ col: nc, row: nr, defense: this.computeFreshHexTerrainDefense(nc, nr, unit) });
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
  /** По прямому запросу — «в случае перемирия если есть юниты на чужой территории оттесни их в
   * свободные гексы доступные для размещения ближайшие... в случае мира нужно перебрасывать с бывшей
   * вражеской территории бесплатно на ближайшую не вражескую»: как только между `aId` и `bId`
   * заключается мир (единственный вызов — из `applyProposalTerms`, term.kind==="peace", и ТОЛЬКО когда
   * стороны реально были в состоянии войны — мир без войны ничего не меняет территориально), любой
   * юнит ОДНОЙ стороны, оставшийся на территории ДРУГОЙ (война давала право там находиться —
   * `canTraverseTerritoryOf` — мир его забирает, если нет отдельных «Открытых границ»/«Вассалитета»),
   * принудительно и БЕСПЛАТНО (в отличие от обычного приказа движения — без 1💰, это не действие
   * игрока/бота, а последствие только что заключённого мира) переносится на ближайший гекс, куда
   * реально может попасть, не нарушая территориальных правил (`findFreeNonForeignHex` выше). Юнита,
   * для которого такого гекса не нашлось — оставляем на месте (тот же принцип «лучше не блокировать
   * насмерть», что и everywhere в похожих ситуациях, например `bot.ts: shipSpawnHex`). */
  private evictTrespassersAfterPeace(aId: number, bId: number) {
    for (const [moverId, ownerId] of [
      [aId, bId],
      [bId, aId],
    ] as const) {
      for (const unit of this.units) {
        if (unit.playerId !== moverId) continue;
        if (this.territoryOwnerOf(unit.col, unit.row) !== ownerId) continue;
        if (this.canTraverseTerritoryOf(moverId, ownerId)) continue; // Открытые границы/Вассалитет — эвакуация не нужна
        const dest = this.findFreeNonForeignHex(unit);
        if (!dest) continue;
        const from = { col: unit.col, row: unit.row };
        unit.col = dest.col;
        unit.row = dest.row;
        this.logEvent(
          `Юнит: у ${this.playerName(moverId)} юнит (${GameSession.UNIT_CATEGORY_LABEL[unit.category]}) переброшен с территории ${this.playerName(
            ownerId
          )} (${from.col},${from.row}) на (${dest.col},${dest.row}) — заключён мир, оставаться там больше нельзя.`
        );
      }
    }
  }
  private peekHexDefense(u: UnitInstance): number {
    const key = this.hexKey(u.col, u.row);
    if (!this.hexDefense.has(key)) this.hexDefense.set(key, this.computeFreshHexTerrainDefense(u.col, u.row, u));
    return this.hexDefense.get(key)!;
  }
  /** Личный бонус «Обороны» (по прямому запросу) — 0, если юнит сейчас не обороняется (урон идёт
   * от местности сразу в HP, минуя эту шкалу). Лениво считается и депletируется ТОЧНО как местность,
   * только ключ — id юнита, не гекс: другой юнит на той же клетке, не отдавший команду «Оборона»,
   * этот бонус не получает вовсе. */
  private peekDefendBuffer(u: UnitInstance): number {
    if (!u.defending) return 0;
    if (!this.unitDefendBuffer.has(u.id)) this.unitDefendBuffer.set(u.id, this.unitDefendBase(u));
    return this.unitDefendBuffer.get(u.id)!;
  }
  unitTotalDefense(u: UnitInstance): number {
    return this.peekHexDefense(u) + this.peekDefendBuffer(u);
  }
  /** По прямому запросу — три уровня поглощения урона по порядку: 1) местность (гекс, общая для
   * всех на клетке), 2) личный бонус «Обороны» (только у обороняющегося юнита), 3) здоровье.
   * `doubleDefenseDamage` (Дальняя атака/артиллерия) удваивает ТОЛЬКО списание с этих двух защитных
   * шкал (сначала местность, остаток — с личного бонуса), а не то, что доходит до HP: overflow в HP
   * считается от НЕудвоенного `amount` против суммы ОБОИХ буферов ДО этого удара — если их вместе
   * хватило бы пережить обычный (неудвоенный) урон, HP не трогается вовсе, даже если удвоенное
   * списание уже обнулило оба буфера подчистую (защита ломается быстрее, но урон в HP не растёт). */
  private applyDamage(target: UnitInstance, amount: number, doubleDefenseDamage = false): number {
    const hexKey = this.hexKey(target.col, target.row);
    const terrainBefore = this.hexDefense.has(hexKey) ? this.hexDefense.get(hexKey)! : this.computeFreshHexTerrainDefense(target.col, target.row, target);
    const defendBefore = this.peekDefendBuffer(target);
    const strip = doubleDefenseDamage ? amount * 2 : amount;
    const terrainStrip = Math.min(terrainBefore, strip);
    this.hexDefense.set(hexKey, terrainBefore - terrainStrip);
    if (target.defending) this.unitDefendBuffer.set(target.id, Math.max(0, defendBefore - (strip - terrainStrip)));
    const overflow = Math.max(0, amount - (terrainBefore + defendBefore));
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
    for (const u of this.units) {
      if (deadIds.has(u.id)) this.logEvent(`Юнит: у ${this.playerName(u.playerId)} уничтожен юнит (${GameSession.UNIT_CATEGORY_LABEL[u.category]}) на (${u.col},${u.row}).`);
    }
    this.units = this.units.filter((u) => !deadIds.has(u.id));
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
   * - Увеличивает урон Штурмовых, Мобильных И Оборонительных (`u`, кому ищем поддержку) — по прямому
   *   уточнению живой баг-репорт: «Оборонительные — тоже пехота, им тоже должна оказываться
   *   поддержка» (раньше поддержку получали только Штурмовые/Мобильные). Сама Поддержка не бьёт,
   *   именно баф урона; корабли и Дальняя атака поддержку по-прежнему не получают вообще.
   * - Считает ВСЕХ подходящих союзников поддержки в радиусе разом (не только ближайшего одного) —
   *   каждый даёт +1, суммарно.
   * - Один и тот же юнит поддержки может поддержать сколько угодно раз за цикл — лимита «раз за
   *   цикл» больше нет (`supportUsedThisCycle` снят как понятие).
   */
  private supportersFor(u: UnitInstance): UnitInstance[] {
    if (u.category !== "assault" && u.category !== "mobile" && u.category !== "defense") return [];
    return this.units.filter((s) => {
      if (s.playerId !== u.playerId || s.id === u.id || this.isAboardShip(s)) return false;
      const stats = this.unitStats(s);
      if (stats.supportBonus <= 0) return false;
      const d = this.hexDistance(s.col, s.row, u.col, u.row, stats.supportRadius + 1);
      return d <= stats.supportRadius;
    });
  }
  /** Сумма личных бонусов поддержки (units.ts UnitStats.supportBonus, растёт по эпохам, лист 6) —
   * раньше эту роль играло просто `supporters.length` (безопасно, пока supportBonus был константой
   * 1 у всех эпох), теперь у каждого поддерживающего юнита свой вес, который надо честно сложить. */
  private supportBonusSum(supporters: UnitInstance[]): number {
    return supporters.reduce((sum, s) => sum + this.unitStats(s).supportBonus, 0);
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

  /** Превью исхода боя ДО клика (по прямому запросу — «при выделенном своём юните и наведении на
   * противника показывать исход боя: сколько из скольки защиты снимется цифрами, отступит ли юнит,
   * закончится ли ничьей или кто-то погибнет») — тот же приём, что и `simulateAttackOutcome` в
   * bot.ts: клонирует сессию и реально проигрывает `commandUnit` на клоне (бой детерминирован, без
   * `rng()` — см. `resolveCombat`), значит превью НИКОГДА не разойдётся с настоящим исходом. Только
   * для целей-юнитов (город — отдельная механика буфера осады, без отступления/гибели самого юнита,
   * не показатель для этого превью). Чистое чтение — как и `previewUnitPath`, состояние не мутирует. */
  previewAttackOutcome(
    playerId: number,
    unitId: number,
    col: number,
    row: number
  ): {
    defender: { defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number; died: boolean; retreated: boolean };
    attacker?: { defenseBefore: number; defenseAfter: number; hpBefore: number; hpAfter: number; hpMax: number; died: boolean };
  } | null {
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return null;
    const defenders = this.unitsAt(col, row).filter((u) => u.playerId !== playerId);
    if (!defenders.length) return null;
    const targetUnit = defenders.slice().sort((a, b) => b.hp - a.hp)[0];
    const clone = GameSession.fromJSON(this.id, structuredClone(this.toJSON()));
    const result = clone.dispatch("commandUnit", playerId, { unitId, col, row });
    const hit = result.combatAnim?.hits.find((h): h is Extract<typeof h, { kind: "unit" }> => h.kind === "unit");
    if (!result.ok || !hit) return null;
    const survivor = clone.units.find((u) => u.id === targetUnit.id);
    const retreated = !!survivor && (survivor.col !== col || survivor.row !== row);
    const counter = result.combatAnim!.counterOnAttacker;
    return {
      defender: { defenseBefore: hit.defenseBefore, defenseAfter: hit.defenseAfter, hpBefore: hit.hpBefore, hpAfter: hit.hpAfter, hpMax: hit.hpMax, died: hit.hpAfter <= 0, retreated },
      attacker: counter ? { ...counter, died: counter.hpAfter <= 0 } : undefined,
    };
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

  /** Ищет кратчайший (по стоимости хода — местность/дороги/горы) путь от юнита до ЛЮБОГО гекса в
   * пределах `range` гексов (топологически, `hexDistance`) от цели — используется автоподходом на
   * дистанцию удара (`commandUnit`, по прямому запросу — «юнит сам подходит на дистанцию атаки»).
   * Тот же алгоритм Dijkstra, что и `computeUnitPath` (те же `hexNeighborsGameplay`/`unitPassable`/
   * `canEnterHex`/`isMountainLandingBlocked`/стоимости шага — учитывает и оптимальный маршрут по
   * местности, и блокировку занятыми клетками), только критерий остановки другой: не «дошли до
   * конкретного toCol/toRow», а «извлечённый из очереди гекс уже в радиусе `range` от цели». Уже
   * стоит в радиусе прямо сейчас — возвращает нулевой путь сразу, без поиска. Кандидат на радиус
   * дополнительно проверяется `canEnterHex(..., true)` (полноценная точка ОСТАНОВКИ — нельзя
   * подойти вплотную на клетку своего же юнита, даже если через неё можно было бы транзитом пройти
   * дальше) — если ближайший по расстоянию гекс в радиусе занят своим юнитом, поиск просто
   * продолжается дальше, к следующему по стоимости кандидату. */
  private computeApproachPath(mover: UnitInstance, targetCol: number, targetRow: number, range: number, maxSearchCost = 60): { path: { col: number; row: number }[]; cost: number } | null {
    const withinRange = (c: number, r: number) => this.hexDistance(c, r, targetCol, targetRow, range + 1) <= range;
    if (withinRange(mover.col, mover.row)) return { path: [], cost: 0 };

    const startKey = `${mover.col},${mover.row}`;
    const dist = new Map<string, number>([[startKey, 0]]);
    const parent = new Map<string, string | null>([[startKey, null]]);
    const frontier: string[] = [startKey];
    let foundKey: string | null = null;
    while (frontier.length) {
      frontier.sort((a, b) => dist.get(a)! - dist.get(b)!);
      const key = frontier.shift()!;
      const [kc, kr] = key.split(",").map(Number);
      if (key !== startKey && withinRange(kc, kr) && this.canEnterHex(mover, kc, kr, true)) {
        foundKey = key;
        break;
      }
      const d = dist.get(key)!;
      if (d > maxSearchCost) continue;
      for (const [nc, nr] of this.hexNeighborsGameplay(kc, kr)) {
        const nk = `${nc},${nr}`;
        if (!this.unitPassable(mover, nc, nr)) continue;
        // Транзитом (isDestination=false) — тот же приём, что и в computeUnitPath: узел может
        // пригодиться просто как проход к другому, более удачному кандидату дальше, даже если сам
        // занят своим юнитом; полноценная проверка "можно ли здесь ОСТАНОВИТЬСЯ" — выше, в момент
        // извлечения узла из очереди, не здесь.
        if (!this.canEnterHex(mover, nc, nr, false)) continue;
        if (this.isMountainLandingBlocked(mover, kc, kr, nc, nr)) continue;
        const stepCost = this.isRoadHex(nc, nr) ? 0.5 : this.isBarrierMountain(nc, nr) ? this.unitStats(mover).moveRange : this.terrainMoveCost(nc, nr);
        const nd = d + stepCost;
        if (!dist.has(nk) || nd < dist.get(nk)!) {
          dist.set(nk, nd);
          parent.set(nk, key);
          if (!frontier.includes(nk)) frontier.push(nk);
        }
      }
    }
    if (!foundKey) return null;
    const path: { col: number; row: number }[] = [];
    let k: string | null = foundKey;
    while (k && k !== startKey) {
      const [c, r] = k.split(",").map(Number);
      path.unshift({ col: c, row: r });
      k = parent.get(k) ?? null;
    }
    return { path, cost: dist.get(foundKey)! };
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
      const stepCost = this.isRoadHex(next.col, next.row) ? 0.5 : this.isBarrierMountain(next.col, next.row) ? budget : this.terrainMoveCost(next.col, next.row);
      const shortOnBudget = stepCost > budget;
      // isDestination — тот же смысл, что в computeUnitPath: «точка остановки», где юнит реально
      // задержится (а не просто пройдёт транзитом в том же вызове) — запрещает вставать на клетку
      // своего же юнита. [ИСПРАВЛЕНО, по прямому запросу — «юнит может завершить движение в клетке,
      // где стоит уже юнит, если его маршрут не закончен, такого быть не должно»] — раньше здесь
      // проверялся только литеральный последний шаг ВСЕГО маршрута; если бюджета хода на этот ЦИКЛ
      // не хватало, юнит останавливался ДОСРОЧНО (маршрут продолжится на границе следующего цикла), но
      // формально это «не последний шаг» — правило стека своих юнитов ошибочно не применялось, юнит
      // мог зависнуть на клетке своего же другого юнита до следующего цикла. «Бюджет заканчивается
      // именно на этом шаге» — НЕ только `shortOnBudget` (шаг дороже остатка), но и случай, когда шаг
      // ровно ДОЕДАЕТ остаток до нуля целыми шагами (частый случай — дороги по 0.5, бюджет кратен
      // 0.5) — тогда `shortOnBudget` ложно, а юнит всё равно останавливается здесь до конца цикла,
      // поскольку `budget` дальше 0. Проверяем остаток ПОСЛЕ списания этого шага, а не факт нехватки
      // именно этого шага.
      const budgetAfterStep = shortOnBudget ? 0 : budget - stepCost;
      const willRestHere = budgetAfterStep <= 0 || u.moveOrder.nextIndex === u.moveOrder.path.length - 1;
      if (!this.unitPassable(u, next.col, next.row) || !this.canEnterHex(u, next.col, next.row, willRestHere) || this.isMountainLandingBlocked(u, u.col, u.row, next.col, next.row)) {
        u.moveOrder = null;
        break;
      }
      const spent = shortOnBudget ? budget : stepCost;
      budget = budgetAfterStep;
      this.moveBudgetUsedThisCycle.set(u.id, (this.moveBudgetUsedThisCycle.get(u.id) ?? 0) + spent);
      const fromCol = u.col;
      const fromRow = u.row;
      u.col = next.col;
      u.row = next.row;
      u.moveOrder.nextIndex++;
      steps.push({ col: u.col, row: u.row, cost: spent });
      // Живой баг-репорт — «посадил юнита на корабль, а он потом исчез»: у пассажира на борту НЕТ
      // отдельного «погружен в корабль» состояния — он просто отдельный юнит на той же клетке
      // (см. isAboardShip), и когда двигали КОРАБЛЬ, а не пассажира, тот молча оставался стоять на
      // старой клетке — теперь открытое море БЕЗ корабля, куда сам дойти уже не может (unitPassable
      // для сухопутного юнита требует корабль СВОЕГО игрока именно на этой клетке). Со стороны
      // игрока выглядело как «юнит пропал» — на самом деле просто брошен на воде там, где сел на
      // борт. Теперь корабль каждым шагом пути тянет за собой любого пассажира, стоявшего на его
      // ПРЕЖНЕЙ клетке (по правилам посадки их не может быть больше одного, но на всякий случай
      // переносятся все, кого стек назначения ещё вмещает — тот же лимит ≤2 юнита на гекс, что и
      // у самого корабля, см. canEnterHex).
      // [ИСПРАВЛЕНО, живой баг-репорт — «корабль проплывая сквозь город автоматом захватывает
      // стоящего там юнита, хотя игрок не давал команды посадки»] — фильтр «riders» не проверял
      // isAboardShip (юнит и правда НА БОРТУ, т.е. на морской клетке, а не просто на той же
      // клетке), поэтому сухопутный юнит, ПРОСТО гарнизонированный в городе (клетка города — суша,
      // не море), которую корабль проходит транзитом, ошибочно считался пассажиром и утаскивался
      // вместе с кораблём на следующий шаг — «посадка» без единого приказа игрока. Настоящий
      // пассажир на борту стоит на МОРСКОЙ клетке (посадка возможна только там, см. isAboardShip) —
      // гарнизон города этому условию никогда не удовлетворяет, тащить его нельзя.
      if (u.category === "ship") {
        const riders = this.units.filter((r) => r.category !== "ship" && r.playerId === u.playerId && r.col === fromCol && r.row === fromRow && this.isAboardShip(r));
        for (const r of riders) {
          if (this.unitsAt(u.col, u.row).length >= 2) break;
          r.col = u.col;
          r.row = u.row;
        }
      }
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
        this.transferCity(arrivedCity, u.playerId, "conquest");
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
      const dmg = atkPower + this.supportBonusSum(atkSupporters);
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
      // AoE (сейчас только Корабли — «Дальняя атака» больше group-урон не наносит, см. units.ts) —
      // бьёт по площади, поддержку не получает в принципе (supportersFor уже вернёт [] для этих
      // категорий) — но урон всё равно удвоен на защиту, как и в обычном бою.
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
    this.applyDamage(defender, atkPower + this.supportBonusSum(atkSupporters), atkDoubleDefense);
    let counterOnAttacker: NonNullable<ActionResult["combatAnim"]>["counterOnAttacker"];
    if (defender.hp > 0) {
      const defStats = this.unitStats(defender);
      const defDoubleDefense = defender.category === "ranged";
      const atkDefenseBefore = this.unitTotalDefense(attacker);
      const atkHpBefore = attacker.hp;
      this.applyDamage(attacker, defStats.attack + this.supportBonusSum(defSupporters), defDoubleDefense);
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
    if (defender.hp <= 0) this.logEvent(`Юнит: у ${this.playerName(defender.playerId)} уничтожен юнит (${GameSession.UNIT_CATEGORY_LABEL[defender.category]}) на (${defender.col},${defender.row}).`);
    if (attacker.hp <= 0) this.logEvent(`Юнит: у ${this.playerName(attacker.playerId)} уничтожен юнит (${GameSession.UNIT_CATEGORY_LABEL[attacker.category]}) на (${attacker.col},${attacker.row}).`);
    this.units = this.units.filter((u) => u.hp > 0);
    const anim: ActionResult["combatAnim"] = {
      attacker: attackerPos,
      hits: [{ kind: "unit", target: { col, row }, defenseBefore: defDefenseBefore, defenseAfter: this.unitTotalDefense(defender), hpBefore: defHpBefore, hpAfter: defender.hp, hpMax: defHpMax }],
      counterOnAttacker,
    };
    return { lines: supportLines, anim };
  }

  /** Постройка юнита («Воин», ТЗ 5.1) — портирован из main.ts:buildUnit. */
  buildUnitCard(playerId: number, slotIndex: number, cityId: number, unitId: string, armyId?: number | null): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "warrior" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Воин» недоступна в этом слоте." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Город не найден." };
    const unit = UNITS.find((u) => u.id === unitId);
    if (!unit) return { ok: false, hint: "Такого юнита не существует." };
    if (unit.tech !== null && !this.researchedTechs[playerId].has(unit.tech)) {
      return { ok: false, hint: `Юнит «${unit.id}» открывается технологией «${unit.tech}» — она ещё не исследована.` };
    }
    // По прямому запросу — живой баг-репорт: «нельзя строить юнитов эпохи ниже, если не хватает
    // ресурса, только текущей, иначе автоматическое повышение повысит его, это баг» — ИСПРАВЛЕНО
    // (первая версия ошибочно сравнивала с ГЛОБАЛЬНОЙ эпохой игрока `playerEpoch`, ломая постройку
    // ЛЮБОЙ категории, где именно её ветка ещё не догнала эту эпоху — «ты всё поломал», см. живой
    // баг-репорт). Правильно — «текущая эпоха» имеется в виду ПО ЭТОЙ КОНКРЕТНОЙ КАТЕГОРИИ: старшая
    // эпоха СРЕДИ ЮНИТОВ ИМЕННО ЭТОЙ КАТЕГОРИИ, чья технология уже исследована (см. bestUnitEpochFor
    // ниже) — юнит этой категории эпохой НИЖЕ неё считается устаревшим и больше не строится вовсе, а
    // не откатывается на него как на дешёвый фолбэк (иначе в паре с бесплатным авто-апгрейдом при
    // следующем реальном скачке эпохи — эксплойт: построй дёшево сейчас, получи полноценного юнита
    // бесплатно позже). ВЫШЕ этого максимума юнит категории и так уже недостижим — прошедший тех-гейт
    // чуть выше сам по себе доказывает, что unit.epoch не может быть больше bestUnitEpochFor.
    const bestEpoch = this.bestUnitEpochFor(playerId, unit.category);
    if (unit.epoch < bestEpoch) {
      return { ok: false, hint: `Юнит эпохи ${unit.epoch} устарел — для этой категории уже доступна постройка юнита эпохи ${bestEpoch}.` };
    }
    if (this.oonArmsLimit !== null && this.units.filter((u) => u.playerId === playerId).length >= this.oonArmsLimit) {
      return { ok: false, hint: `Резолюция ООН «Сдерживание вооружений» ограничивает армию ${this.oonArmsLimit} юнитами — лимит уже достигнут (старые юниты не распускаются, но новые строить нельзя).` };
    }
    const cost = GameSession.EPOCH_UNIT_COST[unit.epoch];
    const woodenOverride =
      unit.category === "ship" ? GameSession.WOODEN_SHIP_RESOURCE_COST[unit.epoch] : unit.category === "ranged" ? GameSession.WOODEN_RANGED_RESOURCE_COST[unit.epoch] : undefined;
    const resources = woodenOverride ?? cost.resources;

    if (unit.category === "ship" && !this.shipSpawnHex(city)) return { ok: false, hint: "У этого города нет свободного моря рядом — корабль строить негде." };
    // Гарнизон города ограничен CITY_GARRISON_CAP (по прямому запросу, см. её doc) — кораблей это не
    // касается: они появляются в море рядом (shipSpawnHex), а не на самой клетке города.
    if (unit.category !== "ship" && this.unitsAt(city.col, city.row).length >= GameSession.CITY_GARRISON_CAP) {
      return { ok: false, hint: `Гарнизон города полон (${GameSession.CITY_GARRISON_CAP}/${GameSession.CITY_GARRISON_CAP}) — сначала выведите юнита обычным перемещением.` };
    }
    if (this.money[playerId] < cost.money) return { ok: false, hint: `Не хватает денег (нужно ${cost.money} 💰).` };
    const plan = this.planResourceSpend(playerId, city, resources);
    if (!plan) return { ok: false, hint: "Не набралось нужных ресурсов." };

    this.money[playerId] -= cost.money;
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
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
      armyId: armyId ?? null,
    });
    this.applyUnitBuiltBorderFactor(playerId, city);
    return { ok: true, spent: plan };
  }

  /** «Воин», альтернативное применение — по прямому запросу, доступно только с «Всеобщая воинская
   * повинность»: вместо ресурсной цены по эпохе — купить юнита за деньги (эпоха × 2💰) и 1 единицу
   * населения города, где строится (не может уйти ниже 1). Корабли ЭТИМ путём тоже покупаются (по
   * прямому запросу — раньше было запрещено без явной причины) — появляются в море рядом
   * (`shipSpawnHex`), гарнизон города их не касается, как и у обычной постройки за ресурсы. Для
   * сухопутных/воздушных категорий гарнизон ограничен тем же CITY_GARRISON_CAP — если полон, ОДИН из
   * уже стоящих там юнитов принудительно отодвигается на соседний проходимый гекс (тот же приём, что
   * и отступление защитника в resolveCombat), не блокирует покупку; если отодвинуть действительно
   * некуда — покупка отклоняется. Не более 1 раза за цикл в ОДНОМ городе (conscriptionUsedThisCycle,
   * сбрасывается в advanceCurrentPlayer). AI: см. bot.ts — не использует, если население города к
   * концу хода окажется ≤3. */
  buyUnitWithMoney(playerId: number, slotIndex: number, cityId: number, unitId: string, armyId?: number | null): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!this.researchedTechs[playerId].has("Всеобщая воинская повинность")) {
      return { ok: false, hint: "Нужна технология «Всеобщая воинская повинность»." };
    }
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "warrior" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Воин» недоступна в этом слоте." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Город не найден." };
    if (city.population <= 1) return { ok: false, hint: "Население города и так минимально (1) — покупка за деньги невозможна." };
    if (this.conscriptionUsedThisCycle.has(city.id)) {
      return { ok: false, hint: "В этом городе покупка юнита за деньги уже была в этом цикле — доступна снова со следующего." };
    }
    const unit = UNITS.find((u) => u.id === unitId);
    if (!unit) return { ok: false, hint: "Такого юнита не существует." };
    if (unit.tech !== null && !this.researchedTechs[playerId].has(unit.tech)) {
      return { ok: false, hint: `Юнит «${unit.id}» открывается технологией «${unit.tech}» — она ещё не исследована.` };
    }
    const bestEpoch = this.bestUnitEpochFor(playerId, unit.category);
    if (unit.epoch < bestEpoch) {
      return { ok: false, hint: `Юнит эпохи ${unit.epoch} устарел — для этой категории уже доступна постройка юнита эпохи ${bestEpoch}.` };
    }
    if (this.oonArmsLimit !== null && this.units.filter((u) => u.playerId === playerId).length >= this.oonArmsLimit) {
      return { ok: false, hint: `Резолюция ООН «Сдерживание вооружений» ограничивает армию ${this.oonArmsLimit} юнитами — лимит уже достигнут.` };
    }
    // По прямому запросу — корабли теперь тоже покупаются этим путём: появляются в море рядом
    // (shipSpawnHex), гарнизон города (CITY_GARRISON_CAP) их не касается — та же логика, что уже
    // применяется к обычной постройке за ресурсы (buildUnitCard) выше в файле.
    if (unit.category === "ship" && !this.shipSpawnHex(city)) return { ok: false, hint: "У этого города нет свободного моря рядом — корабль покупать некуда." };
    const price = unit.epoch * 2;
    if (this.money[playerId] < price) return { ok: false, hint: `Не хватает денег (нужно ${price} 💰).` };
    if (unit.category !== "ship" && this.unitsAt(city.col, city.row).length >= GameSession.CITY_GARRISON_CAP) {
      const evicted = this.unitsAt(city.col, city.row)[0];
      const spot = this.hexNeighborsGameplay(city.col, city.row).find(([nc, nr]) => this.unitPassable(evicted, nc, nr) && this.canEnterHex(evicted, nc, nr));
      if (!spot) return { ok: false, hint: "Гарнизон города полон, и отодвинуть юнита некуда (нет свободного соседнего гекса) — покупка невозможна." };
      evicted.col = spot[0];
      evicted.row = spot[1];
    }
    this.money[playerId] -= price;
    city.population -= 1;
    this.conscriptionUsedThisCycle.add(city.id);
    this.consumeHandCard(playerId, slotIndex);
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
      armyId: armyId ?? null,
    });
    this.applyUnitBuiltBorderFactor(playerId, city);
    return { ok: true };
  }

  /** Казарма (ТЗ 4.4) — «без карты» аналог карты «Воин»: та же цена по эпохе, тот же выбор категории
   * юнита, тот же лимит ООН «Сдерживание вооружений» — просто действие тратится ЗДАНИЕМ
   * (`buildingActionGate`/`spendBuildingAction`, бесплатно по очкам действия для всех), а не картой
   * из руки. Бонус Фашизма (раньше — 2 юнита за цену 1, теперь —
   * отдельная бесплатная карта «Воин» в руке, см. grantFascismWarriorCards) сюда не относится — он
   * привязан к самой карте «Воин», не к постройке юнита вообще. Живой баг-репорт — «построил Казарму,
   * но нет кнопки воспользоваться» — эффект был описан в buildings.ts, но ни разу не реализован ни на
   * сервере, ни в клиенте (BUILDING_USE_LABEL не содержал кazarma вовсе). Здание общее на игрока, не
   * привязано к конкретному городу (см. buildings.ts) — юнит можно построить в ЛЮБОМ своём городе,
   * не обязательно в том, где физически стоит Казарма. */
  useKazarma(playerId: number, cityId: number, unitId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!isOwnedBy(this.buildingOwners, "kazarma", playerId)) return { ok: false, hint: "У вас нет здания «Казарма»." };
    const cycleKey = `kazarma:${playerId}`;
    if (this.productionUsedThisCycle.has(cycleKey)) return { ok: false, hint: "Казарма уже использована в этом цикле — снова можно только со следующего." };
    const city = this.cities.find((c) => c.id === cityId && c.playerId === playerId);
    if (!city) return { ok: false, hint: "Город не найден." };
    const unit = UNITS.find((u) => u.id === unitId);
    if (!unit) return { ok: false, hint: "Такого юнита не существует." };
    if (unit.tech !== null && !this.researchedTechs[playerId].has(unit.tech)) {
      return { ok: false, hint: `Юнит «${unit.id}» открывается технологией «${unit.tech}» — она ещё не исследована.` };
    }
    // См. doc в buildUnitCard — тот же запрет устаревших (для ЭТОЙ категории) юнитов.
    const bestEpoch = this.bestUnitEpochFor(playerId, unit.category);
    if (unit.epoch < bestEpoch) {
      return { ok: false, hint: `Юнит эпохи ${unit.epoch} устарел — для этой категории уже доступна постройка юнита эпохи ${bestEpoch}.` };
    }
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
    if (unit.category !== "ship" && this.unitsAt(city.col, city.row).length >= GameSession.CITY_GARRISON_CAP) {
      return { ok: false, hint: `Гарнизон города полон (${GameSession.CITY_GARRISON_CAP}/${GameSession.CITY_GARRISON_CAP}) — сначала выведите юнита обычным перемещением.` };
    }
    if (this.money[playerId] < cost.money) return { ok: false, hint: `Не хватает денег (нужно ${cost.money} 💰).` };
    const plan = this.planResourceSpend(playerId, city, resources);
    if (!plan) return { ok: false, hint: "Не набралось нужных ресурсов." };

    this.money[playerId] -= cost.money;
    this.commitSpend(playerId, plan);
    this.spendBuildingAction(playerId);
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
      armyId: null,
    });
    this.applyUnitBuiltBorderFactor(playerId, city);
    this.productionUsedThisCycle.add(cycleKey);
    return { ok: true, spent: plan };
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

    const defenderCity = this.cityAt(col, row);
    const defenders = this.unitsAt(col, row).filter((u) => u.playerId !== playerId);
    // Гарнизон города = его население (по прямому уточнению) — своего буфера осады на ЭТОТ цикл
    // (citySiegeBuffer) ещё не пробивали ⇒ город обычная цель для атаки. Как только буфер пробит
    // (см. resolveCombat) — на ОСТАТОК этого цикла город становится целью для ВХОДА (перемещение),
    // а не для удара; не успели зайти до обнуления цикла — на новом буфер соберётся заново, снова
    // придётся пробивать (уже с меньшими силами, т.к. население после пробития -1).
    const citySiegeBroken = !!defenderCity && this.citySiegeBuffer.has(defenderCity.id) && this.citySiegeBuffer.get(defenderCity.id)! <= 0;
    const isEnemyTarget = defenders.length > 0 || (!!defenderCity && defenderCity.playerId !== playerId && !citySiegeBroken);

    // По прямому запросу — «если в качестве цели корабля выбрана суша, он должен сделать туда
    // высадку юнита на борту»: корабль сам физически не может встать на обычную сушу (unitPassable —
    // только море/город), так что если выбран именно корабль, а цель — суша, приказ ретранслируется
    // юниту на его борту (тот же гекс, категория не «ship»), если такой есть — вся дальнейшая логика
    // ниже (граница/осада/бой/движение) отрабатывает уже за НЕГО, ровно как если бы игрок сразу
    // выбрал этого пассажира. Раньше выбор корабля с сушей в качестве цели просто падал с общим
    // «путь заблокирован», даже когда пассажир на борту был и мог бы туда дойти.
    // Живой баг-репорт — этот редирект НЕ должен применяться, когда цель — враг (isEnemyTarget):
    // корабль бьёт по прибрежной суше с воды («плавающая артиллерия», AoE, см. unitStats) БЕЗ
    // необходимости физически встать на клетку цели — раньше редирект срабатывал даже для атаки, и
    // без пассажира на борту (обычная ситуация) корабль ошибочно отказывал «некого высаживать» вместо
    // боя, из-за чего AI (attackCandidatesFor/decideAndIssueUnitOrder) никогда не мог довести
    // такую атаку до реального dispatch и молча пропускал цель.
    if (unit.category === "ship" && !this.unitPassable(unit, col, row) && !isEnemyTarget) {
      const rider = this.units.find((u) => u.id !== unit!.id && u.playerId === playerId && u.category !== "ship" && u.col === unit!.col && u.row === unit!.row);
      if (rider) unit = rider;
      else return { ok: false, hint: "Корабль сам не может зайти на сушу (только в город-гавань), а юнита на борту сейчас нет — некого высаживать." };
    }
    if (this.landedThisCycle.has(unit.id)) return { ok: false, hint: "Этот юнит только что высадился на берег — ход исчерпан до начала следующего цикла." };

    if (isEnemyTarget) {
      // По прямому запросу — «атака завершает ход, нельзя атаковать одним юнитом дважды»: этот юнит
      // уже провёл бой в ТЕКУЩЕМ цикле (attackedThisCycle ставится ниже сразу после chargeUnitActivation)
      // — вторая атака тем же юнитом в тот же цикл запрещена, до границы следующего цикла.
      if (this.attackedThisCycle.has(unit.id)) return { ok: false, hint: "Этот юнит уже атаковал в этом цикле — повторная атака доступна только со следующего цикла." };
      if (this.outOfMoveThisCycle.has(unit.id)) return { ok: false, hint: "Юниту не хватило хода на этот гекс в этом цикле — атаковать он пока не может." };
      if (this.isAboardShip(unit)) return { ok: false, hint: "Юнит на борту корабля не может атаковать — сначала высадка на берег." };
      const targetPlayerId = defenders[0]?.playerId ?? defenderCity!.playerId;
      const stats = this.unitStats(unit);
      if (stats.attack <= 0) return { ok: false, hint: "Этот юнит не может атаковать." };
      // Война/её подтверждение — раньше проверялось ПОСЛЕ подхода на дистанцию ниже; по прямому
      // запросу автоподход теперь может реально двигать юнита к цели, так что спросить «объявить
      // войну?» нужно ДО того, как юнит куда-то пойдёт и потратит деньги/действие — не после.
      if (!this.relationOf(playerId, targetPlayerId).war) {
        return { ok: false, needsWarConfirm: { targetPlayerId, reason: "атака" } };
      }
      const range = this.effectiveAttackRange(unit);
      let movedPath: { col: number; row: number; cost: number }[] | undefined;
      let dist = this.hexDistance(unit.col, unit.row, col, row, range + 1);
      // Автоподход на дистанцию удара — по прямому запросу («сейчас юнитом чтоб атаковать сначала
      // нужно подойти в упор — нужно сделать сразу расчёт действий: юнит сам подходит на дистанцию
      // атаки и наносит урон по дистанции; если уже в радиусе — просто наносит урон без движения»):
      // если цель вне дальности, ОДНИМ этим же вызовом ищем ближайший (по стоимости хода, с учётом
      // местности и занятости клеток чужими юнитами — тот же `computeApproachPath`, что и обычное
      // движение) гекс в пределах дальности и идём туда; если бюджета хода хватило дойти в этом же
      // цикле — атака происходит сразу этим же приказом; не хватило — юнит просто продвинулся
      // (остаток пути автопродолжится на границе следующего цикла, как у обычного движения), атаки
      // в этот раз не будет — ровно та же семантика, что у растянутого на несколько циклов marша.
      if (dist > range) {
        const remainingMoveBudget = this.unitStats(unit).moveRange - (this.moveBudgetUsedThisCycle.get(unit.id) ?? 0);
        if (remainingMoveBudget <= 0) return { ok: false, hint: `Цель вне дальности удара (${range}) — юниту не хватило хода в этом цикле, чтобы подойти.` };
        const approach = this.computeApproachPath(unit, col, row, range);
        if (!approach || !approach.path.length) return { ok: false, hint: `Цель вне дальности удара (${range}) — подойти к ней не удаётся (путь блокирован или недоступен).` };
        if (!this.chargeUnitActivation(unit)) return { ok: false, hint: "Не хватает денег (нужен 1💰) — приказ не отдан." };
        this.unitActedThisCycle.add(unit.id);
        unit.moveOrder = { path: approach.path, nextIndex: 0 };
        unit.defending = false;
        movedPath = this.walkUnitAlongOrder(unit);
        dist = this.hexDistance(unit.col, unit.row, col, row, range + 1);
        if (dist > range) {
          return { ok: true, hint: "Юнит пошёл на сближение с целью — хода не хватило дойти в этот раз, атака продолжится на следующем цикле.", movedPath: movedPath.length ? movedPath : undefined };
        }
      }
      // Условие видимости (по прямому уточнению, ТЗ 6.6) — только для ударов НЕ в упор: нужен свой
      // юнит любой категории (включая корабли), стоящий в гексе, СОСЕДНЕМ С ЦЕЛЬЮ, — «передаёт
      // позицию». В упор (dist<=1) юнит и так сам видит соседний гекс, спотер не нужен.
      if (dist > 1) {
        const hasSpotter = this.hexNeighborsGameplay(col, row).some(([nc, nr]) => this.units.some((u) => u.playerId === playerId && u.col === nc && u.row === nr));
        if (!hasSpotter) return { ok: false, hint: "Нет видимости цели — нужен свой юнит в гексе, соседнем с целью (любой категории, включая корабли)." };
      }
      if (!this.chargeUnitActivation(unit)) return { ok: false, hint: "Не хватает денег (нужен 1💰) — атака невозможна." };
      this.unitActedThisCycle.add(unit.id);
      this.attackedThisCycle.add(unit.id);
      unit.defending = false; // любое действие юнита снимает «Оборону» (по прямому уточнению) — атака не исключение
      const combat = this.resolveCombat(unit, col, row);
      // Живой баг-репорт — «смог сделать ход после атаки, атака должна обнулять очки движения»: атака
      // (в упор или после автоподхода) полностью выжигает бюджет хода юнита на ЭТОТ цикл, даже если
      // подход занял не весь бюджет (или атака была в упор без единого шага) — новый приказ движения
      // тем же юнитом (проверка `remainingMoveBudget` чуть выше по файлу) недоступен до следующего
      // цикла, как и повторная атака (`attackedThisCycle`).
      if (unit.hp > 0) this.moveBudgetUsedThisCycle.set(unit.id, this.unitStats(unit).moveRange);
      return { ok: true, movedPath, supportLines: combat.lines.length ? combat.lines : undefined, hint: combat.hint, combatAnim: combat.anim };
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
    if (!neutralWatersBypass && targetOwner !== null && !this.canTraverseTerritoryOf(playerId, targetOwner)) {
      return { ok: false, needsWarConfirm: { targetPlayerId: targetOwner, reason: "вход на чужую территорию без «Открытых границ»/Вассалитета" } };
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
      // Живой баг-репорт — «не работает высадка/мост через корабль»: разбор показал, что путь
      // реально блокирован не самим кораблём, а стеком юнитов НА ЦЕЛЕВОЙ клетке (не более 2 юнитов на
      // обычном гексе, и не более 1 ОТ ИГРОКА вне города, см. canEnterHex) — раньше это тоже падало в
      // общую подсказку «путь блокирован», неотличимую от настоящей непроходимости, из-за чего
      // выглядело как поломка самого моста/высадки. Проверяем ИМЕННО целевую клетку (не весь путь).
      if (!this.cityAt(col, row) && this.unitsAt(col, row).length && !this.isSeaTile(col, row)) {
        const occupants = this.unitsAt(col, row);
        if (occupants.length >= 2) {
          return { ok: false, hint: "На этой клетке уже 2 юнита (максимум вне города) — нужна другая клетка." };
        }
        if (occupants.some((u) => u.playerId === playerId)) {
          return { ok: false, hint: "Там уже стоит ваш юнит — вне города нельзя держать 2 своих юнита на одной клетке, выберите другую клетку." };
        }
      }
      return { ok: false, hint: "Туда не дойти — путь блокирован или недоступен для этого юнита." };
    }
    if (!this.chargeUnitActivation(unit)) return { ok: false, hint: "Не хватает денег (нужен 1💰) — приказ не отдан." };
    this.unitActedThisCycle.add(unit.id);
    unit.moveOrder = { path: result.path, nextIndex: 0 };
    unit.defending = false;
    // Отношения AI — факторы 3/4 (по прямому запросу, «юнит построен/убран у моей границы −1/+1») —
    // «убран» здесь в смысле движения ПРОЧЬ от границы (постройку/распуск см. в
    // applyUnitBuiltBorderFactor). Регион юнита ДО хода этого приказа против ПОСЛЕ — сравнение
    // именно ЭТОГО шага (не всего многоцикличного moveOrder целиком), достаточно, т.к. каждый
    // следующий шаг того же приказа сам придёт сюда же на следующем resolveUnitMovementForCycle.
    const beforeRc = Math.floor(unit.col / REGION_SIZE_X);
    const beforeRr = Math.floor(unit.row / REGION_SIZE_Y);
    // По прямому запросу — движение случается СРАЗУ, в этом же цикле, а не откладывается целиком до
    // границы следующего (см. walkUnitAlongOrder). Если путь длиннее бюджета хода на этот цикл,
    // остаток остаётся в unit.moveOrder и автопродолжится на будущих границах цикла, как и раньше.
    const movedPath = this.walkUnitAlongOrder(unit);
    const afterRc = Math.floor(unit.col / REGION_SIZE_X);
    const afterRr = Math.floor(unit.row / REGION_SIZE_Y);
    this.applyUnitBorderMoveFactor(playerId, beforeRc, beforeRr, afterRc, afterRr);
    const captured = citySiegeBroken && !!defenderCity && defenderCity.playerId === unit.playerId;
    let hint: string | undefined;
    if (citySiegeBroken && defenderCity) {
      hint = captured
        ? "Гарнизон пробит — город захвачен!"
        : "Приказ на захват отдан — юнит доберётся и войдёт в город, как только хватит хода (не успеет в этом цикле — гарнизон к новому циклу соберётся заново).";
    }
    return { ok: true, hint, movedPath: movedPath.length ? movedPath : undefined };
  }

  /** `cascadeVisited` — только для внутренних рекурсивных вызовов из cascadeAllianceWar (не часть
   * публичного API, dispatch всегда зовёт без 3-го аргумента). */
  declareWar(playerId: number, targetId: number, cascadeVisited?: Set<string>): ActionResult {
    const rel = this.relationOf(playerId, targetId);
    // Срок перемирия (по прямому запросу) — пока не истёк, войну между этой парой объявить нельзя
    // ни явным приказом, ни как следствие отклонённого ультиматума (resolveProposal зовёт этот же
    // метод) — иначе перемирие с указанным сроком ничем не отличалось бы от обычного «Мира».
    if (rel.truceUntilCycle !== undefined && this.cyclesElapsed < rel.truceUntilCycle) {
      return { ok: false, hint: `Действует перемирие ещё ${rel.truceUntilCycle - this.cyclesElapsed} цикл(ов) — нельзя объявить войну.` };
    }
    const alreadyAtWar = rel.war;
    rel.war = true;
    rel.agreements.clear();
    rel.truceUntilCycle = undefined;
    // Минимальная длительность войны (по прямому запросу, «война длится минимум 3 цикла») — только на
    // САМОЕ первое объявление этой конкретной паре, не на повторный dispatch по уже идущей войне (та же
    // граница, что и у каскада союзников/факторов отношений ниже).
    if (!alreadyAtWar) {
      rel.noPeaceBeforeCycle = this.cyclesElapsed + GameSession.WAR_MIN_DURATION_CYCLES;
      this.logEvent(`Война: ${this.playerName(playerId)} объявил войну ${this.playerName(targetId)}.`);
    }
    // По прямому запросу — «Совместная оборона»/«Союз» перестают быть design-only флагами:
    // каскадом втягивают союзников в ту же войну (см. cascadeAllianceWar). Только на ПЕРВОЕ
    // объявление этой конкретной пары — не на повторный dispatch по уже идущей войне.
    if (!alreadyAtWar) {
      // Отношения AI — фактор 7 (по прямому запросу — «объявление войны разово −10 для обеих
      // сторон друг к другу», заменяет прежний per-cycle дрейф −1/цикл, пока война идёт, см.
      // resolveCycleBoundary — тот дрейф убран целиком).
      this.adjustRelationScore(playerId, targetId, -10, "объявил войну");
      this.adjustRelationScore(targetId, playerId, -10, "объявил войну");
      this.cascadeAllianceWar(playerId, targetId, cascadeVisited ?? new Set([this.pairKey(playerId, targetId)]));
      // Отношения AI — фактор 13 (по прямому запросу, «объявил войну моему другу/союзнику −5») —
      // у ВСЕХ живых ТРЕТЬИХ наблюдателей P (не сама жертва — у неё уже есть свой per-cycle фактор
      // 7 за факт войны, см. resolveCycleBoundary), для которых targetId — «друг или союзник»:
      // relation(P,targetId) ≥60 (хорошие+) ИЛИ действует mutualDefense/union между P и targetId.
      // Срабатывает и на каскадные объявления (cascadeAllianceWar сама рекурсивно зовёт declareWar)
      // — третьи стороны реагируют одинаково, независимо от того, кто именно первым начал цепочку.
      for (const p of this.players) {
        if (p.id === playerId || p.id === targetId || this.eliminatedPlayers.has(p.id)) continue;
        const isFriend = this.relationScoreOf(p.id, targetId) >= 60;
        const isAlly = this.relationOf(p.id, targetId).agreements.has("mutualDefense") || this.relationOf(p.id, targetId).agreements.has("union");
        if (isFriend || isAlly) this.adjustRelationScore(p.id, playerId, -5, "объявил войну другу/союзнику");
      }
    }
    // Отношения AI — нарушение обещания «не нападать» (promiseNoAttack) — playerId обещал НЕ
    // нападать конкретно на targetId (`by === playerId`, `to === targetId` — обещание уже привязано
    // к конкретной паре, не общее «ни на кого»), а объявляет войну именно ему.
    for (const promise of [...this.activePromises]) {
      if (promise.kind === "noAttack" && promise.by === playerId && promise.to === targetId) this.breakPromise(promise);
    }
    return { ok: true };
  }

  /** По прямому запросу — сделать «Совместную оборону»/«Союз» реально действующими (были design-only
   * флагами, ни на что не влиявшими): вызывается ОДИН раз сразу после того, как война между
   * `attackerId`/`defenderId` реально началась (см. declareWar выше).
   * - **Совместная оборона** (`mutualDefense`) — оборонительный пакт: союзники ЗАЩИТНИКА
   *   автоматически объявляют войну АТАКУЮЩЕМУ («укрепить оборону оборонительным союзом»).
   * - **Союз** (`union`) — наступательный пакт: союзники АТАКУЮЩЕГО тоже объявляют войну той же
   *   ЦЕЛИ («напасть на врага вдвоём») — в отличие от mutualDefense, срабатывает на объявление
   *   войны СВОИМ союзником, а не на то, что кто-то напал на тебя самого.
   * `visited` — общий на всю цепочку набор УЖЕ обработанных пар (ключ pairKey), чтобы цикл
   * взаимных пактов (A-B, B-C, C-A) не долбился в рекурсию бесконечно и не объявлял одну и ту же
   * пару войны дважды через разные цепочки. */
  private cascadeAllianceWar(attackerId: number, defenderId: number, visited: Set<string>) {
    for (const p of this.players) {
      if (p.id === defenderId || p.id === attackerId) continue;
      const key = this.pairKey(p.id, attackerId);
      if (visited.has(key)) continue;
      if (this.relationOf(p.id, defenderId).agreements.has("mutualDefense") && !this.relationOf(p.id, attackerId).war) {
        visited.add(key);
        this.declareWar(p.id, attackerId, visited);
      }
    }
    for (const p of this.players) {
      if (p.id === attackerId || p.id === defenderId) continue;
      const key = this.pairKey(p.id, defenderId);
      if (visited.has(key)) continue;
      if (this.relationOf(p.id, attackerId).agreements.has("union") && !this.relationOf(p.id, defenderId).war) {
        visited.add(key);
        this.declareWar(p.id, defenderId, visited);
      }
    }
  }

  private pairKey(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }
  /** Публичный (не `private`, по надобности bot.ts — военный AI должен уметь проверить «воюю ли я
   * с этим игроком», прежде чем решать, просить ли мира) — сам метод не изменился, просто открыт. */
  relationOf(a: number, b: number): Relation {
    const k = this.pairKey(a, b);
    if (!this.relations[k]) this.relations[k] = { war: false, agreements: new Set() };
    return this.relations[k];
  }

  // === Отношения AI — асимметричная шкала (см. класс-докstring у RelationTier) =====================

  /** Мнение `fromId` о `toId` — НЕ `pairKey` (порядок значим, в отличие от `relationOf` выше): мнение
   * A о B и мнение B о A — два разных числа. Отсутствие записи = дефолт 50 (нейтрально, старт
   * партии) — не материализуем все пары заранее, не за чем на 30 записей при 6 игроках. */
  relationScoreOf(fromId: number, toId: number): number {
    return this.relationScores[`${fromId}:${toId}`] ?? 50;
  }

  /** Единая точка изменения шкалы — используется всеми ~25 факторами (по месту события, см. план) и
   * системой обещаний. Клампится в 0-100. `reason` — необязательная строка, только для будущей
   * отладки (не хранится, не сериализуется) — дёшево при разработке/npx tsx-проверках, ничего не
   * стоит в проде. */
  private adjustRelationScore(fromId: number, toId: number, delta: number, reason?: string): void {
    if (fromId === toId) return; // самому себе мнение не меняем — self-факт исключён на общем уровне
    const key = `${fromId}:${toId}`;
    const next = Math.max(0, Math.min(100, this.relationScoreOf(fromId, toId) + delta));
    this.relationScores[key] = next;
    void reason; // зарезервировано под debug-лог на будущих этапах, пока не используется
  }

  /** Диапазоны строго по прямому запросу: ненависть 0-10, враждебность 10-20, плохие 20-40,
   * нейтральные 40-60, хорошие 60-80, дружеские 80-90, союзнические 90-100. Границы — нижняя
   * включительно, верхняя нет (кроме самого правого диапазона, 100 — тоже "allied"). */
  relationTierOf(score: number): RelationTier {
    if (score < 10) return "hate";
    if (score < 20) return "hostile";
    if (score < 40) return "bad";
    if (score < 60) return "neutral";
    if (score < 80) return "good";
    if (score < 90) return "friendly";
    return "allied";
  }

  toggleDefend(playerId: number, unitId: number): ActionResult {
    const unit = this.units.find((u) => u.id === unitId && u.playerId === playerId);
    if (!unit) return { ok: false, hint: "Юнит не найден." };
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
    if (this.outOfMoveThisCycle.has(unit.id)) return { ok: false, hint: "Не хватило хода на этот гекс — недоступно до нового цикла." };
    unit.raiding = !unit.raiding;
    unit.moveOrder = null;
    unit.defending = false; // любое действие юнита снимает «Оборону» (по прямому уточнению)
    this.unitActedThisCycle.add(unit.id);
    return { ok: true };
  }

  buyListing(playerId: number, listingId: number): ActionResult {
    const listing = this.market.find((l) => l.id === listingId);
    if (!listing || listing.sellerId === playerId) return { ok: false, hint: "Лот недоступен." };
    // «Банковское дело» (по прямому запросу, первооткрывателю, постоянно) — скидка 2💰 на покупку
    // ресурсов НЕ у игроков (только у Мирового рынка, WORLD_SELLER), цена не ниже 1. Скидка считается
    // от `listing.price` только для того, что реально спишется — сам лот (и его цена восстановления
    // после покупки) не меняется, скидка не «портит» рынок для остальных.
    const payPrice =
      listing.sellerId === WORLD_SELLER && this.techDiscoverer["Банковское дело"] === playerId ? Math.max(1, listing.price - 2) : listing.price;
    if (this.money[playerId] < payPrice) return { ok: false, hint: "Недостаточно денег для покупки этого лота." };
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
    this.money[playerId] -= payPrice;
    if (listing.sellerId !== WORLD_SELLER) {
      this.money[listing.sellerId] += payPrice;
      // Отношения AI — фактор 10 (по прямому запросу, «купили мой ресурс на бирже +1») — только
      // ресурс (не карта, буквально «мой РЕСУРС») и только у настоящего игрока-продавца (не
      // нейтрального мирового рынка WORLD_SELLER — там нет «моего», не с кем радоваться).
      if (listing.kind === "resource") this.adjustRelationScore(listing.sellerId, playerId, 1, "купили мой ресурс на бирже");
    }
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
    // [ИСПРАВЛЕНО, по прямому запросу] — выбывшему (потерявшему все города) игроку карту передать
    // нельзя: он больше не участвует в партии, некому будет ей воспользоваться.
    if (this.eliminatedPlayers.has(targetPlayerId)) return { ok: false, hint: "Этот игрок выбыл из партии — карту ему передать нельзя." };
    const hand = this.hands[playerId];
    const card = hand[slotIndex];
    if (!card) return { ok: false, hint: "Такой карты нет в руке." };
    if (card.freeMonarchy) return { ok: false, hint: "Бесплатного «Рабочего» Монархии нельзя передать другому игроку — выберите другую карту." };
    if (card.freeFascism) return { ok: false, hint: "Бесплатного «Воина» Фашизма нельзя передать другому игроку — выберите другую карту." };
    if (card.freeEducation) return { ok: false, hint: "Бесплатного «Учёного» (бонус «Образования») нельзя передать другому игроку — выберите другую карту." };
    if (card.freeBuilding) return { ok: false, hint: "Бесплатного «Строителя» (бонус «Архитектуры») нельзя передать другому игроку — выберите другую карту." };
    if (card.freeParliamentarism) return { ok: false, hint: "Бесплатного «Строителя» Парламентаризма нельзя передать другому игроку — выберите другую карту." };
    if (card.freeForestGrowth) return { ok: false, hint: "Бесплатную карту «Рост леса» (эндгейм-бонус «Учёного») нельзя передать другому игроку — выберите другую карту." };
    // Запрет — на КОНКРЕТНУЮ карту, не на игрока целиком (по прямому уточнению): нельзя вернуть
    // ИМЕННО ЭТОТ экземпляр обратно тому, кто его вам дал; другую карту тому же игроку — можно.
    // `receivedFrom` живёт на самой карте (см. cards.ts) и чистится, когда она уходит в сброс —
    // возврат снимает блокировку, ровно как и передача этой же карты дальше третьему игроку.
    if (card.receivedFrom === targetPlayerId) {
      return { ok: false, hint: `Нельзя вернуть эту карту обратно ${this.players[targetPlayerId].name} — именно он(а) дал(а) вам её в прошлый раз. Выберите другую карту или другого игрока.` };
    }
    // По прямому запросу — нельзя передавать одному и тому же игроку два цикла подряд, минимум через
    // 1 цикл (последняя передача этому же получателю была в ТЕКУЩЕМ или ПРЕДЫДУЩЕМ цикле).
    const handoffKey = `${playerId}:${targetPlayerId}`;
    const lastCycle = this.lastHandoffCycle[handoffKey];
    if (lastCycle !== undefined && this.cyclesElapsed - lastCycle < 2) {
      return { ok: false, hint: `Уже передавали карту ${this.players[targetPlayerId].name} недавно — нужно пропустить минимум 1 цикл, прежде чем передать этому же игроку снова. Выберите другого получателя.` };
    }
    // Передача — принудительная (не выбор игрока-дарителя), поэтому «рука уже полна» её не
    // блокирует (по прямому уточнению — «8-ю карту можно»): получатель просто дойдёт до 8 карт и
    // сбросит всю руку на своём следующем конце хода, как обычно (ТЗ 2.3.1) — не другое исключение.
    hand.splice(slotIndex, 1);
    this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
    card.receivedFrom = playerId;
    this.hands[targetPlayerId].push(card);
    this.mustHandoff.delete(playerId);
    this.lastHandoffCycle[handoffKey] = this.cyclesElapsed;
    // Отношения AI — фактор 5 (по прямому запросу): передал карту действия +1 (реально полезный
    // подарок), передал карту события −3 (событие обычно то, от чего сам хочет избавиться, см.
    // §15.4/looksUnplayableThisTurn — получателю это не в радость). Штраф поднят с −1 до −3 по
    // прямому уточнению («между игроками сейчас преимущественно хорошие отношения, даже без
    // соглашений — нужно увеличить штраф порчи отношений от передачи карт событий до −3»): при −1
    // обязательная передача карты события (происходит у КАЖДОГО игрока почти каждый цикл, ТЗ 2.3)
    // почти не двигала шкалу на фоне +1 за цикл мира и прочих плюсов — отношения у всех дрейфовали
    // вверх, силовые/военные ветки логики (гейты <40/<60, §15.2) не включались вовсе.
    this.adjustRelationScore(targetPlayerId, playerId, card.kind === "event" ? -3 : 1, "передал карту");
    // Отношения AI — обещания: нарушение «не делиться картами событий с [excludedPlayerId]»
    // (promiseNoEventCards) и досрочное исполнение «передать карту [cardId]» (promiseGiveCardType).
    for (const promise of [...this.activePromises]) {
      if (promise.kind === "noEventCards" && promise.by === playerId && card.kind === "event" && promise.excludedPlayerId === targetPlayerId) this.breakPromise(promise);
      if (promise.kind === "giveCardType" && promise.by === playerId && promise.to === targetPlayerId && promise.cardId === card.id) this.fulfillPromise(promise);
    }
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
  /** Старшая эпоха ИМЕННО ЭТОЙ категории, доступная игроку прямо сейчас (среди юнитов этой категории,
   * чья технология уже исследована — «Воин»/эпоха 1 всегда в их числе, tech:null). НЕ то же самое,
   * что `playerEpoch` (максимум по ВСЕМ веткам сразу) — по прямому запросу, живой баг-репорт: «ты не
   * верно понял правило, имеется в виду не эпоха по максимальной технологии, а максимальный юнит
   * исходя из изученных технологий» — первая версия ошибочно сравнивала с playerEpoch и ломала
   * постройку ЛЮБОЙ категории, чья ветка ещё не догнала общую эпоху игрока (у игрока эпоха 5 через
   * другую ветку, а конкретно «Дальняя атака» этой эпохи ещё не открыта — категория оказывалась
   * ЦЕЛИКОМ недоступна, хотя эпоха 3 у неё давно есть). Используется в buildUnitCard/useKazarma — юнит
   * этой категории эпохой НИЖЕ результата считается устаревшим (см. их doc, тот же баг-репорт). */
  private bestUnitEpochFor(playerId: number, category: UnitCategory): TechDef["epoch"] {
    let max: TechDef["epoch"] = 1;
    for (const u of UNITS) {
      if (u.category !== category) continue;
      if (u.tech !== null && !this.researchedTechs[playerId].has(u.tech)) continue;
      if (u.epoch > max) max = u.epoch;
    }
    return max;
  }
  /** Портирован из upgradePlayerUnits — при получении технологии мгновенно и бесплатно апгрейдит уже
   * существующих юнитов этого игрока. По прямому запросу — живой баг-репорт: «юнит в городе (12,12)
   * по-прежнему эпохи 1, но ему доступны более совершенные юниты, почему автоматом не повышается до
   * максимально доступного по открытым технологиям» — раньше апгрейд сравнивал с ОБЩЕЙ эпохой игрока
   * (`playerEpoch`, максимум по ВСЕМ веткам разом) и срабатывал, только когда эта общая эпоха реально
   * росла; если игрок УЖЕ был на эпохе 5 через другую ветку, а технология конкретно ДЛЯ ЭТОЙ
   * категории (скажем, «Дальняя атака») открывалась только сейчас — общая эпоха не менялась вовсе
   * (была 5, осталась 5), апгрейд не запускался, хотя для этой категории только что появился лучший
   * юнит. Теперь — ПО КАЖДОЙ КАТЕГОРИИ ОТДЕЛЬНО (`bestUnitEpochFor`, та же функция, что ограничивает
   * постройку новых юнитов, см. buildUnitCard/useKazarma) — вызывается безусловно при КАЖДОМ гранте
   * технологии, дёшево (перебор своих юнитов), никакого отдельного отслеживания «выросла ли эпоха». */
  private upgradePlayerUnits(playerId: number) {
    for (const u of this.units) {
      if (u.playerId !== playerId) continue;
      const best = this.bestUnitEpochFor(playerId, u.category);
      if (u.epoch < best) {
        u.epoch = best;
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
  private researchTech(playerId: number, techId: string): string | undefined {
    const tech = TECH_TREE.find((t) => t.id === techId);
    const isNewFrontier = !!tech && this.techDiscoverer[techId] === undefined;
    const hint = this.grantWithBackfill(playerId, techId);
    if (isNewFrontier && tech) {
      const order = this.branchTechOrder(tech.branch);
      const myIdx = order.findIndex((t) => t.id === techId);
      for (const p of this.players) {
        if (p.id === playerId) continue;
        for (let i = 0; i < myIdx; i++) {
          const backTech = order[i];
          if (!this.researchedTechs[p.id].has(backTech.id)) this.grantSingleTech(p.id, backTech.id);
        }
        this.upgradePlayerUnits(p.id);
      }
    }
    return hint;
  }

  /** Раздаёт `techId` игроку playerId, ПЕРЕД этим бесплатно добирая все позиции его ветки ниже,
   * которых у него ещё нет (см. `grantSingleTech` — те же бонусы первооткрывателя на каждую).
   * Эпоха игрока пересчитывается ОДИН раз в конце, по итогу всей пачки, не после каждой технологии.
   * Возвращает hint ТОЛЬКО от гранта самой `techId` (не от бесплатных бэкфилл-технологий ниже по
   * ветке — тем практически никогда не достаётся уведомляемый бонус первооткрывателя в одном и том
   * же вызове, а даже если и достаётся — это не то, что игрок только что осознанно выбрал). */
  private grantWithBackfill(playerId: number, techId: string): string | undefined {
    const tech = TECH_TREE.find((t) => t.id === techId);
    if (tech) {
      const order = this.branchTechOrder(tech.branch);
      const myIdx = order.findIndex((t) => t.id === techId);
      for (let i = 0; i < myIdx; i++) {
        const backTech = order[i];
        if (!this.researchedTechs[playerId].has(backTech.id)) this.grantSingleTech(playerId, backTech.id);
      }
    }
    const hint = this.grantSingleTech(playerId, techId);
    this.upgradePlayerUnits(playerId);
    return hint;
  }

  /** Один грант технологии игроку — бонусы первооткрывателя (право основать религию/авто-маршрут/
   * «Философия»), БЕЗ пересчёта эпохи (её считает вызывающий `researchTech` один раз на всю пачку,
   * см. выше). Кто ЛИЧНО первым в партии открыл технологию — решает ДВЕ вещи: право ОСНОВАТЬ религию
   * (adoptReligion, RELIGION_FOUNDING_TECHS) и авто-прокладку торгового маршрута ниже. Технологию
   * МОЖНО переоткрыть повторно (юниты/здания достаются как обычно), но бонус первооткрывателя —
   * только тому, для кого этот if сработал — isFirstDiscovery. */
  private grantSingleTech(playerId: number, techId: string): string | undefined {
    const isFirstDiscovery = this.techDiscoverer[techId] === undefined;
    if (isFirstDiscovery) {
      this.techDiscoverer[techId] = playerId;
      // Отношения AI — фактор 16 (по прямому запросу, «научное открытие (первооткрыватель) +2») —
      // у ВСЕХ живых наблюдателей растёт мнение об открывшем (репутация учёного, видна всей партии).
      for (const p of this.players) {
        if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
        this.adjustRelationScore(p.id, playerId, 2, "научное открытие");
      }
    }
    this.researchedTechs[playerId].add(techId);
    const tech = TECH_TREE.find((t) => t.id === techId);
    let hint: string | undefined;
    // [ИСПРАВЛЕНО] Право прокладки маршрута — только личному первооткрывателю технологии (по
    // прямому уточнению), тем же принципом, что и бонус религии/«Философии» ниже (isFirstDiscovery).
    // Раньше право доставалось ЛЮБОМУ игроку, кто когда-либо исследовал маршрутную технологию —
    // из-за этого маршрут одной и той же технологии могли проложить сразу несколько игроков.
    // ВСЕГДА сразу карта «Право прокладки маршрута» в руку — по прямому запросу («не надо сразу
    // предлагать строить маршрут [модальным окном сразу после исследования] — путать игрока, а
    // помещать карту в руку, и УЖЕ ОТТУДА он бесплатно и без действия прокладывает маршрут, когда
    // сам решит»): раньше при ≥2 своих городов сразу выставлялся блокирующий `pendingRoute`
    // («выберите город прямо сейчас») — игрок только что исследовал технологию и не ожидал, что
    // тут же нужно кликать по городам, путал этот момент с обычным продолжением хода. Теперь
    // ЕДИНСТВЕННЫЙ путь — карта (`playRouteRightCard`, уже бесплатна по действиям и её собственный
    // провал по-прежнему сохраняет карту для повторной попытки) — тот же путь, что раньше был только
    // у игрока с <2 городами или у неудачной геометрии в pickRouteCities.
    if (tech?.route && isFirstDiscovery) {
      this.hands[playerId].push(makeRouteRightCard(techId, tech.route));
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
    // «Кодекс законов»/«Порох» бонусы первооткрывателя (сокращение вдвое содержания/дальность
    // артиллерии) — применяются через techDiscoverer прямо в collectTaxes/unitStats, здесь ничего
    // дополнительно ставить не нужно. Аналогично «Рыцарство»/«Сталь»/«Банковское дело» (урон/дальность
    // атаки/скидка на бирже). Все постоянные «до конца партии», а не разовые, поэтому не нуждаются в
    // отдельном состоянии — сам techDiscoverer[techId] === playerId уже и есть флаг.

    // «Каменная кладка» — первооткрыватель разово получает 2 Силиката на склад (по прямому запросу,
    // было 3 — «сделай за каменную кладку первооткрывателю 2 силиката вместо 3»; до этого была
    // отдельная правка +4 → 3, см. ниже в истории решений — эта заменяет её).
    if (techId === "Каменная кладка" && isFirstDiscovery) {
      this.addToWarehouse(playerId, "silicates", 2);
    }
    // «Бронзовое дело» (по прямому запросу, НОВОЕ) — первооткрыватель разово получает 2 Леса на склад.
    if (techId === "Бронзовое дело" && isFirstDiscovery) {
      this.addToWarehouse(playerId, "wood", 2);
    }
    // «Гончарное дело» (по прямому запросу) — первооткрыватель разово получает 6💰.
    if (techId === "Гончарное дело" && isFirstDiscovery) {
      this.money[playerId] += 6;
    }
    // «Образование» (по прямому запросу — «карта учёного с золотой рубашкой как у рабочего из
    // монархии») — первооткрыватель разово получает бесплатную карту «Учёный» в руку: розыгрыш не
    // тратит ни ресурсов, ни действия (см. playFreeEducationCard/cards.ts CardDef.freeEducation).
    if (techId === "Образование" && isFirstDiscovery) {
      this.hands[playerId].push(makeFreeEducationCard());
    }
    // «Архитектура» (по прямому запросу — «первооткрыватель бесплатное здание получит, выбрать из
    // списка доступных сейчас на момент открытия») — первооткрыватель разово получает бесплатную
    // карту «Строитель» в руку: розыгрыш не тратит ни ресурсов, ни действия, только строит одно
    // здание из уже открытых игроком технологий (см. playFreeBuildingCard/cards.ts CardDef.freeBuilding).
    if (techId === "Архитектура" && isFirstDiscovery) {
      this.hands[playerId].push(makeFreeBuildingCard());
    }
    // «Радио» (по прямому запросу) — первооткрыватель разово получает 3 Контента на склад.
    if (techId === "Радио" && isFirstDiscovery) {
      this.addToWarehouse(playerId, "content", 3);
    }
    // «Телеграф» (по прямому запросу) — первооткрыватель разово получает доход, равный числу
    // существующих торговых путей ЛЮБОГО игрока (не только своих) на момент открытия.
    if (techId === "Телеграф" && isFirstDiscovery) {
      this.money[playerId] += this.tradeRoutes.length;
    }
    // «Экономика» (по прямому запросу — «сделай сбор налогов автоматом первооткрывателю сразу
    // применив эффект карты») — сразу же, без карты и без действия, применяется эффект «Соберите
    // налоги» (interactive: true — при нехватке денег на содержание встаёт обычный pendingTaxShortfall,
    // тот же путь, что и при добровольном розыгрыше карты).
    if (techId === "Экономика" && isFirstDiscovery) {
      hint = `Первооткрыватель: сбор налогов применён сразу — ${this.collectTaxes(playerId, true)}`;
    }
    // «Конвейер» (по прямому запросу) — первооткрыватель разово получает 3 Промтовара на склад;
    // текстовое уведомление возвращается в hint — confirmResearch/playFreeEducationCard/useUniversitet
    // прокидывают его в ActionResult, клиент показывает отдельным окном (см. main.ts).
    if (techId === "Конвейер" && isFirstDiscovery) {
      this.addToWarehouse(playerId, "promtovary", 3);
      hint =
        "Первооткрыватель «Конвейера»: +3 Промтовара на склад. Промтовары — торговый ресурс, которого нет на карте: единственный источник — Фабрика (§5), то есть монополия её владельца; используются как обычный торговый ресурс (постройки/исследования/«Торговец» и т.д.).";
    }
    // «Атомная энергия» (по прямому запросу) — первооткрыватель разово получает 2 Урана на склад.
    if (techId === "Атомная энергия" && isFirstDiscovery) {
      this.addToWarehouse(playerId, "uranium", 2);
    }
    // «Гильдии» (по прямому запросу) — первооткрыватель разово получает по 1 Специй, 1 Китов и 1 Мех
    // на склад.
    if (techId === "Гильдии" && isFirstDiscovery) {
      this.addToWarehouse(playerId, "spices", 1);
      this.addToWarehouse(playerId, "whales", 1);
      this.addToWarehouse(playerId, "fur", 1);
    }
    return hint;
  }

  /** Все НАСТОЯЩИЕ (не building-only, targetCount > 0) ресурсы класса «Стратегические» — пул для
   * «Геологоразведки», карта «Рабочий» (mineStrategicResource, см. выше). */
  private static GEO_SURVEY_RESOURCE_POOL: ResourceId[] = ["metalOre", "silicates", "hydrocarbons", "preciousMetals", "uranium", "rareEarth"];

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
      { kind: "specific", resource: "metalOre", count: 1 },
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
    const hint = this.researchTech(playerId, techId);
    return { ok: true, hint };
  }

  /** «Учёный», когда ВСЕ технологии партии уже открыты этим игроком (по прямому запросу) —
   * `availableResearchFor` в этом случае всегда пуст, обычный confirmResearch играть нечего;
   * розыгрыш вместо выбора технологии предлагает выбрать ОДИН из 4 фиксированных эффектов. Тот же
   * card+action расход, что у обычного confirmResearch, но БЕЗ ресурсной цены — цену исследования
   * неоткуда взять (нет эпохи технологии, которую покупаем), а сами 4 эффекта ничего не требуют,
   * кроме варианта 2 (постоянный, без цены) и варианта 4 (сами карты бесплатны при розыгрыше).
   * 1. Открывателю +1 населения во всех своих городах (не выше вместимости, `cityCapacityFor` —
   *    здесь она всегда 6, раз все 5 технологий вместимости уже открыты); у КАЖДОГО игрока (включая
   *    самого открывателя) 1 случайный свой город теряет 1 населения, не ниже 1 (тот же принцип, что
   *    у катастрофы «Пандемия» — `cataclysmPandemic`).
   * 2. Постоянный (до конца партии) +1 урона и +1HP ВСЕМ своим юнитам — новый флаг
   *    `scientistCombatBonusPlayers`, проверяется в `unitStats`, не технология.
   * 3. Каждый игрок (включая открывателя) сбрасывает 1 случайную НАСТОЯЩУЮ карту (не одну из
   *    бесплатных `freeMonarchy`/`freeFascism`/`freeEducation`/`freeBuilding`/`freeParliamentarism`/
   *    `freeForestGrowth` — их и так нельзя передать/сбросить, см. `consumeHandCard`), карта
   *    возвращается в общую колоду; открыватель в ТОТ ЖЕ ход добирает 2 карты с верха колоды.
   * 4. Открыватель получает 2 бесплатные карты «Рост леса» (`cards.ts: makeFreeForestGrowthCard`) —
   *    розыгрыш каждой бесплатен и по ресурсам, и по действию (см. `plantFreeForest`). */
  useScientistEndgameEffect(playerId: number, slotIndex: number, choice: 1 | 2 | 3 | 4): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "scientist" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Учёный» недоступна в этом слоте." };
    if (!TECH_TREE.every((t) => this.researchedTechs[playerId].has(t.id))) {
      return { ok: false, hint: "Ещё есть неоткрытые технологии — играйте «Учёного» обычным образом." };
    }
    this.consumeHandCard(playerId, slotIndex);
    let hint: string;
    switch (choice) {
      case 1: {
        const cap = this.cityCapacityFor(playerId);
        for (const c of this.cities) if (c.playerId === playerId) c.population = Math.min(cap, c.population + 1);
        for (const p of this.players) {
          const cities = this.cities.filter((c) => c.playerId === p.id);
          if (!cities.length) continue;
          const pick = cities[Math.floor(this.rng() * cities.length)];
          if (pick.population > 1) pick.population -= 1;
        }
        hint = "Все свои города +1 населения (не выше вместимости); у каждого игрока 1 случайный город теряет 1 населения.";
        break;
      }
      case 2: {
        this.scientistCombatBonusPlayers.add(playerId);
        hint = "Все ваши юниты получают +1 урона и +1HP до конца партии.";
        break;
      }
      case 3: {
        const isFreeCard = (c: CardDef) =>
          !!(c.freeMonarchy || c.freeFascism || c.freeEducation || c.freeBuilding || c.freeParliamentarism || c.freeForestGrowth);
        for (const p of this.players) {
          const hand = this.hands[p.id];
          const candidates = [...hand.keys()].filter((i) => !isFreeCard(hand[i]));
          if (!candidates.length) continue;
          const pickIdx = candidates[Math.floor(this.rng() * candidates.length)];
          const [discarded] = hand.splice(pickIdx, 1);
          this.shiftListingSlotsAfterRemoval(p.id, pickIdx);
          discarded.receivedFrom = undefined;
          this.deck.push(discarded);
        }
        for (let i = 0; i < 2; i++) {
          const next = this.deck.shift();
          if (next) this.hands[playerId].push(next);
        }
        hint = "Каждый игрок сбросил случайную карту; вы взяли 2 карты с колоды.";
        break;
      }
      case 4: {
        this.hands[playerId].push(makeFreeForestGrowthCard(), makeFreeForestGrowthCard());
        hint = "Получено 2 бесплатные карты «Рост леса» (без ресурсов и действия при розыгрыше).";
        break;
      }
    }
    return { ok: true, hint };
  }

  /** Розыгрыш бесплатной карты «Учёный» — бонус первооткрывателя «Образования» (по прямому запросу,
   * см. cards.ts CardDef.freeEducation) — тот же выбор технологии, что и confirmResearch, но БЕЗ
   * цены (ни ресурсов, ни действия) и БЕЗ ограничения `actionsLeft > 0` — тем же приёмом, что и
   * playRouteRightCard (карта не из колоды, её роспуск бесплатен по действиям). Карта одноразовая:
   * успешный розыгрыш просто убирает её из руки напрямую (не consumeHandCard — та списывает
   * действие безусловно). */
  playFreeEducationCard(playerId: number, slotIndex: number, techId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || !card.freeEducation) return { ok: false, hint: "В этом слоте нет бесплатной карты «Учёный»." };
    const tech = this.availableResearchFor(playerId).find((t) => t.id === techId);
    if (!tech) return { ok: false, hint: "Эта технология сейчас недоступна для исследования." };
    this.hands[playerId].splice(slotIndex, 1);
    this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
    const hint = this.researchTech(playerId, techId);
    return { ok: true, hint };
  }

  /** Розыгрыш бесплатной карты «Строитель» — бонус первооткрывателя «Архитектуры» (по прямому
   * запросу, см. cards.ts CardDef.freeBuilding) — тот же выбор здания, что и buildBuilding, но БЕЗ
   * цены (ни ресурсов, ни действия) и БЕЗ ограничения `actionsLeft > 0`, тем же приёмом, что и
   * playFreeEducationCard. Здание должно быть уже открыто исследованными технологиями игрока «на
   * момент открытия» (по прямому уточнению) — но сама карта разыгрывается когда угодно, пока лежит
   * в руке, проверка технологии — на момент РОЗЫГРЫША карты, не на момент получения. Карта
   * одноразовая: успешный розыгрыш просто убирает её из руки напрямую (не consumeHandCard). */
  playFreeBuildingCard(playerId: number, slotIndex: number, buildingId: string): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || !card.freeBuilding) return { ok: false, hint: "В этом слоте нет бесплатной карты «Строитель»." };
    if (isOwnedBy(this.buildingOwners, buildingId, playerId)) return { ok: false, hint: "У вас уже есть это здание." };
    const def = BUILDINGS.find((b) => b.id === buildingId);
    if (!def) return { ok: false, hint: "Здание не найдено." };
    if (def.tech !== null && !this.researchedTechs[playerId].has(def.tech)) {
      return { ok: false, hint: `Здание «${def.name}» открывается технологией «${def.tech}» — она ещё не исследована.` };
    }
    if (!claimBuilding(this.buildingOwners, buildingId, playerId)) return { ok: false, hint: "Здание уже занято двумя другими игроками." };
    this.hands[playerId].splice(slotIndex, 1);
    this.shiftListingSlotsAfterRemoval(playerId, slotIndex);
    // Совет ООН (§15.3) — та же регистрация кандидата, что и у обычной buildBuilding, иначе
    // бесплатная постройка ООН этой картой никогда не делала бы игрока кандидатом.
    if (buildingId === "oon") {
      if (this.oonCandidate1Id === null) {
        this.oonCandidate1Id = playerId;
        this.holdOonElection();
        this.oonNextElectionCycle = this.cyclesElapsed + GameSession.OON_ELECTION_INTERVAL_CYCLES;
      } else if (this.oonCandidate2Id === null && playerId !== this.oonCandidate1Id) {
        this.oonCandidate2Id = playerId;
      }
    }
    return { ok: true, hint: `Бесплатно построено: «${def.name}».` };
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
   * остаётся в руке (пробуйте другую пару городов), ни карта, ни действие не тратятся. [ИЗМЕНЕНО ПО
   * ПРЯМОМУ ЗАПРОСУ] — само разыгрывание тоже БЕСПЛАТНО по действиям (не списывает `actionsLeft`,
   * доступно даже при 0 действий): «это не карта [в обычном смысле], а остаточное право» — она не из
   * колоды (минтится сервером, когда исследованная маршрутная технология не смогла проложить путь,
   * см. makeRouteRightCard/pickRouteCities), уже не занимает лимит руки (ТЗ 2.3.1) — теперь и в
   * действиях с неё как с обычной карты не спрашивается. Никакого денежного/ресурсного платежа у неё
   * не было и раньше (это не «Торговый путь» — там 2 разных торговых ресурса и полноценное действие). */
  playRouteRightCard(playerId: number, slotIndex: number, fromCityId: number, toCityId: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "routeRight" || !card.routeTechId || !card.routeCategory) {
      return { ok: false, hint: "В этом слоте нет карты «Право прокладки маршрута»." };
    }
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
    return { ok: true };
  }

  /** Портировано из adoptParadigm — includes the "skip next turn" penalty for the switch itself.
   * Никакого ограничения «уже принята другим игроком» — по прямому уточнению парадигма НЕ
   * эксклюзивна (в отличие от религии — там первую НЕОСНОВАННУЮ религию может основать только
   * личный первооткрыватель, см. adoptReligion): любой игрок с нужной технологией может принять
   * любую доступную ему парадигму независимо от выбора остальных игроков. */
  /** По прямому запросу — «запрети смену религии и парадигм во время войны, нельзя терять ходы в
   * такой ситуации»: и `adoptReligion`, и `adoptParadigm` безусловно пропускают следующий ход этого
   * игрока («революция», см. оба метода) — во время войны такая потеря темпа особенно опасна. */
  private isAtWar(playerId: number): boolean {
    // Выбывший игрок (eliminatedPlayers) исключён из проверки — живой баг-репорт «зелёный
    // уничтожен, но красный всё ещё не может сменить парадигму»: флаг войны с выбывшим никогда не
    // снимается (мириться уже не с кем), без этого исключения `isAtWar` держал бы игрока в вечной
    // «войне» с призраком до конца партии.
    return this.players.some((p) => p.id !== playerId && !this.eliminatedPlayers.has(p.id) && this.relationOf(playerId, p.id).war);
  }

  adoptParadigm(playerId: number, paradigm: Paradigm): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!this.researchedTechs[playerId].has(GameSession.PARADIGM_META[paradigm].tech)) return { ok: false, hint: "Технология для этой парадигмы ещё не исследована." };
    if (this.playerParadigm[playerId] === paradigm) return { ok: false, hint: "Эта парадигма уже принята." };
    // Фашизм — единственное исключение из запрета смены во время войны (по прямому запросу): это
    // именно военная парадигма (условие принятия — военная слабость, см. bot.ts paradigmViable), а
    // запрет мешал бы принять её ровно тогда, когда она реально нужна.
    if (paradigm !== "fascism" && this.isAtWar(playerId)) {
      return { ok: false, hint: "Смена парадигмы пропускает ход — во время войны это недоступно. Дождитесь мира или перемирия." };
    }
    this.playerParadigm[playerId] = paradigm;
    // Отношения AI — фактор 15 (по прямому запросу, «приняли ту же парадигму +5 / другую −2») — у
    // ВСЕХ живых наблюдателей Q, УЖЕ выбравших СВОЮ парадигму (playerParadigm[Q] !== null — нет
    // парадигмы вовсе не с чем сравнивать, нейтрально): та же — их мнение о playerId растёт, другая
    // — падает.
    for (const p of this.players) {
      if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
      const theirs = this.playerParadigm[p.id];
      if (theirs === null || theirs === undefined) continue;
      this.adjustRelationScore(p.id, playerId, theirs === paradigm ? 5 : -2, "смена парадигмы");
    }
    this.skippedTurn.add(playerId);
    this.skipTurnReason[playerId] = "paradigm";
    // Снять бесплатную карту СТАРОЙ парадигмы (если ещё лежит неиграной) — см. doc у
    // discardStaleParadigmCards, живой баг-репорт «парламентаризм не исчезает какое-то время».
    this.discardStaleParadigmCards(playerId, paradigm);
    // Монархия/Фашизм/Парламентаризм дают бесплатную карту сразу при принятии, не дожидаясь конца
    // цикла (дальше она обновляется в endTurn'е, см. grantMonarchyWorkerCards/grantFascismWarriorCards/
    // grantParliamentarismBuilderCards).
    this.grantMonarchyWorkerCards();
    this.grantFascismWarriorCards();
    this.grantParliamentarismBuilderCards();
    // Коммунизм автоматом переводит игрока в Атеизм — по прямому запросу («коммунизм автоматом ведёт
    // к принятию атеизма»), НЕ через `adoptReligion` (та же смена в тот же ход не должна пропускать
    // ход ВТОРОЙ раз — «революция» уже случилась строкой выше, см. её doc; прямая мутация поля, без
    // прав на основание/кулдауна — атеизм всегда свободно доступен). Религия при ЛЮБОЙ ДРУГОЙ
    // парадигме по-прежнему независима (не трогается здесь вовсе) — это исключение только для
    // Коммунизма. Игрок остаётся волен вручную сменить религию на настоящую и позже, пока Коммунизм
    // активен — просто без бонуса действия (см. endTurn — атеизм ПОД Коммунизмом даёт тот же +1
    // действие, что обычно даёт любая НЕ-атеистическая религия, а любая другая религия ПОД
    // Коммунизмом бонуса не даёт вовсе).
    if (paradigm === "communism" && this.playerReligion[playerId] !== "atheism") {
      this.playerReligion[playerId] = "atheism";
      // Отношения AI — фактор 14, тот же что в adoptReligion (см. её doc) — эта ветка меняет религию
      // В ОБХОД adoptReligion (прямая мутация, см. комментарий выше), поэтому фактор нужно повторить
      // здесь отдельно, иначе смена религии «Коммунизмом» была бы единственным путём, ничего не
      // двигающим на шкале отношений.
      for (const p of this.players) {
        if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
        const theirs = this.playerReligion[p.id];
        if (theirs === null || theirs === undefined) continue;
        this.adjustRelationScore(p.id, playerId, theirs === "atheism" ? 10 : -5, "смена парадигмы");
      }
    }
    return { ok: true };
  }

  /** По прямому уточнению — не только «Мистицизм»: три технологии ветки «религия» (эпохи 1-2) дают
   * право основать новую религию — «Мистицизм», «Философия», «Богословие». Любая из трёх, личным
   * (платным) исследованием, не бесплатной догонкой. */
  private static RELIGION_FOUNDING_TECHS = ["Мистицизм", "Философия", "Богословие"];
  /** Кулдаун смены УЖЕ принятой религии (по прямому запросу, bot.ts: считывается ботом в
   * considerReligion — самый первый выбор, из «нет религии», этим не ограничен) — сама блокировка
   * выставляется здесь же, внутри adoptReligion, см. комментарий там же. */
  static RELIGION_CHANGE_COOLDOWN_CYCLES = 6;
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
    if (this.isAtWar(playerId)) {
      return { ok: false, hint: "Принятие/смена религии пропускает ход — во время войны это недоступно. Дождитесь мира или перемирия." };
    }
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
    // Отношения AI — фактор 14 (по прямому запросу, «приняли ту же религию +10 / другую −5») — та же
    // схема, что и у фактора 15 (парадигма) выше: у ВСЕХ живых наблюдателей, УЖЕ выбравших СВОЮ
    // религию (null — ещё не выбрана, нет с чем сравнивать, нейтрально).
    for (const p of this.players) {
      if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
      const theirs = this.playerReligion[p.id];
      if (theirs === null || theirs === undefined) continue;
      this.adjustRelationScore(p.id, playerId, theirs === religion ? 10 : -5, "смена религии");
    }
    // Смена религии (по прямому запросу) — та же «революция», что у смены парадигмы: пропускает
    // следующий ход этого игрока (даже самую первую религию, тем же принципом, что и у парадигмы).
    // Не суммируется с одновременной сменой парадигмы в тот же ход — skippedTurn это Set по
    // playerId, повторная запись того же игрока просто не создаёт второй пропуск подряд (см.
    // advanceCurrentPlayer/endTurn), реальный (последний) повод остаётся в skipTurnReason.
    this.skippedTurn.add(playerId);
    this.skipTurnReason[playerId] = "religion";
    // [ИСПРАВЛЕНО, живой баг-репорт — «компы постоянно меняют религии, теряя ходы, непонятно зачем»]
    // Кулдаун смены религии (bot.ts: considerReligion, RELIGION_CHANGE_COOLDOWN_CYCLES) раньше
    // выставлялся ТОЛЬКО из bot.ts, ПОСЛЕ dispatch — а во время планирования хода AI (computeAiTurnPlan)
    // dispatch идёт на ОДНОРАЗОВЫЙ клон (structuredClone+fromJSON), который потом просто выбрасывается
    // — реальную партию воспроизводит только записанный СПИСОК действий (executeAiPlan), а прямая
    // JS-мутация поля `aiReligionLockUntilCycle` клона в этот список не попадает и терялась целиком.
    // Из-за этого кулдаун ни разу не срабатывал по-настоящему: бот переоценивал религию каждый ход
    // заново без всякой памяти о только что случившейся смене — и каждая такая смена ЗАНОВО пропускала
    // ход (см. выше), отсюда «постоянно меняют религии, теряя ходы». Теперь блокировка выставляется
    // прямо здесь — часть настоящей мутации состояния, которая honestly проходит через executeAiPlan.
    this.aiReligionLockUntilCycle[playerId] = this.cyclesElapsed + GameSession.RELIGION_CHANGE_COOLDOWN_CYCLES;
    return { ok: true };
  }

  // === Дипломатия (ТЗ 11.7) =======================================================================

  /** Проверка, что ВСЕ платные условия предложения реально выполнимы, ДО того как хоть одно из них
   * применится — по прямому уточнению («мир был заключён без учёта требования оплаты денег за
   * перемирие» — раньше demandMoney/offerMoney/demandResource/giveResource в applyProposalTerms
   * молча урезали платёж до того, что реально есть (вплоть до 0), вместо отказа, а «Мир»/соглашения
   * из того же предложения при этом всё равно применялись). Сделка целиком атомарна: либо выполнимы
   * ВСЕ условия сразу, либо не применяется ни одно — вызывающий (resolveProposal) обязан звать это
   * ДО splice/applyProposalTerms при accepted=true. */
  private proposalUnaffordableReason(p: Proposal): string | null {
    for (const term of p.terms) {
      if (term.kind === "demandMoney" && this.money[p.to] < term.amount) {
        return `у ${this.players[p.to]?.name ?? "получателя"} не хватает денег (нужно ${term.amount} 💰, есть ${this.money[p.to]}).`;
      }
      if (term.kind === "offerMoney" && this.money[p.from] < term.amount) {
        return `у ${this.players[p.from]?.name ?? "отправителя"} больше не хватает обещанных денег (нужно ${term.amount} 💰).`;
      }
      if (term.kind === "demandResource" && (this.warehouse[p.to]?.[term.resource] ?? 0) < term.qty) {
        return `у получателя не хватает на складе ${GameSession.RESOURCE_META.get(term.resource)?.label ?? term.resource}.`;
      }
      if (term.kind === "giveResource" && (this.warehouse[p.from]?.[term.resource] ?? 0) < term.qty) {
        return `у отправителя больше не хватает на складе ${GameSession.RESOURCE_META.get(term.resource)?.label ?? term.resource}.`;
      }
      if (term.kind === "demandCity") {
        const c = this.cities.find((c) => c.id === term.cityId);
        if (!c || c.playerId !== p.to) return "требуемый город получателю уже не принадлежит.";
      }
      if (term.kind === "giveCity") {
        const c = this.cities.find((c) => c.id === term.cityId);
        if (!c || c.playerId !== p.from) return "обещанный город отправителю уже не принадлежит.";
      }
    }
    return null;
  }

  /** Портировано из applyProposalTerms.
   *
   * Отношения AI (по прямому запросу) — два фактора считаются здесь:
   * - Фактор 2 «дань/подарок = ценность переданного / 2» — на КАЖДЫЙ терм, реально передающий
   *   деньги/ресурс (не 0, т.е. реально что-то ушло) — мнение ПОЛУЧИВШЕГО о ЗАПЛАТИВШЕМ растёт.
   *   `demandMoney`/`demandResource` (получатель ВЫНУЖДЕН заплатить) считаются наравне с
   *   `offerMoney`/`giveResource` (доброволько) — по буквальному тексту фактора «выплатил дань,
   *   сделал подарок» — это одно и то же с точки зрения того, КТО отдал ценность. Город сюда не
   *   входит — у него уже есть свой фиксированный фактор 8 (см. `transferCity`, cause="deal").
   * - Фактор 19 «мир БЕЗ контрибуций +10» — если В ЭТОМ ЖЕ предложении, кроме "peace"/"agreement",
   *   нет ни одного термa, реально передающего ценность (деньги/ресурс/город) — мнение получателя
   *   мирного предложения о инициаторе растёт.
   */
  /** Односторонний разрыв соглашения (по прямому запросу, этап 9 приоритета 7 — «разорвать при
   * враждебных отношениях») — в отличие от `applyProposalTerms` (двустороннее ПРИНЯТИЕ через
   * предложение), любая сторона может в любой момент СВОЕГО хода разорвать УЖЕ действующее
   * соглашение с конкретным партнёром единолично — не требует согласия другой стороны (соглашения,
   * в отличие от мира, не защищены сроком/перемирием — их всегда можно снять). */
  breakAgreement(playerId: number, otherId: number, agreement: Agreement): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const rel = this.relationOf(playerId, otherId);
    if (!rel.agreements.has(agreement)) return { ok: false, hint: "Этого соглашения между вами и так нет." };
    rel.agreements.delete(agreement);
    this.logEvent(`Дипломатия: ${this.playerName(playerId)} разорвал «${GameSession.AGREEMENT_META[agreement].label}» с ${this.playerName(otherId)}.`);
    return { ok: true };
  }

  /** «Откупился — 3 цикла не нападают» (по прямому уточнению, см. `TRIBUTE_PROTECTION_CYCLES`) —
   * реально выплаченная дань ставит паре перемирие на 3 цикла тем же полем `Relation.truceUntilCycle`,
   * что и обычный «Мир» (его уже проверяет `declareWar`, никакой отдельной ветки не потребовалось).
   * Уже действующее более долгое перемирие не укорачивается. */
  private grantTributeProtection(demanderId: number, payerId: number) {
    const rel = this.relationOf(demanderId, payerId);
    const until = this.cyclesElapsed + GameSession.TRIBUTE_PROTECTION_CYCLES;
    if (rel.truceUntilCycle === undefined || rel.truceUntilCycle < until) rel.truceUntilCycle = until;
  }

  private applyProposalTerms(p: Proposal) {
    const hasValueTransfer = p.terms.some(
      (t) => t.kind === "demandMoney" || t.kind === "offerMoney" || t.kind === "demandResource" || t.kind === "giveResource" || t.kind === "demandCity" || t.kind === "giveCity"
    );
    for (const term of p.terms) {
      if (term.kind === "agreement") {
        this.relationOf(p.from, p.to).agreements.add(term.agreement);
        this.logEvent(`Соглашение: «${GameSession.AGREEMENT_META[term.agreement].label}» между ${this.playerName(p.from)} и ${this.playerName(p.to)}.`);
        // Отношения AI — фактор 6 (по прямому запросу — «заключение соглашения разово поднимает
        // отношения на 5, а не на 1 каждый цикл пока действует соглашение, как было раньше») —
        // разовый бонус ОБЕИМ сторонам в момент заключения ЛЮБОГО из 6 видов соглашения; заменяет
        // прежний per-cycle дрейф +1/цикл, пока соглашение действует (см. resolveCycleBoundary —
        // тот дрейф убран целиком).
        this.adjustRelationScore(p.to, p.from, 5, "заключил соглашение");
        this.adjustRelationScore(p.from, p.to, 5, "заключил соглашение");
        // Отношения AI — фактор 18 (по прямому запросу, «соглашение с моим врагом/тем кого ненавижу
        // −5») — у ВСЕХ живых ТРЕТЬИХ наблюдателей Z, для которых ЛИБО p.from, ЛИБО p.to — «враг/
        // ненависть» (relationScoreOf(Z,X) <20, т.е. hostile или хуже): мнение Z о ДРУГОЙ стороне
        // этого соглашения падает — «спелся с моим врагом».
        for (const z of this.players) {
          if (this.eliminatedPlayers.has(z.id) || z.id === p.from || z.id === p.to) continue;
          if (this.relationScoreOf(z.id, p.to) < 20) this.adjustRelationScore(z.id, p.from, -5, "соглашение с моим врагом");
          if (this.relationScoreOf(z.id, p.from) < 20) this.adjustRelationScore(z.id, p.to, -5, "соглашение с моим врагом");
        }
      } else if (term.kind === "peace") {
        // Срок перемирия (по прямому запросу, 2-6 циклов) — пока не истёк (cyclesElapsed дошёл до
        // truceUntilCycle), ни одна из сторон не может объявить войну другой снова (см. declareWar).
        const rel = this.relationOf(p.from, p.to);
        const wasAtWar = rel.war;
        rel.war = false;
        rel.truceUntilCycle = this.cyclesElapsed + term.duration;
        if (wasAtWar) {
          this.logEvent(`Война: заключён мир между ${this.playerName(p.from)} и ${this.playerName(p.to)} (перемирие на ${term.duration} цикл.).`);
          this.evictTrespassersAfterPeace(p.from, p.to);
        }
        // Отношения AI — фактор 19 (по прямому запросу — «заключение мира с контрибуцией +5, без
        // контрибуций +10, все разово») — ровно один из двух, по факту наличия хоть одного терма,
        // реально передающего ценность (деньги/ресурс/город), в ТОМ ЖЕ предложении.
        if (!hasValueTransfer) this.adjustRelationScore(p.to, p.from, 10, "мир без контрибуций");
        else this.adjustRelationScore(p.to, p.from, 5, "мир с контрибуцией");
      } else if (term.kind === "demandMoney") {
        const pay = Math.min(term.amount, this.money[p.to]);
        this.money[p.to] -= pay;
        this.money[p.from] += pay;
        if (pay > 0) {
          this.adjustRelationScore(p.from, p.to, valueOfMoney(pay) / 2, "выплатил дань");
          this.grantTributeProtection(p.from, p.to);
        }
      } else if (term.kind === "offerMoney") {
        const pay = Math.min(term.amount, this.money[p.from]);
        this.money[p.from] -= pay;
        this.money[p.to] += pay;
        if (pay > 0) this.adjustRelationScore(p.to, p.from, valueOfMoney(pay) / 2, "сделал подарок");
      } else if (term.kind === "giveCity") {
        const c = this.cities.find((c) => c.id === term.cityId);
        if (c && c.playerId === p.from) this.transferCity(c, p.to, "deal");
      } else if (term.kind === "demandCity") {
        const c = this.cities.find((c) => c.id === term.cityId);
        if (c && c.playerId === p.to) this.transferCity(c, p.from, "deal");
      } else if (term.kind === "demandResource") {
        const qty = Math.min(term.qty, this.warehouse[p.to][term.resource] ?? 0);
        if (qty > 0 && this.takeFromWarehouse(p.to, term.resource, qty)) {
          this.addToWarehouse(p.from, term.resource, qty);
          this.adjustRelationScore(p.from, p.to, (valueOfResource(this, term.resource) * qty) / 2, "выплатил дань");
          this.grantTributeProtection(p.from, p.to);
        }
      } else if (term.kind === "giveResource") {
        const qty = Math.min(term.qty, this.warehouse[p.from][term.resource] ?? 0);
        if (qty > 0 && this.takeFromWarehouse(p.from, term.resource, qty)) {
          this.addToWarehouse(p.to, term.resource, qty);
          this.adjustRelationScore(p.to, p.from, (valueOfResource(this, term.resource) * qty) / 2, "сделал подарок");
        }
      } else if (
        term.kind === "promiseNoSettle" ||
        term.kind === "promiseNoAttack" ||
        term.kind === "promiseNoEventCards" ||
        term.kind === "promiseGiveCardType" ||
        term.kind === "promiseListResource"
      ) {
        // Отношения AI — система обещаний (по прямому запросу, фактор 9): p.from ПРОСИЛ это
        // обещание, p.to ПРИНЯЛ (только приём попадает в applyProposalTerms) — значит p.to ДАЁТ
        // обещание (`by`), p.from ЕГО ПОЛУЧАЕТ (`to`, в чьих интересах оно исполняется). «Обещание
        // дано +5» — получатель ценит сам факт обещания, независимо от исхода.
        const kindMap = { promiseNoSettle: "noSettle", promiseNoAttack: "noAttack", promiseNoEventCards: "noEventCards", promiseGiveCardType: "giveCardType", promiseListResource: "listResource" } as const;
        const promise: AiPromise = {
          id: this.nextPromiseId++,
          by: p.to,
          to: p.from,
          kind: kindMap[term.kind],
          expiresAtCycle: this.cyclesElapsed + term.duration,
          ...(term.kind === "promiseNoSettle" ? { regionCol: term.regionCol, regionRow: term.regionRow } : {}),
          ...(term.kind === "promiseNoEventCards" ? { excludedPlayerId: term.excludedPlayerId } : {}),
          ...(term.kind === "promiseGiveCardType" ? { cardId: term.cardId } : {}),
          ...(term.kind === "promiseListResource" ? { resource: term.resource } : {}),
        };
        this.activePromises.push(promise);
        this.adjustRelationScore(p.from, p.to, 5, "обещание дано");
      } else if (term.kind === "callToWar") {
        // Отправитель УЖЕ воюет с targetId (проверено в sendProposal) — принятие объявляет войну
        // ОТ ПОЛУЧАТЕЛЯ (p.to), присоединяя его на стороне отправителя.
        this.declareWar(p.to, term.targetId);
      } else if (term.kind === "jointAttack") {
        // Ни одна из сторон ещё не воевала с targetId — принятие объявляет войну от ОБЕИХ сразу.
        this.declareWar(p.from, term.targetId);
        this.declareWar(p.to, term.targetId);
      } else if (term.kind === "breakTiesWith") {
        // «Прекратить торговлю с врагом» — принявший (p.to) рвёт ВСЕ соглашения с третьим игроком.
        // Тот, с кем порвали, это замечает: разрыв соглашений — недружественный шаг в его адрес.
        const broken = this.relationOf(p.to, term.targetId).agreements.size;
        if (broken > 0) {
          this.relationOf(p.to, term.targetId).agreements.clear();
          this.adjustRelationScore(term.targetId, p.to, -5 * broken, "разорвал соглашения по просьбе третьей стороны");
        }
      }
    }
  }

  /** Отношения AI — обещания (фактор 9): истечение срока БЕЗ нарушения (`by` дожил до
   * `expiresAtCycle`) — по-разному трактуется для 2 классов обещаний (см. AiPromise doc): «не
   * делай»-обещания (noSettle/noAttack/noEventCards) считаются ВЫПОЛНЕННЫМИ (+5 получателю),
   * «сделай»-обещания (giveCardType/listResource) — наоборот, истечение БЕЗ исполнения — и есть
   * нарушение (−10). Активные нарушения (breakPromise, см. foundCity/declareWar/handoffCard) уже
   * удалили запись раньше, чем она успевает попасть сюда — здесь только «дожившие» обещания. */
  /** Человекочитаемое описание обещания (по прямому запросу — «лог дипломатии нужно полностью вести
   * все дипломатические действия») — используется во всех логах, где решается судьба обещания
   * (истечение/нарушение/досрочное исполнение). */
  private describePromise(promise: AiPromise): string {
    switch (promise.kind) {
      case "noSettle":
        return `не селиться в регионе (${promise.regionCol},${promise.regionRow})`;
      case "noAttack":
        return "не нападать";
      case "noEventCards":
        return `не делиться картами событий с ${this.playerName(promise.excludedPlayerId!)}`;
      case "giveCardType":
        return `отдать карту «${promise.cardId}»`;
      case "listResource":
        return `выставить на биржу ${GameSession.RESOURCE_META.get(promise.resource!)?.label ?? promise.resource}`;
    }
  }

  private applyPromiseExpirations() {
    const remaining: AiPromise[] = [];
    for (const promise of this.activePromises) {
      if (this.cyclesElapsed < promise.expiresAtCycle) {
        remaining.push(promise);
        continue;
      }
      if (promise.kind === "giveCardType" || promise.kind === "listResource") {
        this.adjustRelationScore(promise.to, promise.by, -10, "обещание не исполнено к сроку");
        this.logEvent(`Дипломатия: ${this.playerName(promise.by)} не исполнил к сроку обещание ${this.playerName(promise.to)} — ${this.describePromise(promise)}.`);
      } else {
        this.adjustRelationScore(promise.to, promise.by, 5, "обещание выполнено");
        this.logEvent(`Дипломатия: обещание ${this.playerName(promise.by)} игроку ${this.playerName(promise.to)} — ${this.describePromise(promise)} — выполнено (срок истёк без нарушения).`);
      }
    }
    this.activePromises = remaining;
  }

  /** Отношения AI — нарушение конкретного активного обещания (по прямому запросу — «может быть
   * нарушено, если планы изменились» — не блокирует само действие, только штраф пост-фактум и
   * снятие записи, чтобы то же обещание не сработало дважды). */
  private breakPromise(promise: AiPromise) {
    this.activePromises.splice(this.activePromises.indexOf(promise), 1);
    this.adjustRelationScore(promise.to, promise.by, -10, "обещание нарушено");
    this.logEvent(`Дипломатия: ${this.playerName(promise.by)} нарушил обещание ${this.playerName(promise.to)} — ${this.describePromise(promise)}.`);
  }

  /** Отношения AI — досрочное исполнение «сделай»-обещания (giveCardType/listResource, до истечения
   * `duration`) — зеркало breakPromise: снимает запись, +5 вместо −10 (см. AiPromise doc). */
  private fulfillPromise(promise: AiPromise) {
    this.activePromises.splice(this.activePromises.indexOf(promise), 1);
    this.adjustRelationScore(promise.to, promise.by, 5, "обещание выполнено");
    this.logEvent(`Дипломатия: ${this.playerName(promise.by)} досрочно исполнил обещание ${this.playerName(promise.to)} — ${this.describePromise(promise)}.`);
  }

  /** Портировано из sendProposal. */
  /** `scenarioKey` (по прямому запросу — отношения AI, «нет смысла просить второй раз, если
   * отказали») — необязательная метка сценария бота (см. bot.ts: diplomacyAttemptMemory); ЛЮДИ её
   * никогда не передают (человеческий композер не знает об этой памяти вовсе). Штампуется здесь,
   * ВНУТРИ dispatch-пути — а не сырым сайд-эффектом в bot.ts во время планирования хода: планирование
   * (`computeAiTurnPlan`) работает на ОДНОРАЗОВОМ КЛОНЕ сессии (см. заголовок bot.ts), который после
   * возврата плана выбрасывается — любая мутация состояния клона, не прошедшая ЧЕРЕЗ реальный
   * dispatch-вызов (значит не попавшая в записанные шаги плана), никогда не долетит до настоящей
   * сессии. Штампуется РАНЬШЕ технологии/контакта — сама структурная невозможность (например нет
   * контакта) тоже не повод пытаться снова на следующий ход. */
  sendProposal(playerId: number, to: number, terms: ProposalTerm[], ultimatum: boolean, scenarioKey?: string): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!terms.length) return { ok: false, hint: "Предложение не может быть пустым." };
    if (scenarioKey) this.diplomacyAttemptMemory[`${playerId}:${to}:${scenarioKey}`] = this.cyclesElapsed;
    if (this.oonSanctionedPlayerId !== null && (playerId === this.oonSanctionedPlayerId || to === this.oonSanctionedPlayerId)) {
      return { ok: false, hint: "Резолюция ООН «Санкции» запрещает любую дипломатию с этим игроком." };
    }
    // Срок перемирия (по прямому запросу) — 2-6 циклов включительно, обязателен у каждого условия
    // «Мир» в предложении.
    for (const term of terms) {
      if (term.kind === "peace" && (!Number.isInteger(term.duration) || term.duration < 2 || term.duration > 6)) {
        return { ok: false, hint: "Срок перемирия должен быть целым числом от 2 до 6 циклов." };
      }
      if (term.kind === "callToWar") {
        if (!this.relationOf(playerId, term.targetId).war) {
          return { ok: false, hint: "Вы не воюете с этим игроком — нечего звать на помощь." };
        }
      }
      if (term.kind === "jointAttack") {
        if (this.relationOf(playerId, term.targetId).war || this.relationOf(to, term.targetId).war) {
          return { ok: false, hint: "Кто-то из вас уже воюет с этим игроком — совместное нападение не имеет смысла." };
        }
      }
      if (term.kind === "agreement") {
        const meta = GameSession.AGREEMENT_META[term.agreement];
        if (!this.researchedTechs[playerId].has(meta.tech)) {
          return { ok: false, hint: `«${meta.label}» требует технологию «${meta.tech}» — она ещё не открыта у вас.` };
        }
        // «Совместная оборона» нельзя заключить, если ЛЮБАЯ из сторон уже ведёт войну (с кем угодно)
        // — по прямому запросу: оборонительный пакт защищает от БУДУЩЕЙ угрозы, а не задним числом
        // подключает к уже идущей войне через техническую лазейку (сам пакт не втягивает в чужую
        // войну автоматически, см. cascadeAllianceWar — срабатывает только на НОВОЕ объявление войны
        // ПОСЛЕ заключения пакта, но заключать его с уже воюющей стороной всё равно бессмысленно).
        if (term.agreement === "mutualDefense" && (this.isAtWar(playerId) || this.isAtWar(to))) {
          return { ok: false, hint: "«Совместная оборона» невозможна — одна из сторон уже ведёт войну." };
        }
        // Контакт для соглашений (по прямому запросу) — общая граница территорий или торговый
        // маршрут между городами; «Радио» снимает это требование. Мир/война (term.kind === "peace",
        // declareWar) контакта не требуют никогда — иначе с воевавшим без контакта игроком было бы
        // невозможно помириться.
        if (!this.researchedTechs[playerId].has("Радио") && !this.hasContactWith(playerId, to)) {
          return {
            ok: false,
            hint: `Нет контакта с этим игроком — нужна общая граница территорий, торговый маршрут между вашими городами, или технология «Радио» (снимает требование контакта для дипломатии).`,
          };
        }
      }
    }
    this.pendingProposals.push({ id: this.nextProposalId++, from: playerId, to, terms, ultimatum });
    this.logEvent(`Дипломатия: ${this.playerName(playerId)} отправил предложение ${this.playerName(to)}${ultimatum ? " (ультиматум)" : ""} — ${this.describeProposalTerms(terms)}.`);
    // Отношения AI — фактор 20 (по прямому запросу, «у меня требуют дань/подарок −2»): срабатывает
    // на САМ ФАКТ требования, в момент отправки (не при resolveProposal — сам факт того, что просят,
    // уже неприятен, вне зависимости от того, согласятся ли в итоге). Один раз за предложение, даже
    // если демандов несколько сразу — это одно событие «у меня требуют», не сумма по строкам.
    if (terms.some((t) => t.kind === "demandMoney" || t.kind === "demandResource" || t.kind === "demandCity")) {
      this.adjustRelationScore(to, playerId, -2, "у меня требуют дань");
    }
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
    const peaceTerm = p.terms.find((t): t is Extract<ProposalTerm, { kind: "peace" }> => t.kind === "peace");
    if (accepted) {
      const reason = this.proposalUnaffordableReason(p);
      if (reason) return { ok: false, hint: `Нельзя принять целиком — ${reason} Отклоните, или дождитесь, пока условие станет выполнимым.` };
      // Минимальная длительность войны (по прямому запросу) — «мир» из этого предложения ЗАКЛЮЧИТЬ
      // нельзя, пока не прошло 3 цикла с начала войны (или с последнего отказа от мира, см. declareWar/
      // ветку отказа ниже) — предложение остаётся висеть нерешённым, отправитель может его отозвать
      // сам, но получатель принять целиком до срока не может.
      if (peaceTerm) {
        const rel = this.relationOf(p.from, p.to);
        if (rel.noPeaceBeforeCycle !== undefined && this.cyclesElapsed < rel.noPeaceBeforeCycle) {
          return { ok: false, hint: `Война должна продлиться ещё минимум ${rel.noPeaceBeforeCycle - this.cyclesElapsed} цикл(ов), прежде чем можно заключить мир.` };
        }
      }
    }
    this.pendingProposals.splice(idx, 1);
    if (accepted) {
      this.logEvent(`Дипломатия: ${this.playerName(p.to)} принял предложение от ${this.playerName(p.from)} — ${this.describeProposalTerms(p.terms)}.`);
      this.applyProposalTerms(p);
    } else {
      this.logEvent(`Дипломатия: ${this.playerName(p.to)} отклонил предложение от ${this.playerName(p.from)} — ${this.describeProposalTerms(p.terms)}.`);
      // Отношения AI — новый фактор (по прямому запросу — «не хватает отказа от предложения, оно
      // даёт −2 отношения к отказавшему, каким бы оно ни было») — у автора предложения падает
      // мнение об отказавшем, независимо от типа предложения/условий; ультиматум ДОПОЛНИТЕЛЬНО
      // объявляет войну (со своим отдельным разовым −10 обеим сторонам, см. declareWar).
      this.adjustRelationScore(p.from, p.to, -2, "отказался от моего предложения");
      if (p.ultimatum) this.declareWar(p.from, p.to);
      // Минимальная длительность войны (по прямому запросу — «после отказа от мира война длится ещё 3
      // хода минимум и снова 3 цикла нельзя посылать предложения о мире, и так каждый раз») — только
      // если война между этой парой реально продолжается (отклонённый ультиматум её ТОЛЬКО ЧТО
      // объявил, см. declareWar выше — тот уже выставил свежий noPeaceBeforeCycle сам, здесь его
      // перезаписывать не нужно, но условие `rel.war` всё равно истинно к этому моменту).
      if (peaceTerm) {
        const rel = this.relationOf(p.from, p.to);
        if (rel.war) rel.noPeaceBeforeCycle = this.cyclesElapsed + GameSession.WAR_MIN_DURATION_CYCLES;
      }
    }
    return { ok: true };
  }

  /** Отзыв ещё НЕ решённого своего предложения — по прямому запросу («нет действия переотправки
   * предложения мира с отменой предыдущего»): пока получатель тянет с ответом, отправитель мог
   * захотеть уточнить условия (например, у бота изменился баланс денег/сил — см. `bot.ts:
   * considerPeaceOffers`), но раньше единственный способ убрать старое предложение с дороги —
   * дождаться, пока получатель сам его отклонит. Отозвать может только сам отправитель (`p.from`),
   * получателю тут делать нечего — это НЕ отказ (получатель ничего не «отклонял»), сторона войны из
   * ультиматума не объявляется, как при обычном отклонении. */
  cancelProposal(playerId: number, id: number): ActionResult {
    const idx = this.pendingProposals.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, hint: "Предложение не найдено — возможно, уже решено." };
    const p = this.pendingProposals[idx];
    if (p.from !== playerId) return { ok: false, hint: "Отозвать можно только собственное предложение." };
    this.pendingProposals.splice(idx, 1);
    this.logEvent(`Дипломатия: ${this.playerName(p.from)} отозвал своё предложение игроку ${this.playerName(p.to)} — ${this.describeProposalTerms(p.terms)}.`);
    return { ok: true };
  }

  /** Отзыв ЕЩЁ НЕ решённого предложения, адресованного playerId (получателю, не отправителю — тем
   * самая `cancelProposal` выше не подходит) — по прямому запросу («не работают ответные предложения
   * в дипломатии: игрок получает предложение от AI, редактирует его, отправляя встречное — а тот же
   * снова попадёт на старое окно; ответное предложение должно уйти AI, а исходное считаться решённым
   * по итогу встречного»). Встречное предложение (см. main.ts: openProposalComposeFromIncoming)
   * ЗАМЕНЯЕТ переговоры целиком — вызывается клиентом сразу после успешной отправки встречного,
   * снимая исходное с очереди тихо: без применения его условий и без ультиматумных последствий (это
   * не отказ из вражды — это встречное предложение; итог переговоров решает уже сама встречная
   * сделка через обычный resolveProposal). */
  withdrawIncomingProposal(playerId: number, id: number): ActionResult {
    const idx = this.pendingProposals.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, hint: "Предложение не найдено — возможно, уже решено." };
    const p = this.pendingProposals[idx];
    if (p.to !== playerId) return { ok: false, hint: "Отозвать можно только предложение, адресованное вам." };
    this.pendingProposals.splice(idx, 1);
    this.logEvent(`Дипломатия: ${this.playerName(p.to)} снял с очереди предложение от ${this.playerName(p.from)} (встречным предложением) — ${this.describeProposalTerms(p.terms)}.`);
    return { ok: true };
  }

  /** Закрытие окна оповещения о глобальном событии (см. PendingGlobalEvent) конкретным игроком —
   * каждый живой человек закрывает его независимо; запись удаляется из очереди только когда её
   * закрыли ВСЕ ещё живые игроки-люди (AI это окно не показывается и не учитывается вовсе — см.
   * checkPendingGlobalEventsForCurrentPlayer на клиенте). */
  dismissGlobalEvent(playerId: number, id: number): ActionResult {
    const ev = this.pendingGlobalEvents.find((e) => e.id === id);
    if (!ev) return { ok: false, hint: "Событие не найдено — возможно, уже закрыто всеми." };
    if (!ev.dismissedBy.includes(playerId)) ev.dismissedBy.push(playerId);
    const remainingHumans = this.players.filter((p) => !p.isAI && !this.eliminatedPlayers.has(p.id));
    if (remainingHumans.every((p) => ev.dismissedBy.includes(p.id))) {
      this.pendingGlobalEvents = this.pendingGlobalEvents.filter((e) => e.id !== id);
    }
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

  /** Shortest hex path — портирован из findRoutePath. [ИСПРАВЛЕНО, по прямому запросу — живой
   * баг-репорт: «торговый маршрут идёт через всю карту, хотя оптимально проложить с учётом круглости
   * земли — проверка на расстояние прошла, но маршрут лёг без учёта круглости»] Раньше здесь
   * НАМЕРЕННО стоял обычный, не оборачивающийся вокруг карты `hexNeighbors` (порт со старой версии,
   * когда `hexNeighborsGameplay`/«земля круглая» ещё не существовала как концепция) — расхождение с
   * остальным геймплеем: движение юнитов, приграничные регионы, поиск моря у берега — everywhere else
   * уже используют `hexNeighborsGameplay` (оборачивает ТОЛЬКО долготу/столбцы, см. её doc). Теперь
   * поиск пути тоже через неё — маршрут может обогнуть карту по кратчайшей стороне, как и юнит. */
  private findRoutePathByCategory(fromCol: number, fromRow: number, toCol: number, toRow: number, category: "land" | "sea"): { col: number; row: number }[] | null {
    const passable = (col: number, row: number) => (category === "land" ? this.isLandTile(col, row) : this.isSeaTile(col, row));
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
        for (const [nc, nr] of this.hexNeighborsGameplay(col, row)) {
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
   * ресурса», не любые 2 единицы (по прямому уточнению переосмысления карты). Обычный склад —
   * бонус Коммунизма (grantCommunismResourceIncome) начисляет НАСТОЯЩИЕ единицы каждый цикл, они уже
   * здесь без отдельной логики. */
  private uniqueTradeResourceTypeCount(playerId: number): number {
    return (Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(
      ([id, qty]) => (qty ?? 0) > 0 && GameSession.RESOURCE_META.get(id)!.category === "trade"
    ).length;
  }
  /** Списывает по 1 единице с `count` РАЗНЫХ видов торгового ресурса (не `count` единиц одного и
   * того же вида) — вызывающий обязан сперва убедиться через uniqueTradeResourceTypeCount. */
  private spendUniqueTradeResourcesFromWarehouse(playerId: number, count: number): boolean {
    const types = (Object.entries(this.warehouse[playerId] ?? {}) as [ResourceId, number][]).filter(
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
    // Отношения AI — фактор 11 (по прямому запросу, «подключили маршрут в мою сеть +5») — сеть
    // fixedCity ДО перенаправления, сравнённая с сетью ПОСЛЕ (через ту же tradeNetworkOf, что считает
    // реальный торговый доход) — отличает настоящее НОВОЕ подключение от простой перестройки уже
    // связанной сети. Для каждого владельца, чья сеть в результате ВПЕРВЫЕ включила fixedCity —
    // мнение об исполнителе (playerId, разыгравшем карту) растёт.
    const beforeOwners = new Set(this.tradeNetworkOf(fixedCity).cities.map((c) => c.playerId));
    if (route.fromCityId === oldEndpointCityId) route.fromCityId = newCityId;
    else route.toCityId = newCityId;
    route.path = path;
    route.playerId = newCity.playerId;
    const afterOwners = new Set(this.tradeNetworkOf(fixedCity).cities.map((c) => c.playerId));
    for (const ownerId of afterOwners) {
      if (ownerId === playerId || beforeOwners.has(ownerId)) continue;
      this.adjustRelationScore(ownerId, playerId, 5, "подключили маршрут в мою сеть");
    }
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
    // Отношения AI — фактор 11, обратная сторона («сломали маршрут в моей сети −5») — сеть ОДНОГО из
    // концов (fromCity, до удаления) сравнивается с сетью ПОСЛЕ: кто выпал — тот теряет связь по вине
    // исполнителя (playerId, разыгравшем карту), его мнение о нём падает.
    const fromCityForNetwork = this.cities.find((c) => c.id === this.tradeRoutes[idx].fromCityId);
    const beforeOwners = fromCityForNetwork ? new Set(this.tradeNetworkOf(fromCityForNetwork).cities.map((c) => c.playerId)) : new Set<number>();
    this.tradeRoutes.splice(idx, 1);
    const afterOwners = fromCityForNetwork ? new Set(this.tradeNetworkOf(fromCityForNetwork).cities.map((c) => c.playerId)) : new Set<number>();
    for (const ownerId of beforeOwners) {
      if (ownerId === playerId || afterOwners.has(ownerId)) continue;
      this.adjustRelationScore(ownerId, playerId, -5, "сломали маршрут в моей сети");
    }
    this.consumeHandCard(playerId, slotIndex);
    return { ok: true };
  }

  /** «Торговец», негативный эффект сброса (по прямому запросу) — обнуляет денежный баланс игрока;
   * если денег не было — опустошает склад; если и склад пуст — эффекта нет. */
  private applyTraderNegative(playerId: number): string {
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

  /** «Торговый путь», негативный эффект сброса (по прямому запросу — заменил прежнее обнуление
   * денег/склада, перенесённое на «Торговца») — снимает один торговый путь сбросившего игрока; если
   * своих путей нет — случайный путь случайного другого игрока; если на карте вообще нет путей —
   * эффекта нет. */
  private applyTradeRouteNegative(playerId: number): string {
    const mine = this.tradeRoutes.filter((r) => r.playerId === playerId);
    const pool = mine.length ? mine : this.tradeRoutes;
    if (!pool.length) return "торговых путей на карте нет — эффекта нет.";
    const victim = pool[Math.floor(this.rng() * pool.length)];
    this.tradeRoutes.splice(this.tradeRoutes.indexOf(victim), 1);
    return mine.length
      ? "ваш торговый путь снят."
      : `своих путей не было — снят путь игрока ${this.players.find((p) => p.id === victim.playerId)?.name ?? victim.playerId}.`;
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
    if (card.freeFascism) return { ok: false, hint: "Бесплатного «Воина» Фашизма нельзя продать." };
    if (card.freeEducation) return { ok: false, hint: "Бесплатного «Учёного» (бонус «Образования») нельзя продать." };
    if (card.freeBuilding) return { ok: false, hint: "Бесплатного «Строителя» (бонус «Архитектуры») нельзя продать." };
    if (card.freeParliamentarism) return { ok: false, hint: "Бесплатного «Строителя» Парламентаризма нельзя продать." };
    if (card.freeForestGrowth) return { ok: false, hint: "Бесплатную карту «Рост леса» (эндгейм-бонус «Учёного») нельзя продать." };
    if (this.market.some((l) => l.kind === "card" && l.sellerId === playerId && l.sellerSlotIndex === slotIndex)) return { ok: false, hint: "Эта карта уже выставлена на продажу." };
    this.market.push({ id: this.nextListingId++, sellerId: playerId, kind: "card", card, price, sellerSlotIndex: slotIndex });
    return { ok: true };
  }

  /** Отмена собственного лота-карты на бирже — по прямому запросу («сделай возможность отменить
   * выставление карты на биржу»): карта всё время остаётся у продавца в руке, пока лот висит
   * непроданным (см. sellCard выше — слот руки НЕ освобождается при выставлении, только помечается
   * занятым лотом), так что отмена — просто удаление записи из `market`, возвращать нечего (карта уже
   * на месте). Отменить может только сам продавец; не ход игрока не требуется (симметрично
   * cancelProposal — снятие СВОЕГО же предложения/лота не обязано ждать своего хода). */
  cancelCardListing(playerId: number, listingId: number): ActionResult {
    const idx = this.market.findIndex((l) => l.id === listingId);
    if (idx === -1) return { ok: false, hint: "Лот не найден — возможно, уже куплен или отменён." };
    const listing = this.market[idx];
    if (listing.kind !== "card") return { ok: false, hint: "Отменить можно только выставленную карту." };
    if (listing.sellerId !== playerId) return { ok: false, hint: "Отменить можно только собственный лот." };
    this.market.splice(idx, 1);
    return { ok: true };
  }

  /** Портировано из startSellResource+finalizeSellListing. */
  sellResource(playerId: number, resource: ResourceId, price: number): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    // Драгоценные металлы (по прямому запросу — «сделай их конвертируемыми в деньги как третий
    // источник дохода, они больше не уходят на биржу») — на биржу не выставляются вовсе, только
    // прямой обмен на деньги, см. cashInPreciousMetals ниже.
    if (resource === "preciousMetals") {
      return { ok: false, hint: "Драгоценные металлы на бирже не продаются — обменяйте их на деньги напрямую (кнопка на складе)." };
    }
    // «Регуляция цен» (ООН, ТЗ §15.3) — жёстко фиксирует цену конкретного ресурса на бирже, игрок
    // при выставлении лота этого ресурса больше не выбирает цену сам.
    const regulated = this.oonPriceRegulation?.resource === resource ? this.oonPriceRegulation.price : null;
    const finalPrice = regulated ?? price;
    if (!Number.isInteger(finalPrice) || finalPrice < 1 || (regulated === null && finalPrice > 10)) return { ok: false, hint: "Цена должна быть целым числом от 1 до 10." };
    // Коммунизм (по прямому уточнению) — единицы, начисленные бонусом парадигмы (grantCommunismResourceIncome),
    // нельзя продать на бирже: их можно только потратить на обычные нужды. Обычные (добытые/купленные)
    // единицы того же типа продавать по-прежнему можно — эта проверка блокирует только сверх защищённого остатка.
    const sellable = (this.warehouse[playerId]?.[resource] ?? 0) - this.communismProtectedQty(playerId, resource);
    if (sellable < 1) return { ok: false, hint: "Эта единица получена от бонуса Коммунизма — на бирже продать её нельзя." };
    if (!this.takeFromWarehouse(playerId, resource, 1)) return { ok: false, hint: "Ресурс закончился на складе." };
    this.market.push({ id: this.nextListingId++, sellerId: playerId, kind: "resource", resource, price: finalPrice });
    // Отношения AI — досрочное исполнение обещания «выставить на бирже [ресурс]» (promiseListResource).
    for (const promise of [...this.activePromises]) {
      if (promise.kind === "listResource" && promise.by === playerId && promise.resource === resource) this.fulfillPromise(promise);
    }
    return { ok: true };
  }

  /** Драгоценные металлы → деньги напрямую (по прямому запросу — «третий источник дохода» рядом с
   * налогами и «Торговцем»; ресурс был совершенно бесполезен — ни одна технология/здание/карта его
   * не требует, см. проверку в коде — теперь имеет собственный смысл): `qty` единиц со склада → `qty
   * × playerEpoch(playerId)` денег, без выставления на биржу и без ожидания покупателя. Не тратит
   * действие (тот же принцип, что и sellResource — рутинная экономическая операция, не игровое
   * действие). Коммунизм-защищённые единицы (см. communismProtectedQty) обменять нельзя — тем же
   * правилом, что и продажа на бирже. */
  cashInPreciousMetals(playerId: number, qty: number): ActionResult {
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, hint: "Укажите целое положительное количество." };
    const sellable = (this.warehouse[playerId]?.preciousMetals ?? 0) - this.communismProtectedQty(playerId, "preciousMetals");
    if (sellable < qty) return { ok: false, hint: "Недостаточно Драгоценных металлов на складе (без учёта единиц, защищённых Коммунизмом)." };
    if (!this.takeFromWarehouse(playerId, "preciousMetals", qty)) return { ok: false, hint: "Ресурс закончился на складе." };
    const perUnit = this.playerEpoch(playerId);
    this.money[playerId] += qty * perUnit;
    return { ok: true, hint: `Обменяно ${qty} × Драгоценные металлы на ${qty * perUnit}💰 (по ${perUnit}💰 за единицу — текущая эпоха).` };
  }

  private totalPopulationOf(playerId: number): number {
    return this.cities.filter((c) => c.playerId === playerId).reduce((sum, c) => sum + c.population, 0);
  }

  /** Гандикап бота (по прямому запросу — «удвой компьютерам доход с налогов и торговли, это будет их
   * гандикап, чтоб они могли легче оперировать ресурсами и воинами») — простой ИИ (`bot.ts`) слабее
   * человека тактически, этот множитель компенсирует разницу деньгами, не трогая саму игровую логику.
   * ×2 только для игроков с `isAI` — людям (в т.ч. в «Против AI» — среди людей) доход не меняется. */
  private aiIncomeMultiplier(playerId: number): number {
    return this.players.find((p) => p.id === playerId)?.isAI ? 2 : 1;
  }

  /** «Соберите налоги» — портировано из collectTaxes. `interactive`: true (voluntary play) may leave
   * a this.pendingTaxShortfall for resolveTaxShortfall; false (forced discard) auto-picks newest
   * units first, then buildings — no ActionResult/hint involved, this is an internal helper.
   * `discardPenalty` (по прямому запросу — негативный эффект сброса карты «Соберите налоги») — сбор
   * принудительный, БЕЗ дохода с населения (только расход), и содержание удвоено; всегда идёт вместе
   * с `interactive: false` (форс-сброс). */
  private collectTaxes(playerId: number, interactive: boolean, discardPenalty = false): string {
    // «Телеграф» (по прямому запросу) — +1💰 за каждый СВОЙ торговый путь, для любого исследовавшего.
    const telegraphBonus = this.researchedTechs[playerId].has("Телеграф") ? this.tradeRoutes.filter((r) => r.playerId === playerId).length : 0;
    const income = discardPenalty ? 0 : this.totalPopulationOf(playerId) * this.aiIncomeMultiplier(playerId) + telegraphBonus;
    this.money[playerId] += income;
    const rawUpkeep = this.units.filter((u) => u.playerId === playerId).length + builtBy(this.buildingOwners, playerId).length;
    // «Кодекс законов» (по прямому запросу) — первооткрыватель технологии платит вдвое меньше за
    // содержание построек и юнитов, до конца партии (округление вниз — в пользу игрока). Фашизм (по
    // прямому запросу) даёт тот же вдвое-меньше эффект содержания ЮНИТОВ И зданий (не только армии),
    // пока парадигма активна. Совмещённые (Кодекс законов у этого игрока + активный Фашизм) — НЕ
    // floor(floor(raw/2)/2), а единая формула raw/4 с округлением ВВЕРХ (по прямому уточнению —
    // «для 10 юнитов содержание будет 10/2/2 = 2,5 с округлением в большую сторону, т.е 3»).
    const hasKodeks = this.techDiscoverer["Кодекс законов"] === playerId;
    const hasFascism = this.playerParadigm[playerId] === "fascism";
    const baseUpkeep = hasKodeks && hasFascism ? Math.ceil(rawUpkeep / 4) : hasKodeks || hasFascism ? Math.floor(rawUpkeep / 2) : rawUpkeep;
    const upkeep = discardPenalty ? baseUpkeep * 2 : baseUpkeep;
    if (this.money[playerId] >= upkeep) {
      this.money[playerId] -= upkeep;
      return discardPenalty
        ? `−${upkeep} 💰 содержания (удвоено штрафом сброса), дохода с населения не начислено.`
        : `+${income} 💰 населения, −${upkeep} 💰 содержания.`;
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
    return discardPenalty
      ? `не хватило ${shortfall} 💰 на удвоенное содержание (${upkeep}), дохода с населения не начислено — списано юнитов: ${removedUnits}, зданий: ${removedBuildings}.`
      : `+${income} 💰 населения, не хватило ${shortfall} 💰 на содержание (${upkeep}) — списано юнитов: ${removedUnits}, зданий: ${removedBuildings}.`;
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

  /** ДИАГНОСТИКА (ничего не тратит и не меняет) — хватит ли прямо сейчас на отвод катастрофы
   * (1 Лес + 1 Силикат по обычной цепочке доступ → склад → рынок). Нужна боту: `resolveCatastropheChoice`
   * с выбором "pay" при нехватке ресурсов МОЛЧА применяет последствия (теряется здание либо население
   * города) и всё равно возвращает ok — то есть «сыграть Катастрофу и заплатить» невозможно отличить
   * от «сыграть Катастрофу и получить урон» постфактум. Бот обязан проверить это ДО розыгрыша карты. */
  canAvertCatastrophe(playerId: number): boolean {
    return this.planCatastropheAvert(playerId) !== null;
  }

  /** ДИАГНОСТИКА (ничего не тратит и не меняет, никакого this.rng() — детерминированный ответ, не
   * прогон случайного исхода) — по прямому запросу («принять негативный эффект, ведь он не имеет
   * последствий»): предсказывает, сработает ли ветка «принять последствия» ВООБЩЕ ВХОЛОСТУЮ, зная
   * ровно ту же логику выбора цели, что и `applyCatastropheLoss`. Истинно только в предсказуемых
   * случаях: своих зданий нет вовсе (иначе рандомный выбор ВСЕГДА реально снесёт одно), и либо
   * городов нет вовсе («терять было нечего»), либо ЕДИНСТВЕННЫЙ город — столица с населением УЖЕ на
   * полу (1) — эффект `Math.max(1, pop-3)` не сдвинется. Больше одного города — цель случайна и
   * может выпасть на НЕ-столичный город, там урон настоящий, поэтому в этом случае — false. */
  catastropheAcceptIsHarmless(playerId: number): boolean {
    if (builtBy(this.buildingOwners, playerId).length > 0) return false;
    const myCities = this.cities.filter((c) => c.playerId === playerId);
    if (!myCities.length) return true;
    if (myCities.length > 1) return false;
    const only = myCities[0];
    return only.isCapital && only.population <= 1;
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

  /** «Распродажа» (по прямому запросу — заменяет «Население», которое полностью дублировало
   * розыгрыш «Поселенца») — цена: по 1 ЛЮБОМУ ресурсу каждой из 3 категорий (не обязательно
   * одного и того же вида между категориями), со столицы (доступ → склад → рынок, тот же путь, что
   * и у построек/Катастрофы). Эффект — сбрасывает ВСЮ ОСТАЛЬНУЮ руку (сама разыгранная карта уже
   * ушла через consumeHandCard до этого) целиком, кроме «Право прокладки маршрута» (нигде в игре не
   * считается частью руки, см. handCountedSize) — по 2💰 за каждую настоящую сброшенную карту;
   * бесплатные карты парадигм/технологий исчезают вместе с остальными (тот же приём, что и в
   * resolveHandOverflowDiscard), но денег за них не полагается — они не «настоящий» ресурс игрока.
   * Сброшенные карты просто уходят на дно колоды — их СОБСТВЕННЫЙ негативный эффект вынужденного
   * сброса НЕ срабатывает: это добровольная зачистка ради денег, а не наказание. */
  private static SALE_COST: BuildingCostLine[] = [
    { kind: "category", category: "food", count: 1 },
    { kind: "category", category: "strategic", count: 1 },
    { kind: "category", category: "trade", count: 1 },
  ];
  playSaleCard(playerId: number, slotIndex: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "sale" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Распродажа» недоступна в этом слоте." };
    const capital = this.capitalCityOf(playerId);
    if (!capital) return { ok: false, hint: "Нет столицы — карту сыграть нельзя." };
    const plan = this.planBuildingSpend(playerId, capital, GameSession.SALE_COST);
    if (!plan) return { ok: false, hint: "Не хватает ресурсов — нужно по 1 любому Еда/Стратегический/Торговый." };
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
    const hand = this.hands[playerId];
    const kept = hand.filter((c) => c.id === "routeRight");
    const discarded = hand.filter((c) => c.id !== "routeRight");
    hand.length = 0;
    hand.push(...kept);
    let earned = 0;
    for (const c of discarded) {
      if (c.freeMonarchy || c.freeFascism || c.freeEducation || c.freeBuilding || c.freeParliamentarism || c.freeForestGrowth) continue;
      c.receivedFrom = undefined;
      this.deck.push(c);
      earned += 2;
    }
    this.money[playerId] += earned;
    return { ok: true, spent: plan, hint: `Сброшено ${discarded.length} карт(ы), получено ${earned}💰.` };
  }

  /** «Население» (по прямому запросу — замена карты «Мобилизация», которая практически не
   * использовалась) — платит N РАЗНЫХ пищевых ресурсов (N = число своих городов, `requireDistinct`)
   * ОДНИМ платежом (не за город — тот же `planFoodSpend`, что и everywhere в игре, но без привязки к
   * конкретному городу, `allowAccess=false`, тем же приёмом, что и `foundCity` — доступ региона тут
   * ни при чём, карта не целится в одну клетку/город); нет ни одного города — играть не для кого.
   * Население ВСЕХ своих городов растёт на 1 — ДАЖЕ СВЕРХ обычной вместимости (`cityCapacityFor`,
   * см. `growCity`), но не выше 6 (жёсткий потолок именно этой карты, не общий лимит игры). */
  usePopulationCard(playerId: number, slotIndex: number): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Недоступно вне игровой фазы." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    const card = this.hands[playerId][slotIndex];
    if (!card || card.id !== "population" || this.actionsLeft[playerId] <= 0) return { ok: false, hint: "Карта «Население» недоступна в этом слоте." };
    const myCities = this.cities.filter((c) => c.playerId === playerId);
    if (!myCities.length) return { ok: false, hint: "Нет ни одного города — играть карту не для кого." };
    const req = myCities.length;
    const plan = this.planFoodSpend(playerId, { id: -1, regionCol: 0, regionRow: 0 }, req, true, false);
    if (!plan) return { ok: false, hint: `Нужно ${req} разных видов пищи (по числу городов) — на складе/бирже не набралось.` };
    this.commitSpend(playerId, plan);
    this.consumeHandCard(playerId, slotIndex);
    for (const c of myCities) c.population = Math.min(6, c.population + 1);
    return { ok: true, spent: plan };
  }

  /** Негативный эффект сброса «Населения» (по прямому запросу) — население ОДНОГО случайного своего
   * города (включая столицу) −2, БЕЗ пола в 1 (может дойти до уничтожения города целиком, тем же
   * путём, что и у «Поселенца»/«Учёного» — см. `applyDiscardPopulationLoss`/`destroyCity`), в отличие
   * от той функции — только ОДИН случайный город, не все разом. */
  private applyPopulationCardNegative(playerId: number): string {
    const mine = this.cities.filter((c) => c.playerId === playerId);
    if (!mine.length) return "городов не было — эффекта нет.";
    const city = mine[Math.floor(this.rng() * mine.length)];
    city.population -= 2;
    if (city.population <= 0) {
      this.destroyCity(city);
      return `население случайного города −2, обнулилось — город уничтожен.`;
    }
    return `население случайного города −2 (осталось ${city.population}).`;
  }

  /** «Строитель», негативный эффект сброса (по прямому запросу — заменил прежний «случайный лес
   * растёт») — уничтожает одно случайное здание сбросившего игрока; если у него нет ни одного
   * здания — эффекта нет. Использует this.rng(). */
  private applyBuilderNegative(playerId: number): string {
    const owned = builtBy(this.buildingOwners, playerId);
    if (!owned.length) return "зданий не было — эффекта нет.";
    const b = owned[Math.floor(this.rng() * owned.length)];
    this.buildingOwners[b.id].splice(this.buildingOwners[b.id].indexOf(playerId), 1);
    return `здание «${b.name}» уничтожено.`;
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
    // в этот сброс: это не обычная карта колоды, попадание в this.deck её бы испортило. Бесплатные
    // «Рабочий» Монархии / «Воин» Фашизма (freeMonarchy/freeFascism), в отличие от routeRight, ПО
    // ПРЯМОМУ УТОЧНЕНИЮ считаются в лимит руки и сбрасываются наравне с обычными картами — просто не
    // возвращаются в общую колоду (иначе задваивали бы обычные копии навсегда, см. consumeHandCard),
    // а исчезают; следующая появится в начале следующего цикла (grantMonarchyWorkerCards/
    // grantFascismWarriorCards).
    const kept = hand.filter((c) => c.id === "routeRight");
    const discarded = hand.filter((c) => c.id !== "routeRight");
    hand.length = 0;
    hand.push(...kept);
    for (const card of discarded) {
      if (!card.freeMonarchy && !card.freeFascism && !card.freeEducation && !card.freeBuilding && !card.freeParliamentarism && !card.freeForestGrowth) {
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
    // По прямому запросу — «Рабочий» больше НЕ снимает негативный эффект остальных сброшенных карт
    // (было — по прежнему прямому уточнению, «имбово со Складом» тогда касалось только его самого,
    // не всего сброса; отменено отдельным более поздним запросом). Взамен — дедуп ОДИНАКОВЫХ карт:
    // эффект каждого ВИДА карты применяется не больше одного раза за этот сброс, даже если тем же
    // сбросом ушло несколько копий (иначе, например, два «Катастрофа» или два «Учёный» отняли бы/
    // вскрыли катаклизм дважды за один и тот же сброс).
    //
    // Бесплатные карты парадигм/технологий (freeMonarchy/freeFascism/...) сами по себе НИКОГДА не
    // запускают свой негативный эффект (по прямому уточнению — «карты, даваемые парадигмами, не
    // имеют негативного эффекта при сбросе, хоть и считаются в лимит руки») — исключены из
    // `uniqueDiscarded` целиком, а не просто демоутятся дедупом: без этого исключения бесплатная
    // копия могла случайно оказаться той единственной, что «выживает» дедуп (например, в сбросе
    // ЕСТЬ только бесплатный «Рабочий», без обычного) — и эффект (здесь — блокировка ресурса, §194/
    // §195) срабатывал бы от карты, которая по определению не должна его иметь вовсе.
    const isFreeCard = (c: CardDef) => !!(c.freeMonarchy || c.freeFascism || c.freeEducation || c.freeBuilding || c.freeParliamentarism || c.freeForestGrowth);
    const seenIds = new Set<string>();
    const uniqueDiscarded = discarded.filter((c) => !isFreeCard(c) && (seenIds.has(c.id) ? false : (seenIds.add(c.id), true)));
    for (const card of uniqueDiscarded) {
      if (card.kind === "event") {
        if (card.id === "sale") {
          this.pendingBonusCardNextCycle = true;
          log.push(`«${card.label}»: все игроки получат по 1 дополнительной карте в следующем цикле.`);
        } else if (card.id === "taxes") {
          log.push(`«${card.label}»: ${this.collectTaxes(playerId, false, true)}`);
        } else if (card.id === "catastrophe") {
          log.push(`«${card.label}»: ${this.resolveCatastrophe(playerId, false)}`);
        } else if (card.id === "forestGrowth") {
          log.push(`«${card.label}»: ${this.degradeForestOrLand(playerId)}`);
        } else if (card.id === "tradeRoute") {
          log.push(`«${card.label}»: ${this.applyTradeRouteNegative(playerId)}`);
        } else if (card.id === "population") {
          log.push(`«${card.label}»: ${this.applyPopulationCardNegative(playerId)}`);
        }
        continue;
      }
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
        log.push(`«${card.label}»: ${this.applyBuilderNegative(playerId)}`);
      } else if (card.id === "trader") {
        log.push(`«${card.label}»: ${this.applyTraderNegative(playerId)}`);
      } else if (card.id === "scientist") {
        const batch = this.resolveCataclysmBatch(playerId);
        earthquakeHexes.push(...batch.earthquakeHexes);
        log.push(`«${card.label}»: вскрывает катаклизмы (эпоха ${this.playerEpoch(playerId)}). ${batch.log.join(" ")}`);
        // Отношения AI — фактор 17 (по прямому запросу — величина поднята с −2 до −10) — глобальный
        // эффект (землетрясения касаются карты целиком, не только сбросившего), поэтому у ВСЕХ живых
        // наблюдателей падает мнение о том, чей переполненный сброс это вызвал.
        for (const p of this.players) {
          if (p.id === playerId || this.eliminatedPlayers.has(p.id)) continue;
          this.adjustRelationScore(p.id, playerId, -10, "сброшенный Учёный вызвал катаклизм");
        }
        // Оповещение о катаклизме — тот же глобальный эффект, что и релейшены выше, должно быть
        // ВИДНО живым игрокам-людям, а не только проиграться анимацией у сбросившего (по прямому
        // баг-репорту — «непонятно что произошло, можно пропустить важные моменты»). Висит у КАЖДОГО
        // живого человека, пока он сам не закроет (см. dismissGlobalEvent). Все 6 видов катаклизма
        // (не только землетрясения — см. batch.allHexes/resolveCataclysmBatch), всегда (пачка не
        // бывает пустой — epoch ≥ 1 гарантирует минимум 1 бросок).
        this.pendingGlobalEvents.push({
          id: this.nextGlobalEventId++,
          kind: "cataclysm",
          sourcePlayerId: playerId,
          description: `Сброс «${card.label}» игроком ${this.players.find((p) => p.id === playerId)?.name ?? playerId} вскрыл катаклизмы (эпоха ${this.playerEpoch(playerId)}). ${batch.log.join(" ")}`,
          hexes: batch.allHexes.map((h) => ({ col: h.col, row: h.row })),
          dismissedBy: [],
        });
      } else if (card.id === "worker") {
        // По прямому запросу — «негативный эффект сброса Рабочего: случайный ресурс блокируется, как
        // в карте «Катастрофа»» (эффект не суммируется от нескольких «Рабочих» в одном сбросе — тот
        // же общий дедуп `uniqueDiscarded` выше, что и у остальных карт, гарантирует ровно один
        // вызов). Переиспользует РОВНО ТУ ЖЕ логику, что и вид катаклизма «Истощение ресурсов»
        // (`cataclysmResourceDepletion`, §11) — один случайный ещё не заблокированный ресурс на карте
        // помечается перечёркиванием, добыча временно недоступна до первой попытки (см.
        // `TileData.resourceBlocked`/`restoreOneBlockedResourceHex`), не глобальное оповещение (это
        // не «катаклизм» §15.1, эффект касается только сбросившего — второй ресурс на карте, не факт
        // вреда всем игрокам).
        const result = this.cataclysmResourceDepletion();
        log.push(`«${card.label}»: ${result.text}`);
      }
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
  /** [ИСПРАВЛЕНО, по прямому запросу — живой баг-репорт: «после ухода фиолетового у него остаётся
   * окно хода и он продолжает слать предложения — если игрок погиб, он больше не ходит»] Раньше
   * очередь хода продвигалась ровно на одного игрока БЕЗУСЛОВНО, не проверяя `eliminatedPlayers` —
   * выбывший (потерявший все города) игрок продолжал регулярно получать «окно хода» наравне со
   * всеми: для AI-игрока это означало, что весь `bot.ts: runAiTurnLogic` (включая инициативу в
   * дипломатии — предложения мира/соглашений) исправно отрабатывал у игрока без единого города и
   * юнита, рассылая предложения как ни в чём не бывало. Теперь после каждого шага вперёд ЕЩЁ РАЗ
   * проверяется, не выбывший ли игрок оказался «текущим» — если да, продолжаем шагать дальше (может
   * понадобиться несколько раз подряд, если выбыло сразу несколько игроков), пока не найдём живого;
   * `guard` — защита от вечного цикла, если бы вдруг выбыли ВСЕ (партия к этому моменту уже должна
   * была объявить победителя каким-то другим путём). Обработка границы цикла (счётчики/сбросы) при
   * этом всё равно срабатывает на КАЖДОМ шаге через 0, даже если сам шаг в итоге оказался «пропуском»
   * выбывшего — иначе цикл считался бы неверно. `skippedTurn`/`pendingSkipTurn`, наоборot, применяются
   * только к ФИНАЛЬНОМУ (живому) игроку, на котором цикл на самом деле остановился. */
  /** Всё, что происходит на границе цикла (полного круга ходов всех игроков) — сборы/сбросы,
   * извлечённые из advanceCurrentPlayer() (было её телом при currentPlayerIndex===0). Публичный (не
   * private), потому что помимо advanceCurrentPlayer (хотсит) его вызывает weGoRound.ts РОВНО ОДИН
   * РАЗ на весь раунд, после реплея всех игроков, — не по разу на каждого, иначе региональные/
   * рыночные флаги "использовано в этом цикле" сбрасывались бы между игроками одного и того же
   * раунда. */
  resolveCycleBoundary() {
    this.cyclesElapsed++;
    this.accessUsed.clear();
    this.productionUsedThisCycle.clear();
    this.conscriptionUsedThisCycle.clear();
    this.upravlenieUsesThisCycle = {};
    // ТЗ §15.2 п.4 — счётчик считает ПОЛНЫЕ циклы (круг ходов всех игроков), не отдельные ходы;
    // раньше убывал на 1 за каждый отдельный ход (см. §14 п.7 старой редакции) — исправлено.
    if (this.turnsRemaining > 0) this.turnsRemaining--;
    // Ничья по лимиту раундов — ТОЛЬКО режим WeGo (по прямому запросу): в хотсите/«Против AI»
    // turnsRemaining остаётся чисто информационным счётчиком, как и было всегда (никакого
    // автоматического исхода партии по его истечении) — иначе это была бы поведенческая правка
    // старых режимов, а план явно требует их не трогать.
    if (this.turnsRemaining === 0 && this.mode === "wego") this.declareTurnLimitDraw();
    // Сброс — ДО resolveUnitMovementForCycle(), иначе только что выставленные в ЭТОМ цикле флаги
    // тут же стирались бы (см. main.ts, тот же баг был найден и исправлен там же в этом сеансе).
    this.landedThisCycle.clear();
    this.outOfMoveThisCycle.clear();
    this.moveBudgetUsedThisCycle.clear();
    this.unitActedThisCycle.clear();
    this.attackedThisCycle.clear();
    this.hexDefense.clear();
    this.unitDefendBuffer.clear();
    this.citySiegeBuffer.clear();
    for (const u of this.units) u.hp = this.unitStats(u).hp;
    this.resolveUnitMovementForCycle();
    this.grantMonarchyWorkerCards();
    this.grantFascismWarriorCards();
    this.grantParliamentarismBuilderCards();
    this.grantCommunismResourceIncome();
    this.grantScienceCoopTechSharing();
    this.applyPowerBalanceFactors();
    this.pruneCityLossJournal();
    this.applyPromiseExpirations();
    // «Распродажа», негативный эффект вынужденного сброса (см. resolveHandOverflowDiscard/
    // playSaleCard) — взведённый флаг переносится в набор «кому причитается» РОВНО на этой границе
    // цикла, а не сразу в момент сброса, поэтому «в следующем цикле» отсчитывается от реального
    // оборота хода. Каждый живой игрок получает свою лишнюю карту один раз, на своей ближайшей
    // раздаче ЭТОГО цикла (см. finalizeCardsAndBudget), после чего запись снимается.
    if (this.pendingBonusCardNextCycle) {
      this.pendingBonusCardNextCycle = false;
      replaceSet(this.bonusCardOwed, this.players.filter((p) => !this.eliminatedPlayers.has(p.id)).map((p) => p.id));
    }
    // Совет ООН — переизбрание генсека каждые 5 циклов после первых выборов (по прямому запросу) —
    // см. holdOonElection/oonNextElectionCycle.
    if (this.oonNextElectionCycle !== null && this.cyclesElapsed >= this.oonNextElectionCycle) {
      this.holdOonElection();
      this.oonNextElectionCycle = this.cyclesElapsed + GameSession.OON_ELECTION_INTERVAL_CYCLES;
    }
    this.recordCycleSnapshot();
  }

  /** См. `CycleStateSnapshot` — количественный срез на КАЖДУЮ границу цикла, для анализа тактики
   * («как идёт война, чем человек отличается от AI»), не для реплея действий (карты/розыгрыши в него
   * намеренно не входят). Вызывается в самом конце `resolveCycleBoundary`, когда `cyclesElapsed` уже
   * увеличен и все прочие пересчёты границы цикла (население/сборы/сбросы) уже применились — снимок
   * отражает состояние РОВНО на начало нового цикла. */
  private recordCycleSnapshot() {
    const players: Record<number, PlayerCycleState> = {};
    for (const p of this.players) {
      if (this.eliminatedPlayers.has(p.id)) continue;
      const researchedTechsByBranch: [number, number, number, number] = [0, 0, 0, 0];
      for (const t of TECH_TREE) if (this.researchedTechs[p.id].has(t.id)) researchedTechsByBranch[t.branch]++;
      players[p.id] = {
        money: this.money[p.id],
        cities: this.cities.filter((c) => c.playerId === p.id).map((c) => ({ id: c.id, col: c.col, row: c.row, population: c.population })),
        warehouse: { ...(this.warehouse[p.id] ?? {}) },
        units: this.units.filter((u) => u.playerId === p.id).map((u) => ({ col: u.col, row: u.row, category: u.category })),
        researchedTechsByBranch,
      };
    }
    this.cycleLog.push({ cycle: this.cyclesElapsed, players });
  }

  /** [УБРАНО, по прямому запросу — «убираем пункты каждый ход»] Раньше здесь стоял
   * `applyRelationCycleFactors` — два per-cycle фактора («каждый цикл мира с соглашением: +1»,
   * «каждый цикл войны: −1»), начислявшихся ПОВТОРНО каждый цикл, пока соглашение/война длятся.
   * Заменены на РАЗОВЫЕ факторы в момент самого события: заключение соглашения (+5 обеим сторонам,
   * см. `applyProposalTerms`, term.kind === "agreement") и объявление войны (−10 обеим сторонам, см.
   * `declareWar`) — событие срабатывает один раз, а не заново на каждой границе цикла. */

  /** «Баланс сил» (по прямому запросу §1.1/§5.1) — считается раз за цикл, сразу после
   * `applyRelationCycleFactors` (тот же вызов из `resolveCycleBoundary`), в 3 шага:
   * 1. Снимок `playerWeightOf` (valuation.ts — военная сила + население + технологии×2; население
   *    предпочтено числу городов по прямому запросу, см. её доку) каждого живого игрока добавляется в
   *    `weightHistory`, окно обрезается до `POWER_HISTORY_WINDOW` записей.
   * 2. **Отчаяние** (§1.1, bot.ts: considerWarTargets) — свой вес относительно СРЕДНЕГО по живым
   *    соперникам: ниже `DESPERATION_ENTER_RATIO` держится `DESPERATION_MIN_CYCLES` циклов подряд →
   *    входит в `desperatePlayers`; восстановился выше `DESPERATION_EXIT_RATIO` → выходит немедленно.
   *    Гистерезис (диапазон между порогами входа/выхода) — не дребезжит на границе.
   * 3. **Баланс сил как континуальный фактор trust** (§8.3, третий per-cycle фактор после войны/мира,
   *    пп.6-7) — для каждого игрока Y, чей рост веса за окно истории превышает `isOutgrowingOthers`
   *    (медиану роста остальных ×`POWER_ENVY_RATIO`), у КАЖДОГО другого живого игрока X мнение о Y
   *    дрейфует на `POWER_ENVY_DRIFT` за цикл — ПОКА X не получает выгоды от роста Y: действующее
   *    соглашение любого из 5 видов между X и Y, ИЛИ одинаковая религия (кроме атеизма — та же
   *    оговорка, что и везде в игре, атеист не считается единоверцем ни с кем). */
  private applyPowerBalanceFactors() {
    const alive = this.players.filter((p) => !this.eliminatedPlayers.has(p.id));
    if (alive.length < 2) return;
    const weights = new Map<number, number>();
    for (const p of alive) {
      const w = playerWeightOf(this, p.id);
      weights.set(p.id, w);
      const hist = this.weightHistory[p.id] ?? (this.weightHistory[p.id] = []);
      hist.push(w);
      if (hist.length > GameSession.POWER_HISTORY_WINDOW) hist.shift();
    }

    for (const p of alive) {
      const others = alive.filter((o) => o.id !== p.id);
      if (!others.length) continue;
      const avgOthers = others.reduce((s, o) => s + (weights.get(o.id) ?? 0), 0) / others.length;
      const ratio = avgOthers > 0 ? (weights.get(p.id) ?? 0) / avgOthers : 1;
      if (ratio < GameSession.DESPERATION_ENTER_RATIO) {
        if (this.weakSinceCycle[p.id] === undefined) this.weakSinceCycle[p.id] = this.cyclesElapsed;
        if (this.cyclesElapsed - this.weakSinceCycle[p.id]! >= GameSession.DESPERATION_MIN_CYCLES) this.desperatePlayers.add(p.id);
      } else if (ratio >= GameSession.DESPERATION_EXIT_RATIO) {
        delete this.weakSinceCycle[p.id];
        this.desperatePlayers.delete(p.id);
      }
    }

    for (const y of alive) {
      if (!this.isOutgrowingOthers(y.id)) continue;
      for (const x of alive) {
        if (x.id === y.id) continue;
        if (this.relationOf(x.id, y.id).agreements.size > 0) continue;
        const xReligion = this.playerReligion[x.id];
        if (xReligion !== null && xReligion !== "atheism" && xReligion === this.playerReligion[y.id]) continue;
        this.adjustRelationScore(x.id, y.id, GameSession.POWER_ENVY_DRIFT, "баланс сил — чужая экспансия без выгоды мне");
      }
    }
  }

  /** Окно истории `weightHistory` (циклов) — нужно для роста и производного «Отчаяния»/«Баланса сил». */
  private static readonly POWER_HISTORY_WINDOW = 6;
  /** Отчаяние (§1.1) — порог входа: свой вес ниже этой доли от среднего по живым соперникам. */
  private static readonly DESPERATION_ENTER_RATIO = 0.6;
  /** Отчаяние — порог выхода, выше входного (гистерезис, не дребезжит в диапазоне 0.6–0.75). */
  private static readonly DESPERATION_EXIT_RATIO = 0.75;
  /** Отчаяние засчитывается, только если порог входа продержался этот минимум циклов подряд. */
  private static readonly DESPERATION_MIN_CYCLES = 5;
  /** «Баланс сил» (§5.1/§5.2) — чужой рост веса считается «тревожным», если превышает медианный рост
   * остальных живых игроков минимум во столько раз. */
  private static readonly POWER_ENVY_RATIO = 1.3;
  /** Величина дрейфа trust за цикл от «Баланса сил» — тот же масштаб, что у двух уже существующих
   * per-cycle факторов (война/мир, §8.3 пп.6-7). */
  private static readonly POWER_ENVY_DRIFT = -1;

  /** Рост веса игрока за всё окно `weightHistory` (последний снимок минус самый старый) — `0`, если
   * снимков меньше 2 (партия только началась/игрок только что появился, расти ещё не от чего). */
  private growthOf(playerId: number): number {
    const hist = this.weightHistory[playerId];
    return hist && hist.length >= 2 ? hist[hist.length - 1] - hist[0] : 0;
  }
  /** Медианный рост ОСТАЛЬНЫХ живых игроков (кроме `playerId`) за то же окно — `null`, если ни у кого
   * ещё нет минимум 2 снимков (сравнивать не с чем). */
  private medianOtherGrowth(playerId: number, alive: Player[]): number | null {
    const growths = alive.filter((o) => o.id !== playerId && (this.weightHistory[o.id]?.length ?? 0) >= 2).map((o) => this.growthOf(o.id));
    if (!growths.length) return null;
    const sorted = growths.slice().sort((a, b) => a - b);
    return sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  }
  /** «Обгоняет остальных» (§5.1/§5.2, bot.ts: повод войны «Сдерживание лидера») — публичный предикат,
   * тот же порог/окно, что и континуальный дрейф trust в `applyPowerBalanceFactors` п.3, просто без
   * побочного эффекта (только читает `weightHistory`, ничего не меняет) — используется и там, и здесь,
   * одна формула на оба места. */
  isOutgrowingOthers(playerId: number): boolean {
    const alive = this.players.filter((p) => !this.eliminatedPlayers.has(p.id));
    if ((this.weightHistory[playerId]?.length ?? 0) < 2) return false;
    const median = this.medianOtherGrowth(playerId, alive);
    return median !== null && median > 0 && this.growthOf(playerId) >= median * GameSession.POWER_ENVY_RATIO;
  }
  /** Отчаяние (§1.1, bot.ts: considerWarTargets) — публичный геттер для бота; состояние считается в
   * `applyPowerBalanceFactors` раз за цикл, не пересчитывается на лету (иначе гистерезис не работал бы). */
  isDesperate(playerId: number): boolean {
    return this.desperatePlayers.has(playerId);
  }

  /** Возраст, после которого запись журнала потерь городов (§3.1/§2.1) считается неактуальной — та же
   * величина порядка, что и `WAR_PLAN_COOLDOWN_CYCLES` (bot.ts), не критично, просто «давно». */
  private static readonly CITY_LOSS_JOURNAL_MAX_AGE = 20;
  /** Чистит журнал военных потерь городов раз за цикл (см. `resolveCycleBoundary`) — запись снимается,
   * когда СТАРЫЙ владелец отбил город назад (`city.playerId === oldOwnerId` снова), город уничтожен
   * целиком (`destroyCity`, не в `this.cities` вовсе), или запись просто устарела. */
  private pruneCityLossJournal() {
    this.recentCityLosses = this.recentCityLosses.filter((loss) => {
      if (this.cyclesElapsed - loss.cycle > GameSession.CITY_LOSS_JOURNAL_MAX_AGE) return false;
      const city = this.cities.find((c) => c.id === loss.cityId);
      if (!city) return false;
      if (city.playerId === loss.oldOwnerId) return false;
      return true;
    });
  }

  // Публичный (не private) по той же причине, что и resolveCycleBoundary выше: interleavedAi.ts
  // (режим «Против AI») использует его напрямую, чтобы ПРОПУСТИТЬ AI-игрока, чей ход в этом цикле
  // уже полностью доигран через интерливинг (см. interleavedAi.ts: isDoneThisCycle) — без этого
  // driveAiTurns (wsServer.ts) заново применил бы полный ход через runAutoPlayLoop, задвоив раздачу
  // карт/сброс бюджета этому игроку за один и тот же цикл.
  advanceCurrentPlayer() {
    let guard = 0;
    do {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
      if (this.currentPlayerIndex === 0) {
        this.resolveCycleBoundary();
      }
      guard++;
    } while (this.eliminatedPlayers.has(this.players[this.currentPlayerIndex].id) && guard < this.players.length);
    const arrivedId = this.players[this.currentPlayerIndex].id;
    if (this.skippedTurn.has(arrivedId)) {
      this.skippedTurn.delete(arrivedId);
      this.pendingSkipTurn = arrivedId;
      this.pendingSkipTurnReason = this.skipTurnReason[arrivedId] ?? null;
      delete this.skipTurnReason[arrivedId];
    }
  }

  /** Раздача карт/обязательная передача/пересчёт бюджета действий на следующий ход — общая часть
   * endTurn (хотсит) и closeRound (WeGo), извлечённая БЕЗ продвижения очереди (advanceCurrentPlayer),
   * чтобы WeGo-раунд мог зафиксировать план игрока, не трогая currentPlayerIndex его приватного
   * клона (см. weGoRound.ts). Ровно тело старого endTurn между проверками хода и advanceCurrentPlayer. */
  private finalizeCardsAndBudget(_playerId: number, confirmed: boolean): ActionResult {
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
      // «Распродажа» — лишняя карта, причитающаяся по глобальному негативному эффекту вынужденного
      // сброса (см. resolveCycleBoundary/resolveHandOverflowDiscard) — выдаётся ОДИН раз, на первой
      // же раздаче этого игрока после срабатывания, поверх обычных CARDS_DEALT_PER_TURN.
      const bonusCard = this.bonusCardOwed.has(player.id);
      if (bonusCard) this.bonusCardOwed.delete(player.id);
      for (let dealt = 0; dealt < CARDS_DEALT_PER_TURN + (bonusCard ? 1 : 0); dealt++) {
        const next = this.deck.shift();
        if (!next) break;
        hand.push(next);
      }
      // Обязательная передача (по прямому уточнению) — только если реально есть что отдать; хотя
      // бы 1 карта в руке у игрока (иначе пустая рука после сброса/минимального добора блокировала
      // бы его без возможности выполнить требование). Бесплатные «Рабочий» Монархии / «Воин» Фашизма
      // (freeMonarchy/freeFascism) не считаются — их нельзя передать (см. handoffCard), иначе рука из
      // одной такой карты требовала бы передачи без единого варианта её выполнить.
      if (hand.some((c) => !c.freeMonarchy && !c.freeFascism && !c.freeEducation && !c.freeBuilding && !c.freeParliamentarism && !c.freeForestGrowth)) this.mustHandoff.add(player.id);
    }
    // Религия — по прямому уточнению +1 действие даёт ЛЮБАЯ религия, КРОМЕ Атеизма (не просто «есть
    // хоть что-то выбрано» — «atheism» тоже ненулевое значение playerReligion, отдельная проверка
    // обязательна). Не зависит от Монотеизма — бонус даёт сам факт религии, не парадигма.
    // ИСКЛЮЧЕНИЕ — Коммунизм (по прямому уточнению): под ним правило переворачивается — бонус даёт
    // ТОЛЬКО Атеизм (тот самый, в который `adoptParadigm` автоматически переводит игрока при
    // принятии Коммунизма), а любая НАСТОЯЩАЯ религия, принятая вручную, ПОКА действует Коммунизм,
    // бонуса не даёт вовсе (клиент явно предупреждает об этом перед подтверждением, см. main.ts:
    // adoptReligion). Внутри и в других парадигмах правило прежнее.
    const religion = this.playerReligion[player.id];
    const religionBonus = (this.playerParadigm[player.id] === "communism" ? religion === "atheism" : religion !== null && religion !== "atheism") ? 1 : 0;
    // «Компьютеры» — по прямому запросу («измени на постоянный бонус +1 действие для игрока»)
    // подключён по-настоящему: для ЛЮБОГО исследовавшего (не только первооткрывателя), постоянно,
    // пока технология открыта — раньше эффект был только текстом, actionsLeft его не учитывал вовсе.
    const computersBonus = this.researchedTechs[player.id].has("Компьютеры") ? 1 : 0;
    // «Искусственный интеллект» (по прямому запросу) — с момента, когда технологию открывает ПЕРВЫЙ
    // (любой) игрок в партии, у ВСЕХ ОСТАЛЬНЫХ (кто её ещё не открыл сам) −1 действие в ход — тот
    // самый факт открытия проверяется через techDiscoverer (глобальный, не per-player).
    const aiPenalty =
      this.techDiscoverer["Искусственный интеллект"] !== undefined && !this.researchedTechs[player.id].has("Искусственный интеллект") ? 1 : 0;
    const nextActions = Math.max(1, ACTIONS_PER_TURN + (this.playerParadigm[player.id] === "democracy" ? 1 : 0) + religionBonus + computersBonus - aiPenalty);
    this.actionsLeft[this.currentPlayerIndex] = nextActions;
    this.actionsTotal[player.id] = nextActions;
    return { ok: true, earthquakeHexes: earthquakeHexes.length ? earthquakeHexes : undefined };
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
    const result = this.finalizeCardsAndBudget(playerId, confirmed);
    if (!result.ok) return result;
    this.advanceCurrentPlayer();
    return result;
  }

  /** WeGo-аналог endTurn (см. weGoRound.ts) — тот же finalizeCardsAndBudget (раздача карт/mustHandoff/
   * пересчёт бюджета), но БЕЗ advanceCurrentPlayer: currentPlayerIndex приватного клона игрока во
   * время планирования раунда всегда указывает на него самого и не должен сдвигаться — переход к
   * следующему раунду делает round-driver один раз для всех игроков сразу (resolveCycleBoundary). */
  closeRound(playerId: number, confirmed = false): ActionResult {
    if (this.phase !== "playing") return { ok: false, hint: "Ход недоступен до конца расстановки." };
    if (this.players[this.currentPlayerIndex].id !== playerId) return { ok: false, hint: "Сейчас не ваш ход." };
    if (this.pendingSkipTurn === playerId) {
      this.pendingSkipTurn = null;
      this.pendingSkipTurnReason = null;
      return { ok: true };
    }
    return this.finalizeCardsAndBudget(playerId, confirmed);
  }

  // === Сериализация — форма сообщения "state" и файла на диске (rooms.ts) =======================

  toJSON(): SaveGameV1 {
    return {
      version: 1,
      players: this.players.map((p) => ({ name: p.name, color: p.color, isAI: p.isAI })),
      autoPlayAI: this.autoPlayAI,
      mode: this.mode,
      roundDeadline: this.roundDeadline,
      roundOpenedAt: this.roundOpenedAt,
      roundTimeMs: this.roundTimeMs,
      sessionTimeMs: this.sessionTimeMs,
      spentPlanningMs: this.spentPlanningMs,
      aiControlled: [...this.aiControlled],
      phase: this.phase,
      currentPlayerIndex: this.currentPlayerIndex,
      winner: this.winner,
      winnerType: this.winnerType,
      winners: this.winners,
      turnsRemaining: this.turnsRemaining,
      maxTurns: this.maxTurns,
      cyclesElapsed: this.cyclesElapsed,
      eventLog: this.eventLog,
      cycleLog: this.cycleLog,
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
      communismBonusHeld: this.communismBonusHeld,
      communismExtraCityId: this.communismExtraCityId,
      aiReligionLockUntilCycle: this.aiReligionLockUntilCycle,
      money: this.money,
      hands: this.hands,
      deck: this.deck,
      actionsLeft: this.actionsLeft,
      actionsTotal: this.actionsTotal,
      researchedTechs: Object.fromEntries(Object.entries(this.researchedTechs).map(([id, set]) => [id, [...set]])),
      buildingOwners: this.buildingOwners,
      playerParadigm: this.playerParadigm,
      playerReligion: this.playerReligion,
      religionFounder: this.religionFounder,
      techDiscoverer: this.techDiscoverer,
      relations: Object.fromEntries(
        Object.entries(this.relations).map(([k, r]) => [k, { war: r.war, agreements: [...r.agreements], truceUntilCycle: r.truceUntilCycle, noPeaceBeforeCycle: r.noPeaceBeforeCycle }])
      ),
      relationScores: { ...this.relationScores },
      activePromises: this.activePromises,
      nextPromiseId: this.nextPromiseId,
      diplomacyAttemptMemory: { ...this.diplomacyAttemptMemory },
      lastHandoffCycle: { ...this.lastHandoffCycle },
      warPlans: { ...this.warPlans },
      warPlanCooldowns: { ...this.warPlanCooldowns },
      warZoneBuildIndex: { ...this.warZoneBuildIndex },
      weightHistory: Object.fromEntries(Object.entries(this.weightHistory).map(([k, v]) => [k, [...(v ?? [])]])),
      weakSinceCycle: { ...this.weakSinceCycle },
      desperatePlayers: [...this.desperatePlayers],
      peaceOfferStreak: { ...this.peaceOfferStreak },
      peaceOfferStreakCycle: { ...this.peaceOfferStreakCycle },
      recentCityLosses: this.recentCityLosses,
      armies: this.armies,
      nextArmyId: this.nextArmyId,
      fleets: this.fleets,
      nextFleetId: this.nextFleetId,
      armyBuildQueue: { ...this.armyBuildQueue },
      nextArmyBuildOrderId: this.nextArmyBuildOrderId,
      pendingProposals: this.pendingProposals,
      nextProposalId: this.nextProposalId,
      pendingGlobalEvents: this.pendingGlobalEvents,
      nextGlobalEventId: this.nextGlobalEventId,
      skippedTurn: [...this.skippedTurn],
      accessUsed: [...this.accessUsed],
      productionUsedThisCycle: [...this.productionUsedThisCycle],
      conscriptionUsedThisCycle: [...this.conscriptionUsedThisCycle],
      landedThisCycle: [...this.landedThisCycle],
      outOfMoveThisCycle: [...this.outOfMoveThisCycle],
      moveBudgetUsedThisCycle: [...this.moveBudgetUsedThisCycle.entries()],
      unitActedThisCycle: [...this.unitActedThisCycle],
      attackedThisCycle: [...this.attackedThisCycle],
      hexDefense: [...this.hexDefense.entries()],
      unitDefendBuffer: [...this.unitDefendBuffer.entries()],
      citySiegeBuffer: [...this.citySiegeBuffer.entries()],
      ruins: this.ruins,
      eliminatedPlayers: [...this.eliminatedPlayers],
      scientistCombatBonusPlayers: [...this.scientistCombatBonusPlayers],
      upravlenieUsesThisCycle: this.upravlenieUsesThisCycle,
      mustHandoff: [...this.mustHandoff],
      pendingBonusCardNextCycle: this.pendingBonusCardNextCycle,
      bonusCardOwed: [...this.bonusCardOwed],
      spaceComponents: this.spaceComponents,
      nuclearWeapons: this.nuclearWeapons,
      oonCandidate1Id: this.oonCandidate1Id,
      oonCandidate2Id: this.oonCandidate2Id,
      oonEffectiveCandidate2Id: this.effectiveOonCandidate2Id(),
      oonSecretaryGeneralId: this.oonSecretaryGeneralId,
      oonNextElectionCycle: this.oonNextElectionCycle,
      pendingOonSecretaryElection: this.pendingOonSecretaryElection,
      nextOonSecretaryElectionId: this.nextOonSecretaryElectionId,
      pendingOonResolution: this.pendingOonResolution,
      nextOonResolutionId: this.nextOonResolutionId,
      lastOonResolutionType: this.lastOonResolutionType,
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
      pendingAiPlan: this.pendingAiPlan,
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
    const players: Player[] = save.players.map((p, i) => ({ id: i, name: p.name, color: p.color, isAI: p.isAI }));
    const session = new GameSession(id, players, save.rngSeed);
    session.autoPlayAI = save.autoPlayAI ?? false;
    session.mode = save.mode ?? "hotseat";
    session.roundDeadline = save.roundDeadline ?? null;
    session.roundOpenedAt = save.roundOpenedAt ?? null;
    session.roundTimeMs = save.roundTimeMs ?? 180_000;
    session.sessionTimeMs = save.sessionTimeMs ?? 5_400_000;
    session.spentPlanningMs = save.spentPlanningMs ?? {};
    session.aiControlled = new Set(save.aiControlled ?? []);
    session.phase = save.phase;
    session.currentPlayerIndex = save.currentPlayerIndex;
    session.winner = save.winner;
    session.winnerType = save.winnerType ?? null;
    session.winners = save.winners ?? (save.winner !== null ? [save.winner] : []);
    session.turnsRemaining = save.turnsRemaining;
    session.maxTurns = save.maxTurns ?? 60;
    session.cyclesElapsed = save.cyclesElapsed ?? 0;
    session.eventLog = save.eventLog ?? [];
    session.cycleLog = save.cycleLog ?? [];
    session.doc.tiles = save.mapTiles;
    session.placedTokens = save.placedTokens;
    session.cityResults = save.cityResults;
    session.cities = save.cities;
    session.nextCityId = save.nextCityId;
    session.units = save.units;
    // Партии, сохранённые до появления поля raiding, приходят без него — undefined уже ведёт себя
    // как false везде, где юнит читается, но явный false честнее для сериализации назад.
    for (const u of session.units) if ((u as { raiding?: boolean }).raiding === undefined) u.raiding = false;
    // Тот же приём — партии, сохранённые до armyId (§15.9а), приходят без него; undefined ведёт себя
    // как null везде, где сравнивается через `!=`/`??`, но явный null честнее для строгого `=== null`
    // и для сериализации назад (JSON.stringify молча ОПУСКАЕТ ключи со значением undefined).
    for (const u of session.units) if (u.armyId === undefined) u.armyId = null;
    session.nextUnitId = save.nextUnitId;
    session.market = save.market;
    session.nextListingId = save.nextListingId;
    session.tradeRoutes = save.tradeRoutes;
    session.nextRouteId = save.nextRouteId;
    replaceRecord(session.warehouse, save.warehouse);
    replaceRecord(session.communismBonusHeld, save.communismBonusHeld ?? {});
    replaceRecord(session.communismExtraCityId, save.communismExtraCityId ?? {});
    replaceRecord(session.aiReligionLockUntilCycle, save.aiReligionLockUntilCycle ?? {});
    replaceRecord(session.money, save.money);
    replaceRecord(session.hands, save.hands);
    session.deck = save.deck;
    replaceRecord(session.actionsLeft, save.actionsLeft);
    replaceRecord(session.actionsTotal, save.actionsTotal ?? save.actionsLeft);
    for (const k of Object.keys(session.researchedTechs)) delete session.researchedTechs[+k];
    for (const [pid, arr] of Object.entries(save.researchedTechs)) session.researchedTechs[+pid] = new Set(arr);
    replaceRecord(session.buildingOwners, save.buildingOwners);
    replaceRecord(session.playerParadigm, save.playerParadigm);
    replaceRecord(session.playerReligion, save.playerReligion);
    Object.assign(session.religionFounder, save.religionFounder);
    Object.assign(session.techDiscoverer, save.techDiscoverer ?? {});
    for (const [k, r] of Object.entries(save.relations))
      session.relations[k] = { war: r.war, agreements: new Set(r.agreements), truceUntilCycle: r.truceUntilCycle, noPeaceBeforeCycle: r.noPeaceBeforeCycle };
    session.relationScores = { ...(save.relationScores ?? {}) };
    session.activePromises = save.activePromises ?? [];
    session.nextPromiseId = save.nextPromiseId ?? 1;
    session.diplomacyAttemptMemory = { ...(save.diplomacyAttemptMemory ?? {}) };
    session.lastHandoffCycle = { ...(save.lastHandoffCycle ?? {}) };
    session.warPlans = { ...(save.warPlans ?? {}) };
    session.warPlanCooldowns = { ...(save.warPlanCooldowns ?? {}) };
    session.warZoneBuildIndex = { ...(save.warZoneBuildIndex ?? {}) };
    session.weightHistory = Object.fromEntries(Object.entries(save.weightHistory ?? {}).map(([k, v]) => [k, [...(v ?? [])]]));
    session.weakSinceCycle = { ...(save.weakSinceCycle ?? {}) };
    replaceSet(session.desperatePlayers, save.desperatePlayers ?? []);
    session.peaceOfferStreak = { ...(save.peaceOfferStreak ?? {}) };
    session.peaceOfferStreakCycle = { ...(save.peaceOfferStreakCycle ?? {}) };
    session.recentCityLosses = save.recentCityLosses ?? [];
    session.armies = save.armies ?? [];
    session.nextArmyId = save.nextArmyId ?? 1;
    session.fleets = save.fleets ?? [];
    session.nextFleetId = save.nextFleetId ?? 1;
    session.armyBuildQueue = { ...(save.armyBuildQueue ?? {}) };
    session.nextArmyBuildOrderId = save.nextArmyBuildOrderId ?? 1;
    session.pendingProposals = save.pendingProposals;
    session.nextProposalId = save.nextProposalId;
    session.pendingGlobalEvents = save.pendingGlobalEvents ?? [];
    session.nextGlobalEventId = save.nextGlobalEventId ?? 1;
    replaceSet(session.skippedTurn, save.skippedTurn);
    replaceSet(session.accessUsed, save.accessUsed);
    replaceSet(session.productionUsedThisCycle, save.productionUsedThisCycle);
    replaceSet(session.conscriptionUsedThisCycle, save.conscriptionUsedThisCycle ?? []);
    replaceSet(session.landedThisCycle, save.landedThisCycle);
    replaceSet(session.outOfMoveThisCycle, save.outOfMoveThisCycle);
    session.moveBudgetUsedThisCycle.clear();
    for (const [k, v] of save.moveBudgetUsedThisCycle ?? []) session.moveBudgetUsedThisCycle.set(k, v);
    replaceSet(session.unitActedThisCycle, save.unitActedThisCycle ?? []);
    replaceSet(session.attackedThisCycle, save.attackedThisCycle ?? []);
    session.hexDefense.clear();
    for (const [k, v] of save.hexDefense) session.hexDefense.set(k, v);
    session.unitDefendBuffer.clear();
    for (const [k, v] of save.unitDefendBuffer ?? []) session.unitDefendBuffer.set(k, v);
    session.citySiegeBuffer.clear();
    for (const [k, v] of save.citySiegeBuffer ?? []) session.citySiegeBuffer.set(k, v);
    session.ruins = save.ruins ?? [];
    replaceSet(session.eliminatedPlayers, save.eliminatedPlayers ?? []);
    replaceSet(session.scientistCombatBonusPlayers, save.scientistCombatBonusPlayers ?? []);
    replaceRecord(session.upravlenieUsesThisCycle, save.upravlenieUsesThisCycle ?? {});
    replaceSet(session.mustHandoff, save.mustHandoff ?? []);
    session.pendingBonusCardNextCycle = save.pendingBonusCardNextCycle ?? false;
    replaceSet(session.bonusCardOwed, save.bonusCardOwed ?? []);
    replaceRecord(session.spaceComponents, save.spaceComponents);
    replaceRecord(session.nuclearWeapons, save.nuclearWeapons ?? {});
    session.oonCandidate1Id = save.oonCandidate1Id ?? null;
    session.oonCandidate2Id = save.oonCandidate2Id ?? null;
    session.oonSecretaryGeneralId = save.oonSecretaryGeneralId ?? null;
    session.oonNextElectionCycle = save.oonNextElectionCycle ?? null;
    session.pendingOonSecretaryElection = save.pendingOonSecretaryElection ?? null;
    session.nextOonSecretaryElectionId = save.nextOonSecretaryElectionId ?? 1;
    session.pendingOonResolution = save.pendingOonResolution ?? null;
    session.nextOonResolutionId = save.nextOonResolutionId ?? 1;
    session.lastOonResolutionType = save.lastOonResolutionType ?? null;
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
    // [ИСПРАВЛЕНО] Конструктор ВЫШЕ уже сам потратил сколько-то вызовов rng() на shuffle(deck) и
    // generateTerrain — не 0, как молчаливо предполагал старый код. Без сброса rngFn/rngCallCount
    // здесь итоговая позиция потока была бы "K (из конструктора) + save.rngCallCount" вместо
    // корректных "save.rngCallCount" — на K вызовов дальше, чем должно быть. Раньше это было
    // безобидной мелочью (partия просто на 1 перезапуск сервера расходится со своим гипотетическим
    // "непрерванным" вариантом), но теперь ИМЕННО эта точная синхронизация — основа предпросмотра
    // хода AI (bot.ts: computeAiTurnPlan клонирует сессию именно через fromJSON(toJSON()) и должна
    // получить ТОЧНО ту же позицию потока rng(), что и оригинал, иначе показанный план и то, что
    // реально произойдёт при подтверждении, разойдутся на случайных исходах вроде катастрофы).
    session.rngFn = mulberry32(session.rngSeed);
    session.rngCallCount = 0;
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
    // Партия завершена (по прямому запросу — «после победы партия считается завершённой, пока эта
    // функция не работает») — раньше `winner` был чисто информационным полем: AI-автоигра
    // (`runAutoPlayLoop`/`prepareNextAiPlanIfNeeded`) уже останавливалась сама, увидев его, но НИЧТО
    // не мешало человеку продолжать действовать (строить, двигать юниты, завершать ходы) сколько
    // угодно после уже объявленной победы — партия технически никогда не «заканчивалась». Теперь
    // дальнейшие действия отклоняются здесь же, в одной точке входа — `dismissGlobalEvent` НЕ
    // блокируется (чисто закрытие уведомления, в т.ч. самого объявления победы/итогов голосований
    // выше, не игровое действие).
    if (this.winner !== null && action !== "dismissGlobalEvent") {
      return { ok: false, hint: "Партия завершена — победитель уже определён." };
    }
    // Обязательная передача карты (ТЗ 2.3) — по прямому уточнению («это не должно влиять... не
    // передача карты в начале хода блокирует только использование ДРУГИХ КАРТ, а не все действия
    // игрока») блокирует только действия, ссылающиеся на конкретный слот руки (`payload.slotIndex` —
    // тот же сигнал, что используют сами карточные методы: foundCity/buildUnitCard/playCard/
    // growCity/traderTrade/buildBuilding/confirmResearch/usePopulationCard и т.д.), не вообще всё. Юниты,
    // дипломатия (в т.ч. sendProposal — баг-репорт «предложение не дошло» был именно об этом),
    // парадигма/религия, активация уже построенных зданий, endTurn — ничего из этого карт не
    // трогает, поэтому не блокируется. `handoffCard` (сама передача) — исключение, у неё тоже есть
    // slotIndex, но иначе выполнить требование было бы нечем.
    if (action !== "handoffCard" && payload?.slotIndex !== undefined && this.mustHandoff.has(playerId) && this.players[this.currentPlayerIndex]?.id === playerId) {
      return { ok: false, hint: "Сначала передайте 1 карту другому игроку — кликните карту в руке и выберите получателя." };
    }
    switch (action) {
      case "handoffCard":
        return this.handoffCard(playerId, payload.slotIndex, payload.targetPlayerId);
      case "placeToken":
        return this.placeToken(playerId, payload.col, payload.row);
      case "endTurn":
        return this.endTurn(playerId, !!payload.confirmed);
      case "closeRound":
        return this.closeRound(playerId, !!payload.confirmed);
      case "foundCity":
        return this.foundCity(playerId, payload.slotIndex, payload.col, payload.row);
      case "buildUnitCard":
        return this.buildUnitCard(playerId, payload.slotIndex, payload.cityId, payload.unitId, payload.armyId);
      case "buyUnitWithMoney":
        return this.buyUnitWithMoney(playerId, payload.slotIndex, payload.cityId, payload.unitId, payload.armyId);
      case "useKazarma":
        return this.useKazarma(playerId, payload.cityId, payload.unitId);
      case "commandUnit":
        return this.commandUnit(playerId, payload.unitId, payload.col, payload.row);
      case "toggleDefend":
        return this.toggleDefend(playerId, payload.unitId);
      case "toggleRaid":
        return this.toggleRaid(playerId, payload.unitId);
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
      case "plantFreeForest":
        return this.plantFreeForest(playerId, payload.slotIndex, payload.col, payload.row);
      case "growResourceOnHex":
        return this.growResourceOnHex(playerId, payload.slotIndex, payload.col, payload.row, payload.resource);
      case "convertDesertToPlains":
        return this.convertDesertToPlains(playerId, payload.slotIndex, payload.cityId, payload.col, payload.row);
      case "workerCollect":
        return this.workerCollect(playerId, payload.slotIndex, payload.cityId, payload.chosenTypes);
      case "mineStrategicResource":
        return this.mineStrategicResource(playerId, payload.slotIndex, payload.col, payload.row, payload.resource);
      case "chopForest":
        return this.chopForest(playerId, payload.slotIndex, payload.col, payload.row);
      case "skladCollect":
        return this.skladCollect(playerId, payload.cityId, payload.chosenTypes);
      case "drawCardFromDeck":
        return this.drawCardFromDeck(playerId);
      case "traderTrade":
        return this.traderTrade(playerId, payload.slotIndex, payload.cityId, payload.resources);
      case "buildBuilding":
        return this.buildBuilding(playerId, payload.slotIndex, payload.buildingId);
      case "mineMountainsForSilicates":
        return this.mineMountainsForSilicates(playerId, payload.slotIndex, payload.cityId);
      case "activateProductionBuilding":
        return this.activateProductionBuilding(playerId, payload.buildingId);
      case "useUpravlenie":
        return this.useUpravlenie(playerId);
      case "useUpravlenieDrawCard":
        return this.useUpravlenieDrawCard(playerId);
      case "useRynok":
        return this.useRynok(playerId, payload.cityId);
      case "activateYadernyiArsenal":
        return this.activateYadernyiArsenal(playerId);
      case "launchNuclearStrike":
        return this.launchNuclearStrike(playerId, payload.col, payload.row);
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
      case "voteOonWorldLeader":
        return this.voteOonWorldLeader(playerId, payload.candidateId);
      case "voteOonSecretaryGeneral":
        return this.voteOonSecretaryGeneral(playerId, payload.candidateId);
      case "confirmResearch":
        return this.confirmResearch(playerId, payload.slotIndex, payload.techId);
      case "useScientistEndgameEffect":
        return this.useScientistEndgameEffect(playerId, payload.slotIndex, payload.choice);
      case "playFreeEducationCard":
        return this.playFreeEducationCard(playerId, payload.slotIndex, payload.techId);
      case "playFreeBuildingCard":
        return this.playFreeBuildingCard(playerId, payload.slotIndex, payload.buildingId);
      case "pickRouteCities":
        return this.pickRouteCities(playerId, payload.fromCityId, payload.toCityId);
      case "playRouteRightCard":
        return this.playRouteRightCard(playerId, payload.slotIndex, payload.fromCityId, payload.toCityId);
      case "adoptParadigm":
        return this.adoptParadigm(playerId, payload.paradigm);
      case "adoptReligion":
        return this.adoptReligion(playerId, payload.religion);
      case "chooseCommunismCity":
        return this.chooseCommunismCity(playerId, payload.cityId);
      case "sendProposal":
        return this.sendProposal(playerId, payload.to, payload.terms, payload.ultimatum, payload.scenarioKey);
      case "resolveProposal":
        return this.resolveProposal(playerId, payload.id, payload.accepted);
      case "cancelProposal":
        return this.cancelProposal(playerId, payload.id);
      case "withdrawIncomingProposal":
        return this.withdrawIncomingProposal(playerId, payload.id);
      case "dismissGlobalEvent":
        return this.dismissGlobalEvent(playerId, payload.id);
      case "breakAgreement":
        return this.breakAgreement(playerId, payload.otherId, payload.agreement);
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
      case "cancelCardListing":
        return this.cancelCardListing(playerId, payload.listingId);
      case "sellResource":
        return this.sellResource(playerId, payload.resource, payload.price);
      case "cashInPreciousMetals":
        return this.cashInPreciousMetals(playerId, payload.qty);
      case "collectTaxesCard":
        return this.collectTaxesCard(playerId, payload.slotIndex);
      case "resolveTaxShortfall":
        return this.resolveTaxShortfall(playerId, payload.target ?? {});
      case "playCatastropheCard":
        return this.playCatastropheCard(playerId, payload.slotIndex);
      case "resolveCatastropheChoice":
        return this.resolveCatastropheChoice(playerId, payload.choice);
      case "playSaleCard":
        return this.playSaleCard(playerId, payload.slotIndex);
      case "usePopulationCard":
        return this.usePopulationCard(playerId, payload.slotIndex);
      default:
        return { ok: false, hint: `Действие "${action}" пока не перенесено на сервер.` };
    }
  }
}
