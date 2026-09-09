// Fallback snapshot of the Moscow Exchange for the "Фондовый рынок" section.
//
// The page normally asks the exchange itself from the reader's browser; this
// file only serves readers whose network cannot reach it. The parsing lives
// in moex-snapshot.js, shared with the page.
//
// The workflow runs this next to the news build. A failed request leaves the
// previous data/moex.json in place: a stale board is better than none, and the
// page shows how old it is. Note that the exchange resets connections from
// GitHub's runners, so on GitHub this step is expected to fail.

import fs from "node:fs/promises";
import path from "node:path";
import MoexSnapshot from "../moex-snapshot.js";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "data", "moex.json");
const TIMEOUT_MS = 20_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "news-aggregator-pages/1.0 (+https://github.com/)", accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "fetch failed" alone says nothing; the network-level reason (DNS, reset,
 * certificate, timeout) sits in `error.cause`, so the log prints the chain.
 */
function describeError(error) {
  const parts = [];
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    const code = e.code ? ` (${e.code})` : "";
    parts.push(`${e.name === "Error" || !e.name ? "" : `${e.name}: `}${e.message || String(e)}${code}`);
  }
  return parts.join(" <- ");
}

async function main() {
  const urls = MoexSnapshot.urls("json");
  let shares;
  let indices;
  try {
    [shares, indices] = await Promise.all([fetchJson(urls.shares), fetchJson(urls.indices)]);
  } catch (error) {
    console.error(`[moex] запрос не удался: ${describeError(error)}; предыдущий срез оставлен без изменений`);
    return;
  }

  const snapshot = MoexSnapshot.build(shares, indices);
  if (!snapshot) {
    console.error("[moex] в ответе нет бумаг; предыдущий срез оставлен без изменений");
    return;
  }

  await fs.writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  const up = snapshot.stocks.filter((s) => s.change > 0).length;
  const down = snapshot.stocks.filter((s) => s.change < 0).length;
  console.log(`[moex] бумаг ${snapshot.stocks.length} (растут ${up}, падают ${down}), индексов ${snapshot.indices.length}`);
}

await main();
