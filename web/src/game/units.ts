// Юниты — ТЗ 5.1 (36 юнитов: 6 категорий × 6 эпох), привязка к технологиям — Технологии.md.
// Движение и бой не входят сюда (ТЗ 5.2/6) — эта модель только про постройку и авто-переход
// юнита игрока в новую эпоху вместе с самим игроком (см. main.ts, upgradePlayerUnits).

export type UnitCategory = "support" | "ranged" | "mobile" | "assault" | "defense" | "ship";

export interface CategoryMeta {
  label: string;
  icon: string;
}

export const CATEGORY_META: Record<UnitCategory, CategoryMeta> = {
  support: { label: "Поддержка", icon: "🏹" },
  ranged: { label: "Дальняя атака", icon: "💣" },
  mobile: { label: "Мобильные", icon: "🐎" },
  assault: { label: "Штурмовые", icon: "⚔" },
  defense: { label: "Оборонительные", icon: "🛡" },
  ship: { label: "Корабли", icon: "⛵" },
};
export const CATEGORIES: UnitCategory[] = ["assault", "support", "ranged", "mobile", "defense", "ship"];

export interface UnitDef {
  id: string; // = name, unique
  name: string;
  category: UnitCategory;
  epoch: 1 | 2 | 3 | 4 | 5 | 6;
  /** Технология, открывающая юнит. null — доступен всем с самого начала (см. Воин ниже). */
  tech: string | null;
}

const U = (name: string, category: UnitCategory, epoch: UnitDef["epoch"], tech: string | null): UnitDef => ({
  id: name,
  name,
  category,
  epoch,
  tech,
});

export const UNITS: UnitDef[] = [
  // Эпоха 1
  U("Воин", "assault", 1, null), // доступен по умолчанию с самого начала — не привязан к Бронзовому делу
  U("Копейщик", "defense", 1, "Бронзовое дело"),
  U("Лучник", "support", 1, "Бронзовое дело"),
  U("Колесница", "mobile", 1, "Колесо"),
  U("Катапульта", "ranged", 1, "Горное дело"),
  U("Галера", "ship", 1, "Мореплавание"),

  // Эпоха 2
  U("Секироносец", "assault", 2, "Феодализм"),
  U("Алебардщик", "defense", 2, "Феодализм"),
  U("Арбалетчик", "support", 2, "Феодализм"),
  U("Конница", "mobile", 2, "Верховая езда"),
  U("Требушет", "ranged", 2, "Стандартизация"),
  U("Каравелла", "ship", 2, "Компас"),

  // Эпоха 3
  U("Легионер", "assault", 3, "Рыцарство"),
  U("Крестоносец", "defense", 3, "Рыцарство"),
  U("Мушкетер", "support", 3, "Порох"),
  U("Рыцари", "mobile", 3, "Рыцарство"),
  U("Пушка", "ranged", 3, "Порох"),
  U("Фрегат", "ship", 3, "Навигация"),

  // Эпоха 4
  U("Пехотинец", "assault", 4, "Паровой двигатель"),
  U("Пулемётчик", "defense", 4, "Паровой двигатель"),
  U("Самолёты", "support", 4, "Сталь"),
  U("Танки", "mobile", 4, "Сталь"),
  U("Артиллерия", "ranged", 4, "Сталь"),
  U("Крейсер", "ship", 4, "Сталь"), // было «Линкор» — переименовано по прямому уточнению, Э5 теперь Линкор

  // Эпоха 5
  U("Мотострелок", "assault", 5, "Идеология"),
  U("ПТУР", "defense", 5, "Идеология"),
  U("Истребители", "support", 5, "Двигатель внутреннего сгорания"),
  U("Совр. танки", "mobile", 5, "Двигатель внутреннего сгорания"),
  U("САУ", "ranged", 5, "Двигатель внутреннего сгорания"),
  U("Линкор", "ship", 5, "Двигатель внутреннего сгорания"), // было «Авианосец» — переименовано по прямому уточнению

  // Эпоха 6
  U("Киборг", "assault", 6, "Робототехника"),
  U("ПВО", "defense", 6, "Кибернетика"),
  U("Ракеты", "support", 6, "Кибернетика"),
  U("Роботы", "mobile", 6, "Робототехника"),
  U("Дроны", "ranged", 6, "Робототехника"),
  U("Дредноут", "ship", 6, "Ядерный синтез"),
];

