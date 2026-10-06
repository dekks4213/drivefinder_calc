const Anthropic = require('@anthropic-ai/sdk');
const store = require('./db');
const { computeTargets } = require('./nutrition');
const { buildPlan, formatPlan, dayFor } = require('./plan');

const client = new Anthropic();
const MODEL = process.env.COACH_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.COACH_EFFORT || 'low';
const MAX_TOOL_ROUNDS = 6;

const SYSTEM = `Ты — личный тренер и нутрициолог одного человека в Telegram. Ты не «ассистент» и не справочник: ты живой тренер, который ведёт этого человека к результату и отвечает за него.

ХАРАКТЕР
- Говоришь коротко и жёстко, как тренер в зале: 2-6 строк, без воды, без лекций, без списков на пол-экрана.
- Мат разрешён и уместен. Прямота важнее вежливости. Никакого корпоративного тона, никаких «я всего лишь ИИ».
- Не поддакиваешь. Если человек несёт херню — говоришь, что это херня, и объясняешь почему.
- Хвалишь скупо и только за сделанное: выполненную тренировку, закрытый белок, честно записанный срыв.
- Каждое сообщение заканчивается конкретным требованием или вопросом по делу: что сделать, когда, сколько.

КОГДА ОН СОБИРАЕТСЯ ПРОПУСТИТЬ ТРЕНИРОВКУ ИЛИ УЖЕ ПРОПУСТИЛ
- Не утешаешь и не говоришь «ничего страшного». Ничего страшного не бывает — бывает слитая неделя.
- Разбираешь отмазку по фактам: «устал», «нет времени», «настроения нет» — это не причины, это выбор. Назови это выбором.
- Поднимаешь его же цифры через инструменты: сколько тренировок пропущено за месяц, сколько дней с последней, что он сам написал о своей цели. Стыд должен расти из его собственной статистики, а не из абстрактных оскорблений.
- Напоминаешь цену: каждый прогул — это отодвинутый результат и привычка сдаваться, которая переносится на всё остальное.
- Всегда даёшь выход, но не бесплатный: либо тренировка сегодня, либо урезанная версия 20 минут, либо конкретный перенос с точным временем. «Потом» не принимается.
- Фиксируешь пропуск через log_workout(done: false) с его отмазкой, чтобы она всплыла в следующий раз.

ГРАНИЦЫ (не обсуждаются)
- Жёсткость — к поведению, отмазкам и дисциплине. Никогда — к телу, внешности, весу как таким и не к личности в целом.
- Не поощряешь голодание, дефицит ниже расчётного минимума, тренировки на больном, «добить через боль».
- Если травма, болезнь, температура, сильная боль, несколько суток сна меньше 5 часов, признаки расстройства пищевого поведения или психологический кризис — моментально переключаешься на спокойный режим: давление выключено, предлагаешь отдых или адаптацию нагрузки, при симптомах РПП или кризиса советуешь живого специалиста. Разбор отмазок к этому не применяется.

РАБОТА С ДАННЫМИ
- Перед любым разговором о калориях, весе, плане или дисциплине вызывай get_state. Не угадывай его цифры.
- Если профиль неполный — задаёшь не больше двух вопросов за раз и пишешь данные через update_profile. Не мучай анкетой: спрашивай то, без чего нельзя считать (пол, возраст, рост, вес, активность, цель).
- Любую еду, которую он описал словами, оцениваешь сам и пишешь через log_meal: калории и БЖУ — твоя оценка, помечай её как оценку, не делай вид, что это точность до грамма.
- Тренировку фиксируешь через log_workout. План строишь через build_plan, когда известны цель, количество дней и место.
- Числа из инструментов используешь как есть, не придумываешь свои.

Пиши только на русском, обычным текстом, без Markdown-разметки и заголовков.`;

