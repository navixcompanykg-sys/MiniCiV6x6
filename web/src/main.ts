import { Application } from "pixi.js";
import { MapDoc, MAP_WIDTH, MAP_HEIGHT, bandForRegionRow, forestLabelForBand } from "./map/mapDoc";
import { MapRenderer, HEX_SIZE, isLightColor } from "./map/renderer";
import { pixelToHex } from "./map/hexMath";
import { TERRAINS, RESOURCES, TERRAIN_BY_ID, RESOURCE_BY_ID } from "./map/types";
import type { TerrainId, ResourceId, ResourceDef } from "./map/types";
import { computeCounts } from "./map/counters";
import { generateResources } from "./map/resourceGenerator";
import { generateTerrain } from "./map/terrainGenerator";
import { mulberry32 } from "./map/rand";

const STORAGE_KEY = "civa-map-doc-v1";

type Tool =
  | { kind: "terrain"; id: TerrainId }
  | { kind: "resource"; id: ResourceId }
  | { kind: "eraseResource" }
  | { kind: "city" }
  | { kind: "removeCity" }
  | { kind: "forest" }
  | { kind: "removeForest" }
  | { kind: "swapRegions" };

let doc = loadFromStorage() ?? new MapDoc();
let currentTool: Tool = { kind: "terrain", id: "ocean" };
let swapFirst: { col: number; row: number } | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="layout">
    <div class="canvas-wrap"><div id="pixi-container"></div><div id="hex-tooltip" class="hex-tooltip"></div></div>
    <div class="sidebar">
      <h1>Конструктор карты — МИНИ ЦИВА</h1>

      <section>
        <h2>Рельеф</h2>
        <div class="palette" id="terrain-palette"></div>
      </section>

      <section>
        <h2>Ресурсы</h2>
        <button id="erase-resource-btn" class="eraser-btn">✕ Ластик ресурсов — клик по тайлу убирает ресурс</button>
        <div class="palette" id="resource-palette"></div>
      </section>

      <section>
        <h2>Прочее</h2>
        <button id="city-btn" class="tool-btn">Нейтральный город (поставить)</button>
        <button id="remove-city-btn" class="tool-btn">Нейтральный город (убрать)</button>
        <button id="forest-btn" class="tool-btn">Лес/Джунгли — оверлей (только на равнину/холмы)</button>
        <button id="remove-forest-btn" class="tool-btn">Лес/Джунгли (убрать)</button>
        <button id="swap-btn" class="tool-btn">Поменять регионы местами (своя широта или зеркальная)</button>
        <div id="swap-hint" class="hint"></div>
        <button id="shuffle-btn" class="tool-btn primary">🔀 Перемешать всё (регионы + пересев ресурсов)</button>
        <button id="generate-btn" class="tool-btn primary">🎲 Сгенерировать случайную карту (с нуля)</button>
      </section>

      <section>
        <h2>Счётчики</h2>
        <div id="counters"></div>
      </section>

      <section>
        <h2>Сохранение (папка проекта: web/saved-maps)</h2>
        <input id="save-name" type="text" class="text-input" placeholder="Название карты..." />
        <button id="save-btn" class="tool-btn primary">Сохранить</button>
        <div id="save-status" class="hint"></div>

        <select id="load-select" class="text-input"><option value="">— выбрать сохранённую карту —</option></select>
        <button id="load-btn" class="tool-btn">Загрузить выбранную</button>
        <button id="delete-btn" class="tool-btn danger">Удалить выбранную</button>

        <button id="reset-btn" class="tool-btn danger">Сбросить текущую карту (не сохранённые)</button>
      </section>
    </div>
  </div>
