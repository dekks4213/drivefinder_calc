require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const sharp = require('sharp');
const cron = require('node-cron');

const store = require('./db');
const coach = require('./coach');
const { computeTargets } = require('./nutrition');
const { formatPlan, dayFor } = require('./plan');
const stats = require('./stats');
const web = require('./web');
const progress = require('./progress');
const { backup } = require('./migrations');
const exercises = require('./exercises');
const importer = require('./importer');

for (const key of ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Нет ${key} в окружении`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
  // Зависший ход не должен держать очередь сообщений остальных.
  handlerTimeout: Number(process.env.HANDLER_TIMEOUT_MS) || 90000,
});
const OWNER_ID = process.env.OWNER_TELEGRAM_ID ? Number(process.env.OWNER_TELEGRAM_ID) : null;

const TG_LIMIT = 4000;
const STARTED_AT = Date.now();


// Потолки: один человек не должен выжечь дневную квоту и кошелёк.
const USER_DAILY_MESSAGES = Number(process.env.USER_DAILY_MESSAGES) || 80;
const DAILY_COST_LIMIT = Number(process.env.DAILY_COST_LIMIT_USD) || 3;
const health = { turns: 0, errors: 0, quotaHits: 0, lastError: null, lastErrorAt: null };

// Последняя удалённая запись — для кнопки «Вернуть»: промах по кнопке
// не должен стоить пользователю данных.
const lastDeleted = new Map();
// Кого ждём с текстом правки: id пользователя → id записи.
const pendingEdit = new Map();
const EDIT_TTL_MS = 10 * 60 * 1000;

/** Дневник за день: текст со списком и кнопки под каждой записью. */
function diaryView(userId) {
  const items = store.mealsOfDay(userId);
  const t = store.dayTotals(userId);
  const undo = lastDeleted.get(userId);

  if (!items.length) {
    const kb = undo ? [[Markup.button.callback('↩️ Вернуть удалённое', 'meal:undo')]] : [];
    return { text: 'За сегодня в дневнике пусто.', keyboard: Markup.inlineKeyboard(kb) };
  }

  const text =
    `ДНЕВНИК ЗА ${t.day}` +
    '\n\n' +
    items
      .map((m, i) => `${i + 1}. ${m.ts.slice(11, 16)} — ${m.text}\n    ${m.kcal} ккал, Б${m.protein} Ж${m.fat} У${m.carbs}`)
      .join('\n') +
    `\n\nИтого: ${Math.round(t.kcal)} ккал, белок ${Math.round(t.protein)} г\nНажми номер, чтобы поправить или удалить.`;

  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(items.slice(i, i + 5).map((m, j) => Markup.button.callback(String(i + j + 1), `meal:open:${m.id}`)));
  }
  if (undo) rows.push([Markup.button.callback('↩️ Вернуть удалённое', 'meal:undo')]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

async function showDiary(ctx) {
  const view = diaryView(ctx.from.id);
  await ctx.reply(view.text, view.keyboard);
}

/** Перерисовываем на месте, чтобы лента не засорялась копиями списка. */
async function refreshDiary(ctx) {
  const view = diaryView(ctx.from.id);
  try {
    await ctx.editMessageText(view.text, view.keyboard);
  } catch (err) {
    if (!String(err.message).includes('message is not modified')) await ctx.reply(view.text, view.keyboard);
  }
}

// Постоянная клавиатура: то, что нужно каждый день, без вспоминания команд.
const BTN = {
  stats: '📊 Учёт',
  today: '🍽 Сегодня',
  plan: '🏋️ План',
  kbju: '🔢 Нормы',
  dash: '📈 Дашборд',
  weight: '⚖️ Вес',
  photos: '📷 Прогресс',
  workout: '📸 Тренировка',
  supps: '💊 Спортпит',
  diary: '🍽 Дневник',
};

// Кнопки под сообщением о прогуле: выход есть, но каждый вариант платный.
const SKIP_ACTIONS = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Сделал', 'w:done')],
  [Markup.button.callback('Иду сейчас', 'a:now')],
  [Markup.button.callback('20 минут дома', 'a:short'), Markup.button.callback('Перенести', 'a:move')],
]);

// Отметка тренировки одним тапом: писать об этом прозой никто не станет.
const WORKOUT_ACTIONS = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Сделал', 'w:done'), Markup.button.callback('✕ Не пойду', 'w:skip')],
]);
const SKIP_REPLIES = {
  now: 'Иду на тренировку прямо сейчас.',
  short: 'Давай урезанную версию на 20 минут дома, прямо сейчас.',
  move: 'Переношу тренировку, сейчас назову точное время.',
};

const statsKeyboard = (days) =>
  Markup.inlineKeyboard([
    [7, 30, 90].map((d) => Markup.button.callback(d === days ? `· ${d} дней ·` : `${d} дней`, `s:${d}`)),
  ]);

const MAIN_KEYBOARD = Markup.keyboard([
  [BTN.today, BTN.stats],
  [BTN.plan, BTN.workout],
  [BTN.kbju, BTN.weight],
  [BTN.photos, BTN.supps],
  [BTN.diary, BTN.dash],
])
  .resize()
  .persistent();

// Reply-клавиатура у Telegram обновляется только вместе с сообщением,
// которое её несёт. Поэтому прикрепляем её к первому ответу каждому
// пользователю после запуска — иначе у людей остаётся старый набор.
const keyboardShown = new Set();

async function send(ctx, text, extra = {}) {
  const id = ctx.from && ctx.from.id;
  const chunks = [];
  for (let i = 0; i < text.length; i += TG_LIMIT) chunks.push(text.slice(i, i + TG_LIMIT));

  for (const [i, chunk] of chunks.entries()) {
    const last = i === chunks.length - 1;
    let opts = extra;
    if (last && id && !extra.reply_markup && !keyboardShown.has(id)) {
      keyboardShown.add(id);
      opts = { ...extra, ...MAIN_KEYBOARD };
    }
    await ctx.reply(chunk, opts);
  }
}

bot.use(async (ctx, next) => {
  const id = ctx.from && ctx.from.id;
  if (!id) return;
  if (!store.markUpdate(ctx.update && ctx.update.update_id)) {
    console.log(`повторный апдейт ${ctx.update.update_id} пропущен`);
    return;
  }
  if (OWNER_ID && id !== OWNER_ID) {
    await ctx.reply('Это личный бот. Доступа нет.');
    return;
  }
  store.ensureUser(id, [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username);

  // Лимиты проверяем до обращения к модели, иначе платим за отказ.
  if (ctx.message && (ctx.message.text || ctx.message.photo || ctx.message.voice)) {
    const total = store.usageTotalToday();
    if (total.cost_usd >= DAILY_COST_LIMIT) {
      console.warn(`дневной потолок расходов достигнут: $${total.cost_usd.toFixed(2)}`);
      await ctx.reply('На сегодня достигнут дневной лимит расходов бота. Команды /today, /stats, /meals, /plan работают — они считаются по базе.');
      return;
    }
    const mine = store.usageToday(id);
    if (mine.messages >= USER_DAILY_MESSAGES && id !== OWNER_ID) {
      await ctx.reply(`Лимит ${USER_DAILY_MESSAGES} сообщений в сутки исчерпан. Завтра продолжим. Дневник и учёт доступны: /today, /stats, /meals.`);
      return;
    }
  }
  console.log(`[${new Date().toISOString()}] id=${id} @${ctx.from.username || '-'}: ${(ctx.message && ctx.message.text) || ctx.updateType}`);
  return next();
});

bot.start(async (ctx) => {
  await send(
    ctx,
    'Я твой тренер и нутрициолог. Работаем так: ты пишешь, что съел и была ли тренировка — я считаю, веду дневник и держу тебя за горло.\n\n' +
      'Отмазки я не принимаю и фиксирую. Пропустил — узнаю и напомню.\n\n' +
      'Кнопки снизу — всё основное. Команды тоже работают: /kbju /plan /today /stats /dashboard.'
  );
  await ctx.reply('Клавиатура под рукой.', MAIN_KEYBOARD);
  await handleText(ctx, 'Я только что запустил бота. Собери мой профиль, чтобы посчитать КБЖУ.', { persist: false });
});

async function showKbju(ctx) {
  const user = store.getUser(ctx.from.id);
  const t = computeTargets(user);
  if (t.missing) {
    await handleText(ctx, 'Покажи мои КБЖУ.', { persist: false });
    return;
  }
  const today = store.dayTotals(ctx.from.id);
  await send(
    ctx,
    `Норма на день (цель: ${t.goal}):\n` +
      `Калории: ${t.kcal} ккал\nБелок: ${t.protein} г\nЖиры: ${t.fat} г\nУглеводы: ${t.carbs} г\nВода: ${t.water_ml} мл\n\n` +
      `Поддержка (TDEE): ${t.tdee} ккал, обмен покоя: ${t.bmr} ккал\n\n` +
      `Сегодня съедено: ${Math.round(today.kcal)} ккал, белок ${Math.round(today.protein)} г. Осталось: ${t.kcal - Math.round(today.kcal)} ккал.`
  );
}

async function showPlan(ctx) {
  const user = store.getUser(ctx.from.id);
  if (!user.plan_json) {
    await handleText(ctx, 'Собери мне план тренировок.', { persist: false });
    return;
  }
  await send(ctx, formatPlan(JSON.parse(user.plan_json)));
}

async function showToday(ctx) {
  const s = coach.state(ctx.from.id);
  const w = s.today.logged_workouts;
  const planned = s.today.planned_workout;
  await send(
    ctx,
    `${s.today.date}\n` +
      `Съедено: ${s.today.eaten.kcal} ккал | Б ${s.today.eaten.protein} / Ж ${s.today.eaten.fat} / У ${s.today.eaten.carbs} (${s.today.eaten.meals} приёмов)\n` +
      (s.targets.kcal ? `Осталось: ${s.today.left_kcal} ккал, белка ${s.today.left_protein} г\n` : '') +
      `Тренировка по плану: ${planned ? planned.title : 'нет, день отдыха'}\n` +
      `Записано: ${w.length ? w.map((x) => (x.done ? `сделано (${x.title || 'тренировка'})` : `ПРОПУСК — ${x.excuse || 'без причины'}`)).join('; ') : 'ничего'}\n` +
      `За 30 дней: сделано ${s.training_stats.done}, пропущено ${s.training_stats.skipped}` +
      (s.training_stats.days_since_last !== null ? `, с последней ${s.training_stats.days_since_last} дн.` : ''),
    planned && !w.length ? WORKOUT_ACTIONS : {}
  );
}

async function showStats(ctx, days = 30) {
  await ctx.reply(stats.format(stats.summary(ctx.from.id, days)), statsKeyboard(days));
}

async function showDashboard(ctx) {
  await send(ctx, `Твой дашборд: ${web.linkFor(ctx.from.id)}\n\nСсылка личная, не свети её.`);
}

bot.command('kbju', showKbju);
bot.command('plan', showPlan);
bot.command('today', showToday);
bot.command('stats', (ctx) => showStats(ctx, Math.min(Math.max(parseInt(ctx.message.text.split(' ')[1], 10) || 30, 1), 365)));
bot.command('dashboard', showDashboard);

bot.hears(BTN.kbju, showKbju);
bot.hears(BTN.plan, showPlan);
bot.hears(BTN.today, showToday);
bot.hears(BTN.stats, (ctx) => showStats(ctx, 30));
bot.hears(BTN.dash, showDashboard);
bot.hears(BTN.weight, (ctx) => handleText(ctx, 'Хочу записать свой вес на сегодня.'));
bot.hears(BTN.photos, showProgress);
bot.hears(BTN.workout, showWorkout);
bot.hears(BTN.supps, (ctx) => handleText(ctx, 'Что мне из спортпита и добавок реально нужно под мою цель? Посмотри, что я уже принимаю.'));
bot.command('supps', (ctx) => handleText(ctx, 'Что мне из спортпита и добавок реально нужно под мою цель? Посмотри, что я уже принимаю.'));
bot.command('workout', showWorkout);

/** Тренировка дня: каждое упражнение отдельной картинкой, по порядку. */
async function showWorkout(ctx) {
  const user = store.getUser(ctx.from.id);
  if (!user.plan_json) {
    await handleText(ctx, 'Собери мне план тренировок.');
    return;
  }

  const plan = JSON.parse(user.plan_json);
  const today = dayFor(plan, new Date(), store.TZ);
  const day = today || plan.days[0];

  await ctx.reply(
    today ? `Сегодня: ${day.title}. Лови, как это должно выглядеть.` : `Сегодня отдых. Ближайшая тренировка — ${day.title} (${day.weekday}).`
  );
  await ctx.sendChatAction('upload_photo');

  const { media, missing } = await exercises.prepareDay(day.exercises);
  if (media.length) {
    await ctx.replyWithMediaGroup(media.map((m) => ({ type: 'photo', media: { source: m.buffer }, caption: m.caption })));
  }
  if (missing.length) await ctx.reply(`Без картинки: ${missing.join(', ')}`);

  const logged = store.workoutsOfDay(ctx.from.id);
  if (today && !logged.length) {
    await ctx.reply('Как закончишь — жми кнопку, не надо писать об этом прозой.', WORKOUT_ACTIONS);
  }
}
bot.command('progress', showProgress);

/** Архив формы: «было → стало» одной картинкой плюс лента последних кадров. */
async function showProgress(ctx) {
  const photos = store.progressPhotos(ctx.from.id, 50);
  if (!photos.length) {
    await ctx.reply('Архива пока нет. Скинь фото в полный рост или торс — сохраню, и через месяц будет с чем сравнивать.');
    return;
  }
  if (photos.length === 1) {
    const only = photos[0];
    await ctx.replyWithPhoto(
      { source: progress.fileFor(only) },
      { caption: `${progress.ruDate(only.day)}${only.weight_kg ? ` · ${only.weight_kg} кг` : ''}\nЭто единственный кадр. Скинь ещё через пару недель — покажу разницу.` }
    );
    return;
  }

  const first = photos[0];
  const last = photos[photos.length - 1];
  const dayDiff = Math.round((Date.parse(last.day) - Date.parse(first.day)) / 86400000);
  const kgDiff =
    first.weight_kg && last.weight_kg ? Math.round((last.weight_kg - first.weight_kg) * 10) / 10 : null;

  try {
    await ctx.replyWithPhoto(
      { source: await progress.beforeAfter(first, last) },
      {
        caption:
          `Было → стало: ${dayDiff} дней` +
          (kgDiff !== null ? `, ${kgDiff > 0 ? '+' : ''}${kgDiff} кг` : '') +
          `\nВсего кадров в архиве: ${photos.length}`,
      }
    );
  } catch (err) {
    console.error('сравнение не собралось', err);
  }

  const recent = photos.slice(-10);
  if (recent.length > 1) {
    await ctx.replyWithMediaGroup(
      recent.map((p) => ({
        type: 'photo',
        media: { source: progress.fileFor(p) },
        caption: `${progress.ruDate(p.day)}${p.weight_kg ? ` · ${p.weight_kg} кг` : ''}`,
      }))
    );
  }
}

// Период учёта переключается прямо в сообщении, без новых сообщений в ленте.
bot.action(/^s:(\d+)$/, async (ctx) => {
  const days = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(stats.format(stats.summary(ctx.from.id, days)), statsKeyboard(days));
  } catch (err) {
    if (!String(err.message).includes('message is not modified')) throw err;
  }
});

bot.action('w:done', async (ctx) => {
  const user = store.getUser(ctx.from.id);
  const plan = user.plan_json ? JSON.parse(user.plan_json) : null;
  const day = plan ? dayFor(plan, new Date(), store.TZ) : null;

  store.addWorkout(ctx.from.id, { done: true, title: day ? day.title : 'Тренировка' });
  const stats = store.trainingStats(ctx.from.id, 30);

  await ctx.answerCbQuery('Записал');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await send(
    ctx,
    `Записал: ${day ? day.title : 'тренировка'} сделана. За 30 дней сделано ${stats.done}, слито ${stats.skipped}.\n\n` +
      'Скидывай рабочие веса и самочувствие — запомню и в следующий раз буду требовать больше.'
  );
});

bot.action('w:skip', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await handleText(ctx, 'Не пойду сегодня на тренировку.');
});

bot.action(/^a:(now|short|move)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await handleText(ctx, SKIP_REPLIES[ctx.match[1]]);
});

bot.command('meals', showDiary);

bot.command('delmeal', async (ctx) => {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (!id) {
    await ctx.reply('Укажи номер записи: /delmeal 42 (номера видно в /meals).');
    return;
  }
  await ctx.reply(store.deleteMeal(ctx.from.id, id) ? `Удалил запись ${id}.` : `Записи ${id} нет.`);
});

bot.command('undo', async (ctx) => {
  const last = store.lastMeal(ctx.from.id);
  if (!last) {
    await ctx.reply('Нечего отменять.');
    return;
  }
  store.deleteMeal(ctx.from.id, last.id);
  await ctx.reply(`Убрал последнюю запись: ${last.text} (${last.kcal} ккал).`);
});

bot.hears(BTN.diary, showDiary);

bot.action('diary:open', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await showDiary(ctx);
});

bot.action(/^meal:open:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  const meal = store.mealsOfDay(ctx.from.id).find((m) => m.id === id);
  if (!meal) return refreshDiary(ctx);

  await ctx.editMessageText(
    `${meal.ts.slice(11, 16)} — ${meal.text}\n${meal.kcal} ккал, Б${meal.protein} Ж${meal.fat} У${meal.carbs}\n\nЧто с ней делаем?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Исправить', `meal:edit:${id}`), Markup.button.callback('🗑 Удалить', `meal:del:${id}`)],
      [Markup.button.callback('← К списку', 'meal:list')],
    ])
  );
});

