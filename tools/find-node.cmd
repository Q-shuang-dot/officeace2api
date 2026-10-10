@echo off
rem Resolve a Node.js >= 20 executable into the NODE variable of the CALLING script.
rem Do not wrap the caller in "setlocal" around this call, or NODE will be lost.
rem Order: data\node.txt -> PATH -> OfficeAce bundled node -> Program Files.

set "ROOT=%~dp0.."
set "NODE="

rem 1) manual override
if exist "%ROOT%\data\node.txt" for /f "delims=" %%i in ('type "%ROOT%\data\node.txt" 2^>nul') do if not defined NODE call :probe "%%i"
if defined NODE exit /b 0

rem 2) node bundled with OfficeAce - always a modern build
for %%d in (C D E F) do if not defined NODE if exist "%%d:\" for /d %%a in ("%%d:\*") do if not defined NODE if exist "%%~fa\OfficeAce\tools\node\node.exe" call :probe "%%~fa\OfficeAce\tools\node\node.exe"
if defined NODE exit /b 0

rem 3) whatever is on PATH (old versions are rejected by :probe)
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE call :probe "%%i"
if defined NODE exit /b 0

if exist "%ProgramFiles%\nodejs\node.exe" call :probe "%ProgramFiles%\nodejs\node.exe"
if defined NODE exit /b 0
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" call :probe "%LOCALAPPDATA%\Programs\nodejs\node.exe"
exit /b 0

:probe
set "CAND=%~1"
if not exist "%CAND%" exit /b 0
set "MAJ="
for /f "tokens=1 delims=." %%a in ('"%CAND%" -v 2^>nul') do set "MAJ=%%a"
if not defined MAJ exit /b 0
set "MAJ=%MAJ:v=%"
set "MAJ=%MAJ: =%"
echo %MAJ%|findstr /r /c:"^[0-9][0-9]*$" >nul || exit /b 0
if %MAJ% GEQ 20 set "NODE=%CAND%"
exit /b 0
