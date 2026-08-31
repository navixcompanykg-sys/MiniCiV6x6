// Городская застройка — 16 зданий, 4 группы × 4 (см. "Городская застройка" в Технологии.md).
// Все 16 открываются технологией — ни одно не доступно с начала игры без исследований (ТЗ 4.4).
//
// Ключевое правило: здание может принадлежать одновременно ДО 2 игрокам (см. MAX_BUILDING_OWNERS
// ниже) — не одному на всю партию. Поэтому владение хранится глобально (id здания → список id
// игроков), а не в состоянии каждого игрока.
//
// Состав зданий и их эффекты — по переработке ТЗ 4.4 (2026-08-30): Военное министерство → Ядерный
// арсенал, Роботоцех → Аэропорт, Банк → Радиовышка, Биржа → Рынок, Арсенал → Храм (старые id больше
// нигде не используются — проверено grep'ом по всему src/server перед переименованием).

import type { ResourceId } from "../map/types";

export type BuildingGroup = "military" | "economy" | "industry" | "social";

export interface GroupMeta {
  label: string;
  icon: string;
  color: string;
}

export const GROUP_META: Record<BuildingGroup, GroupMeta> = {
  military: { label: "Военные", icon: "⚔", color: "#d4553f" },
  economy: { label: "Экономические", icon: "💰", color: "#d4913f" },
  industry: { label: "Промышленные", icon: "⚙", color: "#8f9aa8" },
  social: { label: "Социальные", icon: "🗣", color: "#3fc4b0" },
};

export const GROUPS: BuildingGroup[] = ["military", "economy", "industry", "social"];

/** One line of a building's structured price — N units of one exact resource, N units each of a
 * *different* resource within a class (no repeats), or N units of ANY of several interchangeable
 * resources (`anyOf`). Mirrors the plain-text `cost` string one-for-one; keep both in sync when
 * editing a price. `anyOf` появился по прямому запросу «пусть электричество и углеводороды будут
 * эквивалентны друг другу» — раньше выразить «одно ИЛИ другое» было нечем, только точный ресурс
 * либо целый класс (а класс «стратегические» шире: туда попадают и руда, и уран, и лес). */
export type BuildingCostLine =
  | { kind: "specific"; resource: string; count: number }
  | { kind: "category"; category: "food" | "trade" | "strategic"; count: number }
  | { kind: "anyOf"; resources: string[]; count: number };

const specific = (resource: string, count: number): BuildingCostLine => ({ kind: "specific", resource, count });
const category = (category: "food" | "trade" | "strategic", count: number): BuildingCostLine => ({ kind: "category", category, count });

export interface BuildingDef {
  id: string;
  name: string;
  group: BuildingGroup;
  /** Технология, открывающая здание. null — стандартное, доступно без исследований. */
  tech: string | null;
  epoch: number | null;
  /** Игровой эффект. Пустая строка — ещё не спроектирован (подсвечивается в сетке). */
  effect: string;
  /** 🏆 Альтернативная механика победы, а не просто бонус — Космодром и ООН. */
  victory?: boolean;
  /** Цена постройки: всегда 4 ресурса на руках, всегда включает 1-3 Силикаты. Человекочитаемая
   * строка — для отображения; costLines — та же цена, но структурированно, для списания
   * («Строитель», main.ts). */
  cost: string;
  costLines: BuildingCostLine[];
  /** Cycle production ("производит N X за цикл" in effect) — clicking the owned building spends
   * 1 💰 + 1 action to add `qty` of `resource` right away, same general "pay 1 💰, activate,
   * costs an action" mechanic as every other building-with-a-function (main.ts, onBuildingClick).
   * `resource` is a real ResourceId now (GameSession.activateProductionBuilding deposits straight
   * into `warehouse`) — Электричество/Промтовары/Контент still only ever come from a building
   * (targetCount: 0 in map/types.ts), they just aren't held in a separate contour any more. */
  produces?: { resource: ResourceId; qty: number };
}

const B = (
  id: string,
  name: string,
  group: BuildingGroup,
  tech: string | null,
  epoch: number | null,
  effect: string,
  cost: string,
  costLines: BuildingCostLine[],
  victory = false,
  produces?: BuildingDef["produces"]
): BuildingDef => ({ id, name, group, tech, epoch, effect, cost, costLines, victory, produces });

