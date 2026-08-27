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
