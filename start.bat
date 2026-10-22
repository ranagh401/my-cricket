@echo off
title MY CRICKET
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Download it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
node server.js
echo.
echo The server has stopped.
pause