bot.action(/^meal:del:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const meal = store.mealsOfDay(ctx.from.id).find((m) => m.id === id);
  if (meal && store.deleteMeal(ctx.from.id, id)) {
    lastDeleted.set(ctx.from.id, meal);
    await ctx.answerCbQuery(`Удалил: ${meal.text.slice(0, 40)}`);
  } else {
    await ctx.answerCbQuery('Записи уже нет');
  }
  await refreshDiary(ctx);
});

bot.action('meal:undo', async (ctx) => {
  const meal = lastDeleted.get(ctx.from.id);
  if (!meal) {
    await ctx.answerCbQuery('Нечего возвращать');
    return;
  }
  store.addMeal(ctx.from.id, { text: meal.text, kcal: meal.kcal, protein: meal.protein, fat: meal.fat, carbs: meal.carbs });
  lastDeleted.delete(ctx.from.id);
  await ctx.answerCbQuery('Вернул');
  await refreshDiary(ctx);
});

bot.action('meal:list', async (ctx) => {
  await ctx.answerCbQuery();
  await refreshDiary(ctx);
});

bot.action(/^meal:edit:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  pendingEdit.set(ctx.from.id, { id, at: Date.now() });
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply('Напиши, что не так: «там было 150 г», «это без масла», «450 ккал». Пересчитаю и поправлю запись.');
});

