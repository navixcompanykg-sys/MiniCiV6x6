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
import type { TokenValue, PlacedToken, CityResult } from "./placement";

const HAND_SIZE = 7; // ТЗ 2.3 — максимум в руке
const ACTIONS_PER_TURN = 3;
const CARDS_DEALT_PER_TURN = 2;

type Phase = "placement" | "resolve-ready" | "playing";
let phase: Phase = "placement";
let currentPlayerIndex = 0;

// --- Placement (starting-city bidding) state ---
const placedTokens: PlacedToken[] = [];
let selectedTokenValue: TokenValue | null = null;
let cityResults: CityResult[] = [];

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
    const usedCount = placedTokens.filter((t) => t.playerId === player.id).length;
    if (usedCount < 3) {
      setHint(
        selectedTokenValue
          ? `${player.name}: выберите обитаемый регион на карте, чтобы поставить туда жетон ${selectedTokenValue}.`
          : `${player.name}: выберите жетон (3, 2 или 1), затем кликните обитаемый регион на карте.`
      );
    } else {
      setHint(`${player.name}: все 3 жетона расставлены — нажмите «Завершить ход».`);
    }
  } else if (phase === "resolve-ready") {
    setHint("Все игроки разместили жетоны — нажмите «Определить города».");
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
    const usedValues = new Set(placedTokens.filter((t) => t.playerId === player.id).map((t) => t.value));
    const allPlaced = usedValues.size === 3;
    bar.className = "bottom-bar placement-mode";
    bar.innerHTML = `
      <div class="placement-panel">
        <div class="player-indicator" style="color:#${player.color.toString(16).padStart(6, "0")}">${player.name}</div>
        <div class="token-buttons" id="token-buttons"></div>
      </div>
      <button class="end-turn-btn" id="end-turn-btn" ${allPlaced ? "" : "disabled"}><span class="icon">⏭</span>Завершить ход</button>
    `;
    const tokenButtonsEl = document.querySelector<HTMLDivElement>("#token-buttons")!;
    for (const v of TOKEN_VALUES) {
      const btn = document.createElement("button");
      btn.className = "token-btn";
      btn.textContent = String(v);
      btn.style.borderColor = "#" + player.color.toString(16).padStart(6, "0");
      if (usedValues.has(v)) btn.classList.add("used");
      if (selectedTokenValue === v) btn.classList.add("selected");
      btn.disabled = usedValues.has(v);
      btn.addEventListener("click", () => {
        selectedTokenValue = selectedTokenValue === v ? null : v;
        renderBottomBar();
        updateHint();
      });
      tokenButtonsEl.appendChild(btn);
    }
    document.querySelector("#end-turn-btn")!.addEventListener("click", onPlacementEndTurn);
  } else if (phase === "resolve-ready") {
    bar.className = "bottom-bar placement-mode";
    bar.innerHTML = `
      <div class="placement-panel">
        <div class="player-indicator">Расстановка завершена</div>
      </div>
      <button class="end-turn-btn" id="resolve-btn"><span class="icon">🏙</span>Определить города</button>
    `;
    document.querySelector("#resolve-btn")!.addEventListener("click", onResolvePlacement);
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

// The average of all 12 tile centers in a region doesn't land on any actual hex (the grid is
// staggered by column parity), which reads as "floating" between tiles. Use one real tile's
// exact center instead — local (1,1) is the closest a 4x3 region gets to a middle hex.
function regionCenterPixel(rc: number, rr: number): { x: number; y: number } {
  return hexToPixel(rc * REGION_SIZE_X + 1, rr * REGION_SIZE_Y + 1, HEX_SIZE);
}

function tryPlaceToken(rc: number, rr: number) {
  if (selectedTokenValue === null) return;
  const player = PLAYERS[currentPlayerIndex];
  if (!isInhabitedRegion(rc, rr)) {
    setHint("Города можно основать только в обитаемом регионе (суши ≥ 3 тайлов) — попробуйте другой регион.");
    return;
  }
  if (placedTokens.some((t) => t.playerId === player.id && t.regionCol === rc && t.regionRow === rr)) {
    setHint("В этом регионе у вас уже есть жетон — только 1 жетон на регион.");
    return;
  }
  placedTokens.push({ playerId: player.id, value: selectedTokenValue, regionCol: rc, regionRow: rr });
  selectedTokenValue = null;
  renderBottomBar();
  drawPlacementMarkers();
  updateHint();
}

function onPlacementEndTurn() {
  currentPlayerIndex++;
  if (currentPlayerIndex >= PLAYERS.length) {
    currentPlayerIndex = PLAYERS.length - 1; // stays on last player's marker context until resolve
    phase = "resolve-ready";
  }
  renderBottomBar();
  updateHint();
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
    const k = `${t.regionCol},${t.regionRow}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(t);
  }
  for (const [, tokens] of grouped) {
    const center = regionCenterPixel(tokens[0].regionCol, tokens[0].regionRow);
    tokens.forEach((t, i) => {
      const offsetX = (i - (tokens.length - 1) / 2) * 22;
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
    const center = regionCenterPixel(result.regionCol, result.regionRow);
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
  if (phase !== "placement" || selectedTokenValue === null) return;
  const rect = pixiApp.canvas.getBoundingClientRect();
  const canvasX = (e.clientX - rect.left) * (pixiApp.canvas.width / rect.width);
  const canvasY = (e.clientY - rect.top) * (pixiApp.canvas.height / rect.height);
  const local = renderer.toLocal(canvasX, canvasY);
  const hit = pixelToHex(local.x, local.y, HEX_SIZE, MAP_WIDTH, MAP_HEIGHT);
  if (!hit) return;
  tryPlaceToken(Math.floor(hit.col / REGION_SIZE_X), Math.floor(hit.row / REGION_SIZE_Y));
});

renderBottomBar();
updateHint();

// @ts-ignore debug hook
window.__debug = { pixiApp, doc, renderer, deck, hands, placedTokens, cityResults, renderBottomBar, updateHint, onResolvePlacement };
