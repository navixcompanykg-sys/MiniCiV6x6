// Стартовое меню (ТЗ) — выбор режима игры: Против AI / Интернет / За одним компьютером /
// Инструкция. Пока полноценно реализован только «За одним компьютером» (hotseat).
//
// Состояние партии теперь живёт на сервере (web/server), не в этой вкладке — «Начать игру» создаёт
// комнату там (net.ts createRoom), «Загрузить игру» подключается к последней сохранённой (joinRoom).
// game.html получает id комнаты через query-параметр `?room=...` и сам подключается тем же net.ts —
// список игроков (имена/цвета) он теперь читает из состояния сервера, а не из sessionStorage.

import { createRoom, joinRoom, listRooms } from "../game/net";
import { REF_CATEGORY_META, REF_CATEGORIES, searchReference, type RefCategory, type RefEntry } from "./reference";

type Screen = "menu" | "hotseat" | "vsai" | "instructions" | "stub";

const PALETTE = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22];

interface PlayerDraft {
  name: string;
  color: number;
  /** Ходит простым эвристическим AI (web/server/src/bot.ts), не человеком за общим экраном. */
  isAI: boolean;
}

let screen: Screen = "menu";
let stubTitle = "";
let players: PlayerDraft[] = [0, 1, 2].map((i) => ({ name: `Игрок ${i + 1}`, color: PALETTE[i], isAI: false }));
let busyMessage: string | null = null;
let savedRooms: { id: string; players: string[]; phase: string; savedAt: string }[] = [];

// --- Инструкция: поиск по сущностям (по прямому запросу — «сделай раздел инструкции ссылающимся
// на этот документ [ЦИВА-СПРАВОЧНИК.md] с возможностью поиска по сущностям», см. reference.ts,
// единый источник данных с самим справочником). Живёт отдельно от `screen`, чтобы не сбрасываться
// при промежуточных ре-рендерах экрана. */
let refQuery = "";
let refCategory: RefCategory | null = null;
let refSelectedId: string | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;

function hex(color: number): string {
  return "#" + color.toString(16).padStart(6, "0");
}

function setScreen(s: Screen) {
  screen = s;
  render();
}

async function refreshSavedRooms() {
  try {
    savedRooms = await listRooms();
  } catch {
    savedRooms = []; // сервер не запущен — просто не показываем «Загрузить игру», не ломаем меню
  }
}

/** Продолжает последнюю сохранённую комнату (сортировка по времени уже на сервере, см. rooms.ts
 * listRooms) — самый недавний файл первый. Несколько параллельных партий (Этап 2) сюда пока не
 * умещаются, тот же принцип «один слот», что раньше был у localStorage. */
async function loadLastRoom() {
  if (!savedRooms.length) return;
  busyMessage = "Подключение к сохранённой партии…";
  render();
  const result = await joinRoom(savedRooms[0].id);
  if ("error" in result) {
    busyMessage = null;
    alert(`Не удалось загрузить партию: ${result.error}`);
    render();
    return;
  }
  window.location.href = `/game.html?room=${result.roomId}`;
}

function renderMenu() {
  const canLoad = savedRooms.length > 0;
  app.innerHTML = `
    <div class="shell">
      <div class="title">МИНИ ЦИВА</div>
      <div class="subtitle">Выберите режим игры</div>
      ${busyMessage ? `<div class="subtitle">${busyMessage}</div>` : ""}
      <div class="mode-grid">
        <button class="mode-btn primary" data-mode="vsai">
          <span class="mode-icon">🤖</span>Против AI
          <span class="mode-note">Ходы AI применяются сами, с паузой между действиями — вы их не подтверждаете и не видите заранее.</span>
        </button>
        <button class="mode-btn" data-mode="online">
          <span class="mode-icon">🌐</span>Интернет
          <span class="mode-note">Не реализовано — сетевой синхронизации ходов пока нет.</span>
        </button>
        <button class="mode-btn primary" data-mode="hotseat">
          <span class="mode-icon">🪑</span>За одним компьютером
          <span class="mode-note">Полноценно работает — от 2 до 6 игроков по очереди на одном экране.</span>
        </button>
        <button class="mode-btn" data-mode="instructions">
          <span class="mode-icon">📖</span>Инструкция
          <span class="mode-note">Краткое описание механик игры.</span>
        </button>
        ${
          canLoad
            ? `<button class="mode-btn primary" data-mode="load" style="grid-column: 1 / -1">
                 <span class="mode-icon">📂</span>Загрузить игру
                 <span class="mode-note">Продолжить «${savedRooms[0].players.join(", ")}» с того же места.</span>
               </button>`
            : ""
        }
      </div>
    </div>`;
  app.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode!;
      if (mode === "hotseat") setScreen("hotseat");
      else if (mode === "vsai") setScreen("vsai");
      else if (mode === "instructions") setScreen("instructions");
      else if (mode === "load") loadLastRoom();
      else {
        stubTitle = "Интернет";
        setScreen("stub");
      }
    })
  );
}

