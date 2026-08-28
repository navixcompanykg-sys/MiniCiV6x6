import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { MAP_WIDTH, MAP_HEIGHT, REGION_SIZE_X, REGION_SIZE_Y, REGION_GRID_W, REGION_GRID_H, LATITUDE_BANDS, bandForRegionRow } from "./mapDoc";
import type { MapDoc } from "./mapDoc";
import { hexToPixel, hexCorner } from "./hexMath";
import { TERRAIN_BY_ID, RESOURCE_BY_ID } from "./types";

export const HEX_SIZE = 18;

const FOREST_COLOR = 0x2f6b2f;
const JUNGLE_COLOR = 0x1f8f3f;

export class MapRenderer {
  app: Application;
  root = new Container();
  hexLayer = new Graphics();
  gridLayer = new Graphics();
  markerLayer = new Container();
  highlightLayer = new Graphics();
  labelLayer = new Container();

  showBandLabels: boolean;

  constructor(app: Application, showBandLabels = true) {
    this.app = app;
    this.showBandLabels = showBandLabels;
    this.root.addChild(this.hexLayer, this.gridLayer, this.markerLayer, this.highlightLayer, this.labelLayer);
    this.app.stage.addChild(this.root);
    // leave room on the left for latitude band labels, unless the caller doesn't want them
    this.root.position.set(showBandLabels ? 90 : 20, 20);
  }

  drawAll(doc: MapDoc) {
    this.hexLayer.clear();
    this.markerLayer.removeChildren();
    this.labelLayer.removeChildren();

    for (let col = 0; col < MAP_WIDTH; col++) {
      for (let row = 0; row < MAP_HEIGHT; row++) {
        const tile = doc.get(col, row);
        const center = hexToPixel(col, row, HEX_SIZE);
        const terrain = TERRAIN_BY_ID[tile.terrain];

        this.hexLayer.poly(this.hexPoints(center, HEX_SIZE * 0.96)).fill({ color: terrain.color });

        if (tile.forest) {
          const band = bandForRegionRow(doc.regionRowOf(row));
          const isJungle = band.id.startsWith("tropical");
          this.drawForestPatch(center, col, row, isJungle ? JUNGLE_COLOR : FOREST_COLOR);
        }

        this.hexLayer.poly(this.hexPoints(center, HEX_SIZE * 0.96)).stroke({ width: 1, color: 0x0a0a0a, alpha: 0.35 });

        const sharesTileWithCity = tile.resource && tile.neutralCity;
        if (tile.resource) {
          const def = RESOURCE_BY_ID[tile.resource];
          const offsetY = sharesTileWithCity ? HEX_SIZE * 0.36 : 0;
          const size = sharesTileWithCity ? HEX_SIZE * 0.24 : HEX_SIZE * 0.38;
          this.drawResourceMarker(center.x, center.y + offsetY, def.category, def.color, size, def.symbol);
        }
        if (tile.neutralCity) {
          const offsetY = sharesTileWithCity ? -HEX_SIZE * 0.22 : 0;
          const star = new Graphics()
            .circle(center.x, center.y + offsetY, HEX_SIZE * 0.32)
            .fill({ color: 0xffffff })
            .circle(center.x, center.y + offsetY, HEX_SIZE * 0.32)
            .stroke({ width: 1.5, color: 0x000000 });
          star.eventMode = "none";
          this.markerLayer.addChild(star);
        }
      }
    }

    this.drawGridAndBands();
  }

  /** A few deterministic (col,row-seeded) green blobs inside the hex, standing in for tree cover. */
  private drawForestPatch(center: { x: number; y: number }, col: number, row: number, color: number) {
    const rnd = mulberry32(col * 7919 + row * 104729);
    const blobCount = 3 + Math.floor(rnd() * 2); // 3-4 blobs
    for (let i = 0; i < blobCount; i++) {
      const angle = rnd() * Math.PI * 2;
      const dist = rnd() * HEX_SIZE * 0.45;
      const bx = center.x + Math.cos(angle) * dist;
      const by = center.y + Math.sin(angle) * dist;
      const r = HEX_SIZE * (0.18 + rnd() * 0.12);
      this.hexLayer.circle(bx, by, r).fill({ color, alpha: 0.85 });
    }
  }

