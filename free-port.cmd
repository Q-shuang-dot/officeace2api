@echo off
setlocal
cd /d "%~dp0"

rem Double-click entry for "the port is busy / the service will not start".
rem It calls tools\free-port.ps1, which says who holds the port and clears it when
rem that is safe. It never touches a HEALTHY instance of this service.
rem
rem Exit codes from free-port.ps1: 0 = ok, 1 = still blocked, 2 = still blocked and
rem it needs administrator rights - then we ask for elevation once, in a new window.
rem
rem NOTE: keep this file ASCII-only. cmd.exe reads .cmd with the OEM code page
rem (936 here), so UTF-8 Chinese text gets mangled into stray commands.

set "PSH=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PSH%" set "PSH=powershell"

"%PSH%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\free-port.ps1" -RepairNat %*
set "RC=%ERRORLEVEL%"

if "%RC%"=="2" if not defined O2A_ELEVATED (
  echo.
  echo [i] this needs administrator rights - opening an elevated window ...
  set "O2A_ELEVATED=1"
  "%PSH%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','\"%~f0\"' -Verb RunAs" 2>nul
  if errorlevel 1 echo [X] elevation was refused - right-click this file and pick "Run as administrator".
  echo.
  pause
  exit /b 0
)

echo.
pause
exit /b %RC%