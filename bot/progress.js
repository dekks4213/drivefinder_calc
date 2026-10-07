const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const store = require('./db');

const PHOTO_DIR = process.env.BOT_PHOTO_DIR || path.join(__dirname, '..', 'data', 'photos');
const CARD_H = 900;

const ruDate = (day) => {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
};

/** Фото прогресса лежат на диске: архив должен пережить смену токена бота. */
function save(userId, buffer, fileId, note) {
  const dir = path.join(PHOTO_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });

  const series = store.weightSeries(userId, 3650);
  const weightKg = series.length ? series[series.length - 1].kg : null;
  const name = `${store.today()}_${Date.now()}.jpg`;

  fs.writeFileSync(path.join(dir, name), buffer);
  const id = store.addProgressPhoto(userId, { file: path.join(String(userId), name), fileId, note, weightKg });
  return { id, weightKg, total: store.progressPhotos(userId, 500).length };
}

function fileFor(row) {
  return path.join(PHOTO_DIR, row.file);
}

function label(text, width) {
  const svg = `<svg width="${width}" height="56" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="56" fill="#0b0b0b" fill-opacity="0.72"/>
    <text x="${width / 2}" y="37" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="600" fill="#ffffff">${text}</text>
  </svg>`;
  return Buffer.from(svg);
}

/** Склейка «было → стало»: два кадра одной высоты с датой и весом. */
async function beforeAfter(first, last) {
  const cards = await Promise.all(
    [first, last].map(async (row) => {
      const img = await sharp(fileFor(row)).resize({ height: CARD_H, fit: 'inside' }).toBuffer();
      const meta = await sharp(img).metadata();
      const caption = `${ruDate(row.day)}${row.weight_kg ? ` · ${row.weight_kg} кг` : ''}`;
      return sharp(img)
        .composite([{ input: label(caption, meta.width), top: meta.height - 56, left: 0 }])
        .jpeg({ quality: 90 })
        .toBuffer();
    })
  );

  const sizes = await Promise.all(cards.map((c) => sharp(c).metadata()));
  const gap = 16;
  const width = sizes[0].width + sizes[1].width + gap;
  const height = Math.max(sizes[0].height, sizes[1].height);

  return sharp({ create: { width, height, channels: 3, background: '#111110' } })
    .composite([
      { input: cards[0], left: 0, top: 0 },
      { input: cards[1], left: sizes[0].width + gap, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

module.exports = { save, beforeAfter, fileFor, ruDate, PHOTO_DIR };
