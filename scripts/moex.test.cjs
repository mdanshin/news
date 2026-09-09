const assert = require('node:assert/strict');
const { test } = require('node:test');
const MoexSnapshot = require('../moex-snapshot.js');

function table(columns, data) {
  return { columns, data };
}

test('urls: plain JSON and JSONP with a callback, both against the TQBR and SNDX boards', () => {
  const json = MoexSnapshot.urls('json');
  assert.match(json.shares, /^https:\/\/iss\.moex\.com\/iss\/engines\/stock\/markets\/shares\/boards\/TQBR\/securities\.json\?iss\.meta=off/);
  assert.match(json.indices, /markets\/index\/boards\/SNDX\/securities\.json\?/);
  const jsonp = MoexSnapshot.urls('jsonp', 'cb 1');
  assert.match(jsonp.shares, /securities\.jsonp\?callback=cb%201&iss\.meta=off/);
});

test('build: prices, changes, sectors and the weight basis come from named columns', () => {
  const shares = {
    securities: table(['SECID', 'SHORTNAME', 'PREVPRICE', 'ISSUECAPITALIZATION'], [
      ['SBER', 'Сбербанк', 300, 7e12],
      ['GAZP', 'Газпром', 130, 3e12],
      ['NEWC', 'Новичок', 10, null],
      ['DEAD', 'Без цены', null, null]
    ]),
    marketdata: table(['SECID', 'LAST', 'LASTTOPREVPRICE', 'VALTODAY'], [
      ['SBER', '312,4', 1.8, 9e9],
      ['GAZP', null, null, 5e9],
      ['NEWC', 11, null, 2e6],
      ['DEAD', null, null, 0],
      ['GHOST', 5, 1, 1]
    ])
  };
  const indices = {
    securities: table(['SECID', 'SHORTNAME'], [['IMOEX', 'Индекс МосБиржи'], ['RTSI', 'Индекс РТС']]),
    marketdata: table(['SECID', 'CURRENTVALUE', 'LASTCHANGEPRC'], [['RTSI', 1100.2, 0.5], ['IMOEX', 2841.55, -0.34], ['MCXSM', 1, 1]])
  };
  const snapshot = MoexSnapshot.build(shares, indices, '2026-09-09T10:00:00Z');
  assert.equal(snapshot.generatedAt, '2026-09-09T10:00:00Z');
  assert.deepEqual(snapshot.stocks.map((s) => s.ticker), ['SBER', 'GAZP', 'NEWC'], 'сортировка по весу; без цены и без веса бумага выпадает; бумага без описания тоже');
  const [sber, gazp, newc] = snapshot.stocks;
  assert.equal(sber.price, 312.4, 'запятая в числе допустима');
  assert.equal(sber.sector, 'Финансы');
  assert.equal(sber.weightBasis, 'capitalisation');
  assert.equal(gazp.price, 130, 'без сделок цена равна закрытию, а не нулю');
  assert.equal(gazp.change, 0);
  assert.equal(newc.change, 10, 'изменение считается от закрытия, если биржа его не дала');
  assert.equal(newc.sector, 'Прочие');
  assert.equal(newc.weightBasis, 'turnover');
  assert.deepEqual(snapshot.indices.map((i) => [i.ticker, i.name, i.change]), [['IMOEX', 'Индекс МосБиржи', -0.34], ['RTSI', 'Индекс РТС', 0.5]]);
});

test('build: empty or malformed answers give null instead of a board of nothing', () => {
  assert.equal(MoexSnapshot.build({}, {}), null);
  assert.equal(MoexSnapshot.build({ securities: { columns: 'x' }, marketdata: null }, undefined), null);
  assert.equal(MoexSnapshot.build({ securities: table(['SECID'], [['SBER']]), marketdata: table(['SECID', 'LAST'], [['SBER', 1]]) }, {}), null, 'без капитализации и оборота плитке нечем быть');
});

