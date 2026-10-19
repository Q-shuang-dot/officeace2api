@echo off
setlocal
cd /d "%~dp0"

call "%~dp0tools\find-node.cmd"
if not defined NODE (
  echo [X] Node.js 20+ not found.
  pause
  exit /b 1
)

:run
echo [*] node : %NODE%
rem Same port check as start.cmd / run-bg.cmd: a busy port would make node exit
rem instantly, and in foreground mode the window just closes and looks like a crash.
set "PSH=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PSH%" set "PSH=powershell"
"%PSH%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\free-port.ps1"
rem 9009 = "powershell.exe not found": a missing helper must not block the start.
if errorlevel 1 if not errorlevel 9009 (
  echo [X] the port is not usable - run free-port.cmd to see who holds it.
  pause
  exit /b 1
)
echo [*] foreground mode - press Ctrl+C to stop
"%NODE%" src\index.mjs
pause
