const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

const TZ = process.env.BOT_TZ || 'Asia/Vladivostok';
const DB_PATH = process.env.BOT_DB_PATH || path.join(__dirname, '..', 'data', 'coach.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

runMigrations(db, DB_PATH);




const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const today = (d = new Date()) => dayFmt.format(d);
const daysAgo = (n) => today(new Date(Date.now() - n * 86400000));
const nowIso = () => new Date().toISOString();

const HISTORY_LIMIT = 24;

module.exports = {
  db,
  DB_PATH,
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

  /** Вес за день перезаписывается: интересна динамика, а не каждое взвешивание. */
  addWeight(id, kg, day = today()) {
    db.prepare('INSERT INTO weights (user_id, day, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET kg = excluded.kg').run(id, day, kg);
  },

  weightSeries(id, days = 90) {
    return db
      .prepare('SELECT day, kg FROM weights WHERE user_id = ? AND day >= ? ORDER BY day')
      .all(id, daysAgo(days - 1));
  },

  /** Посуточный ряд: еда, тренировка, вес — основа всего учёта. */
  dailySeries(id, days = 30) {
    const from = daysAgo(days - 1);
    const food = db
      .prepare(
        `SELECT day, COUNT(*) AS meals, SUM(kcal) AS kcal, SUM(protein) AS protein, SUM(fat) AS fat, SUM(carbs) AS carbs
         FROM meals WHERE user_id = ? AND day >= ? GROUP BY day`
      )
      .all(id, from);
    const training = db
      .prepare('SELECT day, title, duration_min, done, excuse FROM workouts WHERE user_id = ? AND day >= ?')
      .all(id, from);
    const weights = db.prepare('SELECT day, kg FROM weights WHERE user_id = ? AND day >= ?').all(id, from);

    const byDay = new Map();
    for (let i = 0; i < days; i += 1) {
      const day = daysAgo(days - 1 - i);
      byDay.set(day, { day, meals: 0, kcal: 0, protein: 0, fat: 0, carbs: 0, workout: null, weight: null });
    }
    for (const f of food) if (byDay.has(f.day)) Object.assign(byDay.get(f.day), {
      meals: f.meals, kcal: Math.round(f.kcal), protein: Math.round(f.protein), fat: Math.round(f.fat), carbs: Math.round(f.carbs),
    });
    for (const t of training) if (byDay.has(t.day)) byDay.get(t.day).workout = { title: t.title, minutes: t.duration_min, done: Boolean(t.done), excuse: t.excuse };
    for (const w of weights) if (byDay.has(w.day)) byDay.get(w.day).weight = w.kg;

    return [...byDay.values()];
  },

  /** Личная ссылка на дашборд: токен выдаётся один раз и живёт с пользователем. */
  dashToken(id) {
    const row = db.prepare('SELECT dash_token FROM users WHERE id = ?').get(id);
    if (row && row.dash_token) return row.dash_token;
    const token = require('crypto').randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET dash_token = ? WHERE id = ?').run(token, id);
    return token;
  },

  userByToken(token) {
    return db.prepare('SELECT * FROM users WHERE dash_token = ?').get(token);
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
    return db
      .prepare('SELECT id, text, kcal, protein, fat, carbs, ts FROM meals WHERE user_id = ? AND day = ? ORDER BY id')
      .all(id, day);
  },

  deleteMeal(id, mealId) {
    return db.prepare('DELETE FROM meals WHERE user_id = ? AND id = ?').run(id, mealId).changes > 0;
  },

  updateMeal(id, mealId, f) {
    const keys = ['text', 'kcal', 'protein', 'fat', 'carbs'].filter((k) => f[k] !== undefined && f[k] !== null);
    if (!keys.length) return false;
    const sql = `UPDATE meals SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ? AND id = ?`;
    return db.prepare(sql).run(...keys.map((k) => f[k]), id, mealId).changes > 0;
  },

  lastMeal(id) {
    return db.prepare('SELECT id, text, kcal FROM meals WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);
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

  /** Кому вообще есть что напоминать: профиль заполнен хотя бы до веса. */
  remindableUsers() {
    return db.prepare('SELECT * FROM users WHERE weight_kg IS NOT NULL').all();
  },

  lastWeightDay(id) {
    const row = db.prepare('SELECT day FROM weights WHERE user_id = ? ORDER BY day DESC LIMIT 1').get(id);
    return row ? row.day : null;
  },

  addProgressPhoto(id, { file, fileId, note, weightKg, day }) {
    const info = db
      .prepare('INSERT INTO progress_photos (user_id, day, ts, file, file_id, note, weight_kg) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, day || today(), nowIso(), file, fileId || null, note || null, weightKg || null);
    return info.lastInsertRowid;
  },

  progressPhotos(id, limit = 50) {
    return db
      .prepare('SELECT id, day, ts, file, file_id, note, weight_kg FROM progress_photos WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, limit)
      .reverse();
  },

  progressPhoto(id, photoId) {
    return db.prepare('SELECT * FROM progress_photos WHERE user_id = ? AND id = ?').get(id, photoId);
  },

  /** Одна запись на добавку: повторное добавление правит дозировку. */
  setStackItem(id, { name, dose, note, active = 1 }) {
    const key = name.trim().toLowerCase();
    const existing = db
      .prepare('SELECT id, name FROM stack WHERE user_id = ?')
      .all(id)
      .find((r) => r.name.trim().toLowerCase() === key);
    if (existing) {
      db.prepare('UPDATE stack SET dose = COALESCE(?, dose), note = COALESCE(?, note), active = ? WHERE id = ?').run(dose, note, active, existing.id);
      return existing.id;
    }
    return db
      .prepare('INSERT INTO stack (user_id, name, dose, note, since, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, dose || null, note || null, today(), active).lastInsertRowid;
  },

  stack(id) {
    return db.prepare('SELECT name, dose, note, since, active FROM stack WHERE user_id = ? ORDER BY active DESC, id').all(id);
  },

  /**
   * Долговременная память о пользователе. Похожий факт перезаписывается,
   * иначе за месяц накопится десяток формулировок одного и того же.
   */
  remember(id, kind, fact) {
    // lower() в SQLite работает только с латиницей, поэтому сравниваем в JS.
    const key = fact.trim().toLowerCase();
    const dup = db
      .prepare('SELECT id, fact FROM memory WHERE user_id = ? AND kind = ?')
      .all(id, kind)
      .find((r) => r.fact.trim().toLowerCase() === key);
    if (dup) {
      db.prepare('UPDATE memory SET updated_at = ? WHERE id = ?').run(nowIso(), dup.id);
      return dup.id;
    }
    return db
      .prepare('INSERT INTO memory (user_id, kind, fact, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, kind, fact, nowIso(), nowIso()).lastInsertRowid;
  },

  memories(id, limit = 40) {
    return db
      .prepare('SELECT id, kind, fact, updated_at FROM memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(id, limit);
  },

  forget(id, memoryId) {
    return db.prepare('DELETE FROM memory WHERE user_id = ? AND id = ?').run(id, memoryId).changes > 0;
  },

  /** Расход на пользователя за день: запросы, токены и оценка стоимости. */
  recordUsage(id, { requests = 0, messages = 0, tokensIn = 0, tokensOut = 0, cost = 0 }) {
    db.prepare(
      `INSERT INTO usage (user_id, day, requests, messages, tokens_in, tokens_out, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         requests   = requests + excluded.requests,
         messages   = messages + excluded.messages,
         tokens_in  = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         cost_usd   = cost_usd + excluded.cost_usd`
    ).run(id, today(), requests, messages, tokensIn, tokensOut, cost);
  },

  usageToday(id) {
    return (
      db.prepare('SELECT requests, messages, tokens_in, tokens_out, cost_usd FROM usage WHERE user_id = ? AND day = ?').get(id, today()) || {
        requests: 0,
        messages: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      }
    );
  },

  usageTotalToday() {
    return (
      db
        .prepare('SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(messages),0) messages, COALESCE(SUM(cost_usd),0) cost_usd, COUNT(*) users FROM usage WHERE day = ?')
        .get(today()) || { requests: 0, messages: 0, cost_usd: 0, users: 0 }
    );
  },

  usersWithPlan() {
    return db.prepare('SELECT * FROM users WHERE plan_json IS NOT NULL').all();
  },
};
