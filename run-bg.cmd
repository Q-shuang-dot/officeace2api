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
rem
rem server.log rotates itself (8 MB x 3 generations, see src\logger.mjs), but this
rem file is a cmd redirect target - nobody rotates it, so it only ever grows.
rem Rotate it here, BEFORE node starts: once node (and therefore this redirect
rem handle) is running, renaming the file hits a sharing violation on Windows.
call :rotate_err
"%NODE%" src\index.mjs 2>>"logs\server.err.log"
exit /b %ERRORLEVEL%

:rotate_err
if not exist "logs\server.err.log" exit /b 0
for %%F in ("logs\server.err.log") do if %%~zF LSS 8388608 exit /b 0
if exist "logs\server.err.log.3" del /q "logs\server.err.log.3"
if exist "logs\server.err.log.2" move /y "logs\server.err.log.2" "logs\server.err.log.3" >nul
if exist "logs\server.err.log.1" move /y "logs\server.err.log.1" "logs\server.err.log.2" >nul
move /y "logs\server.err.log" "logs\server.err.log.1" >nul
exit /b 0
