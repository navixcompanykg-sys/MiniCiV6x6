// Стартовое меню (ТЗ) — выбор режима игры: Против AI / Интернет / За одним компьютером /
// Инструкция. Пока полноценно реализован только «За одним компьютером» (hotseat).
//
// Состояние партии теперь живёт на сервере (web/server), не в этой вкладке — «Начать игру» создаёт
// комнату там (net.ts createRoom), «Загрузить игру» подключается к последней сохранённой (joinRoom).
// game.html получает id комнаты через query-параметр `?room=...` и сам подключается тем же net.ts —
// список игроков (имена/цвета) он теперь читает из состояния сервера, а не из sessionStorage.

import { createRoom, joinRoom, listRooms } from "../game/net";

type Screen = "menu" | "hotseat" | "instructions" | "stub";

const PALETTE = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22];

interface PlayerDraft {
  name: string;
  color: number;
}

let screen: Screen = "menu";
let stubTitle = "";
let players: PlayerDraft[] = [0, 1, 2].map((i) => ({ name: `Игрок ${i + 1}`, color: PALETTE[i] }));
let busyMessage: string | null = null;
let savedRooms: { id: string; players: string[]; phase: string; savedAt: string }[] = [];

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
        <button class="mode-btn" data-mode="ai">
          <span class="mode-icon">🤖</span>Против AI
          <span class="mode-note">Не реализовано — в клиенте пока нет ни одного ИИ-игрока.</span>
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
      else if (mode === "instructions") setScreen("instructions");
      else if (mode === "load") loadLastRoom();
      else {
        stubTitle = mode === "ai" ? "Против AI" : "Интернет";
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

function renderInstructions() {
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>Инструкция</h2><button class="back-btn" id="back">← Назад</button></div>
        <div class="instructions">
          <h3>Цикл и ходы</h3>
          <ul>
            <li>Игра идёт по циклам — каждый цикл все игроки ходят по разу, по очереди.</li>
            <li>За ход — фиксированное число действий (карты); движение и приказы юнитам действий не тратят.</li>
            <li>Карты приходят в руку из общей колоды; переполнение руки (8+) сбрасывает её целиком со штрафом.</li>
          </ul>
          <h3>Города и ресурсы</h3>
          <ul>
            <li>Столица кормит ресурсами автоматически каждый цикл; остальные города — только картой «Рабочий» или зданием Склад.</li>
            <li>Склад хранит до 6 единиц (12 со зданием Склад), не копится сверх лимита.</li>
            <li>Вражеский юнит на клетке с ресурсом блокирует её добычу, пока не уйдёт.</li>
          </ul>
          <h3>Карты действий и событий</h3>
          <ul>
            <li>Действия: Поселенец, Воин, Строитель, Рабочий, Учёный, Торговец — открывают выбор цели на карте/в списке городов.</li>
            <li>События (Население, Налоги, Катастрофа, Рост леса, Торговый путь, Мобилизация) нельзя сбросить — их эффект срабатывает всегда, добровольно или принудительно.</li>
            <li>Карту действия можно выставить на продажу другому игроку вместо розыгрыша — цена 1–10💰.</li>
          </ul>
          <h3>Здания и технологии</h3>
          <ul>
            <li>Дерево технологий — 4 ветки × 6 эпох, лидер каждой ветки продвигается первым, остальные не более чем на 1 технологию позади.</li>
            <li>Здание можно построить, когда его технология открыта и хватает ресурсов (Строитель); до 2 игроков могут владеть одним и тем же зданием.</li>
          </ul>
          <h3>Юниты и бой</h3>
          <ul>
            <li>Выбор юнита — клик по своей клетке/городу, дальше клик по цели: пустой гекс — движение, чужой юнит/город — атака.</li>
            <li>Защита принадлежит клетке (лес/холмы/горы/город/своя территория/форт/дорога), а не юниту, и снимается первой при уроне, до здоровья.</li>
            <li>Корабли — «плавающая артиллерия»: бьют по всем на клетке цели сразу, возят 1 сухопутный юнит как по мосту, заходят в города.</li>
            <li>Пустой гарнизон города обороняется его населением; захват — только явным входом юнита при нулевой защите.</li>
          </ul>
          <h3>Дипломатия</h3>
          <ul>
            <li>Круговая схема — клик по игроку открывает составитель предложения (статус, деньги, города, ресурсы, ультиматум).</li>
            <li>Атака без объявления войны или вход на чужую территорию без «Открытых границ» — начинает войну (с подтверждением).</li>
          </ul>
        </div>
      </div>
    </div>`;
  document.querySelector("#back")!.addEventListener("click", () => setScreen("menu"));
}

function setPlayerCount(n: number) {
  n = Math.max(2, Math.min(6, n));
  while (players.length < n) players.push({ name: `Игрок ${players.length + 1}`, color: PALETTE[players.length % PALETTE.length] });
  while (players.length > n) players.pop();
  render();
}

function renderHotseat() {
  const dupeColors = new Set<number>();
  const seen = new Set<number>();
  for (const p of players) {
    if (seen.has(p.color)) dupeColors.add(p.color);
    seen.add(p.color);
  }
  app.innerHTML = `
    <div class="shell">
      <div class="panel">
        <div class="panel-head"><h2>За одним компьютером</h2><button class="back-btn" id="back">← Назад</button></div>
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
  document.querySelector("#start")!.addEventListener("click", async () => {
    busyMessage = "Создаём партию…";
    render();
    const result = await createRoom(players.map((p) => ({ name: p.name.trim() || "Игрок", color: p.color })));
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
  else if (screen === "hotseat") renderHotseat();
  else if (screen === "instructions") renderInstructions();
  else renderStub();
}

render();
refreshSavedRooms().then(() => {
  if (screen === "menu") render();
});
