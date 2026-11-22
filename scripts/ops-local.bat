@echo off
rem The local operational test environment: the whole marketplace (admin, sellers, products, buyers,
rem orders paid in Stripe test mode, content) built through the API into an empty database, so the
rem admin panel, the seller panel and the buyer site can be tested like the real system.
rem Design: operational test data, option A, phase 3. Data: scripts\ops-data\README.md.
rem
rem   scripts\ops-local.bat          start everything and top up the data (first run builds all of it, minutes)
rem   scripts\ops-local.bat reset    empty the database, build everything again, then save a backup
rem   scripts\ops-local.bat fast     bring the saved backup back (seconds) and start; needs a reset done before
rem   scripts\ops-local.bat refresh  add today's activity to the running environment, deleting nothing (a minute):
rem                                 shelves filled, special prices renewed, a batch of today's orders (--orders N, default 6)
rem
rem scripts\demo-local.bat is the older, smaller demo and stays as it is. The two share one database: if it
rem holds the demo's data, run "reset" first (it asks before replacing it).
rem Needs what scripts\dev-local.bat needs. Orders need a Stripe test key in .env (README.md); without one
rem the orders are left out and everything else is built.
setlocal
cd /d "%~dp0.."
set "MODE=%~1"
if "%MODE%"=="" set "MODE=start"
if /i not "%MODE%"=="start" if /i not "%MODE%"=="reset" if /i not "%MODE%"=="fast" if /i not "%MODE%"=="refresh" (
  echo Usage: scripts\ops-local.bat [start^|reset^|fast^|refresh [--orders N]]
  goto :fail
)
where node >nul 2>nul || (echo Node.js is not installed. & goto :fail)
where docker >nul 2>nul || (echo Docker is not installed. & goto :fail)
docker info >nul 2>nul || (echo Docker is not running. Start Docker Desktop and run this again. & goto :fail)
if not exist ".env" (
  echo Creating .env from .env.example
  copy /y ".env.example" ".env" >nul
)

set "NO_STRIPE=0"
findstr /r /b /c:"STRIPE_SECRET_KEY=[sr]k_test_" ".env" >nul 2>nul || set "NO_STRIPE=1"
set "ONLY="
if "%NO_STRIPE%"=="1" (
  echo No Stripe test key in .env: the orders are left out. See scripts\ops-data\README.md.
  set "ONLY= --only admin,catalog,sellers,products,content"
)

if /i "%MODE%"=="refresh" (
  rem Needs the environment running (API, worker, Mailpit): the refresh only talks to it, and a reset or restore in progress holds the lock.
  docker compose up -d --wait postgres redis mailpit || goto :fail
  node scripts\ops-data\ops.mjs check || goto :fail
  node scripts\ops-data\refresh.mjs %2 %3 %4 %5 || goto :fail
  endlocal
  exit /b 0
)
if /i "%MODE%"=="start" (
  docker compose up -d --wait postgres redis mailpit || goto :fail
  node scripts\ops-data\ops.mjs check || goto :fail
  set "OPS_LOADER_ARGS=%ONLY%"
  if not exist ".local\ops-data\backup\meta.json" set "OPS_LOADER_ARGS=--backup%ONLY%"
  goto :run
)

rem reset and fast replace the database. Check first (guards, other data, a matching backup); close the windows of a
rem running environment (they hold connections) only when nothing refuses and, for other data, you typed YES.
docker compose up -d --wait postgres redis mailpit || goto :fail
set "REPLACE="
if /i "%MODE%"=="fast" (
  node scripts\ops-data\ops.mjs check --fast || goto :fail
  call :closewindows
  node scripts\ops-data\ops.mjs restore || goto :fail
  set "OPS_LOADER_ARGS=skip"
  goto :run
)
node scripts\ops-data\ops.mjs check
if %errorlevel% equ 0 goto :confirmed
if %errorlevel% neq 3 goto :fail
echo.
echo The database holds other data. A reset replaces ALL of it with the operational test data.
set "ANSWER="
set /p "ANSWER=Type YES to replace it: "
if not "%ANSWER%"=="YES" goto :nothing
set "REPLACE=--replace-unmarked"
:confirmed
call :closewindows
node scripts\ops-data\ops.mjs wipe %REPLACE% || goto :fail
set "OPS_LOADER_ARGS=--within-reset --backup%ONLY%"
goto :run

:nothing
echo Nothing changed.
endlocal
exit /b 1

:run
call "%~dp0dev-local.bat" ops || goto :fail
endlocal
exit /b 0

:closewindows
echo Closing the windows of a running environment
rem "MondaPac " with a space: the titles this environment's windows have, nothing else.
taskkill /f /t /fi "WINDOWTITLE eq MondaPac *" >nul 2>nul
exit /b 0

:fail
echo.
echo Something failed above. Fix it and run this file again. If it says a reset has not finished (or a reset failed half way), run:
echo   node scripts\ops-data\ops.mjs unlock
echo and then scripts\ops-local.bat reset
pause
endlocal
exit /b 1
