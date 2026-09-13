// Условные SVG-иконки для карт (cards.ts) и категорий юнитов (units.ts) — по прямому запросу,
// взамен одиночных эмодзи-заглушек (⚡/🂠 у всех карт без разбора, CATEGORY_META.icon у юнитов).
// Плоский минималистичный стиль, viewBox 0 0 64 64, без внешних зависимостей — безопасно вставлять
// через innerHTML где угодно в DOM. CATEGORY_META.icon (main.ts, units.ts) — те же самые эмодзи,
// что и раньше — оставлены как есть для мест, где нужен просто текстовый символ (тултипы и т.п.),
// эти SVG — только для крупных визуальных слотов (карта в руке, панель выбора юнита).

/** Один SVG-значок на тип карты (cards.ts CardDef.id) — большие, читаемые формы, чтобы заполнять
 * большую часть слота карты (92×128, см. style.css --card-w/--card-h). */
export const CARD_ICON_SVG: Record<string, string> = {
  settler: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 50 L32 14 L52 50 Z" fill="#8a5a34" stroke="#5c3a20" stroke-width="2"/>
    <rect x="27" y="36" width="10" height="14" fill="#3a2414"/>
    <rect x="10" y="50" width="44" height="4" rx="1" fill="#4f7a3a"/>
    <path d="M32 14 L32 4" stroke="#c9a227" stroke-width="3" stroke-linecap="round"/>
    <path d="M32 4 L44 8 L32 12 Z" fill="#c9a227"/>
  </svg>`,
  warrior: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="29" y="6" width="6" height="34" rx="2" fill="#c7d0d9" stroke="#6b7683" stroke-width="1.5"/>
    <rect x="18" y="38" width="28" height="6" rx="2" fill="#c9a227"/>
    <rect x="28" y="43" width="8" height="15" rx="2" fill="#8a5a34"/>
    <circle cx="32" cy="60" r="3.5" fill="#c9a227"/>
  </svg>`,
  builder: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="12" y="34" width="40" height="9" fill="#a9673a" stroke="#5c3a20" stroke-width="1.5"/>
    <rect x="12" y="45" width="40" height="9" fill="#c07f4a" stroke="#5c3a20" stroke-width="1.5"/>
    <rect x="17" y="45" width="9" height="9" fill="#a9673a"/>
    <rect x="38" y="45" width="9" height="9" fill="#a9673a"/>
    <g transform="rotate(-40 46 20)">
      <rect x="43" y="6" width="6" height="26" rx="2" fill="#8a5a34"/>
      <rect x="36" y="4" width="20" height="9" rx="2" fill="#7c8794"/>
    </g>
  </svg>`,
  worker: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="29" y="14" width="6" height="40" rx="2" fill="#8a5a34"/>
    <path d="M32 8 C20 8 12 16 10 26 C18 22 26 20 32 20 C38 20 46 22 54 26 C52 16 44 8 32 8 Z" fill="#7c8794" stroke="#4c545e" stroke-width="1.5"/>
  </svg>`,
  scientist: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M27 8 H37 V24 L48 50 C50 55 47 58 42 58 H22 C17 58 14 55 16 50 L27 24 Z" fill="#1f6f78" stroke="#123d42" stroke-width="2"/>
    <path d="M19.5 44 H44.5" stroke="#123d42" stroke-width="2"/>
    <rect x="25" y="6" width="14" height="5" rx="1.5" fill="#7c8794"/>
    <circle cx="30" cy="50" r="2.5" fill="#7fe0d8"/>
    <circle cx="37" cy="47" r="2" fill="#7fe0d8"/>
    <circle cx="33" cy="53" r="1.6" fill="#7fe0d8"/>
  </svg>`,
  trader: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="32" cy="46" rx="15" ry="6" fill="#a9821f" stroke="#6b5313" stroke-width="1.5"/>
    <ellipse cx="32" cy="36" rx="15" ry="6" fill="#c9a227" stroke="#6b5313" stroke-width="1.5"/>
    <ellipse cx="32" cy="26" rx="15" ry="6" fill="#e0bc3f" stroke="#6b5313" stroke-width="1.5"/>
    <text x="32" y="30" text-anchor="middle" font-size="9" font-weight="700" fill="#6b5313">$</text>
  </svg>`,
  sale: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 32 L26 12 H54 V52 H26 Z" fill="#d9622b" stroke="#7a3010" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="19" cy="22" r="4" fill="#fff" stroke="#7a3010" stroke-width="1.5"/>
    <text x="42" y="39" text-anchor="middle" font-size="18" font-weight="700" fill="#fff">%</text>
  </svg>`,
  /** «Право прокладки маршрута» — не считается в лимит руки, не имеет цены (по прямому запросу —
   * «картам без дизайна тоже нужен какой-то»): дорога-фолбэк (пунктир) с бейджем «повторить»
   * (кольцевая стрелка) в углу — вторая попытка проложить маршрут другой парой городов. */
  routeRight: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 54 C14 34 24 34 24 24 C24 14 34 14 34 8" stroke="#8a8f97" stroke-width="6" fill="none" stroke-linecap="round" stroke-dasharray="7 6"/>
    <circle cx="46" cy="18" r="12" fill="none" stroke="#2e4f70" stroke-width="4"/>
    <path d="M46 6 L52 12 L44 14 Z" fill="#2e4f70"/>
  </svg>`,
  taxes: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M32 10 L38 18 C50 18 56 28 56 38 C56 50 46 58 32 58 C18 58 8 50 8 38 C8 28 14 18 26 18 Z" fill="#c9a227" stroke="#6b5313" stroke-width="2"/>
    <path d="M27 12 Q32 4 37 12" stroke="#6b5313" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <text x="32" y="42" text-anchor="middle" font-size="16" font-weight="700" fill="#6b5313">$</text>
  </svg>`,
  catastrophe: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M32 8 L58 54 H6 Z" fill="#c0392b" stroke="#7a1f16" stroke-width="2.5" stroke-linejoin="round"/>
    <rect x="29" y="24" width="6" height="16" rx="2" fill="#fff"/>
    <circle cx="32" cy="46" r="3.2" fill="#fff"/>
  </svg>`,
  forestGrowth: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="28" y="42" width="8" height="16" rx="2" fill="#5c3a20"/>
    <circle cx="32" cy="30" r="16" fill="#3f7a3f"/>
    <circle cx="20" cy="24" r="11" fill="#4c8f4c"/>
    <circle cx="44" cy="24" r="11" fill="#4c8f4c"/>
  </svg>`,
  tradeRoute: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="46" r="7" fill="#5a8fc7" stroke="#2e4f70" stroke-width="2"/>
    <circle cx="52" cy="18" r="7" fill="#c9a227" stroke="#6b5313" stroke-width="2"/>
    <path d="M15 41 Q32 20 47 21" stroke="#8a8f97" stroke-width="3" stroke-dasharray="5 5" fill="none"/>
    <rect x="26" y="30" width="14" height="9" rx="2" fill="#a9673a" stroke="#5c3a20" stroke-width="1.5"/>
    <circle cx="29" cy="41" r="2.5" fill="#3a2414"/>
    <circle cx="37" cy="41" r="2.5" fill="#3a2414"/>
  </svg>`,
  mobilization: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="18" y="10" width="5" height="48" rx="1.5" fill="#8a5a34"/>
    <path d="M23 12 H50 L42 22 L50 32 H23 Z" fill="#c0392b" stroke="#7a1f16" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`,
};

/** Один SVG-значок на категорию юнита (units.ts UnitCategory) — та же плоская стилистика, для
 * панели выбора юнита и карточки юнита при наведении. */
export const UNIT_ICON_SVG: Record<string, string> = {
  support: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8 C34 12 34 52 16 56" stroke="#8a5a34" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <path d="M17 9 L47 32 L17 55" stroke="#d8d0b8" stroke-width="1.5" fill="none"/>
    <line x1="17" y1="32" x2="52" y2="32" stroke="#3a2414" stroke-width="2"/>
  </svg>`,
  ranged: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="30" cy="38" r="18" fill="#333c46" stroke="#14181e" stroke-width="2"/>
    <path d="M40 24 L48 14" stroke="#5c3a20" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M48 14 L44 10 M48 14 L52 18 M48 14 L44 18 M48 14 L52 10" stroke="#e08a3f" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,
  mobile: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 50 C12 38 16 26 26 20 L26 12 L34 18 C44 16 52 24 52 34 L52 50 L44 50 L44 42 L36 42 L36 50 L28 50 L28 44 L20 50 Z" fill="#8a5a34" stroke="#5c3a20" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="42" cy="26" r="2" fill="#1a1410"/>
  </svg>`,
  assault: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(-30 24 24)"><rect x="21" y="4" width="6" height="30" rx="2" fill="#c7d0d9"/><rect x="15" y="30" width="18" height="6" rx="2" fill="#c9a227"/><rect x="20" y="35" width="8" height="13" rx="2" fill="#8a5a34"/></g>
    <g transform="rotate(30 40 24)"><rect x="37" y="4" width="6" height="30" rx="2" fill="#c7d0d9"/><rect x="31" y="30" width="18" height="6" rx="2" fill="#c9a227"/><rect x="36" y="35" width="8" height="13" rx="2" fill="#8a5a34"/></g>
  </svg>`,
  defense: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M32 6 L54 14 V32 C54 46 45 55 32 60 C19 55 10 46 10 32 V14 Z" fill="#3a5a80" stroke="#1c3450" stroke-width="2.5"/>
    <path d="M32 16 V50 M20 26 H44" stroke="#a9c4e0" stroke-width="2.5"/>
  </svg>`,
  ship: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 42 H54 L46 54 H18 Z" fill="#8a5a34" stroke="#5c3a20" stroke-width="2" stroke-linejoin="round"/>
    <rect x="30" y="8" width="3" height="34" fill="#5c3a20"/>
    <path d="M33 10 L50 34 H33 Z" fill="#e8e2cf" stroke="#a89f83" stroke-width="1.5"/>
    <path d="M30 16 L16 34 H30 Z" fill="#f2eeda" stroke="#a89f83" stroke-width="1.5"/>
  </svg>`,
};

/** Инлайн-иконка юнита нужного пикселького размера — для строчных мест (списки/панели), где во
 * весь SVG-блок разворачивать незачем, просто нужна картинка вместо эмодзи. */
export function unitIconHtml(category: string, sizePx: number): string {
  const svg = UNIT_ICON_SVG[category];
  if (!svg) return "";
  return `<span style="display:inline-block;width:${sizePx}px;height:${sizePx}px;vertical-align:middle">${svg}</span>`;
}
