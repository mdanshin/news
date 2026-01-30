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

/** @type {Set<string>} */
let selected = new Set(["tech"]);

/** @type {{generatedAt?: string, items?: any[]}} */
let data = { generatedAt: "", items: [] };

/** @type {Array<any>} */
let filtered = [];
let rendered = 0;
let modalItemId = "";

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

function sanitizeHtml(html) {
  // Allow a small safe subset; remove all scripts/handlers.
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;

  const allowed = new Set(["P", "BR", "B", "STRONG", "I", "EM", "A", "IMG", "UL", "OL", "LI"]);
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
    contentHtml
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
    elEndText.textContent = "Данных пока нет. Запустите генератор или дождитесь GitHub Action.";
    return;
  }
  if (filtered.length === 0) {
    elEndText.textContent = "Нет новостей по выбранным категориям";
    return;
  }
  if (rendered < filtered.length) {
    elEndText.textContent = `Показано ${rendered} из ${filtered.length} — листайте дальше`;
    return;
  }
  elEndText.textContent = "Конец текущего среза";
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
  elModalBody.innerHTML =
    html ||
    fallback ||
    "<p>Для этой новости в текущем срезе нет текста. Откройте первоисточник.</p>";

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
  });
}

function bindButtons() {
  elRefreshBtn.addEventListener("click", () => refreshData("Обновить"));
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

function bindInfinite() {
  const io = new IntersectionObserver(
    (entries) => {
      const hit = entries.some((e) => e.isIntersecting);
      if (!hit) return;
      const added = renderNextBatch();
      if (added > 0) updateEndText();
    },
    { root: null, rootMargin: "600px 0px", threshold: 0.01 },
  );
  io.observe(elEnd);
}

async function refreshData(reason) {
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

  applyFilterAndReset(reason);
}

function init() {
  loadSelection();
  renderChips();
  bindButtons();
  bindInfinite();
  bindModal();
  refreshData("Старт");
}

init();
