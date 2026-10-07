const path = require('path');
const express = require('express');

const store = require('./db');
const stats = require('./stats');
const progress = require('./progress');
const { computeTargets } = require('./nutrition');

const PORT = Number(process.env.DASH_PORT) || 3100;
const BASE_URL = process.env.DASH_BASE_URL || `http://localhost:${PORT}`;

function linkFor(userId) {
  return `${BASE_URL}/d/${store.dashToken(userId)}`;
}

function start() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/d/:token/data', (req, res) => {
    const user = store.userByToken(req.params.token);
    if (!user) return res.status(404).json({ error: 'not found' });

    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    const full = stats.summary(user.id, days);
    res.json({
      photos: store.progressPhotos(user.id, 60).map((p) => ({ id: p.id, day: p.day, weight: p.weight_kg, note: p.note })),
      name: user.name,
      goal: user.goal,
      targets: computeTargets(user),
      summary: { food: full.food, training: full.training, weight: full.weight, period_days: full.period_days },
      series: full.series,
    });
  });

  app.get('/d/:token/photo/:id', (req, res) => {
    const user = store.userByToken(req.params.token);
    if (!user) return res.status(404).end();
    const row = store.progressPhoto(user.id, Number(req.params.id));
    if (!row) return res.status(404).end();
    res.sendFile(progress.fileFor(row));
  });

  app.get('/d/:token', (req, res) => {
    if (!store.userByToken(req.params.token)) return res.status(404).send('Нет такой страницы');
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  app.listen(PORT, () => console.log(`Дашборд: ${BASE_URL}/d/<токен>`));
}

module.exports = { start, linkFor };
