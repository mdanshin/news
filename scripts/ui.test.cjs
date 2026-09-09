const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const aiHtml = fs.readFileSync(path.join(root, 'ai.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const moexScript = fs.readFileSync(path.join(root, 'moex-snapshot.js'), 'utf8');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/news.json'), 'utf8'));
const categoryIds = ['world', 'ru', 'business', 'markets', 'tech', 'ai', 'security', 'science', 'health', 'sports', 'culture'];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  return {
    generatedAt: '2026-09-09T10:00:00Z',
    items: Array.from({ length: 32 }, (_, index) => ({
      id: `article-${index}`,
      title: `Публикация ${index}`,
      categoryIds: index % 2 ? ['world', 'science'] : ['tech', 'science'],
      publishedAt: new Date(Date.UTC(2026, 8, 9, 9, index)).toISOString(),
      sourceName: 'Источник',
      url: `https://example.com/articles/${index}`,
      image: index % 3 ? `https://example.com/images/${index}.jpg` : '',
      excerpt: 'Краткое описание публикации.',
      contentHtml: '<h2>Подробности</h2><p>Текст публикации.</p>'
    })).reverse()
  };
}

async function setup(t, { news = fixture(), saved, savedTheme, hidden, moex = null, iss = null, systemDark = false, fail = false, observer = true, ai = false } = {}) {
  const dom = new JSDOM(ai ? aiHtml : html, { url: `https://mdanshin.github.io/news/${ai ? 'ai.html' : ''}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const themeListeners = [];
  const media = {
    matches: systemDark,
    addEventListener(event, listener) { if (event === 'change') themeListeners.push(listener); },
    addListener(listener) { themeListeners.push(listener); }
  };
  window.matchMedia = () => media;
  const state = {
    news, fail, calls: [], deferred: null, intersect: null, articles: {}, moex, iss,
    setSystemDark(value) {
      media.matches = value;
      themeListeners.forEach((listener) => listener({ matches: value }));
    }
  };
  if (saved !== undefined) window.localStorage.setItem('news:selectedCats:v2', JSON.stringify(saved));
  if (savedTheme !== undefined) window.localStorage.setItem('news:theme:v1', savedTheme);
  if (hidden !== undefined) window.localStorage.setItem('news:hiddenSources:v1', JSON.stringify(hidden));
  window.fetch = async (url) => {
    state.calls.push(url);
    if (state.deferred) await state.deferred;
    if (state.fail) throw new Error('Offline');
    if (url.startsWith('https://iss.moex.com/')) {
      // `iss` is the raw exchange answer, 'network' a blocked cross-origin
      // request, and null an HTTP refusal that should not be retried.
      if (state.iss === 'network') throw new TypeError('Failed to fetch');
      if (!state.iss) return { ok: false, status: 403, json: async () => ({}) };
      const block = issBlock(state.iss, url);
      if (!block) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => structuredClone(block) };
    }
    if (url === 'data/moex.json') {
      if (!state.moex) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => structuredClone(state.moex) };
    }
    if (url.startsWith('data/articles/')) {
      const article = state.articles[decodeURIComponent(url.slice('data/articles/'.length, -'.json'.length))];
      if (!article) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => structuredClone(article) };
    }
    return { ok: true, json: async () => structuredClone(state.news) };
  };
  if (observer) window.IntersectionObserver = class {
    constructor(callback) { state.intersect = () => callback([{ isIntersecting: true }]); }
    observe() {}
    disconnect() {}
  };
  if (!ai) window.eval(moexScript);
  window.eval(script);
  await tick();
  return { window, document: window.document, state };
}

/** Which fixture answers an ISS URL: the board, candles of an interval, a currency board, a contract. */
function issBlock(iss, url) {
  const { pathname, searchParams } = new URL(url);
  if (pathname.includes('/candles')) return (iss.candles || {})[searchParams.get('interval')] || null;
  if (pathname.includes('/markets/shares/')) return iss.shares || null;
  if (pathname.includes('/boards/FIXI/')) return iss.fixing || null;
  if (pathname.includes('/markets/index/')) return iss.indices || null;
  if (pathname.includes('/markets/selt/')) return iss.currency || null;
  const contract = pathname.match(/\/forts\/securities\/([A-Z0-9]+)/);
  if (contract) return (iss.futures || {})[contract[1]] || null;
  return null;
}

function ids(document) {
  return [...document.querySelectorAll('#grid article')].map((element) => element.dataset.id);
}

function wanted(news, categories) {
  const list = news.items.filter((item) => item.categoryIds.some((id) => categories.includes(id)))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  // The newest story with a picture in the first batch leads the feed.
  const lead = list.slice(0, 12).findIndex((item) => item.image);
  if (lead > 0) list.unshift(list.splice(lead, 1)[0]);
  return list;
}

test('real snapshot: selection, combined topics, chronological batches and source dates', async (t) => {
  const { document, state } = await setup(t, { news: snapshot });
  const tech = wanted(snapshot, ['tech']);
  assert.deepEqual(ids(document), tech.slice(0, 12).map((item) => item.id));
  assert.equal(document.querySelector('#feedTitle').textContent, 'Технологии');
  assert.equal(document.querySelector('#grid time').dateTime, tech[0].publishedAt);
  document.querySelector('#cat-science').click();
  assert.deepEqual(ids(document), wanted(snapshot, ['tech', 'science']).slice(0, 12).map((item) => item.id));
  document.querySelector('#selectAllBtn').click();
  const all = wanted(snapshot, categoryIds);
  assert.deepEqual(ids(document), all.slice(0, 12).map((item) => item.id));
  state.intersect();
  const rendered = ids(document);
  assert.ok(rendered.length > 12);
  assert.equal(new Set(rendered).size, rendered.length);
  assert.deepEqual(rendered, all.slice(0, rendered.length).map((item) => item.id));
  assert.match(document.querySelector('#resultCount').textContent.replace(/\s/g, ''), new RegExp(`^${all.length}`));
  assert.ok(state.calls.every((url) => url === 'data/news.json'));
});

test('theme follows the system until a manual choice is saved', async (t) => {
  const { document, window, state } = await setup(t, { systemDark: true });
  const toggle = document.querySelector('#themeToggle');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.querySelector('#themeColor').content, '#0e1013');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Включить светлую тему');
  toggle.click();
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(window.localStorage.getItem('news:theme:v1'), 'light');
  assert.equal(toggle.getAttribute('aria-label'), 'Включить тёмную тему');
  state.setSystemDark(false);
  state.setSystemDark(true);
  assert.equal(document.documentElement.dataset.theme, 'light');
  const restored = await setup(t, { savedTheme: 'dark', systemDark: false });
  assert.equal(restored.document.documentElement.dataset.theme, 'dark');
});

test('dedicated AI section contains only AI stories and ignores the main feed selection', async (t) => {
  const news = {
    generatedAt: '2026-09-09T10:00:00Z',
    items: [
      { id: 'openai', title: 'OpenAI представила GPT-6', excerpt: 'Новая языковая модель', categoryIds: ['tech'], publishedAt: '2026-09-09T09:00:00Z', sourceName: 'Источник' },
      { id: 'economy', title: 'Центробанк изменил ставку', excerpt: 'Новости экономики', categoryIds: ['business'], publishedAt: '2026-09-09T08:00:00Z', sourceName: 'Источник' },
      { id: 'ml', title: 'Машинное обучение ускорило исследование', excerpt: 'Работа учёных', categoryIds: ['science'], publishedAt: '2026-09-09T07:00:00Z', sourceName: 'Другой источник' },
      { id: 'gemini-zodiac', title: 'Gemini: сезон Близнецов', excerpt: 'Астрологический прогноз', categoryIds: ['culture'], publishedAt: '2026-09-09T06:00:00Z', sourceName: 'Источник' }
    ]
  };
  const { document } = await setup(t, { news, saved: ['business'], ai: true });
  assert.deepEqual(ids(document), ['openai', 'ml']);
  assert.equal(document.querySelector('#feedTitle').textContent, 'Искусственный интеллект');
  assert.equal(document.querySelector('#resultCount').textContent, '2 материала');
  assert.equal(document.querySelector('.section-nav__link[aria-current="page"]').getAttribute('href'), 'ai.html');
  assert.deepEqual([...document.querySelectorAll('.tag')].map((node) => node.textContent), ['ИИ', 'ИИ']);
});

test('source filter hides sources, persists, keeps counts honest and can be restored', async (t) => {
  const news = {
    generatedAt: '2026-09-09T10:00:00Z',
    items: [
      { id: 'a1', title: 'Первая от А', categoryIds: ['tech'], publishedAt: '2026-09-09T09:00:00Z', sourceId: 'a', sourceName: 'Альфа', url: 'https://a.example/1' },
      { id: 'b1', title: 'Первая от Б', categoryIds: ['tech'], publishedAt: '2026-09-09T08:00:00Z', sourceId: 'b', sourceName: 'Бета', url: 'https://b.example/1' },
      { id: 'a2', title: 'Вторая от А', categoryIds: ['science'], publishedAt: '2026-09-09T07:00:00Z', sourceId: 'a', sourceName: 'Альфа', url: 'https://a.example/2' },
      { id: 'legacy', title: 'Без идентификатора источника', categoryIds: ['tech'], publishedAt: '2026-09-09T06:00:00Z', sourceName: 'Гамма', url: 'https://c.example/1' }
    ]
  };
  const { document, window } = await setup(t, { news });
  assert.equal(document.querySelector('#sourcesBlock').hidden, false);
  assert.deepEqual([...document.querySelectorAll('#sources .chip__name')].map((node) => node.textContent), ['Альфа', 'Бета', 'Гамма']);
  assert.equal(document.querySelector('#count-src-a').textContent, '2');
  assert.deepEqual(ids(document), ['a1', 'b1', 'legacy']);
  assert.equal(document.querySelector('#sourcesAllBtn').disabled, true);

  document.querySelector('#src-a').click();
  assert.deepEqual(ids(document), ['b1', 'legacy']);
  assert.equal(window.localStorage.getItem('news:hiddenSources:v1'), '["a"]');
  assert.equal(document.querySelector('#count-tech').textContent, '2');
  assert.equal(document.querySelector('#allCount').textContent, '2');
  assert.equal(document.querySelector('#sourceSummary').textContent, '2 из 3 источников в ленте');
  assert.equal(document.querySelector('#sourcesAllBtn').disabled, false);

  document.querySelector('#src-b').click();
  document.querySelector('#src-Гамма').click();
  assert.deepEqual(ids(document), []);
  assert.equal(document.querySelector('#feedState').hidden, false);
  assert.match(document.querySelector('#stateTitle').textContent, /источники выключены/);
  document.querySelector('#stateAction').click();
  assert.deepEqual(ids(document), ['a1', 'b1', 'legacy']);
  assert.equal(window.localStorage.getItem('news:hiddenSources:v1'), '[]');

  const restored = await setup(t, { news, saved: ['tech', 'science'] });
  assert.deepEqual(ids(restored.document), ['a1', 'b1', 'a2', 'legacy']);
  const reloaded = await setup(t, { news, saved: ['tech', 'science'], hidden: ['b', 'stale'] });
  assert.deepEqual(ids(reloaded.document), ['a1', 'a2', 'legacy']);
  assert.equal(reloaded.document.querySelector('#src-b').checked, false);
  assert.equal(reloaded.document.querySelector('#src-a').checked, true);
  assert.equal(reloaded.document.querySelector('#sourceSummary').textContent, '2 из 3 источников в ленте');

  const ai = await setup(t, { news: { ...news, items: news.items.map((item) => ({ ...item, title: `${item.title} про нейросети` })) }, ai: true });
  assert.equal(ai.document.querySelector('#sourcesBlock').hidden, false);
  ai.document.querySelector('#src-a').click();
  assert.deepEqual(ids(ai.document), ['b1', 'legacy']);
});

test('source filter marks a source whose pages the build cannot read', async (t) => {
  const news = { generatedAt: '2026-09-09T10:00:00Z', items: [] };
  const hour = 3600e3;
  // Delta publishes all day but the build never gets its text; Alpha lost
  // one page out of six; Gamma has too few items to judge.
  for (let i = 0; i < 6; i += 1) {
    news.items.push({ id: `d${i}`, title: `Анонс ${i}`, categoryIds: ['tech'], publishedAt: new Date(Date.now() - i * hour).toISOString(), sourceId: 'd', sourceName: 'Дельта', url: `https://d.example/${i}`, hasContent: i === 0 });
    news.items.push({ id: `a${i}`, title: `Статья ${i}`, categoryIds: ['tech'], publishedAt: new Date(Date.now() - i * hour).toISOString(), sourceId: 'a', sourceName: 'Альфа', url: `https://a.example/${i}`, hasContent: i !== 0 });
  }
  for (let i = 0; i < 3; i += 1) {
    news.items.push({ id: `g${i}`, title: `Заметка ${i}`, categoryIds: ['tech'], publishedAt: new Date(Date.now() - i * hour).toISOString(), sourceId: 'g', sourceName: 'Гамма', url: `https://g.example/${i}`, hasContent: false });
  }
  const { document } = await setup(t, { news });
  assert.deepEqual([...document.querySelectorAll('#sources .chip__name')].map((node) => node.firstChild.textContent), ['Альфа', 'Гамма', 'Дельта']);
  assert.deepEqual([...document.querySelectorAll('#sources .chip__note')].map((node) => node.parentNode.firstChild.textContent), ['Дельта']);
  assert.equal(document.querySelector('#sources .chip__note').textContent, 'только анонсы');
  assert.match(document.querySelector('label[for="src-d"]').title, /не отдаёт текст/);
  assert.equal(document.querySelector('label[for="src-a"]').title, '');
});

