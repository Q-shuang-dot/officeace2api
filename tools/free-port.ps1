# 启动前清理端口占用 —— tools/free-port.ps1
#
#   powershell -ExecutionPolicy Bypass -File tools\free-port.ps1
#   powershell -ExecutionPolicy Bypass -File tools\free-port.ps1 -Port 7864
#   powershell -ExecutionPolicy Bypass -File tools\free-port.ps1 -Force        # 连"健康实例"也让路
#   powershell -ExecutionPolicy Bypass -File tools\free-port.ps1 -RepairNat    # 端口被 WinNAT 保留时自动重启 winnat
#   powershell -ExecutionPolicy Bypass -File tools\free-port.ps1 -TimeoutSec 20
#
# 退出码（调用方只需看这一个数）：
#   0 = 端口可用：本来就是空的 / 已经清掉了 / 上面跑着的就是本服务的健康实例
#   1 = 端口不可用：清不掉，或落在 Windows 保留端口范围里 —— 调用方应当中止启动
#   2 = 同上，但这件事需要管理员权限才能修（free-port.cmd 会拿这个码去请求提权）
#
# 为什么要有这个脚本：端口被占住时 node 会立刻 EADDRINUSE 退出，而 start.cmd 还要
# 在那里空等 30×2 秒做健康检查，最后只丢一句 "health check timeout"。小白看不懂，
# 只看到"双击没反应"。所以启动前先把端口这件事说清楚、顺手清掉。
#
# 三条不能违反的规矩（每条都是真踩过的坑，见 docs\技术笔记.md）：
#   1) 只清"占着端口却不服务"的进程。端口上如果已经有一个**本服务的健康实例**
#      （/healthz 通），绝不碰它 —— 以前无条件杀，两个守护轮流杀对方的服务，
#      表现成"服务每隔几分钟掉一次又自己回来"。
#   2) 探活必须用 /healthz，不能用 /admin/api/state：后者又重又要口令，忙的时候
#      10 秒都答不完，会把健康实例误判成死的。
#   3) 杀进程连子孙一起杀（node 的子进程可能也握着同一个端口），并且如果被杀的
#      是**我们自己的**实例，先把守护（watchdog.ps1）也停掉，免得它立刻又拉一个
#      起来和调用方互抢。
#
# 编码注意：本文件必须存成 UTF-8 **带 BOM**。Windows PowerShell 5.1 读无 BOM 的
# 文件用的是 ANSI 代码页，中文会变乱码（tools\service.ps1 顶部的注释里记着这条）。
# .cmd 文件则相反，必须纯 ASCII —— 见 CONTRIBUTING.md。

param(
    [int]$Port = 0,
    [switch]$Force,
    [int]$TimeoutSec = 10,
    [switch]$RepairNat,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir 'port-clean.log'
$script:BindError = ''
$script:LogCheckedAt = [datetime]::MinValue

function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try {
        # run-bg.cmd 会滚 server.err.log，因为那是个"只会长大"的 cmd 重定向目标。
        # 这个文件也一样，所以自己管：超过 1 MB 就换一代，只留 .1。
        if (((Get-Date) - $script:LogCheckedAt).TotalSeconds -ge 60) {
            $script:LogCheckedAt = Get-Date
            if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -ge 1048576) {
                if (Test-Path -LiteralPath "$LogFile.1") { Remove-Item -LiteralPath "$LogFile.1" -Force -ErrorAction SilentlyContinue }
                Move-Item -LiteralPath $LogFile -Destination "$LogFile.1" -Force -ErrorAction SilentlyContinue
            }
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Say {
    param([string]$Message, [string]$Color = 'Gray')
    if ($Quiet) { return }
    try { Write-Host $Message -ForegroundColor $Color } catch { Write-Host $Message }
}

# --------------------------------------------------------------------------
# 端口 / 监听地址：优先级和 tools\admin-url.mjs 一致（命令行 > 环境变量 > config.json）
# --------------------------------------------------------------------------
function Get-ConfigListen {
    $cfg = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $cfg)) { return $null }
    try {
        $json = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
        return $json.listen
    } catch {
        Write-Log "config.json 读不了：$($_.Exception.Message)"
        return $null
    }
}

