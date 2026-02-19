[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$EnvFile = ".env"
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

$effectiveEnv = Join-Path $work $EnvFile
if(-not (Test-Path $effectiveEnv)){
  throw "Не найден env-файл: $effectiveEnv. Создай его (например, из .env.example / .env.debug.example / .env.prod.example)."
}

# Освободим порт 8080 (или указанный)
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue `
| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if(-not $node){ throw "Node.js не найден в PATH" }

Write-Host "[i] BASE_URL=$env:BASE_URL"
Write-Host "[i] ENV_FILE=$effectiveEnv"
Write-Host "[i] Стартуем бота (порт $Port)"
& $node.Path "--env-file=$effectiveEnv" '.\src\index.js'
