import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import {generateKeyPairSync, sign, randomBytes} from 'node:crypto';
import {createMailApi, readSmtpConfig, encodeMailHeader, dotStuff, formatMail, sendSmtpMail} from './mail-api.mjs';

const env = {SMTP_USER: 'test-sender@mail.ru', SMTP_PASSWORD: 'test-only-app-password'};
const valid = {name: 'Елена', phone: '+7 (921) 123-45-67', message: 'Мне нужна помощь на дому.', consent: true, website: ''};
const message = {from: env.SMTP_USER, to: 'zabota-usluga72@mail.ru', subject: 'Обращение с сайта «Заботливая услуга»', text: 'Имя: Елена\n.Первая строка\n..Вторая строка\nКонец', id: 'aaaa-bbbb-cccc-dddd'};

async function httpFixture({transport = async () => ({accepted: true}), settings = env} = {}) {
  const api = createMailApi({transport, env: settings});
  const server = http.createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(body = valid, {method = 'POST', headers = {}, endpoint = '/api/contact', raw = false} = {}) {
    const response = await fetch(base + endpoint, {method, headers: {Origin: base, 'Content-Type': 'application/json', ...headers}, body: method === 'GET' ? undefined : raw ? body : JSON.stringify(body)});
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return {status: response.status, headers: response.headers, data};
  }
  async function close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  return {request, close};
}

test('Contact is delivered to server recipient only and success requires accepted transport', async () => {
  const deliveries = [];
  const f = await httpFixture({transport: async (mail, config) => { deliveries.push({mail, config}); return {accepted: true}; }});
  try {
    const result = await f.request(); assert.equal(result.status, 200); assert.deepEqual(result.data, {sent: true});
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0].mail.to, 'zabota-usluga72@mail.ru');
    assert.equal(deliveries[0].mail.from, env.SMTP_USER); assert.equal(deliveries[0].mail.subject, message.subject);
    assert.match(deliveries[0].mail.text, /Имя: Елена/); assert.match(deliveries[0].mail.text, /Мне нужна помощь на дому/);
    assert.ok(!Object.hasOwn(deliveries[0].mail, 'replyTo')); assert.match(result.headers.get('cache-control'), /no-store/);
    assert.equal((await f.request({...valid, to: 'attacker@example.org'})).status, 400); assert.equal(deliveries.length, 1);
    assert.ok(!JSON.stringify(result.data).includes(env.SMTP_PASSWORD));
    assert.equal((await f.request(undefined, {method: 'GET'})).status, 405);
    assert.equal((await f.request(valid, {endpoint: '/api/survey'})).status, 404, 'Survey belongs to a separate handler');
  } finally { await f.close(); }
});

test('Missing configuration and SMTP failure never report a sent message', async () => {
  for (const [settings, transport, status] of [
    [{}, async () => ({accepted: true}), 503],
    [{...env, SMTP_FROM: 'bad\r\nBcc:attacker@example.org'}, async () => ({accepted: true}), 503],
    [env, async () => { throw new Error('Secret test error ' + env.SMTP_PASSWORD); }, 502],
    [env, async () => ({accepted: false}), 502],
    [env, async () => undefined, 502]
  ]) {
    const f = await httpFixture({settings, transport});
    try { const result = await f.request(); assert.equal(result.status, status); assert.ok(result.data.error); assert.ok(!result.data.sent); assert.ok(!JSON.stringify(result.data).includes(env.SMTP_PASSWORD)); }
    finally { await f.close(); }
  }
});

test('Validation, consent, honeypot, origin and body limits precede transport', async () => {
  let count = 0; const f = await httpFixture({transport: async () => { count++; return {accepted: true}; }});
  try {
    for (const body of [
      {...valid, consent: false}, {...valid, consent: 'true'}, {...valid, name: ' '}, {...valid, name: 'A\r\nBcc:evil@example.org'},
      {...valid, phone: 'javascript:bad'}, {...valid, message: ''}, {...valid, message: 'x'.repeat(5001)},
      {...valid, website: 'spam.example'}, {...valid, from: 'attacker@example.org'}, {...valid, message: '\u0000bad'}
    ]) assert.equal((await f.request(body)).status, 400);
    assert.equal((await f.request(valid, {headers: {Origin: 'https://evil.example'}})).status, 403);
    assert.equal((await f.request(valid, {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
    assert.equal((await f.request('not-json', {raw: true})).status, 400);
    assert.equal((await f.request('{}', {raw: true, headers: {'Content-Type': 'text/plain'}})).status, 415);
    assert.equal((await f.request('x'.repeat(25000), {raw: true})).status, 413);
    assert.equal(count, 0);
  } finally { await f.close(); }
});

test('Contact rate limit bounds outgoing messages', async () => {
  let count = 0; const f = await httpFixture({transport: async () => { count++; return {accepted: true}; }});
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.request()).status, 200);
    const result = await f.request(); assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '600'); assert.equal(count, 5);
  } finally { await f.close(); }
});

