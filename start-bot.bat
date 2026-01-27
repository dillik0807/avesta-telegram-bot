@echo off
echo ========================================
echo   Avesta Telegram Bot
echo ========================================
echo.

cd /d "%~dp0"

echo Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not installed!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo Checking dependencies...
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

echo.
echo Starting bot...
echo Press Ctrl+C to stop
echo.

node bot.js

pause
