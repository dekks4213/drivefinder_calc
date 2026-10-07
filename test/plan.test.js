const test = require('node:test');
const assert = require('node:assert');
const { buildPlan, formatPlan, dayFor } = require('../bot/plan');

test('количество дней в плане совпадает с запрошенным и зажимается в 2-6', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    assert.strictEqual(buildPlan({ days_per_week: n, location: 'gym' }).days.length, n);
  }
  assert.strictEqual(buildPlan({ days_per_week: 9, location: 'gym' }).days.length, 6);
  assert.strictEqual(buildPlan({ days_per_week: 1, location: 'gym' }).days.length, 2);
});

test('дни недели не повторяются', () => {
  const plan = buildPlan({ days_per_week: 5, location: 'gym' });
  const weekdays = plan.days.map((d) => d.weekday);
  assert.strictEqual(new Set(weekdays).size, weekdays.length);
});

test('у каждого упражнения есть название, подходы и запрос в каталог картинок', () => {
  for (const place of ['gym', 'home']) {
    for (const d of buildPlan({ days_per_week: 6, location: place }).days) {
      assert.ok(d.exercises.length >= 4, `${d.title}: мало упражнений`);
      for (const e of d.exercises) {
        assert.ok(e.name && e.sets, `${d.title}: упражнение без названия или подходов`);
        assert.match(e.q, /^[a-z0-9 -]+$/, `${d.title}/${e.name}: запрос «${e.q}» должен быть латиницей`);
      }
    }
  }
});

test('домашний план не требует штанги и тренажёров', () => {
  const home = buildPlan({ days_per_week: 4, location: 'home' });
  const names = home.days.flatMap((d) => d.exercises.map((e) => e.name.toLowerCase())).join(' ');
  assert.ok(!names.includes('штанг'), 'дома штанги быть не должно');
});

test('кардио подбирается под цель', () => {
  assert.notStrictEqual(
    buildPlan({ days_per_week: 3, location: 'gym', goal: 'cut' }).cardio,
    buildPlan({ days_per_week: 3, location: 'gym', goal: 'bulk' }).cardio
  );
});

test('формат плана содержит дни и прогрессию', () => {
  const text = formatPlan(buildPlan({ days_per_week: 3, location: 'gym', goal: 'cut' }));
  assert.match(text, /3 тренировки в неделю, зал/);
  assert.match(text, /Прогрессия:/);
  assert.match(text, /Кардио:/);
});

test('планы старого формата со строками вместо объектов не ломают вывод', () => {
  const legacy = { days_per_week: 2, location: 'gym', days: [{ weekday: 'пн', title: 'Фулбоди', exercises: ['Приседания 4x8'] }], cardio: '-', progression: '-' };
  assert.match(formatPlan(legacy), /Приседания 4x8/);
});

test('тренировочный день определяется по дню недели', () => {
  const plan = buildPlan({ days_per_week: 6, location: 'gym' });
  const monday = new Date('2026-10-05T06:00:00Z'); // понедельник
  assert.ok(dayFor(plan, monday, 'Asia/Vladivostok'), 'в понедельник при шести днях тренировка есть');
});
