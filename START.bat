@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==========================================
echo   War Monitor - start server
echo ==========================================
echo Project folder: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node.exe not found.
  echo Install Node.js LTS from https://nodejs.org/
  echo Check "Add to PATH" during setup, then close CMD and run START.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "monitor.html" (
  echo ERROR: monitor.html not found here. Put START.bat next to monitor.html.
  pause
  exit /b 1
)
if not exist "backend\server.js" (
  echo ERROR: backend\server.js not found.
  pause
  exit /b 1
)

taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak >nul

where npm >nul 2>&1
if not errorlevel 1 (
  if exist "package.json" if not exist "node_modules\" (
    echo Running npm install in project root...
    call npm install
  )
  if not exist "backend\node_modules\" (
    echo Running npm install in backend folder...
    pushd backend
    call npm install
    popd
  )
) else (
  echo WARNING: npm not in PATH. Skipping npm install. If server fails, run: npm install
)

echo.
echo Starting: node backend\server.js
echo Open: http://localhost:8080/
echo.

start "War Monitor Server" /D "%~dp0" cmd /k node backend\server.js

echo Waiting for server...
timeout /t 5 /nobreak >nul

set "OPEN_URL=http://localhost:8080/?nocache=%RANDOM%"
start "" "%OPEN_URL%"

echo.
echo ==========================================
echo Site: http://localhost:8080/
echo Hard refresh if old page: Ctrl+Shift+R
echo Other port: create .env with PORT=8090
echo ==========================================
pause
endlocal