test('lead card is the newest illustrated story of the first batch; order is otherwise chronological', async (t) => {
  const news = fixture();
  // Tech items newest first: 30 (no picture), 28, 26 (pictures), 24 (none)...
  const { document } = await setup(t, { news });
  const shown = ids(document);
  assert.deepEqual(shown.slice(0, 4), ['article-28', 'article-30', 'article-26', 'article-24']);
  assert.ok(document.querySelector('.card--lead .card__media img'));
  assert.equal(document.querySelector('.card--lead').dataset.id, 'article-28');

  // Without any picture in the first batch nothing is reordered.
  const plain = fixture();
  for (const item of plain.items) item.image = '';
  const bare = await setup(t, { news: plain });
  assert.deepEqual(ids(bare.document).slice(0, 3), ['article-30', 'article-28', 'article-26']);
  assert.ok(bare.document.querySelector('.card--lead.card--text'));

  // A picture deep in the list does not jump over the first batch.
  const far = fixture();
  for (const item of far.items) item.image = item.id === 'article-0' ? 'https://example.com/far.jpg' : '';
  const deep = await setup(t, { news: far });
  assert.equal(ids(deep.document)[0], 'article-30');
});

test('cyber security section collects security stories from any source until the next build', async (t) => {
  const news = {
    generatedAt: '2026-09-09T10:00:00Z',
    items: [
      { id: 'leak', title: 'Хакеры взломали крупный банк', excerpt: 'Утечка данных клиентов', categoryIds: ['ru'], publishedAt: '2026-09-09T09:00:00Z', sourceName: 'Источник' },
      { id: 'cve', title: 'Critical vulnerability CVE-2026-1234 exploited in the wild', excerpt: '', categoryIds: ['tech'], publishedAt: '2026-09-09T08:00:00Z', sourceName: 'Источник' },
      { id: 'esports', title: 'Киберспортсмены выиграли турнир', excerpt: 'Финал прошёл в Москве', categoryIds: ['sports'], publishedAt: '2026-09-09T07:00:00Z', sourceName: 'Источник' },
      { id: 'gas', title: 'Утечка газа в жилом доме', excerpt: '', categoryIds: ['ru'], publishedAt: '2026-09-09T06:00:00Z', sourceName: 'Источник' },
      { id: 'game', title: 'Вышел киберпанковый шутер', excerpt: 'Вдохновлён Half-Life 2', categoryIds: ['tech'], publishedAt: '2026-09-09T05:30:00Z', sourceName: 'Источник' },
      { id: 'car', title: 'Угнал машины без взлома', excerpt: 'Умение убеждать', categoryIds: ['ru'], publishedAt: '2026-09-09T05:20:00Z', sourceName: 'Источник' },
      { id: 'phone', title: 'Ваш телефон всё равно взломают', excerpt: '', categoryIds: ['tech'], publishedAt: '2026-09-09T05:10:00Z', sourceName: 'Источник' },
      { id: 'built', title: 'Обзор новых средств защиты', excerpt: '', categoryIds: ['security'], publishedAt: '2026-09-09T05:00:00Z', sourceName: 'Источник' }
    ]
  };
  const { document } = await setup(t, { news, saved: ['security'] });
  assert.deepEqual(ids(document), ['leak', 'cve', 'phone', 'built']);
  assert.equal(document.querySelector('#feedTitle').textContent, 'Кибербезопасность');
  assert.deepEqual([...document.querySelectorAll('.tag')].map((node) => node.textContent), ['Кибербезопасность', 'Кибербезопасность', 'Кибербезопасность', 'Кибербезопасность']);
  assert.equal(document.querySelector('#count-security').textContent, '4');
});

