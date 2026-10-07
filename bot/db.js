const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TZ = process.env.BOT_TZ || 'Europe/Moscow';
const DB_PATH = process.env.BOT_DB_PATH || path.join(__dirname, '..', 'data', 'coach.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    name          TEXT,
    sex           TEXT,
    age           INTEGER,
    height_cm     REAL,
    weight_kg     REAL,
    activity      TEXT,
    goal          TEXT,
    days_per_week INTEGER,
    location      TEXT,
    targets_json  TEXT,
    plan_json     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meals (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day     TEXT NOT NULL,
    ts      TEXT NOT NULL,
    text    TEXT NOT NULL,
    kcal    REAL NOT NULL,
    protein REAL NOT NULL,
    fat     REAL NOT NULL,
    carbs   REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meals_user_day ON meals(user_id, day);

  CREATE TABLE IF NOT EXISTS workouts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    day          TEXT NOT NULL,
    ts           TEXT NOT NULL,
    title        TEXT,
    duration_min INTEGER,
    done         INTEGER NOT NULL,
    excuse       TEXT,
    notes        TEXT
  );
  CREATE INDEX IF NOT EXISTS workouts_user_day ON workouts(user_id, day);

  CREATE TABLE IF NOT EXISTS seen_updates (
    update_id INTEGER PRIMARY KEY,
    ts        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role    TEXT NOT NULL,
    text    TEXT NOT NULL,
    ts      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, id);
`);

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const today = (d = new Date()) => dayFmt.format(d);
const daysAgo = (n) => today(new Date(Date.now() - n * 86400000));
const nowIso = () => new Date().toISOString();

const HISTORY_LIMIT = 24;

module.exports = {
  db,
  TZ,
  today,
  daysAgo,

  getUser(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  ensureUser(id, name) {
    db.prepare(
      `INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, users.name)`
    ).run(id, name || null, nowIso(), nowIso());
    return this.getUser(id);
  },

  updateUser(id, fields) {
    const allowed = ['name', 'sex', 'age', 'height_cm', 'weight_kg', 'activity', 'goal', 'days_per_week', 'location'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k) && fields[k] !== undefined && fields[k] !== null);
    if (keys.length) {
      const sql = `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
      db.prepare(sql).run(...keys.map((k) => fields[k]), nowIso(), id);
    }
    return this.getUser(id);
  },

  setTargets(id, targets) {
    db.prepare('UPDATE users SET targets_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(targets), nowIso(), id);
  },

  setPlan(id, plan) {
    db.prepare('UPDATE users SET plan_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), nowIso(), id);
  },

  addMeal(id, meal) {
    db.prepare(
      'INSERT INTO meals (user_id, day, ts, text, kcal, protein, fat, carbs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, meal.day || today(), nowIso(), meal.text, meal.kcal, meal.protein, meal.fat, meal.carbs);
  },

  /**
   * Один тренировочный день — одна запись. Повторный вызов обновляет её,
   * иначе модель за диалог плодит дубли и статистика прогулов врёт.
   * Выполненная тренировка перекрывает ранее записанный пропуск.
   */
  addWorkout(id, w) {
    const day = w.day || today();
    const existing = db.prepare('SELECT * FROM workouts WHERE user_id = ? AND day = ? ORDER BY id LIMIT 1').get(id, day);
    const done = w.done ? 1 : 0;

    if (existing) {
      db.prepare(
        `UPDATE workouts SET ts = ?, done = ?, title = ?, duration_min = ?, excuse = ?, notes = ? WHERE id = ?`
      ).run(
        nowIso(),
        done,
        w.title || existing.title,
        w.duration_min || existing.duration_min,
        done ? null : w.excuse || existing.excuse,
        w.notes || existing.notes,
        existing.id
      );
      return { updated: true, day };
    }

    db.prepare(
      'INSERT INTO workouts (user_id, day, ts, title, duration_min, done, excuse, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, day, nowIso(), w.title || null, w.duration_min || null, done, w.excuse || null, w.notes || null);
    return { updated: false, day };
  },

  dayTotals(id, day = today()) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS meals, COALESCE(SUM(kcal),0) AS kcal, COALESCE(SUM(protein),0) AS protein,
                COALESCE(SUM(fat),0) AS fat, COALESCE(SUM(carbs),0) AS carbs
         FROM meals WHERE user_id = ? AND day = ?`
      )
      .get(id, day);
    return { day, ...row };
  },

  mealsOfDay(id, day = today()) {
    return db.prepare('SELECT text, kcal, protein, fat, carbs, ts FROM meals WHERE user_id = ? AND day = ? ORDER BY id').all(id, day);
  },

  diary(id, days = 7) {
    const from = daysAgo(days - 1);
    const food = db
      .prepare(
        `SELECT day, COUNT(*) AS meals, ROUND(SUM(kcal)) AS kcal, ROUND(SUM(protein)) AS protein,
                ROUND(SUM(fat)) AS fat, ROUND(SUM(carbs)) AS carbs
         FROM meals WHERE user_id = ? AND day >= ? GROUP BY day ORDER BY day DESC`
      )
      .all(id, from);
    const training = db
      .prepare(
        `SELECT day, title, duration_min, done, excuse FROM workouts
         WHERE user_id = ? AND day >= ? ORDER BY day DESC, id DESC`
      )
      .all(id, from);
    return { from, to: today(), food, training };
  },

  trainingStats(id, days = 30) {
    const from = daysAgo(days - 1);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(done),0) AS done, COALESCE(SUM(1 - done),0) AS skipped
         FROM workouts WHERE user_id = ? AND day >= ?`
      )
      .get(id, from);
    const last = db
      .prepare('SELECT day, title, done, excuse FROM workouts WHERE user_id = ? AND done = 1 ORDER BY day DESC, id DESC LIMIT 1')
      .get(id);
    const recentSkips = db
      .prepare('SELECT day, excuse FROM workouts WHERE user_id = ? AND done = 0 ORDER BY day DESC, id DESC LIMIT 5')
      .all(id);
    const lastDone = last ? last.day : null;
    const daysSince = lastDone ? Math.round((Date.parse(today()) - Date.parse(lastDone)) / 86400000) : null;
    return { window_days: days, done: row.done, skipped: row.skipped, last_workout: lastDone, days_since_last: daysSince, recent_skips: recentSkips };
  },

  workoutsOfDay(id, day = today()) {
    return db.prepare('SELECT title, duration_min, done, excuse FROM workouts WHERE user_id = ? AND day = ?').all(id, day);
  },

  history(id) {
    const rows = db
      .prepare('SELECT role, text FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, HISTORY_LIMIT)
      .reverse();
    while (rows.length && rows[0].role !== 'user') rows.shift();
    return rows.map((r) => ({ role: r.role, content: r.text }));
  },

  pushMessage(id, role, text) {
    db.prepare('INSERT INTO messages (user_id, role, text, ts) VALUES (?, ?, ?, ?)').run(id, role, text, nowIso());
    db.prepare(
      `DELETE FROM messages WHERE user_id = ? AND id NOT IN
       (SELECT id FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
    ).run(id, id, HISTORY_LIMIT * 2);
  },

  /**
   * Telegram перевыдаёт апдейт, если бот упал до подтверждения offset.
   * Без этой защиты один «съел пиццу» ляжет в дневник дважды.
   * @returns {boolean} true — апдейт новый и его надо обработать
   */
  markUpdate(updateId) {
    if (updateId === undefined || updateId === null) return true;
    const res = db.prepare('INSERT OR IGNORE INTO seen_updates (update_id, ts) VALUES (?, ?)').run(updateId, nowIso());
    if (!res.changes) return false;
    db.prepare(
      `DELETE FROM seen_updates WHERE update_id NOT IN
       (SELECT update_id FROM seen_updates ORDER BY update_id DESC LIMIT 1000)`
    ).run();
    return true;
  },

  clearHistory(id) {
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(id);
  },

  usersWithPlan() {
    return db.prepare('SELECT * FROM users WHERE plan_json IS NOT NULL').all();
  },
};
