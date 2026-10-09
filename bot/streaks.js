const store = require('./db');
const { computeTargets } = require('./nutrition');

const WINDOW = Number(process.env.STREAK_WINDOW_DAYS) || 120;

/**
 * Серия считается от сегодня назад. Сегодняшний день, если он ещё не
 * закрыт, серию НЕ рвёт: иначе каждое утро человек видел бы ноль и
 * бросал. Рвёт её вчерашний провал.
 */
function runLength(series, ok, graceToday = true) {
  let streak = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (ok(series[i])) {
      streak += 1;
      continue;
    }
    // Последний день без послабления рвёт серию: прогул — это уже решение,
    // а не незакрытый день, в котором он ещё может собраться.
    if (graceToday && i === series.length - 1) continue;
    break;
  }
  return streak;
}

function bestRun(series, ok) {
  let best = 0;
  let run = 0;
  for (const d of series) {
    run = ok(d) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

function summary(userId) {
  const user = store.getUser(userId);
  const targets = computeTargets(user);
  const series = store.dailySeries(userId, WINDOW);

  const proteinOk = (d) => Boolean(targets.protein && d.protein >= targets.protein * 0.9);
  const loggedOk = (d) => d.meals > 0;

  const trainingDays = series.filter((d) => d.workout);
  const doneOk = (d) => Boolean(d.workout && d.workout.done);

  const lastSkip = [...trainingDays].reverse().find((d) => !d.workout.done);
  const topProtein = series.reduce((a, d) => (d.protein > (a ? a.protein : 0) ? d : a), null);

  // Лучшая неделя по тренировкам: скользящее окно семи дней.
  let bestWeek = 0;
  for (let i = 0; i < series.length; i += 1) {
    const week = series.slice(Math.max(0, i - 6), i + 1).filter(doneOk).length;
    if (week > bestWeek) bestWeek = week;
  }

  return {
    window_days: WINDOW,
    protein: {
      current: runLength(series, proteinOk),
      best: bestRun(series, proteinOk),
      target: targets.protein || null,
    },
    diary: {
      current: runLength(series, loggedOk),
      best: bestRun(series, loggedOk),
    },
    training: {
      current: runLength(trainingDays, doneOk, false),
      best: bestRun(trainingDays, doneOk),
      best_week: bestWeek,
      days_since_skip: lastSkip
        ? Math.round((Date.parse(store.today()) - Date.parse(lastSkip.day)) / 86400000)
        : null,
      last_skip: lastSkip ? { day: lastSkip.day, excuse: lastSkip.workout.excuse } : null,
    },
    records: {
      max_protein: topProtein && topProtein.protein ? { day: topProtein.day, protein: topProtein.protein } : null,
    },
  };
}

/** Короткий блок для отчётов: только то, что реально есть. */
function format(s) {
  const lines = [];
  if (s.protein.current) lines.push(`Белок по норме: ${s.protein.current} дней подряд (рекорд ${s.protein.best})`);
  else if (s.protein.best) lines.push(`Серия по белку сорвана, рекорд был ${s.protein.best} дней`);

  if (s.diary.current) lines.push(`Дневник заполнен: ${s.diary.current} дней подряд (рекорд ${s.diary.best})`);

  if (s.training.current) lines.push(`Тренировки без прогула: ${s.training.current} подряд (рекорд ${s.training.best})`);
  else if (s.training.last_skip)
    lines.push(`Последний прогул ${s.training.last_skip.day} — ${s.training.last_skip.excuse || 'без причины'}`);

  if (s.training.best_week) lines.push(`Лучшая неделя: ${s.training.best_week} тренировок`);
  if (s.records.max_protein) lines.push(`Максимум белка за день: ${s.records.max_protein.protein} г (${s.records.max_protein.day})`);

  return lines.length ? `СЕРИИ И РЕКОРДЫ\n${lines.join('\n')}` : '';
}

module.exports = { summary, format };
