const fs = require('fs');
const path = require('path');

/**
 * Версионируемая схема. Правило простое: существующие миграции НИКОГДА
 * не редактируются — любое изменение схемы добавляется новым номером.
 * Иначе на чужой базе, где старая версия уже применена, правка молча
 * не выполнится.
 */
const MIGRATIONS = [
  {
    id: 1,
    name: 'initial schema',
    up: (db) =>
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
    dash_token    TEXT,
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

  CREATE TABLE IF NOT EXISTS memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    fact       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_user ON memory(user_id, kind);

  CREATE TABLE IF NOT EXISTS stack (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name    TEXT NOT NULL,
    dose    TEXT,
    note    TEXT,
    since   TEXT NOT NULL,
    active  INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS stack_user ON stack(user_id, active);

  CREATE TABLE IF NOT EXISTS progress_photos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    day       TEXT NOT NULL,
    ts        TEXT NOT NULL,
    file      TEXT NOT NULL,
    file_id   TEXT,
    note      TEXT,
    weight_kg REAL
  );
  CREATE INDEX IF NOT EXISTS photos_user ON progress_photos(user_id, id);

  CREATE TABLE IF NOT EXISTS weights (
    user_id INTEGER NOT NULL,
    day     TEXT NOT NULL,
    kg      REAL NOT NULL,
    PRIMARY KEY (user_id, day)
  );

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
`),
  },
  {
    id: 2,
    name: 'users.dash_token',
    up: (db) => {
      const has = db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'dash_token');
      if (!has) db.exec('ALTER TABLE users ADD COLUMN dash_token TEXT');
    },
  },
  {
    id: 3,
    name: 'usage accounting',
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage (
          user_id    INTEGER NOT NULL,
          day        TEXT NOT NULL,
          requests   INTEGER NOT NULL DEFAULT 0,
          messages   INTEGER NOT NULL DEFAULT 0,
          tokens_in  INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd   REAL    NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, day)
        );
      `),
  },
];

/** Снимок базы перед изменением схемы: откатывать миграции нечем. */
function backupBeforeMigration(db, dbPath, version) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `before-v${version}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

function runMigrations(db, dbPath) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (!pending.length) return { applied: [] };

  // Бэкап, если база уже жила. Проверяем и по таблицам тоже: база,
  // созданная до появления миграций, не имеет записей о версиях,
  // но данные в ней есть.
  const hasUsers = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  const rows = hasUsers ? db.prepare('SELECT COUNT(*) c FROM users').get().c : 0;
  const hadData = applied.size > 0 || rows > 0;
  if (hadData) {
    const file = backupBeforeMigration(db, dbPath, Math.min(...pending.map((m) => m.id)));
    if (file) console.log('бэкап перед миграцией:', file);
  }

  const done = [];
  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
    });
    tx();
    done.push(`${m.id}: ${m.name}`);
  }
  console.log('применены миграции:', done.join(', '));
  return { applied: done };
}

/** Ежедневный снимок с ротацией: бэкап, который некому чистить, кончается диском. */
function backup(db, dbPath, keep = 14) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `coach-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.prepare('VACUUM INTO ?').run(file);

  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('coach-') && f.endsWith('.db'))
    .sort()
    .slice(0, -keep);
  old.forEach((f) => fs.unlinkSync(path.join(dir, f)));

  return { file, removed: old.length };
}

module.exports = { MIGRATIONS, runMigrations, backup };
