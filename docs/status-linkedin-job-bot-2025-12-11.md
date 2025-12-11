# LinkedIn Job Bot – Implementation Status (2025-12-11)

## 1. Overview

The **LinkedIn Job Bot** is an automation tool designed to search for student and junior software engineering roles in Israel, track which jobs have been seen to avoid duplicates, and send email digests of new findings.

Currently, the bot is in a **prototype phase**:
- **Job Search**: Uses a placeholder client returning dummy data (real scraping/API integration is pending).
- **State Management**: Fully implemented (tracks "seen" jobs in a database).
- **Notifications**: Fully implemented (emails new jobs via SMTP).

## 2. What is already implemented

### 2.1 Core application logic

- **Orchestration (`app/main.py`)**:
  - Runs the full pipeline: Init DB → Fetch Jobs → Filter New → Build Email → Send Email → Mark as Seen.
  - Supports **Dry Run Mode** (`JOBBOT_DRY_RUN=true`) to simulate execution without DB writes or email sending.
  - Includes global error handling with automatic email notifications on crash.

- **State Management (`app/state_store.py`)**:
  - Uses **SQLAlchemy** for ORM.
  - **Local**: Defaults to SQLite (`sqlite:///jobs.db`).
  - **Cloud**: Supports PostgreSQL (`DATABASE_URL`), including a fix for Render's `postgres://` connection string scheme.
  - Manages the `jobs_seen` table to deduplicate listings across runs.

- **Email Client (`app/email_client.py`)**:
  - Sends HTML email digests using SMTP.
  - Configurable via environment variables (`JOBBOT_SMTP_HOST`, `JOBBOT_SMTP_USER`, etc.).
  - Generates a tidy HTML table of new job findings.

- **LinkedIn Client (`app/linkedin_client.py`)**:
  - **Placeholder only**: Currently returns a fixed list of 3 dummy jobs for testing purposes.
  - Ready to be swapped with a real implementation.

### 2.2 Configuration and logging

- **`app/config.py`**:
  - Centralized `Settings` class loading variables from `.env` or system environment.
- **`app/logging_config.py`**:
  - Configures a standard logger (`"jobbot"`) writing to stdout.
  - Log level controls via `JOBBOT_LOG_LEVEL` (default: INFO).

### 2.3 Local execution

- **Standard Run**: `python -m app.main` works end-to-end (using dummy data).
- **Configuration**:
  - `.env` file loads local secrets.
  - `.env.example` provides a template with safe defaults (SQLite).

### 2.4 Local scheduling (Windows)

Robust batch scripts are provided for local automation:

- **`run_jobbot.bat`**:
  - Production mode (`JOBBOT_DRY_RUN=false`).
  - Activates the virtual environment automatically.
  - robust to execution context (uses `%~dp0`).
- **`run_jobbot_dryrun.bat`**:
  - Testing mode (`JOBBOT_DRY_RUN=true`, `DEBUG` logs).
- **Documentation**:
  - The `README.md` includes a comprehensive guide for setting up **Windows Task Scheduler** to run these scripts automatically (e.g., every 2 hours).

### 2.5 Cloud deployment (Render) – prepared but not active

- **`render.yaml`**:
  - Defines infrastructure-as-code for Render.
  - **Database**: PostgreSQL (`jobbot-db`, free tier).
  - **Service**: Cron Job (`linkedin-job-bot`) running Python.
- **Status**:
  - Configuration is valid and preserved.
  - **Paused** because Render Cron Jobs require a paid plan. The project is currently optimized for local scheduled runs to keep costs at zero.

## 3. What is still missing / future work

- **Real Job Search**: Replace the dummy data in `app/linkedin_client.py` with a real scraper or API client (e.g., official LinkedIn API, unofficial scrapers, or alternative job boards).
- **Advanced Filtering**: Implement logic to filter by:
  - Location (e.g., "Israel").
  - Keywords (e.g., "student", "junior", "intern").
- **UX Improvements**: Enhance the email template design for better readability on mobile.
- **Resilience**: Implement "backoff" logic for error emails to prevent spamming if the bot fails repeatedly.
- **Cloud Activation**: If a budget allows, enable the Render Cron Job and migrate the local SQLite data to the managed PostgreSQL instance.

## 4. How to use the bot today

### Local Manual Use
1. **Setup**: Create venv, install requirements, and configure `.env`.
2. **Run**: Execute `python -m app.main`.

### Local Scheduled Use (Windows)
1. **Script**: Use `run_jobbot.bat` for the actual job.
2. **Schedule**: Configure Windows Task Scheduler to run this script every 2 hours (see `README.md` for details).

### Future Cloud Use
- The project is ready for Render. Push to a linked repo and deploy the **Blueprint** defined in `render.yaml` when ready to switch to cloud hosting.

## 5. Notes / Open questions

- **SMTP**: Assumes a Gmail App Password or similar SMTP service is available.
- **Task Scheduler**: Requires the host computer to be powered on and active (not sleep mode) to run.
