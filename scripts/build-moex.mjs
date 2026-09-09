// Snapshot of the Moscow Exchange for the "Фондовый рынок" section: the index
// values, a quote line and the tiles of the heat map.
//
// The data comes from the MOEX ISS API, which answers with a
// {columns: [...], data: [[...]]} table per block. Column sets change over
// time, so every field is read by name through `pick()` and a missing column
// degrades to null instead of throwing.
//
// The workflow runs this next to the news build. A failed request leaves the
// previous data/moex.json in place: a stale board is better than none, and the
// page shows how old it is.

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "data", "moex.json");

const ISS = "https://iss.moex.com/iss";
const SHARES_URL = `${ISS}/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities,marketdata`;
const INDEX_URL = `${ISS}/engines/stock/markets/index/boards/SNDX/securities.json?iss.meta=off&iss.only=securities,marketdata`;

const TIMEOUT_MS = 20_000;
const TILE_LIMIT = 40; // tiles that still hold a readable label

// Sectors are not part of the ISS share board, so the heat map groups by a
// static map of the tickers that actually trade with meaningful volume.
// An unlisted ticker falls into "Прочие" rather than being dropped.
const SECTORS = {
  "Нефть и газ": ["GAZP", "ROSN", "LKOH", "NVTK", "SNGS", "SNGSP", "TATN", "TATNP", "SIBN", "BANE", "BANEP", "RNFT", "TRNFP"],
  Финансы: ["SBER", "SBERP", "VTBR", "TCSG", "T", "MOEX", "BSPB", "CBOM", "SVCB", "RENI", "SFIN", "AFKS"],
  Металлы: ["GMKN", "NLMK", "CHMF", "MAGN", "PLZL", "POLY", "RUAL", "ENPG", "MTLR", "MTLRP", "TRMK", "SELG", "VSMO", "ALRS"],
  Энергетика: ["IRAO", "HYDR", "FEES", "UPRO", "OGKB", "MSNG", "TGKA", "LSNGP", "ROSSETI"],
  Технологии: ["YDEX", "YNDX", "VKCO", "OZON", "HHRU", "POSI", "ASTR", "DIAS", "SOFL", "WUSH", "CIAN", "DATA"],
  Потребительский: ["MGNT", "FIVE", "X5", "LENT", "FIXP", "BELU", "ABRD", "GCHE", "MVID", "OKEY", "AQUA"],
  Связь: ["MTSS", "RTKM", "RTKMP", "MGTSP"],
  Транспорт: ["AFLT", "NMTP", "FESH", "FLOT", "GLTR"],
  Химия: ["PHOR", "AKRN", "KAZT", "KAZTP", "NKNC", "NKNCP"],
  Строительство: ["PIKK", "LSRG", "SMLT", "ETLN"]
};

const SECTOR_BY_TICKER = new Map();
for (const [sector, tickers] of Object.entries(SECTORS)) {
  for (const ticker of tickers) SECTOR_BY_TICKER.set(ticker, sector);
}

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

/** Rows of an ISS block as objects keyed by column name. */
function rows(block) {
  const columns = Array.isArray(block?.columns) ? block.columns : [];
  const data = Array.isArray(block?.data) ? block.data : [];
  return data.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]])));
}

/** First non-empty value among several possible column names. */
function pick(row, names) {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function num(value) {
  const n = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildIndices(payload) {
  const meta = new Map(rows(payload?.securities).map((row) => [row.SECID, row]));
  const wanted = ["IMOEX", "RTSI", "MOEXBC"];
  const out = [];
  for (const row of rows(payload?.marketdata)) {
    if (!wanted.includes(row.SECID)) continue;
    const value = num(pick(row, ["CURRENTVALUE", "LASTVALUE", "CLOSEVALUE"]));
    const change = num(pick(row, ["LASTCHANGEPRCNT", "LASTCHANGEPRC", "LASTCHANGETOOPENPRC"]));
    if (value === null) continue;
    out.push({
      ticker: row.SECID,
      name: String(pick(meta.get(row.SECID) || {}, ["SHORTNAME", "NAME"]) || row.SECID),
      value,
      change
    });
  }
  return out.sort((a, b) => wanted.indexOf(a.ticker) - wanted.indexOf(b.ticker));
}

function buildStocks(payload) {
  const meta = new Map(rows(payload?.securities).map((row) => [row.SECID, row]));
  const out = [];

  for (const row of rows(payload?.marketdata)) {
    const security = meta.get(row.SECID);
    if (!security) continue;

    const previous = num(pick(security, ["PREVPRICE", "PREVLEGALCLOSEPRICE", "PREVADMITTEDQUOTE"]));
    const price = num(pick(row, ["LAST", "MARKETPRICE", "LCURRENTPRICE", "WAPRICE"])) ?? previous;
    if (price === null) continue;

    let change = num(pick(row, ["LASTTOPREVPRICE", "LASTCHANGEPRCNT"]));
    if (change === null && previous) change = ((price - previous) / previous) * 100;

    const turnover = num(pick(row, ["VALTODAY", "VALTODAY_RUR"])) ?? 0;
    const capitalisation = num(pick(security, ["ISSUECAPITALIZATION", "ISSUECAPITALIZATION_UPDATETIME"]));
    // Tile area: capitalisation where the board reports it, turnover otherwise.
    const weight = capitalisation && capitalisation > 0 ? capitalisation : turnover;
    if (!weight) continue;

    out.push({
      ticker: row.SECID,
      name: String(pick(security, ["SHORTNAME", "SECNAME", "NAME"]) || row.SECID),
      sector: SECTOR_BY_TICKER.get(row.SECID) || "Прочие",
      price,
      change: change === null ? 0 : Number(change.toFixed(2)),
      turnover,
      weight,
      weightBasis: capitalisation && capitalisation > 0 ? "capitalisation" : "turnover"
    });
  }

  // A board where nothing traded today would size every tile by a stale
  // capitalisation; keep the most valuable names either way.
  out.sort((a, b) => b.weight - a.weight);
  return out.slice(0, TILE_LIMIT);
}

async function main() {
  let shares;
  let indices;
  try {
    [shares, indices] = await Promise.all([fetchJson(SHARES_URL), fetchJson(INDEX_URL)]);
  } catch (error) {
    console.error(`[moex] запрос не удался: ${error?.message || error}; предыдущий срез оставлен без изменений`);
    return;
  }

  const stocks = buildStocks(shares);
  if (stocks.length === 0) {
    console.error("[moex] в ответе нет бумаг; предыдущий срез оставлен без изменений");
    return;
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "Московская биржа (ISS)",
    indices: buildIndices(indices),
    stocks
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  const up = stocks.filter((s) => s.change > 0).length;
  const down = stocks.filter((s) => s.change < 0).length;
  console.log(`[moex] бумаг ${stocks.length} (растут ${up}, падают ${down}), индексов ${snapshot.indices.length}`);
}

await main();
