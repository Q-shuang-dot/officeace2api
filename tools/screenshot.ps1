# 给控制台截图（无头 Chrome）
#
#   powershell -ExecutionPolicy Bypass -File tools/screenshot.ps1 -Page accounts
#   powershell -ExecutionPolicy Bypass -File tools/screenshot.ps1 -All
#
# ⚠️ 只清理**自己启动的**那个无头实例，绝不动你正在用的 Chrome。
#    做法：每个截图用独立的 --user-data-dir，清理时按命令行里那个唯一路径筛选进程。
#    以前的写法是 Get-Process chrome | Stop-Process —— 那会把用户开着的所有窗口
#    一起杀掉，非常粗暴，绝对不要那么干。

param(
    [string]$Page = 'accounts',
    [string]$Out = '',
    [int]$Width = 1600,
    [int]$Height = 1900,
    [string]$Base = 'http://127.0.0.1:7864/admin',
    [switch]$All
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Docs = Join-Path $Root 'docs'
if (-not (Test-Path $Docs)) { New-Item -ItemType Directory -Path $Docs -Force | Out-Null }

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $chrome) {
    Write-Host '[X] 没找到 Chrome / Edge' -ForegroundColor Red
    exit 1
}

function Take-Shot {
    param([string]$Hash, [string]$File, [int]$H)

    # 每个截图一个全新的临时 profile：互不干扰，也好精确清理
    # 注意：别把参数数组叫 $args —— 那是 PowerShell 的自动变量，会解析报错
    $profileDir = Join-Path $env:TEMP ("o2a-shot-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
    $chromeArgs = @(
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions',
        "--user-data-dir=$profileDir",
        "--window-size=$Width,$H",
        '--virtual-time-budget=10000',
        "--screenshot=$File",
        "$Base#$Hash"
    )

    $proc = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -PassThru -WindowStyle Hidden
    $null = $proc.WaitForExit(90000)
    if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }

    # 兜底：只杀命令行里带这个唯一 profile 路径的进程（也就是我们自己起的那些）
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }

    Start-Sleep -Milliseconds 500
    Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $File) {
        Write-Host ("  [OK] {0}  ({1:N0} 字节)" -f (Split-Path $File -Leaf), (Get-Item $File).Length) -ForegroundColor Green
    } else {
        Write-Host ("  [X] {0} 没生成" -f (Split-Path $File -Leaf)) -ForegroundColor Red
    }
}

if ($All) {
    Write-Host "[i] chrome: $chrome"
    Take-Shot 'accounts' (Join-Path $Docs 'panel-accounts.png') 1900
    Take-Shot 'credits'  (Join-Path $Docs 'panel-credits.png')  2300
    Take-Shot 'models'   (Join-Path $Docs 'panel-models.png')   1700
    Take-Shot 'usage'    (Join-Path $Docs 'panel-usage.png')    1700
    Take-Shot 'access'   (Join-Path $Docs 'panel-access.png')   1500
    Take-Shot 'settings' (Join-Path $Docs 'panel-settings.png') 1500
} else {
    $file = if ($Out) { $Out } else { Join-Path $Docs ("panel-" + $Page + ".png") }
    Write-Host "[i] chrome: $chrome"
    Take-Shot $Page $file $Height
}