function renderStub() {
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>${stubTitle}</h2><button class="back-btn" id="back">← Назад</button></div>
        <div class="stub-note">Этот режим ещё не реализован в клиенте. Единственный полноценно работающий сейчас способ сыграть — «За одним компьютером» (hotseat, по очереди на одном экране).</div>
      </div>
    </div>`;
  document.querySelector("#back")!.addEventListener("click", () => setScreen("menu"));
}

/** Текущая выборка по поиску+фильтру категории — единая точка, чтобы список и деталка (панель
 * справа) всегда смотрели на один и тот же результат. */
function refResults(): RefEntry[] {
  return searchReference(refQuery, refCategory);
}

function refListHtml(): string {
  const items = refResults();
  if (!items.length) return `<div class="ref-empty">Ничего не найдено — попробуйте другое слово или снимите фильтр категории.</div>`;
  return items
    .map(
      (e) => `
    <button class="ref-item${e.id === refSelectedId ? " active" : ""}" data-id="${e.id}">
      <span class="ref-item-icon">${REF_CATEGORY_META[e.category].icon}</span>
      <span class="ref-item-text"><span class="ref-item-title">${e.title}</span><span class="ref-item-summary">${e.summary}</span></span>
    </button>`
    )
    .join("");
}

function refDetailHtml(): string {
  const items = refResults();
  if (!items.length) return `<div class="ref-placeholder">—</div>`;
  const selected = items.find((e) => e.id === refSelectedId) ?? items[0];
  refSelectedId = selected.id; // по умолчанию открыт первый результат — не пустая панель
  const body = selected.raw
    ? selected.body
    : selected.body
        .split("\n\n")
        .map((p) => `<p>${p}</p>`)
        .join("");
  return `
    <div class="ref-detail-head">
      <span class="ref-detail-icon">${REF_CATEGORY_META[selected.category].icon}</span>
      <div>
        <h3>${selected.title}</h3>
        <div class="ref-detail-summary">${selected.summary}</div>
      </div>
    </div>
    <div class="ref-detail-body">${body}</div>`;
}

/** Перерисовывает ТОЛЬКО список+деталку (не всю панель с полем поиска) — иначе поле теряло бы
 * фокус/курсор на каждое нажатие клавиши при поиске вживую. */
function updateRefPanels() {
  const list = document.querySelector<HTMLDivElement>("#ref-list");
  const detail = document.querySelector<HTMLDivElement>("#ref-detail");
  if (!list || !detail) return;
  list.innerHTML = refListHtml();
  detail.innerHTML = refDetailHtml();
  list.querySelectorAll<HTMLButtonElement>(".ref-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      refSelectedId = btn.dataset.id!;
      updateRefPanels();
    })
  );
}

function renderInstructions() {
  app.innerHTML = `
    <div class="shell wide">
      <div class="panel ref-panel">
        <div class="panel-head"><h2>📖 Инструкция</h2><button class="back-btn" id="back">← Назад</button></div>
        <div class="ref-intro">Коротко: партия идёт по циклам — все игроки ходят по разу, по очереди; за ход — несколько действий (карты), движение юнитов действий не тратит, но стоит 1💰 за приказ; рука до 7 карт, лишняя раздутая сверху сбрасывается со штрафом в конце хода. Дальше — ищите ниже по названию любой сущности игры (юнит, карта, технология, здание, ресурс, гекс, парадигма, религия, соглашение) или по слову вроде «бой», «осада», «действия», «цикл» — статьи с общими правилами тоже находятся поиском.</div>
        <input type="text" id="ref-search" class="ref-search" placeholder="Поиск: Крейсер, Мистицизм, Открытые границы, осада…" autocomplete="off" value="${refQuery}" />
        <div class="ref-chips" id="ref-chips">
          <button class="ref-chip${refCategory === null ? " active" : ""}" data-cat="">Все</button>
          ${REF_CATEGORIES.map((c) => `<button class="ref-chip${refCategory === c ? " active" : ""}" data-cat="${c}">${REF_CATEGORY_META[c].icon} ${REF_CATEGORY_META[c].label}</button>`).join("")}
        </div>
        <div class="ref-columns">
          <div class="ref-list" id="ref-list"></div>
          <div class="ref-detail" id="ref-detail"></div>
        </div>
      </div>
    </div>`;
  document.querySelector("#back")!.addEventListener("click", () => setScreen("menu"));
  const search = document.querySelector<HTMLInputElement>("#ref-search")!;
  search.addEventListener("input", () => {
    refQuery = search.value;
    refSelectedId = null;
    updateRefPanels();
  });
  document.querySelectorAll<HTMLButtonElement>(".ref-chip").forEach((btn) =>
    btn.addEventListener("click", () => {
      refCategory = (btn.dataset.cat || null) as RefCategory | null;
      refSelectedId = null;
      document.querySelectorAll(".ref-chip").forEach((b) => b.classList.toggle("active", b === btn));
      updateRefPanels();
    })
  );
  updateRefPanels();
}

function setPlayerCount(n: number) {
  n = Math.max(2, Math.min(6, n));
  while (players.length < n) players.push({ name: `Игрок ${players.length + 1}`, color: PALETTE[players.length % PALETTE.length], isAI: false });
  while (players.length > n) players.pop();
  render();
}

/** Общий экран настройки партии — и «За одним компьютером» (hotseat), и «Против AI»: тот же выбор
 * числа игроков/имени/цвета/AI-переключателя на каждого, разница только в заголовке/подсказке и в
 * том, какой режим уходит на сервер (см. GameSession.autoPlayAI/wsServer.ts driveAiTurns) — по
 * прямому запросу «в настройках партии должна быть возможность не только выбрать число игроков но и
 * кто играет AI или человек» для режима «Против AI» тоже, той же формой, что уже была у hotseat. */
function renderSetup() {
  const isVsAi = screen === "vsai";
  const dupeColors = new Set<number>();
  const seen = new Set<number>();
  for (const p of players) {
    if (seen.has(p.color)) dupeColors.add(p.color);
    seen.add(p.color);
  }
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>${isVsAi ? "Против AI" : "За одним компьютером"}</h2><button class="back-btn" id="back">← Назад</button></div>
        ${
          isVsAi
            ? `<div class="setup-note">Отметьте галочкой 🤖 AI, кем из игроков управляет AI — их ходы применяются сами, с небольшой паузой между действиями, без вашего подтверждения. Остальные — обычные игроки за этим же экраном по очереди, как в хотсите.</div>`
            : ""
        }
        <div class="field-row">
          <label>Число игроков</label>
          <div class="count-stepper">
            <button id="count-dec" ${players.length <= 2 ? "disabled" : ""}>−</button>
            <span class="count-value">${players.length}</span>
            <button id="count-inc" ${players.length >= 6 ? "disabled" : ""}>+</button>
          </div>
        </div>
        <div class="player-rows">
          ${players
            .map(
              (p, i) => `
            <div class="player-row">
              <input type="color" data-idx="${i}" value="${hex(p.color)}">
              <input type="text" data-idx="${i}" value="${p.name}" maxlength="20" placeholder="Игрок ${i + 1}">
              <label class="ai-toggle"><input type="checkbox" data-ai-idx="${i}" ${p.isAI ? "checked" : ""}> 🤖 AI</label>
              ${dupeColors.has(p.color) ? `<span class="color-dupe-note">цвет повторяется</span>` : ""}
            </div>`
            )
            .join("")}
        </div>
        <button class="start-btn" id="start" ${busyMessage ? "disabled" : ""}>${busyMessage ?? "▶ Начать игру"}</button>
      </div>
    </div>`;
  document.querySelector("#back")!.addEventListener("click", () => setScreen("menu"));
  document.querySelector("#count-dec")!.addEventListener("click", () => setPlayerCount(players.length - 1));
  document.querySelector("#count-inc")!.addEventListener("click", () => setPlayerCount(players.length + 1));
  app.querySelectorAll<HTMLInputElement>('input[type="text"]').forEach((input) =>
    input.addEventListener("input", () => {
      players[+input.dataset.idx!].name = input.value;
    })
  );
  app.querySelectorAll<HTMLInputElement>('input[type="color"]').forEach((input) =>
    input.addEventListener("input", () => {
      players[+input.dataset.idx!].color = parseInt(input.value.slice(1), 16);
      render(); // updates the "цвет повторяется" hints live
    })
  );
  app.querySelectorAll<HTMLInputElement>("input[data-ai-idx]").forEach((input) =>
    input.addEventListener("change", () => {
      players[+input.dataset.aiIdx!].isAI = input.checked;
    })
  );
  document.querySelector("#start")!.addEventListener("click", async () => {
    busyMessage = "Создаём партию…";
    render();
    const result = await createRoom(
      players.map((p) => ({ name: p.name.trim() || "Игрок", color: p.color, isAI: p.isAI })),
      isVsAi
    );
    if ("error" in result) {
      busyMessage = null;
      alert(`Не удалось создать партию: ${result.error} (сервер запущен? см. web/server, npm run dev)`);
      render();
      return;
    }
    window.location.href = `/game.html?room=${result.roomId}`;
  });
}

function render() {
  if (screen === "menu") renderMenu();
  else if (screen === "hotseat" || screen === "vsai") renderSetup();
  else if (screen === "instructions") renderInstructions();
  else renderStub();
}

render();
refreshSavedRooms().then(() => {
  if (screen === "menu") render();
});
