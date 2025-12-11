# LinkedIn Job Bot (Render + Python)

A Python automation bot that searches LinkedIn for student/junior engineering roles in Israel and emails new findings. Designed to run as a scheduled Cron Job on **Render**.

## Project Structure

```
linkedin_job_bot/
├── app/
│   ├── main.py            # Entry point (Orchestration with error handling)
│   ├── config.py          # Configuration & secret management
│   ├── logging_config.py  # Centralized logging setup
│   ├── linkedin_client.py # Placeholder job search logic
│   ├── email_client.py    # Email sending logic
│   └── state_store.py     # Database state management (SQLite/Postgres)
├── render.yaml            # Render Blueprint for automated deployment
├── .env.example           # Template for environment variables
├── requirements.txt       # Python dependencies
└── README.md              # This file
```

## Local Setup

### 1. Prerequisites
- Python 3.10+
- Git

### 2. Create a Virtual Environment

```bash
# Windows
python -m venv venv
venv\Scripts\activate

# Mac/Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Configuration

Copy `.env.example` to `.env` and fill in your details:

```bash
cp .env.example .env
```

**Required Variables**:
- `JOBBOT_SMTP_HOST`, `JOBBOT_SMTP_USER`, `JOBBOT_SMTP_PASS`, `JOBBOT_TO_EMAIL`.

### 5. Run Locally

**Standard Mode**:
Using local SQLite database (`jobs.db`).
```bash
python -m app.main
```

**Dry Run Mode** (No side effects):
```bash
# Windows (PowerShell)
$env:JOBBOT_DRY_RUN="true"; python -m app.main

# Mac/Linux
JOBBOT_DRY_RUN=true python -m app.main
```

## Local Scheduled Runs (Windows Task Scheduler)

You can run the bot automatically on your local machine using Windows Task Scheduler.

### A. Prerequisites
1. **Python 3.x** installed.
2. **Virtual Environment** created and dependencies installed:
   ```bash
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. **Configuration**: `.env` file configured with SMTP details.

### B. Manual Script Execution
You can run the bot manually using the provided batch scripts (double-click or run from PowerShell):

- **Production Run** (Normal mode):
  ```powershell
  .\run_jobbot.bat
  ```
- **Dry Run** (Testing mode, no DB changes):
  ```powershell
  .\run_jobbot_dryrun.bat
  ```

### C. Create a Windows Task Scheduler Job
1. Open **Task Scheduler** from the Start menu.
2. Click **Create Basic Task...** and name it e.g., "LinkedIn Job Bot".
3. **Trigger**: Select **Daily**.
4. **Action**: Select **Start a program**.
5. **Program/script**: `C:\Windows\System32\cmd.exe`
6. **Add arguments**: `/c "C:\path\to\linkedin_job_bot\run_jobbot.bat"`
   *(Replace `C:\path\to\...` with the actual path to your project folder).*
7. Click **Finish**.

**Configure Repeat Interval**:
1. Find your new task in the list, right-click, and select **Properties**.
2. Go to the **Triggers** tab and click **Edit...**.
3. Check **Repeat task every**: `1 hour` (then manually type `2 hours`).
4. Set **for a duration of**: `Indefinitely`.
5. Click **OK**.

> **Note**: The task will only run when your computer is powered on and not in Sleep mode. This is a fully local solution with no cloud costs.

### D. Cloud Deployment (Optional)
The existing `render.yaml` and **Deployment to Render** instructions below remain fully valid. You can start with local scheduling and migrate to Render later if you prefer a managed cloud solution. Local and cloud deployments are independent.

This project is configured for **Render Blueprints**.

### 1. Push to Git
Ensure your code is pushed to a repository (GitHub/GitLab) connected to your Render account.

### 2. Deploy using Blueprint
1. Go to the [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** -> **Blueprint**.
3. Connect your repository.
4. Render will detect `render.yaml` and propose creating:
   - **jobbot-db**: A managed PostgreSQL database (Free Plan).
   - **linkedin-job-bot**: A generic Cron Job service (Free Plan).
5. Click **Apply**.

### 3. Configure Secrets
Once the services are created, the build might fail or the job might crash initially because secrets are missing. You must add them manually:

1. Go to the **Dashboard** -> **linkedin-job-bot** (Cron Job).
2. Click **Environment**.
3. Add the following Environment Variables:
   - `JOBBOT_SMTP_HOST`
   - `JOBBOT_SMTP_PORT`
   - `JOBBOT_SMTP_USER`
   - `JOBBOT_SMTP_PASS`
   - `JOBBOT_TO_EMAIL`
   - `LINKEDIN_EMAIL` (Optional for now)
   - `LINKEDIN_PASSWORD` (Optional for now)

### 4. Verify
1. In the Dashboard, find the Cron Job and click **Trigger Run** (or wait for the schedule).
2. Check the **Logs** tab. You should see "JobBot main() started" and the search process.
3. Check **Persistent Storage**: Valid jobs will be stored in the Postgres database automatically linked via `DATABASE_URL`.

**Note on Filesystem**: Render's filesystem is ephemeral. We use Postgres (`jobbot-db`) to persist the list of "seen" jobs, so the bot remembers them across restarts.
