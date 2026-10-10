@echo off
setlocal
cd /d "%~dp0"

set "URL=http://127.0.0.1:7864/admin"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

"%PS%" -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:7864/healthz' -UseBasicParsing -TimeoutSec 4; exit 0 } catch { exit 1 }" >nul 2>&1

if errorlevel 1 (
  echo   service is down, starting it ...
  call "%~dp0start.cmd"
  echo.
)

echo   opening %URL%
start "" "%URL%"
endlocal
