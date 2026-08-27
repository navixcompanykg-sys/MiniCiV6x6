import { MAP_WIDTH, MAP_HEIGHT, bandForRegionRow } from "./mapDoc";
import type { MapDoc } from "./mapDoc";
import { TERRAINS, RESOURCES } from "./types";
import type { TerrainId, ResourceId } from "./types";

export interface Counts {
  terrain: Record<TerrainId, number>;
  resource: Record<ResourceId, number>;
  neutralCities: number;
  totalTiles: number;
  /** Forest overlay tiles in temperate/polar bands. */
  forestCount: number;
  /** Forest overlay tiles in tropical bands (auto-relabeled as jungle). */
  jungleCount: number;
}

export function computeCounts(doc: MapDoc): Counts {
  const terrain = Object.fromEntries(TERRAINS.map((t) => [t.id, 0])) as Record<TerrainId, number>;
  const resource = Object.fromEntries(RESOURCES.map((r) => [r.id, 0])) as Record<ResourceId, number>;
  let neutralCities = 0;
  let forestCount = 0;
  let jungleCount = 0;

  for (let col = 0; col < MAP_WIDTH; col++) {
    for (let row = 0; row < MAP_HEIGHT; row++) {
      const tile = doc.get(col, row);
      terrain[tile.terrain]++;
      if (tile.resource) resource[tile.resource]++;
      if (tile.neutralCity) neutralCities++;
      if (tile.forest) {
        const band = bandForRegionRow(doc.regionRowOf(row));
        if (band.id.startsWith("tropical")) jungleCount++;
        else forestCount++;
      }
    }
  }

  return { terrain, resource, neutralCities, totalTiles: MAP_WIDTH * MAP_HEIGHT, forestCount, jungleCount };
}
