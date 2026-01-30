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
  { id: "world", name: "Мир", color: "var(--accent2)" },
  { id: "ru", name: "Россия", color: "var(--accent)" },
  { id: "business", name: "Бизнес", color: "#a8ffcb" },
  { id: "tech", name: "Технологии", color: "#b6c7ff" },
  { id: "science", name: "Наука", color: "#ffd1f1" },
  { id: "health", name: "Здоровье", color: "#ffd28a" },
  { id: "sports", name: "Спорт", color: "#9bf0ff" },
  { id: "culture", name: "Культура", color: "#ffb3b3" }
];

const DATA_URL = "data/news.json";
const BATCH_SIZE = 12;
const STORAGE_KEY = "news:selectedCats:v2";
const READER_FONT_KEY = "news:readerFontPx:v1";
const READER_FONT_DEFAULT = 16;
const READER_FONT_MIN = 13;
const READER_FONT_MAX = 22;
const READER_FONT_STEP = 1;

const LOCAL_REBUILD_PATH = "/__rebuild";
const END_POLL_INTERVAL_MS = 20 * 1000;

const AUTO_REFRESH_MS = 3 * 60 * 1000;
let lastAutoRefreshAttemptAt = 0;

const $ = (sel) => document.querySelector(sel);
const elGrid = $("#grid");
const elChips = $("#chips");
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

/** @type {Set<string>} */
let selected = new Set(["tech"]);

/** @type {{generatedAt?: string, items?: any[]}} */
let data = { generatedAt: "", items: [] };

/** @type {Array<any>} */
let filtered = [];
let rendered = 0;
let modalItemId = "";

let readerFontPx = READER_FONT_DEFAULT;

let endPollTimer = 0;

function isLocalHost() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function setStatus(text) {
  elStatus.textContent = text;
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
  document.documentElement.style.setProperty("--reader-font-size", `${readerFontPx}px`);
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
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
    if (node.tagName === "IMG") {
      keep.add("src");
      keep.add("alt");
      keep.add("title");
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
  setStatus(`${reason}: собираю данные…`);
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(selected)));
  } catch {
    // ignore
  }
}

function loadSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const allowed = new Set(CATEGORY_DEFS.map((c) => c.id));
    const next = arr.filter((x) => typeof x === "string" && allowed.has(x));
    if (next.length > 0) selected = new Set(next);
  } catch {
    // ignore
  }
}

function selectedIds() {
  return CATEGORY_DEFS.filter((c) => selected.has(c.id)).map((c) => c.id);
}

function renderChips() {
  elChips.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const c of CATEGORY_DEFS) {
    const wrap = document.createElement("div");
    wrap.className = "chip";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `cat-${c.id}`;
    input.checked = selected.has(c.id);

    const label = document.createElement("label");
    label.htmlFor = input.id;

    const dot = document.createElement("span");
    dot.className = "chip__dot";
    dot.style.background = c.color;

    const name = document.createElement("span");
    name.className = "chip__name";
    name.textContent = c.name;

    label.appendChild(dot);
    label.appendChild(name);

    input.addEventListener("change", () => {
      if (input.checked) selected.add(c.id);
      else selected.delete(c.id);
      saveSelection();
      applyFilterAndReset("Фильтр");
    });

    wrap.appendChild(input);
    wrap.appendChild(label);
    frag.appendChild(wrap);
  }

  elChips.appendChild(frag);
}

function categoryById(id) {
  return CATEGORY_DEFS.find((c) => c.id === id) || null;
}

function normalizeItem(it) {
  const publishedAt = typeof it.publishedAt === "string" ? it.publishedAt : "";
  const url = typeof it.url === "string" ? it.url : "";
  const title = typeof it.title === "string" ? it.title : "";
  const excerpt = typeof it.excerpt === "string" ? it.excerpt : "";
  const image = typeof it.image === "string" ? it.image : "";
  const sourceName = typeof it.sourceName === "string" ? it.sourceName : "";
  const contentHtml = typeof it.contentHtml === "string" ? it.contentHtml : "";
  const contentTruncated = Boolean(it.contentTruncated);
  const contentMeta = it && typeof it.contentMeta === "object" ? it.contentMeta : null;
  const id = typeof it.id === "string" ? it.id : `${url}:${publishedAt}`;
  const categoryIds = Array.isArray(it.categoryIds) ? it.categoryIds.filter((x) => typeof x === "string") : [];

  return {
    id,
    url,
    title,
    excerpt,
    image,
    sourceName,
    publishedAt,
    categoryIds,
    contentHtml,
    contentTruncated,
    contentMeta
  };
}

