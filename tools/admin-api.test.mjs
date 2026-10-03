import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, readFile, rm, readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createAdminApi, validateUpload, writeAdminAccount} from './admin-api.mjs';

const password = 'test-only-safe-password-2026';
const runFile = promisify(execFile);

async function fixture({publicOrigin} = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'zabota-admin-test-'));
  const stateDir = path.join(projectRoot, '.admin'); const distRoot = path.join(projectRoot, 'dist');
  await mkdir(distRoot);
  let content = {data: {title: 'До'}, revision: 'one'}; const calls = [];
  const previousState = process.env.ADMIN_STATE_DIR; const previousOrigin = process.env.ADMIN_PUBLIC_ORIGIN;
  process.env.ADMIN_STATE_DIR = stateDir;
  if (publicOrigin) process.env.ADMIN_PUBLIC_ORIGIN = publicOrigin; else delete process.env.ADMIN_PUBLIC_ORIGIN;
  const api = createAdminApi({projectRoot, distRoot,
    getContent: async () => content,
    saveContent: async value => { calls.push(['save', value]); content = value; return {saved: true, revision: 'two'}; },
    preview: async (page, value) => { calls.push(['preview', page, value]); return '<!doctype html><title>Preview</title><h1>Просмотр</h1>'; },
    listVersions: async () => [{id: 'version-one', date: '2026-10-03'}],
    restore: async id => { calls.push(['restore', id]); return {restored: true, revision: 'three'}; }
  });
  if (previousState === undefined) delete process.env.ADMIN_STATE_DIR; else process.env.ADMIN_STATE_DIR = previousState;
  if (previousOrigin === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN; else process.env.ADMIN_PUBLIC_ORIGIN = previousOrigin;
  const server = http.createServer(async (req, res) => {
    if (!(await api(req, res, new URL(req.url, 'http://localhost')))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(endpoint, {method = 'GET', body, headers = {}, cookie, csrf} = {}) {
    const actualHeaders = {...headers};
    if (cookie) actualHeaders.Cookie = cookie;
    if (csrf) actualHeaders['X-CSRF-Token'] = csrf;
    if (body !== undefined && !Buffer.isBuffer(body)) { body = JSON.stringify(body); actualHeaders['Content-Type'] ||= 'application/json'; }
    if (body !== undefined) actualHeaders['Content-Length'] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
      const req = http.request(base + endpoint, {method, headers: actualHeaders}, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8'); let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          const resultHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          resolve({status: response.statusCode, headers: resultHeaders, data});
        });
      });
      req.on('error', reject); req.end(body);
    });
  }
  async function close() {
    await new Promise(resolve => server.close(resolve));
    const target = path.resolve(projectRoot);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('zabota-admin-test-')) throw new Error('Unsafe test cleanup path');
    await rm(target, {recursive: true, force: true});
  }
  return {projectRoot, stateDir, distRoot, base, request, close, calls};
}

function auth(result) { return {cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.data.csrf}; }

