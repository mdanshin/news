import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

import { classifyItem, isKnownCategory } from "./classify.mjs";
import { redactSensitiveContent } from "./secrets.mjs";

const ROOT = process.cwd();
const FEEDS_PATH = path.join(ROOT, "data", "feeds.json");
// The snapshot is split in two: `news.json` is the index the feed loads on
// every visit (cards only), and `articles/<id>.json` holds the reader text of
// one item, fetched only when that item is opened.
const OUT_PATH = path.join(ROOT, "data", "news.json");
const ARTICLES_DIR = path.join(ROOT, "data", "articles");

// Card summaries longer than this are shortened in the index; the full
// summary then lives in the article file so nothing is lost for reading.
const EXCERPT_MAX_CHARS = 500;

const MAX_ITEMS_PER_SOURCE = 120;
// Every item gets its article page fetched so the reader can show the full
// text on the site; the budget per run keeps the workflow bounded and the
// newest items go first. A page that yields no text is retried a few times
// (timeouts, temporary errors) and then left alone.
const ARTICLE_FETCH_LIMIT = 400; // total pages to parse per run (keeps runtime bounded)
const MAX_CONTENT_TRIES = 3;
const IMAGE_LOOKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // look up page images only for recent items
const CONCURRENCY = 8;
const TIMEOUT_MS = 25_000;

const HISTORY_MAX_DAYS = 7;
// Fourteen sources produce well over 1500 items a day, so a lower cap would
// squeeze small sources out before the seven-day window is used up.
const HISTORY_MAX_ITEMS = 4000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const FEED_HEADERS = {
  "user-agent": "news-aggregator-pages/1.0 (+https://github.com/)"
};

// Article pages are requested the way a browser would: several sites answer
// an unknown user agent with 403 or an empty shell.
const PAGE_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "accept-encoding": "gzip, deflate, br",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1"
};

// Fields in which feeds carry the full article text. When present and long
// enough, the article page is not requested at all.
const FEED_FULL_TEXT_FIELDS = ["content:encoded", "yandex:full-text", "rbc_news:full-text", "turbo:content", "full-text", "fulltext"];
const FEED_FULL_TEXT_MIN_CHARS = 500;

function pickFullTextFromItem(item) {
  for (const key of FEED_FULL_TEXT_FIELDS) {
    const html = safeText(item[key]);
    if (!html) continue;
    const text = stripHtmlToText(html);
    if (text.length >= FEED_FULL_TEXT_MIN_CHARS) return html;
  }
  return "";
}

// Article text from JSON-LD (NewsArticle.articleBody) for pages that render
// the article client-side, where Readability finds nothing in the HTML.
function pickArticleBodyFromJsonLd(doc) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return "";
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = visit(n);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof node.articleBody === "string" && node.articleBody.trim().length > 200) return node.articleBody.trim();
    for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "hasPart"]) {
      const hit = visit(node[key]);
      if (hit) return hit;
    }
    return "";
  };
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const body = visit(JSON.parse(script.textContent || ""));
      if (body) return body;
    } catch {
      // malformed JSON-LD is common; ignore
    }
  }
  return "";
}

