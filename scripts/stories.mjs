// Groups items about the same event into "stories" and counts how many
// sources cover each one. That count is the site's only popularity signal:
// there are no view counters on a static site and feeds carry none, but an
// event that Lenta, Interfax, Kommersant and RBC all report is bigger than
// a note in one outlet.
//
// The grouping is leader clustering over tf-idf vectors of the title and the
// first lines of the description: items are walked newest first and join the
// closest recent story above a similarity threshold, or start their own.
// Russian is handled by a light suffix stemmer, enough for headlines.

const WINDOW_MS = 36 * 60 * 60 * 1000; // items further apart than this are different events
const TITLE_WEIGHT = 3;
const EXCERPT_CHARS = 300;
const SIMILARITY = 0.42;
const MIN_TOKEN = 3;

const STOPWORDS = new Set(`
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему
теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут
где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой
совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после
над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя
такой им более всегда конечно всю между это также который которые которая которых также об также свой свои своих своей его их
года году годах лет год рублей млн млрд тыс процентов процента процент раз также сообщил сообщила сообщили сообщает заявил заявила
заявили заявляет рассказал рассказала отметил отметила пишет передает передаёт стало известно источник источника данным данные
россии российской российских российский российская российские рф россия москве москвы москва сша
`.trim().split(/\s+/));

// Endings stripped from a Cyrillic token when the stem stays long enough.
const SUFFIXES = [
  "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ешь", "ишь", "ете", "ите", "ует", "уют", "ают", "яют", "ить", "ать", "ять", "еть",
  "ой", "ей", "ах", "ях", "ам", "ям", "ов", "ев", "ий", "ый", "ая", "яя", "ое", "ее", "ые", "ие", "ом", "ем", "ть", "ла", "ли", "ло", "ет", "ут", "ют", "ит", "ат", "ят",
  "а", "я", "ы", "и", "у", "ю", "о", "е", "ь"
];

export function stem(token) {
  if (!/^[а-я]+$/.test(token)) return token;
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/u)
    .filter((token) => token.length >= MIN_TOKEN && !STOPWORDS.has(token))
    .map(stem)
    .filter((token) => token.length >= MIN_TOKEN);
}

function termCounts(item) {
  const counts = new Map();
  for (const token of tokens(item.title)) counts.set(token, (counts.get(token) || 0) + TITLE_WEIGHT);
  for (const token of tokens(String(item.excerpt || "").slice(0, EXCERPT_CHARS))) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function normalise(vector) {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  const out = new Map();
  for (const [term, value] of vector) out.set(term, value / norm);
  return out;
}

function dot(a, b) {
  let sum = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, value] of small) {
    const other = large.get(term);
    if (other) sum += value * other;
  }
  return sum;
}

function add(target, vector) {
  for (const [term, value] of vector) target.set(term, (target.get(term) || 0) + value);
}

/**
 * Stories with their members, newest first. Every item lands in exactly one
 * story; `sources` is the number of distinct outlets, the popularity signal.
 */
export function buildStories(items, { similarity = SIMILARITY, windowMs = WINDOW_MS } = {}) {
  const list = items
    .filter((item) => item && item.id && item.title)
    .map((item) => ({ item, time: Date.parse(item.publishedAt) || 0, counts: termCounts(item) }))
    .sort((a, b) => b.time - a.time);

  const df = new Map();
  for (const entry of list) for (const term of entry.counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  const idf = (term) => Math.log((list.length + 1) / ((df.get(term) || 0) + 1)) + 1;
  for (const entry of list) {
    const weighted = new Map();
    for (const [term, count] of entry.counts) weighted.set(term, count * idf(term));
    entry.vector = normalise(weighted);
  }

  /** @type {{members: any[], centroid: Map<string, number>, latest: number, earliest: number}[]} */
  const stories = [];
  for (const entry of list) {
    let best = null;
    let bestSim = similarity;
    for (const story of stories) {
      if (story.earliest - entry.time > windowMs || entry.time - story.latest > windowMs) continue;
      const sim = dot(entry.vector, normalise(story.centroid));
      if (sim >= bestSim) {
        bestSim = sim;
        best = story;
      }
    }
    if (best) {
      best.members.push(entry);
      add(best.centroid, entry.vector);
      best.earliest = Math.min(best.earliest, entry.time);
      best.latest = Math.max(best.latest, entry.time);
    } else {
      stories.push({ members: [entry], centroid: new Map(entry.vector), earliest: entry.time, latest: entry.time });
    }
  }

  return stories.map((story) => {
    const centroid = normalise(story.centroid);
    // The headline is the member closest to the centre of the story.
    const lead = story.members.reduce((acc, entry) => (dot(entry.vector, centroid) > dot(acc.vector, centroid) ? entry : acc), story.members[0]);
    const sources = new Set(story.members.map((entry) => entry.item.sourceId || entry.item.sourceName || ""));
    return {
      id: lead.item.id,
      title: lead.item.title,
      sources: sources.size,
      publishedAt: new Date(story.latest).toISOString(),
      itemIds: story.members.map((entry) => entry.item.id)
    };
  });
}

/** Only the stories worth showing: several outlets, newest first. */
export function topStories(items, { minSources = 2, limit = 100, ...options } = {}) {
  return buildStories(items, options)
    .filter((story) => story.sources >= minSources)
    .sort((a, b) => b.sources - a.sources || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
}
