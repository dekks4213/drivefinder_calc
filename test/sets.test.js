const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-sets-')), 'test.db');
const store = require('../bot/db');

const UID = 7;
store.ensureUser(UID, 'Жимовой');

test('регистр и кириллица не плодят разные упражнения', () => {
  store.addSet(UID, { exercise: 'Жим лёжа', weight_kg: 60, reps: 8, sets: 4, day: '2026-10-01' });
  store.addSet(UID, { exercise: 'жим лёжа', weight_kg: 62.5, reps: 7, sets: 4, day: '2026-10-05' });
  store.addSet(UID, { exercise: 'ЖИМ ЛЁЖА', weight_kg: 65, reps: 5, sets: 3, day: '2026-10-07' });

  const tracked = store.trackedExercises(UID);
  assert.strictEqual(tracked.length, 1, 'упражнение должно быть одно');
  assert.strictEqual(tracked[0].entries, 3);
});

test('прошлый раз берётся из последнего дня до сегодня', () => {
  const last = store.lastSession(UID, 'Жим Лёжа');
  assert.strictEqual(last.day, '2026-10-07');
  assert.strictEqual(last.sets[0].weight_kg, 65);
});

test('сегодняшние подходы в прошлый раз не попадают', () => {
  store.addSet(UID, { exercise: 'жим лёжа', weight_kg: 67.5, reps: 5, sets: 3 });
  assert.strictEqual(store.lastSession(UID, 'жим лёжа').day, '2026-10-07');
  assert.strictEqual(store.setsOfDay(UID).length, 1);
});

test('рекорд — по весу, при равном весе по повторам', () => {
  store.addSet(UID, { exercise: 'Приседания', weight_kg: 80, reps: 5, day: '2026-10-02' });
  store.addSet(UID, { exercise: 'Приседания', weight_kg: 80, reps: 8, day: '2026-10-06' });
  store.addSet(UID, { exercise: 'Приседания', weight_kg: 75, reps: 12, day: '2026-10-08' });

  const rec = store.record(UID, 'приседания');
  assert.strictEqual(rec.weight_kg, 80);
  assert.strictEqual(rec.reps, 8);
});

test('свой вес пишется без веса снаряда и не ломает рекорд', () => {
  store.addSet(UID, { exercise: 'Подтягивания', reps: 12, sets: 4, day: '2026-10-06' });
  assert.strictEqual(store.record(UID, 'подтягивания'), null);
  assert.strictEqual(store.lastSession(UID, 'подтягивания').sets[0].reps, 12);
});

test('истории нет — прошлый раз и рекорд пустые', () => {
  assert.strictEqual(store.lastSession(UID, 'тяга штанги'), null);
  assert.strictEqual(store.record(UID, 'тяга штанги'), null);
});