function paragraphsToHtml(text) {
  return text
    .split(/\n{1,}|(?<=[.!?…»"])\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
}

async function fetchText(url, { timeoutMs = TIMEOUT_MS, retries = 2, headers = FEED_HEADERS } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers
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

// Text of a parsed node. The parser represents CDATA as nested `#text`
// nodes (`{"#text": [{"#text": "…"}], "@_type": "html"}`), so text is
// collected recursively and adjacent fragments are joined.
function safeText(x) {
  if (!x) return "";
  if (Array.isArray(x)) return x.map(safeText).join("").trim();
  if (typeof x === "string") return x.trim();
  if (typeof x === "number") return String(x);
  if (typeof x === "object" && "#text" in x) return safeText(x["#text"]);
  return "";
}

function stripHtmlToText(html) {
  const dom = new JSDOM(`<div>${html || ""}</div>`);
  const t = dom.window.document.body.textContent || "";
  return t.replace(/\s+/g, " ").trim();
}

function isHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

// Image URL from a media-like node: <enclosure>, <media:content>,
// <media:thumbnail>. Non-image enclosures (audio, video) are skipped when
// the node says what it carries.
function mediaUrl(node) {
  if (!node || typeof node !== "object") return "";
  const type = String(node["@_type"] || "");
  const medium = String(node["@_medium"] || "");
  if ((type && !type.startsWith("image/")) || (medium && medium !== "image")) return "";
  const u = node["@_url"] || node.url || node["@_href"];
  return isHttpUrl(u) ? u : "";
}

function pickImageFromItem(item) {
  for (const key of ["enclosure", "media:content", "media:thumbnail", "media:group"]) {
    for (const node of toArray(item[key])) {
      // <media:group> nests the same media tags one level down.
      const candidates = key === "media:group" && node && typeof node === "object" ? [...toArray(node["media:content"]), ...toArray(node["media:thumbnail"])] : [node];
      for (const c of candidates) {
        const u = mediaUrl(c);
        if (u) return u;
      }
    }
  }

  const image = item.image;
  const imageUrl = typeof image === "string" ? image : image && typeof image === "object" ? image.url || image["@_url"] || safeText(image) : "";
  if (isHttpUrl(imageUrl)) return imageUrl;

  for (const html of [safeText(item.description), safeText(item["content:encoded"]), safeText(item["yandex:full-text"])]) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && isHttpUrl(m[1])) return m[1];
  }
  return "";
}

// Preview image declared by the article page itself (Open Graph, Twitter
// cards, or the older image_src link).
function pickImageFromPage(doc, baseUrl) {
  const selectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'link[rel="image_src"]'
  ];
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    const raw = el?.getAttribute("content") || el?.getAttribute("href") || "";
    if (!raw.trim()) continue;
    try {
      const u = new URL(raw.trim(), baseUrl).href;
      if (isHttpUrl(u)) return u;
    } catch {
      // ignore malformed values
    }
  }
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

/**
 * Items of a parsed feed in RSS 2.0 item shape. Atom feeds are converted:
 * `<link href>` becomes `link`, `published`/`updated` become `pubDate`,
 * `summary`/`content` become `description` and `<category term>` becomes
 * a plain category string.
 */
function parseFeedItems(obj) {
  const channel = obj?.rss?.channel;
  if (channel) return toArray(channel.item);

  const feed = obj?.feed;
  if (!feed) return [];
  return toArray(feed.entry).map((entry) => {
    const links = toArray(entry.link);
    const pick = (rel) => links.find((l) => l && typeof l === "object" && (l["@_rel"] || "alternate") === rel);
    const alternate = pick("alternate") || links.find((l) => typeof l === "string");
    const enclosure = pick("enclosure");
    const link = typeof alternate === "string" ? alternate : alternate?.["@_href"] || "";
    const categories = toArray(entry.category).map((c) => (c && typeof c === "object" ? c["@_term"] || c["@_label"] || safeText(c) : safeText(c)));
    return {
      title: entry.title,
      link,
      guid: safeText(entry.id),
      pubDate: safeText(entry.published) || safeText(entry.updated),
      description: entry.summary ?? entry.content,
      category: categories.filter(Boolean),
      enclosure: enclosure ? { "@_url": enclosure["@_href"] } : undefined
    };
  });
}

// Items are unique by URL, so the id is a short digest of it. It doubles as
// the article file name.
function itemId(url) {
  return createHash("sha1").update(String(url || "")).digest("hex").slice(0, 16);
}

function trimExcerpt(text) {
  const t = (text || "").trim();
  if (t.length <= EXCERPT_MAX_CHARS) return t;
  const cut = t.slice(0, EXCERPT_MAX_CHARS);
  const at = cut.lastIndexOf(" ");
  const head = at > EXCERPT_MAX_CHARS / 2 ? cut.slice(0, at) : cut;
  return `${head.replace(/[\s,;:—–-]+$/u, "")}…`;
}

async function readStoredArticle(id) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(ARTICLES_DIR, `${id}.json`), "utf8"));
    if (typeof parsed?.contentHtml !== "string" || !parsed.contentHtml) return null;
    return { contentHtml: parsed.contentHtml, contentTruncated: Boolean(parsed.contentTruncated) };
  } catch {
    return null;
  }
}