function Get-TryInt {
    param($Value)
    $n = 0
    if ($null -eq $Value) { return 0 }
    if ([int]::TryParse([string]$Value, [ref]$n) -and $n -gt 0) { return $n }
    return 0
}

$listen = Get-ConfigListen
$listenHost = '127.0.0.1'
if ($listen -and $listen.host) { $listenHost = [string]$listen.host }

if ($Port -le 0) {
    $fromEnv = Get-TryInt $env:OFFICEACE2API_PORT
    if ($fromEnv -gt 0) { $Port = $fromEnv }
    elseif ($listen -and $listen.port) { $Port = Get-TryInt $listen.port }
    if ($Port -le 0) { $Port = 7864 }
}

function Resolve-BindAddress {
    param([string]$HostName)
    $h = ''
    if ($HostName) { $h = $HostName.Trim() }
    switch -Regex ($h) {
        '^(127\.0\.0\.1|localhost|)$' { return [System.Net.IPAddress]::Loopback }
        '^0\.0\.0\.0$' { return [System.Net.IPAddress]::Any }
        '^::1$' { return [System.Net.IPAddress]::IPv6Loopback }
        '^(::|\[::\])$' { return [System.Net.IPAddress]::IPv6Any }
    }
    $ip = $null
    if ([System.Net.IPAddress]::TryParse($h, [ref]$ip)) { return $ip }
    return [System.Net.IPAddress]::Loopback
}

$bindAddress = Resolve-BindAddress -HostName $listenHost

Write-Log "free-port: port=$Port host=$listenHost pid=$PID force=$($Force.IsPresent)"

# --------------------------------------------------------------------------
# 谁在监听这个端口
# --------------------------------------------------------------------------
function Get-PortHolders {
    param([int]$LocalPort)
    $holders = New-Object System.Collections.ArrayList
    $seen = @{}

    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        try {
            foreach ($c in @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)) {
                $ownerPid = 0
                if ($null -ne $c.OwningProcess) { $ownerPid = [int]$c.OwningProcess }
                if ($ownerPid -le 0 -or $seen.ContainsKey($ownerPid)) { continue }
                $seen[$ownerPid] = $true
                [void]$holders.Add([pscustomobject]@{ PidId = $ownerPid })
            }
        } catch { }
        return @($holders)
    }

    # 兜底：极少数机器上没有 NetTCPIP 模块，这时用 netstat 顶着。
    # 结尾必须跟空白，否则 ":7864" 会把 ":78640" 也算进来。
    $pattern = '(^|\s)(\[[0-9a-fA-F:]*\]|\d{1,3}(\.\d{1,3}){3}):' + $LocalPort + '\s'
    foreach ($line in @(netstat -ano 2>$null)) {
        $text = [string]$line
        if ($text -notmatch $pattern) { continue }
        if ($text -notmatch 'LISTENING') { continue }
        $fields = @($text.Trim() -split '\s+')
        if ($fields.Length -lt 5) { continue }
        $ownerPid = Get-TryInt $fields[$fields.Length - 1]
        if ($ownerPid -le 0 -or $seen.ContainsKey($ownerPid)) { continue }
        $seen[$ownerPid] = $true
        [void]$holders.Add([pscustomobject]@{ PidId = $ownerPid })
    }
    return @($holders)
}

function Get-ProcInfo {
    param([int]$ProcId)
    $name = ''
    $path = ''
    $cmdline = ''
    try {
        $ci = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcId" -ErrorAction SilentlyContinue
        if ($ci) {
            $name = [string]$ci.Name
            $path = [string]$ci.ExecutablePath
            $cmdline = [string]$ci.CommandLine
        }
    } catch { }
    if (-not $name) {
        try {
            $p = Get-Process -Id $ProcId -ErrorAction Stop
            $name = $p.ProcessName + '.exe'
            $path = [string]$p.Path
        } catch { }
    }
    return [pscustomobject]@{ Pid = $ProcId; Name = $name; Path = $path; CommandLine = $cmdline }
}

function Format-ProcInfo {
    param($Info)
    $name = $Info.Name
    if (-not $name) { $name = '未知进程' }
    $text = "$name（pid $($Info.Pid)）"
    if ($Info.Path) { $text += "  $($Info.Path)" }
    return $text
}