  /** Bold, outlined, category-shaped icon so resources read clearly against any terrain color
   * (a plain gray dot for metal ore was nearly invisible on hills/mountains). */
  private drawResourceMarker(cx: number, cy: number, category: "food" | "strategic" | "trade", color: number, size: number, symbol: string) {
    const outline = { width: Math.max(1.5, size * 0.16), color: 0x111111 };
    const g = new Graphics();

    if (category === "food") {
      g.circle(cx, cy, size).fill({ color }).circle(cx, cy, size).stroke(outline);
    } else if (category === "strategic") {
      const pts = [cx, cy - size, cx + size, cy, cx, cy + size, cx - size, cy];
      g.poly(pts).fill({ color }).poly(pts).stroke(outline);
    } else {
      const pts: number[] = [];
      for (let i = 0; i < 3; i++) {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        pts.push(cx + size * Math.cos(angle), cy + size * Math.sin(angle));
      }
      g.poly(pts).fill({ color }).poly(pts).stroke(outline);
    }

    g.eventMode = "none";
    this.markerLayer.addChild(g);

    // Short legend code (like on a contour/resource map) so no two resources read the same —
    // color+shape alone weren't enough to tell e.g. metal ore and silicates apart.
    if (size >= HEX_SIZE * 0.22) {
      const textColor = isLightColor(color) ? 0x111111 : 0xffffff;
      const label = new Text({
        text: symbol,
        style: new TextStyle({ fontSize: Math.max(6, size * 0.85), fontWeight: "bold", fill: textColor, fontFamily: "sans-serif" }),
      });
      label.anchor.set(0.5);
      label.position.set(cx, cy + size * 0.05);
      label.eventMode = "none";
      this.markerLayer.addChild(label);
    }
  }

  private drawGridAndBands() {
    this.gridLayer.clear();

    // Region column boundaries: the right point/edges of a column's hexes are the exact
    // spot where three hexes meet (that column and its two column+1 neighbors), so tracing
    // that zigzag down the column is the true shared seam with the region to its right —
    // same idea as the row boundaries below, just running the other way.
    for (let rc = 0; rc <= REGION_GRID_W; rc++) {
      const col = rc * REGION_SIZE_X;
      const points = col === 0 ? this.leftEdgePoints(0) : this.rightEdgePoints(col - 1);
      this.strokeZigzag(points, 0xffffff, 2.5, 0.95);
    }

    // Region row boundaries: every one of these also happens to be a latitude-band boundary
    // (each band is exactly one region-row tall), so a single zigzag path serves both —
    // it follows the actual flat top/bottom edges of the hexes instead of cutting a straight
    // ruler-line across a grid whose rows are staggered every other column.
    for (let rr = 0; rr <= REGION_GRID_H; rr++) {
      const hexRow = rr * REGION_SIZE_Y;
      const points = hexRow === 0 ? this.topEdgePoints() : this.bottomEdgePoints(hexRow - 1);
      this.strokeZigzag(points, 0xffffff, 2.5, 0.95);
    }

    // Latitude labels on the left margin (map editor only — the game client hides these).
    if (!this.showBandLabels) return;
    const style = new TextStyle({ fill: 0xd0d0d0, fontSize: 11, fontFamily: "sans-serif" });
    for (const band of LATITUDE_BANDS) {
      const topY = hexToPixel(0, band.regionRowStart * REGION_SIZE_Y, HEX_SIZE).y - (HEX_SIZE * Math.sqrt(3)) / 2;
      const bottomRow = Math.min((band.regionRowEnd + 1) * REGION_SIZE_Y - 1, MAP_HEIGHT - 1);
      const bottomY = hexToPixel(0, bottomRow, HEX_SIZE).y + (HEX_SIZE * Math.sqrt(3)) / 2;

      const label = new Text({ text: band.label, style });
      label.position.set(-88, (topY + bottomY) / 2 - 6);
      this.labelLayer.addChild(label);
    }
  }

