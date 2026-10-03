import net from 'node:net';
import tls from 'node:tls';
import {randomUUID} from 'node:crypto';

const MAX_BODY = 24 * 1024;
const MAX_SENDS = 5;
const RATE_MS = 10 * 60 * 1000;
const MAX_RATE_KEYS = 2048;
const FALLBACK_TO = 'zabota-usluga72@mail.ru';
const SMTP_TIMEOUT = 20000;
const HEADERS = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};

class MailError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function mailbox(value) {
  return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) && !value.includes('..');
}

export function readSmtpConfig(env = process.env) {
  if (!env.SMTP_USER || !env.SMTP_PASSWORD) return null;
  const config = {
    host: env.SMTP_HOST || 'smtp.mail.ru', port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE === undefined ? true : /^(true|1)$/i.test(env.SMTP_SECURE),
    user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SMTP_FROM || env.SMTP_USER,
    to: env.MAIL_TO || FALLBACK_TO, timeout: SMTP_TIMEOUT
  };
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(config.host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      !mailbox(config.user) || !mailbox(config.from) || !mailbox(config.to) || config.password.length > 1024 || /[\r\n\0]/.test(config.password) ||
      (env.SMTP_SECURE !== undefined && !/^(true|false|1|0)$/i.test(env.SMTP_SECURE))) {
    throw new MailError(503, 'Отправка сообщений временно недоступна.');
  }
  return config;
}

/** Encoded words are individually valid UTF-8 and stay below RFC 2047's limit. */
export function encodeMailHeader(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid mail header');
  const chunks = []; let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42 && chunk) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(item => `=?UTF-8?B?${Buffer.from(item, 'utf8').toString('base64')}?=`).join('\r\n ');
}

