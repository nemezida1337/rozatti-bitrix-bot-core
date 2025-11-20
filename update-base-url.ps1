# ================== update-base-url.ps1 ==================
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root      = 'C:\BitrixBot\bitrix-bot-core'
$EnvPath   = Join-Path $Root '.env'
$RuntimeBA = Join-Path $Root '_runtime\BASE_URL.txt'

if (-not (Test-Path $RuntimeBA)) {
    throw "Файл $RuntimeBA не найден. Сначала запусти start-tunnel-once.ps1"
}

$baseUrlLine = Get-Content -Raw -LiteralPath $RuntimeBA
$baseUrlLine = $baseUrlLine.Trim()

if (-not $baseUrlLine.StartsWith('http')) {
    throw "В $RuntimeBA нет валидного URL: '$baseUrlLine'"
}

Write-Host "[i] Новый BASE_URL: $baseUrlLine"

$content = Get-Content -Raw -LiteralPath $EnvPath

if ($content -notmatch 'BASE_URL=') {
    $content = "BASE_URL=$baseUrlLine`r`n" + $content
} else {
    $content = $content -replace 'BASE_URL=.*', "BASE_URL=$baseUrlLine"
}

$content | Set-Content -LiteralPath $EnvPath -Encoding UTF8

Write-Host "[✓] .env обновлён."
# =========================================================
