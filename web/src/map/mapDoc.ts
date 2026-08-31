import type { ResourceId, TerrainId } from "./types";
import { shuffleArray } from "./rand";

// Wider-than-tall map: latitude runs horizontally (east-west), longitude vertically (north-south).
// 24 hexes wide (along latitude), 18 tall (along longitude).
export const MAP_WIDTH = 24;
export const MAP_HEIGHT = 18;
export const REGION_SIZE_X = 4; // hexes per region, horizontal (along latitude)
export const REGION_SIZE_Y = 3; // hexes per region, vertical (along longitude)
export const REGION_GRID_W = MAP_WIDTH / REGION_SIZE_X; // 6
export const REGION_GRID_H = MAP_HEIGHT / REGION_SIZE_Y; // 6

export interface LatitudeBand {
  id: string;
  label: string;
  /** Inclusive region-row range within the 6x6 region grid. */
  regionRowStart: number;
  regionRowEnd: number;
  color: number;
  /** The mirrored band across the equator, if any — same climate, opposite hemisphere. */
  mirrorOf?: string;
}

// Default symmetric split (north -> south): Polar / Temperate / Tropical / Tropical / Temperate / Polar.
// Purely organizational for the editor (band separators + "swap within band") — the user places
// whatever terrain they want in each band.
export const LATITUDE_BANDS: LatitudeBand[] = [
  { id: "polar-n", label: "Полярный (С)", regionRowStart: 0, regionRowEnd: 0, color: 0x3a4a5a, mirrorOf: "polar-s" },
  { id: "temperate-n", label: "Умеренный (С)", regionRowStart: 1, regionRowEnd: 1, color: 0x2f5a3a, mirrorOf: "temperate-s" },
  { id: "tropical-n", label: "Тропический (С)", regionRowStart: 2, regionRowEnd: 2, color: 0x5a4a1f, mirrorOf: "tropical-s" },
  { id: "tropical-s", label: "Тропический (Ю)", regionRowStart: 3, regionRowEnd: 3, color: 0x5a4a1f, mirrorOf: "tropical-n" },
  { id: "temperate-s", label: "Умеренный (Ю)", regionRowStart: 4, regionRowEnd: 4, color: 0x2f5a3a, mirrorOf: "temperate-n" },
  { id: "polar-s", label: "Полярный (Ю)", regionRowStart: 5, regionRowEnd: 5, color: 0x3a4a5a, mirrorOf: "polar-n" },
];

export function bandForRegionRow(regionRow: number): LatitudeBand {
  return LATITUDE_BANDS.find((b) => regionRow >= b.regionRowStart && regionRow <= b.regionRowEnd)!;
}

export interface TileData {
  terrain: TerrainId;
  resource?: ResourceId;
  neutralCity?: boolean;
  /** Overlay, not a base terrain — only meaningful on Plains/Hills. Renders/counts as
   * "Лес" (Forest) or "Джунгли" (Jungle) automatically depending on the tile's latitude band. */
  forest?: boolean;
  /** "Тундра под льдом" — only meaningful on `terrain: "tundra"`. Real land (counts for inhabited
   * regions, can carry a resource, passable by units) but renders as ice and cannot hold a city
   * (game.html gates that separately) — used where the generator would otherwise have to skip a
   * polar ice tile entirely when laying down a tundra continent, see terrainGenerator.ts. Its
   * resource (if any) needs a technology to extract, same idea as Мореплавание/Горное дело. */
  iceCover?: boolean;
  /** «Извержение вулкана» (ТЗ §15.1) — оверлей по аналогии с `forest`, только на `terrain:
   * "mountains"`. Ресурс на тайле снят, тайл непроходим для юнитов (GameSession.unitPassable). */
  volcano?: boolean;
}

/** "Лес" in polar/temperate bands, "Джунгли" in tropical bands — derived from latitude, not chosen by hand. */
export function forestLabelForBand(band: LatitudeBand): "Лес" | "Джунгли" {
  return band.id.startsWith("tropical") ? "Джунгли" : "Лес";
}

export class MapDoc {
  tiles: TileData[][]; // [col][row]

  constructor() {
    this.tiles = [];
    for (let col = 0; col < MAP_WIDTH; col++) {
      const column: TileData[] = [];
      for (let row = 0; row < MAP_HEIGHT; row++) {
        column.push({ terrain: "ocean" });
      }
      this.tiles.push(column);
    }
  }

