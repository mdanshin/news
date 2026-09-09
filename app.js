/*
  GitHub Pages friendly: vanilla JS, no build step.

  IMPORTANT:
  Browsers cannot reliably fetch and parse full articles from random news sites
  (CORS / paywalls / bot protection). Therefore the project uses a prebuilt
  JSON snapshot at data/news.json.

  Generate locally: `npm ci && npm run build:data`
  Or enable GitHub Action: .github/workflows/update-data.yml
*/

const CATEGORY_DEFS = [
  { id: "world", name: "Мир" },
  { id: "ru", name: "Россия" },
  { id: "business", name: "Бизнес" },
  { id: "tech", name: "Технологии" },
  { id: "ai", name: "ИИ" },
  // `chipName` carries a soft hyphen so the narrow sidebar breaks the word
  // at a syllable instead of mid-word.
  { id: "security", name: "Кибербезопасность", chipName: "Кибер­безопасность" },
  { id: "science", name: "Наука" },
  { id: "health", name: "Здоровье" },
  { id: "sports", name: "Спорт" },
  { id: "culture", name: "Культура" }
];

// Local interface icons: no additional runtime or external icon requests.
const TOPIC_ICONS = {
  world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  ru: '<path d="m3 9 9-6 9 6H3Zm2 3v6m5-6v6m4-6v6m5-6v6M3 21h18"/>',
  business: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12c5 3 13 3 18 0M12 12v4"/>',
  tech: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5M10 10h4v4h-4z"/>',
  ai: '<path d="M8 4.5A3.5 3.5 0 0 1 14.2 3a3.5 3.5 0 0 1 4.3 4.3A3.5 3.5 0 0 1 20 13.5a3.5 3.5 0 0 1-4.3 4.3A3.5 3.5 0 0 1 9.5 19a3.5 3.5 0 0 1-4.3-4.3A3.5 3.5 0 0 1 4 8.5 3.5 3.5 0 0 1 8 4.5Z"/><path d="M9 9v6m6-6v6M7.5 12h3m3 0h3"/>',
  security: '<path d="M12 3 4 6v6c0 5 3.4 8.6 8 9.5 4.6-.9 8-4.5 8-9.5V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  science: '<path d="M9 3h6M10 3v7L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M7 15h10"/>',
  health: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  sports: '<path d="M8 3h8v7a4 4 0 0 1-8 0V3ZM8 5H3v3a4 4 0 0 0 5 4m8-7h5v3a4 4 0 0 1-5 4m-4 2v7m-5 0h10"/>',
  culture: '<path d="M12 5C8 2 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-5-2-9 1Zm0 0v15"/>'
};

const DATA_URL = "data/news.json";
const BATCH_SIZE = 12;
const STORAGE_KEY = "news:selectedCats:v2";
// Sources are stored as an exclusion list so that a source added later is
// visible by default.
const HIDDEN_SOURCES_KEY = "news:hiddenSources:v1";
const READER_FONT_KEY = "news:readerFontPx:v1";
const THEME_KEY = "news:theme:v1";
const READER_FONT_DEFAULT = 18;
const READER_FONT_MIN = 14;
const READER_FONT_MAX = 26;
const READER_FONT_STEP = 1;

const LOCAL_REBUILD_PATH = "/__rebuild";
const END_POLL_INTERVAL_MS = 20 * 1000;

const AUTO_REFRESH_MS = 3 * 60 * 1000;
const IS_AI_SECTION = document.body.dataset.section === "ai";
let lastAutoRefreshAttemptAt = 0;

const $ = (sel) => document.querySelector(sel);
const elGrid = $("#grid");
const elChips = $("#chips");
const elSources = $("#sources");
const elSourcesBlock = $("#sourcesBlock");
const elSourcesAllBtn = $("#sourcesAllBtn");
const elStatus = $("#status");
const elEndText = $("#endText");
const elEnd = $("#end");
const elRefreshBtn = $("#refreshBtn");
const elClearBtn = $("#clearBtn");
const elSelectAllBtn = $("#selectAllBtn");
const elModal = $("#modal");
const elModalTitle = $("#modalTitle");
const elModalMeta = $("#modalMeta");
const elModalBody = $("#modalBody");
const elModalLink = $("#modalLink");
const elFontDownBtn = $("#fontDownBtn");
const elFontUpBtn = $("#fontUpBtn");
const elFontResetBtn = $("#fontResetBtn");
const elPageShell = $("#pageShell");
const elModalCard = $(".modal__card");
const elModalClose = $("#modalClose");
const elFeedTitle = $("#feedTitle");
const elFeedState = $("#feedState");
const elStateAction = $("#stateAction");
const elSkeletons = $("#skeletons");
const elEndSpinner = $("#endSpinner");
const elThemeToggle = $("#themeToggle");
const elThemeColor = $("#themeColor");

