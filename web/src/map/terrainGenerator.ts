import { MAP_WIDTH, MAP_HEIGHT, REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H, bandForRegionRow } from "./mapDoc";
import type { MapDoc } from "./mapDoc";
import { hexNeighbors } from "./hexMath";
import { shuffleArray } from "./rand";
import { generateResources } from "./resourceGenerator";

type Coord = [number, number];
const key = (c: Coord) => `${c[0]},${c[1]}`;

const TROPICAL_ROWS = [2, 3]; // tropical-n, tropical-s
const NON_POLAR_ROWS = [1, 2, 3, 4]; // temperate-n, tropical-n, tropical-s, temperate-s
const POLE_ROWS = [0, REGION_GRID_H - 1]; // polar-n, polar-s

function regionCoords(rc: number, rr: number): Coord[] {
  const coords: Coord[] = [];
  for (let dx = 0; dx < REGION_SIZE_X; dx++)
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) coords.push([rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy]);
  return coords;
}

/** Tiles on the outer ring of a region's local 4x3 block — everything except the interior
 * columns' middle row. Used so a "hole" carved into an otherwise-solid region always reads as a
 * bite out of the coastline, never a landlocked lake in the middle. */
function regionEdgeCoords(rc: number, rr: number): Coord[] {
  return regionCoords(rc, rr).filter(([c, r]) => {
    const dx = c - rc * REGION_SIZE_X;
    const dy = r - rr * REGION_SIZE_Y;
    return dx === 0 || dx === REGION_SIZE_X - 1 || dy === 0 || dy === REGION_SIZE_Y - 1;
  });
}

function isIce(doc: MapDoc, c: Coord): boolean {
  return doc.get(c[0], c[1]).terrain === "iceOcean";
}
function isLand(doc: MapDoc, c: Coord): boolean {
  const t = doc.get(c[0], c[1]).terrain;
  return t !== "ocean" && t !== "iceOcean";
}
function regionLand(doc: MapDoc, rc: number, rr: number): Coord[] {
  return regionCoords(rc, rr).filter((c) => isLand(doc, c));
}

/** Grows one connected clump of up to `size` tiles inside `pool`, starting from a tile in
 * `startPreference` when given (falls back to the whole pool). Used for every "patch of N
 * connected hexes" step in the algorithm (peninsulas, islands, deserts, mountains). */