bot.command('backup', async (ctx) => {
  try {
    const res = await sendBackup(ctx.chat.id);
    if (res.skipped) await ctx.reply('Нечего сохранять: база пустая.');
  } catch (err) {
    console.error('бэкап по команде не прошёл', err);
    await ctx.reply('Не смог отправить копию базы. Посмотри логи.');
  }
});

bot.command('health', async (ctx) => {
  const upMin = Math.round((Date.now() - STARTED_AT) / 60000);
  const up = upMin >= 60 ? `${Math.floor(upMin / 60)} ч ${upMin % 60} мин` : `${upMin} мин`;
  const dbPath = process.env.BOT_DB_PATH || './data/coach.db';
  let dbSize = '—';
  try {
    dbSize = `${Math.round(require('fs').statSync(dbPath).size / 1024)} КБ`;
  } catch (err) {
    dbSize = 'файл не найден';
  }

  await send(
    ctx,
    [
      'СОСТОЯНИЕ',
      `Работает: ${up}`,
      `Модель сейчас: ${coach.currentModel()}`,
      `Обработано сообщений с запуска: ${health.turns}`,
      `Ошибок: ${health.errors}${health.quotaHits ? ` (из них упёрлись в квоту: ${health.quotaHits})` : ''}`,
      health.lastError ? `Последняя: ${health.lastErrorAt} — ${health.lastError}` : 'Последняя ошибка: не было',
      `База: ${dbSize}, фактов в памяти: ${store.memories(ctx.from.id, 500).length}`,
      '',
      'РАСХОД ЗА СЕГОДНЯ',
      (() => {
        const m = store.usageToday(ctx.from.id);
        return `Твои: ${m.messages} сообщений, ${m.requests} запросов к модели, $${m.cost_usd.toFixed(3)}`;
      })(),
      (() => {
        const t = store.usageTotalToday();
        return `Всего: ${t.messages} сообщений от ${t.users} чел., $${t.cost_usd.toFixed(3)} из лимита $${DAILY_COST_LIMIT}`;
      })(),
      `Часовой пояс: ${store.TZ}`,
    ].join('\n')
  );
});