export function unitsInCategory(category: UnitCategory): UnitDef[] {
  return UNITS.filter((u) => u.category === category).sort((a, b) => a.epoch - b.epoch);
}

/** The unit of a given category at a given epoch — the current-tier design for that slot. */
export function unitAt(category: UnitCategory, epoch: UnitDef["epoch"]): UnitDef | undefined {
  return UNITS.find((u) => u.category === category && u.epoch === epoch);
}

// --- Боевые характеристики (ТЗ 5.2/6/9) — движение и бой реализованы в main.ts, эта таблица
// только хранит цифры по категории+эпохе (юниты одной категории отличаются только эпохой). ---
export interface UnitStats {
  hp: number;
  attack: number;
  attackRange: number;
  moveRange: number;
  /** Дальняя атака — бьёт по всем юнитам цели сразу (AoE), не только по одному (5.2/6.6). */
  aoe: boolean;
  /** Поддержка — +1 к урону ближайшего союзного бойца в радиусе (Поддержка/Корабли, 5.2). */
  supportBonus: number;
  supportRadius: number;
  /** Оборонительные — множитель к базовой обороне (1 = обычная защита без множителя, 5.2). */
  armorMultiplier: number;
}

const SUPPORT_RADIUS_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 8, 6: 13 };
const ARMOR_MULT_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7 };
const RANGED_RANGE_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7 };
const ASSAULT_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7 };
const RANGED_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
const MOBILE_MOVE_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8 };
const SHIP_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 2, 2: 4, 3: 6, 4: 8, 5: 10, 6: 12 };

/** По классу + эпохе — числа один в один из ТЗ 5.2 («Если сила не прописана явно — считается 1»,
 * ТЗ 9, отсюда default hp=1 везде, где явно не задано иное). */
export function statsFor(category: UnitCategory, epoch: UnitDef["epoch"]): UnitStats {
  switch (category) {
    case "assault":
      // Атака 2 (было 1) — по прямому уточнению.
      return { hp: ASSAULT_HP_BY_EPOCH[epoch], attack: 2, attackRange: 1, moveRange: 2, aoe: false, supportBonus: 0, supportRadius: 0, armorMultiplier: 1 };
    case "support":
      return { hp: 1, attack: 0, attackRange: 0, moveRange: 1, aoe: false, supportBonus: 1, supportRadius: SUPPORT_RADIUS_BY_EPOCH[epoch], armorMultiplier: 1 };
    case "ranged":
      return { hp: RANGED_HP_BY_EPOCH[epoch], attack: 1, attackRange: RANGED_RANGE_BY_EPOCH[epoch], moveRange: 1, aoe: true, supportBonus: 0, supportRadius: 0, armorMultiplier: 1 };
    case "mobile":
      return { hp: 3, attack: 1, attackRange: 1, moveRange: MOBILE_MOVE_BY_EPOCH[epoch], aoe: false, supportBonus: 0, supportRadius: 0, armorMultiplier: 1 };
    case "defense":
      // Атака 1 (было 0 — не могли атаковать вообще) — по прямому уточнению.
      return { hp: 3, attack: 1, attackRange: 1, moveRange: 1, aoe: false, supportBonus: 0, supportRadius: 0, armorMultiplier: ARMOR_MULT_BY_EPOCH[epoch] };
    case "ship":
      // Плавающая артиллерия (правка) — атака растёт с эпохой (1..6), бьёт по всем на клетке цели
      // (aoe, как Дальняя атака), фиксированная дальность 1 (не растёт по эпохам), без поддержки.
      return { hp: SHIP_HP_BY_EPOCH[epoch], attack: epoch, attackRange: 1, moveRange: 4, aoe: true, supportBonus: 0, supportRadius: 0, armorMultiplier: 1 };
  }
}