export function dotStuff(value) {
  return String(value).replace(/\r\n|\r|\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

export function formatMail(message) {
  if (!mailbox(message.from) || !mailbox(message.to) || typeof message.text !== 'string' || !/^[a-f0-9-]+$/.test(message.id)) throw new Error('Invalid mail');
  const body = Buffer.from(message.text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return [
    `From: ${encodeMailHeader('Заботливая услуга')} <${message.from}>`, `To: <${message.to}>`,
    `Subject: ${encodeMailHeader(message.subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${message.id}@${message.from.split('@')[1]}>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    'X-Auto-Response-Suppress: All', '', body, ''
  ].join('\r\n');
}

function smtpError(code = 'SMTP_PROTOCOL') { const error = new Error('SMTP delivery failed'); error.code = code; return error; }

function responseReader(socket) {
  let buffer = ''; let lines = []; let responseCode; let failure; let waiting; const queue = [];
  function fail(error) {
    if (failure) return;
    failure = error;
    if (waiting) { waiting.reject(error); waiting = null; }
    socket.destroy();
  }
  function data(chunk) {
    buffer += chunk.toString('utf8');
    if (buffer.length > 65536) { fail(smtpError('SMTP_RESPONSE_LIMIT')); return; }
    let end;
    while ((end = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match || (responseCode && Number(match[1]) !== responseCode)) { fail(smtpError()); return; }
      responseCode = Number(match[1]); lines.push(match[3]);
      if (lines.length > 100) { fail(smtpError('SMTP_RESPONSE_LIMIT')); return; }
      if (match[2] === ' ') {
        const response = {code: responseCode, lines}; lines = []; responseCode = undefined;
        if (waiting) { waiting.resolve(response); waiting = null; }
        else { queue.push(response); if (queue.length > 16) { fail(smtpError('SMTP_RESPONSE_LIMIT')); return; } }
      }
    }
  }
  function error(value) { fail(value); }
  function close() { fail(smtpError('SMTP_CONNECTION_CLOSED')); }
  socket.on('data', data); socket.on('error', error); socket.on('end', close); socket.on('close', close);
  return {
    read() { if (failure) return Promise.reject(failure); if (queue.length) return Promise.resolve(queue.shift()); return new Promise((resolve, reject) => { waiting = {resolve, reject}; }); },
    dispose() { socket.off('data', data); socket.off('error', error); socket.off('end', close); socket.off('close', close); },
    fail
  };
}

async function connected(socket, event) {
  await new Promise((resolve, reject) => {
    const cleanup = () => { socket.off(event, onConnect); socket.off('error', onError); socket.off('close', onClose); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(smtpError('SMTP_CONNECTION_CLOSED')); };
    const onConnect = () => { cleanup(); resolve(); };
    socket.once(event, onConnect); socket.once('error', onError); socket.once('close', onClose);
  });
}

/** SMTP is sequential, encrypted and certificate-verified; acceptance requires DATA's 250. */
export async function sendSmtpMail(message, config) {
  let socket; let reader;
  const formatted = formatMail(message);
  const timeout = Math.max(100, Math.min(Number(config.timeout) || SMTP_TIMEOUT, SMTP_TIMEOUT));
  const tlsOptions = {host: config.host, port: config.port, servername: net.isIP(config.host)?undefined:config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(config.ca ? {ca: config.ca} : {})};
  const timer = setTimeout(() => { reader?.fail(smtpError('SMTP_TIMEOUT')); socket?.destroy(); }, timeout);
  try {
    socket = config.secure ? tls.connect(tlsOptions) : net.connect({host: config.host, port: config.port});
    reader = responseReader(socket); socket.setTimeout(timeout, () => reader.fail(smtpError('SMTP_TIMEOUT')));
    await connected(socket, config.secure ? 'secureConnect' : 'connect');
    if (config.secure && !socket.authorized) throw smtpError('SMTP_TLS');
    async function expect(codes) { const reply = await reader.read(); if (!codes.includes(reply.code)) throw smtpError(`SMTP_${reply.code}`); return reply; }
    async function command(value, codes) { socket.write(value + '\r\n'); return expect(codes); }
    await expect([220]);
    const domain = config.from.split('@')[1];
    let capabilities = await command(`EHLO ${domain}`, [250]);
    if (!config.secure) {
      if (!capabilities.lines.some(line => /^STARTTLS(?:\s|$)/i.test(line))) throw smtpError('SMTP_STARTTLS_REQUIRED');
      await command('STARTTLS', [220]);
      reader.dispose(); socket.setTimeout(0);
      socket = tls.connect({...tlsOptions, socket}); reader = responseReader(socket);
      socket.setTimeout(timeout, () => reader.fail(smtpError('SMTP_TIMEOUT')));
      await connected(socket, 'secureConnect');
      if (!socket.authorized) throw smtpError('SMTP_TLS');
      capabilities = await command(`EHLO ${domain}`, [250]);
    }
    const mechanisms = capabilities.lines.filter(line => /^AUTH(?:=|\s)/i.test(line)).join(' ').toUpperCase();
    if (/\bPLAIN\b/.test(mechanisms)) {
      const token = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64');
      const reply = await command(`AUTH PLAIN ${token}`, [235, 334]);
      if (reply.code === 334) await command(token, [235]);
    } else if (/\bLOGIN\b/.test(mechanisms)) {
      await command('AUTH LOGIN', [334]); await command(Buffer.from(config.user, 'utf8').toString('base64'), [334]);
      await command(Buffer.from(config.password, 'utf8').toString('base64'), [235]);
    } else throw smtpError('SMTP_AUTH_UNSUPPORTED');
    await command(`MAIL FROM:<${message.from}>`, [250]); await command(`RCPT TO:<${message.to}>`, [250, 251]);
    await command('DATA', [354]); socket.write(dotStuff(formatted) + '.\r\n'); await expect([250]);
    socket.end('QUIT\r\n');
    return {accepted: true, messageId: message.id};
  } finally {
    clearTimeout(timer); reader?.dispose(); if(socket){socket.on('error',()=>{});socket.destroy();}
  }
}

function validateOrigin(req, configured) {
  const host = req.headers.host;
  if (typeof host !== 'string' || /[\s/\\@#?]/.test(host)) throw new MailError(403, 'Не удалось проверить адрес сайта.');
  let expected;
  try {
    const actual = new URL(`http://${host}`);
    const origin = configured ? new URL(configured) : null;
    if (origin && (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || origin.host.toLowerCase() !== actual.host.toLowerCase())) throw new Error();
    expected = origin?.origin || `${req.socket.encrypted ? 'https' : 'http'}://${actual.host}`;
  } catch { throw new MailError(403, 'Не удалось проверить адрес сайта.'); }
  if (req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') throw new MailError(403, 'Отправьте сообщение со страницы сайта.');
}

async function readJSON(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new MailError(415, 'Некорректный формат сообщения.');
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY) throw new MailError(413, 'Сообщение слишком длинное.');
  const bytes = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const timer = setTimeout(() => finish(new MailError(408, 'Время отправки истекло. Повторите попытку.')), 10000);
    const finish = (error) => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
      if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks, size));
    };
    function data(chunk) { size += chunk.length; if (size > MAX_BODY) finish(new MailError(413, 'Сообщение слишком длинное.')); else chunks.push(chunk); }
    function end() { finish(); } function fail() { finish(new MailError(400, 'Не удалось прочитать сообщение.')); } function aborted() { fail(); }
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted);
  });
  try { const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new MailError(400, 'Некорректные данные сообщения.'); }
}