test('First setup, persistent password hash, protected content and preview, logout', async () => {
  const f = await fixture();
  try {
    let result = await f.request('/api/admin/session');
    assert.deepEqual(result.data, {authenticated: false, setupRequired: true, setupAllowed: true});
    assert.equal((await f.request('/api/admin/content')).status, 401);
    assert.equal((await f.request('/api/admin/setup', {method: 'POST', body: {username: 'admin', password: 'short'}})).status, 400);
    assert.equal((await f.request('/api/admin/setup', {method: 'POST', body: {username: 'admin', password}, headers: {Host: 'attacker.example'}})).status, 403);
    assert.equal((await f.request('/api/admin/setup', {method: 'POST', body: {username: 'admin', password}, headers: {Origin: 'https://attacker.example'}})).status, 403);
    result = await f.request('/api/admin/setup', {method: 'POST', body: {username: 'admin', password}, headers: {Origin: f.base}});
    assert.equal(result.status, 201); assert.equal(result.data.authenticated, true);
    const credentials = auth(result);
    assert.match(result.headers.get('set-cookie'), /HttpOnly/); assert.match(result.headers.get('set-cookie'), /SameSite=Strict/);
    assert.match(result.headers.get('cache-control'), /no-store/);
    const stored = await readFile(path.join(f.stateDir, 'users.json'), 'utf8');
    assert.ok(!stored.includes(password)); assert.match(JSON.parse(stored).user.key, /^[a-f0-9]{64}$/);
    assert.equal((await f.request('/api/admin/setup', {method: 'POST', body: {username: 'admin', password}})).status, 409);
    result = await f.request('/api/admin/session', credentials);
    assert.equal(result.data.authenticated, true); assert.equal(result.data.csrf, credentials.csrf);
    result = await f.request('/api/admin/content', credentials);
    assert.equal(result.data.data.title, 'До');
    assert.equal((await f.request('/api/admin/content', {method: 'PUT', cookie: credentials.cookie, body: {data: {title: 'После'}}})).status, 403);
    assert.equal((await f.request('/api/admin/content', {method: 'PUT', ...credentials, csrf: 'wrong', body: {data: {title: 'После'}}})).status, 403);
    assert.equal((await f.request('/api/admin/content', {method: 'PUT', ...credentials, headers: {Origin: 'https://attacker.example'}, body: {data: {title: 'После'}}})).status, 403);
    assert.equal(f.calls.length, 0);
    result = await f.request('/api/admin/content', {method: 'PUT', ...credentials, headers: {Origin: f.base}, body: {data: {title: 'После'}, revision: 'one'}});
    assert.deepEqual(result.data, {saved: true, revision: 'two'});
    assert.equal((await f.request('/api/admin/content', credentials)).data.data.title, 'После');
    result = await f.request('/api/admin/preview', {method: 'POST', ...credentials, body: {page: 'index.html', content: {data: {title: 'Черновик'}}}});
    assert.equal(result.status, 200); assert.match(result.data, /Просмотр/); assert.match(result.headers.get('content-type'), /text\/html/);
    assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal((await f.request('/api/admin/versions', credentials)).data.versions[0].id, 'version-one');
    assert.equal((await f.request('/api/admin/restore', {method: 'POST', ...credentials, body: {id: '../users.json'}})).status, 400);
    assert.equal((await f.request('/api/admin/restore', {method: 'POST', ...credentials, body: {id: 'version-one'}})).data.restored, true);
    assert.equal((await f.request('/api/admin/logout', {method: 'POST', ...credentials})).status, 200);
    assert.equal((await f.request('/api/admin/content', credentials)).status, 401);
    assert.equal((await f.request('/api/admin/login', {method: 'POST', body: {username: 'admin', password: 'incorrect-password'}})).status, 401);
    result = await f.request('/api/admin/login', {method: 'POST', body: {username: 'admin', password}});
    assert.equal(result.status, 200);
    const fresh = auth(result);
    assert.notEqual(fresh.cookie, credentials.cookie);
    await writeAdminAccount(f.stateDir, 'admin', 'another-test-password-2026', {replace: true});
    assert.equal((await f.request('/api/admin/content', fresh)).status, 401, 'Password replacement revokes existing sessions');
    assert.equal((await f.request('/api/admin/session', {method: 'POST'})).status, 405);
    assert.equal((await f.request('/api/admin/missing')).status, 404);
  } finally { await f.close(); }
});

