const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-audit-')), 'test.db');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1:test';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test';
const store = require('../bot/db');

const UID = 5;
store.ensureUser(UID, 'Наблюдаемый');

test('лента разговоров не обрезается вместе с контекстом модели', () => {
  for (let i = 0; i < 60; i += 1) {
    store.pushMessage(UID, 'user', `реплика ${i}`);
    store.logTurn(UID, 'user', `реплика ${i}`);
  }
  const kept = store.db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id = ?').get(UID).c;
  const audited = store.db.prepare('SELECT COUNT(*) c FROM audit WHERE user_id = ?').get(UID).c;

  assert.ok(kept < 60, 'контекст модели должен обрезаться');
  assert.strictEqual(audited, 60, 'лента разбора должна хранить всё');
});

test('проблемные реплики выбираются отдельно', () => {
  store.logTurn(UID, 'user', 'ты меня не слушаешь', 'не слышит человека');
  store.logTurn(UID, 'user', 'обычная реплика');

  const flagged = store.auditFlagged('2000-01-01');
  assert.strictEqual(flagged.length, 1);
  assert.strictEqual(flagged[0].flag, 'не слышит человека');
});

test('лента чистится по сроку хранения', () => {
  store.db.prepare('UPDATE audit SET ts = ? WHERE id = 1').run('2020-01-01T00:00:00.000Z');
  const before = store.db.prepare('SELECT COUNT(*) c FROM audit').get().c;
  const dropped = store.trimAudit(30);
  assert.strictEqual(dropped, 1);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) c FROM audit').get().c, before - 1);
});

test('фразы ухода и спора о цифрах распознаются', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
  const block = /const FRICTION = \[([\s\S]*?)\n\];/.exec(index);
  assert.ok(block, 'список сигналов должен быть в коде');

  const patterns = [...block[1].matchAll(/\[(\/.+?\/i), '(.+?)'\]/g)].map(([, re, label]) => {
    const body = re.slice(1, -2);
    return [new RegExp(body, 'i'), label];
  });
  const match = (text) => (patterns.find(([re]) => re.test(text)) || [null, null])[1];

  assert.strictEqual(match('ты опять спрашиваешь, я же говорил'), 'не слышит человека');
  assert.strictEqual(match('откуда столько калорий, я столько не ел'), 'спорит с цифрами');
  assert.strictEqual(match('удали меня отсюда'), 'собирается уйти');
  assert.strictEqual(match('что поесть в офисе'), null, 'обычный вопрос помечать нельзя');
});