`;

const pixiContainer = document.querySelector<HTMLDivElement>("#pixi-container")!;

const mapWidthPx = MAP_WIDTH * HEX_SIZE * 1.5 + HEX_SIZE * 2 + 100;
const mapHeightPx = MAP_HEIGHT * Math.sqrt(3) * HEX_SIZE + HEX_SIZE * 3 + 40;

const pixiApp = new Application();
await pixiApp.init({ width: mapWidthPx, height: mapHeightPx, background: 0x0e1520, antialias: true });
pixiContainer.appendChild(pixiApp.canvas);

const renderer = new MapRenderer(pixiApp);
renderer.drawAll(doc);
renderInteractionLayer();
setupZoom();
setupHoverTooltip();
renderCounters();

// @ts-ignore debug hook
window.__debug = { pixiApp, doc, renderer };

function renderInteractionLayer() {
  pixiApp.stage.eventMode = "static";
  pixiApp.stage.hitArea = pixiApp.screen;
  pixiApp.stage.on("pointerdown", (e) => {
    const local = renderer.toLocal(e.global.x, e.global.y);
    const hit = pixelToHex(local.x, local.y, HEX_SIZE, MAP_WIDTH, MAP_HEIGHT);
    if (!hit) return;
    handleHexClick(hit.col, hit.row);
  });
}

// --- Zoom (mouse wheel) ---
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
let zoom = 1;
const rootBaseX = 90;
const rootBaseY = 20;

function applyZoom(newZoom: number) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  pixiApp.renderer.resize(mapWidthPx * zoom, mapHeightPx * zoom);
  renderer.root.scale.set(zoom);
  renderer.root.position.set(rootBaseX * zoom, rootBaseY * zoom);
  pixiApp.stage.hitArea = pixiApp.screen;
}

function setupZoom() {
  const canvasWrap = document.querySelector<HTMLDivElement>(".canvas-wrap")!;
  canvasWrap.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      const rect = canvasWrap.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const contentX = canvasWrap.scrollLeft + cursorX;
      const contentY = canvasWrap.scrollTop + cursorY;

      const oldZoom = zoom;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * factor));
      if (newZoom === oldZoom) return;
      const ratio = newZoom / oldZoom;

      applyZoom(newZoom);

      canvasWrap.scrollLeft = contentX * ratio - cursorX;
      canvasWrap.scrollTop = contentY * ratio - cursorY;
    },
    { passive: false }
  );
}

function handleHexClick(col: number, row: number) {
  if (currentTool.kind === "swapRegions") {
    const regionCol = doc.regionColOf(col);
    const regionRow = doc.regionRowOf(row);
    if (!swapFirst) {
      swapFirst = { col: regionCol, row: regionRow };
      renderer.highlightRegion(regionCol, regionRow, 0xffff00);
      setHint(`Выбран регион (${regionCol}, ${regionRow}). Кликните регион в той же широте, чтобы поменять местами.`);
      return;
    }
    const firstBand = bandForRegionRow(swapFirst.row);
    const secondBand = bandForRegionRow(regionRow);
    const sameBand = firstBand.id === secondBand.id;
    const mirroredBand = firstBand.mirrorOf === secondBand.id;
    if (!sameBand && !mirroredBand) {
      setHint(`Нельзя: ${firstBand.label} и ${secondBand.label} — не одна и не зеркальная широтная зона.`);
      swapFirst = null;
      renderer.highlightRegion(null, null);
      return;
    }
    doc.swapRegions(swapFirst.col, swapFirst.row, regionCol, regionRow, mirroredBand);
    swapFirst = null;
    renderer.highlightRegion(null, null);
    setHint(mirroredBand ? "Готово — регионы поменяны местами (зеркально, через экватор)." : "Готово — регионы поменяны местами.");
    redrawAndPersist();
    return;
  }

  if (currentTool.kind === "terrain") {
    doc.set(col, row, { terrain: currentTool.id });
  } else if (currentTool.kind === "resource") {
    doc.set(col, row, { resource: currentTool.id });
  } else if (currentTool.kind === "eraseResource") {
    doc.set(col, row, { resource: undefined });
  } else if (currentTool.kind === "city") {
    doc.set(col, row, { neutralCity: true });
  } else if (currentTool.kind === "removeCity") {
    doc.set(col, row, { neutralCity: false });
  } else if (currentTool.kind === "forest") {
    const terrain = TERRAIN_BY_ID[doc.get(col, row).terrain];
    if (!terrain.canHaveForest) {
      setHint(`Лес/джунгли можно ставить только на равнину или холмы (тайл сейчас: ${terrain.label}).`);
      return;
    }
    doc.set(col, row, { forest: true });
  } else if (currentTool.kind === "removeForest") {
    doc.set(col, row, { forest: false });
  }
  redrawAndPersist();
}

function redrawAndPersist() {
  renderer.drawAll(doc);
  renderCounters();
  saveToStorage();
}

function setHint(text: string) {
  document.querySelector<HTMLDivElement>("#swap-hint")!.textContent = text;
}

// --- Resource icon: same shape (circle/diamond/triangle by category) + color + symbol used on
// the map itself, reused everywhere a resource needs a legend swatch (counters, palette). ---

function resourceIconSvg(r: ResourceDef, size = 20): string {
  const hex = "#" + r.color.toString(16).padStart(6, "0");
  const textColor = isLightColor(r.color) ? "#111" : "#fff";
  const c = size / 2;
  const rad = size * 0.42;
  let shape: string;
  if (r.category === "food") {
    shape = `<circle cx="${c}" cy="${c}" r="${rad}" fill="${hex}" stroke="#111" stroke-width="1.5"/>`;
  } else if (r.category === "strategic") {
    shape = `<polygon points="${c},${c - rad} ${c + rad},${c} ${c},${c + rad} ${c - rad},${c}" fill="${hex}" stroke="#111" stroke-width="1.5"/>`;
  } else {
    const pts = [0, 1, 2]
      .map((i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        return `${c + rad * Math.cos(a)},${c + rad * Math.sin(a)}`;
      })
      .join(" ");
    shape = `<polygon points="${pts}" fill="${hex}" stroke="#111" stroke-width="1.5"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="resource-icon">${shape}<text x="${c}" y="${c + size * 0.12}" text-anchor="middle" dominant-baseline="middle" font-size="${size * 0.36}" font-weight="bold" fill="${textColor}" font-family="sans-serif">${r.symbol}</text></svg>`;
}

// --- Hover tooltip: shows exactly what's on the hex under the cursor. ---

const tooltipEl = document.querySelector<HTMLDivElement>("#hex-tooltip")!;

function tileInfoHtml(col: number, row: number): string {
  const tile = doc.get(col, row);
  const band = bandForRegionRow(doc.regionRowOf(row));
  const terrain = TERRAIN_BY_ID[tile.terrain];
  const lines = [`<div class="tt-band">${band.label}</div>`, `<div>${terrain.label}</div>`];
  if (tile.forest) lines.push(`<div>${forestLabelForBand(band)}</div>`);
  if (tile.resource) {
    const r = RESOURCE_BY_ID[tile.resource];
    lines.push(`<div class="tt-resource">${resourceIconSvg(r, 16)}<span>${r.label}</span></div>`);
  }
  if (tile.neutralCity) lines.push(`<div>Нейтральный город</div>`);
  return lines.join("");
}

function setupHoverTooltip() {
  const canvasWrap = document.querySelector<HTMLDivElement>(".canvas-wrap")!;
  pixiApp.canvas.addEventListener("pointermove", (e: PointerEvent) => {
    const rect = pixiApp.canvas.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (pixiApp.canvas.width / rect.width);
    const canvasY = (e.clientY - rect.top) * (pixiApp.canvas.height / rect.height);
    const local = renderer.toLocal(canvasX, canvasY);
    const hit = pixelToHex(local.x, local.y, HEX_SIZE, MAP_WIDTH, MAP_HEIGHT);
    if (!hit) {
      tooltipEl.style.display = "none";
      return;
    }
    tooltipEl.innerHTML = tileInfoHtml(hit.col, hit.row);
    tooltipEl.style.display = "block";
    const wrapRect = canvasWrap.getBoundingClientRect();
    tooltipEl.style.left = e.clientX - wrapRect.left + 16 + "px";
    tooltipEl.style.top = e.clientY - wrapRect.top + 16 + "px";
  });
  pixiApp.canvas.addEventListener("pointerleave", () => {
    tooltipEl.style.display = "none";
  });
}

// --- Palettes ---

const terrainPalette = document.querySelector<HTMLDivElement>("#terrain-palette")!;
for (const t of TERRAINS) {
  const btn = document.createElement("button");
  btn.className = "swatch";
  btn.style.background = "#" + t.color.toString(16).padStart(6, "0");
  btn.title = t.label;
  btn.textContent = t.label;
  btn.addEventListener("click", () => {
    currentTool = { kind: "terrain", id: t.id };
    selectButton(btn, terrainPalette);
    clearOtherSelections(terrainPalette);
  });
  terrainPalette.appendChild(btn);
}
selectButton(terrainPalette.firstElementChild as HTMLButtonElement, terrainPalette);

const resourcePalette = document.querySelector<HTMLDivElement>("#resource-palette")!;
for (const r of RESOURCES) {
  const btn = document.createElement("button");
  btn.className = "swatch resource-swatch";
  btn.title = `${r.label} (цель: ${r.targetCount})`;
  btn.innerHTML = `${resourceIconSvg(r, 16)}<span>${r.label}</span>`;
  btn.addEventListener("click", () => {
    currentTool = { kind: "resource", id: r.id };
    selectButton(btn, resourcePalette);
    clearOtherSelections(resourcePalette);
  });
  resourcePalette.appendChild(btn);
}

function selectButton(btn: HTMLButtonElement, group: HTMLElement) {
  group.querySelectorAll(".swatch").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
}
function clearOtherSelections(exceptGroup: HTMLElement) {
  document.querySelectorAll(".tool-btn, .eraser-btn").forEach((b) => b.classList.remove("selected"));
  if (exceptGroup !== terrainPalette) terrainPalette.querySelectorAll(".swatch").forEach((b) => b.classList.remove("selected"));
  if (exceptGroup !== resourcePalette) resourcePalette.querySelectorAll(".swatch").forEach((b) => b.classList.remove("selected"));
}

function selectToolButton(id: string) {
  document.querySelectorAll(".tool-btn, .eraser-btn").forEach((b) => b.classList.remove("selected"));
  document.querySelector(id)?.classList.add("selected");
  terrainPalette.querySelectorAll(".swatch").forEach((b) => b.classList.remove("selected"));
  resourcePalette.querySelectorAll(".swatch").forEach((b) => b.classList.remove("selected"));
}

document.querySelector("#erase-resource-btn")!.addEventListener("click", () => {
  currentTool = { kind: "eraseResource" };
  selectToolButton("#erase-resource-btn");
});
document.querySelector("#city-btn")!.addEventListener("click", () => {
  currentTool = { kind: "city" };
  selectToolButton("#city-btn");
});
document.querySelector("#remove-city-btn")!.addEventListener("click", () => {
  currentTool = { kind: "removeCity" };
  selectToolButton("#remove-city-btn");
});
document.querySelector("#forest-btn")!.addEventListener("click", () => {
  currentTool = { kind: "forest" };
  selectToolButton("#forest-btn");
  setHint("Клик по равнине/холмам — поставить лес (в тропиках отобразится как джунгли).");
});
document.querySelector("#remove-forest-btn")!.addEventListener("click", () => {
  currentTool = { kind: "removeForest" };
  selectToolButton("#remove-forest-btn");
  setHint("");
});
document.querySelector("#swap-btn")!.addEventListener("click", () => {
  currentTool = { kind: "swapRegions" };
  swapFirst = null;
  renderer.highlightRegion(null, null);
  selectToolButton("#swap-btn");
  setHint("Кликните первый регион.");
});

document.querySelector("#shuffle-btn")!.addEventListener("click", () => {
  if (!confirm("Перемешать все регионы (с учётом широты/зеркала) и пересеять ресурсы заново? Текущая расстановка ресурсов будет потеряна — рельеф останется, просто в других местах.")) return;
  const rng = mulberry32(Date.now() ^ (Math.random() * 0xffffffff));
  doc.shuffleAllRegions(rng);
  generateResources(doc, rng);
  redrawAndPersist();
  setHint("Готово — карта перемешана, ресурсы пересеяны.");
});

document.querySelector("#generate-btn")!.addEventListener("click", () => {
  if (!confirm("Сгенерировать полностью новую случайную карту с нуля? Вся текущая расстановка будет стёрта (несохранённое — потеряется).")) return;
  const rng = mulberry32(Date.now() ^ (Math.random() * 0xffffffff));
  generateTerrain(doc, rng);
  redrawAndPersist();
  setHint("Готово — сгенерирована новая карта.");
});

// --- Counters ---

function renderCounters() {
  const counts = computeCounts(doc);
  const el = document.querySelector<HTMLDivElement>("#counters")!;

  const terrainRows = TERRAINS.map(
    (t) => `<div class="count-row"><span class="swatch-dot" style="background:#${t.color.toString(16).padStart(6, "0")}"></span>${t.label}<b>${counts.terrain[t.id]}</b></div>`
  ).join("");

  const resourceRows = RESOURCES.map((r) => {
    const n = counts.resource[r.id];
    const over = n > r.targetCount ? " over" : n === r.targetCount ? " ok" : "";
    return `<div class="count-row${over}">${resourceIconSvg(r)}${r.label}<b>${n} / ${r.targetCount}</b></div>`;
  }).join("");

  const landCount = TERRAINS.filter((t) => !t.isWater).reduce((s, t) => s + counts.terrain[t.id], 0);
  const waterCount = counts.totalTiles - landCount;

  const overlayRows = `
    <div class="count-row"><span class="swatch-dot" style="background:#2f6b2f"></span>Лес (оверлей)<b>${counts.forestCount}</b></div>
    <div class="count-row"><span class="swatch-dot" style="background:#1f8f3f"></span>Джунгли (оверлей, тропики)<b>${counts.jungleCount}</b></div>
  `;

  el.innerHTML = `
    <div class="count-summary">Всего тайлов: <b>${counts.totalTiles}</b> — суша: <b>${landCount}</b>, море: <b>${waterCount}</b>, нейтр. города: <b>${counts.neutralCities}</b></div>
    <div class="count-group-title">Рельеф (база)</div>
    ${terrainRows}
    <div class="count-group-title">Растительность (оверлей на равнину/холмы)</div>
    ${overlayRows}
    <div class="count-group-title">Ресурсы (текущее / цель из ТЗ)</div>
    ${resourceRows}
  `;
}

// --- Save / Load / Reset (strictly through web/saved-maps/ via the dev-server API, no OS file picker) ---

function setSaveStatus(text: string) {
  document.querySelector<HTMLDivElement>("#save-status")!.textContent = text;
}

async function refreshSavedMapsList(selectName?: string) {
  const select = document.querySelector<HTMLSelectElement>("#load-select")!;
  const resp = await fetch("/api/maps");
  const entries: { name: string; savedAt: string }[] = await resp.json();
  select.innerHTML = '<option value="">— выбрать сохранённую карту —</option>';
  for (const e of entries) {
    const opt = document.createElement("option");
    opt.value = e.name;
    const when = new Date(e.savedAt).toLocaleString("ru-RU");
    opt.textContent = `${e.name} (${when})`;
    select.appendChild(opt);
  }
  if (selectName) select.value = selectName;
}

document.querySelector("#save-btn")!.addEventListener("click", async () => {
  const nameInput = document.querySelector<HTMLInputElement>("#save-name")!;
  const name = nameInput.value.trim();
  if (!name) {
    setSaveStatus("Введите название карты.");
    return;
  }
  setSaveStatus("Сохраняю...");
  const resp = await fetch("/api/maps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data: JSON.parse(doc.toJSON()) }),
  });
  if (!resp.ok) {
    setSaveStatus("Ошибка сохранения.");
    return;
  }
  const { name: savedName } = await resp.json();
  setSaveStatus(`Сохранено: web/saved-maps/${savedName}.json`);
  await refreshSavedMapsList(savedName);
});

document.querySelector("#load-btn")!.addEventListener("click", async () => {
  const select = document.querySelector<HTMLSelectElement>("#load-select")!;
  const name = select.value;
  if (!name) {
    setSaveStatus("Сначала выберите карту в списке.");
    return;
  }
  const resp = await fetch(`/api/maps/${encodeURIComponent(name)}`);
  if (!resp.ok) {
    setSaveStatus("Не удалось загрузить — файл не найден.");
    return;
  }
  const text = await resp.text();
  doc = MapDoc.fromJSON(text);
  redrawAndPersist();
  setSaveStatus(`Загружено: ${name}`);
});

document.querySelector("#delete-btn")!.addEventListener("click", async () => {
  const select = document.querySelector<HTMLSelectElement>("#load-select")!;
  const name = select.value;
  if (!name) {
    setSaveStatus("Сначала выберите карту в списке.");
    return;
  }
  if (!confirm(`Удалить сохранённую карту «${name}»? Это необратимо.`)) return;
  await fetch(`/api/maps/${encodeURIComponent(name)}`, { method: "DELETE" });
  setSaveStatus(`Удалено: ${name}`);
  await refreshSavedMapsList();
});

document.querySelector("#reset-btn")!.addEventListener("click", () => {
  if (!confirm("Сбросить текущую (несохранённую) карту до пустого моря? Сохранённые файлы в web/saved-maps не затронет.")) return;
  doc = new MapDoc();
  redrawAndPersist();
});

refreshSavedMapsList();

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, doc.toJSON());
  } catch {
    /* ignore quota errors */
  }
}

function loadFromStorage(): MapDoc | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return MapDoc.fromJSON(raw);
  } catch {
    return null;
  }
}
