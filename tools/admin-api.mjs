import {randomBytes, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';

const scrypt = promisify(scryptCallback);
const COOKIE = 'zabota_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;
const RATE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_SESSIONS = 256;
const MAX_RATE_KEYS = 2048;
const JSON_HEADERS = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};

export class AdminError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function resolveAdminStateDir(projectRoot) {
  return path.resolve(process.env.ADMIN_STATE_DIR || path.join(projectRoot, '.admin'));
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{3,64}$/u.test(username.trim())) {
    throw new AdminError(400, 'Логин: от 3 до 64 букв, цифр, точек, дефисов или подчёркиваний.');
  }
  if (typeof password !== 'string' || [...password].length < 12 || [...password].length > 256) {
    throw new AdminError(400, 'Пароль должен содержать от 12 до 256 символов.');
  }
  return {username: username.trim().normalize('NFC'), password};
}

export async function readAdminAccount(stateDir) {
  let data;
  try { data = JSON.parse(await readFile(path.join(stateDir, 'users.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const user = data.user;
  if (data.version !== 1 || typeof user?.username !== 'string' || !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{64}$/.test(user.key)) {
    throw new Error('Invalid admin account state');
  }
  return user;
}

export async function writeAdminAccount(stateDir, username, password, {replace = false} = {}) {
  const valid = validateCredentials(username, password);
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(valid.password, Buffer.from(salt, 'hex'), 32)).toString('hex');
  const user = {username: valid.username, salt, key, updatedAt: new Date().toISOString()};
  await mkdir(stateDir, {recursive: true, mode: 0o700});
  const filename = path.join(stateDir, 'users.json');
  const serialized = JSON.stringify({version: 1, user}, null, 2) + '\n';
  if (!replace) {
    try { await writeFile(filename, serialized, {flag: 'wx', mode: 0o600}); }
    catch (error) { if (error.code === 'EEXIST') throw new AdminError(409, 'Администратор уже создан.'); throw error; }
  } else {
    const temp = path.join(stateDir, `users-${randomBytes(12).toString('hex')}.tmp`);
    try { await writeFile(temp, serialized, {flag: 'wx', mode: 0o600}); await rename(temp, filename); }
    finally { await rm(temp, {force: true}); }
  }
  return user;
}

function equalToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackAddress(address) {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function requestHost(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || /[\s/\\@#?]/.test(host)) throw new AdminError(400, 'Некорректный адрес сервера.');
  try { return new URL(`http://${host}`); }
  catch { throw new AdminError(400, 'Некорректный адрес сервера.'); }
}

function localSetupAllowed(req) {
  const host = requestHost(req).hostname;
  return isLoopbackAddress(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function configuredOrigin() {
  if (!process.env.ADMIN_PUBLIC_ORIGIN) return null;
  const value = new URL(process.env.ADMIN_PUBLIC_ORIGIN);
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) {
    throw new Error('ADMIN_PUBLIC_ORIGIN must be an HTTP(S) origin without a path');
  }
  return value;
}

function checkOrigin(req, origin) {
  const host = requestHost(req);
  if (origin && host.host.toLowerCase() !== origin.host.toLowerCase()) throw new AdminError(403, 'Адрес запроса не совпадает с адресом сайта.');
  const expected = origin?.origin || `${req.socket.encrypted ? 'https' : 'http'}://${host.host}`;
  if (req.headers.origin && req.headers.origin !== expected) throw new AdminError(403, 'Запрос с другого сайта запрещён.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new AdminError(403, 'Запрос с другого сайта запрещён.');
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new AdminError(413, 'Файл или данные слишком большие.');
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new AdminError(413, 'Файл или данные слишком большие.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function readJSON(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new AdminError(415, 'Ожидались данные JSON.');
  try {
    const value = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError(400, 'Некорректные данные JSON.');
  }
}

function validDocx(bytes) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return false;
  const count = bytes.readUInt16LE(end + 10); const size = bytes.readUInt32LE(end + 12); let pos = bytes.readUInt32LE(end + 16);
  if (!count || count > 2048 || pos + size > end) return false;
  const directoryEnd = pos + size; let document = false; let types = false; let expanded = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > directoryEnd || bytes.readUInt32LE(pos) !== 0x02014b50) return false;
    const flags = bytes.readUInt16LE(pos + 8); const method = bytes.readUInt16LE(pos + 10);
    const packedSize = bytes.readUInt32LE(pos + 20); const unpackedSize = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28); const extraLength = bytes.readUInt16LE(pos + 30); const commentLength = bytes.readUInt16LE(pos + 32);
    const local = bytes.readUInt32LE(pos + 42); const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || (flags & 1) || ![0, 8].includes(method)) return false;
    const name = bytes.toString('utf8', pos + 46, pos + 46 + nameLength);
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) return false;
    expanded += unpackedSize; if (expanded > 100 * 1024 * 1024) return false;
    if (name === 'word/document.xml') document = true;
    if (name === '[Content_Types].xml') {
      if (unpackedSize > 1024 * 1024 || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) return false;
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + packedSize > bytes.length) return false;
      const packed = bytes.subarray(start, start + packedSize);
      let xml; try { xml = (method === 0 ? packed : inflateRawSync(packed, {maxOutputLength: 1024 * 1024})).toString('utf8'); } catch { return false; }
      types = xml.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml');
    }
    pos = next;
  }
  return pos === directoryEnd && document && types;
}

const UPLOAD_TYPES = {
  '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'], '.gif': ['image/gif'],
  '.pdf': ['application/pdf'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.rtf': ['application/rtf', 'text/rtf'], '.txt': ['text/plain']
};

export function validateUpload(filename, contentType, bytes) {
  if (typeof filename !== 'string' || !filename || filename.length > 240 || /[\x00-\x1f\x7f/\\]/.test(filename) || filename === '.' || filename === '..') {
    throw new AdminError(400, 'Некорректное имя файла.');
  }
  const ext = path.extname(filename).toLowerCase();
  if (!UPLOAD_TYPES[ext]?.includes(contentType.split(';')[0].trim().toLowerCase())) throw new AdminError(415, 'Разрешены изображения PNG, JPG, WebP, GIF и документы PDF, DOCX, RTF, TXT.');
  if (!bytes.length || bytes.length > MAX_UPLOAD) throw new AdminError(bytes.length ? 413 : 400, bytes.length ? 'Максимальный размер файла — 25 МБ.' : 'Файл пустой.');
  let valid = false;
  if (ext === '.png') valid = bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR';
  if (ext === '.jpg' || ext === '.jpeg') valid = bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (ext === '.webp') valid = bytes.length > 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (ext === '.gif') valid = bytes.length > 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (ext === '.pdf') valid = bytes.length > 8 && bytes.toString('ascii', 0, 5) === '%PDF-';
  if (ext === '.docx') { try { valid = bytes.length > 22 && validDocx(bytes); } catch { valid = false; } }
  if (ext === '.rtf') valid = bytes.toString('ascii', 0, 5) === '{\\rtf';
  if (ext === '.txt') { try { new TextDecoder('utf-8', {fatal: true}).decode(bytes); valid = !bytes.includes(0); } catch { valid = false; } }
  if (!valid) throw new AdminError(415, 'Содержимое файла не соответствует выбранному формату.');
  return {extension: ext === '.jpeg' ? '.jpg' : ext, filename: filename.normalize('NFC')};
}

/** Session and file API. Public pages remain the responsibility of server.mjs. */
export function createAdminApi({projectRoot, distRoot, getContent, saveContent, preview, restore, listVersions, getSurveyResponses}) {
  const stateDir = resolveAdminStateDir(projectRoot);
  const origin = configuredOrigin();
  const secureCookie = origin?.protocol === 'https:';
  const sessions = new Map(); const attempts = new Map(); let setupInProgress = false;
  const routes = new Map([
    ['/api/admin/session', ['GET']], ['/api/admin/setup', ['POST']], ['/api/admin/login', ['POST']], ['/api/admin/logout', ['POST']],
    ['/api/admin/content', ['GET', 'PUT']], ['/api/admin/preview', ['POST']], ['/api/admin/upload', ['POST']],
    ['/api/admin/versions', ['GET']], ['/api/admin/restore', ['POST']], ['/api/admin/surveys', ['GET']]
  ]);

  function prune() {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
    for (const [key, item] of attempts) if (item.expires <= now) attempts.delete(key);
  }

  function sessionFor(req, account) {
    const cookies = String(req.headers.cookie || '').split(';').map(item => item.trim());
    const token = cookies.find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = /^[a-f0-9]{64}$/.test(token || '') ? sessions.get(token) : null;
    if (!session || session.expires <= Date.now() || session.key !== account?.key || session.username !== account?.username) { if (token) sessions.delete(token); return null; }
    return {...session, token};
  }

  function issueSession(res, account) {
    const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    sessions.set(token, {username: account.username, key: account.key, csrf, expires: Date.now() + SESSION_MS});
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secureCookie ? '; Secure' : ''}`);
    return {authenticated: true, username: account.username, csrf};
  }

  function requireSession(req, account, mutation = false) {
    const session = sessionFor(req, account);
    if (!session) throw new AdminError(401, 'Войдите в админку.');
    if (mutation && !equalToken(req.headers['x-csrf-token'], session.csrf)) throw new AdminError(403, 'Сессия запроса устарела. Обновите страницу.');
    return session;
  }

  function rateLimit(req, increment = true) {
    const key = req.socket.remoteAddress || 'unknown'; const now = Date.now();
    const entry = attempts.get(key) || {count: 0, expires: now + RATE_MS};
    if (entry.count >= MAX_ATTEMPTS) throw new AdminError(429, 'Слишком много попыток входа. Повторите через 10 минут.');
    if (increment) {
      if (!attempts.has(key) && attempts.size >= MAX_RATE_KEYS) attempts.delete(attempts.keys().next().value);
      entry.count++; attempts.set(key, entry);
    }
    return key;
  }

  function sendJSON(res, status, value) { res.writeHead(status, JSON_HEADERS); res.end(JSON.stringify(value)); }

  return async function handle(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/admin/')) return false;
    try {
      prune(); checkOrigin(req, origin);
      if (!routes.has(pathname)) throw new AdminError(404, 'Такого действия нет.');
      const methods = routes.get(pathname);
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); throw new AdminError(405, 'Этот способ запроса не поддерживается.'); }
      const account = await readAdminAccount(stateDir);
      if (pathname === '/api/admin/session') {
        const session = sessionFor(req, account);
        sendJSON(res, 200, {authenticated: Boolean(session), setupRequired: !account, setupAllowed: !account && localSetupAllowed(req), ...(session ? {username: session.username, csrf: session.csrf} : {})});
      } else if (pathname === '/api/admin/setup') {
        if (account) throw new AdminError(409, 'Администратор уже создан.');
        if (!localSetupAllowed(req)) throw new AdminError(403, 'На хостинге создайте администратора командой npm run admin:create.');
        if (setupInProgress) throw new AdminError(409, 'Создание администратора уже выполняется.');
        setupInProgress = true;
        try {
          const payload = await readJSON(req);
          const created = await writeAdminAccount(stateDir, payload.username, payload.password);
          sendJSON(res, 201, issueSession(res, created));
        } finally { setupInProgress = false; }
      } else if (pathname === '/api/admin/login') {
        const rateKey = rateLimit(req); const payload = await readJSON(req);
        if (typeof payload.username !== 'string' || typeof payload.password !== 'string' || payload.password.length > 512) throw new AdminError(401, 'Неверный логин или пароль.');
        const derived = await scrypt(payload.password, Buffer.from(account?.salt || '00000000000000000000000000000000', 'hex'), 32);
        const correctPassword = timingSafeEqual(derived, Buffer.from(account?.key || '0000000000000000000000000000000000000000000000000000000000000000', 'hex'));
        if (!account || payload.username.trim().normalize('NFC') !== account.username || !correctPassword) throw new AdminError(401, 'Неверный логин или пароль.');
        attempts.delete(rateKey); sendJSON(res, 200, issueSession(res, account));
      } else {
        const session = requireSession(req, account, req.method !== 'GET');
        if (pathname === '/api/admin/logout') {
          sessions.delete(session.token);
          res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`);
          sendJSON(res, 200, {authenticated: false});
        } else if (pathname === '/api/admin/content' && req.method === 'GET') {
          sendJSON(res, 200, await getContent());
        } else if (pathname === '/api/admin/content') {
          sendJSON(res, 200, await saveContent(await readJSON(req)) ?? {saved: true});
        } else if (pathname === '/api/admin/surveys') {
          if(!getSurveyResponses)throw new AdminError(501, 'Результаты опроса недоступны.');
          sendJSON(res,200,await getSurveyResponses({page:url.searchParams.get('page')}));
        } else if (pathname === '/api/admin/preview') {
          const payload = await readJSON(req);
          if (typeof payload.page !== 'string' || !payload.content || typeof payload.content !== 'object') throw new AdminError(400, 'Выберите страницу для просмотра.');
          const html = await preview(payload.page, payload.content);
          res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'none'"});
          res.end(html);
        } else if (pathname === '/api/admin/upload') {
          let filename; try { filename = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { throw new AdminError(400, 'Некорректное имя файла.'); }
          const bytes = await readBody(req, MAX_UPLOAD);
          const info = validateUpload(filename, String(req.headers['content-type'] || ''), bytes);
          const savedName = randomBytes(20).toString('hex') + info.extension;
          const uploadDir = path.resolve(distRoot, 'assets/uploads');
          await mkdir(uploadDir, {recursive: true});
          await writeFile(path.join(uploadDir, savedName), bytes, {flag: 'wx', mode: 0o644});
          sendJSON(res, 201, {src: `assets/uploads/${savedName}`, filename: info.filename, size: bytes.length, format: info.extension.slice(1).toUpperCase()});
        } else if (pathname === '/api/admin/versions') {
          if (!listVersions) throw new AdminError(501, 'История изменений недоступна.');
          sendJSON(res, 200, {versions: await listVersions()});
        } else if (pathname === '/api/admin/restore') {
          if (!restore) throw new AdminError(501, 'Восстановление недоступно.');
          const payload = await readJSON(req);
          if (typeof payload.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(payload.id) || payload.id.includes('..')) throw new AdminError(400, 'Некорректная версия.');
          sendJSON(res, 200, await restore(payload.id) ?? {restored: true});
        }
      }
    } catch (error) {
      if (!res.headersSent) {
        const status = error instanceof AdminError ? error.status : (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500);
        if (status === 429) res.setHeader('Retry-After', String(RATE_MS / 1000));
        sendJSON(res, status, {error: status === 500 ? 'Не удалось выполнить действие. Попробуйте ещё раз.' : error.message});
      } else if (!res.writableEnded) res.end();
    }
    return true;
  };
}
