@echo off
setlocal
title Schuetzen-App einrichten
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Die Einrichtung ist fehlgeschlagen. Bitte die Meldung oben beachten.
  pause
  exit /b 1
)
echo.
pause
