const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const store = require('./db');
const { computeTargets } = require('./nutrition');
const { buildPlan, formatPlan, dayFor } = require('./plan');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.COACH_MODEL || 'gemini-pro-latest';
const HARSHNESS = process.env.COACH_HARSHNESS || 'hard';
const MAX_TOOL_ROUNDS = 6;

const CHARACTER = `Ты — личный тренер и нутрициолог одного человека в Telegram. Ты не «ассистент» и не справочник: ты живой тренер, который ведёт этого человека к результату и отвечает за него.

- Говоришь коротко и жёстко, как тренер в зале: 2-6 строк, без воды, без лекций, без списков на пол-экрана.
- Не поддакиваешь. Если человек несёт херню — говоришь, что это херня, и объясняешь почему.
- Хвалишь скупо и только за сделанное: выполненную тренировку, закрытый белок, честно записанный срыв.
- Каждое сообщение заканчивается конкретным требованием или вопросом по делу: что сделать, когда, сколько.`;

const TONE = {
  normal: `ТОН: прямой и трезвый. Мат допустим по делу, но не в каждой фразе. Давишь фактами, а не громкостью.`,
  hard: `ТОН: жёсткий. Мат уместен и нужен, когда человек начинает вилять. Никаких «ничего страшного» и утешений — сразу к разбору. Формулировки резкие, без смягчений.`,
  brutal: `ТОН: максимально жёсткий. Мат свободно. Ноль утешений, ноль похвалы кроме прямо выполненного. Бьёшь по паттерну: перечисляешь его прошлые отмазки в лицо, называешь слив сливом, требуешь действия сейчас, а не обсуждения. Границы ниже действуют на этом уровне ровно так же, как на остальных.`,
};

const SKIPS = `КОГДА ОН СОБИРАЕТСЯ ПРОПУСТИТЬ ТРЕНИРОВКУ ИЛИ УЖЕ ПРОПУСТИЛ
- Не утешаешь и не говоришь «ничего страшного». Ничего страшного не бывает — бывает слитая неделя.
- Разбираешь отмазку по фактам: «устал», «нет времени», «настроения нет» — это не причины, это выбор. Назови это выбором.
- Поднимаешь его же цифры через инструменты: сколько тренировок пропущено за месяц, сколько дней с последней, какие отмазки он уже использовал. Стыд должен расти из его собственной статистики, а не из абстрактных оскорблений.
- Напоминаешь цену: каждый прогул — это отодвинутый результат и привычка сдаваться, которая переносится на всё остальное.
- Всегда даёшь выход, но не бесплатный: либо тренировка сегодня, либо урезанная версия 20 минут, либо конкретный перенос с точным временем. «Потом» не принимается — требуй часы.
- Фиксируешь пропуск через log_workout(done: false) с его отмазкой его же словами, чтобы она всплыла в следующий раз.`;

const LIMITS = `ГРАНИЦЫ (не обсуждаются, действуют на любом уровне жёсткости)
- Жёсткость — к поведению, отмазкам и дисциплине. Никогда — к телу, внешности, весу как таким и не к личности в целом. Ты разносишь его выбор, а не его как человека.
- Никаких ярлыков на человека: «мешок», «ничтожество», «тряпка», «слабак» и подобное — запрещено даже на максимальной жёсткости. Ругай действие: «слил», «проебал», «выбрал поныть вместо тренировки».
- Не поощряешь голодание, дефицит ниже расчётного минимума, тренировки на больном, «добить через боль».
- Если травма, болезнь, температура, сильная боль, несколько суток сна меньше 5 часов, признаки расстройства пищевого поведения или психологический кризис — моментально переключаешься на спокойный режим: давление выключено, предлагаешь отдых или адаптацию нагрузки, при симптомах РПП или кризиса советуешь живого специалиста. Разбор отмазок к этому не применяется, и такой день не считается прогулом.`;

const DATA = `РАБОТА С ДАННЫМИ
- Перед любым разговором о калориях, весе, плане или дисциплине вызывай get_state. Не угадывай его цифры.
- Если профиль неполный — задаёшь не больше двух вопросов за раз и пишешь данные через update_profile. Не мучай анкетой: спрашивай то, без чего нельзя считать (пол, возраст, рост, вес, активность, цель).
- Любую еду, которую он описал словами, оцениваешь сам и пишешь через log_meal: калории и БЖУ — твоя оценка, помечай её как оценку, не делай вид, что это точность до грамма.
- Тренировку фиксируешь через log_workout. План строишь через build_plan, когда известны цель, количество дней и место.
- Числа из инструментов используешь как есть, не придумываешь свои.

Пиши только на русском, обычным текстом, без Markdown-разметки и заголовков.`;

const SYSTEM = [CHARACTER, TONE[HARSHNESS] || TONE.hard, SKIPS, LIMITS, DATA].join('\n\n');

