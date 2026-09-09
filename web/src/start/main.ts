// Стартовое меню (ТЗ) — выбор режима игры: Против AI / Интернет / За одним компьютером /
// Инструкция. Пока полноценно реализован только «За одним компьютером» (hotseat).
//
// Состояние партии теперь живёт на сервере (web/server), не в этой вкладке — «Начать игру» создаёт
// комнату там (net.ts createRoom), «Загрузить игру» подключается к последней сохранённой (joinRoom).
// game.html получает id комнаты через query-параметр `?room=...` и сам подключается тем же net.ts —
// список игроков (имена/цвета) он теперь читает из состояния сервера, а не из sessionStorage.

import * as net from "../game/net";
import { createRoom, joinRoom, listRooms, type WeGoLobbySlotView } from "../game/net";
import { REF_CATEGORY_META, REF_CATEGORIES, searchReference, type RefCategory, type RefEntry } from "./reference";

type Screen = "menu" | "hotseat" | "vsai" | "instructions" | "load" | "stub" | "wego-setup" | "wego-lobby" | "wego-join";

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

// --- WeGo (лобби со слотами, "Интернет") — см. web/server/src/rooms.ts WeGoLobby ---

interface WeGoSlotDraft {
  kind: "human" | "ai" | "open";
  name: string;
  color: number;
}
let wegoSlots: WeGoSlotDraft[] = [
  { kind: "human", name: "Игрок 1", color: PALETTE[0] },
  { kind: "open", name: "Игрок 2", color: PALETTE[1] },
  { kind: "open", name: "Игрок 3", color: PALETTE[2] },
];
/** Комната, за состоянием слотов которой мы сейчас следим на экране "wego-lobby" — своя (только что
 * создали) ИЛИ та, куда только что зашли по ссылке (см. renderWeGoJoin). */
let wegoLobbyRoomId: string | null = null;
let wegoLobbySlots: WeGoLobbySlotView[] = [];

/** Экран "wego-join" (переход по ссылке-приглашению, ?joinWego=<roomId>) — своё имя/цвет + список
 * слотов лобби, куда заходим (peekWeGoLobby, без привязки к игроку, пока не нажали конкретный слот). */
let wegoJoinRoomId: string | null = null;
let wegoJoinName = "Игрок";
let wegoJoinColor = PALETTE[Math.floor(Math.random() * PALETTE.length)];
let wegoJoinSlots: WeGoLobbySlotView[] = [];
let wegoJoinError: string | null = null;

// Слушатели регистрируются ОДИН раз на весь модуль (не при каждом рендере экрана) — тот же сокет
// живёт, пока вкладка открыта, независимо от смены экрана внутри start.html.
net.onLobbyState((msg) => {
  if (msg.roomId === wegoLobbyRoomId && screen === "wego-lobby") {
    wegoLobbySlots = msg.slots;
    render();
  } else if (msg.roomId === wegoJoinRoomId && screen === "wego-join") {
    wegoJoinSlots = msg.slots;
    render();
  }
});
net.onState((state) => {
  // Пока мы ждём в "wego-lobby", единственный способ получить "state" вообще — партия только что
  // реально стартовала на сервере (до этого момента GameSession для этой комнаты не существует,
  // см. rooms.ts startWeGoLobby) — переходим на игровой экран, ровно как хотсит делает сразу при
  // создании комнаты.
  if (screen === "wego-lobby" && wegoLobbyRoomId && state?.phase) {
    window.location.href = `/game.html?room=${wegoLobbyRoomId}`;
  }
});

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

/** Подключается к выбранной сохранённой комнате (по прямому запросу — «кнопка загрузить могла
 * выбрать сохранение»: раньше тут был только один слот, самый недавний файл, теперь — явный выбор
 * из ВСЕХ сохранений, см. renderLoad, включая ручные снимки «Сохранить партию» из паузы игры). */
async function loadRoom(id: string) {
  busyMessage = "Подключение к сохранённой партии…";
  render();
  const result = await joinRoom(id);
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
        <button class="mode-btn primary" data-mode="online">
          <span class="mode-icon">🌐</span>Интернет
          <span class="mode-note">Своя комната со слотами (люди по ссылке / AI). Ходы — раундами одновременно: 3 мин на раунд, партия до 40 раундов.</span>
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
                 <span class="mode-note">${savedRooms.length === 1 ? `Продолжить «${savedRooms[0].players.join(", ")}».` : `Выбрать одну из ${savedRooms.length} сохранённых партий.`}</span>
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
      else if (mode === "load") setScreen("load");
      else if (mode === "online") setScreen("wego-setup");
      else {
        stubTitle = mode;
        setScreen("stub");
      }
    })
  );
}