bot.command('memory', async (ctx) => {
  const facts = store.memories(ctx.from.id, 60);
  if (!facts.length) {
    await ctx.reply('Пока ничего не запомнил. Поговори с ним пару дней — начнёт копить.');
    return;
  }
  const byKind = facts.reduce((acc, f) => {
    (acc[f.kind] = acc[f.kind] || []).push(f);
    return acc;
  }, {});
  const text = Object.entries(byKind)
    .map(([kind, items]) => `${kind.toUpperCase()}\n${items.map((f) => `  ${f.id}. ${f.fact}`).join('\n')}`)
    .join('\n\n');
  await send(ctx, `ЧТО ТРЕНЕР ПРО ТЕБЯ ЗНАЕТ\n\n${text}\n\nНеверное удаляется: /forget <номер>`);
});

bot.command('forget', async (ctx) => {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (!id) {
    await ctx.reply('Укажи номер факта: /forget 12 (номера видно в /memory).');
    return;
  }
  await ctx.reply(store.forget(ctx.from.id, id) ? `Забыл факт ${id}.` : `Факта ${id} нет.`);
});

bot.command('reset', async (ctx) => {
  store.clearHistory(ctx.from.id);
  await ctx.reply('История диалога очищена. Профиль и дневник на месте.');
});