function growClump(pool: Coord[], size: number, rng: () => number, startPreference?: Coord[]): Coord[] {
  if (pool.length === 0 || size <= 0) return [];
  const poolSet = new Set(pool.map(key));
  const starters = startPreference && startPreference.length ? startPreference : pool;
  const start = starters[Math.floor(rng() * starters.length)];
  const chosen = new Set<string>();
  const frontier: Coord[] = [start];
  while (chosen.size < size && frontier.length > 0) {
    const idx = Math.floor(rng() * frontier.length);
    const cur = frontier.splice(idx, 1)[0];
    const k = key(cur);
    if (chosen.has(k)) continue;
    chosen.add(k);
    for (const n of hexNeighbors(cur[0], cur[1])) {
      if (poolSet.has(key(n)) && !chosen.has(key(n))) frontier.push(n);
    }
  }
  return [...chosen].map((k) => k.split(",").map(Number) as Coord);
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Grows several genuinely separate clumps inside `pool` per the given `sizes` (e.g. [2, 1] = a
 * pair plus a lone tile) instead of one single connected blob — used wherever the land should
 * look like a scatter of distinct patches rather than one shape. After each patch, its tiles
 * *and their neighbors* are excluded from the pool so the next patch can't happen to land right
 * next door and read as one merged blob. The first clump honors `startPreference` (e.g. "touching
 * the continent's edge"); every lone (size-1) patch prefers `edgePreference` (e.g. "some edge of
 * the region") when given, so a solitary tile never lands stranded in the middle — it only reads
 * as "attached to something" when it happens to end up next to another patch or a neighboring
 * region's land, which is fine.
 *
 * A small region can run out of room to keep every patch fully separated — when that happens,
 * whatever's short gets topped up from the plain leftover pool (patches may end up touching
 * after all), because hitting the exact requested tile count matters more than the separation
 * being perfect every time. */
function growPatches(pool: Coord[], sizes: number[], rng: () => number, startPreference?: Coord[], edgePreference?: Coord[]): Coord[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  let remainingPool = pool;
  const result: Coord[] = [];
  sizes.forEach((size, i) => {
    if (remainingPool.length === 0) return;
    let prefer = i === 0 ? startPreference : undefined;
    if (size === 1 && edgePreference) {
      const edgeSet = new Set(edgePreference.map(key));
      const edgeInRemaining = remainingPool.filter((c) => edgeSet.has(key(c)));
      if (edgeInRemaining.length > 0) prefer = edgeInRemaining;
    }
    const patch = growClump(remainingPool, size, rng, prefer);
    result.push(...patch);
    const exclude = new Set(patch.map(key));
    for (const c of patch) for (const n of hexNeighbors(c[0], c[1])) exclude.add(key(n));
    remainingPool = remainingPool.filter((c) => !exclude.has(key(c)));
  });
  if (result.length >= total) return result;
  const chosen = new Set(result.map(key));
  const leftover = pool.filter((c) => !chosen.has(key(c)));
  return [...result, ...growClump(leftover, total - result.length, rng)];
}

/** Picks how a 3-hex island splits up: all 3 connected, a pair plus a lone tile, or three
 * completely separate single tiles — equally likely, so islands don't all look like one blob. */
function pickIslandShape(rng: () => number): number[] {
  const roll = rng();
  if (roll < 1 / 3) return [3];
  if (roll < 2 / 3) return [2, 1];
  return [1, 1, 1];
}

/** Same idea as `pickIslandShape` but for however many tiles are actually needed (1-3) — used
 * when topping up a region that already has a tile or two rather than starting from scratch. */
function pickShapeForTotal(total: number, rng: () => number): number[] {
  if (total <= 1) return [1];
  if (total === 2) return rng() < 0.5 ? [2] : [1, 1];
  return pickIslandShape(rng);
}

/** shuffleArray shuffles in place and returns nothing — this wraps it for call sites that want
 * a shuffled copy back as an expression. */
function shuffled<T>(arr: T[], rng: () => number): T[] {
  const copy = arr.slice();
  shuffleArray(copy, rng);
  return copy;
}

/** Step 1-2: top/bottom rows fully iced, then 6 tiles per pole released back to open sea and
 * 2 tiles per pole re-iced one row closer to the equator — always exactly 20 ice tiles per
 * pole (40 total), regardless of the random draw. */
function placeIce(doc: MapDoc, rng: () => number) {
  for (const top of [true, false]) {
    const edgeRow = top ? 0 : MAP_HEIGHT - 1;
    const innerRow = top ? 1 : MAP_HEIGHT - 2;
    for (let c = 0; c < MAP_WIDTH; c++) doc.set(c, edgeRow, { terrain: "iceOcean" });
    const edgeCols = shuffled(Array.from({ length: MAP_WIDTH }, (_, i) => i), rng);
    for (const c of edgeCols.slice(0, 6)) doc.set(c, edgeRow, { terrain: "ocean" });
    const innerCols = shuffled(Array.from({ length: MAP_WIDTH }, (_, i) => i), rng);
    for (const c of innerCols.slice(0, 2)) doc.set(c, innerRow, { terrain: "iceOcean" });
  }
}

/** Builds an entirely new map from scratch, following the exact step-by-step process the user
 * specified (verified against their hand-built "Вторая" reference map): ice geometry, then
 * continents/peninsulas/islands land placement (always landing on exactly 20 inhabited
 * regions), then a desert/mountain/hills recoloring pass, then forest/jungle, then resources. */
export function generateTerrain(doc: MapDoc, rng: () => number) {
  // 0) Wipe to a blank ocean map.
  for (let col = 0; col < MAP_WIDTH; col++)
    for (let row = 0; row < MAP_HEIGHT; row++) doc.set(col, row, { terrain: "ocean", resource: undefined, forest: false, neutralCity: false });

  // 1-2) Polar ice — fixed at exactly 40 tiles total, never touched again after this point.
  placeIce(doc, rng);

  const usedRegions = new Set<string>(); // "rc,rr" already claimed by a land-placement step

  // 3a) 5-6 large continents in the temperate/tropical zone — each fills its region, minus 0-3
  // random sea tiles so the coastline isn't a perfect rectangle every time.
  const continentCandidates = shuffled(
    Array.from({ length: REGION_GRID_W }, (_, rc) => NON_POLAR_ROWS.map((rr): Coord => [rc, rr])).flat(),
    rng
  );
  const continentCount = randInt(rng, 5, 6);
  const continentRegions = continentCandidates.slice(0, continentCount);
  for (const [rc, rr] of continentRegions) {
    const coords = regionCoords(rc, rr);
    const edgeCoords = regionEdgeCoords(rc, rr);
    const seaHoles = new Set(shuffled(edgeCoords, rng).slice(0, randInt(rng, 0, 3)).map(key));
    for (const c of coords) doc.set(c[0], c[1], { terrain: seaHoles.has(key(c)) ? "ocean" : "plains" });
    usedRegions.add(`${rc},${rr}`);
  }

  // 3b) 1-3 tundra continents per pole — every non-ice tile in the region becomes tundra (ice
  // tiles placed in step 1-2 are never repainted).
  for (const poleRow of POLE_ROWS) {
    const count = randInt(rng, 1, 3);
    const cols = shuffled(Array.from({ length: REGION_GRID_W }, (_, i) => i), rng).slice(0, count);
    for (const rc of cols) {
      for (const c of regionCoords(rc, poleRow)) {
        if (!isIce(doc, c)) doc.set(c[0], c[1], { terrain: "tundra" });
      }
      usedRegions.add(`${rc},${poleRow}`);
    }
  }

  // 4) 3-5 peninsulas: a "half sea, half land" region (always exactly 6 land tiles) attached to
  // an already-placed continent — either one connected clump of 6, or split into two clumps of 3.
  type PenCandidate = { rc: number; rr: number; dc: number; dr: number };
  const penCandidates: PenCandidate[] = [];
  for (const [rc, rr] of continentRegions) {
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const nc = rc + dc;
      const nr = rr + dr;
      if (nc < 0 || nc >= REGION_GRID_W || !NON_POLAR_ROWS.includes(nr)) continue;
      if (usedRegions.has(`${nc},${nr}`)) continue;
      penCandidates.push({ rc: nc, rr: nr, dc, dr });
    }
  }
  const peninsulaCount = Math.min(randInt(rng, 3, 5), penCandidates.length);
  const chosenPeninsulas = shuffled(penCandidates, rng).slice(0, peninsulaCount);
  for (const { rc, rr, dc, dr } of chosenPeninsulas) {
    if (usedRegions.has(`${rc},${rr}`)) continue; // could've been picked twice from different continents
    const coords = regionCoords(rc, rr);
    const edge = coords.filter(([c, r]) => {
      if (dc === 1) return c === rc * REGION_SIZE_X + REGION_SIZE_X - 1;
      if (dc === -1) return c === rc * REGION_SIZE_X;
      if (dr === 1) return r === rr * REGION_SIZE_Y + REGION_SIZE_Y - 1;
      return r === rr * REGION_SIZE_Y;
    });
    const land = rng() < 0.5 ? growPatches(coords, [3, 3], rng, edge) : growClump(coords, 6, rng, edge);
    for (const c of land) doc.set(c[0], c[1], { terrain: "plains" });
    usedRegions.add(`${rc},${rr}`);
  }

  // 5) 2-4 tundra island groups (5 hexes each), one empty polar region apiece, never on ice.
  const islandGroupCount = randInt(rng, 2, 4);
  const emptyPolarRegions = shuffled(
    Array.from({ length: REGION_GRID_W }, (_, rc) => POLE_ROWS.map((rr): Coord => [rc, rr]))
      .flat()
      .filter(([rc, rr]) => !usedRegions.has(`${rc},${rr}`) && regionLand(doc, rc, rr).length === 0),
    rng
  );
  for (const [rc, rr] of emptyPolarRegions.slice(0, islandGroupCount)) {
    const pool = regionCoords(rc, rr).filter((c) => !isIce(doc, c));
    for (const c of growClump(pool, 5, rng)) doc.set(c[0], c[1], { terrain: "tundra" });
    usedRegions.add(`${rc},${rr}`);
  }

  // 6) Count how many of the 20 inhabited (land >= 3) regions already exist; fill the rest with
  // 3-hex islands in still-completely-empty seas (tundra if polar, plains otherwise).
  const allRegions: Coord[] = [];
  for (let rc = 0; rc < REGION_GRID_W; rc++) for (let rr = 0; rr < REGION_GRID_H; rr++) allRegions.push([rc, rr]);

  const countInhabited = () => allRegions.filter(([rc, rr]) => regionLand(doc, rc, rr).length >= 3).length;
  let inhabited = countInhabited();
  const emptyRegions = shuffled(
    allRegions.filter(([rc, rr]) => !usedRegions.has(`${rc},${rr}`) && regionLand(doc, rc, rr).length === 0),
    rng
  );
  for (const [rc, rr] of emptyRegions) {
    if (inhabited >= 20) break;
    const isPolar = bandForRegionRow(rr).id.startsWith("polar");
    const pool = regionCoords(rc, rr).filter((c) => !isIce(doc, c));
    const edge = regionEdgeCoords(rc, rr).filter((c) => !isIce(doc, c));
    const clump = growPatches(pool, pickIslandShape(rng), rng, undefined, edge);
    if (clump.length === 0) continue;
    for (const c of clump) doc.set(c[0], c[1], { terrain: isPolar ? "tundra" : "plains" });
    usedRegions.add(`${rc},${rr}`);
    inhabited++;
  }

  // 7) Of the seas still completely empty, 2/3 get a single land tile pressed into the region
  // (never on ice) — the rest stay open water. Regions that are only ice still count here, but
  // never receive land on the ice tiles themselves.
  const stillEmpty = shuffled(
    allRegions.filter(([rc, rr]) => regionLand(doc, rc, rr).length === 0),
    rng
  );
  const singleFillCount = Math.floor((stillEmpty.length * 2) / 3);
  for (const [rc, rr] of stillEmpty.slice(0, singleFillCount)) {
    const isPolar = bandForRegionRow(rr).id.startsWith("polar");
    const edge = regionEdgeCoords(rc, rr).filter((c) => !isIce(doc, c));
    const pool = edge.length > 0 ? edge : regionCoords(rc, rr).filter((c) => !isIce(doc, c));
    if (pool.length === 0) continue;
    const [c, r] = pool[Math.floor(rng() * pool.length)];
    doc.set(c, r, { terrain: isPolar ? "tundra" : "plains" });
  }

  rebalanceBandMinimums(doc, rng);
  recolorTerrain(doc, rng);
  generateResources(doc, rng);
}

