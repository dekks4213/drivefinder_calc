require('dotenv').config();

const { Telegraf } = require('telegraf');
const cron = require('node-cron');

const store = require('./db');
const coach = require('./coach');
const { computeTargets } = require('./nutrition');
const { formatPlan, dayFor } = require('./plan');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Нет TELEGRAM_BOT_TOKEN в окружении');
  process.exit(1);
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
  if (OWNER_ID && id !== OWNER_ID) {
    await ctx.reply('Это личный бот. Доступа нет.');
    return;
  }
  store.ensureUser(id, [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username);
  return next();
});

bot.start(async (ctx) => {
  await send(
    ctx,
    'Я твой тренер и нутрициолог. Работаем так: ты пишешь, что съел и была ли тренировка — я считаю, веду дневник и держу тебя за горло.\n\n' +
      'Отмазки я не принимаю и фиксирую. Пропустил — узнаю и напомню.\n\n' +
      '/kbju — твои нормы, /plan — план на неделю, /today — итоги дня.'
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
      await send(ctx, answer);
    } finally {
      clearInterval(typing);
    }
  } catch (err) {
    console.error('coach error', err);
    await ctx.reply('Связь с головой отвалилась. Повтори сообщение.');
  }
}

bot.on('text', (ctx) => handleText(ctx, ctx.message.text));

bot.on('voice', (ctx) => ctx.reply('Голосовые не разбираю. Напиши текстом.'));

// --- Напоминания ---

async function nudge(user, prompt) {
  try {
    const answer = await coach.reply(user.id, prompt, { persist: false });
    await bot.telegram.sendMessage(user.id, answer);
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

bot.launch().then(() => console.log(`Тренер запущен. TZ=${store.TZ}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
