const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/news.json'), 'utf8'));
const categoryIds = ['world', 'ru', 'business', 'tech', 'science', 'health', 'sports', 'culture'];
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

async function setup(t, { news = fixture(), saved, fail = false, observer = true } = {}) {
  const dom = new JSDOM(html, { url: 'https://mdanshin.github.io/news/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const state = { news, fail, calls: [], deferred: null, intersect: null };
  if (saved !== undefined) window.localStorage.setItem('news:selectedCats:v2', JSON.stringify(saved));
  window.fetch = async (url) => {
    state.calls.push(url);
    if (state.deferred) await state.deferred;
    if (state.fail) throw new Error('Offline');
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
  return news.items.filter((item) => item.categoryIds.some((id) => categories.includes(id)))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
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
  assert.ok(state.calls.every((url) => url.startsWith('data/news.json?')));
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
