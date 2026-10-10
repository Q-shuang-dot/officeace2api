@echo off
setlocal
cd /d "%~dp0"

schtasks /query /tn "officeace2api" >nul 2>nul && (
  schtasks /end /tn "officeace2api" >nul 2>nul
  echo      scheduled task stopped
)

set "PIDFILE=data\server.pid"
if not exist "%PIDFILE%" goto port

set /p PID=<"%PIDFILE%"
call :kill %PID%
del /q "%PIDFILE%" >nul 2>nul

:port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":7864" ^| findstr LISTENING') do call :kill %%p

rem single-instance lock: the server removes it on exit; this is a safety net
rem so a leftover lock file can never block the next start (pids get reused).
if exist "data\instance.lock" del /q "data\instance.lock" >nul 2>nul

echo [OK] stopped
exit /b 0

:kill
if "%1"=="" exit /b 0
taskkill /PID %1 /F >nul 2>nul && echo      killed PID %1
exit /b 0
