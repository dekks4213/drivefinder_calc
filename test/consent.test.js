const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-c-'));
process.env.BOT_DB_PATH = path.join(dir, 'test.db');
process.env.BOT_PHOTO_DIR = path.join(dir, 'photos');
process.env.TELEGRAM_BOT_TOKEN = '1:test';
process.env.GEMINI_API_KEY = 'test';
process.env.DASH_PORT = '0';

const store = require('../bot/db');
const progress = require('../bot/progress');
const { bot } = require('../bot/index');

bot.botInfo = { id: 1, is_bot: true, first_name: 'Тест', username: 'test_bot' };
const { Telegram } = require('telegraf');
const sent = [];
Telegram.prototype.callApi = async function (method, payload) {
  sent.push({ method, payload });
  if (method === 'sendMessage') return { message_id: sent.length, chat: { id: payload.chat_id }, text: payload.text };
  return true;
};

const UID = 101;
let updateId = 1;
const textUpdate = (text) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: 1, chat: { id: UID, type: 'private' }, from: { id: UID, is_bot: false, first_name: 'Тест' }, text },
});
const callbackUpdate = (data) => ({
  update_id: updateId++,
  callback_query: { id: String(updateId), from: { id: UID, is_bot: false, first_name: 'Тест' }, message: { message_id: 9, date: 1, chat: { id: UID, type: 'private' }, text: 'согласие' }, data },
});
const lastText = () => [...sent].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');

test('без согласия бот не работает и показывает условия', async () => {
  sent.length = 0;
  await bot.handleUpdate(textUpdate('🍽 Дневник'));

  const msg = lastText().payload.text;
  assert.match(msg, /ЧТО Я ХРАНЮ/);
  assert.match(msg, /не врач/, 'есть дисклеймер про медицину');
  assert.match(msg, /18 лет/, 'есть возрастное ограничение');
  assert.match(msg, /жёстко и матом/, 'тон заявлен до начала');
  assert.strictEqual(store.hasConsent(UID, '2026-10-08'), false);
});

test('согласие фиксируется с версией', async () => {
  await bot.handleUpdate(callbackUpdate('consent:yes'));
  assert.ok(store.hasConsent(UID, '2026-10-08'));
  assert.strictEqual(store.hasConsent(UID, '2099-01-01'), false, 'новая версия условий потребует нового согласия');
});

test('выгрузка отдаёт данные и не содержит токен дашборда', () => {
  store.updateUser(UID, { sex: 'male', age: 30, height_cm: 180, weight_kg: 85, activity: 'moderate', goal: 'cut' });
  store.addMeal(UID, { text: 'творог', kcal: 120, protein: 18, fat: 5, carbs: 3 });
  store.remember(UID, 'питание', 'не ест рыбу');
  store.dashToken(UID);

  const data = store.exportUserData(UID);
  assert.strictEqual(data.питание.length, 1);
  assert.strictEqual(data.память.length, 1);
  assert.strictEqual(data.профиль.dash_token, undefined, 'приватный токен в выгрузку не попадает');
});

test('удаление стирает всё, включая файлы фото', () => {
  fs.mkdirSync(path.join(process.env.BOT_PHOTO_DIR, String(UID)), { recursive: true });
  fs.writeFileSync(path.join(process.env.BOT_PHOTO_DIR, String(UID), 'a.jpg'), 'x');
  store.addProgressPhoto(UID, { file: `${UID}/a.jpg`, note: 'старт' });

  const removed = store.deleteUserData(UID);
  const files = progress.wipeFiles(UID);

  assert.ok(removed.meals >= 1);
  assert.strictEqual(files, 1, 'файл фото удалён с диска');
  assert.strictEqual(store.getUser(UID), undefined, 'профиля больше нет');
  assert.strictEqual(store.exportUserData(UID), null);
  assert.strictEqual(store.mealsOfDay(UID).length, 0);
});

test('после удаления согласие спрашивается заново', async () => {
  sent.length = 0;
  await bot.handleUpdate(textUpdate('привет'));
  assert.match(lastText().payload.text, /ЧТО Я ХРАНЮ/);
});
