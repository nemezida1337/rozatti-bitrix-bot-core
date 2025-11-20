[CmdletBinding()]
param(
  [int]$Port = 8080
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Set-Location $PSScriptRoot

# 1) если cloudflared не запущен — поднимем и сохраним URL
if(-not (Get-Process cloudflared -ErrorAction SilentlyContinue)){
  Write-Host "[i] Туннель не найден — запускаю..."
  & .\start-tunnel-once.ps1 -Port $Port
} else {
  $rt = Join-Path (Get-Location).Path '_runtime'
  $tx = Join-Path $rt 'BASE_URL.txt'
  if(Test-Path $tx){
    $u = (Get-Content -Raw -LiteralPath $tx).Trim()
    if($u){ Write-Host "[i] Туннель уже работает: $u" }
  } else {
    Write-Host "[!] Туннель работает, но BASE_URL.txt не найден. При случае запусти start-tunnel-once.ps1."
  }
}

# 2) перезапуск сервера
& .\run-bot.ps1 -Port $Port