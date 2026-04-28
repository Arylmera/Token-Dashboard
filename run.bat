@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js was not found on PATH.
    echo Install Node.js 22.5 or newer from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

node --experimental-sqlite cli.js dashboard %*

if %ERRORLEVEL% NEQ 0 pause
endlocal
