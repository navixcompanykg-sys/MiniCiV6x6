import { REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H, LATITUDE_BANDS, bandForRegionRow } from "./mapDoc";
import type { MapDoc } from "./mapDoc";
import { shuffleArray } from "./rand";
import type { ResourceId, TerrainId } from "./types";

const INHABITED_LAND_THRESHOLD = 3;
type Coord = [number, number];

interface RegionInfo {
  rc: number;
  rr: number;
  bandId: string;
  coords: Coord[];
  land: Coord[];
  inhabited: boolean;
  slotsRemaining: number;
  placedTypes: Set<ResourceId>;
}

function buildRegionInfo(doc: MapDoc): RegionInfo[] {
  const regions: RegionInfo[] = [];
  for (let rc = 0; rc < REGION_GRID_W; rc++) {
    for (let rr = 0; rr < REGION_GRID_H; rr++) {
      const coords: Coord[] = [];
      const land: Coord[] = [];
      for (let dx = 0; dx < REGION_SIZE_X; dx++) {
        for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
          const col = rc * REGION_SIZE_X + dx;
          const row = rr * REGION_SIZE_Y + dy;
          coords.push([col, row]);
          const t = doc.get(col, row).terrain;
          if (t !== "ocean" && t !== "iceOcean") land.push([col, row]);
        }
      }
      const inhabited = land.length >= INHABITED_LAND_THRESHOLD;
      regions.push({ rc, rr, bandId: bandForRegionRow(rr).id, coords, land, inhabited, slotsRemaining: inhabited ? 3 : 0, placedTypes: new Set() });
    }
  }
  return regions;
}

interface PlaceOpts {
  /** The resource's own tile must be literal open sea — never ice, regardless of this flag. */
  onWater?: boolean;
  requireTerrain?: TerrainId[];
  excludeTerrain?: TerrainId[];
  /** Tile must carry the forest/jungle overlay (only meaningful on plains/hills). */
  requireForest?: boolean;
  /** Allow a second tile of this same resource type in the region (only used as a last resort). */
  allowDuplicate?: boolean;
}

function eligibleCoords(doc: MapDoc, region: RegionInfo, resource: ResourceId, opts: PlaceOpts): Coord[] {
  if (!opts.allowDuplicate && region.placedTypes.has(resource)) return [];
  return region.coords.filter(([c, r]) => {
    const tile = doc.get(c, r);
    if (tile.resource) return false;
    const terrain = tile.terrain;
    if (terrain === "iceOcean") return false; // never on ice, no exceptions
    if (opts.onWater) return terrain === "ocean";
    if (terrain === "ocean") return false; // land resources never sit on open water
    if (opts.requireTerrain && !opts.requireTerrain.includes(terrain)) return false;
    if (opts.excludeTerrain && opts.excludeTerrain.includes(terrain)) return false;
    if (opts.requireForest && !tile.forest) return false;
    return true;
  });
}

function placeOne(doc: MapDoc, region: RegionInfo, resource: ResourceId, rng: () => number, opts: PlaceOpts): boolean {
  if (region.slotsRemaining <= 0) return false;
  const candidates = eligibleCoords(doc, region, resource, opts);
  if (candidates.length === 0) return false;
  const [c, r] = candidates[Math.floor(rng() * candidates.length)];
  doc.set(c, r, { resource });
  region.slotsRemaining--;
  region.placedTypes.add(resource);
  return true;
}

function placeInPool(doc: MapDoc, pool: RegionInfo[], resource: ResourceId, count: number, rng: () => number, opts: PlaceOpts): number {
  const candidates = pool.filter((r) => r.inhabited && r.slotsRemaining > 0 && eligibleCoords(doc, r, resource, opts).length > 0);
  shuffleArray(candidates, rng);
  let placed = 0;
  for (const region of candidates) {
    if (placed >= count) break;
    if (placeOne(doc, region, resource, rng, opts)) placed++;
  }
  return placed;
}

/** Places up to `count` units of `resource`, one per region, into distinct regions drawn from
 * `pool` — the band-restricted set the algorithm's rule calls for (e.g. "tropical only"). The
 * band restriction is never relaxed, even under pressure: spices belong in the tropics and must
 * never end up in tundra just because the tropics ran out of room. Anything that doesn't fit at
 * first is retried immediately within that *same* pool, first dropping the terrain requirement,
 * then finally allowing a second tile of this type in one region — chased down before later
 * rules get a chance to consume the capacity that would have fixed it. Water-only resources
 * always keep the "must sit on literal open sea, never ice" rule, even relaxed. */
function placeCount(doc: MapDoc, pool: RegionInfo[], resource: ResourceId, count: number, rng: () => number, opts: PlaceOpts) {
  let remaining = count - placeInPool(doc, pool, resource, count, rng, opts);
  if (remaining <= 0) return;

  const isWaterResource = resource === "fish" || resource === "shellfish" || resource === "whales";
  const waterOpts: PlaceOpts = isWaterResource ? { onWater: true } : {};
  const stages: PlaceOpts[] = [waterOpts, { ...waterOpts, allowDuplicate: true }];
  for (const stageOpts of stages) {
    if (remaining <= 0) break;
    remaining -= placeInPool(doc, pool, resource, remaining, rng, stageOpts);
  }
  // if every stage failed, there's truly no room left in this resource's climate zone — leave it
  // unplaced rather than violate the band restriction.
}

