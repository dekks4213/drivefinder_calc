const test = require('node:test');
const assert = require('node:assert');
const { FOODS, options } = require('../bot/foods');

test('справочник не выродился в три продукта', () => {
  assert.ok(FOODS.length >= 25, `продуктов ${FOODS.length}`);
  const names = FOODS.map((f) => f.name);
  assert.strictEqual(new Set(names).size, names.length, 'дубликатов нет');
});

test('у каждого продукта есть белок, калории и метки', () => {
  for (const f of FOODS) {
    assert.ok(f.protein > 0, `${f.name}: нет белка`);
    assert.ok(f.kcal > 0, `${f.name}: нет калорий`);
    assert.ok(f.tags.length, `${f.name}: нет меток`);
    const fromMacros = f.protein * 4 + f.fat * 9;
    assert.ok(fromMacros <= f.kcal + 30, `${f.name}: белок с жиром дают больше калорий, чем заявлено`);
  }
});

test('ситуация фильтрует выдачу', () => {
  for (const situation of ['офис', 'кафе', 'веган', 'готовка']) {
    const items = options({ situation, limit: 20 });
    assert.ok(items.length, `${situation}: пусто`);
  }
  const office = options({ situation: 'офис', limit: 20 });
  assert.ok(office.every((i) => i.tags.includes('офис')), 'в офисной выдаче только офисное');
});

test('исключённое не предлагается', () => {
  const items = options({ exclude: ['творог', 'тунец', 'грудка'], limit: 30 });
  const names = items.map((i) => i.name.toLowerCase()).join(' ');
  assert.ok(!names.includes('творог'));
  assert.ok(!names.includes('тунец'));
  assert.ok(!names.includes('грудка'));
});

test('выдача перемешивается, иначе советы повторяются', () => {
  const runs = new Set();
  for (let i = 0; i < 12; i += 1) runs.add(options({ limit: 4 }).map((x) => x.name).join('|'));
  assert.ok(runs.size > 1, 'порядок меняется от вызова к вызову');
});

test('если исключили всё подряд, список не схлопывается в пустоту', () => {
  const items = options({ exclude: FOODS.map((f) => f.name), limit: 5 });
  assert.ok(items.length > 0, 'есть запасной вариант вместо пустого ответа');
});