function moexFixture() {
  return {
    generatedAt: '2026-09-09T10:12:00Z',
    source: 'Московская биржа (ISS)',
    indices: [{ ticker: 'IMOEX', name: 'Индекс МосБиржи', value: 2841.55, change: -0.34 }],
    stocks: [
      { ticker: 'SBER', name: 'Сбербанк', sector: 'Финансы', price: 312.4, change: 1.8, turnover: 9.4e9, weight: 7e12, weightBasis: 'capitalisation' },
      { ticker: 'GAZP', name: 'Газпром', sector: 'Нефть и газ', price: 128.9, change: -2.6, turnover: 5.1e9, weight: 3e12, weightBasis: 'capitalisation' },
      { ticker: 'LKOH', name: 'Лукойл', sector: 'Нефть и газ', price: 6800, change: 0.04, turnover: 4.2e9, weight: 4.5e12, weightBasis: 'capitalisation' },
      { ticker: 'GMKN', name: 'Норникель', sector: 'Металлы', price: 141.2, change: -5.1, turnover: 2.8e9, weight: 2.1e12, weightBasis: 'capitalisation' }
    ]
  };
}

/** The exchange's own answer shape: one {columns, data} table per block. */
function issFixture() {
  return {
    shares: {
      securities: {
        columns: ['SECID', 'SHORTNAME', 'PREVPRICE', 'ISSUECAPITALIZATION'],
        data: [['SBER', 'Сбербанк', 306.9, 7e12], ['GAZP', 'Газпром', 132.3, 3e12], ['LKOH', 'Лукойл', 6797, 4.5e12], ['GMKN', 'Норникель', 148.8, 2.1e12], ['ZZZZ', 'Без торгов', null, null]]
      },
      marketdata: {
        columns: ['SECID', 'LAST', 'LASTTOPREVPRICE', 'VALTODAY'],
        data: [['SBER', 312.4, 1.8, 9.4e9], ['GAZP', 128.9, -2.6, 5.1e9], ['LKOH', 6800, 0.04, 4.2e9], ['GMKN', null, null, 2.8e9], ['ZZZZ', null, null, 0]]
      }
    },
    indices: {
      securities: { columns: ['SECID', 'SHORTNAME'], data: [['IMOEX', 'Индекс МосБиржи'], ['RTSI', 'Индекс РТС'], ['RGBI', 'Индекс гособлигаций']] },
      marketdata: { columns: ['SECID', 'CURRENTVALUE', 'LASTCHANGEPRC'], data: [['RTSI', 1100.2, 0.5], ['IMOEX', 2841.55, -0.34], ['MCXSM', 1, 1], ['RGBI', 112.4, 0.12]] }
    },
    candles: {
      10: {
        candles: {
          columns: ['begin', 'end', 'open', 'close', 'high', 'low'],
          data: [
            ['2026-09-08 18:30:00', '2026-09-08 18:39:59', 2850, 2851.2, 2852, 2849],
            ['2026-09-09 10:00:00', '2026-09-09 10:09:59', 2851, 2848, 2852, 2847],
            ['2026-09-09 10:10:00', '2026-09-09 10:19:59', 2848, 2836.4, 2849, 2835],
            ['2026-09-09 10:20:00', '2026-09-09 10:29:59', 2836.4, 2844, 2845, 2836],
            ['2026-09-09 18:40:00', '2026-09-09 18:49:59', 2844, 2841.55, 2846, 2840]
          ]
        }
      },
      24: {
        candles: {
          columns: ['begin', 'end', 'open', 'close', 'high', 'low'],
          data: Array.from({ length: 20 }, (_, i) => [`2026-08-${String(10 + i).padStart(2, '0')} 00:00:00`, '', 2700 + i * 5, 2700 + i * 7, 2760, 2690])
        }
      }
    },
    currency: {
      securities: { columns: ['SECID', 'SHORTNAME', 'PREVPRICE'], data: [['CNYRUB_TOM', 'CNYRUB_TOM', 11.5]] },
      marketdata: { columns: ['SECID', 'LAST', 'LASTTOPREVPRICE'], data: [['CNYRUB_TOM', 11.62, 1.04]] }
    },
    fixing: {
      securities: { columns: ['SECID', 'SHORTNAME', 'PREVPRICE'], data: [['USDFIX', 'USD/RUB fixing', 82.1]] },
      marketdata: { columns: ['SECID', 'CURRENTVALUE'], data: [['USDFIX', 83.3]] }
    },
    futures: {
      BRV6: {
        securities: { columns: ['SECID', 'SHORTNAME', 'PREVSETTLEPRICE'], data: [['BRV6', 'BR-10.26', 100.5]] },
        marketdata: { columns: ['SECID', 'LAST', 'VALTODAY', 'LASTTOPREVPRICE'], data: [['BRV6', 101.2, 5e9, 0.7]] }
      }
    }
  };
}

