import fs from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const ROOT = process.cwd();
const FEEDS_PATH = path.join(ROOT, "data", "feeds.json");
const OUT_PATH = path.join(ROOT, "data", "news.json");

const MAX_ITEMS_PER_SOURCE = 120;
const ARTICLE_FETCH_LIMIT = 120; // total pages to parse (keeps runtime bounded)
const CONCURRENCY = 6;
const TIMEOUT_MS = 25_000;

const HISTORY_MAX_DAYS = 7;
const HISTORY_MAX_ITEMS = 1500;

const CATEGORY_DEFS = {
  world: { name: "Мир" },
  ru: { name: "Россия" },
  business: { name: "Бизнес" },
  tech: { name: "Технологии" },
  science: { name: "Наука" },
  health: { name: "Здоровье" },
  sports: { name: "Спорт" },
  culture: { name: "Культура" }
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, { timeoutMs = TIMEOUT_MS, retries = 2 } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "user-agent": "news-aggregator-pages/1.0 (+https://github.com/)"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      if (i < retries) await sleep(350 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw last || new Error("fetch failed");
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function safeText(x) {
  if (!x) return "";
  if (Array.isArray(x)) return safeText(x[0]);
  if (typeof x === "string") return x.trim();
  if (typeof x === "number") return String(x);
  if (typeof x === "object" && typeof x["#text"] === "string") return x["#text"].trim();
  return "";
}

function stripHtmlToText(html) {
  const dom = new JSDOM(`<div>${html || ""}</div>`);
  const t = dom.window.document.body.textContent || "";
  return t.replace(/\s+/g, " ").trim();
}

function pickImageFromItem(item) {
  const enc = item.enclosure;
  const encFirst = Array.isArray(enc) ? enc[0] : enc;
  if (encFirst && typeof encFirst === "object") {
    const u = encFirst["@_url"] || encFirst.url;
    if (typeof u === "string" && /^https?:/i.test(u)) return u;
  }

  const desc = safeText(item.description);
  const m = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1] && /^https?:/i.test(m[1])) return m[1];
  return "";
}

function normalizePublishedAt(item) {
  const raw = safeText(item.pubDate) || safeText(item.published) || safeText(item["dc:date"]);
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeUrl(item) {
  const link = safeText(item.link);
  const guid = safeText(item.guid);
  const u = link || guid;
  return u;
}

function buildId(sourceId, url, publishedAt, title) {
  return `${sourceId}:${url || ""}:${publishedAt || ""}:${(title || "").slice(0, 40)}`;
}

function mapCategories(sourceId, itemCats, cfg) {
  const map = cfg.categoryMap?.[sourceId] || {};
  const out = new Set();

  for (const c of itemCats) {
    const v = map[c];
    for (const id of toArray(v)) out.add(id);
  }
  for (const id of toArray(cfg.defaultCategoryForSource?.[sourceId])) out.add(id);

  // Drop unknown
  for (const id of Array.from(out)) {
    if (!CATEGORY_DEFS[id]) out.delete(id);
  }
  return Array.from(out);
}

function inferCategoriesByText(title, excerpt) {
  const t = `${title || ""} ${excerpt || ""}`.toLowerCase();
  const out = new Set();

  // Health / medicine
  if (
    /(\bhealth\b|\bmedicine\b|здоров|медиц|врач|пациент|больниц|клиник|аптек|лекарств|препарат|вакцин|диабет|ожирен|онколог|инфекц|грипп|коронавирус|covid|фарма|психолог|психиатр|депресс|стресс)/i.test(
      t,
    )
  ) {
    out.add("health");
  }

  return Array.from(out);
}

function extractArticleHtml(url, html) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Habr: keep original markup (code classes like "bash", "yaml", etc.)
  // Readability often strips these, which breaks language-aware highlighting.
  try {
    const u = new URL(url);
    if (u.hostname === "habr.com" || u.hostname.endsWith(".habr.com")) {
      const body = doc.querySelector(".article-formatted-body") || doc.querySelector(".tm-article-body");
      if (body) {
        const content = body.innerHTML || "";
        const text = (body.textContent || "").replace(/\s+/g, " ").trim();
        const title = (doc.querySelector("h1")?.textContent || "").replace(/\s+/g, " ").trim();
        return { content, text, title };
      }
    }
  } catch {
    // ignore
  }

  const reader = new Readability(doc, {
    keepClasses: false
  });
  const parsed = reader.parse();
  const content = parsed?.content || "";
  const text = (parsed?.textContent || "").replace(/\s+/g, " ").trim();
  const title = (parsed?.title || "").trim();
  return { content, text, title };
}

