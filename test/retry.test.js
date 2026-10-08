const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-r-')), 'test.db');
process.env.GEMINI_API_KEY = 'test';
const { retryTransient, isTransient } = require('../bot/coach');

test('перегрузка и внутренние ошибки распознаются как временные', () => {
  assert.ok(isTransient({ status: 503, message: 'The service is currently unavailable.' }));
  assert.ok(isTransient({ message: '{"error":{"code":503,"status":"UNAVAILABLE"}}' }));
  assert.ok(isTransient({ status: 500, message: 'INTERNAL' }));
  assert.ok(!isTransient({ status: 400, message: 'bad request' }));
  assert.ok(!isTransient({ message: 'RESOURCE_EXHAUSTED' }), 'квота лечится не повтором, а запасной моделью');
});

test('временный сбой повторяется и отдаёт результат', async () => {
  let calls = 0;
  const res = await retryTransient(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
      return 'готово';
    },
    3,
    [1, 1]
  );
  assert.strictEqual(res, 'готово');
  assert.strictEqual(calls, 3);
});

test('постоянная ошибка не повторяется впустую', async () => {
  let calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { status: 400 });
    }, 3, [1, 1])
  );
  assert.strictEqual(calls, 1, 'на 400 повторов быть не должно');
});

test('после исчерпания попыток ошибка пробрасывается', async () => {
  let calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls += 1;
      throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
    }, 3, [1, 1]),
    /UNAVAILABLE/
  );
  assert.strictEqual(calls, 3);
});