test('build: only the most valuable names make tiles', () => {
  const rows = Array.from({ length: 60 }, (_, i) => [`T${i}`, `Бумага ${i}`, 10, 1e9 * (i + 1)]);
  const shares = {
    securities: table(['SECID', 'SHORTNAME', 'PREVPRICE', 'ISSUECAPITALIZATION'], rows),
    marketdata: table(['SECID', 'LAST'], rows.map((r) => [r[0], 10]))
  };
  const snapshot = MoexSnapshot.build(shares, {});
  assert.equal(snapshot.stocks.length, MoexSnapshot.TILE_LIMIT);
  assert.equal(snapshot.stocks[0].ticker, 'T59');
});

test('requests: candle ranges span the right dates and Brent contracts follow the calendar', () => {
  const now = '2026-09-09T12:00:00';
  assert.deepEqual(MoexSnapshot.requests.candles('day', now).params, { 'iss.meta': 'off', interval: 10, from: '2026-09-02', till: '2026-09-09' });
  assert.deepEqual(MoexSnapshot.requests.candles('ytd', now).params, { 'iss.meta': 'off', interval: 24, from: '2026-01-01', till: '2026-09-09' });
  assert.equal(MoexSnapshot.requests.candles('month', now).params.interval, 24);
  assert.deepEqual(MoexSnapshot.brentContracts(now), ['BRU6', 'BRV6', 'BRX6']);
  assert.deepEqual(MoexSnapshot.brentContracts('2026-12-15'), ['BRZ6', 'BRF7', 'BRG7'], 'переход через год');
  assert.match(MoexSnapshot.issUrl('/a/b', { interval: 10, from: '2026-09-01' }, 'jsonp', 'cb7'), /^https:\/\/iss\.moex\.com\/iss\/a\/b\.jsonp\?callback=cb7&interval=10&from=2026-09-01$/);
});

test('buildSeries: the day range keeps the last session and measures it against the previous close', () => {
  const payload = {
    candles: table(['begin', 'end', 'open', 'close'], [
      ['2026-09-09 10:10:00', '', 2848, 2836.4],
      ['2026-09-08 18:30:00', '', 2850, 2851.2],
      ['2026-09-09 10:00:00', '', 2851, 2848],
      ['2026-09-09 18:40:00', '', 2844, 2841.55]
    ])
  };
  const day = MoexSnapshot.buildSeries(payload, 'day');
  assert.deepEqual(day.points.map((p) => p.v), [2848, 2836.4, 2841.55], 'только последняя дата, по времени');
  assert.equal(day.baseline, 2851.2, 'база это закрытие предыдущей сессии');
  assert.equal(day.change, -0.34);
  assert.equal(day.min, 2836.4);
  assert.equal(day.max, 2848);
  const month = MoexSnapshot.buildSeries(payload, 'month');
  assert.equal(month.points.length, 4, 'другие периоды берут все свечи');
  assert.equal(month.baseline, 2850, 'база это открытие первой свечи');
  assert.equal(MoexSnapshot.buildSeries({ candles: table(['begin', 'close'], []) }, 'day'), null);
  assert.equal(MoexSnapshot.buildSeries({}, 'day'), null);
});

test('buildMovers: leaders among liquid names only, sorted each way', () => {
  const rows = [
    ['SBER', 'Сбербанк', 300, 7e12], ['GAZP', 'Газпром', 130, 3e12], ['TINY', 'Пустышка', 1, 1e9], ['LKOH', 'Лукойл', 6800, 4.5e12], ['GMKN', 'Норникель', 140, 2e12]
  ];
  const shares = {
    securities: table(['SECID', 'SHORTNAME', 'PREVPRICE', 'ISSUECAPITALIZATION'], rows),
    marketdata: table(['SECID', 'LAST', 'LASTTOPREVPRICE', 'VALTODAY'], [
      ['SBER', 312, 1.8, 9e9], ['GAZP', 128, -2.6, 5e9], ['TINY', 1.5, 50, 1e6], ['LKOH', 6810, 0.1, 4e9], ['GMKN', 135, -3.5, 2e9]
    ])
  };
  const movers = MoexSnapshot.buildMovers(shares);
  assert.deepEqual(movers.up.map((s) => s.ticker), ['SBER', 'LKOH'], 'бумага с оборотом в миллион не лидер, даже с +50%');
  assert.deepEqual(movers.down.map((s) => s.ticker), ['GMKN', 'GAZP']);
  assert.deepEqual(movers.turnover.map((s) => s.ticker), ['SBER', 'GAZP', 'LKOH', 'GMKN']);
  assert.deepEqual(Object.keys(movers.up[0]).sort(), ['change', 'name', 'price', 'ticker', 'turnover']);
  assert.ok(MoexSnapshot.build(shares, {}).movers.up.length > 0, 'лидеры входят в срез');
});

