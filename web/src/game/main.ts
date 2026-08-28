import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { MapDoc, MAP_WIDTH, MAP_HEIGHT, REGION_SIZE_X, REGION_SIZE_Y } from "../map/mapDoc";
import { MapRenderer, HEX_SIZE } from "../map/renderer";
import { generateTerrain } from "../map/terrainGenerator";
import { mulberry32 } from "../map/rand";
import { hexToPixel } from "../map/hexMath";
import { pixelToHex } from "../map/hexMath";
import { freshDeck, shuffle } from "./cards";
import type { CardDef } from "./cards";
import { PLAYERS, TOKEN_VALUES, resolvePlacement } from "./placement";
import type { PlacedToken, CityResult } from "./placement";

const HAND_SIZE = 7; // ТЗ 2.3 — максимум в руке
const ACTIONS_PER_TURN = 3;
const CARDS_DEALT_PER_TURN = 2;

type Phase = "placement" | "playing";
let phase: Phase = "placement";
let currentPlayerIndex = 0;

// --- Placement (starting-city bidding) state ---
const placedTokens: PlacedToken[] = [];
let cityResults: CityResult[] = [];

/** No manual token selection — each click places whichever value comes next for this player:
 * 3 first, then 2, then 1 (ТЗ order), reading straight off how many they've placed so far. */
function nextTokenValueFor(playerId: number) {
  const count = placedTokens.filter((t) => t.playerId === playerId).length;
  return count < 3 ? TOKEN_VALUES[count] : null;
}