/** Every latitude band has resources that can *only* go there (spices/fruit tropical, grain
 * temperate, fur polar, etc.) — if random placement above left a band with too few inhabited
 * (land >= 3) regions, those resources have nowhere legal to go and the generator would either
 * come up short or (worse) have to break the climate rule. So: top up any band below the
 * minimum by converting an empty region there into a small island, paid for by demoting the
 * smallest inhabited region in whichever band currently has the most spare — total inhabited
 * region count (20) never changes, only its distribution across bands. */
function rebalanceBandMinimums(doc: MapDoc, rng: () => number) {
  const MIN_PER_BAND = 3;
  const allRegions: Coord[] = [];
  for (let rc = 0; rc < REGION_GRID_W; rc++) for (let rr = 0; rr < REGION_GRID_H; rr++) allRegions.push([rc, rr]);
  const inhabitedInRow = (rr: number) => allRegions.filter(([c, r]) => r === rr && regionLand(doc, c, r).length >= 3);
  // Promotable: anything short of "inhabited" — a clean empty sea (land 0) or an already-barren
  // sliver (land 1-2) that just needs topping up, whichever this band still has.
  const promotableInRow = (rr: number) => allRegions.filter(([c, r]) => r === rr && regionLand(doc, c, r).length < 3);

  let guard = 0;
  while (guard++ < 40) {
    const byRow = Array.from({ length: REGION_GRID_H }, (_, rr) => ({ rr, list: inhabitedInRow(rr) }));
    const deficient = byRow.find((b) => b.list.length < MIN_PER_BAND);
    if (!deficient) break;

    // Find somewhere to promote *before* touching a donor — never sink a good region for nothing.
    const rr = deficient.rr;
    const promoteCandidates = shuffled(promotableInRow(rr), rng);
    if (promoteCandidates.length === 0) break; // this band has no room to grow into at all — give up
    const [rc2, rr2] = promoteCandidates[0];
    const currentLand = regionLand(doc, rc2, rr2).length;
    const needed = 3 - currentLand;

    const donor = byRow.filter((b) => b.list.length > MIN_PER_BAND).sort((a, b) => b.list.length - a.list.length)[0];
    if (!donor) break; // nowhere left to borrow capacity from — leave the shortfall rather than loop forever
    const donorRegion = [...donor.list].sort((a, b) => regionLand(doc, a[0], a[1]).length - regionLand(doc, b[0], b[1]).length)[0];
    for (const c of regionCoords(donorRegion[0], donorRegion[1])) {
      if (!isIce(doc, c)) doc.set(c[0], c[1], { terrain: "ocean" });
    }

    const isPolar = bandForRegionRow(rr).id.startsWith("polar");
    const existingLand = new Set(regionLand(doc, rc2, rr2).map(key));
    const pool = regionCoords(rc2, rr2).filter((c) => !isIce(doc, c) && !existingLand.has(key(c)));
    const edge = regionEdgeCoords(rc2, rr2).filter((c) => !isIce(doc, c) && !existingLand.has(key(c)));
    for (const c of growPatches(pool, pickShapeForTotal(needed, rng), rng, undefined, edge)) {
      doc.set(c[0], c[1], { terrain: isPolar ? "tundra" : "plains" });
    }
  }
}