async function handleText(ctx, text, opts) {
  let result = null;
  try {
    await ctx.sendChatAction('typing');
    const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 5000);
    try {
      const startedAt = Date.now();
      const answer = await coach.reply(ctx.from.id, text, opts);
      const ms = Date.now() - startedAt;
      if (ms > 20000) console.warn(`долгий ход: ${Math.round(ms / 1000)} с`);
      health.turns += 1;
      result = answer;
      for (const item of answer.media) {
        await ctx.replyWithPhoto({ source: item.buffer }, { caption: item.caption });
      }
      for (const block of answer.extras) await send(ctx, block);

      // Кнопки под ответом: после прогула — три выхода, после записи
      // еды — быстрый доступ к правке дневника.
      const short = answer.text.length <= TG_LIMIT;
      if (answer.signals.skipped && short) {
        await ctx.reply(answer.text, SKIP_ACTIONS);
      } else if (answer.signals.mealLogged && short) {
        await ctx.reply(answer.text, Markup.inlineKeyboard([[Markup.button.callback('🍽 Поправить дневник', 'diary:open')]]));
      } else {
        await send(ctx, answer.text);
      }
    } finally {
      clearInterval(typing);
    }
  } catch (err) {
    health.errors += 1;
    health.lastError = String(err.message || err).slice(0, 200);
    health.lastErrorAt = new Date().toISOString();
    if (err.transient) {
      console.warn('модель перегружена, пользователю отправлено объяснение');
      await ctx.reply('Gemini сейчас перегружен и не отвечает — это на их стороне, не у тебя. Повтори через минуту.');
    } else if (err.timedOut) {
      console.warn('ход оборван по таймауту');
      await ctx.reply('Подвис на этом сообщении — модель не ответила вовремя. Повтори, я на месте.');
    } else if (err.quotaExhausted) {
      health.quotaHits += 1;
      const hours = err.retrySeconds ? Math.ceil(err.retrySeconds / 3600) : null;
      console.warn('квота Gemini исчерпана, пользователю отправлено объяснение');
      await ctx.reply(
        'Дневной лимит запросов к Gemini выбран — на сегодня я молчу, это не поломка.' +
          (hours ? ` Лимит обновится примерно через ${hours} ч.` : '') +
          '\n\nДневник и учёт работают: /today, /stats, /plan, /workout — они считаются по базе и не трогают лимит.'
      );
    } else {
      console.error('coach error', err);
      await ctx.reply('Связь с головой отвалилась. Повтори сообщение.');
    }
  }
  return result;
}