/** Feed where a few stories name listed companies. */
function companyNewsFixture() {
  const news = fixture();
  for (const item of news.items) item.categoryIds = ['markets', 'business'];
  news.items[0].title = 'Сбер повысил ставки по вкладам';
  news.items[1].title = 'Сберегательные сертификаты возвращаются';
  news.items[2].title = 'Газпром нефть увеличила добычу';
  news.items[3].title = '«Газпром» подписал контракт с Китаем';
  news.items[4].excerpt = 'Аналитики Сбербанка ждут снижения ставки.';
  return news;
}

/** No network in jsdom: fail the JSONP script tags the page injected. */
function failJsonp(document, window) {
  for (const node of document.head.querySelectorAll('script[src*="iss.moex.com"]')) node.dispatchEvent(new window.Event('error'));
}

function marketsOnly() {
  const news = fixture();
  for (const item of news.items) item.categoryIds = ['markets', 'business'];
  return news;
}

test('market board asks the exchange itself, replaces the lead card and stays out of other sections', async (t) => {
  const { document, state } = await setup(t, { news: marketsOnly(), saved: ['markets'], iss: issFixture() });
  await tick();
  await tick();

  assert.equal(document.querySelector('#marketBoard').hidden, false);
  assert.equal(document.querySelector('#marketBoard').classList.contains('board--empty'), false);
  assert.equal(document.querySelector('#grid .card--lead'), null, 'большая карточка уступает место карте рынка');
  assert.ok(state.calls.some((url) => url.startsWith('https://iss.moex.com/iss/engines/stock/markets/shares/')), 'котировки запрошены у биржи');
  assert.ok(!state.calls.includes('data/moex.json'), 'срез сборщика не нужен, когда биржа отвечает');
  assert.equal(document.querySelectorAll('#boardHeat .heat__tile').length, 4, 'бумага без цены и капитализации не попадает на карту');
  assert.deepEqual([...document.querySelectorAll('#boardHeat .heat__ticker')].map((n) => n.textContent).sort(), ['GAZP', 'GMKN', 'LKOH', 'SBER']);
  // Colour is never the only channel: every tile names itself and its change.
  const tile = [...document.querySelectorAll('#boardHeat .heat__tile')].find((node) => node.dataset.ticker === 'SBER');
  assert.match(tile.getAttribute('aria-label'), /Сбербанк, \+1,80%/);
  assert.equal(tile.style.getPropertyValue('--fill'), 'var(--heat-u3)');
  assert.equal([...document.querySelectorAll('#boardHeat .heat__tile')].find((node) => node.dataset.ticker === 'LKOH').style.getPropertyValue('--fill'), 'var(--heat-zero)');
  // No trade yet today: the previous close stands in, with no change.
  const idle = [...document.querySelectorAll('#boardHeat .heat__tile')].find((node) => node.dataset.ticker === 'GMKN');
  assert.match(idle.getAttribute('aria-label'), /0,00%/);
  assert.equal(document.querySelectorAll('#boardTable tbody tr').length, 4);
  assert.match(document.querySelector('#boardTable').textContent, /148,8/);
  // The quote line repeats the list so the loop has no seam.
  assert.equal(document.querySelectorAll('#boardTickerTrack .quote').length, 8);
  const indices = [...document.querySelectorAll('#boardIndices .board__indexName')].map((n) => n.textContent);
  assert.deepEqual(indices, ['Индекс МосБиржи', 'Индекс РТС'], 'индексы в устоявшемся порядке, лишние не показываются');
  assert.match(document.querySelector('#boardMeta').textContent, /котировки на .+капитализация/);

  // Adding a second topic is no longer "the stock section": the board goes
  // away and the usual lead card comes back.
  document.querySelector('#cat-tech').click();
  assert.equal(document.querySelector('#marketBoard').hidden, true);
  assert.ok(document.querySelector('#grid .card--lead'), 'вне раздела крупная карточка возвращается');
});