function applyFilterAndReset(reason) {
  const ids = selectedIds();
  if (ids.length === 0) {
    filtered = [];
    resetFeed();
    elEndText.textContent = "Выберите хотя бы одну категорию";
    setStatus("Ничего не выбрано");
    return;
  }

  const wanted = new Set(ids);
  const all = Array.isArray(data.items) ? data.items.map(normalizeItem) : [];

  filtered = all
    .filter((x) => x.categoryIds.some((c) => wanted.has(c)))
    .sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });

  resetFeed();
  renderNextBatch();

  const gen = data.generatedAt ? ` • срез: ${toAbsTime(data.generatedAt)}` : "";
  setStatus(`${reason}: ${filtered.length}${gen}`);
  updateEndText();
}

function resetFeed() {
  rendered = 0;
  elGrid.innerHTML = "";
}

function updateEndText() {
  if (!data.items || data.items.length === 0) {
    elEndText.textContent = isLocalHost()
      ? "Данных пока нет. Локально запустите сборщик: npm run build:data (или npm run dev:live)."
      : "Данных пока нет. Запустите генератор или дождитесь GitHub Action.";
    updateEndPoll();
    return;
  }
  if (filtered.length === 0) {
    elEndText.textContent = "Нет новостей по выбранным категориям";
    updateEndPoll();
    return;
  }
  if (rendered < filtered.length) {
    elEndText.textContent = `Показано ${rendered} из ${filtered.length} — листайте дальше`;
    updateEndPoll();
    return;
  }
  const gen = data.generatedAt ? toAbsTime(data.generatedAt) : "";
  if (isLocalHost()) {
    elEndText.textContent = gen
      ? `Конец текущего среза (обновлён: ${gen}). Нажмите «Обновить» — пересоберу данные локально.`
      : "Конец текущего среза. Нажмите «Обновить» — пересоберу данные локально.";
  } else {
    elEndText.textContent = gen
      ? `Конец текущего среза (обновлён: ${gen}). Новые появятся после обновления данных — нажмите «Обновить» или подождите (проверяю каждые ~3 минуты).`
      : "Конец текущего среза. Новые появятся после обновления данных — нажмите «Обновить» или подождите (проверяю каждые ~3 минуты).";
  }
  updateEndPoll();
}

function renderNextBatch() {
  const slice = filtered.slice(rendered, rendered + BATCH_SIZE);
  if (slice.length === 0) return 0;

  const frag = document.createDocumentFragment();
  for (const it of slice) frag.appendChild(renderCard(it));
  elGrid.appendChild(frag);
  rendered += slice.length;
  return slice.length;
}

function renderCard(it) {
  const el = document.createElement("article");
  el.className = "card";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `Открыть: ${it.title}`);
  el.dataset.id = it.id;

  const media = document.createElement("div");
  media.className = "card__media";
  if (it.image) {
    const img = document.createElement("img");
    img.src = it.image;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      img.remove();
      const ph = document.createElement("div");
      ph.className = "ph";
      ph.textContent = "NEWS";
      media.appendChild(ph);
    });
    media.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = "NEWS";
    media.appendChild(ph);
  }

  const body = document.createElement("div");
  body.className = "card__body";

  const meta = document.createElement("div");
  meta.className = "card__meta";

  const catId = it.categoryIds[0] || "";
  const cat = categoryById(catId);
  if (cat) {
    const tag = document.createElement("span");
    tag.className = "tag";
    const dot = document.createElement("span");
    dot.className = "tag__dot";
    dot.style.background = cat.color;
    tag.appendChild(dot);
    tag.appendChild(document.createTextNode(cat.name));
    meta.appendChild(tag);
  }

  const when = document.createElement("span");
  when.textContent = it.publishedAt ? toAbsTime(it.publishedAt) : "";
  if (when.textContent) meta.appendChild(when);

  const src = document.createElement("span");
  src.textContent = it.sourceName ? `• ${it.sourceName}` : "";
  if (src.textContent) meta.appendChild(src);

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = it.title;

  const desc = document.createElement("p");
  desc.className = "card__desc";
  desc.textContent = it.excerpt || "";

  body.appendChild(meta);
  body.appendChild(title);
  if (desc.textContent) body.appendChild(desc);

  el.appendChild(media);
  el.appendChild(body);

  el.addEventListener("click", () => openModal(it.id));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openModal(it.id);
    }
  });

  // Stagger reveal
  el.style.opacity = "0";
  el.style.transform = "translateY(8px)";
  requestAnimationFrame(() => {
    el.style.transition = "opacity 220ms ease, transform 220ms ease";
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });

  return el;
}

