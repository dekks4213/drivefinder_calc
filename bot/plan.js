/**
 * Шаблоны тренировочных дней. Базовые движения, прогрессия по нагрузке,
 * объём под натурального любителя 2-6 тренировок в неделю.
 */
const DAYS = {
  gym: {
    fullA: ['Приседания со штангой 4x6-8', 'Жим лёжа 4x6-8', 'Тяга штанги в наклоне 4x8-10', 'Жим гантелей сидя 3x10', 'Планка 3x45 сек'],
    fullB: ['Румынская тяга 4x8', 'Жим гантелей лёжа 4x8-10', 'Тяга верхнего блока 4x10', 'Выпады с гантелями 3x10 на ногу', 'Подъём ног в висе 3x12'],
    push: ['Жим лёжа 4x6-8', 'Жим гантелей сидя 4x8-10', 'Жим гантелей на наклонной 3x10', 'Разведения в тренажёре 3x12-15', 'Разгибания на блоке 3x12'],
    pull: ['Тяга верхнего блока 4x8-10', 'Тяга штанги в наклоне 4x8', 'Тяга гантели одной рукой 3x10', 'Лицевые тяги 3x15', 'Сгибания со штангой 3x10'],
    legs: ['Приседания со штангой 4x6-8', 'Румынская тяга 4x8', 'Жим платформы 3x12', 'Сгибания ног в тренажёре 3x12', 'Подъёмы на носки 4x15'],
    upper: ['Жим лёжа 4x6-8', 'Тяга верхнего блока 4x8-10', 'Жим гантелей сидя 3x10', 'Тяга гантели одной рукой 3x10', 'Сгибания + разгибания рук 3x12'],
    lower: ['Приседания со штангой 4x6-8', 'Румынская тяга 4x8', 'Выпады 3x10 на ногу', 'Сгибания ног 3x12', 'Планка 3x60 сек'],
  },
  home: {
    fullA: ['Приседания с весом тела / с рюкзаком 4x15', 'Отжимания 4x10-15', 'Тяга рюкзака в наклоне 4x12', 'Отведения рук с бутылками 3x15', 'Планка 3x45 сек'],
    fullB: ['Выпады назад 4x12 на ногу', 'Отжимания с паузой 4x8-12', 'Ягодичный мост 4x15', 'Отжимания от опоры узким хватом 3x12', 'Скручивания 3x20'],
    push: ['Отжимания 4x12-15', 'Отжимания с ногами на возвышении 3x10', 'Отжимания узким хватом 3x12', 'Отведения рук с бутылками 3x15', 'Планка на локтях 3x60 сек'],
    pull: ['Подтягивания или тяга рюкзака 4x8-12', 'Тяга в наклоне 4x12', 'Обратные отжимания от стола 3x10', 'Супермен 3x15', 'Сгибания рук с рюкзаком 3x15'],
    legs: ['Приседания 4x20', 'Выпады назад 4x12 на ногу', 'Болгарские приседания 3x12 на ногу', 'Ягодичный мост 4x15', 'Подъёмы на носки 4x25'],
    upper: ['Отжимания 4x12-15', 'Подтягивания / тяга рюкзака 4x8-12', 'Отжимания от опоры 3x12', 'Супермен 3x15', 'Планка 3x60 сек'],
    lower: ['Приседания 4x20', 'Выпады 4x12 на ногу', 'Ягодичный мост 4x20', 'Подъёмы на носки 4x25', 'Велосипед 3x30'],
  },
};

const SPLITS = {
  2: [['Фулбоди A', 'fullA'], ['Фулбоди B', 'fullB']],
  3: [['Жим (грудь/плечи/трицепс)', 'push'], ['Тяга (спина/бицепс)', 'pull'], ['Ноги', 'legs']],
  4: [['Верх A', 'upper'], ['Низ A', 'lower'], ['Верх B', 'push'], ['Низ B', 'legs']],
  5: [['Жим', 'push'], ['Тяга', 'pull'], ['Ноги', 'legs'], ['Верх', 'upper'], ['Низ', 'lower']],
  6: [['Жим A', 'push'], ['Тяга A', 'pull'], ['Ноги A', 'legs'], ['Жим B', 'upper'], ['Тяга B', 'pull'], ['Ноги B', 'lower']],
};

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const SCHEDULE = { 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5] };

const CARDIO = {
  cut: '4x в неделю по 30-40 мин ходьбы/велотренажёра + 8-10к шагов каждый день',
  recomp: '3x в неделю по 25-30 мин кардио + 8к шагов каждый день',
  maintain: '2-3x в неделю по 25 мин кардио',
  bulk: '2x в неделю по 20 мин кардио, чтобы не терять дыхалку',
};

function buildPlan({ days_per_week = 3, location = 'gym', goal = 'maintain' } = {}) {
  const n = Math.min(Math.max(Number(days_per_week) || 3, 2), 6);
  const place = location === 'home' ? 'home' : 'gym';
  const lib = DAYS[place];
  const slots = SCHEDULE[n];

  const days = SPLITS[n].map(([title, key], i) => ({
    weekday: WEEKDAYS[slots[i]],
    title,
    exercises: lib[key],
  }));

  return {
    days_per_week: n,
    location: place,
    goal,
    days,
    cardio: CARDIO[goal] || CARDIO.maintain,
    progression: 'Каждую неделю: +2.5 кг на штанге или +1-2 повтора в подходе. Разминка 5-8 мин, последний подход — почти до отказа.',
    created_at: new Date().toISOString(),
  };
}

function formatPlan(plan) {
  const head = `План: ${plan.days_per_week} тренировки в неделю, ${plan.location === 'home' ? 'дома' : 'зал'}`;
  const body = plan.days
    .map((d) => `${d.weekday.toUpperCase()} — ${d.title}\n${d.exercises.map((e) => `  • ${e}`).join('\n')}`)
    .join('\n\n');
  return `${head}\n\n${body}\n\nКардио: ${plan.cardio}\nПрогрессия: ${plan.progression}`;
}

function isTrainingDay(plan, date = new Date(), tz = 'Europe/Moscow') {
  const short = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short' }).format(date).toLowerCase().slice(0, 2);
  return plan.days.some((d) => d.weekday === short);
}

function dayFor(plan, date = new Date(), tz = 'Europe/Moscow') {
  const short = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short' }).format(date).toLowerCase().slice(0, 2);
  return plan.days.find((d) => d.weekday === short) || null;
}

module.exports = { buildPlan, formatPlan, isTrainingDay, dayFor };
