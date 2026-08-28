import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { MapDoc, MAP_WIDTH, MAP_HEIGHT, REGION_SIZE_X, REGION_SIZE_Y } from "../map/mapDoc";
import { RESOURCES } from "../map/types";
import type { ResourceId } from "../map/types";
import { MapRenderer, HEX_SIZE } from "../map/renderer";
import { generateTerrain } from "../map/terrainGenerator";
import { mulberry32 } from "../map/rand";
import { hexToPixel } from "../map/hexMath";
import { pixelToHex } from "../map/hexMath";
import { freshDeck, shuffle } from "./cards";
import type { CardDef } from "./cards";
import { PLAYERS, TOKEN_VALUES, resolvePlacement } from "./placement";
import type { PlacedToken, CityResult } from "./placement";
import { BUILDINGS, GROUPS, GROUP_META, buildingsIn, claimBuilding } from "./buildings";
import type { BuildingOwners } from "./buildings";
import {
  EPOCHS,
  BRANCHES,
  CATS,
  CAT_META,
  EPOCH_NAMES,
  EPOCH_RESEARCH_COST,
  TECH_TREE,
  techsAt,
  isBranchComplete,
  branchGaps,
} from "./techtree";

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

// Владение зданиями — общее на партию, не по игрокам: каждое здание достаётся ровно одному
// игроку, первому построившему его.
const buildingOwners: BuildingOwners = {};

// --- Playing-phase state (per player; deck is shared) ---
let deck: CardDef[] = shuffle(freshDeck());
const hands: Record<number, CardDef[]> = {};
const actionsLeft: Record<number, number> = {};
const money: Record<number, number> = {};
for (const p of PLAYERS) {
  hands[p.id] = [];
  actionsLeft[p.id] = ACTIONS_PER_TURN;
  money[p.id] = 0; // nothing produces money yet (no income system) — the market is the only source/sink
}

/** A card listed for sale by its owner, price 1-5, visible to every player until bought. Selling
 * doesn't cost an action (like the mandatory end-of-turn card handoff in ТЗ 2.3, it's a transfer,
 * not a play) — it removes the card from the seller's hand immediately. */
interface MarketListing {
  id: number;
  sellerId: number;
  card: CardDef;
  price: number;
}
const market: MarketListing[] = [];
let nextListingId = 1;

// Reference data for the two right-panel info buttons — no negotiation/selection system exists
// yet (no per-player diplomatic state, no paradigm slot), so these are read-only lookups pulled
// from Технологии.md's tables, not a functioning mechanic.
const DIPLOMACY_AGREEMENTS = [
  "Открытые границы — торговля и проход юнитов у связанных игроков (Письменность)",
  "Вассалитет — вассал не может воевать один, сюзерен получает часть дохода (Феодализм)",
  "Совместная оборона — союзники вступают в войну при нападении на одного (Кодекс законов)",
  "Торговый союз — участники не берут друг с друга пошлину за маршруты (Гильдии)",
  "Научное сотрудничество — общий уровень технологий (Книгопечатание)",
  "Союз — объединение в единую команду (Коммунизм)",
];
const GOVERNMENT_PARADIGMS = [
  "Монотеизм (Мистицизм, Э1)",
  "Монархия (Богословие, Э2)",
  "Парламентаризм (Экономика, Э3)",
  "Фашизм (Идеология, Э5)",
  "Демократия (Права человека, Э5)",
  "Коммунизм (Коммунизм, Э6)",
];

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="table">
    <div class="map-area">
      <div class="left-rail">
        <div class="tech-tree" id="tech-tree"></div>
        <div class="buildings-panel" id="buildings-bar"></div>
      </div>
      <div class="map-wrap"><div id="pixi-container"></div></div>
      <!-- Same fill-the-rail approach as .left-rail (ТЗ 11.4/11.5) — a real panel now, no longer
           a dummy spacer, so the map stays centred on the window while this side earns its keep. -->
      <div class="right-rail">
        <div class="action-buttons-row" id="action-buttons"></div>
        <div class="city-list" id="city-list"></div>
        <div class="warehouse-panel" id="warehouse-panel"></div>
      </div>
    </div>
    <div class="hint-bar" id="hint-bar"></div>
    <div class="bottom-bar" id="bottom-bar"></div>
    <div class="side-modal-backdrop" id="side-modal-backdrop"></div>
  </div>
