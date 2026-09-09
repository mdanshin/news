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
  assert.deepEqual(Object.keys(CATEGORY_DEFS), ["world", "ru", "business", "tech", "ai", "science", "health", "sports", "culture"]);
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

test("classifyItem keeps stored categories for items without source sections", () => {
  const legacy = item({ title: "Старая запись", categoryIds: ["world", "bogus"] });
  assert.deepEqual(classifyItem(legacy, cfg), ["world"]);
  const legacyAi = item({ title: "Модель ChatGPT обновили", categoryIds: ["tech"] });
  assert.deepEqual(classifyItem(legacyAi, cfg), ["tech", "ai"]);
  assert.deepEqual(classifyItem(item({ title: "Без категорий" }), cfg), []);
});
