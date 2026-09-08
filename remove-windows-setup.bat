@echo off
setlocal
title Schuetzen-App Einrichtung entfernen
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\uninstall.ps1" %*
if errorlevel 1 (
  echo.
  echo Die Deinstallation ist fehlgeschlagen. Bitte die Meldung oben beachten.
  pause
  exit /b 1
)
echo.
pause
