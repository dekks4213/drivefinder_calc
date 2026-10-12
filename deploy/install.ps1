# Разворачивает бота-тренера службой Windows. Запускать в PowerShell от администратора:
#   powershell -ExecutionPolicy Bypass -File install.ps1
# Служба ставится, но НЕ запускается: два бота на одном токене Telegram конфликтуют,
# поэтому сначала глушится старый экземпляр, и только потом даётся -Start.
param(
  [string]$Path   = 'C:\coach',
  [string]$Branch = 'claude/personal-trainer-nutritionist-bot-qiqkf5',
  [string]$Repo   = 'https://github.com/dekks4213/drivefinder_calc.git',
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
function Say($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Die($text) { Write-Host "`n$text" -ForegroundColor Red; exit 1 }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die 'Нужен PowerShell от администратора: правой кнопкой по значку, "Запуск от имени администратора".'
}

Say 'Проверяю Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say 'Node не найден, ставлю через winget'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Die 'Node установлен. Закрой это окно, открой PowerShell заново от администратора и запусти скрипт ещё раз.'
}
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) { Die "Нужен Node.js 20 или новее, сейчас $(node -v). Обнови и повтори." }
Write-Host "Node $(node -v) подходит"

Say 'Проверяю git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
  Die 'Git установлен. Открой PowerShell заново от администратора и запусти скрипт ещё раз.'
}

Say "Забираю код в $Path"
if (Test-Path (Join-Path $Path '.git')) {
  git -C $Path fetch origin $Branch
  git -C $Path checkout $Branch
  git -C $Path reset --hard "origin/$Branch"
} else {
  git clone -b $Branch $Repo $Path
}

Say 'Ставлю зависимости'
Push-Location $Path
try {
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) {
    Die @'
Зависимости не собрались. Чаще всего это better-sqlite3 или sharp без готовой сборки под твою версию Node.
Пришли вывод ошибки — переведём на Docker или WSL, там этой проблемы нет.
'@
  }
} finally { Pop-Location }

$dataDir = Join-Path $Path 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Say 'Проверяю .env'
$envFile = Join-Path $Path '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $Path '.env.example') $envFile
  Die @"
Создал $envFile из шаблона. Заполни в нём TELEGRAM_BOT_TOKEN и GEMINI_API_KEY,
поставь COACH_HARSHNESS=brutal и BACKUP_CHAT_ID=135146146, потом запусти скрипт снова.
"@
}
foreach ($key in @('TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY')) {
  if (-not (Select-String -Path $envFile -Pattern "^$key=.+" -Quiet)) { Die "В .env не заполнен $key" }
}

$db = Join-Path $dataDir 'coach.db'
if (-not (Test-Path $db)) {
  Write-Host "ВНИМАНИЕ: $db не найден. Положи сюда файл базы из Telegram, иначе бот стартует пустым." -ForegroundColor Yellow
}

Say 'Проверяю NSSM'
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  winget install -e --id NSSM.NSSM --accept-source-agreements --accept-package-agreements
  Die 'NSSM установлен. Открой PowerShell заново от администратора и запусти скрипт ещё раз.'
}

Say 'Ставлю службу coach'
$node = (Get-Command node).Source
$log  = Join-Path $dataDir 'bot.log'
if (nssm status coach 2>$null) { nssm stop coach | Out-Null; nssm remove coach confirm | Out-Null }
nssm install coach $node 'bot\index.js'  | Out-Null
nssm set coach AppDirectory $Path        | Out-Null
nssm set coach AppStdout $log            | Out-Null
nssm set coach AppStderr $log            | Out-Null
nssm set coach AppRotateFiles 1          | Out-Null
nssm set coach AppRotateBytes 10485760   | Out-Null
nssm set coach Start SERVICE_AUTO_START  | Out-Null
nssm set coach AppExit Default Restart   | Out-Null
nssm set coach AppRestartDelay 5000      | Out-Null

if ($Start) {
  Say 'Запускаю'
  nssm start coach | Out-Null
  Start-Sleep -Seconds 6
  nssm status coach
  if (Test-Path $log) { Get-Content $log -Tail 15 }
  Write-Host "`nГотово. Логи: Get-Content $log -Tail 30 -Wait" -ForegroundColor Green
} else {
  Write-Host @"

Служба coach создана и будет подниматься сама после перезагрузки, но пока НЕ запущена.
Два бота на одном токене Telegram конфликтуют, поэтому сначала скажи об этом в чат —
облачная копия будет остановлена и пришлёт свежий файл базы. Потом положи его в
$dataDir и запусти:  nssm start coach
"@ -ForegroundColor Yellow
}
