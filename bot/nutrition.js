const ACTIVITY = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  high: 1.725,
  athlete: 1.9,
};

const GOAL_SHIFT = { cut: -0.2, recomp: -0.1, maintain: 0, bulk: 0.12 };
const PROTEIN_PER_KG = { cut: 2.2, recomp: 2.0, maintain: 1.8, bulk: 2.0 };
const FAT_PER_KG = { cut: 0.8, recomp: 0.85, maintain: 0.9, bulk: 1.0 };

const REQUIRED = ['sex', 'age', 'height_cm', 'weight_kg', 'activity', 'goal'];

function missingFields(p) {
  return REQUIRED.filter((f) => p[f] === null || p[f] === undefined || p[f] === '');
}

/** Mifflin-St Jeor + коэффициент активности + коррекция под цель. */
function computeTargets(p) {
  const missing = missingFields(p);
  if (missing.length) return { missing };

  const w = Number(p.weight_kg);
  const bmr = 10 * w + 6.25 * Number(p.height_cm) - 5 * Number(p.age) + (p.sex === 'female' ? -161 : 5);
  const factor = ACTIVITY[p.activity] || ACTIVITY.moderate;
  const tdee = bmr * factor;
  const goal = GOAL_SHIFT[p.goal] !== undefined ? p.goal : 'maintain';

  // Жёсткий минимум, чтобы дефицит не уезжал в голодание.
  const floor = p.sex === 'female' ? 1300 : 1600;
  const kcal = Math.max(Math.round((tdee * (1 + GOAL_SHIFT[goal])) / 10) * 10, floor);

  const protein = Math.round(w * PROTEIN_PER_KG[goal]);
  let fat = Math.round(w * FAT_PER_KG[goal]);
  let carbs = Math.round((kcal - protein * 4 - fat * 9) / 4);

  if (carbs < 60) {
    // Углеводы не ниже разумного минимума — добираем за счёт жира.
    carbs = 60;
    fat = Math.max(Math.round((kcal - protein * 4 - carbs * 4) / 9), Math.round(w * 0.6));
  }

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    kcal,
    protein,
    fat,
    carbs,
    water_ml: Math.round(w * 33),
    goal,
  };
}

module.exports = { computeTargets, missingFields, ACTIVITY, GOAL_SHIFT };
