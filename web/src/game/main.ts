import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { MapDoc, MAP_WIDTH, MAP_HEIGHT, REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H } from "../map/mapDoc";
import { RESOURCES, TERRAIN_BY_ID } from "../map/types";
import type { ResourceId } from "../map/types";
import { MapRenderer, HEX_SIZE } from "../map/renderer";
import { hexToPixel, hexCorner, hexNeighbors } from "../map/hexMath";
import { pixelToHex } from "../map/hexMath";
import { hexNeighborsWrapped } from "../map/hexMath";
import type { CardDef } from "./cards";
import { ACTION_CARDS, EVENT_CARDS } from "./cards";
import { TOKEN_VALUES } from "./placement";
import type { PlacedToken, Player } from "./placement";
import * as net from "./net";
import { BUILDINGS, GROUPS, GROUP_META, buildingsIn, ownersOf, isOwnedBy, isTaken, MAX_BUILDING_OWNERS, builtBy } from "./buildings";
import type { BuildingOwners, BuildingCostLine, BuildingDef } from "./buildings";
import {
  EPOCHS,
  BRANCHES,
  CATS,
  CAT_META,
  EPOCH_NAMES,
  EPOCH_RESEARCH_COST,
  TECH_TREE,
  techsAt,
  isBranchComplete,
  branchGaps,
  techEffectLines,
} from "./techtree";
import type { TechDef } from "./techtree";
import { UNITS, CATEGORIES, CATEGORY_META, statsFor } from "./units";
import type { UnitDef, UnitCategory, UnitStats } from "./units";
import { CARD_ICON_SVG, unitIconHtml } from "./icons";

const HAND_SIZE = 7; // ТЗ 2.3 — максимум в руке
// Держать в синхроне с --card-w/.card-slots{gap} в style.css. Бюджет ширины ряда карт — до 10 карт
// без наложения; сверх того renderHand сдвигает слоты друг на друга (см. CARD_ROW_BUDGET ниже).
const CARD_W = 92;
const CARD_GAP = 10;
const CARD_ROW_BUDGET = CARD_W * 10 + CARD_GAP * 9;
const ACTIONS_PER_TURN = 2; // база (по прямому уточнению) — Демократия/Религия/«Управление» добавляют сверху, см. renderActionPips
// Зеркалит GameSession.NUCLEAR_STRIKE_MONEY_COST (сервер) — только для того, чтобы показать кнопку
// «Нанести удар» disabled ДО клика, если денег не хватит; держать в синхроне при правке цены там.
const NUCLEAR_STRIKE_MONEY_COST = 2;

// Состояние партии больше не живёт здесь — сервер (web/server/src/GameSession.ts) владеет ВСЕМИ
// правилами, этот модуль только зеркалит присланный снимок (см. updateMirrorFrom ниже, план:
// C:\Users\user\.claude\plans\mighty-snuggling-squid.md) и рендерит его. Имена переменных
// сохранены 1-в-1, чтобы не переписывать всю разводку рендера/кликов заново — меняется только то,
// КАК они получают значения (сервер, а не локальная мутация).

type Phase = "placement" | "playing";
let phase: Phase = "placement";
let currentPlayerIndex = 0;
/** Раньше — импорт из ./placement (читал sessionStorage при загрузке модуля); теперь приходит с
 * сервера в каждом снимке состояния (см. updateMirrorFrom) — 73 места чтения `PLAYERS[...]` по
 * всему файлу остаются нетронутыми, меняется только источник значения. */
let PLAYERS: Player[] = [];

/** Тонкая обёртка над net.sendAction — playerId всегда currentPlayerIndex (один браузер отдаёт
 * команды за текущего игрока; GameSession.dispatch сам проверяет, что это действительно его ход).
 * В WeGo (`net.myWeGoPlayer() !== null`) currentPlayerIndex во время "playing" уже переопределён на
 * СВОЕГО игрока в updateMirrorFrom (см. ниже) — эта обёртка не знает разницы и не должна её знать. */
async function sendAction(action: string, payload: Record<string, unknown> = {}, playerIdOverride?: number): Promise<net.ActionResult> {
  return net.sendAction(action, playerIdOverride ?? currentPlayerIndex, payload);
}

// --- WeGo — раунд (таймер/отчёт/сдан ли план), см. §16 СПРАВОЧНИКА. Всегда пусто/null в хотсите. ---
/** unix ms дедлайна ТЕКУЩЕГО открытого раунда (state.deadlineAt, см. net.onState) — null вне WeGo
 * или пока раунд ещё не открыт (например во время расстановки). */
let wegoRoundDeadline: number | null = null;
/** Персональный отчёт по только что резолвленному раунду (net.WeGoRoundReport) — приходит ОДИН раз
 * сразу после резолюции, показывается коротким дисмиссящимся окном (см. renderWegoReportPanel). */
let wegoRoundReport: net.WeGoRoundReport | null = null;
/** Я уже нажал «Завершить ход» (=сдал план) в ЭТОМ раунде — ждём остальных/таймер, своя рука/кнопка
 * скрыты (тот же принцип, что и заглушка «Ход соперника» в «Против AI», см. renderBottomBar). */
let wegoPlanSubmitted = false;
let wegoTimerHandle: ReturnType<typeof setInterval> | null = null;

/** Атака / вход на чужую территорию без договора могут потребовать подтверждения объявления войны
 * — сервер не блокирует (window.confirm существует только в браузере), а возвращает
 * needsWarConfirm, ничего не поменяв; здесь — явный follow-up round-trip вместо старого
 * confirmAndDeclareWarIfNeeded. */
async function sendActionMaybeWar(action: string, payload: Record<string, unknown>): Promise<net.ActionResult> {
  let result = await sendAction(action, payload);
  if (!result.ok && result.needsWarConfirm) {
    const { targetPlayerId, reason } = result.needsWarConfirm;
    const ok = window.confirm(
      `${reason.charAt(0).toUpperCase()}${reason.slice(1)} против ${PLAYERS[targetPlayerId].name} без объявления войны начнёт войну с этим игроком. Продолжить?`
    );
    if (!ok) return { ok: false, hint: "Отменено — война не объявлена." };
    const warResult = await sendAction("declareWar", { targetId: targetPlayerId });
    if (!warResult.ok) return warResult;
    result = await sendAction(action, payload); // повторяем теперь, когда война объявлена
  }
  return result;
}

// --- Placement (starting-city bidding) state ---
const placedTokens: PlacedToken[] = [];

// --- Live city state (playing phase) — the mutable source of truth for cities (population, and
// later founded cities via the Поселенец card). ---
interface City {
  id: number;
  playerId: number;
  regionCol: number;
  regionRow: number;
  col: number;
  row: number;
  population: number;
  /** The first city founded (starting placement) — «Строитель» spends resources from the
   * capital's own region specifically (ТЗ 3.1: «построить здание в столице»). */
  isCapital: boolean;
}
let cities: City[] = [];
/** Уничтоженные (население упало до 0) города — сервер держит их отдельно от cities (см.
 * GameSession.destroyCity); клетка остаётся обычной проходимой местностью, помечена лишь визуально. */
let ruins: { col: number; row: number }[] = [];
/** Выбывшие из партии игроки — зеркало серверного eliminatedPlayers (см. GameSession.handleCityLoss).
 * Показ уведомления «поверх карты» — задача клиента: `eliminationNoticeQueue` копит id, только что
 * ставшие выбывшими (по сравнению с прошлым снимком), `renderModal()` показывает по одному, следующий
 * открывается сразу после закрытия текущего (closeModal). */
let eliminatedPlayers: number[] = [];
let eliminationNoticeQueue: number[] = [];
let lastSeenEliminated = new Set<number>();
/** Territorial-victory winner (ТЗ 9: 9th city ends the game), or null while play continues. There
 * is no real game-over state machine yet — declaring a winner just pops a modal, play technically
 * remains possible after dismissing it. */
let winner: number | null = null;
/** Человекочитаемый тип победы (территориальная/космос/ООН, см. GameSession.declareVictory) — по
 * прямому запросу «дашборд результатов и тип победы». */
let winnerType: string | null = null;
/** Все победители — обычные пути победы (territorial/space/oon) кладут сюда ровно [winner]; общая
 * ничья по лимиту раундов WeGo (GameSession.declareTurnLimitDraw, см. §16 СПРАВОЧНИКА) — всех, кто
 * не выбыл. Экран победы показывает список, если тут больше одного игрока. */
let winners: number[] = [];

/** Ходов до конца партии — чисто информационный счётчик для окна «Гос. управление» (11.6),
 * убывает на 1 за каждый отдельный ход (не за цикл). По умолчанию 60 (хотсит) — WeGo передаёт 40
 * (см. maxTurns). Ничего не завершает партию автоматически при достижении 0 в хотсите — как и
 * territorial victory (см. `winner` выше); в WeGo достижение 0 объявляет общую ничью на сервере,
 * клиент лишь отражает уже пришедший `winners`. */
let turnsRemaining = 60;
/** Исходный лимит партии (см. GameSession.maxTurns) — только для подписи "Ход N из maxTurns" в
 * нижней панели, сама остановка партии считается на сервере. */
let maxTurns = 60;
/** Зеркалит GameSession.cyclesElapsed — нужен, чтобы посчитать, сколько циклов ещё осталось до
 * конца перемирия (Relation.truceUntilCycle). */
let cyclesElapsed = 0;

/** Космодром (4.4, ещё не перенесён в код — часть переработки зданий, оставшейся в ТЗ) должен
 * пополнять это по 1 за клик; сейчас счётчик существует только для честного отображения в окне
 * «Гос. управление» (11.6) — у всех игроков стабильно 0, пока Космодром не реализован. */
const spaceComponents: Record<number, number> = {};
const SPACE_VICTORY_COMPONENTS = 3;

/** Ядерный арсенал (ТЗ 4.4) — накопительный стокпайл за партию, для отображения в модалке
 * building-use. Само применение ЯО намеренно не реализовано (см. GameSession.activateYadernyiArsenal). */
const nuclearWeapons: Record<number, number> = {};

// --- Research (научный трек) & units (ТЗ 4.2, 5) --------------------------------------------
// Per-player researched techs — this is the "chip on the science track" state. The actual trigger
// (playing «Учёный») isn't built yet (next card in the queue after Воин); researchTech() is the
// mechanism it will call, exposed via window.__debug for testing in the meantime.
const researchedTechs: Record<number, Set<string>> = {};

// --- Гос. управление: политическая парадигма (ТЗ 11.6) --------------------------------------
type Paradigm = "monotheism" | "monarchy" | "parliamentarism" | "democracy" | "fascism" | "communism";
const PARADIGM_META: Record<Paradigm, { label: string; tech: string; epoch: TechDef["epoch"]; effect: string }> = {
  monotheism: { label: "Монотеизм (община)", tech: "Мистицизм", epoch: 1, effect: "Прирост населения удвоен — Поселенец/Население увеличивают сразу 2 города за один розыгрыш карты, не 1." },
  monarchy: { label: "Монархия", tech: "Богословие", epoch: 2, effect: "1 бесплатная карта «Рабочий» в руке (другая рубашка) — обновляется каждый цикл. Считается в лимит руки (7 → фактически 6 обычных карт), но не защищает от негативного эффекта сброса." },
  parliamentarism: { label: "Парламентаризм", tech: "Экономика", epoch: 3, effect: "Активация уже построенных зданий не тратит очков действия — можно использовать любое число своих зданий за ход (каждое платит обычную цену использования и подчиняется своему лимиту частоты)." },
  democracy: { label: "Демократия", tech: "Права человека", epoch: 5, effect: "+1 действие в ход." },
  fascism: { label: "Фашизм", tech: "Идеология", epoch: 5, effect: "1 бесплатная карта «Воин» в руке (другая рубашка) — обновляется каждый цикл. Считается в лимит руки, но не защищает от негативного эффекта сброса (тот же приём, что у бесплатного «Рабочего» Монархии)." },
  communism: {
    label: "Коммунизм",
    tech: "Коммунизм",
    epoch: 6,
    effect:
      "Каждый цикл склад пополняется на 1 единицу каждого добываемого типа ресурса региона столицы (сверх обычной добычи); эти единицы нельзя продать на бирже. Лимит склада увеличивается на их число. Дополнительно можно выбрать ещё ОДИН свой город (см. «Гос. управление») — его ресурсы добавляются к столичным, не заменяют их.",
  },
};
const PARADIGMS: Paradigm[] = ["monotheism", "monarchy", "parliamentarism", "democracy", "fascism", "communism"];

/** Постоянные («до конца партии») бонусы личного первооткрывателя технологии (по прямому запросу) —
 * в отличие от разовых выплат при открытии (Письменность/Гончарное дело), эти нужно «зафиксировать» в
 * Гос. управление, чтобы игрок всегда видел, активен ли у него сейчас такой бонус. Сам эффект
 * считается на сервере от techDiscoverer[tech] === playerId (GameSession.unitStats/collectTaxes) —
 * этот список только для отображения. */
const DISCOVERY_BONUSES: { tech: string; effect: string }[] = [
  { tech: "Кодекс законов", effect: "Содержание построек и юнитов (при сборе налогов) сокращено вдвое." },
  { tech: "Рыцарство", effect: "+1 урон юнитами категорий «Штурмовые» и «Мобильные»." },
  { tech: "Порох", effect: "+1 дальность атаки артиллерией («Дальняя атака»)." },
  { tech: "Банковское дело", effect: "Скидка 2💰 (не ниже 1) на покупку у Мирового рынка." },
  { tech: "Сталь", effect: "+1 урон артиллерией (Дальняя атака) и кораблями." },
  { tech: "Двигатель внутреннего сгорания", effect: "+1 скорость всем своим юнитам." },
];
function discoveryBonusRow(b: (typeof DISCOVERY_BONUSES)[number], playerId: number): string {
  const holderId = techDiscoverer[b.tech];
  const mine = holderId === playerId;
  const status =
    mine ? `<span class="unit-pick-locked" style="color:#7ad97a">✅ ваш бонус</span>` : holderId !== undefined ? `<span class="unit-pick-locked">🔒 у ${PLAYERS[holderId].name}</span>` : `<span class="unit-pick-locked">🔒 технология ещё не открыта</span>`;
  return `
    <div class="unit-pick-row gov-row${mine ? " unit-pick-active" : ""}">
      <span class="unit-pick-name">${b.tech}</span>
      ${status}
      <span class="gov-row-desc">${b.effect}</span>
    </div>`;
}

/** По умолчанию ничего не выбрано — ни у одного игрока нет технологии, дающей парадигму, в начале
 * партии (ТЗ: «нигде просто не стоит галочка»). */
const playerParadigm: Record<number, Paradigm | null> = {};

function canAdoptParadigm(playerId: number, paradigm: Paradigm): boolean {
  return researchedTechs[playerId].has(PARADIGM_META[paradigm].tech);
}
/** По прямому запросу — «предложение выбрать религию/сменить парадигму должно сразу всплывать,
 * иначе игрок-новичок может не понять, что у него есть такое право»: раз за партию на каждую
 * впервые ставшую доступной парадигму/религию у игрока автоматически открывается панель «Гос.
 * управление», а не молча ждёт, пока он сам туда зайдёт. Ключ `${playerId}:${paradigm}` — так
 * повторный показ той же парадигмы тому же игроку не случится.
 *
 * Персистится в localStorage (не только in-memory) — баг-репорт «постоянно ставит гос. управление,
 * даже когда нового выбора нет»: хотсит-партия обычно живёт много ходов и не одну посадку за
 * компьютер, а простой Set сбрасывается на КАЖДОЙ перезагрузке вкладки (переподключение к комнате,
 * закрыли-открыли браузер, у разработчика — рестарт dev-сервера). После такого сброса уже показанная
 * этому игроку парадигма/религия «внезапно» показывалась снова, хотя нового выбора не появилось —
 * выглядело как «срабатывает без причины». Ключ хранилища привязан к комнате, чтобы разные партии не
 * путали историю показов друг друга. */
const PROMPTED_STORAGE_KEY = `civa:govPrompted:${new URLSearchParams(location.search).get("room") ?? "local"}`;
function loadPromptedFromStorage(): { paradigms: string[]; religions: number[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(PROMPTED_STORAGE_KEY) ?? "null") as { paradigms?: string[]; religions?: number[] } | null;
    return { paradigms: raw?.paradigms ?? [], religions: raw?.religions ?? [] };
  } catch {
    return { paradigms: [], religions: [] };
  }
}
function savePromptedToStorage() {
  try {
    localStorage.setItem(PROMPTED_STORAGE_KEY, JSON.stringify({ paradigms: [...paradigmPrompted], religions: [...religionPrompted] }));
  } catch {
    /* приватный режим / localStorage недоступен — одноразовый попап просто не переживёт перезагрузку, не критично */
  }
}
const _initialPrompted = loadPromptedFromStorage();
const paradigmPrompted = new Set<string>(_initialPrompted.paradigms);
const religionPrompted = new Set<number>(_initialPrompted.religions);

/** Смена парадигмы (включая самый первый выбор) — теперь тонкая обёртка над сервером
 * (см. dispatch "adoptParadigm" в GameSession.ts); эффект (пропуск хода и т.п.) применяется там. */
async function adoptParadigm(playerId: number, paradigm: Paradigm) {
  if (!canAdoptParadigm(playerId, paradigm) || playerParadigm[playerId] === paradigm) return;
  const result = await sendAction("adoptParadigm", { paradigm });
  if (!result.ok) setHint(result.hint ?? "Не удалось сменить парадигму.");
}

/** Здание «Управление» — куплено ли уже доп. действие в этом ходу (см. GameSession.useUpravlenie). */
const upravlenieUsedThisTurn = new Set<number>();
/** Обязательная передача карты (ТЗ 2.3) — зеркало GameSession.mustHandoff. Запрет «вернуть эту же
 * карту тому, кто её дал» живёт на самой карте (card.receivedFrom), не отдельным полем здесь. */
const mustHandoff = new Set<number>();
/** Зеркало GameSession.lastHandoffCycle (по прямому запросу — «нельзя передавать одному и тому же
 * игроку два цикла подряд») — ключ `"${from}:${to}"`, цикл последней передачи; используется только
 * для дисейбла кнопки получателя в handoff-pick, реальную проверку всё равно делает сервер. */
let lastHandoffCycle: Record<string, number> = {};
/** Какой слот руки сейчас показывает большой выбор получателя (см. onCardSlotClick/renderModal). */
let handoffSlotIndex: number | null = null;
/** «Рост леса» → «Вырастить ресурс» (Генная инженерия) — слот карты, пока в модалке gene-grow-pick
 * не выбран тип ресурса (см. startGeneGrow/pickGeneGrowResource). */
let geneGrowSlotIndex: number | null = null;
/** «Рабочий» → добыть стратегический ресурс (Геологоразведка) — слот карты, пока в модалке
 * worker-mine-pick не выбран тип ресурса (см. startWorkerMine/pickWorkerMineResource). */
let workerMineSlotIndex: number | null = null;
/** Пул ресурсов, доступных для выбора «Рабочим» (mineStrategicResource) — зеркалит серверный
 * GameSession.GEO_SURVEY_RESOURCE_POOL (те же 6 «настоящих» стратегических ресурсов). */
const WORKER_MINE_RESOURCE_POOL: ResourceId[] = ["metalOre", "silicates", "hydrocarbons", "preciousMetals", "uranium", "rareEarth"];

// --- Гос. управление: религия (ТЗ 3.2/4.4 Храм, «Мистицизм» открывает выбор) -----------------
type Religion = "judaism" | "buddhism" | "christianity" | "islam" | "confucianism" | "atheism";
const RELIGION_META: Record<Religion, { label: string; symbol: string }> = {
  judaism: { label: "Иудаизм", symbol: "✡" },
  buddhism: { label: "Буддизм", symbol: "☸" },
  christianity: { label: "Христианство", symbol: "✝" },
  islam: { label: "Ислам", symbol: "☪" },
  confucianism: { label: "Конфуцианство", symbol: "☯" },
  atheism: { label: "Атеизм (нет религии)", symbol: "🚫" },
};
const RELIGIONS: Religion[] = ["judaism", "buddhism", "christianity", "islam", "confucianism", "atheism"];

/** `null` — ещё не выбрано (отличается от «atheism», осознанного выбора «нет религии», см. ТЗ 4.5). */
const playerReligion: Record<number, Religion | null> = {};
/** Первый игрок, выбравший данную религию, становится её основателем навсегда — даже если потом
 * сам сменит религию (это исторический факт, а не текущее членство). */
const religionFounder: Partial<Record<Religion, number>> = {};
/** Кто ЛИЧНО (платным исследованием, не бесплатной догонкой) первым в партии открыл технологию —
 * зеркалит GameSession.techDiscoverer. По прямому уточнению нужно только "Мистицизм" (право
 * ОСНОВАТЬ новую религию — «нельзя выбрать любую, даже не открыв её»), ключ по techId вообще. */
const techDiscoverer: Record<string, number> = {};

/** По прямому уточнению — три технологии дают право основать новую религию, не только «Мистицизм»:
 * «Мистицизм», «Философия», «Богословие» (любая из трёх, личным исследованием). Зеркалит
 * GameSession.RELIGION_FOUNDING_TECHS. */
const RELIGION_FOUNDING_TECHS = ["Мистицизм", "Философия", "Богословие"];
/** Может ли этот игрок ОСНОВАТЬ (не просто примкнуть к уже основанной) конкретную религию — только
 * личный первооткрыватель одной из RELIGION_FOUNDING_TECHS, только пока эта религия ещё никем не
 * основана, и только если сам ещё не основал никакую другую (одна религия на игрока за партию —
 * по прямому уточнению «почему их стало две»). Зеркалит GameSession.adoptReligion. */
function canFoundReligion(playerId: number, religion: Religion): boolean {
  if (religionFounder[religion] !== undefined) return false;
  if (Object.values(religionFounder).includes(playerId)) return false;
  return RELIGION_FOUNDING_TECHS.some((t) => techDiscoverer[t] === playerId);
}

async function adoptReligion(playerId: number, religion: Religion) {
  // Религия НЕ привязана ни к текущей парадигме (в т.ч. Коммунизму), ни к наличию у игрока
  // технологии «Мистицизм» — по прямому уточнению «принять религию можно независимо от того, какая
  // у игрока текущая парадигма и открыт ли у него монотеизм». Единственное ограничение —
  // ОСНОВАТЬ ещё не открытую религию может только личный первооткрыватель (canFoundReligion ниже).
  if (playerReligion[playerId] === religion) return;
  if (religionFounder[religion] === undefined && !canFoundReligion(playerId, religion)) return;
  // Коммунизм — единственное исключение из «религия не зависит от парадигмы» (по прямому уточнению):
  // под ним бонус +1 действие даёт ТОЛЬКО Атеизм (см. GameSession.adoptParadigm/endTurn) — вручную
  // принять настоящую религию по-прежнему можно, но она бонуса не даст, пока действует Коммунизм.
  // Предупреждаем явно перед подтверждением, а не молча теряем бонус.
  if (playerParadigm[playerId] === "communism" && religion !== "atheism") {
    const ok = window.confirm("При Коммунизме бонус +1 действие даёт только Атеизм — эта религия его не даст, пока действует Коммунизм. Всё равно принять?");
    if (!ok) return;
  }
  const result = await sendAction("adoptReligion", { religion });
  if (!result.ok) setHint(result.hint ?? "Не удалось сменить религию.");
}

/** Сколько игроков приняли эту религию, их города и совокупное население — только для основателя
 * (ТЗ: «игрок видит количество игроков, что приняли его религию»). */
function religionFollowerStats(religion: Religion): { players: number; cities: number; population: number } {
  const followers = PLAYERS.filter((p) => playerReligion[p.id] === religion).map((p) => p.id);
  const followerCities = cities.filter((c) => followers.includes(c.playerId));
  return {
    players: followers.length,
    cities: followerCities.length,
    population: followerCities.reduce((sum, c) => sum + c.population, 0),
  };
}

// --- Дипломатия: реальные отношения между парой игроков + составные предложения (ТЗ 11.7) ---
// Война исключает любое сотрудничество (эксклюзивный статус, не нужна технология); всё остальное —
// «мирные» статусы: Мир — это просто отсутствие войны и соглашений (нейтралитет по умолчанию), а
// поверх мира можно накопить сколько угодно соглашений одновременно (Открытые границы + Торговый
// союз и т.д. — не взаимоисключающие), каждое своей технологией, как раньше в DIPLOMACY_AGREEMENTS.
type Agreement = "openBorders" | "vassalage" | "mutualDefense" | "tradeUnion" | "scienceCoop" | "union";
const AGREEMENT_META: Record<Agreement, { label: string; tech: string; desc: string }> = {
  openBorders: { label: "Открытые границы", tech: "Письменность", desc: "Торговля и проход юнитов у связанных игроков" },
  vassalage: { label: "Вассалитет", tech: "Феодализм", desc: "Вассал не может воевать один, сюзерен получает часть дохода" },
  mutualDefense: { label: "Совместная оборона", tech: "Кодекс законов", desc: "Союзники вступают в войну при нападении на одного" },
  tradeUnion: { label: "Торговый союз", tech: "Гильдии", desc: "Участники не берут друг с друга пошлину за маршруты" },
  scienceCoop: { label: "Научное сотрудничество", tech: "Образование", desc: "Общий уровень технологий" },
  union: { label: "Союз", tech: "Коммунизм", desc: "Объединение в единую команду" },
};
const AGREEMENTS: Agreement[] = ["openBorders", "vassalage", "mutualDefense", "tradeUnion", "scienceCoop", "union"];

interface Relation {
  war: boolean;
  agreements: Set<Agreement>;
  /** Зеркалит GameSession.Relation.truceUntilCycle — цикл, до которого действует перемирие (см.
   * cyclesElapsed ниже); undefined — перемирия нет или оно без срока. */
  truceUntilCycle?: number;
}
/** Ключ — неупорядоченная пара id игроков ("меньший-больший"), одна запись на пару на всю партию. */
const relations: Record<string, Relation> = {};
function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
function relationOf(a: number, b: number): Relation {
  const k = pairKey(a, b);
  if (!relations[k]) relations[k] = { war: false, agreements: new Set() };
  return relations[k];
}

/** Отношения AI — числовая асимметричная шкала 0-100 (см. GameSession.relationScores/relationOf,
 * СПРАВОЧНИК §8.3) — зеркалит серверное состояние 1:1, ключ "${fromId}:${toId}" (мнение fromId о
 * toId), дефолт 50 для отсутствующей записи — та же семантика, что и на сервере. Публично видно
 * всем клиентам (по прямому запросу — отображается на линии дипломатии каждому игроку). */
const relationScores: Record<string, number> = {};
function relationScoreOf(fromId: number, toId: number): number {
  return relationScores[`${fromId}:${toId}`] ?? 50;
}
/** Зеркалит GameSession.relationTierOf — те же 7 диапазонов (нижняя граница включительно). */
const RELATION_TIER_LABEL: Record<string, string> = {
  hate: "Ненависть",
  hostile: "Враждебность",
  bad: "Плохие",
  neutral: "Нейтральные",
  good: "Хорошие",
  friendly: "Дружеские",
  allied: "Союзнические",
};
function relationTierOf(score: number): string {
  if (score < 10) return "hate";
  if (score < 20) return "hostile";
  if (score < 40) return "bad";
  if (score < 60) return "neutral";
  if (score < 80) return "good";
  if (score < 90) return "friendly";
  return "allied";
}
function relationSummary(rel: Relation): string {
  if (rel.war) return "⚔ Война";
  if (rel.agreements.size === 0) return "Мир (нейтралитет)";
  return "Мир — " + Array.from(rel.agreements).map((a) => AGREEMENT_META[a].label).join(", ");
}

/** Объявление войны и разрыв отношений — односторонние мгновенные действия (не требуют согласия
 * цели, в отличие от любого предложения ниже): войну можно объявить не спрашивая, а разорвать
 * действующие соглашения — тоже (их всегда можно перестать соблюдать). Оба сбрасывают пару до
 * «войны без соглашений» / «нейтралитета без соглашений» соответственно. */
async function declareWar(a: number, b: number): Promise<net.ActionResult> {
  return net.sendAction("declareWar", a, { targetId: b });
}
async function breakOffRelations(a: number, b: number) {
  const result = await net.sendAction("breakOffRelations", a, { targetId: b });
  if (!result.ok) setHint(result.hint ?? "Не удалось разорвать отношения.");
}

/** Составное предложение (ТЗ: «несколько вариантов можно компоновать в одно предложение») —
 * список условий, отправитель `from`, получатель `to`; получатель видит и решает ВСЕ условия
 * сразу, целиком принимает или целиком отклоняет (не по частям). */
type ProposalTerm =
  | { kind: "agreement"; agreement: Agreement }
  /** Срок перемирия в циклах, 2-6 включительно (по прямому запросу) — пока не истёк, ни одна из
   * сторон не может снова объявить войну другой (см. GameSession.declareWar). */
  | { kind: "peace"; duration: number }
  | { kind: "demandMoney"; amount: number }
  | { kind: "offerMoney"; amount: number }
  | { kind: "giveCity"; cityId: number }
  | { kind: "demandCity"; cityId: number }
  | { kind: "demandResource"; resource: ResourceId; qty: number }
  | { kind: "giveResource"; resource: ResourceId; qty: number }
  // «Призыв на войну»/«Совместное нападение» (по прямому запросу, «План войны», НОВЫЕ) — заводятся
  // только ботом (см. bot.ts), композер человека их предложить не даёт; но человек может ПОЛУЧИТЬ
  // такое предложение от бота, поэтому клиент обязан их знать хотя бы для отображения (termLabel).
  | { kind: "callToWar"; targetId: number }
  | { kind: "jointAttack"; targetId: number }
  // Система обещаний AI (§8.5 СПРАВОЧНИКА) — ЗАВОДЯТСЯ ТОЛЬКО БОТОМ, композер человека их тоже не
  // даёт (как и два терма выше), но человек регулярно ПОЛУЧАЕТ такие предложения от бота — клиент
  // ОБЯЗАН их знать хотя бы для отображения. [ИСПРАВЛЕНО, живой баг-репорт: «пришло предложение,
  // а вместо текста условия — "undefined"»] — этих 5 кодов не было в клиентском типе вовсе, поэтому
  // switch в termLabel ни разу не совпадал ни с одним case и молча возвращал undefined (TS проверяет
  // exhaustiveness только по ОБЪЯВЛЕННОМУ здесь типу — сервер шлёт эти kind'ы независимо от клиента).
  | { kind: "promiseNoSettle"; regionCol: number; regionRow: number; duration: number }
  | { kind: "promiseNoAttack"; duration: number }
  | { kind: "promiseNoEventCards"; excludedPlayerId: number; duration: number }
  | { kind: "promiseGiveCardType"; cardId: string; duration: number }
  | { kind: "promiseListResource"; resource: ResourceId; duration: number }
  /** «Прекратить торговлю с врагом» — принятие немедленно разрывает ВСЕ соглашения получателя с третьим игроком. */
  | { kind: "breakTiesWith"; targetId: number };

interface Proposal {
  id: number;
  from: number;
  to: number;
  terms: ProposalTerm[];
  /** Ультиматум — отказ автоматически объявляет войну ОТ отправителя К получателю, а не просто ничего не происходит. */
  ultimatum: boolean;
}
/** Очередь предложений — решение показывается получателю в начале ЕГО хода (не сразу при отправке,
 * не в модалке отправителя — иначе получатель узнал бы о предложении раньше своего хода). */
const pendingProposals: Proposal[] = [];

/** Зеркало GameSession.PendingGlobalEvent — оповещение о катаклизме (сброшенный по переполнению руки
 * «Учёный»), висит у каждого живого игрока-человека независимо, пока он сам не закроет окно. */
interface PendingGlobalEvent {
  id: number;
  kind: "cataclysm";
  sourcePlayerId: number;
  description: string;
  hexes: { col: number; row: number }[];
  dismissedBy: number[];
}
const pendingGlobalEvents: PendingGlobalEvent[] = [];

function cityLabel(cityId: number): string {
  const city = cities.find((c) => c.id === cityId);
  if (!city) return "?";
  const owned = cities.filter((c) => c.playerId === city.playerId);
  return `Город ${owned.indexOf(city) + 1} (${PLAYERS[city.playerId].name})`;
}

function cardLabelById(cardId: string): string {
  return ACTION_CARDS.find((c) => c.id === cardId)?.label ?? EVENT_CARDS.find((c) => c.id === cardId)?.label ?? cardId;
}

function termLabel(term: ProposalTerm, from: number, to: number): string {
  switch (term.kind) {
    case "agreement":
      return `Новое соглашение: ${AGREEMENT_META[term.agreement].label}`;
    case "peace":
      return `Мир — окончание войны, перемирие на ${term.duration} цикл(ов) (нельзя объявить войну друг другу до истечения)`;
    case "demandMoney":
      return `${playerNameHtml(to)} платит ${playerNameHtml(from)} ${term.amount} 💰`;
    case "offerMoney":
      return `${playerNameHtml(from)} платит ${playerNameHtml(to)} ${term.amount} 💰`;
    case "giveCity":
      return `${playerNameHtml(from)} передаёт город «${cityLabel(term.cityId)}»`;
    case "demandCity":
      return `${playerNameHtml(to)} передаёт город «${cityLabel(term.cityId)}»`;
    case "demandResource":
      return `${playerNameHtml(to)} передаёт ${term.qty} × ${RESOURCE_META.get(term.resource)!.label}`;
    case "giveResource":
      return `${playerNameHtml(from)} передаёт ${term.qty} × ${RESOURCE_META.get(term.resource)!.label}`;
    case "callToWar":
      return `${playerNameHtml(from)} уже воюет с ${playerNameHtml(term.targetId)} и просит ${playerNameHtml(to)} вступить в войну на его стороне`;
    case "jointAttack":
      return `Совместное нападение — при согласии ${playerNameHtml(from)} и ${playerNameHtml(to)} одновременно объявляют войну ${playerNameHtml(term.targetId)}`;
    case "breakTiesWith":
      return `Прекратить связи: ${playerNameHtml(to)} при согласии немедленно разрывает ВСЕ свои соглашения с ${playerNameHtml(term.targetId)} — просьба ${playerNameHtml(from)}`;
    case "promiseNoSettle":
      return `Обещание: ${playerNameHtml(to)} обязуется не селиться в регионе ${term.regionCol + 1}.${term.regionRow + 1} в течение ${term.duration} цикл(ов) — просьба ${playerNameHtml(from)}`;
    case "promiseNoAttack":
      return `Обещание: ${playerNameHtml(to)} обязуется не нападать на ${playerNameHtml(from)} в течение ${term.duration} цикл(ов)`;
    case "promiseNoEventCards":
      // По прямому запросу — просящий (from) теперь защищает СЕБЯ (excludedPlayerId===from — типичный
      // случай для предложений от AI, см. bot.ts: considerPromiseNoEventCards), а не третью сторону —
      // формулировка ближе к promiseNoAttack выше (адресат назван прямо в тексте, без «— просьба»,
      // раз субъект и объект просьбы совпадают). Третья сторона (excludedPlayerId !== from) всё ещё
      // возможна — например, если человек составит такое условие сам в композере — тогда старая
      // формулировка с явным «— просьба» точнее.
      return term.excludedPlayerId === from
        ? `Обещание: ${playerNameHtml(to)} обязуется не передавать карты событий ${playerNameHtml(from)} в течение ${term.duration} цикл(ов)`
        : `Обещание: ${playerNameHtml(to)} обязуется не передавать карты событий игроку ${playerNameHtml(term.excludedPlayerId)} в течение ${term.duration} цикл(ов) — просьба ${playerNameHtml(from)}`;
    case "promiseGiveCardType":
      return `Обещание: ${playerNameHtml(to)} обязуется передать ${playerNameHtml(from)} карту «${cardLabelById(term.cardId)}» в течение ${term.duration} цикл(ов)`;
    case "promiseListResource":
      return `Обещание: ${playerNameHtml(to)} обязуется выставить ${RESOURCE_META.get(term.resource)!.label} на биржу в течение ${term.duration} цикл(ов) — просьба ${playerNameHtml(from)}`;
  }
}

/** Возвращает true/false по факту — вызывающий (кнопка «Отправить») не должен показывать
 * «отправлено», не дождавшись ответа сервера (см. баг-репорт «предложение не пришло получателю»:
 * старый код звал sendProposal без await и сразу писал «отправлено», даже если сервер отклонил
 * запрос — например «не ваш ход» или незавершённая обязательная передача карты). */
async function sendProposal(from: number, to: number, terms: ProposalTerm[], ultimatum: boolean): Promise<boolean> {
  if (!terms.length) return false;
  const result = await net.sendAction("sendProposal", from, { to, terms, ultimatum });
  if (!result.ok) setHint(result.hint ?? "Не удалось отправить предложение.");
  return result.ok;
}

/** Показывается получателю в начале ЕГО хода (см. onPlayingEndTurn) — очередь, не всплывающее окно
 * у отправителя. По прямому запросу — живой баг-репорт: «фиолетовому пришло предложение торгового
 * союза, он сам должен принимать или отклонять, а не у игрока живого спрашивать» — если получатель
 * СЕЙЧАС ИИ, модалка вообще не показывается: решение — дело `bot.ts: resolveIncomingProposals`,
 * часть его собственного плана хода (тот же клик «Подтвердить ход AI», не отдельное окно) — до этого
 * момента предложение просто остаётся висеть в очереди, как и должно. */
function checkPendingProposalsForCurrentPlayer() {
  if (PLAYERS[currentPlayerIndex]?.isAI) return;
  if (pendingProposals.some((p) => p.to === currentPlayerIndex)) {
    activeModal = "proposal-review";
    renderModal();
  }
}

/** Показывает голосование ООН текущему игроку в начале ЕГО хода — тот же паттерн, что и
 * checkPendingProposalsForCurrentPlayer (в т.ч. та же защита `isAI` — см. её доку ниже), но
 * голосование одно на всех, не персональное: пропускает инициатора (уже проголосовал «за»
 * автоматически) и тех, кто уже проголосовал. */
function checkPendingOonVoteForCurrentPlayer() {
  if (PLAYERS[currentPlayerIndex]?.isAI) return;
  if (pendingOonResolution && !(currentPlayerIndex in pendingOonResolution.votes)) {
    activeModal = "oon-vote";
    renderModal();
  }
}

/** Показывает голосование за генсека ООН текущему игроку — тот же паттерн, что
 * checkPendingOonVoteForCurrentPlayer.
 *
 * [ИСПРАВЛЕНО, живой баг-репорт — «ход жёлтого, показывает окно голосования за генсека, AI должен
 * сам голосовать»] — раньше AI отдельно не пропускался, в расчёте, что бот успевает проголосовать
 * САМ до того, как очередь вообще доходит до этого клиентского check*-вызова (bot.ts:
 * considerOonSecretaryVote). Расчёт был неверным: `computeAiTurnPlan` (bot.ts) строит план хода на
 * КЛОНЕ сессии (`structuredClone`/`GameSession.fromJSON`) — сам голос `considerOonSecretaryVote`
 * записывается ТОЛЬКО в клон, а не в настоящую сессию; настоящий `dispatch("voteOonSecretaryGeneral")`
 * происходит лишь при исполнении уже готового плана (`executeAiPlan`), которое может случиться
 * позже, чем клиент успевает получить событие смены хода и вызвать этот check. В этом окне
 * `pendingOonSecretaryElection.votes` на сервере ЕЩЁ не содержит голос AI-игрока — условие ниже
 * ошибочно срабатывало, открывая модалку голосования во время хода бота, который её никак не может
 * закрыть сам (модалка ждёт клика человека). Теперь, как и у остальных подобных модалок (предложения/
 * резолюции ООН выше), AI-ход просто пропускается целиком — реальный голос бот всё равно поставит
 * через `executeAiPlan`, эта модалка ему для этого не нужна. */
function checkPendingOonSecretaryVoteForCurrentPlayer() {
  if (PLAYERS[currentPlayerIndex]?.isAI) return;
  if (pendingOonSecretaryElection && !(currentPlayerIndex in pendingOonSecretaryElection.votes)) {
    activeModal = "oon-secretary-vote";
    renderModal();
  }
}

async function resolveProposal(id: number, accepted: boolean) {
  const result = await sendAction("resolveProposal", { id, accepted });
  if (!result.ok) setHint(result.hint ?? "Не удалось обработать предложение.");
}

// --- Гос. управление: сводка по игроку и по партии (ТЗ 11.6) --------------------------------
function unitsAndBuildingsUpkeep(playerId: number): { units: number; buildings: number; totalUpkeep: number } {
  const unitCount = units.filter((u) => u.playerId === playerId).length;
  const buildingCount = builtBy(buildingOwners, playerId).length;
  const raw = unitCount + buildingCount;
  // «Кодекс законов» (по прямому запросу) — первооткрыватель платит вдвое меньше содержания
  // (округление вниз, как в GameSession.collectTaxes — тот же расчёт, только для превью).
  const totalUpkeep = techDiscoverer["Кодекс законов"] === playerId ? Math.floor(raw / 2) : raw;
  return { units: unitCount, buildings: buildingCount, totalUpkeep };
}

/** «Сколько денег приносит доступная сеть на 1 торговый ресурс» — буквально множитель из
 * Торговца (3.1.6): доход = города сети × уникальные типы, так что на 1 уникальный тип
 * приходится ровно «города сети» денег. Считается от столицы, раз само окно не привязано к
 * конкретному городу игрока. */
function tradeNetworkIncomePerResource(playerId: number): number {
  const capital = capitalCityOf(playerId);
  if (!capital) return 0;
  return tradeNetworkOf(capital).cities.length;
}

/** Лес на своей территории (все регионы со своими городами) — тот же скан, что у
 * `degradeForestOrLand()` (3.2.4), просто считает вместо того чтобы менять. */
function ownForestCount(playerId: number): number {
  let count = 0;
  for (const c of cities.filter((c) => c.playerId === playerId)) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        if (doc.get(c.regionCol * REGION_SIZE_X + dx, c.regionRow * REGION_SIZE_Y + dy).forest) count++;
      }
    }
  }
  return count;
}

function populationRace(): { leaderId: number; leaderPop: number; totalPop: number; sharePercent: number } {
  const totals = PLAYERS.map((p) => ({ id: p.id, pop: totalPopulationOf(p.id) }));
  const totalPop = totals.reduce((s, t) => s + t.pop, 0);
  const leader = totals.reduce((best, t) => (t.pop > best.pop ? t : best), totals[0]);
  return { leaderId: leader.id, leaderPop: leader.pop, totalPop, sharePercent: totalPop ? Math.round((leader.pop / totalPop) * 100) : 0 };
}
function citiesRace(): { leaderId: number; leaderCities: number } {
  const counts = PLAYERS.map((p) => ({ id: p.id, count: cities.filter((c) => c.playerId === p.id).length }));
  const leader = counts.reduce((best, c) => (c.count > best.count ? c : best), counts[0]);
  return { leaderId: leader.id, leaderCities: leader.count };
}
function spaceRace(): { leaderId: number; leaderComponents: number } {
  const leader = PLAYERS.reduce((best, p) => (spaceComponents[p.id] > spaceComponents[best.id] ? p : best), PLAYERS[0]);
  return { leaderId: leader.id, leaderComponents: spaceComponents[leader.id] };
}

/** Справочно — какую стратегию победы «выберет» ИИ-игрок. В клиенте нет никакого ИИ вообще (это
 * 3-человеческий hotseat-прототип, см. ТЗ 8.2) — эти 5 строк ни на что не влияют и ни к чему не
 * подключены, чисто информационный список для этого окна, как раньше был DIPLOMACY_AGREEMENTS. */
const AI_VICTORY_STRATEGIES = ["Военная (города)", "Космическая", "Население", "ООН", "Окончание по времени"];

interface UnitInstance {
  id: number;
  playerId: number;
  /** Родной город (постройки) — используется как источник доступа для цены хода/атаки, город-очередь
   * гарнизона не завязана на это поле (гарнизон читает units, стоящие на клетке города, 5.3). */
  cityId: number;
  category: UnitCategory;
  epoch: TechDef["epoch"];
  col: number;
  row: number;
  hp: number;
  /** «Обороняться» (6.3) — не двигается, не поддерживает, зато бонусы обороны (6.2) удваиваются. */
  defending: boolean;
  /** Пиратство/грабёж (по прямому запросу) — на гексе торгового маршрута перехватывает 1💰 с чужого
   * розыгрыша «Торговца», см. GameSession.traderTrade/toggleRaid. */
  raiding: boolean;
  /** Очередь хода на несколько клеток вперёд (5.3/9 — «в конце цикла») — остаток пути, который
   * юнит доходит по частям, по moveRange (с учётом дорог) за КАЖДЫЙ конец цикла, пока не дойдёт
   * или не наткнётся на затор. `null` — юнит без активного приказа на движение. */
  moveOrder: { path: { col: number; row: number }[]; nextIndex: number } | null;
}
let units: UnitInstance[] = [];
/** Юнит только что высадился на берег в этом цикле (сошёл с корабля-«моста» на настоящую сушу) —
 * «ход юнита заканчивается»: новую команду до начала следующего цикла принимать нельзя. */
const landedThisCycle = new Set<number>();
/** Юниту не хватило остатка хода на гекс, куда он всё равно вошёл (холмы 2 очка, лес +1 — по
 * прямому уточнению): останавливается там же, но в ЭТОМ цикле не может ни атаковать, ни встать в
 * оборону — только новую команду на движение принять по-прежнему можно (в отличие от
 * landedThisCycle выше, которое блокирует вообще всё). */
const outOfMoveThisCycle = new Set<number>();
/** Кто уже отдавал приказ (движение/атака/оборона/грабёж) в текущем цикле. */
const unitActedThisCycle = new Set<number>();
/** Зеркало GameSession.moveBudgetUsedThisCycle — сколько бюджета хода (moveRange) юнит уже потратил
 * в этом цикле, по прямому запросу «на кнопке "Переместить" должно показываться, сколько очков хода
 * ещё осталось» (см. renderUnitCommandBar). */
const moveBudgetUsedThisCycle = new Map<number, number>();
function remainingMoveBudget(u: UnitInstance): number {
  return Math.max(0, unitStats(u).moveRange - (moveBudgetUsedThisCycle.get(u.id) ?? 0));
}

function unitStats(u: UnitInstance): UnitStats {
  return statsFor(u.category, u.epoch);
}

/** Холмы увеличивают дальность стрельбы дальнобойных юнитов (высота даёт обзор/дальнобой) —
 * только у Дальней атаки (у остальных категорий дальность 0/1, «дальше видеть» тут ни на что не
 * влияет), только пока юнит СТОИТ на холме, не привязано к цели. */
function effectiveAttackRange(u: UnitInstance): number {
  const stats = unitStats(u);
  const onHills = stats.attackRange > 1 && doc.get(u.col, u.row).terrain === "hills";
  return stats.attackRange + (onHills ? 1 : 0);
}

/** Everything this player is currently allowed to build — Воин is free, the rest need their tech
 * researched (ТЗ 5.1 × Технологии.md's per-tech unit lists). */
function availableUnitsFor(playerId: number): UnitDef[] {
  const researched = researchedTechs[playerId];
  return UNITS.filter((u) => u.tech === null || researched.has(u.tech));
}

// --- Trade routes (ТЗ 4.1 — 8 route techs) --------------------------------------------------
// Built by whoever researches a route-granting tech, connecting two of their own cities. A route
// never mixes terrain: "land" техи (Колесо/Верховая езда/Железные дороги) need an all-land path,
// "sea" техи (Мореплавание/Компас) an all-sea path, "universal" (Банковское дело/Авиация/
// Космонавтика) ignore terrain — see findRoutePath.

interface TradeRoute {
  id: number;
  playerId: number;
  techId: string;
  category: "land" | "sea" | "universal";
  fromCityId: number;
  toCityId: number;
  path: { col: number; row: number }[]; // hex-by-hex, city to city, length-1 ≤ 12
}
let tradeRoutes: TradeRoute[] = [];

function isSeaTile(col: number, row: number): boolean {
  return doc.get(col, row).terrain === "ocean"; // ice blocks sea routes same as it blocks ships
}

/** Маршрут после исследования route-технологии (ТЗ 4.1) — зеркалит GameSession.PendingRoute
 * (playerId/techId/category, БЕЗ fromCityId: сервер сохраняет это состояние между 2 сообщениями
 * действия только для «уже открыт маршрут, ждём 2 клика по городам», сам первый клик — чисто
 * клиентское промежуточное состояние до того, как оба города известны и можно отправить
 * `pickRouteCities` одним вызовом, см. pickRouteCity ниже). */
interface PendingRoute {
  playerId: number;
  techId: string;
  category: TradeRoute["category"];
}
let pendingRoute: PendingRoute | null = null;
/** Первый выбранный город маршрута — чисто клиентское (не часть SaveGameV1), сбрасывается только
 * при отправке pickRouteCities или обычным Esc. */
let pendingRouteFromCityId: number | null = null;
/** По прямому запросу — «остаточный артефакт»: `pendingRoute` на сервере ГЛОБАЛЬНЫЙ (один слот на
 * всю партию, playerId просто поле внутри), не привязан к текущему игроку клиента. Если игрок
 * исследовал маршрутную технологию и не успел (или не стал) выбрать 2 города до конца своего хода,
 * это состояние остаётся висеть и раньше перехватывало клики уже ДРУГОГО игрока на следующих ходах
 * («Первый город маршрута должен быть вашим» — чисто клиентская проверка в `pickRouteCity` — вместо
 * ожидаемого действия), потому что весь клик-роутинг проверял голую истинность `pendingRoute`, не
 * сверяя владельца. Используется вместо прямой проверки `pendingRoute` везде, где решение — «хватать
 * клик/показывать подсказку СЕЙЧАС для текущего игрока», а не читать поля чужого `pendingRoute`. */
function pendingRouteIsMine(): boolean {
  return pendingRoute !== null && pendingRoute.playerId === currentPlayerIndex;
}

/** «Торговый путь» (event, переосмыслена по прямому запросу — раньше умела только «перенаправить
 * существующий путь» или «оставить как есть», из-за чего была бесполезна без хотя бы одного уже
 * проложенного маршрута) — три равноценных действия на выбор, каждое за 2 РАЗНЫХ торговых ресурса:
 * проложить новый (pendingTradeRouteNew), перенаправить существующий (pendingRouteRedirect) или
 * удалить существующий (pendingTradeRouteDelete). Ни одно из трёх не списывает ресурсы до финального
 * клика — Esc-отмена всегда бесплатна. */

/** Redirect ANY existing trade route (any player's, not just the active player's own) to a
 * different city. Step 1 (`routeId === null`) picks a city that's a current endpoint of some
 * route — identifies which route AND which of its two ends gets replaced. Step 2 picks the new
 * city for that end; the route's OTHER end stays fixed, but (по прямому уточнению) новый город
 * может принадлежать ЛЮБОМУ игроку — маршрут переходит его владельцу целиком. */
interface PendingRouteRedirect {
  slotIndex: number;
  routeId: number | null;
  oldEndpointCityId: number | null;
}
let pendingRouteRedirect: PendingRouteRedirect | null = null;

/** Шаг 1 (выбор города с существующим путём) остаётся чисто клиентским — только для UX (не тратит
 * ничего); шаг 2 (новый город) отправляет ОДИН вызов "redirectTradeRoute" со всеми параметрами
 * сразу (см. dispatch в GameSession.ts) — сервер и валидирует, и списывает ресурсы, и ищет путь. */
async function pickRedirectCity(city: City) {
  if (!pendingRouteRedirect) return;
  if (pendingRouteRedirect.routeId === null) {
    const route = tradeRoutes.find((r) => r.fromCityId === city.id || r.toCityId === city.id);
    if (!route) {
      setHint("В этот город не идёт ни один торговый путь — выберите другой. Esc — отмена.");
      return;
    }
    pendingRouteRedirect.routeId = route.id;
    pendingRouteRedirect.oldEndpointCityId = city.id;
    setHint("Путь выбран — теперь выберите новый город (любой, даже чужой — маршрут перейдёт его владельцу). Esc — отмена.");
    renderCityList();
    return;
  }
  const { slotIndex, routeId, oldEndpointCityId } = pendingRouteRedirect;
  pendingRouteRedirect = null;
  renderCityList();
  const result = await sendAction("redirectTradeRoute", { slotIndex, routeId, oldEndpointCityId, newCityId: city.id });
  if (!result.ok) setHint(result.hint ?? "Не удалось перенаправить путь.");
}

/** Проложить НОВЫЙ маршрут (категория всегда "universal" на сервере, см. layNewTradeRoute) — тот
 * же 2-клика паттерн, что у pickRouteCity/pickRouteRightCity ниже: первый город обязан быть своим,
 * второй — любой существующий город (свой или чужой). */
interface PendingTradeRouteNew {
  slotIndex: number;
  fromCityId: number | null;
}
let pendingTradeRouteNew: PendingTradeRouteNew | null = null;

async function pickTradeRouteNewCity(city: City) {
  if (!pendingTradeRouteNew) return;
  if (pendingTradeRouteNew.fromCityId === null) {
    if (city.playerId !== currentPlayerIndex) {
      setHint("Первый город маршрута должен быть вашим.");
      return;
    }
    pendingTradeRouteNew = { ...pendingTradeRouteNew, fromCityId: city.id };
    setHint("Первый город выбран — теперь выберите второй (свой или чужой). Esc — отмена.");
    renderCityList();
    return;
  }
  if (city.id === pendingTradeRouteNew.fromCityId) {
    setHint("Второй город должен отличаться от первого. Esc — отмена.");
    return;
  }
  const { slotIndex, fromCityId } = pendingTradeRouteNew;
  pendingTradeRouteNew = null;
  renderCityList();
  const result = await sendAction("layNewTradeRoute", { slotIndex, fromCityId, toCityId: city.id });
  if (result.hint) setHint(result.hint);
}

/** Удалить существующий маршрут (чей угодно, тем же принципом, что у перенаправления) — один клик
 * по городу-концу маршрута сразу удаляет весь путь, второй шаг не нужен. */
interface PendingTradeRouteDelete {
  slotIndex: number;
}
let pendingTradeRouteDelete: PendingTradeRouteDelete | null = null;

async function pickTradeRouteDeleteCity(city: City) {
  if (!pendingTradeRouteDelete) return;
  const route = tradeRoutes.find((r) => r.fromCityId === city.id || r.toCityId === city.id);
  if (!route) {
    setHint("В этот город не идёт ни один торговый путь — выберите другой. Esc — отмена.");
    return;
  }
  const { slotIndex } = pendingTradeRouteDelete;
  pendingTradeRouteDelete = null;
  renderCityList();
  const result = await sendAction("deleteTradeRoute", { slotIndex, routeId: route.id });
  if (!result.ok) setHint(result.hint ?? "Не удалось удалить путь.");
}

/** Коммунизм — второй город, доп. к столице (по прямому запросу — «дополнительно к столице
 * выбирается город, столица остаётся прежней»): один клик по своему НЕстоличному городу в списке
 * или на карте, из кнопки в «Гос. управление» (GameSession.chooseCommunismCity). */
let pendingCommunismCityPick = false;
async function pickCommunismCity(city: City) {
  if (!pendingCommunismCityPick) return;
  pendingCommunismCityPick = false;
  renderCityList();
  const result = await sendAction("chooseCommunismCity", { cityId: city.id });
  if (!result.ok) setHint(result.hint ?? "Не удалось выбрать город.");
  else {
    setHint(`Город ${city.id} выбран доп. источником ресурсов Коммунизма.`);
    renderRightPanelExtra();
  }
}

/** Шаг 1 (первый город) — чисто клиентское промежуточное состояние (pendingRouteFromCityId, см.
 * выше); шаг 2 отправляет ОДИН вызов "pickRouteCities" с обоими id — сервер ищет путь и создаёт
 * маршрут (см. GameSession.pickRouteCities). */
async function pickRouteCity(city: City) {
  if (!pendingRouteIsMine()) return;
  const route = pendingRoute!;
  if (pendingRouteFromCityId === null) {
    // Первый город обязан быть своим — маршрут тянется ОТ своего города; второй (ниже) уже может
    // принадлежать любому игроку, по прямому уточнению «маршрут можно строить не только к своему,
    // но и к городу другого игрока».
    if (city.playerId !== route.playerId) {
      setHint("Первый город маршрута должен быть вашим.");
      return;
    }
    pendingRouteFromCityId = city.id;
    setHint("Первый город выбран — теперь выберите второй (свой или чужой; не дальше 12 гексов, без смешения суши/моря).");
    renderCityList();
    return;
  }
  if (city.id === pendingRouteFromCityId) {
    setHint("Второй город должен отличаться от первого. Esc — отмена.");
    return;
  }
  const fromCityId = pendingRouteFromCityId;
  pendingRouteFromCityId = null;
  const result = await sendAction("pickRouteCities", { fromCityId, toCityId: city.id });
  // ok:true с hint — путь не нашёлся, но право прокладки сохранено картой в руке (см. GameSession.
  // pickRouteCities/makeRouteRightCard) — тоже стоит показать, не только ошибки.
  if (result.hint) setHint(result.hint);
}

/** Карта «Право прокладки маршрута» (см. GameSession.playRouteRightCard) — тот же 2-клика паттерн,
 * что у pickRouteCity, только источник — pendingCardAction, а не серверный pendingRoute. */
function startRouteRightPlay(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "routeRight-city", slotIndex, fromCityId: null };
  renderHand();
  renderCityList();
  updateHint();
}
async function pickRouteRightCity(city: City) {
  if (!pendingCardAction || pendingCardAction.kind !== "routeRight-city") return;
  if (pendingCardAction.fromCityId === null) {
    if (city.playerId !== currentPlayerIndex) {
      setHint("Первый город маршрута должен быть вашим.");
      return;
    }
    pendingCardAction = { ...pendingCardAction, fromCityId: city.id };
    setHint("Первый город выбран — теперь выберите второй (свой или чужой).");
    renderCityList();
    return;
  }
  if (city.id === pendingCardAction.fromCityId) {
    setHint("Второй город должен отличаться от первого. Esc — отмена.");
    return;
  }
  const { slotIndex, fromCityId } = pendingCardAction;
  pendingCardAction = null;
  renderCityList();
  const result = await sendAction("playRouteRightCard", { slotIndex, fromCityId, toCityId: city.id });
  if (result.hint) setHint(result.hint);
}

// --- Учёный: групповая граница ветки (ТЗ 4.2/3.1.8, п.5 очереди правок) -----------------------
// По прямому уточнению — технология на позиции N ветки доступна для исследования (за карту+
// действие+ресурсы, НЕ бесплатно) любому игроку, если позиция N−1 той же ветки уже исследована
// КЕМ УГОДНО (не обязательно тем же игроком). Пример: если открыты «Бронзовое дело», «Колесо» и
// «Каменная кладка» (неважно кем), уже доступны «Горное дело», «Письменность» и «Мистицизм» —
// «Гончарное дело» нет, раз «Мореплавание» никем не открыто. Технологию можно переоткрыть повторно
// (юниты/здания достаются как обычно), но бонус первооткрывателя (авто-маршрут, право основать
// религию) — только тому, кто открыл её первым (см. GameSession.researchTech/techDiscoverer).
function branchTechOrder(branch: TechDef["branch"]): TechDef[] {
  return TECH_TREE.filter((t) => t.branch === branch); // TECH_TREE is declared epoch-by-epoch, so this is already in epoch order
}
/** Сколько позиций ветки подряд от начала уже коллективно закрыты — кем угодно, каждая может быть
 * закрыта разными игроками. Зеркалит GameSession.branchGroupDepth. */
function branchGroupDepth(branch: TechDef["branch"]): number {
  const order = branchTechOrder(branch);
  let depth = 0;
  while (depth < order.length && PLAYERS.some((p) => researchedTechs[p.id].has(order[depth].id))) depth++;
  return depth;
}
/** How many of the epoch's 4 branches have at least one researched tech in them — по прямому
 * уточнению считается по ЛЮБОМУ игроку («одному игроку не нужно открывать всю ветку самому,
 * учитываются открытия других игроков»), не только по тому, для кого считается maxEligibleEpoch.
 * Зеркалит GameSession.branchesTouchedInEpoch — эта копия только рисует модалку. */
function branchesTouchedInEpoch(epoch: TechDef["epoch"]): number {
  return BRANCHES.filter((b) => TECH_TREE.some((t) => t.branch === b && t.epoch === epoch && PLAYERS.some((p) => researchedTechs[p.id].has(t.id)))).length;
}
/** Highest epoch any player may currently pick a technology from — общий порог на всех (см. выше).
 * Normally epoch N+1 would need epoch N fully finished (both techs in all 4 branches); touching
 * (≥1 researched tech in, by ANY player) 3 or 4 of epoch N's 4 branches unlocks epoch N+1 early
 * ("досрочно"), even with epoch N incomplete. */
function maxEligibleEpoch(_playerId: number): TechDef["epoch"] {
  let epoch: TechDef["epoch"] = 1;
  while (epoch < 6 && branchesTouchedInEpoch(epoch) >= 3) epoch = (epoch + 1) as TechDef["epoch"];
  return epoch;
}
/** Techs this player can research right now via «Учёный» — EVERY position from the start of a
 * branch up to and including branchGroupDepth that this player doesn't personally have yet (может
 * вернуть больше одной строки на ветку — игрок мог отстать сразу на несколько позиций). Mirrors
 * GameSession.availableResearchFor. */
function availableResearchFor(playerId: number): TechDef[] {
  const maxEpoch = maxEligibleEpoch(playerId);
  const out: TechDef[] = [];
  for (const b of BRANCHES) {
    const order = branchTechOrder(b);
    const groupDepth = branchGroupDepth(b);
    for (let idx = 0; idx <= groupDepth && idx < order.length; idx++) {
      const t = order[idx];
      if (researchedTechs[playerId].has(t.id)) continue;
      if (t.epoch > maxEpoch) continue;
      out.push(t);
    }
  }
  return out;
}
/** «Учёный», эндгейм-выбор 1 из 4 (по прямому запросу) — открывается, только когда игрок исследовал
 * буквально ВСЕ технологии партии (не то же самое, что «сейчас нечего исследовать» — та временная
 * пауза бывает и раньше, если ветки упёрлись в лидера). Зеркалит GameSession's проверку в
 * useScientistEndgameEffect. */
function allTechsResearched(playerId: number): boolean {
  return TECH_TREE.every((t) => researchedTechs[playerId]?.has(t.id));
}

/** No manual token selection — each click places whichever value comes next for this player:
 * 3 first, then 2, then 1 (ТЗ order), reading straight off how many they've placed so far. */
function nextTokenValueFor(playerId: number) {
  const count = placedTokens.filter((t) => t.playerId === playerId).length;
  return count < 3 ? TOKEN_VALUES[count] : null;
}

// Владение зданиями — общее на партию, не по игрокам: каждое здание достаётся ровно одному
// игроку, первому построившему его.
const buildingOwners: BuildingOwners = {};

// --- Playing-phase state (per player; deck is shared) — все поля ниже теперь зеркалят сервер. ---
let deck: CardDef[] = [];
/** В WeGo сервер (toPrivateView) не присылает содержимое колоды вовсе (иначе будущие карты были бы
 * предсказуемы) — только счётчик state.deckCount; в хотсите deck.length совпадает с ним всегда. */
let deckCount = 0;
const hands: Record<number, CardDef[]> = {};
/** Число карт в руке ЛЮБОГО игрока (не только текущего) — в WeGo чужая рука приходит от сервера как
 * `{count}`, не массив (toPrivateView), поэтому `.length` даёт undefined для неё; свою руку (и любую
 * в хотсите, где приватности нет) — как обычно. Все места, читающие ЧУЖУЮ руку именно для счётчика
 * (не для содержимого — содержимое чужой руки нигде, кроме своей собственной, недоступно и не
 * нужно), должны идти через эту функцию, не напрямую hands[id].length. */
function handCountOf(playerId: number): number {
  const h = hands[playerId] as CardDef[] | { count: number } | undefined;
  if (!h) return 0;
  return Array.isArray(h) ? h.length : h.count;
}
const actionsLeft: Record<number, number> = {};
/** Зеркалит GameSession.actionsTotal — сколько действий было ВСЕГО в начале этого хода (по прямому
 * запросу: «число кружков должно быть равно числу действий», не max(2, остаток) — иначе бонус от
 * Демократии/Религии терялся из виду по мере траты действий, см. renderActionPips). */
const actionsTotal: Record<number, number> = {};
const money: Record<number, number> = {};

/** Player's resource storage — зеркалит склад с сервера (сама логика лимита/пополнения теперь в
 * GameSession.ts: addToWarehouse/takeFromWarehouse/WAREHOUSE_CAP и т.п.). */
const warehouse: Record<number, Partial<Record<ResourceId, number>>> = {};
/** Зеркалит GameSession.communismBonusHeld — какие единицы склада защищены от продажи (пришли от
 * бонуса Коммунизма, см. communismProtectedQty). */
const communismBonusHeld: Record<number, Partial<Record<ResourceId, number>>> = {};
/** Зеркалит GameSession.communismExtraCityId — второй город Коммунизма, доп. к столице (по прямому
 * запросу — «дополнительно к столице выбирается город, столица остаётся прежней»). */
const communismExtraCityId: Record<number, number> = {};

/** Electricity/Промтовары — building-only outputs, never on the map and never harvested from a
 * region, so they live outside `warehouse`/`ResourceId` rather than pretend to be a map resource
 * (which would wrongly pull them into the food/strategic/trade category logic and the market
 * seed). Only source: activating the building that produces them (see BuildingDef.produces /
 * activateProductionBuilding). */
type BuildingResourceId = "electricity" | "promtovary";
const BUILDING_RESOURCE_META: Record<BuildingResourceId, { label: string; symbol: string; color: number }> = {
  electricity: { label: "Электричество", symbol: "⚡", color: 0xf5d547 },
  promtovary: { label: "Промтовары", symbol: "Пр", color: 0xc47fd4 },
};
const buildingResources: Record<number, Partial<Record<BuildingResourceId, number>>> = {};

/** A market lot: either a hand card (sold by its owner, price 1-5 — a transfer, not a play, so it
 * doesn't cost an action, same reasoning as the mandatory end-of-turn card handoff in ТЗ 2.3) or a
 * single resource unit. `sellerId: WORLD_SELLER` marks the seeded test listings below — nobody's
 * money, so buying one doesn't credit anyone. */
const WORLD_SELLER = -1;
interface CardListing {
  id: number;
  sellerId: number;
  kind: "card";
  card: CardDef;
  price: number;
  /** Which of the seller's OWN hand slots this card is still physically sitting in — listing it
   * doesn't remove it from hand (ТЗ 2.3, redesigned), only locks that slot until bought. Every
   * other hand-array splice for that player must shift this down by 1 if it removed an earlier
   * slot, or it'd end up pointing at the wrong card (see `shiftListingSlotsAfterRemoval`). */
  sellerSlotIndex: number;
}
interface ResourceListing {
  id: number;
  sellerId: number;
  kind: "resource";
  resource: ResourceId;
  price: number;
}
type MarketListing = CardListing | ResourceListing;
const market: MarketListing[] = [];

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="table">
    <div class="map-area">
      <div class="left-rail">
        <div class="tech-tree" id="tech-tree"></div>
        <div class="buildings-panel" id="buildings-bar"></div>
      </div>
      <div class="map-wrap"><div id="pixi-container"></div><div class="hex-info-panel" id="hex-info-panel"></div></div>
      <!-- Same fill-the-rail approach as .left-rail (ТЗ 11.4/11.5) — a real panel now, no longer
           a dummy spacer, so the map stays centred on the window while this side earns its keep. -->
      <div class="right-rail">
        <div class="action-buttons-row" id="action-buttons"></div>
        <div class="city-list" id="city-list"></div>
        <div class="warehouse-panel" id="warehouse-panel"></div>
        <div class="right-panel-extra" id="right-panel-extra"></div>
      </div>
    </div>
    <div class="map-filters" id="map-filters"></div>
    <div class="unit-command-bar" id="unit-command-bar"></div>
    <div class="hint-bar" id="hint-bar"></div>
    <div class="bottom-bar" id="bottom-bar"></div>
    <div class="side-modal-backdrop" id="side-modal-backdrop"></div>
    <div class="pause-menu-backdrop" id="pause-menu-backdrop"></div>
    <svg class="ai-plan-overlay" id="ai-plan-overlay"></svg>
    <div class="ai-plan-panel" id="ai-plan-panel"></div>
    <div class="ai-plan-panel wego-report-panel" id="wego-report-panel"></div>
    <div class="ai-plan-panel global-event-panel" id="global-event-panel"></div>
  </div>
`;

function setHint(text: string) {
  document.querySelector<HTMLDivElement>("#hint-bar")!.textContent = text;
}

// --- Tech tree: vertical, epoch 1 at the bottom, 4 branch columns. Just a visual audit tool for
// now (no research wired up yet). Branches are positional (ТЗ 4.2), not thematic — so what a node
// *means* is carried by its category colour/icon, not by which column it sits in. Nodes with no
// designed effect yet are drawn hollow, so gaps in any branch are immediately visible. ---
function renderTechTree() {
  const el = document.querySelector<HTMLDivElement>("#tech-tree")!;
  // DOM order stays 1..6; `.tech-rows` is `column-reverse`, which puts epoch 1 at the bottom.
  const rows = EPOCHS;

  // По прямому уточнению — панель раньше показывала только «кто уже исследовал» (чипы), без
  // подсказки, что ИМЕННО может исследовать текущий игрок прямо сейчас (включая «догнать»
  // технологию, которую лидер ветки уже открыл — см. canAdvanceBranch); дерево из-за этого
  // выглядело так, будто предыдущие уровни ветки никому, кроме лидера, не видны. Теперь у каждого
  // узла — статус относительно ТЕКУЩЕГО игрока: done (уже его), available (следующая в очереди его
  // ветки — то же множество, что и availableResearchFor, включает и «догнать», и «толкнуть
  // границу»), иначе locked (пока не подошла очередь).
  const player = PLAYERS[currentPlayerIndex];
  const availableIds = new Set(availableResearchFor(player.id).map((t) => t.id));

  const node = (t: (typeof TECH_TREE)[number]) => {
    const meta = CAT_META[t.cat];
    const mine = researchedTechs[player.id].has(t.name);
    const status = mine ? "done" : availableIds.has(t.id) ? "available" : "locked";
    const cls = ["tech-node", status, t.hasEffect ? "" : "empty", t.unique ? "unique" : "", t.building ? "building" : ""]
      .filter(Boolean)
      .join(" ");
    // Структурированная подсказка (по прямому запросу — короче и понятнее, чем раньше): Юниты →
    // Здания → Город → «прочее» (t.summary — маршруты/дипломатия/парадигмы/ресурсы) → Первооткрывателю,
    // общий источник строк с модалкой «Учёный» ниже — см. techEffectLines (techtree.ts).
    const effectLines = techEffectLines(t);
    const effectBlock = effectLines.length ? `\n${effectLines.join("\n")}` : "";
    // Player chips — who has researched this tech. Placed by researchTech() (see «Учёный», not
    // built yet); tested via window.__debug.researchTech in the meantime.
    const researchers = PLAYERS.filter((p) => researchedTechs[p.id].has(t.name));
    const chips = researchers.length
      ? `<div class="tech-chips">${researchers.map((p) => `<span class="tech-chip" style="--pc:${playerCss(p.id)}" title="${p.name} исследовал(а)"></span>`).join("")}</div>`
      : "";
    const chipNote = researchers.length ? `\nИсследовали: ${researchers.map((p) => p.name).join(", ")}` : "";
    const statusNote =
      status === "done"
        ? `\n✓ Уже исследована (${player.name})`
        : status === "available"
          ? `\n▶ Доступна для исследования сейчас (${player.name})`
          : `\n🔒 Пока не подошла очередь в этой ветке`;
    const tip = `${t.name} ${t.tags}${effectBlock}\nЦена открытия: ${EPOCH_RESEARCH_COST[t.epoch]}${chipNote}${statusNote}\n— ${meta.label}${t.unique ? " · уникальная (в дизайне)" : ""}`;
    const statusMark = status === "available" ? `<span class="tech-status-mark">▶</span>` : status === "locked" ? `<span class="tech-status-mark">🔒</span>` : "";
    return `<div class="${cls}" data-tech="${t.id}" style="--cat: ${meta.color}" title="${tip.replace(/"/g, "&quot;")}"><span class="ico">${meta.icon}</span>${statusMark}${chips}</div>`;
  };

  el.innerHTML = `
    <div class="tech-title">Дерево технологий</div>
    <div class="tech-branch-headers">
      <div class="tech-epoch-label"></div>
      ${BRANCHES.map((b) => {
        const gaps = branchGaps(b);
        return `<div class="tech-branch-header${isBranchComplete(b) ? " complete" : ""}" title="Ветка ${b + 1} — позиционная (механика лидерства), 12 технологий${gaps ? `, из них ${gaps} без эффекта` : ", все с эффектами"}">Ветка ${b + 1}${gaps ? `<i>${gaps}</i>` : ""}</div>`;
      }).join("")}
    </div>
    <div class="tech-rows">
      ${rows
        .map(
          (epoch) => `
        <div class="tech-row">
          <div class="tech-epoch-label" title="Эпоха ${epoch} — ${EPOCH_NAMES[epoch]}">${epoch}<i>${EPOCH_NAMES[epoch]}</i></div>
          ${BRANCHES.map(
            (branch) => `<div class="tech-branch-cell">${techsAt(epoch, branch).map(node).join("")}</div>`
          ).join("")}
        </div>`
        )
        .join("")}
    </div>
    <div class="tech-legend">
      ${CATS.map(
        (c) =>
          `<span class="sw" style="--cat: ${CAT_META[c].color}" title="${CAT_META[c].label}">${CAT_META[c].icon}</span>`
      ).join("")}
      <span class="sw hollow" title="Эффект ещё не задан"></span>
      <span class="sw ring" title="🔓 уникальная — по дизайну должна доставаться только лидеру ветки, но эта проверка пока не реализована">🔓</span>
    </div>
  `;
}

// --- Городская застройка: 16 зданий, 4 группы × 4. Здание достаётся ДО 2 игрокам за партию, у
// каждого свой независимый экземпляр — кто построил (одним из первых двух), тот и владеет; третьему
// и далее оно больше недоступно, только когда оба слота заняты (ТЗ 4.4, buildings.ts:
// MAX_BUILDING_OWNERS). Владение глобальное (buildingOwners: id -> до 2 id игроков), не в состоянии
// игрока. Постройка требует активной карты «Строитель» (ТЗ 3.1.5) и реально списывает цену со
// столицы/склада/рынка. Здания без заданного эффекта показаны полыми. ---
/** No per-resource icon exists for a whole category (only single resources have one in
 * RESOURCE_META) — a small fixed lookup so category cost lines (e.g. "2 разных торговых") still
 * get an icon in the buildings panel, not just specific ones. */
const RESOURCE_CATEGORY_META: Record<"food" | "strategic" | "trade", { icon: string; color: string }> = {
  food: { icon: "🌾", color: "#7cb342" },
  strategic: { icon: "⛏", color: "#8f9aa8" },
  trade: { icon: "💠", color: "#d4a83f" },
};

/** Compact icon+count chips for a building's price, one per cost line — same visual language as
 * the resource chips elsewhere (city list/warehouse), just small enough to fit a 4×4 grid cell. */
function costIconsHtml(lines: BuildingCostLine[]): string {
  return lines
    .map((line) => {
      if (line.kind === "specific") {
        const meta = RESOURCE_META.get(line.resource as ResourceId)!;
        return `<span class="bld-cost-ico" style="--rc:#${meta.color.toString(16).padStart(6, "0")}" title="${meta.label} ×${line.count}">${meta.symbol}×${line.count}</span>`;
      }
      if (line.kind === "anyOf") {
        // Не встречается в costLines зданий сейчас (только у RESEARCH_COST_LINES на сервере), но тип
        // общий — на всякий случай показываем список через «/».
        const labels = line.resources.map((r) => RESOURCE_META.get(r as ResourceId)?.symbol ?? r).join("/");
        return `<span class="bld-cost-ico" title="Любой из: ${line.resources.join(", ")} ×${line.count}">${labels}×${line.count}</span>`;
      }
      const meta = RESOURCE_CATEGORY_META[line.category];
      return `<span class="bld-cost-ico" style="--rc:${meta.color}" title="${line.count} разных ${line.category === "food" ? "пищевых" : line.category === "trade" ? "торговых" : "стратегических"} ×${line.count}">${meta.icon}×${line.count}</span>`;
    })
    .join("");
}

/** Dry-run only (planBuildingSpend never mutates state on its own) — по прямому запросу, только
 * столица (Коммунизм больше не расширяет доступ на сеть — у него отдельный, уже начисленный на
 * настоящий склад бонус, см. communismCapitalTypes/GameSession.grantCommunismResourceIncome). */
function canAffordBuilding(playerId: number, def: BuildingDef): boolean {
  const capital = capitalCityOf(playerId);
  if (!capital) return false;
  return !!planBuildingSpend(playerId, capital, def.costLines);
}

/** Зеркалит GameSession.RESEARCH_COST_LINES (private static, сервер, ТЗ 4.3) — цена исследования
 * технологии по эпохе, структурированно (не просто текст EPOCH_RESEARCH_COST), чтобы окно выбора
 * технологии («Учёный»/«Университет») могло подсветить каждую строку цены по отдельности. */
const RESEARCH_COST_LINES: Record<TechDef["epoch"], BuildingCostLine[]> = {
  1: [{ kind: "category", category: "food", count: 1 }],
  2: [
    { kind: "category", category: "food", count: 1 },
    { kind: "category", category: "strategic", count: 1 },
  ],
  3: [
    { kind: "category", category: "food", count: 1 },
    { kind: "category", category: "strategic", count: 1 },
    { kind: "category", category: "trade", count: 1 },
  ],
  4: [
    { kind: "category", category: "food", count: 1 },
    { kind: "category", category: "strategic", count: 2 },
    { kind: "category", category: "trade", count: 1 },
  ],
  5: [
    { kind: "category", category: "food", count: 1 },
    { kind: "category", category: "strategic", count: 2 },
    { kind: "anyOf", resources: ["hydrocarbons", "electricity"], count: 1 },
  ],
  6: [
    { kind: "category", category: "food", count: 1 },
    { kind: "specific", resource: "metalOre", count: 1 },
    { kind: "specific", resource: "rareEarth", count: 1 },
    { kind: "specific", resource: "uranium", count: 1 },
    { kind: "anyOf", resources: ["hydrocarbons", "electricity"], count: 1 },
  ],
};

/** Доступ для цены исследования — только столица, тем же принципом, что и у построек
 * (canAffordBuilding выше). [ИСПРАВЛЕНО, по прямому запросу] Раньше — со ВСЕХ городов игрока разом
 * (см. п.20/§21 ЦИВА-ЖУРНАЛ.md) — убрано вместе с остальной логикой «несколько городов
 * одновременно» по всей игре; зеркалит серверный GameSession.confirmResearch. */
function researchAccessSource(playerId: number): AccessSource[] {
  const capital = capitalCityOf(playerId);
  return capital ? [capital] : [];
}

/** Цена открытия технологии — построчно, каждая строка подсвечена зелёным (хватает) или красным (не
 * хватает) прямо сейчас — по прямому запросу «в окне технологий... стоимость открытия, не хватающие
 * ресурсы красным, хватающие зелёным». Строки проверяются НЕЗАВИСИМО друг от друга (не единым планом
 * на весь список сразу, как canAffordBuilding) — так видно, какого именно ресурса не хватает, а не
 * только «в целом не сходится»; в редком случае, когда две строки соперничают за один и тот же
 * последний экземпляр ресурса, обе могут показаться зелёными по отдельности, хотя вместе не сойдутся
 * — тот же класс приближения, что у ETA хода в computeUnitPath. */
function researchCostChipsHtml(playerId: number, epoch: TechDef["epoch"]): string {
  const source = researchAccessSource(playerId);
  return RESEARCH_COST_LINES[epoch]
    .map((line) => {
      const afford = !!planBuildingSpend(playerId, source, [line]);
      const color = afford ? "#3f8a53" : "#d4553f";
      let label: string;
      let title: string;
      if (line.kind === "specific") {
        const meta = RESOURCE_META.get(line.resource as ResourceId)!;
        label = `${meta.symbol}×${line.count}`;
        title = `${meta.label} ×${line.count}`;
      } else if (line.kind === "anyOf") {
        const labels = line.resources.map((r) => RESOURCE_META.get(r as ResourceId)?.symbol ?? r).join("/");
        label = `${labels}×${line.count}`;
        title = `Любой из: ${line.resources.map((r) => RESOURCE_META.get(r as ResourceId)?.label ?? r).join(", ")} ×${line.count}`;
      } else {
        const meta = RESOURCE_CATEGORY_META[line.category];
        label = `${meta.icon}×${line.count}`;
        title = `${line.count} разных ${line.category === "food" ? "пищевых" : line.category === "trade" ? "торговых" : "стратегических"}`;
      }
      return `<span class="bld-cost-ico" style="--rc:${color}" title="${title}${afford ? "" : " — не хватает"}">${label}</span>`;
    })
    .join("");
}

function renderBuildings() {
  const el = document.querySelector<HTMLDivElement>("#buildings-bar")!;
  const canBuild = phase === "playing" && pendingCardAction?.kind === "builder-select";
  // Бонус первооткрывателя «Архитектуры» (по прямому запросу) — карта «Строитель» с freeBuilding
  // строит здание без ресурсов и без действия; проверяется тем же способом, что isFree в
  // confirmResearch (см. cards.ts CardDef.freeBuilding).
  const freeCard = canBuild && !!hands[currentPlayerIndex]?.[(pendingCardAction as { slotIndex: number }).slotIndex]?.freeBuilding;

  // Same 4×4 square-grid language as the tech tree: columns are the 4 groups, rows the 4 buildings
  // in each. A building with 1 owner fills solid with their colour; with 2, a diagonal 2-colour
  // split (inline background-image beats the CSS class's single-colour rule).
  // 4 persistent states (always on, not just while a Строитель card is active): built by me
  // (green), open + affordable right now (yellow, shows price as icons), open + can't afford
  // (red, same icons), and not open at all — tech missing or both slots taken by others (empty,
  // no info in the cell at all, per explicit instruction).
  const cell = (b: (typeof BUILDINGS)[number]) => {
    const owners = ownersOf(buildingOwners, b.id);
    const taken = isTaken(buildingOwners, b.id); // both of the (up to 2) slots filled
    const mine = owners.includes(currentPlayerIndex);
    const usable = mine && !!BUILDING_USE_LABEL[b.id];
    const techOk = !b.tech || researchedTechs[currentPlayerIndex].has(b.tech);
    // "Available to me" survives a partially-taken building (1 of 2 slots free) as long as MY tech
    // is open and I don't already own it — only a fully-taken building (2/2, neither slot mine) or
    // a missing tech genuinely blocks me.
    const available = !mine && techOk && !taken;
    const affordable = available && (freeCard || canAffordBuilding(currentPlayerIndex, b));
    const state = mine
      ? "state-built"
      : available
        ? affordable
          ? "state-available"
          : "state-unaffordable"
        : owners.length > 0
          ? "" // taken by 1-2 others, not me — keeps the existing owner-fill look, no new border
          : "state-locked"; // tech not open yet — genuinely nothing to show
    const cls = [
      "bld",
      owners.length ? "taken" : "free",
      owners.length === 2 ? "split" : "",
      b.effect ? "" : "noeffect",
      b.victory && state !== "state-locked" ? "victory" : "",
      state,
      !taken && canBuild ? "buildable" : "",
      usable ? "usable" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const src = b.tech ? `${b.tech}, Э${b.epoch}` : "без исследования";
    // Баг-репорт «модалка пишет, что есть свободный слот, но зелёный всё равно не может построить» —
    // раньше ветка «здание частично занято другим игроком» перекрывала собой РЕАЛЬНУЮ причину отказа
    // (техника ещё не открыта / не хватает ресурсов) — свободный слот показывался как единственный
    // факт, хотя техника всё ещё блокировала постройку молча. Теперь ownership-факт — это ПРЕФИКС
    // (slotNote), а не отдельная взаимоисключающая ветка: тот же tech/afford-разбор ниже показывается
    // и когда здание никем не занято, и когда 1 из 2 слотов уже занят другим игроком.
    const slotNote = owners.length && !mine ? `Построил: ${PLAYERS[owners[0]].name} — свободен ещё ${MAX_BUILDING_OWNERS - owners.length} слот из ${MAX_BUILDING_OWNERS}. ` : "";
    const status = taken
      ? `Построили: ${owners.map((o) => PLAYERS[o].name).join(" и ")} — оба слота заняты, больше недоступно`
      : mine
        ? "Построено вами"
        : !techOk
          ? `${slotNote}Технология ещё не открыта`
          : !affordable
            ? `${slotNote}Технология открыта, но не набралось ресурсов прямо сейчас`
            : canBuild
              ? freeCard
                ? `${slotNote}Бесплатно (бонус «Архитектуры») — кликните, чтобы построить`
                : `${slotNote}Свободно — кликните, чтобы построить (спишется со столицы/склада/рынка)`
              : `${slotNote}Свободно — сыграйте карту «Строитель», чтобы построить`;
    const usedThisCycle = usable && !!b.produces && productionUsedThisCycle.has(`${b.id}:${currentPlayerIndex}`);
    const useLine = usable ? `\n🖱 Клик — ${BUILDING_USE_LABEL[b.id]}${usedThisCycle ? " (уже использовано в этом цикле)" : ""}` : "";
    const tip = `${b.name} (${src})\n${b.effect || "⚠ эффект не задан"}\nЦена: ${b.cost}\n${status}${useLine}`;
    const pcStyle =
      owners.length === 2
        ? `--pc: ${playerCss(owners[0])}; background-image: linear-gradient(135deg, ${playerCss(owners[0])} 50%, ${playerCss(owners[1])} 50%);`
        : `--pc: ${owners.length ? playerCss(owners[0]) : GROUP_META[b.group].color};`;
    const body = mine
      ? owners.map((o) => o + 1).join("+")
      : available
        ? costIconsHtml(b.costLines)
        : owners.length > 0
          ? owners.map((o) => o + 1).join("+") // fully taken by others — still worth showing who
          : ""; // locked — blank, no info at all
    return `<div class="${cls}" data-bld="${b.id}" style="${pcStyle}" title="${tip.replace(/"/g, "&quot;")}">${body}</div>`;
  };

  const rows = [0, 1, 2, 3];
  el.innerHTML = `
    <div class="tech-title">Городская застройка</div>
    <div class="bld-headers">
      ${GROUPS.map((g) => {
        const meta = GROUP_META[g];
        const taken = buildingsIn(g).filter((b) => isTaken(buildingOwners, b.id)).length;
        return `<div class="bld-header" style="--cat: ${meta.color}" title="${meta.label} — занято ${taken} из 4">${meta.icon}</div>`;
      }).join("")}
    </div>
    <div class="bld-rows">
      ${rows
        .map((i) => `<div class="bld-row">${GROUPS.map((g) => cell(buildingsIn(g)[i])).join("")}</div>`)
        .join("")}
    </div>
    <div class="bld-note">Здание доступно максимум 2 игрокам — у каждого свой экземпляр; когда оба слота заняты, остальным недоступно</div>
    ${renderBuildingUseMenuHtml()}
  `;
}

/** CSS-цвет игрока из его 0xRRGGBB. */
function playerCss(playerId: number): string {
  return "#" + PLAYERS[playerId].color.toString(16).padStart(6, "0");
}

/** Имя игрока, окрашенное в его цвет (по прямому запросу — «в упоминание игрока нужно помимо ника
 * добавлять цвет») — тот же приём (`style="color:#RRGGBB"`), что уже применяется к имени текущего
 * игрока в шапке (см. player-indicator) и к бейджу следующего жетона расстановки. */
function playerNameHtml(playerId: number): string {
  return `<span style="color:${playerCss(playerId)}">${PLAYERS[playerId].name}</span>`;
}

/** Building ids that do something once owned, beyond sitting on the grid — right now only Склад
 * (its own paid version of «Рабочий», see BUILDING_USE_LABEL/trySkladCollect). Extend this set
 * when another building's effect gets wired up the same way. */
const BUILDING_USE_LABEL: Partial<Record<string, string>> = {
  kazarma: "Построить юнит в любом своём городе — та же цена по эпохе и выбор категории, что у карты «Воин», только без карты. Без лимита цикла.",
  sklad: "Собрать регион на склад за деньги (1 💰 за единицу) — как «Рабочий», но без карты, доступно каждый цикл.",
  ges: "Активировать за 1 💰 — получить 1 Электричество. Не больше 1 раза за цикл.",
  aes: "Активировать за 1 💰 — получить 2 Электричества. Не больше 1 раза за цикл.",
  radiovyshka: "Активировать за 1 💰 (нужно 1 Электричество со склада) — получить 3 Контента. Не больше 1 раза за цикл.",
  fabrika: "Активировать за 1 💰 (нужно 1 Электричество со склада) — получить 3 Промтовара. Не больше 1 раза за цикл.",
  upravlenie: "Заплатить 5 💰 — +1 действие в этот ход. Не больше 1 раза за ход.",
  rynok: "Тот же доход, что у карты «Торговец» — выберите свой город, доход по всей его торговой сети. Требует 1 Углеводороды или 1 Электричество со склада, сверх действия. Без лимита цикла.",
  yadernyi_arsenal: "Заплатить 2 Уран + 1 Металл (без денег) — +1 ядерное оружие в запас. Без лимита цикла.",
  aeroport: "Перебросить своего юнита со столицы на любую клетку карты. Без денег, без лимита цикла.",
  hram: "Сжечь 1 карту из руки — доход +1💰 за каждый город любого игрока с той же религией (атеист/без религии — доход 0).",
  universitet: "Открыть технологию (как «Учёный») за 5 💰 сверху обычной цены исследования.",
  internet: "Заплатить 5 💰 и выбрать игрока — подтянуть свои технологии до его уровня во всех ветках, где он впереди.",
  kosmodrom: "Заплатить 1 Углеводороды + 2 Редкоземельные + 2 Металла + 1 Уран (без денег) — +1 компонент корабля в запас. Без лимита цикла. 3 компонента — 🏆 победа через космос.",
  oon: "Постройка даёт статус кандидата в Совет ООН (№1 или №2) и запускает голосование за генсека между двумя кандидатами (вес голоса = население, переизбрание каждые 5 циклов). Генеральный секретарь выносит резолюции (1 действие + 10💰 каждая) — принимаются при ≥60% голосов.",
};

/** Цена АКТИВАЦИИ уже построенного здания (не цена самой постройки, см. `costLines` в buildings.ts) —
 * по прямому запросу, для нового внутреннего меню использования зданий (см. `renderBuildingUseMenu`
 * ниже): `money` — деньги (плоское число, не структурировано как ресурсы), `resources` — тот же
 * формат `BuildingCostLine[]`, что и у цены постройки (переиспользует `costIconsHtml`), `note` —
 * произвольный текст для случаев, которые не сводятся к фиксированной цене (переменная по эпохе/
 * городу и т.п.). Действие (1, если не Парламентаризм — см. `buildingActionGate` на сервере)
 * показывается ОТДЕЛЬНО, одинаково для всех, а не через это поле. */
interface BuildingActivationCost {
  money?: number;
  resources?: BuildingCostLine[];
  note?: string;
}
const BUILDING_ACTIVATION_COST: Partial<Record<string, BuildingActivationCost>> = {
  kazarma: { note: "цена юнита по эпохе" },
  sklad: { note: "1💰 за каждую добытую единицу" },
  ges: { money: 1 },
  aes: { money: 1 },
  radiovyshka: { money: 1, resources: [{ kind: "specific", resource: "electricity", count: 1 }] },
  fabrika: { money: 1, resources: [{ kind: "specific", resource: "electricity", count: 1 }] },
  upravlenie: { money: 5 },
  rynok: { resources: [{ kind: "anyOf", resources: ["hydrocarbons", "electricity"], count: 1 }] },
  yadernyi_arsenal: {
    resources: [
      { kind: "specific", resource: "uranium", count: 2 },
      { kind: "specific", resource: "metalOre", count: 1 },
    ],
  },
  aeroport: { note: "бесплатно" },
  hram: { note: "сжечь 1 карту из руки" },
  universitet: { money: 5, note: "+ цена исследования" },
  internet: { money: 5 },
  kosmodrom: {
    resources: [
      { kind: "specific", resource: "hydrocarbons", count: 1 },
      { kind: "specific", resource: "rareEarth", count: 2 },
      { kind: "specific", resource: "metalOre", count: 2 },
      { kind: "specific", resource: "uranium", count: 1 },
    ],
  },
  oon: { money: 10, note: "за резолюцию (только у Генсека) — далее выбор типа резолюции из списка" },
  "yadernyi_arsenal:strike": { money: 2 },
};

/** Ресурсная часть цены активации — деньги + `costIconsHtml` + текстовая заметка, если задана.
 * Действие показывается отдельно (см. renderBuildingUseMenu) — этот текст только про
 * ресурсы/деньги. Ничего не задано вовсе — прочерк (не должно происходить для usable-зданий, но
 * не должно и падать, если кто-то забудет дополнить таблицу для нового здания). */
function buildingActivationCostHtml(key: string): string {
  const cost = BUILDING_ACTIVATION_COST[key];
  if (!cost) return "—";
  const parts: string[] = [];
  if (cost.money) parts.push(`<span class="bld-cost-ico" title="${cost.money} денег">${cost.money}💰</span>`);
  if (cost.resources?.length) parts.push(costIconsHtml(cost.resources));
  if (cost.note) parts.push(`<span class="bld-use-cost-note">${cost.note}</span>`);
  return parts.join(" ") || "—";
}

/** Один здание может нести НЕСКОЛЬКО независимых применимых эффектов с разной ценой (по прямому
 * запросу — живой баг-репорт: «постройка ещё одной бомбы есть, а удара той, что уже на складе,
 * нет как доступной операции») — «Ядерный арсенал» копит бомбу (`activateYadernyiArsenal`) И,
 * отдельно, стреляет уже накопленной (`launchNuclearStrike`, GameSession) — две совсем разные цены
 * и разный дальнейший поток (у удара — выбор ЦЕЛИ на карте, не общая building-use модалка). `key`
 * здесь — то же значение, что уходит в `data-bld-use`, у дополнительных эффектов отличается от id
 * здания (потому что цена/поведение свои), у основного всегда равен id. `onClick` для основного
 * эффекта не задаётся вовсе — по умолчанию ведёт в уже существующий `applyBuildingEffect(buildingId)`
 * (см. BUILDING_USE_EXTRA_ACTIONS ниже, где перечислены только ИСКЛЮЧЕНИЯ). Резолюция ООН (`oon`)
 * СОЗНАТЕЛЬНО не разбита на отдельные пункты по типам — по прямому уточнению («резолюции
 * перечислять не надо, просто само действие и его цену, а игрок выберет какую вынести из списка») —
 * список конкретных резолюций уже показывается ПОСЛЕ клика, внутри существующей building-use
 * модалки (см. её ветку `activeBuildingUse === "oon"`), этот пункт лишь ведёт туда. */
interface BuildingUseEntry {
  key: string;
  buildingId: string;
  label: string;
  description: string;
  disabled: boolean;
  disabledLabel?: string;
}
function buildingUseEntries(): BuildingUseEntry[] {
  const entries: BuildingUseEntry[] = [];
  for (const b of BUILDINGS) {
    if (!isOwnedBy(buildingOwners, b.id, currentPlayerIndex) || !BUILDING_USE_LABEL[b.id]) continue;
    const usedThisCycle = !!b.produces && productionUsedThisCycle.has(`${b.id}:${currentPlayerIndex}`);
    entries.push({ key: b.id, buildingId: b.id, label: b.name, description: b.effect || "", disabled: usedThisCycle, disabledLabel: usedThisCycle ? "Использовано" : undefined });
    if (b.id === "yadernyi_arsenal" && (nuclearWeapons[currentPlayerIndex] ?? 0) > 0) {
      entries.push({
        key: "yadernyi_arsenal:strike",
        buildingId: "yadernyi_arsenal",
        label: "Ядерный удар",
        description: "Нанести удар уже накопленной бомбой (в запасе: " + nuclearWeapons[currentPlayerIndex] + ") — цель: гекс на территории противника, с которым сейчас идёт война.",
        disabled: false,
      });
    }
  }
  return entries;
}

/** Клик по «Применить» для эффектов, которым НЕ подходит стандартный `applyBuildingEffect` (тот
 * ведёт в общую building-use модалку — годится для всего, что там уже реализовано, включая саму
 * постройку бомбы «Ядерного арсенала»). Удар — исключение: у него уже готов свой прямой поток
 * (`startNuclearTarget` — сразу режим выбора цели на карте, см. существующую кнопку «🚀 Нанести
 * удар» внутри той же building-use модалки), не нужно заново открывать модалку, чтобы тут же
 * закрыть её этим же кликом. */
const BUILDING_USE_EXTRA_ACTIONS: Partial<Record<string, () => void>> = {
  "yadernyi_arsenal:strike": () => startNuclearTarget(),
};

/** Внутреннее меню использования уже построенных зданий — по прямому запросу («в окне городская
 * застройка... внутреннее меню, из которого можно сразу сыграть эффект здания из списка доступных.
 * Слева название эффекта, наведение даёт описание. Посередине ресурсы за активацию, включая
 * действие (0 при парламентаризме), и сама кнопка применить»). Список — `buildingUseEntries()`
 * (обычно 1 строка на здание, у «Ядерного арсенала» — 2, см. её doc) вместо клика по иконке в сетке
 * + карточка building-detail; кнопка «Применить» ведёт либо в `BUILDING_USE_EXTRA_ACTIONS[key]`,
 * либо (по умолчанию) в тот же `applyBuildingEffect`, что и кнопка «Применить эффект» в
 * building-detail — все дальнейшие шаги (выбор юнита/города/технологии и т.п.) не дублируются, а
 * переиспользуются как есть. */
function renderBuildingUseMenuHtml(): string {
  const entries = buildingUseEntries();
  const actionCostLabel = playerParadigm[currentPlayerIndex] === "parliamentarism" ? "0 действий (Парламентаризм)" : "1 действие";
  if (!entries.length) {
    return `<div class="bld-use-menu"><div class="tech-title">Использовать здание</div><div class="bld-use-empty">Нет построенных зданий с применимым эффектом</div></div>`;
  }
  const rows = entries
    .map(
      (e) => `
        <div class="bld-use-row">
          <span class="bld-use-name" title="${e.description.replace(/"/g, "&quot;")}">${e.label}</span>
          <span class="bld-use-cost">${buildingActivationCostHtml(e.key)} <span class="bld-use-action">+ ${actionCostLabel}</span></span>
          <button class="bld-use-apply" data-bld-use="${e.key}" ${e.disabled ? "disabled" : ""}>${e.disabled ? e.disabledLabel : "Применить"}</button>
        </div>`
    )
    .join("");
  return `<div class="bld-use-menu"><div class="tech-title">Использовать здание</div><div class="bld-use-rows">${rows}</div></div>`;
}

/** Здания-производители (ГЭС/АЭС/Фабрика) — сработали ли уже в этом цикле. Ключ — `` `${id}:${playerId}` ``,
 * НЕ просто id здания: здание теперь может принадлежать до 2 разным игрокам (buildingOwners), и у
 * каждого свой независимый экземпляр — общий флаг на двоих заставил бы одного владельца случайно
 * блокировать активацию другому. Сбрасывается там же и тогда же, что accessUsed — начало нового цикла. */
const productionUsedThisCycle = new Set<string>();

/** Общая механика для зданий с производством (ГЭС/АЭС/Фабрика, BuildingDef.produces) — в отличие
 * от Склада, здесь не нужен выбор региона: платишь фиксированную 1 💰, тратишь 1 действие,
 * получаешь на склад-эквивалент (`buildingResources`) заранее известное количество. Ровно как
 * «производит N за цикл» и заявляет — не больше одного раза за цикл. */
async function activateProductionBuilding(buildingId: string) {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("activateProductionBuilding", { buildingId });
  if (!result.ok) setHint(result.hint ?? "Не удалось активировать здание.");
}

async function useUpravlenie() {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("useUpravlenie", {});
  if (!result.ok) setHint(result.hint ?? "Не удалось купить действие.");
}

/** Рынок — по прямому запросу тот же доход, что у карты «Торговец» (см. GameSession.useRynok),
 * только через здание: выбор своего города вместо цели карты. */
async function useRynok(cityId: number) {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("useRynok", { cityId });
  if (!result.ok) setHint(result.hint ?? "Не удалось провести торговлю.");
}

/** Ядерный арсенал — ресурсное производство без денег, без лимита цикла (ТЗ 4.4, схема 3). Само
 * применение ЯО намеренно не реализовано (см. GameSession.activateYadernyiArsenal). */
async function activateYadernyiArsenal() {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("activateYadernyiArsenal", {});
  if (!result.ok) setHint(result.hint ?? "Не удалось активировать Ядерный арсенал.");
}

async function activateKosmodrom() {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("activateKosmodrom", {});
  if (!result.ok) setHint(result.hint ?? "Не удалось активировать Космодром.");
}

/** Начинает/сбрасывает черновик резолюции (ТЗ §15.3) — открывает под-выбор параметров внутри той
 * же модалки «oon», тем же паттерном, что diplomacyPickMode у составителя дипломатии. */
function startOonCompose(type: OonResolutionType) {
  oonComposeType = type;
  oonComposeParams = {};
  renderModal();
}
function cancelOonCompose() {
  oonComposeType = null;
  oonComposeParams = {};
  renderModal();
}
async function submitOonResolution() {
  if (!oonComposeType) return;
  const result = await sendAction("proposeOonResolution", { resolutionType: oonComposeType, params: oonComposeParams });
  if (!result.ok) setHint(result.hint ?? "Не удалось вынести резолюцию.");
  else setHint(result.hint ?? "Резолюция вынесена.");
  oonComposeType = null;
  oonComposeParams = {};
  activeModal = null;
  activeBuildingUse = null;
  renderModal();
}

async function castOonVote(inFavor: boolean) {
  const result = await sendAction("voteOonResolution", { inFavor });
  if (!result.ok) setHint(result.hint ?? "Не удалось проголосовать.");
  activeModal = null;
  renderModal();
}

async function castOonSecretaryVote(candidateId: number) {
  const result = await sendAction("voteOonSecretaryGeneral", { candidateId });
  if (!result.ok) setHint(result.hint ?? "Не удалось проголосовать.");
  activeModal = null;
  renderModal();
}

function oonParamsReady(type: OonResolutionType, params: OonResolutionParams): boolean {
  switch (type) {
    case "worldLeader":
    case "sanctions":
      return params.targetPlayerId !== undefined;
    case "priceRegulation":
      return !!params.resource && params.price !== undefined;
    case "armsLimit":
      return params.limit !== undefined;
    case "aid":
      return params.targetPlayerId !== undefined && params.amount !== undefined;
    case "credit":
      return params.amount !== undefined;
    default:
      return true; // openTrade/banNuclear/neutralWaters/greenAgenda — без параметров
  }
}

/** Под-выбор параметров резолюции (ТЗ §15.3) — та же механика «клик добавляет значение, повторный
 * рендер модалки», что у diplomacyComposerSubPickerHtml. */
function oonResolutionParamsHtml(): string {
  if (!oonComposeType) return "";
  const back = `<button class="market-buy" data-oon-back style="background:#2f4a6b;border-color:#3f6a8a">← Назад к списку</button>`;
  let body = "";
  if (oonComposeType === "worldLeader" || oonComposeType === "sanctions" || oonComposeType === "aid") {
    body += `<div class="side-modal-section">${oonComposeType === "aid" ? "Получатель" : "Выберите игрока"}</div><div class="unit-pick-list">${PLAYERS.map(
      (p) => `
      <div class="unit-pick-row gov-row"><span class="unit-pick-name" style="color:${playerCss(p.id)}">${p.name}</span><button class="unit-pick-build" data-oon-target="${p.id}">${
        oonComposeParams.targetPlayerId === p.id ? "✓ Выбран" : "Выбрать"
      }</button></div>`
    ).join("")}</div>`;
  }
  if (oonComposeType === "priceRegulation") {
    body += `<div class="side-modal-section">Ресурс</div><div class="unit-pick-list">${RESOURCES.filter((r) => r.targetCount > 0)
      .map(
        (r) => `
      <div class="unit-pick-row gov-row"><span class="unit-pick-name">${r.symbol} ${r.label}</span><button class="unit-pick-build" data-oon-resource="${r.id}">${
          oonComposeParams.resource === r.id ? "✓ Выбран" : "Выбрать"
        }</button></div>`
      )
      .join("")}</div>
      <div class="side-modal-section">Цена</div><div class="choice-sell-row">${[1, 2, 3, 5, 8, 10]
        .map((p) => `<button class="choice-price" data-oon-price="${p}">${p}💰${oonComposeParams.price === p ? " ✓" : ""}</button>`)
        .join("")}</div>`;
  }
  if (oonComposeType === "armsLimit") {
    body += `<div class="side-modal-section">Лимит юнитов на игрока</div><div class="choice-sell-row">${[0, 2, 4, 6, 8, 10, 15, 20]
      .map((n) => `<button class="choice-price" data-oon-limit="${n}">${n}${oonComposeParams.limit === n ? " ✓" : ""}</button>`)
      .join("")}</div>`;
  }
  if (oonComposeType === "aid" || oonComposeType === "credit") {
    const amounts = oonComposeType === "credit" ? [1, 2, 3, 5] : [1, 2, 5, 10, 20];
    body += `<div class="side-modal-section">${oonComposeType === "credit" ? "Множитель к населению" : "Сумма с каждой страны"}</div><div class="choice-sell-row">${amounts
      .map((a) => `<button class="choice-price" data-oon-amount="${a}">${a}${oonComposeType === "credit" ? "×" : "💰"}${oonComposeParams.amount === a ? " ✓" : ""}</button>`)
      .join("")}</div>`;
  }
  const ready = oonParamsReady(oonComposeType, oonComposeParams);
  body += `<div class="choice-sell-row" style="margin-top:10px">${back}<button class="side-modal-action" id="oon-submit" ${ready ? "" : "disabled"}>Вынести на голосование (1 действие + 10💰)</button></div>`;
  return body;
}

/** Список уже принятых, всё ещё действующих резолюций (ТЗ §15.3) — показывается в модалке «oon»
 * всем игрокам, не только генсеку, чтобы было видно текущие правила мира. */
function activeOonResolutionsSummary(): string[] {
  const lines: string[] = [];
  if (oonOpenTradeActive) lines.push("🟢 Открытая торговля — все торговые пути доступны всем.");
  if (oonNuclearBanActive) lines.push("🟢 Запрет ядерного оружия — новое ЯО производить нельзя.");
  if (oonNeutralWatersActive) lines.push("🟢 Нейтральные воды — море открыто всем, кроме входа в чужие города.");
  if (oonSanctionedPlayerId !== null) lines.push(`🟢 Санкции — с ${PLAYERS[oonSanctionedPlayerId].name} запрещена любая дипломатия.`);
  if (oonGreenAgendaActive) lines.push("🟢 Зелёная повестка — посадка леса удвоена.");
  if (oonPriceRegulation) lines.push(`🟢 Регуляция цен — ${RESOURCE_META.get(oonPriceRegulation.resource)!.label} фиксирован по ${oonPriceRegulation.price}💰.`);
  if (oonArmsLimit !== null) lines.push(`🟢 Сдерживание вооружений — лимит ${oonArmsLimit} юнитов на игрока.`);
  return lines;
}

function oonResolutionParamsSummary(res: PendingOonResolution): string {
  switch (res.type) {
    case "worldLeader":
      return ` — кандидат: ${PLAYERS[res.params.targetPlayerId!].name}.`;
    case "sanctions":
      return ` — цель: ${PLAYERS[res.params.targetPlayerId!].name}.`;
    case "priceRegulation":
      return ` — ${RESOURCE_META.get(res.params.resource!)!.label}: ${res.params.price}💰.`;
    case "armsLimit":
      return ` — лимит ${res.params.limit} юнитов на игрока.`;
    case "aid":
      return ` — по ${res.params.amount}💰 с каждой страны игроку ${PLAYERS[res.params.targetPlayerId!].name}.`;
    case "credit":
      return ` — эмиссия ×${res.params.amount} к населению каждой страны.`;
    default:
      return ".";
  }
}

/** Аэропорт — первый шаг (выбор юнита) закрывает модалку и вооружает pendingCardAction ожиданием
 * клика по ЛЮБОМУ гексу карты (не по региону/городу, см. pointerdown-обработчик ниже). */
function startAeroportPick(unitId: number) {
  activeModal = null;
  activeBuildingUse = null;
  pendingCardAction = { kind: "aeroport-target", unitId };
  renderModal();
  updateHint();
}
async function tryAeroportTarget(col: number, row: number) {
  if (!pendingCardAction || pendingCardAction.kind !== "aeroport-target") return;
  const { unitId } = pendingCardAction;
  pendingCardAction = null;
  const result = await sendAction("useAeroport", { unitId, col, row });
  if (!result.ok) setHint(result.hint ?? "Не удалось перебросить юнита.");
}

/** Ядерный арсенал, применение ЯО (по прямому запросу) — та же схема, что у Аэропорта: закрыть
 * модалку, вооружить прицел по любому гексу карты. */
function startNuclearTarget() {
  activeModal = null;
  activeBuildingUse = null;
  pendingCardAction = { kind: "nuclear-target" };
  renderModal();
  updateHint();
}
async function tryNuclearTarget(col: number, row: number) {
  if (!pendingCardAction || pendingCardAction.kind !== "nuclear-target") return;
  pendingCardAction = null;
  const result = await sendAction("launchNuclearStrike", { col, row });
  if (!result.ok) setHint(result.hint ?? "Не удалось нанести ядерный удар.");
  else if (result.hint) setHint(result.hint);
  if (result.nuclearStrike) playNuclearStrikeAnimation(result.nuclearStrike);
}

/** Добор карты с колоды за 1 действие (по прямому запросу — «на случай когда уже нет карт на руке а
 * действия ещё есть», клик по колоде) — сама доступность (рука пуста, есть действие) уже проверена
 * снаружи (`canDrawFromDeck` в renderBottomBar) для визуального признака, но сервер
 * (`GameSession.drawCardFromDeck`) — единственный источник правды, перепроверяет то же самое.
 * Колода закончилась — отдельный явный hint (по прямому запросу — «подсказку в окно подсказок»),
 * тот же путь `setHint`, что и у любого другого отказа действия. */
async function drawCardFromDeck() {
  const result = await sendAction("drawCardFromDeck", {});
  if (!result.ok) setHint(result.hint ?? "Не удалось взять карту с колоды.");
  else if (result.hint) setHint(result.hint);
}

/** Храм — сжигает 1 карту руки, платит за единоверные города (ТЗ 4.4/4.5, схема 5). */
async function useHram(slotIndex: number) {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("useHram", { slotIndex });
  if (!result.ok) setHint(result.hint ?? "Не удалось активировать Храм.");
}

/** Университет — то же открытие технологии, что и «Учёный», плюс доплата 5💰 (ТЗ 4.4, схема 4). */
async function useUniversitet(techId: string) {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("useUniversitet", { techId });
  if (!result.ok) setHint(result.hint ?? "Не удалось открыть технологию.");
  // Бонус первооткрывателя (напр. «Конвейер» — +3 Промтовара) — отдельным окном, по прямому запросу
  // («оповести его о получении отдельным окном и свойстве этого ресурса»), тем же приёмом, что уже
  // применяется для предупреждения о смене религии при Коммунизме (window.confirm).
  else if (result.hint) window.alert(result.hint);
}

/** Интернет — подтянуть свои технологии до уровня выбранного игрока (ТЗ 4.4, схема 4). */
async function useInternet(targetPlayerId: number) {
  activeModal = null;
  activeBuildingUse = null;
  const result = await sendAction("useInternet", { targetPlayerId });
  if (!result.ok) setHint(result.hint ?? "Не удалось активировать Интернет.");
}

/** [ИСПРАВЛЕНО, по прямому запросу] Любой клик по зданию в панели застройки — построено оно или
 * нет — теперь сначала открывает карточку (building-detail): полное описание, цена, и одна кнопка
 * «Построить»/«Применить эффект» в зависимости от владения. Раньше клик по СВОЕМУ зданию без
 * функции не делал вообще ничего, а клик по СВОБОДНОМУ зданию с активной картой «Строитель» строил
 * его мгновенно, без подтверждения. */
function onBuildingClick(id: string) {
  if (phase !== "playing") return;
  buildingDetailId = id;
  activeModal = "building-detail";
  renderModal();
}

/** Применить эффект уже построенного здания — передаёт управление уже существующему потоку
 * building-use (второй шаг, если у здания есть что выбрать — юнит/город/регион/технология — или
 * сразу нужная кнопка для простых «производит N за цикл» зданий); building-detail был для таких
 * зданий только промежуточной карточкой с описанием. */
function applyBuildingEffect(id: string) {
  activeModal = "building-use";
  activeBuildingUse = id;
  renderModal();
}

/** Построить свободное здание — то же условие, что было раньше прямо в onBuildingClick (нужна
 * активная карта «Строитель», ТЗ 3.1.5), просто теперь запускается кнопкой «Построить» в карточке
 * building-detail, а не первым же кликом по клетке. */
async function tryBuildBuilding(id: string) {
  if (!pendingCardAction || pendingCardAction.kind !== "builder-select") {
    setHint('Чтобы построить здание, сначала сыграйте карту «Строитель».');
    return;
  }
  const slotIndex = pendingCardAction.slotIndex;
  // Бонус первооткрывателя «Архитектуры» — см. cards.ts CardDef.freeBuilding, тем же приёмом, что
  // isFree в confirmResearch.
  const isFree = !!hands[currentPlayerIndex]?.[slotIndex]?.freeBuilding;
  pendingCardAction = null;
  activeModal = null;
  buildingDetailId = null;
  const result = await sendAction(isFree ? "playFreeBuildingCard" : "buildBuilding", { slotIndex, buildingId: id });
  if (!result.ok) setHint(result.hint ?? "Не удалось построить здание.");
  else if (result.hint) setHint(result.hint);
}

// --- Right rail: money card, city list, warehouse, market/diplomacy/government buttons ---
// (ТЗ 11.5). City resources are real (read off the actual generated map for that city's region);
// everything downstream of "collect it to a warehouse" isn't implemented yet — no per-city storage,
// no income, no card-effect resource checks — so those parts stay honest placeholders/read-only
// reference panels rather than fabricated numbers.

const RESOURCE_META = new Map(RESOURCES.map((r) => [r.id, r]));
const MAX_CITIES = 8;

/** Чужой юнит, с чьим владельцем идёт война, физически блокирует добычу ресурса на СВОЕЙ клетке
 * (по прямому запросу) — не всего региона, только этой конкретной клетки. */
function resourceTileBlocked(col: number, row: number, ownerId: number): boolean {
  return units.some((u) => u.col === col && u.row === row && u.playerId !== ownerId && relationOf(u.playerId, ownerId).war);
}

/** Сколько РАЗНЫХ типов ресурса этот город уже отработал через доступ в текущем цикле —
 * `accessUsed` хранит по одной записи `cityId:resource` на тип, не на количество. */
function accessTypesUsedThisCycle(cityId: number): number {
  let count = 0;
  for (const key of accessUsed) if (key.startsWith(`${cityId}:`)) count++;
  return count;
}

/** `blockedForPlayerId`, если передан, отфильтровывает клетки, заблокированные вражеским юнитом
 * (см. resourceTileBlocked). `capToCity`, если передан, ограничивает число ВОЗВРАЩАЕМЫХ типов
 * ресурса населением этого города (по прямому запросу — «город не может добывать ресурсов больше
 * чем его население»): уже отработанные в этом цикле типы не занимают лимит заново, лимит бьёт
 * только по ЕЩЁ не тронутым. Оба параметра — только для вызовов, реально СПИСЫВАЮЩИХ доступ;
 * чисто отображательные (список городов) оставляют ресурс видимым независимо ни от того, ни от
 * другого. */
function resourcesInRegion(rc: number, rr: number, blockedForPlayerId?: number, capToCity?: City): ResourceId[] {
  const tiles: ResourceId[] = [];
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      const col = rc * REGION_SIZE_X + dx;
      const row = rr * REGION_SIZE_Y + dy;
      const tile = doc.get(col, row);
      const r = tile.resource;
      if (!r) continue;
      if (blockedForPlayerId !== undefined) {
        if (resourceTileBlocked(col, row, blockedForPlayerId)) continue;
      }
      tiles.push(r);
    }
  }
  if (!capToCity) return tiles;
  // Лимит бьёт по РАЗНЫМ типам, не по клеткам — два тайла одного ресурса в регионе не должны
  // съедать лимит дважды, только когда встречается действительно новый тип.
  let budget = Math.max(0, capToCity.population - accessTypesUsedThisCycle(capToCity.id));
  const allowedNewTypes = new Set<ResourceId>();
  const out: ResourceId[] = [];
  for (const r of tiles) {
    if (accessUsed.has(`${capToCity.id}:${r}`) || allowedNewTypes.has(r)) {
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

/** Not every resource a region holds is extractable from turn 1 — per `Технологии.md`: land food
 * ("добыча пищи на земле доступна по умолчанию, без технологии") and land trade goods need
 * nothing, but **Мореплавание** ("открывает добычу морских ресурсов" — `requiresWater` resources:
 * рыба/крабы/киты) and **Горное дело** ("открывает добычу ископаемых" — every strategic resource)
 * gate their categories until researched. Only gates the ACCESS pool (a city's own region) — a
 * warehouse/market resource is already someone's extracted goods, buying it needs no tech of your
 * own. */
function resourceIsExtractable(playerId: number, id: ResourceId): boolean {
  const meta = RESOURCE_META.get(id)!;
  if (meta.category === "strategic") return researchedTechs[playerId].has("Горное дело");
  if (meta.requiresWater) return researchedTechs[playerId].has("Мореплавание");
  return true;
}

// --- Поселенец: город/регион helpers + spend-order (access → склад → рынок) ---------------------

/** A city's own region resources are "always available" (ТЗ 7.2/11.3) — spent first, before the
 * warehouse. Tracked per (city, resource TYPE), not per physical unit: if a region ever holds two
 * of the same type (rare — only allowed for food/trade as a last resort, see resourceGenerator.ts)
 * this treats them as one poolable type rather than two separate units. Reset at the start of every
 * cycle (see onPlayingEndTurn) — "восполняются, но не накапливаются" (ТЗ 7.2). */
const accessUsed = new Set<string>();

function cityAtRegion(rc: number, rr: number): City | undefined {
  return cities.find((c) => c.regionCol === rc && c.regionRow === rr);
}
function capitalCityOf(playerId: number): City | undefined {
  return cities.find((c) => c.playerId === playerId && c.isCapital);
}

interface SpendPlanItem {
  resource: ResourceId;
  source: "access" | "warehouse" | "market";
  cityId?: number;
  listingId?: number;
}

/** Зеркалит GameSession.communismCapitalTypes — только для превью (лимит склада/подсветка «хватает»),
 * реальное начисление всё равно на сервере (grantCommunismResourceIncome, раз за цикл). Добываемые
 * типы региона столицы, плюс (по прямому запросу — «дополнительно к столице выбирается город»)
 * региона отдельно выбранного второго города, если он выбран — по ним Коммунист получает по 1
 * настоящей единице на склад каждый цикл. */
function communismCapitalTypes(playerId: number): ResourceId[] {
  if (playerParadigm[playerId] !== "communism") return [];
  const capital = capitalCityOf(playerId);
  if (!capital) return [];
  const sources = [capital];
  const extraCityId = communismExtraCityId[playerId];
  if (extraCityId !== undefined) {
    const extra = cities.find((c) => c.id === extraCityId && c.playerId === playerId);
    if (extra) sources.push(extra);
  }
  const types = new Set<ResourceId>();
  for (const city of sources) for (const r of resourcesInRegion(city.regionCol, city.regionRow, playerId)) types.add(r);
  return [...types].filter((r) => resourceIsExtractable(playerId, r));
}
/** Зеркалит GameSession.communismProtectedQty — сколько единиц этого типа на складе сейчас защищены
 * от продажи (пришли от бонуса Коммунизма, не от своей добычи/покупки), только для подсветки кнопки
 * «Продать» — реальный запрет всё равно на сервере (sellResource). */
function communismProtectedQty(playerId: number, resource: ResourceId): number {
  return Math.min(communismBonusHeld[playerId]?.[resource] ?? 0, warehouse[playerId]?.[resource] ?? 0);
}

/** Access is scoped to ONE city — its own region only. A build in city A never draws on food
 * sitting unused in city B; "доступность ресурсов нужна не в целом по государству, а в городе
 * строительства" — only the warehouse is genuinely shared across the player's whole state, stacked
 * on top of that one city's own access. `id` may be a not-yet-created city's future id (founding a
 * new settlement spends from the target region before the City object exists — see tryFoundCity). */
interface AccessSource {
  id: number;
  regionCol: number;
  regionRow: number;
}

/** One cost line, e.g. "1 Металл" or "1 Еда" — `match` decides which resource ids satisfy it
 * (a specific id, or a whole category). Unlike Поселенец's
 * growth cost, Воин's slots are never required to differ from each other, so no `requireDistinct`
 * flag here. */
interface ResourceReq {
  label: string;
  match: (id: ResourceId) => boolean;
}
const reqCategory = (label: string, category: "food" | "trade" | "strategic"): ResourceReq => ({
  label,
  match: (r) => RESOURCE_META.get(r)!.category === category,
});
const reqSpecific = (label: string, id: ResourceId): ResourceReq => ({ label, match: (r) => r === id });

/** ТЗ 7.1 — unit cost by epoch (not per-unit; every unit of that epoch costs the same). Quantities
 * aren't specified in ТЗ beyond "this resource type", so each line defaults to 1 — same gap-filling
 * approach used for building/research costs earlier this session. */
const EPOCH_UNIT_COST: Record<TechDef["epoch"], { money: number; resources: ResourceReq[] }> = {
  1: { money: 0, resources: [reqCategory("Еда", "food")] },
  2: { money: 0, resources: [reqCategory("Еда", "food"), reqSpecific("Металл", "metalOre")] },
  3: { money: 0, resources: [reqSpecific("Металл", "metalOre"), reqCategory("Торговый", "trade")] },
  4: { money: 2, resources: [reqSpecific("Металл", "metalOre"), reqSpecific("Углеводороды", "hydrocarbons")] },
  5: { money: 1, resources: [reqSpecific("Металл", "metalOre"), reqSpecific("Углеводороды", "hydrocarbons")] },
  6: {
    money: 1,
    resources: [reqSpecific("Металл", "metalOre"), reqSpecific("Углеводороды", "hydrocarbons"), reqSpecific("Редкоземельные", "rareEarth")],
  },
};

/** «Деревянные» корабли (Галера Э1, Каравелла Э2, Фрегат Э3 — до стали, Линкор с Э4 уже металл) —
 * по прямому запросу «для деревянных кораблей 1 металл замени на лес»: тот же состав цены эпохи,
 * только Металл → Лес. Зеркалит GameSession.WOODEN_SHIP_RESOURCE_COST — эта копия только рисует
 * подсказку в попапе постройки юнита (сама цена реально списывается сервером, см. buildUnitCard).
 * Раньше эта подсказка не знала о категории юнита вовсе и всегда показывала Металл даже кораблям —
 * отсюда и баг «Каравелла просит металл вместо дерева». Галера (Э1) была просто 1 едой — по прямому
 * уточнению теперь тоже 1 Лес (полностью заменяет еду, не добавляется к ней). */
const WOODEN_SHIP_RESOURCE_COST: Partial<Record<TechDef["epoch"], ResourceReq[]>> = {
  1: [reqSpecific("Лес", "wood")],
  2: [reqCategory("Еда", "food"), reqSpecific("Лес", "wood")],
  3: [reqSpecific("Лес", "wood"), reqCategory("Торговый", "trade")],
};
/** Дальняя атака Э1/Э2 (Катапульта/Требушет) — по прямому уточнению «по аналогии с кораблями», тот же
 * паттерн замены на Лес, что и у деревянных кораблей выше. Зеркалит
 * GameSession.WOODEN_RANGED_RESOURCE_COST, только для подсказки цены. */
const WOODEN_RANGED_RESOURCE_COST: Partial<Record<TechDef["epoch"], ResourceReq[]>> = {
  1: [reqSpecific("Лес", "wood")],
  2: [reqCategory("Еда", "food"), reqSpecific("Лес", "wood")],
};
function unitCostLabel(epoch: TechDef["epoch"], category: UnitCategory): string {
  const c = EPOCH_UNIT_COST[epoch];
  const woodenOverride = category === "ship" ? WOODEN_SHIP_RESOURCE_COST[epoch] : category === "ranged" ? WOODEN_RANGED_RESOURCE_COST[epoch] : undefined;
  const resources = woodenOverride ?? c.resources;
  const parts = resources.map((r) => `1 ${r.label}`);
  if (c.money) parts.push(`${c.money} 💰`);
  return parts.join(" + ");
}

/** Строитель's price model — a building's cost is a short list of lines (see buildings.ts): either
 * N units of one exact resource, or N *different* types within a category. Same access → склад →
 * рынок order and same city-scoping as everything else (ТЗ 3.1.4) — access is the capital's region
 * specifically ("построить здание в столице"), never pooled across the player's other cities.
 * `source` stays an array-capable type only so callers don't need touching — по прямому запросу
 * («убери логику, где ресурсы берутся с нескольких городов одновременно») ни один вызывающий больше
 * не передаёт больше одного города; Коммунизм теперь даёт другой бонус (см. communismCapitalTypes/
 * GameSession.grantCommunismResourceIncome) вместо доступа ко всей торговой сети — он начисляется
 * прямо на настоящий склад, так что здесь ничего отдельно учитывать не нужно. */
function planBuildingSpend(playerId: number, source: AccessSource | AccessSource[], lines: BuildingCostLine[]): SpendPlanItem[] | null {
  const plan: SpendPlanItem[] = [];
  let moneyBudget = money[playerId];
  const sources = Array.isArray(source) ? source : [source];

  const accessCandidates: { resource: ResourceId; cityId: number }[] = [];
  for (const src of sources) {
    for (const r of new Set(resourcesInRegion(src.regionCol, src.regionRow, playerId, cities.find((c) => c.id === src.id)))) {
      if (!resourceIsExtractable(playerId, r)) continue;
      if (accessUsed.has(`${src.id}:${r}`)) continue;
      accessCandidates.push({ resource: r, cityId: src.id });
    }
  }
  const warehouseCandidates: ResourceId[] = [];
  for (const [id, qty] of Object.entries(warehouse[playerId] ?? {}) as [ResourceId, number][]) {
    for (let i = 0; i < qty; i++) warehouseCandidates.push(id);
  }
  const marketCandidates = market.filter((l): l is ResourceListing => l.kind === "resource" && l.sellerId !== playerId).sort((a, b) => a.price - b.price);

  const pickOne = (match: (id: ResourceId) => boolean): boolean => {
    const aIdx = accessCandidates.findIndex((a) => match(a.resource));
    if (aIdx >= 0) {
      const a = accessCandidates.splice(aIdx, 1)[0];
      plan.push({ resource: a.resource, source: "access", cityId: a.cityId });
      return true;
    }
    const wIdx = warehouseCandidates.findIndex((r) => match(r));
    if (wIdx >= 0) {
      const r = warehouseCandidates.splice(wIdx, 1)[0];
      plan.push({ resource: r, source: "warehouse" });
      return true;
    }
    const mIdx = marketCandidates.findIndex((l) => match(l.resource) && l.price <= moneyBudget);
    if (mIdx >= 0) {
      const l = marketCandidates.splice(mIdx, 1)[0];
      moneyBudget -= l.price;
      plan.push({ resource: l.resource, source: "market", listingId: l.id });
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
      // «Эквивалентны друг другу» (по прямому запросу) — зеркалит GameSession.planBuildingSpend.
      for (let i = 0; i < line.count; i++) {
        if (!pickOne((r) => (line.resources as ResourceId[]).includes(r))) return null;
      }
    } else {
      const chosen = new Set<ResourceId>();
      for (let i = 0; i < line.count; i++) {
        if (!pickOne((r) => RESOURCE_META.get(r)!.category === line.category && !chosen.has(r))) return null;
        chosen.add(plan[plan.length - 1].resource);
      }
    }
  }
  return plan;
}

function renderMoneyCard() {
  const el = document.querySelector<HTMLDivElement>("#money-card");
  if (!el) return; // only exists in the playing-phase bottom bar markup
  el.innerHTML = `<div class="money-label">Деньги</div><div class="money-amount">${money[currentPlayerIndex]}</div>`;
}

function renderCityList() {
  const el = document.querySelector<HTMLDivElement>("#city-list");
  if (!el) return;
  const player = PLAYERS[currentPlayerIndex];
  const myCities = cities.filter((c) => c.playerId === player.id);
  const targetKinds = [
    "settler-grow",
    "warrior-city",
    "warrior-money-city",
    "worker-city",
    "sklad-collect",
    "trader-city",
    "routeRight-city",
    "builder-mine",
    "kazarma-city",
  ];
  const growPending =
    pendingRouteIsMine() || !!pendingRouteRedirect || !!pendingTradeRouteNew || !!pendingTradeRouteDelete || pendingCommunismCityPick || (!!pendingCardAction && targetKinds.includes(pendingCardAction.kind));

  const slot = (city: City | undefined, index: number) => {
    if (!city) return `<div class="city-slot empty">${index + 1}</div>`;
    const icons = resourcesInRegion(city.regionCol, city.regionRow)
      .map((id) => {
        const meta = RESOURCE_META.get(id)!;
        const locked = !resourceIsExtractable(city.playerId, id);
        const used = !locked && accessUsed.has(`${city.id}:${id}`);
        const cls = locked ? " locked" : used ? " used" : "";
        const note = locked ? " — нет технологии добычи (Мореплавание/Горное дело)" : used ? " — уже использован в этом цикле" : "";
        return `<span class="res-ico${cls}" style="--rc:#${meta.color.toString(16).padStart(6, "0")}" title="${meta.label}${note}">${locked ? "🔒" : meta.symbol}</span>`;
      })
      .join("");
    const cls = "city-slot filled" + (growPending ? " growable" : "");
    return `<div class="${cls}" data-city-id="${city.id}" title="Регион ${city.regionCol + 1}.${city.regionRow + 1}">
      <div class="city-name">Город ${index + 1} <span class="city-pop">👥${city.population}</span></div>
      <div class="city-resources">${icons}</div>
    </div>`;
  };

  el.innerHTML = `
    <div class="tech-title">Города (${myCities.length}/${MAX_CITIES})</div>
    <div class="city-slots-wrap">
      ${Array.from({ length: MAX_CITIES }, (_, i) => slot(myCities[i], i)).join("")}
    </div>
  `;
}

const WAREHOUSE_CAP = 6;
const WAREHOUSE_CAP_WITH_SKLAD = 12;
/** Зеркалит приватный `GameSession.playerEpoch` — максимальная эпоха среди исследованных технологий
 * игрока, минимум 1. Нужен только для отображения (обмен Драгоценных металлов на деньги, см.
 * renderWarehouse) — реальный расчёт при самом обмене всё равно делает сервер. */
function playerEpochOf(playerId: number): TechDef["epoch"] {
  let max: TechDef["epoch"] = 1;
  for (const techId of researchedTechs[playerId] ?? []) {
    const t = TECH_TREE.find((x) => x.id === techId);
    if (t && t.epoch > max) max = t.epoch;
  }
  return max;
}

function renderWarehouse() {
  const el = document.querySelector<HTMLDivElement>("#warehouse-panel");
  if (!el) return;
  const stock = Object.entries(warehouse[currentPlayerIndex] ?? {}).filter(([, qty]) => (qty ?? 0) > 0) as [ResourceId, number][];
  const bldStock = Object.entries(buildingResources[currentPlayerIndex] ?? {}).filter(([, qty]) => (qty ?? 0) > 0) as [BuildingResourceId, number][];
  // Only real map ResourceId stock is sellable (ТЗ: «ресурсы со склада») — building-only
  // Электричество/Промтовары/Контент aren't map resources and stay out of this, same distinction
  // `warehouse` vs `buildingResources` keeps everywhere else this session.
  // Кнопка продажи прямо на ресурсе склада (ТЗ 11.5 — редизайн «одно окно»), всегда кликабельна,
  // а не только в особом режиме — ведёт сразу к выбору цены (см. startSellResource). Коммунизм —
  // единицы, начисленные бонусом парадигмы, продавать нельзя (см. communismProtectedQty/
  // GameSession.sellResource) — кнопка гаснет, только когда ВЕСЬ остаток типа защищён.
  const chip = (color: number, label: string, symbol: string, qty: number, resourceAttr?: ResourceId) => {
    const protectedQty = resourceAttr ? communismProtectedQty(currentPlayerIndex, resourceAttr) : 0;
    const allProtected = !!resourceAttr && protectedQty >= qty;
    // Драгоценные металлы (по прямому запросу) — не на биржу, а напрямую в деньги (по эпохе игрока),
    // отдельная кнопка/подсказка и отдельный обработчик клика (см. cashInPreciousMetals ниже).
    const isPreciousMetals = resourceAttr === "preciousMetals";
    const sellBtn = resourceAttr
      ? allProtected
        ? `<button class="res-sell-btn" disabled title="Все ${qty} ед. — от бонуса Коммунизма, ${isPreciousMetals ? "не обмениваются" : "на бирже не продаются"}">💲</button>`
        : isPreciousMetals
          ? `<button class="res-sell-btn" data-resource="${resourceAttr}" title="Обменять 1 ${label} на ${playerEpochOf(currentPlayerIndex)}💰 напрямую (не через биржу)${protectedQty > 0 ? ` (${protectedQty} ед. защищены Коммунизмом — не обмениваются)` : ""}">💲</button>`
          : `<button class="res-sell-btn" data-resource="${resourceAttr}" title="Продать 1 ${label}${protectedQty > 0 ? ` (${protectedQty} ед. защищены Коммунизмом — не продаются)` : ""}">💲</button>`
      : "";
    return `
    <span class="res-ico" style="--rc:#${color.toString(16).padStart(6, "0")}" title="${label}">
      ${symbol} ×${qty}${sellBtn}
    </span>`;
  };
  // Зеркалит GameSession.warehouseCapFor — только для отображения «X из Y», сам лимит проверяет и
  // правда применяет сервер (endTurn/needsWarehouseTrim). Коммунизм добавляет число добываемых типов
  // региона столицы (communismCapitalTypes) — «ресурсы 1 города постоянно на складе сверх лимита».
  const cap = (isOwnedBy(buildingOwners, "sklad", currentPlayerIndex) ? WAREHOUSE_CAP_WITH_SKLAD : WAREHOUSE_CAP) + communismCapitalTypes(currentPlayerIndex).length;
  const total = stock.reduce((sum, [, qty]) => sum + qty, 0);
  el.innerHTML = `
    <div class="tech-title">Склад <span class="warehouse-fill${total > cap ? " over" : ""}">${total} из ${cap}</span></div>
    ${
      stock.length || bldStock.length
        ? `<div class="city-resources warehouse-stock">${[
            ...stock.map(([id, qty]) => {
              const meta = RESOURCE_META.get(id)!;
              return chip(meta.color, meta.label, meta.symbol, qty, id);
            }),
            ...bldStock.map(([id, qty]) => {
              const meta = BUILDING_RESOURCE_META[id];
              return chip(meta.color, meta.label, meta.symbol, qty);
            }),
          ].join("")}</div>`
        : `<div class="warehouse-empty">Пусто. Пополняется добычей («Рабочий»/Склад), покупкой на рынке или активацией зданий-производителей (ГЭС/АЭС/Фабрика).</div>`
    }
  `;
}

function switchRightPanelView(view: RightPanelView) {
  rightPanelView = view;
  renderActionButtons();
}

function renderActionButtons() {
  const el = document.querySelector<HTMLDivElement>("#action-buttons");
  if (!el) return;
  const tab = (view: RightPanelView, label: string) =>
    `<button class="side-btn${rightPanelView === view ? " active" : ""}" data-view="${view}">${label}</button>`;
  el.innerHTML = `
    ${tab("resources", "Ресурсы")}
    ${tab("market", `Купить${market.length ? ` (${market.length})` : ""}`)}
    ${tab("diplomacy", "Дипломатия")}
    ${tab("government", "Гос. управление")}
  `;
  el.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => switchRightPanelView(btn.dataset.view as RightPanelView))
  );
  renderRightPanelExtra();
}

// --- Side modal: market listing + read-only diplomacy/government reference lists ---

type ModalKind =
  | "victory"
  | "elimination"
  | "discard-confirm"
  | "warehouse-trim"
  | "warrior-unit"
  | "building-detail"
  | "building-use"
  | "scientist-pick"
  | "scientist-endgame-pick"
  | "tax-shortfall"
  | "catastrophe-choice"
  | "sell-price"
  | "proposal-review"
  | "proposal-compose"
  | "handoff-pick"
  | "resource-choice"
  | "city-detail"
  | "unit-pick"
  | "trader-compose"
  | "oon-vote"
  | "oon-secretary-vote"
  | "skip-turn"
  | "gene-grow-pick"
  | "worker-mine-pick"
  | null;
/** Одно окно (ТЗ 11.4/11.5 редизайн) — верхние кнопки переключают, что показано справа от карты,
 * вместо отдельных модалок «Рынок»/«Дипломатия»/«Гос. управление». */
type RightPanelView = "resources" | "market" | "diplomacy" | "government";
let rightPanelView: RightPanelView = "resources";
/** Which owned building's dialog is open (только «sklad» имеет реальную функцию сейчас). */
let activeBuildingUse: string | null = null;
/** Здание, чья карточка (полное описание + цена + «Построить»/«Применить эффект») сейчас открыта —
 * по прямому запросу «при щелчке по зданию... открывай окно с полным описанием, перечнем ресурсов и
 * выбором построить или закрыть». Первый экран для ЛЮБОГО клика по зданию (построено оно или нет);
 * кнопка «Применить эффект» просто передаёт управление уже существующему activeBuildingUse-потоку
 * (building-use), «Построить» — существующей логике buildBuilding. */
let buildingDetailId: string | null = null;
/** The city chosen for Воин, while the unit-type modal is open picking what to build there. */
let warriorTargetCity: City | null = null;
/** Hand slot of the «Учёный» card while its tech-pick modal is open — no city/map target step, so
 * this is the only thing that needs to survive between opening the modal and confirming a pick. */
let scientistSlotIndex: number | null = null;
/** Город, чья модалка (ТЗ §14 п.1 — юниты гарнизона списком) сейчас открыта. */
let cityDetailId: number | null = null;
/** Клетка ВНЕ города, где сейчас несколько своих юнитов (по прямому запросу — живой баг-репорт:
 * «при выборе корабля с юнитом на борту выделяется юнит, из-за чего корабль не может двигаться») —
 * тот же выбор «каким юнитом ходить», что и у city-detail, только не привязан к городу: клик по
 * клетке своего корабля с пассажиром раньше молча брал первого по порядку в unitsAt (случайно то
 * корабль, то пассажира), теперь всегда явно спрашивает. */
let unitPickHex: { col: number; row: number } | null = null;

/** Состояние окна составления «Торговца» (по прямому запросу — выбор конкретных торговых ресурсов
 * перед разыгрышем, с превью дохода/сети/долей других игроков) — `selected: null` значит «ещё не
 * пришёл первый ответ превью» (сервер сам решит «все доступные», UI просто ждёт), после первого
 * ответа заполняется реальным множеством и дальше меняется чекбоксами. */
interface TraderComposeState {
  slotIndex: number;
  cityId: number;
  selected: Set<ResourceId> | null;
}
let traderComposeState: TraderComposeState | null = null;
let traderComposePreview: net.TradeTradePreview | null = null;
let traderComposeRequestId = 0;

let activeModal: ModalKind = null;

function closeModal() {
  // Пропуск хода (11.6) — по прямому запросу единственное доступное действие это кнопка
  // «Пропустить» в самом окне; закрыть окно кликом по фону/Esc нельзя, иначе игрок мог бы вернуться
  // к карте/карте мира, хотя действий у него всё равно нет.
  if (activeModal === "skip-turn") return;
  // Closing mid-pick means "changed my mind" — cancel the whole Воин action, not just the modal,
  // otherwise the card stays stuck pending with no visible way to finish or back out of it.
  if (activeModal === "warrior-unit") {
    warriorTargetCity = null;
    cancelPendingCardAction();
  }
  if (activeModal === "scientist-pick" || activeModal === "scientist-endgame-pick") scientistSlotIndex = null;
  if (activeModal === "gene-grow-pick") geneGrowSlotIndex = null; // ничего не потрачено — карта ещё в руке
  if (activeModal === "worker-mine-pick") workerMineSlotIndex = null; // ничего не потрачено — карта ещё в руке
  if (activeModal === "resource-choice") pendingResourceChoice = null; // ничего не потрачено — см. workerCollect
  if (activeModal === "sell-price") {
    pendingSellTarget = null; // nothing was spent yet — see finalizeSellListing
    renderHand(); // drops the price-picker's target highlight/lock state
  }
  if (activeModal === "elimination") {
    eliminationNoticeQueue.shift();
    // Ещё кто-то в очереди (несколько выбываний между снимками) — показываем следующего сразу же.
    activeModal = eliminationNoticeQueue.length ? "elimination" : null;
    renderModal();
    return;
  }
  if (activeModal === "city-detail") cityDetailId = null;
  if (activeModal === "unit-pick") unitPickHex = null;
  if (activeModal === "building-detail") buildingDetailId = null;
  // Клик по фону — тоже должен сбросить черновик выбора ресурсов «Торговца», иначе повторное
  // открытие окна показало бы прошлый выбор (карта/действие ещё не потрачены — просто отмена).
  if (activeModal === "trader-compose") {
    traderComposeState = null;
    traderComposePreview = null;
  }
  // Клик по фону (в обход собственной кнопки «Закрыть») — тоже должен сбросить черновик, иначе
  // повторное открытие окна показало бы условия из предыдущей, уже закрытой попытки.
  if (activeModal === "proposal-compose") {
    composeState = null;
    composeValuePreview = null;
  }
  // Клик по фону закрывает и подсветку региона (см. renderRegionHighlight) — предложение остаётся в
  // очереди, но раз игрок сам закрыл окно, подсказку на карте тоже убираем, а не оставляем висеть.
  if (activeModal === "proposal-review" && highlightedRegion) {
    highlightedRegion = null;
    regionHighlightForProposalId = null;
    renderRegionHighlight();
  }
  if (activeModal === "building-use" && activeBuildingUse === "oon") {
    oonComposeType = null;
    oonComposeParams = {};
  }
  // Живой баг-репорт — «предложение дипломатии принять нельзя, кнопка не нажимается, потому что
  // сперва открыто окно переполнения руки»: closeModal() на ЛЮБОЙ другой модалке (например
  // discard-confirm/warehouse-trim) просто обнуляла activeModal — а renderEverything() показывает
  // proposal-review/oon-vote заново ТОЛЬКО на смену хода или пока эта же модалка уже открыта (по
  // прямому уточнению — иначе закрытая пользователем модалка тут же переоткрывалась бы после любого
  // чужого действия), так что закрытая ПОВЕРХ предложения модалка навсегда прятала его до следующего
  // хода. Теперь при закрытии любой ДРУГОЙ модалки (не самого предложения/голосования — те при
  // явном закрытии по-прежнему не переоткрываются немедленно) сразу проверяем, не ждёт ли игрока
  // предложение/голосование, и если да — показываем его вместо пустого экрана.
  const wasProposalOrOonVote = activeModal === "proposal-review" || activeModal === "oon-vote" || activeModal === "oon-secretary-vote";
  activeModal = null;
  if (!wasProposalOrOonVote) {
    checkPendingProposalsForCurrentPlayer();
    checkPendingOonVoteForCurrentPlayer();
    checkPendingOonSecretaryVoteForCurrentPlayer();
  }
  renderModal();
}

/** Больше не вызывается напрямую (foundCity сам выставляет winner на сервере при 9-м городе) —
 * updateMirrorFrom открывает модалку «victory» сама, как только увидит winner !== null. */

async function buyListing(id: number) {
  const result = await sendAction("buyListing", { listingId: id });
  if (!result.ok) setHint(result.hint ?? "Не удалось купить лот.");
}

/** По прямому запросу — «сделай возможность отменить выставление карты на биржу»: карта всё это
 * время остаётся у продавца в руке (см. GameSession.sellCard — слот не освобождается при выставлении),
 * так что отмена — просто снятие лота, ничего не нужно возвращать. */
async function cancelCardListing(id: number) {
  const result = await sendAction("cancelCardListing", { listingId: id });
  if (!result.ok) setHint(result.hint ?? "Не удалось отменить лот.");
}

function renderModal() {
  const backdrop = document.querySelector<HTMLDivElement>("#side-modal-backdrop")!;
  if (!activeModal) {
    backdrop.classList.remove("open");
    backdrop.innerHTML = "";
    return;
  }
  backdrop.classList.add("open");

  if (activeModal === "handoff-pick" && handoffSlotIndex !== null) {
    const card = hands[currentPlayerIndex][handoffSlotIndex];
    // Запрет — на ЭТУ карту (card.receivedFrom), не на игрока целиком: другая карта из той же
    // руки может пойти хоть тому же самому игроку без ограничений.
    const forbiddenId = card?.receivedFrom ?? null;
    if (!card) {
      activeModal = null;
      handoffSlotIndex = null;
      backdrop.classList.remove("open");
      backdrop.innerHTML = "";
      return;
    }
    // По прямому запросу — нельзя передавать одному и тому же игроку два цикла подряд (минимум 1
    // цикл пропуска) — тот же дизейбл-приём, что и у forbiddenId выше, реальную проверку всё равно
    // делает сервер (см. GameSession.handoffCard).
    const onCooldown = (id: number) => {
      const last = lastHandoffCycle[`${currentPlayerIndex}:${id}`];
      return last !== undefined && cyclesElapsed - last < 2;
    };
    backdrop.innerHTML = `
      <div class="side-modal handoff-modal">
        <div class="side-modal-head">Обязательная передача карты</div>
        <div class="side-modal-note">Карта «${card.label}» уйдёт другому игроку — без этого нельзя сделать ничего другого в этом ходу. Выберите получателя:</div>
        <div class="handoff-player-list">
          ${PLAYERS.filter((p) => p.id !== currentPlayerIndex && !eliminatedPlayers.includes(p.id))
            .map((p) => {
              const cooldown = p.id !== forbiddenId && onCooldown(p.id);
              const disabled = p.id === forbiddenId || cooldown;
              return `
            <button class="handoff-player-btn" data-id="${p.id}" style="--pc:${playerCss(p.id)}" ${disabled ? "disabled" : ""}>
              ${p.name}${p.id === forbiddenId ? "<br><i>только что дал(а) вам карту — вернуть нельзя</i>" : cooldown ? "<br><i>уже передавали недавно — пропустите хотя бы 1 цикл</i>" : ""}
            </button>`;
            })
            .join("")}
        </div>
        <button class="side-modal-action handoff-cancel-btn" id="handoff-cancel">← Отменить выбор карты</button>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".handoff-player-btn").forEach((btn) =>
      btn.addEventListener("click", () => doHandoff(+btn.dataset.id!))
    );
    backdrop.querySelector("#handoff-cancel")!.addEventListener("click", () => {
      // Отменяет только ВЫБОР ЭТОЙ карты — саму обязанность передать 1 карту это не снимает
      // (mustHandoff всё ещё стоит на сервере), просто закрывает модалку, чтобы кликнуть другую.
      activeModal = null;
      handoffSlotIndex = null;
      renderModal();
      updateHint();
    });
    return;
  }

  if (activeModal === "warrior-unit") {
    const player = PLAYERS[currentPlayerIndex];
    const available = availableUnitsFor(player.id);
    backdrop.innerHTML = `
      <div class="side-modal warrior-unit-modal">
        <div class="side-modal-head">Выбор юнита — ${warriorTargetCity ? `Город ${cities.filter((c) => c.playerId === player.id).indexOf(warriorTargetCity) + 1}` : ""} <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Воин доступен всем с начала партии. Остальные открываются технологиями (см. дерево технологий и научный трек). Цена зависит от эпохи юнита (ТЗ 7.1). Для каждой категории доступен только юнит её СТАРШЕЙ уже открытой эпохи — устаревшие варианты той же категории недоступны (по прямому запросу — иначе бесплатный авто-апгрейд юнитов при новой эпохе превращался бы в эксплойт).</div>
        <div class="unit-pick-list">
          ${CATEGORIES.map((cat) => {
            // Старшая эпоха ИМЕННО ЭТОЙ категории (не общая эпоха игрока по всем веткам разом — по
            // прямому запросу, живой баг-репорт: «ты не верно понял правило, имеется в виду не эпоха
            // по максимальной технологии, а максимальный юнит исходя из изученных технологий»). Если
            // категория вообще не открыта (нет ни одного её юнита с исследованной технологией) —
            // недоступна вовсе; никакого отката на более раннюю эпоху той же категории, если старшая
            // почему-то недоступна — устаревшую эпоху для этой категории сервер всё равно отклонит.
            const u = available.filter((x) => x.category === cat).sort((a, b) => b.epoch - a.epoch)[0];
            if (!u) return `<div class="unit-pick-row locked"><span class="unit-pick-cat">${unitIconHtml(cat, 20)} ${CATEGORY_META[cat].label}</span><span class="unit-pick-locked">не открыто</span></div>`;
            if (cat === "ship" && warriorTargetCity && !cityHasAdjacentSea(warriorTargetCity)) {
              return `<div class="unit-pick-row locked"><span class="unit-pick-cat">${unitIconHtml(cat, 20)} ${CATEGORY_META[cat].label}</span><span class="unit-pick-locked">🔒 нет моря рядом</span></div>`;
            }
            return `
              <div class="unit-pick-row">
                <span class="unit-pick-cat">${unitIconHtml(cat, 20)} ${CATEGORY_META[cat].label}</span>
                <span class="unit-pick-name">${u.name} <i>Э${u.epoch}</i></span>
                <span class="unit-pick-cost">${unitCostLabel(u.epoch, u.category)}</span>
                <button class="unit-pick-build" data-name="${u.id}">Построить</button>
              </div>`;
          }).join("")}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".unit-pick-build").forEach((btn) =>
      btn.addEventListener("click", () => {
        const unit = UNITS.find((u) => u.id === btn.dataset.name);
        if (unit) buildUnit(unit);
      })
    );
  } else if (activeModal === "building-detail" && buildingDetailId) {
    const b = BUILDINGS.find((x) => x.id === buildingDetailId)!;
    const owners = ownersOf(buildingOwners, b.id);
    const taken = isTaken(buildingOwners, b.id);
    const mine = owners.includes(currentPlayerIndex);
    const usable = mine && !!BUILDING_USE_LABEL[b.id];
    const techOk = !b.tech || researchedTechs[currentPlayerIndex].has(b.tech);
    const available = !mine && techOk && !taken;
    const cardArmed = pendingCardAction?.kind === "builder-select";
    // Бонус первооткрывателя «Архитектуры» — см. cards.ts CardDef.freeBuilding — бесплатно и по
    // ресурсам, и по действию, тем же приёмом, что isFree в confirmResearch.
    const freeCard = cardArmed && !!hands[currentPlayerIndex]?.[(pendingCardAction as { slotIndex: number }).slotIndex]?.freeBuilding;
    const affordable = available && (freeCard || canAffordBuilding(currentPlayerIndex, b));
    const hasAction = freeCard || actionsLeft[currentPlayerIndex] > 0;
    // [ИСПРАВЛЕНО] По прямому уточнению — «построить будет кнопка активна только если есть
    // строитель, ресурсы и свободные очки действия»: явная третья проверка (раньше свободные
    // действия не проверялись отдельно — на практике карта «Строитель» и так не встанет в
    // pendingCardAction без действия, но проверка здесь делает причину видимой в статусе, а не
    // просто «кнопка почему-то неактивна»).
    const canBuildNow = available && affordable && cardArmed && hasAction;
    const src = b.tech ? `${b.tech}, эпоха ${b.epoch}` : "без исследования";
    // Тот же баг-репорт, что и в renderBuildings() выше (см. её комментарий) — «свободен ещё 1 слот»
    // раньше перекрывал собой реальную причину отказа (техника/ресурсы/действия), когда здание уже
    // частично занято другим игроком. slotNote — префикс, не отдельная взаимоисключающая ветка.
    const slotNote = owners.length && !mine ? `Построил: ${PLAYERS[owners[0]].name} — свободен ещё ${MAX_BUILDING_OWNERS - owners.length} слот из ${MAX_BUILDING_OWNERS}. ` : "";
    const status = taken
      ? `Построили: ${owners.map((o) => PLAYERS[o].name).join(" и ")} — оба слота заняты, больше недоступно.`
      : mine
        ? "Построено вами."
        : !techOk
          ? `${slotNote}Технология ещё не открыта.`
          : !affordable
            ? `${slotNote}Не набралось ресурсов прямо сейчас (регион/склад/рынок).`
            : !hasAction
              ? `${slotNote}Не осталось действий в этом ходу.`
              : cardArmed
                ? freeCard
                  ? `${slotNote}Бесплатно (бонус «Архитектуры») — можно построить прямо сейчас.`
                  : `${slotNote}Можно построить прямо сейчас.`
                : `${slotNote}Чтобы построить, сначала сыграйте карту «Строитель» и выберите «Открыть стройку».`;
    const actionButton = mine
      ? usable
        ? `<button class="side-modal-action" id="building-detail-go">🖱 Применить эффект</button>`
        : ""
      : available
        ? `<button class="side-modal-action" id="building-detail-go" ${canBuildNow ? "" : "disabled"} title="${canBuildNow ? "" : status.replace(/"/g, "&quot;")}">🏗 Построить</button>`
        : "";
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">${b.name} <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${GROUP_META[b.group].icon} ${GROUP_META[b.group].label} · ${src}</div>
        <div class="side-modal-note">${b.effect || "⚠ эффект не задан"}</div>
        <div class="side-modal-section">Цена постройки</div>
        <div class="tech-pick-cost">${freeCard ? "Бесплатно (бонус «Архитектуры»)" : costIconsHtml(b.costLines)}</div>
        <div class="side-modal-note">${status}</div>
        ${actionButton}
      </div>`;
    backdrop.querySelector("#building-detail-go")?.addEventListener("click", () => {
      if (mine) applyBuildingEffect(b.id);
      else tryBuildBuilding(b.id);
    });
  } else if (activeModal === "sell-price" && pendingSellTarget) {
    const player = PLAYERS[currentPlayerIndex];
    const label =
      pendingSellTarget.kind === "card"
        ? hands[player.id][pendingSellTarget.slotIndex]?.label ?? "?"
        : RESOURCE_META.get(pendingSellTarget.resource)!.label;
    const note =
      pendingSellTarget.kind === "card"
        ? "Карта останется в руке (рубашка станет красной) и будет недоступна для игры, пока её не купят."
        : "Ресурс сразу списывается со склада.";
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Продать «${label}» <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${note} Деньги придут только когда лот купят.</div>
        <div class="choice-sell-row">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => `<button class="choice-price" data-p="${p}">${p}</button>`).join("")}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".choice-price").forEach((btn) =>
      btn.addEventListener("click", () => finalizeSellListing(+btn.dataset.p!))
    );
  } else if (activeModal === "catastrophe-choice" && pendingCatastrophe) {
    const playerId = pendingCatastrophe.playerId;
    const canPay = canAvertCatastrophe(playerId);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">☠ Катастрофа <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Стихийное бедствие угрожает стране. Заплатите 1 Лес + 1 Силикат, чтобы устранить опасность (без какого-либо другого эффекта), или примите последствия: случайное здание будет потеряно; если зданий нет — случайный город потеряет 3 населения (или исчезнет вовсе, если населения было меньше).</div>
        <button class="side-modal-action" id="catastrophe-pay" ${canPay ? "" : "disabled"}>Заплатить 1 Лес + 1 Силикат${canPay ? "" : " (не хватает)"}</button>
        <button class="side-modal-action" id="catastrophe-accept">Принять последствия</button>
      </div>`;
    backdrop.querySelector("#catastrophe-pay")!.addEventListener("click", () => canPay && resolveCatastropheChoice("pay"));
    backdrop.querySelector("#catastrophe-accept")!.addEventListener("click", () => resolveCatastropheChoice("accept"));
  } else if (activeModal === "tax-shortfall" && pendingTaxShortfall) {
    const player = PLAYERS[pendingTaxShortfall.playerId];
    const myUnits = units.filter((u) => u.playerId === player.id);
    const myBuildings = builtBy(buildingOwners, player.id);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Недоимка — осталось списать ${pendingTaxShortfall.remaining} <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Денег на содержание армии и зданий не хватило — выберите, что списать (юнит или здание), пока недоимка не покрыта. Списание нельзя отменить.</div>
        <div class="unit-pick-list">
          ${myUnits
            .map(
              (u) => `
            <div class="unit-pick-row">
              <span class="unit-pick-name">${unitIconHtml(u.category, 20)} ${CATEGORY_META[u.category].label} <i>Э${u.epoch}</i></span>
              <button class="unit-pick-build" data-remove-unit="${u.id}">Списать</button>
            </div>`
            )
            .join("")}
          ${myBuildings
            .map(
              (b) => `
            <div class="unit-pick-row">
              <span class="unit-pick-name">${b.name}</span>
              <button class="unit-pick-build" data-remove-building="${b.id}">Списать</button>
            </div>`
            )
            .join("")}
          ${!myUnits.length && !myBuildings.length ? `<div class="market-empty">Списывать больше нечего.</div>` : ""}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>("[data-remove-unit]").forEach((btn) =>
      btn.addEventListener("click", () => removeForTaxShortfall({ unitId: +btn.dataset.removeUnit! }))
    );
    backdrop.querySelectorAll<HTMLButtonElement>("[data-remove-building]").forEach((btn) =>
      btn.addEventListener("click", () => removeForTaxShortfall({ buildingId: btn.dataset.removeBuilding! }))
    );
  } else if (activeModal === "scientist-pick") {
    const player = PLAYERS[currentPlayerIndex];
    const available = availableResearchFor(player.id);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Открытие технологии <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Технология доступна, если предыдущая в той же ветке уже открыта кем-то (неважно кем) — открыть можно и уже открытую кем-то другим, только бонус первооткрывателя (авто-маршрут, право основать религию) при этом не достаётся. При выборе технологии вы АВТОМАТИЧЕСКИ и бесплатно получаете себе все технологии этой же ветки, что стоят раньше выбранной, если их у вас ещё не было. Если технология НОВАЯ (открываете её первым в партии) — все ОСТАЛЬНЫЕ игроки тоже автоматически получают себе технологии этой ветки, что стоят раньше неё (саму новую технологию — нет, её каждому нужно исследовать лично). Как только в текущей эпохе открыты технологии в 3-4 ветках (любыми игроками), досрочно становится доступна следующая эпоха.</div>
        <div class="unit-pick-list">
          ${
            available.length
              ? available
                  .map((t) => {
                    const meta = CAT_META[t.cat];
                    const discoverer = techDiscoverer[t.id];
                    const statusHtml =
                      discoverer !== undefined
                        ? `<span class="tech-pick-status status-taken">Уже открыта: ${PLAYERS[discoverer].name} — бонус первооткрывателя (маршрут/религия) вам не достанется</span>`
                        : `<span class="tech-pick-status status-first">🆕 Никем ещё не открыта — вы станете первооткрывателем</span>`;
                    return `
                <div class="unit-pick-row unit-pick-row-tech">
                  <span class="unit-pick-cat" style="color:${meta.color}">${meta.icon} Ветка ${t.branch + 1}</span>
                  <span class="unit-pick-name">${t.name} <i>Э${t.epoch}</i></span>
                  <button class="unit-pick-build" data-tech="${t.id}">Открыть</button>
                  <div class="unit-pick-desc">${techEffectLines(t).join("<br>")}</div>
                  <div class="tech-pick-cost">Цена: ${researchCostChipsHtml(player.id, t.epoch)}</div>
                  ${statusHtml}
                </div>`;
                  })
                  .join("")
              : `<div class="market-empty">Сейчас нечего исследовать — все ветки либо упёрлись в лидера, либо эпоха ещё не открыта.</div>`
          }
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".unit-pick-build").forEach((btn) =>
      btn.addEventListener("click", () => confirmResearch(btn.dataset.tech!))
    );
  } else if (activeModal === "scientist-endgame-pick") {
    // «Учёный», эндгейм-выбор (по прямому запросу) — все технологии партии уже открыты, вместо
    // выбора технологии выбираем 1 из 4 фиксированных эффектов (см. GameSession.useScientistEndgameEffect).
    const CHOICES: { choice: 1 | 2 | 3 | 4; icon: string; title: string; desc: string }[] = [
      {
        choice: 1,
        icon: "👥",
        title: "Рост населения",
        desc: "Все ваши города +1 населения (не выше вместимости). У КАЖДОГО игрока (включая вас) 1 случайный свой город теряет 1 населения.",
      },
      { choice: 2, icon: "⚔", title: "Военная выучка", desc: "Все ваши юниты получают +1 урона и +1❤HP до конца партии." },
      { choice: 3, icon: "🃏", title: "Обмен колоды", desc: "Каждый игрок (включая вас) сбрасывает 1 случайную карту. Вы в этот же ход берёте 2 карты с колоды." },
      { choice: 4, icon: "🌲", title: "Лесничество", desc: "Вы получаете 2 бесплатные карты «Рост леса» — без ресурсов и действия при розыгрыше каждой." },
    ];
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Особый эффект «Учёного» <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Все технологии партии уже открыты — вместо исследования выберите ОДИН из 4 эффектов.</div>
        <div class="unit-pick-list">
          ${CHOICES.map(
            (c) => `
          <div class="unit-pick-row unit-pick-row-tech">
            <span class="unit-pick-cat">${c.icon} ${c.title}</span>
            <button class="unit-pick-build" data-choice="${c.choice}">Выбрать</button>
            <div class="unit-pick-desc">${c.desc}</div>
          </div>`
          ).join("")}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".unit-pick-build").forEach((btn) =>
      btn.addEventListener("click", () => pickScientistEndgameChoice(+btn.dataset.choice! as 1 | 2 | 3 | 4))
    );
  } else if (activeModal === "gene-grow-pick" && geneGrowSlotIndex !== null) {
    // «Рост леса» → «Вырастить ресурс» (Генная инженерия, по прямому запросу) — выбор ЛЮБОГО
    // пищевого ресурса, который сейчас есть на складе (нулевые не показываем — их всё равно нельзя
    // выбрать).
    const player = PLAYERS[currentPlayerIndex];
    const foodInStock = RESOURCES.filter((r) => r.category === "food" && (warehouse[player.id]?.[r.id] ?? 0) > 0);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Вырастить ресурс <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Выберите пищевой ресурс со склада — он спишется, и вы сможете разместить его на подходящем пустом гексе своей территории.</div>
        <div class="unit-pick-list">
          ${
            foodInStock.length
              ? foodInStock
                  .map(
                    (r) => `
              <div class="unit-pick-row">
                <span class="unit-pick-name">${r.symbol} ${r.label}</span>
                <span class="unit-pick-cost">${warehouse[player.id]?.[r.id] ?? 0} на складе</span>
                <button class="unit-pick-build" data-resource="${r.id}">Выбрать</button>
              </div>`
                  )
                  .join("")
              : `<div class="market-empty">На складе нет пищевых ресурсов.</div>`
          }
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".unit-pick-build").forEach((btn) =>
      btn.addEventListener("click", () => pickGeneGrowResource(btn.dataset.resource as ResourceId))
    );
  } else if (activeModal === "worker-mine-pick" && workerMineSlotIndex !== null) {
    // «Рабочий» → добыть стратегический ресурс (Геологоразведка, по прямому запросу обобщено с
    // «только Редкоземельные» на любой стратегический ресурс) — выбор типа ресурса ДО клика по гексу,
    // та же схема, что у «Рост леса» → «Вырастить ресурс» (gene-grow-pick).
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Добыть стратегический ресурс <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Выберите тип ресурса — дальше кликните гекс Равнины без ресурса на своей территории, он необратимо станет Пустыней.</div>
        <div class="unit-pick-list">
          ${WORKER_MINE_RESOURCE_POOL.map((id) => {
            const meta = RESOURCE_META.get(id)!;
            return `
          <div class="unit-pick-row">
            <span class="unit-pick-name">${meta.symbol} ${meta.label}</span>
            <button class="unit-pick-build" data-resource="${id}">Выбрать</button>
          </div>`;
          }).join("")}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".unit-pick-build").forEach((btn) =>
      btn.addEventListener("click", () => pickWorkerMineResource(btn.dataset.resource as ResourceId))
    );
  } else if (activeModal === "resource-choice" && pendingResourceChoice) {
    const { budget, options, cityId, population, usedThisCycle } = pendingResourceChoice;
    const myCities = cities.filter((c) => c.playerId === currentPlayerIndex);
    // По прямому запросу — сводка «использовано X из Y» по ВСЕМ своим городам, чтобы сразу видеть,
    // какие города в этом цикле уже задействованы, а какие ещё свободны (лимит — население, ТЗ 7.2).
    const cityUsageRows = myCities
      .map((c) => {
        const used = [...accessUsed].filter((k) => k.startsWith(`${c.id}:`)).length;
        const isCurrent = c.id === cityId;
        const spent = used >= c.population;
        const label = `Город ${myCities.indexOf(c) + 1}`;
        return `<div class="unit-pick-row${isCurrent ? " unit-pick-active" : ""}">
          <span class="unit-pick-name">${isCurrent ? "▶ " : ""}${label} 👥${c.population}</span>
          <span class="unit-pick-cost"${spent ? ' style="color:#d9737a"' : ""}>использовано ${used} из ${c.population}${spent ? " — исчерпан" : ""}</span>
        </div>`;
      })
      .join("");
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Выбор ресурсов для добычи <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Этот город: население ${population}, в этом цикле уже использовано ${usedThisCycle} из ${population} — осталось ${budget}. Свободных добыч в регионе ${options.length}, выберите не более ${budget}.</div>
        <div class="unit-pick-list">
          ${(() => {
            // [ИСПРАВЛЕНО] Удвоенный технологией ресурс может встретиться в options дважды (по
            // прямому уточнению — «удвоенная добыча не даёт ×2 за раз, а позволяет 1 ресурс
            // добыть дважды за цикл», каждый раз тратя свой слот лимита населения) — оба чекбокса
            // независимы (можно отметить один или оба), но подписаны по-разному, чтобы не выглядело
            // одинаковыми строками без объяснения.
            const seenCount = new Map<ResourceId, number>();
            return options
              .map((id) => {
                const meta = RESOURCE_META.get(id)!;
                const n = (seenCount.get(id) ?? 0) + 1;
                seenCount.set(id, n);
                const totalForId = options.filter((o) => o === id).length;
                const suffix = totalForId > 1 ? ` — добыча ${n} из ${totalForId} (удвоение)` : "";
                return `<label class="unit-pick-row">
                  <input type="checkbox" class="res-choice-box" value="${id}" style="margin-right:8px">
                  <span class="unit-pick-name">${meta.symbol} ${meta.label}${suffix}</span>
                </label>`;
              })
              .join("");
          })()}
        </div>
        <button class="side-modal-action" id="resource-choice-confirm">Подтвердить выбор</button>
        <div class="side-modal-section">Использование городов в этом цикле</div>
        <div class="unit-pick-list">${cityUsageRows}</div>
      </div>`;
    const boxes = backdrop.querySelectorAll<HTMLInputElement>(".res-choice-box");
    const confirmBtn = backdrop.querySelector<HTMLButtonElement>("#resource-choice-confirm")!;
    const refreshBoxes = () => {
      const checked = [...boxes].filter((b) => b.checked).length;
      boxes.forEach((b) => (b.disabled = !b.checked && checked >= budget));
      confirmBtn.textContent = `Подтвердить выбор (${checked}/${budget})`;
    };
    boxes.forEach((b) => b.addEventListener("change", refreshBoxes));
    refreshBoxes();
    confirmBtn.addEventListener("click", () => {
      const chosen = [...boxes].filter((b) => b.checked).map((b) => b.value as ResourceId);
      confirmResourceChoice(chosen);
    });
  } else if (activeModal === "building-use" && activeBuildingUse === "rynok") {
    // Рынок — по прямому запросу тот же доход, что у карты «Торговец»: выбор своего города вместо
    // ресурса, требует Углеводороды/Электричество на складе (см. GameSession.useRynok).
    const hydro = warehouse[currentPlayerIndex]?.hydrocarbons ?? 0;
    const elec = warehouse[currentPlayerIndex]?.electricity ?? 0;
    const myCities = cities.filter((c) => c.playerId === currentPlayerIndex);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Рынок <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.rynok} На складе: ${hydro} Углеводороды, ${elec} Электричество.</div>
        <div class="unit-pick-list">
          ${
            hydro + elec > 0 && myCities.length
              ? myCities
                  .map(
                    (c, i) => `
                <div class="unit-pick-row" data-rynok-city="${c.id}" style="cursor:pointer">
                  <span class="unit-pick-name">Город ${i + 1} · 👥${c.population}</span>
                </div>`
                  )
                  .join("")
              : `<div class="market-empty">Нужны Углеводороды или Электричество на складе.</div>`
          }
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLDivElement>("[data-rynok-city]").forEach((row) => row.addEventListener("click", () => useRynok(+row.dataset.rynokCity!)));
  } else if (activeModal === "building-use" && activeBuildingUse === "yadernyi_arsenal") {
    // Ядерный арсенал — ресурсное производство без денег, без лимита цикла (ТЗ 4.4, схема 3) + по
    // прямому запросу применение накопленного ЯО (см. GameSession.launchNuclearStrike) — вторая
    // кнопка появляется, только когда в запасе есть хотя бы 1 бомба.
    const bombCount = nuclearWeapons[currentPlayerIndex] ?? 0;
    // По прямому запросу — живой баг-репорт «кнопка не работает»: кнопка раньше была активна при
    // одном лишь наличии бомбы в запасе, а сервер (GameSession.launchNuclearStrike) отдельно
    // отклоняет удар без 2💰 — клик уводил в режим прицеливания на карте, и только ПОСЛЕ клика по
    // гексу приходил отказ «Не хватает денег», что выглядело как «кнопка ничего не делает». Теперь
    // нехватка денег видна СРАЗУ — кнопка становится disabled с понятной причиной в title, вместо
    // того чтобы завершиться отказом уже на карте.
    const canAffordStrike = money[currentPlayerIndex] >= NUCLEAR_STRIKE_MONEY_COST;
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Ядерный арсенал <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.yadernyi_arsenal} В запасе сейчас: ${bombCount}.</div>
        <button class="side-modal-action" id="building-use-go">Активировать (2 Уран + 1 Металл)</button>
        ${
          bombCount > 0
            ? `<button class="side-modal-action" id="nuclear-strike-go" ${canAffordStrike ? "" : "disabled"} title="${
                canAffordStrike ? "Цель — гекс на территории противника, с которым сейчас идёт война" : `Не хватает денег (нужно ${NUCLEAR_STRIKE_MONEY_COST}💰)`
              }">🚀 Нанести удар (${NUCLEAR_STRIKE_MONEY_COST}💰)</button>`
            : ""
        }
      </div>`;
    backdrop.querySelector("#building-use-go")!.addEventListener("click", () => activateYadernyiArsenal());
    backdrop.querySelector("#nuclear-strike-go")?.addEventListener("click", () => startNuclearTarget());
  } else if (activeModal === "building-use" && activeBuildingUse === "kosmodrom") {
    // Космодром — накопительный счётчик компонентов корабля, 3 = победа через космос (ТЗ 4.4).
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Космодром <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.kosmodrom} Сейчас накоплено: ${spaceComponents[currentPlayerIndex] ?? 0}/3.</div>
        <button class="side-modal-action" id="building-use-go">Активировать (1 Углеводороды + 2 Редкоземельные + 2 Металла + 1 Уран)</button>
      </div>`;
    backdrop.querySelector("#building-use-go")!.addEventListener("click", () => activateKosmodrom());
  } else if (activeModal === "building-use" && activeBuildingUse === "oon") {
    // Совет ООН (ТЗ §15.3) — статус кандидатов/генсека всегда виден; составитель резолюции — только
    // действующему генсеку, тем же двухшаговым паттерном, что диплом. составитель (pick → confirm).
    const isSecretary = oonSecretaryGeneralId === currentPlayerIndex;
    const c2 = oonCandidate2Id ?? oonEffectiveCandidate2Id;
    const statusLines = [
      oonCandidate1Id !== null ? `Кандидат №1: ${PLAYERS[oonCandidate1Id].name}` : "Кандидат №1 ещё не определён.",
      c2 !== null ? `Кандидат №2: ${PLAYERS[c2].name}${oonCandidate2Id === null ? " (автоподбор — может смениться)" : ""}` : "Кандидат №2 ещё не определён.",
      pendingOonSecretaryElection
        ? "Идут выборы генсека — голосование ещё не завершено."
        : oonSecretaryGeneralId !== null
          ? `Генеральный секретарь: ${PLAYERS[oonSecretaryGeneralId].name}`
          : "Выборы генсека ещё не проходили — нужно первое здание ООН.",
      ...activeOonResolutionsSummary(),
    ];
    const composer = oonComposeType
      ? `<div class="side-modal-section">Резолюция: ${OON_RESOLUTION_LABEL[oonComposeType]}</div>${oonResolutionParamsHtml()}`
      : isSecretary
      ? pendingOonResolution
        ? `<div class="side-modal-note">Уже выносится резолюция «${OON_RESOLUTION_LABEL[pendingOonResolution.type]}» — дождитесь её завершения.</div>`
        : `<div class="side-modal-section">Вынести резолюцию (1 действие + 10💰)</div>
           <div class="choice-sell-row" style="flex-wrap:wrap">${(Object.keys(OON_RESOLUTION_LABEL) as OonResolutionType[])
             .map((t) => `<button class="choice-play" data-oon-type="${t}">${OON_RESOLUTION_LABEL[t]}</button>`)
             .join("")}</div>`
      : "";
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">ООН <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${statusLines.join("<br>")}</div>
        ${composer}
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oon-type]").forEach((btn) => btn.addEventListener("click", () => startOonCompose(btn.dataset.oonType as OonResolutionType)));
    backdrop.querySelector("[data-oon-back]")?.addEventListener("click", cancelOonCompose);
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oon-target]").forEach((btn) =>
      btn.addEventListener("click", () => {
        oonComposeParams = { ...oonComposeParams, targetPlayerId: +btn.dataset.oonTarget! };
        renderModal();
      })
    );
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oon-resource]").forEach((btn) =>
      btn.addEventListener("click", () => {
        oonComposeParams = { ...oonComposeParams, resource: btn.dataset.oonResource as ResourceId };
        renderModal();
      })
    );
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oon-price]").forEach((btn) =>
      btn.addEventListener("click", () => {
        oonComposeParams = { ...oonComposeParams, price: +btn.dataset.oonPrice! };
        renderModal();
      })
    );
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oon-limit]").forEach((btn) =>
      btn.addEventListener("click", () => {
        oonComposeParams = { ...oonComposeParams, limit: +btn.dataset.oonLimit! };
        renderModal();
      })
    );
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oon-amount]").forEach((btn) =>
      btn.addEventListener("click", () => {
        oonComposeParams = { ...oonComposeParams, amount: +btn.dataset.oonAmount! };
        renderModal();
      })
    );
    backdrop.querySelector("#oon-submit")?.addEventListener("click", submitOonResolution);
  } else if (activeModal === "oon-vote" && pendingOonResolution) {
    // Голосующий — показывается в начале его хода, тот же паттерн, что и proposal-review
    // (checkPendingProposalsForCurrentPlayer/checkPendingOonVoteForCurrentPlayer).
    const res = pendingOonResolution;
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">🗳 Резолюция ООН <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">«${OON_RESOLUTION_LABEL[res.type]}»${oonResolutionParamsSummary(res)} Вес вашего голоса = ваше население (${totalPopulationOf(currentPlayerIndex)}); принимается при ≥60% от суммарного населения активных игроков.</div>
        <div class="choice-sell-row" style="margin-top:10px">
          <button class="side-modal-action" id="oon-vote-yes">✅ За</button>
          <button class="side-modal-action" id="oon-vote-no" style="background:#6b2f2f;border-color:#8a3f3f">❌ Против</button>
        </div>
      </div>`;
    backdrop.querySelector("#oon-vote-yes")!.addEventListener("click", () => castOonVote(true));
    backdrop.querySelector("#oon-vote-no")!.addEventListener("click", () => castOonVote(false));
  } else if (activeModal === "oon-secretary-vote" && pendingOonSecretaryElection) {
    // Выборы генсека — тот же паттерн, что и голосование за резолюцию выше, но выбор бинарный (один
    // из двух кандидатов, не «за/против»).
    const el = pendingOonSecretaryElection;
    const c1 = PLAYERS[el.candidate1Id];
    const c2 = PLAYERS[el.candidate2Id];
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">🗳 Выборы генсека ООН <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Вес вашего голоса = ваше население (${totalPopulationOf(currentPlayerIndex)}).</div>
        <div class="choice-sell-row" style="margin-top:10px;flex-wrap:wrap">
          <button class="side-modal-action" id="oon-sec-vote-1">${c1.name} (нас. ${totalPopulationOf(el.candidate1Id)})</button>
          <button class="side-modal-action" id="oon-sec-vote-2">${c2.name} (нас. ${totalPopulationOf(el.candidate2Id)})</button>
        </div>
      </div>`;
    backdrop.querySelector("#oon-sec-vote-1")!.addEventListener("click", () => castOonSecretaryVote(el.candidate1Id));
    backdrop.querySelector("#oon-sec-vote-2")!.addEventListener("click", () => castOonSecretaryVote(el.candidate2Id));
  } else if (activeModal === "building-use" && activeBuildingUse === "aeroport") {
    // Аэропорт — выбор своего юнита, стоящего в столице; следующий клик по карте (любой гекс) —
    // цель переброски, см. tryAeroportTarget/pointerdown.
    const capital = capitalCityOf(currentPlayerIndex);
    const eligible = units.filter((u) => u.playerId === currentPlayerIndex && capital && u.col === capital.col && u.row === capital.row);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Аэропорт <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.aeroport} Выберите юнита, стоящего в столице, затем кликните клетку назначения на карте.</div>
        <div class="unit-pick-list">
          ${
            eligible.length
              ? eligible
                  .map(
                    (u) => `
                <div class="unit-pick-row">
                  <span class="unit-pick-name">${unitIconHtml(u.category, 20)} ${CATEGORY_META[u.category].label} <i>Э${u.epoch}</i></span>
                  <button class="unit-pick-build" data-unit="${u.id}">Выбрать</button>
                </div>`
                  )
                  .join("")
              : `<div class="market-empty">В столице сейчас нет своих юнитов, готовых к переброске.</div>`
          }
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>("[data-unit]").forEach((btn) =>
      btn.addEventListener("click", () => startAeroportPick(+btn.dataset.unit!))
    );
  } else if (activeModal === "building-use" && activeBuildingUse === "hram") {
    // Храм — сжечь 1 карту руки, доход за единоверные города (ТЗ 4.4/4.5, схема 5).
    const hand = hands[currentPlayerIndex] ?? [];
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Храм <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.hram}</div>
        <div class="unit-pick-list">
          ${
            hand.length
              ? hand
                  .map(
                    (c, i) => `
                <div class="unit-pick-row">
                  <span class="unit-pick-name">${c.label}</span>
                  <button class="unit-pick-build" data-slot="${i}">Сжечь</button>
                </div>`
                  )
                  .join("")
              : `<div class="market-empty">В руке нет карт.</div>`
          }
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>("[data-slot]").forEach((btn) =>
      btn.addEventListener("click", () => useHram(+btn.dataset.slot!))
    );
  } else if (activeModal === "building-use" && activeBuildingUse === "universitet") {
    // Университет — то же открытие технологии, что «Учёный», + доплата 5💰 (ТЗ 4.4, схема 4).
    const available = availableResearchFor(currentPlayerIndex);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Университет <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.universitet}</div>
        <div class="unit-pick-list">
          ${
            available.length
              ? available
                  .map((t) => {
                    const meta = CAT_META[t.cat];
                    return `
                <div class="unit-pick-row">
                  <span class="unit-pick-cat" style="color:${meta.color}">${meta.icon} Ветка ${t.branch + 1}</span>
                  <span class="unit-pick-name">${t.name} <i>Э${t.epoch}</i></span>
                  <button class="unit-pick-build" data-tech="${t.id}">Открыть (+5💰)</button>
                </div>`;
                  })
                  .join("")
              : `<div class="market-empty">Сейчас нечего исследовать — все ветки либо упёрлись в лидера, либо эпоха ещё не открыта.</div>`
          }
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>("[data-tech]").forEach((btn) =>
      btn.addEventListener("click", () => useUniversitet(btn.dataset.tech!))
    );
  } else if (activeModal === "building-use" && activeBuildingUse === "internet") {
    // Интернет — выбрать другого игрока, подтянуть отставшие ветки (ТЗ 4.4, схема 4).
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Интернет <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.internet}</div>
        <div class="handoff-player-list">
          ${PLAYERS.filter((p) => p.id !== currentPlayerIndex && !eliminatedPlayers.includes(p.id))
            .map((p) => `<button class="handoff-player-btn" data-id="${p.id}" style="--pc:${playerCss(p.id)}">${p.name}</button>`)
            .join("")}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".handoff-player-btn").forEach((btn) =>
      btn.addEventListener("click", () => useInternet(+btn.dataset.id!))
    );
  } else if (activeModal === "building-use" && activeBuildingUse === "kazarma") {
    // Казарма — та же city-then-unit-type механика, что у карты «Воин» (см. pickKazarmaCity/
    // buildUnit), просто без карты: кнопка сразу вооружает pendingCardAction и ждёт клика по своему
    // городу (на карте или в списке справа), гейт «нет действий» тут не нужен отдельно — его уже
    // проверит useKazarma на сервере при реальной постройке юнита.
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Казарма <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL.kazarma}</div>
        <button class="side-modal-action" id="building-use-go">Выбрать город для постройки</button>
      </div>`;
    backdrop.querySelector("#building-use-go")!.addEventListener("click", () => {
      activeModal = null;
      activeBuildingUse = null;
      pendingCardAction = { kind: "kazarma-city" };
      renderModal();
      renderCityList(); // gold "targetable" highlighting
      updateHint();
    });
  } else if (activeModal === "building-use" && activeBuildingUse) {
    const building = BUILDINGS.find((b) => b.id === activeBuildingUse);
    const buildingName = building?.name ?? activeBuildingUse;
    const isUpravlenie = activeBuildingUse === "upravlenie";
    const alreadyUsed = isUpravlenie
      ? upravlenieUsedThisTurn.has(currentPlayerIndex)
      : !!building?.produces && productionUsedThisCycle.has(`${activeBuildingUse}:${currentPlayerIndex}`);
    const alreadyUsedNote = isUpravlenie ? " Уже куплено в этом ходу." : " Уже использовано в этом цикле.";
    const buttonLabel = isUpravlenie ? "Купить действие (5 💰)" : building?.produces ? `Активировать (1 💰)` : "Выбрать регион";
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">${buildingName} <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${BUILDING_USE_LABEL[activeBuildingUse]}${alreadyUsed ? alreadyUsedNote : ""}</div>
        <button class="side-modal-action" id="building-use-go" ${alreadyUsed ? "disabled" : ""}>${alreadyUsed ? "Уже использовано" : buttonLabel}</button>
      </div>`;
    backdrop.querySelector("#building-use-go")!.addEventListener("click", () => {
      if (alreadyUsed) return;
      if (isUpravlenie) {
        useUpravlenie();
        return;
      }
      if (building?.produces) {
        activateProductionBuilding(building.id);
        return;
      }
      activeModal = null;
      activeBuildingUse = null;
      pendingCardAction = { kind: "sklad-collect" };
      renderModal();
      renderCityList(); // gold "targetable" highlighting
      updateHint();
    });
  } else if (activeModal === "victory") {
    // Дашборд результатов (по прямому запросу — «показать тип победы и сколько городов, сколько
    // населения, сколько армий») — по каждому игроку, отсортировано по числу городов (тот же
    // показатель, что чаще всего решает территориальную победу) убыванием, победитель подсвечен.
    const rows = PLAYERS.map((p) => {
      const myCities = cities.filter((c) => c.playerId === p.id);
      const population = myCities.reduce((sum, c) => sum + c.population, 0);
      const armyCount = units.filter((u) => u.playerId === p.id).length;
      return { player: p, citiesCount: myCities.length, population, armyCount };
    }).sort((a, b) => b.citiesCount - a.citiesCount || b.population - a.population);
    // Общая ничья по лимиту раундов WeGo (declareTurnLimitDraw, §16 СПРАВОЧНИКА) — winners содержит
    // ВСЕХ, не потерявших все города, не одного; обычные пути победы (territorial/space/oon) кладут
    // туда ровно [winner], та же вёрстка сводится к прежнему единственному имени.
    const isSharedDraw = winners.length > 1;
    backdrop.innerHTML = `
      <div class="side-modal victory-modal">
        <div class="side-modal-head">🏆 ${isSharedDraw ? "Ничья!" : "Победа!"} <button class="modal-close" id="modal-close">×</button></div>
        <div class="victory-text">${
          isSharedDraw
            ? winners.map((id) => `<span style="color:${playerCss(id)}">${PLAYERS[id].name}</span>`).join(", ")
            : `<span style="color:${playerCss(winner!)}">${PLAYERS[winner!].name}</span>`
        }</div>
        <div class="side-modal-note">${winnerType ?? "Победа."}</div>
        <div class="side-modal-section">Итоги партии</div>
        <table class="victory-table">
          <thead><tr><th>Игрок</th><th>🏙 Города</th><th>👥 Население</th><th>⚔ Армия</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr${winners.includes(r.player.id) ? ` class="victory-row-winner"` : ""}>
                <td style="color:${playerCss(r.player.id)}">${winners.includes(r.player.id) ? "🏆 " : ""}${r.player.name}</td>
                <td>${r.citiesCount}</td>
                <td>${r.population}</td>
                <td>${r.armyCount}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="side-modal-note">Игра формально не блокируется: полноценного состояния «партия окончена» пока нет, можно продолжать играть после закрытия этого окна.</div>
      </div>`;
  } else if (activeModal === "discard-confirm" && pendingDiscardConfirm) {
    const canTrySomethingElse = actionsLeft[currentPlayerIndex] > 0;
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">⚠ Переполнение руки (8+) — последствия сброса</div>
        <div class="side-modal-note">Рука будет сброшена (кроме «Права прокладки маршрута»), эффекты сброшенных карт применятся. Список ниже — то, что случится, если подтвердить конец хода прямо сейчас; он не изменится от закрытия этого окна.${pendingDiscardConfirm.eliminates ? " <b>Это лишит вас всех городов — вы выбудете из партии.</b>" : ""}</div>
        <ul class="info-list">${pendingDiscardConfirm.consequences.map((c) => `<li>${c}</li>`).join("")}</ul>
        <div class="choice-sell-row" style="margin-top:10px">
          <button class="side-modal-action" id="discard-confirm-accept">✅ Принять и завершить ход</button>
          ${canTrySomethingElse ? `<button class="side-modal-action" id="discard-confirm-dismiss" style="background:#3f4a5a;border-color:#5a6a7a">↩ Попробовать что-то ещё</button>` : ""}
        </div>
      </div>`;
    backdrop.querySelector("#discard-confirm-accept")!.addEventListener("click", confirmDiscardAndEndTurn);
    backdrop.querySelector("#discard-confirm-dismiss")?.addEventListener("click", dismissDiscardConfirm);
    return;
  } else if (activeModal === "warehouse-trim" && pendingWarehouseTrim) {
    const { total, cap, overBy } = pendingWarehouseTrim;
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">📦 Склад переполнен <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">На складе ${total} из ${cap} — конец хода недоступен, пока склад не в пределах лимита. Продайте на бирже как минимум <b>${overBy}</b> ед. ресурсов (любых), затем завершите ход снова.</div>
      </div>`;
    backdrop.querySelector("#modal-close")!.addEventListener("click", () => {
      pendingWarehouseTrim = null;
      closeModal();
    });
    return;
  } else if (activeModal === "elimination") {
    const deadId = eliminationNoticeQueue[0];
    backdrop.innerHTML = `
      <div class="side-modal victory-modal">
        <div class="side-modal-head">💀 Игрок выбыл <button class="modal-close" id="modal-close">×</button></div>
        <div class="victory-text" style="color:${playerCss(deadId)}">${PLAYERS[deadId].name}</div>
        <div class="side-modal-note">Потерял все города — юниты и торговые маршруты сняты с карты, партия для него окончена.</div>
      </div>`;
  } else if (activeModal === "skip-turn") {
    // Пропуск хода (смена парадигмы/религии/штраф «Мобилизации», ТЗ 11.6) — по прямому запросу не
    // тихий автопропуск сервером: игрок по-прежнему «получает» ход и должен сам нажать «Пропустить»,
    // никакого другого действия сделать нельзя (нет × — см. closeModal).
    const reasonText =
      pendingSkipTurnReason === "mobilization"
        ? "штраф за отклонённую «Мобилизацию» — карта ушла в вынужденный сброс"
        : pendingSkipTurnReason === "religion"
          ? "смена религии"
          : "смена парадигмы (реформы)";
    backdrop.innerHTML = `
      <div class="side-modal victory-modal">
        <div class="side-modal-head">⏭ Ход пропущен</div>
        <div class="victory-text" style="color:${playerCss(currentPlayerIndex)}">${PLAYERS[currentPlayerIndex].name}</div>
        <div class="side-modal-note">Ваш ход пропущен — ${reasonText} (ТЗ 11.6). В этом ходу нельзя сделать ничего другого.</div>
        <button class="side-modal-action" id="skip-turn-go">⏭ Пропустить</button>
      </div>`;
    backdrop.querySelector("#skip-turn-go")!.addEventListener("click", skipMyTurn);
    return;
  } else if (activeModal === "proposal-review") {
    const p = pendingProposals.find((p) => p.to === currentPlayerIndex);
    if (!p) {
      activeModal = null;
      backdrop.classList.remove("open");
      backdrop.innerHTML = "";
      if (highlightedRegion) {
        highlightedRegion = null;
        regionHighlightForProposalId = null;
        renderRegionHighlight();
      }
      return;
    }
    // По прямому запросу — предложение с обещанием «не селиться в регионе X» ссылается на конкретный
    // регион, а карта в этот момент скрыта под самим окном: подсвечиваем регион и подводим камеру к
    // нему (см. centerCameraOnRegionAvoidingModal), один раз на КАЖДОЕ предложение (не на каждый
    // ре-рендер — см. doc у regionHighlightForProposalId).
    const noSettleTerm = p.terms.find((t): t is Extract<ProposalTerm, { kind: "promiseNoSettle" }> => t.kind === "promiseNoSettle");
    if (noSettleTerm) {
      if (regionHighlightForProposalId !== p.id) {
        regionHighlightForProposalId = p.id;
        centerCameraOnRegionAvoidingModal(noSettleTerm.regionCol, noSettleTerm.regionRow);
      }
    } else if (highlightedRegion) {
      highlightedRegion = null;
      regionHighlightForProposalId = null;
      renderRegionHighlight();
    }
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Предложение от ${playerNameHtml(p.from)} <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${p.ultimatum ? "⚠ Ультиматум — отказ означает немедленную войну с этим игроком." : "Можно закрыть и решить позже — предложение останется в очереди до следующего вашего хода."}</div>
        <ul class="info-list">${p.terms.map((t) => `<li>${termLabel(t, p.from, p.to)}</li>`).join("")}</ul>
        <div class="choice-sell-row" style="margin-top:10px">
          <button class="side-modal-action" id="proposal-accept">✅ Принять</button>
          <button class="side-modal-action" id="proposal-reject" style="background:#6b2f2f;border-color:#8a3f3f">❌ Отклонить</button>
          <button class="side-modal-action" id="proposal-edit" style="background:#3f4a5a;border-color:#5a6a7a">✏ Редактировать</button>
        </div>
      </div>`;
    backdrop.querySelector("#proposal-accept")!.addEventListener("click", () => resolveProposal(p.id, true));
    backdrop.querySelector("#proposal-reject")!.addEventListener("click", () => resolveProposal(p.id, false));
    // Редактировать — по прямому запросу: открывает составитель с зеркальными условиями (свои
    // ответные), само это предложение НЕ отклоняет — остаётся в очереди, решить по нему можно и
    // отдельно, в т.ч. позже (см. doc у openProposalComposeFromIncoming).
    backdrop.querySelector("#proposal-edit")!.addEventListener("click", () => openProposalComposeFromIncoming(p));
  } else if (activeModal === "city-detail") {
    const city = cities.find((c) => c.id === cityDetailId);
    if (!city) {
      activeModal = null;
      backdrop.classList.remove("open");
      backdrop.innerHTML = "";
      return;
    }
    // Гарнизон ограничен CITY_GARRISON_CAP=2 юнитами (см. GameSession), ОБА полноценно командуемы —
    // по прямому запросу («при щелчке по городу, где два юнита, предлагать сначала выбор, каким
    // игрок хочет ходить») эта же модалка — тот самый выбор: клик по юниту подсвечивает его на карте
    // и открывает нижнюю панель команд. Никакого разделения на «активного»/«резервного» больше нет.
    const garrison = unitsAt(city.col, city.row);
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Город · 👥${city.population} <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">${garrison.length ? "Выберите юнита для приказа:" : "Гарнизон пуст — город обороняется собственным населением."}</div>
        <div class="unit-pick-list">
          ${garrison
            .map((u) => {
              const stats = unitStats(u);
              return `
            <div class="unit-pick-row" data-garrison-unit="${u.id}" style="cursor:pointer">
              <span class="unit-pick-cat" style="color:${playerCss(u.playerId)}">${unitIconHtml(u.category, 16)}</span>
              <span class="unit-pick-name">${CATEGORY_META[u.category].label} Э${u.epoch} <i>❤${u.hp}/${stats.hp}</i></span>
            </div>`;
            })
            .join("")}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLDivElement>("[data-garrison-unit]").forEach((row) =>
      row.addEventListener("click", () => {
        const id = +row.dataset.garrisonUnit!;
        const unit = units.find((u) => u.id === id);
        activeModal = null;
        renderModal();
        if (!unit) return;
        selectUnit(id);
        centerCameraOnHex(unit.col, unit.row);
      })
    );
  } else if (activeModal === "unit-pick") {
    if (!unitPickHex) {
      activeModal = null;
      backdrop.classList.remove("open");
      backdrop.innerHTML = "";
      return;
    }
    // Та же идея, что city-detail (см. выше) — только клетка не городская: корабль с пассажиром на
    // борту чаще всего и есть этот случай (см. doc у unitPickHex).
    const here = unitsAt(unitPickHex.col, unitPickHex.row).filter((u) => u.playerId === currentPlayerIndex);
    if (here.length < 2) {
      activeModal = null;
      unitPickHex = null;
      backdrop.classList.remove("open");
      backdrop.innerHTML = "";
      return;
    }
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Несколько юнитов на клетке <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Выберите юнита для приказа:</div>
        <div class="unit-pick-list">
          ${here
            .map((u) => {
              const stats = unitStats(u);
              return `
            <div class="unit-pick-row" data-unit-pick="${u.id}" style="cursor:pointer">
              <span class="unit-pick-cat" style="color:${playerCss(u.playerId)}">${unitIconHtml(u.category, 16)}</span>
              <span class="unit-pick-name">${CATEGORY_META[u.category].label} Э${u.epoch} <i>❤${u.hp}/${stats.hp}</i></span>
            </div>`;
            })
            .join("")}
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLDivElement>("[data-unit-pick]").forEach((row) =>
      row.addEventListener("click", () => {
        const id = +row.dataset.unitPick!;
        const unit = units.find((u) => u.id === id);
        activeModal = null;
        unitPickHex = null;
        renderModal();
        if (!unit) return;
        selectUnit(id);
        centerCameraOnHex(unit.col, unit.row);
      })
    );
  } else if (activeModal === "trader-compose") {
    if (!traderComposeState) {
      activeModal = null;
      backdrop.classList.remove("open");
      backdrop.innerHTML = "";
      return;
    }
    backdrop.innerHTML = `
      <div class="side-modal dip-compose-modal">
        <div class="side-modal-head">Торговец — выбор ресурсов</div>
        ${traderComposeBodyHtml()}
      </div>`;
    bindTraderComposeModal(backdrop);
    return;
  } else if (activeModal === "proposal-compose") {
    if (!composeState) {
      activeModal = null;
      backdrop.classList.remove("open");
      backdrop.innerHTML = "";
      return;
    }
    backdrop.innerHTML = `
      <div class="side-modal dip-compose-modal">
        <div class="side-modal-head">Составить предложение</div>
        ${proposalComposeBodyHtml()}
      </div>`;
    bindProposalComposeModal(backdrop);
    return;
  }
  backdrop.querySelector("#modal-close")!.addEventListener("click", closeModal);
}

/** Рынок/Дипломатия/Гос. управление больше не модалки — вкладки правой панели, переключаемые
 * верхними кнопками (см. switchRightPanelView). «Ресурсы» — исходный вид (города + склад),
 * остальные три подменяют #right-panel-extra и прячут #city-list/#warehouse-panel. */
// --- Дипломатия: круг из 6 слотов + окно составления предложения (вкладка "diplomacy", 11.7) -----
/** Кого сейчас подсвечивает круг дипломатии (клик по игроку) — по прямому запросу влияет ТОЛЬКО на
 * то, какие линии показаны (см. diplomacyCircleHtml — оставляет линии одного этого игрока), ничего
 * больше в окне не меняет и не перестраивает. Повторный клик по тому же игроку снимает подсветку. */
let diplomacyHighlightId: number | null = null;

/** Состояние отдельного окна составления предложения (по прямому запросу — «неудобно набирать
 * условия, лучше в отдельном окне, не ломая стандартное окно отношений») — модалка поверх карты
 * (`activeModal === "proposal-compose"`), null, когда закрыта. Условия разложены по трём спискам —
 * `give`/`request` (однонаправленные — деньги/ресурс/город, определяют колонку «Я отдаю»/«Я прошу»)
 * и `shared` (двусторонние — смена статуса соглашений/мир, к колонкам не относятся). */
interface ProposalComposeState {
  to: number | null;
  give: ProposalTerm[];
  request: ProposalTerm[];
  shared: ProposalTerm[];
  ultimatum: boolean;
  /** Какой под-выбор сейчас открыт (какой ресурс/город/сумму выбрать) — null значит показаны обычные
   * кнопки-действия, не под-список вариантов. */
  pickMode: "agreement" | "peace" | "money" | "city" | "resource" | null;
  /** Для money/city/resource — в какую колонку добавляется условие (даёт/просит); agreement/peace
   * колонки не имеют. */
  pickColumn: "give" | "request" | null;
}
let composeState: ProposalComposeState | null = null;
/** Живой предпросмотр ценности черновика (по прямому запросу — «внизу считается ценность условий с
 * каждой стороны», формулы ТЗ §8.1) — null, пока ответ сервера ещё не пришёл или условий нет.
 * `composeValueRequestId` — тот же паттерн отбрасывания устаревших ответов, что и movePreview/
 * attackPreview (net.onPreviewProposalValue). */
let composeValuePreview: net.ProposalValuePreview | null = null;
let composeValueRequestId = 0;

/** Разворачивает термы предложения на противоположный — по прямому запросу («после редактирования
 * выслать ответные условия»): открывая составитель из чужого входящего предложения, каждое условие
 * подставляется так, будто ту же сделку теперь предлагает получатель отправителю (деньги/ресурс/
 * город меняются местами give↔demand); соглашение/мир двусторонние — не меняются. */
function mirrorTerm(term: ProposalTerm): ProposalTerm {
  switch (term.kind) {
    case "offerMoney":
      return { kind: "demandMoney", amount: term.amount };
    case "demandMoney":
      return { kind: "offerMoney", amount: term.amount };
    case "giveResource":
      return { kind: "demandResource", resource: term.resource, qty: term.qty };
    case "demandResource":
      return { kind: "giveResource", resource: term.resource, qty: term.qty };
    case "giveCity":
      return { kind: "demandCity", cityId: term.cityId };
    case "demandCity":
      return { kind: "giveCity", cityId: term.cityId };
    case "agreement":
    case "peace":
    // «Призыв на войну»/«Совместное нападение»/обещания AI — заводятся только ботом, композер
    // человека их предложить не даёт (см. doc у типа ProposalTerm); при редактировании входящего
    // предложения от бота оставляем как есть — двусторонний зеркальный разворот для них не имеет
    // смысла (это не «я отдаю/прошу» ценность, а обязательство/призыв).
    case "callToWar":
    case "jointAttack":
    case "promiseNoSettle":
    case "promiseNoAttack":
    case "promiseNoEventCards":
    case "promiseGiveCardType":
    case "promiseListResource":
    case "breakTiesWith":
      return term;
  }
}
/** В какую колонку составителя попадает терм — используется и при заполнении из mirrorTerm, и нигде
 * больше (обычное добавление кнопками уже знает свою колонку явно). */
function classifyTerm(term: ProposalTerm): "give" | "request" | "shared" {
  switch (term.kind) {
    case "offerMoney":
    case "giveResource":
    case "giveCity":
      return "give";
    case "demandMoney":
    case "demandResource":
    case "demandCity":
      return "request";
    case "agreement":
    case "peace":
    case "callToWar":
    case "jointAttack":
    case "promiseNoSettle":
    case "promiseNoAttack":
    case "promiseNoEventCards":
    case "promiseGiveCardType":
    case "promiseListResource":
    case "breakTiesWith":
      return "shared";
  }
}
function composeAllTerms(state: ProposalComposeState): ProposalTerm[] {
  return [...state.shared, ...state.give, ...state.request];
}
function valueLabel(v: number | undefined): string {
  if (v === undefined) return "…";
  const rounded = Math.round(v * 10) / 10;
  return (rounded > 0 ? "+" : "") + rounded;
}
function valueClass(v: number | undefined): string {
  if (v === undefined) return "";
  return v > 0 ? "dip-value-pos" : v < 0 ? "dip-value-neg" : "";
}
/** Запрашивает у сервера ценность ТЕКУЩЕГО черновика (по прямому запросу — живой пересчёт при каждом
 * изменении условий) — сбрасывает предыдущий предпросмотр сразу (не ждёт ответа), чтобы не показывать
 * устаревшее число, пока считается новое. */
function requestComposeValuePreview() {
  if (!composeState || composeState.to === null) {
    composeValuePreview = null;
    return;
  }
  const terms = composeAllTerms(composeState);
  if (!terms.length) {
    composeValuePreview = null;
    return;
  }
  composeValuePreview = null;
  composeValueRequestId = net.requestPreviewProposalValue(currentPlayerIndex, composeState.to, terms);
}
/** Перерисовывает модалку немедленно (список условий/выбор адресата не должны ждать сервер) и
 * отдельно запрашивает пересчёт ценности — тот перерисует ещё раз сам, когда придёт ответ. */
function refreshComposeAndRender() {
  renderModal();
  requestComposeValuePreview();
}
function openProposalCompose(target: number | null) {
  composeState = { to: target, give: [], request: [], shared: [], ultimatum: false, pickMode: null, pickColumn: null };
  composeValuePreview = null;
  activeModal = "proposal-compose";
  renderModal();
  requestComposeValuePreview();
}
/** Открывает составитель, предзаполненный зеркальными условиями чужого входящего предложения (по
 * прямому запросу — «редактировать и выслать ответные условия»); САМО входящее предложение при этом
 * НЕ отклоняется и не трогается — остаётся висеть в очереди, пока получатель явно не примет/отклонит
 * его отдельно (в т.ч. и после отправки этого встречного). */
function openProposalComposeFromIncoming(p: Proposal) {
  const state: ProposalComposeState = { to: p.from, give: [], request: [], shared: [], ultimatum: false, pickMode: null, pickColumn: null };
  for (const t of p.terms) {
    const mirrored = mirrorTerm(t);
    state[classifyTerm(mirrored)].push(mirrored);
  }
  composeState = state;
  composeValuePreview = null;
  activeModal = "proposal-compose";
  renderModal();
  requestComposeValuePreview();
}

/** 6 фиксированных позиций по кругу — свой игрок ВСЕГДА внизу (индекс 0), остальные распределены
 * по кругу от него; лишние слоты (при <6 игроках в партии) остаются пустыми кружками. */
function diplomacySlotPositions(): { x: number; y: number }[] {
  const cx = 130,
    cy = 112,
    r = 84;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const rad = ((90 + i * 60) * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) });
  }
  return pts;
}

/** Подсказка при наведении на игрока в окне дипломатии (ТЗ §14 п.14) — деньги, карты на руке,
 * число зданий, число военных юнитов (числом, без разбивки по типам), число городов, религия и
 * парадигма. Обычный `title` — тот же паттерн наведения, что уже используется у ресурсных иконок
 * (renderCityList). */
function playerDiplomacyTooltip(playerId: number): string {
  const { units: unitCount, buildings: buildingCount } = unitsAndBuildingsUpkeep(playerId);
  const playerCities = cities.filter((c) => c.playerId === playerId);
  const cityCount = playerCities.length;
  // По прямому запросу — «в справочную информацию о игроке в окне дипломатии добавь кол-во
  // населения»: суммарное население ВСЕХ городов игрока, та же метрика, что и everywhere else
  // (Гос. управление/лидер по населению, налоги и т.п.).
  const population = playerCities.reduce((sum, c) => sum + c.population, 0);
  const religion = playerReligion[playerId] ? RELIGION_META[playerReligion[playerId]!].label : "нет";
  const paradigm = playerParadigm[playerId] ? PARADIGM_META[playerParadigm[playerId]!].label : "не выбрана";
  const lines = [
    `${PLAYERS[playerId].name}`,
    `💰 Деньги: ${money[playerId] ?? 0}`,
    `🃏 Карт на руке: ${handCountOf(playerId)}`,
    `🏛 Зданий: ${buildingCount}`,
    `⚔ Военных юнитов: ${unitCount}`,
    `🏙 Городов: ${cityCount}`,
    `👥 Население: ${population}`,
    `☦ Религия: ${religion}`,
    `🏛 Парадигма: ${paradigm}`,
  ];
  // Отношения AI — по прямому запросу: мнение ЭТОГО игрока о текущем (чей сейчас ход) — асимметрично,
  // не путать с симметричным war/agreements выше (см. СПРАВОЧНИК §8.3). Не показывается на самом себе.
  if (playerId !== currentPlayerIndex) lines.push(`🤝 Отношение ко мне: ${relationScoreOf(playerId, currentPlayerIndex)}/100`);
  return lines.join("\n");
}

/** По прямому запросу — «разным уровням отношений разные цвета, а то сейчас торговые союзы не
 * отличаются от просто открытых границ или оборонительных союзов»: раньше ЛЮБОЕ соглашение (в любом
 * сочетании) красилось одним и тем же зелёным — теперь у каждого своя линия своим цветом (см.
 * relationLineDefs ниже), можно одновременно видеть, например, «Открытые границы есть, Торгового
 * союза нет» и наоборот. Война остаётся отдельным, взаимоисключающим статусом (по правилам —
 * соглашения при войне не действуют, см. doc у Relation/Agreement выше), нейтралитет без единого
 * соглашения — как раньше, тонкий пунктир. */
const AGREEMENT_LINE_COLOR: Record<Agreement, string> = {
  openBorders: "#4fc3f7",
  vassalage: "#c9822a",
  mutualDefense: "#3fae5a",
  tradeUnion: "#e8c547",
  scienceCoop: "#9b6fd6",
  union: "#e85d9e",
};
const RELATION_WAR_COLOR = "#c0392b";
const RELATION_NEUTRAL_COLOR = "#3a4a5f";
function relationLineDefs(rel: Relation): { color: string; width: number; dash: string; label: string }[] {
  if (rel.war) return [{ color: RELATION_WAR_COLOR, width: 3, dash: "", label: "Война" }];
  if (rel.agreements.size === 0) return [{ color: RELATION_NEUTRAL_COLOR, width: 1, dash: "4 3", label: "Мир (без соглашений)" }];
  return [...rel.agreements].map((a) => ({ color: AGREEMENT_LINE_COLOR[a], width: 2.5, dash: "", label: AGREEMENT_META[a].label }));
}

/** По прямому запросу — «убирай из окна дипломатии игрока, что выбыл»: выбывшие раньше продолжали
 * занимать слот в круге (с уже неактуальными отношениями), хотя партия для них закончена. */
function diplomacyCircleHtml(): string {
  const others = PLAYERS.filter((p) => p.id !== currentPlayerIndex && !eliminatedPlayers.includes(p.id));
  const slots = diplomacySlotPositions();
  const order: (Player | null)[] = [PLAYERS[currentPlayerIndex], ...others];
  while (order.length < 6) order.push(null);

  // Несколько параллельных линий между одной парой (по прямому запросу — «разреши несколько линий от
  // игрока к игроку, чтоб видеть типы связей между ними») — сдвигаем каждую линию пары перпендикулярно
  // самой связи на свой шаг, симметрично вокруг центра, чтобы 2-3 одновременных соглашения не сливались
  // в одну неразличимую линию.
  const LINE_SPACING = 4;
  // Фиксированное смещение вдоль линии от КАЖДОГО узла (не доля длины) — по прямому запросу «цифры
  // отношения где-то скрываются под кругами игроков»: доля длины (было 22%/78%) у соседних по кругу
  // слотов (короткая хорда) сажала число почти на границу узла. Значки религии/ООН сидят на фиксированных
  // ±14,-14 от центра узла (радиус 8) — их СОБСТВЕННЫЙ внешний край доходит до ~28 от центра в своём
  // направлении (диагональ), и для линии, идущей примерно туда же, отступ должен перекрывать именно
  // это, не только сам кружок игрока (18) — 34 даёт запас с учётом полуширины текста и обводки.
  const LABEL_OFFSET = 34;
  const lines: string[] = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i],
        b = order[j];
      if (!a || !b) continue;
      // По прямому запросу — «щелчок по игроку оставляет только линии выделенного» (не меняет
      // остальное окно): подсветка просто исключает из отрисовки пары, не касающиеся выбранного,
      // сам круг/раскладка узлов остаются как есть.
      if (diplomacyHighlightId !== null && a.id !== diplomacyHighlightId && b.id !== diplomacyHighlightId) continue;
      const p1 = slots[i],
        p2 = slots[j];
      const dx = p2.x - p1.x,
        dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len,
        uy = dy / len;
      const px = -uy,
        py = ux;
      const defs = relationLineDefs(relationOf(a.id, b.id));
      defs.forEach((def, k) => {
        const offset = (k - (defs.length - 1) / 2) * LINE_SPACING;
        const ox = px * offset,
          oy = py * offset;
        lines.push(
          `<line x1="${p1.x + ox}" y1="${p1.y + oy}" x2="${p2.x + ox}" y2="${p2.y + oy}" stroke="${def.color}" stroke-width="${def.width}" stroke-dasharray="${def.dash}"><title>${def.label}</title></line>`
        );
      });
      // Отношения AI — по прямому запросу: числа прямо на линии дипломатии, у СВОЕГО конца — мнение
      // ДРУГОЙ стороны о себе («как ко мне относится сосед», см. СПРАВОЧНИК §8.3) — асимметрично, два
      // разных числа на одной линии. Один раз на пару (не на каждую параллельную линию соглашения) —
      // считается по НЕсмещённым p1/p2, чтобы не плясать по перпендикулярному офсету def'ов.
      const scoreAtA = relationScoreOf(b.id, a.id);
      const scoreAtB = relationScoreOf(a.id, b.id);
      const labelAX = p1.x + ux * LABEL_OFFSET;
      const labelAY = p1.y + uy * LABEL_OFFSET;
      const labelBX = p2.x - ux * LABEL_OFFSET;
      const labelBY = p2.y - uy * LABEL_OFFSET;
      lines.push(
        `<text x="${labelAX}" y="${labelAY}" text-anchor="middle" font-size="7" font-weight="700" fill="#ffd76a" paint-order="stroke" stroke="#0b0e13" stroke-width="2.5"><title>Мнение игрока ${b.name} о ${a.name}</title>${scoreAtA}</text>`,
        `<text x="${labelBX}" y="${labelBY}" text-anchor="middle" font-size="7" font-weight="700" fill="#ffd76a" paint-order="stroke" stroke="#0b0e13" stroke-width="2.5"><title>Мнение игрока ${a.name} о ${b.name}</title>${scoreAtB}</text>`
      );
    }
  }
  const nodes = order
    .map((pl, i) => {
      const pos = slots[i];
      if (!pl) return `<circle cx="${pos.x}" cy="${pos.y}" r="16" fill="none" stroke="#3a4a5f" stroke-dasharray="3 3" />`;
      const isSelf = pl.id === currentPlayerIndex;
      const selected = !isSelf && pl.id === diplomacyHighlightId;
      // Подпись ника под иконкой — у бота (когда AI появится) это будет просто «Игрок N», как и у
      // человека сейчас: имя не хранит отдельного признака человек/бот, показываем как есть.
      const labelY = pos.y > 112 ? pos.y + 30 : pos.y - 24;
      // Значок религии (по прямому запросу) — ОСНОВАТЕЛЬ (religionFounder[R] === этот игрок, историческая
      // роль — остаётся навсегда, даже если сам потом сменил религию, см. doc у religionFounder) получает
      // ЦВЕТНОЙ значок символа ИМЕННО той религии, которую он основал; любой другой игрок с выбранной
      // религией (playerReligion, включая осознанный «Атеизм») — значок ТЕКУЩЕЙ религии, но
      // чёрно-белый (SVG grayscale-фильтр ниже) — не путается со значком основателя на глаз. Ничего не
      // выбрано (null) — вовсе без значка.
      const foundedReligion = (Object.keys(religionFounder) as Religion[]).find((r) => religionFounder[r] === pl.id);
      const badgeReligion = foundedReligion ?? playerReligion[pl.id] ?? null;
      const isFounderBadge = !!foundedReligion;
      const badgeX = pos.x + 14,
        badgeY = pos.y - 14;
      const religionBadge = badgeReligion
        ? `<g${isFounderBadge ? "" : ` filter="url(#dip-grayscale)"`}>
             <circle cx="${badgeX}" cy="${badgeY}" r="8" fill="${isFounderBadge ? "#ffe08a" : "#2a3444"}" stroke="#0b0e13" stroke-width="1.2" />
             <text x="${badgeX}" y="${badgeY + 3.5}" text-anchor="middle" font-size="9">${RELIGION_META[badgeReligion].symbol}</text>
           </g>`
        : "";
      // Значок ООН (по прямому запросу — «убираем оттуда [Гос.управление], оставляя лишь значок
      // председателя по типу значка религии и кандидата») — тот же приём, что и религия (colored для
      // роли/grayscale для «просто причастен»), только противоположный угол узла: действующий генсек
      // — цветной значок; кандидат №1/№2 (эффективный, пока реальный №2 не зафиксирован постройкой),
      // ЕСЛИ он сам сейчас не генсек — серый (уже показан цветным, второй значок не нужен).
      const isOonSecretary = pl.id === oonSecretaryGeneralId;
      const oonEffC2 = oonCandidate2Id ?? oonEffectiveCandidate2Id;
      const isOonCandidate = pl.id === oonCandidate1Id || pl.id === oonEffC2;
      const oonBadgeX = pos.x - 14,
        oonBadgeY = pos.y - 14;
      const oonBadge =
        isOonSecretary || isOonCandidate
          ? `<g${isOonSecretary ? "" : ` filter="url(#dip-grayscale)"`}>
             <circle cx="${oonBadgeX}" cy="${oonBadgeY}" r="8" fill="${isOonSecretary ? "#ffe08a" : "#2a3444"}" stroke="#0b0e13" stroke-width="1.2" />
             <text x="${oonBadgeX}" y="${oonBadgeY + 3.5}" text-anchor="middle" font-size="9">🏛</text>
           </g>`
          : "";
      const oonTitle = isOonSecretary ? "Генеральный секретарь ООН" : isOonCandidate ? "Кандидат в Совет ООН" : "";
      return `
        <g class="dip-node${!isSelf ? " dip-node-clickable" : ""}${selected ? " dip-node-selected" : ""}" ${!isSelf ? `data-player="${pl.id}"` : ""}>
          <title>${playerDiplomacyTooltip(pl.id)}${oonTitle ? `\n🏛 ${oonTitle}` : ""}</title>
          <circle cx="${pos.x}" cy="${pos.y}" r="18" fill="${playerCss(pl.id)}" stroke="${selected ? "#fff" : "#0b0e13"}" stroke-width="${selected ? 3 : 2}" />
          <text x="${pos.x}" y="${pos.y + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="#0b0e13">${pl.id + 1}</text>
          <text x="${pos.x}" y="${labelY}" text-anchor="middle" font-size="10" font-weight="600" fill="#cfe0ff">${pl.name}</text>
          ${religionBadge}
          ${oonBadge}
        </g>`;
    })
    .join("");
  const defsBlock = `<defs><filter id="dip-grayscale"><feColorMatrix type="saturate" values="0" /></filter></defs>`;
  const legend = `
    <div class="dip-legend">
      <span class="dip-legend-item"><span class="dip-legend-swatch" style="background:${RELATION_WAR_COLOR}"></span>Война</span>
      <span class="dip-legend-item"><span class="dip-legend-swatch dip-legend-swatch-dashed"></span>Мир (без соглашений)</span>
      ${AGREEMENTS.map((a) => `<span class="dip-legend-item"><span class="dip-legend-swatch" style="background:${AGREEMENT_LINE_COLOR[a]}"></span>${AGREEMENT_META[a].label}</span>`).join("")}
      <span class="dip-legend-item"><span class="dip-legend-badge">✝</span>Основатель религии (цветной)</span>
      <span class="dip-legend-item"><span class="dip-legend-badge dip-legend-badge-bw">✝</span>Принял религию (ч/б)</span>
    </div>`;
  return `<svg viewBox="0 0 260 256" class="dip-circle">${defsBlock}${lines.join("")}${nodes}</svg>${legend}`;
}

/** Компактная статичная панель под кругом (по прямому запросу — «в целом окно не менялось»): высота
 * не зависит от того, выбран ли игрок — просто текст меняется на заглушку, никакие блоки не
 * появляются/пропадают, в отличие от старого составителя, который раньше жил прямо здесь. Составление
 * самого предложения теперь целиком в отдельной модалке (см. proposalComposeBodyHtml). */
function diplomacyInfoBarHtml(): string {
  const from = currentPlayerIndex,
    to = diplomacyHighlightId;
  if (to === null) {
    return `
      <div class="side-modal-note">Выберите игрока на схеме, чтобы оставить только его линии и увидеть отношения — остальные пары временно скрываются, повторный клик возвращает все.</div>
      <div class="choice-sell-row" style="flex-wrap:wrap">
        <button class="side-modal-action" data-act="open-compose">📨 Отправить предложение</button>
      </div>`;
  }
  const target = PLAYERS[to];
  const rel = relationOf(from, to);
  // Срок перемирия (по прямому запросу) — пока действует, войну объявить нельзя ни явно, ни ультиматумом.
  const truceLeft = rel.truceUntilCycle !== undefined ? rel.truceUntilCycle - cyclesElapsed : 0;
  const truceActive = truceLeft > 0;
  return `
    <div class="side-modal-section">${target.name} — сейчас: ${relationSummary(rel)}${truceActive ? ` · 🕊 перемирие ещё ${truceLeft} цикл(ов)` : ""}</div>
    <div class="side-modal-section">🤝 Отношение: моё к ${target.name} — ${relationScoreOf(from, to)}/100 (${RELATION_TIER_LABEL[relationTierOf(relationScoreOf(from, to))]}); ${target.name} ко мне — ${relationScoreOf(to, from)}/100 (${RELATION_TIER_LABEL[relationTierOf(relationScoreOf(to, from))]})</div>
    <div class="choice-sell-row" style="flex-wrap:wrap">
      <button class="side-modal-action" data-act="war" ${rel.war || truceActive ? "disabled" : ""} ${truceActive ? `title="Действует перемирие ещё ${truceLeft} цикл(ов)"` : ""}>⚔ Объявить войну</button>
      <button class="side-modal-action" data-act="breakoff" style="background:#5a4a2f;border-color:#8a723f">🚫 Прекратить отношения</button>
      <button class="side-modal-action" data-act="open-compose">📨 Отправить предложение</button>
    </div>`;
}

function bindDiplomacyView(extraEl: HTMLDivElement) {
  extraEl.querySelectorAll<HTMLElement>("[data-player]").forEach((el) =>
    el.addEventListener("click", () => {
      const id = +el.dataset.player!;
      // Повторный клик по уже подсвеченному — снять подсветку, вернуть все линии (по прямому запросу).
      diplomacyHighlightId = diplomacyHighlightId === id ? null : id;
      renderRightPanelExtra();
    })
  );
  const act = (sel: string, fn: (el: HTMLElement) => void) =>
    extraEl.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
  act('[data-act="war"]', () => {
    if (diplomacyHighlightId === null) return;
    declareWar(currentPlayerIndex, diplomacyHighlightId);
    renderRightPanelExtra();
  });
  act('[data-act="breakoff"]', () => {
    if (diplomacyHighlightId === null) return;
    breakOffRelations(currentPlayerIndex, diplomacyHighlightId);
    renderRightPanelExtra();
  });
  act('[data-act="open-compose"]', () => openProposalCompose(diplomacyHighlightId));
}

// --- Окно составления предложения — отдельная модалка поверх карты (activeModal "proposal-compose") ---

function composeSubPickerHtml(): string | null {
  if (!composeState || !composeState.pickMode || composeState.to === null) return null;
  const from = currentPlayerIndex,
    to = composeState.to;
  const back = `<button class="market-buy dip-pick-back" data-act="pick-cancel" style="background:#2f4a6b;border-color:#3f6a8a">← Назад</button>`;
  if (composeState.pickMode === "agreement") {
    const rel = relationOf(from, to);
    // Показываем все 6 — не только доступные — недоступные (без технологии или уже действуют)
    // серые и без кнопки, как в Гос. управлении (11.6), а не скрыты вовсе (по прямому запросу).
    // Оборонительный союз нельзя заключить, если ЛЮБАЯ из сторон уже ведёт войну (с кем угодно) —
    // сервер и так это отклонит (см. GameSession.sendProposal), здесь — та же проверка заранее, чтобы
    // серым цветом показать причину сразу, не дожидаясь отказа после отправки.
    const anyWar = (id: number) => PLAYERS.some((p) => p.id !== id && !eliminatedPlayers.includes(p.id) && relationOf(id, p.id).war);
    const rows = AGREEMENTS.map((a) => {
      const already = rel.agreements.has(a);
      const techOk = researchedTechs[from].has(AGREEMENT_META[a].tech);
      const warBlocked = a === "mutualDefense" && (anyWar(from) || anyWar(to));
      const locked = already || !techOk || warBlocked;
      const status = already ? "уже действует" : !techOk ? "🔒 не открыта" : warBlocked ? "⚔ кто-то уже воюет" : "";
      return `
        <div class="unit-pick-row gov-row${locked ? " dip-agreement-locked" : ""}">
          <span class="unit-pick-name">${AGREEMENT_META[a].label}<i>${AGREEMENT_META[a].tech}</i></span>
          ${locked ? `<span class="unit-pick-locked">${status}</span>` : `<button class="unit-pick-build" data-act="add-agreement" data-agreement="${a}">Добавить</button>`}
        </div>`;
    });
    return `${back}<div class="unit-pick-list">${rows.join("")}</div>`;
  }
  if (composeState.pickMode === "money") {
    const amounts = [1, 2, 5, 10, 20, 50];
    return `${back}<div class="choice-sell-row">${amounts.map((a) => `<button class="choice-price" data-act="add-money" data-amount="${a}">${a}💰</button>`).join("")}</div>`;
  }
  if (composeState.pickMode === "peace") {
    // Срок перемирия — 2 до 6 циклов включительно (по прямому запросу).
    const durations = [2, 3, 4, 5, 6];
    return `${back}<div class="side-modal-note">На сколько циклов перемирие? Пока оно действует, ни одна сторона не сможет объявить войну снова.</div><div class="choice-sell-row">${durations.map((d) => `<button class="choice-price" data-act="add-peace" data-duration="${d}">${d} цикл(ов)</button>`).join("")}</div>`;
  }
  if (composeState.pickMode === "city") {
    const ownerId = composeState.pickColumn === "give" ? from : to;
    const list = cities.filter((c) => c.playerId === ownerId);
    return `${back}<div class="unit-pick-list">${
      list.length
        ? list
            .map(
              (c) =>
                `<div class="unit-pick-row gov-row"><span class="unit-pick-name">${cityLabel(c.id)} <i>👥${c.population}</i></span><button class="unit-pick-build" data-act="add-city" data-city="${c.id}">Добавить</button></div>`
            )
            .join("")
        : `<div class="side-modal-note">У ${PLAYERS[ownerId].name} нет городов.</div>`
    }</div>`;
  }
  // resource
  const ownerId = composeState.pickColumn === "give" ? from : to;
  const stock = Object.entries(warehouse[ownerId] ?? {}).filter(([, qty]) => (qty ?? 0) > 0) as [ResourceId, number][];
  return `${back}<div class="unit-pick-list">${
    stock.length
      ? stock
          .map(
            ([id, qty]) =>
              `<div class="unit-pick-row gov-row"><span class="unit-pick-name">${RESOURCE_META.get(id)!.symbol} ${RESOURCE_META.get(id)!.label} <i>×${qty}</i></span><button class="unit-pick-build" data-act="add-resource" data-resource="${id}" data-max="${qty}">+1</button></div>`
          )
          .join("")
      : `<div class="side-modal-note">У ${PLAYERS[ownerId].name} склад пуст.</div>`
  }</div>`;
}

/** По прямому запросу — окно составления: общее поле выбора адресата сверху, под ним две колонки
 * («Я отдаю»/«Я прошу» — однонаправленные условия) плюс общий блок для двусторонних (смена статуса/
 * мир), внизу живая ценность предложения с обеих сторон (formulas ТЗ §8.1) и «Отправить»/«Закрыть». */
function proposalComposeBodyHtml(): string {
  if (!composeState) return "";
  const from = currentPlayerIndex;
  const others = PLAYERS.filter((p) => p.id !== from && !eliminatedPlayers.includes(p.id));
  const selectedTo = composeState.to;
  const recipientSelect = `
    <div class="side-modal-section">Кому адресовано</div>
    <select id="compose-target" class="dip-compose-target">
      <option value="" ${selectedTo === null ? "selected" : ""}>— выберите игрока —</option>
      ${others.map((p) => `<option value="${p.id}" ${selectedTo === p.id ? "selected" : ""}>${p.name}</option>`).join("")}
    </select>`;
  if (composeState.to === null) {
    return `${recipientSelect}<div class="side-modal-note">Сначала выберите адресата.</div><button class="side-modal-action" data-act="close-compose" style="background:#3f4a5a;border-color:#5a6a7a;margin-top:8px">Закрыть</button>`;
  }
  const to = composeState.to;
  const target = PLAYERS[to];
  const sub = composeSubPickerHtml();
  if (sub) return `${recipientSelect}<div class="side-modal-section">${target.name} — выбор для условия</div>${sub}`;

  const termRow = (t: ProposalTerm, i: number, col: "give" | "request" | "shared") =>
    `<div class="unit-pick-row gov-row"><span class="unit-pick-name">${termLabel(t, from, to)}</span><button class="unit-pick-locked dip-term-remove" data-col="${col}" data-i="${i}" title="Убрать">✕</button></div>`;

  const sharedHtml = composeState.shared.length ? `<div class="unit-pick-list">${composeState.shared.map((t, i) => termRow(t, i, "shared")).join("")}</div>` : "";
  const rel = relationOf(from, to);
  const total = composeAllTerms(composeState).length;

  return `
    ${recipientSelect}
    <div class="side-modal-section">🤝 Отношение: моё к ${target.name} — ${relationScoreOf(from, to)}/100 (${RELATION_TIER_LABEL[relationTierOf(relationScoreOf(from, to))]}); ${target.name} ко мне — ${relationScoreOf(to, from)}/100 (${RELATION_TIER_LABEL[relationTierOf(relationScoreOf(to, from))]})</div>
    <div class="side-modal-section">Совместные условия</div>
    <div class="choice-sell-row" style="flex-wrap:wrap">
      ${!rel.war ? `<button class="choice-play" data-act="pick-agreement">🤝 Сменить статус</button>` : `<button class="choice-play" data-act="pick-peace">🕊 Заключить мир</button>`}
    </div>
    ${sharedHtml}
    <div class="dip-compose-columns">
      <div class="dip-compose-col">
        <div class="side-modal-section">Я отдаю</div>
        <div class="choice-sell-row" style="flex-wrap:wrap">
          <button class="choice-play" data-act="pick-money" data-col="give">💰 Деньги</button>
          <button class="choice-play" data-act="pick-resource" data-col="give">📦 Ресурс</button>
          <button class="choice-play" data-act="pick-city" data-col="give">🏙 Город</button>
        </div>
        ${composeState.give.length ? `<div class="unit-pick-list">${composeState.give.map((t, i) => termRow(t, i, "give")).join("")}</div>` : `<div class="side-modal-note">Пока ничего.</div>`}
      </div>
      <div class="dip-compose-col">
        <div class="side-modal-section">Я прошу</div>
        <div class="choice-sell-row" style="flex-wrap:wrap">
          <button class="choice-play" data-act="pick-money" data-col="request">💰 Деньги</button>
          <button class="choice-play" data-act="pick-resource" data-col="request">📦 Ресурс</button>
          <button class="choice-play" data-act="pick-city" data-col="request">🏙 Город</button>
        </div>
        ${composeState.request.length ? `<div class="unit-pick-list">${composeState.request.map((t, i) => termRow(t, i, "request")).join("")}</div>` : `<div class="side-modal-note">Пока ничего.</div>`}
      </div>
    </div>
    <div class="side-modal-section">
      <label class="dip-ultimatum-label"><input type="checkbox" id="dip-ultimatum" ${composeState.ultimatum ? "checked" : ""}> ⚠ Ультиматум — отказ означает войну</label>
    </div>
    <div class="side-modal-section">Ценность предложения</div>
    <div class="dip-value-summary">
      <span>Мне: <b class="${valueClass(composeValuePreview?.mine)}">${total ? valueLabel(composeValuePreview?.mine) : "—"}</b></span>
      <span>${target.name}: <b class="${valueClass(composeValuePreview?.theirs)}">${total ? valueLabel(composeValuePreview?.theirs) : "—"}</b></span>
    </div>
    <div class="choice-sell-row" style="margin-top:8px">
      <button class="side-modal-action" data-act="send" ${total ? "" : "disabled"}>📨 Отправить</button>
      <button class="side-modal-action" data-act="close-compose" style="background:#3f4a5a;border-color:#5a6a7a">Закрыть</button>
    </div>
  `;
}

function bindProposalComposeModal(backdrop: HTMLElement) {
  if (!composeState) return;
  backdrop.querySelector<HTMLSelectElement>("#compose-target")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    composeState!.to = v === "" ? null : +v;
    composeState!.pickMode = null;
    composeState!.pickColumn = null;
    refreshComposeAndRender();
  });
  const act = (sel: string, fn: (el: HTMLElement) => void) => backdrop.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
  act('[data-act="pick-agreement"]', () => {
    composeState!.pickMode = "agreement";
    renderModal();
  });
  act('[data-act="pick-peace"]', () => {
    composeState!.pickMode = "peace";
    renderModal();
  });
  act('[data-act="pick-money"]', (el) => {
    composeState!.pickMode = "money";
    composeState!.pickColumn = el.dataset.col as "give" | "request";
    renderModal();
  });
  act('[data-act="pick-resource"]', (el) => {
    composeState!.pickMode = "resource";
    composeState!.pickColumn = el.dataset.col as "give" | "request";
    renderModal();
  });
  act('[data-act="pick-city"]', (el) => {
    composeState!.pickMode = "city";
    composeState!.pickColumn = el.dataset.col as "give" | "request";
    renderModal();
  });
  act('[data-act="pick-cancel"]', () => {
    composeState!.pickMode = null;
    composeState!.pickColumn = null;
    renderModal();
  });
  act('[data-act="add-agreement"]', (el) => {
    composeState!.shared.push({ kind: "agreement", agreement: el.dataset.agreement as Agreement });
    composeState!.pickMode = null;
    refreshComposeAndRender();
  });
  act('[data-act="add-peace"]', (el) => {
    composeState!.shared.push({ kind: "peace", duration: +el.dataset.duration! });
    composeState!.pickMode = null;
    refreshComposeAndRender();
  });
  act('[data-act="add-money"]', (el) => {
    const amount = +el.dataset.amount!;
    const col = composeState!.pickColumn!;
    (col === "give" ? composeState!.give : composeState!.request).push(col === "give" ? { kind: "offerMoney", amount } : { kind: "demandMoney", amount });
    composeState!.pickMode = null;
    composeState!.pickColumn = null;
    refreshComposeAndRender();
  });
  act('[data-act="add-city"]', (el) => {
    const cityId = +el.dataset.city!;
    const col = composeState!.pickColumn!;
    (col === "give" ? composeState!.give : composeState!.request).push(col === "give" ? { kind: "giveCity", cityId } : { kind: "demandCity", cityId });
    composeState!.pickMode = null;
    composeState!.pickColumn = null;
    refreshComposeAndRender();
  });
  act('[data-act="add-resource"]', (el) => {
    const resource = el.dataset.resource as ResourceId;
    const max = +el.dataset.max!;
    const col = composeState!.pickColumn!;
    const arr = col === "give" ? composeState!.give : composeState!.request;
    const kind = col === "give" ? "giveResource" : "demandResource";
    const existing = arr.find((t) => t.kind === kind && (t as { resource: ResourceId }).resource === resource) as
      | Extract<ProposalTerm, { kind: "giveResource" | "demandResource" }>
      | undefined;
    if (existing) {
      if (existing.qty < max) existing.qty++;
    } else {
      arr.push({ kind, resource, qty: 1 } as ProposalTerm);
    }
    composeState!.pickMode = null;
    composeState!.pickColumn = null;
    refreshComposeAndRender();
  });
  backdrop.querySelectorAll<HTMLButtonElement>(".dip-term-remove").forEach((btn) =>
    btn.addEventListener("click", () => {
      const col = btn.dataset.col as "give" | "request" | "shared";
      composeState![col].splice(+btn.dataset.i!, 1);
      refreshComposeAndRender();
    })
  );
  backdrop.querySelector<HTMLInputElement>("#dip-ultimatum")?.addEventListener("change", (e) => {
    composeState!.ultimatum = (e.target as HTMLInputElement).checked;
  });
  act('[data-act="close-compose"]', () => closeProposalCompose());
  act('[data-act="send"]', async () => {
    if (!composeState || composeState.to === null) return;
    const terms = composeAllTerms(composeState);
    if (!terms.length) return;
    const to = composeState.to,
      ultimatum = composeState.ultimatum;
    const targetName = PLAYERS[to].name;
    closeProposalComposeUiOnly();
    // Хинт «отправлено» — только по факту реального успеха (см. sendProposal) — раньше писался
    // сразу, не дожидаясь ответа сервера, из-за чего отклонённое предложение (например «не ваш
    // ход») выглядело отправленным, а получатель его так и не видел.
    const ok = await sendProposal(currentPlayerIndex, to, terms, ultimatum);
    if (ok) setHint(`Предложение отправлено ${targetName} — решение придёт в начале его хода.`);
    // Только ПОСЛЕ ответа сервера возвращаем игрока к исходному предложению, если оно (при
    // редактировании через «Редактировать») всё ещё висит нерешённым — иначе старое окно с
    // Принять/Отклонить выскакивало раньше любого подтверждения, что встречное вообще ушло.
    checkPendingProposalsForCurrentPlayer();
    checkPendingOonVoteForCurrentPlayer();
    checkPendingOonSecretaryVoteForCurrentPlayer();
  });
}

/** Только UI-часть закрытия составителя, без побочного «вернуть игрока к ещё не решённому входящему
 * предложению» — нужна отдельно от closeProposalCompose для обработчика «Отправить»: там нельзя
 * переоткрывать старое предложение ДО того, как пришёл ответ сервера на встречное (иначе игрок видит
 * старое окно раньше любого подтверждения, что правка вообще ушла — см. checkPendingProposalsForCurrentPlayer
 * вызов после await sendProposal в обработчике send). */
function closeProposalComposeUiOnly() {
  composeState = null;
  composeValuePreview = null;
  activeModal = null;
  renderModal();
}

/** Закрывает составитель (кнопкой «Закрыть») — тем же паттерном, что closeModal для остальных
 * модалок: если составитель был открыт ПОВЕРХ ещё не решённого входящего предложения (кнопка
 * «Редактировать», см. openProposalComposeFromIncoming — само предложение при этом не трогалось),
 * после закрытия сразу проверяем очередь и возвращаем игрока к нему, а не к пустому экрану под ним. */
function closeProposalCompose() {
  closeProposalComposeUiOnly();
  checkPendingProposalsForCurrentPlayer();
  checkPendingOonVoteForCurrentPlayer();
  checkPendingOonSecretaryVoteForCurrentPlayer();
}

function renderRightPanelExtra() {
  const cityListEl = document.querySelector<HTMLDivElement>("#city-list");
  const warehouseEl = document.querySelector<HTMLDivElement>("#warehouse-panel");
  const extraEl = document.querySelector<HTMLDivElement>("#right-panel-extra");
  if (!cityListEl || !warehouseEl || !extraEl) return;
  const showResources = rightPanelView === "resources";
  cityListEl.style.display = showResources ? "" : "none";
  warehouseEl.style.display = showResources ? "" : "none";
  extraEl.style.display = showResources ? "none" : "flex";
  if (showResources) {
    extraEl.innerHTML = "";
    return;
  }

  if (rightPanelView === "market") {
    const rowLabel = (l: MarketListing) =>
      l.kind === "card" ? `${l.card.kind === "event" ? "⚡" : "🂠"} ${l.card.label}` : `${RESOURCE_META.get(l.resource)!.symbol} ${RESOURCE_META.get(l.resource)!.label}`;
    const sellerName = (id: number) => (id === WORLD_SELLER ? "Мировой рынок" : PLAYERS[id].name);
    const sellerColor = (id: number) => (id === WORLD_SELLER ? "#8fa3b8" : playerCss(id));
    const sorted = market.slice().sort((a, b) => a.price - b.price); // дешёвые сверху
    extraEl.innerHTML = `
      <div class="side-modal-head">Рынок</div>
      <div class="side-modal-note">Видимость «только торговая сеть или сосед» ещё не реализована — показаны все объявления всех игроков. Мировой рынок — тестовый посев по 1 единице каждого ресурса, цена 1.</div>
      <div class="market-list">
        ${
          sorted.length
            ? sorted
                .map(
                  (l) => `
              <div class="market-row">
                <span class="market-card">${rowLabel(l)}</span>
                <span class="market-seller" style="color:${sellerColor(l.sellerId)}">${sellerName(l.sellerId)}</span>
                <span class="market-price">${l.price} 💰</span>
                ${
                  l.sellerId === currentPlayerIndex
                    ? l.kind === "card"
                      ? `<button class="market-cancel" data-id="${l.id}">Отменить</button>`
                      : `<span class="market-own">ваш лот</span>`
                    : `<button class="market-buy" data-id="${l.id}">Купить</button>`
                }
              </div>`
                )
                .join("")
            : `<div class="market-empty">Пока ничего не выставлено</div>`
        }
      </div>`;
    extraEl.querySelectorAll<HTMLButtonElement>(".market-buy").forEach((btn) =>
      btn.addEventListener("click", () => buyListing(+btn.dataset.id!))
    );
    extraEl.querySelectorAll<HTMLButtonElement>(".market-cancel").forEach((btn) =>
      btn.addEventListener("click", () => cancelCardListing(+btn.dataset.id!))
    );
  } else if (rightPanelView === "diplomacy") {
    extraEl.innerHTML = `
      <div class="side-modal-head">Дипломатия</div>
      ${diplomacyCircleHtml()}
      ${diplomacyInfoBarHtml()}`;
    bindDiplomacyView(extraEl);
  } else if (rightPanelView === "government") {
    const player = PLAYERS[currentPlayerIndex];
    const myCities = cities.filter((c) => c.playerId === player.id);
    const totalPop = myCities.reduce((s, c) => s + c.population, 0);
    const upkeep = unitsAndBuildingsUpkeep(player.id);
    const netIncome = tradeNetworkIncomePerResource(player.id);
    const popRace = populationRace();
    const cityRace = citiesRace();
    const spcRace = spaceRace();

    const paradigmRow = (p: Paradigm) => {
      const meta = PARADIGM_META[p];
      const eligible = canAdoptParadigm(player.id, p);
      const active = playerParadigm[player.id] === p;
      return `
        <div class="unit-pick-row gov-row${active ? " unit-pick-active" : ""}">
          <span class="unit-pick-name">${meta.label} <i>${meta.tech}, Э${meta.epoch}</i></span>
          ${active ? `<span class="unit-pick-locked">текущая</span>` : eligible ? `<button class="unit-pick-build" data-paradigm="${p}">Выбрать</button>` : `<span class="unit-pick-locked">🔒 не открыта</span>`}
          <span class="gov-row-desc">${meta.effect}</span>
        </div>`;
    };

    // Наведя на религию, игрок видит основателя и статистику последователей — в title, а не
    // инлайн-текстом, чтобы сэкономить место в узкой правой панели (пожелание пользователя).
    const religionRow = (r: Religion) => {
      const meta = RELIGION_META[r];
      const active = playerReligion[player.id] === r;
      const founderId = religionFounder[r];
      const founded = founderId !== undefined;
      let title = founderId === player.id ? "Вы основатель этой религии." : founded ? `Основал(а): ${PLAYERS[founderId].name}.` : "Ещё никем не основана.";
      if (founderId === player.id && r !== "atheism") {
        const stats = religionFollowerStats(r);
        title += ` Принявших: ${stats.players} игрок(ов), городов ${stats.cities}, населения ${stats.population}.`;
      }
      // По прямому уточнению — «нужно провести грань между Открыть религию (первооткрыватель
      // Мистицизма) и Принять уже открытую (кто угодно)»: ещё не основанную религию видно, но
      // разыграть может только личный первооткрыватель технологии, остальным — заблокировано.
      const canFound = founded || canFoundReligion(player.id, r);
      const action = active
        ? `<span class="unit-pick-locked">текущая</span>`
        : !canFound
          ? `<span class="unit-pick-locked">🔒 не основана</span>`
          : `<button class="unit-pick-build" data-religion="${r}">${founded ? "Принять" : "Открыть"}</button>`;
      return `
        <div class="unit-pick-row gov-row${active ? " unit-pick-active" : ""}" title="${title}">
          <span class="unit-pick-name">${meta.label}</span>
          ${action}
        </div>`;
    };

    extraEl.innerHTML = `
      <div class="side-modal-head">Гос. управление</div>
      <div class="side-modal-note">Смена парадигмы (в т.ч. самая первая) пропускает следующий ход этого игрока (11.6).</div>

      <div class="side-modal-section">Политическая парадигма — сейчас: ${playerParadigm[player.id] ? PARADIGM_META[playerParadigm[player.id]!].label : "не выбрана"}</div>
      <div class="unit-pick-list">${PARADIGMS.map(paradigmRow).join("")}</div>

      ${
        playerParadigm[player.id] === "communism"
          ? `<div class="side-modal-section">Коммунизм — доп. город (сверх столицы)</div>
      <div class="side-modal-note">
        Сейчас: ${
          communismExtraCityId[player.id] !== undefined
            ? (() => {
                const c = cities.find((x) => x.id === communismExtraCityId[player.id]);
                return c ? `город (${c.col},${c.row})` : `город #${communismExtraCityId[player.id]}`;
              })()
            : "не выбран"
        } — его добываемые ресурсы тоже пополняют склад каждый цикл, вдобавок к столице (не вместо).
        <button class="unit-pick-build" id="gov-pick-communism-city" ${myCities.filter((c) => !c.isCapital).length ? "" : "disabled"}>${communismExtraCityId[player.id] !== undefined ? "Сменить" : "Выбрать"}</button>
      </div>`
          : ""
      }

      <div class="side-modal-section">Религия — сейчас: ${playerReligion[player.id] ? RELIGION_META[playerReligion[player.id]!].label : "не выбрана"}</div>
      <div class="unit-pick-list">${RELIGIONS.map(religionRow).join("")}</div>

      <div class="side-modal-section">Бонусы от открытий</div>
      <div class="unit-pick-list">${DISCOVERY_BONUSES.map((b) => discoveryBonusRow(b, player.id)).join("")}</div>

      <div class="side-modal-section">Ваша страна</div>
      <div class="side-modal-note">
        Городов: ${myCities.length}/${MAX_CITIES} · Население всего: ${totalPop}<br>
        ${myCities.map((c, i) => `Город ${i + 1}: 👥${c.population}`).join(" · ") || "городов нет"}<br>
        Войск: ${upkeep.units} · Зданий: ${upkeep.buildings} · Содержание при налогах: ${upkeep.totalUpkeep} 💰<br>
        Доход торговой сети за 1 уникальный ресурс: ${netIncome} 💰
      </div>

      <div class="side-modal-section">Партия</div>
      <div class="side-modal-note">
        Ходов до конца: ${turnsRemaining} (по умолчанию 60)<br>
        Население планеты: лидер ${PLAYERS[popRace.leaderId].name} — ${popRace.leaderPop} из ${popRace.totalPop} (${popRace.sharePercent}%, победа считается от 50%)<br>
        Города: лидер ${PLAYERS[cityRace.leaderId].name} — ${cityRace.leaderCities} из ${MAX_CITIES + 1}<br>
        Выход в космос: лидер ${PLAYERS[spcRace.leaderId].name} — ${spcRace.leaderComponents} из ${SPACE_VICTORY_COMPONENTS}<br>
        Лесов на своей территории: ${ownForestCount(player.id)}
      </div>

      <div class="side-modal-section">Стратегия ИИ (справочно — ИИ-игроков в клиенте нет)</div>
      <ul class="info-list">${AI_VICTORY_STRATEGIES.map((x) => `<li>${x}</li>`).join("")}</ul>`;
    extraEl.querySelectorAll<HTMLButtonElement>("[data-paradigm]").forEach((btn) =>
      btn.addEventListener("click", () => {
        adoptParadigm(player.id, btn.dataset.paradigm as Paradigm);
        renderRightPanelExtra();
        updateHint();
      })
    );
    extraEl.querySelectorAll<HTMLButtonElement>("[data-religion]").forEach((btn) =>
      btn.addEventListener("click", () => {
        adoptReligion(player.id, btn.dataset.religion as Religion);
        renderRightPanelExtra();
      })
    );
    extraEl.querySelector<HTMLButtonElement>("#gov-pick-communism-city")?.addEventListener("click", () => {
      pendingCommunismCityPick = true;
      closeModal();
      renderCityList();
      updateHint();
    });
  }
}

// Close on backdrop click (outside the panel), not on clicks inside it.
document.querySelector<HTMLDivElement>("#side-modal-backdrop")!.addEventListener("click", (e) => {
  if (e.currentTarget === e.target) closeModal();
});

function updateHint() {
  const player = PLAYERS[currentPlayerIndex];
  if (mustHandoff.has(currentPlayerIndex)) {
    setHint(`${player.name}: обязательная передача карты (ТЗ 2.3) — пока не отдадите 1 карту другому игроку, любую ДРУГУЮ карту сыграть нельзя (клик по карте откроет передачу, не розыгрыш). Остальные действия — юниты, дипломатия, здания, парадигма/религия, конец хода — по-прежнему доступны.`);
  } else if (pendingTaxShortfall) {
    setHint(`${PLAYERS[pendingTaxShortfall.playerId].name}: недоимка — спишите ещё ${pendingTaxShortfall.remaining} юнит(ов)/здани(й), отменить нельзя.`);
  } else if (pendingRouteIsMine()) {
    setHint(
      pendingRouteFromCityId === null
        ? `${PLAYERS[pendingRoute!.playerId].name}: выберите первый город для маршрута «${pendingRoute!.techId}». Esc — отмена.`
        : `${PLAYERS[pendingRoute!.playerId].name}: выберите второй город (≤12 гексов, без смешения суши/моря). Esc — отмена.`
    );
  } else if (pendingRouteRedirect) {
    setHint(
      pendingRouteRedirect.routeId === null
        ? "Выберите город на карте или в списке, куда идёт торговый путь для перенаправления. Esc — отмена."
        : "Выберите новый город (любой, даже чужой — маршрут перейдёт его владельцу). Esc — отмена."
    );
  } else if (pendingTradeRouteNew) {
    setHint(
      pendingTradeRouteNew.fromCityId === null
        ? "Выберите свой город — первый конец нового торгового пути. Esc — отмена."
        : "Выберите второй город (свой или чужой) для нового торгового пути. Esc — отмена."
    );
  } else if (pendingTradeRouteDelete) {
    setHint("Выберите город на карте или в списке, куда идёт торговый путь для удаления. Esc — отмена.");
  } else if (pendingCommunismCityPick) {
    setHint("Коммунизм: выберите свой НЕстоличный город на карте или в списке — доп. источник ресурсов. Esc — отмена.");
  } else if (phase === "placement") {
    const value = nextTokenValueFor(player.id);
    setHint(`${player.name}: кликните обитаемый регион на карте — туда встанет жетон ${value}.`);
  } else if (pendingCardAction?.kind === "settler-found") {
    setHint("Кликните гекс на карте, где основать поселение — регион должен примыкать к вашему городу и быть свободным. Esc — отмена.");
  } else if (pendingCardAction?.kind === "forest-plant") {
    setHint("Кликните гекс Равнины/Холмов без леса в своём регионе, чтобы посадить лес (2 пищевых ресурса). Esc — отмена.");
  } else if (pendingCardAction?.kind === "gene-grow") {
    const meta = RESOURCE_META.get(pendingCardAction.resource)!;
    setHint(`Кликните пустой гекс своей территории (${meta.requiresWater ? "открытая вода" : "суша"}), чтобы вырастить «${meta.label}». Esc — отмена.`);
  } else if (pendingCardAction?.kind === "settler-grow") {
    setHint("Выберите свой город на карте или в списке городов справа, чтобы увеличить население. Esc — отмена.");
  } else if (pendingCardAction?.kind === "warrior-city" || pendingCardAction?.kind === "kazarma-city") {
    setHint("Выберите свой город на карте или в списке городов справа, чтобы построить юнит. Esc — отмена.");
  } else if (pendingCardAction?.kind === "warrior-money-city") {
    setHint("Выберите свой город на карте или в списке городов справа, чтобы купить юнита за деньги (население города −1). Esc — отмена.");
  } else if (pendingCardAction?.kind === "worker-city") {
    setHint("Выберите свой город на карте или в списке городов справа, чтобы собрать регион на склад. Esc — отмена.");
  } else if (pendingCardAction?.kind === "worker-mine") {
    setHint(`Кликните гекс Равнины без ресурса в своём регионе, чтобы добыть 1 ${RESOURCE_META.get(pendingCardAction.resource)?.label ?? pendingCardAction.resource} (гекс превратится в Пустыню, необратимо). Esc — отмена.`);
  } else if (pendingCardAction?.kind === "builder-chop") {
    setHint("Кликните гекс с лесом на своей территории, чтобы вырубить его (1 еда → 2 Леса). Esc — отмена.");
  } else if (pendingCardAction?.kind === "sklad-collect") {
    setHint("Выберите свой город на карте или в списке городов справа — Склад добудет регион за деньги. Esc — отмена.");
  } else if (pendingCardAction?.kind === "builder-select") {
    setHint("Кликните свободное здание в панели застройки слева, чтобы построить его. Esc — отмена.");
  } else if (pendingCardAction?.kind === "trader-city") {
    setHint("Выберите свой город на карте или в списке городов справа — Торговец пройдётся по всей вашей торговой сети. Esc — отмена.");
  } else {
    setHint(`${player.name}: сыграйте карту (действий осталось: ${actionsLeft[player.id]}) или завершите ход.`);
  }
}

// --- Bottom bar: phase-dependent content ---

/** Обзор хода AI — компактный блок в ТРИ КОРОТКИХ строки, полное объяснение — в подсказке при
 * наведении (по прямому запросу — сначала «три строки: приоритет / регион напряжения (атаки или
 * обороны) / игрок и ресурс (или всё хватает)», ЗАТЕМ уточнение: «выведи нормальное полное описание
 * при наведении, а то куча текста не влазит, да и зачем полностью писать регион — можно короче» —
 * видимый текст поэтому сведён до иконки+числа/имени, а связный текст — только в `title`):
 * 1. Метка режима (`STRATEGIC_PRIORITY_LABELS`, уже короткая сама по себе).
 * 2. Регион напряжения — иконка ⚔ (атака, регион цели плана/дипломатии) или 🛡 (оборона, приграничный
 *    регион наибольшего скопления чужих юнитов, `borderThreat`, в режиме «Оборона») + координаты
 *    1-based; нет ни того ни другого — «–».
 * 3. Цель — иконка 🎯 (формальный план)/🧭 (только кандидат дипломатии, отношения ещё нормальные) +
 *    имя игрока, либо «✓ ресурсов хватает». */
function strategicOverviewHtml(mode: StrategicPriority, warPlan: PendingWarPlanInfo | null | undefined, borderThreat: PendingBorderThreatInfo | null | undefined): string {
  const useDefenseRegion = mode === "defense" && !!borderThreat;
  const regionSource = useDefenseRegion ? borderThreat! : warPlan ?? borderThreat ?? null;
  const isDefenseRegion = useDefenseRegion || (!warPlan && !!borderThreat);
  const regionShort = regionSource ? `${isDefenseRegion ? "🛡" : "⚔"} ${regionSource.regionCol + 1}.${regionSource.regionRow + 1}` : "–";
  const regionFull = regionSource ? `Регион напряжения ${isDefenseRegion ? "обороны" : "атаки"}: ${regionSource.regionCol + 1}.${regionSource.regionRow + 1}` : "Регион напряжения: нет";

  let targetShort: string;
  let targetFull: string;
  let targetColor = "#4a6a94";
  if (warPlan) {
    const target = PLAYERS.find((p) => p.id === warPlan.targetPlayerId);
    const name = target?.name ?? "?";
    targetColor = target ? `#${target.color.toString(16).padStart(6, "0")}` : "#ffd979";
    const resourceLabel = warPlan.cause === "resourceShortage" ? RESOURCES.find((r) => r.id === warPlan.resource)?.label ?? warPlan.resource ?? "?" : null;
    const reasonFull = resourceLabel ? `нехватка «${resourceLabel}»` : "экспансия — свободная территория";
    const navyNote = warPlan.requiresNavy ? " (нужен флот)" : "";
    const icon = warPlan.isFormalPlan ? "🎯" : "🧭";
    targetShort = `${icon} <span class="name">${name}</span>`;
    targetFull = `${warPlan.isFormalPlan ? "Цель «Плана войны»" : "Текущая цель дипломатии (план ещё не заведён)"}: игрок ${name} — ${reasonFull}${navyNote}`;
  } else {
    targetShort = "✓ ресурсов хватает";
    targetFull = "Ресурсов достаточно — цели для войны/экспансии сейчас нет.";
  }

  const title = `${STRATEGIC_PRIORITY_DESCRIPTIONS[mode]}\n${regionFull}\n${targetFull}`.replace(/"/g, "&quot;");
  return `<div class="strategic-overview" style="--target-color:${targetColor}" title="${title}">
    <div class="line priority">${STRATEGIC_PRIORITY_LABELS[mode]}</div>
    <div class="line region">${regionShort}</div>
    <div class="line target">${targetShort}</div>
  </div>`;
}

/** Face-down deck, drawn immediately left of the hand — cards come off it and return under it.
 * Рубашка цветом ТЕКУЩЕГО игрока (по прямому запросу — «непонятно, какого цвета игрока ход»).
 * `clickable` (по прямому запросу — «получить карту за действие с колоды, нажать на колоду») —
 * добавляет наводимый курсор/подсказку; сам клик вешается снаружи (см. renderBottomBar), это только
 * визуальный признак «можно нажать» — доступность и в placement-фазе, где `clickable` всегда false,
 * колода не кликабельна вовсе. */
function deckPileHtml(playerColor: number, clickable = false): string {
  const hex = "#" + playerColor.toString(16).padStart(6, "0");
  const title = clickable ? ' title="Взять карту с колоды за 1 действие"' : "";
  return `
  <div class="deck-pile${clickable ? " deck-pile--clickable" : ""}" id="deck-pile" style="--deck-color:${hex}"${title}>
    <div class="deck-card"></div>
    <div class="deck-card"></div>
    <div class="deck-card deck-card-top"><span id="deck-count"></span></div>
  </div>`;
}

function renderBottomBar() {
  const bar = document.querySelector<HTMLDivElement>("#bottom-bar")!;
  const myWegoId = net.myWeGoPlayer();
  if (phase === "placement") {
    // WeGo: расстановка остаётся последовательной и общей, как в хотсите (§16 СПРАВОЧНИКА) —
    // currentPlayerIndex здесь НЕ переопределён (см. updateMirrorFrom, override только для
    // "playing"), так что это настоящий текущий игрок. Если это не я — интерактивная панель
    // показала бы жетон, который сервер всё равно отклонит ("Сейчас не ваш ход") — вместо этого
    // короткая заглушка ожидания, тот же визуальный паттерн, что и «Ход соперника» ниже.
    if (myWegoId !== null && currentPlayerIndex !== myWegoId) {
      const waitingFor = PLAYERS[currentPlayerIndex];
      bar.className = "bottom-bar bottom-bar--watching";
      bar.innerHTML = `<div class="ai-turn-watch"><span class="ai-turn-watch-icon">⏳</span><span>Ждём — ${waitingFor?.name ?? "?"} расставляет жетоны…</span></div>`;
      updateDeckCount();
      return;
    }
    const player = PLAYERS[currentPlayerIndex];
    const value = nextTokenValueFor(player.id);
    bar.className = "bottom-bar placement-mode";
    bar.innerHTML = `
      <div class="placement-panel">
        <div class="player-indicator" style="color:#${player.color.toString(16).padStart(6, "0")}">${player.name}</div>
        <div class="next-token-badge">Следующий жетон: <b style="color:#${player.color.toString(16).padStart(6, "0")}">${value}</b></div>
      </div>
      <div class="hand-zone">${deckPileHtml(player.color)}</div>
      <div></div>
    `;
  } else {
    const player = PLAYERS[currentPlayerIndex];
    const isAiTurn = !!player.isAI;

    // «Против AI» (по прямому запросу — «игрок не видит как ходит ИИ... ходы применяются сами, с
    // небольшой задержкой имитируя игрока») — пока сервер сам доигрывает ход AI (driveAiTurns/
    // playAiTurnPaced), его рука/раздача/действия/деньги вообще не отрисовываются, только заглушка;
    // карта продолжает жить как обычно (юниты/города видно всем — это открытая часть партии).
    if (autoPlayAI && isAiTurn) {
      bar.className = "bottom-bar bottom-bar--watching";
      bar.innerHTML = `<div class="ai-turn-watch"><span class="ai-turn-watch-icon">🤖</span><span>Ход соперника — ${player.name}…</span></div>`;
      updateDeckCount();
      return;
    }

    // WeGo: план этого раунда уже сдан (кнопка «Завершить ход» = closeRound+readyForRound, см.
    // onPlayingEndTurn) — своя рука больше не показывается (сервер её всё равно уже не примет,
    // "План этого раунда уже сдан"), только ожидание резолюции (остальные игроки/раундовый таймер).
    if (myWegoId !== null && wegoPlanSubmitted) {
      bar.className = "bottom-bar bottom-bar--watching";
      bar.innerHTML = `<div class="ai-turn-watch"><span class="ai-turn-watch-icon">⏳</span><span>План сдан — ждём остальных игроков…</span>${wegoRoundTimerHtml()}</div>`;
      updateDeckCount();
      startWegoTimerTicker();
      return;
    }

    // Хотсит с AI за столом (по прямому запросу — «AI пока не перематывает сам, все ходы совершаются
    // после кнопки завершить ход, игрок видит ходы ИИ как сейчас реализовано») — та же кнопка
    // меняет назначение: вместо endTurn подтверждает (и только тогда РЕАЛЬНО совершает) уже
    // посчитанный и показанный предпросмотр (pendingAiPlan, см. renderAiPlanOverlay). planReady
    // почти всегда true, как только currentPlayerIndex указал на AI — план считается на сервере
    // синхронно ДО рассылки состояния тем же снимком; на случай рассинхрона кнопка при отсутствии
    // плана просто неактивна, а не шлёт заведомо отказанное действие.
    const planReady = isAiTurn && pendingAiPlan?.playerId === player.id;
    // Добор с колоды (по прямому запросу) — кликом по колоде, только на своём ходу (не в превью хода
    // AI), пока рука ПОЛНОСТЬЮ пуста и есть хоть 1 действие; сервер (GameSession.drawCardFromDeck)
    // проверяет то же самое ещё раз — здесь только визуальный признак и обработчик клика.
    const canDrawFromDeck = !isAiTurn && (hands[player.id]?.length ?? 0) === 0 && actionsLeft[player.id] > 0;
    bar.className = "bottom-bar";
    bar.innerHTML = `
      <div class="action-counter">
        <div class="turn-number" title="Всего ходов в партии: ${maxTurns}">${myWegoId !== null ? "Раунд" : "Ход"} ${maxTurns - turnsRemaining + 1}</div>
        <div class="label">Действия</div>
        <div class="pips" id="action-pips"></div>
        ${myWegoId !== null ? wegoRoundTimerHtml() : ""}
      </div>
      <div class="hand-zone">
        ${planReady && pendingAiPlan ? strategicOverviewHtml(pendingAiPlan.strategicPriority, pendingAiPlan.warPlan, pendingAiPlan.borderThreat) : ""}
        ${deckPileHtml(player.color, canDrawFromDeck)}
        <div class="card-slots" id="card-slots"></div>
        <div class="money-card" id="money-card"></div>
      </div>
      ${
        isAiTurn
          ? `<button class="end-turn-btn ai-confirm-btn" id="end-turn-btn" ${planReady ? "" : "disabled"}><span class="icon">🤖</span>${planReady ? "Подтвердить ход AI" : "Просчитываю ход AI…"}</button>`
          : `<button class="end-turn-btn" id="end-turn-btn"><span class="icon">⏭</span>${myWegoId !== null ? "Готово — сдать план раунда" : "Завершить ход"}</button>`
      }
    `;
    renderHand();
    renderActionPips();
    renderMoneyCard();
    document.querySelector("#end-turn-btn")!.addEventListener("click", isAiTurn ? confirmAiTurn : onPlayingEndTurn);
    if (myWegoId !== null) startWegoTimerTicker();
    if (canDrawFromDeck) document.querySelector("#deck-pile")!.addEventListener("click", drawCardFromDeck);
  }
  updateDeckCount(); // the counter lives inside the markup above, so fill it in afterwards
}

/** Разметка таймера раунда — сам текст обновляется отдельным `setInterval` (см.
 * startWegoTimerTicker), чтобы не перерисовывать всю нижнюю панель каждую секунду. */
function wegoRoundTimerHtml(): string {
  return `<div class="wego-round-timer" id="wego-round-timer" title="Дедлайн текущего раунда">⏱ …</div>`;
}

/** Обновляет #wego-round-timer раз в секунду, пока элемент существует в DOM (renderBottomBar
 * пересоздаёт его при каждом ре-рендере панели — старый интервал просто перестаёт находить свою
 * цель и логически замещается новым при следующем вызове этой функции, без явной отмены: querySelector
 * возвращает null для отсоединённого узла, обработчик тогда просто ничего не делает в этот тик). */
function startWegoTimerTicker() {
  if (wegoTimerHandle) return;
  wegoTimerHandle = setInterval(() => {
    const el = document.querySelector<HTMLDivElement>("#wego-round-timer");
    if (!el) return;
    if (wegoRoundDeadline === null) {
      el.textContent = "⏱ …";
      return;
    }
    const msLeft = Math.max(0, wegoRoundDeadline - Date.now());
    const totalSec = Math.ceil(msLeft / 1000);
    el.textContent = `⏱ ${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
    el.classList.toggle("wego-round-timer--low", totalSec <= 20);
  }, 1000);
}

// --- Placement phase logic ---

function isLandTile(col: number, row: number): boolean {
  const t = doc.get(col, row).terrain;
  return t !== "ocean" && t !== "iceOcean";
}

/** isInhabitedRegion/canFoundCityAt/regionHasFoundableTile/landTileForClick удалены как мёртвый
 * код — вся валидация клика теперь на сервере (GameSession.placeToken/foundCity), клиент просто
 * пересылает col/row клика, см. tryPlaceToken/tryFoundCity ниже. */

async function tryPlaceToken(clickCol: number, clickRow: number) {
  const result = await sendAction("placeToken", { col: clickCol, row: clickRow });
  if (!result.ok) setHint(result.hint ?? "Нельзя поставить жетон сюда.");
}

/** shiftListingSlotsAfterRemoval/consumeHandCard удалены как мёртвый код — списание карты/действия
 * теперь целиком на сервере (см. dispatch в GameSession.ts), клиент только шлёт slotIndex. */

async function tryFoundCity(clickCol: number, clickRow: number) {
  if (!pendingCardAction || pendingCardAction.kind !== "settler-found") return;
  const slotIndex = pendingCardAction.slotIndex;
  pendingCardAction = null;
  const result = await sendAction("foundCity", { slotIndex, col: clickCol, row: clickRow });
  if (!result.ok) setHint(result.hint ?? "Не удалось основать город.");
}

/** «Рост леса», positive branch (ТЗ 3.2.4) — pay 2 food (any type(s), not required distinct, same
 * `planFoodSpend(..., false)` Поселенец's founding uses), plant forest on the clicked hex. Access
 * scopes to whichever of the player's own cities owns that hex's region — «своя территория» means
 * any of their regions, not just the capital. */
async function tryPlantForest(clickCol: number, clickRow: number) {
  if (!pendingCardAction || pendingCardAction.kind !== "forest-plant") return;
  const slotIndex = pendingCardAction.slotIndex;
  // Бонус «Учёного» (эндгейм-выбор 4 из 4, см. cards.ts CardDef.freeForestGrowth) — та же цель, но
  // без ресурсов/действия, тем же приёмом, что isFree в confirmResearch/tryBuildBuilding.
  const isFree = !!hands[currentPlayerIndex]?.[slotIndex]?.freeForestGrowth;
  pendingCardAction = null;
  const result = await sendAction(isFree ? "plantFreeForest" : "plantForest", { slotIndex, col: clickCol, row: clickRow });
  if (!result.ok) setHint(result.hint ?? "Не удалось посадить лес.");
}

/** Зеркало GameSession.CITY_CAPACITY_TECHS/cityCapacityFor — только чтобы отличить в tryGrowCity
 * ниже город, который реально ЕЩЁ МОЖЕТ вырасти, от города, который просто существует, но уже
 * упёрся в вместимость (см. баг-репорт «Монотеизм, только 1 город может расти — не даёт завершить
 * розыгрыш одним городом»). Списание всё равно проверяет и делает сервер — это чисто UI-фильтр. */
const CITY_CAPACITY_TECHS = ["Каменная кладка", "Стандартизация", "Городское планирование", "Медицина", "Космонавтика"];
function cityCapacityFor(playerId: number): number {
  return 1 + CITY_CAPACITY_TECHS.filter((t) => researchedTechs[playerId].has(t)).length;
}

/** Shared by Поселенец's grow branch AND the event card «Население» — оба используют один и тот же
 * серверный action "growCity" (метод сам смотрит, «settler» или «population» лежит в слоте). При
 * Монотеизме карта растит 2 РАЗНЫХ города за один розыгрыш — оба клика копятся здесь локально
 * (grownCityIds/citiesLeft), единый вызов уходит на сервер только когда выбраны все нужные города,
 * см. пример в плане (collapse two-step arm-then-click into ONE server call). */
async function tryGrowCity(city: City) {
  if (!pendingCardAction || pendingCardAction.kind !== "settler-grow") return;
  if (pendingCardAction.grownCityIds.includes(city.id)) {
    setHint("Этот город уже выбран для роста в этом розыгрыше — выберите другой (Монотеизм). Esc — отмена.");
    return;
  }
  pendingCardAction.grownCityIds.push(city.id);
  pendingCardAction.citiesLeft--;
  const player = PLAYERS[currentPlayerIndex];
  const grownSoFar = pendingCardAction.grownCityIds;
  const capacity = cityCapacityFor(player.id);
  // Только города, которые ЕЩЁ РЕАЛЬНО МОГУТ вырасти (население < вместимости) — не просто «ещё не
  // выбран в этом розыгрыше». Иначе при Монотеизме и единственном городе с запасом вместимости игрок
  // застревал бы в ожидании второго клика: любой другой свой город технически «не выбран», но если он
  // уже упёрся в вместимость, сервер всё равно отклонит весь запрос целиком (growCity проверяет
  // вместимость КАЖДОГО из двух городов ДО применения любого) — розыгрыш нельзя было завершить вообще.
  const citiesStillPickable = cities.some((c) => c.playerId === player.id && !grownSoFar.includes(c.id) && c.population < capacity);
  if (pendingCardAction.citiesLeft > 0 && citiesStillPickable) {
    setHint("Город выбран — выберите ещё один (Монотеизм). Esc — отмена.");
    renderCityList();
    return;
  }
  const { slotIndex, grownCityIds } = pendingCardAction;
  pendingCardAction = null;
  const result = await sendAction("growCity", { slotIndex, cityIds: grownCityIds });
  if (!result.ok) setHint(result.hint ?? "Не удалось увеличить население.");
}

/** Воин step 1: city chosen — opens the unit-type modal instead of resolving immediately, since
 * the card still needs a unit type picked (step 2, see buildUnit). Делит шаг с альтернативной
 * покупкой за деньги (warrior-money-city, «Всеобщая воинская повинность») — разница только в том,
 * какое действие в итоге отправляется (см. buildUnit). */
function pickWarriorCity(city: City) {
  if (!pendingCardAction || (pendingCardAction.kind !== "warrior-city" && pendingCardAction.kind !== "warrior-money-city")) return;
  const player = PLAYERS[currentPlayerIndex];
  if (city.playerId !== player.id) {
    setHint("Можно строить войска только в своих городах.");
    return;
  }
  warriorTargetCity = city;
  activeModal = "warrior-unit";
  renderModal();
}

/** Казарма step 1 — тот же city-picking шаг, что у «Воин» (pickWarriorCity), просто без карты в
 * руке: делит с ней warriorTargetCity и модалку "warrior-unit" (см. buildUnit ниже). */
function pickKazarmaCity(city: City) {
  if (!pendingCardAction || pendingCardAction.kind !== "kazarma-city") return;
  const player = PLAYERS[currentPlayerIndex];
  if (city.playerId !== player.id) {
    setHint("Можно строить войска только в своих городах.");
    return;
  }
  warriorTargetCity = city;
  activeModal = "warrior-unit";
  renderModal();
}

/** Воин/Казарма step 2: unit type chosen — сервер (buildUnitCard/useKazarma) проверяет и списывает
 * всё сам. Один и тот же шаг для обоих источников — разница только в том, какое действие отправить и
 * нужен ли slotIndex карты. */
async function buildUnit(unit: UnitDef) {
  if (!pendingCardAction || !warriorTargetCity) return;
  const cityId = warriorTargetCity.id;
  if (pendingCardAction.kind === "warrior-city") {
    const slotIndex = pendingCardAction.slotIndex;
    pendingCardAction = null;
    warriorTargetCity = null;
    activeModal = null;
    const result = await sendAction("buildUnitCard", { slotIndex, cityId, unitId: unit.id });
    if (!result.ok) setHint(result.hint ?? "Не удалось построить юнит.");
  } else if (pendingCardAction.kind === "warrior-money-city") {
    // «Всеобщая воинская повинность» — по прямому запросу, покупка юнита за деньги вместо ресурсов
    // (эпоха × 2💰 + 1 население города, см. GameSession.buyUnitWithMoney).
    const slotIndex = pendingCardAction.slotIndex;
    pendingCardAction = null;
    warriorTargetCity = null;
    activeModal = null;
    const result = await sendAction("buyUnitWithMoney", { slotIndex, cityId, unitId: unit.id });
    if (!result.ok) setHint(result.hint ?? "Не удалось купить юнита за деньги.");
  } else if (pendingCardAction.kind === "kazarma-city") {
    pendingCardAction = null;
    warriorTargetCity = null;
    activeModal = null;
    const result = await sendAction("useKazarma", { cityId, unitId: unit.id });
    if (!result.ok) setHint(result.hint ?? "Не удалось построить юнит.");
  }
}

// =============================================================================================
// --- Юниты: движение, бой, гарнизон города (ТЗ 5.2/5.3/6/9) ---------------------------------
// =============================================================================================

/** «Земля круглая» (по прямому запросу) — карта замкнута тором по обеим осям: уходя с правого края,
 * юнит продолжает движение с левого (и симметрично сверху/вниз), если там вообще есть куда пройти —
 * применяется ко ВСЕЙ игровой смежности (движение, бой, дальность атаки, поддержка, отступление,
 * прибрежность/бухты), но НЕ к генерации карты (та намеренно осталась на необёрнутом `hexNeighbors`
 * — по краям, а не тором, чтобы не задеть уже настроенные алгоритмы). MAP_WIDTH чётный (24), поэтому
 * чётность offset-координат остаётся согласованной через шов (см. `hexNeighborsWrapped`). */
function hexNeighborsGameplay(col: number, row: number): [number, number][] {
  return hexNeighborsWrapped(col, row, MAP_WIDTH, MAP_HEIGHT);
}

/** Погруженные на корабль юниты исключены — не самостоятельная фигура на клетке (ТЗ 5.3). */
function unitsAt(col: number, row: number): UnitInstance[] {
  return units.filter((u) => u.col === col && u.row === row);
}
function cityAt(col: number, row: number): City | undefined {
  return cities.find((c) => c.col === col && c.row === row);
}
/** Сухопутный юнит на морской клетке — то есть на корабле (позиция определяет посадку сама по
 * себе, отдельного флага не заводим): «атаковать и оказывать поддержку не может, только
 * высадившись» — используется в findSupportFor и в проверке атаки (tryCommandSelectedUnit). */
function isAboardShip(u: UnitInstance): boolean {
  return u.category !== "ship" && isSeaTile(u.col, u.row);
}
/** Корабли идут по воде И заходят в города (док/гавань — «корабли могут заходить в города», их
 * можно убрать в запас гарнизона, и через город на другую сторону перешейка, если там снова
 * море — это и есть канал, отдельной логики не нужно, просто города проходимы для кораблей).
 * Сухопутные — по суше, а корабль СВОЕГО игрока проходим как временный мост (ТЗ: «корабли как
 * гекс, через который могут проходить юниты как по суше» — цепочка кораблей = переправа через
 * пролив). Возврат на настоящий берег обрывает бюджет хода этого цикла целиком, см.
 * resolveUnitMovementForCycle. */
/** isCoastalSeaTile/unitPassable/canEnterHex удалены как мёртвый код — движение/проходимость
 * теперь целиком проверяет сервер (GameSession.commandUnit), клиент только шлёт клик. */

/** Есть ли у города хоть один соседний морской гекс — города без выхода к морю не могут строить
 * корабли (по прямому запросу). */
function cityHasAdjacentSea(city: City): boolean {
  return hexNeighborsGameplay(city.col, city.row).some(([nc, nr]) => isSeaTile(nc, nr));
}
/** Свободный морской гекс рядом с городом для новопостроенного корабля — приоритет наиболее
 * защищённому (та же формула бухты «берега минус один», что и в бою, 6.8). `null`, если рядом с
 * городом вообще нет свободного моря (звать только после cityHasAdjacentSea). */
/** Дорога, принадлежащая КОНКРЕТНОМУ игроку — используется только для бонуса обороны «на своём
 * торговом пути» (снабжение). shipSpawnHex/isRoadHex/isBarrierMountain/terrainMoveCost/
 * computeUnitPath/unitActivationReq/chargeUnitActivation удалены как мёртвый код — движение и его
 * цена теперь целиком на сервере (GameSession.commandUnit). */
function ownRoadHex(playerId: number, col: number, row: number): boolean {
  return tradeRoutes.some((r) => r.playerId === playerId && r.path.some((p) => p.col === col && p.row === row));
}

/** Чья территория — регион с чужим городом (ТЗ: «вход на чужую территорию без соглашения о
 * границах приводит к войне»). Регион без города — ничей, свободный проход. */
function territoryOwnerOf(col: number, row: number): number | null {
  const rc = Math.floor(col / REGION_SIZE_X);
  const rr = Math.floor(row / REGION_SIZE_Y);
  const city = cityAtRegion(rc, rr);
  return city ? city.playerId : null;
}

/** Защиту хранит КЛЕТКА, не юнит (по прямому уточнению — проблема одновременности ходов в
 * hotseat: одна артатака могла бить юнита, который к следующей уже сбежал в другой гекс, и защиту
 * приходилось сбивать заново на каждый удар). Считается один раз лениво, при ПЕРВОМ уроне по этой
 * клетке в текущем цикле (используя того, кто там стоит на тот момент — территория/форт/дорога
 * зависят от владельца, «Обороняться» от его стойки), дальше просто убывает независимо от того,
 * кто именно там окажется впоследствии; сбежавший юнит на НОВОЙ клетке получает её собственное,
 * ещё не тронутое значение. Восстанавливается вместе со здоровьем юнитов в начале нового цикла
 * (`hexDefense.clear()`, см. onPlayingEndTurn). */
const hexDefense = new Map<string, number>();
/** Личный бонус «Обороны» — зеркалит GameSession.unitDefendBuffer (по прямому запросу: защита
 * местности привязана к гексу и общая для всех на клетке, а бонус команды «Оборона» — только у
 * конкретного обороняющегося юнита, отдельная шкала, ключ — id юнита). */
const unitDefendBuffer = new Map<number, number>();
function hexKey(col: number, row: number): string {
  return `${col},${row}`;
}
/** Защита МЕСТНОСТИ (гекс) — общая для всех юнитов на клетке, не зависит от того, кто именно из них
 * сейчас в «Обороне» (см. unitDefendBase/peekDefendBuffer для персонального бонуса). */
function computeFreshHexTerrainDefense(col: number, row: number, context: UnitInstance): number {
  const tile = doc.get(col, row);
  const hasCity = !!cityAt(col, row);
  let bonus = 0;
  if (isSeaTile(col, row)) {
    // Корабли (уточнение) — закрытая бухта прячет лучше открытого моря: каждый берег (сухопутный
    // сосед) даёт +1, кроме первого — открытая вода с одним берегом рядом вообще без бонуса,
    // бухта из 5 гексов суши (максимум для одной клетки — 6-й сосед сам остаётся морем) даёт +4.
    const shores = hexNeighborsGameplay(col, row).filter(([nc, nr]) => isLandTile(nc, nr)).length;
    bonus += Math.max(0, shores - 1);
  } else {
    const dugIn = tile.terrain !== "desert" && tile.terrain !== "tundra"; // «окопаться нельзя» — искл. город ниже
    if (dugIn || hasCity) {
      if (tile.forest) bonus += 1;
      if (tile.terrain === "hills") bonus += 1;
      if (tile.terrain === "mountains") bonus += 2;
      if (hasCity) bonus += 1;
      if (territoryOwnerOf(col, row) === context.playerId) bonus += 1;
      if (isOwnedBy(buildingOwners, "fort", context.playerId)) bonus += maxEligibleEpoch(context.playerId); // «соразмерно уровню»
      if (ownRoadHex(context.playerId, col, row)) bonus += 1; // снабжение по своему торговому пути
    }
  }
  return Math.max(0, bonus);
}
/** Личный бонус «Обороны» — плоское число (не множитель, по прямому запросу «защита при уходе в
 * оборону теперь не удвоение, а конкретный плюс к защите»), растёт по эпохам у КАЖДОЙ категории
 * отдельно (units.ts, лист 6), больше НЕ часть общей защиты местности. */
function unitDefendBase(u: UnitInstance): number {
  const stats = unitStats(u);
  return stats.defenseBonus;
}
/** Текущее (возможно уже частично истощённое в этом цикле) значение защиты клетки — считает, если
 * ещё не считалось, но не тратит (в отличие от applyDamage на сервере). */
function peekHexDefense(u: UnitInstance): number {
  const key = hexKey(u.col, u.row);
  if (!hexDefense.has(key)) hexDefense.set(key, computeFreshHexTerrainDefense(u.col, u.row, u));
  return hexDefense.get(key)!;
}
/** 0, если юнит сейчас не обороняется — тогда урон идёт от местности сразу в HP, минуя эту шкалу. */
function peekDefendBuffer(u: UnitInstance): number {
  if (!u.defending) return 0;
  if (!unitDefendBuffer.has(u.id)) unitDefendBuffer.set(u.id, unitDefendBase(u));
  return unitDefendBuffer.get(u.id)!;
}

/** Совокупная защита юнита — то, что показывается при наведении на чужого юнита (текущий остаток
 * защиты его клетки + личного бонуса «Обороны» в этом цикле, не «полное» значение с нуля). */
function unitTotalDefense(u: UnitInstance): number {
  return peekHexDefense(u) + peekDefendBuffer(u);
}

/** Разбивка ТЕКУЩЕЙ (возможно частично истощённой в этом цикле) защиты на «свою» (личный бонус
 * «Обороны», только у обороняющегося юнита) и «местную» (лес/холмы/горы/город/территория/форт/
 * дорога — общая для всех на клетке) — по прямому запросу: урон тратит СНАЧАЛА местный бонус (гекс)
 * и только потом персональный бонус «Обороны», НАСТОЯЩИЕ раздельные шкалы (peekHexDefense/
 * peekDefendBuffer), не приближение для отображения, как было раньше. */
function unitDefenseBreakdown(u: UnitInstance): { unitDefense: number; terrainDefense: number; total: number } {
  const terrainDefense = peekHexDefense(u);
  const unitDefense = peekDefendBuffer(u);
  return { unitDefense, terrainDefense, total: terrainDefense + unitDefense };
}

/** Зеркалит GameSession.cityGarrisonDefense — «сила гарнизона» города (население, а не отдельный
 * юнит), см. §6.9. Реально принимает урон только когда в городе НЕТ ни одного размещённого
 * защитника — но полезно видеть заранее, справочно, пока защитники ещё стоят (по прямому запросу,
 * показывается в hex-info-panel рядом со списком юнитов). Ответная атака гарнизона по населению
 * нигде явно не задана — «если сила не прописана явно, считается 1» (ТЗ 9), тем же значением.
 * Местность (bonus) без удвоения — удваивается только база гарнизона (город «всегда обороняется»),
 * по прямому запросу — тот же принцип, что и у обычного юнита в «Обороне». */
function cityGarrisonDefenseBreakdown(city: City): { population: number; base: number; bonus: number; total: number } {
  const tile = doc.get(city.col, city.row);
  const base = Math.max(1, city.population);
  let bonus = 1; // сам факт города
  if (tile.terrain === "hills") bonus += 1;
  if (tile.terrain === "mountains") bonus += 2;
  if (territoryOwnerOf(city.col, city.row) === city.playerId) bonus += 1;
  if (isOwnedBy(buildingOwners, "fort", city.playerId)) bonus += maxEligibleEpoch(city.playerId);
  if (ownRoadHex(city.playerId, city.col, city.row)) bonus += 1;
  return { population: city.population, base, bonus, total: bonus + base * 2 };
}
const CITY_GARRISON_COUNTERATTACK = 1;

/** Зеркалит GameSession.hexDistance — тороидальный BFS (карта замкнута по обеим осям, «земля
 * круглая»), тот же обход через hexNeighborsGameplay, что и на сервере. */
function hexDistance(fromCol: number, fromRow: number, toCol: number, toRow: number, maxRadius = 20): number {
  if (fromCol === toCol && fromRow === toRow) return 0;
  const visited = new Set<string>([`${fromCol},${fromRow}`]);
  let frontier: [number, number][] = [[fromCol, fromRow]];
  for (let dist = 1; dist <= maxRadius && frontier.length; dist++) {
    const next: [number, number][] = [];
    for (const [c, r] of frontier) {
      for (const [nc, nr] of hexNeighborsGameplay(c, r)) {
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

/** Зеркалит GameSession.supportersFor — для подсказки при наведении (по прямому запросу: «отображай
 * урон юнита и размер поддержки, в радиус которой он входит, сколько итого урона»), не только для
 * самого боя. */
function supportersFor(u: UnitInstance): UnitInstance[] {
  if (u.category !== "assault" && u.category !== "mobile") return [];
  return units.filter((s) => {
    if (s.playerId !== u.playerId || s.id === u.id || isAboardShip(s)) return false;
    const stats = unitStats(s);
    if (stats.supportBonus <= 0) return false;
    const d = hexDistance(s.col, s.row, u.col, u.row, stats.supportRadius + 1);
    return d <= stats.supportRadius;
  });
}
/** Зеркалит GameSession.supportBonusSum — сумма личных бонусов (units.ts, растёт по эпохам, лист 6),
 * не просто число поддерживающих юнитов (было безопасно приравнивать, пока supportBonus был
 * константой 1 у всех эпох — с листом 6 у каждого поддерживающего свой вес). */
function supportBonusSum(supporters: UnitInstance[]): number {
  return supporters.reduce((sum, s) => sum + unitStats(s).supportBonus, 0);
}

// --- Выбор юнита и отдача приказа (клик по своему юниту → клик по цели) ----------------------
let selectedUnitId: number | null = null;
/** Гекс под курсором (по прямому запросу — «при наведении на гекс выводи что в нём есть: юниты,
 * города, ресурсы, местность, лес»). Обновляется в pointermove на canvas — см. renderHexInfoPanel
 * (единственная панель наведения — `#unit-info-panel` удалена по прямому запросу, дублировала её). */
let hoveredHex: { col: number; row: number } | null = null;

function selectedUnit(): UnitInstance | undefined {
  return units.find((u) => u.id === selectedUnitId);
}
function selectUnit(id: number | null) {
  selectedUnitId = id;
  if (id === null && crosshairHex) {
    crosshairHex = null;
    renderCrosshair();
  }
  clearMovePreview();
  clearAttackPreview();
  drawCityMarkers();
  renderUnitCommandBar();
}

/** Превью маршрута до наведённого гекса, пока выбран свой юнит (по прямому запросу — «при выборе
 * клетки куда переместиться показывай маршрут и число ходов»). Запрашивается у сервера отдельным
 * каналом (net.requestPreviewPath) — та же приватная логика, что и настоящее движение
 * (GameSession.computeUnitPath), поэтому превью не может разойтись с тем, что случится по клику; на
 * клиенте эта логика намеренно не дублируется (была снята как мёртвый код при переходе на
 * server-authoritative движение, см. комментарии у cityHasAdjacentSea/ownRoadHex). `latestPreviewRequestId`
 * — последний реально нужный запрос; более ранние ответы, пришедшие позже (наведение быстрее сети),
 * просто отбрасываются в net.onPreviewPath. */
let movePreview: { col: number; row: number; result: net.PreviewPathResult } | null = null;
let latestPreviewRequestId = 0;

function clearMovePreview() {
  movePreview = null;
  movePreviewLayer.clear();
}

function updateMovePreview() {
  const unit = selectedUnit();
  if (!unit || unit.playerId !== currentPlayerIndex || phase !== "playing" || !hoveredHex || (hoveredHex.col === unit.col && hoveredHex.row === unit.row)) {
    if (movePreview) clearMovePreview();
    return;
  }
  latestPreviewRequestId = net.requestPreviewPath(currentPlayerIndex, unit.id, hoveredHex.col, hoveredHex.row);
}

function drawMovePreview() {
  movePreviewLayer.clear();
  if (!movePreview) return;
  const unit = selectedUnit();
  if (!unit) return;
  const player = PLAYERS[unit.playerId];
  let from = hexToPixelView(unit.col, unit.row, HEX_SIZE);
  for (const step of movePreview.result.path) {
    const to = hexToPixelView(step.col, step.row, HEX_SIZE);
    drawRouteSegment(movePreviewLayer, from, to, 5, 4);
    from = to;
  }
  movePreviewLayer.stroke({ width: 2, color: player.color, alpha: 0.9 });
  const end = hexToPixelView(movePreview.col, movePreview.row, HEX_SIZE);
  movePreviewLayer.circle(end.x, end.y, 6).stroke({ width: 2, color: player.color, alpha: 0.9 });
}

/** Превью исхода боя при наведении на противника, пока выбран свой юнит (по прямому запросу — «при
 * выделенном своём юните и наведении на противника показывать исход боя: сколько из скольки защиты
 * снимется цифрами, отступит ли юнит, ничья или кто-то погибнет») — тот же round-trip, что и
 * movePreview выше (net.requestPreviewAttack/onPreviewAttack, отдельный канал от очереди действий,
 * `latestAttackPreviewRequestId` отбрасывает устаревшие ответы). Рендерится строкой в
 * renderHexInfoPanel — см. её doc. */
let attackPreview: { col: number; row: number; result: net.PreviewAttackResult } | null = null;
let latestAttackPreviewRequestId = 0;

function clearAttackPreview() {
  attackPreview = null;
}

function updateAttackPreview() {
  const unit = selectedUnit();
  if (!unit || unit.playerId !== currentPlayerIndex || phase !== "playing" || !hoveredHex) {
    if (attackPreview) clearAttackPreview();
    return;
  }
  const defenders = unitsAt(hoveredHex.col, hoveredHex.row).filter((u) => u.playerId !== unit.playerId);
  if (!defenders.length) {
    if (attackPreview) clearAttackPreview();
    return;
  }
  latestAttackPreviewRequestId = net.requestPreviewAttack(currentPlayerIndex, unit.id, hoveredHex.col, hoveredHex.row);
}

/** Клик по гексу с одним своим юнитом выбирает его сразу; с двумя — по прямому запросу сперва
 * спрашивает, каким игрок хочет ходить, вместо того чтобы молча брать первого по порядку в
 * `unitsAt` (было именно так — на клетке города это гарнизон, CITY_GARRISON_CAP=2, а на открытой
 * клетке это корабль+пассажир на борту, см. §15.3 «пассажир на борту»; молчаливый выбор первого
 * иногда попадал на пассажира, и корабль оказывалось невозможно выбрать кликом вовсе). Город —
 * существующая city-detail-модалка; открытая клетка — та же идея, новая unit-pick. */
function tryStartUnitCommand(col: number, row: number): boolean {
  const player = PLAYERS[currentPlayerIndex];
  const city = cityAt(col, row);
  const own = unitsAt(col, row).filter((u) => u.playerId === player.id);
  if (!own.length) return false;
  if (own.length > 1) {
    if (city) {
      cityDetailId = city.id;
      activeModal = "city-detail";
    } else {
      unitPickHex = { col, row };
      activeModal = "unit-pick";
    }
    renderModal();
    return true;
  }
  const unit = own[0];
  selectUnit(unit.id);
  setHint(`Выбран(а) ${unit.category === "ranged" ? "дальнобойный" : ""} юнит — кликните пустой гекс (движение) или юнита противника (атака), Esc — отмена.`);
  return true;
}

/** Клик по цели уже выбранным юнитом — теперь один вызов "commandUnit" (сервер сам решает,
 * движение это или атака, по позиции цели — см. GameSession.commandUnit); needsWarConfirm-поток
 * (объявление войны атакой/пересечением границы) идёт через sendActionMaybeWar (см. план). */
async function tryCommandSelectedUnit(col: number, row: number) {
  const unit = selectedUnit();
  if (!unit) return;
  // Снаряд + вспышка — чисто визуальный эффект, безопасно запускаем оптимистично по клику (не
  // дожидаясь ответа сервера о реальном исходе боя) для дистанционных атак начиная с эпохи пороха.
  const defenderCity = cityAt(col, row);
  const defenders = unitsAt(col, row).filter((u) => u.playerId !== unit.playerId);
  const isEnemyTarget = defenders.length > 0 || (!!defenderCity && defenderCity.playerId !== unit.playerId);
  if (isEnemyTarget) {
    const stats = unitStats(unit);
    if ((stats.aoe || stats.attackRange > 1) && unit.epoch >= 3) {
      playRangedAttackAnimation(unit.col, unit.row, col, row);
    }
  }
  // Стартовая клетка — ДО отправки, т.к. движение сервер применяет сразу (по прямому запросу «должен
  // двигаться в текущем цикле») и локальное зеркало unit.col/row уже укажет на конечную точку к
  // моменту, когда придёт ответ (см. movedPath ниже — маршрут для анимации, а не для самого хода).
  const fromCol = unit.col;
  const fromRow = unit.row;
  const playerColor = PLAYERS[unit.playerId].color;
  selectUnit(null);
  const result = await sendActionMaybeWar("commandUnit", { unitId: unit.id, col, row });
  if (!result.ok) setHint(result.hint ?? "Не удалось выполнить приказ.");
  else {
    if (result.hint) setHint(result.hint);
    if (result.supportLines?.length) playSupportLineAnimation(result.supportLines);
    if (result.movedPath?.length) playUnitMoveAnimation(fromCol, fromRow, result.movedPath, playerColor);
    if (result.combatAnim?.hits.length) playCombatAnimation(result.combatAnim);
  }
}

/** Движение юнита по гексам (по прямому запросу — «должен двигаться в текущем цикле... плюс анимация
 * с учётом местности»). Сервер применяет приказ мгновенно (GameSession.commandUnit/walkUnitAlongOrder)
 * — юнит уже стоит на итоговой клетке к моменту ответа, это чисто визуальный «прочерк» пройденного
 * маршрута поверх уже актуального состояния, тем же fxLayer/RAF-паттерном, что playRangedAttackAnimation.
 * Длительность каждого сегмента — от `cost` шага (дорога/обычная местность/весь остаток бюджета на
 * горе без дороги, см. GameSession.walkUnitAlongOrder), а не одинаковая на каждый гекс — сервер прислал
 * его в movedPath, чтобы не дублировать формулу стоимости местности на клиенте. */
function playUnitMoveAnimation(fromCol: number, fromRow: number, path: { col: number; row: number; cost: number }[], color: number) {
  const marker = new Graphics().circle(0, 0, 7).fill({ color, alpha: 0.85 }).circle(0, 0, 7).stroke({ width: 1.5, color: 0x111111 });
  const start = hexToPixelView(fromCol, fromRow, HEX_SIZE);
  marker.position.set(start.x, start.y);
  marker.eventMode = "none";
  fxLayer.addChild(marker);
  const MS_PER_COST = 220;
  let segIndex = 0;
  let segStart = performance.now();
  let from = start;
  const step = () => {
    if (segIndex >= path.length) {
      fxLayer.removeChild(marker);
      marker.destroy();
      return;
    }
    const seg = path[segIndex];
    const to = hexToPixelView(seg.col, seg.row, HEX_SIZE);
    const durationMs = Math.max(80, Math.min(600, seg.cost * MS_PER_COST));
    const t = Math.min(1, (performance.now() - segStart) / durationMs);
    marker.position.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (t >= 1) {
      segIndex++;
      segStart = performance.now();
      from = to;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Линии поддержки (по прямому запросу — «чтоб было видно какие юниты оказали поддержку») — от
 * каждого поддержавшего юнита к тому, кого он поддержал (атакующий или защитник), чисто визуально,
 * ни на что в состоянии игры не влияет. Тот же fxLayer/RAF-паттерн, что у playRangedAttackAnimation. */
function playSupportLineAnimation(lines: { from: { col: number; row: number }; to: { col: number; row: number } }[]) {
  const durationMs = 700;
  const start = performance.now();
  const graphics = lines.map(({ from, to }) => {
    const g = new Graphics();
    fxLayer.addChild(g);
    return { g, from: hexToPixelView(from.col, from.row, HEX_SIZE), to: hexToPixelView(to.col, to.row, HEX_SIZE) };
  });
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / durationMs);
    const alpha = 1 - t;
    for (const { g, from, to } of graphics) {
      g.clear();
      g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 3, color: 0x6cf0a0, alpha: alpha * 0.9 });
      g.circle(from.x, from.y, 5).fill({ color: 0x6cf0a0, alpha });
    }
    if (t < 1) {
      requestAnimationFrame(step);
      return;
    }
    for (const { g } of graphics) {
      fxLayer.removeChild(g);
      g.destroy();
    }
  };
  requestAnimationFrame(step);
}

/** Полоски-«выстрелы» от атакующего к каждой цели + убывающая полоска защиты (и HP, если это юнит)
 * над целью (по прямому запросу — «полосками от юнита к цели как стрельба, с отображаемым убыванием
 * защиты, хотя бы секунда анимации, иначе трудно понять возымело ли действие эффект»). Реальный урон
 * УЖЕ применён сервером (GameSession.resolveCombat) до того, как эти данные вообще пришли — здесь
 * только визуальное воспроизведение снимков до/после, ни на что в состоянии партии не влияет. Та же
 * fxLayer/RAF-схема, что и у остальных боевых анимаций (playSupportLineAnimation и т.д.), но общая
 * для ЛЮБОЙ атаки (в упор и дистанционно, по юниту и по гарнизону города), не только для эпох пороха. */
function playCombatAnimation(anim: NonNullable<net.ActionResult["combatAnim"]>) {
  const DURATION_MS = 1100; // «хотя бы секунда» — с запасом, чтобы точно успело прочитаться
  const attackerPos = hexToPixelView(anim.attacker.col, anim.attacker.row, HEX_SIZE);
  type Bar = { x: number; y: number; defenseBefore: number; defenseAfter: number; hpBefore?: number; hpAfter?: number; hpMax?: number };
  const beamTargets: { x: number; y: number }[] = [];
  const bars: Bar[] = [];
  const stackAt = new Map<string, number>(); // несколько целей на одном гексе (AoE) — не рисовать полоски друг на друге
  const posFor = (col: number, row: number) => {
    const base = hexToPixelView(col, row, HEX_SIZE);
    const key = `${col},${row}`;
    const stack = stackAt.get(key) ?? 0;
    stackAt.set(key, stack + 1);
    return { x: base.x, y: base.y - stack * 9 };
  };
  for (const hit of anim.hits) {
    const pos = posFor(hit.target.col, hit.target.row);
    beamTargets.push(pos);
    bars.push(
      hit.kind === "unit"
        ? { x: pos.x, y: pos.y, defenseBefore: hit.defenseBefore, defenseAfter: hit.defenseAfter, hpBefore: hit.hpBefore, hpAfter: hit.hpAfter, hpMax: hit.hpMax }
        : { x: pos.x, y: pos.y, defenseBefore: hit.defenseBefore, defenseAfter: hit.defenseAfter }
    );
  }
  if (anim.counterOnAttacker) {
    const c = anim.counterOnAttacker;
    bars.push({ x: attackerPos.x, y: attackerPos.y, defenseBefore: c.defenseBefore, defenseAfter: c.defenseAfter, hpBefore: c.hpBefore, hpAfter: c.hpAfter, hpMax: c.hpMax });
  }

  const beamG = new Graphics();
  const barG = new Graphics();
  // Цифры — «минус N, осталось M» (по прямому запросу) — отдельные Text-объекты поверх полосок:
  // Graphics.clear() каждый кадр не трогает дочерние Text, так что создаём их один раз и только
  // обновляем позицию/альфу, вместо пересоздания на каждый requestAnimationFrame.
  const labelG = new Container();
  fxLayer.addChild(beamG, barG, labelG);
  const labelSets = bars.map((bar) => makeCombatStatLabels(labelG, bar));
  const start = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / DURATION_MS);
    // Полоска-выстрел — быстрая вспышка, затем плавное затухание, а не всё время на полной альфе.
    const beamAlpha = t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.12) / 0.5);
    beamG.clear();
    if (beamAlpha > 0) {
      for (const target of beamTargets) {
        beamG.moveTo(attackerPos.x, attackerPos.y).lineTo(target.x, target.y).stroke({ width: 3, color: 0xff5a3f, alpha: beamAlpha * 0.9 });
      }
    }
    // Полоски защиты/HP убывают за первые 70% длительности, дальше держат итог, чтобы его успели
    // прочитать (а не просто мигнуло и пропало). Цифры проявляются чуть позже полоски (после 20%
    // длительности) — сперва видно, что удар пришёл (вспышка+полоска), потом цифру «на сколько».
    const drainT = Math.min(1, t / 0.7);
    const labelAlpha = Math.max(0, Math.min(1, (t - 0.2) / 0.3));
    barG.clear();
    for (let i = 0; i < bars.length; i++) {
      drawCombatStatBar(barG, bars[i], drainT);
      updateCombatStatLabels(labelSets[i], bars[i], labelAlpha);
    }
    if (t < 1) {
      requestAnimationFrame(step);
      return;
    }
    fxLayer.removeChild(beamG);
    beamG.destroy();
    fxLayer.removeChild(barG);
    barG.destroy();
    fxLayer.removeChild(labelG);
    labelG.destroy({ children: true });
  };
  requestAnimationFrame(step);
}
/** Один блок полосок (защита сверху, HP снизу, если это юнит) над целью боя — см. playCombatAnimation.
 * Ширина полоски защиты — относительно ЕЁ ЖЕ значения ДО удара (не какого-то общего максимума), так
 * что убывание всегда наглядно видно, даже у целей с маленьким числом защиты. */
function drawCombatStatBar(g: Graphics, bar: { x: number; y: number; defenseBefore: number; defenseAfter: number; hpBefore?: number; hpAfter?: number; hpMax?: number }, drainT: number) {
  const W = 26;
  const H = 4;
  const topY = bar.y - HEX_SIZE - 10;
  const defMax = Math.max(1, bar.defenseBefore);
  const defNow = bar.defenseBefore + (bar.defenseAfter - bar.defenseBefore) * drainT;
  const defFrac = Math.max(0, Math.min(1, defNow / defMax));
  g.rect(bar.x - W / 2, topY, W, H).fill({ color: 0x0a0a0a, alpha: 0.75 });
  if (defFrac > 0) g.rect(bar.x - W / 2, topY, W * defFrac, H).fill({ color: 0x6cc8ff });
  if (bar.hpMax !== undefined && bar.hpBefore !== undefined && bar.hpAfter !== undefined) {
    const hpNow = bar.hpBefore + (bar.hpAfter - bar.hpBefore) * drainT;
    const hpFrac = Math.max(0, Math.min(1, hpNow / Math.max(1, bar.hpMax)));
    const hpY = topY + H + 2;
    g.rect(bar.x - W / 2, hpY, W, H).fill({ color: 0x0a0a0a, alpha: 0.75 });
    if (hpFrac > 0) g.rect(bar.x - W / 2, hpY, W * hpFrac, H).fill({ color: hpFrac > 0.34 ? 0x6cff9c : 0xff5a3f });
  }
}
type CombatBar = { x: number; y: number; defenseBefore: number; defenseAfter: number; hpBefore?: number; hpAfter?: number; hpMax?: number };
type CombatStatLabels = { defenseDelta: Text; defenseLeft: Text; hpDelta?: Text; hpLeft?: Text };
/** Текстовые подписи «−N / осталось M» для защиты (и HP, если это юнит) — по прямому запросу
 * («должно показываться значение защиты, знак минус, сколько сняла атака и сколько осталось рядом с
 * тем по кому наносится урон»). Создаётся один раз на весь ход анимации (см. playCombatAnimation),
 * `updateCombatStatLabels` только позиционирует/проявляет — числа посчитаны сразу по before/after,
 * не пересчитываются по кадрам (в отличие от полоски, у цифр нет смысла «досчитывать» — реальный урон
 * уже применён сервером, drainT только для визуального темпа). */
function makeCombatStatLabels(into: Container, bar: CombatBar): CombatStatLabels {
  const style = (color: number) => new TextStyle({ fontSize: 10, fontWeight: "bold", fill: color, fontFamily: "sans-serif", stroke: { color: 0x111111, width: 2 } });
  const defenseDelta = new Text({ text: `−${bar.defenseBefore - bar.defenseAfter}`, style: style(0xff5a3f) });
  defenseDelta.anchor.set(0, 0.5);
  const defenseLeft = new Text({ text: String(bar.defenseAfter), style: style(0x6cc8ff) });
  defenseLeft.anchor.set(1, 0.5);
  into.addChild(defenseDelta, defenseLeft);
  const labels: CombatStatLabels = { defenseDelta, defenseLeft };
  if (bar.hpMax !== undefined && bar.hpBefore !== undefined && bar.hpAfter !== undefined) {
    const hpDelta = new Text({ text: `−${bar.hpBefore - bar.hpAfter}`, style: style(0xff5a3f) });
    hpDelta.anchor.set(0, 0.5);
    const hpLeft = new Text({ text: `${bar.hpAfter}/${bar.hpMax}`, style: style(0x6cff9c) });
    hpLeft.anchor.set(1, 0.5);
    into.addChild(hpDelta, hpLeft);
    labels.hpDelta = hpDelta;
    labels.hpLeft = hpLeft;
  }
  return labels;
}
function updateCombatStatLabels(labels: CombatStatLabels, bar: CombatBar, alpha: number) {
  const W = 26;
  const H = 4;
  const topY = bar.y - HEX_SIZE - 10;
  const defDamage = bar.defenseBefore - bar.defenseAfter;
  // Нулевой урон по защите (например удар полностью ушёл в HP, буфер уже был снят раньше) — не
  // показываем «−0», это не несёт информации и просто загромождает картинку.
  labels.defenseDelta.visible = defDamage > 0;
  labels.defenseDelta.alpha = alpha;
  labels.defenseDelta.position.set(bar.x + W / 2 + 3, topY + H / 2);
  labels.defenseLeft.alpha = alpha;
  labels.defenseLeft.position.set(bar.x - W / 2 - 3, topY + H / 2);
  if (labels.hpDelta && labels.hpLeft && bar.hpBefore !== undefined && bar.hpAfter !== undefined) {
    const hpY = topY + H + 2 + H / 2;
    const hpDamage = bar.hpBefore - bar.hpAfter;
    labels.hpDelta.visible = hpDamage > 0;
    labels.hpDelta.alpha = alpha;
    labels.hpDelta.position.set(bar.x + W / 2 + 3, hpY);
    labels.hpLeft.alpha = alpha;
    labels.hpLeft.position.set(bar.x - W / 2 - 3, hpY);
  }
}

/** Летящий снаряд + вспышка взрыва (по запросу — «для эпох где уже есть порох») — чисто
 * визуальный эффект поверх карты, ни на что в состоянии игры не влияет. Порох как технология
 * открывается в Э3 (Мушкетёр/Пушка), отсюда и порог `epoch >= 3`; юниты раньше этой эпохи (лук,
 * катапульта, требушет) стреляют без анимации — на порохе тут в принципе рано завязываться. */
function playRangedAttackAnimation(fromCol: number, fromRow: number, toCol: number, toRow: number) {
  const from = hexToPixelView(fromCol, fromRow, HEX_SIZE);
  const to = hexToPixelView(toCol, toRow, HEX_SIZE);
  const projectile = new Graphics().circle(0, 0, 3).fill({ color: 0xffcc55 }).circle(0, 0, 3).stroke({ width: 1, color: 0xff8a3f });
  projectile.position.set(from.x, from.y);
  fxLayer.addChild(projectile);
  const flightMs = 260;
  const flightStart = performance.now();
  const stepFlight = () => {
    const t = Math.min(1, (performance.now() - flightStart) / flightMs);
    projectile.position.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (t < 1) {
      requestAnimationFrame(stepFlight);
      return;
    }
    fxLayer.removeChild(projectile);
    projectile.destroy();
    playImpactFlash(to.x, to.y);
  };
  requestAnimationFrame(stepFlight);
}
function playImpactFlash(x: number, y: number) {
  const flash = new Graphics();
  fxLayer.addChild(flash);
  const flashMs = 260;
  const flashStart = performance.now();
  const stepFlash = () => {
    const t = Math.min(1, (performance.now() - flashStart) / flashMs);
    const radius = 4 + t * 14;
    const alpha = 1 - t;
    flash
      .clear()
      .circle(x, y, radius)
      .fill({ color: 0xffb347, alpha: alpha * 0.8 })
      .circle(x, y, radius * 0.45)
      .fill({ color: 0xfff3d0, alpha });
    if (t < 1) {
      requestAnimationFrame(stepFlash);
      return;
    }
    fxLayer.removeChild(flash);
    flash.destroy();
  };
  requestAnimationFrame(stepFlash);
}

/** Землетрясение среди катаклизмов «Учёного» (ТЗ §15.1) — небольшая тряска: гексы задетого региона
 * рисуются временными копиями поверх настоящего рельефа (тот — один сплошной Graphics-блоб на всю
 * карту, отдельные гексы не двигаются как объекты) и покачиваются влево-вправо каждый со своей
 * фазой — из-за этого при пике амплитуды они могут наезжать друг на друга, как и запрошено.
 * Амплитуда затухает к концу, копии убираются — настоящий рельеф под ними всё это время не менялся,
 * чисто визуальный эффект поверх него. */
function playEarthquakeAnimation(regionCol: number, regionRow: number) {
  const hexes: { col: number; row: number }[] = [];
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      hexes.push({ col: regionCol * REGION_SIZE_X + dx, row: regionRow * REGION_SIZE_Y + dy });
    }
  }
  const shakeLayer = new Container();
  fxLayer.addChild(shakeLayer);
  const corners: number[] = [];
  for (let i = 0; i < 6; i++) {
    const p = hexCorner({ x: 0, y: 0 }, HEX_SIZE * 0.96, i);
    corners.push(p.x, p.y);
  }
  const pieces = hexes.map((h) => {
    const center = hexToPixelView(h.col, h.row, HEX_SIZE);
    const tile = doc.get(h.col, h.row);
    const color = tile.iceCover ? TERRAIN_BY_ID.iceOcean.color : TERRAIN_BY_ID[tile.terrain].color;
    const g = new Graphics().poly(corners).fill({ color }).poly(corners).stroke({ width: 1, color: 0x0a0a0a, alpha: 0.35 });
    g.position.set(center.x, center.y);
    shakeLayer.addChild(g);
    return { g, baseX: center.x, baseY: center.y, seed: Math.random() * 1000 };
  });
  const durationMs = 650;
  const start = performance.now();
  const step = () => {
    const t = (performance.now() - start) / durationMs;
    if (t >= 1) {
      fxLayer.removeChild(shakeLayer);
      shakeLayer.destroy({ children: true });
      return;
    }
    const amp = HEX_SIZE * 0.22 * (1 - t);
    for (const p of pieces) {
      const wob = Math.sin(performance.now() / 40 + p.seed) * amp;
      p.g.position.set(p.baseX + wob, p.baseY);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Ядерный удар (по прямому запросу, дополнено по прямому запросу — «анимация ввиду расходящегося
 * медленно круга на радиус поражения и гриба ядерного над гексом») — три слоя, все на одном общем
 * таймере от начала анимации:
 * 1. Вспышка на задетых гексах — цель ярче/крупнее, соседи тусклее (та же разница силы, что 12
 *    урона у цели против 6 у соседей), быстро гаснет. Промах — только на самой цели, без урона по
 *    факту, и БЕЗ колец/гриба ниже (нечего показывать — по факту ничего не случилось).
 * 2. Расходящееся кольцо — визуальная граница радиуса поражения (цель + 6 соседей), медленно растёт
 *    от 0 до охвата всех задетых гексов, толщина и яркость убывают по мере роста (классическая
 *    «ударная волна»). Только при реальном попадании.
 * 3. Гриб — ножка (дым/пыль) поднимается от гекса цели, наверху расширяется неровная «шапка» из
 *    нескольких пересекающихся кругов (с тёплым отсветом снизу), после подъёма недолго держится и
 *    тает. Только при реальном попадании.
 * Чисто визуальный эффект, состояние партии этим ходом уже применено на сервере. */
function playNuclearStrikeAnimation(strike: NonNullable<net.ActionResult["nuclearStrike"]>) {
  const layer = new Container();
  fxLayer.addChild(layer);
  const targetCenter = hexToPixelView(strike.target.col, strike.target.row, HEX_SIZE);

  const flashPieces = (strike.hit ? strike.hexes : [strike.target]).map((h, i) => {
    const center = hexToPixelView(h.col, h.row, HEX_SIZE);
    const isTarget = i === 0;
    const g = new Graphics();
    layer.addChild(g);
    return { g, x: center.x, y: center.y, maxR: HEX_SIZE * (isTarget ? 1.3 : 0.85) };
  });
  const flashDurationMs = 500;

  const ringG = strike.hit ? new Graphics() : null;
  if (ringG) layer.addChild(ringG);
  const ringDelayMs = 150;
  const ringDurationMs = 1700;
  const ringMaxR = HEX_SIZE * 2.5;

  const cloudG = strike.hit ? new Graphics() : null;
  if (cloudG) layer.addChild(cloudG);
  const cloudDelayMs = 250;
  const cloudRiseMs = 1300;
  const cloudHoldMs = 500;
  const cloudFadeMs = 700;
  const cloudTotalMs = cloudRiseMs + cloudHoldMs + cloudFadeMs;

  const totalDurationMs = strike.hit ? cloudDelayMs + cloudTotalMs : flashDurationMs;
  const start = performance.now();
  const step = () => {
    const elapsed = performance.now() - start;
    if (elapsed >= totalDurationMs) {
      fxLayer.removeChild(layer);
      layer.destroy({ children: true });
      return;
    }

    const ft = Math.min(1, elapsed / flashDurationMs);
    for (const p of flashPieces) {
      p.g.clear();
      if (ft >= 1) continue;
      const r = p.maxR * Math.min(1, ft * 2.2);
      const alpha = 1 - ft;
      p.g.circle(p.x, p.y, r).fill({ color: 0xffcc33, alpha: alpha * 0.55 }).circle(p.x, p.y, r * 0.55).fill({ color: 0xff4020, alpha: alpha * 0.75 });
    }

    if (ringG) {
      ringG.clear();
      const rt = (elapsed - ringDelayMs) / ringDurationMs;
      if (rt > 0 && rt < 1) {
        const r = ringMaxR * rt;
        const alpha = (1 - rt) * 0.75;
        const width = HEX_SIZE * 0.12 * (1 - rt * 0.6);
        ringG.circle(targetCenter.x, targetCenter.y, r).stroke({ width, color: 0xffb347, alpha });
      }
    }

    if (cloudG) {
      cloudG.clear();
      const ct = elapsed - cloudDelayMs;
      if (ct > 0) {
        const riseT = Math.min(1, ct / cloudRiseMs);
        const fadeStart = cloudRiseMs + cloudHoldMs;
        const fadeT = ct > fadeStart ? Math.min(1, (ct - fadeStart) / cloudFadeMs) : 0;
        const alpha = 1 - fadeT;
        if (alpha > 0) {
          const stemH = HEX_SIZE * 1.7 * riseT;
          const stemTopY = targetCenter.y - stemH;
          const stemHalfWTop = HEX_SIZE * 0.32;
          const stemHalfWBase = HEX_SIZE * 0.55;
          cloudG
            .moveTo(targetCenter.x - stemHalfWBase, targetCenter.y)
            .lineTo(targetCenter.x - stemHalfWTop, stemTopY)
            .lineTo(targetCenter.x + stemHalfWTop, stemTopY)
            .lineTo(targetCenter.x + stemHalfWBase, targetCenter.y)
            .closePath()
            .fill({ color: 0x6b5d52, alpha: alpha * 0.6 });
          const capR = HEX_SIZE * (0.55 + 0.55 * riseT);
          const capY = stemTopY - capR * 0.35;
          const lobes: { dx: number; dy: number; r: number; color: number; a: number }[] = [
            { dx: 0, dy: 0, r: capR, color: 0x5a4d44, a: 0.7 },
            { dx: -capR * 0.55, dy: capR * 0.15, r: capR * 0.6, color: 0x6b5d52, a: 0.7 },
            { dx: capR * 0.55, dy: capR * 0.15, r: capR * 0.6, color: 0x6b5d52, a: 0.7 },
            { dx: 0, dy: -capR * 0.35, r: capR * 0.65, color: 0x8a7a6b, a: 0.7 },
            { dx: 0, dy: capR * 0.25, r: capR * 0.5, color: 0xd4703f, a: 0.5 },
          ];
          for (const l of lobes) {
            cloudG.circle(targetCenter.x + l.dx, capY + l.dy, l.r).fill({ color: l.color, alpha: alpha * l.a });
          }
        }
      }
    }

    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Пиратство (корабль) / грабёж (сухопутный) — по прямому запросу, один и тот же переключатель
 * (toggleRaid), разница только в подписи по категории юнита. */
function raidLabel(u: UnitInstance): string {
  const verb = u.category === "ship" ? "Пиратство" : "Грабёж";
  return u.raiding ? `🏴 ${verb} (вкл)` : `🏴 ${verb}`;
}

/** Командная панель под картой (по прямому запросу — «сейчас непонятно, как двигать юнита») —
 * показывается только для СВОЕГО выбранного юнита. «Переместить»/«Атаковать» не отдельные режимы на
 * сервере — оба сворачиваются в один клик по гексу цели (commandUnit сам решает, что это — движение
 * или атака, по содержимому клетки), так что эти две кнопки только проговаривают инструкцию в
 * hint-bar, не меняют логику. Единственное место с деталями выбранного юнита (HP/атака/защита,
 * статусы вроде «на борту корабля») — плавающая `#unit-info-panel` удалена по прямому запросу
 * (дублировала `#hex-info-panel` при наведении на гекс с юнитом). */
function renderUnitCommandBar() {
  const el = document.querySelector<HTMLDivElement>("#unit-command-bar");
  if (!el) return;
  const u = selectedUnit();
  if (!u || u.playerId !== currentPlayerIndex) {
    el.classList.remove("open");
    el.innerHTML = "";
    return;
  }
  const stats = unitStats(u);
  const hasMoveLeft = !outOfMoveThisCycle.has(u.id);
  const canMove = hasMoveLeft;
  const canAct = hasMoveLeft;
  const isRanged = stats.attackRange > 1;
  el.classList.add("open");
  // Диагностические строки (раньше жили в удалённой плавающей #unit-info-panel, «дублировала правое
  // окно наведения» — перенесены сюда, единственное оставшееся место с деталями выбранного юнита).
  const notes = [
    isAboardShip(u) ? "На борту корабля — не может атаковать/поддерживать до высадки." : "",
    landedThisCycle.has(u.id) ? "Только что высадился — ход исчерпан до нового цикла." : "",
    !hasMoveLeft ? "Не хватило хода на этот гекс в этом цикле — атака/оборона недоступны до нового." : "",
  ].filter(Boolean);
  // Атака с разбивкой по поддержке (по прямому запросу — «отображай урон юнита и размер поддержки,
  // в радиус которой он входит, сколько итого урона») — supportersFor сама фильтрует по категории
  // (только Штурмовые/Мобильные), поэтому «+N» появляется только когда поддержка реально есть.
  const supporters = supportersFor(u);
  const supportSum = supportBonusSum(supporters);
  const attackDisplay = stats.attack ? (supportSum > 0 ? `${stats.attack} + ${supportSum} = ${stats.attack + supportSum}` : `${stats.attack}`) : "—";
  el.innerHTML = `
    <div class="unit-command-name" style="color:${playerCss(u.playerId)}">${unitIconHtml(u.category, 16)} ${CATEGORY_META[u.category].label} (Э${u.epoch}) · HP ${u.hp}/${stats.hp} · Атака ${attackDisplay} · Защита ${unitTotalDefense(u)} · Ход ${stats.moveRange} · Дальность ${stats.attackRange ? effectiveAttackRange(u) : "—"}</div>
    ${notes.length ? `<div class="unit-command-note">${notes.join(" ")}</div>` : ""}
    <div class="unit-command-actions">
      <button class="unit-command-btn" data-cmd="move" ${canMove ? "" : "disabled"}>🚶 Переместить (${remainingMoveBudget(u)}/${stats.moveRange})</button>
      <button class="unit-command-btn" data-cmd="attack" ${canAct && stats.attack ? "" : "disabled"}>${isRanged ? "🏹 Атака (дистанционно)" : "⚔ Атака (в упор)"}</button>
      <button class="unit-command-btn" data-cmd="defend" ${canAct ? "" : "disabled"}>${u.defending ? "🛡 Обороняется" : "🛡 Оборона"}</button>
      <button class="unit-command-btn" data-cmd="raid" ${canAct ? "" : "disabled"}>${raidLabel(u)}</button>
    </div>
  `;
  el.querySelector<HTMLButtonElement>('[data-cmd="move"]')?.addEventListener("click", () => {
    setHint("Переместить: кликните по гексу назначения на карте (в пределах хода юнита).");
  });
  el.querySelector<HTMLButtonElement>('[data-cmd="attack"]')?.addEventListener("click", () => {
    setHint(isRanged ? "Атака: кликните по вражескому юниту или городу в пределах дальности — необязательно вплотную." : "Атака: кликните по вражескому юниту или городу на соседнем гексе.");
  });
  el.querySelector<HTMLButtonElement>('[data-cmd="defend"]')?.addEventListener("click", async () => {
    if (!canAct) return;
    const result = await sendAction("toggleDefend", { unitId: u.id });
    if (!result.ok) setHint(result.hint ?? "Не удалось переключить оборону.");
  });
  el.querySelector<HTMLButtonElement>('[data-cmd="raid"]')?.addEventListener("click", async () => {
    if (!canAct) return;
    const result = await sendAction("toggleRaid", { unitId: u.id });
    if (!result.ok) setHint(result.hint ?? "Не удалось переключить пиратство/грабёж.");
  });
}

/** Подсказка при наведении на гекс — единственная панель с деталями клетки (по прямому запросу
 * плавающая `#unit-info-panel` удалена — дублировала эту же информацию по отдельному юниту).
 * [СЖАТО ПО ПРЯМОМУ ЗАПРОСУ — «очень много информации, слова ужать до символов, владельца
 * достаточно цветом строки, не текстом»] Показывает все юниты клетки (защита ОДНИМ числом — местность
 * + активная стойка «Оборона», см. unitDefenseBreakdown), город (+ справочная защита гарнизона по
 * населению и ресурсы его региона текстом), ресурс, тип местности и лес. Карта рисует на клетке
 * маркеры обоих юнитов гарнизона (до CITY_GARRISON_CAP, см. drawCityMarkers) — оба полностью
 * командуемы, отдельного «резерва» больше нет. */
function renderHexInfoPanel() {
  const el = document.querySelector<HTMLDivElement>("#hex-info-panel");
  if (!el) return;
  if (!hoveredHex || dragging) {
    el.classList.remove("open");
    el.innerHTML = "";
    return;
  }
  const { col, row } = hoveredHex;
  const tile = doc.get(col, row);
  const terrainLabel = TERRAIN_BY_ID[tile.terrain]?.label ?? tile.terrain;
  const cityHere = cityAt(col, row);
  const unitsHere = unitsAt(col, row);
  const resourceMeta = tile.resource ? RESOURCE_META.get(tile.resource) : undefined;

  // По прямому запросу — «очень много информации, слова (атака, местность, оборона) нужно ужать до
  // символов, того защиты лишь оставить напротив юнита, чего игрока город и юнит не нужно писать
  // [текстом] — цветового обозначения достаточно»: символы вместо подписей (⚔ атака, 🛡 защита, ❤ HP),
  // один совмещённый показатель защиты на юнита (terrainDefense + defendBuffer, см.
  // unitDefenseBreakdown.total — уже 0 в бонусе, если юнит не в стойке «Оборона»), владелец — только
  // цветом строки (playerCss), без текста имени.
  const unitsHtml = unitsHere
    .map((u) => {
      const stats = unitStats(u);
      const def = unitDefenseBreakdown(u);
      const supporters = supportersFor(u);
      const supportSum = supportBonusSum(supporters);
      const attackText = stats.attack ? ` · ⚔${stats.attack}${supportSum > 0 ? `+${supportSum}` : ""}` : "";
      return `<div class="hex-info-line" style="color:${playerCss(u.playerId)}">${unitIconHtml(u.category, 14)} ${CATEGORY_META[u.category].label} Э${u.epoch}${attackText} · 🛡${def.total} · ❤${u.hp}/${stats.hp}</div>`;
    })
    .join("");
  const cityHtml = cityHere
    ? (() => {
        const g = cityGarrisonDefenseBreakdown(cityHere);
        // Номер города — та же нумерация, что в панели «Города» слева (позиция в СВОЁМ списке
        // городов владельца, 1-based), не глобальный city.id — по прямому запросу «не понять, где
        // какой по номеру город»: иначе номер на карте не совпадал бы с тем, что игрок видит в
        // панели своих городов.
        const ownerCities = cities.filter((c) => c.playerId === cityHere.playerId);
        const cityIndex = ownerCities.indexOf(cityHere) + 1;
        // Справочная защита гарнизона по населению реально в силе только пока в городе НЕТ юнитов —
        // примечание показывается только когда это отличие сейчас АКТУАЛЬНО (юниты есть), иначе оно
        // просто лишний текст (по прямому запросу — сократить объём подсказки).
        const referenceNote = unitsHere.length > 0 ? " (справочно, пока нет юнитов)" : "";
        // Ресурсы региона города — текстом, по прямому запросу «указать, какие ресурсы он добывает».
        const regionResources = [...new Set(resourcesInRegion(cityHere.regionCol, cityHere.regionRow))].map((id) => RESOURCE_META.get(id)!.label);
        const regionResourcesHtml = regionResources.length
          ? `<div class="hex-info-line hex-info-region-res">📦 Ресурсы региона: ${regionResources.join(", ")}</div>`
          : "";
        return `<div class="hex-info-line" style="color:${playerCss(cityHere.playerId)}">🏙 Город ${cityIndex}${cityHere.isCapital ? " 👑" : ""} · 👥${g.population}</div>
       <div class="hex-info-line hex-info-garrison">🏰 🛡${g.total}${referenceNote} · ⚔${CITY_GARRISON_COUNTERATTACK}</div>
       ${regionResourcesHtml}`;
      })()
    : ruins.some((r) => r.col === col && r.row === row)
      ? `<div class="hex-info-line">🏚 Руины разрушенного города</div>`
      : "";
  const resourceHtml = resourceMeta
    ? `<div class="hex-info-line">${resourceMeta.symbol} ${resourceMeta.label}${tile.resourceBlocked ? " ⛔ заблокирован катастрофой — добыча снимет блокировку, но не даст единицу" : ""}</div>`
    : "";
  const forestHtml = tile.forest ? `<div class="hex-info-line">🌲 Лес</div>` : "";
  // Превью маршрута выбранного юнита до ЭТОГО гекса (по прямому запросу — «показывай маршрут и
  // число ходов») — см. updateMovePreview/net.onPreviewPath; movePreview.col/row всегда совпадает с
  // hoveredHex к моменту рендера (оба обновляются вместе), просто дополнительная защита от гонки.
  const routeHtml =
    movePreview && movePreview.col === col && movePreview.row === row
      ? (() => {
          const { path, cost, remainingBudget, moveRange } = movePreview.result;
          const fitsThisTurn = cost <= remainingBudget;
          const extraCycles = fitsThisTurn ? 0 : Math.max(1, Math.ceil((cost - remainingBudget) / Math.max(1, moveRange)));
          const cyclesNote = fitsThisTurn ? "дойдёт в этот же ход" : `не хватит хода сейчас — доедет примерно за ${extraCycles + 1} цикл(а/ов)`;
          return `<div class="hex-info-line hex-info-route">🧭 Маршрут: ${path.length} гекс(ов), ${cost} очк. хода (осталось ${remainingBudget}/${moveRange}) — ${cyclesNote}</div>`;
        })()
      : "";
  // Превью боя выбранным юнитом по этой цели (по прямому запросу — «при выделенном своём юните и
  // наведении на противника показывать исход боя: сколько из скольки защиты снимется цифрами...
  // отступит юнит, ничья или кто-то погибнет») — только цифры (защита/HP до→после), исход отмечен
  // символом (↩ отступил, 💀 погиб), без словесного описания. См. updateAttackPreview/onPreviewAttack.
  const attackPreviewHtml =
    attackPreview && attackPreview.col === col && attackPreview.row === row
      ? (() => {
          const { defender, attacker } = attackPreview.result;
          const defOutcome = defender.died ? " 💀" : defender.retreated ? " ↩" : "";
          const lines = [`<div class="hex-info-line hex-info-combat-preview">⚔ 🛡${defender.defenseBefore}→${defender.defenseAfter} ❤${defender.hpBefore}→${defender.hpAfter}/${defender.hpMax}${defOutcome}</div>`];
          if (attacker) lines.push(`<div class="hex-info-line hex-info-combat-preview">↩ 🛡${attacker.defenseBefore}→${attacker.defenseAfter} ❤${attacker.hpBefore}→${attacker.hpAfter}/${attacker.hpMax}${attacker.died ? " 💀" : ""}</div>`);
          return lines.join("");
        })()
      : "";

  el.classList.add("open");
  el.innerHTML = `
    ${unitsHtml}
    ${cityHtml}
    <div class="hex-info-line hex-info-terrain">${terrainLabel} · (${col}, ${row})</div>
    ${resourceHtml}
    ${forestHtml}
    ${routeHtml}
    ${attackPreviewHtml}
  `;
}

/** Рабочий (free — costs the card + 1 action, no money): harvests everything the chosen region
 * currently has, all at once — no partial pick, no requireDistinct concern like Поселенец's
 * growth, since this is pure income rather than a cost to satisfy. */
async function tryWorkerCollect(city: City) {
  if (!pendingCardAction || pendingCardAction.kind !== "worker-city") return;
  const slotIndex = pendingCardAction.slotIndex;
  pendingCardAction = null;
  const result = await sendAction("workerCollect", { slotIndex, cityId: city.id });
  if (result.needsResourceChoice) {
    // Новых типов в регионе больше, чем позволяет население — выбор за игроком (по прямому
    // уточнению), сама добыча ещё не произошла, действие/карта не потрачены.
    pendingResourceChoice = {
      slotIndex,
      cityId: city.id,
      budget: result.needsResourceChoice.budget,
      options: result.needsResourceChoice.options as ResourceId[],
      population: result.needsResourceChoice.population,
      usedThisCycle: result.needsResourceChoice.usedThisCycle,
    };
    activeModal = "resource-choice";
    renderModal();
    updateHint();
    return;
  }
  if (!result.ok) setHint(result.hint ?? "Не удалось собрать ресурсы.");
}

/** Подтверждение выбора из pendingResourceChoice — повторяет workerCollect (с картой/слотом) или
 * skladCollect (без них, платно) с явным chosenTypes, смотря откуда пришёл выбор (см. `slotIndex`
 * doc у pendingResourceChoice). */
async function confirmResourceChoice(chosenTypes: ResourceId[]) {
  if (!pendingResourceChoice) return;
  const { slotIndex, cityId } = pendingResourceChoice;
  pendingResourceChoice = null;
  activeModal = null;
  const result =
    slotIndex !== undefined ? await sendAction("workerCollect", { slotIndex, cityId, chosenTypes }) : await sendAction("skladCollect", { cityId, chosenTypes });
  if (!result.ok) setHint(result.hint ?? "Не удалось собрать ресурсы.");
}

/** Склад's paid alternative to «Рабочий» — no card/hand slot involved. По прямому запросу («Склад
 * должен работать точно как Рабочий, на выбор») — та же модалка выбора, что и у workerCollect,
 * когда типов больше, чем позволяет бюджет населения города. */
async function trySkladCollect(city: City) {
  if (!pendingCardAction || pendingCardAction.kind !== "sklad-collect") return;
  pendingCardAction = null;
  const result = await sendAction("skladCollect", { cityId: city.id });
  if (result.needsResourceChoice) {
    pendingResourceChoice = {
      cityId: city.id,
      budget: result.needsResourceChoice.budget,
      options: result.needsResourceChoice.options as ResourceId[],
      population: result.needsResourceChoice.population,
      usedThisCycle: result.needsResourceChoice.usedThisCycle,
    };
    activeModal = "resource-choice";
    renderModal();
    updateHint();
    return;
  }
  if (!result.ok) setHint(result.hint ?? "Не удалось добыть ресурсы.");
}

/** Real diplomacy still doesn't exist (ТЗ 13) — per explicit instruction, every player is treated
 * as having a standing trade agreement ("Торговый союз") with every other player for this pass, so
 * the pooling/toll mechanics below have something real to exercise. Swap this for a real agreement
 * lookup once diplomacy state exists — everything downstream already keys off this one function. */
function tradeAlliesOf(playerId: number): number[] {
  return PLAYERS.filter((p) => p.id !== playerId).map((p) => p.id);
}

/** The clicked player's own cities connected to it, directly or transitively, via ROUTES THAT
 * PLAYER OWNS (BFS over `tradeRoutes` filtered to `route.playerId === playerId`). A city with no
 * routes at all is its own trivial 1-city component — matches the original "если город 1 то
 * только по нему" case from before routes existed. */
function ownRouteComponent(playerId: number, startCityId: number): City[] {
  const own = new Map(cities.filter((c) => c.playerId === playerId).map((c) => [c.id, c]));
  if (!own.has(startCityId)) return [];
  const adjacency = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a)!.push(b);
  };
  for (const r of tradeRoutes) {
    if (r.playerId !== playerId) continue;
    link(r.fromCityId, r.toCityId);
    link(r.toCityId, r.fromCityId);
  }
  const visited = new Set<number>([startCityId]);
  const queue = [startCityId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return [...visited].map((id) => own.get(id)!).filter(Boolean);
}

/** «Торговая сеть — это города, соединённые торговыми путями» (own cities, via `ownRouteComponent`
 * above) **plus**, for every player with whom there's a trade agreement (`tradeAlliesOf` — every
 * other player, for now), ALL of that ally's cities, unconditionally — matches the original,
 * pre-route wording "считаются только города стран с которыми есть торговое соглашение" (no route-
 * connectivity requirement was ever stated for an ally's own cities, only for the active player's).
 * `tollOwners` lists which allies actually contributed a city — each one is owed a flat 1💰 toll in
 * `tryTraderTrade`, "за факт проезда" through their network, regardless of how much traded. */
function tradeNetworkOf(clickedCity: City): { cities: City[]; tollOwners: number[] } {
  const own = ownRouteComponent(clickedCity.playerId, clickedCity.id);
  const ownIds = new Set(own.map((c) => c.id));
  const netCities = [...own];
  const tollOwners: number[] = [];
  for (const allyId of tradeAlliesOf(clickedCity.playerId)) {
    const allyCities = cities.filter((c) => c.playerId === allyId);
    if (!allyCities.length) continue;
    for (const c of allyCities) if (!ownIds.has(c.id)) netCities.push(c);
    tollOwners.push(allyId);
  }
  return { cities: netCities, tollOwners };
}

/** Торговец — по прямому запросу больше не разыгрывается мгновенно по клику на город: клик выбирает
 * ГОРОД, через который торгуем, и открывает окно составления (`trader-compose`) — там уже выбор
 * конкретных ресурсов и превью дохода/сети/долей других игроков (реальный расчёт — целиком на
 * сервере, `GameSession.computeTradeIncomeBreakdown`, см. её doc). */
function tryTraderTrade(city: City) {
  if (!pendingCardAction || pendingCardAction.kind !== "trader-city") return;
  const slotIndex = pendingCardAction.slotIndex;
  pendingCardAction = null;
  traderComposeState = { slotIndex, cityId: city.id, selected: null };
  traderComposePreview = null;
  activeModal = "trader-compose";
  renderHand();
  renderModal();
  requestTraderComposePreview();
}
function requestTraderComposePreview() {
  if (!traderComposeState) return;
  const resources = traderComposeState.selected ? [...traderComposeState.selected] : undefined;
  traderComposeRequestId = net.requestPreviewTraderTrade(currentPlayerIndex, traderComposeState.cityId, resources);
}
function toggleTraderResource(resource: ResourceId) {
  if (!traderComposeState?.selected) return;
  if (traderComposeState.selected.has(resource)) traderComposeState.selected.delete(resource);
  else traderComposeState.selected.add(resource);
  renderModal();
  requestTraderComposePreview();
}
function closeTraderCompose() {
  traderComposeState = null;
  traderComposePreview = null;
  activeModal = null;
  renderModal();
}
async function confirmTraderTrade() {
  if (!traderComposeState?.selected || !traderComposeState.selected.size) return;
  const { slotIndex, cityId, selected } = traderComposeState;
  closeTraderCompose();
  const result = await sendAction("traderTrade", { slotIndex, cityId, resources: [...selected] });
  if (!result.ok) setHint(result.hint ?? "Не удалось провести торговлю.");
}

function traderComposeBodyHtml(): string {
  if (!traderComposeState) return "";
  const city = cities.find((c) => c.id === traderComposeState!.cityId);
  if (!city) return `<div class="side-modal-note">Город больше не существует.</div>`;
  const preview = traderComposePreview;
  const selected = traderComposeState.selected;

  const resourceRows = preview
    ? preview.available.length
      ? preview.available
          .map((a) => {
            const meta = RESOURCE_META.get(a.resource as ResourceId)!;
            const checked = selected?.has(a.resource as ResourceId) ?? false;
            const sourceLabel = a.source === "access" ? "🏙 город" : "📦 склад";
            return `
              <label class="unit-pick-row gov-row" style="cursor:pointer">
                <input type="checkbox" data-trader-resource="${a.resource}" ${checked ? "checked" : ""} />
                <span class="unit-pick-name">${meta.symbol} ${meta.label} <i>${sourceLabel}</i></span>
              </label>`;
          })
          .join("")
      : `<div class="side-modal-note">Нет доступных торговых ресурсов (ни в городе, ни на складе).</div>`
    : `<div class="side-modal-note">Считаем…</div>`;

  const networkRows = preview?.networkCities.length
    ? preview.networkCities
        .map((nc) => `<div class="unit-pick-row gov-row" style="color:${playerCss(nc.playerId)}"><span class="unit-pick-name">${cityLabel(nc.cityId)} <i>👥${nc.population}</i></span></div>`)
        .join("")
    : `<div class="side-modal-note">—</div>`;

  const tollLines = preview?.tollBreakdown.map((t) => `<div>${playerNameHtml(t.playerId)} (толл за сеть): +${t.amount}💰</div>`).join("") ?? "";
  const raiderLines = preview?.raiderBreakdown.map((r) => `<div>⚠ Грабёж — ${playerNameHtml(r.playerId)}: +${r.amount}💰</div>`).join("") ?? "";

  return `
    <div class="side-modal-section">Город: ${cityLabel(city.id)}</div>
    <div class="side-modal-section">Доступные торговые ресурсы — отметьте, что пустить в оборот</div>
    <div class="unit-pick-list">${resourceRows}</div>
    <div class="side-modal-section">Города в торговой сети (цвет — владелец)</div>
    <div class="unit-pick-list">${networkRows}</div>
    <div class="side-modal-section">Доход</div>
    <div class="unit-pick-list">
      <div>Валовый доход сети: ${preview ? preview.grossIncome : "…"}💰</div>
      ${tollLines}
      ${raiderLines}
      <div style="margin-top:4px"><b>Вам: ${preview ? Math.round(preview.playerShare * 10) / 10 : "…"}💰</b></div>
    </div>
    <div class="choice-sell-row" style="margin-top:8px">
      <button class="side-modal-action" data-act="trader-confirm" ${selected?.size ? "" : "disabled"}>📨 Играть</button>
      <button class="side-modal-action" data-act="trader-close" style="background:#3f4a5a;border-color:#5a6a7a">Закрыть</button>
    </div>
  `;
}
function bindTraderComposeModal(backdrop: HTMLElement) {
  backdrop
    .querySelectorAll<HTMLInputElement>("[data-trader-resource]")
    .forEach((el) => el.addEventListener("change", () => toggleTraderResource(el.dataset.traderResource as ResourceId)));
  backdrop.querySelector('[data-act="trader-confirm"]')?.addEventListener("click", () => confirmTraderTrade());
  backdrop.querySelector('[data-act="trader-close"]')?.addEventListener("click", () => closeTraderCompose());
}

// --- Map overlay markers (tokens during placement, cities once resolved) ---

const markerOverlay = new Container();

/** Расстановка — «слепой» аукцион жетонами (3/2/1, см. resolvePlacement): по прямому запросу чужие
 * жетоны на карте не показываем, пока идёт этот же заход расстановки — иначе следующий игрок видел
 * бы, куда/чем уже поставили остальные (в т.ч. AI, которые ставят все свои жетоны разом заранее, см.
 * bot.ts:runAiPlacement), и мог бы сознательно перебить их ставку. Данные всё равно приходят с
 * сервера в общем снимке (как и чужие руки карт в хотсите) — секретность целиком клиентская, тем же
 * приёмом, что и рука соперника. Собственные уже поставленные жетоны текущий игрок видит как обычно. */
function drawPlacementMarkers() {
  markerOverlay.removeChildren();
  const grouped = new Map<string, PlacedToken[]>();
  const myTokens = placedTokens.filter((t) => t.playerId === currentPlayerIndex);
  for (const t of myTokens) {
    const k = `${t.col},${t.row}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(t);
  }
  for (const [, tokens] of grouped) {
    const center = hexToPixelView(tokens[0].col, tokens[0].row, HEX_SIZE);
    tokens.forEach((t, i) => {
      const offsetX = (i - (tokens.length - 1) / 2) * 16;
      const player = PLAYERS[t.playerId];
      const g = new Graphics().circle(center.x + offsetX, center.y, 10).fill({ color: player.color }).circle(center.x + offsetX, center.y, 10).stroke({ width: 2, color: 0x111111 });
      markerOverlay.addChild(g);
      const label = new Text({
        text: String(t.value),
        style: new TextStyle({ fontSize: 12, fontWeight: "bold", fill: 0x111111, fontFamily: "sans-serif" }),
      });
      label.anchor.set(0.5);
      label.position.set(center.x + offsetX, center.y + 1);
      markerOverlay.addChild(label);
    });
  }
}

/** Draws a dashed segment between two points — Pixi's Graphics has no built-in dashing, so this
 * just walks the segment in alternating draw/gap chunks. */
function dashedLine(g: Graphics, x1: number, y1: number, x2: number, y2: number, dash = 6, gap = 4) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len;
  const uy = dy / len;
  let pos = 0;
  let drawing = true;
  while (pos < len) {
    const step = Math.min(drawing ? dash : gap, len - pos);
    const sx = x1 + ux * pos;
    const sy = y1 + uy * pos;
    const ex = x1 + ux * (pos + step);
    const ey = y1 + uy * (pos + step);
    if (drawing) g.moveTo(sx, sy).lineTo(ex, ey);
    pos += step;
    drawing = !drawing;
  }
}

/** Ширина «полосы» отображения по X — период, через который склеивается заворот карты по долготе
 * (см. displayCol/hexToPixel: x = size*1.5*col). Нужна, чтобы `drawTradeRoutes` ниже могла отличить
 * сегмент, который просто пересёк текущий шов обзора, от сегмента, который реально длинный. */
const MAP_PIXEL_WIDTH = MAP_WIDTH * HEX_SIZE * 1.5;

/** Рисует один сегмент маршрута с учётом заворота карты (по прямому запросу — живой баг-репорт:
 * «торговый маршрут идёт через всю карту, хотя оптимально с учётом круглости земли — при вращении
 * маршрут ломается и снова идёт через всю планету») — соседние по МИРОВЫМ координатам гексы (путь
 * строит `GameSession.findRoutePathByCategory`, теперь тоже с учётом заворота, см. СПРАВОЧНИК) могут
 * оказаться на ПРОТИВОПОЛОЖНЫХ краях текущей отображаемой полосы, если между ними как раз проходит
 * текущий шов обзора (`viewColShift`) — прямая линия между их экранными координатами тогда тянется
 * через всю видимую карту, хотя гексы физически соседние. Если экранное расстояние между точками
 * больше половины ширины полосы — сегмент явно «завёрнутый»: вместо одной длинной линии рисуются ДВЕ
 * копии той же короткой линии, сдвинутые на ±период — какая из них попадает в видимую полосу, зависит
 * от текущего поворота обзора, но одна всегда корректно соединяет гексы возле каждого конца. */
function drawRouteSegment(g: Graphics, a: { x: number; y: number }, b: { x: number; y: number }, dash = 6, gap = 4) {
  const rawDelta = b.x - a.x;
  if (Math.abs(rawDelta) <= MAP_PIXEL_WIDTH / 2) {
    dashedLine(g, a.x, a.y, b.x, b.y, dash, gap);
    return;
  }
  const wrappedDelta = rawDelta - MAP_PIXEL_WIDTH * Math.sign(rawDelta);
  dashedLine(g, a.x, a.y, a.x + wrappedDelta, b.y, dash, gap);
  dashedLine(g, b.x - wrappedDelta, a.y, b.x, b.y, dash, gap);
}

/** Every route — a dashed polyline through each hex's centre, in the owner's colour, drawn under
 * the city/unit markers so it doesn't cross over them visually. */
function drawTradeRoutes(into: Container) {
  for (const route of tradeRoutes) {
    const player = PLAYERS[route.playerId];
    const g = new Graphics();
    for (let i = 0; i < route.path.length - 1; i++) {
      const a = hexToPixelView(route.path[i].col, route.path[i].row, HEX_SIZE);
      const b = hexToPixelView(route.path[i + 1].col, route.path[i + 1].row, HEX_SIZE);
      drawRouteSegment(g, a, b);
    }
    g.stroke({ width: 2, color: player.color });
    into.addChild(g);
  }
}

// Фильтры отображения карты (галочки «Юниты/Города/Ресурсы») — юниты рисуются поверх городов,
// города поверх маршрутов, ресурсы (renderer.markerLayer, общий с редактором карт) — в самом
// низу, под всем markerOverlay целиком (он добавлен в root позже renderer'а, см. ниже по файлу).
let showUnitsLayer = true;
let showCitiesLayer = true;
let showResourcesLayer = true;

function renderMapFilters() {
  const el = document.querySelector<HTMLDivElement>("#map-filters");
  if (!el) return;
  const row = (key: string, label: string, checked: boolean) => `
    <label class="map-filter-row"><input type="checkbox" data-filter="${key}" ${checked ? "checked" : ""}> ${label}</label>`;
  el.innerHTML =
    row("units", "Юниты", showUnitsLayer) +
    row("cities", "Города", showCitiesLayer) +
    row("resources", "Ресурсы", showResourcesLayer) +
    // Поворот обзора (по прямому запросу) — шаг ровно один регион, см. shiftMapView.
    `<button class="map-shift-btn" data-shift="-1" title="Повернуть землю на 1 регион влево — состояние партии не меняется, только вид">◀ 1 регион влево</button>` +
    `<button class="map-shift-btn" data-shift="1" title="Повернуть землю на 1 регион вправо — состояние партии не меняется, только вид">1 регион вправо ▶</button>`;
  el.querySelectorAll<HTMLInputElement>("input[data-filter]").forEach((input) =>
    input.addEventListener("change", () => {
      const on = input.checked;
      if (input.dataset.filter === "units") showUnitsLayer = on;
      else if (input.dataset.filter === "cities") showCitiesLayer = on;
      else if (input.dataset.filter === "resources") {
        showResourcesLayer = on;
        renderer.markerLayer.visible = on;
      }
      drawCityMarkers();
    })
  );
  el.querySelectorAll<HTMLButtonElement>("button[data-shift]").forEach((btn) =>
    btn.addEventListener("click", () => shiftMapView(Number(btn.dataset.shift)))
  );
}

// --- Поворот обзора карты (по прямому запросу «как бы повернув землю») -----------------------
// Чисто локальный сдвиг ОТОБРАЖЕНИЯ для того игрока, кто нажал кнопку: состояние партии и координаты
// на сервере не меняются вообще, меняется только то, какая колонка мира рисуется в какой позиции на
// экране. Шаг — один регион (REGION_SIZE_X = 4 гекса), а не один гекс: сдвиг на нечётное число
// колонок сломал бы чередование odd-q (у половины гексов сместилась бы вертикаль, карта пошла бы
// «пилой»), поэтому кнопки двигают землю ровно на регион — как и описано в запросе.
let viewColShift = 0;
/** Мировая колонка → экранная (с учётом поворота обзора). */
function displayCol(worldColumn: number): number {
  return (((worldColumn - viewColShift) % MAP_WIDTH) + MAP_WIDTH) % MAP_WIDTH;
}
/** Экранная колонка → мировая (обратно к displayCol) — для попадания клика по гексу. */
function worldColOf(displayColumn: number): number {
  return (((displayColumn + viewColShift) % MAP_WIDTH) + MAP_WIDTH) % MAP_WIDTH;
}
/** hexToPixel в экранных координатах — все рисующие функции клиента ходят через неё, чтобы поворот
 * обзора применялся к рельефу, городам, юнитам, маршрутам, туману и анимациям разом. */
function hexToPixelView(col: number, row: number, size: number): { x: number; y: number } {
  return hexToPixel(displayCol(col), row, size);
}
function shiftMapView(regions: number) {
  viewColShift = (((viewColShift + regions * REGION_SIZE_X) % MAP_WIDTH) + MAP_WIDTH) % MAP_WIDTH;
  renderer.colShift = viewColShift;
  renderer.drawAll(doc);
  if (phase === "placement") drawPlacementMarkers();
  else drawCityMarkers();
  drawFogAndRegionBorders();
  renderCrosshair();
}

// --- Перекрестие над выбранным юнитом (ТЗ §14 п.1) --------------------------------------------
let crosshairHex: { col: number; row: number } | null = null;
function renderCrosshair() {
  crosshairLayer.clear();
  if (!crosshairHex) return;
  const { x, y } = hexToPixelView(crosshairHex.col, crosshairHex.row, HEX_SIZE);
  const r1 = HEX_SIZE * 0.55;
  const r2 = HEX_SIZE * 0.85;
  crosshairLayer
    .moveTo(x - r2, y)
    .lineTo(x - r1, y)
    .moveTo(x + r1, y)
    .lineTo(x + r2, y)
    .moveTo(x, y - r2)
    .lineTo(x, y - r1)
    .moveTo(x, y + r1)
    .lineTo(x, y + r2)
    .stroke({ width: 2.5, color: 0xffd75e, alpha: 0.95 })
    .circle(x, y, r1)
    .stroke({ width: 2, color: 0xffd75e, alpha: 0.7 });
}
/** Центрирует камеру карты на гексе (ТЗ §14 п.1 — выбор юнита из модалки города подсвечивает его
 * перекрестием на карте) — не меняет zoom, просто панорамирует так, чтобы гекс оказался в центре
 * видимой области. */
function centerCameraOnHex(col: number, row: number) {
  const { x, y } = hexToPixelView(col, row, HEX_SIZE);
  const viewW = mapContentWidth / zoom;
  const viewH = mapContentHeight / zoom;
  camX = x - viewW / 2;
  camY = y - viewH / 2;
  applyMapTransform();
  crosshairHex = { col, row };
  renderCrosshair();
}

// --- Подсветка региона + стрелка (по прямому запросу — предложение дипломатии ссылается на регион,
// а карта скрыта под окном сообщения) ----------------------------------------------------------
let highlightedRegion: { rc: number; rr: number } | null = null;
/** Какое предложение уже подвинуло камеру/подсветило регион — не паникуем и не панорамируем заново
 * на КАЖДЫЙ ре-рендер модалки (иначе отменяли бы собственное панорамирование пользователя, если он
 * решит подвинуть камеру сам, пока окно ещё открыто), только когда показано ДРУГОЕ предложение. */
let regionHighlightForProposalId: number | null = null;
function renderRegionHighlight() {
  regionHighlightLayer.clear();
  if (!highlightedRegion) return;
  const { rc, rr } = highlightedRegion;
  // Bounding box по всем 6 углам всех гексов региона (hexToPixelView уже учитывает текущий поворот
  // обзора) — регион, который текущий шов карты («Повернуть землю») режет ПОПОЛАМ, отрисуется
  // некорректно (тот же класс краевого случая, что был у маршрутов/превью движения до отдельного
  // исправления — не обрабатывается здесь отдельно, встречается редко и только при неудачном
  // сочетании поворота обзора и позиции региона).
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      const center = hexToPixelView(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy, HEX_SIZE);
      for (let i = 0; i < 6; i++) {
        const { x, y } = hexCorner(center, HEX_SIZE, i);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const pad = 4;
  regionHighlightLayer
    .rect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2)
    .stroke({ width: 4, color: 0xffd75e, alpha: 0.95 });
  // Стрелка сверху, указывающая вниз на регион — регион при открытии окна намеренно подводится к
  // верхней части экрана (см. centerCameraOnRegionAvoidingModal), чтобы окно сообщения его не закрыло.
  const cx = (minX + maxX) / 2;
  const arrowBaseY = minY - pad - 8;
  const arrowTopY = arrowBaseY - 26;
  regionHighlightLayer
    .moveTo(cx, arrowTopY)
    .lineTo(cx, arrowBaseY)
    .moveTo(cx - 9, arrowBaseY - 12)
    .lineTo(cx, arrowBaseY)
    .lineTo(cx + 9, arrowBaseY - 12)
    .stroke({ width: 4, color: 0xffd75e, alpha: 0.95 });
}
/** Панорамирует камеру на центр региона, СМЕЩАЯ его к верхней части видимой области (не в центр, как
 * centerCameraOnHex) — по прямому запросу: окно входящего предложения открывается по центру экрана и
 * закрывает середину карты, а верхняя часть обычно свободна. */
function centerCameraOnRegionAvoidingModal(rc: number, rr: number) {
  const centerCol = rc * REGION_SIZE_X + (REGION_SIZE_X - 1) / 2;
  const centerRow = rr * REGION_SIZE_Y + (REGION_SIZE_Y - 1) / 2;
  const { x, y } = hexToPixelView(centerCol, centerRow, HEX_SIZE);
  const viewW = mapContentWidth / zoom;
  const viewH = mapContentHeight / zoom;
  camX = x - viewW / 2;
  camY = y - viewH * 0.2;
  applyMapTransform();
  highlightedRegion = { rc, rr };
  renderRegionHighlight();
}

/** Подсветка гексов, затронутых оповещением о глобальном катаклизме (см. renderGlobalEventsPanel) —
 * набор отдельных гексов по всей карте (не один регион, как у renderRegionHighlight), поэтому просто
 * обводит каждый гекс своим шестиугольником вместо единого bounding box. */
function renderGlobalEventHexHighlight(hexes: { col: number; row: number }[]) {
  eventHexHighlightLayer.clear();
  for (const { col, row } of hexes) {
    const center = hexToPixelView(col, row, HEX_SIZE);
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { x, y } = hexCorner(center, HEX_SIZE, i);
      pts.push(x, y);
    }
    eventHexHighlightLayer.poly(pts).stroke({ width: 4, color: 0xff6a3f, alpha: 0.95 });
  }
}

// --- Туман войны (терра инкогнита) + границы регионов по владельцу ---------------------------
// По прямому запросу: в фазе посева видны только регионы, пригодные для заселения (остальные —
// сплошная «терра инкогнита»); после заселения игрок видит только свои регионы, примыкающие к ним,
// и те, где стоит его юнит. Границы регионов красятся цветом игрока-владельца. Всё это чисто
// клиентское отображение — сервер по-прежнему шлёт полное состояние карты, никакого сокрытия
// данных на уровне протокола здесь нет (это было бы Этапом 2, вместе с настоящей многопользо-
// вательской игрой; в хотсите за одним экраном скрывать друг от друга нечего технически).

/** Регион пригоден для стартового посева — те же три проверки, что и на сервере (isInhabitedRegion
 * + regionHasFoundableTile + regionHasLandFood, см. GameSession.placeToken). По прямому запросу
 * isInhabitedRegion теперь смотрит на количество РЕСУРСОВ в регионе, а не суши. */
function regionPlaceableForSeed(rc: number, rr: number): boolean {
  let hasResource = false;
  let foundable = false;
  let landFood = false;
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      const col = rc * REGION_SIZE_X + dx;
      const row = rr * REGION_SIZE_Y + dy;
      const tile = doc.get(col, row);
      const isLand = tile.terrain !== "ocean" && tile.terrain !== "iceOcean";
      if (isLand && !tile.iceCover) foundable = true;
      if (tile.resource) {
        hasResource = true;
        const meta = RESOURCE_META.get(tile.resource);
        if (meta && meta.category === "food" && !meta.requiresWater) landFood = true;
      }
    }
  }
  return hasResource && foundable && landFood;
}

/** Соседние регионы (8-соседство), с заворотом только по колонкам — «карта круглая» запад↔восток,
 * но не через полюса (см. GameSession.regionsAdjacent, то же правило). */
function neighborRegions(rc: number, rr: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dc === 0 && dr === 0) continue;
      const nr = rr + dr;
      if (nr < 0 || nr >= REGION_GRID_H) continue;
      out.push([((rc + dc) % REGION_GRID_W + REGION_GRID_W) % REGION_GRID_W, nr]);
    }
  }
  return out;
}

/** Какие регионы видит текущий игрок прямо сейчас. */
function visibleRegions(): Set<string> {
  const visible = new Set<string>();
  if (phase === "placement") {
    for (let rc = 0; rc < REGION_GRID_W; rc++) {
      for (let rr = 0; rr < REGION_GRID_H; rr++) {
        if (regionPlaceableForSeed(rc, rr)) visible.add(`${rc},${rr}`);
      }
    }
    return visible;
  }
  const me = currentPlayerIndex;
  // Космонавтика (по прямому запросу) — снимает туман войны целиком, пока технология открыта.
  if (researchedTechs[me]?.has("Космонавтика")) {
    for (let rc = 0; rc < REGION_GRID_W; rc++) {
      for (let rr = 0; rr < REGION_GRID_H; rr++) visible.add(`${rc},${rr}`);
    }
    return visible;
  }
  for (const c of cities) {
    if (c.playerId !== me) continue;
    visible.add(`${c.regionCol},${c.regionRow}`);
    for (const [nc, nr] of neighborRegions(c.regionCol, c.regionRow)) visible.add(`${nc},${nr}`);
  }
  for (const u of units) {
    if (u.playerId !== me) continue;
    // [ИСПРАВЛЕНО] Юнит раскрывает свой регион И соседние (как город) — раньше только свой,
    // из-за чего игрок не видел, куда именно движется юнит на границе исследованного: соседний,
    // ещё не открытый регион оставался под туманом, хотя юнит в него мог физически пойти.
    const [ucol, urow] = [u.col, u.row];
    const rc = Math.floor(ucol / REGION_SIZE_X);
    const rr = Math.floor(urow / REGION_SIZE_Y);
    visible.add(`${rc},${rr}`);
    for (const [nc, nr] of neighborRegions(rc, rr)) visible.add(`${nc},${nr}`);
  }
  return visible;
}

/** Какое ребро гекса (пара индексов углов hexCorner) отделяет его от соседа по направлению `dir`
 * — индексы направлений те же, что возвращает hexNeighbors. Для flat-top odd-q таблица совпадает
 * для чётных и нечётных колонок (сами направления в hexNeighbors уже учитывают чётность), поэтому
 * одна таблица на оба случая: правое-нижнее, правое-верхнее, верх, левое-верхнее, левое-нижнее, низ. */
const EDGE_CORNERS_FOR_DIR: [number, number][] = [
  [0, 1],
  [5, 0],
  [4, 5],
  [3, 4],
  [2, 3],
  [1, 2],
];

/** Владелец региона — игрок, чей город в нём стоит (1 город на регион, ТЗ 9), иначе null. */
function regionOwner(rc: number, rr: number): number | null {
  const city = cities.find((c) => c.regionCol === rc && c.regionRow === rr);
  return city ? city.playerId : null;
}

function drawFogAndRegionBorders() {
  fogLayer.clear();
  const visible = visibleRegions();

  for (let rc = 0; rc < REGION_GRID_W; rc++) {
    for (let rr = 0; rr < REGION_GRID_H; rr++) {
      const isVisible = visible.has(`${rc},${rr}`);
      if (!isVisible) {
        // Сплошная заливка каждого гекса региона — «терра инкогнита» скрывает и рельеф, и ресурсы,
        // и чужие города/юниты (fogLayer лежит выше markerOverlay, см. порядок addChild).
        for (let dx = 0; dx < REGION_SIZE_X; dx++) {
          for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
            const center = hexToPixelView(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy, HEX_SIZE);
            const pts: number[] = [];
            for (let i = 0; i < 6; i++) {
              const p = hexCorner(center, HEX_SIZE * 0.99, i);
              pts.push(p.x, p.y);
            }
            fogLayer.poly(pts).fill({ color: 0x0b0f16 });
          }
        }
        continue;
      }
      // Видимый регион с владельцем — обводим цветом игрока ПО РЁБРАМ ГЕКСОВ (по прямому запросу —
      // «по границам гекса, а не квадратом»): для каждого гекса региона рисуем только те его рёбра,
      // за которыми лежит другой регион или край карты, — из них и складывается контур владения.
      const owner = regionOwner(rc, rr);
      if (owner === null) continue;
      for (let dx = 0; dx < REGION_SIZE_X; dx++) {
        for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
          const col = rc * REGION_SIZE_X + dx;
          const row = rr * REGION_SIZE_Y + dy;
          const center = hexToPixelView(col, row, HEX_SIZE);
          hexNeighbors(col, row).forEach(([nc, nr], dir) => {
            const outside =
              nc < 0 || nc >= MAP_WIDTH || nr < 0 || nr >= MAP_HEIGHT || Math.floor(nc / REGION_SIZE_X) !== rc || Math.floor(nr / REGION_SIZE_Y) !== rr;
            if (!outside) return;
            const [a, b] = EDGE_CORNERS_FOR_DIR[dir];
            const p1 = hexCorner(center, HEX_SIZE, a);
            const p2 = hexCorner(center, HEX_SIZE, b);
            fogLayer.moveTo(p1.x, p1.y).lineTo(p2.x, p2.y);
          });
        }
      }
      fogLayer.stroke({ width: 3, color: PLAYERS[owner].color, alpha: 0.95 });
    }
  }
}

function drawCityMarkers() {
  markerOverlay.removeChildren();
  const routeLayer = new Container();
  const cityLayer = new Container();
  const unitLayer = new Container();
  cityLayer.visible = showCitiesLayer;
  unitLayer.visible = showUnitsLayer;
  drawTradeRoutes(routeLayer);
  for (const ruin of ruins) {
    const center = hexToPixelView(ruin.col, ruin.row, HEX_SIZE);
    const mark = new Text({
      text: "🏚",
      style: new TextStyle({ fontSize: 20, fontFamily: "sans-serif" }),
    });
    mark.anchor.set(0.5);
    mark.position.set(center.x, center.y);
    cityLayer.addChild(mark);
  }
  for (const city of cities) {
    const center = hexToPixelView(city.col, city.row, HEX_SIZE);
    const player = PLAYERS[city.playerId];
    const g = new Graphics()
      .circle(center.x, center.y, 14)
      .fill({ color: 0xffffff })
      .circle(center.x, center.y, 14)
      .stroke({ width: 3, color: player.color });
    cityLayer.addChild(g);
    // Население = «уровень» города (по прямому запросу) — крупная цифра по центру маркера — это и
    // есть главное, что должно читаться с одного взгляда; 🏙 сдвинут в бейдж сверху-справа, чтобы
    // не спорить с цифрой за центр круга.
    const popLabel = new Text({
      text: String(city.population),
      style: new TextStyle({ fontSize: 15, fontWeight: "bold", fill: 0x111111, fontFamily: "sans-serif" }),
    });
    popLabel.anchor.set(0.5);
    popLabel.position.set(center.x, center.y);
    cityLayer.addChild(popLabel);
    const badge = new Text({
      text: "🏙",
      style: new TextStyle({ fontSize: 11, fontFamily: "sans-serif" }),
    });
    badge.anchor.set(0.5);
    badge.position.set(center.x + 11, center.y - 11);
    cityLayer.addChild(badge);
  }

  // Юниты (5.2/5.3/6/9) — по прямому уточнению маркер юнита стоит ПОСРЕДИНЕ гекса, верхним слоем
  // (unitLayer уже добавлен последним — см. конец функции — поверх городов). Юниты на борту корабля
  // (isAboardShip) не получают своего маркера вовсе — они «как бы внутри», как в резерве гарнизона
  // города, а не отдельная фигура на гексе. Клик — обработчик в pointerup canvas-листенере, здесь
  // только наведение (hover), поскольку клик уже завязан на весь остальной pointerup-код.
  const byTile = new Map<string, UnitInstance[]>();
  for (const u of units) {
    if (isAboardShip(u)) continue;
    const k = `${u.col},${u.row}`;
    if (!byTile.has(k)) byTile.set(k, []);
    byTile.get(k)!.push(u);
  }
  // Небольшие диагональные смещения только чтобы 2 юнита на одном гексе не слились в одно пятно —
  // не широкая сетка, как раньше, а компактный стек вокруг центра.
  const STACK_OFFSETS: [number, number][] = [
    [0, 0],
    [5, -5],
    [-5, 5],
  ];
  for (const [, group] of byTile) {
    const center = hexToPixelView(group[0].col, group[0].row, HEX_SIZE);
    // И в городе, и вне его — до CITY_GARRISON_CAP=2 юнитов на клетке (canEnterHex), оба полноценно
    // командуемы, поэтому оба и получают маркер на карте.
    group.forEach((u, i) => {
      const player = PLAYERS[u.playerId];
      const [offsetX, offsetY] = STACK_OFFSETS[i] ?? STACK_OFFSETS[STACK_OFFSETS.length - 1];
      const cx = center.x + offsetX;
      const cy = center.y + offsetY;
      const isSelected = u.id === selectedUnitId;
      const container = new Container();
      container.eventMode = "static";
      container.cursor = "pointer";
      const g = new Graphics()
        .circle(cx, cy, 8)
        .fill({ color: player.color, alpha: 1 })
        .circle(cx, cy, 8)
        .stroke({ width: isSelected ? 2.5 : 1.5, color: isSelected ? 0xffd75e : 0x111111 });
      container.addChild(g);
      const icon = new Text({
        text: CATEGORY_META[u.category].icon,
        style: new TextStyle({ fontSize: 9, fontFamily: "sans-serif" }),
      });
      icon.anchor.set(0.5);
      icon.position.set(cx, cy);
      container.addChild(icon);
      const hpLabel = new Text({
        text: String(u.hp),
        style: new TextStyle({ fontSize: 8, fontWeight: "bold", fill: 0xffffff, fontFamily: "sans-serif", stroke: { color: 0x111111, width: 2 } }),
      });
      hpLabel.anchor.set(0.5);
      hpLabel.position.set(cx, cy + 10);
      container.addChild(hpLabel);
      unitLayer.addChild(container);
    });
  }
  // Порядок добавления = порядок отрисовки: маршруты внизу, города, юниты сверху всех (по запросу).
  markerOverlay.addChild(routeLayer, cityLayer, unitLayer);
}

// --- Hand / deck (playing phase) ---

const cardSlotsEl = () => document.querySelector<HTMLDivElement>("#card-slots")!;
let slotEls: HTMLDivElement[] = [];
/** Контейнер, которому реально принадлежат текущие slotEls — см. баг-репорт «когда играю карту,
 * все остальные карты исчезают» ниже в ensureHandSlotCount. */
let slotsContainer: HTMLDivElement | null = null;
/** Which hand slot currently shows the "Играть / Продать" choice popover, or null if none. */
let openCardChoiceIndex: number | null = null;

/** Поселенец needs a second click (on the map or the city list) after choosing what to do with
 * it — this holds that in-progress choice between the two clicks. Other action cards don't have a
 * target-picking step yet, so this stays settler-only for now. */
type PendingCardAction =
  | { kind: "settler-found"; slotIndex: number }
  /** `citiesLeft`/`cardConsumed` — Монотеизм (11.6) lets ONE play of this card grow 2 cities
   * instead of 1; `cardConsumed` tracks whether the hand card/action has already been spent, so
   * the 2nd city (if any) doesn't pay for the card twice. */
  | { kind: "settler-grow"; slotIndex: number; citiesLeft: number; cardConsumed: boolean; grownCityIds: number[] }
  | { kind: "warrior-city"; slotIndex: number }
  | { kind: "warrior-money-city"; slotIndex: number }
  | { kind: "worker-city"; slotIndex: number }
  /** Рабочий, альтернативное применение (по прямому запросу, доступно только с «Геологоразведка») —
   * тип ресурса уже выбран в модалке (см. startWorkerMine/pickWorkerMineResource), ждём клика по
   * гексу Равнины без ресурса в своём регионе — добывает 1 единицу выбранного ресурса, превращая
   * гекс в Пустыню; тот же режим прицела по гексу, что у «Строитель: срубить лес» (builder-chop). */
  | { kind: "worker-mine"; slotIndex: number; resource: ResourceId }
  /** Склад's own paid version of "Рабочий" — no hand card involved, so no slotIndex. */
  | { kind: "sklad-collect" }
  /** Казарма's own card-less version of «Воин» — same city-then-unit-type flow (pickKazarmaCity/
   * buildUnit reuse warriorTargetCity and the same "warrior-unit" modal), no hand card involved. */
  | { kind: "kazarma-city" }
  /** No separate target-picking step — the always-visible buildings panel (right rail) IS the
   * "окно строительства"; clicking a free cell there while this is active builds it. */
  | { kind: "builder-select"; slotIndex: number }
  /** Строитель, альтернативное применение (по прямому уточнению — «силикатов критично не
   * хватает», сбалансировано позже тем же уточнением) — вместо стройки добывает 1 Силикат за 1
   * пищевой, если в регионе выбранного города есть гора. */
  | { kind: "builder-mine"; slotIndex: number }
  /** Строитель, ещё одно альтернативное применение — перенесено с Рабочего по прямому запросу
   * («рабочие очень нужны, тратить их на лес невыгодно, ведёт к нехватке леса»): клик по гексу с
   * лесом на своей территории, как у «Рост леса» (forest-plant), только рубит, а не сажает. */
  | { kind: "builder-chop"; slotIndex: number }
  | { kind: "trader-city"; slotIndex: number }
  /** Событие «Рост леса» (3.2.4) — клик по гексу на карте, как у Поселенца-основателя, только
   * сажает лес вместо города. */
  | { kind: "forest-plant"; slotIndex: number }
  /** «Рост леса», второе применение (Генная инженерия, по прямому запросу) — тип ресурса уже выбран
   * в модалке (см. startGeneGrow/pickGeneGrowResource), ждём клика по гексу на карте. */
  | { kind: "gene-grow"; slotIndex: number; resource: ResourceId }
  /** Аэропорт (ТЗ 4.4) — юнит уже выбран в модалке building-use, ждём клика по ЛЮБОМУ гексу карты
   * (не по региону/городу, в отличие от всех остальных target-режимов выше). */
  | { kind: "aeroport-target"; unitId: number }
  /** Ядерный арсенал, применение ЯО (по прямому запросу) — та же схема, что у Аэропорта: модалка
   * закрыта, ждём клика по ЛЮБОМУ гексу карты (цель — территория противника, с которым идёт война;
   * сервер сам это проверяет, клиент не фильтрует заранее). */
  | { kind: "nuclear-target" }
  /** «Право прокладки маршрута» (см. GameSession.makeRouteRightCard/playRouteRightCard, по прямому
   * уточнению) — та же механика 2 кликов, что у pendingRoute, только источник карта в руке, а не
   * серверное состояние после исследования: первый город обязан быть своим (`fromCityId`), второй —
   * любой (свой или чужой). */
  | { kind: "routeRight-city"; slotIndex: number; fromCityId: number | null };
let pendingCardAction: PendingCardAction | null = null;

/** Рабочему не хватило лимита населения на все новые типы региона — ответ workerCollect с
 * `needsResourceChoice` открывает эту модалку вместо немедленной добычи (см. tryWorkerCollect). */
/** `slotIndex` отсутствует — выбор пришёл от Склада (`skladCollect`, платно, без карты/слота), а не
 * от «Рабочего» (`workerCollect`, бесплатно, слот обязателен) — по прямому запросу («Склад должен
 * работать точно как Рабочий, на выбор») оба используют одну и ту же модалку выбора ресурса. */
let pendingResourceChoice: { slotIndex?: number; cityId: number; budget: number; options: ResourceId[]; population: number; usedThisCycle: number } | null = null;

function cancelPendingCardAction() {
  if (!pendingCardAction && !pendingRouteFromCityId && !pendingRouteRedirect && !pendingTradeRouteNew && !pendingTradeRouteDelete && !pendingResourceChoice && !pendingCommunismCityPick) return;
  pendingCardAction = null;
  pendingResourceChoice = null;
  // pendingRoute сам — состояние сервера (см. GameSession.PendingRoute), отменить его тут нельзя,
  // отменяем только локальный первый клик (см. pendingRouteFromCityId выше).
  pendingRouteFromCityId = null;
  pendingRouteRedirect = null; // nothing was ever spent for this one — payment is deferred to resolution, so a bare cancel is free
  pendingTradeRouteNew = null;
  pendingTradeRouteDelete = null;
  pendingCommunismCityPick = false;
  renderCityList(); // drops the "growable" highlighting
  renderModal();
  updateHint();
}
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (pauseMenuOpen) {
    togglePauseMenu(false);
    return;
  }
  const hadPending = !!pendingCardAction || pendingRouteIsMine() || !!pendingRouteRedirect || !!pendingTradeRouteNew || !!pendingTradeRouteDelete || !!pendingCommunismCityPick || selectedUnitId !== null;
  cancelPendingCardAction();
  if (selectedUnitId !== null) selectUnit(null);
  // Ничего не было в процессе — ESC открывает меню паузы (ТЗ: «вызов меню по кнопке ESC»),
  // а не отменяет несуществующее действие впустую.
  if (!hadPending) togglePauseMenu(true);
});

/** Слотов ровно столько, сколько реально карт в руке (не меньше HAND_SIZE — стабильный вид пустой
 * руки) — по прямому запросу («часть карт не видно, если в руке больше 7»). Раньше слоты заводились
 * фиксированно, один раз при входе в фазу playing (`buildHandSlotEls`, вызывалась ровно один раз) —
 * 8-я и далее карта (рука временно раздувается раздачей/передачами до конца хода этого игрока, см.
 * ТЗ 2.3) просто не имела, куда отрисоваться, и была не видна вообще. Вызывается из renderHand()
 * КАЖДЫЙ раз — лишние слоты убираются, недостающие добавляются, уже существующие не пересоздаются
 * зря (клик-обработчики свежесозданных слотов индексируются по их позиции на момент создания —
 * это всегда «хвост» списка, раз слоты удаляются только с конца, порядок не сбивается). */
function ensureHandSlotCount(count: number) {
  const container = cardSlotsEl();
  // Баг-репорт «когда играю карту, все остальные карты исчезают» — renderBottomBar() пересоздаёт
  // #card-slots С НУЛЯ (innerHTML) на КАЖДЫЙ полный рендер (после каждого действия/ответа сервера),
  // а не только когда меняется фаза/число слотов. slotEls раньше считались валидными, пока их
  // ДЛИНА не менялась — но сам DOM-узел контейнера при этом уже подменялся на новый пустой, и старые
  // элементы оставались висеть отсоединёнными от документа (обновлялись невидимо). Если контейнер
  // сменился — забываем старые ссылки и строим слоты заново уже в новом контейнере.
  if (container !== slotsContainer) {
    slotEls = [];
    slotsContainer = container;
  }
  const target = Math.max(HAND_SIZE, count);
  while (slotEls.length < target) {
    const i = slotEls.length;
    const slot = document.createElement("div");
    slot.className = "card-slot";
    slot.addEventListener("click", () => onCardSlotClick(i));
    container.appendChild(slot);
    slotEls.push(slot);
  }
  while (slotEls.length > target) {
    slotEls.pop()!.remove();
  }
}

/** Clicking a playable card doesn't play it outright any more — it opens a choice between
 * playing it (unchanged behaviour) and listing it on the market at a price 1-5 instead. */
function onCardSlotClick(i: number) {
  const hand = hands[currentPlayerIndex];
  if (!hand[i]) return;
  // По прямому запросу — «выбор другой карты должен снимать выделение с юнита»: клик по карте — это
  // карточные слоты (DOM, не canvas), совсем другой обработчик клика, чем у юнита на карте
  // (tryCommandSelectedUnit сам снимает выбор, но только на СВОИХ кликах по канвасу) — без этой
  // строки юнит оставался выбранным (подсвеченным, с открытым превью хода) параллельно с открывшимся
  // выбором карты, будто ничего не произошло.
  if (selectedUnitId !== null) selectUnit(null);
  // Обязательная передача карты (ТЗ 2.3) перехватывает клик по ЛЮБОЙ карте — не тратит действий,
  // так что actionsLeft<=0 её не блокирует; это единственное, что вообще можно сделать сейчас.
  if (mustHandoff.has(currentPlayerIndex)) {
    handoffSlotIndex = i;
    activeModal = "handoff-pick";
    renderModal();
    return;
  }
  if (isSlotListed(currentPlayerIndex, i)) {
    setHint("Эта карта выставлена на продажу — недоступна для игры, пока её не купят.");
    return;
  }
  // «Право прокладки маршрута» — не карта из колоды, а остаточное право (см.
  // GameSession.playRouteRightCard) — по прямому запросу играется БЕСПЛАТНО по действиям, поэтому
  // 0 действий её не блокирует, как и обязательную передачу карты выше.
  if (actionsLeft[currentPlayerIndex] <= 0 && hand[i].id !== "routeRight") return;
  // Если другая карта уже была вооружена и ждёт цели на карте (settler-found и т.п., см.
  // PendingCardAction) — по прямому уточнению «что за ошибка карта поселения недоступна в этом
  // слоте»: ничего раньше не мешало тем временем разыграть ЕЩЁ одну карту первой; consumeHandCard
  // на сервере вырезает её из руки (splice), из-за чего сохранённый slotIndex вооружённой карты
  // указывал уже не туда, и сервер отвечал непонятным «недоступна в этом слоте». Открытие выбора
  // для ЛЮБОЙ карты теперь сразу отменяет незавершённое ожидание цели — тот же путь, что и Esc.
  cancelPendingCardAction();
  openCardChoiceIndex = openCardChoiceIndex === i ? null : i; // click again to close
  renderHand();
}

/** Обязательная передача карты (ТЗ 2.3) — тонкая обёртка над сервером. */
async function doHandoff(targetPlayerId: number) {
  if (handoffSlotIndex === null) return;
  const slotIndex = handoffSlotIndex;
  handoffSlotIndex = null;
  activeModal = null;
  const result = await sendAction("handoffCard", { slotIndex, targetPlayerId });
  if (!result.ok) setHint(result.hint ?? "Не удалось передать карту.");
}

/** Поселенец has two named actions instead of a plain "Играть" — each starts a target-picking
 * step (see PendingCardAction) rather than resolving immediately. */
function cardChoiceHtml(i: number, card: CardDef): string {
  const primary =
    card.id === "settler"
      ? `<button class="choice-play" data-i="${i}" data-act="found">🏙 Основать поселение</button>
         <button class="choice-play" data-i="${i}" data-act="grow">👥 Увеличить население</button>`
      : card.id === "warrior"
        ? `<button class="choice-play" data-i="${i}" data-act="warrior">⚔ Выбрать город</button>
           ${researchedTechs[currentPlayerIndex]?.has("Всеобщая воинская повинность") ? `<button class="choice-play" data-i="${i}" data-act="warriorMoney" title="Купить юнита за деньги (эпоха × 2💰) вместо ресурсов — стоит 1 население города, не чаще раза за цикл в одном городе">💰 Купить за деньги</button>` : ""}`
        : card.id === "worker"
          ? `<button class="choice-play" data-i="${i}" data-act="worker">🧑‍🌾 Выбрать регион</button>
             ${researchedTechs[currentPlayerIndex]?.has("Геологоразведка") ? `<button class="choice-play" data-i="${i}" data-act="workerMine" title="Равнина без ресурса своей территории → Пустыня, +1 стратегический ресурс на выбор на склад (необратимо)">⛏ Добыть стратегический ресурс</button>` : ""}`
          : card.id === "builder"
            ? card.freeBuilding
              ? `<button class="choice-play" data-i="${i}" data-act="builder" title="Бонус первооткрывателя «Архитектуры» — построить 1 здание бесплатно, из уже открытых технологий">🏛 Построить бесплатно</button>`
              : `<button class="choice-play" data-i="${i}" data-act="builder">🏗 Открыть стройку</button>
               <button class="choice-play" data-i="${i}" data-act="builderMine">⛏ Добыть силикат (горы, 1 еда → 1 Si)</button>
               <button class="choice-play" data-i="${i}" data-act="builderChop">🪓 Срубить лес (1 еда → 2 Лес)</button>`
            : card.id === "trader"
              ? `<button class="choice-play" data-i="${i}" data-act="trader">💱 Выбрать город</button>`
              : card.id === "scientist"
                ? allTechsResearched(currentPlayerIndex)
                  ? `<button class="choice-play" data-i="${i}" data-act="scientistEndgame" title="Все технологии партии уже открыты — выберите 1 из 4 особых эффектов">🎁 Особый эффект</button>`
                  : `<button class="choice-play" data-i="${i}" data-act="scientist">🔬 Открыть технологию</button>`
                : card.id === "sale"
                  ? `<button class="choice-play" data-i="${i}" data-act="sale">💵 Распродать руку</button>`
                  : card.id === "taxes"
                    ? `<button class="choice-play" data-i="${i}" data-act="taxes">💰 Собрать налоги</button>`
                    : card.id === "catastrophe"
                      ? `<button class="choice-play" data-i="${i}" data-act="catastrophe">☠ Разыграть</button>`
                      : card.id === "forestGrowth"
                        ? `<button class="choice-play" data-i="${i}" data-act="forestGrowth">🌲 Посадить лес${card.freeForestGrowth ? " (бесплатно)" : ""}</button>
                           ${!card.freeForestGrowth && researchedTechs[currentPlayerIndex]?.has("Генная инженерия") ? `<button class="choice-play" data-i="${i}" data-act="geneGrow">🌾 Вырастить ресурс</button>` : ""}`
                        : card.id === "tradeRoute"
                          ? `<button class="choice-play" data-i="${i}" data-act="tradeRoute-new">🛤 Новый путь</button>
                             <button class="choice-play" data-i="${i}" data-act="tradeRoute-redirect">🔀 Перенаправить путь</button>
                             <button class="choice-play" data-i="${i}" data-act="tradeRoute-delete">🗑 Удалить путь</button>`
                          : card.id === "mobilization"
                            ? `<button class="choice-play" data-i="${i}" data-act="mobilization">📯 Мобилизация (10💰)</button>`
                            : card.id === "routeRight"
                              ? `<button class="choice-play" data-i="${i}" data-act="routeRight">🛤 Выбрать города</button>`
                              : `<button class="choice-play" data-i="${i}" data-act="play">▶ Играть</button>`;
  // Продать можно только карту действия, не события (ТЗ 11.5 — редизайн «одно окно»: продажа
  // теперь запускается прямо из этого попапа, а не отдельной кнопкой+кликом по цели).
  const sell = card.kind === "action" ? `<button class="choice-play choice-sell" data-i="${i}" data-act="sell">💲 Продать</button>` : "";
  return `<div class="card-choice">${primary}${sell}</div>`;
}

// Slots show which type of card sits there (action vs event) but not its name — the exact
// hand a player ends up with is random and not something to spell out yet at this layout stage.
function renderHand() {
  const hand = hands[currentPlayerIndex];
  const left = actionsLeft[currentPlayerIndex];
  ensureHandSlotCount(hand.length);
  // Наложение карт друг на друга вместо переноса на вторую строку (по прямому запросу) — если рука
  // не помещается в один ряд без наложения (> CARD_ROW_BUDGET по ширине), каждый следующий слот
  // сдвигается навстречу предыдущему ровно настолько, чтобы вся рука влезла в один ряд целиком;
  // z-index растёт слева направо — «эффект веера», поздние карты лежат поверх более ранних, а
  // наведённая (.card-slot:hover в style.css) временно всплывает поверх всех.
  const n = slotEls.length;
  const naturalWidth = n * CARD_W + Math.max(0, n - 1) * CARD_GAP;
  const overlap = n > 1 && naturalWidth > CARD_ROW_BUDGET ? (naturalWidth - CARD_ROW_BUDGET) / (n - 1) : 0;
  slotEls.forEach((el, i) => {
    const card = hand[i];
    if (overlap > 0 && i > 0) {
      el.style.marginLeft = `-${overlap}px`;
      el.style.zIndex = String(i);
    } else {
      el.style.marginLeft = "";
      el.style.zIndex = "";
    }
    const listed = !!card && isSlotListed(currentPlayerIndex, i);
    const choiceOpen = openCardChoiceIndex === i && !!card && !listed;
    el.classList.toggle("empty", !card);
    el.classList.toggle("event", card?.kind === "event");
    el.classList.toggle("free-monarchy", !!card?.freeMonarchy);
    el.classList.toggle("free-fascism", !!card?.freeFascism);
    el.classList.toggle("free-education", !!card?.freeEducation);
    el.classList.toggle("free-building", !!card?.freeBuilding);
    el.classList.toggle("free-parliamentarism", !!card?.freeParliamentarism);
    el.classList.toggle("free-forest-growth", !!card?.freeForestGrowth);
    el.classList.toggle("playable", !!card && left > 0 && !listed);
    el.classList.toggle("choice-open", choiceOpen);
    el.classList.toggle("listed", listed);
    // Подсказка при наведении (по прямому запросу) — название, эффект и цена карты, тем же
    // паттерном title=, что уже используют res-ico/tech-node в этом файле.
    el.title = card
      ? `${card.freeMonarchy ? "⚜ Бесплатный «Рабочий» Монархии — считается в лимит руки, но не защищает от негативного эффекта сброса; обновится в конце цикла\n" : ""}${card.freeFascism ? "⚔ Бесплатный «Воин» Фашизма — считается в лимит руки, но не защищает от негативного эффекта сброса; обновится в конце цикла\n" : ""}${card.freeEducation ? "🎓 Бесплатный «Учёный» — бонус первооткрывателя «Образования», разовый; бесплатен и по действию\n" : ""}${card.freeBuilding ? "🏛 Бесплатный «Строитель» — бонус первооткрывателя «Архитектуры», разовый; бесплатен и по действию, только постройка здания\n" : ""}${card.freeParliamentarism ? "🏗 Бесплатный «Строитель» Парламентаризма — считается в лимит руки, но не защищает от негативного эффекта сброса; обновится в конце цикла\n" : ""}${card.freeForestGrowth ? "🌲 Бесплатный «Рост леса» — эндгейм-бонус «Учёного», разовый; бесплатен и по действию\n" : ""}${card.label}\n${card.effect}${card.price ? `\nЦена: ${card.price}` : ""}\nСброс (рука ≥8): ${card.discardEffect}`
      : "";
    el.innerHTML = card ? `<div class="card-icon">${CARD_ICON_SVG[card.id] ?? (card.kind === "event" ? "⚡" : "🂠")}</div>${choiceOpen ? cardChoiceHtml(i, card) : ""}` : "";
  });
  // innerHTML above wipes any previously-bound listeners, so the choice popover's own buttons
  // (if open) get rewired every render rather than once at slot-creation time like the slot itself.
  if (openCardChoiceIndex !== null) {
    const openEl = slotEls[openCardChoiceIndex];
    openEl.querySelectorAll<HTMLButtonElement>(".choice-play").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = +btn.dataset.i!;
        const act = btn.dataset.act;
        if (act === "found") startSettlerFound(i);
        else if (act === "grow") startSettlerGrow(i);
        else if (act === "warrior") startWarriorCityPick(i);
        else if (act === "warriorMoney") startWarriorMoneyCityPick(i);
        else if (act === "worker") startWorkerCollect(i);
        else if (act === "workerMine") startWorkerMine(i);
        else if (act === "builder") startBuilderSelect(i);
        else if (act === "builderMine") startBuilderMine(i);
        else if (act === "builderChop") startBuilderChop(i);
        else if (act === "trader") startTraderPick(i);
        else if (act === "scientist") startScientistPick(i);
        else if (act === "scientistEndgame") startScientistEndgamePick(i);
        else if (act === "sale") startSaleCard(i);
        else if (act === "taxes") startTaxCollection(i);
        else if (act === "catastrophe") startCatastrophe(i);
        else if (act === "forestGrowth") startForestGrowth(i);
        else if (act === "geneGrow") startGeneGrow(i);
        else if (act === "tradeRoute-new") startTradeRouteNew(i);
        else if (act === "tradeRoute-redirect") startTradeRouteRedirect(i);
        else if (act === "tradeRoute-delete") startTradeRouteDelete(i);
        else if (act === "mobilization") startMobilization(i);
        else if (act === "routeRight") startRouteRightPlay(i);
        else if (act === "sell") startSellCard(i);
        else playCard(i);
      })
    );
  }
  // Число слотов могло измениться (см. ensureHandSlotCount выше) — если рука перенеслась на вторую
  // строку (или обратно на одну), высота нижней панели меняется, карте нужно пересчитать доступное
  // место (см. fitMapToArea, вызывается и на resize окна — здесь тот же пересчёт, но по данным, а не
  // по размеру окна).
  fitMapToArea();
}

function startSettlerFound(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "settler-found", slotIndex };
  renderHand();
  updateHint();
}
function startSettlerGrow(slotIndex: number) {
  openCardChoiceIndex = null;
  const citiesLeft = playerParadigm[currentPlayerIndex] === "monotheism" ? 2 : 1;
  pendingCardAction = { kind: "settler-grow", slotIndex, citiesLeft, cardConsumed: false, grownCityIds: [] };
  renderHand();
  renderCityList(); // turns on "growable" highlighting
  updateHint();
}

function startForestGrowth(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "forest-plant", slotIndex };
  renderHand();
  updateHint();
}

/** «Рост леса» → «Вырастить ресурс» (Генная инженерия, по прямому запросу) — сначала выбор типа
 * ресурса (модалка, т.к. зависит от того, что реально есть на складе), потом клик по гексу. */
function startGeneGrow(slotIndex: number) {
  openCardChoiceIndex = null;
  geneGrowSlotIndex = slotIndex;
  activeModal = "gene-grow-pick";
  renderModal();
  updateHint();
}
function pickGeneGrowResource(resource: ResourceId) {
  if (geneGrowSlotIndex === null) return;
  pendingCardAction = { kind: "gene-grow", slotIndex: geneGrowSlotIndex, resource };
  geneGrowSlotIndex = null;
  activeModal = null;
  renderModal();
  renderHand();
  updateHint();
}
async function tryGeneGrow(col: number, row: number) {
  if (!pendingCardAction || pendingCardAction.kind !== "gene-grow") return;
  const { slotIndex, resource } = pendingCardAction;
  pendingCardAction = null;
  const result = await sendAction("growResourceOnHex", { slotIndex, col, row, resource });
  if (!result.ok) setHint(result.hint ?? "Не удалось вырастить ресурс.");
}

/** Число РАЗНЫХ видов торгового ресурса на складе (зеркалит GameSession.uniqueTradeResourceTypeCount)
 * — цена всех трёх действий карты «Торговый путь»: 2 РАЗНЫХ вида, не любые 2 единицы. */
function uniqueTradeResourceTypeCount(playerId: number): number {
  return (Object.entries(warehouse[playerId]) as [ResourceId, number][]).filter(([id, qty]) => (qty ?? 0) > 0 && RESOURCE_META.get(id)!.category === "trade").length;
}

function startTradeRouteNew(slotIndex: number) {
  openCardChoiceIndex = null;
  const player = PLAYERS[currentPlayerIndex];
  if (uniqueTradeResourceTypeCount(player.id) < 2) {
    setHint("Нужно 2 РАЗНЫХ вида торгового ресурса на складе — карту сыграть нельзя.");
    return;
  }
  pendingTradeRouteNew = { slotIndex, fromCityId: null };
  renderCityList();
  updateHint();
}

function startTradeRouteDelete(slotIndex: number) {
  openCardChoiceIndex = null;
  const player = PLAYERS[currentPlayerIndex];
  if (uniqueTradeResourceTypeCount(player.id) < 2) {
    setHint("Нужно 2 РАЗНЫХ вида торгового ресурса на складе — карту сыграть нельзя.");
    return;
  }
  if (!tradeRoutes.length) {
    setHint("На карте нет ни одного торгового пути — удалять нечего.");
    return;
  }
  pendingTradeRouteDelete = { slotIndex };
  renderCityList();
  updateHint();
}

function startTradeRouteRedirect(slotIndex: number) {
  openCardChoiceIndex = null;
  const player = PLAYERS[currentPlayerIndex];
  if (uniqueTradeResourceTypeCount(player.id) < 2) {
    setHint("Нужно 2 РАЗНЫХ вида торгового ресурса на складе — карту сыграть нельзя.");
    return;
  }
  if (!tradeRoutes.length) {
    setHint("На карте нет ни одного торгового пути — перенаправлять нечего.");
    return;
  }
  pendingRouteRedirect = { slotIndex, routeId: null, oldEndpointCityId: null };
  renderCityList();
  updateHint();
}

/** «Мобилизация» (event, ТЗ 3.2.6) — теперь тонкая обёртка над сервером ("mobilize"). */
async function startMobilization(slotIndex: number) {
  openCardChoiceIndex = null;
  const result = await sendAction("mobilize", { slotIndex });
  if (!result.ok) setHint(result.hint ?? "Не удалось разыграть карту.");
}

/** Пропуск хода игрока (ТЗ 3.2.6 негативная ветка Мобилизации, смена парадигмы) — теперь зеркалит
 * серверное состояние, ничего не мутирует локально. Сама очередь ожидающих пропуска — skippedTurn;
 * playerId, чей ход ЗАМОРОЖЕН прямо сейчас (открывает модалку «Ход пропущен») — отдельный
 * pendingSkipTurn (см. GameSession.advanceCurrentPlayer): нужен ИМЕННО отдельный флаг, иначе нельзя
 * отличить «игрок только что поставил флаг сам себе посреди своего текущего хода» (принятие
 * парадигмы) от «мы только что пришли на его замороженный ход». */
const skippedTurn = new Set<number>();
let pendingSkipTurn: number | null = null;
let pendingSkipTurnReason: "paradigm" | "religion" | "mobilization" | null = null;

function totalPopulationOf(playerId: number): number {
  return cities.filter((c) => c.playerId === playerId).reduce((sum, c) => sum + c.population, 0);
}

/** «Соберите налоги» (event, ТЗ 3.2.2) — недоимка теперь зеркалит серверное PendingTaxShortfall
 * (см. GameSession.ts); списание идёт по одному через resolveTaxShortfall, отменить нельзя. */
interface PendingTaxShortfall {
  playerId: number;
  remaining: number;
}
let pendingTaxShortfall: PendingTaxShortfall | null = null;

async function startTaxCollection(slotIndex: number) {
  openCardChoiceIndex = null;
  const result = await sendAction("collectTaxesCard", { slotIndex });
  if (!result.ok) setHint(result.hint ?? "Не удалось собрать налоги.");
}

/** «Распродажа» — без выбора цели, как «Соберите налоги» выше: сервер сам списывает по 1 ресурсу
 * каждой категории и сбрасывает всю остальную руку одним действием (см. GameSession.playSaleCard). */
async function startSaleCard(slotIndex: number) {
  openCardChoiceIndex = null;
  const result = await sendAction("playSaleCard", { slotIndex });
  setHint(result.ok ? (result.hint ?? "Распродажа завершена.") : (result.hint ?? "Не удалось разыграть карту."));
}

/** Списывает ровно один юнит или здание в счёт недоимки — не часть PendingCardAction/
 * cancelPendingCardAction, это состояние нельзя отменить. */
async function removeForTaxShortfall(target: { unitId?: number } | { buildingId?: string }) {
  if (!pendingTaxShortfall) return;
  // Недоимка может пережить конец хода игрока, которому она принадлежит (endTurn её не блокирует) —
  // шлём playerId её владельца, а не currentPlayerIndex, иначе после смены хода отклик пришёл бы
  // от чужого имени и сервер отказал бы («Сейчас нет недоимки по налогам»).
  const result = await sendAction("resolveTaxShortfall", { target }, pendingTaxShortfall.playerId);
  if (!result.ok) setHint(result.hint ?? "Не удалось списать.");
}

/** «Катастрофа» (event, ТЗ 3.2.3) — pendingCatastrophe зеркалит серверное состояние. */
interface PendingCatastrophe {
  playerId: number;
}
let pendingCatastrophe: PendingCatastrophe | null = null;

/** Предпросмотр хода AI (по прямому запросу — «прежде чем ходить подсвечивай какие карты куда
 * хочет сыграть AI... AI пока не перематывает сам, все ходы совершаются после кнопки завершить
 * ход») — зеркалит серверный GameSession.pendingAiPlan (bot.ts) один в один; поля-таргеты почти все
 * опциональны, ровно как на сервере, конкретные присутствуют в зависимости от targetKind. */
type AiPlanTargetKind = "city" | "hex" | "building" | "tech" | "player" | "market" | "proposal" | "paradigm" | "none";
interface AiPlanStep {
  order: number;
  cardSlotIndex?: number;
  cardId?: string;
  /** Приказ юниту (commandUnit/toggleDefend) — линия идёт от ЭТОЙ клетки (позиция юнита на момент
   * планирования), а не от карты в руке, см. renderAiPlanOverlay. */
  sourceUnitId?: number;
  sourceCol?: number;
  sourceRow?: number;
  /** Использование ЗДАНИЯ без карты (Космодром/Ядерный арсенал/Склад) — линия идёт от ИКОНКИ ЭТОГО
   * ЗДАНИЯ в панели построек (`.bld[data-bld=...]`), см. renderAiPlanOverlay. */
  sourceBuildingId?: string;
  targetKind: AiPlanTargetKind;
  targetCityId?: number;
  targetCol?: number;
  targetRow?: number;
  targetBuildingId?: string;
  targetTechId?: string;
  targetPlayerId?: number;
  targetResource?: ResourceId;
  label: string;
}
/** Зеркалит серверный bot.ts: StrategicPriority/STRATEGIC_PRIORITY_LABELS (по прямому запросу —
 * «пиши стратегический приоритет хода AI») — общая метка режима, которым руководствуется бот в
 * этот ход; показывается слева от колоды карт, пока подтверждается предпросмотр его хода. */
type StrategicPriority = "expansion" | "victory" | "development" | "defense" | "warPrep" | "war";
const STRATEGIC_PRIORITY_LABELS: Record<StrategicPriority, string> = {
  expansion: "🏕 Экспансия",
  victory: "🏛 Победа",
  development: "📈 Развитие",
  defense: "🛡 Оборона",
  warPrep: "🛠 Подготовка",
  war: "⚔ Война",
};
/** Полное описание режима — по прямому запросу («выведи нормальное полное описание при наведении,
 * а то куча текста не влазит») уходит в `title` (подсказку при наведении), а не в постоянно видимый
 * текст блока — там теперь только короткая метка (см. strategicOverviewHtml). Формулировки — тот же
 * смысл, что и §15.6 СПРАВОЧНИКА. */
const STRATEGIC_PRIORITY_DESCRIPTIONS: Record<StrategicPriority, string> = {
  expansion: "Экспансия: есть свободный приграничный регион под новое поселение. Порядок карт: Поселенец → Учёный → Торговый путь → Налоги → Торговец → Воин → Рабочий → Строитель → Рост леса → Катастрофа.",
  victory: "Победа: построено здание ООН — курс на победу через ООН. Порядок карт: Население → Торговый путь → Учёный → Налоги → Торговец → Рост леса → Катастрофа → Строитель → Воин → Рабочий.",
  development: "Развитие: все стратегические ресурсы эпохи доступны, угрозы захвата нет. Порядок карт: Учёный → Население → Торговый путь → Строитель → Налоги → Торговец → Воин → Рост леса → Катастрофа → Рабочий.",
  defense: "Оборона: ресурсы в порядке, но у соседа в регионе вдвое больше юнитов. Порядок карт: Население → Учёный → Воин → Налоги → Торговый путь → Торговец → Строитель → Рабочий → Рост леса → Катастрофа.",
  warPrep: "Подготовка: не хватает стратегических ресурсов эпохи, а перевеса для удара или денег на армию пока нет. Порядок карт: Население → Воин → Налоги → Учёный → Торговый путь → Торговец → Строитель → Рабочий → Рост леса → Катастрофа.",
  war: "Война: не хватает ресурсов эпохи, зато есть локальный перевес для удара и деньги на содержание армии. Порядок карт: Воин → Торговец → Налоги (если доход положительный) → Торговый путь → Учёный → Население → Рабочий → Строитель → Налоги (если отрицательный) → Рост леса → Катастрофа.",
};
/** Зеркалит серверный GameSession.PendingWarPlanInfo (по прямому запросу — «добавь где подготовка к
 * войне или война, чтоб было видно, какой город планируется захватить и ради какого ресурса, чтоб
 * понимать, соответствует ли строительство плану») — сводка активного «Плана войны», посчитанная
 * один раз вместе с самим планом хода, не отдельным запросом. */
interface PendingWarPlanInfo {
  targetPlayerId: number;
  cause: "resourceShortage" | "expansion";
  resource: ResourceId | null;
  regionCol: number;
  regionRow: number;
  targetCityCol: number | null;
  targetCityRow: number | null;
  requiresNavy: boolean;
  /** `false` — это только текущий кандидат дипломатии (вежливая просьба/дань-ультиматум), ещё не
   * формальный «План войны» (отношения пока не испортились настолько) — см. её doc на сервере. */
  isFormalPlan: boolean;
}
/** Зеркалит серверный GameSession.PendingBorderThreatInfo — конкретный приграничный регион
 * наибольшего скопления чужих юнитов (для строки «регион напряжения обороны» — см. её doc и
 * warPlanSummaryHtml ниже). */
interface PendingBorderThreatInfo {
  regionCol: number;
  regionRow: number;
  enemyPlayerId: number;
  enemyUnits: number;
}
let pendingAiPlan: {
  playerId: number;
  steps: AiPlanStep[];
  strategicPriority: StrategicPriority;
  warPlan?: PendingWarPlanInfo | null;
  borderThreat?: PendingBorderThreatInfo | null;
} | null = null;
/** Режим партии «Против AI» (по прямому запросу — «игрок не видит как ходит ИИ... каждая команда с
 * небольшой задержкой имитируя игрока») — зеркалит GameSession.autoPlayAI. В этом режиме сервер сам
 * доигрывает ходы AI по одному действию с паузой (см. wsServer.ts driveAiTurns/bot.ts
 * playAiTurnPaced) — pendingAiPlan здесь никогда не приходит (предпросмотра нет вовсе), а хотситный
 * UI хода AI (руку с картами и т.п.) на время автохода прячем — см. renderBottomBar/myPlayerId. */
let autoPlayAI = false;

/** Совет ООН (ТЗ §15.3) — кандидаты/генсек/резолюции, зеркалит GameSession. */
type OonResolutionType = "openTrade" | "worldLeader" | "banNuclear" | "neutralWaters" | "sanctions" | "greenAgenda" | "priceRegulation" | "armsLimit" | "aid" | "credit";
interface OonResolutionParams {
  targetPlayerId?: number;
  resource?: ResourceId;
  price?: number;
  limit?: number;
  amount?: number;
}
interface PendingOonResolution {
  id: number;
  type: OonResolutionType;
  params: OonResolutionParams;
  votes: Record<number, boolean>;
}
/** Зеркалит GameSession.PendingOonSecretaryElection — настоящее голосование за генсека (заменяет
 * прежнее мгновенное сравнение населения). */
interface PendingOonSecretaryElection {
  id: number;
  candidate1Id: number;
  candidate2Id: number;
  votes: Record<number, number>;
}
let oonCandidate1Id: number | null = null;
let oonCandidate2Id: number | null = null;
let oonEffectiveCandidate2Id: number | null = null;
let oonSecretaryGeneralId: number | null = null;
let pendingOonSecretaryElection: PendingOonSecretaryElection | null = null;
let pendingOonResolution: PendingOonResolution | null = null;
let oonOpenTradeActive = false;
let oonNuclearBanActive = false;
let oonNeutralWatersActive = false;
let oonSanctionedPlayerId: number | null = null;
let oonGreenAgendaActive = false;
let oonPriceRegulation: { resource: ResourceId; price: number } | null = null;
let oonArmsLimit: number | null = null;
const OON_RESOLUTION_LABEL: Record<OonResolutionType, string> = {
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
/** Черновик резолюции, которую составляет генсек, пока не отправлена (proposeOonResolution). */
let oonComposeType: OonResolutionType | null = null;
let oonComposeParams: OonResolutionParams = {};

/** Чисто для отображения — подсвечивает кнопку «Заплатить» в модалке, реальную проверку и списание
 * всё равно делает сервер. [ИСПРАВЛЕНО, по прямому запросу] Раньше проверяла строго склад — теперь
 * зеркалит GameSession.planCatastropheAvert: доступ к региону столицы, потом (эффективный) склад,
 * потом рынок за деньги, тем же planBuildingSpend, что у зданий/исследования. */
function canAvertCatastrophe(playerId: number): boolean {
  const capital = capitalCityOf(playerId);
  if (!capital) return false;
  return !!planBuildingSpend(playerId, capital, [
    { kind: "specific", resource: "wood", count: 1 },
    { kind: "specific", resource: "silicates", count: 1 },
  ]);
}

async function startCatastrophe(slotIndex: number) {
  openCardChoiceIndex = null;
  const result = await sendAction("playCatastropheCard", { slotIndex });
  if (!result.ok) setHint(result.hint ?? "Не удалось разыграть карту.");
}

async function resolveCatastropheChoice(choice: "pay" | "accept") {
  if (!pendingCatastrophe) return;
  // Та же логика, что у недоимки выше — катастрофа может остаться нерешённой после смены хода,
  // резолвить её должен владелец pendingCatastrophe, а не текущий по очереди игрок.
  const result = await sendAction("resolveCatastropheChoice", { choice }, pendingCatastrophe.playerId);
  setHint(result.ok ? (result.hint ?? "Катастрофа разрешена.") : (result.hint ?? "Не удалось обработать катастрофу."));
}

function startWarriorCityPick(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "warrior-city", slotIndex };
  renderHand();
  renderCityList(); // reuses the same "growable" gold highlighting to mean "clickable target" here too
  updateHint();
}

/** «Всеобщая воинская повинность» — по прямому запросу, альтернатива startWarriorCityPick: тот же
 * шаг выбора города, только итоговое действие — buyUnitWithMoney (см. buildUnit). */
function startWarriorMoneyCityPick(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "warrior-money-city", slotIndex };
  renderHand();
  renderCityList();
  updateHint();
}

function startWorkerCollect(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "worker-city", slotIndex };
  renderHand();
  renderCityList();
  updateHint();
}

/** Рабочий, альтернативное применение (по прямому запросу, «Геологоразведка») — сначала выбор типа
 * ресурса (модалка), потом клик по гексу на карте, тот же режим прицела, что у «Строитель: срубить
 * лес» (startBuilderChop/tryBuilderChop). */
function startWorkerMine(slotIndex: number) {
  openCardChoiceIndex = null;
  workerMineSlotIndex = slotIndex;
  activeModal = "worker-mine-pick";
  renderModal();
  updateHint();
}
function pickWorkerMineResource(resource: ResourceId) {
  if (workerMineSlotIndex === null) return;
  pendingCardAction = { kind: "worker-mine", slotIndex: workerMineSlotIndex, resource };
  workerMineSlotIndex = null;
  activeModal = null;
  renderModal();
  renderHand();
  updateHint();
}
async function tryWorkerMine(col: number, row: number) {
  if (!pendingCardAction || pendingCardAction.kind !== "worker-mine") return;
  const { slotIndex, resource } = pendingCardAction;
  pendingCardAction = null;
  const result = await sendAction("mineStrategicResource", { slotIndex, col, row, resource });
  if (!result.ok) setHint(result.hint ?? "Не удалось добыть ресурс.");
  else if (result.hint) setHint(result.hint);
}

function startTraderPick(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "trader-city", slotIndex };
  renderHand();
  renderCityList();
  updateHint();
}

/** Учёный needs no map/city target — it opens straight into the tech-pick modal (see
 * availableResearchFor / renderModal's "scientist-pick" branch). */
function startScientistPick(slotIndex: number) {
  openCardChoiceIndex = null;
  scientistSlotIndex = slotIndex;
  activeModal = "scientist-pick";
  renderHand();
  renderModal();
}

/** Confirms a tech pick from the modal — сервер сам списывает карту/действие и применяет
 * эпоху/маршрут (см. GameSession.confirmResearch). */
async function confirmResearch(techId: string) {
  if (scientistSlotIndex === null) return;
  const slotIndex = scientistSlotIndex;
  const player = PLAYERS[currentPlayerIndex];
  // Бонус первооткрывателя «Образования» — карта «Учёный» с freeEducation (id тот же "scientist",
  // поэтому кнопка/модалка выше срабатывают как для обычной карты) — сервер не берёт ни ресурсов,
  // ни действия, см. GameSession.playFreeEducationCard.
  const isFree = !!hands[player.id]?.[slotIndex]?.freeEducation;
  scientistSlotIndex = null;
  activeModal = null;
  const result = await sendAction(isFree ? "playFreeEducationCard" : "confirmResearch", { slotIndex, techId });
  if (!result.ok) setHint(result.hint ?? "Не удалось исследовать технологию.");
  else if (result.hint) window.alert(result.hint);
}

/** «Учёный», эндгейм-выбор (по прямому запросу) — все технологии партии уже открыты (см.
 * allTechsResearched), вместо tech-pick модалки открывает выбор 1 из 4 фиксированных эффектов. */
function startScientistEndgamePick(slotIndex: number) {
  openCardChoiceIndex = null;
  scientistSlotIndex = slotIndex;
  activeModal = "scientist-endgame-pick";
  renderHand();
  renderModal();
}
async function pickScientistEndgameChoice(choice: 1 | 2 | 3 | 4) {
  if (scientistSlotIndex === null) return;
  const slotIndex = scientistSlotIndex;
  scientistSlotIndex = null;
  activeModal = null;
  const result = await sendAction("useScientistEndgameEffect", { slotIndex, choice });
  if (!result.ok) setHint(result.hint ?? "Не удалось применить эффект.");
  else if (result.hint) window.alert(result.hint);
}

/** No target step of its own — the buildings panel is already always on screen, so this just
 * arms it (renderBuildings() switches free cells to "buildable" once pendingCardAction is set). */
function startBuilderSelect(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "builder-select", slotIndex };
  renderHand();
  renderBuildings();
  updateHint();
}

/** Строитель, альтернатива стройке — портирована по прямому уточнению («силикатов критично не
 * хватает», сбалансировано позже тем же уточнением): та же карта, тот же расход действия, плюс 1
 * пищевой ресурс — вместо здания добывает 1 Силикат из гор региона. */
function startBuilderMine(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "builder-mine", slotIndex };
  renderHand();
  renderCityList();
  updateHint();
}
async function tryBuilderMine(city: City) {
  if (!pendingCardAction || pendingCardAction.kind !== "builder-mine") return;
  const slotIndex = pendingCardAction.slotIndex;
  pendingCardAction = null;
  const result = await sendAction("mineMountainsForSilicates", { slotIndex, cityId: city.id });
  if (!result.ok) setHint(result.hint ?? "Не удалось добыть силикаты.");
}

/** Строитель, ещё одно альтернативное применение — перенесено с Рабочего (было бесплатно, теперь
 * 1 еды за вырубку) по прямому запросу: «рабочие очень нужны, тратить их на лес не рентабельно, что
 * ведёт к нехватке леса». Клик по гексу с лесом на своей территории — та же цель-по-гексу, что у
 * «Рост леса» (tryPlantForest), только рубит. */
function startBuilderChop(slotIndex: number) {
  openCardChoiceIndex = null;
  pendingCardAction = { kind: "builder-chop", slotIndex };
  renderHand();
  updateHint();
}
async function tryBuilderChop(col: number, row: number) {
  if (!pendingCardAction || pendingCardAction.kind !== "builder-chop") return;
  const slotIndex = pendingCardAction.slotIndex;
  pendingCardAction = null;
  const result = await sendAction("chopForest", { slotIndex, col, row });
  if (!result.ok) setHint(result.hint ?? "Не удалось вырубить лес.");
  else if (result.hint) setHint(result.hint); // последний лес в регионе — каскад опустынивания/потери ресурса, см. GameSession.cascadeLastForestLoss
}

function updateDeckCount() {
  document.querySelector<HTMLSpanElement>("#deck-count")!.textContent = String(deckCount);
}

async function playCard(slotIndex: number) {
  const hand = hands[currentPlayerIndex];
  const card = hand[slotIndex];
  if (!card || actionsLeft[currentPlayerIndex] <= 0) return;
  openCardChoiceIndex = null;
  const result = await sendAction("playCard", { slotIndex });
  if (!result.ok) setHint(result.hint ?? "Не удалось сыграть карту.");
}

/** Lists a hand card on the shared market instead of playing it — a transfer, not a play, so it
 * doesn't cost an action (same reasoning as the mandatory end-of-turn card handoff in ТЗ 2.3). */
/** Продать (ТЗ 2.3/11.5) — «Продать» лежит прямо в попапе выбора карты (для карт действия) и
 * кнопкой 💲 на каждом ресурсе склада, оба пути ведут сразу к выбору цены — никакого отдельного
 * режима «нажми кнопку, потом нажми на цель» больше нет (единое окно, редизайн 11.5). Ничего не
 * списывается до выбора цены (см. finalizeSellListing), поэтому отмена по Esc всегда бесплатна. */
type SellTarget = { kind: "card"; slotIndex: number } | { kind: "resource"; resource: ResourceId };
let pendingSellTarget: SellTarget | null = null;

function isSlotListed(playerId: number, slotIndex: number): boolean {
  return market.some((l) => l.kind === "card" && l.sellerId === playerId && l.sellerSlotIndex === slotIndex);
}

function startSellCard(slotIndex: number) {
  const player = PLAYERS[currentPlayerIndex];
  const card = hands[player.id][slotIndex];
  if (!card || card.kind !== "action" || isSlotListed(player.id, slotIndex)) return;
  openCardChoiceIndex = null;
  pendingSellTarget = { kind: "card", slotIndex };
  activeModal = "sell-price";
  renderHand();
  renderModal();
}

function startSellResource(resource: ResourceId) {
  const player = PLAYERS[currentPlayerIndex];
  if ((warehouse[player.id][resource] ?? 0) <= 0) return;
  pendingSellTarget = { kind: "resource", resource };
  activeModal = "sell-price";
  renderHand();
  renderModal();
}

/** Nothing is actually spent/removed until a price is picked here — a card listing keeps the card
 * physically in hand (just locks that slot, see CardListing.sellerSlotIndex), a resource listing
 * takes 1 unit off the warehouse right now (it has no "still there but locked" state to occupy). */
async function finalizeSellListing(price: number) {
  if (!pendingSellTarget) return;
  const target = pendingSellTarget;
  pendingSellTarget = null;
  activeModal = null;
  const result =
    target.kind === "card"
      ? await sendAction("sellCard", { slotIndex: target.slotIndex, price })
      : await sendAction("sellResource", { resource: target.resource, price });
  if (!result.ok) setHint(result.hint ?? "Не удалось выставить лот.");
}

/** Мобилизация ставит actionsLeft в GameSession.UNLIMITED_ACTIONS (999) — рисовать столько пипсов
 * было бы абсурдно, показываем один значок ∞ вместо них. */
const UNLIMITED_ACTIONS_THRESHOLD = 100;
function renderActionPips() {
  const pipsEl = document.querySelector<HTMLDivElement>("#action-pips")!;
  pipsEl.innerHTML = "";
  const left = actionsLeft[currentPlayerIndex];
  if (left >= UNLIMITED_ACTIONS_THRESHOLD) {
    pipsEl.innerHTML = `<div class="pip pip-unlimited" title="Мобилизация — безлимитные действия в этот ход">∞</div>`;
    return;
  }
  // Пипсов ровно столько, сколько действий было ВСЕГО в начале хода (actionsTotal, не max(2,
  // остаток) — по прямому запросу: «число кружков должно быть равно числу действий, а то не
  // понятно сколько из скольки использовано»). Использованные (i >= left) — просто пустые, не
  // исчезают из счёта, как раньше при бонусах от Демократии/Религии/«Управления».
  const total = Math.max(actionsTotal[currentPlayerIndex] ?? ACTIONS_PER_TURN, left);
  for (let i = 0; i < total; i++) {
    const pip = document.createElement("div");
    pip.className = "pip" + (i < left ? " filled" : "");
    pipsEl.appendChild(pip);
  }
}

/** Окно последствий переполнения руки (ТЗ 2.3, «фильтр от случайного проматывания») — зеркалит
 * ActionResult.needsDiscardConfirm с сервера (не часть общего state, отдельный round-trip как
 * needsWarConfirm). Закрытие окна ничего не отправляет на сервер и ничего не меняет — превью
 * детерминировано (см. GameSession.previewHandOverflowDiscard), те же последствия наступят, если
 * игрок всё же подтвердит конец хода с той же рукой. */
let pendingDiscardConfirm: { consequences: string[]; eliminates: boolean } | null = null;

/** Окно «склад переполнен» (по прямому уточнению — лимит проверяется только в конце хода, не в
 * процессе) — зеркалит ActionResult.needsWarehouseTrim. Жёсткий отказ конца хода: нет кнопки
 * «принять», только продать лишнее на бирже (за пределами этого окна) и повторить конец хода. */
let pendingWarehouseTrim: { total: number; cap: number; overBy: number } | null = null;

/** Конец хода — теперь тонкая обёртка над сервером ("endTurn"), включая ветку переполнения руки и
 * продвижение отложенного движения юнитов (обе теперь целиком на сервере, см. GameSession.endTurn).
 * Рука ≥8 — сервер не сбрасывает её сразу, а возвращает превью последствий (needsDiscardConfirm) —
 * показываем окно, реальный сброс идёт только по подтверждению (confirmDiscardAndEndTurn). Склад
 * сверх лимита — needsWarehouseTrim, жёсткий отказ без пути «подтвердить», проверяется сервером
 * раньше руки (см. GameSession.endTurn). */
async function onPlayingEndTurn() {
  const result = await sendAction("endTurn", {});
  if (!result.ok && result.needsWarehouseTrim) {
    pendingWarehouseTrim = result.needsWarehouseTrim;
    activeModal = "warehouse-trim";
    renderModal();
    return;
  }
  if (!result.ok && result.needsDiscardConfirm) {
    pendingDiscardConfirm = result.needsDiscardConfirm;
    activeModal = "discard-confirm";
    renderModal();
    return;
  }
  if (!result.ok) {
    setHint(result.hint ?? "Не удалось завершить ход.");
    return;
  }
  // WeGo: "endTurn" здесь применяется к МОЕМУ приватному клону раунда (сервер сам переиграет его как
  // "closeRound" на общей сессии при резолюции, см. weGoRound.ts) — раздал карты/выставил mustHandoff.
  // Кнопка «Завершить ход» в WeGo означает «сдать план» — сразу следом сигналим readyForRound, чтобы
  // не заводить отдельную кнопку «Готово» поверх уже привычной.
  if (net.myWeGoPlayer() !== null) {
    const readyResult = await net.submitReadyForRound();
    if (!readyResult.ok) {
      setHint(readyResult.hint ?? "Не удалось сдать план раунда.");
      return;
    }
    wegoPlanSubmitted = true;
    renderBottomBar();
  }
}

/** Подтверждает уже показанный предпросмотр хода AI (по прямому запросу — «кнопка подтвердить ход
 * будет перематывать ход дальше... AI сам пока не перематывает») — тонкая обёртка над сервером
 * ("confirmAiTurn", см. wsServer.ts/bot.ts): именно ЭТОТ вызов реально совершает ход, до него
 * ничего в партии не менялось, только показывался расчёт. currentPlayerIndex уже указывает на
 * AI-игрока (иначе кнопка не была бы видна), поэтому playerId брать неоткуда, кроме него же. */
async function confirmAiTurn() {
  const result = await sendAction("confirmAiTurn", {});
  if (!result.ok) setHint(result.hint ?? "Не удалось подтвердить ход AI.");
}

/** Кнопка «Пропустить» в окне skip-turn (11.6) — тот же endTurn, что и обычный конец хода; сервер
 * сам видит playerId в своём pendingSkipTurn и идёт коротким путём (без раздачи карт/обязательной
 * передачи/проверок склада-руки — см. GameSession.endTurn). */
async function skipMyTurn() {
  const result = await sendAction("endTurn", {});
  if (!result.ok) setHint(result.hint ?? "Не удалось пропустить ход.");
}

/** «Принять последствия» в окне discard-confirm — реальный сброс, тот же confirmed:true, что и в
 * GameSession.endTurn. */
async function confirmDiscardAndEndTurn() {
  const result = await sendAction("endTurn", { confirmed: true });
  pendingDiscardConfirm = null;
  activeModal = null;
  renderModal();
  if (!result.ok) setHint(result.hint ?? "Не удалось завершить ход.");
  // Землетрясение среди катаклизмов «Учёного» (ТЗ §15.1) — только визуальный эффект, состояние уже
  // применено сервером независимо от того, увидит ли игрок анимацию.
  for (const hex of result.earthquakeHexes ?? []) {
    playEarthquakeAnimation(Math.floor(hex.col / REGION_SIZE_X), Math.floor(hex.row / REGION_SIZE_Y));
  }
}

/** «Попробовать что-то ещё» — просто закрывает окно, ничего не отправляет на сервер: превью
 * детерминировано, ничего не потеряно и не изменилось (см. pendingDiscardConfirm). Доступно, только
 * пока у игрока ещё остались действия — иначе пробовать нечего, кнопка не рендерится вовсе. */
function dismissDiscardConfirm() {
  pendingDiscardConfirm = null;
  activeModal = null;
  // Тот же баг/фикс, что в closeModal() — не даём закрытому окну переполнения руки навсегда
  // спрятать ждущее предложение дипломатии/голосование ООН, см. комментарий там.
  checkPendingProposalsForCurrentPlayer();
  checkPendingOonVoteForCurrentPlayer();
  checkPendingOonSecretaryVoteForCurrentPlayer();
  renderModal();
}

// --- Map: always centered in the space above the hint/bottom bar, scaled to fit. ---
const mapArea = document.querySelector<HTMLDivElement>(".map-area")!;
const mapWrap = document.querySelector<HTMLDivElement>(".map-wrap")!;
const pixiContainer = document.querySelector<HTMLDivElement>("#pixi-container")!;

// No latitude-label margin here (client hides them) — MapRenderer places its root at local
// (20,20) in this case (showBandLabels=false). The grid's own leftmost point already sits
// `HEX_SIZE` to the left of col 0's centre, so the true left margin works out to `20 - HEX_SIZE`
// (2px) — the OLD width formula below gave the same tiny left margin but a much bigger right one
// (~55px, since it padded independently of the actual root offset), leaving the grid visibly
// off-centre. Deriving width directly from that same root offset keeps both margins identical.
const MAP_ROOT_OFFSET = 20; // must match MapRenderer's root offset for showBandLabels=false
const mapContentWidth = 2 * MAP_ROOT_OFFSET + HEX_SIZE * 1.5 * (MAP_WIDTH - 1);
const mapContentHeight = MAP_HEIGHT * Math.sqrt(3) * HEX_SIZE + HEX_SIZE * 3 + 40;

// devicePixelRatio, capped — an uncapped value on a 3x+ phone would blow the backing store past
// common GPU texture-size limits once multiplied by fit-scale and zoom below (see updateRenderResolution).
const DEVICE_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);

const pixiApp = new Application();
await pixiApp.init({ width: mapContentWidth, height: mapContentHeight, background: 0x0b0e13, antialias: true, resolution: DEVICE_PIXEL_RATIO });
pixiContainer.appendChild(pixiApp.canvas);

// Карта больше не генерируется в браузере — она приходит с сервера в первом снимке состояния
// (см. bootstrap ниже, joinRoom → updateMirrorFrom: doc.tiles = state.mapTiles). Пустой MapDoc()
// здесь — просто держатель, который renderer.drawAll() тут же перерисует, как только придут данные.
const doc = new MapDoc();

const renderer = new MapRenderer(pixiApp, false); // no band labels in the game client
renderer.drawAll(doc);
renderer.root.addChild(markerOverlay);
/** Снаряд + вспышка дальнобойных атак (см. playRangedAttackAnimation ниже) — отдельный слой НАД
 * markerOverlay, который `drawCityMarkers()` не трогает (тот делает removeChildren на СВОИХ
 * дочерних контейнерах каждый рендер — если бы анимация жила внутри markerOverlay, следующий же
 * renderCombat→drawCityMarkers сразу бы её стёр). */
const fxLayer = new Container();
renderer.root.addChild(fxLayer);
/** Туман войны + границы регионов по владельцу (см. drawFogAndRegionBorders) — САМЫЙ верхний слой:
 * терра инкогнита должна закрывать и рельеф с ресурсами (renderer.hexLayer/markerLayer), и чужие
 * города с юнитами (markerOverlay), поэтому добавляется последним. */
const fogLayer = new Graphics();
renderer.root.addChild(fogLayer);
/** Превью маршрута выбранного юнита до наведённого гекса (по прямому запросу — «при выборе клетки
 * куда переместиться показывай маршрут и число ходов») — поверх тумана, чтобы игрок всегда видел
 * собственное планирование. См. updateMovePreview/net.onPreviewPath. */
const movePreviewLayer = new Graphics();
renderer.root.addChild(movePreviewLayer);
/** Перекрестие над выбранным юнитом (ТЗ §14 п.1 — клик по юниту в модалке города подсвечивает его
 * на карте) — самый верхний слой, чтобы быть видимым и поверх тумана. */
const crosshairLayer = new Graphics();
renderer.root.addChild(crosshairLayer);
/** Подсветка региона + стрелка (по прямому запросу — «предложение ссылается на регион, а карта
 * скрыта под окном; сделай стрелку и подсвети регион»), см. renderRegionHighlight — над crosshairLayer,
 * чтобы не потеряться под перекрестием, если оба активны одновременно. */
const regionHighlightLayer = new Graphics();
renderer.root.addChild(regionHighlightLayer);
/** Подсветка гексов, затронутых оповещением о глобальном катаклизме (см. renderGlobalEventHexHighlight)
 * — над regionHighlightLayer, чтобы быть видимой в т.ч. поверх подсветки региона предложения, если
 * оба почему-то активны одновременно (крайний случай, не мешаем друг другу молча). */
const eventHexHighlightLayer = new Graphics();
renderer.root.addChild(eventHexHighlightLayer);
renderMapFilters();

/** Floor for each side rail — below this the map starts giving width back instead. */
const MIN_RAIL = 210;

// The map takes only the width it actually needs (it is normally bound by height, not width) and
// then reports that width to the layout; the rail and its mirror split everything left over. That
// keeps the map centred on the window *and* leaves no dead space beside the panels.
function fitMapToArea() {
  const cs = getComputedStyle(mapArea);
  const innerW = mapArea.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const innerH = mapArea.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const gap = parseFloat(cs.columnGap) || 0;
  // Widest the map may be while both rails still keep their minimum width.
  const widthCap = innerW - 2 * gap - 2 * MIN_RAIL;
  const scale = Math.min(innerH / mapContentHeight, widthCap / mapContentWidth, 1.5);
  const w = mapContentWidth * scale;
  const h = mapContentHeight * scale;
  pixiApp.canvas.style.width = w + "px";
  pixiApp.canvas.style.height = h + "px";
  mapWrap.style.width = w + "px";
  updateRenderResolution();
}
window.addEventListener("resize", fitMapToArea);

// --- Map zoom & pan -------------------------------------------------------------------------
// Only the map scales: the canvas element keeps its fitted size and we scale the *world* inside
// Pixi instead, so panels, cards and text are untouched. renderer.toLocal() goes through the same
// root container, so hex hit-testing keeps working at any zoom without extra maths.
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ROOT_BASE = 20; // MapRenderer's own root offset at zoom 1
let zoom = 1;
let camX = 0; // camera top-left, in unzoomed world pixels
let camY = 0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function applyMapTransform() {
  // Keep the camera inside the map: at zoom 1 the range collapses to 0 and it stays centred.
  camX = clamp(camX, 0, Math.max(0, mapContentWidth - mapContentWidth / zoom));
  camY = clamp(camY, 0, Math.max(0, mapContentHeight - mapContentHeight / zoom));
  renderer.root.scale.set(zoom);
  renderer.root.position.set((ROOT_BASE - camX) * zoom, (ROOT_BASE - camY) * zoom);
  updateRenderResolution();
}

// Backing-store resolution the same fixed-size canvas is rendered at (world/logical size stays
// mapContentWidth×mapContentHeight always — see fitMapToArea/applyMapTransform — only the pixel
// density backing that world changes here). Without this, hexes/units/resources were rendered once
// at ~1 physical pixel per world unit and then simply magnified by CSS zoom/scale, so they read fine
// zoomed all the way out but turned to mush zoomed in or stretched to fit a big screen. Recomputed
// on both resize (fit-scale changes) and zoom (camera magnification changes) so the canvas always
// carries enough real pixels for whatever is currently on screen, without over-allocating when
// zoomed out. Capped well under common GPU max-texture-size limits (8192+) even at DPR=2 and max zoom.
const RENDER_RESOLUTION_MAX = 8;
function updateRenderResolution() {
  const rect = pixiApp.canvas.getBoundingClientRect();
  const fitScale = rect.width > 0 ? rect.width / mapContentWidth : 1;
  const target = clamp(DEVICE_PIXEL_RATIO * fitScale * zoom, 1, RENDER_RESOLUTION_MAX);
  if (Math.abs(target - pixiApp.renderer.resolution) > 0.05) pixiApp.renderer.resolution = target;
}

/** Pointer position in canvas pixel space (undoing the CSS fit-scale). Uses the fixed world/logical
 * size, not pixiApp.canvas.width/height — those now vary with updateRenderResolution's backing-store
 * pixel density and would otherwise throw off every hit-test by that same factor. */
function canvasPoint(e: { clientX: number; clientY: number }) {
  const rect = pixiApp.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (mapContentWidth / rect.width),
    y: (e.clientY - rect.top) * (mapContentHeight / rect.height),
  };
}

pixiApp.canvas.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    e.preventDefault();
    const p = canvasPoint(e);
    const next = clamp(zoom * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    if (next === zoom) return;
    // Anchor on the cursor: whatever world point sits under it must stay under it.
    const worldX = camX + p.x / zoom;
    const worldY = camY + p.y / zoom;
    zoom = next;
    camX = worldX - p.x / zoom;
    camY = worldY - p.y / zoom;
    applyMapTransform();
  },
  { passive: false }
);

// Drag to pan once zoomed in. A click is only a click if the pointer barely moved, so dragging
// the map never drops a placement token by accident.
const DRAG_SLOP = 5;
let dragging = false;
let dragMoved = false;
let lastX = 0;
let lastY = 0;

pixiApp.canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  dragging = true;
  dragMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  // Best-effort: capture can throw (e.g. no active pointer with this id) in edge cases outside
  // real mouse/touch input. That must never abort the click/placement logic below.
  try {
    pixiApp.canvas.setPointerCapture(e.pointerId);
  } catch {
    /* not captured — pan/click still work off plain client coordinates */
  }
});

pixiApp.canvas.addEventListener("pointermove", (e: PointerEvent) => {
  if (!dragging) {
    // Наведение (по прямому запросу — «при наведении мыши на гекс выводи что в нём есть»), не
    // конфликтует с перетаскиванием карты (то — отдельная ветка ниже, при dragging=true).
    const p = canvasPoint(e);
    const local = renderer.toLocal(p.x, p.y);
    const hit = pixelToHex(local.x, local.y, HEX_SIZE, MAP_WIDTH, MAP_HEIGHT);
    // Экранная колонка → мировая: поворот обзора (viewColShift) не должен сбивать наведение.
    const next = hit ? { col: worldColOf(hit.col), row: hit.row } : null;
    if (hoveredHex?.col !== next?.col || hoveredHex?.row !== next?.row) {
      hoveredHex = next;
      renderHexInfoPanel();
      updateMovePreview();
      updateAttackPreview();
    }
    return;
  }
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  if (!dragMoved && Math.hypot(dx, dy) < DRAG_SLOP) return;
  dragMoved = true;
  if (zoom > 1) {
    const rect = pixiApp.canvas.getBoundingClientRect();
    // Convert the CSS-pixel drag into world pixels before applying it (see canvasPoint above for
    // why this uses the fixed world size rather than pixiApp.canvas.width/height).
    camX -= dx * (mapContentWidth / rect.width) / zoom;
    camY -= dy * (mapContentHeight / rect.height) / zoom;
    applyMapTransform();
  }
  lastX = e.clientX;
  lastY = e.clientY;
});
pixiApp.canvas.addEventListener("pointerleave", () => {
  if (hoveredHex) {
    hoveredHex = null;
    renderHexInfoPanel();
    clearMovePreview();
    clearAttackPreview();
  }
});

pixiApp.canvas.addEventListener("pointerup", (e: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  // Same defensive try/catch as the capture call above — a throw here must not swallow the
  // click/placement handling that follows.
  try {
    pixiApp.canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* nothing was captured — fine, ignore */
  }
  if (dragMoved) return;
  const p = canvasPoint(e);
  const local = renderer.toLocal(p.x, p.y);
  const hitRaw = pixelToHex(local.x, local.y, HEX_SIZE, MAP_WIDTH, MAP_HEIGHT);
  if (!hitRaw) {
    // Клик мимо всех гексов (зазор сетки/край канваса) — по прямому запросу («щелчок в область,
    // куда юнит не может двигаться, должен снимать с него выделение») раньше здесь был голый
    // `return`: если клик не попал ВООБЩЕ ни в один гекс, выбор юнита оставался висеть — ни один из
    // веток ниже (в т.ч. tryCommandSelectedUnit, который снимает выбор сам) до этого места не
    // добирался.
    if (selectedUnitId !== null) selectUnit(null);
    return;
  }
  // Экранная колонка → мировая: клик должен попадать в тот же гекс и после поворота обзора.
  const hit = { col: worldColOf(hitRaw.col), row: hitRaw.row };

  if (phase === "placement") {
    tryPlaceToken(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "settler-found") {
    tryFoundCity(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "forest-plant") {
    tryPlantForest(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "gene-grow") {
    tryGeneGrow(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "settler-grow") {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) tryGrowCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && (pendingCardAction?.kind === "warrior-city" || pendingCardAction?.kind === "warrior-money-city")) {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickWarriorCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "kazarma-city") {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickKazarmaCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "worker-city") {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) tryWorkerCollect(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "worker-mine") {
    tryWorkerMine(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "builder-chop") {
    tryBuilderChop(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "sklad-collect") {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) trySkladCollect(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "trader-city") {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) tryTraderTrade(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "builder-mine") {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) tryBuilderMine(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  // Аэропорт (ТЗ 4.4) — в отличие от всех режимов выше, цель ЛЮБОЙ гекс карты, не только клетка
  // с городом/регионом.
  if (phase === "playing" && pendingCardAction?.kind === "aeroport-target") {
    tryAeroportTarget(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "nuclear-target") {
    tryNuclearTarget(hit.col, hit.row);
    return;
  }
  if (phase === "playing" && pendingRouteIsMine()) {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickRouteCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingCardAction?.kind === "routeRight-city") {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickRouteRightCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingRouteRedirect) {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickRedirectCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingTradeRouteNew) {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickTradeRouteNewCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingTradeRouteDelete) {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickTradeRouteDeleteCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  if (phase === "playing" && pendingCommunismCityPick) {
    const rc = Math.floor(hit.col / REGION_SIZE_X);
    const rr = Math.floor(hit.row / REGION_SIZE_Y);
    const city = cityAtRegion(rc, rr);
    if (city) pickCommunismCity(city);
    else setHint("В этом регионе нет города.");
    return;
  }
  // Юниты (ТЗ 5.3/6/9) — ничего из карточных режимов выше не активно: клик по гексу с уже
  // выбранным своим юнитом отдаёт ему приказ (движение/атака), иначе пробуем выбрать юнита прямо
  // на этом гексе (с учётом очереди гарнизона в городе), а мимо — просто снимаем выбор.
  if (phase === "playing") {
    if (selectedUnitId !== null) {
      tryCommandSelectedUnit(hit.col, hit.row);
      return;
    }
    if (!tryStartUnitCommand(hit.col, hit.row)) selectUnit(null);
  }
});

// An interrupted gesture (pointer lost to the OS, touch cancelled) would otherwise leave the drag
// flag stuck on, making the next plain click read as the tail of a drag.
pixiApp.canvas.addEventListener("pointercancel", () => {
  dragging = false;
  dragMoved = false;
});

pixiApp.canvas.style.touchAction = "none";

// === Предпросмотр хода AI (по прямому запросу — см. интерфейс AiPlanStep выше) =================
// Линии от карты (в руке — она и есть текущий игрок, раз сейчас его ход, пусть и AI-управляемый) к
// цели — SVG-оверлей поверх всего стола (#ai-plan-overlay, .table position:relative), плюс общий
// нумерованный список всех действий (#ai-plan-panel, включая те без геометрической цели — биржа,
// налоги, дипломатия и т.п., см. bot.ts AiPlanStep.targetKind). Кнопка подтверждения — уже
// существующая end-turn-btn (см. renderBottomBar), здесь только показ.

/** Гекс → пиксель ВЬЮПОРТА (не мировые/не canvas-локальные координаты) — учитывает и камеру Pixi
 * (zoom/pan, renderer.root), и CSS-подгонку канваса под доступную область (fitMapToArea). */
function hexToScreen(col: number, row: number): { x: number; y: number } {
  const local = hexToPixelView(col, row, HEX_SIZE);
  const g = renderer.root.toGlobal({ x: local.x, y: local.y });
  const rect = pixiApp.canvas.getBoundingClientRect();
  const fitScale = rect.width / mapContentWidth;
  return { x: rect.left + g.x * fitScale, y: rect.top + g.y * fitScale };
}

/** Каждый план-шаг с `cardSlotIndex` действительно убирает 1 карту из руки на сервере (см.
 * bot.ts — consumeHandCard/handoffCard за каждым таким шагом) — но эти индексы записаны ОТНОСИТЕЛЬНО
 * руки НА МОМЕНТ ТОГО шага при планировании, а рука настоящей (ещё не исполненной) сессии — это
 * исходная, ЕЩЁ ПОЛНАЯ рука. Прогоняем ту же последовательность удалений здесь, чтобы для каждого
 * шага получить индекс слота в РЕАЛЬНОЙ, видимой сейчас руке. */
function resolvePlanSlotIndices(steps: AiPlanStep[], handLength: number): (number | undefined)[] {
  const remaining = Array.from({ length: handLength }, (_, i) => i);
  return steps.map((step) => {
    if (step.cardSlotIndex === undefined) return undefined;
    const orig = remaining[step.cardSlotIndex];
    if (step.cardSlotIndex >= 0 && step.cardSlotIndex < remaining.length) remaining.splice(step.cardSlotIndex, 1);
    return orig;
  });
}

const AI_PLAN_STEP_ICON: Record<AiPlanTargetKind, string> = {
  city: "🏙",
  hex: "⬡",
  building: "🏛",
  tech: "🔬",
  player: "🤝",
  market: "💱",
  proposal: "🕊",
  paradigm: "⚖",
  none: "•",
};

function clearAiPlanOverlay() {
  const svg = document.querySelector<SVGSVGElement>("#ai-plan-overlay");
  if (svg) svg.innerHTML = "";
  const panel = document.querySelector<HTMLDivElement>("#ai-plan-panel");
  if (panel) panel.classList.remove("open");
  for (const el of slotEls) {
    el.classList.remove("plan-step");
    el.querySelector(".plan-step-badge")?.remove();
    el.querySelector(".plan-handoff-arrow")?.remove();
  }
}

function renderAiPlanOverlay() {
  const svg = document.querySelector<SVGSVGElement>("#ai-plan-overlay");
  const panel = document.querySelector<HTMLDivElement>("#ai-plan-panel");
  if (!svg || !panel) return;
  const player = PLAYERS[currentPlayerIndex];
  // «Против AI» никогда не показывает предпросмотр (по прямому запросу — «игрок не видит как ходит
  // ИИ») — сервер там и не выставляет pendingAiPlan вовсе (см. bot.ts playAiTurnPaced), проверка
  // autoPlayAI здесь просто явная, а не полагается на это молча.
  if (autoPlayAI || !player?.isAI || !pendingAiPlan || pendingAiPlan.playerId !== player.id || phase !== "playing") {
    clearAiPlanOverlay();
    return;
  }

  for (const el of slotEls) {
    el.classList.remove("plan-step");
    el.querySelector(".plan-step-badge")?.remove();
    el.querySelector(".plan-handoff-arrow")?.remove();
  }

  const steps = pendingAiPlan.steps;
  const hand = hands[currentPlayerIndex] ?? [];
  const slotIndices = resolvePlanSlotIndices(steps, hand.length);
  const svgNS = "http://www.w3.org/2000/svg";
  const overlayRect = svg.getBoundingClientRect();
  const toLocal = (x: number, y: number) => ({ x: x - overlayRect.left, y: y - overlayRect.top });
  svg.innerHTML = "";

  const drawLineTo = (from: { x: number; y: number }, to: { x: number; y: number }, order: number) => {
    const a = toLocal(from.x, from.y);
    const b = toLocal(to.x, to.y);
    const path = document.createElementNS(svgNS, "path");
    // Лёгкая дуга вместо прямой — параллельные линии к разным целям от соседних карт не сливаются
    // в одну на глаз.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - Math.min(60, Math.hypot(b.x - a.x, b.y - a.y) * 0.15);
    path.setAttribute("d", `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`);
    path.setAttribute("class", "plan-line");
    svg.appendChild(path);
    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", String(a.x));
    dot.setAttribute("cy", String(a.y));
    dot.setAttribute("r", "3");
    dot.setAttribute("class", "plan-line-dot");
    svg.appendChild(dot);
    const bg = document.createElementNS(svgNS, "circle");
    bg.setAttribute("cx", String(b.x));
    bg.setAttribute("cy", String(b.y));
    bg.setAttribute("r", "10");
    bg.setAttribute("class", "plan-line-num-bg");
    svg.appendChild(bg);
    const num = document.createElementNS(svgNS, "text");
    num.setAttribute("x", String(b.x));
    num.setAttribute("y", String(b.y));
    num.setAttribute("class", "plan-line-num");
    num.textContent = String(order);
    svg.appendChild(num);
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const slotIndex = slotIndices[i];
    const cardEl = slotIndex !== undefined ? slotEls[slotIndex] : undefined;
    if (cardEl) {
      cardEl.classList.add("plan-step");
      const badge = document.createElement("div");
      badge.className = "plan-step-badge";
      badge.textContent = String(step.order);
      cardEl.appendChild(badge);
    }
    // Использование здания без карты (Космодром/Ядерный арсенал/Склад — по прямому запросу
    // «использование зданий в план тоже пиши») — та же подсветка+бейдж, что у карты, только на
    // иконке здания в панели построек.
    const sourceBldEl = !cardEl && step.sourceBuildingId ? document.querySelector<HTMLElement>(`.bld[data-bld="${step.sourceBuildingId}"]`) : undefined;
    if (sourceBldEl) {
      sourceBldEl.classList.add("plan-step");
      const badge = document.createElement("div");
      badge.className = "plan-step-badge";
      badge.textContent = String(step.order);
      sourceBldEl.appendChild(badge);
    }
    // Приказ юниту (по прямому запросу — «команды военным юнитам так же отмечаются на карте... какой
    // юнит куда собирается идти») — источник линии не карта, а клетка юнита на момент планирования.
    const from = cardEl
      ? (() => {
          const r = cardEl.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top };
        })()
      : sourceBldEl
        ? (() => {
            const r = sourceBldEl.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()
        : step.sourceCol !== undefined && step.sourceRow !== undefined
          ? hexToScreen(step.sourceCol, step.sourceRow)
          : null;
    if (!from) continue;
    // Здание, действующее САМО НА СЕБЯ (Космодром — цель тоже "building" и targetBuildingId
    // совпадает с sourceBuildingId) — линия в никуда была бы бессмысленна, достаточно бейджа выше.
    if (sourceBldEl && step.targetKind === "building" && step.targetBuildingId === step.sourceBuildingId) continue;

    if (step.targetKind === "player" && step.targetPlayerId !== undefined && cardEl) {
      // Большая стрелка НАД картой (по прямому запросу) — у других игроков нет своей видимой руки
      // на этом столе, чтобы тянуть линию буквально к ним, поэтому цель — подпись с их именем/цветом.
      const target = PLAYERS.find((p) => p.id === step.targetPlayerId);
      const arrow = document.createElement("div");
      arrow.className = "plan-handoff-arrow";
      arrow.style.setProperty("--target-color", target ? `#${target.color.toString(16).padStart(6, "0")}` : "#ffd979");
      arrow.innerHTML = `<span class="arrow-ico">⬆</span><span class="name">→ ${target?.name ?? "?"}</span>`;
      cardEl.appendChild(arrow);
      continue;
    }
    if (step.targetKind === "city" && step.targetCityId !== undefined) {
      const cityEl = document.querySelector<HTMLElement>(`.city-slot[data-city-id="${step.targetCityId}"]`);
      if (cityEl) {
        const r = cityEl.getBoundingClientRect();
        drawLineTo(from, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, step.order);
      }
      continue;
    }
    if (step.targetKind === "building" && step.targetBuildingId) {
      const bldEl = document.querySelector<HTMLElement>(`.bld[data-bld="${step.targetBuildingId}"]`);
      if (bldEl) {
        const r = bldEl.getBoundingClientRect();
        drawLineTo(from, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, step.order);
      }
      continue;
    }
    if (step.targetKind === "tech" && step.targetTechId) {
      const techEl = document.querySelector<HTMLElement>(`.tech-node[data-tech="${CSS.escape(step.targetTechId)}"]`);
      if (techEl) {
        const r = techEl.getBoundingClientRect();
        drawLineTo(from, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, step.order);
      }
      continue;
    }
    if (step.targetKind === "hex" && step.targetCol !== undefined && step.targetRow !== undefined) {
      drawLineTo(from, hexToScreen(step.targetCol, step.targetRow), step.order);
      continue;
    }
    // market/proposal/paradigm/none — без геометрической цели, только в списке ниже.
  }

  panel.classList.add("open");
  panel.innerHTML = `
    <div class="ai-plan-head"><span>🤖 План хода AI: ${player.name}</span></div>
    ${steps
      .map(
        (s) => `<div class="ai-plan-step-row"><span class="n">${s.order}</span><span>${AI_PLAN_STEP_ICON[s.targetKind]} ${s.label}</span></div>`
      )
      .join("")}
    ${steps.length === 0 ? `<div class="ai-plan-step-row"><span>Ничего не запланировано — сразу конец хода.</span></div>` : ""}
    <button class="ai-plan-confirm-btn" id="ai-plan-confirm-btn">▶ Подтвердить ход AI</button>
  `;
  document.querySelector<HTMLButtonElement>("#ai-plan-confirm-btn")?.addEventListener("click", confirmAiTurn);
}

// Геометрия карт/города/зданий/дерева технологий не меняется между снимками состояния (только
// позиция/зум карты — колесо мыши/перетаскивание/ресайз окна), но у оверлея нет единого события
// «что-то из этого сдвинулось» — дешевле держать его в синхроне лёгким постоянным тиком, чем
// оборачивать fitMapToArea/applyMapTransform/window resize по отдельности. Сам renderAiPlanOverlay
// почти всегда no-op (сразу выходит по pendingAiPlan===null), реальная работа только пока идёт показ.
function aiPlanOverlayTick() {
  if (pendingAiPlan) renderAiPlanOverlay();
  requestAnimationFrame(aiPlanOverlayTick);
}
requestAnimationFrame(aiPlanOverlayTick);

// --- «План хода AI» — перетаскиваемое окно, позиция запоминается между ходами/циклами (по прямому
// запросу — «чтоб не таскать постоянно куда удобно») -------------------------------------------
// Панель — статический DOM-узел (см. разметку выше, #ai-plan-panel), renderAiPlanOverlay только
// переписывает её innerHTML на каждый показ — инлайновый style самого узла (позиция) это не
// затрагивает, так что достаточно выставить его один раз (при перетаскивании и при загрузке из
// localStorage) и он переживёт все последующие перерисовки списка шагов сам по себе.
const AI_PLAN_PANEL_POS_KEY = "civa-ai-plan-panel-pos";
function loadAiPlanPanelPos(): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(AI_PLAN_PANEL_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.left === "number" && typeof parsed.top === "number") return parsed;
  } catch {
    // приватный режим/запрет хранения — просто остаёмся на позиции по умолчанию из CSS
  }
  return null;
}
function saveAiPlanPanelPos(left: number, top: number) {
  try {
    localStorage.setItem(AI_PLAN_PANEL_POS_KEY, JSON.stringify({ left, top }));
  } catch {
    // тихо игнорируем — это только UI-удобство, не игровое состояние
  }
}
(function applySavedAiPlanPanelPos() {
  const pos = loadAiPlanPanelPos();
  if (!pos) return;
  const panel = document.querySelector<HTMLDivElement>("#ai-plan-panel");
  if (!panel) return;
  panel.style.left = `${pos.left}px`;
  panel.style.top = `${pos.top}px`;
  panel.style.right = "auto";
})();

let aiPlanPanelDrag: { startX: number; startY: number; startLeft: number; startTop: number } | null = null;
document.querySelector<HTMLDivElement>("#ai-plan-panel")!.addEventListener("mousedown", (e) => {
  if (!(e.target as HTMLElement).closest(".ai-plan-head")) return; // тащим только за шапку — не за список шагов/кнопку
  const panel = document.querySelector<HTMLDivElement>("#ai-plan-panel")!;
  const rect = panel.getBoundingClientRect();
  aiPlanPanelDrag = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!aiPlanPanelDrag) return;
  const panel = document.querySelector<HTMLDivElement>("#ai-plan-panel");
  if (!panel) return;
  const left = Math.max(0, Math.min(aiPlanPanelDrag.startLeft + (e.clientX - aiPlanPanelDrag.startX), window.innerWidth - panel.offsetWidth));
  const top = Math.max(0, Math.min(aiPlanPanelDrag.startTop + (e.clientY - aiPlanPanelDrag.startY), window.innerHeight - panel.offsetHeight));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = "auto";
});
window.addEventListener("mouseup", () => {
  if (!aiPlanPanelDrag) return;
  aiPlanPanelDrag = null;
  const panel = document.querySelector<HTMLDivElement>("#ai-plan-panel");
  if (panel) saveAiPlanPanelPos(parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0);
});

// --- Окно оповещения о глобальном катаклизме — тот же перетаскиваемый паттерн, что #ai-plan-panel
// выше (см. комментарий там), своя позиция в localStorage под отдельным ключом ----------------
const GLOBAL_EVENT_PANEL_POS_KEY = "civa-global-event-panel-pos";
function loadGlobalEventPanelPos(): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(GLOBAL_EVENT_PANEL_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.left === "number" && typeof parsed.top === "number") return parsed;
  } catch {
    // приватный режим/запрет хранения — просто остаёмся на позиции по умолчанию из CSS
  }
  return null;
}
function saveGlobalEventPanelPos(left: number, top: number) {
  try {
    localStorage.setItem(GLOBAL_EVENT_PANEL_POS_KEY, JSON.stringify({ left, top }));
  } catch {
    // тихо игнорируем — это только UI-удобство, не игровое состояние
  }
}
(function applySavedGlobalEventPanelPos() {
  const pos = loadGlobalEventPanelPos();
  if (!pos) return;
  const panel = document.querySelector<HTMLDivElement>("#global-event-panel");
  if (!panel) return;
  panel.style.left = `${pos.left}px`;
  panel.style.top = `${pos.top}px`;
  panel.style.right = "auto";
})();
let globalEventPanelDrag: { startX: number; startY: number; startLeft: number; startTop: number } | null = null;
document.querySelector<HTMLDivElement>("#global-event-panel")!.addEventListener("mousedown", (e) => {
  if (!(e.target as HTMLElement).closest(".ai-plan-head")) return; // тащим только за шапку
  const panel = document.querySelector<HTMLDivElement>("#global-event-panel")!;
  const rect = panel.getBoundingClientRect();
  globalEventPanelDrag = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!globalEventPanelDrag) return;
  const panel = document.querySelector<HTMLDivElement>("#global-event-panel");
  if (!panel) return;
  const left = Math.max(0, Math.min(globalEventPanelDrag.startLeft + (e.clientX - globalEventPanelDrag.startX), window.innerWidth - panel.offsetWidth));
  const top = Math.max(0, Math.min(globalEventPanelDrag.startTop + (e.clientY - globalEventPanelDrag.startY), window.innerHeight - panel.offsetHeight));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = "auto";
});
window.addEventListener("mouseup", () => {
  if (!globalEventPanelDrag) return;
  globalEventPanelDrag = null;
  const panel = document.querySelector<HTMLDivElement>("#global-event-panel");
  if (panel) saveGlobalEventPanelPos(parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0);
});

// Bottom bar (and its content) must be laid out *before* we measure how much room the map
// actually has — fitting against the map-area's size while the bottom bar was still empty
// left the canvas oversized once real content pushed the available height back down.
// One delegated listener on the grid — chips are re-rendered on every claim, so per-chip handlers
// would have to be re-bound each time.
document.querySelector<HTMLDivElement>("#buildings-bar")!.addEventListener("click", (e) => {
  const useBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-bld-use]");
  if (useBtn) {
    if (useBtn.disabled) return;
    const key = useBtn.dataset.bldUse!;
    const extra = BUILDING_USE_EXTRA_ACTIONS[key];
    if (extra) extra();
    else applyBuildingEffect(key);
    return;
  }
  const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-bld]");
  if (chip) onBuildingClick(chip.dataset.bld!);
});

// Каждый ресурс склада несёт свою кнопку 💲 — всегда кликабельна, ведёт сразу к выбору цены. Кроме
// Драгоценных металлов (по прямому запросу) — те не выставляются на биржу вовсе, кнопка сразу
// обменивает 1 единицу на деньги (cashInPreciousMetals, без выбора цены — она фиксирована эпохой).
document.querySelector<HTMLDivElement>("#warehouse-panel")!.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".res-sell-btn");
  if (!btn) return;
  const resource = btn.dataset.resource as ResourceId;
  if (resource === "preciousMetals") {
    const result = await sendAction("cashInPreciousMetals", { qty: 1 });
    if (!result.ok) setHint(result.hint ?? "Не удалось обменять Драгоценные металлы.");
    else if (result.hint) setHint(result.hint);
  } else {
    startSellResource(resource);
  }
});

// Growing a city, or picking one to build a unit in, can both be done from the list — not only by
// clicking the city's marker on the map.
document.querySelector<HTMLDivElement>("#city-list")!.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-city-id]");
  if (!el) return;
  const city = cities.find((c) => c.id === +el.dataset.cityId!);
  if (!city) return;
  // Без ожидающего действия карты клик по своему городу открывает модалку гарнизона (ТЗ §14 п.1),
  // а не выбирает цель для карты.
  if (!pendingCardAction && !pendingRouteIsMine() && !pendingRouteRedirect && !pendingTradeRouteNew && !pendingTradeRouteDelete && !pendingCommunismCityPick) {
    cityDetailId = city.id;
    activeModal = "city-detail";
    renderModal();
    return;
  }
  if (pendingCommunismCityPick) {
    pickCommunismCity(city);
    return;
  }
  if (pendingRouteIsMine()) {
    pickRouteCity(city);
    return;
  }
  if (pendingRouteRedirect) {
    pickRedirectCity(city);
    return;
  }
  if (pendingTradeRouteNew) {
    pickTradeRouteNewCity(city);
    return;
  }
  if (pendingTradeRouteDelete) {
    pickTradeRouteDeleteCity(city);
    return;
  }
  if (pendingCardAction!.kind === "routeRight-city") {
    pickRouteRightCity(city);
    return;
  }
  if (pendingCardAction!.kind === "settler-grow") tryGrowCity(city);
  else if (pendingCardAction!.kind === "warrior-city" || pendingCardAction!.kind === "warrior-money-city") pickWarriorCity(city);
  else if (pendingCardAction!.kind === "kazarma-city") pickKazarmaCity(city);
  else if (pendingCardAction!.kind === "worker-city") tryWorkerCollect(city);
  else if (pendingCardAction!.kind === "sklad-collect") trySkladCollect(city);
  else if (pendingCardAction!.kind === "trader-city") tryTraderTrade(city);
  else if (pendingCardAction!.kind === "builder-mine") tryBuilderMine(city);
});

// --- ESC-меню паузы: продолжить / сохранить / выйти в главное меню -------------------------
// Обычная («тихая») персистенция — сервер и так сохраняет партию на диск после КАЖДОГО действия
// (см. web/server/src/rooms.ts), обновление страницы просто переподключается к той же комнате
// (см. bootstrap ниже) и получает актуальное состояние — это НЕ то, что делает кнопка «Сохранить»
// ниже. По прямому запросу — «кнопка сохранить партию, чтоб файлом можно было сохранить, без выбора
// папки, а системно заданная внутри проекта, а кнопка загрузить могла выбрать сохранение»: кнопка
// делает отдельный, независимый СНИМОК текущего состояния под новым id (см. net.saveSnapshot/
// GameSession.saveSnapshot) — партия в этой вкладке продолжается как обычно, снимок просто
// появляется в списке на start.html «Загрузить игру» (теперь это выбор из ВСЕХ сохранений, не
// только самого недавнего).
let pauseMenuOpen = false;
let pauseMenuSaveStatus: string | null = null;
function renderPauseMenu() {
  const el = document.querySelector<HTMLDivElement>("#pause-menu-backdrop")!;
  if (!pauseMenuOpen) {
    el.classList.remove("open");
    el.innerHTML = "";
    return;
  }
  el.classList.add("open");
  el.innerHTML = `
    <div class="side-modal pause-menu">
      <div class="side-modal-head">Пауза</div>
      <button class="side-modal-action pause-btn" id="pm-resume">▶ Продолжить</button>
      <button class="side-modal-action pause-btn" id="pm-save">💾 Сохранить партию</button>
      ${pauseMenuSaveStatus ? `<div class="side-modal-note">${pauseMenuSaveStatus}</div>` : ""}
      <button class="side-modal-action pause-btn pause-btn-danger" id="pm-exit">🏠 Выйти в главное меню</button>
    </div>`;
  el.querySelector("#pm-resume")!.addEventListener("click", () => togglePauseMenu(false));
  el.querySelector("#pm-save")!.addEventListener("click", async () => {
    pauseMenuSaveStatus = "Сохраняю…";
    renderPauseMenu();
    const result = await net.saveSnapshot();
    pauseMenuSaveStatus = "error" in result ? `Не удалось сохранить: ${result.error}` : "Сохранено ✅ — доступно в «Загрузить игру» на стартовом экране.";
    renderPauseMenu();
  });
  el.querySelector("#pm-exit")!.addEventListener("click", () => {
    window.location.href = "/start.html";
  });
}
function togglePauseMenu(force?: boolean) {
  pauseMenuOpen = force ?? !pauseMenuOpen;
  if (pauseMenuOpen) pauseMenuSaveStatus = null; // свежее открытие меню — без старого статуса сохранения
  renderPauseMenu();
}
document.querySelector<HTMLDivElement>("#pause-menu-backdrop")!.addEventListener("click", (e) => {
  if (e.currentTarget === e.target) togglePauseMenu(false);
});

// =============================================================================================
// --- Сеть: подключение к комнате на сервере (см. план: C:\Users\user\.claude\plans\mighty-snuggling-squid.md)
// =============================================================================================
// Сырой последний снимок сервера — рядом с "распакованными" mirror-переменными выше, пригождается
// для window.__debug и вообще как единственный источник правды на любой момент.
let serverState: net.ServerState | null = null;
/** Для триггера checkPendingProposalsForCurrentPlayer только на смену хода / пока открыта модалка
 * предложения (не на каждый снимок — иначе закрытое предложение тут же переоткрывалось бы). */
let lastMirroredPlayerIndex = -1;

function replaceRecord<T>(target: Record<string, T>, source: Record<string, T>) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}
function replaceSet<T>(target: Set<T>, values: T[]) {
  target.clear();
  for (const v of values) target.add(v);
}

/** Единственное место, где module-level переменные состояния переприсваиваются — раньше
 * (в старом клиенте до этой миграции) их напрямую мутировали ~45 функций-обработчиков, теперь их
 * меняет только это. Имена и типы 1-в-1 повторяют SaveGameV1 на сервере (GameSession.ts). */
function updateMirrorFrom(state: net.ServerState) {
  serverState = state;

  PLAYERS = state.players.map((p: { name: string; color: number; isAI?: boolean }, i: number) => ({ id: i, name: p.name, color: p.color, isAI: p.isAI }));
  phase = state.phase;
  const turnChanged = state.currentPlayerIndex !== lastMirroredPlayerIndex;
  currentPlayerIndex = state.currentPlayerIndex;
  lastMirroredPlayerIndex = currentPlayerIndex;
  // WeGo, игровая фаза: каждая вкладка видит СВОЙ приватный клон раунда — рука/деньги/счётчик
  // действий/кнопка «Завершить ход» должны относиться К НЕЙ, а не к тому, что стоит в
  // currentPlayerIndex ОБЩЕЙ сессии (между раундами он может указывать на любого игрока, см.
  // weGoRuntime.ts). Расстановка (`renderBottomBar`, phase==="placement") в WeGo остаётся общей и
  // последовательной, как в хотсите — там нужен НАСТОЯЩИЙ currentPlayerIndex, override не трогает
  // его (условие ниже — только "playing").
  if (phase === "playing" && net.myWeGoPlayer() !== null) currentPlayerIndex = net.myWeGoPlayer()!;
  winner = state.winner;
  winnerType = state.winnerType ?? null;
  winners = state.winners ?? (state.winner !== null ? [state.winner] : []);
  turnsRemaining = state.turnsRemaining;
  maxTurns = state.maxTurns ?? 60;
  cyclesElapsed = state.cyclesElapsed ?? 0;

  doc.tiles = state.mapTiles;
  placedTokens.length = 0;
  placedTokens.push(...state.placedTokens);
  cities = state.cities;
  ruins = state.ruins ?? [];
  eliminatedPlayers = state.eliminatedPlayers ?? [];
  for (const id of eliminatedPlayers) {
    if (!lastSeenEliminated.has(id)) {
      lastSeenEliminated.add(id);
      eliminationNoticeQueue.push(id);
    }
  }

  units = state.units;
  replaceSet(landedThisCycle, state.landedThisCycle);
  replaceSet(outOfMoveThisCycle, state.outOfMoveThisCycle);
  replaceSet(unitActedThisCycle, state.unitActedThisCycle ?? []);
  moveBudgetUsedThisCycle.clear();
  for (const [k, v] of (state.moveBudgetUsedThisCycle ?? []) as [number, number][]) moveBudgetUsedThisCycle.set(k, v);
  hexDefense.clear();
  for (const [k, v] of state.hexDefense as [string, number][]) hexDefense.set(k, v);
  unitDefendBuffer.clear();
  for (const [k, v] of (state.unitDefendBuffer ?? []) as [number, number][]) unitDefendBuffer.set(k, v);

  market.length = 0;
  market.push(...state.market);
  tradeRoutes = state.tradeRoutes;

  replaceRecord(buildingOwners, state.buildingOwners);
  deck = state.deck ?? []; // WeGo: содержимое колоды не приходит вовсе (см. deckCount ниже)
  deckCount = state.deckCount ?? deck.length;
  replaceRecord(hands, state.hands);
  replaceRecord(actionsLeft, state.actionsLeft);
  replaceRecord(actionsTotal, state.actionsTotal ?? state.actionsLeft);
  replaceRecord(money, state.money);
  replaceRecord(warehouse, state.warehouse);
  replaceRecord(communismBonusHeld, state.communismBonusHeld ?? {});
  replaceRecord(communismExtraCityId, state.communismExtraCityId ?? {});
  replaceRecord(buildingResources, state.buildingResources);

  for (const k of Object.keys(researchedTechs)) delete researchedTechs[+k];
  for (const [id, arr] of Object.entries(state.researchedTechs as Record<string, string[]>)) researchedTechs[+id] = new Set(arr);
  replaceRecord(playerParadigm, state.playerParadigm);
  replaceRecord(playerReligion, state.playerReligion);
  for (const k of Object.keys(religionFounder)) delete (religionFounder as Record<string, number>)[k];
  Object.assign(religionFounder, state.religionFounder);
  for (const k of Object.keys(techDiscoverer)) delete techDiscoverer[k];
  Object.assign(techDiscoverer, state.techDiscoverer ?? {});
  replaceSet(upravlenieUsedThisTurn, state.upravlenieUsedThisTurn ?? []);
  replaceSet(mustHandoff, state.mustHandoff ?? []);
  lastHandoffCycle = state.lastHandoffCycle ?? {};
  if (!mustHandoff.has(currentPlayerIndex)) handoffSlotIndex = null; // выполнено/сменился игрок — закрываем оверлей
  replaceRecord(spaceComponents, state.spaceComponents);
  replaceRecord(nuclearWeapons, state.nuclearWeapons ?? {});

  for (const k of Object.keys(relations)) delete relations[k];
  for (const [k, r] of Object.entries(state.relations as Record<string, { war: boolean; agreements: Agreement[]; truceUntilCycle?: number }>)) {
    relations[k] = { war: r.war, agreements: new Set(r.agreements), truceUntilCycle: r.truceUntilCycle };
  }
  replaceRecord(relationScores, (state.relationScores as Record<string, number>) ?? {});
  pendingProposals.length = 0;
  pendingProposals.push(...state.pendingProposals);
  pendingGlobalEvents.length = 0;
  pendingGlobalEvents.push(...(state.pendingGlobalEvents ?? []));

  replaceSet(skippedTurn, state.skippedTurn);
  pendingSkipTurn = state.pendingSkipTurn ?? null;
  pendingSkipTurnReason = state.pendingSkipTurnReason ?? null;
  replaceSet(accessUsed, state.accessUsed);
  replaceSet(productionUsedThisCycle, state.productionUsedThisCycle);

  pendingRoute = state.pendingRoute ?? null;
  // Маршрут завершён/недоступен, ИЛИ принадлежит другому игроку (см. pendingRouteIsMine) — сбрасываем
  // локальный первый клик; иначе он пережил бы смену текущего игрока и путался бы с чужим pendingRoute.
  if (!pendingRouteIsMine()) pendingRouteFromCityId = null;
  pendingTaxShortfall = state.pendingTaxShortfall ?? null;
  pendingCatastrophe = state.pendingCatastrophe ?? null;
  pendingAiPlan = state.pendingAiPlan ?? null;
  autoPlayAI = state.autoPlayAI ?? false;
  oonCandidate1Id = state.oonCandidate1Id ?? null;
  oonCandidate2Id = state.oonCandidate2Id ?? null;
  oonEffectiveCandidate2Id = state.oonEffectiveCandidate2Id ?? null;
  oonSecretaryGeneralId = state.oonSecretaryGeneralId ?? null;
  pendingOonSecretaryElection = state.pendingOonSecretaryElection ?? null;
  pendingOonResolution = state.pendingOonResolution ?? null;
  oonOpenTradeActive = state.oonOpenTradeActive ?? false;
  oonNuclearBanActive = state.oonNuclearBanActive ?? false;
  oonNeutralWatersActive = state.oonNeutralWatersActive ?? false;
  oonSanctionedPlayerId = state.oonSanctionedPlayerId ?? null;
  oonGreenAgendaActive = state.oonGreenAgendaActive ?? false;
  oonPriceRegulation = state.oonPriceRegulation ?? null;
  oonArmsLimit = state.oonArmsLimit ?? null;
  if (!pendingOonResolution && activeModal === "oon-vote") activeModal = null; // резолюция разрешилась, пока модалка была открыта
  if (!pendingOonSecretaryElection && activeModal === "oon-secretary-vote") activeModal = null; // выборы разрешились, пока модалка была открыта

  // Катастрофа/недоимка — серверное pending-состояние, ждущее выбора игрока (оплатить/принять,
  // списать юнит/здание); без этого модалка никогда не открывалась бы сама, и разыгранная карта
  // просто зависала бы без последствий (карта уже ушла из руки на сервере, а выбор нечем сделать).
  if (pendingCatastrophe && activeModal === null) activeModal = "catastrophe-choice";
  if (pendingTaxShortfall && activeModal === null) activeModal = "tax-shortfall";
  // Симметричное автозакрытие — как у oon-vote выше: выбор уже обработан сервером (pending обнулился),
  // а окно без этого осталось бы висеть открытым, и игрок не понимал бы, что эффект применился.
  if (!pendingCatastrophe && activeModal === "catastrophe-choice") activeModal = null;
  if (!pendingTaxShortfall && activeModal === "tax-shortfall") activeModal = null;

  // Пропуск хода (11.6) — по прямому запросу игрок «получает» пропущенный ход и сам жмёт
  // «Пропустить», а не тихо перепрыгивается сервером; открываем/закрываем окно тем же паттерном,
  // что катастрофа/недоимка выше. pendingSkipTurn (не skippedTurn!) — см. его комментарий: только
  // ОН однозначно означает «текущий ход именно заморожен», а не «флаг просто где-то стоит».
  if (pendingSkipTurn !== null && activeModal === null) activeModal = "skip-turn";
  if (pendingSkipTurn === null && activeModal === "skip-turn") activeModal = null;

  // Территориальная победа теперь выставляется сервером (foundCity, ТЗ 9) — открываем модалку сами,
  // как только видим winner !== null (раньше это делала declareTerritorialVictory синхронно).
  if (state.winner !== null && activeModal !== "victory") activeModal = "victory";

  // Уведомление о выбывании — «поверх карты», всем игрокам (по прямому уточнению) — открываем, как
  // только очередь непуста и сейчас ничего важнее не показано; следующее в очереди открывается сразу
  // после закрытия текущего (см. closeModal).
  if (eliminationNoticeQueue.length && activeModal === null) activeModal = "elimination";

  // Предложения дипломатии показываются в начале хода получателя, либо пока модалка уже открыта
  // (чтобы после решения одного показать следующее в очереди тому же игроку) — не на каждый снимок,
  // иначе закрытая пользователем модалка тут же переоткрывалась бы после любого чужого действия.
  if (turnChanged || activeModal === "proposal-review") checkPendingProposalsForCurrentPlayer();
  if (turnChanged || activeModal === "oon-vote") checkPendingOonVoteForCurrentPlayer();
  if (turnChanged || activeModal === "oon-secretary-vote") checkPendingOonSecretaryVoteForCurrentPlayer();

  // [ИСПРАВЛЕНО] По прямому запросу — «постоянно в начале хода открыто гос. управление, должно
  // открываться автоматом лишь раз, когда технология впервые открыта, последующие ходы окно по
  // умолчанию ресурсы»: rightPanelView — общая переменная на весь клиент, не за-игрока, и раньше
  // ничего не возвращало её назад в "resources" после легитимного одноразового автопереключения
  // ниже — вкладка так и оставалась на «Гос. управление» на все последующие ходы (в т.ч. чужие),
  // выглядя как «открывается каждый раз». Каждый новый ход — сброс к дефолту, newlyAvailable-проверка
  // ниже сама переключит обратно на «government», если ИМЕННО в этом ходу появился новый пункт.
  if (turnChanged) rightPanelView = "resources";

  // По прямому запросу — впервые доступную парадигму/религию у ТЕКУЩЕГО игрока показываем сразу, а
  // не молча ждём, пока он сам зайдёт в «Гос. управление» (только пока играется фаза playing —
  // phase присвоен чуть выше в этой же функции).
  if (phase === "playing") {
    let newlyAvailable = false;
    for (const p of PARADIGMS) {
      const key = `${currentPlayerIndex}:${p}`;
      if (canAdoptParadigm(currentPlayerIndex, p) && !paradigmPrompted.has(key)) {
        paradigmPrompted.add(key);
        newlyAvailable = true;
      }
    }
    // Религия доступна с самого начала партии, независимо от парадигмы/технологий (см. adoptReligion)
    // — подсказка показывается один раз каждому игроку на первом же ходу, не ждёт «разблокировки».
    if (!religionPrompted.has(currentPlayerIndex)) {
      religionPrompted.add(currentPlayerIndex);
      newlyAvailable = true;
    }
    if (newlyAvailable) {
      savePromptedToStorage();
      if (rightPanelView !== "government") {
        rightPanelView = "government";
        setHint("Доступен новый выбор в «Гос. управление» — парадигма или религия (правая панель).");
      }
    }
  }
}

/** Единая точка перерисовки всего экрана — вызывается после каждого снимка с сервера (initial join
 * И каждый onState). Индивидуальные обёртки действий (tryFoundCity и т.п.) сами НЕ рендерят —
 * рендер целиком отсюда, см. план. */
let wegoReportDismissTimer: ReturnType<typeof setTimeout> | null = null;

/** Персональный отчёт по только что резолвленному WeGo-раунду (по прямому запросу — «показывай
 * итог раунда как AI-план, только за себя») — короткая ненавязчивая панель, не блокирует игру (в
 * отличие от #ai-plan-panel, тут нечего подтверждать — раунд уже применён). Список шагов СВОЕГО
 * плана с ok/hint (`ok:false` — конфликт с чужим действием того же раунда, порядок реплея решил не
 * в мою пользу, см. weGoRound.ts) — та же идея, что и ai-plan-step-row, переиспользуем те же классы,
 * чтобы не тащить отдельный CSS-блок под одноразовую панель. Автоматически прячется через 8с или по
 * клику на "×" — руки/действия следующего раунда её не трогают (renderEverything с ней не
 * взаимодействует вовсе, см. вызов в net.onState). */
/** Оповещение о глобальном катаклизме (см. PendingGlobalEvent) — перетаскиваемое окно, отдельное от
 * activeModal-системы (как #ai-plan-panel/#wego-report-panel — не блокирует остальную игру), висит у
 * КАЖДОГО живого игрока-человека независимо, пока он сам не нажмёт «Понятно». Вызывается из
 * renderEverything на каждый снимок состояния (не привязана к конкретным точкам смены хода/модалки —
 * иначе легко забыть вызвать её в одной из точек и оповещение бы «терялось»). */
function renderGlobalEventsPanel() {
  const panel = document.querySelector<HTMLDivElement>("#global-event-panel");
  if (!panel) return;
  const mine = PLAYERS[currentPlayerIndex]?.isAI ? [] : pendingGlobalEvents.filter((e) => !e.dismissedBy.includes(currentPlayerIndex));
  if (!mine.length) {
    panel.classList.remove("open");
    panel.innerHTML = "";
    renderGlobalEventHexHighlight([]);
    return;
  }
  panel.classList.add("open");
  panel.innerHTML = `
    <div class="ai-plan-head"><span>🌍 Глобальное событие</span></div>
    ${mine.map((e) => `<div class="ai-plan-step-row"><span>${e.description}</span></div>`).join("")}
    <button class="global-event-dismiss-btn" id="global-event-dismiss-btn">Понятно</button>
  `;
  renderGlobalEventHexHighlight(mine.flatMap((e) => e.hexes));
  const ids = mine.map((e) => e.id);
  panel.querySelector("#global-event-dismiss-btn")!.addEventListener("click", () => dismissGlobalEvents(ids));
}

/** Оптимистично помечает события закрытыми для ТЕКУЩЕГО игрока сразу (не дожидаясь ответа сервера —
 * тот же паттерн, что и у остальных однозначных по исходу действий) и шлёт dismissGlobalEvent на
 * каждое; следующий снимок состояния всё равно перезапишет pendingGlobalEvents целиком. */
function dismissGlobalEvents(ids: number[]) {
  for (const e of pendingGlobalEvents) {
    if (ids.includes(e.id) && !e.dismissedBy.includes(currentPlayerIndex)) e.dismissedBy.push(currentPlayerIndex);
  }
  renderGlobalEventsPanel();
  for (const id of ids) sendAction("dismissGlobalEvent", { id });
}

function showWegoRoundReport() {
  const report = wegoRoundReport;
  const panel = document.querySelector<HTMLDivElement>("#wego-report-panel");
  if (!panel || !report) return;
  if (wegoReportDismissTimer) clearTimeout(wegoReportDismissTimer);
  const dismiss = () => {
    panel.classList.remove("open");
    panel.innerHTML = "";
  };
  panel.classList.add("open");
  panel.innerHTML = `
    <div class="ai-plan-head"><span>📋 Итоги раунда</span><button class="modal-close" id="wego-report-close">×</button></div>
    ${report.steps
      .map(
        (s, i) =>
          `<div class="ai-plan-step-row"><span class="n">${i + 1}</span><span>${s.ok ? "✅" : "❌"} ${WEGO_ACTION_LABEL[s.action] ?? s.action}${!s.ok && s.hint ? ` — <i>${s.hint}</i>` : ""}</span></div>`
      )
      .join("")}
    ${report.steps.length === 0 ? `<div class="ai-plan-step-row"><span>В этом раунде вы ничего не сделали.</span></div>` : ""}
  `;
  panel.querySelector("#wego-report-close")!.addEventListener("click", dismiss);
  wegoReportDismissTimer = setTimeout(dismiss, 8000);
}

/** Человекочитаемые подписи для отчёта о раунде — те же action-имена, что идут в dispatch(), но без
 * технических деталей payload (в отличие от AI-плана, здесь не нужна точная цель — просто "что за
 * тип действия"). Незнакомое имя — просто выводится как есть (запасной путь). */
const WEGO_ACTION_LABEL: Record<string, string> = {
  endTurn: "Завершение раунда",
  closeRound: "Завершение раунда",
  handoffCard: "Передача карты",
  playCard: "Розыгрыш карты",
  commandUnit: "Приказ юниту",
  foundCity: "Основание города",
  growCity: "Рост города",
  buildUnitCard: "Постройка юнита",
  buyUnitWithMoney: "Покупка юнита за деньги",
  buildBuilding: "Постройка здания",
  buyListing: "Покупка на бирже",
  sellCard: "Выставление карты на биржу",
  sellResource: "Продажа ресурса",
  declareWar: "Объявление войны",
  sendProposal: "Дипломатическое предложение",
  resolveProposal: "Ответ на предложение",
  confirmResearch: "Исследование технологии",
  adoptParadigm: "Смена парадигмы",
  adoptReligion: "Принятие религии",
};

function renderEverything() {
  renderer.drawAll(doc);
  // Оба рисуют В ОДИН И ТОТ ЖЕ markerOverlay и оба начинают с полной его очистки (removeChildren) —
  // вызванные подряд, второй стирал бы то, что нарисовал первый (жетоны расстановки были на «нижнем
  // слое» не из-за z-order, а буквально стирались следующим же вызовом). Фазы взаимоисключающие —
  // жетоны есть только в placement, города/юниты только в playing — поэтому просто не вызываем оба.
  if (phase === "placement") drawPlacementMarkers();
  else drawCityMarkers();
  drawFogAndRegionBorders(); // после маркеров — туман лежит поверх них (см. fogLayer)
  renderMapFilters();
  renderTechTree();
  renderBuildings();
  renderCityList();
  renderWarehouse();
  renderActionButtons(); // тянет за собой renderRightPanelExtra()
  renderBottomBar(); // тянет за собой renderHand/renderActionPips/renderMoneyCard/updateDeckCount
  renderModal();
  renderUnitCommandBar();
  renderHexInfoPanel();
  updateHint();
  fitMapToArea();
  renderAiPlanOverlay();
  renderGlobalEventsPanel();
}

// --- Bootstrap: game.html всегда открывается с ?room=<id> (см. start/main.ts) ----------------
const roomIdParam = new URLSearchParams(location.search).get("room");
if (!roomIdParam) {
  // Нет валидного способа запустить клиент без комнаты — состояние партии больше нигде не живёт.
  document.body.textContent = "Комната не указана — возвращаемся в меню…";
  window.location.href = "/start.html";
} else {
  // WeGo: если для ЭТОЙ комнаты в localStorage есть свой reconnectToken (см. net.ts
  // reconnectWeGoSlot/sendAndBindSlot) — F5, разрыв связи, или просто открыли ту же ссылку заново
  // на том же устройстве — восстанавливаем привязку к СВОЕМУ игроку. null — токена для этой
  // комнаты вообще нет (хотсит-комната, или WeGo-комната, куда эта вкладка ни разу не заходила
  // как участник) — тогда обычный net.joinRoom (зритель без своего игрока в WeGo, полноправный
  // единственный "игрок за всех" в хотсите — см. заголовок net.ts).
  // net.joinRoom/reconnectWeGoSlot сами ретраят коннект несколько раз (сервер иногда недоступен
  // секунду-другую при перезапуске в процессе разработки) — try/catch здесь просто на случай
  // непредвиденного throw, чтобы страница не осталась молча пустой, а внятно объяснила и вернула
  // в меню, как и { error }.
  let joined: { roomId: string; state: net.ServerState; deadlineAt?: number | null } | { error: string };
  try {
    const wego = await net.reconnectWeGoSlot(roomIdParam);
    joined = wego ?? (await net.joinRoom(roomIdParam));
  } catch (err) {
    joined = { error: err instanceof Error ? err.message : String(err) };
  }
  if ("error" in joined) {
    document.body.textContent = `Не удалось подключиться: ${joined.error} — возвращаемся в меню…`;
    window.location.href = "/start.html";
  } else {
    updateMirrorFrom(joined.state);
    wegoRoundDeadline = joined.deadlineAt ?? null;
    renderEverything();
    net.onState((state, deadlineAt, report) => {
      updateMirrorFrom(state);
      // Новый дедлайн (не совпадает с уже известным) — открылся следующий раунд, план для него ещё
      // не сдан. Report приходит ОТДЕЛЬНЫМ, более ранним сообщением (см. wsServer.ts
      // broadcastWeGoState) — здесь просто запоминаем и показываем, ничего не сбрасывает.
      if (deadlineAt !== undefined && deadlineAt !== wegoRoundDeadline) wegoPlanSubmitted = false;
      if (deadlineAt !== undefined) wegoRoundDeadline = deadlineAt;
      if (report) {
        wegoRoundReport = report;
        showWegoRoundReport();
      }
      renderEverything();
    });
    net.onError((message) => setHint(`Ошибка сервера: ${message}`));
    net.onPreviewPath((requestId, result) => {
      if (requestId !== latestPreviewRequestId || !hoveredHex) return; // устаревший ответ — наведение уже ушло дальше
      movePreview = result ? { col: hoveredHex.col, row: hoveredHex.row, result } : null;
      drawMovePreview();
      renderHexInfoPanel();
    });
    net.onPreviewAttack((requestId, result) => {
      if (requestId !== latestAttackPreviewRequestId || !hoveredHex) return; // устаревший ответ — наведение уже ушло дальше
      attackPreview = result ? { col: hoveredHex.col, row: hoveredHex.row, result } : null;
      renderHexInfoPanel();
    });
    net.onPreviewProposalValue((requestId, result) => {
      // Устаревший ответ (список условий уже снова изменился, либо окно закрыто) — отбрасываем, тем
      // же паттерном, что movePreview/attackPreview выше.
      if (requestId !== composeValueRequestId || activeModal !== "proposal-compose") return;
      composeValuePreview = result;
      renderModal();
    });
    net.onPreviewTraderTrade((requestId, result) => {
      if (requestId !== traderComposeRequestId || activeModal !== "trader-compose" || !traderComposeState) return;
      traderComposePreview = result;
      // Первый ответ (ещё не было явного выбора игрока) — по умолчанию отмечаем ВСЕ доступные,
      // тем же поведением, что раньше было единственным (автоматически все доступные виды сразу).
      if (traderComposeState.selected === null && result) traderComposeState.selected = new Set(result.selected as ResourceId[]);
      renderModal();
    });
    // Сервер иногда перезапускают в процессе разработки — раньше это молча обрывало сокет без
    // возврата (нужен был ручной F5); теперь net.ts сам переподключается к той же комнате.
    net.onConnectionChange((connected) => {
      setHint(connected ? "Соединение восстановлено." : "Связь с сервером потеряна — переподключаюсь…");
    });
  }
}

// Раньше здесь были десятки прямых мутаторов состояния (d.units = [...], d.resolveCombat(...) и
// т.п.); клиент больше не исполняет игровую логику сам, так что от них никакого толку —
// минимальный хук вместо этого просто даёт заглянуть в последний снимок сервера и отправить
// произвольное действие напрямую, тем же путём, что и обычные клики по UI.
// @ts-ignore debug hook
window.__debug = {
  state: () => serverState,
  PLAYERS: () => PLAYERS,
  roomId: () => net.roomId(),
  sendAction: (action: string, payload?: Record<string, unknown>) => sendAction(action, payload),
};
