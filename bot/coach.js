const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const store = require('./db');
const { computeTargets } = require('./nutrition');
const { buildPlan, formatPlan, dayFor } = require('./plan');
const exercises = require('./exercises');
const stats = require('./stats');

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
  brutal: `ТОН: максимально жёсткий.
- Мат в каждом сообщении, а не только когда он виляет. Рубленые короткие фразы, никакой гладкой речи.
- Ноль утешений, ноль «понимаю», ноль «бывает». Никаких смягчающих оговорок и вежливых концовок.
- Высмеиваешь саму отмазку — в лицо, с конкретикой: зачитываешь даты и формулировки его прошлых отмазок из статистики, считаешь слитые недели, называешь слив сливом.
- Не предлагаешь выбор вопросом «что выберешь?». Ставишь ультиматум с дедлайном: что он делает и к какому времени отчитывается. Требуешь отчёт по часам («через 40 минут пишешь, что зашёл в зал»).
- Он пытается съехать на другую тему — возвращаешь к незакрытому вопросу, пока не ответит по делу.
- Высмеиваешь отмазку и поступок, но НИКОГДА не человека: границы ниже сильнее этого тона и не отменяются ни на слово.`,
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
- Вес и состав тела — только как цифра и цель: «88 кг при цели 80», «на дефиците 2320 ккал». Нельзя подавать его тело как мерзость или угрожать им: «заплывёшь жиром», «разжирел», «пузо», «превратишься в тушу» — запрещено на любом уровне жёсткости. Отмазка смешная — тело нет.
- Никаких ярлыков на человека: «мешок», «ничтожество», «тряпка», «слабак» и подобное — запрещено даже на максимальной жёсткости. Ругай действие: «слил», «проебал», «выбрал поныть вместо тренировки».
- Не поощряешь голодание, дефицит ниже расчётного минимума, тренировки на больном, «добить через боль».
- Если травма, болезнь, температура, сильная боль, несколько суток сна меньше 5 часов, признаки расстройства пищевого поведения или психологический кризис — моментально переключаешься на спокойный режим: давление выключено, предлагаешь отдых или адаптацию нагрузки, при симптомах РПП или кризиса советуешь живого специалиста. Разбор отмазок к этому не применяется, и такой день не считается прогулом.`;

const DATA = `РАБОТА С ДАННЫМИ
- Перед любым разговором о калориях, весе, плане или дисциплине вызывай get_state. Не угадывай его цифры.
- Если профиль неполный — задаёшь не больше двух вопросов за раз и пишешь данные через update_profile. Не мучай анкетой: спрашивай то, без чего нельзя считать (пол, возраст, рост, вес, активность, цель).
- Просит расписать питание или меню — расписываешь, это твоя работа. Конкретно: 3-4 приёма пищи, продукты с граммовкой, под его норму калорий и белка. Отказы вида «я тебе не нянька», «сам разбирайся» ЗАПРЕЩЕНЫ: жёсткость — про дисциплину, а не про отказ делать то, за чем он пришёл. Жёстко можно требовать отчёт о съеденном, но меню ты даёшь.
- В дневник идёт только его реальная порция. Витрина, стоковая картинка, продукты в упаковке, стол на компанию, еда явно не его — не записываешь вообще, а требуешь фото своей тарелки. Инструмент такие цифры и сам отклонит.
- Прислал фото еды — оцениваешь по картинке: что на тарелке, сколько примерно граммов, и сразу пишешь через log_meal. Порции по фото определяются приблизительно, так и говори: «на глаз». Если из кадра не понять ключевое (масло в салате, соус, сахар в кофе, размер порции без ориентира) — оценивай по худшему сценарию и одним вопросом уточняй, а не выдумывай точную цифру.
- Любую еду, которую он описал словами, оцениваешь сам и пишешь через log_meal: калории и БЖУ — твоя оценка, помечай её как оценку, не делай вид, что это точность до грамма.
- Тренировку фиксируешь через log_workout. План строишь через build_plan, когда известны цель, количество дней и место. Полный план с упражнениями уходит пользователю отдельным сообщением автоматически — не пересказывай его целиком, скажи пару слов и переходи к требованию.
- Числа из инструментов используешь как есть, не придумываешь свои.
- Когда даёшь новое упражнение, объясняешь технику или он спрашивает «как это делать» — показывай через show_exercise: прилетит фото упражнения и схема задействованных мышц. Запрос в инструмент пиши ПО-АНГЛИЙСКИ («barbell squat», «romanian deadlift»), база англоязычная. Не вызывай его на каждое сообщение — только когда картинка реально помогает.
- Инструмент сам проверяет картинку перед отправкой. Если он вернул ok: false — картинки не будет, объясняй словами и не ври, что что-то отправил.

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
    name: 'show_exercise',
    description:
      'Показать упражнение: реальное фото из базы wger + схема задействованных мышц (основные красным, вспомогательные светлым). Запрос ТОЛЬКО на английском. Картинки уходят пользователю автоматически, тебе возвращается карточка упражнения.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название упражнения по-английски, например barbell squat' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_stats',
    description:
      'Полный учёт за период: сколько дней записана еда, средние калории и белок против нормы, процент попаданий в норму, сделанные и пропущенные тренировки, минуты под нагрузкой, динамика веса. Бери это, когда он спрашивает «как у меня дела», «сколько я съел за неделю», «какой прогресс», и когда разбираешь дисциплину.',
    parameters: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Период в днях, по умолчанию 30' } },
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

