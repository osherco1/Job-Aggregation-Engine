### 🏗️ High-Level Architecture (The "Mental Model")

The LinkedIn Job Bot is a multi-stage data pipeline that takes raw LinkedIn Voyager search results and turns them into a curated stream of junior-friendly job leads. The end-to-end flow is:

- **Search (Voyager)** → `fetchJobs` in `linkedin_client.js` issues boolean job searches against the `voyagerJobsDashJobCards` endpoint using a browser-derived “golden” URL and a standardized header/cookie set (`getHeaders`). Results are returned in LinkedIn’s normalized JSON format with a top-level `data.elements` array and a separate `included` array that holds the actual job card payloads.
- **Reference Map Parsing** → `normalizeResponse` in `linkedin_client.js` resolves the indirection between lightweight `elements[].jobCardUnion.*jobPostingCard` references and the rich objects in `included`. It builds a **map of `entityUrn → included item`**, then:
  - Extracts the primary job URN from `jobCardUnion['*jobPostingCard']` or `jobPostingCard.entityUrn`.
  - Looks up that URN in the map; if not found, it uses `extractJobId` to pull the numeric jobId from the URN and performs a **soft match** against any `entityUrn` containing that ID.
  - Once a matching included object is found, it normalizes it into a flat job object `{ jobId, title, company, location, postedAt, url }`.
  - If no job data is resolvable for a given element, it logs a warning and drops that element instead of guessing.
- **Binary Filtering** → In `scraper.js`, each enriched job flows through `passesFilters(job, runStats, filteredJobsLog)`:
  - Titles are lowercased and checked against a **broad blacklist** (`BLACKLIST_KEYWORDS`) that now combines seniority markers (e.g. “Senior”, “Lead”, “Manager”, “Director”) with entire non-technical role classes (Sales/Marketing, Finance/Accounting, Operations/HR, various Hebrew terms, etc.).
  - If any blacklist token appears, the job is hard-dropped, `runStats.filteredOut.blacklist` is incremented, and a `{ title, company, reason: 'Blacklist' }` entry is appended to `filteredJobsLog`.
  - If the title survives the blacklist, it is then checked against the **technical whitelist** (`WHITELIST_KEYWORDS`, e.g. “Software”, “Developer”, “Engineer”, “QA”, “Cyber”, “DevOps”, “Backend”, “Frontend”, “Junior”, “Student”, “Intern”, etc.). Jobs with titles that contain none of these markers are dropped as non-technical (`reason: 'Whitelist'`).
  - Only jobs that are **not blacklisted and do contain at least one whitelist marker** flow forward.
- **Deduplication & Seen-Job Memory** → Before enrichment, each Voyager job card is checked against `seen_jobs.json`:
  - `loadSeenJobIds()` loads an on-disk set of previously seen job IDs from `data/seen_jobs.json`.
  - Every new Voyager `jobId` is added to `seenIds` immediately, even if the job is later dropped by filters, so reposts and re-runs do not reprocess the same posting.
  - Jobs that are already in `seenIds` are counted under `runStats.filteredOut.alreadySeen` and logged into `filteredJobsLog` with `reason: 'AlreadySeen'`.
- **Enrichment (GraphQL)** → For every new, unseen job:
  - `scraper.js` calls `fetchJobDetails(job.jobId)` from `linkedin_client.js`, which in turn uses the reverse-engineered GraphQL endpoint `jobsDashJobPostingsById` (`JOB_POSTING_GRAPHQL_QUERY_ID`) to fetch a full job posting shape.
  - The enrichment layer extracts a normalized description, external apply URL (`companyApplyUrl` exposed as `directApplyUrl`), employment type, approximate applies count, repost status, and auxiliary recruiter fields.
  - The raw GraphQL payload is saved under `debug_artifacts/debug_job_details_<jobId>.json` for schema debugging and incident analysis.
  - The enriched object is merged back onto the Voyager card and flagged with `isRepost`, `simpleApplication`, `applyMethodEasyApply`, etc., and only then passed through the binary filter.
- **Final Deduped Output & Reporting** → All enriched, filter-passing jobs are:
  - Collected into `allNewJobs` (bounded by `DAILY_NEW_JOBS_LIMIT`).
  - Persisted as a timestamped snapshot `output/enriched_jobs_<ISO>.json`.
  - Reported via `mailer.sendJobReport(allNewJobs)` unless `DRY_RUN` is enabled.
  - Summarized to console and into `logs/run_summary_<ISO>.json` (with `runStats`) and `logs/filtered_jobs_debug_<ISO>.json` (with the detailed reasons for each drop).

