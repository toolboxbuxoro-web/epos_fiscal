# EPOS Fiscal — авто-установка dev-окружения на Windows.
#
# Запуск (в PowerShell, можно НЕ от админа — winget сам спросит права когда нужно):
#   irm https://raw.githubusercontent.com/toolboxbuxoro-web/epos_fiscal/main/scripts/setup-windows.ps1 | iex
#
# После завершения откроется PowerShell — там запусти `npm run dev`.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Step($n, $title) {
    Write-Host ""
    Write-Host "==> [$n] $title" -ForegroundColor Cyan
}

function Have($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ─────────────────────────────────────────────────────────────────
Write-Host "EPOS Fiscal — установка dev-окружения" -ForegroundColor Green
Write-Host "Это займёт ~20–30 минут (Visual Studio Build Tools ~6 ГБ)." -ForegroundColor Yellow

$wingetArgs = '--accept-package-agreements', '--accept-source-agreements', '--silent'

Step 1 'Node.js LTS'
if (Have node) {
    Write-Host "уже установлен: $(node -v)"
} else {
    winget install -e --id OpenJS.NodeJS.LTS @wingetArgs
}

Step 2 'Rust toolchain'
if (Have rustc) {
    Write-Host "уже установлен: $(rustc --version)"
} else {
    winget install -e --id Rustlang.Rustup @wingetArgs
}

Step 3 'Visual Studio 2022 Build Tools (компилятор C++ для Rust)'
$vsExists = Test-Path 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC'
if ($vsExists) {
    Write-Host "уже установлены"
} else {
    winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
        --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' `
        @wingetArgs
}

Step 4 'Git'
if (Have git) {
    Write-Host "уже установлен: $(git --version)"
} else {
    winget install -e --id Git.Git @wingetArgs
}

Step 5 'WebView2 Runtime (на Win 10/11 обычно уже есть)'
winget install -e --id Microsoft.EdgeWebView2Runtime @wingetArgs 2>$null

# ─────────────────────────────────────────────────────────────────
Step 6 'Клонирую репозиторий в %USERPROFILE%\Desktop\epos_fiscal'
$repoDir = Join-Path $env:USERPROFILE 'Desktop\epos_fiscal'
if (Test-Path $repoDir) {
    Write-Host "репо уже есть, делаю git pull"
    Set-Location $repoDir
    git pull
} else {
    git clone https://github.com/toolboxbuxoro-web/epos_fiscal.git $repoDir
    Set-Location $repoDir
}

Step 7 'Устанавливаю npm-зависимости (~1 минута)'
& "$env:ProgramFiles\nodejs\npm.cmd" install

# ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Готово!" -ForegroundColor Green
Write-Host ""
Write-Host "Дальше:"
Write-Host "  1. Перезапусти PowerShell (чтобы PATH подхватил новый Rust/Node)"
Write-Host "  2. cd $repoDir"
Write-Host "  3. npm run dev      # запустит приложение в dev-режиме"
Write-Host "  4. npm run build    # соберёт production .exe (~10 мин первый раз)"
Write-Host ""
Write-Host "Готовый .exe появится в:"
Write-Host "  $repoDir\src-tauri\target\release\bundle\nsis\"
