export interface Player {
  id: number;
  name: string;
  /** Marker/UI color, one per player. */
  color: number;
}

/** Testing with 3 for now; the format supports 2-6 (ТЗ: "от 2 до 6 игроков"). */
export const PLAYERS: Player[] = [
  { id: 0, name: "Игрок 1", color: 0xe74c3c },
  { id: 1, name: "Игрок 2", color: 0x3498db },
  { id: 2, name: "Игрок 3", color: 0x2ecc71 },
];

export type TokenValue = 1 | 2 | 3;
export const TOKEN_VALUES: TokenValue[] = [3, 2, 1];

export interface PlacedToken {
  playerId: number;
  value: TokenValue;
  regionCol: number;
  regionRow: number;
}

export interface CityResult {
  playerId: number;
  regionCol: number;
  regionRow: number;
  /** True if this region's top tier was tied and the winner was picked at random. */
  randomTiebreak: boolean;
}

function regionKey(col: number, row: number): string {
  return `${col},${row}`;
}

/**
 * Resolves starting-city placement from every player's 3 bid tokens (values 1-3, one token per
 * region per player).
 *
 * Priority tier by tier, 3 first then 2 then 1: in each region, if exactly one *still-active*
 * player holds the top token value present there, that player wins the region (founds a city)
 * and their other tokens are removed from play everywhere else — a player can only ever win one
 * region. A tie for the top value in a region (two players both bid 3 there, say) is left
 * unresolved during the tiered passes — a tied higher token still "blocks" any lower token in the
 * same region from ever winning it via the tier check, since a stronger-or-equal token is still
 * present. Whatever is still contested after all three tiers (including single-region ties that
 * never broke) is resolved by a random pick among that region's top tier.
 *
 * A player who never uniquely wins any of their 3 bids (all lost to stronger/tied bids) simply
 * doesn't get a starting city this pass.
 */
export function resolvePlacement(tokens: PlacedToken[], rng: () => number = Math.random): CityResult[] {
  const byRegion = new Map<string, PlacedToken[]>();
  for (const t of tokens) {
    const k = regionKey(t.regionCol, t.regionRow);
    if (!byRegion.has(k)) byRegion.set(k, []);
    byRegion.get(k)!.push(t);
  }

  const active = new Set(tokens.map((t) => t.playerId));
  const resolved = new Set<string>();
  const results: CityResult[] = [];

  for (const value of TOKEN_VALUES) {
    for (const [key, list] of byRegion) {
      if (resolved.has(key)) continue;
      const activeHere = list.filter((t) => active.has(t.playerId));
      if (activeHere.length === 0) continue;
      const maxVal = Math.max(...activeHere.map((t) => t.value));
      if (maxVal !== value) continue; // not this tier's turn yet (or already below the true max here)
      const top = activeHere.filter((t) => t.value === maxVal);
      if (top.length !== 1) continue; // tied — leave for the final random pass
      const winner = top[0];
      results.push({ playerId: winner.playerId, regionCol: winner.regionCol, regionRow: winner.regionRow, randomTiebreak: false });
      active.delete(winner.playerId);
      resolved.add(key);
    }
  }

  // Final pass: everything still contested (a tie all the way down) gets a random winner among
  // whichever tier is still on top there.
  for (const [key, list] of byRegion) {
    if (resolved.has(key)) continue;
    const activeHere = list.filter((t) => active.has(t.playerId));
    if (activeHere.length === 0) continue;
    const maxVal = Math.max(...activeHere.map((t) => t.value));
    const top = activeHere.filter((t) => t.value === maxVal);
    const winner = top[Math.floor(rng() * top.length)];
    results.push({ playerId: winner.playerId, regionCol: winner.regionCol, regionRow: winner.regionRow, randomTiebreak: top.length > 1 });
    active.delete(winner.playerId);
    resolved.add(key);
  }

  return results;
}
