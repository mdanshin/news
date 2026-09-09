import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

import { classifyItem, isKnownCategory } from "./classify.mjs";

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
const ARTICLE_FETCH_LIMIT = 120; // total pages to parse (keeps runtime bounded)
const CONCURRENCY = 6;
const TIMEOUT_MS = 25_000;

const HISTORY_MAX_DAYS = 7;
const HISTORY_MAX_ITEMS = 1500;

const REDACTED_SECRET = "[REDACTED_SECRET]";
const REDACTED_PRIVATE_KEY = "[REDACTED_PRIVATE_KEY]";

const SECRET_REDACTIONS = [
  {
    pattern: /-----BEGIN [^-]{0,80}PRIVATE KEY-----[\s\S]*?-----END [^-]{0,80}PRIVATE KEY-----/g,
    replacement: REDACTED_PRIVATE_KEY
  },
  {
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    replacement: REDACTED_PRIVATE_KEY
  },
  {
    pattern: /-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    replacement: REDACTED_PRIVATE_KEY
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bghp_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]+\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bsk-[A-Za-z0-9]{32,}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\b[0-9]{6,10}:[A-Za-z0-9_-]{35,}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: REDACTED_SECRET
  },
  {
    pattern: /\b(?:sk_live|rk_live|pk_live)_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTED_SECRET
  }
];

const URL_CREDENTIAL_PATTERN = /(https?:\/\/[^/\s:@"'<>]+:)(?!\[REDACTED_)([^@\s"'<>]+)(@)/gi;
const AUTH_HEADER_PATTERN = /(\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic)\s+)(?!\[REDACTED_)[A-Za-z0-9._~+/=-]{8,}/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:access_token|refresh_token|token|api_key|apikey|key|signature|x-amz-signature|x-amz-credential|awsaccesskeyid)=)(?!\[REDACTED_)[^&#\s"'<>]{8,}/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|jwt[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'`]?)(?!\[REDACTED_)([^"'`\s<>&;,\\]{8,})/gi;

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

function redactSensitiveContent(value) {
  if (typeof value !== "string" || value.length === 0) return value || "";

  let out = value;
  for (const { pattern, replacement } of SECRET_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }

  out = out
    .replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED_SECRET}$3`)
    .replace(AUTH_HEADER_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(SENSITIVE_QUERY_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, `$1${REDACTED_SECRET}`);

  return out;
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

    for (const it of rssItems) {
      const title = safeText(it.title);
      const url = normalizeUrl(it);
      const publishedAt = normalizePublishedAt(it);
      const catsRaw = toArray(it.category).map(safeText).filter(Boolean);

      const image = pickImageFromItem(it);
      const descHtml = safeText(it.description);
      const excerpt = stripHtmlToText(descHtml);

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
        contentHtml: ""
      };
      item.categoryIds = classifyItem(item, cfg);
      if (item.categoryIds.length === 0) continue;

      items.push(item);
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

  // Article extraction can add a previously missing excerpt, so run the
  // classification once more before writing the snapshot.
  items = reclassify(items, cfg);

  await writeSnapshot(items);
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
      hasContent: Boolean(contentHtml)
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
