@echo off
setlocal
cd /d "%~dp0"

rem Export every account credential of THIS pc into one file, so another pc can
rem import it instead of signing in again.
rem English-only on purpose: cmd.exe reads .cmd with the OEM code page (936 here),
rem so UTF-8 Chinese text would be mangled. See CONTRIBUTING.md.
rem NOTE: this file must stay ASCII + CRLF (tools\normalize-cmd.ps1 enforces it).

call "%~dp0tools\find-node.cmd"
if not defined NODE (
  echo [X] Node.js 20+ not found. Install it, or write the full path of node.exe into data\node.txt
  pause
  exit /b 1
)

echo.
echo   Export this PC's accounts  ^(for moving to another computer^)
echo   ------------------------------------------------------------
echo   The file contains real credentials. Give it a passphrase, or press
echo   Enter to export plain text ^(then keep the file to yourself^).
echo.

set "PASS="
set /p "PASS=Passphrase ^(Enter = no password^): "

rem Pass the passphrase through the environment, not the command line: a
rem passphrase containing ^& or ^" would otherwise break the quoting.
set "O2A_BUNDLE_PASS=%PASS%"
"%NODE%" "%~dp0tools\export-accounts.mjs"
set "RC=%ERRORLEVEL%"
set "O2A_BUNDLE_PASS="

if not "%RC%"=="0" (
  echo.
  echo [X] export failed - see the message above.
  pause
  exit /b 1
)

echo.
echo   Copy that file to the new computer, then double-click import-accounts.cmd
echo   there and drag the file onto it.
echo.
pause
exit /b 0
