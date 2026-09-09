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
  { id: "markets", name: "Фондовый рынок" },
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
  markets: '<path d="M3 21h18M7 17v-6m5 6V7m5 10v-4"/><path d="m4 9 4-4 5 3 7-5"/>',
  tech: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5M10 10h4v4h-4z"/>',
  ai: '<path d="M8 4.5A3.5 3.5 0 0 1 14.2 3a3.5 3.5 0 0 1 4.3 4.3A3.5 3.5 0 0 1 20 13.5a3.5 3.5 0 0 1-4.3 4.3A3.5 3.5 0 0 1 9.5 19a3.5 3.5 0 0 1-4.3-4.3A3.5 3.5 0 0 1 4 8.5 3.5 3.5 0 0 1 8 4.5Z"/><path d="M9 9v6m6-6v6M7.5 12h3m3 0h3"/>',
  security: '<path d="M12 3 4 6v6c0 5 3.4 8.6 8 9.5 4.6-.9 8-4.5 8-9.5V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  science: '<path d="M9 3h6M10 3v7L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M7 15h10"/>',
  health: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  sports: '<path d="M8 3h8v7a4 4 0 0 1-8 0V3ZM8 5H3v3a4 4 0 0 0 5 4m8-7h5v3a4 4 0 0 1-5 4m-4 2v7m-5 0h10"/>',
  culture: '<path d="M12 5C8 2 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-5-2-9 1Zm0 0v15"/>'
};

const DATA_URL = "data/news.json";
// Reader text lives in one small file per item and is fetched on demand.
const ARTICLES_URL = "data/articles/";
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

/** Loaded article texts by item id. @type {Map<string, {contentHtml: string, contentTruncated: boolean}>} */
const articleCache = new Map();
// Incremented on every open so a late article response for a previous
// story is ignored.
let modalOpenToken = 0;

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

// Mirrors the rule in scripts/classify.mjs: AI in the headline, or at least
// two mentions across headline and summary. Keep both copies in sync.
const AI_TERMS =
  /(?:искусственн(?:ый|ого|ому|ым|ом) интеллект|нейросет|нейронн(?:ая|ые|ой|ую) сет|генеративн(?:ый|ого|ому|ым|ом) ии|машинн(?:ое|ого|ому|ым|ом) обучен|больш(?:ая|ой|ую|ие|их) языков(?:ая|ой|ую|ые|ых) модел|вайб-?кодинг|(?:^|[^а-яёa-z0-9])ии(?:$|[^а-яёa-z0-9])|\bartificial intelligence\b|\bgenerative ai\b|\bmachine learning\b|\bdeep learning\b|\blarge language models?\b|\bllms?\b|\bml\b|\bvibe coding\b|\bchatgpt\b|\bopenai\b|\banthropic\b|\bclaude (?:ai|\d|model)\b|(?:модель|model)\s+claude\b|\bgoogle gemini\b|(?:модель|model)\s+gemini\b|\bgemini (?:ai|\d)\b|\bgpt-?\d|\b(?:qwen|llama|deepseek|mistral|gemma|grok)(?:\d|\b)|\bcopilot\b|\bmidjourney\b|\bstable diffusion\b|\bai[- ]agents?\b)/gi;

function isAiNews(title, excerpt) {
  const head = String(title || "").toLowerCase();
  if ((head.match(AI_TERMS) || []).length > 0) return true;
  return ((`${head} ${String(excerpt || "").toLowerCase()}`).match(AI_TERMS) || []).length >= 2;
}

// Mirrors the two-tier rule in scripts/classify.mjs: unambiguous terms count
// on their own, ambiguous ones ("взлом", "exploit") only next to something
// digital. Keep both copies in sync.
const SECURITY_STRONG =
  /(?:кибер(?:атак|преступ|безопасност|угроз|шпион|мошенн|инцидент|войн|развед|полиц|расслед|защит)|хакер|уязвимост|вредонос|малвар|шифровальщик|фишинг|эксплойт|ботнет|троян|бэкдор|руткит|антивирус|пентест|инфобез|даркнет|информационн(?:ая|ой|ую) безопасност|утечк[а-я]* (?:данных|персональн|баз|информац|парол)|\bddos\b|\bmalware\b|\bransomware\b|\bspyware\b|\brootkit\b|\bphishing\b|\bcve-\d{4}-\d+|\bzero-day\b|\b0-day\b|\binfostealer|\bdata breach|\bcyber ?(?:attack|security|crime|threat|espionage)|\bhackers?\b(?! news)|\bhacked\b|\bbotnet\b|\bbackdoor\b|\bweb shell\b|\bdark ?web\b|\bcredential (?:theft|stuffing)|\binfosec\b)/i;
const SECURITY_WEAK = /(?:взлом|вымогател|\bexploit|\bvulnerabilit|\bbreach)/i;
const DIGITAL_CONTEXT =
  /(?:аккаунт|учетн(?:ая|ой|ую) запис|сайт|сервер|систем|баз[а-я]* данных|данны[ех]|парол|телефон|смартфон|компьютер|ноутбук|сет[ьи]\b|почт|приложен|мессендж|крипто|бирж|банк|\bпо\b|софт|программ|прошивк|плагин|патч|обновлен|устройств|роутер|камер|браузер|\bит\b|\bit\b|windows|linux|android|ios|iphone|chrome|api|wi-?fi|bluetooth|\bsoftware\b|\bservers?\b|\bnetwork|\bpassword|\baccounts?\b|\bdevices?\b|\bapps?\b|\brouter|\bdatabase|\bcredential|\bpatch|\bupdate|\bbrowser|\bplugin|\bfirmware|\bcloud\b|\bemail\b|\bcrypto)/i;

function isSecurityNews(title, excerpt) {
  const text = `${title || ""} ${excerpt || ""}`.toLowerCase();
  if (SECURITY_STRONG.test(text)) return true;
  return SECURITY_WEAK.test(text) && DIGITAL_CONTEXT.test(text);
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

// A source whose pages the build cannot read (a bot filter, a network
// block) gives the reader only announcements; the filter says so, so hiding
// it is an informed choice. Judged on the last days, with enough items.
const TEXTLESS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const TEXTLESS_MIN_ITEMS = 5;
const TEXTLESS_MAX_SHARE = 0.2;

function sourceHasNoText(sourceId) {
  const cutoff = Date.now() - TEXTLESS_WINDOW_MS;
  let total = 0;
  let withText = 0;
  for (const item of data.items) {
    if (item.sourceId !== sourceId || Date.parse(item.publishedAt || 0) < cutoff) continue;
    total += 1;
    if (item.hasContent) withText += 1;
  }
  return total >= TEXTLESS_MIN_ITEMS && withText / total < TEXTLESS_MAX_SHARE;
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
    if (sourceHasNoText(source.id)) {
      const note = document.createElement("span");
      note.className = "chip__note";
      note.textContent = "только анонсы";
      name.appendChild(note);
      label.title = "Сайт источника не отдаёт текст статей сборщику: в окне чтения будет описание и ссылка";
    }
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
  // Old snapshots carry the text inline; new ones only flag that an article
  // file exists.
  const hasContent = Boolean(contentHtml) || Boolean(it.hasContent);
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
    hasContent
  };
}