test('Uploads remain inside upload directory and reject active/forged formats', async () => {
  const f = await fixture();
  try {
    const login = await f.request('/api/admin/setup', {method: 'POST', body: {username: 'admin', password}});
    const credentials = auth(login);
    const pdf = Buffer.from('%PDF-1.4\n% Test document\n%%EOF');
    let result = await f.request('/api/admin/upload', {method: 'POST', ...credentials, body: pdf, headers: {'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('Новый документ.pdf')}});
    assert.equal(result.status, 201); assert.equal(result.data.filename, 'Новый документ.pdf');
    assert.match(result.data.src, /^assets\/uploads\/[a-f0-9]{40}\.pdf$/);
    assert.deepEqual(await readFile(path.join(f.distRoot, result.data.src)), pdf);
    assert.equal((await f.request('/api/admin/upload', {method: 'POST', cookie: credentials.cookie, body: pdf, headers: {'Content-Type': 'application/pdf', 'X-File-Name': 'test.pdf'}})).status, 403);
    for (const [filename, type, bytes, expected] of [
      ['../test.pdf', 'application/pdf', pdf, 400], ['a\\test.pdf', 'application/pdf', pdf, 400],
      ['test.svg', 'image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'), 415],
      ['test.pdf', 'application/pdf', Buffer.from('<script>alert(1)</script>'), 415],
      ['test.png', 'image/png', pdf, 415], ['test.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('PK\x03\x04not a Word document'), 415],
      ['test.txt', 'text/plain', Buffer.from([0, 1, 2]), 415], ['test.exe', 'application/octet-stream', Buffer.from('MZabc'), 415]
    ]) {
      result = await f.request('/api/admin/upload', {method: 'POST', ...credentials, body: bytes, headers: {'Content-Type': type, 'X-File-Name': encodeURIComponent(filename)}});
      assert.equal(result.status, expected, filename);
    }
    const realDocx = await readFile(fileURLToPath(new URL('../dist/assets/documents/sample-contract.docx', import.meta.url)));
    result = await f.request('/api/admin/upload', {method: 'POST', ...credentials, body: realDocx, headers: {'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'X-File-Name': encodeURIComponent('Договор.docx')}});
    assert.equal(result.status, 201); assert.equal(result.data.format, 'DOCX');
    assert.equal((await readdir(path.join(f.distRoot, 'assets/uploads'))).length, 2);
    result = await f.request('/api/admin/upload', {method: 'POST', ...credentials, body: Buffer.alloc(25 * 1024 * 1024 + 1), headers: {'Content-Type': 'application/pdf', 'X-File-Name': 'large.pdf'}});
    assert.equal(result.status, 413);
  } finally { await f.close(); }
});

test('Login throttles repeated failures without returning account details', async () => {
  const f = await fixture();
  try {
    await writeAdminAccount(f.stateDir, 'admin', password);
    for (let i = 0; i < 8; i++) {
      const result = await f.request('/api/admin/login', {method: 'POST', body: {username: i % 2 ? 'missing-user' : 'admin', password: 'wrong-password'}});
      assert.equal(result.status, 401); assert.equal(result.data.error, 'Неверный логин или пароль.');
    }
    const blocked = await f.request('/api/admin/login', {method: 'POST', body: {username: 'admin', password}});
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '600');
  } finally { await f.close(); }
});

test('Production origin is explicit, remote setup is blocked, HTTPS cookies are Secure', async () => {
  const f = await fixture({publicOrigin: 'https://care.example'});
  const headers = {Host: 'care.example', Origin: 'https://care.example'};
  try {
    assert.equal((await f.request('/api/admin/session')).status, 403);
    const state = await f.request('/api/admin/session', {headers});
    assert.equal(state.data.setupAllowed, false);
    assert.equal((await f.request('/api/admin/setup', {method: 'POST', headers, body: {username: 'admin', password}})).status, 403);
    await writeAdminAccount(f.stateDir, 'admin', password);
    const result = await f.request('/api/admin/login', {method: 'POST', headers, body: {username: 'admin', password}});
    assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /; Secure/);
    assert.equal((await f.request('/api/admin/login', {method: 'POST', headers: {...headers, Origin: 'http://care.example'}, body: {username: 'admin', password}})).status, 403);
  } finally { await f.close(); }
});

test('Image signatures and UTF-8 text validation', () => {
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR', 12);
  assert.equal(validateUpload('photo.png', 'image/png', png).extension, '.png');
  assert.equal(validateUpload('photo.jpeg', 'image/jpeg', Buffer.from([255,216,255,224,0,16])).extension, '.jpg');
  const webp = Buffer.alloc(20); webp.write('RIFF'); webp.writeUInt32LE(12, 4); webp.write('WEBP', 8);
  assert.equal(validateUpload('photo.webp', 'image/webp', webp).extension, '.webp');
  assert.equal(validateUpload('text.txt', 'text/plain; charset=utf-8', Buffer.from('Текст документа')).extension, '.txt');
  assert.throws(() => validateUpload('bad.txt', 'text/plain', Buffer.from([255,254,255])), /не соответствует/);
});

test('Hosting CLI creates and replaces account without printing passwords', async () => {
  const f = await fixture();
  const cli = fileURLToPath(new URL('./admin-user.mjs', import.meta.url));
  try {
    const env = {...process.env, ADMIN_STATE_DIR: f.stateDir, ADMIN_PASSWORD: password};
    let result = await runFile(process.execPath, [cli, '--username', 'admin'], {env});
    assert.match(result.stdout, /Администратор создан/); assert.ok(!result.stdout.includes(password));
    await assert.rejects(runFile(process.execPath, [cli, '--username', 'admin'], {env}), /уже существует/);
    const login = await f.request('/api/admin/login', {method: 'POST', body: {username: 'admin', password}});
    assert.equal(login.status, 200);
    result = await runFile(process.execPath, [cli, '--username', 'admin', '--replace'], {env: {...env, ADMIN_PASSWORD: 'new-test-hosting-password'}});
    assert.match(result.stdout, /Пароль администратора изменён/);
    assert.equal((await f.request('/api/admin/content', auth(login))).status, 401);
    assert.equal((await f.request('/api/admin/login', {method: 'POST', body: {username: 'admin', password: 'new-test-hosting-password'}})).status, 200);
  } finally { await f.close(); }
});