// --- Playing-phase state (per player; deck is shared) ---
let deck: CardDef[] = shuffle(freshDeck());
const hands: Record<number, CardDef[]> = {};
const actionsLeft: Record<number, number> = {};
for (const p of PLAYERS) {
  hands[p.id] = [];
  actionsLeft[p.id] = ACTIONS_PER_TURN;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="table">
    <div class="map-area">
      <div class="deck-pile" id="deck-pile">
        <div class="deck-card"></div>
        <div class="deck-card"></div>
        <div class="deck-card deck-card-top">
          <span id="deck-count"></span>
        </div>
      </div>
      <div id="pixi-container"></div>
    </div>
    <div class="hint-bar" id="hint-bar"></div>
    <div class="bottom-bar" id="bottom-bar"></div>
  </div>
`;

function setHint(text: string) {
  document.querySelector<HTMLDivElement>("#hint-bar")!.textContent = text;
}

function updateHint() {
  const player = PLAYERS[currentPlayerIndex];
  if (phase === "placement") {
    const value = nextTokenValueFor(player.id);
    setHint(`${player.name}: кликните обитаемый регион на карте — туда встанет жетон ${value}.`);
  } else {
    setHint(`${player.name}: сыграйте карту (действий осталось: ${actionsLeft[player.id]}) или завершите ход.`);
  }
}

// --- Bottom bar: phase-dependent content ---

function renderBottomBar() {
  const bar = document.querySelector<HTMLDivElement>("#bottom-bar")!;
  updateDeckCount();
  if (phase === "placement") {
    const player = PLAYERS[currentPlayerIndex];
    const value = nextTokenValueFor(player.id);
    bar.className = "bottom-bar placement-mode";
    bar.innerHTML = `
      <div class="placement-panel">
        <div class="player-indicator" style="color:#${player.color.toString(16).padStart(6, "0")}">${player.name}</div>
        <div class="next-token-badge">Следующий жетон: <b style="color:#${player.color.toString(16).padStart(6, "0")}">${value}</b></div>
      </div>
    `;
  } else {
    bar.className = "bottom-bar";
    bar.innerHTML = `
      <div class="action-counter">
        <div class="label">Действия</div>
        <div class="pips" id="action-pips"></div>
      </div>
      <div class="card-slots" id="card-slots"></div>
      <button class="end-turn-btn" id="end-turn-btn"><span class="icon">⏭</span>Завершить ход</button>
    `;
    buildHandSlotEls();
    renderHand();
    renderActionPips();
    document.querySelector("#end-turn-btn")!.addEventListener("click", onPlayingEndTurn);
  }
}

// --- Placement phase logic ---

function isInhabitedRegion(rc: number, rr: number): boolean {
  let land = 0;
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      const t = doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).terrain;
      if (t !== "ocean" && t !== "iceOcean") land++;
    }
  }
  return land >= 3;
}

function isLandTile(col: number, row: number): boolean {
  const t = doc.get(col, row).terrain;
  return t !== "ocean" && t !== "iceOcean";
}

/** A city (and its bidding token) can never sit on sea or ice. If the clicked tile itself is
 * land, use it exactly — that's what makes the marker land where the player actually clicked
 * instead of some unrelated "region center" tile. Only when they click a water/ice tile inside
 * an otherwise-inhabited region do we fall back to the nearest land tile in that region. */
function landTileForClick(rc: number, rr: number, clickCol: number, clickRow: number): { col: number; row: number } {
  if (isLandTile(clickCol, clickRow)) return { col: clickCol, row: clickRow };
  const clickPixel = hexToPixel(clickCol, clickRow, HEX_SIZE);
  let best = { col: clickCol, row: clickRow };
  let bestDist = Infinity;
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      const c = rc * REGION_SIZE_X + dx;
      const r = rr * REGION_SIZE_Y + dy;
      if (!isLandTile(c, r)) continue;
      const p = hexToPixel(c, r, HEX_SIZE);
      const d = (p.x - clickPixel.x) ** 2 + (p.y - clickPixel.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { col: c, row: r };
      }
    }
  }
  return best;
}

function tryPlaceToken(clickCol: number, clickRow: number) {
  const player = PLAYERS[currentPlayerIndex];
  const value = nextTokenValueFor(player.id);
  if (value === null) return;
  const rc = Math.floor(clickCol / REGION_SIZE_X);
  const rr = Math.floor(clickRow / REGION_SIZE_Y);
  if (!isInhabitedRegion(rc, rr)) {
    setHint("Города можно основать только в обитаемом регионе (суши ≥ 3 тайлов) — попробуйте другой регион.");
    return;
  }
  if (placedTokens.some((t) => t.playerId === player.id && t.regionCol === rc && t.regionRow === rr)) {
    setHint("В этом регионе у вас уже есть жетон — только 1 жетон на регион.");
    return;
  }
  const { col, row } = landTileForClick(rc, rr, clickCol, clickRow);
  placedTokens.push({ playerId: player.id, value, regionCol: rc, regionRow: rr, col, row });
  drawPlacementMarkers();

  if (nextTokenValueFor(player.id) !== null) {
    updateHint();
    renderBottomBar();
    return;
  }
  // That was this player's 3rd token — their turn ends automatically, no button needed.
  currentPlayerIndex++;
  if (currentPlayerIndex >= PLAYERS.length) {
    onResolvePlacement(); // everyone's done — resolve immediately, no extra click needed either
  } else {
    renderBottomBar();
    updateHint();
  }
}

function onResolvePlacement() {
  cityResults = resolvePlacement(placedTokens);
  drawCityMarkers();

  // ТЗ: once every starting city (level 1) is founded, every player draws 2 cards.
  for (const p of PLAYERS) {
    for (let i = 0; i < CARDS_DEALT_PER_TURN && hands[p.id].length < HAND_SIZE; i++) {
      const card = deck.shift();
      if (!card) break;
      hands[p.id].push(card);
    }
  }

  phase = "playing";
  currentPlayerIndex = 0;
  renderBottomBar();
  updateHint();
}

// --- Map overlay markers (tokens during placement, cities once resolved) ---

const markerOverlay = new Container();

function drawPlacementMarkers() {
  markerOverlay.removeChildren();
  const grouped = new Map<string, PlacedToken[]>();
  for (const t of placedTokens) {
    const k = `${t.col},${t.row}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(t);
  }
  for (const [, tokens] of grouped) {
    const center = hexToPixel(tokens[0].col, tokens[0].row, HEX_SIZE);
    tokens.forEach((t, i) => {
      const offsetX = (i - (tokens.length - 1) / 2) * 16;
      const player = PLAYERS[t.playerId];
      const g = new Graphics().circle(center.x + offsetX, center.y, 10).fill({ color: player.color }).circle(center.x + offsetX, center.y, 10).stroke({ width: 2, color: 0x111111 });
      markerOverlay.addChild(g);
      const label = new Text({
        text: String(t.value),
        style: new TextStyle({ fontSize: 12, fontWeight: "bold", fill: 0x111111, fontFamily: "sans-serif" }),
      });
      label.anchor.set(0.5);
      label.position.set(center.x + offsetX, center.y + 1);
      markerOverlay.addChild(label);
    });
  }
}

function drawCityMarkers() {
  markerOverlay.removeChildren();
  for (const result of cityResults) {
    const center = hexToPixel(result.col, result.row, HEX_SIZE);
    const player = PLAYERS[result.playerId];
    const g = new Graphics()
      .circle(center.x, center.y, 14)
      .fill({ color: 0xffffff })
      .circle(center.x, center.y, 14)
      .stroke({ width: 3, color: player.color });
    markerOverlay.addChild(g);
    const label = new Text({
      text: "🏙",
      style: new TextStyle({ fontSize: 16, fontFamily: "sans-serif" }),
    });
    label.anchor.set(0.5);
    label.position.set(center.x, center.y);
    markerOverlay.addChild(label);
  }
}

// --- Hand / deck (playing phase) ---

const cardSlotsEl = () => document.querySelector<HTMLDivElement>("#card-slots")!;
let slotEls: HTMLDivElement[] = [];

