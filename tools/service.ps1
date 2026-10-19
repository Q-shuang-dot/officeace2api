# officeace2api service manager (ASCII only - safe under CJK code pages)
#
#   powershell -ExecutionPolicy Bypass -File tools/service.ps1 install [-Autostart]
#   powershell -ExecutionPolicy Bypass -File tools/service.ps1 uninstall
#   powershell -ExecutionPolicy Bypass -File tools/service.ps1 start | stop | restart | status
#
# Why a scheduled task: a process started from a console window dies together
# with that window. Running it as a scheduled task detaches it from the console
# (Task Scheduler owns it) and optionally starts it at every logon.

param(
    [Parameter(Position = 0)][string]$Action = 'status',
    [switch]$Autostart
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'officeace2api'

# The port is configurable (config.json listen.port, or OFFICEACE2API_PORT).
# Hard-coding 7864 here made stop/start hit the wrong port as soon as someone moved
# the service - start looked "fine" while it actually started on another port, and
# stop killed whatever unrelated process happened to sit on 7864.
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

# Clearing the port right before a start is the same job tools\free-port.ps1 does
# for start.cmd / run-bg.cmd: probe /healthz, never touch a healthy instance, know
# about Windows reserved port ranges, log to logs\port-clean.log.
# It MUST run as a child process: the script ends with `exit`, and `exit` reached
# through `& script.ps1` would take this script down with it.
function Invoke-FreePort {
    $freePort = Join-Path $PSScriptRoot 'free-port.ps1'
    if (-not (Test-Path -LiteralPath $freePort)) { return $true }
    $psExe = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
    & $psExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $freePort -Port $Port
    return ($LASTEXITCODE -eq 0)
}

$Port = Get-ListenPort
$Url = "http://127.0.0.1:$Port/healthz"

function Get-TaskInfo {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# Pick a Node.js >= 20 that actually exists on this machine.
# Note: this box may only have Node 14 in PATH, so we also look inside the
# OfficeAce install folder (which ships a modern node).
function Resolve-Node {
    $candidates = New-Object System.Collections.ArrayList

    # 1) OfficeAce ships a modern node under <install>\OfficeAce\tools\node\node.exe.
    #    Prefer it: the path is stable and guaranteed to exist when OfficeAce does.
    #    (-Directory is a provider dynamic parameter that throws on missing drives,
    #     so test the drive first and filter with PSIsContainer.)
    foreach ($d in @('C:\', 'D:\', 'E:\', 'F:\')) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        Get-ChildItem -LiteralPath $d -ErrorAction SilentlyContinue |
            Where-Object { $_.PSIsContainer } |
            ForEach-Object { [void]$candidates.Add((Join-Path $_.FullName 'OfficeAce\tools\node\node.exe')) }
    }
    # 2) value resolved by a previous run
    $nodeFile = Join-Path $Root 'data\node.txt'
    if (Test-Path $nodeFile) {
        try { [void]$candidates.Add(([System.IO.File]::ReadAllText($nodeFile, [System.Text.Encoding]::GetEncoding(936))).Trim()) } catch { }
    }
    # 3) whatever is on PATH (may be an old Node - the version check below filters it)
    foreach ($c in (Get-Command node.exe -All -ErrorAction SilentlyContinue)) {
        $src = $c.Source
        if (-not $src) { $src = $c.Path }
        if ($src -and $src -notlike '*\dsh-desktop\*') { [void]$candidates.Add($src) }
    }
    [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
    [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))

    foreach ($c in $candidates) {
        if (-not $c) { continue }
        if (-not (Test-Path -LiteralPath $c)) { continue }
        try { $raw = (& $c -v 2>$null) } catch { continue }
        if (-not $raw) { continue }
        $ver = ($raw | Select-Object -First 1).ToString().Trim() -replace '^v', ''
        $major = 0
        if (-not [int]::TryParse(($ver -split '\.')[0], [ref]$major)) { continue }
        if ($major -ge 20) { return [pscustomobject]@{ Path = $c; Version = $ver } }
    }
    return $null
}

function Save-NodeHint {
    param($Node)
    $dir = Join-Path $Root 'data'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # run-bg.cmd reads this with "type" under the OEM code page, so write GBK
    [System.IO.File]::WriteAllText((Join-Path $dir 'node.txt'), $Node.Path, [System.Text.Encoding]::GetEncoding(936))
}

function Install-Task {
    param([bool]$AtLogon, $Node)
    # The payload is the watchdog, not node itself: Task Scheduler's own
    # RestartOnFailure only fires on a non-zero exit, so a killed process would
    # never come back. The watchdog loops forever and restarts the server on
    # any exit. Task Scheduler passes paths as Unicode, so a non-ASCII install
    # path (e.g. D:\<chinese>\OfficeAce) is safe. Logging is handled by the
    # app (logs\server.log) and the watchdog (logs\watchdog.log).
    # NOTE: keep this file ASCII-only. PowerShell 5.1 reads a BOM-less file
    # using the ANSI code page, so raw UTF-8 Chinese here turns into mojibake
    # and can even break string literals. If you need Chinese output, write
    # the file as UTF-8 *with* BOM (see tools\screenshot.ps1).
    $psExe = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
    $watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'
    $action = New-ScheduledTaskAction -Execute $psExe `
        -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $watchdog + '"') `
        -WorkingDirectory $Root
    # -DontStopOnIdleEnd is NOT optional. New-ScheduledTaskSettingsSet defaults
    # StopOnIdleEnd to true, and Task Scheduler then kills the whole task --
    # watchdog plus the node child -- every time the machine leaves idle state.
    # Symptom: the service dies within minutes of you touching the keyboard and
    # comes back ~1 min later via RestartOnFailure. watchdog.log fills up with
    # "watchdog up" / "starting server" pairs and almost no "server exited"
    # line, because the watchdog itself was killed mid WaitForExit(). That also
    # throws away every in-memory counter (stats baseline, credit cache), so the
    # panel appears to reset itself for no reason.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
        -StartWhenAvailable -DontStopOnIdleEnd
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
    $desc = 'officeace2api - OpenAI compatible API proxy for the local OfficeAce client'
    if ($AtLogon) {
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
    }
    else {
        Register-ScheduledTask -TaskName $TaskName -Action $action `
            -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
    }
}

function Uninstall-Task {
    if (Get-TaskInfo) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
}

function Get-Health {
    try { return Invoke-RestMethod -Uri $Url -TimeoutSec 3 } catch { return $null }
}

function Wait-Health {
    param([int]$Seconds = 30)
    for ($i = 0; $i -lt $Seconds; $i++) {
        $h = Get-Health
        if ($h) { return $h }
        Start-Sleep -Seconds 1
    }
    return $null
}

function Stop-Service {
    if (Get-TaskInfo) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    # Kill the watchdog by command line: Stop-ScheduledTask does not always take
    # the child node process with it (the watchdog spawns it with -NoNewWindow).
    try {
        # Match the watchdog PAYLOAD shape (the script path is the tail of the
        # command line), not any shell that merely mentions the file: the loose
        # '*watchdog.ps1*' version also kills a terminal that is running something
        # which spawns the watchdog. Same rule as Stop-StrayWatchdogs in free-port.ps1.
        Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match '[\\/]watchdog\.ps1"?\s*$' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }
    $pidFile = Join-Path $Root 'data\server.pid'
    if (Test-Path $pidFile) {
        $raw = (Get-Content $pidFile -Raw).Trim()
        if ($raw -match '^\d+$') { Stop-Process -Id ([int]$raw) -Force -ErrorAction SilentlyContinue }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 1200
}

function Start-Service {
    if (-not (Get-TaskInfo)) {
        $node = Resolve-Node
        if (-not $node) {
            Write-Host '[X] Node.js 20+ not found. Install it, or write the full path of node.exe into data\node.txt' -ForegroundColor Red
            exit 1
        }
        Save-NodeHint -Node $node
        Install-Task -AtLogon:$false -Node $node
    }
    Stop-Service
    # Only start once the port is actually usable. Otherwise node dies on
    # EADDRINUSE and the caller waits 30 s for a health check that can never pass.
    if (-not (Invoke-FreePort)) {
        Write-Host '[X] the port is not usable - not starting; see the message above' -ForegroundColor Red
        return $null
    }
    Start-ScheduledTask -TaskName $TaskName
    return (Wait-Health -Seconds 30)
}

switch ($Action.ToLower()) {
    'install' {
        $node = Resolve-Node
        if (-not $node) {
            Write-Host '[X] Node.js 20+ not found. Install it, or write the full path of node.exe into data\node.txt' -ForegroundColor Red
            exit 1
        }
        Save-NodeHint -Node $node
        Write-Host "[i] node : $($node.Path)  (v$($node.Version))"
        Install-Task -AtLogon:$Autostart -Node $node
        Write-Host "[OK] scheduled task '$TaskName' installed" -ForegroundColor Green
        if ($Autostart) { Write-Host '[OK] will start automatically at every logon' -ForegroundColor Green }
        else { Write-Host '[i]  manual start only, use: service.ps1 install -Autostart' -ForegroundColor DarkGray }
        $h = Start-Service
        if ($h) { Write-Host "[OK] running: $Url" -ForegroundColor Green }
        else { Write-Host '[X] started but health check failed - see logs\server.err.log' -ForegroundColor Red }
    }
    'uninstall' {
        Stop-Service
        Uninstall-Task
        Write-Host "[OK] scheduled task '$TaskName' removed" -ForegroundColor Green
    }
    'start' {
        $h = Start-Service
        if ($h) {
            Write-Host '[OK] service is up' -ForegroundColor Green
            Write-Host ''
            Write-Host "  OpenAI base : http://127.0.0.1:$Port/v1"
            Write-Host "  Admin panel : http://127.0.0.1:$Port/admin"
            Write-Host '  API key     : sk-officeace'
            Write-Host ''
        }
        else {
            Write-Host '[X] health check timeout - see logs\server.log / logs\server.err.log' -ForegroundColor Red
            exit 1
        }
    }
    'stop' {
        Stop-Service
        Write-Host '[OK] stopped' -ForegroundColor Green
    }
    'restart' {
        $h = Start-Service
        if ($h) { Write-Host '[OK] restarted' -ForegroundColor Green } else { Write-Host '[X] restart failed' -ForegroundColor Red; exit 1 }
    }
    'log' {
        $wdLog = Join-Path $Root 'logs\watchdog.log'
        if (Test-Path -LiteralPath $wdLog) {
            Write-Host '--- logs\watchdog.log (last 25) ---' -ForegroundColor DarkGray
            Get-Content -LiteralPath $wdLog -Tail 25
        }
        else { Write-Host '(no watchdog log yet)' }
        $srvLog = Join-Path $Root 'logs\server.log'
        if (Test-Path -LiteralPath $srvLog) {
            Write-Host ''
            Write-Host '--- logs\server.log (last 15) ---' -ForegroundColor DarkGray
            Get-Content -LiteralPath $srvLog -Tail 15
        }
    }
    'status' {
        $task = Get-TaskInfo
        $h = Get-Health
        Write-Host ("task     : " + $(if ($task) { 'installed' } else { 'not installed' }))
        if ($task) {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
            $trig = ($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','
            Write-Host ("trigger  : " + $(if ($trig) { $trig } else { 'manual' }))
            $isWatchdog = @($task.Actions | Where-Object { "$($_.Execute)" -like '*powershell*' }).Count -gt 0
            Write-Host ("payload  : " + $(if ($isWatchdog) { 'watchdog (auto-restart on)' } else { 'node.exe directly (no auto-restart!)' }))
            if ($info) { Write-Host ("last run : " + $info.LastRunTime + "  result=" + $info.LastTaskResult) }
        }
        if ($h) {
            Write-Host ("service  : running  " + ($h | ConvertTo-Json -Compress))
            Write-Host ''
            Write-Host "  OpenAI base : http://127.0.0.1:$Port/v1"
            Write-Host "  Admin panel : http://127.0.0.1:$Port/admin"
            Write-Host '  API key     : sk-officeace'
        }
        else {
            Write-Host 'service  : DOWN' -ForegroundColor Red
            $wdLog = Join-Path $Root 'logs\watchdog.log'
            if (Test-Path -LiteralPath $wdLog) {
                Write-Host '  watchdog log tail:' -ForegroundColor DarkGray
                Get-Content -LiteralPath $wdLog -Tail 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            }
        }
    }
    default {
        Write-Host 'usage: service.ps1 install [-Autostart] | uninstall | start | stop | restart | status | log'
    }
}
