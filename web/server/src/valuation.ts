// === Система ценности объектов — общая часть, используемая И GameSession.ts, И bot.ts ============
// Перенесено из bot.ts (по прямому запросу — система отношений AI: фактор «дань/подарок = ценность
// переданного / 2» нужен ВНУТРИ GameSession.applyProposalTerms, а не только в bot.ts, где эти
// формулы жили раньше). Здесь — только простые, самодостаточные формулы (не зависящие от AI-специфичных
// понятий вроде «сосед»/«угроза»/«ветка лидерства») — остальные `valueOf*` (война/мир/оборонительный
// пакт/научное сотрудничество/торговый союз) остаются в bot.ts, они реально нужны только там.
//
// `GameSession` импортируется ТОЛЬКО как тип (`import type`) — стирается на компиляции, поэтому не
// создаёт настоящего кругового runtime-импорта с GameSession.ts (который импортирует функции отсюда).
//
// Полное текущее поведение — ЦИВА-СПРАВОЧНИК.md §8.1 «Ценность объектов».

import type { GameSession } from "./GameSession";
import type { BuildingDef } from "../../src/game/buildings";
import { RESOURCES, type ResourceId } from "../../src/map/types";

const RESOURCE_CATEGORY = new Map(RESOURCES.map((r) => [r.id, r.category]));

/** 1. Город — население × число СТРАТЕГИЧЕСКИХ ресурсов в его регионе (0, если таких нет вовсе). */
export function valueOfCity(session: GameSession, city: { population: number; regionCol: number; regionRow: number }): number {
  const strategicCount = session.resourcesInRegion(city.regionCol, city.regionRow).filter((r) => RESOURCE_CATEGORY.get(r) === "strategic").length;
  return city.population * strategicCount;
}
/** 2. Юнит — одинаково для всех категорий, 2 × эпоха. */
export function valueOfUnit(unit: { epoch: number }): number {
  return 2 * unit.epoch;
}
/** 3. Деньги — 1:1. */
export function valueOfMoney(amount: number): number {
  return amount;
}
/** 4. Технология — эпоха × 2. */
export function valueOfTechByEpoch(epoch: number): number {
  return epoch * 2;
}
/** 5. Открытые границы — фиксированно. */
export const VALUE_OPEN_BORDERS = 2;

/** 10. Ресурс — средняя биржевая стоимость (среднее цены среди активных лотов этого ресурса на
 * рынке прямо сейчас); нет активных лотов — фиксированный базовый ориентир (тот же, что «Рынок»
 * использует для продажи излишков). */
export const FALLBACK_RESOURCE_VALUE = 4;
export function valueOfResource(session: GameSession, resource: ResourceId): number {
  const listings = session.market.filter((l) => l.kind === "resource" && l.resource === resource);
  if (!listings.length) return FALLBACK_RESOURCE_VALUE;
  return listings.reduce((s, l) => s + l.price, 0) / listings.length;
}

/** 12/13. Карта — действие +5, событие −5 (событие «стоит» отрицательно: это то, от чего хочется
 * избавиться, см. §15.4/looksUnplayableThisTurn — согласуется с этим же знаком). */
export function valueOfCard(card: { kind: "action" | "event" }): number {
  return card.kind === "event" ? -5 : 5;
}
/** 14. Здание — ценность ресурсов на его постройку (п.10 на каждую строку цены; `category`/`anyOf`
 * строки — конкретный ресурс заранее не известен, берётся базовый ориентир/самый дешёвый вариант
 * соответственно, не точная сумма). */
export function valueOfBuilding(session: GameSession, building: BuildingDef): number {
  let total = 0;
  for (const line of building.costLines) {
    if (line.kind === "specific") total += valueOfResource(session, line.resource as ResourceId) * line.count;
    else if (line.kind === "category") total += FALLBACK_RESOURCE_VALUE * line.count;
    else if (line.kind === "anyOf") total += Math.min(...line.resources.map((r) => valueOfResource(session, r as ResourceId))) * line.count;
  }
  return total;
}
