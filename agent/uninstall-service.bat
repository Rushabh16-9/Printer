@echo off
:: PrintScan Agent -- Uninstaller
:: Run as Administrator

set SERVICE_NAME=PrintScanAgent
set AGENT_DIR=%~dp0

echo Stopping and removing PrintScan Agent service...

if exist "%AGENT_DIR%nssm.exe" (
  "%AGENT_DIR%nssm.exe" stop %SERVICE_NAME% >nul 2>&1
  "%AGENT_DIR%nssm.exe" remove %SERVICE_NAME% confirm
  echo Service removed.
) else (
  sc stop %SERVICE_NAME% >nul 2>&1
  sc delete %SERVICE_NAME% >nul 2>&1
  echo Service removed via sc.
)

echo.
echo PrintScan Agent has been uninstalled.
pause