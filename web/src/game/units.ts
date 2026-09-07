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
  U("Рыцарь", "mobile", 3, "Рыцарство"), // было «Рыцари» — единственное число, как у всех остальных юнитов
  U("Пушка", "ranged", 3, "Порох"),
  U("Фрегат", "ship", 3, "Навигация"),

  // Эпоха 4
  U("Пехотинец", "assault", 4, "Паровой двигатель"),
  U("Пулемётчик", "defense", 4, "Паровой двигатель"),
  U("Авианаводчик", "support", 4, "Сталь"), // было «Самолёты» — не читалось как «Поддержка»; авианаводчик прямо называет роль (наводит удар на союзников рядом)
  U("Танк", "mobile", 4, "Сталь"), // было «Танки» — единственное число, как у всех остальных юнитов
  U("Артиллерия", "ranged", 4, "Сталь"),
  U("Крейсер", "ship", 4, "Сталь"), // было «Линкор» — переименовано по прямому уточнению, Э5 теперь Линкор

  // Эпоха 5
  U("Мотострелок", "assault", 5, "Идеология"),
  U("ПТУР", "defense", 5, "Идеология"),
  U("САУ", "support", 5, "Двигатель внутреннего сгорания"), // было «Радиокорректировщик» — по прямому запросу («Авианаводчик - далее САУ и Дроны»)
  U("БМП", "mobile", 5, "Двигатель внутреннего сгорания"), // было «Скоростной танк» — по прямому запросу
  U("Авиация", "ranged", 5, "Двигатель внутреннего сгорания"), // было «САУ» (перешло Поддержке выше) — по прямому запросу («Артиллерия - замени далее авиация, потом на ракеты»)
  U("Линкор", "ship", 5, "Двигатель внутреннего сгорания"), // было «Авианосец» — переименовано по прямому уточнению

  // Эпоха 6
  U("Киборг", "assault", 6, "Робототехника"),
  U("ПВО", "defense", 6, "Кибернетика"),
  U("Дроны", "support", 6, "Кибернетика"), // было «Кибернаводчик» — по прямому запросу, во множественном числе (явно оговорено)
  U("Робот", "mobile", 6, "Робототехника"), // было «Роботы» — единственное число, как у всех остальных юнитов
  U("Ракеты", "ranged", 6, "Робототехника"), // было «Дрон» (перешло Поддержке выше) — по прямому запросу, во множественном числе (явно оговорено)
  U("Дредноут", "ship", 6, "Дредноуты"), // технология переименована из «Ядерный синтез» по прямому запросу
];

export function unitsInCategory(category: UnitCategory): UnitDef[] {
  return UNITS.filter((u) => u.category === category).sort((a, b) => a.epoch - b.epoch);
}

/** The unit of a given category at a given epoch — the current-tier design for that slot. */
export function unitAt(category: UnitCategory, epoch: UnitDef["epoch"]): UnitDef | undefined {
  return UNITS.find((u) => u.category === category && u.epoch === epoch);
}

// --- Боевые характеристики (ТЗ 5.2/6/9) — движение и бой реализованы в main.ts, эта таблица
// только хранит цифры по категории+эпохе (юниты одной категории отличаются только эпохой). Цифры —
// с листа 6 пользовательской таблицы настройки юнитов по эпохам (по прямому запросу, заменяет
// прежние формулы целиком). ---
export interface UnitStats {
  hp: number;
  attack: number;
  attackRange: number;
  moveRange: number;
  /** Бьёт по всем юнитам цели сразу (AoE), не только по одному (5.2/6.6) — сейчас только у Кораблей;
   * «Дальняя атака» (ranged) group-урон не наносит, несмотря на дальность и высокий attack. */
  aoe: boolean;
  /** Поддержка — +1 к урону ближайшего союзного бойца в радиусе (Поддержка/Корабли, 5.2). */
  supportBonus: number;
  supportRadius: number;
  /** Личный бонус «Обороны» (GameSession.unitDefendBase/peekDefendBuffer) — плоское число единиц
   * защиты, а НЕ множитель (по прямому запросу — «защита при уходе в оборону теперь не удвоение, а
   * конкретный плюс к защите»): у КАЖДОЙ категории теперь своя растущая по эпохам величина (лист 6),
   * не только у «Оборонительных», как было раньше (там же остальным категориям молча подставлялась
   * заглушка armorMultiplier=1). */
  defenseBonus: number;
}