bot.on('text', (ctx) => {
  const pending = pendingEdit.get(ctx.from.id);
  if (pending && Date.now() - pending.at < EDIT_TTL_MS) {
    pendingEdit.delete(ctx.from.id);
    return handleText(ctx, `Исправь запись в дневнике с id ${pending.id} через fix_meal: ${ctx.message.text}`);
  }
  pendingEdit.delete(ctx.from.id);
  return handleText(ctx, ctx.message.text);
});

// Фото еды: уменьшаем перед отправкой в модель — оригиналы с телефона
// жрут токены, а для оценки порции хватает 1024 px.
bot.on('photo', async (ctx) => {
  try {
    const sizes = ctx.message.photo;
    const link = await ctx.telegram.getFileLink(sizes[sizes.length - 1].file_id);
    const res = await fetch(link.href, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Telegram вернул HTTP ${res.status}`);

    const buffer = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const caption = (ctx.message.caption || '').trim() || 'Вот фото. Разберись, что на нём, и зафиксируй.';
    const answer = await handleText(ctx, caption, { image: { buffer, mimeType: 'image/jpeg' } });

    // Модель решает, еда это или фото формы; файл сохраняем только во втором случае.
    if (answer && answer.signals.progress) {
      const saved = progress.save(ctx.from.id, buffer, sizes[sizes.length - 1].file_id, answer.signals.progress.note);
      await ctx.reply(`Фото в архиве. Всего кадров: ${saved.total}. Посмотреть историю — кнопка «${BTN.photos}».`);
    }
  } catch (err) {
    console.error('photo error', err);
    await ctx.reply('Фото не открылось. Пришли ещё раз или напиши словами, что сожрал.');
  }
});

// Голосовые Telegram приходят в OGG/Opus — модель понимает их напрямую,
// отдельное распознавание речи не нужно.
// Экспорт переписки из Telegram Desktop: читать историю чата бот не может,
// в Bot API такого метода нет, — зато может разобрать выгруженный файл.
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const isJson = /\.json$/i.test(doc.file_name || '') || doc.mime_type === 'application/json';
  if (!isJson) {
    await ctx.reply('Жду файл result.json из выгрузки Telegram. Другие файлы я не разбираю.');
    return;
  }
  if (doc.file_size > 20 * 1024 * 1024) {
    await ctx.reply('Файл больше 20 МБ. Выгрузи переписку только с этим ботом и без медиа.');
    return;
  }

  await ctx.reply('Разбираю выгрузку, это займёт до минуты.');
  await ctx.sendChatAction('typing');

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Telegram вернул HTTP ${res.status}`);

    const result = await importer.importExport(ctx.from.id, await res.json());
    if (!result.ok) {
      await ctx.reply(`Не вышло: ${result.reason}.`);
      return;
    }

    const a = result.added;
    await send(
      ctx,
      `Восстановил из переписки за ${result.days} дней:\n` +
        (a.profile ? 'профиль заполнен\n' : '') +
        `еды ${a.meals}, тренировок ${a.workouts}, замеров веса ${a.weights}, фактов в память ${a.memory}.\n\n` +
        'Записи из истории помечены, калории в них — оценка по описанию. Загляни в «Дневник» и поправь, что криво.'
    );
  } catch (err) {
    console.error('import error', err);
    await ctx.reply('Файл не разобрался. Проверь, что это result.json из выгрузки Telegram, и пришли ещё раз.');
  }
});

