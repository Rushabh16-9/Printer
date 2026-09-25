@echo off
:: PrintScan Agent ? Windows Service Installer
:: Run this ONCE as Administrator on the printing PC.
:: After this, the agent starts automatically every time Windows boots.

setlocal
set SERVICE_NAME=PrintScanAgent
set AGENT_DIR=%~dp0

:: Find node.exe in PATH
where node > "%TEMP%\nodepath.txt" 2>nul
set /p NODE_EXE=<"%TEMP%\nodepath.txt"
del "%TEMP%\nodepath.txt" 2>nul

if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause & exit /b 1
)

echo.
echo ============================================================
echo   PrintScan Agent -- Windows Service Installer
echo ============================================================
echo.
echo   Agent folder : %AGENT_DIR%
echo   Node.js      : %NODE_EXE%
echo   Service name : %SERVICE_NAME%
echo.

if not exist "%AGENT_DIR%.env" (
  echo [ERROR] .env file not found!
  echo Copy .env.example to .env and fill in SERVER_URL and AGENT_SECRET.
  pause & exit /b 1
)

if not exist "%AGENT_DIR%nssm.exe" (
  echo Downloading NSSM service manager...
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile '%TEMP%\nssm.zip'; Expand-Archive -Path '%TEMP%\nssm.zip' -DestinationPath '%TEMP%\nssm' -Force; Copy-Item '%TEMP%\nssm\nssm-2.24\win64\nssm.exe' '%AGENT_DIR%nssm.exe'"
  if not exist "%AGENT_DIR%nssm.exe" (
    echo [ERROR] Could not download NSSM. Get nssm.exe from https://nssm.cc and place it here.
    pause & exit /b 1
  )
)

sc query %SERVICE_NAME% >nul 2>&1
if %errorlevel% == 0 (
  echo Removing old service...
  "%AGENT_DIR%nssm.exe" stop %SERVICE_NAME% >nul 2>&1
  "%AGENT_DIR%nssm.exe" remove %SERVICE_NAME% confirm >nul 2>&1
)

echo Installing service...
"%AGENT_DIR%nssm.exe" install %SERVICE_NAME% "%NODE_EXE%" "%AGENT_DIR%agent.js"
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% AppDirectory "%AGENT_DIR%"
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% DisplayName "PrintScan Agent"
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% Description "PrintScan wireless print agent"
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% Start SERVICE_AUTO_START
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% AppStdout "%AGENT_DIR%logs\agent-out.log"
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% AppStderr "%AGENT_DIR%logs\agent-err.log"
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% AppRotateFiles 1
"%AGENT_DIR%nssm.exe" set %SERVICE_NAME% AppRotateBytes 1048576

if not exist "%AGENT_DIR%logs" mkdir "%AGENT_DIR%logs"

echo Starting service...
"%AGENT_DIR%nssm.exe" start %SERVICE_NAME%

echo.
echo ============================================================
echo   SUCCESS! PrintScan Agent is now a Windows Service.
echo   It auto-starts on every boot. No manual action needed.
echo.
echo   Check status : sc query PrintScanAgent
echo   View logs    : type "%AGENT_DIR%logs\agent-out.log"
echo   Uninstall    : run uninstall-service.bat as Administrator
echo ============================================================
echo.
pause