/** Выбор сохранения (по прямому запросу — «кнопка загрузить могла выбрать сохранение») — список ВСЕХ
 * файлов на сервере (см. rooms.ts listRooms), самый недавний первым; ручные снимки из «Сохранить
 * партию» (пауза внутри игры, см. game/main.ts) и обычные автосохранённые партии тут вперемешку —
 * для игрока это просто «ещё одно сохранение», без разницы в происхождении. */
function renderLoad() {
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>📂 Загрузить игру</h2><button class="back-btn" id="back">← Назад</button></div>
        ${busyMessage ? `<div class="subtitle">${busyMessage}</div>` : ""}
        <div class="ref-list">
          ${savedRooms
            .map(
              (r) => `
            <button class="ref-item" data-room-id="${r.id}">
              <span class="ref-item-icon">💾</span>
              <span class="ref-item-text"><span class="ref-item-title">${r.players.join(", ")}</span><span class="ref-item-summary">${r.phase} · ${new Date(r.savedAt).toLocaleString("ru-RU")}</span></span>
            </button>`
            )
            .join("")}
        </div>
      </div>
    </div>`;
  document.querySelector("#back")!.addEventListener("click", () => setScreen("menu"));
  app.querySelectorAll<HTMLButtonElement>("[data-room-id]").forEach((row) => row.addEventListener("click", () => loadRoom(row.dataset.roomId!)));
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

function setWegoSlotCount(n: number) {
  n = Math.max(2, Math.min(6, n));
  while (wegoSlots.length < n) wegoSlots.push({ kind: "open", name: `Игрок ${wegoSlots.length + 1}`, color: PALETTE[wegoSlots.length % PALETTE.length] });
  while (wegoSlots.length > n) wegoSlots.pop();
  render();
}

/** Экран создания WeGo-комнаты — слот 0 всегда сам создатель (человек, эта вкладка), остальные —
 * либо AI, либо открытый слот (ссылку на него получат друзья, см. renderWeGoLobby). Таймеры (3 мин/
 * раунд, 90 мин/партия суммарно) и лимит 40 раундов — фиксированные значения по прямому запросу, не
 * настраиваются из этого экрана. */
function renderWeGoSetup() {
  const dupeColors = new Set<number>();
  const seen = new Set<number>();
  for (const s of wegoSlots) {
    if (seen.has(s.color)) dupeColors.add(s.color);
    seen.add(s.color);
  }
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>🌐 Интернет — своя комната</h2><button class="back-btn" id="back">← Назад</button></div>
        <div class="setup-note">Слот 0 — вы. Остальные слоты — либо 🤖 AI, либо открытый (ссылку на присоединение получат друзья на следующем экране). Ход идёт РАУНДАМИ: все живые игроки планируют одновременно, не по очереди — на раунд 3 минуты (не успели — раунд доигрывает AI), на партию суммарно 90 минут игроку (истёк лимит — до конца партии играет AI), партия не длиннее 40 раундов (по истечении — общая победа всем, кроме выбывших).</div>
        <div class="field-row">
          <label>Число слотов</label>
          <div class="count-stepper">
            <button id="count-dec" ${wegoSlots.length <= 2 ? "disabled" : ""}>−</button>
            <span class="count-value">${wegoSlots.length}</span>
            <button id="count-inc" ${wegoSlots.length >= 6 ? "disabled" : ""}>+</button>
          </div>
        </div>
        <div class="player-rows">
          ${wegoSlots
            .map(
              (s, i) => `
            <div class="player-row">
              <input type="color" data-idx="${i}" value="${hex(s.color)}">
              <input type="text" data-idx="${i}" value="${s.name}" maxlength="20" placeholder="Игрок ${i + 1}">
              ${
                i === 0
                  ? `<span class="ai-toggle">Вы (создатель)</span>`
                  : `<label class="ai-toggle"><input type="checkbox" data-ai-idx="${i}" ${s.kind === "ai" ? "checked" : ""}> 🤖 AI (иначе — открытый слот по ссылке)</label>`
              }
              ${dupeColors.has(s.color) ? `<span class="color-dupe-note">цвет повторяется</span>` : ""}
            </div>`
            )
            .join("")}
        </div>
        <button class="start-btn" id="start" ${busyMessage ? "disabled" : ""}>${busyMessage ?? "▶ Создать комнату"}</button>
      </div>
    </div>`;
  document.querySelector("#back")!.addEventListener("click", () => setScreen("menu"));
  document.querySelector("#count-dec")!.addEventListener("click", () => setWegoSlotCount(wegoSlots.length - 1));
  document.querySelector("#count-inc")!.addEventListener("click", () => setWegoSlotCount(wegoSlots.length + 1));
  app.querySelectorAll<HTMLInputElement>('input[type="text"]').forEach((input) =>
    input.addEventListener("input", () => {
      wegoSlots[+input.dataset.idx!].name = input.value;
    })
  );
  app.querySelectorAll<HTMLInputElement>('input[type="color"]').forEach((input) =>
    input.addEventListener("input", () => {
      wegoSlots[+input.dataset.idx!].color = parseInt(input.value.slice(1), 16);
      render();
    })
  );
  app.querySelectorAll<HTMLInputElement>("input[data-ai-idx]").forEach((input) =>
    input.addEventListener("change", () => {
      wegoSlots[+input.dataset.aiIdx!].kind = input.checked ? "ai" : "open";
    })
  );
  document.querySelector("#start")!.addEventListener("click", async () => {
    busyMessage = "Создаём комнату…";
    render();
    const result = await net.createWeGoRoom(
      wegoSlots.map((s) => ({ kind: s.kind, name: s.name.trim() || "Игрок", color: s.color })),
      180,
      5400
    );
    busyMessage = null;
    if ("error" in result) {
      alert(`Не удалось создать комнату: ${result.error} (сервер запущен? см. web/server, npm run dev)`);
      render();
      return;
    }
    wegoLobbyRoomId = result.roomId;
    wegoLobbySlots = wegoSlots.map((s, i) => ({ index: i, kind: s.kind, name: s.name.trim() || "Игрок", color: s.color, connected: s.kind === "human" }));
    setScreen("wego-lobby");
  });
}

