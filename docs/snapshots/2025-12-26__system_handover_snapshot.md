# System Handover Snapshot – Phase 3 Completion (December 26, 2025)

## 1. Executive Summary & Phase Status

**Phase 3 (Safety, Stealth, Observability) is COMPLETE.**  
The system has evolved from a single root-level script into a structured, modular bot with clear separation of concerns and a clean filesystem layout:

- **`/data`**: Persistent operational state (dedup DB: `seen_jobs.json`).
- **`/logs`**: Run-level telemetry (`run_summary_*.json`, `filtered_jobs_debug_*.json`, `analysis_state.json`).
- **`/output`**: User-facing artifacts (`enriched_jobs_*.json`).
- **`/debug_artifacts`**: Ephemeral, high-volume debug dumps (`debug_linkedin_response.json`, `debug_job_details_*.json`).
- **`/docs/snapshots`**: Time-stamped documentation snapshots for change tracking.

Root clutter (raw JSON and logs) has been eliminated; every generated artifact now has a clear home and lifecycle.

## 2. System Architecture View (End-to-End Flow)

### 2.1 Data Lifecycle (High-Level Flow)

```text
dotenv/.env  ->  scraper.js bootstrap  ->  ensureDir(DATA/LOGS/OUTPUT)
                  |
                  v
        SEARCH_QUERIES matrix (LEVEL_PREFIX + NICHES)
                  |
                  v
        Batches of 5 queries with jitter
                  |
                  v
        linkedin_client.fetchJobs (Voyager API)
                  |
                  v
      normalizeResponse + raw debug artifacts (debug_artifacts/)
                  |
                  v
      Dedup against data/seen_jobs.json
                  |
                  v
      Enrich via fetchJobDetails (GraphQL + debug_job_details_*.json)
                  |
                  v
      passesFilters (blacklist/whitelist) + quota limit
                  |
                  v
      OUTPUT: output/enriched_jobs_*.json + email (unless DRY_RUN)
                  |
                  v
      LOGS: logs/run_summary_*.json, logs/filtered_jobs_debug_*.json
                  |
                  v
      ANALYTICS: analyze_logs.js (dead queries, top performers, trends)
```

### 2.2 Initialization

- `scraper.js`:
  - Loads `.env` via `require('dotenv').config()`.
  - Declares canonical directories:
    - `DATA_DIR = path.join(__dirname, 'data')`
    - `LOGS_DIR = path.join(__dirname, 'logs')`
    - `OUTPUT_DIR = path.join(__dirname, 'output')`
  - Uses **`ensureDir(dirPath)`** (mkdir with `{ recursive: true }`) before any read/write to `DATA`, `LOGS`, `OUTPUT`.
  - `loadSeenJobIds()` ensures `data/seen_jobs.json` exists (or starts fresh).

### 2.3 Search Matrix & Query Generation

- `LEVEL_PREFIX` (junior / early-career intent, English + Hebrew):
  ```js
  '(Junior OR Student OR Intern OR Graduate OR "Entry Level" OR "0-2 years" OR "No experience" OR ג\'וניור OR סטודנט OR בוגר OR "ללא ניסיון")'
  ```
- `NICHES` (technical stacks) include Backend, Frontend, Fullstack, Mobile, Data/AI, DevOps, Cyber, QA, Embedded, Systems/IT – see **Configuration Snapshot** for the exact list.
- Final `SEARCH_QUERIES`:
  ```js
  const SEARCH_QUERIES = NICHES.map((niche) => `${LEVEL_PREFIX} AND ${niche}`);
  ```

### 2.4 Batching, Jitter, and Cool-off

- Pagination offsets: `pageOffsets = [0, 25, 50, 75]`.
- Batching:
  - `BATCH_SIZE = 5`, queries chunked into `queryBatches`.
  - Outer loop: `for (let batchIndex = 0; batchIndex < queryBatches.length; batchIndex++)`.
  - Inner loop: `for (const query of batch)`.
- **Jitter + Timing:**
  - **Query-level jitter** between distinct queries:
    - `await randomDelay(10000, 20000)` → **10–20s**.
  - **Intra-page (between pages of the same query):**
    - After each page fetch: `await randomDelay(3000, 7000)` → **3–7s**.
  - **Detail enrichment jitter (per job):**
    - After each `fetchJobDetails`: `await randomDelay(3000, 6000)` → **3–6s**.
  - **Batch cool-off:**
    - After each batch if quota not reached:
      - `await randomDelay(120000, 180000)` → **2–3 minutes**.