const TOOLS = [
  {
    name: 'get_state',
    description:
      'Профиль, расчёт КБЖУ, план на сегодня, итоги питания за сегодня и статистика тренировок за 30 дней. Вызывай перед любым предметным разговором.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_profile',
    description: 'Записать или обновить данные профиля. Передавай только те поля, которые человек реально сообщил. КБЖУ пересчитывается автоматически.',
    input_schema: {
      type: 'object',
      properties: {
        sex: { type: 'string', enum: ['male', 'female'] },
        age: { type: 'integer', minimum: 14, maximum: 90 },
        height_cm: { type: 'number', minimum: 120, maximum: 230 },
        weight_kg: { type: 'number', minimum: 35, maximum: 250 },
        activity: {
          type: 'string',
          enum: ['sedentary', 'light', 'moderate', 'high', 'athlete'],
          description: 'sedentary — сидячий, light — лёгкая активность, moderate — средняя, high — высокая, athlete — спортсмен',
        },
        goal: { type: 'string', enum: ['cut', 'recomp', 'maintain', 'bulk'] },
        days_per_week: { type: 'integer', minimum: 2, maximum: 6 },
        location: { type: 'string', enum: ['gym', 'home'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'log_meal',
    description: 'Записать приём пищи в дневник. Калории и БЖУ — твоя оценка по описанию, в граммах и ккал.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Что он съел, его словами' },
        kcal: { type: 'number' },
        protein: { type: 'number' },
        fat: { type: 'number' },
        carbs: { type: 'number' },
      },
      required: ['text', 'kcal', 'protein', 'fat', 'carbs'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_workout',
    description: 'Записать тренировку. done: false — это пропуск, в excuse пиши его отмазку его же словами.',
    input_schema: {
      type: 'object',
      properties: {
        done: { type: 'boolean' },
        title: { type: 'string' },
        duration_min: { type: 'integer' },
        excuse: { type: 'string' },
        notes: { type: 'string', description: 'Рабочие веса, самочувствие, что получилось' },
      },
      required: ['done'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_diary',
    description: 'Дневник питания и тренировок за последние N дней.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 60 } },
      additionalProperties: false,
    },
  },
  {
    name: 'build_plan',
    description: 'Собрать и сохранить план тренировок на неделю. Нужны количество дней и место.',
    input_schema: {
      type: 'object',
      properties: {
        days_per_week: { type: 'integer', minimum: 2, maximum: 6 },
        location: { type: 'string', enum: ['gym', 'home'] },
      },
      required: ['days_per_week', 'location'],
      additionalProperties: false,
    },
  },
];

function state(userId) {
  const user = store.getUser(userId);
  const targets = computeTargets(user);
  const plan = user.plan_json ? JSON.parse(user.plan_json) : null;
  const totals = store.dayTotals(userId);

  return {
    profile: {
      name: user.name,
      sex: user.sex,
      age: user.age,
      height_cm: user.height_cm,
      weight_kg: user.weight_kg,
      activity: user.activity,
      goal: user.goal,
      days_per_week: user.days_per_week,
      location: user.location,
    },
    targets,
    today: {
      date: store.today(),
      eaten: {
        meals: totals.meals,
        kcal: Math.round(totals.kcal),
        protein: Math.round(totals.protein),
        fat: Math.round(totals.fat),
        carbs: Math.round(totals.carbs),
      },
      left_kcal: targets.kcal ? Math.round(targets.kcal - totals.kcal) : null,
      left_protein: targets.protein ? Math.round(targets.protein - totals.protein) : null,
      planned_workout: plan ? dayFor(plan, new Date(), store.TZ) : null,
      logged_workouts: store.workoutsOfDay(userId),
    },
    training_stats: store.trainingStats(userId, 30),
    has_plan: Boolean(plan),
  };
}

function runTool(userId, name, input) {
  switch (name) {
    case 'get_state':
      return state(userId);

    case 'update_profile': {
      const user = store.updateUser(userId, input);
      const targets = computeTargets(user);
      if (!targets.missing) store.setTargets(userId, targets);
      return { saved: input, targets };
    }

    case 'log_meal': {
      store.addMeal(userId, input);
      const s = state(userId);
      return { logged: true, today: s.today.eaten, left_kcal: s.today.left_kcal, left_protein: s.today.left_protein };
    }

    case 'log_workout': {
      store.addWorkout(userId, input);
      return { logged: true, training_stats: store.trainingStats(userId, 30) };
    }

    case 'get_diary':
      return store.diary(userId, input.days || 7);

    case 'build_plan': {
      const user = store.updateUser(userId, { days_per_week: input.days_per_week, location: input.location });
      const plan = buildPlan({ days_per_week: input.days_per_week, location: input.location, goal: user.goal || 'maintain' });
      store.setPlan(userId, plan);
      return { plan, text: formatPlan(plan) };
    }

    default:
      return { error: `unknown tool ${name}` };
  }
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Один ход диалога: история из БД + инструменты, цикл до финального ответа.
 * @param {number} userId
 * @param {string} userText
 * @param {{persist?: boolean}} [opts] persist=false — системный пинок, не пишем вход в историю
 */
async function reply(userId, userText, opts = {}) {
  const persist = opts.persist !== false;
  const messages = store.history(userId);
  messages.push({ role: 'user', content: userText });
  if (persist) store.pushMessage(userId, 'user', userText);

  let answer = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return 'Этот заход я не разберу. Давай к делу: что с тренировкой и едой сегодня?';
    }

    answer = textOf(response) || answer;

    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) break;

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: calls.map((call) => {
        try {
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(runTool(userId, call.name, call.input)) };
        } catch (err) {
          return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: String(err.message || err) };
        }
      }),
    });
  }

  if (!answer) answer = 'Коротко: пиши, что съел и была ли тренировка. Разберём.';
  store.pushMessage(userId, 'assistant', answer);
  return answer;
}

module.exports = { reply, state };
