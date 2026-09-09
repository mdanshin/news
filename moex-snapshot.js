// Turns the raw answer of the MOEX ISS API into the board snapshot that the
// page draws: index values, and the stocks of the heat map and quote line.
//
// The same code runs in two places. The page loads it as a plain script and
// asks the exchange directly, because the reader's browser can reach it. The
// build script (scripts/build-moex.mjs) imports it in Node to produce
// data/moex.json as a fallback for readers whose network cannot.
//
// ISS answers with {columns: [...], data: [[...]]} tables. Column sets change
// over time, so every field is read by name through `pick()` and a missing
// column degrades to null instead of throwing.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.MoexSnapshot = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ISS = "https://iss.moex.com/iss";
  const QUERY = "iss.meta=off&iss.only=securities,marketdata";
  const SHARES_PATH = "/engines/stock/markets/shares/boards/TQBR/securities";
  const INDEX_PATH = "/engines/stock/markets/index/boards/SNDX/securities";

  const TILE_LIMIT = 40; // tiles that still hold a readable label
  const INDICES = ["IMOEX", "RTSI", "MOEXBC"];

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

  /** ISS URLs: `.json` for a plain request, `.jsonp` with a callback name. */
  function urls(format, callback) {
    const suffix = format === "jsonp" ? `.jsonp?callback=${encodeURIComponent(callback)}&${QUERY}` : `.json?${QUERY}`;
    return { shares: `${ISS}${SHARES_PATH}${suffix}`, indices: `${ISS}${INDEX_PATH}${suffix}` };
  }

  /** Rows of an ISS block as objects keyed by column name. */
  function rows(block) {
    const columns = Array.isArray(block && block.columns) ? block.columns : [];
    const data = Array.isArray(block && block.data) ? block.data : [];
    return data.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]])));
  }

  /** First non-empty value among several possible column names. */
  function pick(row, names) {
    for (const name of names) {
      const value = row ? row[name] : undefined;
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  }

  function num(value) {
    // Number(null) is 0, which would turn a missing LAST into a price of zero.
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function buildIndices(payload) {
    const meta = new Map(rows(payload && payload.securities).map((row) => [row.SECID, row]));
    const out = [];
    for (const row of rows(payload && payload.marketdata)) {
      if (!INDICES.includes(row.SECID)) continue;
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
    return out.sort((a, b) => INDICES.indexOf(a.ticker) - INDICES.indexOf(b.ticker));
  }

  function buildStocks(payload) {
    const meta = new Map(rows(payload && payload.securities).map((row) => [row.SECID, row]));
    const out = [];

    for (const row of rows(payload && payload.marketdata)) {
      const security = meta.get(row.SECID);
      if (!security) continue;

      const previous = num(pick(security, ["PREVPRICE", "PREVLEGALCLOSEPRICE", "PREVADMITTEDQUOTE"]));
      const last = num(pick(row, ["LAST", "MARKETPRICE", "LCURRENTPRICE", "WAPRICE"]));
      const price = last === null ? previous : last;
      if (price === null) continue;

      let change = num(pick(row, ["LASTTOPREVPRICE", "LASTCHANGEPRCNT"]));
      if (change === null && previous) change = ((price - previous) / previous) * 100;

      const turnover = num(pick(row, ["VALTODAY", "VALTODAY_RUR"])) || 0;
      const capitalisation = num(pick(security, ["ISSUECAPITALIZATION"]));
      // Tile area: capitalisation where the board reports it, turnover otherwise.
      const byCap = Boolean(capitalisation && capitalisation > 0);
      const weight = byCap ? capitalisation : turnover;
      if (!weight) continue;

      out.push({
        ticker: row.SECID,
        name: String(pick(security, ["SHORTNAME", "SECNAME", "NAME"]) || row.SECID),
        sector: SECTOR_BY_TICKER.get(row.SECID) || "Прочие",
        price,
        change: change === null ? 0 : Number(change.toFixed(2)),
        turnover,
        weight,
        weightBasis: byCap ? "capitalisation" : "turnover"
      });
    }

    // A board where nothing traded today would size every tile by a stale
    // capitalisation; keep the most valuable names either way.
    out.sort((a, b) => b.weight - a.weight);
    return out.slice(0, TILE_LIMIT);
  }

  /**
   * Board snapshot from the two ISS answers, or null when the share board is
   * empty (an outage answers with an empty table rather than an error).
   */
  function build(shares, indices, generatedAt) {
    const stocks = buildStocks(shares);
    if (stocks.length === 0) return null;
    return {
      generatedAt: generatedAt || new Date().toISOString(),
      source: "Московская биржа (ISS)",
      indices: buildIndices(indices),
      stocks
    };
  }

  return { urls, build, buildStocks, buildIndices, rows, pick, num, SECTORS, TILE_LIMIT };
});
