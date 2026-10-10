@echo off
setlocal
cd /d "%~dp0"

call "%~dp0tools\find-node.cmd"
if not defined NODE set "NODE=node"

echo == service task ==
schtasks /query /tn "officeace2api" >nul 2>nul && echo   installed ^(auto start at logon^) || echo   not installed ^(run install-autostart.cmd^)
echo.
echo == health ==
curl -s --max-time 5 http://127.0.0.1:7864/healthz
echo.
echo.
echo == models ==
"%NODE%" tools\list-models.mjs --key sk-officeace
echo.
echo Admin: http://127.0.0.1:7864/admin
