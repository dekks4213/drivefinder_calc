const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const API = 'https://wger.de/api/v2';
const CACHE_DIR = process.env.BOT_CACHE_DIR || path.join(__dirname, '..', 'data', 'cache');
const CATALOG_FILE = path.join(CACHE_DIR, 'exercises.json');
const CATALOG_TTL_MS = 7 * 86400000;
const MAP_WIDTH = 420;

fs.mkdirSync(path.join(CACHE_DIR, 'svg'), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, 'maps'), { recursive: true });

const MUSCLES_RU = {
  1: 'бицепс',
  2: 'передняя дельта',
  3: 'передняя зубчатая',
  4: 'грудные',
  5: 'трицепс',
  6: 'пресс',
  7: 'икроножные',
  8: 'ягодичные',
  9: 'трапеция',
  10: 'квадрицепс',
  11: 'бицепс бедра',
  12: 'широчайшие',
  13: 'плечевая',
  14: 'косые пресса',
  15: 'камбаловидная',
};

const LANG_ORDER = { 2: 0, 5: 1 };
const langRank = (id) => (LANG_ORDER[id] === undefined ? 9 : LANG_ORDER[id]);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Каталог упражнений wger: только те, у которых есть фото. Кэш на диске. */
async function loadCatalog() {
  if (fs.existsSync(CATALOG_FILE) && Date.now() - fs.statSync(CATALOG_FILE).mtimeMs < CATALOG_TTL_MS) {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  }

  const muscleList = (await getJson(`${API}/muscle/?limit=50&format=json`)).results;
  const muscles = Object.fromEntries(muscleList.map((m) => [m.id, m]));

  const exercises = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const page = await getJson(`${API}/exerciseinfo/?limit=200&offset=${offset}&format=json`);
    for (const e of page.results) {
      if (!e.images || !e.images.length) continue;
      exercises.push({
        id: e.id,
        // Английский первым, затем русский — иначе в карточку лезет испанский или немецкий.
        names: e.translations
          .filter((t) => t.name)
          .sort((a, b) => langRank(a.language) - langRank(b.language))
          .map((t) => t.name),
        description: (e.translations.find((t) => t.language === 2) || {}).description || '',
        category: e.category && e.category.name,
        muscles: (e.muscles || []).map((m) => m.id),
        secondary: (e.muscles_secondary || []).map((m) => m.id),
        equipment: (e.equipment || []).map((q) => q.name),
        images: e.images.map((i) => ({ url: i.image, main: Boolean(i.is_main) })),
        author: e.license_author || 'wger community',
        license: (e.license && e.license.short_name) || 'CC-BY-SA',
      });
    }
    if (!page.next) break;
  }

  const catalog = { muscles, exercises, built_at: new Date().toISOString() };
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog));
  return catalog;
}

/** Лишние уточнения в названии штрафуются: на «bench press» нужен
 *  классический жим, а не «Decline Bench Press Barbell». */
function scoreName(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  const nWords = n.split(/\s+/);
  const hits = qWords.filter((w) => n.includes(w)).length;

  let score;
  if (n === q) score = 100;
  else if (n.startsWith(q)) score = 85;
  else if (n.includes(q)) score = 70;
  else if (qWords.length && hits === qWords.length) score = 60;
  else score = qWords.length ? (hits / qWords.length) * 45 : 0;

  // Название целиком укладывается в запрос — это базовое движение,
  // а не вариация: «bench press» при запросе «barbell bench press».
  if (nWords.every((w) => q.includes(w))) score += 30;

  return score - 4 * Math.max(0, nWords.length - qWords.length);
}

/** Поиск по английскому названию; при пустом результате — добор по группе мышц. */
async function search(query, muscleIds = []) {
  const { exercises } = await loadCatalog();
  let found = exercises
    .map((e) => ({ e, score: Math.max(...e.names.map((n) => scoreName(n, query || '')), 0) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);

  if (!found.length && muscleIds.length) {
    found = exercises.filter((e) => e.muscles.some((m) => muscleIds.includes(m)));
  }
  return found.slice(0, 5);
}

/** Телеграм принимает фото буфером; заодно это и есть проверка ссылки. */
async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return { ok: false, reason: `не картинка (${type})` };

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 9 * 1024 * 1024) return { ok: false, reason: 'больше 9 МБ' };

  // Отсев заглушек и битых миниатюр: такую картинку отправлять бессмысленно.
  const meta = await sharp(buf).metadata();
  if (!meta.width || meta.width < 250 || meta.height < 250) {
    return { ok: false, reason: `слишком мелкая (${meta.width}x${meta.height})` };
  }

  // webp Telegram как фото не принимает, а прозрачный фон без подложки
  // становится чёрным прямоугольником — поэтому flatten перед jpeg.
  const jpeg = await sharp(buf).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();

  // Пустая заливка: картинка есть, а смотреть не на что.
  const stats = await sharp(jpeg).stats();
  const spread = Math.max(...stats.channels.map((c) => c.stdev));
  if (spread < 8) return { ok: false, reason: 'однотонная картинка, смотреть нечего' };

  return { ok: true, buffer: jpeg, bytes: jpeg.length };
}