// Reader text of an item from a previous snapshot: inline in old snapshots,
// in a separate article file in new ones.
async function storedContent(raw, url) {
  if (typeof raw.contentHtml === "string" && raw.contentHtml) {
    return { contentHtml: raw.contentHtml, contentTruncated: Boolean(raw.contentTruncated) };
  }
  if (raw.hasContent) return readStoredArticle(itemId(url));
  return null;
}

function uniqueStrings(values) {
  return Array.from(new Set(toArray(values).filter((x) => typeof x === "string" && x)));
}

// Recompute categories from the source sections and text rules; items that
// end up without any category are not part of the feed.
function reclassify(items, cfg) {
  for (const item of items) item.categoryIds = classifyItem(item, cfg);
  return items.filter((item) => item.categoryIds.length > 0);
}

function extractArticleHtml(url, html) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  // Read the preview image before Readability, which prunes <head>.
  const image = pickImageFromPage(doc, url);

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
        return { content, text, title, image, diag: pageDiagnostics(doc, html) };
      }
    }
  } catch {
    // ignore
  }

  // JSON-LD is read before Readability, which rewrites the document.
  const ldBody = pickArticleBodyFromJsonLd(doc);
  const diag = pageDiagnostics(doc, html);

  const reader = new Readability(doc, {
    keepClasses: false
  });
  const parsed = reader.parse();
  let content = parsed?.content || "";
  let text = (parsed?.textContent || "").replace(/\s+/g, " ").trim();
  const title = (parsed?.title || "").trim();

  // Client-rendered pages leave Readability with nothing (or a stub shorter
  // than the structured data); fall back to the article body from JSON-LD.
  if (ldBody && text.length < Math.min(400, ldBody.length / 2)) {
    content = paragraphsToHtml(ldBody);
    text = ldBody.replace(/\s+/g, " ").trim();
  }
  return { content, text, title, image, diag };
}

