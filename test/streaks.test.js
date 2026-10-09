const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-streaks-')), 'test.db');
const store = require('../bot/db');
const streaks = require('../bot/streaks');

const UID = 11;
store.ensureUser(UID, 'Серийный');
store.updateUser(UID, {
  sex: 'male', age: 30, height_cm: 180, weight_kg: 80, activity: 'moderate', goal: 'recomp', days_per_week: 3, location: 'gym',
});

const day = (back) => store.today(new Date(Date.now() - back * 86400000));
const target = require('../bot/nutrition').computeTargets(store.getUser(UID));

test('незакрытый сегодняшний день серию не рвёт', () => {
  for (const back of [1, 2, 3]) {
    store.addMeal(UID, { day: day(back), text: 'норма', kcal: 2000, protein: target.protein, fat: 60, carbs: 200 });
  }
  const s = streaks.summary(UID);
  assert.strictEqual(s.protein.current, 3, 'три закрытых дня должны считаться');
  assert.strictEqual(s.diary.current, 3);
});

test('провал вчера серию рвёт', () => {
  const other = 12;
  store.ensureUser(other, 'Сорвавшийся');
  store.updateUser(other, { sex: 'male', age: 30, height_cm: 180, weight_kg: 80, activity: 'moderate', goal: 'recomp' });
  store.addMeal(other, { day: day(2), text: 'норма', kcal: 2000, protein: target.protein, fat: 60, carbs: 200 });
  store.addMeal(other, { day: day(1), text: 'мало', kcal: 500, protein: 10, fat: 10, carbs: 50 });

  const s = streaks.summary(other);
  assert.strictEqual(s.protein.current, 0);
  assert.strictEqual(s.protein.best, 1, 'рекорд должен помнить закрытый день');
});

test('тренировки без прогула считаются только по записанным дням', () => {
  store.addWorkout(UID, { day: day(5), done: true, title: 'Ноги' });
  store.addWorkout(UID, { day: day(3), done: true, title: 'Жим' });
  store.addWorkout(UID, { day: day(1), done: true, title: 'Тяга' });

  const s = streaks.summary(UID);
  assert.strictEqual(s.training.current, 3);
  assert.strictEqual(s.training.best, 3);
  assert.strictEqual(s.training.last_skip, null);
  assert.ok(s.training.best_week >= 2, 'лучшая неделя должна учесть несколько тренировок');
});

test('прогул обнуляет текущую серию и запоминает отмазку', () => {
  store.addWorkout(UID, { day: day(0), done: false, excuse: 'устал' });
  const s = streaks.summary(UID);
  assert.strictEqual(s.training.current, 0);
  assert.strictEqual(s.training.last_skip.excuse, 'устал');
  assert.strictEqual(s.training.best, 3, 'рекорд остаётся');
});

test('отчёт пишется только по тому, что есть', () => {
  const text = streaks.format(streaks.summary(UID));
  assert.match(text, /СЕРИИ И РЕКОРДЫ/);
  assert.match(text, /Максимум белка/);
});
