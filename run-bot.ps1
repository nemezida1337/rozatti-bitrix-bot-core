[CmdletBinding()]
param(
  [int]$Port = 8080
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Set-Location $PSScriptRoot

$work   = (Get-Location).Path
$rt     = Join-Path $work '_runtime'
$baseTx = Join-Path $rt 'BASE_URL.txt'
if(-not (Test-Path $baseTx)){ throw "Не найден $baseTx. Сначала запусти .\start-tunnel-once.ps1" }
$BASE_URL = (Get-Content -Raw -LiteralPath $baseTx).Trim()
if(-not $BASE_URL){ throw "BASE_URL пуст. Перезапусти туннель." }
$env:BASE_URL = $BASE_URL

# .env для ABCP (если нет — создадим черновик)
$envFile = Join-Path $work '.env'
if(-not (Test-Path $envFile)){
@"
ABCP_HOST=abcp75363.public.api.abcp.ru
ABCP_USERLOGIN=api@abcp75363
ABCP_USERPSW_MD5=2fc26d717da126b06b786c73f0f4e358
"@ | Set-Content -LiteralPath $envFile -Encoding utf8
}

# Освободим порт 8080 (или указанный)
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue `
| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if(-not $node){ throw "Node.js не найден в PATH" }

Write-Host "[i] BASE_URL=$env:BASE_URL"
Write-Host "[i] Стартуем бота (порт $Port)"
& $node.Path '--env-file=.env' '.\src\index.js'