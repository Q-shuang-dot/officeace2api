@echo off
setlocal
cd /d "%~dp0"

rem Resolve the port instead of hard-coding 7864: if someone moved the service in
rem config.json, a hard-coded stop would kill an unrelated process on 7864 and
rem leave the real one running.
rem NOTE: keep this file ASCII-only - cmd.exe reads .cmd with the OEM code page
rem (936 here), so UTF-8 Chinese text gets mangled into stray commands.
call "%~dp0tools\find-node.cmd"
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0tools\admin-url.mjs" --cmd >nul 2>nul
if exist "%~dp0data\admin-url.vars.cmd" call "%~dp0data\admin-url.vars.cmd"
if not defined O2A_PORT set "O2A_PORT=7864"

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
rem The port pattern is followed by the column padding of netstat, never by a
rem digit, so ":7864" cannot accidentally match ":78640".
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%O2A_PORT% " ^| findstr LISTENING') do call :kill %%p

rem single-instance lock: the server removes it on exit; this is a safety net
rem so a leftover lock file can never block the next start (pids get reused).
if exist "data\instance.lock" del /q "data\instance.lock" >nul 2>nul

echo [OK] stopped
exit /b 0

:kill
if "%1"=="" exit /b 0
taskkill /PID %1 /F >nul 2>nul && echo      killed PID %1
exit /b 0