bot.on(['voice', 'audio', 'video_note'], async (ctx) => {
  const m = ctx.message;
  const file = m.voice || m.audio || m.video_note;
  try {
    if (file.file_size && file.file_size > 18 * 1024 * 1024) {
      await ctx.reply('Запись слишком длинная. Напиши текстом или запиши короче.');
      return;
    }

    const link = await ctx.telegram.getFileLink(file.file_id);
    const res = await fetch(link.href, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error(`Telegram вернул HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = m.video_note ? 'video/mp4' : file.mime_type || 'audio/ogg';
    const caption = (m.caption || '').trim() || 'Это голосовое. Разбери, что я сказал, и ответь по делу.';
    await handleText(ctx, caption, { audio: { buffer, mimeType } });
  } catch (err) {
    console.error('voice error', err);
    await ctx.reply('Запись не открылась. Повтори или напиши текстом.');
  }
});

// --- Напоминания ---

/**
 * Снимок базы файлом в чат. Базу без содержимого не шлём: пара пустых
 * профилей — это не данные, а шум в чате у владельца.
 */
async function sendBackup(chatId) {
  const rows = store.db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const payload = store.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM meals) + (SELECT COUNT(*) FROM workouts)
            + (SELECT COUNT(*) FROM weights) + (SELECT COUNT(*) FROM memory)
            + (SELECT COUNT(*) FROM users WHERE weight_kg IS NOT NULL) AS c`
    )
    .get().c;
  if (!rows || !payload) return { skipped: 'в базе нечего сохранять' };

  const file = path.join(os.tmpdir(), `coach-${store.today()}-${Date.now()}.db`);
  store.db.prepare('VACUUM INTO ?').run(file);

  const stats = {
    users: rows,
    meals: store.db.prepare('SELECT COUNT(*) c FROM meals').get().c,
    workouts: store.db.prepare('SELECT COUNT(*) c FROM workouts').get().c,
    memory: store.db.prepare('SELECT COUNT(*) c FROM memory').get().c,
  };

  await bot.telegram.sendDocument(
    chatId,
    { source: file, filename: `coach-${store.today()}.db` },
    {
      caption:
        `Копия базы на ${new Date().toLocaleString('ru-RU', { timeZone: store.TZ })}\n` +
        `Профилей ${stats.users}, еды ${stats.meals}, тренировок ${stats.workouts}, фактов памяти ${stats.memory}.\n` +
        'Храни последний файл: из него восстанавливается всё.',
    }
  );

  fs.unlinkSync(file);
  console.log(`бэкап отправлен в чат ${chatId}: ${JSON.stringify(stats)}`);
  return stats;
}

async function nudge(user, prompt, withActions = false) {
  try {
    const answer = await coach.reply(user.id, prompt, { persist: false });
    for (const item of answer.media) {
      await bot.telegram.sendPhoto(user.id, { source: item.buffer }, { caption: item.caption });
    }
    for (const block of answer.extras) await bot.telegram.sendMessage(user.id, block);
    const actions = (withActions || answer.signals.skipped) && answer.text.length <= TG_LIMIT;
    await bot.telegram.sendMessage(user.id, answer.text, actions ? SKIP_ACTIONS : undefined);
  } catch (err) {
    console.error('nudge error', user.id, err.message);
  }
}

function scheduleReminders() {
  const tz = store.TZ;

  // Копия базы уходит в Telegram: бэкап внутри контейнера не спасает
  // от его пересоздания, а файл в чате переживает что угодно.
  const backupChat = process.env.BACKUP_CHAT_ID || process.env.OWNER_TELEGRAM_ID;
  if (backupChat) {
    cron.schedule(
      process.env.BACKUP_SEND_CRON || '5 */3 * * *',
      () => sendBackup(backupChat).catch((err) => console.error('отправка бэкапа не прошла:', err.message)),
      { timezone: tz }
    );
  }

  // Ночной бэкап базы с ротацией: данные живут в одном файле.
  cron.schedule(
    process.env.BACKUP_CRON || '15 4 * * *',
    () => {
      try {
        const res = backup(store.db, store.DB_PATH, Number(process.env.BACKUP_KEEP) || 14);
        console.log(`бэкап: ${res.file}${res.removed ? `, удалено старых: ${res.removed}` : ''}`);
      } catch (err) {
        console.error('бэкап не сделан:', err.message);
      }
    },
    { timezone: tz }
  );

  // Воскресенье: разбор недели и выводы в память — это и есть адаптация.
  cron.schedule(
    process.env.REMINDER_WEEKLY || '0 20 * * 0',
    () => {
      for (const user of store.remindableUsers()) {
        nudge(
          user,
          'Системный пинок: воскресный разбор недели. Возьми get_stats за 7 и за 30 дней и get_diary. ' +
            'Сравни: как шёл вес, добирал ли калории и белок, сколько тренировок сделал и слил, какие отмазки повторялись. ' +
            'Сделай 2-3 вывода и запиши их через remember — что у него работает, что проваливается и на что это влияет. ' +
            'Если вес стоит на месте две недели при соблюдении нормы или падает слишком быстро — скажи, что меняем в калориях или нагрузке, конкретными цифрами. ' +
            'Ответ короткий: что было, что меняем, что он делает на следующей неделе.'
        );
      }
    },
    { timezone: tz }
  );

  // Утро: установка на день — тренировка, нормы и взвешивание.
  cron.schedule(
    process.env.REMINDER_MORNING || '30 8 * * *',
    () => {
      for (const user of store.remindableUsers()) {
        const plan = user.plan_json ? JSON.parse(user.plan_json) : null;
        const planned = plan ? dayFor(plan, new Date(), tz) : null;
        const lastWeight = store.lastWeightDay(user.id);
        const daysNoWeight = lastWeight
          ? Math.round((Date.parse(store.today()) - Date.parse(lastWeight)) / 86400000)
          : null;

        nudge(
          user,
          'Системный пинок, утро. ' +
            (planned ? `Сегодня по плану «${planned.title}».` : 'Сегодня день отдыха по плану.') +
            (daysNoWeight === null
              ? ' Вес он не записывал ни разу.'
              : daysNoWeight >= 7
                ? ` Вес не записывал ${daysNoWeight} дней.`
                : '') +
            ' Дай короткую установку на день: ' +
            (planned
              ? 'во сколько сегодня тренировка — требуй точное время, '
              : 'чем закрывает активность в выходной — шаги или кардио, ') +
            'и что с едой под его нормы. Возьми цифры через get_state. Если вес давно не писал — требуй взвеситься сейчас, натощак. Коротко, без пересказа плана.',
          Boolean(planned)
        );
      }
    },
    { timezone: tz }
  );

  // Вечер: тренировочный день, а тренировка не записана.
  cron.schedule(
    process.env.REMINDER_EVENING || '0 19 * * *',
    () => {
      for (const user of store.usersWithPlan()) {
        const planned = dayFor(JSON.parse(user.plan_json), new Date(), tz);
        if (!planned) continue;
        if (store.workoutsOfDay(user.id).length) continue;
        nudge(
          user,
          `Системный пинок: сегодня по плану «${planned.title}», тренировка не записана, вечер. Спроси прямо, где тренировка, и не принимай «потом».`,
          true
        );
      }
    },
    { timezone: tz }
  );

  // Ночь: итоги дня по еде и тренировке.
  cron.schedule(
    process.env.REMINDER_NIGHT || '30 22 * * *',
    () => {
      for (const user of store.usersWithPlan()) {
        const s = coach.state(user.id);
        const protein = s.targets.protein || 0;
        const slacked = s.today.eaten.meals === 0 || (protein && s.today.eaten.protein < protein * 0.7);
        const skipped = s.today.logged_workouts.some((w) => !w.done);
        if (!slacked && !skipped) continue;
        nudge(user, 'Системный пинок: подведи итоги дня по фактам из get_state. Коротко, по делу, и назови одно требование на завтра.');
      }
    },
    { timezone: tz }
  );
}

// Под require (тесты) ничего не запускаем: нужны только обработчики.
if (require.main === module) {
  scheduleReminders();
  web.start();
}

// launch() резолвится только при остановке бота — лог запуска идёт колбэком.
if (require.main === module) {
  // Список команд в меню рядом с полем ввода.
  bot.telegram
    .setMyCommands([
      { command: 'today', description: 'Итоги дня' },
      { command: 'stats', description: 'Полный учёт' },
      { command: 'plan', description: 'План тренировок' },
      { command: 'kbju', description: 'Нормы КБЖУ' },
      { command: 'supps', description: 'Спортпит и добавки' },
      { command: 'meals', description: 'Что записано за сегодня' },
      { command: 'undo', description: 'Убрать последнюю запись еды' },
      { command: 'memory', description: 'Что тренер о тебе знает' },
      { command: 'health', description: 'Состояние бота' },
      { command: 'dashboard', description: 'Графики' },
      { command: 'backup', description: 'Прислать копию базы файлом' },
    { command: 'reset', description: 'Очистить историю диалога' },
    ])
    .catch((err) => console.warn('не удалось записать меню команд:', err.message));

  bot.launch(() => console.log(`Тренер запущен. TZ=${store.TZ}, жёсткость=${process.env.COACH_HARSHNESS || 'hard'}`)).catch((err) => {
    console.error('Не удалось запустить бота:', err.message);
    process.exit(1);
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = { bot, diaryView };
