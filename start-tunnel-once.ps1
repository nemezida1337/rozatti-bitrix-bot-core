[CmdletBinding()]
param(
  [int]$Port = 8080
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Set-Location $PSScriptRoot

$work   = (Get-Location).Path
$logs   = Join-Path $work 'logs'
$rt     = Join-Path $work '_runtime'
$logOut = Join-Path $logs 'cloudflared_quick.out.log'
$logErr = Join-Path $logs 'cloudflared_quick.err.log'
$baseTx = Join-Path $rt   'BASE_URL.txt'

function Get-LastQuickTunnelUrl {
  param(
    [string[]]$Paths
  )

  $rx = [regex]'https?://[a-z0-9\-\.]+\.trycloudflare\.com'
  $quick = $null

  foreach($p in $Paths){
    if(Test-Path $p){
      $t = Get-Content -Raw -LiteralPath $p -ErrorAction SilentlyContinue
      if($t){
        $matches = $rx.Matches($t)
        if($matches.Count -gt 0){
          # Берём последний URL из файла, иначе можно схватить давно протухший tunnel.
          $quick = $matches[$matches.Count - 1].Value
        }
      }
    }
  }

  return $quick
}

# cloudflared путь
$cf = Join-Path $work 'bin\cloudflared.exe'
if (-not (Test-Path $cf)) {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  $cf  = $cmd ? $cmd.Path : 'cloudflared'
}

# если cloudflared уже работает — не трогаем, просто пытаемся взять URL
if (Get-Process cloudflared -ErrorAction SilentlyContinue) {
  $quick = Get-LastQuickTunnelUrl -Paths @($logOut,$logErr)
  if(-not $quick -and (Test-Path $baseTx)){ $quick=(Get-Content -Raw $baseTx).Trim() }
  if($quick){
    Set-Content -LiteralPath $baseTx -Value $quick -Encoding utf8
    Write-Host "[i] cloudflared уже запущен"
    Write-Host "    Quick Tunnel URL: $quick"
    return
  } else {
    Write-Warning "cloudflared запущен, но URL не найден в логах. При необходимости перезапусти туннель."
    return
  }
}

# стартуем новый Quick-туннель (IPv4 loopback!)
if(Test-Path $logOut){ Clear-Content -LiteralPath $logOut -ErrorAction SilentlyContinue }
if(Test-Path $logErr){ Clear-Content -LiteralPath $logErr -ErrorAction SilentlyContinue }

$cfArgs = @('tunnel','--url',"http://127.0.0.1:$Port",'--edge-ip-version','auto','--no-autoupdate')
Write-Host "[+] Starting QUICK tunnel: $cf $($cfArgs -join ' ')"
$proc = Start-Process -FilePath $cf -ArgumentList $cfArgs `
  -RedirectStandardOutput $logOut -RedirectStandardError $logErr `
  -PassThru -WindowStyle Hidden

# ждём URL
$deadline = (Get-Date).AddSeconds(25)
$quick = $null
while((Get-Date) -lt $deadline){
  $quick = Get-LastQuickTunnelUrl -Paths @($logOut,$logErr)
  if($quick){ break }
  Start-Sleep -Milliseconds 300
}
if(-not $quick){
  Write-Warning "Не удалось вытащить URL Quick Tunnel из логов."
  if(Test-Path $logOut){ Get-Content -LiteralPath $logOut | Select-Object -Last 30 }
  if(Test-Path $logErr){ Get-Content -LiteralPath $logErr | Select-Object -Last 30 }
  throw "cloudflared не выдал публичный URL."
}
Set-Content -LiteralPath $baseTx -Value $quick -Encoding utf8
try{ Set-Clipboard -Value $quick }catch{}
Write-Host "[✓] Quick Tunnel URL: $quick"
Write-Host "[i] Сохранён в: $baseTx"