// One-line description of a page that yielded no text, for the log.
function pageDiagnostics(doc, html) {
  const markers = [];
  if (/application\/ld\+json/i.test(html)) markers.push("ld+json");
  if (/__NUXT__|__NEXT_DATA__|window\.__INITIAL_STATE__/.test(html)) markers.push("spa-state");
  if (doc.querySelector("article")) markers.push("<article>");
  if (/captcha|cf-chl|challenge-platform|Just a moment/i.test(html)) markers.push("challenge");
  if (/paywall|подписк/i.test(html)) markers.push("paywall?");
  return `${html.length} bytes, ${(doc.body?.textContent || "").replace(/\s+/g, " ").trim().length} chars of text${markers.length ? `, ${markers.join(" ")}` : ""}`;
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

function redactItemSensitiveContent(item) {
  return {
    ...item,
    id: redactSensitiveContent(item.id),
    title: redactSensitiveContent(item.title),
    url: redactSensitiveContent(item.url),
    image: redactSensitiveContent(item.image),
    excerpt: redactSensitiveContent(item.excerpt),
    contentHtml: redactSensitiveContent(item.contentHtml)
  };
}

// Round-robin over sources, keeping each source's own order.
function interleaveBySource(list) {
  const queues = new Map();
  for (const x of list) {
    const key = x.sourceId || "";
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(x);
  }
  const out = [];
  const iterators = [...queues.values()].map((q) => q[Symbol.iterator]());
  let active = iterators.length;
  while (active > 0) {
    active = 0;
    for (const it of iterators) {
      const next = it.next();
      if (next.done) continue;
      active += 1;
      out.push(next.value);
    }
  }
  return out;
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

  // One unreachable or broken feed must not fail the whole build: the other
  // sources are still collected and the failure is only logged.
  const fetched = await withPool(
    sources.map((s) => async () => {
      try {
        const xml = await fetchText(s.feedUrl);
        return { source: s, xml };
      } catch (e) {
        console.error(`[feed] ${s.id}: fetch failed: ${e?.message || e}`);
        return { source: s, xml: "" };
      }
    }),
    3,
  );

  /** @type {Array<any>} */
  let items = [];

  for (const row of fetched) {
    const source = row.source;
    if (!row.xml) continue;
    let feedItems;
    try {
      feedItems = parseFeedItems(parser.parse(row.xml));
    } catch (e) {
      console.error(`[feed] ${source.id}: parse failed: ${e?.message || e}`);
      continue;
    }
    if (feedItems.length === 0) console.error(`[feed] ${source.id}: no items found`);
    const rssItems = feedItems.slice(0, MAX_ITEMS_PER_SOURCE);
    const before = items.length;

    for (const it of rssItems) {
      const title = safeText(it.title);
      const url = normalizeUrl(it);
      const publishedAt = normalizePublishedAt(it);
      const catsRaw = toArray(it.category).map(safeText).filter(Boolean);

      const image = pickImageFromItem(it);
      const descHtml = safeText(it.description);
      const excerpt = stripHtmlToText(descHtml);
      const feedHtml = pickFullTextFromItem(it);
      const feedContent = feedHtml ? sanitizeReadabilityHtml(feedHtml) : null;

      const item = {
        id: itemId(url),
        sourceId: source.id,
        sourceName: source.name,
        title,
        url,
        publishedAt,
        // Raw sections from the feed; categories are derived from them.
        sourceCategories: uniqueStrings(catsRaw),
        categoryIds: [],
        image,
        excerpt,
        contentHtml: feedContent?.html || "",
        contentTruncated: Boolean(feedContent?.truncated)
      };
      item.categoryIds = classifyItem(item, cfg);
      if (item.categoryIds.length === 0) continue;

      items.push(item);
    }
    const added = items.slice(before);
    console.log(`[feed] ${source.id}: ${rssItems.length} entries, ${added.length} with a section, ${added.filter((x) => x.contentHtml).length} with full text in the feed`);
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
    // Merge source sections (categories are recomputed from them below)
    prev.sourceCategories = uniqueStrings([...(prev.sourceCategories || []), ...(it.sourceCategories || [])]);
    // Prefer image
    if (!prev.image && it.image) prev.image = it.image;
    // Prefer excerpt
    if ((prev.excerpt || "").length < (it.excerpt || "").length) prev.excerpt = it.excerpt;
  }
  items = reclassify(Array.from(byUrl.values()), cfg);
  byUrl.clear();
  for (const it of items) byUrl.set(it.url, it);

  // Merge with previous snapshot to simulate an "infinite" feed.
  try {
    const prevRaw = await fs.readFile(OUT_PATH, "utf8");
    const prev = JSON.parse(prevRaw);
    const prevItems = Array.isArray(prev?.items) ? prev.items : [];
    for (const raw of prevItems) {
      const url = typeof raw?.url === "string" ? raw.url : "";
      if (!url) continue;
      const existing = byUrl.get(url);
      const stored = await storedContent(raw, url);
      if (existing) {
        // Prefer richer fields if the new run didn't get them.
        if (!existing.contentHtml && stored) {
          existing.contentHtml = stored.contentHtml;
          existing.contentTruncated = stored.contentTruncated;
        }
        if (Number.isInteger(raw.contentTries) && raw.contentTries > 0) existing.contentTries = raw.contentTries;
        if ((!existing.excerpt || existing.excerpt.length < 40) && typeof raw.excerpt === "string") existing.excerpt = raw.excerpt;
        if (!existing.image && typeof raw.image === "string") existing.image = raw.image;
        if (!existing.publishedAt && typeof raw.publishedAt === "string") existing.publishedAt = raw.publishedAt;
        // Categories come from the fresh feed entry (its sections are
        // authoritative), so the stored ones are intentionally not merged in.
      } else {
        // Carry forward an older item.
        const carried = {
          id: itemId(url),
          sourceId: typeof raw.sourceId === "string" ? raw.sourceId : "",
          sourceName: typeof raw.sourceName === "string" ? raw.sourceName : "",
          title: typeof raw.title === "string" ? raw.title : "",
          url,
          publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : null,
          categoryIds: Array.isArray(raw.categoryIds) ? raw.categoryIds.filter(isKnownCategory) : [],
          image: typeof raw.image === "string" ? raw.image : "",
          excerpt: typeof raw.excerpt === "string" ? raw.excerpt : "",
          contentHtml: stored ? stored.contentHtml : "",
          contentTruncated: stored ? stored.contentTruncated : false
        };
        if (Number.isInteger(raw.contentTries) && raw.contentTries > 0) carried.contentTries = raw.contentTries;
        // Snapshots written before sections were stored have no
        // `sourceCategories`; such items keep their stored categories.
        if (Array.isArray(raw.sourceCategories)) carried.sourceCategories = uniqueStrings(raw.sourceCategories);
        byUrl.set(url, carried);
      }
    }
    // Carried items are mapped with the current rules too, so a mapping
    // change applies to the whole history and not only to fresh entries.
    items = reclassify(Array.from(byUrl.values()), cfg);
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

  // Fetch article pages: first for items that lack readable text, then for
  // recent items whose feed entry came without a picture (the page usually
  // declares one). Items are newest first, so the freshest get the budget.
  const hasHtml = (x) => typeof x.contentHtml === "string" && x.contentHtml.length > 0;
  const canRetry = (x) => (x.contentTries || 0) < MAX_CONTENT_TRIES;
  const needsText = (x) => {
    if (!hasHtml(x)) return canRetry(x);
    // Habr: prefer full rebuild (older snapshots may have short HTML).
    if (x.sourceId === "habr") {
      const h = x.contentHtml.toLowerCase();
      // Before we allowed <pre>/<code>, older cached content lost code blocks.
      if (!h.includes("<pre") && !h.includes("<code")) return canRetry(x);
      return x.contentHtml.length < 8000 && canRetry(x);
    }
    return false;
  };
  // A page already fetched (it has text) but still without an image has no
  // usable picture; don't ask again. Older items are left alone as well.
  const imageCutoff = Date.now() - IMAGE_LOOKUP_MAX_AGE_MS;
  const needsImage = (x) => !x.image && !hasHtml(x) && canRetry(x) && x.publishedAt && new Date(x.publishedAt).getTime() >= imageCutoff;
  // The budget is shared fairly between sources (round-robin, newest first
  // within a source), so one high-volume source cannot starve the others.
  const needText = interleaveBySource(items.filter(needsText));
  const needImage = interleaveBySource(items.filter((x) => !needsText(x) && needsImage(x)));
  const need = [...needText, ...needImage].slice(0, ARTICLE_FETCH_LIMIT);

  /** @type {Map<string, {ok: number, empty: number, failed: number, reasons: Map<string, number>}>} */
  const fetchStats = new Map();
  const stat = (sourceId) => {
    let s = fetchStats.get(sourceId);
    if (!s) fetchStats.set(sourceId, (s = { ok: 0, empty: 0, failed: 0, reasons: new Map() }));
    return s;
  };

  await withPool(
    need.map((x) => async () => {
      x.contentTries = (x.contentTries || 0) + 1;
      const s = stat(x.sourceId);
      try {
        const html = await fetchText(x.url, { headers: PAGE_HEADERS });
        const parsed = extractArticleHtml(x.url, html);
        const cleaned = sanitizeReadabilityHtml(parsed.content);
        if (cleaned.html) {
          x.contentHtml = cleaned.html;
          // Done: no need to remember attempts once the text is in hand
          // (Habr keeps counting while its rebuild rule still applies).
          if (x.sourceId !== "habr" || cleaned.html.length >= 8000) delete x.contentTries;
          s.ok += 1;
        } else {
          s.empty += 1;
          if (!s.emptySample) s.emptySample = `${x.url}: ${parsed.diag}`;
        }
        x.contentTruncated = Boolean(cleaned.truncated);
        x.contentMeta = {
          approxChars: cleaned.approxChars,
          approxBlocks: cleaned.approxBlocks
        };
        if (!x.image && parsed.image) x.image = parsed.image;
        if (!x.excerpt && parsed.text) x.excerpt = parsed.text.slice(0, 240);
        if (!x.title && parsed.title) x.title = parsed.title;
      } catch (e) {
        s.failed += 1;
        const cause = e?.cause;
        const reason = e?.name === "AbortError" ? "timeout" : String(cause?.code || cause?.message || e?.message || e).slice(0, 60);
        s.reasons.set(reason, (s.reasons.get(reason) || 0) + 1);
        if (!s.failSample) s.failSample = `${x.url}: ${reason}`;
      }
    }),
    CONCURRENCY,
  );

  // One line per source in the workflow log: how article pages went.
  for (const [sourceId, s] of [...fetchStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const reasons = [...s.reasons.entries()].map(([r, n]) => `${r} ×${n}`).join(", ");
    console.log(`[pages] ${sourceId}: text ${s.ok}, no text ${s.empty}, failed ${s.failed}${reasons ? ` (${reasons})` : ""}`);
    if (s.emptySample) console.log(`[pages]   no text sample: ${s.emptySample}`);
    if (s.failSample) console.log(`[pages]   failure sample: ${s.failSample}`);
  }

  // Article extraction can add a previously missing excerpt, so run the
  // classification once more before writing the snapshot.
  items = reclassify(items, cfg);

  dropUnhelpfulImages(items, cfg);

  await writeSnapshot(items);
}

// How many items must share one image before it is treated as a site-wide
// placeholder. Kept high on purpose: agencies legitimately reuse one archive
// photo across a handful of related stories.
const SHARED_IMAGE_LIMIT = 8;

/**
 * Remove images that illustrate nothing: a site-wide placeholder or logo
 * reused by dozens of stories, and the auto-generated "social cards" some
 * sites return as og:image, which are just the headline drawn on a canvas —
 * the card then repeats the headline twice and the crop cuts the text.
 * Denied URL fragments per source live in `imageDeny` in data/feeds.json.
 */
function dropUnhelpfulImages(items, cfg) {
  const deny = cfg?.imageDeny || {};
  const dropped = new Map();
  const note = (sourceId, reason) => {
    const key = `${sourceId}: ${reason}`;
    dropped.set(key, (dropped.get(key) || 0) + 1);
  };

  for (const item of items) {
    if (!item.image) continue;
    for (const fragment of toArray(deny[item.sourceId])) {
      if (item.image.includes(fragment)) {
        item.image = "";
        note(item.sourceId, `шаблон ${fragment}`);
        break;
      }
    }
  }

  const uses = new Map();
  for (const item of items) {
    if (item.image) uses.set(item.image, (uses.get(item.image) || 0) + 1);
  }
  for (const item of items) {
    if (item.image && uses.get(item.image) >= SHARED_IMAGE_LIMIT) {
      note(item.sourceId, `общая картинка (${uses.get(item.image)} новостей)`);
      item.image = "";
    }
  }

  for (const [key, count] of [...dropped.entries()].sort()) {
    console.log(`[images] убрано ${count}: ${key}`);
  }
}

// Write the index and one article file per item with reader text, and
// remove article files that no longer belong to any item.
async function writeSnapshot(items) {
  /** @type {Map<string, {contentHtml: string, contentTruncated: boolean}>} */
  const articles = new Map();
  const index = [];

  for (const raw of items) {
    const item = redactItemSensitiveContent(raw);
    const excerpt = typeof item.excerpt === "string" ? item.excerpt.trim() : "";
    let contentHtml = typeof item.contentHtml === "string" ? item.contentHtml : "";
    // A long summary is the whole text for items without an article; keep
    // it readable in full through the article file.
    if (!contentHtml && excerpt.length > EXCERPT_MAX_CHARS) contentHtml = `<p>${escapeHtml(excerpt)}</p>`;
    if (contentHtml) articles.set(item.id, { contentHtml, contentTruncated: Boolean(item.contentTruncated) });

    index.push({
      id: item.id,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      ...(Array.isArray(item.sourceCategories) ? { sourceCategories: item.sourceCategories } : {}),
      categoryIds: item.categoryIds,
      image: item.image,
      excerpt: trimExcerpt(excerpt),
      hasContent: Boolean(contentHtml),
      ...(Number.isInteger(item.contentTries) && item.contentTries > 0 ? { contentTries: item.contentTries } : {})
    });
  }

  await fs.mkdir(ARTICLES_DIR, { recursive: true });
  for (const [id, article] of articles) {
    const file = path.join(ARTICLES_DIR, `${id}.json`);
    const body = JSON.stringify(article) + "\n";
    let current = "";
    try {
      current = await fs.readFile(file, "utf8");
    } catch {
      // new article
    }
    if (current !== body) await fs.writeFile(file, body, "utf8");
  }
  for (const name of await fs.readdir(ARTICLES_DIR)) {
    if (!name.endsWith(".json")) continue;
    if (!articles.has(name.slice(0, -".json".length))) await fs.unlink(path.join(ARTICLES_DIR, name));
  }

  const out = { generatedAt: new Date().toISOString(), items: index };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
}

await main();