test('market board falls back to JSONP when the plain request to the exchange is blocked', async (t) => {
  const { document, window, state } = await setup(t, { news: marketsOnly(), saved: ['markets'], iss: 'network' });
  await tick();
  await tick();
  // While the exchange is still answering, the board keeps its shape.
  const board = document.querySelector('#marketBoard');
  assert.equal(board.hidden, false);
  assert.ok(board.classList.contains('board--loading'));
  assert.equal(board.getAttribute('aria-busy'), 'true');
  assert.ok(document.querySelectorAll('#boardHeat .heat__ghost').length >= 8, 'скелетон карты на месте');
  assert.ok(document.querySelectorAll('#boardIndices .ghost').length >= 3);
  assert.ok(document.querySelectorAll('#boardTickerTrack .ghost').length >= 16);
  assert.match(document.querySelector('#boardMeta').textContent, /Запрашиваем/);

  const scripts = [...document.head.querySelectorAll('script[src*="iss.moex.com"]')];
  assert.equal(scripts.length, 2, 'после сетевой ошибки оба запроса уходят через script');
  const raw = issFixture();
  for (const node of scripts) {
    const url = new URL(node.src);
    assert.ok(url.pathname.endsWith('.jsonp'));
    const callback = url.searchParams.get('callback');
    assert.equal(typeof window[callback], 'function');
    window[callback](url.pathname.includes('/markets/index/') ? raw.indices : raw.shares);
  }
  await tick();
  await tick();
  assert.equal(document.querySelectorAll('#boardHeat .heat__tile').length, 4);
  assert.equal(document.querySelectorAll('#boardHeat .heat__ghost').length, 0, 'скелетон ушёл вместе с ответом');
  assert.equal(board.classList.contains('board--loading'), false);
  assert.equal(board.getAttribute('aria-busy'), 'false');
  const pending = [...document.head.querySelectorAll('script[src*="iss.moex.com"]')].map((node) => new URL(node.src).pathname);
  assert.ok(pending.every((path) => !path.includes('/markets/shares/') && !path.endsWith('/SNDX/securities.jsonp')), 'временные script котировок убраны');
  // Once the plain request is known to be blocked, the follow-up requests
  // (candles, currencies) go straight through script tags.
  assert.ok(pending.some((path) => path.includes('/candles')), 'свечи запрошены через JSONP без повторной прямой попытки');
  assert.equal(state.calls.filter((url) => url.includes('/candles')).length, 0);
  assert.ok(!state.calls.includes('data/moex.json'));
});

