import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, copyFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createAdminApi, writeAdminAccount} from './admin-api.mjs';
import {createContentStore} from './admin-content.mjs';

test('HTTP admin API and content store integrate through preview adapter and publish/restore', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'zabota-integration-test-'));
  const distRoot = path.join(projectRoot, 'dist'); const stateDir = path.join(projectRoot, '.admin');
  const stateFile = path.join(projectRoot, 'cms-content.json'); const backupDir = path.join(stateDir, 'backups');
  const password = 'integration-test-private-password';
  let server;
  try {
    await copyFile(fileURLToPath(new URL('../content.json', import.meta.url)), path.join(projectRoot, 'content.json'));
    await mkdir(distRoot);
    const store = createContentStore({projectRoot, distRoot, stateFile, backupDir});
    await store.build(); await writeAdminAccount(stateDir, 'admin', password);
    const previousState = process.env.ADMIN_STATE_DIR; const previousOrigin = process.env.ADMIN_PUBLIC_ORIGIN;
    process.env.ADMIN_STATE_DIR = stateDir; delete process.env.ADMIN_PUBLIC_ORIGIN;
    let api;
    try {
      api = createAdminApi({projectRoot, distRoot,
        getContent: store.getContent, saveContent: store.saveContent, listVersions: store.listVersions, restore: store.restore,
        // This adapter is required: HTTP API has positional arguments; store uses an object.
        preview: (page, content) => store.preview({page, content})
      });
    } finally {
      if (previousState === undefined) delete process.env.ADMIN_STATE_DIR; else process.env.ADMIN_STATE_DIR = previousState;
      if (previousOrigin === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN; else process.env.ADMIN_PUBLIC_ORIGIN = previousOrigin;
    }
    const initial = await store.getContent(); const allowedPages = new Set(initial.catalog.pages.map(page => '/' + page.file));
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (await api(req, res, url)) return;
      if (!allowedPages.has(url.pathname)) { res.writeHead(404); res.end(); return; }
      try { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(await readFile(path.join(distRoot, url.pathname.slice(1)))); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie; let csrf;
    async function request(endpoint, {method = 'GET', body, authenticated = true, token = csrf} = {}) {
      const headers = {};
      if (authenticated && cookie) headers.Cookie = cookie;
      if (method !== 'GET') {
        headers.Origin = base; headers['Content-Type'] = 'application/json';
        if (authenticated && token) headers['X-CSRF-Token'] = token;
      }
      const response = await fetch(base + endpoint, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
      const raw = await response.text(); let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      return {status: response.status, headers: response.headers, data};
    }
    assert.equal((await request('/api/admin/content', {authenticated: false})).status, 401);
    const login = await request('/api/admin/login', {method: 'POST', authenticated: false, body: {username: 'admin', password}});
    assert.equal(login.status, 200); assert.equal(login.data.authenticated, true);
    cookie = login.headers.get('set-cookie').split(';')[0]; csrf = login.data.csrf;
    const session = await request('/api/admin/session'); assert.equal(session.data.csrf, csrf); assert.equal(session.data.authenticated, true);
    const model = (await request('/api/admin/content')).data;
    assert.equal(model.revision, 'initial'); assert.equal(model.catalog.pages.length, 11); assert.equal(model.catalog.tables.length, 2);
    const heading = model.catalog.items.find(item => item.page === 'index.html' && item.kind === 'text' && item.tag === 'h1');
    const draft = {revision: model.revision, data: model.data, overrides: {[heading.id]: {text: 'Правка из админки <script>alert(1)</script>'}}};
    const before = await readFile(path.join(distRoot, 'index.html'), 'utf8');
    const preview = await request('/api/admin/preview', {method: 'POST', body: {page: 'index.html', content: draft}});
    assert.equal(preview.status, 200, typeof preview.data === 'object' ? JSON.stringify(preview.data) : 'Preview should return HTML');
    assert.match(preview.headers.get('content-type'), /text\/html/); assert.ok(preview.data.includes('<base href="/">'));
    assert.ok(preview.data.includes('Правка из админки &lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(!/<script\b/.test(preview.data));
    assert.equal(await readFile(path.join(distRoot, 'index.html'), 'utf8'), before, 'Preview must not publish');
    await assert.rejects(readFile(stateFile), error => error.code === 'ENOENT');
    assert.deepEqual((await request('/api/admin/versions')).data.versions, []);
    assert.equal((await request('/api/admin/preview', {method: 'POST', body: {page: 'missing.html', content: draft}})).status, 400);
    assert.equal((await request('/api/admin/content', {method: 'PUT', token: 'wrong-token', body: draft})).status, 403);
    assert.equal((await request('/api/admin/content')).data.revision, 'initial');
    const saved = await request('/api/admin/content', {method: 'PUT', body: draft});
    assert.equal(saved.status, 200); assert.equal(saved.data.saved, true); assert.notEqual(saved.data.revision, 'initial');
    const current = (await request('/api/admin/content')).data;
    assert.equal(current.revision, saved.data.revision); assert.equal(current.catalog.items.find(item => item.id === heading.id).value, draft.overrides[heading.id].text);
    const publicHome = await request('/index.html', {authenticated: false});
    assert.equal(publicHome.status, 200); assert.ok(publicHome.data.includes('Правка из админки &lt;script&gt;alert(1)&lt;/script&gt;'));
    for (const page of current.catalog.pages) {
      const response = await request('/' + page.file, {authenticated: false});
      assert.equal(response.status, 200, page.file); assert.ok(response.data.startsWith('<!doctype html>'), page.file);
    }
    assert.equal((await request('/api/admin/content', {method: 'PUT', body: draft})).status, 409);
    const history = await request('/api/admin/versions'); assert.equal(history.status, 200); assert.equal(history.data.versions.length, 1);
    assert.equal(history.data.versions[0].revision, 'initial'); assert.ok(Number.isFinite(Date.parse(history.data.versions[0].createdAt)));
    const restored = await request('/api/admin/restore', {method: 'POST', body: {id: history.data.versions[0].id}});
    assert.equal(restored.status, 200); assert.equal(restored.data.saved, true); assert.notEqual(restored.data.revision, saved.data.revision);
    const afterRestore = (await request('/api/admin/content')).data;
    assert.equal(afterRestore.catalog.items.find(item => item.id === heading.id).value, heading.defaultValue);
    assert.ok(!(await request('/index.html', {authenticated: false})).data.includes('Правка из админки'));
    assert.equal((await request('/api/admin/versions')).data.versions.length, 2);
    assert.equal((await createContentStore({projectRoot, distRoot, stateFile, backupDir}).getContent()).revision, restored.data.revision);
    assert.equal((await request('/api/admin/logout', {method: 'POST'})).status, 200);
    assert.equal((await request('/api/admin/content')).status, 401);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const target = path.resolve(projectRoot);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('zabota-integration-test-')) throw new Error('Unsafe test cleanup path');
    await rm(target, {recursive: true, force: true});
  }
});
