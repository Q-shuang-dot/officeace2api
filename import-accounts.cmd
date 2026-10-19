@echo off
setlocal
cd /d "%~dp0"

rem Import the file exported by export-accounts.cmd on the old computer, so no
rem account has to be signed in again.
rem English-only on purpose: cmd.exe reads .cmd with the OEM code page (936 here),
rem so UTF-8 Chinese text would be mangled. See CONTRIBUTING.md.
rem NOTE: this file must stay ASCII + CRLF (tools\normalize-cmd.ps1 enforces it).

call "%~dp0tools\find-node.cmd"
if not defined NODE (
  echo [X] Node.js 20+ not found. Install it, or write the full path of node.exe into data\node.txt
  pause
  exit /b 1
)

set "BUNDLE=%~1"
if not defined BUNDLE (
  echo.
  echo   Import accounts exported from another computer
  echo   ---------------------------------------------
  echo   Drag the exported .json file onto this window and press Enter.
  echo   ^(Or type its full path. Nothing is deleted: existing accounts stay.^)
  echo.
  set /p "BUNDLE=File: "
)

rem Typed/pasted paths often come with quotes around them.
set "BUNDLE=%BUNDLE:"=%"
if not defined BUNDLE (
  echo [X] no file given.
  pause
  exit /b 1
)
if not exist "%BUNDLE%" (
  echo [X] file not found: %BUNDLE%
  pause
  exit /b 1
)

echo.
set "PASS="
set /p "PASS=Passphrase ^(Enter if the file has no password^): "

set "O2A_BUNDLE_PASS=%PASS%"
"%NODE%" "%~dp0tools\import-accounts.mjs" "%BUNDLE%"
set "RC=%ERRORLEVEL%"
set "O2A_BUNDLE_PASS="

if not "%RC%"=="0" (
  echo.
  echo [X] import failed - see the message above.
  pause
  exit /b 1
)

echo.
pause
exit /b 0
