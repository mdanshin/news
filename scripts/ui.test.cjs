const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const aiHtml = fs.readFileSync(path.join(root, 'ai.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/news.json'), 'utf8'));
const categoryIds = ['world', 'ru', 'business', 'tech', 'ai', 'security', 'science', 'health', 'sports', 'culture'];
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

async function setup(t, { news = fixture(), saved, savedTheme, hidden, systemDark = false, fail = false, observer = true, ai = false } = {}) {
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
    news, fail, calls: [], deferred: null, intersect: null, articles: {},
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
  window.eval(script);
  await tick();
  return { window, document: window.document, state };
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
      { id: 'built', title: 'Обзор новых средств защиты', excerpt: '', categoryIds: ['security'], publishedAt: '2026-09-09T05:00:00Z', sourceName: 'Источник' }
    ]
  };
  const { document } = await setup(t, { news, saved: ['security'] });
  assert.deepEqual(ids(document), ['leak', 'cve', 'built']);
  assert.equal(document.querySelector('#feedTitle').textContent, 'Кибербезопасность');
  assert.deepEqual([...document.querySelectorAll('.tag')].map((node) => node.textContent), ['Кибербезопасность', 'Кибербезопасность', 'Кибербезопасность']);
  assert.equal(document.querySelector('#count-security').textContent, '3');
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