/** Комната создана/куда-то присоединились — ждём, пока закроются все "open" слоты (сами по ссылке,
 * либо хост нажмёт «Начать досрочно»). Партия стартует на сервере САМА, как только слотов "open" не
 * останется — переход на game.html происходит по подписке net.onState выше (первый настоящий "state"
 * для этой комнаты означает, что GameSession уже создана). */
function renderWeGoLobby() {
  const link = wegoLobbyRoomId ? `${location.origin}/start.html?joinWego=${wegoLobbyRoomId}` : "";
  const isHost = net.myWeGoPlayer() === 0;
  const openCount = wegoLobbySlots.filter((s) => s.kind === "open").length;
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>🌐 Ожидание игроков</h2></div>
        <div class="setup-note">Отправьте эту ссылку друзьям — по ней каждый займёт свободный слот. Как только свободных слотов не останется (или вы нажмёте «Начать досрочно»), партия начнётся сама.</div>
        <input type="text" id="invite-link" class="ref-search" readonly value="${link}">
        <button class="back-btn" id="copy-link">📋 Скопировать ссылку</button>
        <div class="player-rows">
          ${wegoLobbySlots
            .map(
              (s) => `
            <div class="player-row">
              <span class="slot-color-dot" style="background:${hex(s.color)}"></span>
              <span>${s.name}</span>
              <span class="ai-toggle">${s.kind === "ai" ? "🤖 AI" : s.kind === "open" ? "⏳ Ждём игрока…" : s.connected ? "✅ Подключён" : "⚠ Отключён"}</span>
            </div>`
            )
            .join("")}
        </div>
        ${isHost && openCount > 0 ? `<button class="start-btn" id="start-early">▶ Начать досрочно (оставшиеся слоты — AI)</button>` : ""}
      </div>
    </div>`;
  document.querySelector<HTMLButtonElement>("#copy-link")!.addEventListener("click", () => {
    navigator.clipboard?.writeText(link).catch(() => {});
  });
  document.querySelector<HTMLButtonElement>("#start-early")?.addEventListener("click", () => net.startWeGoRoomEarly());
}

/** Переход по ссылке-приглашению (?joinWego=<roomId>) — сначала «подсматриваем» состав слотов
 * (net.peekWeGoLobby, без привязки к игроку), даём выбрать своё имя/цвет и КОНКРЕТНЫЙ открытый слот. */
async function loadWeGoJoinScreen(roomId: string) {
  wegoJoinRoomId = roomId;
  wegoJoinError = null;
  wegoJoinSlots = [];
  render();
  const result = await net.peekWeGoLobby(roomId);
  if ("error" in result) {
    wegoJoinError = result.error;
    render();
    return;
  }
  wegoJoinSlots = result.slots;
  render();
}

function renderWeGoJoin() {
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>🌐 Присоединиться к комнате</h2><button class="back-btn" id="back">← В меню</button></div>
        ${wegoJoinError ? `<div class="setup-note">Не удалось открыть комнату: ${wegoJoinError}</div>` : ""}
        ${
          !wegoJoinError && wegoJoinSlots.length === 0
            ? `<div class="setup-note">Загрузка…</div>`
            : !wegoJoinError
              ? `
          <div class="field-row">
            <label>Ваше имя</label>
            <input type="text" id="join-name" value="${wegoJoinName}" maxlength="20">
          </div>
          <div class="field-row">
            <label>Цвет</label>
            <input type="color" id="join-color" value="${hex(wegoJoinColor)}">
          </div>
          <div class="setup-note">Выберите свободный слот:</div>
          <div class="player-rows">
            ${wegoJoinSlots
              .map(
                (s) => `
              <button class="ref-item" data-slot="${s.index}" ${s.kind !== "open" ? "disabled" : ""}>
                <span class="ref-item-text"><span class="ref-item-title">${s.name}</span><span class="ref-item-summary">${
                  s.kind === "ai" ? "🤖 AI — занято" : s.kind === "open" ? "⏳ Свободно — нажмите, чтобы занять" : "занято"
                }</span></span>
              </button>`
              )
              .join("")}
          </div>
          ${wegoJoinSlots.every((s) => s.kind !== "open") ? `<div class="setup-note">Свободных слотов не осталось — комната уже заполнена.</div>` : ""}
        `
              : ""
        }
      </div>
    </div>`;
  document.querySelector("#back")!.addEventListener("click", () => setScreen("menu"));
  const nameInput = document.querySelector<HTMLInputElement>("#join-name");
  nameInput?.addEventListener("input", () => {
    wegoJoinName = nameInput.value;
  });
  const colorInput = document.querySelector<HTMLInputElement>("#join-color");
  colorInput?.addEventListener("input", () => {
    wegoJoinColor = parseInt(colorInput.value.slice(1), 16);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-slot]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const slotIndex = Number(btn.dataset.slot);
      busyMessage = "Присоединяемся…";
      render();
      const result = await net.joinWeGoSlot(wegoJoinRoomId!, slotIndex, wegoJoinName.trim() || "Игрок", wegoJoinColor);
      busyMessage = null;
      if ("error" in result) {
        alert(`Не удалось присоединиться: ${result.error}`);
        render();
        return;
      }
      wegoLobbyRoomId = wegoJoinRoomId;
      wegoLobbySlots = wegoJoinSlots.map((s) => (s.index === slotIndex ? { ...s, kind: "human" as const, name: wegoJoinName.trim() || "Игрок", color: wegoJoinColor, connected: true } : s));
      setScreen("wego-lobby");
    })
  );
}

function render() {
  if (screen === "menu") renderMenu();
  else if (screen === "hotseat" || screen === "vsai") renderSetup();
  else if (screen === "instructions") renderInstructions();
  else if (screen === "load") renderLoad();
  else if (screen === "wego-setup") renderWeGoSetup();
  else if (screen === "wego-lobby") renderWeGoLobby();
  else if (screen === "wego-join") renderWeGoJoin();
  else renderStub();
}

const joinWegoParam = new URLSearchParams(location.search).get("joinWego");
if (joinWegoParam) {
  screen = "wego-join";
  loadWeGoJoinScreen(joinWegoParam);
}

render();
refreshSavedRooms().then(() => {
  if (screen === "menu") render();
});
