@echo off
rem One command for the local demo: starts everything and fills it with the sample marketplace.
rem Double-click this file or run scripts\demo-local.bat (see scripts\dev-local.bat for what it needs).
rem The buyer site starts too, at http://storefront.localhost:3003 (fixed port 3003).
call "%~dp0dev-local.bat" seed
