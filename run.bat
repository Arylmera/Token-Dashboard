@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %ERRORLEVEL% == 0 (
    py -3 cli.py dashboard --reload %*
) else (
    where python >nul 2>nul
    if %ERRORLEVEL% == 0 (
        python cli.py dashboard --reload %*
    ) else (
        echo Python 3 was not found on PATH.
        echo Install it from https://www.python.org/downloads/ and try again.
        pause
        exit /b 1
    )
)

if %ERRORLEVEL% NEQ 0 pause
endlocal