export const BUILDINGS: BuildingDef[] = [
  // ⚔ Военные
  B("kazarma", "Казарма", "military", "Бронзовое дело", 1, "1 действие + обычная цена юнита по эпохе, без карты — строит 1 Воина в любом своём городе", "1 Силикаты + 1 Лес + 2 Металл", [specific("silicates", 1), specific("wood", 1), specific("metalOre", 2)]),
  B("fort", "Фортификация", "military", "Феодализм", 2, "Нет активации — пассивный бонус обороны, растёт по эпохам", "3 Силикаты + 1 Металл", [specific("silicates", 3), specific("metalOre", 1)]),
  B("yadernyi_arsenal", "Ядерный арсенал", "military", "Атомная энергия", 5, "1 действие + 2 Уран + 1 Металл, без денег, без лимита цикла — +1 ядерное оружие в запас (предмет пока без применения — нет боя/системы целей)", "2 Силикаты + 1 Металл + 1 Уран", [specific("silicates", 2), specific("metalOre", 1), specific("uranium", 1)]),
  B("aeroport", "Аэропорт", "military", "Авиация", 5, "1 действие, без денег, без лимита цикла — переброска 1 своего юнита со столицы на любую клетку карты (сектор нейтрален/свой, на клетке нет вражеского юнита; чужой сектор без «Открытых границ» — блокируется)", "1 Силикаты + 2 Металл + 1 Углеводороды", [specific("silicates", 1), specific("metalOre", 2), specific("hydrocarbons", 1)]),

  // 💰 Экономические
  B("sklad", "Склад", "economy", "Стандартизация", 2, "Удваивает вместимость хранилища (6 → 12 единиц). Клик по своему Складу — как карта «Рабочий», но без неё: собрать регион на склад за 1 действие + 1 💰 за каждую добытую единицу, доступно каждый цикл", "1 Силикаты + 1 Лес + 2 разных торговых ресурса", [specific("silicates", 1), specific("wood", 1), category("trade", 2)]),
  B("radiovyshka", "Радиовышка", "economy", "Радио", 5, "1 действие + 1💰, не больше 1 раза за цикл (требует 1 Электричество со склада) — +3 Контента: новый building-only торговый ресурс (кино/музыка и подобное), монополия владельца, как Промтовары у Фабрики", "1 Силикаты + 1 Металл + 2 разных торговых ресурса", [specific("silicates", 1), specific("metalOre", 1), category("trade", 2)], false, { resource: "content", qty: 3 }),
  B("rynok", "Рынок", "economy", "Экономика", 3, "1 действие, продаёт 1 торговый ресурс со склада — +2💰", "1 Силикаты + 3 разных торговых ресурса", [specific("silicates", 1), category("trade", 3)]),
  B("fabrika", "Фабрика", "economy", "Конвейер", 5, "Клик по своей Фабрике — 1 💰 + 1 действие (требует 1 Электричество со склада), получить 3 Промтовара. Промтовары — торговый ресурс, которого нет на карте: единственный источник — Фабрика, то есть монополия её владельца", "1 Силикаты + 3 Металл", [specific("silicates", 1), specific("metalOre", 3)], false, { resource: "promtovary", qty: 3 }),

  // ⚙ Промышленные
  B("ges", "ГЭС", "industry", "Паровой двигатель", 4, "Клик по своей ГЭС — 1 💰 + 1 действие, получить 1 Электричество", "1 Силикаты + 1 Лес + 2 Металл", [specific("silicates", 1), specific("wood", 1), specific("metalOre", 2)], false, { resource: "electricity", qty: 1 }),
  B("aes", "АЭС", "industry", "Атомная энергия", 5, "Клик по своей АЭС — 1 💰 + 1 действие, получить 2 Электричества", "1 Силикаты + 1 Металл + 2 Уран", [specific("silicates", 1), specific("metalOre", 1), specific("uranium", 2)], false, { resource: "electricity", qty: 2 }),
  B("hram", "Храм", "industry", "Мистицизм", 1, "1 действие, ни денег, ни ресурсов — сжигает 1 любую выбранную карту действия из руки (обычный сброс на дно колоды, без штрафных эффектов перебора) и даёт +1💰 за каждый город любого игрока, чья религия совпадает с религией владельца Храма (атеист/без религии — сравнивать не с чем, доход 0)", "1 Силикаты + 1 Лес + 2 разных пищевых ресурса", [specific("silicates", 1), specific("wood", 1), category("food", 2)]),
  B("kosmodrom", "Космодром", "industry", "Космонавтика", 6, "1 действие + 1 Углеводороды + 2 Редкоземельные + 2 Металла + 1 Уран, без денег, без лимита цикла — +1 компонент корабля, накопительно за партию; 3 компонента = 🏆 победа через космос", "1 Силикаты + 1 Металл + 1 Уран + 1 Редкоземельные", [specific("silicates", 1), specific("metalOre", 1), specific("uranium", 1), specific("rareEarth", 1)], true),

  // 🗣 Социальные
  B("upravlenie", "Управление", "social", "Всеобщая воинская повинность", 4, "2💰, без действия, без лимита цикла — +1 действие в этот ход (не более раза за ход)", "1 Силикаты + 1 Лес + 2 разных пищевых ресурса", [specific("silicates", 1), specific("wood", 1), category("food", 2)]),
  B("universitet", "Университет", "social", "Образование", 3, "1 действие + 5💰 — то же открытие технологии, что и карта «Учёный» (та же механика лидерства по веткам), только через здание и с доплатой 5💰 сверху обычной цены исследования", "1 Силикаты + 1 Лес + 2 разных пищевых ресурса", [specific("silicates", 1), specific("wood", 1), category("food", 2)]),
  B("internet", "Интернет", "social", "Интернет", 6, "1 действие + 5💰, выбрать другого игрока — сравняться с ним по всем веткам, где он впереди (подтянуть свои технологии до его глубины); если он нигде не впереди — активировать нельзя, деньги не списываются", "1 Силикаты + 1 Металл + 2 Редкоземельные", [specific("silicates", 1), specific("metalOre", 1), specific("rareEarth", 2)]),
  B("oon", "ООН", "social", "Права человека", 5, "🏆 Дипломатическая победа: раз в цикл созывает голосование среди игроков — большинство в поддержку инициатора завершает партию его победой", "1 Силикаты + 3 разных торговых ресурса", [specific("silicates", 1), category("trade", 3)], true),
];