function openModal(id) {
  const it = filtered.find((x) => x.id === id) || (Array.isArray(data.items) ? data.items.map(normalizeItem).find((x) => x.id === id) : null);
  if (!it) return;

  modalItemId = id;
  elModalTitle.textContent = it.title;
  const meta = [it.publishedAt ? toAbsTime(it.publishedAt) : "", it.sourceName].filter(Boolean).join(" • ");
  elModalMeta.textContent = meta;
  elModalLink.href = it.url || "#";

  const html = it.contentHtml ? sanitizeHtml(it.contentHtml) : "";
  const fallback = it.excerpt ? `<p>${escapeHtml(it.excerpt)}</p>` : "";

  let hint = "";
  if (it.contentTruncated) {
    hint =
      "<p><em>Примечание: текст может быть сокращён сборщиком (ограничение на размер). Откройте первоисточник для полного текста.</em></p>";
  }

  elModalBody.innerHTML = html ? `${hint}${html}` : (fallback || "<p>Для этой новости в текущем срезе нет текста. Откройте первоисточник.</p>");

  // Apply syntax highlighting after HTML is in DOM.
  highlightModalCode();

  elModal.classList.add("isOpen");
  elModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  elModal.classList.remove("isOpen");
  elModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  modalItemId = "";
}

function bindModal() {
  elModal.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t?.dataset?.close) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && elModal.classList.contains("isOpen")) closeModal();

    // Reader-like zoom controls when modal is open.
    if (!elModal.classList.contains("isOpen")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;

    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      bumpReaderFont(READER_FONT_STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      bumpReaderFont(-READER_FONT_STEP);
    } else if (e.key === "0") {
      e.preventDefault();
      resetReaderFont();
    }
  });
}

function bindButtons() {
  elRefreshBtn.addEventListener("click", async () => {
    if (isLocalHost()) {
      try {
        await rebuildDataLocally("Обновить");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Обновить: не удалось собрать данные (${msg})`);
      }
    }
    await refreshData("Обновить");
  });
  elClearBtn.addEventListener("click", () => {
    selected = new Set();
    saveSelection();
    renderChips();
    applyFilterAndReset("Сброс");
  });
  elSelectAllBtn.addEventListener("click", () => {
    selected = new Set(CATEGORY_DEFS.map((c) => c.id));
    saveSelection();
    renderChips();
    applyFilterAndReset("Все темы");
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

  const io = new IntersectionObserver(
    (entries) => {
      const hit = entries.some((e) => e.isIntersecting);
      if (!hit) return;
      maybeRenderMore();
    },
    { root: null, rootMargin: `${margin}px 0px`, threshold: 0.01 },
  );
  io.observe(elEnd);

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
  if (elModal.classList.contains("isOpen")) return;
  if (filtered.length > 0 && rendered < filtered.length) return;
  const now = Date.now();
  if (now - lastAutoRefreshAttemptAt < AUTO_REFRESH_MS) return;
  lastAutoRefreshAttemptAt = now;

  const prevGen = typeof data.generatedAt === "string" ? data.generatedAt : "";
  setStatus("Проверяю обновления…");

  if (isLocalHost()) {
    try {
      await rebuildDataLocally("Авто");
    } catch {
      // ignore
    }
  }
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const next = await res.json();
    if (!next || typeof next !== "object") return;
    if (!Array.isArray(next.items)) return;
    const nextGen = typeof next.generatedAt === "string" ? next.generatedAt : "";
    if (nextGen && prevGen && nextGen === prevGen) {
      const gen = nextGen ? ` • срез: ${toAbsTime(nextGen)}` : "";
      setStatus(`Без изменений${gen}`);
      return;
    }
    // Swap data and re-filter; keep already rendered cards if possible.
    data = next;
    applyFilterAndReset("Обновлено");
  } catch {
    // ignore
  }
}

async function refreshData(reason) {
  const prevGen = typeof data.generatedAt === "string" ? data.generatedAt : "";
  setStatus(`${reason}: загружаю…`);
  elEndText.textContent = "Загружаю…";
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    if (!data || typeof data !== "object") data = { generatedAt: "", items: [] };
    if (!Array.isArray(data.items)) data.items = [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Ошибка данных: ${msg}`);
    elEndText.textContent = "Не удалось загрузить data/news.json";
    return;
  }

  const nextGen = typeof data.generatedAt === "string" ? data.generatedAt : "";
  const unchanged = Boolean(prevGen && nextGen && prevGen === nextGen);
  const label = unchanged && reason === "Обновить" ? "Без изменений" : reason;
  applyFilterAndReset(label);
}

function init() {
  loadReaderFont();
  applyReaderFont();

  loadSelection();
  renderChips();
  bindButtons();
  bindInfinite();
  bindModal();
  bindReaderTools();
  refreshData("Старт");
}

init();