  get(col: number, row: number): TileData {
    return this.tiles[col][row];
  }

  set(col: number, row: number, data: Partial<TileData>) {
    this.tiles[col][row] = { ...this.tiles[col][row], ...data };
  }

  regionRowOf(row: number): number {
    return Math.floor(row / REGION_SIZE_Y);
  }
  regionColOf(col: number): number {
    return Math.floor(col / REGION_SIZE_X);
  }

  /**
   * Swaps the full contents of two regions (checked by caller: same band, or mirrored
   * bands across the equator). When `flip` is true (crossing hemispheres), each region's
   * rows are reversed within the block on the way over — a coast that faced the pole in
   * the south still faces the pole after landing in the mirrored northern band, instead
   * of ending up upside down relative to its new hemisphere.
   */
  swapRegions(regionColA: number, regionRowA: number, regionColB: number, regionRowB: number, flip = false) {
    const bufA: TileData[][] = [];
    const bufB: TileData[][] = [];
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      bufA.push([]);
      bufB.push([]);
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        bufA[dx].push(this.tiles[regionColA * REGION_SIZE_X + dx][regionRowA * REGION_SIZE_Y + dy]);
        bufB[dx].push(this.tiles[regionColB * REGION_SIZE_X + dx][regionRowB * REGION_SIZE_Y + dy]);
      }
    }
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const srcDy = flip ? REGION_SIZE_Y - 1 - dy : dy;
        this.tiles[regionColA * REGION_SIZE_X + dx][regionRowA * REGION_SIZE_Y + dy] = bufB[dx][srcDy];
        this.tiles[regionColB * REGION_SIZE_X + dx][regionRowB * REGION_SIZE_Y + dy] = bufA[dx][srcDy];
      }
    }
  }

  private extractRegionBlock(regionCol: number, regionRow: number): TileData[][] {
    const block: TileData[][] = [];
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      block.push([]);
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        block[dx].push(this.tiles[regionCol * REGION_SIZE_X + dx][regionRow * REGION_SIZE_Y + dy]);
      }
    }
    return block;
  }

  private writeRegionBlock(regionCol: number, regionRow: number, block: TileData[][], flip: boolean) {
    for (let dx = 0; dx < REGION_SIZE_X; dx++) {
      for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
        const srcDy = flip ? REGION_SIZE_Y - 1 - dy : dy;
        this.tiles[regionCol * REGION_SIZE_X + dx][regionRow * REGION_SIZE_Y + dy] = block[dx][srcDy];
      }
    }
  }

  /**
   * Shuffles region *positions* within each latitude constraint — three independent pools
   * (polar/temperate/tropical), each pool spanning both hemispheres of that climate so a
   * region can land either in its own band or the mirrored one across the equator (with the
   * same north/south flip swapRegions uses). Content travels with the region; this does not
   * touch resources — call a resource generator afterwards to reseed those.
   */
  shuffleAllRegions(rng: () => number) {
    const mirrorGroups: [string, string][] = [
      ["polar-n", "polar-s"],
      ["temperate-n", "temperate-s"],
      ["tropical-n", "tropical-s"],
    ];

    for (const [bandAId, bandBId] of mirrorGroups) {
      const bandA = LATITUDE_BANDS.find((b) => b.id === bandAId)!;
      const bandB = LATITUDE_BANDS.find((b) => b.id === bandBId)!;
      const positions: { rc: number; rr: number; bandId: string }[] = [];
      for (let rc = 0; rc < REGION_GRID_W; rc++) {
        positions.push({ rc, rr: bandA.regionRowStart, bandId: bandA.id });
        positions.push({ rc, rr: bandB.regionRowStart, bandId: bandB.id });
      }

      const blocks = positions.map((p) => ({ tiles: this.extractRegionBlock(p.rc, p.rr), fromBand: p.bandId }));
      shuffleArray(blocks, rng);

      positions.forEach((p, i) => {
        const block = blocks[i];
        this.writeRegionBlock(p.rc, p.rr, block.tiles, block.fromBand !== p.bandId);
      });
    }
  }

  toJSON(): string {
    return JSON.stringify({ width: MAP_WIDTH, height: MAP_HEIGHT, tiles: this.tiles }, null, 2);
  }

  static fromJSON(json: string): MapDoc {
    const doc = new MapDoc();
    const parsed = JSON.parse(json);
    if (parsed.tiles) doc.tiles = parsed.tiles;
    return doc;
  }
}