**Pointer/Reference Resolution via `includedMap`**  
Voyager’s `elements` array only contains **lightweight references** to job cards, not the full job data. The actual cards live in the top-level `included` array. `normalizeResponse` solves this by:

- Building a **hash map**: for each item in `included`, if it has an `entityUrn`, store it under `includedMap[entityUrn]`.
- When normalizing each `element`, pull the URN reference (`union['*jobPostingCard']` or `jobPostingCard.entityUrn`) and do a direct lookup into `includedMap`.
- If that fails (common when URN formats diverge across experiments), call `extractJobId` to get the numeric ID and search the `includedMap` keys for any key containing that ID (soft numeric match).
- Only when a concrete included object is found does the code project out title/company/location/date. If no match is found, the job is dropped with a clear warning.

This **map-first resolver** turns the pointer-heavy Voyager shape into a stable flat list, insulating the scraper from minor structural tweaks in LinkedIn’s API while making failures observable.

**No-Redirect Protocol for Auth Challenges**  
All LinkedIn HTTP traffic is routed through a single `axiosClient` in `linkedin_client.js` configured with:

- `maxRedirects: 0` so that 302/303 redirect responses are **never followed**.
- A global response interceptor that:
  - Treats any 302/303 received from LinkedIn as a **CRITICAL auth failure / challenge**.
  - Logs a high-priority message and sends a one-shot `sendCriticalAlert` email with status, URL, timestamp, and whether the status came from a response or error branch.
  - Immediately calls `process.exit(1)` to stop all scraping activity under a challenged session.

This “No-Redirect” protocol is critical because it turns redirect-based login or captcha walls into a clean fail-fast signal instead of accidentally following SSO flows that would look extremely bot-like and risk hard bans.

---

### 🛠️ Tooling & Observability Ecosystem (Bulk Analysis & Maintenance)

The project now ships with a small, focused **tooling suite** that makes it easy to understand what the bot is doing and to manage historical data.

#### Analysis Suite (`tools/analyze_logs.js`, `tools/show_acc_history.js`, `tools/show_rejected_history.js`)

- **Stateless Bulk Analyzer (`tools/analyze_logs.js`)**
  - Operates in **strict bulk mode**: there is **no state file**, no `--since` or date-argument behavior, and no “latest file only” logic.
  - Reads **all** `run_summary_*.json` files in `logs/` and aggregates:
    - Run counts, success vs. quota-reached vs. error statuses.
    - Average run duration from `startTime` → `endTime`.
    - Total quota hits, total queries executed.
    - Aggregate filter stats: blacklist drops, whitelist drops, already-seen count, reposts detected.
    - Query-level performance from `queryLog`:
      - For each query: total raw hits, total new jobs, number of runs with data, and how often it returned zero jobs.
      - Derived **dead queries** (always zero results) and **top performers** (highest average new jobs per run).
  - Outputs a **plain-text system health report**:
    - `=== SYSTEM HEALTH REPORT ===` → “Scope: All Runs”.
    - Detailed health overview, search efficiency, filtering calibration, recent errors, dead queries, and top-performing search queries.
  - Then appends two bulk job sections:
    - `=== ✅ ACCUMULATED ACCEPTED JOBS (All Active Files) ===`:
      - Scans every `output/enriched_jobs_*.json`, aggregates accepted jobs across all snapshots, and prints `N. Title @ Company` for each, with a final `(Total: N)`.
    - `=== 🚫 ACCUMULATED REJECTED JOBS (All Active Files) ===`:
      - Scans every `logs/filtered_jobs_debug_*.json`, aggregates **all** rejected jobs, and prints `N. Title @ Company -> REJECTED: Reason`, again with a final `(Total: N)`.
  - The analyzer is **idempotent and stateless**: running it multiple times simply recomputes a fresh, global view from whatever JSON artifacts currently exist on disk.

- **Accepted History Viewer (`tools/show_acc_history.js`)**
  - Specialized “accepted jobs” inspection tool.
  - Scans `output/` for **all** `enriched_jobs_*.json` files, sorts them newest-first by filename timestamp, and for each file:
    - Prints a file header `--- enriched_jobs_<timestamp>.json ---` (with optional color when `chalk` is available).
    - Prints each job as `N. Title @ Company`.
  - Ends with `Total files scanned: X, Total jobs found: Y`.
  - This is ideal when you want to inspect the raw accepted-job snapshots exactly as they were persisted after each run.