async function runTool(userId, name, args = {}, media = [], extras = []) {
  switch (name) {
    case 'get_state':
      return state(userId);

    case 'update_profile': {
      if (args.weight_kg) store.addWeight(userId, args.weight_kg);
      const user = store.updateUser(userId, args);
      const targets = computeTargets(user);
      if (!targets.missing) store.setTargets(userId, targets);
      return { saved: args, targets };
    }

    case 'log_meal': {
      // Страховка дневника: одна порция не бывает такой. Чаще всего это
      // витрина или стоковое фото — записывать такое нельзя, день поедет.
      if (!(args.kcal > 0) || args.kcal > 3000 || args.protein > 300 || args.fat > 300 || args.carbs > 500) {
        return {
          ok: false,
          reason: 'Нереалистичная порция, в дневник не записано. Это похоже не на его тарелку — потребуй фото реальной порции или описание словами.',
        };
      }
      store.addMeal(userId, args);
      const s = state(userId);
      return { logged: true, today: s.today.eaten, left_kcal: s.today.left_kcal, left_protein: s.today.left_protein };
    }

    case 'log_workout': {
      store.addWorkout(userId, args);
      return { logged: true, training_stats: store.trainingStats(userId, 30) };
    }

    case 'show_exercise': {
      const res = await exercises.prepare(args.query || '');
      if (!res.ok) return { ok: false, reason: res.reason };
      media.push(...res.media);
      return { ok: true, sent_photos: res.media.length, exercise: res.exercise };
    }

    case 'get_stats': {
      const full = stats.summary(userId, args.days || 30);
      // Посуточный ряд в модель не отдаём — это десятки строк на каждый ход.
      const { series, ...rest } = full;
      return rest;
    }

    case 'get_diary':
      return store.diary(userId, args.days || 7);

    case 'build_plan': {
      const user = store.updateUser(userId, { days_per_week: args.days_per_week, location: args.location });
      const plan = buildPlan({ days_per_week: args.days_per_week, location: args.location, goal: user.goal || 'maintain' });
      store.setPlan(userId, plan);
      extras.push(formatPlan(plan));
      return {
        saved: true,
        days_per_week: plan.days_per_week,
        location: plan.location,
        days: plan.days.map((d) => `${d.weekday}: ${d.title}`),
        note: 'Полный план уже отправлен пользователю отдельным сообщением. Не пересказывай его целиком.',
      };
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

  // Картинка идёт перед текстом и только в текущем ходе: в историю
  // пишется пометка, чтобы не таскать фото в каждом следующем запросе.
  const parts = [];
  if (opts.image) parts.push({ inlineData: { mimeType: opts.image.mimeType, data: opts.image.buffer.toString('base64') } });
  parts.push({ text: userText });
  contents.push({ role: 'user', parts });

  if (persist) store.pushMessage(userId, 'user', opts.image ? `[фото] ${userText}` : userText);

  let answer = '';
  const media = [];
  const extras = [];
  let malformed = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        safetySettings: SAFETY_SETTINGS,
        maxOutputTokens: 8192,
        // На повторе после сломанного вызова думаем дольше: структурный
        // вывод у модели разваливается именно на поверхностном режиме.
        thinkingConfig: { thinkingLevel: malformed ? 'MEDIUM' : process.env.COACH_THINKING || 'LOW' },
      },
    });

    const candidate = (response.candidates || [])[0];

    // Gemini периодически генерирует невалидный вызов инструмента или вовсе
    // не отдаёт кандидата. Лечится повтором; после двух неудач уходим в
    // добивающий ответ без инструментов, а не в заглушку пользователю.
    if (!candidate || candidate.finishReason === 'MALFORMED_FUNCTION_CALL') {
      if (malformed < 2) {
        malformed += 1;
        console.warn(`пустой или сломанный ответ (${candidate ? candidate.finishReason : 'нет кандидата'}), повтор ${malformed}/2`);
        continue;
      }
      break;
    }

    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(candidate.finishReason)) {
      console.warn('gemini blocked:', candidate.finishReason, response.promptFeedback);
      return { text: 'Этот заход провайдер зарубил. Давай к делу: что с тренировкой и едой сегодня?', media, extras };
    }

    // Берём текст из частей сами: response.text при наличии functionCall
    // логирует варнинг на каждый ход.
    const text = (candidate.content.parts || [])
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text)
      .join('')
      .trim();
    answer = text || answer;
    if (!text && candidate.finishReason === 'MAX_TOKENS') {
      console.warn('ответ обрезан по maxOutputTokens, текста не осталось');
    }

    const calls = response.functionCalls || [];
    if (process.env.COACH_DEBUG) {
      console.log(
        `  [раунд ${round}] finish=${candidate.finishReason} частей=${(candidate.content.parts || []).length}` +
          ` вызовы=${calls.map((c) => c.name).join(',') || '-'} текст=${text.length} симв.` +
          ` токены=${JSON.stringify(response.usageMetadata && { out: response.usageMetadata.candidatesTokenCount, think: response.usageMetadata.thoughtsTokenCount })}`
      );
    }
    if (!calls.length) break;

    // Части модели возвращаем как есть — вместе с thoughtSignature,
    // иначе Gemini 3 теряет контекст своего же вызова.
    contents.push({ role: 'model', parts: candidate.content.parts });
    const parts = await Promise.all(
      calls.map(async (call) => {
        let output;
        try {
          output = { output: await runTool(userId, call.name, call.args || {}, media, extras) };
        } catch (err) {
          output = { error: String(err.message || err) };
        }
        return { functionResponse: { id: call.id, name: call.name, response: output } };
      })
    );
    contents.push({ role: 'user', parts });
  }

  // Модель иногда уходит в инструменты и не оставляет текста. Добиваем
  // ответ отдельным запросом без инструментов, чтобы не слать заглушку.
  if (!answer) {
    try {
      const final = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction:
            media.length || extras.length
              ? `${SYSTEM}\n\nФото и материалы пользователю уже отправлены. Коротко прокомментируй их и переходи к требованию.`
              : `${SYSTEM}\n\nСЕЙЧАС ИНСТРУМЕНТЫ НЕДОСТУПНЫ. Отвечай словами. Не обещай и не утверждай, что отправил фото, схему или план — ничего не отправлено.`,
          safetySettings: SAFETY_SETTINGS,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: 'LOW' },
        },
      });
      answer = ((final.candidates || [])[0]?.content?.parts || [])
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text)
        .join('')
        .trim();
    } catch (err) {
      console.warn('добивающий запрос не прошёл:', err.message);
    }
  }
  if (!answer) answer = 'Данные записал. Пиши, что дальше: еда, тренировка или план.';

  store.pushMessage(userId, 'assistant', answer);
  return { text: answer, media, extras };
}

module.exports = { reply, state };