test('Optional Russian phone is validated and normalized before sending', async () => {
  const deliveries = [];
  const f = await httpFixture({transport: async mail => { deliveries.push(mail); return {accepted: true}; }});
  try {
    for (const [phone, expected] of [
      ['', 'Не указан'], ['9211234567', '+79211234567'],
      ['+7 (921) 123-45-67', '+79211234567'], ['8 (921) 123-45-67', '+79211234567'], ['79211234567', '+79211234567']
    ]) {
      assert.equal((await f.request({...valid, phone})).status, 200, phone);
      assert.equal(deliveries.at(-1).text.split('\n')[1], 'Телефон: ' + expected);
    }
    assert.equal(deliveries.length, 5);
  } finally { await f.close(); }
  const rejected = await httpFixture({transport: async mail => { deliveries.push(mail); return {accepted: true}; }});
  try {
    for (const phone of ['любой текст', '1234567', '+7 (921) 123-45', '+7 92112345678', '+1 9211234567',
      '9 9211234567', '++7 (921) 123-45-67', '+9211234567', '+7----', '9211234567 доб. 1']) {
      assert.equal((await rejected.request({...valid, phone})).status, 400, phone);
    }
    assert.equal(deliveries.length, 5, 'Invalid phones must not reach SMTP');
  } finally { await rejected.close(); }
});

test('Mail config and MIME preserve UTF-8 without header or DATA injection', () => {
  const config = readSmtpConfig(env); assert.equal(config.host, 'smtp.mail.ru'); assert.equal(config.port, 465); assert.equal(config.secure, true);
  assert.equal(readSmtpConfig({...env, SMTP_PASSWORD: ''}), null);
  assert.equal(readSmtpConfig({...env, SMTP_SECURE: 'false', SMTP_PORT: '587'}).secure, false);
  assert.throws(() => readSmtpConfig({...env, SMTP_SECURE: 'invalid'}));
  assert.throws(() => readSmtpConfig({...env, MAIL_TO: 'a@example.org\r\nBcc:b@example.org'}));
  assert.equal(dotStuff('.one\n..two\r.\r\nend'), '..one\r\n...two\r\n..\r\nend');
  const subject = 'Очень длинное обращение с сайта Заботливая услуга: помощь пожилому человеку';
  const encoded = encodeMailHeader(subject); const words = encoded.split('\r\n ');
  assert.ok(words.every(word => word.length <= 75));
  assert.equal(words.map(word => Buffer.from(word.slice(10, -2), 'base64').toString('utf8')).join(''), subject);
  assert.throws(() => encodeMailHeader('Bad\r\nBcc:evil@example.org'));
  assert.throws(() => formatMail({...message, from: 'bad\r\nBcc:evil@example.org'}));
  const wire = formatMail(message); assert.match(wire, /Content-Type: text\/plain; charset=UTF-8/); assert.match(wire, /Content-Transfer-Encoding: base64/);
  assert.equal(Buffer.from(wire.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), message.text);
});

// Ephemeral self-signed certificate for local TLS tests. No static private key is shipped.
function certificate() {
  const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
  const der = (tag, ...parts) => {
    const value = Buffer.concat(parts); const length = value.length;
    return Buffer.concat([Buffer.from([tag]), length < 128 ? Buffer.from([length]) : Buffer.from([0x82, length >> 8, length & 255]), value]);
  };
  const seq = (...parts) => der(0x30, ...parts); const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
  const algorithm = seq(oid('2a864886f70d01010b'), der(0x05));
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('localhost')))));
  const now = Date.now(); const time = value => der(0x17, Buffer.from(new Date(value).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
  const extensions = der(0xa3, seq(
    seq(oid('551d13'), der(0x01, Buffer.from([255])), der(0x04, seq(der(0x01, Buffer.from([255]))))),
    seq(oid('551d11'), der(0x04, seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127,0,0,1])))))
  ));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.concat([Buffer.from([1]), randomBytes(15)])), algorithm, name,
    seq(time(now - 60000), time(now + 86400000)), name, pair.publicKey.export({type: 'spki', format: 'der'}), extensions);
  const cert = seq(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, pair.privateKey)])));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return {cert: pem, key: pair.privateKey.export({type: 'pkcs8', format: 'pem'})};
}