function allCoords(): Coord[] {
  const list: Coord[] = [];
  for (let c = 0; c < MAP_WIDTH; c++) for (let r = 0; r < MAP_HEIGHT; r++) list.push([c, r]);
  return list;
}

/** Recoloring pass, run once the land shape is final: carve desert patches out of tropical
 * plains, sprinkle mountains anywhere on land, add extra hills in the temperate/tropical zone,
 * then lay down the forest/jungle overlay counts. */
function recolorTerrain(doc: MapDoc, rng: () => number) {
  // 1a) Deserts: 2-3 tile patches seeded on tropical plains, until the total lands in [10, 20].
  const targetDesert = randInt(rng, 10, 20);
  let desertCount = 0;
  let guard = 0;
  while (desertCount < targetDesert && guard++ < 500) {
    const tropicalPlains = allCoords().filter(([c, r]) => {
      const rr = Math.floor(r / REGION_SIZE_Y);
      return TROPICAL_ROWS.includes(rr) && doc.get(c, r).terrain === "plains";
    });
    if (tropicalPlains.length === 0) break;
    const patch = growClump(tropicalPlains, Math.min(randInt(rng, 2, 3), targetDesert - desertCount), rng, [
      tropicalPlains[Math.floor(rng() * tropicalPlains.length)],
    ]);
    for (const [c, r] of patch) doc.set(c, r, { terrain: "desert" });
    desertCount += patch.length;
    if (patch.length === 0) break;
  }

  // 1b) Mountains: groups of 1-3 tiles recolored from any current land (except desert), any
  // latitude, until the total lands in [10, 20].
  const targetMountains = randInt(rng, 10, 20);
  let mountainCount = 0;
  guard = 0;
  while (mountainCount < targetMountains && guard++ < 500) {
    const landPool = allCoords().filter(([c, r]) => {
      const t = doc.get(c, r).terrain;
      return t === "plains" || t === "hills" || t === "tundra";
    });
    if (landPool.length === 0) break;
    const seed = landPool[Math.floor(rng() * landPool.length)];
    const patch = growClump(landPool, Math.min(randInt(rng, 1, 3), targetMountains - mountainCount), rng, [seed]);
    for (const [c, r] of patch) doc.set(c, r, { terrain: "mountains" });
    mountainCount += patch.length;
    if (patch.length === 0) break;
  }

  // 2) Hills: 20-30 tiles, temperate/tropical zone only (never in a polar band), from plains.
  const targetHills = randInt(rng, 20, 30);
  const hillCandidates = shuffled(
    allCoords().filter(([c, r]) => {
      const rr = Math.floor(r / REGION_SIZE_Y);
      return NON_POLAR_ROWS.includes(rr) && doc.get(c, r).terrain === "plains";
    }),
    rng
  );
  for (const [c, r] of hillCandidates.slice(0, targetHills)) doc.set(c, r, { terrain: "hills" });

  // 3) Forest/jungle overlay: 20 in the temperate zone (either hemisphere), 20 in the tropical
  // zone (either hemisphere), on plains/hills only.
  for (const rows of [
    [1, 4], // temperate-n, temperate-s
    TROPICAL_ROWS,
  ]) {
    const candidates = shuffled(
      allCoords().filter(([c, r]) => {
        const rr = Math.floor(r / REGION_SIZE_Y);
        if (!rows.includes(rr)) return false;
        const t = doc.get(c, r).terrain;
        return t === "plains" || t === "hills";
      }),
      rng
    );
    for (const [c, r] of candidates.slice(0, 20)) doc.set(c, r, { forest: true });
  }
}
