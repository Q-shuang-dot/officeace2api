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
echo [*] foreground mode - press Ctrl+C to stop
"%NODE%" src\index.mjs
pause