function sanitizeReadabilityHtml(html, { maxBlocks = 1500, maxChars = 220_000 } = {}) {
  const dom = new JSDOM(`<div>${html || ""}</div>`);
  const doc = dom.window.document;
  const root = doc.body.firstElementChild;

  // Drop scripts/styles early.
  for (const bad of Array.from(root.querySelectorAll("script,style,noscript"))) bad.remove();

  // Keep a readable subset.
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

  const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_ELEMENT);
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

    // Remove most attrs.
    const keep = new Set();
    if (node.tagName === "A") keep.add("href");
    if (node.tagName === "IMG") {
      keep.add("src");
      keep.add("alt");
    }
    if (node.tagName === "CODE" || node.tagName === "PRE" || node.tagName === "KBD") {
      // Preserve language hints like: class="language-js".
      keep.add("class");
    }
    for (const a of Array.from(node.attributes)) {
      if (!keep.has(a.name)) node.removeAttribute(a.name);
    }
  }

  // Limit size without cutting mid-DOM: keep first N "blocks".
  const blocks = Array.from(
    root.querySelectorAll("h2,h3,p,blockquote,li,figure,figcaption,img,pre"),
  );

  let kept = 0;
  let chars = 0;
  let truncated = false;
  const toRemove = [];
  for (const el of blocks) {
    if (kept >= maxBlocks || chars >= maxChars) {
      truncated = true;
      toRemove.push(el);
      continue;
    }
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t) chars += t.length;
    kept += 1;
  }
  for (const el of toRemove) el.remove();

  return { html: root.innerHTML, truncated, approxChars: chars, approxBlocks: kept };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function withPool(tasks, limit) {
  const out = [];
  let i = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    for (;;) {
      const idx = i;
      i += 1;
      if (idx >= tasks.length) return;
      out[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(FEEDS_PATH, "utf8"));
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
    trimValues: true,
    cdataPropName: "#text"
  });

  const sources = toArray(cfg.sources);

  const fetched = await withPool(
    sources.map((s) => async () => {
      const xml = await fetchText(s.feedUrl);
      return { source: s, xml };
    }),
    3,
  );

  /** @type {Array<any>} */
  let items = [];

  for (const row of fetched) {
    const source = row.source;
    const obj = parser.parse(row.xml);
    const channel = obj?.rss?.channel;
    const rssItems = toArray(channel?.item).slice(0, MAX_ITEMS_PER_SOURCE);

    for (const it of rssItems) {
      const title = safeText(it.title);
      const url = normalizeUrl(it);
      const publishedAt = normalizePublishedAt(it);
      const catsRaw = toArray(it.category).map(safeText).filter(Boolean);

      const image = pickImageFromItem(it);
      const descHtml = safeText(it.description);
      const excerpt = stripHtmlToText(descHtml);

      const mapped = mapCategories(source.id, catsRaw, cfg);
      const inferred = inferCategoriesByText(title, excerpt);
      const categoryIds = Array.from(new Set([...mapped, ...inferred]));
      if (categoryIds.length === 0) continue;

      items.push({
        id: buildId(source.id, url, publishedAt, title),
        sourceId: source.id,
        sourceName: source.name,
        title,
        url,
        publishedAt,
        categoryIds,
        image,
        excerpt,
        contentHtml: ""
      });
    }
  }

  // Deduplicate by url.
  const byUrl = new Map();
  for (const it of items) {
    if (!it.url) continue;
    const prev = byUrl.get(it.url);
    if (!prev) {
      byUrl.set(it.url, it);
      continue;
    }
    // Merge categories
    const cats = new Set([...(prev.categoryIds || []), ...(it.categoryIds || [])]);
    prev.categoryIds = Array.from(cats);
    // Prefer image
    if (!prev.image && it.image) prev.image = it.image;
    // Prefer excerpt
    if ((prev.excerpt || "").length < (it.excerpt || "").length) prev.excerpt = it.excerpt;
  }
  items = Array.from(byUrl.values());

  // Merge with previous snapshot to simulate an "infinite" feed.
  try {
    const prevRaw = await fs.readFile(OUT_PATH, "utf8");
    const prev = JSON.parse(prevRaw);
    const prevItems = Array.isArray(prev?.items) ? prev.items : [];
    for (const raw of prevItems) {
      const url = typeof raw?.url === "string" ? raw.url : "";
      if (!url) continue;
      const existing = byUrl.get(url);
      if (existing) {
        // Prefer richer fields if the new run didn't get them.
        if (!existing.contentHtml && typeof raw.contentHtml === "string") existing.contentHtml = raw.contentHtml;
        if ((!existing.excerpt || existing.excerpt.length < 40) && typeof raw.excerpt === "string") existing.excerpt = raw.excerpt;
        if (!existing.image && typeof raw.image === "string") existing.image = raw.image;
        if (!existing.publishedAt && typeof raw.publishedAt === "string") existing.publishedAt = raw.publishedAt;
        // Union categories
        const cats = new Set([...(existing.categoryIds || [])]);
        for (const c of Array.isArray(raw.categoryIds) ? raw.categoryIds : []) {
          if (typeof c === "string" && CATEGORY_DEFS[c]) cats.add(c);
        }
        existing.categoryIds = Array.from(cats);
      } else {
        // Carry forward an older item.
        const carried = {
          id: typeof raw.id === "string" ? raw.id : buildId(String(raw.sourceId || ""), url, String(raw.publishedAt || ""), String(raw.title || "")),
          sourceId: typeof raw.sourceId === "string" ? raw.sourceId : "",
          sourceName: typeof raw.sourceName === "string" ? raw.sourceName : "",
          title: typeof raw.title === "string" ? raw.title : "",
          url,
          publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : null,
          categoryIds: Array.isArray(raw.categoryIds) ? raw.categoryIds.filter((x) => typeof x === "string" && CATEGORY_DEFS[x]) : [],
          image: typeof raw.image === "string" ? raw.image : "",
          excerpt: typeof raw.excerpt === "string" ? raw.excerpt : "",
          contentHtml: typeof raw.contentHtml === "string" ? raw.contentHtml : ""
        };
        byUrl.set(url, carried);
      }
    }
    items = Array.from(byUrl.values());
  } catch {
    // no previous snapshot
  }

  // Sort newest first.
  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  // Prune history.
  const cutoff = Date.now() - HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
  items = items
    .filter((x) => {
      if (!x.publishedAt) return true;
      const t = new Date(x.publishedAt).getTime();
      if (Number.isNaN(t)) return true;
      return t >= cutoff;
    })
    .slice(0, HISTORY_MAX_ITEMS);

  // Fetch article pages for missing text.
  const need = items
    .filter((x) => {
      const hasHtml = typeof x.contentHtml === "string" && x.contentHtml.length > 0;

      // Habr: prefer full rebuild (older snapshots may have short HTML).
      if (x.sourceId === "habr") {
        if (!hasHtml) return true;
        const h = x.contentHtml.toLowerCase();
        // Before we allowed <pre>/<code>, older cached content lost code blocks.
        if (!h.includes("<pre") && !h.includes("<code")) return true;
        return x.contentHtml.length < 8000;
      }

      if (hasHtml) return false;
      return (x.excerpt || "").length < 60;
    })
    .slice(0, ARTICLE_FETCH_LIMIT);

  await withPool(
    need.map((x) => async () => {
      try {
        const html = await fetchText(x.url);
        const parsed = extractArticleHtml(x.url, html);
        const cleaned = sanitizeReadabilityHtml(parsed.content);
        if (cleaned.html) x.contentHtml = cleaned.html;
        x.contentTruncated = Boolean(cleaned.truncated);
        x.contentMeta = {
          approxChars: cleaned.approxChars,
          approxBlocks: cleaned.approxBlocks
        };
        if (!x.excerpt && parsed.text) x.excerpt = parsed.text.slice(0, 240);
        if (!x.title && parsed.title) x.title = parsed.title;
      } catch {
        // ignore
      }
    }),
    CONCURRENCY,
  );

  const out = {
    generatedAt: new Date().toISOString(),
    items
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
}

await main();