export function buildingsIn(group: BuildingGroup): BuildingDef[] {
  return BUILDINGS.filter((b) => b.group === group);
}

/** Глобальное владение: id здания -> до `MAX_BUILDING_OWNERS` id игроков, каждый со своим
 * независимым экземпляром (см. buildings.ts export const и ТЗ 4.4 — не общая постройка на двоих).
 * Отсутствующий/пустой массив = здание ещё полностью свободно. */
export type BuildingOwners = Record<string, number[]>;

/** До скольких разных игроков одновременно может принадлежать одно и то же здание — раньше было
 * жёстко 1 ("кто первым построил, тот забрал"), теперь 2: третьему и далее оно недоступно, только
 * когда оба слота заняты. */
export const MAX_BUILDING_OWNERS = 2;

export function ownersOf(owners: BuildingOwners, id: string): number[] {
  return owners[id] ?? [];
}

export function isTaken(owners: BuildingOwners, id: string): boolean {
  return ownersOf(owners, id).length >= MAX_BUILDING_OWNERS;
}

export function isOwnedBy(owners: BuildingOwners, id: string, playerId: number): boolean {
  return ownersOf(owners, id).includes(playerId);
}

/** Занять один из до 2 слотов здания для игрока. Возвращает false, если оба слота уже заняты
 * (двумя РАЗНЫМИ игроками) или если этот же игрок уже владеет этим зданием (нельзя иметь 2 своих
 * экземпляра одного здания). */
export function claimBuilding(owners: BuildingOwners, id: string, playerId: number): boolean {
  const current = ownersOf(owners, id);
  if (current.length >= MAX_BUILDING_OWNERS || current.includes(playerId)) return false;
  owners[id] = [...current, playerId];
  return true;
}

export function builtBy(owners: BuildingOwners, playerId: number): BuildingDef[] {
  return BUILDINGS.filter((b) => isOwnedBy(owners, b.id, playerId));
}
