@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo ModelPort dependencies are missing. Run npm.cmd install in this folder first.
  pause
  exit /b 1
)
if not exist ".data" mkdir ".data"
start "ModelPort" "node_modules\electron\dist\electron.exe" --enable-logging --log-file="%~dp0.data\electron.log" .
