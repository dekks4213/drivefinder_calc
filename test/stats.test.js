const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-stats-')), 'test.db');
const store = require('../bot/db');
const stats = require('../bot/stats');

const UID = 7;
store.ensureUser(UID, 'Тест');
store.updateUser(UID, { sex: 'male', age: 30, height_cm: 180, weight_kg: 90, activity: 'moderate', goal: 'cut' });

// День 0 — точно в норму, день 1 — недобор белка, день 2 — еды нет.
const T = store.today();
const D1 = store.daysAgo(1);
const D2 = store.daysAgo(2);
const norm = require('../bot/nutrition').computeTargets(store.getUser(UID));

store.addMeal(UID, { day: T, text: 'в норму', kcal: norm.kcal, protein: norm.protein, fat: norm.fat, carbs: norm.carbs });
store.addMeal(UID, { day: D1, text: 'мало белка', kcal: norm.kcal, protein: Math.round(norm.protein * 0.5), fat: 50, carbs: 200 });
store.addWorkout(UID, { day: T, done: true, title: 'Верх', duration_min: 60 });
store.addWorkout(UID, { day: D1, done: false, excuse: 'устал' });
store.addWeight(UID, 92, D2);
store.addWeight(UID, 90, T);

test('ряд покрывает весь период, включая дни без записей', () => {
  const s = stats.summary(UID, 7);
  assert.strictEqual(s.series.length, 7);
  assert.strictEqual(s.series[s.series.length - 1].day, T, 'последний день — сегодня');
  const empty = s.series.find((d) => d.day === D2);
  assert.strictEqual(empty.kcal, 0, 'день без еды не пропадает, а показывает ноль');
});

test('средние считаются только по дням с записями', () => {
  const s = stats.summary(UID, 7);
  assert.strictEqual(s.food.days_logged, 2);
  assert.strictEqual(s.food.days_missing, 5);
  assert.strictEqual(s.food.avg_kcal, norm.kcal, 'пустые дни не занижают среднее');
});

test('в норму засчитывается только день с добранным белком', () => {
  const s = stats.summary(UID, 7);
  assert.strictEqual(s.food.days_on_target, 1);
  assert.strictEqual(s.food.adherence_pct, 50);
});

test('выполнение тренировок считается от сделанных и слитых', () => {
  const s = stats.summary(UID, 7);
  assert.strictEqual(s.training.done, 1);
  assert.strictEqual(s.training.skipped, 1);
  assert.strictEqual(s.training.completion_pct, 50);
  assert.strictEqual(s.training.total_minutes, 60);
  assert.deepStrictEqual(s.training.excuses.map((e) => e.excuse), ['устал']);
});

test('динамика веса считается от первого замера к последнему', () => {
  const s = stats.summary(UID, 7);
  assert.strictEqual(s.weight.first, 92);
  assert.strictEqual(s.weight.last, 90);
  assert.strictEqual(s.weight.delta, -2);
});

test('пустой профиль не роняет отчёт', () => {
  store.ensureUser(8, 'Новичок');
  const s = stats.summary(8, 30);
  assert.strictEqual(s.food.days_logged, 0);
  assert.strictEqual(s.food.adherence_pct, 0);
  assert.strictEqual(s.training.completion_pct, 0);
  assert.ok(stats.format(s).includes('УЧЁТ ЗА 30 ДНЕЙ'));
});

test('текстовый отчёт содержит ключевые цифры', () => {
  const text = stats.format(stats.summary(UID, 7));
  assert.match(text, /записано 2 из 7/);
  assert.match(text, /сделано 1, пропущено 1/);
  assert.match(text, /92 → 90 кг/);
});