test('index chart, macro strip, movers and company news round out the stock section', async (t) => {
  const { document, state } = await setup(t, { news: companyNewsFixture(), saved: ['markets'], iss: issFixture() });
  await tick();
  await tick();
  await tick();

  // Chart of the last session: five candles of the week fixture, four of them today.
  const line = document.querySelector('#boardChart svg .chart__line');
  assert.ok(line, 'линия графика нарисована');
  assert.equal((line.getAttribute('d').match(/[ML]/g) || []).length, 4, 'на графике только последняя сессия');
  assert.ok(document.querySelector('#boardChart svg').classList.contains('is-down'), 'цвет по изменению к закрытию прошлой сессии');
  assert.match(document.querySelector('#boardChartStats').textContent, /2\s841,55.*−0,34%.*мин\.\s2\s836,4/);
  assert.deepEqual([...document.querySelectorAll('#boardChartAxis span')].map((n) => n.textContent), ['10:00', '18:40']);
  assert.match(document.querySelector('#boardChart').getAttribute('aria-label'), /Индекс МосБиржи, день: от 2\s848 до 2\s841,55, −0,34%/);
  const ranges = [...document.querySelectorAll('#boardRanges .chart__range')];
  assert.deepEqual(ranges.map((n) => n.textContent), ['День', 'Неделя', 'Месяц', 'С начала года']);
  assert.equal(ranges[0].getAttribute('aria-pressed'), 'true');

  ranges[2].click();
  await tick();
  await tick();
  assert.equal(ranges[2].getAttribute('aria-pressed'), 'true');
  assert.equal(ranges[0].getAttribute('aria-pressed'), 'false');
  assert.ok(state.calls.some((url) => url.includes('/candles') && url.includes('interval=24')), 'месяц запрашивает дневные свечи');
  assert.equal((document.querySelector('#boardChart svg .chart__line').getAttribute('d').match(/[ML]/g) || []).length, 20);
  assert.ok(document.querySelector('#boardChart svg').classList.contains('is-up'));

  // Macro strip: whatever answered, in a fixed order; the euro did not.
  const macro = [...document.querySelectorAll('#boardMacro .macro__row')].map((row) => row.querySelector('.macro__name').textContent);
  assert.deepEqual(macro, ['Гособлигации RGBI', 'Юань', 'Доллар (фиксинг)', 'Нефть Brent']);
  assert.match(document.querySelector('#boardMacro').textContent, /11,62 ₽.*\+1,04%/);
  assert.match(document.querySelector('#boardMacro').textContent, /101,2 \$.*\+0,70%/);

  // Movers come from the liquid names of the board.
  const titles = [...document.querySelectorAll('#boardMovers .movers__title')].map((n) => n.textContent);
  assert.deepEqual(titles, ['Рост дня', 'Падение дня', 'Оборот дня']);
  const columns = [...document.querySelectorAll('#boardMovers .movers__col')];
  assert.deepEqual([...columns[0].querySelectorAll('.movers__ticker')].map((n) => n.textContent), ['SBER', 'LKOH']);
  assert.deepEqual([...columns[1].querySelectorAll('.movers__ticker')].map((n) => n.textContent), ['GAZP']);
  assert.equal(columns[2].querySelector('.movers__ticker').textContent, 'SBER');

  // A tile opens the company panel with the feed's stories about it, and
  // "Сберегательные" is not "Сбер".
  const tile = [...document.querySelectorAll('#boardHeat .heat__tile')].find((node) => node.dataset.ticker === 'SBER');
  tile.click();
  const focus = document.querySelector('#boardFocus');
  assert.equal(focus.hidden, false);
  assert.equal(tile.getAttribute('aria-pressed'), 'true');
  assert.match(focus.querySelector('.focus__title').textContent, /Сбербанк · SBER/);
  assert.deepEqual([...focus.querySelectorAll('.focus__itemTitle')].map((n) => n.textContent), ['Сбер повысил ставки по вкладам', 'Публикация 27']);
  focus.querySelector('.focus__item').click();
  assert.equal(document.querySelector('#modal').getAttribute('aria-hidden'), 'false');
  assert.equal(document.querySelector('#modalTitle').textContent, 'Сбер повысил ставки по вкладам');
  document.querySelector('#modalClose').click();

  // Gazprom is not Gazprom Neft.
  [...document.querySelectorAll('#boardMovers .movers__row')].find((row) => row.dataset.ticker === 'GAZP').click();
  assert.deepEqual([...focus.querySelectorAll('.focus__itemTitle')].map((n) => n.textContent), ['«Газпром» подписал контракт с Китаем']);
  assert.equal(tile.hasAttribute('aria-pressed'), false);
  focus.querySelector('.focus__close').click();
  assert.equal(focus.hidden, true);
});

