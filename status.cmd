@echo off
setlocal
cd /d "%~dp0"

call "%~dp0tools\find-node.cmd"
if not defined NODE set "NODE=node"

rem Resolve port + panel URL from config.json (the panel token is generated on
rem first startup, so a hard-coded URL would just 401).
rem NOTE: keep this file ASCII-only - cmd.exe reads .cmd with the OEM codepage,
rem so UTF-8 text gets mangled into stray commands.
"%NODE%" "%~dp0tools\admin-url.mjs" --cmd >nul 2>nul
if exist "%~dp0data\admin-url.vars.cmd" call "%~dp0data\admin-url.vars.cmd"

if not defined O2A_PORT set "O2A_PORT=7864"
if not defined O2A_PANEL set "O2A_PANEL=http://127.0.0.1:%O2A_PORT%/admin"

echo == service task ==
schtasks /query /tn "officeace2api" >nul 2>nul && echo   installed ^(auto start at logon^) || echo   not installed ^(run install-autostart.cmd^)
echo.
echo == health ==
curl -s --max-time 5 http://127.0.0.1:%O2A_PORT%/healthz
echo.
echo.
echo == models ==
"%NODE%" "%~dp0tools\list-models.mjs" --key sk-officeace
echo.
echo Admin: %O2A_PANEL%
