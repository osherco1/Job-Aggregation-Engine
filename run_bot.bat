@echo off
REM Change to the directory of this script (so .env and project files are found)
cd /d "%~dp0"

echo Starting LinkedIn Job Bot at %DATE% %TIME%

REM Run the scraper
node scraper.js

REM Keep the window open for 10 seconds so we can see the result
timeout /t 10 /nobreak >nul


