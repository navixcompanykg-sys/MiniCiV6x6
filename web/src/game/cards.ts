export type CardKind = "action" | "event";

export interface CardDef {
  id: string;
  label: string;
  kind: CardKind;
  effect: string;
  price?: string;
  /** Event cards can never be discarded — their effect resolves automatically instead (ТЗ 2.3). */
  discardable: boolean;
}

// ТЗ 3.1 — 6 action card types, 4 copies each = 24 cards.
export const ACTION_CARDS: CardDef[] = [
  {
    id: "settler",
    label: "Поселенец",
    kind: "action",
    effect: "Увеличить население в выбранном поселении ИЛИ создать колониста (заплатив питание). Если нечем кормить — потерять 1 население.",
    price: "Еда (зависит от уровня города)",
    discardable: true,
  },
  {
    id: "warrior",
    label: "Воин",
    kind: "action",
    effect: "Создать военный юнит в выбранном поселении. Снижает население города на 1.",
    price: "Ресурсы согласно эпохе",
    discardable: true,
  },
  {
    id: "builder",
    label: "Строитель",
    kind: "action",
    effect: "Построить здание в столице (открывается окно строительства).",
    price: "Цена здания",
    discardable: true,
  },
  {
    id: "worker",
    label: "Рабочий",
    kind: "action",
    effect: "Собрать ресурсы с выбранного города в его регионе ИЛИ улучшить добычу 1 ресурса на карте (не больше населения города).",
    price: "1 деньга за каждый добытый ресурс",
    discardable: true,
  },
  {
    id: "scientist",
    label: "Учёный",
    kind: "action",
    effect: "Открыть технологию (открывается окно технологий). Цена и условия — в дереве технологий.",
    price: "Цена технологического открытия",
    discardable: true,
  },
  {
    id: "trader",
    label: "Торговец",
    kind: "action",
    effect: "Собрать деньги с торгового маршрута или с выбранного города (по числу населения).",
    price: "Торговые ресурсы (по числу городов на маршруте)",
    discardable: true,
  },
];

// ТЗ 3.2 — 6 event card types, 2 copies each = 12 cards. Never discardable.
export const EVENT_CARDS: CardDef[] = [
  {
    id: "population",
    label: "Население",
    kind: "event",
    effect: "Уплатить прирост населения. Иначе — потерять 1 населения в каждом городе.",
    discardable: false,
  },
  {
    id: "taxes",
    label: "Соберите налоги",
    kind: "event",
    effect: "Собрать по 1 единице со всего населения страны, затем уплатить содержание войск и зданий (по 1 за каждое).",
    discardable: false,
  },
  { id: "catastrophe", label: "Катастрофа", kind: "event", effect: "Потерять случайное здание.", discardable: false },
  {
    id: "forestGrowth",
    label: "Рост леса",
    kind: "event",
    effect: "Бросить два кубика (сумма от 2 до 12). Лес появляется в случайной области, соответствующей выпавшему числу.",
    discardable: false,
  },
  { id: "tradeRoute", label: "Торговый путь", kind: "event", effect: "Сдвинуть линию торгового пути на 1 гекс.", discardable: false },
  {
    id: "mobilization",
    label: "Мобилизация",
    kind: "event",
    effect: "В этом ходу можно сыграть любое число карт действий, равное числу карт действий в руке.",
    discardable: false,
  },
];

/** Full 36-card deck (ТЗ 3): 24 action cards (4x6) + 12 event cards (2x6). */
export function freshDeck(): CardDef[] {
  const deck: CardDef[] = [];
  for (const card of ACTION_CARDS) for (let i = 0; i < 4; i++) deck.push(card);
  for (const card of EVENT_CARDS) for (let i = 0; i < 2; i++) deck.push(card);
  return deck;
}

export function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