- **Rejected History Viewer (`tools/show_rejected_history.js`)**
  - Mirrors the accepted history viewer but for **filtered-out jobs**:
    - Scans `logs/` for all `filtered_jobs_debug_*.json`.
    - Sorts them by modification time, newest first.
    - For each file, prints `=== Log: filtered_jobs_debug_<timestamp>.json ===` and then each entry as  
      `Title @ Company -> REJECTED: Reason`.
  - Finishes with `Total rejected jobs found: N`.
  - This is the primary tool for calibrating keyword filters and understanding why specific leads were dropped (Blacklist vs Whitelist vs AlreadySeen).

#### Maintenance Protocol (`tools/archive_logs.js`, `tools/reset_data.js`)

- **Master Archiver (`tools/archive_logs.js`)**
  - Runs as a **daily hygiene tool** to keep the working set small while preserving full history for forensic analysis.
  - Defines:
    - `PROJECT_ROOT` as the repo root.
    - `LOGS_DIR`, `OUTPUT_DIR`, `DEBUG_DIR` pointing to `logs/`, `output/`, and `debug_artifacts/`.
    - A unified `ARCHIVE_DIR` (`archive/` under project root).
  - On each run:
    - Computes `CUTOFF_DATE_STR` from **today’s local date** (`YYYY-MM-DD`) and `CUTOFF_DATE` as today’s local midnight.
    - For each configured directory, processes only files whose names start with known prefixes:
      - `logs/`: `run_summary_`, `filtered_jobs_debug_` (skips `analysis_state.json`).
      - `output/`: `enriched_jobs_`.
      - `debug_artifacts/`: `debug_job_details_`, `debug_linkedin_response`.
    - For each file:
      - If the filename contains a parseable `YYYY-MM-DD`, uses a **lexicographic comparison** against `CUTOFF_DATE_STR` to decide whether it is “history”.
      - If no date is present, falls back to file `mtime` and archives anything modified before `CUTOFF_DATE`.
      - Files considered historical are moved into `archive/` via `fs.renameSync`; current files remain in place.
    - Prints a per-namespace summary: how many logs, outputs, and debug artifacts were archived vs. kept.

- **State Reset Tool (`tools/reset_data.js`)**
  - Designed for **hard resets** between experiments:
    - Deletes `data/seen_jobs.json` to clear the deduplication memory.
    - Deletes `debug_artifacts/debug_linkedin_response.json`.
    - Deletes all `enriched_jobs_*.json` files from `output/`.
    - Deletes all `debug_job_details_*.json` from `debug_artifacts/`.
    - Deletes legacy `logs/run_summary.json` and `logs/filtered_jobs_debug.json` (non-timestamped variants).
  - Each deletion is logged and failures are caught per-file.
  - After running this tool, the next scraper run behaves like a **first-time boot** with no remembered jobs or artifacts.

Together, the analysis and maintenance tooling provides a **360° QA and operations surface**: you can inspect every accepted and rejected job, understand system health across all runs, and prune or reset artifacts safely.

---

### ⚙️ Live Configuration Snapshot (as of 2025-12-29)

The following configuration values are hardcoded in `scraper.js`:

- **Job Intake Limits**
  - `DAILY_NEW_JOBS_LIMIT = 500`  
    - Hard cap on the number of *new* (deduped, filter-passing) jobs processed and reported per run. Once reached, the scraper stops fetching further pages/queries and marks `runStats.filteredOut.quotaHit = true`.

- **Jitter & Delay Behavior**
  - The system uses a single `randomDelay(minMs, maxMs)` helper with:
    - **Query-level jitter** between distinct boolean search queries:  
      `await randomDelay(10000, 20000)` → **10–20 seconds** between queries.
    - **Per-API-call anti-bot delay** between each Voyager search page and each `fetchJobDetails` call:  
      - `fetchJobDetails` calls: `await randomDelay(3000, 6000)` → **3–6 seconds** between detail fetches.  
      - After each search page: `await randomDelay(3000, 7000)` → **3–7 seconds** between jobSearch API calls.
    - **Batch cool-off** between chunks of queries:  
      `await randomDelay(120000, 180000)` → **2–3 minutes** between query batches.
  - These values effectively play the role of:
    - `JITTER_MIN_MS ≈ 3000`, `JITTER_MAX_MS ≈ 20000` (depending on context).
    - `PAGINATION_DELAY_MS ≈ 3000–7000` between search pages.
  - There is no explicit `MAX_RETRIES` constant; retries are implicit:
    - On job search errors, the scraper logs the error and performs a **single** randomized backoff (`3–7s`) before moving on; it does not currently loop with a fixed retry count.
    - For job details, the calling loop treats thrown errors as non-recoverable for that job and continues with the next candidate.

