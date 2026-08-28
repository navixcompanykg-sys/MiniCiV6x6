@echo off
setlocal enabledelayedexpansion

echo Stopping any old server on port 5183...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :5183 ^| findstr LISTENING') do (
    echo   killing PID %%P
    taskkill /PID %%P /F >nul 2>&1
)

echo Starting dev server (web/) on port 5183...
cd /d "%~dp0web"
call npm run dev -- --port 5183
