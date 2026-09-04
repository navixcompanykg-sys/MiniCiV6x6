export interface Player {
  id: number;
  name: string;
  /** Marker/UI color, one per player. */
  color: number;
  /** Ходит автоматически через простой эвристический бот (web/server/src/bot.ts), а не через
   * реального человека за общим экраном — по прямому запросу «Сделай простого AI который играет
   * карты». */
  isAI?: boolean;
}

const DEFAULT_PLAYERS: Player[] = [
  { id: 0, name: "Игрок 1", color: 0xe74c3c },
  { id: 1, name: "Игрок 2", color: 0x3498db },
  { id: 2, name: "Игрок 3", color: 0x2ecc71 },
];

/** Setup screen (`start.html`, "За одним компьютером") writes its choice here before navigating
 * to game.html — 2 to 6 players, каждый со своим ником и цветом (ТЗ: "от 2 до 6 игроков"). No
 * saved setup (direct game.html access, e.g. for testing) falls back to the old 3-player default. */
function loadPlayersFromSetup(): Player[] {
  try {
    // Этот модуль теперь импортируется и сервером (web/server) — там sessionStorage не существует
    // вообще (не браузер); сервер сам передаёт список игроков явно при создании GameSession и
    // никогда не трогает PLAYERS/loadPlayersFromSetup, но модуль обязан безопасно загружаться.
    if (typeof sessionStorage === "undefined") return DEFAULT_PLAYERS;
    const raw = sessionStorage.getItem("civ-setup");
    if (!raw) return DEFAULT_PLAYERS;
    const parsed = JSON.parse(raw) as { players?: { name: string; color: number }[] };
    if (!parsed.players || parsed.players.length < 2 || parsed.players.length > 6) return DEFAULT_PLAYERS;
    return parsed.players.map((p, i) => ({ id: i, name: (p.name || "").trim() || `Игрок ${i + 1}`, color: p.color }));
  } catch {
    return DEFAULT_PLAYERS;
  }
}

export const PLAYERS: Player[] = loadPlayersFromSetup();

export type TokenValue = 1 | 2 | 3;
export const TOKEN_VALUES: TokenValue[] = [3, 2, 1];

export interface PlacedToken {
  playerId: number;
  value: TokenValue;
  regionCol: number;
  regionRow: number;
  /** The exact land tile within the region this token sits on — where the marker/city renders. */
  col: number;
  row: number;
}

export interface CityResult {
  playerId: number;
  regionCol: number;
  regionRow: number;
  col: number;
  row: number;
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
      results.push({ playerId: winner.playerId, regionCol: winner.regionCol, regionRow: winner.regionRow, col: winner.col, row: winner.row, randomTiebreak: false });
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
    results.push({ playerId: winner.playerId, regionCol: winner.regionCol, regionRow: winner.regionRow, col: winner.col, row: winner.row, randomTiebreak: top.length > 1 });
    active.delete(winner.playerId);
    resolved.add(key);
  }

  return results;
}