test('buildMacro: each source is optional, the order is fixed, the first traded Brent contract wins', () => {
  const indices = { securities: table(['SECID', 'SHORTNAME'], [['RGBI', 'RGBI']]), marketdata: table(['SECID', 'CURRENTVALUE', 'LASTCHANGEPRC'], [['RGBI', 112.4, 0.12]]) };
  const currency = { securities: table(['SECID', 'PREVPRICE'], [['CNYRUB_TOM', 11.5], ['USD000UTSTOM', 80]]), marketdata: table(['SECID', 'LAST'], [['CNYRUB_TOM', 11.62], ['USD000UTSTOM', null]]) };
  const fixing = { securities: table(['SECID', 'PREVPRICE'], [['USDFIX', 82.1]]), marketdata: table(['SECID', 'CURRENTVALUE'], [['USDFIX', 83.3]]) };
  const contract = (secid, last, traded) => ({ securities: table(['SECID', 'PREVSETTLEPRICE'], [[secid, 100]]), marketdata: table(['SECID', 'LAST', 'VALTODAY'], [[secid, last, traded]]) });
  const all = MoexSnapshot.buildMacro({ indices, currency, fixing, futures: [contract('BRU6', 99, 0), contract('BRV6', 101.2, 5e9), contract('BRX6', 102, 1e9)] });
  assert.deepEqual(all.map((i) => [i.id, i.value, i.change]), [['RGBI', 112.4, 0.12], ['CNY', 11.62, 1.04], ['USD', 83.3, 1.46], ['BRENT', 101.2, 1.2]]);
  assert.equal(all.find((i) => i.id === 'USD').name, 'Доллар (фиксинг)', 'фиксинг важнее пустого биржевого доллара');
  const partial = MoexSnapshot.buildMacro({ indices: null, currency, fixing: null, futures: [null, null, null] });
  assert.deepEqual(partial.map((i) => i.id), ['CNY']);
  assert.deepEqual(MoexSnapshot.buildMacro({}), []);
});

test('companyPattern: aliases know how a company is named in the news', () => {
  const hit = (ticker, text) => MoexSnapshot.companyPattern(ticker, '').test(text);
  assert.equal(hit('GAZP', '«Газпром» подписал контракт'), true);
  assert.equal(hit('GAZP', 'Газпром нефть увеличила добычу'), false, 'Газпром нефть это SIBN');
  assert.equal(hit('SIBN', 'Газпром нефть увеличила добычу'), true);
  assert.equal(hit('SBER', 'Аналитики Сбербанка ждут снижения ставки'), true, 'падежи');
  assert.equal(hit('SBER', 'Сберегательные сертификаты'), false);
  assert.equal(hit('LENT', 'Лента обновлена'), false, 'сайт называется так же');
  assert.equal(hit('LENT', 'сеть «Лента» откроет магазины'), true);
  assert.equal(hit('PIKK', 'пикник на обочине'), false);
  assert.equal(hit('MGNT', 'выручка Магнита выросла'), true);
  assert.equal(hit('MGNT', 'магнитная буря'), false);
  assert.equal(MoexSnapshot.companyPattern('ZZZZ', 'Полюс Золото ао').source, 'Полюс Золото', 'без алиаса по имени бумаги');
  assert.equal(MoexSnapshot.companyPattern('ZZZZ', 'АО'), null, 'слишком короткое имя ничего не ищет');
});
