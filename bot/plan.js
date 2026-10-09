/**
 * Шаблоны тренировочных дней. Базовые движения, прогрессия по нагрузке,
 * объём под натурального любителя 2-6 тренировок в неделю.
 */
// Справочник движений: русское название + английский запрос в каталог wger,
// чтобы к каждому упражнению можно было приложить картинку.
const EX = {
  squat:      { name: 'Приседания со штангой', q: 'barbell squat' },
  rdl:        { name: 'Румынская тяга', q: 'romanian deadlift' },
  legpress:   { name: 'Жим платформы', q: 'leg press' },
  legcurl:    { name: 'Сгибания ног в тренажёре', q: 'leg curl' },
  lunge:      { name: 'Выпады с гантелями', q: 'lunges' },
  calf:       { name: 'Подъёмы на носки', q: 'calf raises' },
  bench:      { name: 'Жим лёжа', q: 'bench press' },
  incline:    { name: 'Жим гантелей на наклонной', q: 'incline dumbbell press' },
  dbbench:    { name: 'Жим гантелей лёжа', q: 'dumbbell bench press' },
  ohp:        { name: 'Жим гантелей сидя', q: 'shoulder press' },
  fly:        { name: 'Разведения в тренажёре', q: 'butterfly' },
  pushdown:   { name: 'Разгибания на блоке', q: 'triceps pushdown' },
  latpull:    { name: 'Тяга верхнего блока', q: 'neutral-grip chest pulldown' },
  row:        { name: 'Тяга штанги в наклоне', q: 'one arm bent row' },
  dbrow:      { name: 'Тяга к поясу сидя', q: 'seated cable row' },
  facepull:   { name: 'Лицевые тяги', q: 'face pull' },
  curl:       { name: 'Сгибания со штангой', q: 'biceps curl' },
  lateral:    { name: 'Махи гантелями в стороны', q: 'lateral raise' },
  plank:      { name: 'Планка', q: 'plank' },
  legraise:   { name: 'Подъём ног в висе', q: 'leg raises pull up bar' },
  crunch:     { name: 'Скручивания', q: 'crunches' },
  pushup:     { name: 'Отжимания', q: 'push-up' },
  pullup:     { name: 'Подтягивания', q: 'pull up' },
  dip:        { name: 'Отжимания на брусьях', q: 'dips' },
  bwsquat:    { name: 'Приседания с весом тела', q: 'box squat' },
  bwlunge:    { name: 'Выпады назад', q: 'lunges' },
  bridge:     { name: 'Ягодичный мост', q: 'glute bridge' },
  superman:   { name: 'Гиперэкстензия', q: 'hyperextensions' },
  bulgarian:  { name: 'Болгарские приседания', q: 'bulgarian split squat' },
};

const day = (items) => items.map(([key, sets]) => ({ ...EX[key], sets }));