### 2.5 Network Layer (Voyager API, Forced Encoding, 302 Kill Switch)

- `linkedin_client.js`:
  - Global **Axios client**:
    ```js
    const axiosClient = axios.create({ maxRedirects: 0 });
    ```
  - **302/303 Interceptor Fail-Safe:**
    - If any response (or error) has status `302` or `303`:
      - Log: `CRITICAL: LinkedIn Auth Challenge Detected (302). Stopping immediately.`
      - Call **`sendCriticalAlert({...})`** via `mailer.js`.
      - Immediately `process.exit(1)` – no further network activity.
  - **Header Consistency:**
    - `getHeaders()` normalizes `LINKEDIN_JSESSIONID` and `LINKEDIN_CSRF_TOKEN` and enforces equality.
    - Shared **`DEFAULT_USER_AGENT`** used for every request.
  - **Forced Encoding in `fetchJobs`**:
    - Keywords:
      ```js
      const encodedKeywords = encodeURIComponent(keywordString)
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/\+/g, '%20');
      ```
    - Query block:
      ```js
      const queryValue =
        `(origin:JOB_SEARCH_PAGE_JOB_FILTER,` +
        `keywords:${encodedKeywords},` +
        `locationUnion:(geoId:101620260),` +
        `selectedFilters:(sortBy:List(DD),experience:List(1,2),timePostedRange:List(r604800)),` +
        `spellCorrectionEnabled:true)`;
      ```
    - URL manually built (no `params`), preserving Voyager’s exact structure.
  - **Debug Artifacts:**
    - Search response: `debug_artifacts/debug_linkedin_response.json`.
    - Per-job GraphQL: `debug_artifacts/debug_job_details_<jobId>.json`.

### 2.6 Local Processing (Dedup, Filtering, Quota)

- **Deduplication:**
  - `seen_jobs.json` in `data/` is loaded at start and updated at the end.
  - Every newly seen `jobId` is added before filtering so it will not be re-processed in future runs.
- **Filtering via `passesFilters`:**
  - Blacklist (senior/lead/management terms) – if matched in title → drop.
  - Whitelist (technical role keywords) – if **no** match in title → drop as non-tech.
  - Filter outcomes are also logged to `filtered_jobs_debug_*.json`.
- **Quota Logic:**
  - `DAILY_NEW_JOBS_LIMIT = 500`.
  - After each kept job:
    - Increment `runStats.newJobsAdded` and per-query `queryLog[query].new`.
    - If `allNewJobs.length >= DAILY_NEW_JOBS_LIMIT`:
      - Log stop message.
      - Set `runStats.filteredOut.quotaHit = true` and break out of all loops.

### 2.7 Observability & Analytics

- **Per-run statistics (`runStats`)**:
  - Fields include `totalQueries`, `rawJobsFetched`, `candidatesEnriched`, `newJobsAdded`, `repostsDetected`, `filteredOut`, `errors`, and:
  - **`queryLog`:** map of query → `{ raw, new }` for that run, tracking raw hits and retained jobs per query.
- **Log files (one per run, timestamped):**
  - `logs/run_summary_<ISO>.json`
  - `logs/filtered_jobs_debug_<ISO>.json`
- **Analytics Engine (`analyze_logs.js`):**
  - Scans `run_summary_*.json` in `logs/`.
  - Aggregates:
    - Success rate, average duration, quota hits.
    - Total queries, blacklist/whitelist/seen counts, reposts, errors.
    - Per-query performance from `queryLog`.
  - Identifies:
    - **Dead Queries:** queries with `rawTotal === 0` across runs.
    - **Top Performers:** queries with highest average `new` jobs per run.
  - Supports incremental analysis with a **stateful `date` mode** (see §5).

## 3. Core Technical Achievements

### 3.1 Safety Engine (Redirect & Auth Hardening)

- **No-Redirect Policy:**
  - `axiosClient` uses `maxRedirects: 0`.
  - Prevents silent redirects to login or challenge pages, which would otherwise look bot-like and risk loops.
