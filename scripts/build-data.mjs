import fs from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const ROOT = process.cwd();
const FEEDS_PATH = path.join(ROOT, "data", "feeds.json");
const OUT_PATH = path.join(ROOT, "data", "news.json");

const MAX_ITEMS_PER_SOURCE = 45;
const ARTICLE_FETCH_LIMIT = 70; // total pages to parse (keeps runtime bounded)
const CONCURRENCY = 6;
const TIMEOUT_MS = 25_000;

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
  if (enc && typeof enc === "object") {
    const u = enc["@_url"] || enc.url;
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

function extractArticleHtml(url, html) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document, {
    keepClasses: false
  });
  const parsed = reader.parse();
  const content = parsed?.content || "";
  const text = (parsed?.textContent || "").replace(/\s+/g, " ").trim();
  const title = (parsed?.title || "").trim();
  return { content, text, title };
}

function clampHtmlToParagraphs(html, maxParas = 16) {
  const dom = new JSDOM(`<div>${html || ""}</div>`);
  const doc = dom.window.document;
  const ps = Array.from(doc.querySelectorAll("p"));
  const picked = [];
  for (const p of ps) {
    const t = (p.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length < 40) continue;
    picked.push(`<p>${escapeHtml(t)}</p>`);
    if (picked.length >= maxParas) break;
  }
  return picked.join("");
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

      const categoryIds = mapCategories(source.id, catsRaw, cfg);
      if (categoryIds.length === 0) continue;

      const image = pickImageFromItem(it);
      const descHtml = safeText(it.description);
      const excerpt = stripHtmlToText(descHtml);

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

  // Sort newest first.
  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  // Fetch article pages for missing text.
  const need = items
    .filter((x) => {
      if (x.contentHtml) return false;
      // Habr RSS includes only an excerpt + "Читать далее".
      if (x.sourceId === "habr") return true;
      return (x.excerpt || "").length < 60;
    })
    .slice(0, ARTICLE_FETCH_LIMIT);

  await withPool(
    need.map((x) => async () => {
      try {
        const html = await fetchText(x.url);
        const parsed = extractArticleHtml(x.url, html);
        const pickedHtml = clampHtmlToParagraphs(parsed.content, 16);
        if (pickedHtml) x.contentHtml = pickedHtml;
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
