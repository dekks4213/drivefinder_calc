const { GoogleGenAI } = require('@google/genai');

const store = require('./db');
const { computeTargets } = require('./nutrition');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.COACH_MODEL || 'gemini-flash-latest';
const MAX_DAYS = Number(process.env.IMPORT_MAX_DAYS) || 30;

/** Текст сообщения в экспорте бывает строкой или массивом кусков. */
function plainText(text) {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  return '';
}

/**
 * Экспорт Telegram Desktop: result.json со списком сообщений.
 * Берём только реплики человека — ответы бота это его же выводы,
 * и переносить их обратно значит удваивать ошибки.
 */
function parseExport(json, userId) {
  const messages = Array.isArray(json.messages) ? json.messages : [];
  const byDay = new Map();

  for (const m of messages) {
    if (m.type !== 'message') continue;
    const text = plainText(m.text).trim();
    const photo = Boolean(m.photo);
    if (!text && !photo) continue;
    // У бота в Telegram тоже user-идентификатор, поэтому отбираем строго
    // по владельцу переписки, иначе ответы бота попадут в дневник.
    if (String(m.from_id) !== `user${userId}`) continue;

    const day = String(m.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(photo && !text ? '[фото без подписи]' : text);
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-MAX_DAYS);
  return { days, total: messages.length };
}

const SCHEMA = {
  type: 'object',
  properties: {
    profile: {
      type: 'object',
      properties: {
        sex: { type: 'string', enum: ['male', 'female'] },
        age: { type: 'integer' },
        height_cm: { type: 'number' },
        weight_kg: { type: 'number' },
        activity: { type: 'string', enum: ['sedentary', 'light', 'moderate', 'high', 'athlete'] },
        goal: { type: 'string', enum: ['cut', 'recomp', 'maintain', 'bulk'] },
        days_per_week: { type: 'integer' },
        location: { type: 'string', enum: ['gym', 'home'] },
      },
    },
    meals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string' },
          text: { type: 'string' },
          kcal: { type: 'number' },
          protein: { type: 'number' },
          fat: { type: 'number' },
          carbs: { type: 'number' },
        },
        required: ['day', 'text', 'kcal', 'protein', 'fat', 'carbs'],
      },
    },
    workouts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string' },
          done: { type: 'boolean' },
          title: { type: 'string' },
          excuse: { type: 'string' },
        },
        required: ['day', 'done'],
      },
    },
    weights: {
      type: 'array',
      items: {
        type: 'object',
        properties: { day: { type: 'string' }, kg: { type: 'number' } },
        required: ['day', 'kg'],
      },
    },
    memory: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['тренировки', 'питание', 'здоровье', 'режим', 'психология', 'прочее'] },
          fact: { type: 'string' },
        },
        required: ['kind', 'fact'],
      },
    },
  },
};

const PROMPT = `Ты разбираешь переписку человека с ботом-тренером и восстанавливаешь из неё дневник.

Правила:
- Берёшь только то, что человек прямо написал о себе: параметры, съеденную еду, тренировки, вес.
- Калории и БЖУ оцениваешь по описанию еды, как это делает нутрициолог. Это оценка, и она лучше, чем пустой день.
- Одно и то же блюдо, описанное в нескольких сообщениях подряд, — одна запись, а не три.
- Дату берёшь из заголовка дня, в котором сообщение написано.
- Намерения не считаются: «пойду поем» и «завтра схожу в зал» в дневник не идут. Только то, что уже произошло.
- Фото без подписи пропускаешь: что на нём было, уже не узнать.
- В память выноси устойчивые факты о человеке: рабочие веса, травмы, что не ест, график. Разовые реплики туда не идут.`;

async function extract(days) {
  const transcript = days.map(([day, lines]) => `=== ${day} ===\n${lines.join('\n')}`).join('\n\n');

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: `${PROMPT}\n\nПЕРЕПИСКА:\n${transcript}` }] }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      maxOutputTokens: 8192,
      abortSignal: AbortSignal.timeout(Number(process.env.IMPORT_TIMEOUT_MS) || 120000),
    },
  });

  const text = (res.candidates?.[0]?.content?.parts || [])
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('');
  return JSON.parse(text);
}

const MARK = ' (из истории)';

/** Переносит разобранное в базу, не затирая то, что уже записано. */
function apply(userId, data) {
  const added = { meals: 0, workouts: 0, weights: 0, memory: 0, profile: false };

  if (data.profile && Object.keys(data.profile).length) {
    store.updateUser(userId, data.profile);
    const targets = computeTargets(store.getUser(userId));
    if (!targets.missing) store.setTargets(userId, targets);
    added.profile = true;
  }

  for (const m of data.meals || []) {
    const existing = store.mealsOfDay(userId, m.day);
    const marked = `${String(m.text).trim()}${MARK}`;
    const dup = existing.some((e) => e.text.trim().toLowerCase() === marked.toLowerCase());
    if (dup) continue;
    store.addMeal(userId, { ...m, text: marked });
    added.meals += 1;
  }

  for (const w of data.workouts || []) {
    store.addWorkout(userId, w);
    added.workouts += 1;
  }

  for (const w of data.weights || []) {
    store.addWeight(userId, w.kg, w.day);
    added.weights += 1;
  }

  for (const f of data.memory || []) {
    store.remember(userId, f.kind, f.fact);
    added.memory += 1;
  }

  return added;
}

async function importExport(userId, json) {
  const { days, total } = parseExport(json, userId);
  if (!days.length) return { ok: false, reason: 'в файле нет сообщений от человека' };

  const data = await extract(days);
  const added = apply(userId, data);
  return { ok: true, days: days.length, messages: total, added };
}

module.exports = { parseExport, apply, importExport };