async function smtpFixture({secure = true, rejectRecipient = false, silent = false, startTls = false, login = false} = {}) {
  const commands = []; const letters = []; const sockets = new Set(); const credentials = secure || startTls ? certificate() : null;
  const onConnection = (socket, encrypted = secure, greet = true) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (silent) return;
    if(greet) socket.write('220 Local test SMTP\r\n'); let buffer = ''; let mail = false; let content = []; let authStage = 0;
    function parse(chunk) {
      buffer += chunk.toString('utf8'); let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (mail) {
          if (line === '.') { letters.push(content.join('\r\n')); mail = false; content = []; socket.write('250 queued\r\n'); }
          else content.push(line.replace(/^\.\./, '.'));
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO ')) socket.write('250-localhost\r\n'+(startTls && !encrypted ? '250-STARTTLS\r\n' : '')+'250 AUTH '+(login ? 'LOGIN' : 'PLAIN LOGIN')+'\r\n');
        else if(line==='STARTTLS' && startTls && !encrypted){
          socket.write('220 begin TLS\r\n');socket.off('data',parse);
          const secured=new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext(credentials)});
          onConnection(secured,true,false);return;
        }
        else if(line==='AUTH LOGIN'){authStage=1;socket.write('334 VXNlcm5hbWU6\r\n');}
        else if(authStage===1){assert.equal(Buffer.from(line,'base64').toString('utf8'),env.SMTP_USER);authStage=2;socket.write('334 UGFzc3dvcmQ6\r\n');}
        else if(authStage===2){assert.equal(Buffer.from(line,'base64').toString('utf8'),env.SMTP_PASSWORD);authStage=0;socket.write('235 authenticated\r\n');}
        else if (line.startsWith('AUTH PLAIN ')) { assert.equal(Buffer.from(line.slice(11), 'base64').toString('utf8'), `\0${env.SMTP_USER}\0${env.SMTP_PASSWORD}`); socket.write('235 authenticated\r\n'); }
        else if (line.startsWith('MAIL FROM:')) socket.write('250 sender accepted\r\n');
        else if (line.startsWith('RCPT TO:')) socket.write(rejectRecipient ? '550 recipient refused\r\n' : '250 recipient accepted\r\n');
        else if (line === 'DATA') { mail = true; socket.write('354 enter message\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 unknown command\r\n');
      }
    }
    socket.on('data',parse);
  };
  const server = secure ? tls.createServer(credentials, onConnection) : net.createServer(onConnection);
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {...readSmtpConfig(env), host: '127.0.0.1', port: server.address().port, secure, timeout: silent ? 150 : 2000, ...(credentials ? {ca: credentials.cert} : {})};
  async function close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  return {config, commands, letters, close};
}

test('Native TLS SMTP authenticates, sends fixed envelopes and receives DATA acceptance', async () => {
  const f = await smtpFixture();
  try {
    const result = await sendSmtpMail(message, f.config); assert.equal(result.accepted, true); assert.equal(f.letters.length, 1);
    assert.ok(f.commands.includes(`MAIL FROM:<${message.from}>`)); assert.ok(f.commands.includes(`RCPT TO:<${message.to}>`));
    const body = f.letters[0].split('\r\n\r\n')[1]; assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), message.text);
  } finally { await f.close(); }
});

test('Native SMTP rejects recipient refusal, untrusted certificate and missing STARTTLS', async () => {
  let f = await smtpFixture({rejectRecipient: true});
  try { await assert.rejects(sendSmtpMail(message, f.config), error => error.code === 'SMTP_550'); assert.equal(f.letters.length, 0); }
  finally { await f.close(); }
  f = await smtpFixture();
  try { const config = {...f.config}; delete config.ca; await assert.rejects(sendSmtpMail(message, config)); assert.equal(f.letters.length, 0); }
  finally { await f.close(); }
  f = await smtpFixture({secure: false});
  try { await assert.rejects(sendSmtpMail(message, f.config), error => error.code === 'SMTP_STARTTLS_REQUIRED'); assert.ok(!f.commands.some(command => command.startsWith('AUTH'))); assert.equal(f.letters.length, 0); }
  finally { await f.close(); }
});

test('Native SMTP has a bounded timeout when server gives no greeting', async () => {
  const f = await smtpFixture({secure: false, silent: true}); const started = Date.now();
  try { await assert.rejects(sendSmtpMail(message, f.config), error => error.code === 'SMTP_TIMEOUT'); assert.ok(Date.now() - started < 2000); }
  finally { await f.close(); }
});

test('Native SMTP upgrades STARTTLS before AUTH LOGIN credentials',async()=>{
  const f=await smtpFixture({secure:false,startTls:true,login:true});
  try{
    assert.equal((await sendSmtpMail(message,f.config)).accepted,true);assert.equal(f.letters.length,1);
    const upgrade=f.commands.indexOf('STARTTLS'),auth=f.commands.indexOf('AUTH LOGIN');
    assert.ok(upgrade>0&&auth>upgrade);assert.equal(f.commands.filter(command=>command.startsWith('EHLO')).length,2);
  }finally{await f.close();}
});
