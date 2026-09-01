@echo off
setlocal enabledelayedexpansion

echo === MiniCiV6x6 (CIVA) launcher ===
echo.

echo Stopping any server already running on port 8787 (backend)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do (
    echo   killing PID %%P
    taskkill /PID %%P /F >nul 2>&1
)

echo Stopping any server already running on port 5183 (client)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :5183 ^| findstr LISTENING') do (
    echo   killing PID %%P
    taskkill /PID %%P /F >nul 2>&1
)

echo.
echo Starting backend (web/server) on port 8787...
start "CIVA backend :8787" /D "%~dp0web\server" cmd /k "echo ==== CIVA BACKEND :8787 ==== & echo (close this window, or Ctrl+C, to stop it) & echo. & npm run dev"

echo Starting client dev server (web/) on port 5183...
start "CIVA client :5183" /D "%~dp0web" cmd /k "echo ==== CIVA CLIENT :5183 ==== & echo (close this window, or Ctrl+C, to stop it) & echo. & npm run dev -- --port 5183"

echo.
echo Waiting for both servers to come up...
timeout /t 4 /nobreak >nul

echo Opening the game in your browser...
start "" "http://localhost:5183/start.html"

echo.
echo Done. Backend and client are running in their own windows above ^(look for
echo "CIVA BACKEND :8787" / "CIVA CLIENT :5183" printed at the top of each^) —
echo close those windows, or just run this script again, to stop them.