test('market board shows the committed snapshot when the exchange refuses, and says so', async (t) => {
  const { document, window, state } = await setup(t, { news: marketsOnly(), saved: ['markets'], moex: moexFixture() });
  await tick();
  await tick();
  failJsonp(document, window);
  await tick();
  await tick();
  assert.ok(state.calls.includes('data/moex.json'));
  assert.equal(document.querySelector('#marketBoard').hidden, false);
  assert.equal(document.querySelectorAll('#boardHeat .heat__tile').length, 4);
  assert.match(document.querySelector('#boardMeta').textContent, /срез от .+биржа сейчас не отвечает/);
});

test('market board explains itself when no quotes are available at all', async (t) => {
  const news = fixture();
  for (const item of news.items) item.categoryIds = ['markets'];
  const { document, window, state } = await setup(t, { news, saved: ['markets'] });
  await tick();
  await tick();
  failJsonp(document, window);
  await tick();
  await tick();
  const board = document.querySelector('#marketBoard');
  assert.equal(board.hidden, false);
  assert.ok(board.classList.contains('board--empty'));
  const meta = document.querySelector('#boardMeta');
  // The notice names what every path answered, so a reader can report it.
  assert.match(meta.textContent, /недоступны \(прямой запрос: HTTP 403; резерв: HTTP 404\)/);
  assert.equal(document.querySelectorAll('#boardHeat .heat__tile').length, 0);
  assert.equal(document.querySelectorAll('#marketBoard .ghost').length, 0, 'скелетон не остаётся под сообщением');
  assert.ok(ids(document).length > 0, 'лента продолжает работать без биржевых данных');

  // "Повторить" asks again without a reload; this time the exchange answers.
  const before = state.calls.length;
  state.iss = issFixture();
  meta.querySelector('.board__retry').click();
  await tick();
  await tick();
  assert.ok(state.calls.length > before, 'повтор действительно запрашивает биржу');
  assert.equal(document.querySelectorAll('#boardHeat .heat__tile').length, 4);
  assert.equal(board.classList.contains('board--empty'), false);
});

test('cleared selection persists, explains the empty state and can be restored', async (t) => {
  const { document, window } = await setup(t);
  document.querySelector('#clearBtn').click();
  assert.deepEqual(ids(document), []);
  assert.equal(document.querySelector('#feedState').hidden, false);
  assert.equal(document.activeElement, document.querySelector('#stateAction'));
  assert.equal(window.localStorage.getItem('news:selectedCats:v2'), '[]');
  const restored = await setup(t, { saved: [] });
  assert.deepEqual(ids(restored.document), []);
  restored.document.querySelector('#stateAction').click();
  assert.equal(ids(restored.document).length, 12);
  assert.equal(restored.document.querySelector('#feedState').hidden, true);
});

test('reader opens from a real button, traps focus, closes through its icon and restores focus', async (t) => {
  const { document, window } = await setup(t);
  const opener = document.querySelector('.card__title button');
  opener.focus();
  opener.click();
  assert.equal(document.querySelector('#modal').getAttribute('aria-hidden'), 'false');
  assert.equal(document.querySelector('#pageShell').inert, true);
  assert.equal(document.activeElement, document.querySelector('#modalClose'));
  const buttons = document.querySelectorAll('.modal__foot button');
  buttons[0].focus();
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
  assert.equal(document.activeElement, document.querySelector('#fontDownBtn'));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
  assert.equal(document.activeElement, buttons[0]);
  document.querySelector('#fontUpBtn').click();
  assert.equal(window.localStorage.getItem('news:readerFontPx:v1'), '19');
  document.querySelector('#modalClose svg path').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.querySelector('#modal').getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelector('#pageShell').inert, false);
  assert.equal(document.activeElement, opener);
  opener.click();
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(document.activeElement, opener);
});

