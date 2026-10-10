@echo off
setlocal
cd /d "%~dp0"

if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"

call "%~dp0tools\find-node.cmd"
if not defined NODE (
  echo [X] Node.js 20+ not found.
  echo     Install Node.js 20+ , or write the full path of node.exe into data\node.txt
  exit /b 1
)

rem stdout goes to console, the app writes logs\server.log itself;
rem stderr is kept in case node dies before logging is initialised.
"%NODE%" src\index.mjs 2>>"logs\server.err.log"