# pid 4（System）握着端口这件事有专门的解释：那不是"某个程序占着"，
# 而是 Windows 保留端口范围（Hyper-V / Docker 的 WinNAT 预留）在内核里的表现。
# 实测：本机保留范围里的 8030、8999 都表现为 pid 4 在 LISTEN —— 杀不掉，也不该去杀。
function Test-SystemProcess {
    param($Info)
    $ownerPid = 0
    if ($null -ne $Info.Pid) { $ownerPid = [int]$Info.Pid }
    if ($ownerPid -le 4) { return $true }
    $name = [string]$Info.Name
    if ($name -match '^(System|Idle|Registry|MemCompression|Secure System|System Idle Process)(\.exe)?$') { return $true }
    # 连名字都问不出来的，多半是受保护的系统进程，别乱杀
    if (-not $name) { return $true }
    return $false
}

# --------------------------------------------------------------------------
# 探活：/healthz 是固定几百字节、还绕开面板口令，是唯一正确的心跳探针
#    ours    = 本服务的健康实例（默认不碰）
#    foreign = 别的程序占着这个端口在响应（要清）
#    dead    = 没人应答（占着端口的那个已经死了 / 端口本来空着）
#
# 超时给得很短、重试只给一次：占着端口却不应答的东西（比如裸 TCP 监听）会一路
# 卡到超时，慢探针的表现就是"双击 start.cmd 之后先发呆二十秒"。healthz 只有
# 几百字节，再忙也秒回 —— 真正重的 /admin/api/state 才需要长超时，那是另一个接口。
# --------------------------------------------------------------------------
function Test-Serving {
    param([int]$LocalPort, [int]$Tries = 2, [int]$TimeoutSeconds = 2)
    for ($i = 1; $i -le $Tries; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/healthz" -TimeoutSec $TimeoutSeconds -UseBasicParsing
            if ($r.StatusCode -eq 200) {
                $body = [string]$r.Content
                if ($body -match '"status"\s*:\s*"ok"') { return 'ours' }
                return 'foreign'
            }
        } catch { }
        if ($i -lt $Tries) { Start-Sleep -Milliseconds 1000 }
    }
    return 'dead'
}

# --------------------------------------------------------------------------
# 杀进程（连子孙），以及守护
# --------------------------------------------------------------------------
function Stop-ProcessTree {
    param([int]$ProcId, [int]$Depth = 0)
    if ($ProcId -le 0 -or $Depth -gt 5) { return }
    try {
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcId" -ErrorAction SilentlyContinue)) {
            $childPid = 0
            if ($null -ne $child.ProcessId) { $childPid = [int]$child.ProcessId }
            Stop-ProcessTree -ProcId $childPid -Depth ($Depth + 1)
        }
    } catch { }
    Stop-Process -Id $ProcId -Force -ErrorAction SilentlyContinue
    if (Get-Process -Id $ProcId -ErrorAction SilentlyContinue) {
        try { taskkill /F /T /PID $ProcId 2>$null | Out-Null } catch { }
    }
}