- **Filter Examples (Current Keyword Sets)**
  - **Blacklist examples** (titles containing any of these are dropped immediately):
    - Seniority: `"Senior"`, `"Lead"`, `"Manager"`, `"Director"`, `"Architect"`.
    - Non-technical roles: `"Sales"`, `"Marketing"`, `"Finance"`, `"Accountant"`, `"HR"`, `"Recruiter"`, `"Customer Success"`, `"Call Center"`.
    - Hebrew noise: `"שיווק"`, `"מכירות"`, `"מנהל חשבונות"`, `"משאבי אנוש"`, `"גיוס"`.
  - **Whitelist examples** (at least one must appear in the title or the job is treated as non-technical):
    - General technical: `"Software"`, `"Developer"`, `"Engineer"`.
    - Analytics & data: `"Data"`, `"Analyst"`, `"Scientist"`.
    - Roles: `"QA"`, `"Cyber"`, `"DevOps"`, `"Fullstack"`, `"Frontend"`, `"Backend"`, `"Mobile"`, `"Embedded"`.
    - Junior signals: `"Student"`, `"Intern"`, `"Junior"`, `"Researcher"`, `"Automation"`.

These constants define how aggressively the bot filters out senior and non-technical roles and how slowly it paces requests to avoid LinkedIn’s anti-bot systems.

---

### 📊 Current Operational Status (Phase 4 – Maintenance & Optimization)

- **Phase:** The project is in **Phase 4: Maintenance & Optimization**.
- **Stability:** The end-to-end flow is **operational and stable**:
  - Voyager search → reference resolution → binary filtering → enrichment → dedupe → reporting has been validated across multiple runs.
  - The system is robust to LinkedIn’s pointer-heavy response shape via the `includedMap` reference resolver and soft numeric ID matching.
- **Key Achievements:**
  - **Bulk Scanner for QA:**  
    - `tools/analyze_logs.js` now produces a **single, aggregated report** over all historical run summaries, accepted, and rejected jobs. This makes regression detection and filter tuning significantly easier.
  - **Stabilized Reference Model Parser:**  
    - `normalizeResponse` handles both `data.elements` and legacy `elements` roots, with a two-tier resolution strategy (direct URN map lookup and numeric ID soft matching). Failed resolutions are logged with explicit warnings instead of causing silent data loss.
  - **360° QA Report:**  
    - Combining system health metrics, accepted job history, and rejection reasons into one plaintext report has created a **360° QA surface** that can be piped directly into external analysis tools (e.g. LLMs, notebooks, or dashboards).
  - **Safe Archive & Reset Controls:**  
    - `archive_logs.js` and `reset_data.js` provide **clear operator levers** to rotate history, reset state, and control disk usage without disturbing the live configuration.

Overall, the bot “thinks” in terms of: *junior-intent queries → normalized job cards → binary title filter → dedup + enrichment → bounded daily intake → persistent artifacts + QA reports*.

---

### 🔮 Strategic Backlog (Next Steps)

- **UI / Dashboard**
  - Replace the current CLI-only tooling with a **web-based operations dashboard**:
    - Surface the `analyze_logs` report, accepted/rejected history, and archive status in a single UI.
    - Provide interactive filters (by query, by date range, by company, by rejection reason).
    - Add one-click actions for running the scraper, archiver, and reset tools with visible progress.

- **Multi-Source Expansion**
  - Generalize the data model (`jobId`, `title`, `company`, `location`, `source`, `rawPayload`) so the pipeline can ingest:
    - Other job boards (e.g. Indeed, Glassdoor) through equivalent “search → normalize → filter” adapters.
    - Custom feeds (internal job boards, referral lists) with lightweight normalizers.
  - The `normalizeResponse` pattern (reference map → flat objects) can be reused for any upstream that returns pointer-based structures.

- **AI-Assisted Filtering**
  - Gradually evolve from **pure keyword-based** title filtering to a **hybrid or LLM-based classifier**:
    - Use current `BLACKLIST_KEYWORDS` / `WHITELIST_KEYWORDS` as a first-pass heuristic to keep the volume manageable.
    - Introduce an “AI review” phase for borderline titles (e.g. where title includes both technical and non-technical hints, or for novel job titles).
    - Log the LLM’s reasoning alongside existing `filtered_jobs_debug` entries to continuously refine prompts and thresholds.
  - Long-term, replace hand-curated keyword lists with a trainable model that can learn from accepted vs. rejected history (semi-supervised or feedback-driven).

This snapshot reflects the **stable baseline** as of **2025-12-29**. New contributors should start by reading `scraper.js` and `linkedin_client.js`, then explore the tooling in `tools/` to understand how to observe, test, and safely evolve the system.


