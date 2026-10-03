import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createContentStore} from './admin-content.mjs';

const baselineFile = fileURLToPath(new URL('../content.json', import.meta.url));

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'zabota-content-test-'));
  const distRoot = path.join(projectRoot, 'dist'); const stateFile = path.join(projectRoot, 'cms-content.json');
  const backupDir = path.join(projectRoot, '.admin/backups');
  await copyFile(baselineFile, path.join(projectRoot, 'content.json')); await mkdir(distRoot);
  const options = {projectRoot, distRoot, stateFile, backupDir}; const store = createContentStore(options);
  async function html(file = 'index.html') { return readFile(path.join(distRoot, file), 'utf8'); }
  async function close() {
    const target = path.resolve(projectRoot);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('zabota-content-test-')) throw new Error('Unsafe test cleanup path');
    await rm(target, {recursive: true, force: true});
  }
  return {projectRoot, distRoot, stateFile, backupDir, options, store, html, close};
}

function payload(model) { return {revision: model.revision, data: structuredClone(model.data), overrides: structuredClone(model.overrides)}; }
function textItem(model, page, tag = 'h1') { return model.catalog.items.find(item => item.page === page && item.kind === 'text' && item.tag === tag); }
function findElement(html, tag, attribute, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<${tag}\\b[^>]*${attribute}="${escaped}"[^>]*>[\\s\\S]*?<\\/${tag}>`))?.[0];
}

test('Publishes all eleven pages with escaped text, table cells, links and image attributes', async () => {
  const f = await fixture();
  try {
    const model = await f.store.getContent();
    assert.equal(model.revision, 'initial'); assert.equal(model.catalog.pages.length, 11); assert.equal(model.catalog.tables.length, 2);
    const change = payload(model);
    const heading = textItem(model, 'index.html');
    const cell = model.catalog.tables.find(table => table.page === 'services.html').rows[1].cells[1];
    const link = model.catalog.items.find(item => item.page === 'index.html' && item.kind === 'link' && item.defaultValue === 'services.html');
    const image = model.catalog.items.find(item => item.page === 'index.html' && item.kind === 'image' && item.defaultValue === model.data.images.hero);
    change.overrides[heading.id] = {text: 'Помощь <img src=x onerror="alert(1)"> & поддержка'};
    change.overrides[cell.id] = {text: '127 <script>alert(2)</script>'};
    change.overrides[link.id] = {href: 'https://example.org/help?a=1&b=2'};
    change.overrides[image.id] = {src: 'assets/uploads/new-hero.png', alt: 'Цветы " onerror="alert(3)'};
    const saved = await f.store.saveContent(change);
    assert.equal(saved.saved, true); assert.notEqual(saved.revision, 'initial');
    assert.deepEqual((await readdir(f.distRoot)).sort(), model.catalog.pages.map(page => page.file).sort());
    let html = await f.html();
    assert.match(html, /Помощь &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; поддержка/);
    assert.ok(!html.includes('<img src=x onerror='));
    assert.ok(html.includes('href="https://example.org/help?a=1&amp;b=2"'));
    assert.ok(html.includes('src="assets/uploads/new-hero.png"'));
    assert.ok(html.includes('alt="Цветы &quot; onerror=&quot;alert(3)"'));
    html = await f.html('services.html');
    assert.match(html, /127 &lt;script&gt;alert\(2\)&lt;\/script&gt;/); assert.ok(!html.includes('<script>alert(2)</script>'));
    assert.equal((html.match(/<table\b/g) || []).length, 2);
    assert.equal((html.match(/<th\b[^>]*scope="col"/g) || []).length, 6);
    const persisted = JSON.parse(await readFile(f.stateFile, 'utf8'));
    assert.equal(persisted.revision, saved.revision); assert.equal(persisted.overrides[cell.id].text, change.overrides[cell.id].text);
    const next = await createContentStore(f.options).getContent();
    assert.equal(next.catalog.items.find(item => item.id === heading.id).value, change.overrides[heading.id].text);
    assert.equal(next.catalog.tables[0].rows[1].cells[1].value, change.overrides[cell.id].text);
  } finally { await f.close(); }
});

test('Documents, galleries, common contacts, capacity and additional blocks update public content', async () => {
  const f = await fixture();
  try {
    const model = await f.store.getContent(); const change = payload(model);
    change.data.documents.warning = {...change.data.documents.warning, src: 'assets/uploads/new-warning.pdf', size: 2048, format: 'PDF', title: 'Проверка <b>2027</b>', description: 'Новый документ & пояснение'};
    change.data.galleries.press = [{src: 'assets/uploads/press-new.jpg', thumb: 'assets/uploads/press-thumb.webp', caption: 'Новая публикация <script>x</script>', alt: 'Фото "сотрудников"', name: 'Публикация'}];
    change.data.galleries.thanks = [];
    change.data.images.logo = 'assets/uploads/new-logo.png'; change.data.images.hero = 'assets/uploads/flowers-2027.png'; change.data.images.qr = 'assets/uploads/new-qr.png';
    change.data.email = 'new-office@example.org'; change.data.phone = '+7 (812) 123-45-67';
    change.data.placeStats = {free: 77, planned: 200, actual: 123, date: '2027-02-03'};
    const linkKey = Object.keys(change.data.links)[0]; change.data.links[linkKey] = 'https://example.org/new-link';
    change.data.extraSections['reviews.html'] = [{id: 'visit', title: 'Приём <script>bad</script>', text: 'Первая строка\nПродолжение\n\nВторой абзац <img src=x>', image: 'assets/uploads/office.jpg', alt: 'Офис "приём"', href: 'https://example.org/visit?a=1&b=2', linkLabel: 'Записаться & уточнить'}];
    await f.store.saveContent(change);
    const home = await f.html(); const reviews = await f.html('reviews.html'); const quality = await f.html('quality.html');
    assert.ok(home.includes('data-document="warning" href="assets/uploads/new-warning.pdf" target="_blank" rel="noopener noreferrer"'));
    assert.ok(home.includes('Проверка &lt;b&gt;2027&lt;/b&gt;')); assert.ok(home.includes('Новый документ &amp; пояснение'));
    const document = findElement(home, 'a', 'data-document', 'warning'); assert.ok(document); assert.ok(!/\sdownload(?:\s|>)/.test(document));
    assert.ok(home.includes('href="assets/uploads/press-new.jpg"')); assert.ok(home.includes('src="assets/uploads/press-thumb.webp"'));
    assert.ok(home.includes('Новая публикация &lt;script&gt;x&lt;/script&gt;')); assert.ok(!home.includes('<script>x</script>'));
    assert.ok(home.includes('77 свободных мест')); assert.ok(home.includes('3 февраля 2027 года'));
    assert.ok(home.includes('tel:+78121234567')); assert.ok(home.includes('data-email="new-office@example.org"'));
    assert.ok(home.includes('href="mailto:new-office@example.org"')); assert.ok(home.includes('src="assets/uploads/new-logo.png"'));
    assert.ok(home.includes('src="assets/uploads/flowers-2027.png"')); assert.ok(quality.includes('src="assets/uploads/new-qr.png"'));
    assert.ok(reviews.includes('data-extra-section="visit"')); assert.ok(reviews.includes('Приём &lt;script&gt;bad&lt;/script&gt;'));
    assert.ok(reviews.includes('Первая строка<br>Продолжение')); assert.ok(reviews.includes('Второй абзац &lt;img src=x&gt;'));
    assert.ok(reviews.includes('src="assets/uploads/office.jpg"')); assert.ok(reviews.includes('href="https://example.org/visit?a=1&amp;b=2"'));
    const next = await f.store.getContent();
    assert.equal(next.data.links[linkKey], 'https://example.org/new-link'); assert.equal(next.data.galleries.thanks.length, 0);
    assert.equal(next.catalog.documentTitles.warning, 'Проверка <b>2027</b>');
    for (const page of next.catalog.pages) assert.ok((await f.html(page.file)).includes('tel:+78121234567'), page.file);
  } finally { await f.close(); }
});

test('Concurrent revision conflicts, previous versions and restore persist correctly', async () => {
  const f = await fixture();
  try {
    const initial = await f.store.getContent(); const first = payload(initial); const heading = textItem(initial, 'index.html');
    first.overrides[heading.id] = {text: 'Первая версия'};
    const competing = payload(initial); competing.overrides[heading.id] = {text: 'Вторая вкладка'};
    const outcomes = await Promise.allSettled([f.store.saveContent(first), f.store.saveContent(competing)]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(item => item.status === 'rejected').reason.status, 409);
    const second = await f.store.getContent(); assert.equal(second.catalog.items.find(item => item.id === heading.id).value, 'Первая версия');
    const secondChange = payload(second); secondChange.overrides[heading.id] = {text: 'Вторая сохранённая версия'};
    await f.store.saveContent(secondChange);
    const versions = await f.store.listVersions(); assert.equal(versions.length, 2);
    assert.ok(versions.some(item => item.revision === 'initial')); assert.ok(versions.some(item => item.revision === second.revision));
    const original = versions.find(item => item.revision === 'initial');
    assert.match(original.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Number.isFinite(Date.parse(original.createdAt)));
    const restored = await f.store.restore(original.id); assert.equal(restored.saved, true); assert.notEqual(restored.revision, 'initial');
    assert.equal((await f.store.getContent()).catalog.items.find(item => item.id === heading.id).value, heading.defaultValue);
    assert.ok(!(await f.html()).includes('Вторая сохранённая версия'));
    assert.equal((await f.store.listVersions()).length, 3);
    assert.equal((await createContentStore(f.options).getContent()).revision, restored.revision);
    await f.store.build(); assert.ok((await f.html()).includes('Мы вам поможем'));
    await assert.rejects(f.store.restore('../users'), error => error.status === 400);
    await assert.rejects(f.store.restore('2026T_aaaaaaaa'), error => error.status === 400);
    await writeFile(path.join(f.backupDir, 'unrelated.json'), '{}');
    assert.equal((await f.store.listVersions()).length, 3);
  } finally { await f.close(); }
});

test('Preview applies draft with root base, omits site scripts and writes no files', async () => {
  const f = await fixture();
  try {
    const model = await f.store.getContent(); const draft = payload(model); const heading = textItem(model, 'index.html');
    draft.overrides[heading.id] = {text: 'Черновик <script>alert(1)</script>'};
    const html = await f.store.preview({page: 'index.html', content: draft});
    assert.ok(html.includes('<base href="/">')); assert.ok(html.includes('Черновик &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!/<script\b/.test(html));
    assert.deepEqual(await readdir(f.distRoot), []);
    await assert.rejects(readFile(f.stateFile), error => error.code === 'ENOENT');
    assert.deepEqual(await f.store.listVersions(), []); assert.equal((await f.store.getContent()).revision, 'initial');
    await assert.rejects(f.store.preview({page: '../users.json', content: draft}), error => error.status === 400);
    await assert.rejects(f.store.preview({page: 'not-a-page.html', content: draft}), error => error.status === 400);
  } finally { await f.close(); }
});

test('Rejects unsafe URLs, wrong override types and invalid structured data without publishing', async () => {
  const f = await fixture();
  try {
    const model = await f.store.getContent(); const heading = textItem(model, 'index.html');
    const link = model.catalog.items.find(item => item.kind === 'link'); const image = model.catalog.items.find(item => item.kind === 'image');
    const attempts = [
      draft => { draft.overrides[heading.id] = {html: '<script>bad</script>'}; },
      draft => { draft.overrides[heading.id] = {href: 'https://example.org'}; },
      draft => { draft.overrides['unknown:element:text:1'] = {text: 'Not found'}; },
      draft => { draft.overrides[link.id] = {href: 'javascript:alert(1)'}; },
      draft => { draft.overrides[link.id] = {href: 'assets/documents/%252e%252e/users.json'}; },
      draft => { draft.overrides[image.id] = {src: 'data:image/svg+xml,<svg onload=alert(1)>'}; },
      draft => { draft.data.images.hero = '//evil.example/test.png'; },
      draft => { draft.data.images.hero = 'assets/images/../users.json'; },
      draft => { draft.data.documents.warning.src = 'assets/uploads/report.html'; },
      draft => { draft.data.documents.warning.size = 0; },
      draft => { draft.data.documents.warning.format = 'HTML'; },
      draft => { draft.data.documents.extra = {src: 'assets/documents/extra.pdf', size: 1, format: 'PDF'}; },
      draft => { draft.data.galleries.press = Array.from({length: 201}, () => ({src: 'assets/images/photo.jpg'})); },
      draft => { draft.data.galleries.press = [{src: 'assets/images/test.jpg', caption: 'x'.repeat(2001)}]; },
      draft => { draft.data.email = '"><img src=x>@evil.example'; },
      draft => { draft.data.phone = 'tel:javascript:alert(1)'; },
      draft => { draft.data.placeStats.free = -1; },
      draft => { draft.data.placeStats.date = '2027-02-30'; },
      draft => { draft.data.extraSections['not-a-page.html'] = []; },
      draft => { draft.data.extraSections['index.html'] = [{id: '../bad', title: 'Bad', text: 'Bad'}]; },
      draft => { draft.data.extraSections['index.html'] = [{id: 'same', title: 'One', text: 'One'}, {id: 'same', title: 'Two', text: 'Two'}]; },
      draft => { draft.data.extraSections['index.html'] = [{id: 'bad', title: 'Bad', text: 'Bad', href: 'javascript:alert(1)'}]; }
    ];
    for (const mutate of attempts) {
      const draft = payload(model); mutate(draft);
      await assert.rejects(f.store.saveContent(draft), error => error.status === 400, String(mutate));
    }
    assert.deepEqual(await readdir(f.distRoot), []); assert.deepEqual(await f.store.listVersions(), []);
    await assert.rejects(readFile(f.stateFile), error => error.code === 'ENOENT');
  } finally { await f.close(); }
});

test('Raw source HTML and source metadata stay protected by the data allowlist', async () => {
  const f = await fixture();
  try {
    const model = await f.store.getContent(); const draft = payload(model);
    draft.data.procedure = '<script id="malicious-procedure">alert(1)</script>';
    draft.data.tariffs = '<img src=x onerror="alert(2)">';
    draft.data.services = [{title: '<script>bad</script>', content: '<script>bad</script>'}];
    draft.data.faq = [{question: '<script>bad</script>', answer: '<script>bad</script>'}];
    draft.data.documents.warning.source = '../../.admin/users.json';
    draft.data.documents.warning.html = '<script>bad</script>';
    draft.data.evil = '<script id="malicious-global">bad</script>';
    await f.store.saveContent(draft);
    const next = await f.store.getContent();
    assert.equal(next.data.procedure, model.data.procedure); assert.equal(next.data.tariffs, model.data.tariffs);
    assert.deepEqual(next.data.services, model.data.services); assert.deepEqual(next.data.faq, model.data.faq);
    assert.equal(next.data.documents.warning.source, model.data.documents.warning.source);
    assert.ok(!Object.hasOwn(next.data.documents.warning, 'html')); assert.ok(!Object.hasOwn(next.data, 'evil'));
    for (const page of next.catalog.pages) assert.ok(!(await f.html(page.file)).includes('malicious-'), page.file);
  } finally { await f.close(); }
});