`;

function setHint(text: string) {
  document.querySelector<HTMLDivElement>("#hint-bar")!.textContent = text;
}

// --- Tech tree: vertical, epoch 1 at the bottom, 4 branch columns. Just a visual audit tool for
// now (no research wired up yet). Branches are positional (ТЗ 4.2), not thematic — so what a node
// *means* is carried by its category colour/icon, not by which column it sits in. Nodes with no
// designed effect yet are drawn hollow, so gaps in any branch are immediately visible. ---
function renderTechTree() {
  const el = document.querySelector<HTMLDivElement>("#tech-tree")!;
  // DOM order stays 1..6; `.tech-rows` is `column-reverse`, which puts epoch 1 at the bottom.
  const rows = EPOCHS;

  const node = (t: (typeof TECH_TREE)[number]) => {
    const meta = CAT_META[t.cat];
    const cls = ["tech-node", t.hasEffect ? "" : "empty", t.unique ? "unique" : "", t.building ? "building" : ""]
      .filter(Boolean)
      .join(" ");
    // t.summary only says "Здание: X" — the building's own effect lives in buildings.ts, so pull
    // it in here too; otherwise the tooltip names a building without ever saying what it does.
    const bld = t.building ? BUILDINGS.find((b) => b.tech === t.name) : undefined;
    const bldLine = bld ? `\n🏛 ${bld.name}: ${bld.effect} (цена: ${bld.cost})` : "";
    const tip = `${t.name} ${t.tags}\n${t.hasEffect ? t.summary : "⚠ " + t.summary}${bldLine}\nЦена открытия: ${EPOCH_RESEARCH_COST[t.epoch]}\n— ${meta.label}${t.unique ? " · уникальная" : ""}`;
    return `<div class="${cls}" style="--cat: ${meta.color}" title="${tip.replace(/"/g, "&quot;")}"><span class="ico">${meta.icon}</span></div>`;
  };

  el.innerHTML = `
    <div class="tech-title">Дерево технологий</div>
    <div class="tech-branch-headers">
      <div class="tech-epoch-label"></div>
      ${BRANCHES.map((b) => {
        const gaps = branchGaps(b);
        return `<div class="tech-branch-header${isBranchComplete(b) ? " complete" : ""}" title="Ветка ${b + 1} — позиционная (механика лидерства), 12 технологий${gaps ? `, из них ${gaps} без эффекта` : ", все с эффектами"}">Ветка ${b + 1}${gaps ? `<i>${gaps}</i>` : ""}</div>`;
      }).join("")}
    </div>
    <div class="tech-rows">
      ${rows
        .map(
          (epoch) => `
        <div class="tech-row">
          <div class="tech-epoch-label" title="Эпоха ${epoch} — ${EPOCH_NAMES[epoch]}">${epoch}<i>${EPOCH_NAMES[epoch]}</i></div>
          ${BRANCHES.map(
            (branch) => `<div class="tech-branch-cell">${techsAt(epoch, branch).map(node).join("")}</div>`
          ).join("")}
        </div>`
        )
        .join("")}
    </div>
    <div class="tech-legend">
      ${CATS.map(
        (c) =>
          `<span class="sw" style="--cat: ${CAT_META[c].color}" title="${CAT_META[c].label}">${CAT_META[c].icon}</span>`
      ).join("")}
      <span class="sw hollow" title="Эффект ещё не задан"></span>
      <span class="sw ring" title="🔓 уникальная — только лидеру ветки">🔓</span>
    </div>
  `;
}

