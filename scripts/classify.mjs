// Category assignment shared by the data builder and its tests.
//
// A news item gets categories from two places:
//   1. the section the source itself filed it under (RSS <category> values
//      and, where the site encodes the section in the URL, the URL path);
//   2. lightweight text rules for cross-cutting topics (AI, health).
//
// Rule 1 is configured in data/feeds.json. A source section is mapped only to
// site categories that genuinely correspond to it; sections without a
// matching site category are left unmapped and such items are skipped rather
// than pushed into an unrelated category.

export const CATEGORY_DEFS = {
  world: { name: "Мир" },
  ru: { name: "Россия" },
  business: { name: "Бизнес" },
  markets: { name: "Фондовый рынок" },
  tech: { name: "Технологии" },
  ai: { name: "ИИ" },
  security: { name: "Кибербезопасность" },
  science: { name: "Наука" },
  health: { name: "Здоровье" },
  sports: { name: "Спорт" },
  culture: { name: "Культура" }
};

export function isKnownCategory(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(CATEGORY_DEFS, id);
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * First path segment of an article URL ("politika" for https://tass.ru/politika/123).
 * Returns "" when the URL is missing or has no path.
 */
export function urlSection(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean)[0] || "";
    return seg.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Map the source's own sections to site categories.
 *
 * `cfg.categoryMap[sourceId]` keys are either section names as they appear in
 * the feed ("Политика") or URL path sections prefixed with "/" ("/politika").
 * A URL-section key is more specific than the feed rubric (the same RSS
 * rubric can cover several site sections), so when one matches it is used
 * instead of the rubric keys.
 */
export function mapCategories(sourceId, sourceCategories, url, cfg) {
  const map = cfg?.categoryMap?.[sourceId] || {};
  const out = new Set();

  const section = urlSection(url);
  const bySection = section ? map[`/${section}`] : undefined;
  if (bySection !== undefined) {
    for (const id of toArray(bySection)) out.add(id);
  } else {
    for (const c of toArray(sourceCategories)) {
      for (const id of toArray(lookupRubric(map, c))) out.add(id);
    }
  }

  for (const id of toArray(cfg?.defaultCategoryForSource?.[sourceId])) out.add(id);

  return Array.from(out).filter(isKnownCategory);
}

/**
 * Mapping for one feed rubric. Matching is case-insensitive and ignores
 * surrounding whitespace, dashes and slashes ("- игры", "Наука/"). A rubric
 * with a sub-rubric ("Политика / Международные новости") falls back to its
 * parent ("Политика") when it has no entry of its own.
 */
function lookupRubric(map, rubric) {
  if (typeof rubric !== "string") return undefined;
  const index = rubricIndex(map);
  const parts = rubric.split(/\s*\/\s*/).filter(Boolean);
  for (let n = parts.length; n >= 1; n -= 1) {
    const hit = index.get(normalizeRubric(parts.slice(0, n).join(" / ")));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function normalizeRubric(s) {
  return s.toLowerCase().replace(/^[\s\-–—/]+|[\s\-–—/]+$/g, "").replace(/\s+/g, " ");
}

const rubricIndexCache = new WeakMap();
function rubricIndex(map) {
  let index = rubricIndexCache.get(map);
  if (index) return index;
  index = new Map();
  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith("/")) continue; // URL-section keys
    const norm = normalizeRubric(key);
    if (!index.has(norm)) index.set(norm, value);
  }
  rubricIndexCache.set(map, index);
  return index;
}

export function inferCategoriesByText(title, excerpt) {
  const t = `${title || ""} ${excerpt || ""}`.toLowerCase();
  const out = new Set();

  if (isAiText(title, excerpt)) out.add("ai");

  // Health / medicine
  if (
    /(\bhealth\b|\bmedicine\b|здоров|медиц|врач|пациент|больниц|клиник|аптек|лекарств|препарат|вакцин|диабет|ожирен|онколог|инфекц|грипп|коронавирус|covid|фарма|психолог|психиатр|депресс|стресс|инсульт|инфаркт|бессонниц|симптом|заболеван)/i.test(
      t,
    )
  ) {
    out.add("health");
  }

  if (isSecurityText(t)) out.add("security");

  if (isMarketsText(t)) {
    out.add("markets");
    // Market news is business news; the section is a narrower view of it.
    out.add("business");
  }

  return Array.from(out);
}

// Stock markets. Two tiers again: terms that only occur in market reporting,
// and terms that need trading context ("акция" is also a protest and a sale,
// "торги" are also public procurement, "индекс" is also a search index).
//
// JavaScript's `\b` and `\w` are ASCII-only, so Cyrillic is matched with
// explicit Unicode boundaries: without a left boundary "внебиржевым" matches
// the stem "биржев", "зернотрейдера" matches "трейдер" and "акционерное
// общество" matches "акционер". Stems match any Russian ending, so they carry
// no right boundary; Latin acronyms carry one, or "ipo" would match inside
// longer Latin words.
const LETTER = "[\\p{L}\\p{N}]";
const LEFT = `(?<!${LETTER})`;
const RIGHT = `(?!${LETTER})`;
const RU = "\\p{L}*"; // any Russian ending

/** Alternation anchored at a word start; entries may add their own suffix rules. */
const anchored = (alternatives) => new RegExp(`${LEFT}(?:${alternatives.join("|")})`, "iu");
/** Whole-word alternation, for Latin acronyms and exact Russian forms. */
const word = (form) => `${form}${RIGHT}`;

export const MARKETS_STRONG = anchored([
  "мосбирж",
  `моск(?:овской|овская|овскую) бирж`,
  "ммвб",
  `индекс${RU} ртс`,
  `фондов${RU} (?:рынок|рынк${RU}|бирж${RU}|индекс${RU})`,
  "биржев",
  "котировк",
  "дивиденд",
  "облигаци",
  "делистинг",
  "листинг",
  // "акционерное общество" is a legal form, not market news.
  "акционер(?!н)",
  "трейдер",
  "брокер",
  "фьючерс",
  "опцион(?!альн)",
  "эмитент",
  `депозитарн${RU} расписк`,
  "ценны(?:е|х|ми) бумаг",
  `(?:обыкновенн|привилегированн)${RU} акци`,
  "капитализаци",
  word("офз"),
  `обратн${RU} выкуп акци`,
  "уолл-стрит(?! ?джорнал)",
  `индекс (?:мосбирж|доу|насдак|s&p)`,
  ...[`imoex\\p{N}*`, "ipo", "spo", "etf", "nasdaq", "nyse", "ftse", "stoxx", "nikkei", "buyback", "s&p ?500", "dow jones", "hang seng", "share price", "shareholders?", "stock (?:market|exchange)"].map(word),
  `wall street${RIGHT}(?! journal)`
]);

export const MARKETS_WEAK = anchored([
  ...["акци(?:я|и|й|ю|ям|ями|ях)", "торг(?:и|ах|ов|ами)"].map(word),
  // "индекс" and "бумаги" are deliberately absent: a search index or a
  // consumer price index also rises, so they would need context that only
  // the strong terms above can give. Named indices are strong terms already.
  "бирж",
  "инвестор",
  `рынок (?:акци${RU}|облигац${RU}|капитал${RU}|ценных бумаг)`
]);

export const MARKETS_CONTEXT = anchored([
  "бирж",
  "котиров",
  "акционер(?!н)",
  "дивиденд",
  "трейдер",
  "брокер",
  "эмитент",
  "капитализац",
  "облигац",
  "фьючерс",
  word("офз"),
  "подорожал",
  "подешевел",
  "вырос",
  "рост(?!ов)",
  "снижени",
  "падени",
  "снизил",
  "упал",
  "пункт",
  "процент",
  `торгов${RU} сесси`,
  "ценны(?:е|х|ми) бумаг"
]);

// Common non-market senses of the weak terms.
export const MARKETS_EXCLUDE = anchored([
  "акци(?:я|и|ю|ей) (?:протеста|неповиновения|памяти|солидарности|устрашения|возмездия)",
  `(?:протестн|благотворительн|рекламн|террористическ|гуманитарн|экологическ)${RU} акци`,
  `индекс (?:массы тела|потребительских цен|цен производителей|промышленн${RU}|производств${RU}|деловой активности|человеческого развития|счастья|бедности|качества жизни)`,
  // A protest, a rally or a strike nearby means "акция" is not a share.
  "протест",
  "митинг",
  "демонстрац",
  "пикет",
  "забастовк",
  "госзакупк",
  "торги по (?:закупк|аренде)",
  "аукцион по продаже (?:имущества|земл)"
]);

// A weak term only counts when trading context stands next to it: "индекс"
// in a story about a search index, or "торгов" in a story about fish sales,
// must not be rescued by an unrelated "вырос" elsewhere in the summary.
const NEARBY_CHARS = 80;
const MARKETS_WEAK_ALL = new RegExp(MARKETS_WEAK.source, "giu");

function hasNearbyMarketContext(t) {
  MARKETS_WEAK_ALL.lastIndex = 0;
  let match;
  while ((match = MARKETS_WEAK_ALL.exec(t)) !== null) {
    const from = Math.max(0, match.index - NEARBY_CHARS);
    const to = match.index + match[0].length + NEARBY_CHARS;
    // The matched term is blanked out so it cannot serve as its own context.
    const window = t.slice(from, match.index) + " ".repeat(match[0].length) + t.slice(match.index + match[0].length, to);
    if (MARKETS_EXCLUDE.test(window)) continue;
    if (MARKETS_CONTEXT.test(window)) return true;
  }
  return false;
}

function isMarketsText(t) {
  if (MARKETS_STRONG.test(t)) return true;
  if (MARKETS_EXCLUDE.test(t)) return false;
  return hasNearbyMarketContext(t);
}

// Artificial intelligence. A story is about AI when the headline names it or
// the headline and summary together mention it at least twice; a single
// passing mention in the summary ("память для ИИ-серверов") is not enough.
// Word boundaries around the Russian abbreviation are written explicitly
// because JavaScript's `\b` is ASCII-oriented.
const AI_TERMS =
  /(?:искусственн(?:ый|ого|ому|ым|ом) интеллект|нейросет|нейронн(?:ая|ые|ой|ую) сет|генеративн(?:ый|ого|ому|ым|ом) ии|машинн(?:ое|ого|ому|ым|ом) обучен|больш(?:ая|ой|ую|ие|их) языков(?:ая|ой|ую|ые|ых) модел|вайб-?кодинг|(?:^|[^а-яёa-z0-9])ии(?:$|[^а-яёa-z0-9])|\bartificial intelligence\b|\bgenerative ai\b|\bmachine learning\b|\bdeep learning\b|\blarge language models?\b|\bllms?\b|\bml\b|\bvibe coding\b|\bchatgpt\b|\bopenai\b|\banthropic\b|\bclaude (?:ai|\d|model)\b|(?:модель|model)\s+claude\b|\bgoogle gemini\b|(?:модель|model)\s+gemini\b|\bgemini (?:ai|\d)\b|\bgpt-?\d|\b(?:qwen|llama|deepseek|mistral|gemma|grok)(?:\d|\b)|\bcopilot\b|\bmidjourney\b|\bstable diffusion\b|\bai[- ]agents?\b)/gi;

function countMatches(re, text) {
  return (text.match(re) || []).length;
}

function isAiText(title, excerpt) {
  const head = String(title || "").toLowerCase();
  if (countMatches(AI_TERMS, head) > 0) return true;
  return countMatches(AI_TERMS, `${head} ${String(excerpt || "").toLowerCase()}`) >= 2;
}

// Cyber security. Two tiers: terms that are unambiguous on their own, and
// terms that only count next to something digital ("взлом" is also a
// burglary, "exploit" also labour, "vulnerability" also social). Bare "кибер"
// is deliberately not a signal: it covers cyberpunk games and e-sports.
const SECURITY_STRONG =
  /(?:кибер(?:атак|преступ|безопасност|угроз|шпион|мошенн|инцидент|войн|развед|полиц|расслед|защит)|хакер|уязвимост|вредонос|малвар|шифровальщик|фишинг|эксплойт|ботнет|троян|бэкдор|руткит|антивирус|пентест|инфобез|даркнет|информационн(?:ая|ой|ую) безопасност|утечк[а-я]* (?:данных|персональн|баз|информац|парол)|\bddos\b|\bmalware\b|\bransomware\b|\bspyware\b|\brootkit\b|\bphishing\b|\bcve-\d{4}-\d+|\bzero-day\b|\b0-day\b|\binfostealer|\bdata breach|\bcyber ?(?:attack|security|crime|threat|espionage)|\bhackers?\b(?! news)|\bhacked\b|\bbotnet\b|\bbackdoor\b|\bweb shell\b|\bdark ?web\b|\bcredential (?:theft|stuffing)|\binfosec\b)/i;
const SECURITY_WEAK = /(?:взлом|вымогател|\bexploit|\bvulnerabilit|\bbreach)/i;
const DIGITAL_CONTEXT =
  /(?:аккаунт|учетн(?:ая|ой|ую) запис|сайт|сервер|систем|баз[а-я]* данных|данны[ех]|парол|телефон|смартфон|компьютер|ноутбук|сет[ьи]\b|почт|приложен|мессендж|крипто|бирж|банк|\bпо\b|софт|программ|прошивк|плагин|патч|обновлен|устройств|роутер|камер|браузер|\bит\b|\bit\b|windows|linux|android|ios|iphone|chrome|api|wi-?fi|bluetooth|\bsoftware\b|\bservers?\b|\bnetwork|\bpassword|\baccounts?\b|\bdevices?\b|\bapps?\b|\brouter|\bdatabase|\bcredential|\bpatch|\bupdate|\bbrowser|\bplugin|\bfirmware|\bcloud\b|\bemail\b|\bcrypto)/i;

function isSecurityText(t) {
  if (SECURITY_STRONG.test(t)) return true;
  return SECURITY_WEAK.test(t) && DIGITAL_CONTEXT.test(t);
}

/**
 * Full category list for an item.
 *
 * Items produced by the builder carry `sourceCategories` (the raw feed
 * rubrics), so their categories are recomputed from the current mapping on
 * every build. Items carried over from a snapshot written before that field
 * existed keep their stored categories.
 */
export function classifyItem(item, cfg) {
  const fromSource = Array.isArray(item.sourceCategories)
    ? mapCategories(item.sourceId, item.sourceCategories, item.url, cfg)
    : // Legacy snapshot without the feed rubrics: the stored sections were
      // produced by older, looser rules and are not trusted. What can still
      // be derived from the URL section and the source default is used;
      // an item that has neither ends up with text-inferred sections only
      // (or none, and is then dropped from the feed).
      mapCategories(item.sourceId, [], item.url, cfg);
  const inferred = inferCategoriesByText(item.title, item.excerpt);
  return Array.from(new Set([...fromSource, ...inferred]));
}
