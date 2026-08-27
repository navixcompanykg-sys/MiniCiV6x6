import { REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H, LATITUDE_BANDS, bandForRegionRow } from "./mapDoc";
import type { MapDoc } from "./mapDoc";
import { shuffleArray } from "./rand";
import { hexNeighbors } from "./hexMath";
import { RESOURCE_BY_ID } from "./types";
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
  /** The tile must have a neighbor lying in a *different* region that's open sea (land === 0) —
   * so whales/crabs sit on the real coast, never in some landlocked puddle inside a continent. */
  requireAdjacentSeaRegion?: boolean;
  /** Allow a second tile of this same resource type in the region — last-resort only, and never
   * used for strategic resources (metal/silicates/hydrocarbons/uranium/preciousMetals/rareEarth
   * must never cluster two-of-a-kind in one region). */
  allowDuplicate?: boolean;
}

const MAP_W = REGION_GRID_W * REGION_SIZE_X;
const MAP_H = REGION_GRID_H * REGION_SIZE_Y;

function isAdjacentToSeaRegion(region: RegionInfo, c: number, r: number, regionByKey: Map<string, RegionInfo>): boolean {
  for (const [nc, nr] of hexNeighbors(c, r)) {
    if (nc < 0 || nc >= MAP_W || nr < 0 || nr >= MAP_H) continue;
    const nrc = Math.floor(nc / REGION_SIZE_X);
    const nrr = Math.floor(nr / REGION_SIZE_Y);
    if (nrc === region.rc && nrr === region.rr) continue; // same region — not what we're checking
    const neighborRegion = regionByKey.get(`${nrc},${nrr}`);
    if (neighborRegion && !neighborRegion.inhabited) return true;
  }
  return false;
}

function eligibleCoords(doc: MapDoc, region: RegionInfo, resource: ResourceId, opts: PlaceOpts, regionByKey: Map<string, RegionInfo>): Coord[] {
  if (!opts.allowDuplicate && region.placedTypes.has(resource)) return [];
  return region.coords.filter(([c, r]) => {
    const tile = doc.get(c, r);
    if (tile.resource) return false;
    const terrain = tile.terrain;
    if (terrain === "iceOcean") return false; // never on ice, no exceptions
    if (opts.onWater) {
      if (terrain !== "ocean") return false;
    } else if (terrain === "ocean") {
      return false; // land resources never sit on open water
    }
    if (opts.requireTerrain && !opts.requireTerrain.includes(terrain)) return false;
    if (opts.excludeTerrain && opts.excludeTerrain.includes(terrain)) return false;
    if (opts.requireForest && !tile.forest) return false;
    if (opts.requireAdjacentSeaRegion && !isAdjacentToSeaRegion(region, c, r, regionByKey)) return false;
    return true;
  });
}

function placeOne(doc: MapDoc, region: RegionInfo, resource: ResourceId, rng: () => number, opts: PlaceOpts, regionByKey: Map<string, RegionInfo>): boolean {
  if (region.slotsRemaining <= 0) return false;
  const candidates = eligibleCoords(doc, region, resource, opts, regionByKey);
  if (candidates.length === 0) return false;
  const [c, r] = candidates[Math.floor(rng() * candidates.length)];
  doc.set(c, r, { resource });
  region.slotsRemaining--;
  region.placedTypes.add(resource);
  return true;
}

function placeInPool(doc: MapDoc, pool: RegionInfo[], resource: ResourceId, count: number, rng: () => number, opts: PlaceOpts, regionByKey: Map<string, RegionInfo>): number {
  const candidates = pool.filter((r) => r.inhabited && r.slotsRemaining > 0 && eligibleCoords(doc, r, resource, opts, regionByKey).length > 0);
  shuffleArray(candidates, rng);
  let placed = 0;
  for (const region of candidates) {
    if (placed >= count) break;
    if (placeOne(doc, region, resource, rng, opts, regionByKey)) placed++;
  }
  return placed;
}

/** Places up to `count` units of `resource`, one per region, into distinct regions drawn from
 * `pool` — the band-restricted set the algorithm's rule calls for (e.g. "tropical only"). The
 * band restriction is never relaxed, even under pressure: spices belong in the tropics and must
 * never end up in tundra just because the tropics ran out of room. Anything that doesn't fit at
 * first is retried immediately within that *same* pool: first dropping the terrain requirement,
 * then — for anything that isn't a strategic resource — allowing a second tile of this type in
 * one region as an absolute last resort. Strategic resources (metal, silicates, hydrocarbons,
 * uranium, precious metals, rare earth) never get that last resort: two of the same strategic
 * resource must never cluster in one region, full stop, even if that means falling short. */