// --- Городская застройка: 16 зданий, 4 группы × 4. Здание достаётся только одному игроку за всю
// партию — кто первым построил, тот забрал, — поэтому владение глобальное (buildingOwners), а не
// в состоянии игрока. Постройка сейчас стоит 1 действие и не требует ресурсов: полноценная цена
// появится вместе с ресурсной экономикой. Здания без заданного эффекта показаны полыми. ---
function renderBuildings() {
  const el = document.querySelector<HTMLDivElement>("#buildings-bar")!;
  const canBuild = phase === "playing" && actionsLeft[PLAYERS[currentPlayerIndex].id] > 0;

  // Same 4×4 square-grid language as the tech tree: columns are the 4 groups, rows the 4 buildings
  // in each. Taken buildings fill with the owner's colour and show their number.
  const cell = (b: (typeof BUILDINGS)[number]) => {
    const owner = buildingOwners[b.id];
    const taken = owner !== undefined;
    const cls = [
      "bld",
      taken ? "taken" : "free",
      b.effect ? "" : "noeffect",
      b.victory ? "victory" : "",
      !taken && canBuild ? "buildable" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const src = b.tech ? `${b.tech}, Э${b.epoch}` : "без исследования";
    const status = taken
      ? `Построил: ${PLAYERS[owner].name} — здание занято, другим недоступно`
      : "Свободно — кто первым построил, тот забрал";
    const tip = `${b.name} (${src})\n${b.effect || "⚠ эффект не задан"}\nЦена: ${b.cost}\n${status}`;
    const pc = taken ? playerCss(owner) : GROUP_META[b.group].color;
    const face = taken ? `${owner + 1}` : "";
    return `<div class="${cls}" data-bld="${b.id}" style="--pc: ${pc}" title="${tip.replace(/"/g, "&quot;")}">${face}</div>`;
  };

  const rows = [0, 1, 2, 3];
  el.innerHTML = `
    <div class="tech-title">Городская застройка</div>
    <div class="bld-headers">
      ${GROUPS.map((g) => {
        const meta = GROUP_META[g];
        const taken = buildingsIn(g).filter((b) => buildingOwners[b.id] !== undefined).length;
        return `<div class="bld-header" style="--cat: ${meta.color}" title="${meta.label} — занято ${taken} из 4">${meta.icon}</div>`;
      }).join("")}
    </div>
    <div class="bld-rows">
      ${rows
        .map((i) => `<div class="bld-row">${GROUPS.map((g) => cell(buildingsIn(g)[i])).join("")}</div>`)
        .join("")}
    </div>
    <div class="bld-note">Одно здание — один игрок: кто первым построил, тот забрал</div>
  `;
}

/** CSS-цвет игрока из его 0xRRGGBB. */
function playerCss(playerId: number): string {
  return "#" + PLAYERS[playerId].color.toString(16).padStart(6, "0");
}

function onBuildingClick(id: string) {
  if (phase !== "playing") return;
  const player = PLAYERS[currentPlayerIndex];
  if (actionsLeft[player.id] <= 0) return;
  // Первый застройщик забирает здание навсегда; повторная попытка просто ничего не делает.
  if (!claimBuilding(buildingOwners, id, player.id)) return;
  actionsLeft[player.id] -= 1;
  renderBuildings();
  renderActionPips();
  updateHint();
}

// --- Right rail: money card, city list, warehouse, market/diplomacy/government buttons ---
// (ТЗ 11.5). City resources are real (read off the actual generated map for that city's region);
// everything downstream of "collect it to a warehouse" isn't implemented yet — no per-city storage,
// no income, no card-effect resource checks — so those parts stay honest placeholders/read-only
// reference panels rather than fabricated numbers.

const RESOURCE_META = new Map(RESOURCES.map((r) => [r.id, r]));
const MAX_CITIES = 8;

function resourcesInRegion(rc: number, rr: number): ResourceId[] {
  const found: ResourceId[] = [];
  for (let dx = 0; dx < REGION_SIZE_X; dx++) {
    for (let dy = 0; dy < REGION_SIZE_Y; dy++) {
      const r = doc.get(rc * REGION_SIZE_X + dx, rr * REGION_SIZE_Y + dy).resource;
      if (r) found.push(r);
    }
  }
  return found;
}

function renderMoneyCard() {
  const el = document.querySelector<HTMLDivElement>("#money-card");
  if (!el) return; // only exists in the playing-phase bottom bar markup
  el.innerHTML = `<div class="money-label">Деньги</div><div class="money-amount">${money[currentPlayerIndex]}</div>`;
}

function renderCityList() {
  const el = document.querySelector<HTMLDivElement>("#city-list");
  if (!el) return;
  const player = PLAYERS[currentPlayerIndex];
  const myCities = cityResults.filter((c) => c.playerId === player.id);

  const slot = (city: CityResult | undefined, index: number) => {
    if (!city) return `<div class="city-slot empty">${index + 1}</div>`;
    const icons = resourcesInRegion(city.regionCol, city.regionRow)
      .map((id) => {
        const meta = RESOURCE_META.get(id)!;
        return `<span class="res-ico" style="--rc:#${meta.color.toString(16).padStart(6, "0")}" title="${meta.label}">${meta.symbol}</span>`;
      })
      .join("");
    return `<div class="city-slot filled" title="Регион ${city.regionCol + 1}.${city.regionRow + 1}">
      <div class="city-name">Город ${index + 1}</div>
      <div class="city-resources">${icons}</div>
    </div>`;
  };

  el.innerHTML = `
    <div class="tech-title">Города (${myCities.length}/${MAX_CITIES})</div>
    <div class="city-slots-wrap">
      ${Array.from({ length: MAX_CITIES }, (_, i) => slot(myCities[i], i)).join("")}
    </div>
  `;
}

function renderWarehouse() {
  const el = document.querySelector<HTMLDivElement>("#warehouse-panel");
  if (!el) return;
  el.innerHTML = `
    <div class="tech-title">Склад</div>
    <div class="warehouse-empty">Добыча картой «Рабочий» и хранение на складе ещё не реализованы (ТЗ 7.2) — ресурсы городов видны в списке выше, но на склад пока не попадают.</div>
  `;
}

function renderActionButtons() {
  const el = document.querySelector<HTMLDivElement>("#action-buttons");
  if (!el) return;
  el.innerHTML = `
    <button class="side-btn" id="btn-sell">Продать</button>
    <button class="side-btn" id="btn-buy">Купить${market.length ? ` (${market.length})` : ""}</button>
    <button class="side-btn" id="btn-diplomacy">Дипломатия</button>
    <button class="side-btn" id="btn-government">Гос. управление</button>
  `;
  el.querySelector("#btn-sell")!.addEventListener("click", () => {
    setHint(phase === "playing" ? "Нажмите на карту в руке и выберите цену продажи." : "Продажа карт доступна только в фазе игры.");
  });
  el.querySelector("#btn-buy")!.addEventListener("click", openMarketModal);
  el.querySelector("#btn-diplomacy")!.addEventListener("click", () => openInfoModal("diplomacy"));
  el.querySelector("#btn-government")!.addEventListener("click", () => openInfoModal("government"));
}

// --- Side modal: market listing + read-only diplomacy/government reference lists ---

type ModalKind = "market" | "diplomacy" | "government" | null;
let activeModal: ModalKind = null;

function closeModal() {
  activeModal = null;
  renderModal();
}

function openMarketModal() {
  activeModal = "market";
  renderModal();
}

function openInfoModal(kind: "diplomacy" | "government") {
  activeModal = kind;
  renderModal();
}

function buyListing(id: number) {
  const listing = market.find((l) => l.id === id);
  if (!listing || listing.sellerId === currentPlayerIndex) return;
  if (money[currentPlayerIndex] < listing.price) {
    setHint("Недостаточно денег для покупки этой карты.");
    return;
  }
  if (hands[currentPlayerIndex].length >= HAND_SIZE) {
    setHint("Рука полна — некуда положить купленную карту.");
    return;
  }
  money[currentPlayerIndex] -= listing.price;
  money[listing.sellerId] += listing.price;
  hands[currentPlayerIndex].push(listing.card);
  market.splice(market.indexOf(listing), 1);
  renderHand();
  renderMoneyCard();
  renderActionButtons();
  renderModal();
}

function renderModal() {
  const backdrop = document.querySelector<HTMLDivElement>("#side-modal-backdrop")!;
  if (!activeModal) {
    backdrop.classList.remove("open");
    backdrop.innerHTML = "";
    return;
  }
  backdrop.classList.add("open");

  if (activeModal === "market") {
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">Рынок карт <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Видимость «только торговая сеть или сосед» ещё не реализована — показаны все объявления всех игроков.</div>
        <div class="market-list">
          ${
            market.length
              ? market
                  .map(
                    (l) => `
                <div class="market-row">
                  <span class="market-card">${l.card.kind === "event" ? "⚡" : "🂠"} ${l.card.label}</span>
                  <span class="market-seller" style="color:${playerCss(l.sellerId)}">${PLAYERS[l.sellerId].name}</span>
                  <span class="market-price">${l.price} 💰</span>
                  ${
                    l.sellerId === currentPlayerIndex
                      ? `<span class="market-own">ваш лот</span>`
                      : `<button class="market-buy" data-id="${l.id}">Купить</button>`
                  }
                </div>`
                  )
                  .join("")
              : `<div class="market-empty">Пока ничего не выставлено</div>`
          }
        </div>
      </div>`;
    backdrop.querySelectorAll<HTMLButtonElement>(".market-buy").forEach((btn) =>
      btn.addEventListener("click", () => buyListing(+btn.dataset.id!))
    );
  } else {
    const isDiplomacy = activeModal === "diplomacy";
    const title = isDiplomacy ? "Дипломатия" : "Гос. управление";
    const items = isDiplomacy ? DIPLOMACY_AGREEMENTS : GOVERNMENT_PARADIGMS;
    backdrop.innerHTML = `
      <div class="side-modal">
        <div class="side-modal-head">${title} <button class="modal-close" id="modal-close">×</button></div>
        <div class="side-modal-note">Справочно — соглашения/парадигмы открываются технологиями (см. дерево технологий), но выбор и состояние по игрокам ещё не реализованы.</div>
        <ul class="info-list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>
      </div>`;
  }
  backdrop.querySelector("#modal-close")!.addEventListener("click", closeModal);
}

// Close on backdrop click (outside the panel), not on clicks inside it.
document.querySelector<HTMLDivElement>("#side-modal-backdrop")!.addEventListener("click", (e) => {
  if (e.currentTarget === e.target) closeModal();
});

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

/** Face-down deck, drawn immediately left of the hand — cards come off it and return under it. */
const deckPileHtml = `
  <div class="deck-pile" id="deck-pile">
    <div class="deck-card"></div>
    <div class="deck-card"></div>
    <div class="deck-card deck-card-top"><span id="deck-count"></span></div>
  </div>`;

function renderBottomBar() {
  const bar = document.querySelector<HTMLDivElement>("#bottom-bar")!;
  if (phase === "placement") {
    const player = PLAYERS[currentPlayerIndex];
    const value = nextTokenValueFor(player.id);
    bar.className = "bottom-bar placement-mode";
    bar.innerHTML = `
      <div class="placement-panel">
        <div class="player-indicator" style="color:#${player.color.toString(16).padStart(6, "0")}">${player.name}</div>
        <div class="next-token-badge">Следующий жетон: <b style="color:#${player.color.toString(16).padStart(6, "0")}">${value}</b></div>
      </div>
      <div class="hand-zone">${deckPileHtml}</div>
      <div></div>
    `;
  } else {
    bar.className = "bottom-bar";
    bar.innerHTML = `
      <div class="action-counter">
        <div class="label">Действия</div>
        <div class="pips" id="action-pips"></div>
      </div>
      <div class="hand-zone">
        ${deckPileHtml}
        <div class="card-slots" id="card-slots"></div>
        <div class="money-card" id="money-card"></div>
      </div>
      <button class="end-turn-btn" id="end-turn-btn"><span class="icon">⏭</span>Завершить ход</button>
    `;
    buildHandSlotEls();
    renderHand();
    renderActionPips();
    renderMoneyCard();
    document.querySelector("#end-turn-btn")!.addEventListener("click", onPlayingEndTurn);
  }
  updateDeckCount(); // the counter lives inside the markup above, so fill it in afterwards
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
  renderBuildings(); // grid only becomes claimable once the playing phase starts
  renderCityList(); // cities just got founded — the right rail had nothing to show before this
  updateHint();
  // The playing-phase bottom bar is taller (card slots), so the map has less room than it did
  // during placement — refit rather than leaving the canvas at its old size.
  fitMapToArea();
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
/** Which hand slot currently shows the "Играть / Продать" choice popover, or null if none. */
let openCardChoiceIndex: number | null = null;

function buildHandSlotEls() {
  const container = cardSlotsEl();
  slotEls = [];
  for (let i = 0; i < HAND_SIZE; i++) {
    const slot = document.createElement("div");
    slot.className = "card-slot";
    slot.addEventListener("click", () => onCardSlotClick(i));
    container.appendChild(slot);
    slotEls.push(slot);
  }
}

/** Clicking a playable card doesn't play it outright any more — it opens a choice between
 * playing it (unchanged behaviour) and listing it on the market at a price 1-5 instead. */
function onCardSlotClick(i: number) {
  const hand = hands[currentPlayerIndex];
  if (!hand[i] || actionsLeft[currentPlayerIndex] <= 0) return;
  openCardChoiceIndex = openCardChoiceIndex === i ? null : i; // click again to close
  renderHand();
}

function cardChoiceHtml(i: number): string {
  return `
    <div class="card-choice">
      <button class="choice-play" data-i="${i}">▶ Играть</button>
      <div class="choice-sell-row">
        <span>Продать за:</span>
        ${[1, 2, 3, 4, 5].map((p) => `<button class="choice-price" data-i="${i}" data-p="${p}">${p}</button>`).join("")}
      </div>
    </div>`;
}

// Slots show which type of card sits there (action vs event) but not its name — the exact
// hand a player ends up with is random and not something to spell out yet at this layout stage.
function renderHand() {
  const hand = hands[currentPlayerIndex];
  const left = actionsLeft[currentPlayerIndex];
  slotEls.forEach((el, i) => {
    const card = hand[i];
    const choiceOpen = openCardChoiceIndex === i && !!card;
    el.classList.toggle("empty", !card);
    el.classList.toggle("event", card?.kind === "event");
    el.classList.toggle("playable", !!card && left > 0);
    el.classList.toggle("choice-open", choiceOpen);
    el.innerHTML = card ? `<div class="card-icon">${card.kind === "event" ? "⚡" : "🂠"}</div>${choiceOpen ? cardChoiceHtml(i) : ""}` : "";
  });
  // innerHTML above wipes any previously-bound listeners, so the choice popover's own buttons
  // (if open) get rewired every render rather than once at slot-creation time like the slot itself.
  if (openCardChoiceIndex !== null) {
    const openEl = slotEls[openCardChoiceIndex];
    openEl.querySelector(".choice-play")?.addEventListener("click", (e) => {
      e.stopPropagation();
      playCard(openCardChoiceIndex!);
    });
    openEl.querySelectorAll<HTMLButtonElement>(".choice-price").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        sellCard(+btn.dataset.i!, +btn.dataset.p!);
      })
    );
  }
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
  openCardChoiceIndex = null;
  renderHand();
  renderActionPips();
  updateDeckCount(); // the played card went under the deck — the pile's count changed
  updateHint();
}

/** Lists a hand card on the shared market instead of playing it — a transfer, not a play, so it
 * doesn't cost an action (same reasoning as the mandatory end-of-turn card handoff in ТЗ 2.3). */
function sellCard(slotIndex: number, price: number) {
  const hand = hands[currentPlayerIndex];
  const card = hand[slotIndex];
  if (!card) return;
  hand.splice(slotIndex, 1);
  market.push({ id: nextListingId++, sellerId: currentPlayerIndex, card, price });
  openCardChoiceIndex = null;
  renderHand();
  renderActionButtons(); // refreshes the "Купить (N)" count
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
  openCardChoiceIndex = null; // closes with the turn — the old owner's choice popover makes no sense for the next player
  currentPlayerIndex = (currentPlayerIndex + 1) % PLAYERS.length;
  renderHand();
  renderActionPips();
  updateDeckCount(); // cards were just dealt off the pile
  renderBuildings(); // "buildable" highlighting follows whose turn it is
  renderCityList(); // right rail follows whose turn it is, same as buildings above
  renderMoneyCard();
  renderActionButtons(); // "Купить (N)" count doesn't change, but keeps buy-ability current
  updateHint();
}

// --- Map: always centered in the space above the hint/bottom bar, scaled to fit. ---
const mapArea = document.querySelector<HTMLDivElement>(".map-area")!;
const mapWrap = document.querySelector<HTMLDivElement>(".map-wrap")!;
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

/** Floor for each side rail — below this the map starts giving width back instead. */
const MIN_RAIL = 210;

// The map takes only the width it actually needs (it is normally bound by height, not width) and
// then reports that width to the layout; the rail and its mirror split everything left over. That
// keeps the map centred on the window *and* leaves no dead space beside the panels.
function fitMapToArea() {
  const cs = getComputedStyle(mapArea);
  const innerW = mapArea.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const innerH = mapArea.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const gap = parseFloat(cs.columnGap) || 0;
  // Widest the map may be while both rails still keep their minimum width.
  const widthCap = innerW - 2 * gap - 2 * MIN_RAIL;
  const scale = Math.min(innerH / mapContentHeight, widthCap / mapContentWidth, 1.5);
  const w = mapContentWidth * scale;
  const h = mapContentHeight * scale;
  pixiApp.canvas.style.width = w + "px";
  pixiApp.canvas.style.height = h + "px";
  mapWrap.style.width = w + "px";
}
window.addEventListener("resize", fitMapToArea);

// --- Map zoom & pan -------------------------------------------------------------------------
// Only the map scales: the canvas element keeps its fitted size and we scale the *world* inside
// Pixi instead, so panels, cards and text are untouched. renderer.toLocal() goes through the same
// root container, so hex hit-testing keeps working at any zoom without extra maths.
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ROOT_BASE = 20; // MapRenderer's own root offset at zoom 1
let zoom = 1;
let camX = 0; // camera top-left, in unzoomed world pixels
let camY = 0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function applyMapTransform() {
  // Keep the camera inside the map: at zoom 1 the range collapses to 0 and it stays centred.
  camX = clamp(camX, 0, Math.max(0, mapContentWidth - mapContentWidth / zoom));
  camY = clamp(camY, 0, Math.max(0, mapContentHeight - mapContentHeight / zoom));
  renderer.root.scale.set(zoom);
  renderer.root.position.set((ROOT_BASE - camX) * zoom, (ROOT_BASE - camY) * zoom);
}

/** Pointer position in canvas pixel space (undoing the CSS fit-scale). */
function canvasPoint(e: { clientX: number; clientY: number }) {
  const rect = pixiApp.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (pixiApp.canvas.width / rect.width),
    y: (e.clientY - rect.top) * (pixiApp.canvas.height / rect.height),
  };
}

pixiApp.canvas.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    e.preventDefault();
    const p = canvasPoint(e);
    const next = clamp(zoom * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    if (next === zoom) return;
    // Anchor on the cursor: whatever world point sits under it must stay under it.
    const worldX = camX + p.x / zoom;
    const worldY = camY + p.y / zoom;
    zoom = next;
    camX = worldX - p.x / zoom;
    camY = worldY - p.y / zoom;
    applyMapTransform();
  },
  { passive: false }
);

// Drag to pan once zoomed in. A click is only a click if the pointer barely moved, so dragging
// the map never drops a placement token by accident.
const DRAG_SLOP = 5;
let dragging = false;
let dragMoved = false;
let lastX = 0;
let lastY = 0;

pixiApp.canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  dragging = true;
  dragMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  // Best-effort: capture can throw (e.g. no active pointer with this id) in edge cases outside
  // real mouse/touch input. That must never abort the click/placement logic below.
  try {
    pixiApp.canvas.setPointerCapture(e.pointerId);
  } catch {
    /* not captured — pan/click still work off plain client coordinates */
  }
});

pixiApp.canvas.addEventListener("pointermove", (e: PointerEvent) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  if (!dragMoved && Math.hypot(dx, dy) < DRAG_SLOP) return;
  dragMoved = true;
  if (zoom > 1) {
    const rect = pixiApp.canvas.getBoundingClientRect();
    // Convert the CSS-pixel drag into world pixels before applying it.
    camX -= dx * (pixiApp.canvas.width / rect.width) / zoom;
    camY -= dy * (pixiApp.canvas.height / rect.height) / zoom;
    applyMapTransform();
  }
  lastX = e.clientX;
  lastY = e.clientY;
});

pixiApp.canvas.addEventListener("pointerup", (e: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  // Same defensive try/catch as the capture call above — a throw here must not swallow the
  // click/placement handling that follows.
  try {
    pixiApp.canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* nothing was captured — fine, ignore */
  }
  if (dragMoved || phase !== "placement") return;
  const p = canvasPoint(e);
  const local = renderer.toLocal(p.x, p.y);
  const hit = pixelToHex(local.x, local.y, HEX_SIZE, MAP_WIDTH, MAP_HEIGHT);
  if (!hit) return;
  tryPlaceToken(hit.col, hit.row);
});

// An interrupted gesture (pointer lost to the OS, touch cancelled) would otherwise leave the drag
// flag stuck on, making the next plain click read as the tail of a drag.
pixiApp.canvas.addEventListener("pointercancel", () => {
  dragging = false;
  dragMoved = false;
});

pixiApp.canvas.style.touchAction = "none";

// Bottom bar (and its content) must be laid out *before* we measure how much room the map
// actually has — fitting against the map-area's size while the bottom bar was still empty
// left the canvas oversized once real content pushed the available height back down.
// One delegated listener on the grid — chips are re-rendered on every claim, so per-chip handlers
// would have to be re-bound each time.
document.querySelector<HTMLDivElement>("#buildings-bar")!.addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-bld]");
  if (chip) onBuildingClick(chip.dataset.bld!);
});

renderBottomBar();
updateHint();
renderTechTree();
renderBuildings();
renderCityList();
renderWarehouse();
renderActionButtons();
fitMapToArea();

// @ts-ignore debug hook
window.__debug = {
  pixiApp,
  doc,
  renderer,
  deck,
  hands,
  placedTokens,
  cityResults,
  buildingOwners,
  money,
  market,
  renderBottomBar,
  renderBuildings,
  renderCityList,
  updateHint,
  onResolvePlacement,
};