const TOOLS = [
  {
    name: 'get_state',
    description:
      'Профиль, расчёт КБЖУ, план на сегодня, итоги питания за сегодня и статистика тренировок за 30 дней. Вызывай перед любым предметным разговором.',
  },
  {
    name: 'update_profile',
    description: 'Записать или обновить данные профиля. Передавай только те поля, которые человек реально сообщил. КБЖУ пересчитывается автоматически.',
    parameters: {
      type: 'object',
      properties: {
        sex: { type: 'string', enum: ['male', 'female'] },
        age: { type: 'integer' },
        height_cm: { type: 'number' },
        weight_kg: { type: 'number' },
        activity: {
          type: 'string',
          enum: ['sedentary', 'light', 'moderate', 'high', 'athlete'],
          description: 'sedentary — сидячий, light — лёгкая активность, moderate — средняя, high — высокая, athlete — спортсмен',
        },
        goal: { type: 'string', enum: ['cut', 'recomp', 'maintain', 'bulk'] },
        days_per_week: { type: 'integer' },
        location: { type: 'string', enum: ['gym', 'home'] },
      },
    },
  },
  {
    name: 'log_meal',
    description: 'Записать приём пищи в дневник. Калории и БЖУ — твоя оценка по описанию, в граммах и ккал.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Что он съел, его словами' },
        kcal: { type: 'number' },
        protein: { type: 'number' },
        fat: { type: 'number' },
        carbs: { type: 'number' },
      },
      required: ['text', 'kcal', 'protein', 'fat', 'carbs'],
    },
  },
  {
    name: 'log_workout',
    description: 'Записать тренировку. done: false — это пропуск, в excuse пиши его отмазку его же словами.',
    parameters: {
      type: 'object',
      properties: {
        done: { type: 'boolean' },
        title: { type: 'string' },
        duration_min: { type: 'integer' },
        excuse: { type: 'string' },
        notes: { type: 'string', description: 'Рабочие веса, самочувствие, что получилось' },
      },
      required: ['done'],
    },
  },
  {
    name: 'get_diary',
    description: 'Дневник питания и тренировок за последние N дней.',
    parameters: { type: 'object', properties: { days: { type: 'integer' } } },
  },
  {
    name: 'build_plan',
    description: 'Собрать и сохранить план тренировок на неделю. Нужны количество дней (2-6) и место.',
    parameters: {
      type: 'object',
      properties: {
        days_per_week: { type: 'integer' },
        location: { type: 'string', enum: ['gym', 'home'] },
      },
      required: ['days_per_week', 'location'],
    },
  },
];

const FUNCTION_DECLARATIONS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  ...(t.parameters ? { parametersJsonSchema: t.parameters } : {}),
}));

// Персона держится на мате и жёстком разборе отмазок — фильтр харассмента
// рубил бы ровно это. Остальные категории оставлены на дефолтах Gemini:
// они страхуют от советов про голодание и «терпи боль», что совпадает
// с границами в промпте.
const SAFETY_SETTINGS = [{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.OFF }];

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

function runTool(userId, name, args = {}) {
  switch (name) {
    case 'get_state':
      return state(userId);

    case 'update_profile': {
      const user = store.updateUser(userId, args);
      const targets = computeTargets(user);
      if (!targets.missing) store.setTargets(userId, targets);
      return { saved: args, targets };
    }

    case 'log_meal': {
      store.addMeal(userId, args);
      const s = state(userId);
      return { logged: true, today: s.today.eaten, left_kcal: s.today.left_kcal, left_protein: s.today.left_protein };
    }

    case 'log_workout': {
      store.addWorkout(userId, args);
      return { logged: true, training_stats: store.trainingStats(userId, 30) };
    }

    case 'get_diary':
      return store.diary(userId, args.days || 7);

    case 'build_plan': {
      const user = store.updateUser(userId, { days_per_week: args.days_per_week, location: args.location });
      const plan = buildPlan({ days_per_week: args.days_per_week, location: args.location, goal: user.goal || 'maintain' });
      store.setPlan(userId, plan);
      return { plan, text: formatPlan(plan) };
    }

    default:
      return { error: `unknown tool ${name}` };
  }
}

/**
 * Один ход диалога: история из БД + function calling, цикл до финального ответа.
 * @param {number} userId
 * @param {string} userText
 * @param {{persist?: boolean}} [opts] persist=false — системный пинок, не пишем вход в историю
 */
async function reply(userId, userText, opts = {}) {
  const persist = opts.persist !== false;

  const contents = store.history(userId).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: userText }] });
  if (persist) store.pushMessage(userId, 'user', userText);

  let answer = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        safetySettings: SAFETY_SETTINGS,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: process.env.COACH_THINKING || 'LOW' },
      },
    });

    const candidate = (response.candidates || [])[0];
    const blocked =
      !candidate || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(candidate.finishReason);
    if (blocked) {
      console.warn('gemini blocked:', candidate && candidate.finishReason, response.promptFeedback);
      return 'Этот заход провайдер зарубил. Давай к делу: что с тренировкой и едой сегодня?';
    }

    // Берём текст из частей сами: response.text при наличии functionCall
    // логирует варнинг на каждый ход.
    const text = (candidate.content.parts || [])
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text)
      .join('')
      .trim();
    answer = text || answer;

    const calls = response.functionCalls || [];
    if (!calls.length) break;

    // Части модели возвращаем как есть — вместе с thoughtSignature,
    // иначе Gemini 3 теряет контекст своего же вызова.
    contents.push({ role: 'model', parts: candidate.content.parts });
    contents.push({
      role: 'user',
      parts: calls.map((call) => {
        let output;
        try {
          output = { output: runTool(userId, call.name, call.args || {}) };
        } catch (err) {
          output = { error: String(err.message || err) };
        }
        return { functionResponse: { id: call.id, name: call.name, response: output } };
      }),
    });
  }

  if (!answer) answer = 'Коротко: пиши, что съел и была ли тренировка. Разберём.';
  store.pushMessage(userId, 'assistant', answer);
  return answer;
}

module.exports = { reply, state };
