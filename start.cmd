@echo off
cd /d "%~dp0"
if exist "%~dp0app\server.cjs" (
  cd /d "%~dp0app"
  "%~dp0app\tools\node.exe" "%~dp0app\server.cjs" --open
) else (
  "%~dp0tools\node.exe" "%~dp0server.cjs" --open
)
if errorlevel 1 pause
