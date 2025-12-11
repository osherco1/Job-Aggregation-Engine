@echo off
REM Change directory to the folder where this script lives
cd /d "%~dp0"

REM Activate virtual environment with error check
if not exist "venv\Scripts\activate.bat" (
    echo [ERROR] Cannot find venv\Scripts\activate.bat. Please create the virtual environment first.
    echo Run: python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt
    exit /b 1
)

call venv\Scripts\activate.bat

REM Set environment variables for a normal run
set JOBBOT_DRY_RUN=false
set JOBBOT_LOG_LEVEL=INFO

REM Run the bot
python -m app.main

REM Example to log output (uncomment to enable logging to file):
REM python -m app.main >> jobbot.log 2>&1