/** @type {Set<string>} */
let selected = new Set(IS_AI_SECTION ? ["ai"] : ["tech"]);

/** Source ids the reader switched off. @type {Set<string>} */
let hiddenSources = new Set();

/** @type {{generatedAt?: string, items?: any[]}} */
let data = { generatedAt: "", items: [] };

/** @type {Array<any>} */
let filtered = [];
let rendered = 0;
let lastFocusedElement = null;
let isLoading = false;
let loadError = false;
let stateActionMode = "all";

let readerFontPx = READER_FONT_DEFAULT;

let endPollTimer = 0;

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "light" ? value : "";
  } catch {
    return "";
  }
}

function systemTheme() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  elThemeColor.content = dark ? "#0e1013" : "#fafafa";
  elThemeToggle.setAttribute("aria-pressed", String(dark));
  elThemeToggle.setAttribute("aria-label", dark ? "Включить светлую тему" : "Включить тёмную тему");
  elThemeToggle.title = dark ? "Светлая тема" : "Тёмная тема";
}

function initTheme() {
  applyTheme(savedTheme() || systemTheme());
  elThemeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The selected theme still applies for the current page.
    }
    applyTheme(next);
  });
  if (typeof window.matchMedia !== "function") return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const syncWithSystem = () => {
    if (!savedTheme()) applyTheme(media.matches ? "dark" : "light");
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", syncWithSystem);
  else if (typeof media.addListener === "function") media.addListener(syncWithSystem);
}

function isLocalHost() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function setStatus(text, error = false) {
  elStatus.textContent = text;
  elStatus.classList.toggle("is-error", error);
}

function setLoading(active) {
  isLoading = active;
  elRefreshBtn.disabled = active;
  elRefreshBtn.classList.toggle("is-loading", active);
  elGrid.setAttribute("aria-busy", String(active));
  elEndSpinner.hidden = !active;
  elSkeletons.hidden = !active || data.items.length > 0;
  if (active && !data.items.length) elFeedState.hidden = true;
}

function plural(n, forms) {
  const v = Math.abs(n) % 100;
  return forms[v > 10 && v < 20 ? 2 : v % 10 === 1 ? 0 : v % 10 >= 2 && v % 10 <= 4 ? 1 : 2];
}

function compactTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `Сегодня, ${time}`;
  const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }).format(date);
  return `${day}, ${time}`;
}

function safeHttpUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function isAiNews(title, excerpt) {
  const text = `${title || ""} ${excerpt || ""}`.toLowerCase();
  return /(?:искусственн(?:ый|ого|ому|ым|ом) интеллект|нейросет|нейронн(?:ая|ые|ой|ую) сет|генеративн(?:ый|ого|ому|ым|ом) ии|машинн(?:ое|ого|ому|ым|ом) обучен|больш(?:ая|ой|ую|ие|их) языков(?:ая|ой|ую|ые|ых) модел|(?:^|[^а-яёa-z0-9])ии(?:$|[^а-яёa-z0-9])|\bartificial intelligence\b|\bgenerative ai\b|\bmachine learning\b|\bdeep learning\b|\blarge language models?\b|\bllms?\b|\bchatgpt\b|\bopenai\b|\banthropic\b|\bclaude (?:ai|\d|model)\b|(?:модель|model)\s+claude\b|\bgoogle gemini\b|(?:модель|model)\s+gemini\b|\bgemini (?:ai|\d)\b|\bgpt-?\d)/i.test(text);
}

function isSecurityNews(title, excerpt) {
  const text = `${title || ""} ${excerpt || ""}`.toLowerCase();
  return /(?:кибер(?!спорт)|хакер|взлом|уязвимост|вредонос|шифровальщик|фишинг|эксплойт|ботнет|троян|бэкдор|антивирус|пентест|инфобез|даркнет|информационн(?:ая|ой|ую) безопасност|утечк[а-я]* (?:данных|персональн|баз|информац|парол)|\bddos\b|\bmalware\b|\bransomware\b|\bphishing\b|\bvulnerabilit|\bcve-\d{4}-\d+|\bexploit|\bzero-day\b|\b0-day\b|\binfostealer|\bdata breach|\bcyber ?(?:attack|security|crime|threat)|\bhackers?\b|\bhacked\b|\bbotnet\b|\bbackdoor\b|\bdark ?web\b)/i.test(text);
}

