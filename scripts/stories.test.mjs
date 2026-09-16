import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStories, topStories, stem, tokens } from "./stories.mjs";

const at = (hoursAgo) => new Date(Date.UTC(2026, 8, 16, 12 - hoursAgo)).toISOString();
const item = (id, sourceId, title, hoursAgo = 0, excerpt = "") => ({ id, sourceId, sourceName: sourceId, title, excerpt, publishedAt: at(hoursAgo) });

test("stem and tokens: light Russian stemming, stopwords and short words dropped", () => {
  assert.equal(stem("санкциями"), "санкц");
  assert.equal(stem("поставки"), "поставк");
  assert.equal(stem("газа"), "газа", "слишком короткая основа не режется");
  assert.deepEqual(tokens("Россия приостановит поставки газа в Армению на 11 дней"), ["приостанов", "поставк", "газа", "армени", "дней"]);
  assert.deepEqual(tokens("Ёж и ёлка"), ["елка"], "ё это е; короткая основа не режется");
});

test("buildStories: outlets phrasing one event differently land in one story", () => {
  const items = [
    item("a", "lenta", "Россия приостановит поставки газа в Армению", 0, "Поставки остановят на 11 дней из-за ремонта."),
    item("b", "tass", "Поставки газа из России в Армению приостанавливаются на 11 дней", 1),
    item("c", "rbc", "«Газпром» приостанавливает поставки газа в Армению на 11 дней", 2, "Ремонт трубопровода продлится до 25 сентября."),
    item("d", "interfax", "Поставки газа в Армению из России приостановят с 15 по 25 сентября", 3),
    item("e", "lenta", "Цены на газ в Европе выросли после новостей из Норвегии", 1, "Биржевые котировки газа прибавили пять процентов."),
    item("f", "tass", "В Армении прошли учения спасателей", 2)
  ];
  const stories = buildStories(items);
  const gas = stories.find((story) => story.itemIds.includes("a"));
  assert.deepEqual([...gas.itemIds].sort(), ["a", "b", "c", "d"]);
  assert.equal(gas.sources, 4);
  assert.ok(!gas.itemIds.includes("e"), "другая новость про газ не склеивается");
  assert.ok(!gas.itemIds.includes("f"), "другая новость про Армению не склеивается");
  assert.ok(["a", "b", "c", "d"].includes(gas.id), "заголовок сюжета берётся у одного из участников");
  assert.equal(gas.publishedAt, at(0), "время сюжета это время последней публикации");
});

test("buildStories: the same outlet twice counts as one source; far-apart repeats are separate events", () => {
  const items = [
    item("a", "tass", "Кабмин утвердил стратегию развития креативной экономики до 2036 года", 0),
    item("b", "tass", "Доля креативной экономики должна вырасти: кабмин утвердил стратегию до 2036 года", 1),
    item("c", "tass", "Кабмин утвердил стратегию развития креативной экономики до 2036 года", 80)
  ];
  const stories = buildStories(items);
  const fresh = stories.find((story) => story.itemIds.includes("a"));
  assert.deepEqual([...fresh.itemIds].sort(), ["a", "b"]);
  assert.equal(fresh.sources, 1);
  assert.ok(stories.some((story) => story.itemIds.length === 1 && story.itemIds[0] === "c"), "повтор через трое суток это отдельный сюжет");
});

test("topStories: only multi-source stories, most covered first, capped", () => {
  const items = [
    item("a", "lenta", "Истребитель НАТО сбил дрон над Литвой", 0),
    item("b", "rbc", "Истребители НАТО сбили беспилотник в Литве", 1),
    item("c", "tass", "Истребитель НАТО сбил беспилотник над Литвой", 2),
    item("d", "lenta", "ВТБ повысил ставки по долгосрочным вкладам", 0),
    item("e", "vedomosti", "ВТБ повышает ставки по долгосрочным вкладам до 13,9%", 1),
    item("f", "habr", "Как я собрал визуальную лабораторию для племянника", 0)
  ];
  const top = topStories(items);
  assert.deepEqual(top.map((story) => story.sources), [3, 2]);
  assert.equal(topStories(items, { limit: 1 }).length, 1);
  assert.equal(topStories(items, { minSources: 4 }).length, 0);
  for (const story of top) assert.deepEqual(Object.keys(story).sort(), ["id", "itemIds", "publishedAt", "sources", "title"]);
});
