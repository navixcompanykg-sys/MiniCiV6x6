import { Application } from "pixi.js";
import { MapDoc, MAP_WIDTH, MAP_HEIGHT } from "../map/mapDoc";
import { MapRenderer, HEX_SIZE } from "../map/renderer";
import { generateTerrain } from "../map/terrainGenerator";
import { mulberry32 } from "../map/rand";
import { freshDeck, shuffle } from "./cards";
import type { CardDef } from "./cards";

const HAND_SIZE = 7; // ТЗ 2.3 — максимум в руке
const ACTIONS_PER_TURN = 3;
const CARDS_DEALT_PER_TURN = 2;

let actionsLeft = ACTIONS_PER_TURN;
let deck: CardDef[] = shuffle(freshDeck()); // shuffled once, at game start
// Only the cards actually in hand — no null placeholders. Always packed left, in the order they
// were received: playing a card removes it (everything after shifts left), dealing appends new
// ones at the end. Empty slots only ever show up trailing on the right.
let hand: CardDef[] = [];

// Initial deal fills the hand completely so there's something to look at from turn one.
for (let i = 0; i < HAND_SIZE; i++) {
  const card = deck.shift();
  if (card) hand.push(card);
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
    <div class="bottom-bar">
      <div class="action-counter">
        <div class="label">Действия</div>
        <div class="pips" id="action-pips"></div>
      </div>
      <div class="card-slots" id="card-slots"></div>
      <button class="end-turn-btn" id="end-turn-btn"><span class="icon">⏭</span>Завершить ход</button>
    </div>
  </div>
`;

// --- Hand: 7 slots, each either empty or showing a real card from the deck. Clicking a card
// "plays" it — it goes to the bottom of the deck and the slot goes empty until the next turn's
// deal fills it back in (ТЗ: played cards return to the deck, cards cycle deck -> hand -> deck). ---
const cardSlotsEl = document.querySelector<HTMLDivElement>("#card-slots")!;
const slotEls: HTMLDivElement[] = [];
for (let i = 0; i < HAND_SIZE; i++) {
  const slot = document.createElement("div");
  slot.className = "card-slot";
  slot.addEventListener("click", () => playCard(i));
  cardSlotsEl.appendChild(slot);
  slotEls.push(slot);
}

// Slots show which type of card sits there (action vs event) but not its name — the exact
// hand a player ends up with is random and not something to spell out yet at this layout stage.
function renderHand() {
  slotEls.forEach((el, i) => {
    const card = hand[i];
    el.classList.toggle("empty", !card);
    el.classList.toggle("event", card?.kind === "event");
    el.classList.toggle("playable", !!card && actionsLeft > 0);
    el.innerHTML = card ? `<div class="card-icon">${card.kind === "event" ? "⚡" : "🂠"}</div>` : "";
  });
  document.querySelector<HTMLSpanElement>("#deck-count")!.textContent = String(deck.length);
}

function playCard(slotIndex: number) {
  const card = hand[slotIndex];
  if (!card || actionsLeft <= 0) return;
  deck.push(card); // played cards go to the bottom of the deck, never a separate discard pile
  hand.splice(slotIndex, 1); // remove it — everything after shifts left, no gap left behind
  actionsLeft--;
  renderHand();
  renderActionPips();
}

// --- Action-point pips ---
function renderActionPips() {
  const pipsEl = document.querySelector<HTMLDivElement>("#action-pips")!;
  pipsEl.innerHTML = "";
  for (let i = 0; i < ACTIONS_PER_TURN; i++) {
    const pip = document.createElement("div");
    pip.className = "pip" + (i < actionsLeft ? " filled" : "");
    pipsEl.appendChild(pip);
  }
}

document.querySelector("#end-turn-btn")!.addEventListener("click", () => {
  actionsLeft = ACTIONS_PER_TURN;
  for (let dealt = 0; dealt < CARDS_DEALT_PER_TURN && hand.length < HAND_SIZE; dealt++) {
    const next = deck.shift();
    if (!next) break; // deck empty — nothing left to deal
    hand.push(next);
  }
  renderHand();
  renderActionPips();
});

renderHand();
renderActionPips();

// --- Map: always centered in the space above the bottom bar, scaled to fit. ---
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

function fitMapToArea() {
  const scale = Math.min(mapArea.clientWidth / mapContentWidth, mapArea.clientHeight / mapContentHeight, 1.5);
  pixiApp.canvas.style.width = mapContentWidth * scale + "px";
  pixiApp.canvas.style.height = mapContentHeight * scale + "px";
}
fitMapToArea();
window.addEventListener("resize", fitMapToArea);

// @ts-ignore debug hook
window.__debug = { pixiApp, doc, renderer, deck, hand };
