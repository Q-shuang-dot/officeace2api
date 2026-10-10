@echo off
setlocal
cd /d "%~dp0"

if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"

call "%~dp0tools\find-node.cmd"
if not defined NODE goto nonode

for /f "delims=" %%v in ('"%NODE%" -v 2^>nul') do set "NODEV=%%v"
echo [*] node : %NODE%  %NODEV%

rem Resolve port + panel URL from config.json on the fly.
rem NOTE: keep this file ASCII-only. cmd.exe reads .cmd with the OEM codepage
rem (936 here), so UTF-8 Chinese text gets mangled into stray commands and
rem breaks the script. That is why every comment in these .cmd files is English.
"%NODE%" "%~dp0tools\admin-url.mjs" --cmd >nul 2>nul
if exist "%~dp0data\admin-url.vars.cmd" call "%~dp0data\admin-url.vars.cmd"
if not defined O2A_PORT set "O2A_PORT=7864"

set "USE_TASK=0"
schtasks /query /tn "officeace2api" >nul 2>nul && set "USE_TASK=1"

if "%USE_TASK%"=="1" (
  echo [*] starting via scheduled task "officeace2api" ...
  rem A task that EXISTS but is DISABLED makes "schtasks /run" fail. The old code
  rem ignored that and fell straight into the 30-iteration health wait - a silent
  rem 60-second hang ending in a bare "pause". Check the exit code and fall back.
  schtasks /run /tn "officeace2api" >nul 2>nul
  if errorlevel 1 (
    echo [!] task exists but would not start ^(disabled, or needs elevation^)
    echo     falling back to run-bg.cmd ...
    start "officeace2api" /min cmd /c "run-bg.cmd"
  )
) else (
  echo [*] starting officeace2api ...
  start "officeace2api" /min cmd /c "run-bg.cmd"
)

set /a n=0
:wait
set /a n+=1
ping -n 2 127.0.0.1 -w 1000 >nul
curl -s -o nul --max-time 3 http://127.0.0.1:%O2A_PORT%/healthz && goto ready
if %n% LSS 30 goto wait
echo [!] health check timeout - see logs\server.log / logs\server.err.log
pause
exit /b 1

:ready
rem Re-resolve: the panel token is generated during that first startup,
rem and a hard-coded http://127.0.0.1:7864/admin would just 401.
"%NODE%" "%~dp0tools\admin-url.mjs" --cmd >nul 2>nul
if exist "%~dp0data\admin-url.vars.cmd" call "%~dp0data\admin-url.vars.cmd"
if not defined O2A_PANEL set "O2A_PANEL=http://127.0.0.1:%O2A_PORT%/admin"

echo.
echo   [OK] service is up
echo.
echo   OpenAI base : http://127.0.0.1:%O2A_PORT%/v1
echo   Admin panel : %O2A_PANEL%
echo   API key     : see "apiKeys" in config.json  ^(default: sk-officeace^)
echo   Log file    : logs\server.log
echo.
echo   No account yet? Open the Admin panel above, go to the pool tab and
echo   click "switch account login" - just sign in with your own account.
echo.
exit /b 0

:nonode
echo [X] Node.js 20+ not found.
echo     Install Node.js 20+ , or write the full path of node.exe into data\node.txt
pause
exit /b 1
