require('dotenv').config();

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
const exercises = require('./exercises');

for (const key of ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Нет ${key} в окружении`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const OWNER_ID = process.env.OWNER_TELEGRAM_ID ? Number(process.env.OWNER_TELEGRAM_ID) : null;

const TG_LIMIT = 4000;

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
};
const MAIN_KEYBOARD = Markup.keyboard([
  [BTN.today, BTN.stats],
  [BTN.plan, BTN.workout],
  [BTN.kbju, BTN.weight],
  [BTN.photos, BTN.supps],
  [BTN.dash],
])
  .resize()
  .persistent();

// Кнопки под сообщением о прогуле: выход есть, но каждый вариант платный.
const SKIP_ACTIONS = Markup.inlineKeyboard([
  [Markup.button.callback('Иду сейчас', 'a:now')],
  [Markup.button.callback('20 минут дома', 'a:short'), Markup.button.callback('Перенести', 'a:move')],
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

async function send(ctx, text) {
  for (let i = 0; i < text.length; i += TG_LIMIT) {
    await ctx.reply(text.slice(i, i + TG_LIMIT));
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
      (s.training_stats.days_since_last !== null ? `, с последней ${s.training_stats.days_since_last} дн.` : '')
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

bot.action(/^a:(now|short|move)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await handleText(ctx, SKIP_REPLIES[ctx.match[1]]);
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
      const answer = await coach.reply(ctx.from.id, text, opts);
      result = answer;
      for (const item of answer.media) {
        await ctx.replyWithPhoto({ source: item.buffer }, { caption: item.caption });
      }
      for (const block of answer.extras) await send(ctx, block);

      // После зафиксированного прогула даём три выхода одним тапом.
      if (answer.signals.skipped && answer.text.length <= TG_LIMIT) {
        await ctx.reply(answer.text, SKIP_ACTIONS);
      } else {
        await send(ctx, answer.text);
      }
    } finally {
      clearInterval(typing);
    }
  } catch (err) {
    if (err.quotaExhausted) {
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

bot.on('text', (ctx) => handleText(ctx, ctx.message.text));

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

bot.on('voice', (ctx) => ctx.reply('Голосовые не разбираю. Напиши текстом.'));

// --- Напоминания ---

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
            'и что с едой под его нормы. Возьми цифры через get_state. Если вес давно не писал — требуй взвеситься сейчас, натощак. Коротко, без пересказа плана.'
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

scheduleReminders();
web.start();

// launch() резолвится только при остановке бота — лог запуска идёт колбэком.
// Список команд в меню рядом с полем ввода.
bot.telegram
  .setMyCommands([
    { command: 'today', description: 'Итоги дня' },
    { command: 'stats', description: 'Полный учёт' },
    { command: 'plan', description: 'План тренировок' },
    { command: 'kbju', description: 'Нормы КБЖУ' },
    { command: 'supps', description: 'Спортпит и добавки' },
    { command: 'dashboard', description: 'Графики' },
    { command: 'reset', description: 'Очистить историю диалога' },
  ])
  .catch((err) => console.warn('не удалось записать меню команд:', err.message));

bot.launch(() => console.log(`Тренер запущен. TZ=${store.TZ}, жёсткость=${process.env.COACH_HARSHNESS || 'hard'}`)).catch((err) => {
  console.error('Не удалось запустить бота:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