export function validateContact(payload) {
  if (Object.keys(payload).some(key => !['name', 'phone', 'message', 'consent', 'website'].includes(key))) throw new MailError(400, 'Некорректные поля сообщения.');
  if (typeof payload.website !== 'undefined' && (typeof payload.website !== 'string' || payload.website)) throw new MailError(400, 'Не удалось проверить форму. Обновите страницу.');
  const validText = (value, max, multiline = false) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value);
  if (!validText(payload.name, 150)) throw new MailError(400, 'Укажите ваше имя (до 150 символов).');
  if (!validText(payload.message, 5000, true)) throw new MailError(400, 'Напишите сообщение (до 5000 символов).');
  let phone = payload.phone ?? '';
  if (typeof phone !== 'string' || phone.length > 60) throw new MailError(400, 'Проверьте номер телефона.');
  phone = phone.trim();
  if (phone) {
    if (!/^\+?[\d ().-]+$/.test(phone)) throw new MailError(400, 'Проверьте номер телефона.');
    const digits = phone.replace(/\D/g, '');
    if ((phone.startsWith('+') && (digits.length !== 11 || !digits.startsWith('7'))) ||
        (digits.length !== 10 && !(digits.length === 11 && /^[78]/.test(digits)))) {
      throw new MailError(400, 'Проверьте номер телефона.');
    }
    phone = '+7' + (digits.length === 11 ? digits.slice(1) : digits);
  }
  if (payload.consent !== true) throw new MailError(400, 'Подтвердите согласие на обработку данных для ответа.');
  return {name: payload.name.trim(), phone, message: payload.message.trim()};
}

/** transport injection is for tests; production always uses sendSmtpMail and server-only recipients. */
export function createMailApi({transport = sendSmtpMail, env = process.env, origin = env.ADMIN_PUBLIC_ORIGIN} = {}) {
  let config; try { config = readSmtpConfig(env); } catch { config = null; }
  const rates = new Map(); let active = 0;
  function rateLimit(req) {
    const now = Date.now(); for (const [key, item] of rates) if (item.expires <= now) rates.delete(key);
    const key = req.socket.remoteAddress || 'unknown'; const item = rates.get(key) || {count: 0, expires: now + RATE_MS};
    if (item.count >= MAX_SENDS || active >= 4) throw new MailError(429, 'Слишком много сообщений. Повторите отправку позже.');
    if (!rates.has(key) && rates.size >= MAX_RATE_KEYS) rates.delete(rates.keys().next().value);
    item.count++; rates.set(key, item);
  }
  function respond(res, status, payload) { res.writeHead(status, HEADERS); res.end(JSON.stringify(payload)); }
  return async function handle(req, res, url) {
    if (url.pathname !== '/api/contact') return false;
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new MailError(405, 'Используйте форму отправки сообщения.'); }
      validateOrigin(req, origin);
      if (!config) throw new MailError(503, 'Отправка сообщений временно недоступна. Свяжитесь с нами по телефону.');
      const contact = validateContact(await readJSON(req)); rateLimit(req); active++;
      try {
        const message = {from: config.from, to: config.to, subject: 'Обращение с сайта «Заботливая услуга»', id: randomUUID(),
          text: `Имя: ${contact.name}\nТелефон: ${contact.phone || 'Не указан'}\n\n${contact.message}\n\nСогласие на обработку указанных персональных данных для ответа на обращение подтверждено.`};
        let result; try { result = await transport(message, config); } catch { throw new MailError(502, 'Не удалось отправить сообщение. Повторите позже или свяжитесь с нами по телефону.'); }
        if (result?.accepted !== true) throw new MailError(502, 'Не удалось отправить сообщение. Повторите позже или свяжитесь с нами по телефону.');
        respond(res, 200, {sent: true});
      } finally { active--; }
    } catch (error) {
      const status = error instanceof MailError ? error.status : 500;
      if (status === 429) res.setHeader('Retry-After', String(RATE_MS / 1000));
      if (!res.headersSent) respond(res, status, {error: status === 500 ? 'Не удалось отправить сообщение. Повторите позже.' : error.message});
    }
    return true;
  };
}