  /** Bottom corners (flat edge) of every hex in row `hexRow`, in column order — the boundary between hexRow and hexRow+1. */
  private bottomEdgePoints(hexRow: number): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = [];
    for (let col = 0; col < MAP_WIDTH; col++) {
      const center = hexToPixel(col, hexRow, HEX_SIZE);
      pts.push(hexCorner(center, HEX_SIZE, 2)); // 120°, bottom-left
      pts.push(hexCorner(center, HEX_SIZE, 1)); // 60°, bottom-right
    }
    return pts;
  }

  /** Top corners (flat edge) of every hex in row 0 — the map's top boundary. */
  private topEdgePoints(): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = [];
    for (let col = 0; col < MAP_WIDTH; col++) {
      const center = hexToPixel(col, 0, HEX_SIZE);
      pts.push(hexCorner(center, HEX_SIZE, 4)); // 240°, top-left
      pts.push(hexCorner(center, HEX_SIZE, 5)); // 300°, top-right
    }
    return pts;
  }

  /** Zigzag down the right side of column `col` (point → lower-right, repeating) — the shared seam with column+1. */
  private rightEdgePoints(col: number): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = [];
    for (let row = 0; row < MAP_HEIGHT; row++) {
      const center = hexToPixel(col, row, HEX_SIZE);
      if (row === 0) pts.push(hexCorner(center, HEX_SIZE, 5)); // 300°, upper-right
      pts.push(hexCorner(center, HEX_SIZE, 0)); // 0°, right point
      pts.push(hexCorner(center, HEX_SIZE, 1)); // 60°, lower-right
    }
    return pts;
  }

  /** Zigzag down the left side of column `col` — used only for the map's outer left edge. */
  private leftEdgePoints(col: number): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = [];
    for (let row = 0; row < MAP_HEIGHT; row++) {
      const center = hexToPixel(col, row, HEX_SIZE);
      if (row === 0) pts.push(hexCorner(center, HEX_SIZE, 4)); // 240°, upper-left
      pts.push(hexCorner(center, HEX_SIZE, 3)); // 180°, left point
      pts.push(hexCorner(center, HEX_SIZE, 2)); // 120°, lower-left
    }
    return pts;
  }

  private strokeZigzag(points: { x: number; y: number }[], color: number, width: number, alpha: number) {
    if (points.length === 0) return;
    this.gridLayer.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.gridLayer.lineTo(points[i].x, points[i].y);
    this.gridLayer.stroke({ width, color, alpha });
  }

  highlightRegion(regionCol: number | null, regionRow: number | null, color = 0xffffff) {
    this.highlightLayer.clear();
    if (regionCol === null || regionRow === null) return;
    const col0 = regionCol * REGION_SIZE_X;
    const row0 = regionRow * REGION_SIZE_Y;
    const topLeft = hexToPixel(col0, row0, HEX_SIZE);
    const bottomRight = hexToPixel(col0 + REGION_SIZE_X - 1, row0 + REGION_SIZE_Y - 1, HEX_SIZE);
    this.highlightLayer
      .rect(topLeft.x - HEX_SIZE, topLeft.y - HEX_SIZE, bottomRight.x - topLeft.x + HEX_SIZE * 2, bottomRight.y - topLeft.y + HEX_SIZE * 2)
      .stroke({ width: 3, color, alpha: 0.9 });
  }

  private hexPoints(center: { x: number; y: number }, size: number): number[] {
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const p = hexCorner(center, size, i);
      pts.push(p.x, p.y);
    }
    return pts;
  }

  toLocal(globalX: number, globalY: number): { x: number; y: number } {
    const p = this.root.toLocal({ x: globalX, y: globalY } as any);
    return { x: p.x, y: p.y };
  }
}

/** Perceived-brightness check so marker legend text picks a readable dark/light color automatically. */
export function isLightColor(color: number): boolean {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** Small deterministic PRNG so forest patch placement is stable across redraws instead of jittering. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
