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
    [int]$Port = 0
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$WdLog = Join-Path $LogDir 'watchdog.log'

# The port belongs to config.json (or OFFICEACE2API_PORT). A hard-coded 7864 here
# meant that after someone moved the service the watchdog probed and cleared the
# WRONG port - it would happily start a second server next to a healthy one.
function Get-ListenPort {
    $fromEnv = 0
    if ($env:OFFICEACE2API_PORT) { [void][int]::TryParse($env:OFFICEACE2API_PORT, [ref]$fromEnv) }
    if ($fromEnv -gt 0) { return $fromEnv }
    $cfg = Join-Path $Root 'config.json'
    if (Test-Path -LiteralPath $cfg) {
        try {
            $json = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($json.listen.port) { return [int]$json.listen.port }
        } catch { }
    }
    return 7864
}

if ($Port -le 0) { $Port = Get-ListenPort }

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

# Node must be >= 20. src\*.mjs uses `||=`, `??=`, `??` and friends; a v14 from PATH
# dies with "SyntaxError: Unexpected token '||='" and exit code 1 in zero seconds --
# which this loop then reads as "it crashed, restart it" and backs off forever.
# That is exactly what happened on the machine this was written on: PATH had
# v14.21.2 (nvm4w) while OfficeAce shipped v22, so the scheduled-task payload could
# never start the server while tools\service.ps1 / find-node.cmd (both of which DO
# version-check) started it fine. Same contract as Resolve-Node in service.ps1.
function Test-NodeOk {
    param([string]$Path)
    if (-not $Path) { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try { $raw = (& $Path -v 2>$null) } catch { return $false }
    if (-not $raw) { return $false }
    $ver = (@($raw)[0].ToString().Trim()) -replace '^v', ''
    $major = 0
    if (-not [int]::TryParse(($ver -split '\.')[0], [ref]$major)) { return $false }
    return ($major -ge 20)
}

function Resolve-NodePath {
    # 1) value remembered by a previous run / tools\service.ps1 install
    $hint = Join-Path $Root 'data\node.txt'
    if (Test-Path -LiteralPath $hint) {
        $raw = ''
        try { $raw = [System.IO.File]::ReadAllText($hint, [System.Text.Encoding]::GetEncoding(936)).Trim() } catch { $raw = '' }
        if (Test-NodeOk -Path $raw) { return $raw }
        if ($raw) { Write-Log "data\node.txt points at an unusable node ($raw) - ignoring it" }
    }
    # 2) the node bundled with OfficeAce. It is NOT always at <drive>\OfficeAce:
    # on this machine it lives at <drive>\<folder>\OfficeAce\tools\node\node.exe.
    # Probe the direct layout and one level down, same as tools\find-node.cmd.
    foreach ($d in @('C:\', 'D:\', 'E:\', 'F:\')) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $direct = Join-Path $d 'OfficeAce\tools\node\node.exe'
        if (Test-NodeOk -Path $direct) { return $direct }
        try {
            foreach ($sub in @(Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue)) {
                $exe = Join-Path $sub.FullName 'OfficeAce\tools\node\node.exe'
                if (Test-NodeOk -Path $exe) { return $exe }
            }
        } catch { }
    }
    # 3) PATH, filtered by version. Never take the first hit blindly - that is the
    #    bug this replaced.
    foreach ($c in (Get-Command node.exe -All -ErrorAction SilentlyContinue)) {
        $src = $c.Source; if (-not $src) { $src = $c.Path }
        if ($src -and $src -notlike '*\dsh-desktop\*' -and (Test-NodeOk -Path $src)) { return $src }
    }
    # 4) the usual install locations
    foreach ($d in @($env:ProgramFiles, $env:LOCALAPPDATA)) {
        if (-not $d) { continue }
        $exe = Join-Path $d 'nodejs\node.exe'
        if (Test-NodeOk -Path $exe) { return $exe }
        $exe = Join-Path $d 'Programs\nodejs\node.exe'
        if (Test-NodeOk -Path $exe) { return $exe }
    }
    return $null
}

# Someone else (a manual restart, a stale process) may still be holding the
# port. A fresh node would fail to bind and exit immediately, so clear it.
#
# But only when it is actually dead. An earlier version killed whatever held
# the port unconditionally, which let two watchdogs take turns killing each
# other's perfectly healthy server.
# Liveness must be probed with /healthz, NOT /admin/api/state. Two traps:
#   * state is the heaviest endpoint (full model list + pool + config + usage),
#     so a busy server blows past the timeout. Observed 12:00 local: during a
#     model probe, state took longer than 10s to answer -- the watchdog then
#     concluded "nothing is serving the port", started a second node, that one
#     hit data/instance.lock and exited 1, and the loop ran 8 times before
#     Task Scheduler restarted the task.
#   * once config.admin.token is set, state answers 401 (see the isAdminRoute
#     gate in server.mjs) -- the watchdog would treat EVERY healthy instance as
#     dead, kill it and restart forever.
# healthz is a fixed few hundred bytes and bypasses the admin token, so it is
# the correct liveness probe.
function Test-Serving {
    param([int]$LocalPort)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/healthz" -TimeoutSec 5 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Clear-Port {
    param([int]$LocalPort)
    try {
        $conns = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
        if (-not $conns) { return }   # nothing on the port -> nothing to spawn
    } catch { }

    # tools\free-port.ps1 is now the single source of truth for "who holds this port
    # and may we take it": it probes /healthz, refuses to touch a healthy instance,
    # recognises Windows reserved port ranges (which look like a pid 4 listener and
    # cannot be killed) and logs everything to logs\port-clean.log. Keeping one
    # implementation means start.cmd, service.ps1 and this watchdog can never
    # disagree about what "the port is busy" means.
    #
    # It MUST run as a CHILD process: the script ends with `exit`, and `exit`
    # reached through `& script.ps1` would kill this watchdog too. The child's
    # stdout is left alone (this may be a hidden task window); the full story is in
    # logs\port-clean.log, so we only record the exit code here.
    $freePort = Join-Path $PSScriptRoot 'free-port.ps1'
    if (-not (Test-Path -LiteralPath $freePort)) {
        Write-Log 'tools\free-port.ps1 is missing - falling back to no port cleanup'
        return
    }
    $psExe = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
    try {
        & $psExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $freePort -Port $LocalPort
        Write-Log "free-port exit=$LASTEXITCODE on port $LocalPort"
    } catch {
        Write-Log "free-port failed: $($_.Exception.Message)"
    }
}

$node = Resolve-NodePath
if (-not $node) {
    Write-Log 'FATAL: no Node.js >= 20 found. Write its full path into data\node.txt'
    Write-Host '[X] node not found - see logs\watchdog.log' -ForegroundColor Red
    exit 1
}

Write-Log "watchdog up: node=$node root=$Root pid=$PID"

$consecutiveFastExits = 0
$adopted = $false
while ($true) {
    Clear-Port -LocalPort $Port

    # A server can outlive its watchdog: Stop-ScheduledTask kills the task's
    # process tree, but a node launched through Start-Process does not always
    # go with it. Clear-Port deliberately refuses to touch a *healthy*
    # instance, so without this check we would start a second one right after
    # -- it dies instantly on the single-instance lock, we see a fast exit and
    # start yet another, and the loop spins forever writing two log lines every
    # few seconds. If something is already answering on the port, adopt it:
    # watch from a distance and wait for it to actually go away.
    if (Test-Serving -LocalPort $Port) {
        if (-not $adopted) {
            Write-Log "port $Port already served by an orphan instance - adopting it, not starting a second one"
            $adopted = $true
        }
        Start-Sleep -Seconds 15
        continue
    }
    $adopted = $false

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