/** Sources present in the loaded snapshot, alphabetically by name. */
function knownSources() {
  const byId = new Map();
  for (const item of data.items) {
    if (!item.sourceId || byId.has(item.sourceId)) continue;
    byId.set(item.sourceId, { id: item.sourceId, name: item.sourceName || item.sourceId });
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function isSourceVisible(item) {
  return !item.sourceId || !hiddenSources.has(item.sourceId);
}

function updateOverview() {
  const ids = selectedIds();
  const allSelected = ids.length === CATEGORY_DEFS.length;
  const title = IS_AI_SECTION ? "Искусственный интеллект" : allSelected ? "Все новости" : ids.length === 1 ? categoryById(ids[0]).name : "Ваша лента";
  elFeedTitle.textContent = title;
  document.title = `${title} — Лента`;
  elSelectAllBtn.setAttribute("aria-pressed", String(allSelected));
  elClearBtn.disabled = ids.length === 0;
  $("#resultCount").textContent = `${filtered.length.toLocaleString("ru-RU")} ${plural(filtered.length, ["материал", "материала", "материалов"])}`;
  const allowed = new Set(CATEGORY_DEFS.map((c) => c.id));
  const visible = data.items.filter(isSourceVisible);
  $("#allCount").textContent = visible.filter((item) => item.categoryIds.some((id) => allowed.has(id))).length.toLocaleString("ru-RU");
  for (const category of CATEGORY_DEFS) {
    const count = visible.filter((item) => item.categoryIds.includes(category.id)).length;
    const element = document.getElementById(`count-${category.id}`);
    if (element) element.textContent = count.toLocaleString("ru-RU");
  }
  const sourceScope = IS_AI_SECTION ? data.items.filter((item) => item.categoryIds.includes("ai")) : data.items;
  for (const source of knownSources()) {
    const element = document.getElementById(`count-src-${source.id}`);
    if (element) element.textContent = sourceScope.filter((item) => item.sourceId === source.id).length.toLocaleString("ru-RU");
  }
  if (elSourcesAllBtn) elSourcesAllBtn.disabled = hiddenSources.size === 0;
  const generatedAt = toAbsTime(data.generatedAt);
  const updated = $("#updatedAt");
  updated.textContent = generatedAt || "—";
  if (generatedAt) updated.dateTime = data.generatedAt;
  else updated.removeAttribute("datetime");
  const total = new Set(sourceScope.map((item) => item.sourceId || item.sourceName).filter(Boolean)).size;
  const shown = new Set(sourceScope.filter(isSourceVisible).map((item) => item.sourceId || item.sourceName).filter(Boolean)).size;
  const summary = !total
    ? "Новости из разных источников"
    : shown === total
      ? `${total} ${plural(total, ["источник", "источника", "источников"])} в общей ленте`
      : `${shown} из ${total} ${plural(total, ["источника", "источников", "источников"])} в ленте`;
  $("#sourceSummary").textContent = summary;
}

function updateEmptyState() {
  elFeedState.hidden = isLoading || filtered.length > 0;
  if (elFeedState.hidden) return;
  let title, description;
  stateActionMode = "all";
  if (loadError && !data.items.length) {
    title = "Не удалось загрузить новости";
    description = "Проверьте подключение к интернету и попробуйте ещё раз.";
    stateActionMode = "retry";
  } else if (IS_AI_SECTION) {
    title = "Новости об ИИ скоро появятся";
    description = "Проверьте обновления: раздел автоматически собирает публикации об искусственном интеллекте.";
    stateActionMode = "retry";
  } else if (!selected.size) {
    title = "Что вам интересно?";
    description = "Выберите темы в меню или откройте общую ленту новостей.";
  } else if (!data.items.length) {
    title = "Новости скоро появятся";
    description = "Здесь будут новые публикации. Попробуйте обновить ленту чуть позже.";
    stateActionMode = "retry";
  } else if (hiddenSources.size && !data.items.some(isSourceVisible)) {
    title = "Все источники выключены";
    description = "Включите хотя бы один источник в меню, чтобы увидеть новости.";
    stateActionMode = "sources";
  } else {
    title = "В этих темах пока тихо";
    description = "Выберите другие темы или посмотрите все последние новости.";
  }
  $("#stateTitle").textContent = title;
  $("#stateText").textContent = description;
  elStateAction.textContent = stateActionMode === "retry" ? "Попробовать ещё раз" : stateActionMode === "sources" ? "Включить все источники" : "Показать все новости";
}

function formatDate(d) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function toAbsTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDate(d);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clampInt(n, min, max) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function applyReaderFont() {
  document.documentElement.style.setProperty("--reader-font-size", `${readerFontPx / 16}rem`);
  elFontDownBtn.disabled = readerFontPx <= READER_FONT_MIN;
  elFontUpBtn.disabled = readerFontPx >= READER_FONT_MAX;
}

function loadReaderFont() {
  try {
    const raw = localStorage.getItem(READER_FONT_KEY);
    if (!raw) return;
    readerFontPx = clampInt(raw, READER_FONT_MIN, READER_FONT_MAX);
  } catch {
    // ignore
  }
}

function saveReaderFont() {
  try {
    localStorage.setItem(READER_FONT_KEY, String(readerFontPx));
  } catch {
    // ignore
  }
}

function bumpReaderFont(delta) {
  readerFontPx = clampInt(readerFontPx + delta, READER_FONT_MIN, READER_FONT_MAX);
  applyReaderFont();
  saveReaderFont();
}

function resetReaderFont() {
  readerFontPx = READER_FONT_DEFAULT;
  applyReaderFont();
  saveReaderFont();
}

function sanitizeHtml(html) {
  // Allow a small safe subset; remove all scripts/handlers.
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;

  const allowed = new Set([
    "P",
    "BR",
    "B",
    "STRONG",
    "I",
    "EM",
    "A",
    "IMG",
    "UL",
    "OL",
    "LI",
    "H2",
    "H3",
    "BLOCKQUOTE",
    "FIGURE",
    "FIGCAPTION",
    "PRE",
    "CODE",
    "KBD"
  ]);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  /** @type {Element[]} */
  const nodes = [];
  while (walker.nextNode()) nodes.push(/** @type {Element} */ (walker.currentNode));

  for (const node of nodes) {
    if (!allowed.has(node.tagName)) {
      const parent = node.parentNode;
      if (!parent) continue;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
      continue;
    }

    const keep = new Set();
    if (node.tagName === "A") {
      keep.add("href");
      keep.add("title");
      keep.add("target");
      keep.add("rel");
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
    if (node.tagName === "IMG") {
      keep.add("src");
      keep.add("alt");
      keep.add("title");
      keep.add("referrerpolicy");
      keep.add("loading");
      node.setAttribute("referrerpolicy", "no-referrer");
      node.setAttribute("loading", "lazy");
    }
    if (node.tagName === "CODE" || node.tagName === "PRE" || node.tagName === "KBD") {
      // Preserve language hints like: class="language-js".
      keep.add("class");
    }

    const attrs = Array.from(node.attributes);
    for (const a of attrs) {
      const name = a.name.toLowerCase();
      const val = a.value || "";
      if (name.startsWith("on")) {
        node.removeAttribute(a.name);
        continue;
      }
      if (!keep.has(a.name)) {
        node.removeAttribute(a.name);
        continue;
      }
      if (node.tagName === "A" && a.name === "href") {
        if (!/^https?:/i.test(val)) node.removeAttribute("href");
      }
      if (node.tagName === "IMG" && a.name === "src") {
        if (!/^https?:/i.test(val)) node.removeAttribute("src");
      }
    }
  }

  return root.innerHTML;
}

function updateEndPoll() {
  const atEnd = filtered.length > 0 && rendered >= filtered.length;
  if (!atEnd) {
    if (endPollTimer) {
      window.clearInterval(endPollTimer);
      endPollTimer = 0;
    }
    return;
  }

  if (endPollTimer) return;
  endPollTimer = window.setInterval(() => {
    // Only poll while we still sit at the end.
    if (!(filtered.length > 0 && rendered >= filtered.length)) return;
    maybeAutoRefresh();
  }, END_POLL_INTERVAL_MS);
}

async function waitForLocalRebuild(maxMs = 180_000) {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > maxMs) throw new Error("Rebuild timeout");
    const res = await fetch(`${LOCAL_REBUILD_PATH}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const st = await res.json().catch(() => null);
    if (!st || typeof st !== "object") return;
    if (!st.inFlight) return;
    await new Promise((r) => setTimeout(r, 900));
  }
}

async function rebuildDataLocally(reason) {
  // Best-effort: only works with dev-server.js.
  if (!isLocalHost()) return;

  const prev = elRefreshBtn.disabled;
  elRefreshBtn.disabled = true;
  setStatus("Обновляем новости…");
  elEndText.textContent = "Собираю новости…";
  try {
    const res = await fetch(`${LOCAL_REBUILD_PATH}?t=${Date.now()}`, { method: "POST", cache: "no-store" });
    if (res.status === 409) {
      await waitForLocalRebuild();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json().catch(() => null);
  } finally {
    elRefreshBtn.disabled = prev;
  }
}

function highlightModalCode() {
  // highlight.js is loaded via CDN; no-op if unavailable.
  const hljs = window.hljs;
  if (!hljs || typeof hljs.highlightElement !== "function") return;

  const blocks = Array.from(elModalBody.querySelectorAll("pre code"));
  for (const code of blocks) {
    // Habr uses class="bash"/"yaml" etc; highlight.js prefers language-*
    // Keep original class, but add a language-* hint for deterministic highlighting.
    try {
      const cls = Array.from(code.classList).filter((c) => c && c !== "hljs");
      const hasLang = cls.some((c) => c.startsWith("language-"));
      if (!hasLang && cls.length === 1) {
        const hint = cls[0].toLowerCase();
        code.classList.add(`language-${hint}`);
      }
    } catch {
      // ignore
    }

    // Re-highlight safely if opened multiple times.
    code.removeAttribute("data-highlighted");
    try {
      hljs.highlightElement(code);
    } catch {
      // ignore
    }
  }
}

function saveSelection() {
  if (IS_AI_SECTION) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(selected)));
  } catch {
    // ignore
  }
}

function loadSelection() {
  if (IS_AI_SECTION) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const allowed = new Set(CATEGORY_DEFS.map((c) => c.id));
    const next = arr.filter((x) => typeof x === "string" && allowed.has(x));
    selected = new Set(next);
  } catch {
    // ignore
  }
}

function selectedIds() {
  return CATEGORY_DEFS.filter((c) => selected.has(c.id)).map((c) => c.id);
}

function saveHiddenSources() {
  try {
    localStorage.setItem(HIDDEN_SOURCES_KEY, JSON.stringify(Array.from(hiddenSources)));
  } catch {
    // ignore
  }
}

function loadHiddenSources() {
  try {
    const raw = localStorage.getItem(HIDDEN_SOURCES_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    hiddenSources = new Set(arr.filter((x) => typeof x === "string" && x));
  } catch {
    // ignore
  }
}

function renderSources() {
  if (!elSources) return;
  const sources = knownSources();
  // Ids that are no longer in the snapshot are dropped so the stored list
  // cannot grow forever, but a source that merely has no items today is kept.
  elSources.replaceChildren();
  if (elSourcesBlock) elSourcesBlock.hidden = sources.length < 2;
  const frag = document.createDocumentFragment();
  for (const source of sources) {
    const wrap = document.createElement("div");
    wrap.className = "chip chip--source";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `src-${source.id}`;
    input.checked = !hiddenSources.has(source.id);
    const label = document.createElement("label");
    label.htmlFor = input.id;
    const name = document.createElement("span");
    name.className = "chip__name";
    name.textContent = source.name;
    const count = document.createElement("span");
    count.className = "topic-count";
    count.id = `count-src-${source.id}`;
    count.setAttribute("aria-hidden", "true");
    const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    check.setAttribute("viewBox", "0 0 16 16");
    check.setAttribute("class", "chip__check");
    check.setAttribute("aria-hidden", "true");
    check.innerHTML = '<path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    label.append(name, count, check);
    input.addEventListener("change", () => {
      if (input.checked) hiddenSources.delete(source.id);
      else hiddenSources.add(source.id);
      saveHiddenSources();
      applyFilterAndReset("Источники");
    });
    wrap.append(input, label);
    frag.appendChild(wrap);
  }
  elSources.appendChild(frag);
}

function renderChips() {
  elChips.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const category of CATEGORY_DEFS) {
    const wrap = document.createElement("div");
    wrap.className = "chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `cat-${category.id}`;
    input.checked = selected.has(category.id);
    const label = document.createElement("label");
    label.htmlFor = input.id;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.5");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = TOPIC_ICONS[category.id];
    const name = document.createElement("span");
    name.className = "chip__name";
    name.textContent = category.chipName || category.name;
    const count = document.createElement("span");
    count.className = "topic-count";
    count.id = `count-${category.id}`;
    count.setAttribute("aria-hidden", "true");
    const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    check.setAttribute("viewBox", "0 0 16 16");
    check.setAttribute("class", "chip__check");
    check.setAttribute("aria-hidden", "true");
    check.innerHTML = '<path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    label.append(icon, name, count, check);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(category.id);
      else selected.delete(category.id);
      saveSelection();
      applyFilterAndReset("Фильтр");
    });
    wrap.append(input, label);
    frag.appendChild(wrap);
  }
  elChips.appendChild(frag);
}

function categoryById(id) {
  return CATEGORY_DEFS.find((c) => c.id === id) || null;
}

function normalizeItem(it) {
  it = it && typeof it === "object" ? it : {};
  const publishedAt = typeof it.publishedAt === "string" ? it.publishedAt : "";
  const url = safeHttpUrl(it.url);
  const title = typeof it.title === "string" ? it.title : "";
  const excerpt = typeof it.excerpt === "string" ? it.excerpt : "";
  const image = safeHttpUrl(it.image);
  const sourceName = typeof it.sourceName === "string" ? it.sourceName : "";
  const sourceId = typeof it.sourceId === "string" && it.sourceId ? it.sourceId : sourceName;
  const contentHtml = typeof it.contentHtml === "string" ? it.contentHtml : "";
  const contentTruncated = Boolean(it.contentTruncated);
  const contentMeta = it && typeof it.contentMeta === "object" ? it.contentMeta : null;
  const id = typeof it.id === "string" ? it.id : `${url}:${publishedAt}`;
  const categoryIds = new Set(Array.isArray(it.categoryIds) ? it.categoryIds.filter((x) => typeof x === "string") : []);
  if (isAiNews(title, excerpt)) categoryIds.add("ai");
  if (isSecurityNews(title, excerpt)) categoryIds.add("security");

  return {
    id,
    url,
    title,
    excerpt,
    image,
    sourceId,
    sourceName,
    publishedAt,
    categoryIds: Array.from(categoryIds),
    contentHtml,
    contentTruncated,
    contentMeta
  };
}

function applyFilterAndReset(reason) {
  const wanted = new Set(selectedIds());
  filtered = data.items
    .filter((item) => isSourceVisible(item) && item.categoryIds.some((id) => wanted.has(id)))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  resetFeed();
  renderNextBatch();
  if (reason !== "Фильтр" && reason !== "Источники") renderSources();
  updateOverview();
  const generated = toAbsTime(data.generatedAt);
  if (loadError) {
    setStatus("Не удалось обновить новости. Показываем загруженные материалы.", true);
  } else if (!selected.size) {
    setStatus("Выберите темы для своей ленты");
  } else {
    const prefix = reason === "Без изменений" ? "Новых публикаций пока нет" : "Лента обновлена";
    setStatus(generated ? `${prefix} · ${generated}` : "Новости по выбранным темам");
  }
  updateEndText();
}

function resetFeed() {
  rendered = 0;
  elGrid.innerHTML = "";
}

function updateEndText() {
  elEndSpinner.hidden = !isLoading;
  if (isLoading) {
    elEndText.textContent = "Загружаем новости…";
  } else if (!filtered.length) {
    elEndText.textContent = "";
  } else if (rendered < filtered.length) {
    elEndText.textContent = `Показано ${rendered} из ${filtered.length.toLocaleString("ru-RU")} · Листайте дальше`;
  } else {
    elEndText.textContent = "Все новости загружены. Проверим новые публикации автоматически.";
  }
  updateEmptyState();
  updateEndPoll();
}

function renderNextBatch() {
  const slice = filtered.slice(rendered, rendered + BATCH_SIZE);
  if (!slice.length) return 0;
  const frag = document.createDocumentFragment();
  slice.forEach((item, index) => frag.appendChild(renderCard(item, rendered + index)));
  elGrid.appendChild(frag);
  rendered += slice.length;
  return slice.length;
}

function renderCard(item, index) {
  const card = document.createElement("article");
  card.className = `card${index === 0 ? " card--lead" : index < 3 ? " card--brief" : ""}`;
  card.dataset.id = item.id;
  if (item.image) {
    const media = document.createElement("div");
    media.className = "card__media";
    const img = document.createElement("img");
    img.src = item.image;
    img.alt = "";
    img.loading = index < 3 ? "eager" : "lazy";
    img.decoding = "async";
    if (index === 0) img.fetchPriority = "high";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      media.remove();
      card.classList.add("card--text");
    }, { once: true });
    media.appendChild(img);
    card.appendChild(media);
  } else {
    card.classList.add("card--text");
  }
  const body = document.createElement("div");
  body.className = "card__body";
  const meta = document.createElement("div");
  meta.className = "card__meta";
  const category = categoryById(item.categoryIds.find((id) => selected.has(id)) || item.categoryIds[0]);
  if (category) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = category.name;
    meta.appendChild(tag);
  }
  const title = document.createElement("h2");
  title.className = "card__title";
  const open = document.createElement("button");
  open.type = "button";
  open.setAttribute("aria-haspopup", "dialog");
  open.textContent = item.title || "Без заголовка";
  title.appendChild(open);
  body.append(meta, title);
  if (item.excerpt) {
    const description = document.createElement("p");
    description.className = "card__desc";
    description.textContent = item.excerpt;
    body.appendChild(description);
  }
  const footer = document.createElement("div");
  footer.className = "card__footer";
  if (item.sourceName) {
    const source = document.createElement("span");
    source.className = "card__source";
    source.textContent = item.sourceName;
    footer.appendChild(source);
  }
  const formatted = compactTime(item.publishedAt);
  if (formatted) {
    const time = document.createElement("time");
    time.className = "card__time";
    time.dateTime = item.publishedAt;
    time.textContent = formatted;
    time.title = toAbsTime(item.publishedAt);
    footer.appendChild(time);
  }
  body.appendChild(footer);
  card.appendChild(body);
  open.addEventListener("click", () => openModal(item.id, open));
  card.addEventListener("click", (event) => {
    if (event.target.closest("button") || window.getSelection()?.toString()) return;
    openModal(item.id, open);
  });
  return card;
}

function openModal(id, trigger = document.activeElement) {
  const item = filtered.find((entry) => entry.id === id) || data.items.find((entry) => entry.id === id);
  if (!item) return;
  if (!elModal.classList.contains("isOpen")) lastFocusedElement = trigger;
  elModalTitle.textContent = item.title || "Без заголовка";
  const category = categoryById(item.categoryIds.find((value) => selected.has(value)) || item.categoryIds[0]);
  elModalMeta.textContent = [category?.name, item.sourceName, toAbsTime(item.publishedAt)].filter(Boolean).join(" · ");
  elModalLink.hidden = !item.url;
  if (item.url) elModalLink.href = item.url;
  else elModalLink.removeAttribute("href");
  const html = item.contentHtml ? sanitizeHtml(item.contentHtml) : "";
  const fallback = item.excerpt ? `<p>${escapeHtml(item.excerpt)}</p>` : "";
  const note = item.contentTruncated ? '<p class="reader-note">Это сокращённая версия. Полный материал доступен в источнике.</p>' : "";
  const missingText = item.url ? "Полный текст этой публикации доступен в источнике." : "Текст этой публикации пока недоступен.";
  elModalBody.innerHTML = html ? `${note}${html}` : `${fallback}<p class="reader-note">${missingText}</p>`;
  highlightModalCode();
  elModal.classList.add("isOpen");
  elModal.setAttribute("aria-hidden", "false");
  elPageShell.inert = true;
  document.body.style.overflow = "hidden";
  elModalCard.scrollTop = 0;
  elModalClose.focus({ preventScroll: true });
}

function closeModal() {
  elModal.classList.remove("isOpen");
  elModal.setAttribute("aria-hidden", "true");
  elPageShell.inert = false;
  document.body.style.overflow = "";
  if (lastFocusedElement?.isConnected) lastFocusedElement.focus({ preventScroll: true });
  else elFeedTitle.focus({ preventScroll: true });
  lastFocusedElement = null;
}

function bindModal() {
  elModal.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) closeModal();
  });
  window.addEventListener("keydown", (event) => {
    if (!elModal.classList.contains("isOpen")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(elModalCard.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')).filter((element) => !element.hidden);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === elModalCard)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      bumpReaderFont(READER_FONT_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      bumpReaderFont(-READER_FONT_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      resetReaderFont();
    }
  });
}

function bindButtons() {
  elRefreshBtn.addEventListener("click", () => refreshData("Обновить"));
  elClearBtn.addEventListener("click", () => {
    selected = new Set();
    saveSelection();
    renderChips();
    applyFilterAndReset("Сброс");
    (elFeedState.hidden ? elSelectAllBtn : elStateAction).focus({ preventScroll: true });
  });
  elSelectAllBtn.addEventListener("click", () => {
    selected = new Set(CATEGORY_DEFS.map((category) => category.id));
    saveSelection();
    renderChips();
    applyFilterAndReset("Все темы");
  });
  elSourcesAllBtn?.addEventListener("click", () => {
    hiddenSources = new Set();
    saveHiddenSources();
    renderSources();
    applyFilterAndReset("Источники");
  });
  elStateAction.addEventListener("click", async () => {
    if (stateActionMode === "sources") {
      elSourcesAllBtn?.click();
      elFeedTitle.focus();
    } else if (stateActionMode === "retry") {
      await refreshData("Обновить");
      // Restore the retry flow only if the user has not moved to another control.
      const focus = document.activeElement;
      if (!elModal.classList.contains("isOpen") && (focus === document.body || focus === elStateAction)) {
        (elFeedState.hidden ? elFeedTitle : elStateAction).focus({ preventScroll: true });
      }
    } else {
      elSelectAllBtn.click();
      elFeedTitle.focus();
    }
  });
}

function bindReaderTools() {
  elFontDownBtn?.addEventListener("click", () => bumpReaderFont(-READER_FONT_STEP));
  elFontUpBtn?.addEventListener("click", () => bumpReaderFont(READER_FONT_STEP));
  elFontResetBtn?.addEventListener("click", () => resetReaderFont());
}

function bindInfinite() {
  const margin = 600;

  function endNearViewport() {
    const r = elEnd.getBoundingClientRect();
    return r.top <= window.innerHeight + margin;
  }

  function maybeRenderMore() {
    if (isLoading || elModal.classList.contains("isOpen")) return;
    // Some browsers won't re-fire IntersectionObserver while the sentinel
    // remains intersecting. Render in a small loop while the end is still near.
    let safety = 0;
    while (safety < 8 && endNearViewport()) {
      const added = renderNextBatch();
      if (added <= 0) break;
      safety += 1;
    }
    updateEndText();

    // If we hit the end, try a gentle auto-refresh (won't help unless data/news.json
    // was updated by the generator / GitHub Action).
    if (rendered >= filtered.length) maybeAutoRefresh();
  }

  const io = typeof IntersectionObserver === "function" ? new IntersectionObserver(
    (entries) => {
      const hit = entries.some((e) => e.isIntersecting);
      if (!hit) return;
      maybeRenderMore();
    },
    { root: null, rootMargin: `${margin}px 0px`, threshold: 0.01 },
  ) : null;
  io?.observe(elEnd);

  // Fallback for cases where IO is flaky.
  let raf = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (endNearViewport()) maybeRenderMore();
      });
    },
    { passive: true },
  );
}

async function maybeAutoRefresh() {
  if (isLoading || !selected.size || document.hidden || elModal.classList.contains("isOpen")) return;
  if (filtered.length > 0 && rendered < filtered.length) return;
  if (Date.now() - lastAutoRefreshAttemptAt < AUTO_REFRESH_MS) return;
  await refreshData("Авто");
}

async function refreshData(reason) {
  if (isLoading) return;
  const previous = data.generatedAt || "";
  lastAutoRefreshAttemptAt = Date.now();
  setLoading(true);
  setStatus(data.items.length ? "Проверяем обновления…" : "Загружаем новости…");
  updateEndText();
  let rebuildFailed = false;
  try {
    if (isLocalHost() && reason !== "Старт") {
      try {
        await rebuildDataLocally(reason);
      } catch {
        rebuildFailed = true;
      }
    }
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!next || !Array.isArray(next.items)) throw new Error("Invalid news data");
    const generatedAt = typeof next.generatedAt === "string" ? next.generatedAt : "";
    const unchanged = Boolean(previous && generatedAt && previous === generatedAt);
    loadError = false;
    if (!unchanged) {
      data = { generatedAt, items: next.items.filter((item) => item && typeof item === "object").map(normalizeItem) };
      applyFilterAndReset(reason);
    } else {
      updateOverview();
      setStatus(`Новых публикаций пока нет · ${toAbsTime(generatedAt)}`);
    }
    if (rebuildFailed) setStatus("Не удалось обновить источники. Показываем последние доступные новости.", true);
  } catch {
    loadError = true;
    setStatus(data.items.length ? "Не удалось обновить новости. Показываем загруженные материалы." : "Новости временно недоступны. Попробуйте ещё раз.", true);
  } finally {
    setLoading(false);
    updateEndText();
  }
}

function init() {
  initTheme();
  const now = new Date();
  const today = $("#today");
  today.dateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  today.textContent = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(now);
  loadReaderFont();
  applyReaderFont();
  loadSelection();
  loadHiddenSources();
  renderChips();
  renderSources();
  updateOverview();
  bindButtons();
  bindInfinite();
  bindModal();
  bindReaderTools();
  refreshData("Старт");
}

init();
