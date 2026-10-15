@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required on the BUILD machine.
  pause
  exit /b 1
)
if not exist "node_modules\electron-builder\cli.js" (
  echo Build dependencies are missing. Run npm.cmd ci first.
  pause
  exit /b 1
)
echo ModelPort release: check, test, build EXE, then test the standalone EXE.
call npm.cmd run release
set "MODELPORT_BUILD_RESULT=%ERRORLEVEL%"
if not "%MODELPORT_BUILD_RESULT%"=="0" (
  echo Release failed. Read the error above. Do not distribute this build.
) else (
  echo Release verified. The standalone EXE and checksum are in the dist folder.
)
pause
exit /b %MODELPORT_BUILD_RESULT%