/* ── Биржевой блок: бегущая строка и тепловая карта ───────────────────────
   Показывается, когда единственная выбранная тема — «Фондовый рынок».
   Котировки страница берёт у Московской биржи сама (ISS API): биржа
   отвечает браузерам читателей, но рвёт соединения с серверов GitHub, так что
   срез data/moex.json от сборщика — лишь запасной вариант. Разбор ответа
   биржи общий с сборщиком и живёт в moex-snapshot.js. */

const MOEX_FALLBACK_URL = "data/moex.json";
const MARKET_TTL_MS = 5 * 60 * 1000; // quotes are refreshed this often while the board is open
const MARKET_RETRY_MS = 60 * 1000; // a failed request is not repeated sooner than this
const MARKET_JSONP_TIMEOUT_MS = 10_000;
const HEAT_LABEL_HEIGHT = 17;
// A sector smaller than this share of the board cannot hold a readable label
// and a tile, so the tail is merged into one "Прочие" group.
const HEAT_MIN_SECTOR_SHARE = 0.02;
const HEAT_LABEL_MIN_WIDTH = 92;
const HEAT_LABEL_MIN_HEIGHT = 46;
const HEAT_TEXT_MIN_WIDTH = 44;
const HEAT_TEXT_MIN_HEIGHT = 26;
const TICKER_QUOTES = 28;

/** @type {{snapshot: any, live: boolean, fetchedAt: number, reasons: string[]} | null} */
let marketData = null;
let marketRequest = null;
let marketTimer = 0;
let marketJsonpSeq = 0;
let issPreferJsonp = false;
let boardShown = false;

const elMarketBoard = $("#marketBoard");

function boardActive() {
  return Boolean(elMarketBoard) && !IS_AI_SECTION && selected.size === 1 && selected.has("markets");
}

async function fetchJsonFrom(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * JSONP request for browsers where the plain cross-origin request to the
 * exchange is blocked: ISS supports a `.jsonp` format with a callback name.
 */
function loadJsonp(url, callback) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const finish = (error, payload) => {
      clearTimeout(timer);
      delete window[callback];
      script.remove();
      if (error) reject(error);
      else resolve(payload);
    };
    const timer = setTimeout(() => finish(new Error("Таймаут")), MARKET_JSONP_TIMEOUT_MS);
    window[callback] = (payload) => finish(null, payload);
    script.onerror = () => finish(new Error("Скрипт не загрузился"));
    script.async = true;
    script.src = url;
    document.head.appendChild(script);
  });
}

/**
 * The parser is a separate script tag; a page served from an older cached
 * index.html would lack it, so load it on demand rather than give up.
 */
function loadMoexModule() {
  if (typeof MoexSnapshot !== "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => reject(new Error("модуль разбора не загрузился"));
    script.onload = () => (typeof MoexSnapshot !== "undefined" ? resolve() : fail());
    script.onerror = fail;
    script.src = "moex-snapshot.js";
    document.head.appendChild(script);
  });
}

/** Short human reason for the notice under the board. */
function describeMarketError(error) {
  const message = String((error && error.message) || error || "");
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "сеть или запрет браузера (CORS)";
  return message || "неизвестная ошибка";
}

/** One ISS request: plain JSON first, JSONP when the browser blocks it. */
async function issGet(request, reasons) {
  await loadMoexModule();
  if (!issPreferJsonp) {
    try {
      return await fetchJsonFrom(MoexSnapshot.issUrl(request.path, request.params, "json"), { cache: "no-store" });
    } catch (error) {
      if (reasons) reasons.push(`прямой запрос: ${describeMarketError(error)}`);
      // An HTTP status is the exchange's answer and would repeat over JSONP;
      // only a request that never got through is worth the second attempt.
      if (error && error.status) throw error;
    }
  }
  // Second attempt through JSONP: a blocked cross-origin request is the
  // usual failure, and a script tag is not subject to it.
  marketJsonpSeq += 1;
  const callback = `moexCallback${marketJsonpSeq}`;
  try {
    const payload = await loadJsonp(MoexSnapshot.issUrl(request.path, request.params, "jsonp", callback), callback);
    issPreferJsonp = true; // the plain request is known to fail here; skip it from now on
    return payload;
  } catch (jsonpError) {
    if (reasons) reasons.push(`JSONP: ${describeMarketError(jsonpError)}`);
    throw jsonpError;
  }
}

/**
 * Live quotes straight from the exchange, as the reader's browser sees it.
 * `reasons` collects what each transport answered, for the notice.
 */
async function loadLiveMarket(reasons) {
  const requests = (await loadMoexModule(), MoexSnapshot.requests);
  const [shares, indices] = await Promise.all([
    issGet(requests.shares(), reasons),
    issGet(requests.indices()).catch(() => null)
  ]);
  const snapshot = MoexSnapshot.build(shares, indices);
  if (!snapshot) {
    reasons.push("биржа вернула пустой список бумаг");
    throw new Error("Биржа не вернула бумаг");
  }
  marketIndicesPayload = indices;
  return snapshot;
}

/** The snapshot the build committed, for readers who cannot reach the exchange. */
async function loadFallbackMarket() {
  const parsed = await fetchJsonFrom(MOEX_FALLBACK_URL, { cache: "no-cache" });
  if (!parsed || !Array.isArray(parsed.stocks) || parsed.stocks.length === 0) throw new Error("Пустой срез");
  return parsed;
}

function marketFresh() {
  if (!marketData) return false;
  const age = Date.now() - marketData.fetchedAt;
  return age < (marketData.live ? MARKET_TTL_MS : MARKET_RETRY_MS);
}

/** Resolves with the best snapshot available, or null; never rejects. */
function ensureMarketData() {
  if (marketFresh()) return Promise.resolve(marketData.snapshot);
  if (!marketRequest) {
    const reasons = [];
    marketRequest = loadLiveMarket(reasons)
      .then((snapshot) => ({ snapshot, live: true }))
      .catch(async (error) => {
        if (reasons.length === 0) reasons.push(describeMarketError(error));
        // Keep what the board already shows rather than replacing it with an
        // older committed file; go to the file only when there is nothing.
        if (marketData && marketData.snapshot) return { snapshot: marketData.snapshot, live: false };
        const fallback = await loadFallbackMarket().catch((fallbackError) => {
          reasons.push(`резерв: ${describeMarketError(fallbackError)}`);
          return null;
        });
        return { snapshot: fallback, live: false };
      })
      .then((next) => {
        marketData = { ...next, reasons, fetchedAt: Date.now() };
        return next.snapshot;
      })
      .finally(() => {
        marketRequest = null;
      });
  }
  return marketRequest;
}

