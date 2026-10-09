const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-access-')), 'test.db');
process.env.FREE_ACCESS_SLOTS = '3';
const store = require('../bot/db');

test('первые места раздаются бесплатно, дальше доступа нет', () => {
  for (const id of [101, 102, 103]) store.ensureUser(id, `Ранний ${id}`);
  assert.deepStrictEqual(store.freeSlots(), { used: 3, total: 3, left: 0 });
  for (const id of [101, 102, 103]) {
    assert.deepStrictEqual(store.access(id), { ok: true, kind: 'free' });
  }

  store.ensureUser(201, 'Поздний');
  assert.strictEqual(store.access(201).ok, false);
  assert.strictEqual(store.access(201).kind, 'new');
});

test('проба выдаётся один раз и открывает доступ на свой срок', () => {
  store.ensureUser(202, 'Пробный');
  const until = store.startTrial(202, 3);
  assert.ok(until, 'проба должна выдаться');
  assert.strictEqual(store.access(202).kind, 'trial');
  assert.strictEqual(store.startTrial(202, 3), null, 'повторная проба запрещена');
});

test('истёкшая проба закрывает доступ, оплата открывает', () => {
  store.ensureUser(203, 'Истёкший');
  store.startTrial(203, 3);
  store.db.prepare('UPDATE users SET trial_until = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', 203);
  assert.deepStrictEqual(store.access(203), {
    ok: false,
    kind: 'trial_over',
    until: '2020-01-01T00:00:00.000Z',
  });

  const until = new Date(Date.now() + 86400000).toISOString();
  store.setPaidUntil(203, until);
  store.addPayment(203, { charge_id: 'ch_1', stars: 500, paid_until: until });
  assert.deepStrictEqual(store.access(203), { ok: true, kind: 'paid', until });
  assert.strictEqual(store.payments(203)[0].stars, 500);
});

test('кончившаяся подписка закрывает доступ', () => {
  store.ensureUser(204, 'Отвалившийся');
  store.setPaidUntil(204, '2020-01-01T00:00:00.000Z');
  assert.strictEqual(store.access(204).ok, false);
  assert.strictEqual(store.access(204).kind, 'expired');
});

test('бесплатное место не отбирается оплатой и не требует её', () => {
  assert.strictEqual(store.startTrial(101, 3), null);
  assert.deepStrictEqual(store.access(101), { ok: true, kind: 'free' });
});
