# LinkedIn Job Bot – Implementation Status (2025-12-13)

## 1. Overview

The **LinkedIn Job Bot** is an automation tool designed to search for student and junior software engineering roles in Israel, track which jobs have been seen to avoid duplicates, and send email digests of new findings.

Currently, the bot is in **Phase 3 (Real Job Search)** and is **ACTIVE**:
- **Job Search**: Fully functional using Playwright (Headed Mode) and a local Chrome profile to bypass authentication walls.
- **State Management**: Fully implemented (tracks "seen" jobs in a database).
- **Notifications**: Fully implemented (emails new jobs via SMTP).

## 2. What is already implemented

### 2.1 Core application logic

- **Orchestration (`app/main.py`)**:
  - Runs the full pipeline: Init DB → Fetch Jobs (Real) → Filter New → Build Email → Send Email → Mark as Seen.
  - Supports **Dry Run Mode** (`JOBBOT_DRY_RUN=true`) to simulate execution without DB writes or email sending.
  - Includes global error handling with automatic email notifications on crash.

- **State Management (`app/state_store.py`)**:
  - Uses **SQLAlchemy** for ORM.
  - **Local**: Defaults to SQLite (`sqlite:///jobs.db`).
  - Manages the `jobs_seen` table to deduplicate listings across runs.

- **Email Client (`app/email_client.py`)**:
  - Sends HTML email digests using SMTP.
  - Configurable via environment variables (`JOBBOT_SMTP_HOST`, `JOBBOT_SMTP_USER`, etc.).
  - Generates a tidy HTML table of new job findings.

- **LinkedIn Client (`app/linkedin_client.py`)** [UPDATED]:
  - **Browser Automation**: Uses **Playwright** with `channel="chrome"`.
  - **Headed Mode**: Forced to `headless=False` to avoid detection by LinkedIn.
  - **Auth Bypass**: Connects to the local Chrome user profile (`user_data_dir`) to reuse existing LinkedIn sessions (cookies/local storage).
  - **Robust Parsing**: Implements a "Sanity Check" to detect Auth Walls and uses multiple CSS selectors to reliably extract job details.
  - **Stealth**: Uses basic stealth techniques (hiding webdriver property).

### 2.2 Configuration and logging

- **`app/config.py`**:
  - Centralized `Settings` class loading variables from `.env`.
- **`app/logging_config.py`**:
  - Configures a standard logger (`"jobbot"`) writing to stdout.

### 2.3 Local execution

- **Standard Run**: `run_jobbot.bat` or `python -m app.main` works end-to-end with real data.
- **Configuration**:
  - `.env` file loads local secrets.
  - `HEADLESS_MODE=false` is enforced for successful scraping.

### 2.4 Local scheduling (Windows)

- **`run_jobbot.bat`**: Production mode (Headless=False, DryRun=False).
- **`run_jobbot_dryrun.bat`**: Testing mode (Headless=False, DryRun=True).
- **Documentation**: `README.md` guides Windows Task Scheduler setup.

## 3. Known Issues

- **Broken Links in Email**: The job links generated in the email digest are currently relative or malformed (e.g., missing the base domain). This is a known issue to be fixed in the next session.

## 4. What is still missing / future work

- **Link Fix**: Ensure absolute URLs in emails.
- **Advanced Filtering**: Implement logic to filter by location or keywords (currently relies on the saved search URL).
- **Resilience**: Implement "backoff" logic for error emails.
- **Cloud Activation**: Currently paused; optimized for local execution.

## 5. How to use the bot today

### Local Manual Use
1. **Setup**: Ensure Chrome is closed.
2. **Run**: Execute `run_jobbot_dryrun.bat` to test.
3. **Verify**: Check logs for "Search complete" and check your email inbox.

### Local Scheduled Use
1. **Script**: Use `run_jobbot.bat`.
2. **Schedule**: Configure Windows Task Scheduler to run this script (ensure "Run only when user is logged on" is selected so the visible window can launch).

## 6. Notes

- **Chrome Profile**: The bot relies on the user being logged into LinkedIn in their local Chrome profile. If the session expires, run `setup_auth.py` (or just open Chrome and login) to refresh it.
