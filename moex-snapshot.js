// Turns the raw answers of the MOEX ISS API into what the "Фондовый рынок"
// board draws: index values, the heat map tiles and quote line, the index
// chart, the day's movers and the macro strip (currencies, bonds, oil).
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
  const BOARD_QUERY = { "iss.meta": "off", "iss.only": "securities,marketdata" };
  const SHARES_PATH = "/engines/stock/markets/shares/boards/TQBR/securities";
  const INDEX_PATH = "/engines/stock/markets/index/boards/SNDX/securities";
  const INDEX_CANDLES_PATH = "/engines/stock/markets/index/boards/SNDX/securities/IMOEX/candles";
  const CURRENCY_PATH = "/engines/currency/markets/selt/boards/CETS/securities";
  const FIXING_PATH = "/engines/currency/markets/index/boards/FIXI/securities";
  const FUTURES_PATH = "/engines/futures/markets/forts/securities";

  const TILE_LIMIT = 40; // tiles that still hold a readable label
  const MOVERS_LIMIT = 5;
  const MOVERS_MIN_TURNOVER = 30e6; // an illiquid name jumping 20% on one trade is noise
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

  // How a company is named in the news, as case-insensitive regex sources.
  // Preferred shares share the alias of the common ones. Where a short name
  // would also match another company or an ordinary word, the pattern says
  // what must not follow ("Газпром" but not "Газпром нефть", "Лента" only as
  // the retailer, not this site or Lenta.ru).
  // Russian names decline ("Полюса", "Магнитом"): where a short name needs a
  // word boundary, allow a case ending before it.
  const D = "(?:а|у|е|ом|ы|ой|ов|ам|ами|ах)?(?![а-я])";
  const COMPANY_ALIASES = {
    GAZP: "газпром(?!\\s*нефт)", ROSN: "роснефт", LKOH: "лукойл", NVTK: "новатэк", SNGS: "сургутнефтегаз", SNGSP: "сургутнефтегаз",
    TATN: "татнефт", TATNP: "татнефт", SIBN: "газпром\\s*нефт", BANE: "башнефт", BANEP: "башнефт", RNFT: "русснефт", TRNFP: "транснефт",
    SBER: `сбер(?:банк)?${D}`, SBERP: `сбер(?:банк)?${D}`, VTBR: "(?<![а-я])втб(?![а-я])", TCSG: "т-банк|тинькофф|т-технолог", T: "т-банк|тинькофф|т-технолог",
    MOEX: "мосбирж|московск\\p{L}+ бирж", BSPB: "банк\\p{L}* санкт-петербург", CBOM: "(?<![а-я])мкб(?![а-я])|московск\\p{L}+ кредитн", SVCB: "совкомбанк",
    RENI: "ренессанс страхован", SFIN: "(?<![а-я])sfi(?![a-z])|эсэфай", AFKS: "(?<![а-я])афк(?![а-я])|афк «система»|афк система",
    GMKN: "норникел|норильск\\p{L}+ никел", NLMK: "(?<![а-я])нлмк(?![а-я])|новолипецк", CHMF: "северстал", MAGN: "(?<![а-я])ммк(?![а-я])|магнитогорск\\p{L}+ метал",
    PLZL: `(?<![а-я])полюс${D}`, POLY: "polymetal|полиметалл", RUAL: "русал", ENPG: "эн\\+|en\\+", MTLR: "мечел", MTLRP: "мечел", TRMK: "(?<![а-я])тмк(?![а-я])|трубн\\p{L}+ металлург",
    SELG: "селигдар", VSMO: "всмпо", ALRS: "алроса",
    IRAO: "интер рао", HYDR: "русгидро", FEES: "россети", UPRO: "юнипро", OGKB: "огк-2", MSNG: "мосэнерго", TGKA: "тгк-1", LSNGP: "ленэнерго",
    YDEX: "яндекс", YNDX: "яндекс", VKCO: "(?<![a-z])vk(?![a-z])|вконтакте", OZON: `ozon|(?<![а-я])озон${D}`, HHRU: "hh\\.ru|headhunter|хедхантер", POSI: "positive technologies|позитив текнолоджис|(?<![а-я])positive(?![a-z])",
    ASTR: "группа астр|(?<![а-я])астр(?:а|ы|е|у|ой)(?![а-я])", DIAS: "диасофт", SOFL: "софтлайн|softline", WUSH: `whoosh|(?<![а-я])вуш${D}`, CIAN: `(?<![а-я])циан${D}`, DATA: "аренадата|arenadata",
    MGNT: `(?<![а-я])магнит${D}`, FIVE: "x5|пятёрочк|пятерочк|перекрёст|перекрест", X5: "x5|пятёрочк|пятерочк|перекрёст|перекрест", LENT: "сеть «лента»|ритейлер лента|«лента»", FIXP: "fix price", BELU: "novabev|белуга", ABRD: "абрау",
    GCHE: "черкизово", MVID: "м\\.видео", OKEY: "о’кей|о'кей|okey", AQUA: "инарктика",
    MTSS: "(?<![а-я])мтс(?![а-я])", RTKM: "ростелеком", RTKMP: "ростелеком", MGTSP: "(?<![а-я])мгтс(?![а-я])",
    AFLT: "аэрофлот", NMTP: "(?<![а-я])нмтп(?![а-я])|новороссийск\\p{L}+ морск", FESH: "fesco|дальневосточн\\p{L}+ морск", FLOT: "совкомфлот", GLTR: "globaltrans|глобалтранс",
    PHOR: "фосагро", AKRN: `(?<![а-я])акрон${D}`, KAZT: "куйбышевазот", KAZTP: "куйбышевазот", NKNC: "нижнекамскнефтехим", NKNCP: "нижнекамскнефтехим",
    PIKK: `(?<![а-я])пик${D}`, LSRG: "(?<![а-я])лср(?![а-я])", SMLT: `(?<![а-я])самол[её]т${D}`, ETLN: `(?<![а-я])эталон${D}`
  };

  const MONTH_CODES = "FGHJKMNQUVXZ";

  const RANGES = {
    day: { label: "День", interval: 10, days: 7 },
    week: { label: "Неделя", interval: 60, days: 10 },
    month: { label: "Месяц", interval: 24, days: 35 },
    ytd: { label: "С начала года", interval: 24, days: null }
  };

  function encodeQuery(params) {
    return Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  }

  /** ISS URL: `.json` for a plain request, `.jsonp` with a callback name. */
  function issUrl(path, params, format, callback) {
    const query = format === "jsonp" ? { callback, ...params } : params;
    return `${ISS}${path}.${format === "jsonp" ? "jsonp" : "json"}?${encodeQuery(query)}`;
  }

  /** Requests behind the board, as {path, params}; the page picks the format. */
  const requests = {
    shares: () => ({ path: SHARES_PATH, params: BOARD_QUERY }),
    indices: () => ({ path: INDEX_PATH, params: BOARD_QUERY }),
    currency: () => ({ path: CURRENCY_PATH, params: { ...BOARD_QUERY, securities: "CNYRUB_TOM,USD000UTSTOM,EUR_RUB__TOM" } }),
    fixing: () => ({ path: FIXING_PATH, params: BOARD_QUERY }),
    future: (contract) => ({ path: `${FUTURES_PATH}/${contract}`, params: BOARD_QUERY }),
    candles: (range, now) => {
      const spec = RANGES[range] || RANGES.day;
      const today = now ? new Date(now) : new Date();
      const from = new Date(today);
      if (spec.days === null) from.setMonth(0, 1);
      else from.setDate(from.getDate() - spec.days);
      return { path: INDEX_CANDLES_PATH, params: { "iss.meta": "off", interval: spec.interval, from: isoDate(from), till: isoDate(today) } };
    }
  };

  /** Legacy pair of board URLs, kept for the build script and tests. */
  function urls(format, callback) {
    const shares = requests.shares();
    const indices = requests.indices();
    return { shares: issUrl(shares.path, shares.params, format, callback), indices: issUrl(indices.path, indices.params, format, callback) };
  }

  function isoDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /**
   * Nearest Brent contracts on the derivatives market: "BR" + month code +
   * last digit of the year, the current month and the two after it. The
   * page asks for all three and keeps the first one that trades.
   */
  function brentContracts(now) {
    const date = now ? new Date(now) : new Date();
    const out = [];
    for (let step = 0; step < 3; step += 1) {
      const d = new Date(date.getFullYear(), date.getMonth() + step, 1);
      out.push(`BR${MONTH_CODES[d.getMonth()]}${d.getFullYear() % 10}`);
    }
    return out;
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

  function round2(value) {
    return value === null ? null : Number(value.toFixed(2));
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

  /** Every share of the board with a price, unsorted; tiles and movers pick from it. */
  function shareRows(payload) {
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
    return out;
  }

  function buildStocks(payload) {
    // A board where nothing traded today would size every tile by a stale
    // capitalisation; keep the most valuable names either way.
    return shareRows(payload).filter((s) => s.weight).sort((a, b) => b.weight - a.weight).slice(0, TILE_LIMIT);
  }

  /** The day's leaders among names that actually trade: up, down, turnover. */
  function buildMovers(payload) {
    const liquid = shareRows(payload).filter((s) => s.turnover >= MOVERS_MIN_TURNOVER);
    const brief = (s) => ({ ticker: s.ticker, name: s.name, price: s.price, change: s.change, turnover: s.turnover });
    return {
      up: liquid.filter((s) => s.change > 0).sort((a, b) => b.change - a.change).slice(0, MOVERS_LIMIT).map(brief),
      down: liquid.filter((s) => s.change < 0).sort((a, b) => a.change - b.change).slice(0, MOVERS_LIMIT).map(brief),
      turnover: liquid.slice().sort((a, b) => b.turnover - a.turnover).slice(0, MOVERS_LIMIT).map(brief)
    };
  }

  /** Every priced share by ticker, for the reader's own list. */
  function buildQuotes(payload) {
    const out = {};
    for (const s of shareRows(payload)) out[s.ticker] = { name: s.name, price: s.price, change: s.change, turnover: s.turnover };
    return out;
  }

  function moscowClock(now) {
    const date = now ? new Date(now) : new Date();
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
    const get = (type) => (parts.find((part) => part.type === type) || {}).value || "";
    return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
  }

  /**
   * Trading calendar as a fallback: the main session runs 10:00–18:50 and the
   * evening one 19:00–23:50 Moscow time on weekdays. Holidays are not known
   * here, so the exchange's own status wins whenever it is present.
   */
  function sessionByClock(now) {
    const { weekday, minutes } = moscowClock(now);
    if (weekday === "Sat" || weekday === "Sun") return "closed";
    const open = (minutes >= 10 * 60 && minutes < 18 * 60 + 50) || (minutes >= 19 * 60 && minutes < 23 * 60 + 50);
    return open ? "open" : "closed";
  }

  /**
   * Whether the market is trading and when the data was stamped, from the
   * TRADINGSTATUS and SYSTIME columns of the share board.
   */
  function buildSession(payload, now) {
    const list = rows(payload && payload.marketdata);
    const withStatus = list.find((row) => row.TRADINGSTATUS) || null;
    const stamped = list.find((row) => row.SYSTIME) || withStatus;
    const status = withStatus ? (String(withStatus.TRADINGSTATUS).toUpperCase() === "T" ? "open" : "closed") : sessionByClock(now);
    const time = stamped ? String(pick(stamped, ["SYSTIME"]) || "") : "";
    return { status, time: time || null, fromExchange: Boolean(withStatus) };
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
      stocks,
      movers: buildMovers(shares),
      quotes: buildQuotes(shares),
      session: buildSession(shares)
    };
  }

  /**
   * Index chart points from a candles answer. The day range asks for a week
   * of 10-minute candles and keeps the last trading date, so a weekend or
   * a morning before the open still shows the latest session; the close of
   * the session before it is the baseline for the change.
   */
  function buildSeries(payload, range) {
    const candles = rows(payload && payload.candles)
      .map((row) => ({ begin: String(pick(row, ["begin"]) || ""), end: String(pick(row, ["end"]) || ""), open: num(pick(row, ["open"])), close: num(pick(row, ["close"])) }))
      .filter((c) => c.begin && c.close !== null)
      .sort((a, b) => (a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : 0));
    if (candles.length === 0) return null;

    let session = candles;
    let baseline = candles[0].open === null ? candles[0].close : candles[0].open;
    if (range === "day") {
      const lastDate = candles[candles.length - 1].begin.slice(0, 10);
      session = candles.filter((c) => c.begin.startsWith(lastDate));
      const before = candles.filter((c) => !c.begin.startsWith(lastDate));
      if (before.length > 0) baseline = before[before.length - 1].close;
      else baseline = session[0].open === null ? session[0].close : session[0].open;
    }

    const points = session.map((c) => ({ t: c.begin, v: c.close }));
    const values = points.map((p) => p.v);
    const last = values[values.length - 1];
    return {
      range,
      points,
      baseline,
      first: values[0],
      last,
      min: Math.min(...values),
      max: Math.max(...values),
      change: baseline ? round2(((last - baseline) / baseline) * 100) : null
    };
  }

  /** One row of the macro strip from a board answer, or null. */
  function macroItem(payload, secid, id, name, unit, valueColumns) {
    const meta = new Map(rows(payload && payload.securities).map((row) => [row.SECID, row]));
    const row = rows(payload && payload.marketdata).find((r) => r.SECID === secid);
    if (!row) return null;
    const value = num(pick(row, valueColumns));
    if (value === null) return null;
    const previous = num(pick(meta.get(secid) || {}, ["PREVPRICE", "PREVSETTLEPRICE", "PREVLEGALCLOSEPRICE", "PREVADMITTEDQUOTE", "PREVVALUE"]));
    let change = num(pick(row, ["LASTTOPREVPRICE", "LASTCHANGEPRCNT", "LASTCHANGEPRC", "LASTCHANGETOOPENPRC"]));
    if (change === null && previous) change = ((value - previous) / previous) * 100;
    return { id, name, unit, value, change: round2(change) };
  }

  /**
   * Macro strip: bond index from the index board, the yuan from the currency
   * market, dollar and euro from the exchange's fixings, Brent from the
   * nearest traded contract. Any source that did not answer is left out.
   */
  function buildMacro({ indices, currency, fixing, futures } = {}) {
    const out = [];
    const rgbi = macroItem(indices, "RGBI", "RGBI", "Гособлигации RGBI", "", ["CURRENTVALUE", "LASTVALUE", "CLOSEVALUE"]);
    if (rgbi) out.push(rgbi);
    const cny = macroItem(currency, "CNYRUB_TOM", "CNY", "Юань", "₽", ["LAST", "WAPRICE", "MARKETPRICE"]);
    if (cny) out.push(cny);
    for (const [secid, id, name] of [["USDFIX", "USD", "Доллар (фиксинг)"], ["EURFIX", "EUR", "Евро (фиксинг)"]]) {
      const item = macroItem(fixing, secid, id, name, "₽", ["CURRENTVALUE", "LASTVALUE", "CLOSEVALUE", "LAST"]);
      if (item) out.push(item);
    }
    for (const [secid, id, name] of [["USD000UTSTOM", "USD", "Доллар"], ["EUR_RUB__TOM", "EUR", "Евро"]]) {
      if (out.some((item) => item.id === id)) continue;
      const item = macroItem(currency, secid, id, name, "₽", ["LAST", "WAPRICE", "MARKETPRICE"]);
      if (item) out.push(item);
    }
    for (const payload of Array.isArray(futures) ? futures : []) {
      const row = rows(payload && payload.marketdata)[0];
      if (!row || !num(pick(row, ["LAST"])) || !(num(pick(row, ["VALTODAY", "VOLTODAY", "NUMTRADES"])) > 0)) continue;
      const item = macroItem(payload, row.SECID, "BRENT", "Нефть Brent", "$", ["LAST"]);
      if (item) {
        out.push(item);
        break;
      }
    }
    return out;
  }

  /** Regex that finds a company in news text, from the alias map or its name. */
  function companyPattern(ticker, name) {
    const source = COMPANY_ALIASES[ticker];
    if (source) return new RegExp(source, "iu");
    const clean = String(name || "").replace(/\s*\(.*?\)\s*/g, " ").replace(/[-\s]*(?:ао|ап|прив\.?|обыкн\.?)\s*$/iu, "").trim();
    if (clean.length < 3) return null;
    return new RegExp(clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  }

  return {
    issUrl, requests, urls, build, buildStocks, buildIndices, buildMovers, buildQuotes, buildSession, sessionByClock, buildSeries, buildMacro, brentContracts, companyPattern,
    rows, pick, num, isoDate, SECTORS, RANGES, COMPANY_ALIASES, TILE_LIMIT, MOVERS_LIMIT, MOVERS_MIN_TURNOVER
  };
});