const DAYS = {
  gym: {
    fullA: day([['squat', '4x6-8'], ['bench', '4x6-8'], ['row', '4x8-10'], ['ohp', '3x10'], ['plank', '3x45 сек']]),
    fullB: day([['rdl', '4x8'], ['dbbench', '4x8-10'], ['latpull', '4x10'], ['lunge', '3x10 на ногу'], ['legraise', '3x12']]),
    push:  day([['bench', '4x6-8'], ['ohp', '4x8-10'], ['incline', '3x10'], ['fly', '3x12-15'], ['pushdown', '3x12']]),
    pull:  day([['latpull', '4x8-10'], ['row', '4x8'], ['dbrow', '3x10'], ['facepull', '3x15'], ['curl', '3x10']]),
    legs:  day([['squat', '4x6-8'], ['rdl', '4x8'], ['legpress', '3x12'], ['legcurl', '3x12'], ['calf', '4x15']]),
    upper: day([['bench', '4x6-8'], ['latpull', '4x8-10'], ['ohp', '3x10'], ['dbrow', '3x10'], ['curl', '3x12']]),
    lower: day([['squat', '4x6-8'], ['rdl', '4x8'], ['lunge', '3x10 на ногу'], ['legcurl', '3x12'], ['plank', '3x60 сек']]),
  },
  home: {
    fullA: day([['bwsquat', '4x15'], ['pushup', '4x10-15'], ['dbrow', '4x12'], ['lateral', '3x15'], ['plank', '3x45 сек']]),
    fullB: day([['bwlunge', '4x12 на ногу'], ['pushup', '4x8-12'], ['bridge', '4x15'], ['dip', '3x12'], ['crunch', '3x20']]),
    push:  day([['pushup', '4x12-15'], ['dip', '3x10'], ['lateral', '3x15'], ['ohp', '3x12'], ['plank', '3x60 сек']]),
    pull:  day([['pullup', '4x8-12'], ['dbrow', '4x12'], ['superman', '3x15'], ['facepull', '3x15'], ['curl', '3x15']]),
    legs:  day([['bwsquat', '4x20'], ['bwlunge', '4x12 на ногу'], ['bulgarian', '3x12 на ногу'], ['bridge', '4x15'], ['calf', '4x25']]),
    upper: day([['pushup', '4x12-15'], ['pullup', '4x8-12'], ['dip', '3x12'], ['superman', '3x15'], ['plank', '3x60 сек']]),
    lower: day([['bwsquat', '4x20'], ['bwlunge', '4x12 на ногу'], ['bridge', '4x20'], ['calf', '4x25'], ['crunch', '3x30']]),
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

// Без зала и без тренировок: цель закрывается едой, шагами и бытовой
// активностью. Это рабочий выбор, а не поблажка.
const NO_TRAINING = {
  cut: '10-12к шагов каждый день плюс 30-40 мин ходьбы или велосипеда 4-5 раз в неделю',
  recomp: '10к шагов каждый день плюс 30 мин ходьбы 3-4 раза в неделю',
  maintain: '8-10к шагов каждый день',
  bulk: '8к шагов каждый день, без лишнего кардио',
};

function buildPlan({ days_per_week = 3, location = 'gym', goal = 'maintain' } = {}) {
  const asked = Number(days_per_week);
  const n = asked === 0 ? 0 : Math.min(Math.max(asked || 3, 2), 6);
  const place = location === 'home' ? 'home' : 'gym';

  // Ноль тренировок: план остаётся, но держится на питании и ходьбе.
  if (!n) {
    return {
      days_per_week: 0,
      location: place,
      goal,
      days: [],
      cardio: NO_TRAINING[goal] || NO_TRAINING.maintain,
      progression: 'Тренировок нет: результат даёт норма калорий и белка каждый день плюс шаги. Раз в неделю взвешивание натощак — по нему и правим калории.',
      created_at: new Date().toISOString(),
    };
  }

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

/** Планы, сохранённые до появления картинок, хранят упражнения строками. */
const exName = (e) => (typeof e === 'string' ? e : `${e.name} ${e.sets}`);

function formatPlan(plan) {
  if (!plan.days_per_week || !plan.days.length) {
    return `План без тренировок: работаем питанием и активностью.\n\nАктивность: ${plan.cardio}\n${plan.progression}`;
  }
  const head = `План: ${plan.days_per_week} тренировки в неделю, ${plan.location === 'home' ? 'дома' : 'зал'}`;
  const body = plan.days
    .map((d) => `${d.weekday.toUpperCase()} — ${d.title}\n${d.exercises.map((e) => `  • ${exName(e)}`).join('\n')}`)
    .join('\n\n');
  return `${head}\n\n${body}\n\nКардио: ${plan.cardio}\nПрогрессия: ${plan.progression}`;
}

function isTrainingDay(plan, date = new Date(), tz = 'Asia/Vladivostok') {
  const short = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short' }).format(date).toLowerCase().slice(0, 2);
  return plan.days.some((d) => d.weekday === short);
}

function dayFor(plan, date = new Date(), tz = 'Asia/Vladivostok') {
  const short = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short' }).format(date).toLowerCase().slice(0, 2);
  return plan.days.find((d) => d.weekday === short) || null;
}

module.exports = { buildPlan, formatPlan, isTrainingDay, dayFor, exName };
