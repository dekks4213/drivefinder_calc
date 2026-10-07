const store = require('./db');
const { computeTargets } = require('./nutrition');

/**
 * Полный учёт по пользователю: посуточный ряд + агрегаты за период.
 * День считается закрытым по еде, если калории в пределах ±12% нормы
 * и белок добран хотя бы на 90% — иначе это не соблюдение плана.
 */
function summary(userId, days = 30) {
  const user = store.getUser(userId);
  const targets = computeTargets(user);
  const series = store.dailySeries(userId, days);

  const logged = series.filter((d) => d.meals > 0);
  const trained = series.filter((d) => d.workout && d.workout.done);
  const skipped = series.filter((d) => d.workout && !d.workout.done);
  const weights = series.filter((d) => d.weight !== null);

  const avg = (arr, key) => (arr.length ? Math.round(arr.reduce((a, d) => a + d[key], 0) / arr.length) : 0);

  const onTarget = targets.kcal
    ? logged.filter((d) => Math.abs(d.kcal - targets.kcal) <= targets.kcal * 0.12 && d.protein >= targets.protein * 0.9)
    : [];

  const minutes = trained.reduce((a, d) => a + (d.workout.minutes || 0), 0);

  return {
    period_days: days,
    targets,
    food: {
      days_logged: logged.length,
      days_missing: days - logged.length,
      avg_kcal: avg(logged, 'kcal'),
      avg_protein: avg(logged, 'protein'),
      avg_fat: avg(logged, 'fat'),
      avg_carbs: avg(logged, 'carbs'),
      days_on_target: onTarget.length,
      adherence_pct: logged.length ? Math.round((onTarget.length / logged.length) * 100) : 0,
      total_meals: logged.reduce((a, d) => a + d.meals, 0),
    },
    training: {
      done: trained.length,
      skipped: skipped.length,
      total_minutes: minutes,
      completion_pct: trained.length + skipped.length ? Math.round((trained.length / (trained.length + skipped.length)) * 100) : 0,
      last_workout: trained.length ? trained[trained.length - 1].day : null,
      excuses: skipped.map((d) => ({ day: d.day, excuse: d.workout.excuse })).slice(-5),
    },
    weight: {
      first: weights.length ? weights[0].weight : user.weight_kg,
      last: weights.length ? weights[weights.length - 1].weight : user.weight_kg,
      delta: weights.length > 1 ? Math.round((weights[weights.length - 1].weight - weights[0].weight) * 10) / 10 : 0,
      points: weights.length,
    },
    series,
  };
}

/** Короткий отчёт для Telegram. */
function format(s) {
  const t = s.targets;
  const f = s.food;
  const w = s.training;
  const kg = s.weight;

  return [
    `УЧЁТ ЗА ${s.period_days} ДНЕЙ`,
    '',
    `Еда: записано ${f.days_logged} из ${s.period_days} дней, пропущено ${f.days_missing}`,
    t.kcal ? `В среднем ${f.avg_kcal} ккал при норме ${t.kcal} | белок ${f.avg_protein} г при норме ${t.protein} г` : `В среднем ${f.avg_kcal} ккал, белок ${f.avg_protein} г`,
    `В норму попал ${f.days_on_target} дней из ${f.days_logged} (${f.adherence_pct}%), всего приёмов пищи ${f.total_meals}`,
    '',
    `Тренировки: сделано ${w.done}, пропущено ${w.skipped} (${w.completion_pct}% выполнения), ${w.total_minutes} минут под нагрузкой`,
    w.last_workout ? `Последняя: ${w.last_workout}` : 'Ни одной тренировки за период',
    w.excuses.length ? `Отмазки: ${w.excuses.map((e) => `${e.day} — ${e.excuse || 'без причины'}`).join('; ')}` : false,
    '',
    `Вес: ${kg.first ?? '—'} → ${kg.last ?? '—'} кг (${kg.delta > 0 ? '+' : ''}${kg.delta} кг, замеров ${kg.points})`,
  ]
    .filter((line) => line !== false && line !== undefined)
    .join('\n');
}

module.exports = { summary, format };
