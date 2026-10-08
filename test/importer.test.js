const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-imp-')), 'test.db');
process.env.GEMINI_API_KEY = 'test';
const store = require('../bot/db');
const { parseExport, apply } = require('../bot/importer');

const exportJson = {
  name: 'РИТМ',
  messages: [
    { id: 1, type: 'service', date: '2026-10-06T10:00:00', action: 'pinned' },
    { id: 2, type: 'message', date: '2026-10-06T10:01:00', from: 'Дима', from_id: 'user135146146', text: 'мужской, 31, 186 см, 105 кг' },
    { id: 3, type: 'message', date: '2026-10-06T10:02:00', from: 'РИТМ', from_id: 'user8832657663', text: 'Записал.' },
    { id: 4, type: 'message', date: '2026-10-07T12:00:00', from: 'Дима', from_id: 'user135146146', text: [{ type: 'plain', text: 'съел ' }, { type: 'bold', text: 'омлет' }] },
    { id: 5, type: 'message', date: '2026-10-07T12:05:00', from: 'Дима', from_id: 'user135146146', photo: 'photos/1.jpg', text: '' },
    { id: 6, type: 'message', date: 'битая дата', from: 'Дима', from_id: 'user135146146', text: 'мусор' },
  ],
};

test('из выгрузки берутся только реплики человека', () => {
  const { days } = parseExport(exportJson, 135146146);
  const all = days.flatMap(([, lines]) => lines).join(' ');
  assert.ok(!all.includes('Записал'), 'ответы бота не переносятся');
  assert.ok(all.includes('мужской, 31'));
});

test('текст из кусков с разметкой склеивается', () => {
  const { days } = parseExport(exportJson, 135146146);
  const lines = days.find(([d]) => d === '2026-10-07')[1];
  assert.ok(lines.some((l) => l === 'съел омлет'), `получили ${JSON.stringify(lines)}`);
});

test('фото без подписи помечается, битые даты отбрасываются', () => {
  const { days } = parseExport(exportJson, 135146146);
  const dates = days.map(([d]) => d);
  assert.deepStrictEqual(dates, ['2026-10-06', '2026-10-07']);
  assert.ok(days.find(([d]) => d === '2026-10-07')[1].includes('[фото без подписи]'));
});

test('перенос в базу заполняет профиль, дневник и память', () => {
  store.ensureUser(5, 'Дима');
  const added = apply(5, {
    profile: { sex: 'male', age: 31, height_cm: 186, weight_kg: 105, activity: 'sedentary', goal: 'cut' },
    meals: [{ day: '2026-10-07', text: 'омлет', kcal: 400, protein: 25, fat: 28, carbs: 6 }],
    workouts: [{ day: '2026-10-07', done: false, excuse: 'устал' }],
    weights: [{ day: '2026-10-07', kg: 105 }],
    memory: [{ kind: 'питание', fact: 'не ест рыбу' }],
  });

  assert.strictEqual(added.profile, true);
  assert.strictEqual(added.meals, 1);
  assert.strictEqual(store.getUser(5).weight_kg, 105);
  assert.match(store.mealsOfDay(5, '2026-10-07')[0].text, /из истории/, 'видно, что запись восстановлена');
  assert.strictEqual(store.memories(5, 10).length, 1);
});

test('повторный импорт не удваивает еду', () => {
  const added = apply(5, {
    meals: [{ day: '2026-10-07', text: 'омлет', kcal: 400, protein: 25, fat: 28, carbs: 6 }],
  });
  assert.strictEqual(added.meals, 0, 'дубликат отсеян');
  assert.strictEqual(store.mealsOfDay(5, '2026-10-07').length, 1);
});
