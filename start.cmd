@echo off
setlocal
cd /d "%~dp0"

if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"

call "%~dp0tools\find-node.cmd"
if not defined NODE goto nonode

for /f "delims=" %%v in ('"%NODE%" -v 2^>nul') do set "NODEV=%%v"
echo [*] node : %NODE%  %NODEV%

set "USE_TASK=0"
schtasks /query /tn "officeace2api" >nul 2>nul && set "USE_TASK=1"

if "%USE_TASK%"=="1" (
  echo [*] starting via scheduled task "officeace2api" ...
  schtasks /run /tn "officeace2api" >nul
) else (
  echo [*] starting officeace2api ...
  start "officeace2api" /min cmd /c "run-bg.cmd"
)

set /a n=0
:wait
set /a n+=1
ping -n 2 127.0.0.1 -w 1000 >nul
curl -s -o nul --max-time 3 http://127.0.0.1:7864/healthz && goto ready
if %n% LSS 30 goto wait
echo [!] health check timeout - see logs\server.log / logs\server.err.log
pause
exit /b 1

:ready
echo.
echo   [OK] service is up
echo.
echo   OpenAI base : http://127.0.0.1:7864/v1
echo   Admin panel : http://127.0.0.1:7864/admin
echo   API key     : sk-officeace
echo   Log file    : logs\server.log
echo.
exit /b 0

:nonode
echo [X] Node.js 20+ not found.
echo     Install Node.js 20+ , or write the full path of node.exe into data\node.txt
pause
exit /b 1
