const EVEN_COL_DIRS: [number, number][] = [
  [1, 0], [1, -1], [0, -1],
  [-1, -1], [-1, 0], [0, 1],
];
const ODD_COL_DIRS: [number, number][] = [
  [1, 1], [1, 0], [0, -1],
  [-1, 0], [-1, 1], [0, 1],
];

/** The (up to) 6 neighbors of a hex, offset coords, "odd-q" flat-top layout — not bounds-checked. */
export function hexNeighbors(col: number, row: number): [number, number][] {
  const dirs = (col & 1) === 0 ? EVEN_COL_DIRS : ODD_COL_DIRS;
  return dirs.map(([dx, dy]) => [col + dx, row + dy]);
}

function wrapCoord(v: number, size: number): number {
  return ((v % size) + size) % size;
}

/** Same up-to-6 neighbors as `hexNeighbors`, but wrapped onto a CYLINDER of `width` x `height` — "the
 * map is round only west-east": a unit walking off the right edge continues from the left (and vice
 * versa), by direct request (gameplay adjacency only — map generation deliberately keeps using the
 * unwrapped `hexNeighbors` above, unaffected). The row (north-south / latitude) axis is deliberately
 * NOT wrapped — by direct correction, wrapping through the poles/ice caps at the top and bottom edges
 * made no geographic sense (that would let a unit step off the north ice cap straight onto the south
 * one). Width must be even for hex offset-parity to stay consistent across the west-east seam (true
 * here — MAP_WIDTH is 24). Unlike before, this can return FEWER than 6 pairs — a hex on the very top
 * or bottom row simply has no neighbor across that missing row-direction — so callers must treat this
 * (like plain `hexNeighbors`) as a variable-length list, not a fixed 6. */
export function hexNeighborsWrapped(col: number, row: number, width: number, height: number): [number, number][] {
  return hexNeighbors(col, row)
    .filter(([, nr]) => nr >= 0 && nr < height)
    .map(([nc, nr]) => [wrapCoord(nc, width), nr]);
}

/** Flat-top hex, offset coordinates, "odd-q" layout (odd columns pushed down half a hex). */
export function hexToPixel(col: number, row: number, size: number): { x: number; y: number } {
  const horiz = size * 1.5;
  const height = Math.sqrt(3) * size;
  const x = horiz * col;
  const y = height * (row + 0.5 * (col & 1));
  return { x, y };
}

export function hexCorner(center: { x: number; y: number }, size: number, i: number): { x: number; y: number } {
  const angle = (Math.PI / 180) * (60 * i);
  return { x: center.x + size * Math.cos(angle), y: center.y + size * Math.sin(angle) };
}

/** Finds the hex under a world-space point, or null if none is close enough. */
export function pixelToHex(
  x: number,
  y: number,
  size: number,
  cols: number,
  rows: number
): { col: number; row: number } | null {
  const horiz = size * 1.5;
  const height = Math.sqrt(3) * size;
  const estCol = Math.round(x / horiz);

  let best: { col: number; row: number } | null = null;
  let bestDist = Infinity;
  for (let c = estCol - 1; c <= estCol + 1; c++) {
    if (c < 0 || c >= cols) continue;
    const estRow = Math.round(y / height - 0.5 * (c & 1));
    for (let r = estRow - 1; r <= estRow + 1; r++) {
      if (r < 0 || r >= rows) continue;
      const p = hexToPixel(c, r, size);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { col: c, row: r };
      }
    }
  }
  return bestDist <= size * size ? best : null;
}
