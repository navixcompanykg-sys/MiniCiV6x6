@echo off
REM Открывает PowerShell сразу в этой папке проекта и запускает в нём claude.
REM Двойной клик по этому файлу — то же самое, что вручную cd в проект + claude.
start "ЦИВА — claude" powershell -NoExit -Command "Set-Location -LiteralPath '%~dp0'; claude"