- **302/303 Kill Switch:**
  - Response and error interceptors:
    - If `status === 302` or `status === 303`:
      - Log a critical message.
      - Invoke `sendCriticalAlert({ status, url, timestamp, source })`.
      - `process.exit(1)` to terminate the bot immediately.
  - Ensures any auth challenge or CAPTCHA wall stops the entire process and notifies the operator.

### 3.2 Clean Architecture & Filesystem Layout

- **Operational DB vs Ephemeral Artifacts:**
  - **Operational**:
    - `data/seen_jobs.json` – persistent dedup memory across runs.
  - **Ephemeral**:
    - `debug_artifacts/` – raw LinkedIn responses for reverse-engineering and debugging.
    - `output/` – transient reports (`enriched_jobs_*.json`) that can be rotated.
    - `logs/` – time-series metrics and filter traces.
  - `reset_data.js` cleans each area explicitly, respecting directories.

### 3.3 Smart Analytics & Incremental Calibration

- **Per-query analytics via `queryLog`:**
  - Each `run_summary` captures how many raw and kept jobs each query produced.
  - `analyze_logs.js` aggregates `rawTotal`, `newTotal`, `runsWithData`, and `zeroRawRuns` for each query string across runs.
- **Dead Query Detection:**
  - A query is considered “dead” in the current scope if:
    - `runsWithData > 0` and `rawTotal === 0`.
  - The analyzer lists these under:
    - `5. **Matrix Calibration (Dead Queries)**` with failure counts.
- **Top Performer Identification:**
  - Queries with `newTotal > 0` are ranked by:
    - `avgNewPerRun = newTotal / runsWithData`.
  - Reported under:
    - `6. **Top Performers**` with average jobs/run and run count.
- **Incremental “Resume Mode” (`date`):**
  - `analyze_logs.js date`:
    - Reads `logs/analysis_state.json` to find `lastLogTimestamp`.
    - Only analyzes `run_summary_*.json` files with timestamps newer than that.
    - After analysis, updates `analysis_state.json` with the newest timestamp processed.
  - Enables lightweight, repeated calibration focusing only on fresh data.

## 4. Configuration Snapshot (From Code)

### 4.1 Limits & Jitter Ranges

- **Daily new jobs limit:**
  - `DAILY_NEW_JOBS_LIMIT = 500`.

- **Jitter (from `scraper.js`):**
  - **Query-level jitter:** `randomDelay(10000, 20000)` → **10–20 seconds**.
  - **Intra-page jitter (between `fetchJobs` pages):** `randomDelay(3000, 7000)` → **3–7 seconds**.
  - **Enrichment jitter (between `fetchJobDetails`):** `randomDelay(3000, 6000)` → **3–6 seconds**.
  - **Batch cool-off:** `randomDelay(120000, 180000)` → **2–3 minutes**.

### 4.2 Blacklist & Whitelist Keywords (Top 5)

- **Blacklist (top 5):**
  ```js
  [
    'Senior',
    'Lead',
    'Principal',
    'Manager',
    'Head of',
    // ... plus Director, VP, Chief, Architect, 5+ years, 6+ years, 7+ years, 8+ years
  ]
  ```

- **Whitelist (top 5):**
  ```js
  [
    'Software',
    'Developer',
    'Engineer',
    'Data',
    'Analyst',
    // ... plus Scientist, QA, Quality, Cyber, Security, DevOps, Cloud, Fullstack, Frontend, Backend, Mobile, Embedded, Student, Intern, Junior, Researcher, Automation
  ]
  ```

### 4.3 Current Niche Definitions (Matrix Seeds)

From `NICHES` in `scraper.js`:

- **Backend:**
  - `(Backend OR "Backend Developer" OR "Server Side") AND (Node.js OR Python OR Java OR Go OR "C#")`
  - `(Backend OR "Backend Developer") AND (Python OR Django OR Flask OR FastAPI)`
  - `(Backend OR "Backend Developer") AND (Java OR Spring)`
  - `(Backend OR "Backend Developer") AND ("Node.js" OR Express)`
- **Frontend:**
  - `(Frontend OR "Front End" OR "UI Developer") AND (React OR Angular OR Vue OR Typescript OR Javascript)`
