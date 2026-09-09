// Print every item of a section together with the rule that put it there,
// so misclassifications can be reviewed in bulk instead of one by one.
//
//   node scripts/audit-sections.mjs                # all sections, current snapshot
//   node scripts/audit-sections.mjs ai security    # only these sections
//   node scripts/audit-sections.mjs --file other.json ai
//
// The classification is recomputed with the current rules, so the output
// shows what the next build would produce, not what the snapshot stores.

import fs from "node:fs";
import path from "node:path";

import { CATEGORY_DEFS, classifyItem, inferCategoriesByText, mapCategories, urlSection } from "./classify.mjs";

const args = process.argv.slice(2);
let file = "data/news.json";
const fileIndex = args.indexOf("--file");
if (fileIndex >= 0) {
  file = args[fileIndex + 1];
  args.splice(fileIndex, 2);
}
const wanted = args.length ? args : Object.keys(CATEGORY_DEFS);

const cfg = JSON.parse(fs.readFileSync(path.resolve("data/feeds.json"), "utf8"));
const snapshot = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
const items = Array.isArray(snapshot.items) ? snapshot.items : [];

// Why an item is in a section: URL section, feed rubric, source default,
// text rule, or the stored categories of a legacy item.
function reason(item, id) {
  const section = urlSection(item.url);
  const map = cfg.categoryMap?.[item.sourceId] || {};
  if (section && map[`/${section}`]?.includes(id)) return `url:/${section}`;
  for (const rubric of item.sourceCategories || []) {
    if (mapCategories(item.sourceId, [rubric], "", { categoryMap: cfg.categoryMap }).includes(id)) return `rubric:${rubric}`;
  }
  if ((cfg.defaultCategoryForSource?.[item.sourceId] || []).includes(id)) return "default";
  if (inferCategoriesByText(item.title, item.excerpt).includes(id)) return "text";
  return "?";
}

const stats = [];
for (const id of wanted) {
  if (!CATEGORY_DEFS[id]) {
    console.error(`unknown section: ${id}`);
    continue;
  }
  const rows = items.filter((item) => classifyItem(item, cfg).includes(id));
  console.log(`\n== ${CATEGORY_DEFS[id].name} (${id}): ${rows.length}`);
  for (const item of rows) {
    console.log(`  ${String(item.sourceName || item.sourceId).padEnd(16)} | ${reason(item, id).padEnd(34).slice(0, 34)} | ${String(item.title).slice(0, 100)}`);
  }
  stats.push([id, rows.length]);
}

const none = items.filter((item) => classifyItem(item, cfg).length === 0);
console.log(`\n== без раздела: ${none.length}`);
for (const item of none.slice(0, 40)) {
  console.log(`  ${String(item.sourceName || item.sourceId).padEnd(16)} | ${JSON.stringify(item.sourceCategories || null).slice(0, 34).padEnd(34)} | ${String(item.title).slice(0, 100)}`);
}
console.log(`\n${stats.map(([id, n]) => `${id}=${n}`).join("  ")}  none=${none.length}  total=${items.length}`);
