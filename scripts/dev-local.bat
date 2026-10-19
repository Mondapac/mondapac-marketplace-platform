@echo off
rem Starts MondaPac locally on Windows: Docker services, database, API, worker, the seller and admin panels
rem and the buyer site.
rem Run from anywhere: double-click this file or run scripts\dev-local.bat.
rem Needs: Docker Desktop (running), Node.js 24.20+ and pnpm 10 (npm i -g pnpm@10).
rem Then open http://seller.localhost:3001 (seller), http://admin.localhost:3002 (admin) or
rem http://storefront.localhost:3003 (buyer site, port 3003). Mail arrives in Mailpit at http://localhost:8025 .
rem Optional argument "seed": also fills the database with the sample Brisbane marketplace (four
rem sellers, 14 products, prices, stock, a buyer) once the services are up; the sample logins are
rem written to .local\demo-credentials.txt. Without it nothing is added. Run "scripts\demo-local.bat"
rem for the same thing by double-click. The buyer site runs at http://storefront.localhost:3003
rem (STOREFRONT_ORIGIN below; port 3003 is fixed in apps\web\package.json). It shows sample data only.
rem The Market is AU, the first Market (HOSTED_MARKETS in .env.example and PANEL_HOSTS in
rem apps\seller\.env.example name it too; change all three together for another Market).
setlocal
cd /d "%~dp0.."
set "MARKET=AU"
set "SEED=0"
if /i "%~1"=="seed" set "SEED=1"
rem The buyer site's slot in the local demo: its origin is allowed for customer requests.
set "STOREFRONT_ORIGIN=http://storefront.localhost:3003"
echo Buyer site (when started): %STOREFRONT_ORIGIN%

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
findstr /b /c:"PANEL_LOCALE=" "apps\seller\.env.local" >nul 2>nul || (
  echo apps\seller\.env.local has no PANEL_LOCALE: adding PANEL_LOCALE=en-AU, the AU Market's locale
  echo PANEL_LOCALE=en-AU>>"apps\seller\.env.local"
)
if not exist "apps\admin\.env.local" (
  echo Creating apps\admin\.env.local from apps\admin\.env.example
  copy /y "apps\admin\.env.example" "apps\admin\.env.local" >nul
)
findstr /b /c:"CLIENT_ADDRESS_SOURCE=" "apps\admin\.env.local" >nul 2>nul || (
  echo apps\admin\.env.local has no CLIENT_ADDRESS_SOURCE: adding CLIENT_ADDRESS_SOURCE=socket
  echo CLIENT_ADDRESS_SOURCE=socket>>"apps\admin\.env.local"
)
findstr /b /c:"PANEL_LOCALE=" "apps\admin\.env.local" >nul 2>nul || (
  echo apps\admin\.env.local has no PANEL_LOCALE: adding PANEL_LOCALE=en-AU, the AU Market's locale
  echo PANEL_LOCALE=en-AU>>"apps\admin\.env.local"
)

echo [1/5] Installing packages
call pnpm install || goto :fail

echo [2/5] Starting PostgreSQL, Redis and Mailpit
docker compose up -d --wait || goto :fail

echo [3/5] Preparing the database and the local Market configuration
call pnpm db:migrate || goto :fail
node scripts\dev-panels-market.mjs "%MARKET%" || goto :fail
rem The catalog refuses every text until the Market has a claim vocabulary; this writes the demo's.
if "%SEED%"=="1" ( node scripts\demo-seed\claim-vocabulary.mjs || goto :fail )

echo [4/5] Starting the API and the worker in their own windows
set "MARKET_CONFIG_DIR=%CD%\.local\markets"
set "SERVICE_AREA_CONFIG_DIR=%CD%\.local\service-areas"
start "MondaPac API" /d "%CD%" cmd /k "pnpm dev"
rem The worker builds the API once; wait so it does not race the API watcher that cleans dist.
start "MondaPac worker" /d "%CD%" cmd /k "timeout /t 60 /nobreak && pnpm dev:worker"

echo [5/5] Starting the seller and admin panels and the buyer site in their own windows
start "MondaPac seller panel" /d "%CD%" cmd /k "pnpm dev:seller"
start "MondaPac admin panel" /d "%CD%" cmd /k "pnpm dev:admin"
start "MondaPac buyer site" /d "%CD%" cmd /k "pnpm dev:web"

if "%SEED%"=="1" (
  echo Starting the demo data in its own window; it waits for the API and the worker.
  start "MondaPac demo data" /d "%CD%" cmd /k "node scripts\demo-seed\index.mjs"
)

rem The panels start in seconds but the API needs a minute to build; a sign-in before then fails
rem with "upstream-unreachable". Wait here (up to 5 minutes) so the message below is true.
where curl >nul 2>nul || (echo curl was not found, so this script cannot wait for the API. Check the "MondaPac API" window yourself. & goto :afterwait)
echo Waiting for the API on http://localhost:3000 ...
set /a TRIES=0
:waitapi
curl -s -f -m 3 -o nul http://localhost:3000/health && goto :apiready
set /a TRIES+=1
if %TRIES% geq 60 goto :apislow
ping -n 6 127.0.0.1 >nul
goto :waitapi
:apislow
echo.
echo The API is not answering yet. Look at the "MondaPac API" window: if it shows an error, fix that first;
echo if it is still building, wait until it says the application started, then reload the panel.
goto :afterwait
:apiready
echo The API is ready.
:afterwait
echo.
echo Started. Open:
echo   Seller panel : http://seller.localhost:3001
echo   Admin panel  : http://admin.localhost:3002
echo   Buyer site   : %STOREFRONT_ORIGIN%
echo   Mail (Mailpit): http://localhost:8025
if "%SEED%"=="1" echo   Sample logins : .local\demo-credentials.txt  (written when the demo data window says Done)
echo To stop: close the windows, then run "docker compose down" (add -v to wipe the demo data).
echo (The windows inherit MARKET_CONFIG_DIR and SERVICE_AREA_CONFIG_DIR from this one.)
pause
endlocal
exit /b 0

:fail
echo.
echo Something failed above. Fix it and run this file again.
pause
endlocal
exit /b 1
