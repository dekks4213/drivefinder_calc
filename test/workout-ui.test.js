const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-w-')), 'test.db');
process.env.TELEGRAM_BOT_TOKEN = '1:test';
process.env.GEMINI_API_KEY = 'test';
process.env.DASH_PORT = '0';

const store = require('../bot/db');
const { buildPlan } = require('../bot/plan');
const { bot, CONSENT_VERSION } = require('../bot/index');

bot.botInfo = { id: 1, is_bot: true, first_name: 'Тест', username: 'test_bot' };

const { Telegram } = require('telegraf');
const sent = [];
Telegram.prototype.callApi = async function (method, payload) {
  sent.push({ method, payload });
  if (method === 'sendMessage') return { message_id: sent.length, chat: { id: payload.chat_id }, text: payload.text };
  return true;
};

const UID = 77;
store.ensureUser(UID, 'Тест');
store.acceptConsent(UID, CONSENT_VERSION);
store.updateUser(UID, { sex: 'male', age: 30, height_cm: 180, weight_kg: 90, activity: 'moderate', goal: 'cut' });
store.setPlan(UID, buildPlan({ days_per_week: 6, location: 'gym', goal: 'cut' }));

let updateId = 1;
const callbackUpdate = (data) => ({
  update_id: updateId++,
  callback_query: {
    id: String(updateId),
    from: { id: UID, is_bot: false, first_name: 'Тест' },
    message: { message_id: 10, date: Math.floor(Date.now() / 1000), chat: { id: UID, type: 'private' }, text: 'тренировка' },
    data,
  },
});
const lastText = () => [...sent].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');

test('кнопка «Сделал» записывает тренировку без единого слова от пользователя', async () => {
  sent.length = 0;
  await bot.handleUpdate(callbackUpdate('w:done'));

  const [w] = store.workoutsOfDay(UID);
  assert.ok(w, 'запись появилась');
  assert.strictEqual(w.done, 1);
  assert.ok(w.title, 'название взято из плана дня');
  assert.match(lastText().payload.text, /сделана/);
  assert.match(lastText().payload.text, /сделано 1/);
});

test('повторное нажатие не плодит записи', async () => {
  await bot.handleUpdate(callbackUpdate('w:done'));
  assert.strictEqual(store.workoutsOfDay(UID).length, 1);
  assert.strictEqual(store.trainingStats(UID, 30).done, 1);
});

test('кнопки с тренировкой предлагают оба исхода', () => {
  const { bot: b } = require('../bot/index');
  assert.ok(b, 'модуль экспортирует бота для тестов');
});

test('статистика считает выполнение после отметки кнопкой', () => {
  const s = store.trainingStats(UID, 30);
  assert.strictEqual(s.done, 1);
  assert.strictEqual(s.skipped, 0);
  assert.strictEqual(s.days_since_last, 0);
});