const ASSAULT_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 2, 2: 4, 3: 6, 4: 8, 5: 10, 6: 12 };
const ASSAULT_DEFENSE_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
const SUPPORT_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
const SUPPORT_BONUS_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
const RANGED_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
const RANGED_RANGE_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 2, 2: 3, 3: 4, 4: 6, 5: 8, 6: 10 };
const DEFENSE_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8 };
const DEFENSE_DEFENSE_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 7, 6: 9 };
const MOBILE_ATTACK_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8 };
const MOBILE_MOVE_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8 };
const SHIP_HP_BY_EPOCH: Record<UnitDef["epoch"], number> = { 1: 2, 2: 4, 3: 6, 4: 8, 5: 10, 6: 12 };

/** По классу + эпохе — цифры с листа 6 (см. заголовок файла). Атака в упор (attackRange=1) теперь
 * есть у ВСЕХ категорий без исключения (по прямому запросу — «все юниты могут атаковать в упор, но
 * не все дистанционно, остаётся как раньше»): раньше «Поддержка» единственная не могла атаковать
 * вообще (attack:0/attackRange:0). Дистанционный бой (attackRange > 1) по-прежнему только у «Дальняя
 * атака» — это не менялось, только числа её прогрессии (лист 6, обновлялся дважды по прямому
 * запросу — сверяйте прямо с таблицей, а не с формулой в голове). */
export function statsFor(category: UnitCategory, epoch: UnitDef["epoch"]): UnitStats {
  switch (category) {
    case "assault":
      return { hp: ASSAULT_HP_BY_EPOCH[epoch], attack: 2, attackRange: 1, moveRange: 2, aoe: false, supportBonus: 0, supportRadius: 0, defenseBonus: ASSAULT_DEFENSE_BY_EPOCH[epoch] };
    case "support":
      // supportRadius — раньше рос по Фибоначчи (SUPPORT_RADIUS_BY_EPOCH), теперь фиксирован (2, с
      // листа 6); supportBonus, наоборот, раньше был константой (1), теперь растёт по эпохам.
      return { hp: SUPPORT_HP_BY_EPOCH[epoch], attack: 1, attackRange: 1, moveRange: 2, aoe: false, supportBonus: SUPPORT_BONUS_BY_EPOCH[epoch], supportRadius: 2, defenseBonus: 1 };
    case "ranged":
      // aoe:false (было true) — по прямому запросу: с увеличенным уроном (attack:3) групповой удар по
      // всем юнитам на клетке позволял тройке пушек снести любой по размеру гарнизон/стек за один ход
      // войны. Теперь «Дальняя атака» бьёт по одной цели, как остальные категории (Корабли — не
      // затронуты, у них aoe сохранён).
      return { hp: RANGED_HP_BY_EPOCH[epoch], attack: 3, attackRange: RANGED_RANGE_BY_EPOCH[epoch], moveRange: 1, aoe: false, supportBonus: 0, supportRadius: 0, defenseBonus: 1 };
    case "mobile":
      // HP 2 (было 4, лист 6) — по прямому уточнению: 4 делало Мобильных слишком сильными на ранних
      // эпохах; низкое HP компенсируется высокой Скоростью (MOBILE_MOVE_BY_EPOCH) — есть чем уйти
      // из-под удара, в т.ч. от растущей дальности «Дальней атаки».
      return { hp: 2, attack: MOBILE_ATTACK_BY_EPOCH[epoch], attackRange: 1, moveRange: MOBILE_MOVE_BY_EPOCH[epoch], aoe: false, supportBonus: 0, supportRadius: 0, defenseBonus: 1 };
    case "defense":
      return { hp: DEFENSE_HP_BY_EPOCH[epoch], attack: 1, attackRange: 1, moveRange: 1, aoe: false, supportBonus: 0, supportRadius: 0, defenseBonus: DEFENSE_DEFENSE_BY_EPOCH[epoch] };
    case "ship":
      // Плавающая артиллерия (правка) — атака растёт с эпохой (1..6), бьёт по всем на клетке цели
      // (aoe — единственная категория с групповым уроном, см. поле aoe выше), фиксированная дальность
      // 1 (не растёт по эпохам), без поддержки.
      return { hp: SHIP_HP_BY_EPOCH[epoch], attack: epoch, attackRange: 1, moveRange: 4, aoe: true, supportBonus: 0, supportRadius: 0, defenseBonus: 1 };
  }
}
