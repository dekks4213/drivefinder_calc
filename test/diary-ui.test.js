const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-ui-'));
process.env.BOT_DB_PATH = path.join(dir, 'test.db');
process.env.TELEGRAM_BOT_TOKEN = '1:test';
process.env.GEMINI_API_KEY = 'test';
process.env.DASH_PORT = '0';

const store = require('../bot/db');
const { bot, diaryView, CONSENT_VERSION } = require('../bot/index');

// Telegram наружу не ходит: подменяем транспорт и собираем вызовы.
bot.botInfo = { id: 1, is_bot: true, first_name: 'Тест', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };

// Подмена идёт на прототипе: Telegraf создаёт новый экземпляр Telegram
// на каждый апдейт, поэтому стаб на bot.telegram до обработчиков не доходит.
const { Telegram } = require('telegraf');
const sent = [];
Telegram.prototype.callApi = async function (method, payload) {
  sent.push({ method, payload });
  if (method === 'sendMessage') return { message_id: sent.length, chat: { id: payload.chat_id }, text: payload.text };
  return true;
};

const UID = 42;
store.ensureUser(UID, 'Тест');
store.acceptConsent(UID, CONSENT_VERSION);
let updateId = 1;

const textUpdate = (text) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: UID, type: 'private' }, from: { id: UID, is_bot: false, first_name: 'Тест' }, text },
});

const callbackUpdate = (data) => ({
  update_id: updateId++,
  callback_query: {
    id: String(updateId),
    from: { id: UID, is_bot: false, first_name: 'Тест' },
    message: { message_id: 500, date: Math.floor(Date.now() / 1000), chat: { id: UID, type: 'private' }, text: 'старый список' },
    data,
  },
});

const lastText = () => [...sent].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
const buttons = (call) => {
  const raw = call.payload.reply_markup;
  const markup = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  return (markup.inline_keyboard || []).flat().map((b) => b.callback_data);
};

test('кнопка дневника показывает список с номерами', async () => {
  store.addMeal(UID, { text: 'омлет', kcal: 400, protein: 25, fat: 28, carbs: 6 });
  store.addMeal(UID, { text: 'том ям', kcal: 650, protein: 30, fat: 35, carbs: 50 });
  store.addMeal(UID, { text: 'том ям ещё раз', kcal: 650, protein: 30, fat: 35, carbs: 50 });

  sent.length = 0;
  await bot.handleUpdate(textUpdate('🍽 Дневник'));

  const msg = lastText();
  assert.match(msg.payload.text, /ДНЕВНИК ЗА/);
  assert.match(msg.payload.text, /Итого: 1700 ккал/);
  assert.strictEqual(buttons(msg).length, 3, 'по кнопке на каждую запись');
});

test('нажатие на номер открывает карточку с кнопками правки и удаления', async () => {
  const meal = store.mealsOfDay(UID)[2];
  sent.length = 0;
  await bot.handleUpdate(callbackUpdate(`meal:open:${meal.id}`));

  const msg = lastText();
  assert.match(msg.payload.text, /том ям ещё раз/);
  assert.deepStrictEqual(buttons(msg), [`meal:edit:${meal.id}`, `meal:del:${meal.id}`, 'meal:list']);
});

test('удаление убирает запись и пересчитывает день', async () => {
  const meal = store.mealsOfDay(UID)[2];
  sent.length = 0;
  await bot.handleUpdate(callbackUpdate(`meal:del:${meal.id}`));

  assert.strictEqual(store.mealsOfDay(UID).length, 2);
  assert.strictEqual(Math.round(store.dayTotals(UID).kcal), 1050);
  assert.match(lastText().payload.text, /Итого: 1050 ккал/);
  assert.ok(buttons(lastText()).includes('meal:undo'), 'появилась кнопка возврата');
});

test('промах по кнопке лечится возвратом', async () => {
  sent.length = 0;
  await bot.handleUpdate(callbackUpdate('meal:undo'));

  assert.strictEqual(store.mealsOfDay(UID).length, 3);
  assert.strictEqual(Math.round(store.dayTotals(UID).kcal), 1700);
  assert.ok(!buttons(lastText()).includes('meal:undo'), 'возвращать больше нечего');
});

test('удаление уже удалённой записи не ломает список', async () => {
  sent.length = 0;
  await bot.handleUpdate(callbackUpdate('meal:del:999999'));
  assert.match(lastText().payload.text, /ДНЕВНИК ЗА/);
});

test('пустой дневник показывает понятный текст без кнопок записей', async () => {
  store.mealsOfDay(UID).forEach((m) => store.deleteMeal(UID, m.id));
  const view = diaryView(UID);
  assert.match(view.text, /в дневнике пусто/);
});