function startMarketRefresh() {
  if (marketTimer) return;
  marketTimer = window.setInterval(() => {
    if (boardActive() && document.visibilityState !== "hidden") updateMarketBoard();
  }, MARKET_TTL_MS);
}

function stopMarketRefresh() {
  if (!marketTimer) return;
  clearInterval(marketTimer);
  marketTimer = 0;
}

function updateMarketBoard() {
  if (!elMarketBoard) return;
  if (!boardActive()) {
    elMarketBoard.hidden = true;
    stopMarketRefresh();
    return;
  }
  elMarketBoard.hidden = false;
  if (!marketData) renderBoardSkeleton();
  ensureMarketData().then((snapshot) => {
    if (!boardActive()) return;
    if (snapshot) renderBoard(snapshot, marketData.live);
    else renderBoardEmpty(`Котировки Московской биржи сейчас недоступны (${marketData.reasons.join("; ")}). Лента раздела работает как обычно.`, true);
  });
  startMarketRefresh();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && boardActive()) updateMarketBoard();
});

function formatMoney(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млрд ₽`;
  if (abs >= 1e6) return `${(value / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн ₽`;
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function formatChange(change) {
  const value = Number(change) || 0;
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2).replace(".", ",")}%`;
}

function changeClass(change) {
  return change > 0 ? "is-up" : change < 0 ? "is-down" : "";
}

/** Step of the diverging scale for a percentage change. */
function heatStep(change) {
  const size = Math.abs(change);
  if (size < 0.1) return "zero";
  const level = size < 0.5 ? 1 : size < 1.2 ? 2 : size < 2.5 ? 3 : size < 4 ? 4 : 5;
  return `${change > 0 ? "u" : "d"}${level}`;
}

// Placeholder layout of the heat map while the first quotes are on their way:
// a treemap-looking arrangement in percentages of the board, three columns of
// unequal blocks, so the page does not jump when the real tiles replace it.
const HEAT_GHOSTS = [
  [0, 0, 38, 55], [0, 55, 20, 45], [20, 55, 18, 45],
  [38, 0, 34, 40], [38, 40, 17, 30], [55, 40, 17, 30], [38, 70, 34, 30],
  [72, 0, 28, 30], [72, 30, 14, 35], [86, 30, 14, 35], [72, 65, 28, 35]
];

function skeletonBar(className, width) {
  const bar = document.createElement("span");
  bar.className = `ghost ${className}`.trim();
  if (width) bar.style.width = width;
  return bar;
}

/** Shapes of the board shown until the first answer of the exchange. */
function renderBoardSkeleton() {
  elMarketBoard.classList.remove("board--empty");
  elMarketBoard.classList.add("board--loading");
  elMarketBoard.setAttribute("aria-busy", "true");

  const indices = $("#boardIndices");
  if (indices) {
    indices.replaceChildren();
    for (const width of ["7.5em", "5em", "8em"]) {
      const wrap = document.createElement("div");
      wrap.className = "board__index";
      wrap.setAttribute("aria-hidden", "true");
      wrap.append(skeletonBar("ghost--label", width), skeletonBar("ghost--value", "4.5em"));
      indices.appendChild(wrap);
    }
  }

  const track = $("#boardTickerTrack");
  if (track) {
    track.replaceChildren();
    for (let i = 0; i < 16; i += 1) {
      const quote = document.createElement("span");
      quote.className = "quote";
      quote.append(skeletonBar("ghost--text", `${3 + (i % 3)}em`), skeletonBar("ghost--text", "3.5em"));
      track.appendChild(quote);
    }
  }
  const tickerText = $("#boardTickerText");
  if (tickerText) tickerText.textContent = "";

  const heat = $("#boardHeat");
  if (heat) {
    heat.replaceChildren();
    for (const [x, y, w, h] of HEAT_GHOSTS) {
      const ghost = document.createElement("span");
      ghost.className = "ghost heat__ghost";
      ghost.style.left = `${x}%`;
      ghost.style.top = `${y}%`;
      ghost.style.width = `calc(${w}% - var(--heat-gap))`;
      ghost.style.height = `calc(${h}% - var(--heat-gap))`;
      heat.appendChild(ghost);
    }
  }

  chartGhost();
  for (const id of ["#boardMacro", "#boardMovers", "#boardFocus", "#boardSession", "#boardWatch"]) {
    const host = $(id);
    if (host) {
      host.replaceChildren();
      host.hidden = true;
    }
  }

  const meta = $("#boardMeta");
  if (meta) meta.textContent = "Запрашиваем котировки Московской биржи…";
}

function renderBoardEmpty(text, retryable) {
  elMarketBoard.classList.remove("board--loading");
  elMarketBoard.classList.add("board--empty");
  elMarketBoard.setAttribute("aria-busy", "false");
  // The index placeholders of the skeleton are not hidden by the empty
  // state's styles, so clear them along with the rest.
  for (const id of ["#boardIndices", "#boardTickerTrack", "#boardHeat", "#boardChart", "#boardChartStats", "#boardChartAxis"]) {
    const host = $(id);
    if (host) host.replaceChildren();
  }
  for (const id of ["#boardMacro", "#boardMovers", "#boardFocus", "#boardSession", "#boardWatch"]) {
    const host = $(id);
    if (host) host.hidden = true;
  }
  const meta = $("#boardMeta");
  if (!meta) return;
  meta.textContent = text;
  if (!retryable) return;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "board__retry";
  retry.textContent = "Повторить";
  retry.addEventListener("click", () => {
    marketData = null;
    updateMarketBoard();
  });
  meta.append(" ", retry);
}

function renderBoard(parsed, live) {
  elMarketBoard.classList.remove("board--empty", "board--loading");
  elMarketBoard.setAttribute("aria-busy", "false");
  renderBoardIndices(parsed.indices || []);
  renderTicker(parsed.stocks);
  renderHeatmap(parsed.stocks);
  renderBoardTable(parsed.stocks);
  renderMovers(parsed.movers);
  lastBoardSnapshot = parsed;
  renderWatchlist(parsed);
  renderSession(parsed.session, live, parsed.generatedAt);
  if (live) {
    updateIndexChart();
    updateMacro();
  } else {
    // The committed file carries no candles or currencies: hide what it cannot fill.
    renderIndexChart(null, chartRange);
    renderMacro([]);
  }
  const updated = toAbsTime(parsed.generatedAt);
  const freshness = live ? `котировки на ${updated}` : `срез от ${updated}, биржа сейчас не отвечает`;
  const basis = parsed.stocks.some((stock) => stock.weightBasis === "capitalisation") ? "площадь плитки — капитализация" : "площадь плитки — объём торгов";
  const meta = $("#boardMeta");
  if (meta) meta.textContent = [parsed.source || "Московская биржа", updated && freshness, basis].filter(Boolean).join(" · ");
}

function renderBoardIndices(indices) {
  const host = $("#boardIndices");
  if (!host) return;
  host.replaceChildren();
  for (const index of indices) {
    const wrap = document.createElement("div");
    wrap.className = "board__index";
    const name = document.createElement("span");
    name.className = "board__indexName";
    name.textContent = index.name || index.ticker;
    const value = document.createElement("span");
    value.className = "board__indexValue";
    value.textContent = Number(index.value).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
    const change = document.createElement("span");
    change.className = `board__indexChange ${changeClass(index.change)}`.trim();
    change.textContent = index.change === null || index.change === undefined ? "" : formatChange(index.change);
    wrap.append(name, value, change);
    host.appendChild(wrap);
  }
}

function renderTicker(stocks) {
  const track = $("#boardTickerTrack");
  if (!track) return;
  const quotes = stocks.slice().sort((a, b) => (b.turnover || 0) - (a.turnover || 0)).slice(0, TICKER_QUOTES);
  track.replaceChildren();
  // The track holds the list twice so the loop wraps without a visible seam.
  for (let copy = 0; copy < 2; copy += 1) {
    for (const stock of quotes) {
      const quote = document.createElement("span");
      quote.className = "quote";
      const ticker = document.createElement("span");
      ticker.className = "quote__ticker";
      ticker.textContent = stock.ticker;
      const price = document.createElement("span");
      price.className = "quote__price";
      price.textContent = Number(stock.price).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
      const change = document.createElement("span");
      change.className = `quote__change ${changeClass(stock.change)}`.trim();
      change.textContent = formatChange(stock.change);
      quote.append(ticker, price, change);
      track.appendChild(quote);
    }
  }
  // Constant reading speed regardless of how many quotes are in the loop.
  track.style.animationDuration = `${Math.max(40, quotes.length * 2.6)}s`;
  const text = $("#boardTickerText");
  if (text) text.textContent = quotes.map((stock) => `${stock.ticker} ${formatChange(stock.change)}`).join(", ");
}

/**
 * Squarified treemap: lays items out in rows along the shorter side, keeping
 * tiles as close to square as possible. Values must be positive and sorted
 * from large to small.
 */
function squarify(nodes, box) {
  const placed = [];
  const queue = nodes.slice();
  const rect = { ...box };
  let remaining = queue.reduce((sum, node) => sum + node.value, 0);

  const worstRatio = (values, rowSum, side) => {
    const area = rect.w * rect.h;
    const thickness = ((rowSum / remaining) * area) / side;
    let worst = 0;
    for (const value of values) {
      const length = (value / rowSum) * side;
      if (!length || !thickness) return Infinity;
      worst = Math.max(worst, thickness / length, length / thickness);
    }
    return worst;
  };

  while (queue.length && remaining > 0 && rect.w > 0 && rect.h > 0) {
    const vertical = rect.w >= rect.h;
    const side = vertical ? rect.h : rect.w;
    const row = [];
    let rowSum = 0;
    let best = Infinity;

    while (queue.length) {
      const candidate = row.concat(queue[0]);
      const ratio = worstRatio(candidate.map((node) => node.value), rowSum + queue[0].value, side);
      if (row.length && ratio > best) break;
      row.push(queue.shift());
      rowSum += row[row.length - 1].value;
      best = ratio;
    }

    const thickness = ((rowSum / remaining) * rect.w * rect.h) / side;
    let offset = vertical ? rect.y : rect.x;
    for (const node of row) {
      const length = (node.value / rowSum) * side;
      placed.push(
        vertical
          ? { node, x: rect.x, y: offset, w: thickness, h: length }
          : { node, x: offset, y: rect.y, w: length, h: thickness },
      );
      offset += length;
    }

    if (vertical) {
      rect.x += thickness;
      rect.w -= thickness;
    } else {
      rect.y += thickness;
      rect.h -= thickness;
    }
    remaining -= rowSum;
  }
  return placed;
}

function heatBox() {
  const host = $("#boardHeat");
  const rect = host ? host.getBoundingClientRect() : null;
  // jsdom and a hidden container report zeroes; a nominal box keeps the
  // layout deterministic instead of collapsing to nothing.
  const w = rect && rect.width > 0 ? rect.width : 960;
  const h = rect && rect.height > 0 ? rect.height : 340;
  return { x: 0, y: 0, w, h };
}

function renderHeatmap(stocks) {
  const host = $("#boardHeat");
  if (!host) return;
  host.replaceChildren();

  const bySector = new Map();
  for (const stock of stocks) {
    const sector = stock.sector || "Прочие";
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(stock);
  }

  let sectors = [...bySector.entries()]
    .map(([name, members]) => ({
      name,
      value: members.reduce((sum, stock) => sum + (Number(stock.weight) || 0), 0),
      members: members.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    }))
    .filter((sector) => sector.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = sectors.reduce((sum, sector) => sum + sector.value, 0);
  const small = sectors.filter((sector) => sector.value / total < HEAT_MIN_SECTOR_SHARE);
  if (small.length > 1) {
    sectors = sectors.filter((sector) => !small.includes(sector));
    sectors.push({
      name: "Прочие",
      value: small.reduce((sum, sector) => sum + sector.value, 0),
      members: small.flatMap((sector) => sector.members).sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    });
    sectors.sort((a, b) => b.value - a.value);
  }

  const box = heatBox();
  const frag = document.createDocumentFragment();

  for (const cell of squarify(sectors, box)) {
    const group = document.createElement("div");
    group.className = "heat__group";
    group.style.left = `${(cell.x / box.w) * 100}%`;
    group.style.top = `${(cell.y / box.h) * 100}%`;
    group.style.width = `${(cell.w / box.w) * 100}%`;
    group.style.height = `${(cell.h / box.h) * 100}%`;

    // A label needs room; a narrow column gives its space to the tiles.
    const labelled = cell.w >= HEAT_LABEL_MIN_WIDTH && cell.h >= HEAT_LABEL_MIN_HEIGHT;
    if (labelled) {
      const label = document.createElement("span");
      label.className = "heat__groupName";
      label.textContent = cell.node.name;
      group.appendChild(label);
    }

    const top = labelled ? HEAT_LABEL_HEIGHT : 0;
    const inner = { x: 0, y: top, w: cell.w, h: Math.max(cell.h - top, 1) };
    for (const tile of squarify(cell.node.members.map((stock) => ({ value: Number(stock.weight) || 0, stock })), inner)) {
      group.appendChild(renderHeatTile(tile, cell));
    }
    frag.appendChild(group);
  }

  host.appendChild(frag);
  host.appendChild(createHeatTooltip());
}

function renderHeatTile(tile, cell) {
  const stock = tile.node.stock;
  const step = heatStep(Number(stock.change) || 0);
  const button = document.createElement("button");
  button.type = "button";
  const tiny = tile.w < HEAT_TEXT_MIN_WIDTH || tile.h < HEAT_TEXT_MIN_HEIGHT;
  const small = tile.w < 62 || tile.h < 34;
  button.className = `heat__tile${tiny ? " heat__tile--tiny" : small ? " heat__tile--sm" : ""}`;
  button.style.left = `${(tile.x / cell.w) * 100}%`;
  button.style.top = `${(tile.y / cell.h) * 100}%`;
  button.style.width = `calc(${(tile.w / cell.w) * 100}% - var(--heat-gap))`;
  button.style.height = `calc(${(tile.h / cell.h) * 100}% - var(--heat-gap))`;
  button.style.setProperty("--fill", `var(--heat-${step})`);
  button.style.setProperty("--ink", `var(--heat-${step}-ink)`);
  button.dataset.ticker = stock.ticker;

  const ticker = document.createElement("span");
  ticker.className = "heat__ticker";
  ticker.textContent = stock.ticker;
  const change = document.createElement("span");
  change.className = "heat__change";
  change.textContent = formatChange(stock.change);
  button.append(ticker, change);
  // The tile always names itself; colour only speeds up scanning.
  button.setAttribute("aria-label", `${stock.name}, ${formatChange(stock.change)}, цена ${Number(stock.price).toLocaleString("ru-RU")} ₽`);

  button.addEventListener("click", () => showCompanyFocus(stock, button));
  const show = () => showHeatTooltip(button, stock);
  button.addEventListener("mouseenter", show);
  button.addEventListener("focus", show);
  button.addEventListener("mouseleave", hideHeatTooltip);
  button.addEventListener("blur", hideHeatTooltip);
  return button;
}

function createHeatTooltip() {
  const tip = document.createElement("div");
  tip.className = "heat__tip";
  tip.id = "heatTip";
  tip.hidden = true;
  return tip;
}

function showHeatTooltip(tile, stock) {
  const host = $("#boardHeat");
  const tip = $("#heatTip");
  if (!host || !tip) return;
  tip.replaceChildren();
  const name = document.createElement("b");
  name.textContent = `${stock.ticker} · ${stock.name}`;
  const price = document.createElement("div");
  price.textContent = `${Number(stock.price).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽ · ${formatChange(stock.change)}`;
  const turnover = document.createElement("span");
  turnover.textContent = `Оборот: ${formatMoney(Number(stock.turnover) || 0)}`;
  tip.append(name, price, turnover);
  tip.hidden = false;

  const hostBox = host.getBoundingClientRect();
  const tileBox = tile.getBoundingClientRect();
  const left = Math.min(Math.max(tileBox.left - hostBox.left, 0), Math.max(hostBox.width - tip.offsetWidth, 0));
  const above = tileBox.top - hostBox.top > tip.offsetHeight + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above ? tileBox.top - hostBox.top - tip.offsetHeight - 8 : tileBox.bottom - hostBox.top + 8}px`;
}

function hideHeatTooltip() {
  const tip = $("#heatTip");
  if (tip) tip.hidden = true;
}

function renderBoardTable(stocks) {
  const table = $("#boardTable");
  if (!table) return;
  const caption = table.querySelector("caption");
  table.replaceChildren();
  if (caption) table.appendChild(caption);

  const head = document.createElement("tr");
  for (const title of ["Тикер", "Бумага", "Цена, ₽", "Изменение", "Оборот"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = title;
    head.appendChild(cell);
  }
  const thead = document.createElement("thead");
  thead.appendChild(head);
  const body = document.createElement("tbody");
  for (const stock of stocks) {
    const row = document.createElement("tr");
    const cells = [stock.ticker, stock.name, Number(stock.price).toLocaleString("ru-RU", { maximumFractionDigits: 2 }), formatChange(stock.change), formatMoney(Number(stock.turnover) || 0)];
    cells.forEach((text, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      if (index === 3) cell.className = changeClass(stock.change);
      cell.textContent = text;
      row.appendChild(cell);
    });
    body.appendChild(row);
  }
  table.append(thead, body);
}

/* ── График индекса, макроиндикаторы, лидеры дня, новости компании ───────── */

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_W = 600;
const CHART_H = 130;
const CHART_PAD = 4;
const FOCUS_NEWS_LIMIT = 6;

let chartRange = "day";
/** @type {Map<string, {series: any, fetchedAt: number}>} */
const chartCache = new Map();
let chartRequest = null;
/** @type {{items: any[], fetchedAt: number} | null} */
let macroData = null;
let macroRequest = null;
let marketIndicesPayload = null;

function renderRangeButtons() {
  const host = $("#boardRanges");
  if (!host || host.childElementCount > 0) return;
  for (const [key, spec] of Object.entries(MoexSnapshot.RANGES)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chart__range";
    button.dataset.range = key;
    button.textContent = spec.label;
    button.setAttribute("aria-pressed", String(key === chartRange));
    button.addEventListener("click", () => {
      if (chartRange === key) return;
      chartRange = key;
      for (const node of host.querySelectorAll(".chart__range")) node.setAttribute("aria-pressed", String(node.dataset.range === key));
      updateIndexChart();
    });
    host.appendChild(button);
  }
}

function chartGhost() {
  const host = $("#boardChart");
  if (!host) return;
  const ghost = document.createElement("span");
  ghost.className = "ghost chart__ghost";
  host.replaceChildren(ghost);
}

/** Fetches the candles of the chosen range (cached for the refresh period) and draws them. */
function updateIndexChart() {
  if (typeof MoexSnapshot === "undefined" || !$("#boardChart")) return;
  renderRangeButtons();
  const range = chartRange;
  const cached = chartCache.get(range);
  if (cached && Date.now() - cached.fetchedAt < MARKET_TTL_MS) {
    renderIndexChart(cached.series, range);
    return;
  }
  chartGhost();
  const request = issGet(MoexSnapshot.requests.candles(range))
    .then((payload) => MoexSnapshot.buildSeries(payload, range))
    .catch(() => null)
    .then((series) => {
      chartCache.set(range, { series, fetchedAt: Date.now() });
      // The reader may have switched range while this one was loading.
      if (chartRange === range && boardActive()) renderIndexChart(series, range);
    });
  chartRequest = request;
}

function chartTimeLabel(t, range) {
  const text = String(t || "");
  if (range === "day") return text.slice(11, 16);
  const date = new Date(text.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? text.slice(0, 10) : date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function svgElement(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function renderIndexChart(series, range) {
  const host = $("#boardChart");
  const stats = $("#boardChartStats");
  const axis = $("#boardChartAxis");
  if (!host) return;
  host.replaceChildren();
  if (stats) stats.replaceChildren();
  if (axis) axis.replaceChildren();
  if (!series || series.points.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chart__empty";
    empty.textContent = "Биржа не отдала свечи за этот период.";
    host.appendChild(empty);
    host.removeAttribute("aria-label");
    return;
  }

  const n = series.points.length;
  const span = series.max - series.min || Math.abs(series.max) * 0.001 || 1;
  const x = (i) => CHART_PAD + (n > 1 ? (i / (n - 1)) * (CHART_W - 2 * CHART_PAD) : (CHART_W - 2 * CHART_PAD) / 2);
  const y = (v) => CHART_PAD + (1 - (v - series.min) / span) * (CHART_H - 2 * CHART_PAD);
  const line = series.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const up = (series.change === null ? series.last - series.first : series.change) >= 0;

  const svg = svgElement("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  svg.classList.add("chart__svg", up ? "is-up" : "is-down");
  svg.appendChild(svgElement("path", { class: "chart__area", d: `${line} L${x(n - 1).toFixed(1)} ${CHART_H} L${x(0).toFixed(1)} ${CHART_H} Z` }));
  if (series.baseline !== null && series.baseline >= series.min && series.baseline <= series.max) {
    svg.appendChild(svgElement("line", { class: "chart__baseline", x1: 0, x2: CHART_W, y1: y(series.baseline).toFixed(1), y2: y(series.baseline).toFixed(1) }));
  }
  svg.appendChild(svgElement("path", { class: "chart__line", d: line }));
  host.appendChild(svg);

  const fmt = (v) => Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const changeText = series.change === null ? "" : formatChange(series.change);
  const rangeLabel = (MoexSnapshot.RANGES[range] || {}).label || "";
  host.setAttribute("aria-label", `Индекс МосБиржи, ${rangeLabel.toLowerCase()}: от ${fmt(series.first)} до ${fmt(series.last)}${changeText ? `, ${changeText}` : ""}`);

  if (stats) {
    const value = document.createElement("span");
    value.className = "chart__value";
    value.textContent = fmt(series.last);
    const change = document.createElement("span");
    change.className = `chart__change ${changeClass(series.change === null ? series.last - series.first : series.change)}`.trim();
    change.textContent = changeText;
    const minmax = document.createElement("span");
    minmax.className = "chart__minmax";
    minmax.textContent = `мин. ${fmt(series.min)} · макс. ${fmt(series.max)}`;
    stats.append(value, change, minmax);
  }
  if (axis) {
    const start = document.createElement("span");
    start.textContent = chartTimeLabel(series.points[0].t, range);
    const end = document.createElement("span");
    end.textContent = chartTimeLabel(series.points[n - 1].t, range);
    axis.append(start, end);
  }
}

/** Currencies, the bond index and Brent: each source optional, refreshed with the board. */
function updateMacro() {
  if (typeof MoexSnapshot === "undefined" || !$("#boardMacro")) return;
  if (macroData && Date.now() - macroData.fetchedAt < MARKET_TTL_MS) {
    renderMacro(macroData.items);
    return;
  }
  if (macroRequest) return;
  const requests = MoexSnapshot.requests;
  const quiet = (request) => issGet(request).catch(() => null);
  macroRequest = Promise.all([
    quiet(requests.currency()),
    quiet(requests.fixing()),
    Promise.all(MoexSnapshot.brentContracts().map((contract) => quiet(requests.future(contract))))
  ])
    .then(([currency, fixing, futures]) => MoexSnapshot.buildMacro({ indices: marketIndicesPayload, currency, fixing, futures }))
    .catch(() => [])
    .then((items) => {
      macroData = { items, fetchedAt: Date.now() };
      if (boardActive()) renderMacro(items);
    })
    .finally(() => {
      macroRequest = null;
    });
}

function renderMacro(items) {
  const host = $("#boardMacro");
  if (!host) return;
  host.replaceChildren();
  host.hidden = !items || items.length === 0;
  for (const item of items || []) {
    const row = document.createElement("div");
    row.className = "macro__row";
    const name = document.createElement("span");
    name.className = "macro__name";
    name.textContent = item.name;
    const value = document.createElement("span");
    value.className = "macro__value";
    value.textContent = `${Number(item.value).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}${item.unit ? ` ${item.unit}` : ""}`;
    const change = document.createElement("span");
    change.className = `macro__change ${changeClass(item.change || 0)}`.trim();
    change.textContent = item.change === null || item.change === undefined ? "" : formatChange(item.change);
    row.append(name, value, change);
    host.appendChild(row);
  }
}

function renderMovers(movers) {
  const host = $("#boardMovers");
  if (!host) return;
  host.replaceChildren();
  const groups = [["up", "Рост дня"], ["down", "Падение дня"], ["turnover", "Оборот дня"]];
  const any = movers && groups.some(([key]) => Array.isArray(movers[key]) && movers[key].length > 0);
  host.hidden = !any;
  if (!any) return;
  for (const [key, title] of groups) {
    const list = Array.isArray(movers[key]) ? movers[key] : [];
    if (list.length === 0) continue;
    const column = document.createElement("div");
    column.className = "movers__col";
    const heading = document.createElement("h3");
    heading.className = "movers__title";
    heading.textContent = title;
    const ol = document.createElement("ol");
    ol.className = "movers__list";
    for (const stock of list) {
      const li = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "movers__row";
      row.dataset.ticker = stock.ticker;
      const ticker = document.createElement("span");
      ticker.className = "movers__ticker";
      ticker.textContent = stock.ticker;
      const name = document.createElement("span");
      name.className = "movers__name";
      name.textContent = stock.name;
      const value = document.createElement("span");
      value.className = `movers__value ${key === "turnover" ? "" : changeClass(stock.change)}`.trim();
      value.textContent = key === "turnover" ? formatMoney(stock.turnover) : formatChange(stock.change);
      row.append(ticker, name, value);
      row.setAttribute("aria-label", `${stock.name}, ${formatChange(stock.change)}, оборот ${formatMoney(stock.turnover)}. Показать новости компании`);
      row.addEventListener("click", () => showCompanyFocus(stock, row));
      li.appendChild(row);
      ol.appendChild(li);
    }
    column.append(heading, ol);
    host.appendChild(column);
  }
}

/** News of the feed about one company, newest first. */
function companyNews(stock) {
  const pattern = MoexSnapshot.companyPattern(stock.ticker, stock.name);
  if (!pattern) return [];
  return data.items
    .filter((item) => isSourceVisible(item) && pattern.test(`${item.title} ${item.excerpt}`))
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, FOCUS_NEWS_LIMIT);
}

function hideCompanyFocus(returnTo) {
  const host = $("#boardFocus");
  if (!host) return;
  host.hidden = true;
  host.replaceChildren();
  for (const node of elMarketBoard.querySelectorAll('.heat__tile[aria-pressed="true"]')) node.removeAttribute("aria-pressed");
  if (returnTo && typeof returnTo.focus === "function") returnTo.focus();
}

/** Panel under the map: the company's numbers and what the feed says about it. */
function showCompanyFocus(stock, trigger) {
  const host = $("#boardFocus");
  if (!host) return;
  for (const node of elMarketBoard.querySelectorAll('.heat__tile[aria-pressed="true"]')) node.removeAttribute("aria-pressed");
  if (trigger && trigger.classList.contains("heat__tile")) trigger.setAttribute("aria-pressed", "true");
  host.replaceChildren();
  host.hidden = false;

  const head = document.createElement("div");
  head.className = "focus__head";
  const titles = document.createElement("div");
  const title = document.createElement("h3");
  title.className = "focus__title";
  title.textContent = `${stock.name} · ${stock.ticker}`;
  const meta = document.createElement("p");
  meta.className = "focus__meta";
  const change = document.createElement("span");
  change.className = changeClass(stock.change);
  change.textContent = formatChange(stock.change);
  meta.append(`${Number(stock.price).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽ · `, change, ` · оборот ${formatMoney(Number(stock.turnover) || 0)}${stock.sector ? ` · ${stock.sector}` : ""}`);
  titles.append(title, meta);
  const actions = document.createElement("div");
  actions.className = "focus__actions";
  const watch = document.createElement("button");
  watch.type = "button";
  watch.className = "focus__watch";
  const labelWatch = () => {
    watch.textContent = isWatched(stock.ticker) ? "Убрать из моих бумаг" : "В мои бумаги";
    watch.setAttribute("aria-pressed", String(isWatched(stock.ticker)));
  };
  labelWatch();
  watch.addEventListener("click", () => {
    toggleWatched(stock.ticker);
    labelWatch();
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "focus__close";
  close.textContent = "Закрыть";
  close.setAttribute("aria-label", `Закрыть панель ${stock.name}`);
  close.addEventListener("click", () => hideCompanyFocus(trigger));
  actions.append(watch, close);
  head.append(titles, actions);
  host.appendChild(head);

  const news = companyNews(stock);
  if (news.length === 0) {
    const empty = document.createElement("p");
    empty.className = "focus__empty";
    empty.textContent = "В ленте пока нет новостей об этой компании.";
    host.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "focus__list";
    for (const item of news) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "focus__item";
      const itemTitle = document.createElement("span");
      itemTitle.className = "focus__itemTitle";
      itemTitle.textContent = item.title;
      const itemMeta = document.createElement("span");
      itemMeta.className = "focus__itemMeta";
      itemMeta.textContent = [item.sourceName, toAbsTime(item.publishedAt)].filter(Boolean).join(" · ");
      button.append(itemTitle, itemMeta);
      button.addEventListener("click", () => openModal(item.id, button));
      li.appendChild(button);
      list.appendChild(li);
    }
    host.appendChild(list);
  }
  if (typeof host.scrollIntoView === "function" && !trigger?.classList.contains("heat__tile")) host.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const closeButton = host.querySelector(".focus__close");
  if (closeButton && !trigger?.classList.contains("heat__tile")) closeButton.focus();
}


/* ── Мои бумаги и статус торгов ──────────────────────────────────────────── */

const WATCHLIST_KEY = "news:watchlist:v1";
const WATCHLIST_LIMIT = 20;
/** @type {string[]} */
let watchlist = [];
let lastBoardSnapshot = null;

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    watchlist = Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string" && /^[A-Z0-9]{1,12}$/.test(t)).slice(0, WATCHLIST_LIMIT) : [];
  } catch {
    watchlist = [];
  }
}

function saveWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
  } catch {
    // Storage may be unavailable; the list still works for this page view.
  }
}

/** Quote of a ticker from the snapshot: the full board first, the tiles as a fallback. */
function quoteFor(snapshot, ticker) {
  if (!snapshot) return null;
  const quote = snapshot.quotes && snapshot.quotes[ticker];
  if (quote) return { ticker, ...quote };
  const tile = (snapshot.stocks || []).find((s) => s.ticker === ticker);
  return tile ? { ticker, name: tile.name, price: tile.price, change: tile.change, turnover: tile.turnover, sector: tile.sector } : null;
}

function isWatched(ticker) {
  return watchlist.includes(ticker);
}

function toggleWatched(ticker) {
  if (isWatched(ticker)) watchlist = watchlist.filter((t) => t !== ticker);
  else if (watchlist.length < WATCHLIST_LIMIT) watchlist = [...watchlist, ticker];
  else return false;
  saveWatchlist();
  renderWatchlist(lastBoardSnapshot);
  return true;
}

/** Chip of one watched share; a missing quote still shows the ticker. */
function renderWatchItem(snapshot, ticker) {
  const quote = quoteFor(snapshot, ticker);
  const item = document.createElement("li");
  item.className = "watch__item";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "watch__quote";
  const code = document.createElement("span");
  code.className = "watch__ticker";
  code.textContent = ticker;
  open.appendChild(code);
  if (quote) {
    const price = document.createElement("span");
    price.className = "watch__price";
    price.textContent = `${Number(quote.price).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽`;
    const change = document.createElement("span");
    change.className = `watch__change ${changeClass(quote.change)}`.trim();
    change.textContent = formatChange(quote.change);
    open.append(price, change);
    open.setAttribute("aria-label", `${quote.name}, ${formatChange(quote.change)}, цена ${Number(quote.price).toLocaleString("ru-RU")} ₽. Показать новости компании`);
    open.addEventListener("click", () => showCompanyFocus(quote, open));
  } else {
    const missing = document.createElement("span");
    missing.className = "watch__missing";
    missing.textContent = "нет котировки";
    open.append(missing);
    open.disabled = true;
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "watch__remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Убрать ${ticker} из моих бумаг`);
  remove.addEventListener("click", () => toggleWatched(ticker));
  item.append(open, remove);
  return item;
}

function renderWatchlist(snapshot) {
  const host = $("#boardWatch");
  if (!host) return;
  host.replaceChildren();
  host.hidden = false;

  const head = document.createElement("div");
  head.className = "watch__head";
  const title = document.createElement("h3");
  title.className = "watch__title";
  title.id = "watchTitle";
  title.textContent = "Мои бумаги";
  head.appendChild(title);

  const form = document.createElement("form");
  form.className = "watch__form";
  form.setAttribute("aria-label", "Добавить бумагу в мой список");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "watch__input";
  input.placeholder = "Тикер, например SBER";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Тикер");
  input.setAttribute("list", "watchTickers");
  input.maxLength = 12;
  const list = document.createElement("datalist");
  list.id = "watchTickers";
  for (const [ticker, quote] of Object.entries((snapshot && snapshot.quotes) || {})) {
    const option = document.createElement("option");
    option.value = ticker;
    option.label = quote.name;
    list.appendChild(option);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "watch__add";
  submit.textContent = "Добавить";
  const note = document.createElement("span");
  note.className = "watch__note";
  note.setAttribute("role", "status");
  form.append(input, list, submit, note);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const ticker = input.value.trim().toUpperCase();
    if (!ticker) return;
    if (!quoteFor(lastBoardSnapshot, ticker)) {
      note.textContent = `Бумаги ${ticker} нет на основном рынке Московской биржи`;
      return;
    }
    if (isWatched(ticker)) {
      note.textContent = `${ticker} уже в списке`;
      return;
    }
    if (!toggleWatched(ticker)) note.textContent = `В списке не больше ${WATCHLIST_LIMIT} бумаг`;
  });
  head.appendChild(form);
  host.appendChild(head);

  if (watchlist.length === 0) {
    const empty = document.createElement("p");
    empty.className = "watch__empty";
    empty.textContent = "Добавьте бумаги, за которыми следите: тикером выше или кнопкой в панели компании. Список хранится на этом устройстве.";
    host.appendChild(empty);
    return;
  }
  const items = document.createElement("ul");
  items.className = "watch__list";
  for (const ticker of watchlist) items.appendChild(renderWatchItem(snapshot, ticker));
  host.appendChild(items);
}

function moscowTimeLabel(stamp) {
  const text = String(stamp || "");
  const match = text.match(/(\d{2}):(\d{2})(?::\d{2})?$/);
  return match ? `${match[1]}:${match[2]} мск` : "";
}

/** Line under the title: whether the exchange is trading and how fresh the numbers are. */
function renderSession(session, live, generatedAt) {
  const host = $("#boardSession");
  if (!host) return;
  host.replaceChildren();
  host.classList.remove("is-open", "is-closed");
  if (!session) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const open = session.status === "open";
  host.classList.add(open ? "is-open" : "is-closed");
  const dot = document.createElement("span");
  dot.className = "board__sessionDot";
  dot.setAttribute("aria-hidden", "true");
  const stamp = moscowTimeLabel(session.time) || (generatedAt ? toAbsTime(generatedAt) : "");
  const parts = [open ? "Торги идут" : "Торги закрыты"];
  if (stamp) parts.push(open ? `данные на ${stamp}` : `последние данные ${stamp}`);
  if (live && open) parts.push("задержка 15 минут");
  if (!session.fromExchange) parts.push("по расписанию биржи");
  host.append(dot, parts.join(" · "));
}


function applyFilterAndReset(reason) {
  const wanted = new Set(selectedIds());
  filtered = data.items
    .filter((item) => isSourceVisible(item) && item.categoryIds.some((id) => wanted.has(id)))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  boardShown = boardActive();
  if (!boardShown) promoteLead(filtered);
  resetFeed();
  renderNextBatch();
  if (reason !== "Фильтр" && reason !== "Источники") renderSources();
  updateMarketBoard();
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

// The lead card is the newest story with a picture among the first batch;
// the rest of the feed stays in chronological order.
function promoteLead(list) {
  const index = list.slice(0, BATCH_SIZE).findIndex((item) => item.image);
  if (index > 0) list.unshift(list.splice(index, 1)[0]);
  return list;
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
  card.className = `card${index === 0 && !boardShown ? " card--lead" : index < 3 ? " card--brief" : ""}`;
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

async function loadArticle(item) {
  if (item.contentHtml) return { contentHtml: item.contentHtml, contentTruncated: item.contentTruncated };
  const cached = articleCache.get(item.id);
  if (cached) return cached;
  const response = await fetch(`${ARTICLES_URL}${encodeURIComponent(item.id)}.json`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = await response.json();
  if (!parsed || typeof parsed.contentHtml !== "string" || !parsed.contentHtml) throw new Error("Invalid article data");
  const article = { contentHtml: parsed.contentHtml, contentTruncated: Boolean(parsed.contentTruncated) };
  articleCache.set(item.id, article);
  return article;
}

function renderModalBody(item, article, state) {
  const fallback = item.excerpt ? `<p>${escapeHtml(item.excerpt)}</p>` : "";
  let html = "";
  if (article) {
    const note = article.contentTruncated ? '<p class="reader-note">Это сокращённая версия. Полный материал доступен в источнике.</p>' : "";
    html = `${note}${sanitizeHtml(article.contentHtml)}`;
  } else if (state === "loading") {
    html = `${fallback}<p class="reader-note">Загружаем полный текст…</p>`;
  } else if (state === "error") {
    html = `${fallback}<p class="reader-note">Не удалось загрузить текст. ${item.url ? "Полный материал доступен в источнике." : "Попробуйте ещё раз позже."}</p>`;
  } else {
    const missingText = item.url ? "Полный текст этой публикации доступен в источнике." : "Текст этой публикации пока недоступен.";
    html = `${fallback}<p class="reader-note">${missingText}</p>`;
  }
  elModalBody.innerHTML = html;
  highlightModalCode();
}

function openModal(id, trigger = document.activeElement) {
  const item = filtered.find((entry) => entry.id === id) || data.items.find((entry) => entry.id === id);
  if (!item) return;
  if (!elModal.classList.contains("isOpen")) lastFocusedElement = trigger;
  const token = ++modalOpenToken;
  elModalTitle.textContent = item.title || "Без заголовка";
  const category = categoryById(item.categoryIds.find((value) => selected.has(value)) || item.categoryIds[0]);
  elModalMeta.textContent = [category?.name, item.sourceName, toAbsTime(item.publishedAt)].filter(Boolean).join(" · ");
  elModalLink.hidden = !item.url;
  if (item.url) elModalLink.href = item.url;
  else elModalLink.removeAttribute("href");
  const ready = item.contentHtml ? { contentHtml: item.contentHtml, contentTruncated: item.contentTruncated } : articleCache.get(item.id);
  if (ready) {
    renderModalBody(item, ready);
  } else if (item.hasContent) {
    renderModalBody(item, null, "loading");
    loadArticle(item).then(
      (article) => {
        if (token === modalOpenToken && elModal.classList.contains("isOpen")) renderModalBody(item, article);
      },
      () => {
        if (token === modalOpenToken && elModal.classList.contains("isOpen")) renderModalBody(item, null, "error");
      },
    );
  } else {
    renderModalBody(item, null, "missing");
  }
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
    // "no-cache" always revalidates with the server, which answers
    // "not modified" without a body when the snapshot is unchanged. A
    // cache-busting query string would defeat that.
    const response = await fetch(DATA_URL, { cache: "no-cache" });
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
  loadWatchlist();
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
