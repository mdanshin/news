import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CATEGORY_DEFS, classifyItem, inferCategoriesByText, isKnownCategory, mapCategories, urlSection } from "./classify.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "data/feeds.json"), "utf8"));

function item(overrides) {
  return { sourceId: "lenta", title: "", excerpt: "", url: "", ...overrides };
}

test("feeds.json only references known categories and known sources", () => {
  const sourceIds = new Set(cfg.sources.map((s) => s.id));
  for (const [sourceId, map] of Object.entries(cfg.categoryMap)) {
    assert.ok(sourceIds.has(sourceId), `categoryMap has unknown source ${sourceId}`);
    for (const [section, ids] of Object.entries(map)) {
      assert.ok(Array.isArray(ids) && ids.length > 0, `${sourceId}: ${section} maps to nothing`);
      for (const id of ids) assert.ok(isKnownCategory(id), `${sourceId}: ${section} -> unknown category ${id}`);
    }
  }
  for (const [sourceId, ids] of Object.entries(cfg.defaultCategoryForSource)) {
    assert.ok(sourceIds.has(sourceId));
    for (const id of ids) assert.ok(isKnownCategory(id));
  }
  assert.deepEqual(Object.keys(CATEGORY_DEFS), ["world", "ru", "business", "markets", "tech", "ai", "security", "science", "health", "sports", "culture"]);
  const ids = new Set(cfg.sources.map((s) => s.id));
  assert.equal(ids.size, cfg.sources.length, "source ids must be unique");
  for (const s of cfg.sources) assert.match(s.feedUrl, /^https:\/\//);
});

test("security sources and Habr security hub land in the security section", () => {
  for (const id of ["xakep", "thehackernews"]) {
    assert.deepEqual(mapCategories(id, [], `https://example.com/${id}/1`, cfg), ["security"], id);
  }
  // SecurityLab and BleepingComputer publish general tech and science news as
  // well; their feed rubrics decide, and an unmapped rubric means no section.
  assert.deepEqual(mapCategories("securitylab", ["Наука/"], "https://www.securitylab.ru/news/1.php", cfg), ["science"]);
  assert.deepEqual(mapCategories("securitylab", ["Технологии/"], "https://www.securitylab.ru/news/2.php", cfg), ["tech"]);
  assert.deepEqual(mapCategories("securitylab", ["Отчеты/"], "https://www.securitylab.ru/news/3.php", cfg), ["security"]);
  assert.deepEqual(mapCategories("securitylab", ["Право/"], "https://www.securitylab.ru/news/4.php", cfg), []);
  assert.deepEqual(mapCategories("securitylab", [], "https://www.securitylab.ru/news/5.php", cfg), []);
  assert.deepEqual(mapCategories("bleepingcomputer", ["Security"], "https://www.bleepingcomputer.com/news/security/x/", cfg), ["security"]);
  assert.deepEqual(mapCategories("bleepingcomputer", ["Microsoft", "Software"], "https://www.bleepingcomputer.com/news/microsoft/x/", cfg), ["tech"]);
  assert.deepEqual(mapCategories("bleepingcomputer", ["Artificial Intelligence", "Security"], "https://www.bleepingcomputer.com/news/x/", cfg), ["ai", "security"]);
  assert.deepEqual(mapCategories("3dnews", ["- вирусы, трояны, уязвимости в ПО, вопросы безопасности"], "https://3dnews.ru/1", cfg), ["security", "tech"]);
  assert.deepEqual(mapCategories("3dnews", ["- игры"], "https://3dnews.ru/2", cfg), ["tech"]);
  // Habr hubs are chosen by authors for reach and are not trusted: the text decides.
  assert.deepEqual(mapCategories("habr", ["Информационная безопасность", "Kubernetes"], "https://habr.com/ru/articles/1/", cfg), ["tech"]);
  assert.deepEqual(mapCategories("habr", ["Машинное обучение"], "https://habr.com/ru/articles/1/", cfg), ["tech"]);
  assert.deepEqual(mapCategories("nplus1", ["Физика"], "https://nplus1.ru/news/2026/09/09/x", cfg), ["science"]);
  assert.deepEqual(mapCategories("3dnews", [], "https://3dnews.ru/1", cfg), ["tech"]);
  assert.deepEqual(mapCategories("rbc", ["Политика"], "https://www.rbc.ru/rbcfreenews/1", cfg), ["ru"]);
  assert.deepEqual(mapCategories("rbc", ["Общество"], "https://www.rbc.ru/technology_and_media/09/09/2026/1", cfg), ["tech"]);
  assert.deepEqual(mapCategories("vedomosti", ["Мнения"], "https://www.vedomosti.ru/opinion/articles/2026/09/09/x", cfg), []);
  assert.deepEqual(mapCategories("vedomosti", ["Технологии"], "https://www.vedomosti.ru/technology/news/2026/09/09/x", cfg), ["tech"]);
});

test("rubrics match case-insensitively, with sub-rubrics falling back to the parent", () => {
  // Vedomosti files foreign news under «Политика / Международные новости».
  assert.deepEqual(mapCategories("vedomosti", ["Политика / Международные новости"], "https://www.vedomosti.ru/politics/news/1", cfg), ["world"]);
  assert.deepEqual(mapCategories("vedomosti", ["Политика / Власть"], "https://www.vedomosti.ru/politics/news/2", cfg), ["ru"]);
  assert.deepEqual(mapCategories("vedomosti", ["Бизнес / Транспорт"], "https://www.vedomosti.ru/business/news/3", cfg), ["business"]);
  assert.deepEqual(mapCategories("vedomosti", ["Финансы / Банки"], "https://www.vedomosti.ru/finance/news/4", cfg), ["business"]);
  // Case and decoration of the feed rubric do not matter.
  assert.deepEqual(mapCategories("3dnews", ["- искусственный интеллект, машинное обучение, нейросети"], "https://3dnews.ru/3", cfg), ["ai", "tech"]);
  assert.deepEqual(mapCategories("bleepingcomputer", ["SECURITY"], "https://www.bleepingcomputer.com/news/x/", cfg), ["security"]);
  assert.deepEqual(mapCategories("securitylab", ["наука"], "https://www.securitylab.ru/news/9.php", cfg), ["science"]);
});

test("AI needs the headline or two mentions; Habr hubs alone do not count", () => {
  const mathroots = item({
    sourceId: "habr",
    title: "Как я объяснял племяннику 2x + 4 = 10 и случайно собрал визуальную лабораторию",
    excerpt: "Из этого вопроса вырос MathRoots — мой эксперимент с математикой как dependency graph.",
    url: "https://habr.com/ru/articles/1/",
    sourceCategories: ["математика", "нейросети", "искусственный интеллект", "React"]
  });
  assert.deepEqual(classifyItem(mathroots, cfg), ["tech"]);
  assert.deepEqual(inferCategoriesByText("Китайская Rayson представила память LPDDR5X", "Модули рассчитаны на ноутбуки для ИИ"), []);
  assert.deepEqual(inferCategoriesByText("В России разработали ИИ для определения языка", ""), ["ai"]);
  assert.deepEqual(inferCategoriesByText("Как мы автоматизировали отдел продаж", "Нейросеть читает письма, а ИИ-агент отвечает клиентам"), ["ai"]);
  assert.deepEqual(inferCategoriesByText("Я не читаю свой код", "Два месяца вайбкодинга большого проекта: весь код писал ИИ"), ["ai"]);
  assert.deepEqual(inferCategoriesByText("Я не читаю свой код", "Два месяца вайбкодинга большого проекта"), []);
  assert.deepEqual(inferCategoriesByText("[Перевод] Как запустить Qwen3.8 на 6 ГБ VRAM", ""), ["ai"]);
  assert.deepEqual(inferCategoriesByText("Как научить криптосканер не врать: ML-часть AltScanner", ""), ["ai"]);
});

test("security text rules catch attacks, malware and data leaks but not e-sports or gas leaks", () => {
  assert.deepEqual(inferCategoriesByText("Хакеры взломали крупный банк", "утечка данных клиентов"), ["security"]);
  assert.deepEqual(inferCategoriesByText("Critical vulnerability CVE-2026-1234 exploited in the wild", ""), ["security"]);
  assert.deepEqual(inferCategoriesByText("Новый шифровальщик атакует больницы", ""), ["health", "security"]);
  assert.deepEqual(inferCategoriesByText("Нейросеть научили искать уязвимости", ""), ["ai", "security"]);
  assert.deepEqual(inferCategoriesByText("Ransomware gang leaks data", "dark web forum"), ["security"]);
  assert.deepEqual(inferCategoriesByText("Киберспортсмены выиграли турнир", ""), []);
  assert.deepEqual(inferCategoriesByText("Утечка газа в жилом доме", ""), []);
  assert.deepEqual(inferCategoriesByText("Хакатон собрал студентов", ""), []);
  // Ambiguous words need a digital context.
  assert.deepEqual(inferCategoriesByText("В Steam вышел киберпанковый шутер Sprawl Zero", "вдохновлённый Half-Life 2"), []);
  assert.deepEqual(inferCategoriesByText("Умение убеждать помогло преступнику угнать несколько дорогих машин без взлома", ""), []);
  assert.deepEqual(inferCategoriesByText("Не берёте трубку с незнакомых номеров? Ваш телефон всё равно взломают", ""), ["security"]);
  assert.deepEqual(inferCategoriesByText("Я проанализировал 100 000 постов с Hacker News", ""), []);
  assert.deepEqual(inferCategoriesByText("Workers exploited in supply chain, report says", ""), []);
  assert.deepEqual(inferCategoriesByText("Adobe fixes Magento zero-day exploited to backdoor servers", ""), ["security"]);
  assert.deepEqual(inferCategoriesByText("Спящие чёрные дыры Gaia поставили астрономов в тупик", ""), []);
  assert.deepEqual(inferCategoriesByText("Россиянин экстрадирован в США по делу о кибермошенничестве", ""), ["security"]);
});

test("source sections without a matching site category are not forced into one", () => {
  // Lenta files road and car news under «Авто»; the site has no such section.
  assert.deepEqual(mapCategories("lenta", ["Авто"], "https://lenta.ru/news/2026/09/08/v-tsentre-moskvy-perekryli-dvizhenie/", cfg), []);
  assert.deepEqual(mapCategories("lenta", ["Из жизни"], "https://lenta.ru/news/2026/09/08/x/", cfg), []);
  assert.deepEqual(mapCategories("lenta", ["Путешествия"], "https://lenta.ru/news/2026/09/08/x/", cfg), []);
  assert.deepEqual(mapCategories("lenta", ["Неизвестная рубрика"], "", cfg), []);
});

test("source sections map to the corresponding site categories", () => {
  assert.deepEqual(mapCategories("lenta", ["Россия"], "https://lenta.ru/news/2026/09/08/x/", cfg), ["ru"]);
  assert.deepEqual(mapCategories("lenta", ["Наука и техника"], "https://lenta.ru/news/2026/09/08/x/", cfg), ["science", "tech"]);
  assert.deepEqual(mapCategories("lenta", ["Силовые структуры"], "", cfg), ["ru"]);
  assert.deepEqual(mapCategories("kommersant", ["Политика"], "https://www.kommersant.ru/doc/1", cfg), ["ru"]);
  assert.deepEqual(mapCategories("kommersant", ["Мир"], "https://www.kommersant.ru/doc/1", cfg), ["world"]);
  assert.deepEqual(mapCategories("kommersant", ["КУЛЬТУРА\\СПОРТ"], "https://www.kommersant.ru/doc/1", cfg), ["culture", "sports"]);
  assert.deepEqual(mapCategories("interfax", ["Спорт"], "https://www.sport-interfax.ru/1113950", cfg), ["sports"]);
});

test("URL section is preferred over the feed rubric when the site encodes it", () => {
  assert.equal(urlSection("https://tass.ru/politika/28093215"), "politika");
  assert.equal(urlSection("https://www.sport-interfax.ru/1113950"), "1113950");
  assert.equal(urlSection("not a url"), "");

  // TASS Russian politics and army news belong to «Россия», not «Мир».
  assert.deepEqual(mapCategories("tass", ["Политика"], "https://tass.ru/politika/28093215", cfg), ["ru"]);
  assert.deepEqual(mapCategories("tass", ["Армия и ОПК"], "https://tass.ru/armiya-i-opk/28093269", cfg), ["ru"]);
  assert.deepEqual(mapCategories("tass", ["Политика"], "https://tass.ru/mezhdunarodnaya-panorama/28093279", cfg), ["world"]);
  assert.deepEqual(mapCategories("tass", ["Экономика и бизнес"], "https://tass.ru/ekonomika/1", cfg), ["business"]);
  assert.deepEqual(mapCategories("tass", ["Наука"], "https://tass.ru/kosmos/1", cfg), ["science"]);
  // Unknown URL section: fall back to the rubric.
  assert.deepEqual(mapCategories("tass", ["Общество"], "https://tass.ru/interviews/1", cfg), ["ru"]);

  assert.deepEqual(mapCategories("interfax", ["В мире"], "https://www.interfax.ru/world/1113964", cfg), ["world"]);
  assert.deepEqual(mapCategories("interfax", ["В России"], "https://www.interfax.ru/russia/1113963", cfg), ["ru"]);
});

test("per-source default categories and unknown ids", () => {
  assert.deepEqual(mapCategories("habr", [], "https://habr.com/ru/articles/1/", cfg), ["tech"]);
  assert.deepEqual(mapCategories("habr", ["Программирование"], "https://habr.com/ru/articles/1/", cfg), ["tech"]);
  const bogus = { categoryMap: { x: { "A": ["nope", "ru"] } }, defaultCategoryForSource: { x: ["also-nope"] } };
  assert.deepEqual(mapCategories("x", ["A"], "", bogus), ["ru"]);
});

test("text rules add cross-cutting topics", () => {
  assert.deepEqual(inferCategoriesByText("OpenAI представила GPT-6", ""), ["ai"]);
  assert.deepEqual(inferCategoriesByText("Раскрыт неочевидный фактор снижения риска инсульта", ""), ["health"]);
  assert.deepEqual(inferCategoriesByText("Нейросеть помогла врачам", ""), ["ai", "health"]);
  assert.deepEqual(inferCategoriesByText("В центре Москвы перекрыли движение", "Закрыли Кремлевскую набережную"), []);
  assert.deepEqual(inferCategoriesByText("Gemini: сезон Близнецов", "Астрологический прогноз"), []);
});

test("classifyItem recomputes categories from stored source sections", () => {
  const road = item({
    title: "В центре Москвы перекрыли движение",
    url: "https://lenta.ru/news/2026/09/08/v-tsentre-moskvy-perekryli-dvizhenie/",
    sourceCategories: ["Авто"],
    categoryIds: ["tech"]
  });
  assert.deepEqual(classifyItem(road, cfg), []);

  const stroke = item({
    title: "Раскрыт неочевидный фактор снижения риска инсульта",
    url: "https://lenta.ru/news/2026/09/09/x/",
    sourceCategories: ["Наука и техника"],
    categoryIds: ["science", "tech"]
  });
  assert.deepEqual(classifyItem(stroke, cfg), ["science", "tech", "health"]);

  const politics = item({
    sourceId: "tass",
    title: "Путин заявил, что Россия и КНДР продолжат укреплять партнерство",
    url: "https://tass.ru/politika/28093159",
    sourceCategories: ["Политика"],
    categoryIds: ["world"]
  });
  assert.deepEqual(classifyItem(politics, cfg), ["ru"]);
});

test("stock market section: exchange reporting counts, look-alike wording does not", () => {
  const markets = (title, excerpt = "") => inferCategoriesByText(title, excerpt);
  // Unambiguous market terms are enough on their own, and market news is
  // business news too.
  assert.deepEqual(markets("Индекс Мосбиржи вырос на 0,33%"), ["markets", "business"]);
  for (const title of [
    "Уолл-стрит снизилась во вторник",
    "Минфин проведет аукционы по размещению ОФЗ",
    "Совет директоров рекомендовал дивиденды за полугодие",
    "Компания вышла на IPO",
    "Инвесторы получили депозитарные расписки",
    "Нефтяные фьючерсы подорожали",
    "S&P 500 closed lower",
    "Капитализация компании превысила триллион рублей"
  ]) {
    assert.ok(markets(title).includes("markets"), title);
  }
  // Ambiguous terms need trading context next to them.
  assert.ok(markets("Акции компании подешевели на бирже").includes("markets"));
  assert.deepEqual(markets("Акции протеста прошли в Далласе", "Город готовится к росту расходов на охрану"), []);
  assert.deepEqual(markets("Рекламная акция сети магазинов", "Скидки выросли до 40 процентов"), []);
  assert.deepEqual(markets("Секретная поисковая архитектура и собственный индекс ChatGPT", "видимость выросла"), ["ai"]);
  assert.deepEqual(markets("Индекс потребительских цен вырос", "Росстат отчитался о процентах"), []);
  assert.deepEqual(markets("Торги по аренде помещений", "Ставка выросла на 10 процентов"), []);
  // Cyrillic word boundaries: these stems must not match inside longer words.
  assert.deepEqual(markets("Объем торгов рыбой по внебиржевым сделкам составил тонну"), []);
  assert.deepEqual(markets("«Тиара холдинг» стал владельцем долей зернотрейдера"), []);
  assert.deepEqual(markets("Зарегистрировано новое акционерное общество"), []);
  assert.deepEqual(markets("Опциональный режим появился в приложении"), []);
  assert.deepEqual(markets("The Wall Street Journal сообщил об увольнении"), []);
});

test("classifyItem does not trust stored sections of items without source rubrics", () => {
  // The URL section still identifies the section for TASS and Interfax.
  const tass = item({ sourceId: "tass", title: "Путин провел совещание", url: "https://tass.ru/politika/1", categoryIds: ["world"] });
  assert.deepEqual(classifyItem(tass, cfg), ["ru"]);
  const interfax = item({ sourceId: "interfax", title: "Выборы в Сербии", url: "https://www.interfax.ru/world/2", categoryIds: ["ru"] });
  assert.deepEqual(classifyItem(interfax, cfg), ["world"]);
  // Sources with a default keep it.
  const habr = item({ sourceId: "habr", title: "Модель ChatGPT обновили", url: "https://habr.com/ru/articles/1/", categoryIds: ["culture"] });
  assert.deepEqual(classifyItem(habr, cfg), ["tech", "ai"]);
  // Without a URL section or default only the text rules remain.
  const lentaOld = item({ title: "Пьяный россиянин устроил дебош на борту самолета", url: "https://lenta.ru/news/2026/09/08/x/", categoryIds: ["culture"] });
  assert.deepEqual(classifyItem(lentaOld, cfg), []);
  const lentaHealth = item({ title: "Врач назвала опасную причину бессонницы", url: "https://lenta.ru/news/2026/09/08/y/", categoryIds: ["culture"] });
  assert.deepEqual(classifyItem(lentaHealth, cfg), ["health"]);
  const legacyFalsePositive = item({ title: "Вышел киберпанковый шутер", url: "https://lenta.ru/news/2026/09/08/z/", categoryIds: ["tech", "security", "ai"] });
  assert.deepEqual(classifyItem(legacyFalsePositive, cfg), []);
});
