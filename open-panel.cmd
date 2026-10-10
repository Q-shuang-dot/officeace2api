@echo off
setlocal
cd /d "%~dp0"

call "%~dp0tools\find-node.cmd"
if not defined NODE set "NODE=node"

rem Resolve port + panel URL from config.json on the fly.
rem The panel token is generated during the first startup, so the old
rem hard-coded http://127.0.0.1:7864/admin would only ever show a 401.
rem NOTE: keep this file ASCII-only - cmd.exe reads .cmd with the OEM codepage,
rem so UTF-8 text gets mangled into stray commands.
"%NODE%" "%~dp0tools\admin-url.mjs" --cmd >nul 2>nul
if exist "%~dp0data\admin-url.vars.cmd" call "%~dp0data\admin-url.vars.cmd"

if not defined O2A_PORT set "O2A_PORT=7864"
if not defined O2A_PANEL set "O2A_PANEL=http://127.0.0.1:%O2A_PORT%/admin"

rem Bring the service up first if it is not running.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:%O2A_PORT%/healthz' -UseBasicParsing -TimeoutSec 4; exit 0 } catch { exit 1 }" >nul 2>&1

if errorlevel 1 (
  echo   service is down, starting it ...
  call "%~dp0start.cmd"
  echo.
  rem Port and token may both have changed; resolve again.
  "%NODE%" "%~dp0tools\admin-url.mjs" --cmd >nul 2>nul
  if exist "%~dp0data\admin-url.vars.cmd" call "%~dp0data\admin-url.vars.cmd"
)

echo   opening %O2A_PANEL%
start "" "%O2A_PANEL%"
endlocal
