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
      for (const id of toArray(map[c])) out.add(id);
    }
  }

  for (const id of toArray(cfg?.defaultCategoryForSource?.[sourceId])) out.add(id);

  return Array.from(out).filter(isKnownCategory);
}

export function inferCategoriesByText(title, excerpt) {
  const t = `${title || ""} ${excerpt || ""}`.toLowerCase();
  const out = new Set();

  // Artificial intelligence. Word boundaries around the Russian abbreviation
  // are written explicitly because JavaScript's `\b` is ASCII-oriented.
  if (
    /(?:искусственн(?:ый|ого|ому|ым|ом) интеллект|нейросет|нейронн(?:ая|ые|ой|ую) сет|генеративн(?:ый|ого|ому|ым|ом) ии|машинн(?:ое|ого|ому|ым|ом) обучен|больш(?:ая|ой|ую|ие|их) языков(?:ая|ой|ую|ые|ых) модел|(?:^|[^а-яёa-z0-9])ии(?:$|[^а-яёa-z0-9])|\bartificial intelligence\b|\bgenerative ai\b|\bmachine learning\b|\bdeep learning\b|\blarge language models?\b|\bllms?\b|\bchatgpt\b|\bopenai\b|\banthropic\b|\bclaude (?:ai|\d|model)\b|(?:модель|model)\s+claude\b|\bgoogle gemini\b|(?:модель|model)\s+gemini\b|\bgemini (?:ai|\d)\b|\bgpt-?\d)/i.test(
      t,
    )
  ) {
    out.add("ai");
  }

  // Health / medicine
  if (
    /(\bhealth\b|\bmedicine\b|здоров|медиц|врач|пациент|больниц|клиник|аптек|лекарств|препарат|вакцин|диабет|ожирен|онколог|инфекц|грипп|коронавирус|covid|фарма|психолог|психиатр|депресс|стресс|инсульт|инфаркт|бессонниц|симптом|заболеван)/i.test(
      t,
    )
  ) {
    out.add("health");
  }

  // Cyber security: attacks, malware, vulnerabilities, leaks, hacking.
  // "кибер" deliberately excludes e-sports; "утечка" is only counted when it
  // is a data leak, not a gas or oil leak.
  if (
    /(?:кибер(?!спорт)|хакер|взлом|уязвимост|вредонос|шифровальщик|фишинг|эксплойт|ботнет|троян|бэкдор|антивирус|пентест|инфобез|даркнет|информационн(?:ая|ой|ую) безопасност|утечк[а-я]* (?:данных|персональн|баз|информац|парол)|\bddos\b|\bmalware\b|\bransomware\b|\bphishing\b|\bvulnerabilit|\bcve-\d{4}-\d+|\bexploit|\bzero-day\b|\b0-day\b|\binfostealer|\bdata breach|\bcyber ?(?:attack|security|crime|threat)|\bhackers?\b|\bhacked\b|\bbotnet\b|\bbackdoor\b|\bdark ?web\b)/i.test(
      t,
    )
  ) {
    out.add("security");
  }

  return Array.from(out);
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
    : toArray(item.categoryIds).filter(isKnownCategory);
  const inferred = inferCategoriesByText(item.title, item.excerpt);
  return Array.from(new Set([...fromSource, ...inferred]));
}
