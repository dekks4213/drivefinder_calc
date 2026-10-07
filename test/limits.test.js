const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-lim-')), 'test.db');
const store = require('../bot/db');

store.ensureUser(10, 'А');
store.ensureUser(11, 'Б');

test('расход копится по пользователю и по дню', () => {
  store.recordUsage(10, { requests: 1, messages: 1, tokensIn: 4000, tokensOut: 500, cost: 0.005 });
  store.recordUsage(10, { requests: 2, tokensIn: 8000, tokensOut: 900, cost: 0.011 });
  const u = store.usageToday(10);
  assert.strictEqual(u.requests, 3);
  assert.strictEqual(u.messages, 1);
  assert.strictEqual(u.tokens_in, 12000);
  assert.ok(Math.abs(u.cost_usd - 0.016) < 1e-9);
});

test('общий расход складывается по всем пользователям', () => {
  store.recordUsage(11, { requests: 1, messages: 1, cost: 0.004 });
  const t = store.usageTotalToday();
  assert.strictEqual(t.users, 2);
  assert.strictEqual(t.messages, 2);
  assert.ok(Math.abs(t.cost_usd - 0.02) < 1e-9);
});

test('у нового пользователя расход нулевой, а не undefined', () => {
  const u = store.usageToday(999);
  assert.strictEqual(u.messages, 0);
  assert.strictEqual(u.cost_usd, 0);
});