function placeCount(doc: MapDoc, pool: RegionInfo[], resource: ResourceId, count: number, rng: () => number, opts: PlaceOpts, regionByKey: Map<string, RegionInfo>) {
  let remaining = count - placeInPool(doc, pool, resource, count, rng, opts, regionByKey);
  if (remaining <= 0) return;

  const isWaterResource = resource === "fish" || resource === "shellfish" || resource === "whales";
  const relaxedOpts: PlaceOpts = isWaterResource ? { onWater: true, requireAdjacentSeaRegion: opts.requireAdjacentSeaRegion } : {};
  remaining -= placeInPool(doc, pool, resource, remaining, rng, relaxedOpts, regionByKey);
  if (remaining <= 0) return;

  if (RESOURCE_BY_ID[resource].category !== "strategic") {
    remaining -= placeInPool(doc, pool, resource, remaining, rng, { ...relaxedOpts, allowDuplicate: true }, regionByKey);
  }
  // if that still fell short, there's truly no room left in this resource's climate zone — leave
  // it unplaced rather than violate the band restriction.
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
  const regionByKey = new Map(regions.map((r) => [`${r.rc},${r.rr}`, r]));
  const pc = (pool: RegionInfo[], resource: ResourceId, count: number, opts: PlaceOpts) => placeCount(doc, pool, resource, count, rng, opts, regionByKey);

  const desertPool = regions.filter((r) => hasTerrain(r, doc, "desert"));
  const tundraPool = regions.filter((r) => hasTerrain(r, doc, "tundra"));

  // 1-2) Sea life. Whales go first even though the algorithm lists them second — they're the
  // tightest-constrained (only 2 bands, must touch open sea) and temperate-n is shared with
  // fish/crabs, so claiming whales' scarce eligible tiles before fish/crabs get a chance at that
  // same band avoids starving them of the room they need.
  const whalePool = byBand(regions, "polar-n", "temperate-n");
  pc(whalePool, "whales", 3, { onWater: true, requireAdjacentSeaRegion: true });

  const seaPool = byBand(regions, "temperate-n", "temperate-s", "tropical-n", "tropical-s");
  pc(seaPool, "fish", 4, { onWater: true });
  pc(seaPool, "shellfish", 4, { onWater: true, requireAdjacentSeaRegion: true });

  // 3) Metal ore: 1 per latitude zone, plus one extra in each polar zone (never a 2nd in the
  // same region as the first).
  const METAL_PER_BAND: Record<string, number> = { "polar-n": 2, "polar-s": 2, "temperate-n": 1, "temperate-s": 1, "tropical-n": 1, "tropical-s": 1 };
  for (const band of LATITUDE_BANDS) {
    pc(byBand(regions, band.id), "metalOre", METAL_PER_BAND[band.id] ?? 0, {});
  }

  // 4) Hydrocarbons: 2 on desert tiles, 1 on a tundra tile, 1 in temperate-n, 1 in temperate-s
  // (never on hills).
  pc(desertPool, "hydrocarbons", 2, { requireTerrain: ["desert"] });
  pc(tundraPool, "hydrocarbons", 1, { requireTerrain: ["tundra"] });
  pc(byBand(regions, "temperate-n"), "hydrocarbons", 1, { excludeTerrain: ["hills"] });
  pc(byBand(regions, "temperate-s"), "hydrocarbons", 1, { excludeTerrain: ["hills"] });

  // 5) Uranium: 1 on a tundra tile, 1 on a desert tile, 1 on a hills tile in the temperate zone.
  pc(tundraPool, "uranium", 1, { requireTerrain: ["tundra"] });
  pc(desertPool, "uranium", 1, { requireTerrain: ["desert"] });
  const temperateHills = byBand(regions, "temperate-n", "temperate-s").filter((r) => hasTerrain(r, doc, "hills"));
  pc(temperateHills, "uranium", 1, { requireTerrain: ["hills"] });

  // 6) Fur: 2 on tundra tiles in the northern polar zone, 1 on a tundra tile in the southern.
  pc(byBand(regions, "polar-n").filter((r) => hasTerrain(r, doc, "tundra")), "fur", 2, { requireTerrain: ["tundra"] });
  pc(byBand(regions, "polar-s").filter((r) => hasTerrain(r, doc, "tundra")), "fur", 1, { requireTerrain: ["tundra"] });

  // 7) Fruit on jungle tiles + spices anywhere, both tropical only.
  const tropicalPool = byBand(regions, "tropical-n", "tropical-s");
  pc(tropicalPool, "fruit", 4, { requireForest: true });
  pc(tropicalPool, "spices", 3, {});

  // 8) Grain: anywhere in the temperate zone.
  pc(byBand(regions, "temperate-n", "temperate-s"), "grain", 4, {});

  // 9) Vegetables + cotton: anywhere at all, except mountains, desert or tundra.
  const noHarshTerrain: PlaceOpts = { excludeTerrain: ["mountains", "desert", "tundra"] };
  pc(regions, "vegetables", 4, noHarshTerrain);
  pc(regions, "cotton", 3, noHarshTerrain);

  // 10) Fill whatever's left in every region that hasn't reached 3 yet. Rare earth is strategic
  // (never allowed to duplicate in a region) and has the smallest count, so it goes first while
  // the widest choice of distinct regions is still available — otherwise it's stuck with
  // whatever's left after the other three fillers have already picked over the map.
  const fillers: [ResourceId, number][] = [
    ["rareEarth", 2],
    ["silicates", 3],
    ["preciousMetals", 3],
    ["livestock", 4],
  ];
  for (const [id, count] of fillers) pc(regions, id, count, {});
}
