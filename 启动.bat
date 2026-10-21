@echo off
setlocal
title M-DSH-C
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

node src\server.js %*
echo.
echo   Launcher stopped.
pause
exit /b 0

:NONODE
echo.
echo   [ERROR] Node.js not found in PATH.
echo.
echo   Install Node.js 20 or newer:  https://nodejs.org/
echo   Then run this file again.
echo.
pause
exit /b 1