function Stop-StrayWatchdogs {
    # Never touch the watchdog that CALLED us: tools\watchdog.ps1 runs this script as
    # a child process before restarting a server that died while still holding the
    # port. Killing our own parent there would leave the port clean but nobody to
    # restart the server until Task Scheduler notices - a whole extra minute down.
    $skip = @{}
    $skip[[int]$PID] = $true
    try {
        $me = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue
        if ($me -and $me.ParentProcessId) { $skip[[int]$me.ParentProcessId] = $true }
    } catch { }
    try {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction SilentlyContinue)) {
            $watchPid = 0
            if ($null -ne $p.ProcessId) { $watchPid = [int]$p.ProcessId }
            if ($watchPid -le 0 -or $skip.ContainsKey($watchPid)) { continue }
            $cmdline = [string]$p.CommandLine
            # The path has to be the TAIL of the command line: that is what a real
            # watchdog payload looks like ("... -File "D:\...\watchdog.ps1"").
            # A plain -like '*watchdog.ps1*' also matches any shell that merely
            # MENTIONS the file (an editor task, a shell running a script that
            # spawns it, this very test) - and killing the user's terminal to free a
            # port is much worse than leaving one stray watchdog alive.
            if ($cmdline -match '[\\/]watchdog\.ps1"?\s*$') {
                Write-Log "stopping stray watchdog pid $watchPid so it cannot resurrect the dead instance"
                Stop-Process -Id $watchPid -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { }
}

# --------------------------------------------------------------------------
# Windows"保留端口范围"（Hyper-V / Docker 的 WinNAT 预留）
#   这种端口没进程监听，却谁也绑不上 —— 症状和"被占用"一模一样，
#   但杀进程永远没用，所以必须单独认出来。
# --------------------------------------------------------------------------
function Get-ExcludedRanges {
    $ranges = New-Object System.Collections.ArrayList
    foreach ($family in @('ipv4', 'ipv6')) {
        try {
            foreach ($line in @(netsh interface $family show excludedportrange protocol=tcp 2>$null)) {
                $m = [regex]::Match([string]$line, '^\s*(\d{1,5})\s+(\d{1,5})(\s+\*)?\s*$')
                if (-not $m.Success) { continue }
                [void]$ranges.Add([pscustomobject]@{
                        Start = [int]$m.Groups[1].Value
                        End = [int]$m.Groups[2].Value
                        Family = $family
                        Administered = $m.Groups[3].Success
                    })
            }
        } catch { }
    }
    return @($ranges)
}

function Find-ExcludedRange {
    param([int]$LocalPort)
    foreach ($r in @(Get-ExcludedRanges)) {
        if ($LocalPort -ge $r.Start -and $LocalPort -le $r.End) { return $r }
    }
    return $null
}

# 真的去绑一下端口 —— netstat 看不见保留范围，只有真绑才能证明"起得来"。
# Permissive 那一次开 SO_REUSEADDR：它绕开 TIME_WAIT / 共享绑定这类假冲突，
# 只对"保留范围 / 权限"这种硬失败还报错。
function Test-Bindable {
    param([int]$LocalPort, [System.Net.IPAddress]$Address, [bool]$Permissive)
    $listener = $null
    try {
        $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @($Address, $LocalPort)
        if ($Permissive) {
            $listener.Server.SetSocketOption(
                [System.Net.Sockets.SocketOptionLevel]::Socket,
                [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true) | Out-Null
        }
        $listener.Start()
        return $true
    } catch {
        $script:BindError = $_.Exception.Message
        return $false
    } finally {
        if ($listener) { try { $listener.Stop() } catch { } }
    }
}

function Test-Admin {
    try {
        $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object -TypeName System.Security.Principal.WindowsPrincipal -ArgumentList @($id)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Restart-WinNat {
    Write-Log 'restarting winnat to release the reserved port range'
    try { net stop winnat 2>&1 | Out-Null } catch { }
    try { net start winnat 2>&1 | Out-Null } catch { }
    Start-Sleep -Seconds 2
}

# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
$holders = @(Get-PortHolders -LocalPort $Port)
$serving = 'dead'
if ($holders.Count -gt 0 -or $Force) { $serving = Test-Serving -LocalPort $Port }

if ($serving -eq 'ours' -and -not $Force) {
    Say "[OK] 端口 $Port 上已经有本服务在跑（/healthz 正常），不动它。" 'Green'
    Say '     想看控制台直接双击 open-panel.cmd；想重启就先双击 stop.cmd。' 'DarkGray'
    Write-Log "port $Port served by a healthy instance - left alone"
    exit 0
}

if ($serving -eq 'foreign' -and -not $Force) {
    Say "[!] 端口 $Port 有个别的程序在响应 /healthz，它占着这个端口，准备清掉。" 'Yellow'
    Write-Log "port $Port answers /healthz but does not look like officeace2api - clearing it"
}

$killed = New-Object System.Collections.ArrayList
$infos = New-Object System.Collections.ArrayList
$ours = $false
if ($holders.Count -gt 0) {
    foreach ($h in $holders) {
        $info = Get-ProcInfo -ProcId ([int]$h.PidId)
        [void]$infos.Add($info)
        Write-Log ("holder: pid {0} name={1} path={2} cmd={3}" -f $info.Pid, $info.Name, $info.Path, $info.CommandLine)
        if ($info.CommandLine -and ($info.CommandLine -like "*$Root*" -or $info.CommandLine -like '*src\index.mjs*')) { $ours = $true }
    }

    # 被清掉的是我们自己的实例 → 先把守护也停掉。否则守护会在我们刚清完端口后
    # 立刻把那个"死实例"再拉一遍，和我们抢同一个端口（双实例互杀的老剧本）。
    if ($ours) { Stop-StrayWatchdogs }

    foreach ($info in $infos) {
        if (Test-SystemProcess -Info $info) {
            # 系统进程不碰。留着让后面"保留端口范围"那段去解释。
            Write-Log "pid $($info.Pid) ($($info.Name)) is a system process - not touching it"
            continue
        }
        Write-Log "stopping pid $($info.Pid) (it holds port $Port and does not serve)"
        Stop-ProcessTree -ProcId ([int]$info.Pid)
        [void]$killed.Add([int]$info.Pid)
    }

    if ($killed.Count -gt 0) {
        $waited = 0.0
        while ($waited -lt $TimeoutSec) {
            if ((@(Get-PortHolders -LocalPort $Port)).Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
            $waited += 0.5
        }
    }
}

# 清完再点一次名：还剩下的分成"普通进程"和"系统进程"两类，
# 前者是真没清掉（要权限），后者是保留端口范围，两件事的处理完全不一样。
$leftReal = New-Object System.Collections.ArrayList
$leftSystem = New-Object System.Collections.ArrayList
foreach ($h in @(Get-PortHolders -LocalPort $Port)) {
    $info = Get-ProcInfo -ProcId ([int]$h.PidId)
    if (Test-SystemProcess -Info $info) { [void]$leftSystem.Add($info) }
    else { [void]$leftReal.Add($info) }
}

if ($leftReal.Count -gt 0) {
    Say "[!] 端口 $Port 还被下面的进程占着，没清掉：" 'Yellow'
    foreach ($info in $leftReal) { Say ("      · " + (Format-ProcInfo -Info $info)) 'Yellow' }
    Say '    多半是需要管理员权限。三选一：' 'Yellow'
    Say '      1) 右键 start.cmd（或 free-port.cmd）→ 以管理员身份运行' 'Gray'
    Say '      2) 任务管理器 → 详细信息 → 找到上面那个 pid → 结束任务，再双击 start.cmd' 'Gray'
    Say ("      3) 编辑 config.json，把 listen.port 改成 $($Port + 1) 之类没被占的端口，再双击 start.cmd") 'Gray'
    Write-Log "port $Port still held by $($leftReal.Count) process(es) after kill attempt"
    if (Test-Admin) { exit 1 } else { exit 2 }
}

if ($killed.Count -gt 0) {
    $names = @()
    foreach ($i in $infos) { $names += (Format-ProcInfo -Info $i) }
    Say ("[OK] 端口 $Port 已清理：" + ($names -join '；')) 'Green'
    if ($ours) {
        Say '     刚才是上一个没退干净的实例卡着端口（它已经不再应答了），现在可以启动了。' 'DarkGray'
    }
    else {
        Say '     那个程序不是本服务，但端口是它的，现在可以启动了。' 'DarkGray'
    }
    Write-Log "port $Port freed (killed: $($killed -join ', '))"
    exit 0
}

# 端口上已经没人监听了（或只剩系统进程），再真绑一次确认。保留端口范围内谁绑都失败，
# 这个分支专门用来把"没进程却起不来"的怪事解释清楚。
$strictOk = Test-Bindable -LocalPort $Port -Address $bindAddress -Permissive $false
if ($strictOk) {
    Say "[OK] 端口 $Port 空闲，可以启动。" 'Green'
    Write-Log "port $Port was free"
    exit 0
}
$looseOk = Test-Bindable -LocalPort $Port -Address $bindAddress -Permissive $true
if ($looseOk -and $leftSystem.Count -eq 0) {
    # 严格绑失败、宽松绑成功：多半是 TIME_WAIT 之类的残留，node 自己有退路，放行。
    # 但如果端口上还挂着内核（pid 4）的监听项，那多半是保留范围，宽松绑成功是
    # SO_REUSEADDR 抢进来的假象 —— 交给下面那段去解释，别放行。
    Say "[i] 端口 $Port 没有进程监听，只是还有一点残留状态，通常不影响启动。" 'DarkGray'
    Write-Log "port ${Port}: strict bind failed ($script:BindError) but permissive bind succeeded"
    exit 0
}

$range = Find-ExcludedRange -LocalPort $Port
if ($range -or $leftSystem.Count -gt 0) {
    if ($range) {
        $span = if ($range.Start -eq $range.End) { "$($range.Start)" } else { "$($range.Start)-$($range.End)" }
        Say "[!] 端口 $Port 落在 Windows 的保留端口范围 $span（$($range.Family)）里。" 'Yellow'
    }
    else {
        foreach ($info in $leftSystem) {
            Say ("[!] 端口 $Port 上没有普通程序占着，是内核握着它：" + (Format-ProcInfo -Info $info)) 'Yellow'
        }
    }
    Say '    ── Hyper-V / Docker（WinNAT）预留的端口段，这一段里谁都监听不了，杀进程没用。' 'Yellow'
    if ($range) {
        Say '    两种办法：' 'Gray'
        Say '      1) 以管理员身份把这段范围放出来（会自动重试）：' 'Gray'
        Say '           net stop winnat  &  net start winnat' 'DarkGray'
        Say '         也可以双击 free-port.cmd，它会自己请求管理员权限并带上 -RepairNat。' 'Gray'
        Say ("      2) 换端口：编辑 config.json 的 listen.port 改成 $($Port + 1)，再双击 start.cmd") 'Gray'
        if ($range.Administered) {
            Say '         （这段是「人为登记」的保留，管理员还可以直接删掉它：' 'DarkGray'
            Say ("           netsh int $($range.Family) delete excludedportrange protocol=tcp startport=$($range.Start) numberofports=$($range.End - $range.Start + 1)）") 'DarkGray'
        }
        Write-Log "port $Port is inside an excluded port range $span ($($range.Family))"
    }
    else {
        Say '    两种办法：' 'Gray'
        Say '      1) 以管理员身份重启 WinNAT 把预留放出来（会自动重试）：' 'Gray'
        Say '           net stop winnat  &  net start winnat' 'DarkGray'
        Say '         也可以双击 free-port.cmd，它会自己请求管理员权限并带上 -RepairNat。' 'Gray'
        Say ("      2) 换端口：编辑 config.json 的 listen.port 改成 $($Port + 1)，再双击 start.cmd") 'Gray'
        Write-Log "port $Port is held by a kernel/system listener"
    }

    if ($RepairNat) {
        if (-not (Test-Admin)) {
            Say '[!] 重启 winnat 需要管理员权限：请右键 free-port.cmd → 以管理员身份运行。' 'Yellow'
            Write-Log 'winnat repair requested but this process is not elevated'
            exit 2
        }
        Say '[*] 正在重启 WinNAT（会短暂断开 Docker/Hyper-V 的 NAT 网络）…' 'Gray'
        Restart-WinNat
        if (Test-Bindable -LocalPort $Port -Address $bindAddress -Permissive $true) {
            Say "[OK] 重启 WinNAT 之后端口 $Port 可以用了，现在可以启动。" 'Green'
            Write-Log "port $Port became bindable after winnat restart"
            exit 0
        }
        Say "[!] 重启 WinNAT 之后 $Port 还在保留范围里，请改用第 2 种办法（换端口）。" 'Yellow'
        Write-Log 'winnat restart did not release the port'
        exit 1
    }
    if (Test-Admin) { exit 1 } else { exit 2 }
}

Say "[!] 端口 $Port 上没人监听，但系统不让绑定：$script:BindError" 'Yellow'
Say '    · 常见原因是权限/防火墙策略，或者刚才那个进程还没退干净 —— 等几秒重跑一次；' 'Gray'
Say ("    · 还是不行就把 config.json 的 listen.port 换成 $($Port + 1)，再双击 start.cmd。") 'Gray'
Write-Log "port $Port not bindable: $script:BindError"
if (Test-Admin) { exit 1 } else { exit 2 }