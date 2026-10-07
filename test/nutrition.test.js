const test = require('node:test');
const assert = require('node:assert');
const { computeTargets } = require('../bot/nutrition');

const base = { sex: 'male', age: 30, height_cm: 180, weight_kg: 80, activity: 'moderate', goal: 'maintain' };

test('неполный профиль не даёт цифр, а называет чего не хватает', () => {
  const r = computeTargets({ sex: 'male', age: 30 });
  assert.deepStrictEqual(r.missing, ['height_cm', 'weight_kg', 'activity', 'goal']);
  assert.strictEqual(r.kcal, undefined);
});

test('Mifflin-St Jeor для мужчины', () => {
  // 10*80 + 6.25*180 - 5*30 + 5 = 1780
  assert.strictEqual(computeTargets(base).bmr, 1780);
});

test('у женщины обмен ниже на 166 ккал при тех же данных', () => {
  const m = computeTargets(base).bmr;
  const f = computeTargets({ ...base, sex: 'female' }).bmr;
  assert.strictEqual(m - f, 166);
});

test('коэффициент активности умножает обмен покоя', () => {
  const t = computeTargets(base);
  assert.strictEqual(t.tdee, Math.round(t.bmr * 1.55));
});

test('сушка режет от поддержки, масса добавляет', () => {
  const cut = computeTargets({ ...base, goal: 'cut' });
  const bulk = computeTargets({ ...base, goal: 'bulk' });
  const keep = computeTargets(base);
  assert.ok(cut.kcal < keep.kcal, 'на сушке калорий меньше');
  assert.ok(bulk.kcal > keep.kcal, 'на массе больше');
  assert.strictEqual(cut.kcal, Math.round((keep.tdee * 0.8) / 10) * 10);
});

test('нижний порог калорий не пробивается даже у мелкого человека на сушке', () => {
  const tiny = computeTargets({ sex: 'female', age: 25, height_cm: 150, weight_kg: 45, activity: 'sedentary', goal: 'cut' });
  assert.ok(tiny.kcal >= 1300, `получили ${tiny.kcal}, ожидали не ниже 1300`);
});

test('белок считается от веса и растёт на сушке', () => {
  assert.strictEqual(computeTargets({ ...base, goal: 'cut' }).protein, Math.round(80 * 2.2));
  assert.strictEqual(computeTargets(base).protein, Math.round(80 * 1.8));
});

test('БЖУ сходится с калорийностью с точностью до округления', () => {
  for (const goal of ['cut', 'recomp', 'maintain', 'bulk']) {
    const t = computeTargets({ ...base, goal });
    const fromMacros = t.protein * 4 + t.fat * 9 + t.carbs * 4;
    assert.ok(Math.abs(fromMacros - t.kcal) <= 15, `${goal}: по БЖУ ${fromMacros}, в норме ${t.kcal}`);
  }
});

test('углеводы не уходят в минус при жёстком дефиците', () => {
  const t = computeTargets({ sex: 'male', age: 40, height_cm: 165, weight_kg: 120, activity: 'sedentary', goal: 'cut' });
  assert.ok(t.carbs >= 60, `углеводов ${t.carbs}`);
  assert.ok(t.fat > 0, 'жиры положительные');
});