function buildHandSlotEls() {
  const container = cardSlotsEl();
  slotEls = [];
  for (let i = 0; i < HAND_SIZE; i++) {
    const slot = document.createElement("div");
    slot.className = "card-slot";
    slot.addEventListener("click", () => playCard(i));
    container.appendChild(slot);
    slotEls.push(slot);
  }
}

// Slots show which type of card sits there (action vs event) but not its name — the exact
// hand a player ends up with is random and not something to spell out yet at this layout stage.
function renderHand() {
  const hand = hands[currentPlayerIndex];
  const left = actionsLeft[currentPlayerIndex];
  slotEls.forEach((el, i) => {
    const card = hand[i];
    el.classList.toggle("empty", !card);
    el.classList.toggle("event", card?.kind === "event");
    el.classList.toggle("playable", !!card && left > 0);
    el.innerHTML = card ? `<div class="card-icon">${card.kind === "event" ? "⚡" : "🂠"}</div>` : "";
  });
}

function updateDeckCount() {
  document.querySelector<HTMLSpanElement>("#deck-count")!.textContent = String(deck.length);
}

function playCard(slotIndex: number) {
  const hand = hands[currentPlayerIndex];
  const card = hand[slotIndex];
  if (!card || actionsLeft[currentPlayerIndex] <= 0) return;
  deck.push(card); // played cards go to the bottom of the deck, never a separate discard pile
  hand.splice(slotIndex, 1); // remove it — everything after shifts left, no gap left behind
  actionsLeft[currentPlayerIndex]--;
  renderHand();
  renderActionPips();
  updateHint();
}

function renderActionPips() {
  const pipsEl = document.querySelector<HTMLDivElement>("#action-pips")!;
  pipsEl.innerHTML = "";
  const left = actionsLeft[currentPlayerIndex];
  for (let i = 0; i < ACTIONS_PER_TURN; i++) {
    const pip = document.createElement("div");
    pip.className = "pip" + (i < left ? " filled" : "");
    pipsEl.appendChild(pip);
  }
}

function onPlayingEndTurn() {
  const hand = hands[currentPlayerIndex];
  for (let dealt = 0; dealt < CARDS_DEALT_PER_TURN && hand.length < HAND_SIZE; dealt++) {
    const next = deck.shift();
    if (!next) break; // deck empty — nothing left to deal
    hand.push(next);
  }
  actionsLeft[currentPlayerIndex] = ACTIONS_PER_TURN;
  currentPlayerIndex = (currentPlayerIndex + 1) % PLAYERS.length;
  renderHand();
  renderActionPips();
  updateHint();
}

// --- Map: always centered in the space above the hint/bottom bar, scaled to fit. ---
const mapArea = document.querySelector<HTMLDivElement>(".map-area")!;
const pixiContainer = document.querySelector<HTMLDivElement>("#pixi-container")!;

// No latitude-label margin here (client hides them), so the left padding is much smaller than
// the editor's — just enough for the region grid line stroke width.
const mapContentWidth = MAP_WIDTH * HEX_SIZE * 1.5 + HEX_SIZE * 2 + 30;
const mapContentHeight = MAP_HEIGHT * Math.sqrt(3) * HEX_SIZE + HEX_SIZE * 3 + 40;

const pixiApp = new Application();
await pixiApp.init({ width: mapContentWidth, height: mapContentHeight, background: 0x0b0e13, antialias: true });
pixiContainer.appendChild(pixiApp.canvas);

const doc = new MapDoc();
generateTerrain(doc, mulberry32(Date.now() ^ (Math.random() * 0xffffffff)));

const renderer = new MapRenderer(pixiApp, false); // no band labels in the game client
renderer.drawAll(doc);
renderer.root.addChild(markerOverlay);

function fitMapToArea() {
  const scale = Math.min(mapArea.clientWidth / mapContentWidth, mapArea.clientHeight / mapContentHeight, 1.5);
  pixiApp.canvas.style.width = mapContentWidth * scale + "px";
  pixiApp.canvas.style.height = mapContentHeight * scale + "px";
}
fitMapToArea();
window.addEventListener("resize", fitMapToArea);

pixiApp.canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  if (phase !== "placement") return;
  const rect = pixiApp.canvas.getBoundingClientRect();
  const canvasX = (e.clientX - rect.left) * (pixiApp.canvas.width / rect.width);
  const canvasY = (e.clientY - rect.top) * (pixiApp.canvas.height / rect.height);
  const local = renderer.toLocal(canvasX, canvasY);
  const hit = pixelToHex(local.x, local.y, HEX_SIZE, MAP_WIDTH, MAP_HEIGHT);
  if (!hit) return;
  tryPlaceToken(hit.col, hit.row);
});

renderBottomBar();
updateHint();

// @ts-ignore debug hook
window.__debug = { pixiApp, doc, renderer, deck, hands, placedTokens, cityResults, renderBottomBar, updateHint, onResolvePlacement };
