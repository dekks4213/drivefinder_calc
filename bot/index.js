require('dotenv').config();

const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const cron = require('node-cron');

const store = require('./db');
const coach = require('./coach');
const { computeTargets } = require('./nutrition');
const { formatPlan, dayFor } = require('./plan');
const stats = require('./stats');
const web = require('./web');

for (const key of ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Нет ${key} в окружении`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const OWNER_ID = process.env.OWNER_TELEGRAM_ID ? Number(process.env.OWNER_TELEGRAM_ID) : null;

const TG_LIMIT = 4000;

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
      '/kbju — нормы, /plan — план, /today — итоги дня, /stats — учёт, /dashboard — графики.'
  );
  await handleText(ctx, 'Я только что запустил бота. Собери мой профиль, чтобы посчитать КБЖУ.', { persist: false });
});

bot.command('kbju', async (ctx) => {
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
});

bot.command('plan', async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.plan_json) {
    await handleText(ctx, 'Собери мне план тренировок.', { persist: false });
    return;
  }
  await send(ctx, formatPlan(JSON.parse(user.plan_json)));
});

bot.command('today', async (ctx) => {
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
});

bot.command('stats', async (ctx) => {
  const days = Math.min(Math.max(parseInt((ctx.message.text.split(' ')[1] || '30'), 10) || 30, 1), 365);
  await send(ctx, stats.format(stats.summary(ctx.from.id, days)));
});

bot.command('dashboard', async (ctx) => {
  await send(ctx, `Твой дашборд: ${web.linkFor(ctx.from.id)}\n\nСсылка личная, не свети её.`);
});

bot.command('reset', async (ctx) => {
  store.clearHistory(ctx.from.id);
  await ctx.reply('История диалога очищена. Профиль и дневник на месте.');
});

async function handleText(ctx, text, opts) {
  try {
    await ctx.sendChatAction('typing');
    const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 5000);
    try {
      const answer = await coach.reply(ctx.from.id, text, opts);
      for (const item of answer.media) {
        await ctx.replyWithPhoto({ source: item.buffer }, { caption: item.caption });
      }
      for (const block of answer.extras) await send(ctx, block);
      await send(ctx, answer.text);
    } finally {
      clearInterval(typing);
    }
  } catch (err) {
    console.error('coach error', err);
    await ctx.reply('Связь с головой отвалилась. Повтори сообщение.');
  }
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

    const caption = (ctx.message.caption || '').trim() || 'Это моя еда. Оцени и запиши в дневник.';
    await handleText(ctx, caption, { image: { buffer, mimeType: 'image/jpeg' } });
  } catch (err) {
    console.error('photo error', err);
    await ctx.reply('Фото не открылось. Пришли ещё раз или напиши словами, что сожрал.');
  }
});

bot.on('voice', (ctx) => ctx.reply('Голосовые не разбираю. Напиши текстом.'));

// --- Напоминания ---

async function nudge(user, prompt) {
  try {
    const answer = await coach.reply(user.id, prompt, { persist: false });
    for (const item of answer.media) {
      await bot.telegram.sendPhoto(user.id, { source: item.buffer }, { caption: item.caption });
    }
    for (const block of answer.extras) await bot.telegram.sendMessage(user.id, block);
    await bot.telegram.sendMessage(user.id, answer.text);
  } catch (err) {
    console.error('nudge error', user.id, err.message);
  }
}

function scheduleReminders() {
  const tz = store.TZ;

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
          `Системный пинок: сегодня по плану «${planned.title}», тренировка не записана, вечер. Спроси прямо, где тренировка, и не принимай «потом».`
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
bot.launch(() => console.log(`Тренер запущен. TZ=${store.TZ}, жёсткость=${process.env.COACH_HARSHNESS || 'hard'}`)).catch((err) => {
  console.error('Не удалось запустить бота:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
