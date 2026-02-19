# dev.ps1 — удобный запуск бота в DEV: UTF-8 + туннель + сервер

[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location $PSScriptRoot

# 0) Нормальная кодировка для логов (чтобы не было кракозябр)
try {
  chcp 65001 | Out-Null
} catch { }

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

Write-Host "[dev] Кодировка консоли: UTF-8" -ForegroundColor Cyan

# 1) Поднимаем Cloudflare-туннель, если он ещё не запущен
if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "[dev] Туннель не найден — запускаю..." -ForegroundColor Yellow
  & .\start-tunnel-once.ps1 -Port $Port
} else {
  $rt = Join-Path (Get-Location).Path '_runtime'
  $tx = Join-Path $rt 'BASE_URL.txt'
  if (Test-Path $tx) {
    $u = (Get-Content -Raw -LiteralPath $tx).Trim()
    if ($u) {
      Write-Host "[dev] Туннель уже работает: $u" -ForegroundColor Green
    }
  } else {
    Write-Host "[dev] Внимание: cloudflared запущен, но BASE_URL.txt не найден." -ForegroundColor Yellow
  }
}

# 2) Запускаем бота
Write-Host "[dev] Стартую сервер бота..." -ForegroundColor Cyan
& .\run-bot.ps1 -Port $Port -EnvFile $EnvFile
