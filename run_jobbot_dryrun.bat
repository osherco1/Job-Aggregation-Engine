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

REM Set environment variables for a dry run
set JOBBOT_DRY_RUN=true
set JOBBOT_LOG_LEVEL=DEBUG

REM Run the bot
python -m app.main
