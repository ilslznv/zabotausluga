import {fileURLToPath} from 'node:url';
import path from 'node:path';
import process from 'node:process';
import {createInterface} from 'node:readline/promises';
import {StringDecoder} from 'node:string_decoder';
import {resolveAdminStateDir, readAdminAccount, writeAdminAccount} from './admin-api.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

async function hiddenPassword(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Для запуска без терминала задайте пароль в переменной ADMIN_PASSWORD.');
  process.stdout.write(prompt);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = ''; const decoder = new StringDecoder('utf8');
    const finish = (error) => {
      process.stdin.off('data', onData); process.stdin.setRawMode(Boolean(previousRaw)); process.stdin.pause(); process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    function onData(chunk) {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') { finish(new Error('Операция отменена.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\b' || character === '\u007f') value = [...value].slice(0, -1).join('');
        else if (character >= ' ' && [...value].length < 256) value += character;
      }
    }
    process.stdin.on('data', onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Создание: node tools/admin-user.mjs --username admin\nСмена пароля: node tools/admin-user.mjs --username admin --replace\nПароль вводится скрыто; для хостинга можно использовать ADMIN_PASSWORD.');
    return;
  }
  let username = null; let replace = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && !username && args[i + 1] && !args[i + 1].startsWith('--')) username = args[++i];
    else if (args[i] === '--replace' && !replace) replace = true;
    else throw new Error('Используйте --username логин и, при смене пароля, --replace.');
  }
  if (!username) {
    if (!process.stdin.isTTY) throw new Error('Укажите логин: --username admin');
    const rl = createInterface({input: process.stdin, output: process.stdout});
    try { username = (await rl.question('Логин администратора: ')).trim(); } finally { rl.close(); }
  }
  const stateDir = resolveAdminStateDir(projectRoot);
  const existing = await readAdminAccount(stateDir);
  if (existing && !replace) throw new Error('Администратор уже существует. Для смены пароля добавьте --replace.');
  let password = process.env.ADMIN_PASSWORD;
  if (password === undefined) {
    password = await hiddenPassword('Пароль (минимум 12 символов): ');
    const confirmation = await hiddenPassword('Повторите пароль: ');
    if (confirmation !== password) throw new Error('Пароли не совпадают.');
  }
  delete process.env.ADMIN_PASSWORD;
  await writeAdminAccount(stateDir, username, password, {replace});
  password = '';
  console.log(existing ? 'Пароль администратора изменён. Прежние сессии отозваны.' : 'Администратор создан. Вход: /admin/login.html');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
