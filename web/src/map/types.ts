export type TerrainId =
  | "ocean"
  | "iceOcean"
  | "plains"
  | "hills"
  | "mountains"
  | "desert"
  | "tundra";

export interface TerrainDef {
  id: TerrainId;
  label: string;
  color: number;
  isWater: boolean;
  /** Can carry the forest/jungle overlay (see TileData.forest in mapDoc.ts). */
  canHaveForest?: boolean;
}

// Starter palette — easy to extend, this is exactly what the user will tell us
// needs adjusting once they've designed a map by hand.
// Forest is NOT a base terrain — it's an overlay on Plains/Hills (see TileData.forest),
// rendered as green patches and auto-labeled "Лес" or "Джунгли" depending on latitude band.
export const TERRAINS: TerrainDef[] = [
  { id: "ocean", label: "Море", color: 0x1c5a8a, isWater: true },
  { id: "iceOcean", label: "Полярный лёд (море)", color: 0xcfe8f2, isWater: true },
  { id: "plains", label: "Равнина", color: 0xa3c95b, isWater: false, canHaveForest: true },
  { id: "hills", label: "Холмы", color: 0xb08b52, isWater: false, canHaveForest: true },
  { id: "mountains", label: "Горы", color: 0x8a8a8a, isWater: false },
  { id: "desert", label: "Пустыня", color: 0xd9c17a, isWater: false },
  { id: "tundra", label: "Тундра", color: 0x9aa87d, isWater: false },
];

export const TERRAIN_BY_ID: Record<TerrainId, TerrainDef> = Object.fromEntries(
  TERRAINS.map((t) => [t.id, t])
) as Record<TerrainId, TerrainDef>;

export type ResourceCategory = "food" | "strategic" | "trade";

export type ResourceId =
  | "grain"
  | "livestock"
  | "fruit"
  | "vegetables"
  | "fish"
  | "shellfish"
  | "metalOre"
  | "silicates"
  | "hydrocarbons"
  | "preciousMetals"
  | "uranium"
  | "rareEarth"
  | "spices"
  | "cotton"
  | "fur"
  | "whales";

export interface ResourceDef {
  id: ResourceId;
  label: string;
  category: ResourceCategory;
  /** Target total count from the ТЗ — shown in the counter as a "x / target" reference, not enforced. */
  targetCount: number;
  requiresWater: boolean;
  /** Own fill color so resources sharing a category (same marker shape) aren't visually identical. */
  color: number;
  /** Short 1-3 char mark drawn on the marker itself — like a legend code on a contour map, so
   * resources are identifiable without relying on color alone (color-blind-unfriendly, and hard
   * to tell apart at a glance regardless). */
  symbol: string;
}

export const RESOURCES: ResourceDef[] = [
  { id: "grain", label: "Злаки", category: "food", targetCount: 4, requiresWater: false, color: 0xe8c547, symbol: "Зл" },
  { id: "livestock", label: "Домашние животные", category: "food", targetCount: 4, requiresWater: false, color: 0xa0622d, symbol: "Жв" },
  { id: "fruit", label: "Фрукты", category: "food", targetCount: 4, requiresWater: false, color: 0xe85d3d, symbol: "Фр" },
  { id: "vegetables", label: "Овощи", category: "food", targetCount: 4, requiresWater: false, color: 0x4caf50, symbol: "Ов" },
  { id: "fish", label: "Рыба", category: "food", targetCount: 4, requiresWater: true, color: 0x2196c4, symbol: "Ры" },
  { id: "shellfish", label: "Крабы/Моллюски", category: "food", targetCount: 4, requiresWater: true, color: 0xe8798a, symbol: "Кр" },
  { id: "metalOre", label: "Металлические руды", category: "strategic", targetCount: 8, requiresWater: false, color: 0x5c6b73, symbol: "Fe" },
  { id: "silicates", label: "Силикаты", category: "strategic", targetCount: 3, requiresWater: false, color: 0xd4c5a0, symbol: "Si" },
  { id: "hydrocarbons", label: "Углеводороды", category: "strategic", targetCount: 5, requiresWater: false, color: 0x5a4632, symbol: "Уг" },
  { id: "preciousMetals", label: "Драгоценные металлы", category: "strategic", targetCount: 3, requiresWater: false, color: 0xffd700, symbol: "Au" },
  { id: "uranium", label: "Уран", category: "strategic", targetCount: 3, requiresWater: false, color: 0x7fff2a, symbol: "U" },
  { id: "rareEarth", label: "Редкоземельные материалы", category: "strategic", targetCount: 2, requiresWater: false, color: 0x9b59d0, symbol: "РЗ" },
  { id: "spices", label: "Специи", category: "trade", targetCount: 3, requiresWater: false, color: 0xc0392b, symbol: "Сп" },
  { id: "cotton", label: "Хлопок", category: "trade", targetCount: 3, requiresWater: false, color: 0xf5f5f0, symbol: "Хл" },
  { id: "fur", label: "Мех", category: "trade", targetCount: 3, requiresWater: false, color: 0x8b5a2b, symbol: "Мх" },
  { id: "whales", label: "Киты", category: "trade", targetCount: 3, requiresWater: true, color: 0x2c5f8a, symbol: "Ки" },
];

export const RESOURCE_BY_ID: Record<ResourceId, ResourceDef> = Object.fromEntries(
  RESOURCES.map((r) => [r.id, r])
) as Record<ResourceId, ResourceDef>;

export const CATEGORY_COLOR: Record<ResourceCategory, number> = {
  food: 0x2ecc40,
  strategic: 0xbfbfbf,
  trade: 0xffd700,
};
