#!/usr/bin/env bash
# Разворачивает бота-тренера как сервис systemd.
# Запускать из корня репозитория на сервере:  sudo bash deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-$(logname 2>/dev/null || echo "$SUDO_USER")}"
LOG_DIR="/var/log/coach"
UNIT="/etc/systemd/system/coach.service"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Проверяю окружение"
command -v node >/dev/null || { echo "Нет node. Поставь Node.js 20+ и повтори."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Нужен Node.js 20+, сейчас $(node -v)."; exit 1; }
[ -n "$SERVICE_USER" ] || { echo "Не определил пользователя. Запусти с SERVICE_USER=имя."; exit 1; }
echo "Каталог: $APP_DIR, пользователь: $SERVICE_USER, $(node -v)"

say "Проверяю .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "Создал .env из шаблона — заполни и запусти скрипт снова:"
  echo "  TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, OWNER_TELEGRAM_ID, BOT_TZ"
  exit 1
fi
for KEY in TELEGRAM_BOT_TOKEN GEMINI_API_KEY; do
  grep -qE "^${KEY}=.+" "$APP_DIR/.env" || { echo "В .env не заполнен $KEY"; exit 1; }
done
grep -qE "^OWNER_TELEGRAM_ID=.+" "$APP_DIR/.env" ||
  echo "ВНИМАНИЕ: OWNER_TELEGRAM_ID пуст — бот будет отвечать любому, кто его найдёт."

say "Ставлю зависимости"
sudo -u "$SERVICE_USER" npm ci --omit=dev --prefix "$APP_DIR" 2>/dev/null ||
  sudo -u "$SERVICE_USER" npm install --omit=dev --prefix "$APP_DIR"

say "Готовлю каталоги"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR/data" "$LOG_DIR"

say "Ставлю сервис"
sed -e "s|^User=.*|User=${SERVICE_USER}|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=${APP_DIR}/.env|" \
    -e "s|^ExecStart=.*|ExecStart=$(command -v node) bot/index.js|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=${APP_DIR}/data ${LOG_DIR}|" \
    "$APP_DIR/deploy/coach.service" > "$UNIT"

systemctl daemon-reload
systemctl enable coach >/dev/null
systemctl restart coach

say "Проверяю запуск"
sleep 4
if systemctl is-active --quiet coach; then
  echo "Бот работает. Логи: journalctl -u coach -f"
  systemctl --no-pager --lines=5 status coach || true
else
  echo "Не поднялся. Смотри: journalctl -u coach -n 50 --no-pager"
  exit 1
fi
