const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-test-')), 'test.db');
const store = require('../bot/db');

const UID = 1;
store.ensureUser(UID, 'Тест');

test('все миграции применены и записаны в журнал', () => {
  const { MIGRATIONS } = require('../bot/migrations');
  const applied = store.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id);
  assert.deepStrictEqual(applied, MIGRATIONS.map((m) => m.id));
});

test('номера миграций уникальны и идут по возрастанию', () => {
  const { MIGRATIONS } = require('../bot/migrations');
  const ids = MIGRATIONS.map((m) => m.id);
  assert.deepStrictEqual(ids, [...new Set(ids)].sort((a, b) => a - b));
});

test('повторный прогон миграций ничего не меняет', () => {
  const { runMigrations } = require('../bot/migrations');
  const before = store.db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  const res = runMigrations(store.db, process.env.BOT_DB_PATH);
  assert.deepStrictEqual(res.applied, []);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c, before);
});

test('один тренировочный день — одна запись, повтор обновляет её', () => {
  const day = store.today();
  store.addWorkout(UID, { day, done: false, excuse: 'устал' });
  store.addWorkout(UID, { day, done: false, excuse: 'передумал' });
  const rows = store.workoutsOfDay(UID, day);
  assert.strictEqual(rows.length, 1, 'дубль не создался');
  assert.strictEqual(rows[0].excuse, 'передумал', 'отмазка обновилась');
});

test('выполненная тренировка перекрывает записанный прогул и чистит отмазку', () => {
  const day = store.today();
  store.addWorkout(UID, { day, done: true, title: 'Низ A', duration_min: 50 });
  const [w] = store.workoutsOfDay(UID, day);
  assert.strictEqual(w.done, 1);
  assert.strictEqual(w.excuse, null);
  assert.strictEqual(store.trainingStats(UID, 30).skipped, 0);
});

test('еда пишется, правится и удаляется, итоги пересчитываются', () => {
  store.addMeal(UID, { text: 'курица с рисом', kcal: 600, protein: 50, fat: 10, carbs: 70 });
  store.addMeal(UID, { text: 'творог', kcal: 200, protein: 30, fat: 5, carbs: 8 });
  assert.strictEqual(Math.round(store.dayTotals(UID).kcal), 800);

  const meals = store.mealsOfDay(UID);
  assert.ok(meals[0].id, 'у записи есть id для правки');

  assert.strictEqual(store.updateMeal(UID, meals[0].id, { kcal: 500 }), true);
  assert.strictEqual(Math.round(store.dayTotals(UID).kcal), 700);

  assert.strictEqual(store.deleteMeal(UID, meals[1].id), true);
  assert.strictEqual(Math.round(store.dayTotals(UID).kcal), 500);
  assert.strictEqual(store.deleteMeal(UID, 999999), false, 'чужой или несуществующей записи нет');
});

test('чужую запись править нельзя', () => {
  store.ensureUser(2, 'Другой');
  const [mine] = store.mealsOfDay(UID);
  assert.strictEqual(store.deleteMeal(2, mine.id), false);
  assert.strictEqual(store.updateMeal(2, mine.id, { kcal: 1 }), false);
});

test('повторный апдейт Telegram обрабатывается один раз', () => {
  assert.strictEqual(store.markUpdate(555), true);
  assert.strictEqual(store.markUpdate(555), false);
  assert.strictEqual(store.markUpdate(556), true);
});

test('вес за день перезаписывается, а не накапливается', () => {
  store.addWeight(UID, 100);
  store.addWeight(UID, 99.5);
  const series = store.weightSeries(UID, 30);
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].kg, 99.5);
});

test('память не плодит одинаковые факты', () => {
  store.remember(UID, 'тренировки', 'жим 80 на 5');
  store.remember(UID, 'тренировки', 'Жим 80 На 5');
  assert.strictEqual(store.memories(UID, 50).length, 1);
});

test('добавка обновляет дозировку, а не дублируется', () => {
  store.setStackItem(UID, { name: 'креатин', dose: '5 г' });
  store.setStackItem(UID, { name: 'Креатин', dose: '5 г утром' });
  const stack = store.stack(UID);
  assert.strictEqual(stack.length, 1);
  assert.strictEqual(stack[0].dose, '5 г утром');
});

test('история диалога начинается с реплики пользователя', () => {
  store.pushMessage(UID, 'assistant', 'первый ответ без вопроса');
  store.pushMessage(UID, 'user', 'привет');
  store.pushMessage(UID, 'assistant', 'ответ');
  const h = store.history(UID);
  assert.strictEqual(h[0].role, 'user', 'ведущий assistant отброшен');
});
