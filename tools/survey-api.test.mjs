import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, readFile, readdir, copyFile, rm} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createSurveyStore, createSurveyApi, surveyDefinition} from './survey-api.mjs';
import {createAdminApi} from './admin-api.mjs';
import {renderSitePage} from './site-render.mjs';

const DAY = 86400000;
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(await readFile(new URL('../content.json', import.meta.url), 'utf8'));
const prefix = 'zabota-survey-test-';
const password = 'survey-test-password-2026';

function request(base, endpoint, {method = 'GET', body, headers = {}, cookie} = {}) {
  const actualHeaders = {...headers};
  if (cookie) actualHeaders.Cookie = cookie;
  if (body !== undefined && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    actualHeaders['Content-Type'] ||= 'application/json';
  }
  if (body !== undefined) actualHeaders['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = http.request(base + endpoint, {method, headers: actualHeaders}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({status: response.statusCode, headers: response.headers, data, raw});
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function removeFixture(projectRoot) {
  const target = path.resolve(projectRoot);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) throw Error('Unsafe test cleanup path');
  await rm(target, {recursive: true, force: true});
}

async function fixture({publicOrigin} = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(projectRoot, '.admin', 'surveys');
  const model = {data: structuredClone(baseline), overrides: {}};
  let time = Date.parse('2026-10-03T12:00:00Z');
  const now = () => time;
  const options = {projectRoot, stateDir, getContent: async () => model, now};
  const store = createSurveyStore(options);
  const api = createSurveyApi({store, now, origin: publicOrigin ?? null});
  const previousState = process.env.ADMIN_STATE_DIR;
  const previousOrigin = process.env.ADMIN_PUBLIC_ORIGIN;
  process.env.ADMIN_STATE_DIR = path.join(projectRoot, '.admin');
  delete process.env.ADMIN_PUBLIC_ORIGIN;
  const admin = createAdminApi({projectRoot, distRoot: path.join(projectRoot, 'dist'), getContent: async () => model, getSurveyResponses: store.getResponses});
  if (previousState === undefined) delete process.env.ADMIN_STATE_DIR; else process.env.ADMIN_STATE_DIR = previousState;
  if (previousOrigin === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN; else process.env.ADMIN_PUBLIC_ORIGIN = previousOrigin;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await admin(req, res, url) || await api(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = (cookie, encrypted = false) => ({headers: cookie ? {cookie} : {}, socket: {encrypted, remoteAddress: '127.0.0.1'}});
  const payload = (wishes = 'Текст пожелания только для администратора', variant = 0) => ({consent: true, answers: surveyDefinition(model).map((question, i) => ({question: 'Подставленный вопрос не должен сохраняться', answer: i < 5 ? question.options[variant] : wishes}))});
  return {
    projectRoot, stateDir, model, store, options, browser, payload, base,
    now, advance: duration => { time += duration; },
    request: (endpoint, options) => request(base, endpoint, options),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await removeFixture(projectRoot); }
  };
}

function cookieFrom(result) { return result.headers['set-cookie'][0].split(';')[0]; }
function findChoice(model, value) {
  const item = renderSitePage(model.data, 'survey.html').items.find(item => item.kind === 'text' && item.value === value && item.page === 'survey.html');
  assert.ok(item, `Choice exists in the CMS: ${value}`);
  return item.id;
}

test('Survey definition follows CMS question and option edits, including escaped labels', async () => {
  const f = await fixture();
  try {
    const original = surveyDefinition(f.model);
    assert.equal(original.length, 6);
    assert.deepEqual(original.map(question => question.id), [1, 2, 3, 4, 5, 6]);
    assert.equal(original[5].options.length, 0);
    const first = original[0];
    const question = renderSitePage(f.model.data, 'survey.html').items.find(item => item.kind === 'text' && item.value === first.question);
    assert.ok(question);
    f.model.overrides[question.id] = {text: 'Оценка информации & доступности?'};
    f.model.overrides[findChoice(f.model, first.options[0])] = {text: 'Да, "отлично" & удобно <всегда>'};
    const changed = surveyDefinition(f.model);
    assert.equal(changed[0].question, 'Оценка информации & доступности?');
    assert.equal(changed[0].options[0], 'Да, "отлично" & удобно <всегда>');
    await f.store.save(f.payload(), f.browser());
    const saved = (await f.store.getResponses()).records[0];
    assert.equal(saved.answers[0].question, changed[0].question);
    assert.equal(saved.answers[0].answer, changed[0].options[0]);
    const stale = f.payload(); stale.answers[0].answer = first.options[0];
    await assert.rejects(f.store.save(stale, f.browser()), error => error.status === 400);
  } finally { await f.close(); }
});

test('Saved answers persist; public aggregates exclude wishes and individual records; admin access is protected', async () => {
  const f = await fixture();
  try {
    let result = await f.request('/api/survey', {method: 'POST', body: f.payload('Личное пожелание: Иван, телефон 12345'), headers: {Origin: f.base}});
    assert.equal(result.status, 201);
    assert.deepEqual(result.data, {saved: true});
    assert.match(result.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Max-Age=86400/);
    const cookie = cookieFrom(result);
    f.advance(1);
    assert.equal((await f.request('/api/survey', {method: 'POST', body: f.payload('Второе пожелание', 1)})).status, 201);
    result = await f.request('/api/survey/results', {cookie});
    assert.equal(result.status, 200);
    assert.equal(result.data.total, 2);
    assert.equal(result.data.alreadyAnswered, true);
    assert.equal(result.data.questions.length, 5);
    assert.equal(result.data.questions[0].answers[0].count, 1);
    assert.equal(result.data.questions[0].answers[0].percent, 50);
    assert.equal(result.data.questions[0].answers[1].count, 1);
    assert.ok(!result.raw.includes('Иван') && !result.raw.includes('пожелание') && !result.raw.includes('12345'));
    assert.ok(!Object.hasOwn(result.data, 'records'));
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal((await f.request('/api/admin/surveys')).status, 401);
    assert.equal((await f.request('/api/admin/surveys', {cookie})).status, 401, 'A survey cookie is not an admin session');
    const setup = await f.request('/api/admin/setup', {method: 'POST', body: {username: 'admin', password}});
    assert.equal(setup.status, 201);
    const admin = await f.request('/api/admin/surveys', {cookie: cookieFrom(setup)});
    assert.equal(admin.status, 200);
    assert.equal(admin.data.totalRecords, 2);
    assert.equal(admin.data.records[0].answers[5].answer, 'Второе пожелание');
    assert.equal(admin.data.records[1].answers[5].answer, 'Личное пожелание: Иван, телефон 12345');
    assert.equal(admin.data.records[1].consent, true);
    assert.equal(admin.data.records[1].consentVersion, '2026-10-03');
    assert.notEqual(admin.data.records[0].id, admin.data.records[1].id);
    assert.ok(!admin.data.records[0].answers.some(answer => answer.question.includes('Подставленный')));
    const reopened = createSurveyStore(f.options);
    assert.equal((await reopened.results(f.browser(cookie))).total, 2);
    assert.equal((await reopened.results(f.browser(cookie))).alreadyAnswered, true);
  } finally { await f.close(); }
});

test('HMAC repeat cookie blocks for 24 hours, rejects tampering, and expires independently of records', async () => {
  const f = await fixture();
  try {
    const saved = await f.store.save(f.payload(), f.browser(undefined, true));
    assert.match(saved.cookie, /; Secure$/);
    const cookie = saved.cookie.split(';')[0];
    await assert.rejects(f.store.save(f.payload(), f.browser(cookie)), error => error.status === 409);
    assert.equal((await f.store.results(f.browser(cookie))).alreadyAnswered, true);
    const last = cookie.at(-1) === '0' ? '1' : '0';
    const altered = cookie.slice(0, -1) + last;
    assert.equal((await f.store.results(f.browser(altered))).alreadyAnswered, false);
    assert.equal((await f.store.results(f.browser('zabota_survey=invalid'))).alreadyAnswered, false);
    const key = await readFile(path.join(f.stateDir, 'cookie-key'));
    const futurePayload = 'f'.repeat(32) + '-' + (f.now() + DAY);
    const futureCookie = `zabota_survey=${futurePayload}.${createHmac('sha256', key).update(futurePayload).digest('hex')}`;
    assert.equal((await f.store.results(f.browser(futureCookie))).alreadyAnswered, false);
    f.advance(DAY - 1);
    await assert.rejects(f.store.save(f.payload(), f.browser(cookie)), error => error.status === 409);
    f.advance(1);
    assert.equal((await f.store.results(f.browser(cookie))).alreadyAnswered, false);
    await f.store.save(f.payload(), f.browser(cookie));
    assert.equal((await f.store.results(f.browser())).total, 2);
  } finally { await f.close(); }
});

test('Raw answers expire at 90 days while aggregate counts remain, with deterministic pagination and concurrent writes', async () => {
  const f = await fixture();
  try {
    await f.store.save(f.payload('Старое личное пожелание'), f.browser());
    f.advance(89 * DAY);
    await Promise.all(Array.from({length: 26}, (_, i) => f.store.save(f.payload('Новое пожелание ' + i), f.browser())));
    let admin = await f.store.getResponses();
    assert.equal(admin.total, 27); assert.equal(admin.totalRecords, 27); assert.equal(admin.records.length, 25);
    const secondPage = await f.store.getResponses({page: 2});
    assert.equal(secondPage.records.length, 2);
    assert.equal(secondPage.records[1].answers[5].answer, 'Старое личное пожелание');
    assert.equal((await f.store.getResponses({page: 'invalid'})).page, 1);
    f.advance(DAY);
    await f.store.purgeExpired();
    admin = await f.store.getResponses();
    assert.equal(admin.totalRecords, 26); assert.equal(admin.total, 27);
    assert.ok(!JSON.stringify(admin).includes('Старое личное пожелание'));
    f.advance(89 * DAY);
    await f.store.purgeExpired();
    const stored = JSON.parse(await readFile(path.join(f.stateDir, 'responses.json'), 'utf8'));
    assert.equal(stored.records.length, 0);
    const results = await f.store.results(f.browser());
    assert.equal(results.total, 27);
    assert.equal(results.questions[0].answers[0].count, 27);
    assert.equal(results.questions[0].answers[0].percent, 100);
  } finally { await f.close(); }
});

test('Editable labels matching Object property names are counted as plain data', async () => {
  const f = await fixture();
  try {
    const definition = surveyDefinition(f.model);
    f.model.overrides[findChoice(f.model, definition[0].options[0])] = {text: 'constructor'};
    f.model.overrides[findChoice(f.model, definition[0].options[1])] = {text: '__proto__'};
    let results = await f.store.results(f.browser());
    assert.deepEqual(results.questions[0].answers.slice(0, 2), [{label: 'constructor', count: 0, percent: 0}, {label: '__proto__', count: 0, percent: 0}]);
    await f.store.save(f.payload('', 0), f.browser());
    await f.store.save(f.payload('', 1), f.browser());
    results = await createSurveyStore(f.options).results(f.browser());
    assert.deepEqual(results.questions[0].answers.slice(0, 2), [{label: 'constructor', count: 1, percent: 50}, {label: '__proto__', count: 1, percent: 50}]);
  } finally { await f.close(); }
});

test('HTTP validation rejects invalid consent, choices, body format, origins and methods without storing a vote', async () => {
  const f = await fixture();
  try {
    const invalids = [null, {}, {...f.payload(), consent: false}, {...f.payload(), consent: 'true'}, {...f.payload(), website: 'bot'}, {...f.payload(), answers: []}];
    const wrongChoice = f.payload(); wrongChoice.answers[0].answer = 'Несуществующий ответ'; invalids.push(wrongChoice);
    const wrongType = f.payload(); wrongType.answers[5].answer = {}; invalids.push(wrongType);
    const oversized = f.payload(); oversized.answers[5].answer = 'а'.repeat(3001); invalids.push(oversized);
    const control = f.payload(); control.answers[5].answer = 'строка\u0000'; invalids.push(control);
    for (const body of invalids) assert.equal((await f.request('/api/survey', {method: 'POST', body})).status, 400);
    assert.equal((await f.request('/api/survey', {method: 'POST', body: Buffer.from('{broken'), headers: {'Content-Type': 'application/json'}})).status, 400);
    assert.equal((await f.request('/api/survey', {method: 'POST', body: Buffer.from('{}'), headers: {'Content-Type': 'text/plain'}})).status, 415);
    assert.equal((await f.request('/api/survey', {method: 'POST', body: Buffer.from('x'.repeat(20001)), headers: {'Content-Type': 'application/json'}})).status, 413);
    assert.equal((await f.request('/api/survey', {method: 'POST', body: f.payload(), headers: {Origin: 'https://attacker.example'}})).status, 403);
    assert.equal((await f.request('/api/survey/results', {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
    assert.equal((await f.request('/api/survey')).status, 405);
    assert.equal((await f.request('/api/survey/results', {method: 'POST', body: {}})).status, 405);
    assert.equal((await f.request('/api/not-survey')).status, 404);
    assert.equal((await f.store.results(f.browser())).total, 0);
  } finally { await f.close(); }
});

test('Submission attempts are bounded and recover after the rate window; configured public origin is enforced', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 15; i++) assert.equal((await f.request('/api/survey', {method: 'POST', body: {}})).status, 400);
    assert.equal((await f.request('/api/survey', {method: 'POST', body: f.payload()})).status, 429);
    f.advance(3600001);
    assert.equal((await f.request('/api/survey', {method: 'POST', body: f.payload()})).status, 201);
  } finally { await f.close(); }
  const configured = await fixture({publicOrigin: 'https://zabota.example'});
  try {
    assert.equal((await configured.request('/api/survey/results')).status, 403);
    assert.equal((await configured.request('/api/survey/results', {headers: {Host: 'zabota.example', Origin: 'https://zabota.example'}})).status, 200);
    assert.equal((await configured.request('/api/survey/results', {headers: {Host: 'zabota.example', Origin: 'http://zabota.example'}})).status, 403);
  } finally { await configured.close(); }
});

test('Production server serves public pages and aggregates but never private survey files', {timeout: 20000}, async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  let child;
  try {
    const toolsDir = path.join(projectRoot, 'tools'); await mkdir(toolsDir);
    const files = (await readdir(path.join(sourceRoot, 'tools'))).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'));
    await Promise.all(files.map(name => copyFile(path.join(sourceRoot, 'tools', name), path.join(toolsDir, name))));
    await copyFile(path.join(sourceRoot, 'content.json'), path.join(projectRoot, 'content.json'));
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const env = {...process.env, HOST: '127.0.0.1', PORT: String(port)};
    for (const key of ['ADMIN_STATE_DIR', 'ADMIN_PUBLIC_ORIGIN', 'CMS_STATE_FILE', 'CMS_BACKUP_DIR', 'SURVEY_STATE_DIR', 'SMTP_USER', 'SMTP_PASSWORD']) delete env[key];
    child = spawn(process.execPath, [path.join(toolsDir, 'server.mjs')], {env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Server failed to start: ' + output)), 12000);
      const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes(`http://127.0.0.1:${port}`)) done(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      child.once('error', done);
      child.once('exit', code => done(Error(`Server exited ${code}: ${output}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const payload = {consent: true, answers: surveyDefinition({data: baseline, overrides: {}}).map((question, i) => ({answer: i < 5 ? question.options[0] : 'Приватный комментарий production-test'}))};
    assert.equal((await request(base, '/survey.html')).status, 200);
    assert.equal((await request(base, '/api/survey', {method: 'POST', body: payload})).status, 201);
    const state = await readFile(path.join(projectRoot, '.admin', 'surveys', 'responses.json'), 'utf8');
    assert.match(state, /Приватный комментарий production-test/);
    for (const endpoint of ['/.admin/surveys/responses.json', '/.admin/surveys/cookie-key', '/cms-content.json', '/content.json', '/tools/survey-api.mjs', '/..%2f.admin/surveys/responses.json', '/%2e%2e%5c.admin%5csurveys%5cresponses.json']) {
      const result = await request(base, endpoint);
      assert.ok([403, 404].includes(result.status), `${endpoint} must remain private`);
      assert.ok(!result.raw.includes('Приватный комментарий'));
    }
    assert.equal((await request(base, '/api/admin/surveys')).status, 401);
    const result = await request(base, '/api/survey/results');
    assert.equal(result.status, 200); assert.equal(result.data.total, 1);
    assert.ok(!result.raw.includes('Приватный комментарий'));
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await removeFixture(projectRoot);
  }
});
