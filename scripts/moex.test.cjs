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