- **Fullstack:**
  - `(Fullstack OR "Full Stack" OR "Web Developer")`
- **Mobile:**
  - `(Mobile OR "Mobile Developer") AND (iOS OR Android OR Swift OR Kotlin OR "React Native" OR Flutter)`
  - `(iOS Developer OR "iOS Engineer" OR Swift)`
  - `(Android Developer OR "Android Engineer" OR Kotlin)`
- **Data / AI:**
  - `("Data Scientist" OR "ML Engineer" OR "Machine Learning Engineer") AND (Python OR SQL OR PyTorch OR TensorFlow)`
  - `("Data Analyst" OR "Business Analyst" OR BI) AND (SQL OR Excel OR Tableau OR PowerBI)`
- **DevOps / Platform / Cloud:**
  - `(DevOps OR "Platform Engineer" OR "SRE") AND (CI/CD OR Jenkins OR Docker OR Kubernetes OR AWS OR GCP OR Azure)`
- **Cyber / Security:**
  - `(Cyber OR "Security Researcher" OR Security OR InfoSec OR SOC)`
- **QA / Automation:**
  - `(QA OR "Quality Assurance" OR "Test Engineer" OR Automation OR Testing OR Selenium OR Cypress)`
- **Embedded / Low-level:**
  - `(Embedded OR Firmware OR "C++" OR RTOS OR Kernel OR ARM)`
- **Systems / IT:**
  - `("System Administrator" OR "Systems Administrator" OR IT OR "IT Support" OR "Helpdesk") AND (Linux OR Windows OR Active Directory)`

## 5. Observability & Maintenance Guide

### 5.1 Running the Bot

- **Production run:**
  ```bash
  node scraper.js
  ```

- **Dry run (no email sent, full pipeline & logging):**
  ```bash
  npx cross-env DRY_RUN=true node scraper.js
  ```
  or set `DRY_RUN=true` in the environment before invoking `node scraper.js`.

### 5.2 Calibration via Analytics

- **Full history:**
  ```bash
  node analyze_logs.js --all
  ```

- **Incremental (since last analysis):**
  ```bash
  node analyze_logs.js date
  ```
  - Uses `logs/analysis_state.json` to only process new `run_summary_*.json` files.

- **Time-bounded analysis:**
  ```bash
  node analyze_logs.js --since 2025-12-25
  ```

### 5.3 Cleanup & Reset

- **Reset command:**
  ```bash
  node reset_data.js
  ```

- **What it deletes:**
  - `data/seen_jobs.json` – clears dedup memory.
  - `debug_artifacts/debug_linkedin_response.json`.
  - All `output/enriched_jobs_*.json`.
  - All `debug_artifacts/debug_job_details_*.json` (names starting with `debug_job_detai`).
  - Legacy log filenames in `logs/`:
    - `logs/run_summary.json`
    - `logs/filtered_jobs_debug.json`

No code or configuration files are deleted; only data, logs, and debug artifacts are reset.

## 6. Next Strategic Steps (Backlog)

- **Immediate Action – Query Matrix Cleanup:**
  - **Remove or down-weight “Legacy Systems” / Mainframe-style queries** (e.g., `(Junior) AND ("Legacy Systems")`, `(Junior) AND (Cobol)`), which analytics has identified as dead or very low-yield.

- **Monitoring – Filter Calibration:**
  - Periodically review:
    - `logs/filtered_jobs_debug_*.json` to ensure:
      - Blacklist rejections match clear senior/lead patterns.
      - Whitelist rejections are not discarding genuine junior technical roles.
  - Adjust `BLACKLIST_KEYWORDS` and `WHITELIST_KEYWORDS` if dead queries or over-aggressive filtering patterns emerge.

- **Future – UI / Dashboard:**
  - Build a lightweight UI/Dashboard to visualize:
    - `output/enriched_jobs_*.json` (jobs table, filters, search).
    - Aggregated metrics from `run_summary_*.json` (success rate, query yield, filter stats).
    - Dead query warnings and top performer lists from `analyze_logs.js`.
  - This can sit on top of the `/output` and `/logs` directories, leaving the existing CLI tools as the “engine” behind the scenes.

---

**Phase 3 is now closed.** The system is safe, stealthy, observable, and ready for iterative calibration and eventual UI integration.


