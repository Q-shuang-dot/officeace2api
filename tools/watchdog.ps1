# officeace2api watchdog (ASCII only - safe under CJK code pages)
#
# Why this exists: Task Scheduler's own RestartOnFailure only fires when the
# task exits with a non-zero result. A node process that gets killed, or that
# exits 0 after a crash handler, looks "successful" and is never restarted --
# which is exactly how the service silently died overnight once.
#
# This wrapper is the task's payload instead of node.exe itself. It runs the
# server in a loop and restarts it whenever it goes away, no matter the exit
# code. It never returns on its own.
#
#   powershell -ExecutionPolicy Bypass -File tools/watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File tools/watchdog.ps1 -Once

param(
    [switch]$Once,
    [int]$Port = 7864
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$WdLog = Join-Path $LogDir 'watchdog.log'

# --- single instance -------------------------------------------------------
# Two watchdogs fight: each one's Clear-Port kills the other's server, forever.
# The scheduled task already says MultipleInstances=IgnoreNew, but a manual
# tools\service.ps1 start can still add a second one.
$mutex = New-Object System.Threading.Mutex($false, 'Global\officeace2api-watchdog')
$haveLock = $false
try { $haveLock = $mutex.WaitOne(0) } catch { $haveLock = $true }
if (-not $haveLock) {
    $line = '[{0}] another watchdog already running - exiting' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    try { Add-Content -LiteralPath $WdLog -Value $line -Encoding UTF8 } catch { }
    Write-Host '[i] another watchdog is already running; nothing to do.' -ForegroundColor Yellow
    exit 0
}

function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -LiteralPath $WdLog -Value $line -Encoding UTF8 } catch { }
}

function Resolve-NodePath {
    $hint = Join-Path $Root 'data\node.txt'
    if (Test-Path -LiteralPath $hint) {
        $raw = ''
        try { $raw = [System.IO.File]::ReadAllText($hint, [System.Text.Encoding]::GetEncoding(936)).Trim() } catch { $raw = '' }
        if ($raw -and (Test-Path -LiteralPath $raw)) { return $raw }
    }
    foreach ($d in @('C:\', 'D:\', 'E:\', 'F:\')) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $exe = Join-Path $d 'OfficeAce\tools\node\node.exe'
        if (Test-Path -LiteralPath $exe) { return $exe }
    }
    foreach ($c in (Get-Command node.exe -All -ErrorAction SilentlyContinue)) {
        $src = $c.Source; if (-not $src) { $src = $c.Path }
        if ($src -and $src -notlike '*\dsh-desktop\*') { return $src }
    }
    return $null
}

# Someone else (a manual restart, a stale process) may still be holding the
# port. A fresh node would fail to bind and exit immediately, so clear it.
#
# But only when it is actually dead. An earlier version killed whatever held
# the port unconditionally, which let two watchdogs take turns killing each
# other's perfectly healthy server.
function Test-Serving {
    param([int]$LocalPort)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/admin/api/state" -TimeoutSec 3 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Clear-Port {
    param([int]$LocalPort)
    try {
        $conns = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
        if (-not $conns) { return }
        if (Test-Serving -LocalPort $LocalPort) {
            Write-Log "port $LocalPort is already serving a healthy instance - not touching it"
            return
        }
        foreach ($c in $conns) {
            Write-Log "port $LocalPort held by pid $($c.OwningProcess) and not answering - stopping it"
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    } catch { }
}

$node = Resolve-NodePath
if (-not $node) {
    Write-Log 'FATAL: no Node.js >= 20 found. Write its full path into data\node.txt'
    Write-Host '[X] node not found - see logs\watchdog.log' -ForegroundColor Red
    exit 1
}

Write-Log "watchdog up: node=$node root=$Root pid=$PID"

$consecutiveFastExits = 0
while ($true) {
    Clear-Port -LocalPort $Port

    $started = Get-Date
    Write-Log "starting server"
    $proc = $null
    try {
        # NOT -NoNewWindow: that puts node on the watchdog's own console, so a
        # console close or Ctrl+C takes out the watchdog and the server at the
        # same instant -- the watchdog never gets to log the exit or restart.
        # That is exactly how the service used to vanish with exit 0xC000013A.
        $proc = Start-Process -FilePath $node -ArgumentList 'src\index.mjs' -WorkingDirectory $Root -WindowStyle Hidden -PassThru
        $proc.WaitForExit()
    } catch {
        Write-Log "failed to start: $($_.Exception.Message)"
    }

    $ranSeconds = [int]((Get-Date) - $started).TotalSeconds
    $code = if ($proc) { $proc.ExitCode } else { 'n/a' }
    Write-Log "server exited code=$code after ${ranSeconds}s"

    if ($Once) { exit 0 }

    # A run that lasted a while counts as healthy: reset the backoff so a crash
    # after a long uptime still restarts immediately.
    if ($ranSeconds -ge 300) { $consecutiveFastExits = 0 }
    $consecutiveFastExits++

    # Back off when it keeps dying instantly (bad config, port taken, syntax
    # error) so we do not spin at 100% CPU forever.
    $delay = [Math]::Min(120, 3 * [Math]::Min($consecutiveFastExits, 40))
    Write-Log "restarting in ${delay}s (fast-exit streak $consecutiveFastExits)"
    Start-Sleep -Seconds $delay
}