async function svgFor(url) {
  const file = path.join(CACHE_DIR, 'svg', path.basename(new URL(url).pathname));
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`svg ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

async function side(isFront, mainIds, secondaryIds, muscles) {
  const base = `https://wger.de/static/images/muscles/${isFront ? 'muscular_system_front' : 'muscular_system_back'}.svg`;
  const body = await sharp(await svgFor(base), { density: 300 }).resize({ width: MAP_WIDTH }).png().toBuffer();

  const layers = [];
  for (const [ids, key] of [[mainIds, 'image_url_main'], [secondaryIds, 'image_url_secondary']]) {
    for (const id of ids) {
      const m = muscles[id];
      if (!m || m.is_front !== isFront || !m[key]) continue;
      layers.push({
        input: await sharp(await svgFor(m[key]), { density: 300 }).resize({ width: MAP_WIDTH }).png().toBuffer(),
        blend: 'over',
      });
    }
  }
  return sharp(body).composite(layers).png().toBuffer();
}

/** Схема задействованных мышц: вид спереди и сзади одной картинкой. */
async function muscleMap(mainIds = [], secondaryIds = []) {
  const { muscles } = await loadCatalog();
  const key = `m${mainIds.join('-')}_s${secondaryIds.join('-')}.jpg`;
  const file = path.join(CACHE_DIR, 'maps', key);
  if (fs.existsSync(file)) return fs.readFileSync(file);

  const [front, back] = await Promise.all([
    side(true, mainIds, secondaryIds, muscles),
    side(false, mainIds, secondaryIds, muscles),
  ]);
  const h = (await sharp(front).metadata()).height;

  const out = await sharp({
    create: { width: MAP_WIDTH * 2 + 24, height: h, channels: 3, background: '#ffffff' },
  })
    .composite([
      { input: front, left: 0, top: 0 },
      { input: back, left: MAP_WIDTH + 24, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  fs.writeFileSync(file, out);
  return out;
}

const ru = (ids) => ids.map((id) => MUSCLES_RU[id]).filter(Boolean);

/**
 * Готовит упражнение к отправке: ищет, проверяет фото и собирает схему мышц.
 * Возвращает карточку и медиа; невалидные фото отсеиваются, а не улетают битыми.
 */
async function prepare(query, muscleIds = []) {
  const found = await search(query, muscleIds);
  if (!found.length) return { ok: false, reason: 'в базе нет упражнения по такому запросу' };

  for (const e of found) {
    const images = [...e.images].sort((a, b) => Number(b.main) - Number(a.main));
    for (const img of images) {
      const checked = await fetchImage(img.url);
      if (!checked.ok) continue;

      const media = [
        {
          buffer: checked.buffer,
          caption: `${e.names[0]}\nФото: ${e.author}, ${e.license}, wger.de`,
        },
      ];
      try {
        media.push({
          buffer: await muscleMap(e.muscles, e.secondary),
          caption: `Красным — основные мышцы, светлым — вспомогательные. Слева вид спереди, справа сзади.`,
        });
      } catch (err) {
        console.warn('схема мышц не собралась:', err.message);
      }

      return {
        ok: true,
        exercise: {
          name: e.names[0],
          alt_names: e.names.slice(1, 3),
          category: e.category,
          equipment: e.equipment,
          muscles_main: ru(e.muscles),
          muscles_secondary: ru(e.secondary),
          author: e.author,
          license: e.license,
        },
        media,
      };
    }
  }
  return { ok: false, reason: 'нашлось упражнение, но ни одно фото не прошло проверку' };
}

/** Картинка упражнения с диска: один раз скачали — дальше мгновенно. */
async function photoFor(query) {
  const found = await search(query);
  if (!found.length) return null;

  for (const e of found) {
    const cached = path.join(CACHE_DIR, 'ex', `${e.id}.jpg`);
    if (fs.existsSync(cached)) {
      return { buffer: fs.readFileSync(cached), name: e.names[0], author: e.author, license: e.license };
    }

    const images = [...e.images].sort((a, b) => Number(b.main) - Number(a.main));
    for (const img of images) {
      const checked = await fetchImage(img.url);
      if (!checked.ok) continue;
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.writeFileSync(cached, checked.buffer);
      return { buffer: checked.buffer, name: e.names[0], author: e.author, license: e.license };
    }
  }
  return null;
}

/**
 * Фото ко всем упражнениям тренировочного дня.
 * Упражнения без годной картинки просто выпадают — пустых мест не будет.
 */
async function prepareDay(exercises) {
  const media = [];
  const missing = [];

  for (const [i, e] of exercises.entries()) {
    if (typeof e === 'string' || !e.q) {
      missing.push(typeof e === 'string' ? e : e.name);
      continue;
    }
    const photo = await photoFor(e.q);
    if (!photo) {
      missing.push(`${e.name} ${e.sets}`);
      continue;
    }
    media.push({
      buffer: photo.buffer,
      caption: `${i + 1}. ${e.name} — ${e.sets}\nФото: ${photo.author}, ${photo.license}, wger.de`,
    });
  }
  return { media, missing };
}

module.exports = { prepare, prepareDay, photoFor, search, muscleMap, loadCatalog, MUSCLES_RU };