const byBand = (regions: RegionInfo[], ...bandIds: string[]) => regions.filter((r) => bandIds.includes(r.bandId));
const hasTerrain = (region: RegionInfo, doc: MapDoc, terrain: TerrainId) => region.land.some(([c, r]) => doc.get(c, r).terrain === terrain);

/** Clears every placed resource and reseeds them following the exact ordered algorithm the user
 * specified (verified against their hand-built "Вторая" reference map): sea life, then the
 * band/terrain-locked strategic resources tightest-first, then the unrestricted trade/food
 * resources, finishing with a no-constraint fill to top every inhabited region up to exactly 3. */
export function generateResources(doc: MapDoc, rng: () => number) {
  for (let c = 0; c < REGION_GRID_W * REGION_SIZE_X; c++) {
    for (let r = 0; r < REGION_GRID_H * REGION_SIZE_Y; r++) {
      if (doc.get(c, r).resource) doc.set(c, r, { resource: undefined });
    }
  }

  const regions = buildRegionInfo(doc);

  const desertPool = regions.filter((r) => hasTerrain(r, doc, "desert"));
  const tundraPool = regions.filter((r) => hasTerrain(r, doc, "tundra"));

  // 1) Fish + crabs/mollusks: coastal regions in the temperate or tropical zone.
  const seaPool = byBand(regions, "temperate-n", "temperate-s", "tropical-n", "tropical-s");
  placeCount(doc, seaPool, "fish", 4, rng, { onWater: true });
  placeCount(doc, seaPool, "shellfish", 4, rng, { onWater: true });

  // 2) Whales: coastal regions in the polar or temperate zone.
  const whalePool = byBand(regions, "polar-n", "polar-s", "temperate-n", "temperate-s");
  placeCount(doc, whalePool, "whales", 3, rng, { onWater: true });

  // 3) Metal ore: 1 per latitude zone, plus one extra in each polar zone (never a 2nd in the
  // same region as the first).
  const METAL_PER_BAND: Record<string, number> = { "polar-n": 2, "polar-s": 2, "temperate-n": 1, "temperate-s": 1, "tropical-n": 1, "tropical-s": 1 };
  for (const band of LATITUDE_BANDS) {
    placeCount(doc, byBand(regions, band.id), "metalOre", METAL_PER_BAND[band.id] ?? 0, rng, {});
  }

  // 4) Hydrocarbons: 2 on desert tiles, 1 on a tundra tile, 1 in temperate-n, 1 in temperate-s
  // (never on hills).
  placeCount(doc, desertPool, "hydrocarbons", 2, rng, { requireTerrain: ["desert"] });
  placeCount(doc, tundraPool, "hydrocarbons", 1, rng, { requireTerrain: ["tundra"] });
  placeCount(doc, byBand(regions, "temperate-n"), "hydrocarbons", 1, rng, { excludeTerrain: ["hills"] });
  placeCount(doc, byBand(regions, "temperate-s"), "hydrocarbons", 1, rng, { excludeTerrain: ["hills"] });

  // 5) Uranium: 1 on a tundra tile, 1 on a desert tile, 1 on a hills tile in the temperate zone.
  placeCount(doc, tundraPool, "uranium", 1, rng, { requireTerrain: ["tundra"] });
  placeCount(doc, desertPool, "uranium", 1, rng, { requireTerrain: ["desert"] });
  const temperateHills = byBand(regions, "temperate-n", "temperate-s").filter((r) => hasTerrain(r, doc, "hills"));
  placeCount(doc, temperateHills, "uranium", 1, rng, { requireTerrain: ["hills"] });

  // 6) Fur: 2 on tundra tiles in the northern polar zone, 1 on a tundra tile in the southern.
  placeCount(doc, byBand(regions, "polar-n").filter((r) => hasTerrain(r, doc, "tundra")), "fur", 2, rng, { requireTerrain: ["tundra"] });
  placeCount(doc, byBand(regions, "polar-s").filter((r) => hasTerrain(r, doc, "tundra")), "fur", 1, rng, { requireTerrain: ["tundra"] });

  // 7) Fruit on jungle tiles + spices anywhere, both tropical only.
  const tropicalPool = byBand(regions, "tropical-n", "tropical-s");
  placeCount(doc, tropicalPool, "fruit", 4, rng, { requireForest: true });
  placeCount(doc, tropicalPool, "spices", 3, rng, {});

  // 8) Grain: anywhere in the temperate zone.
  placeCount(doc, byBand(regions, "temperate-n", "temperate-s"), "grain", 4, rng, {});

  // 9) Vegetables + cotton: anywhere at all, except mountains, desert or tundra.
  const noHarshTerrain: PlaceOpts = { excludeTerrain: ["mountains", "desert", "tundra"] };
  placeCount(doc, regions, "vegetables", 4, rng, noHarshTerrain);
  placeCount(doc, regions, "cotton", 3, rng, noHarshTerrain);

  // 10) Fill whatever's left in every region that hasn't reached 3 yet.
  const fillers: [ResourceId, number][] = [
    ["silicates", 3],
    ["preciousMetals", 3],
    ["livestock", 4],
    ["rareEarth", 2],
  ];
  for (const [id, count] of fillers) placeCount(doc, regions, id, count, rng, {});
}
