@echo off
rem Starts MondaPac locally on Windows: Docker services, database, API, worker and the seller and admin panels.
rem Run from anywhere: double-click this file or run scripts\dev-local.bat.
rem Needs: Docker Desktop (running), Node.js 24.20+ and pnpm 10 (npm i -g pnpm@10).
rem Then open http://seller.localhost:3001 (seller) or http://admin.localhost:3002 (admin). Mail arrives in Mailpit at http://localhost:8025 .
rem The Market is AU, the first Market (HOSTED_MARKETS in .env.example and PANEL_HOSTS in
rem apps\seller\.env.example name it too; change all three together for another Market).
setlocal
cd /d "%~dp0.."
set "MARKET=AU"

where node >nul 2>nul || (echo Node.js is not installed. Install Node 24.20 or newer from https://nodejs.org & goto :fail)
where pnpm >nul 2>nul || (echo pnpm is not installed. Run: npm i -g pnpm@10 & goto :fail)
where docker >nul 2>nul || (echo Docker is not installed. Install Docker Desktop and start it. & goto :fail)
docker info >nul 2>nul || (echo Docker is not running. Start Docker Desktop and run this again. & goto :fail)

if not exist ".env" (
  echo Creating .env from .env.example
  copy /y ".env.example" ".env" >nul
)
rem An older .env may lack variables added since (for example MIGRATION_DATABASE_URL).
findstr /b /c:"MIGRATION_DATABASE_URL=" ".env" >nul 2>nul || (
  echo .env has no MIGRATION_DATABASE_URL: keeping it as .env.old and creating a new one from .env.example
  move /y ".env" ".env.old" >nul
  copy /y ".env.example" ".env" >nul
)
if not exist "apps\seller\.env.local" (
  echo Creating apps\seller\.env.local from apps\seller\.env.example
  copy /y "apps\seller\.env.example" "apps\seller\.env.local" >nul
)
findstr /b /c:"CLIENT_ADDRESS_SOURCE=" "apps\seller\.env.local" >nul 2>nul || (
  echo apps\seller\.env.local has no CLIENT_ADDRESS_SOURCE: adding CLIENT_ADDRESS_SOURCE=socket
  echo CLIENT_ADDRESS_SOURCE=socket>>"apps\seller\.env.local"
)
if not exist "apps\admin\.env.local" (
  echo Creating apps\admin\.env.local from apps\admin\.env.example
  copy /y "apps\admin\.env.example" "apps\admin\.env.local" >nul
)
findstr /b /c:"CLIENT_ADDRESS_SOURCE=" "apps\admin\.env.local" >nul 2>nul || (
  echo apps\admin\.env.local has no CLIENT_ADDRESS_SOURCE: adding CLIENT_ADDRESS_SOURCE=socket
  echo CLIENT_ADDRESS_SOURCE=socket>>"apps\admin\.env.local"
)

echo [1/5] Installing packages
call pnpm install || goto :fail

echo [2/5] Starting PostgreSQL, Redis and Mailpit
docker compose up -d --wait || goto :fail

echo [3/5] Preparing the database and the local Market configuration
call pnpm db:migrate || goto :fail
node scripts\dev-panels-market.mjs "%MARKET%" || goto :fail

echo [4/5] Starting the API and the worker in their own windows
set "MARKET_CONFIG_DIR=%CD%\.local\markets"
start "MondaPac API" /d "%CD%" cmd /k "pnpm dev"
rem The worker builds the API once; wait so it does not race the API watcher that cleans dist.
start "MondaPac worker" /d "%CD%" cmd /k "timeout /t 60 /nobreak && pnpm dev:worker"

echo [5/5] Starting the seller and admin panels in their own windows
start "MondaPac seller panel" /d "%CD%" cmd /k "pnpm dev:seller"
start "MondaPac admin panel" /d "%CD%" cmd /k "pnpm dev:admin"

echo.
echo Started. Wait about a minute for the first build, then open:
echo   Seller panel : http://seller.localhost:3001
  Admin panel  : http://admin.localhost:3002
echo   Mail (Mailpit): http://localhost:8025
echo To stop: close the four windows, then run "docker compose down".
echo (The four windows inherit MARKET_CONFIG_DIR from this one.)
pause
endlocal
exit /b 0

:fail
echo.
echo Something failed above. Fix it and run this file again.
pause
endlocal
exit /b 1