test('reader fetches article text on demand, caches it, and survives a missing file', async (t) => {
  const news = fixture();
  // The default feed shows the «tech» items, i.e. the even indexes, newest
  // first; article-30 has no picture, so article-28 is promoted to the lead.
  const [first, second, third] = ['article-28', 'article-30', 'article-26'].map((id) => news.items.find((item) => item.id === id));
  first.contentHtml = '';
  first.hasContent = true;
  second.contentHtml = '';
  second.hasContent = true;
  third.contentHtml = '';
  third.hasContent = false;
  const { document, state } = await setup(t, { news });
  state.articles[first.id] = { contentHtml: '<h2>Из файла</h2><p>Полный текст</p><script>alert(1)</script>', contentTruncated: true };
  const openers = [...document.querySelectorAll('.card__title button')];
  const body = document.querySelector('#modalBody');
  assert.equal(state.calls.length, 1);

  openers[0].click();
  assert.match(body.textContent, /Загружаем полный текст/);
  assert.match(body.textContent, /Краткое описание/);
  await tick();
  await tick();
  assert.match(body.textContent, /Из файла/);
  assert.match(body.textContent, /сокращённая версия/);
  assert.equal(body.querySelector('script'), null);
  assert.deepEqual(state.calls.slice(1), [`data/articles/${first.id}.json`]);

  document.querySelector('#modalClose').click();
  openers[0].click();
  assert.match(body.textContent, /Из файла/);
  assert.equal(state.calls.length, 2);

  document.querySelector('#modalClose').click();
  openers[1].click();
  await tick();
  await tick();
  assert.match(body.textContent, /Не удалось загрузить текст/);
  assert.match(body.textContent, /доступен в источнике/);
  assert.equal(state.calls.length, 3);

  document.querySelector('#modalClose').click();
  openers[2].click();
  await tick();
  assert.match(body.textContent, /Полный текст этой публикации доступен в источнике/);
  assert.equal(state.calls.length, 3);

  // A late response for a previous story must not overwrite the current one.
  let release;
  state.deferred = new Promise((done) => { release = done; });
  state.articles[second.id] = { contentHtml: '<p>Поздний ответ</p>' };
  document.querySelector('#modalClose').click();
  openers[1].click();
  document.querySelector('#modalClose').click();
  openers[2].click();
  release();
  state.deferred = null;
  await tick();
  await tick();
  assert.doesNotMatch(body.textContent, /Поздний ответ/);
});

test('failed initial request is retryable; failed or unchanged refresh keeps visible articles', async (t) => {
  const { document, state } = await setup(t, { fail: true });
  assert.equal(document.querySelector('#feedState').hidden, false);
  assert.match(document.querySelector('#stateTitle').textContent, /Не удалось/);
  assert.equal(document.querySelector('#endSpinner').hidden, true);
  document.querySelector('#stateAction').focus();
  document.querySelector('#stateAction').click();
  await tick();
  assert.equal(document.activeElement, document.querySelector('#stateAction'));
  state.fail = false;
  document.querySelector('#stateAction').click();
  await tick();
  const card = document.querySelector('#grid article');
  assert.ok(card);
  assert.equal(document.activeElement, document.querySelector('#feedTitle'));
  document.querySelector('#refreshBtn').click();
  await tick();
  assert.equal(document.querySelector('#grid article'), card);
  state.fail = true;
  document.querySelector('#refreshBtn').click();
  await tick();
  assert.equal(document.querySelector('#grid article'), card);
  assert.match(document.querySelector('#status').textContent, /Показываем загруженные/);
  assert.equal(document.querySelector('#refreshBtn').disabled, false);
});

test('loading is bounded to one request, and malformed refresh never erases the last valid feed', async (t) => {
  const { document, state } = await setup(t);
  const card = document.querySelector('#grid article');
  let resolve;
  state.deferred = new Promise((done) => { resolve = done; });
  document.querySelector('#refreshBtn').click();
  document.querySelector('#refreshBtn').click();
  assert.equal(state.calls.length, 2);
  assert.equal(document.querySelector('#grid').getAttribute('aria-busy'), 'true');
  assert.equal(document.querySelector('#endSpinner').hidden, false);
  state.news = { generatedAt: 'later', items: null };
  resolve();
  await tick();
  assert.equal(document.querySelector('#grid article'), card);
  assert.equal(document.querySelector('#grid').getAttribute('aria-busy'), 'false');
  assert.equal(document.querySelector('#endSpinner').hidden, true);
});

test('missing images and unavailable categories have useful fallbacks without fabricated content', async (t) => {
  const { document, window } = await setup(t);
  const img = document.querySelector('.card__media img');
  const article = img.closest('article');
  img.dispatchEvent(new window.Event('error'));
  assert.equal(article.querySelector('img'), null);
  assert.ok(article.querySelector('.card__title button').textContent);
  document.querySelector('#clearBtn').click();
  document.querySelector('#cat-sports').click();
  assert.equal(document.querySelector('#feedState').hidden, false);
  assert.match(document.querySelector('#stateTitle').textContent, /пока тихо/);
  const empty = await setup(t, { news: { generatedAt: '', items: [] } });
  assert.match(empty.document.querySelector('#stateTitle').textContent, /скоро появятся/);
  assert.equal(empty.document.querySelector('#endSpinner').hidden, true);
});

test('article rendering retains safe links while rejecting executable URLs and handlers', async (t) => {
  const news = fixture();
  for (const item of news.items) {
    item.url = 'javascript:alert(1)';
    item.image = 'javascript:alert(1)';
    item.contentHtml = '<p onclick="alert(1)">Текст</p><a href="https://example.com">Источник</a><a href="javascript:alert(1)">Опасная ссылка</a><script>alert(1)</script><img src="https://example.com/photo.jpg" onerror="alert(1)">';
  }
  const { document } = await setup(t, { news });
  document.querySelector('.card__title button').click();
  const body = document.querySelector('#modalBody');
  assert.equal(body.querySelector('script, [onclick], [onerror], [href^="javascript:"]'), null);
  assert.equal(body.querySelector('a').getAttribute('rel'), 'noreferrer noopener');
  assert.equal(body.querySelector('a').target, '_blank');
  assert.equal(body.querySelector('img').getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(document.querySelector('#modalLink').hidden, true);
  assert.equal(document.querySelector('#grid img'), null);
});

test('feed still loads when IntersectionObserver is unavailable', async (t) => {
  const { document } = await setup(t, { observer: false });
  assert.equal(ids(document).length, 12);
  assert.equal(document.querySelector('#grid').getAttribute('aria-busy'), 'false');
});
