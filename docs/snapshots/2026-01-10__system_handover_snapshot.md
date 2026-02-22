## 1. Executive Summary & Phase Status

- **Current Phase:** **Phase 5.0 – ATS Integration (ATS Guard Production-Ready)**
- **High-Level Status:** The ATS module has graduated from “infrastructure complete / data tuning pending” to **“production-ready filtering”**:
  - The **ATS Hub & Spoke architecture** (`ats/orchestrator.js` + workers) is stable and confined to the `PATHS.ATS` tree defined in `config/paths.js`.
  - A new **ATS Guard** layer (`ats/filters/ats_guard.js` + `config/vocabulary.js`) now performs aggressive, data-driven filtering of **senior / non-technical / out-of-scope roles** at the ATS source, before they reach the unified job model.
  - Recent calibration runs (Gong, Riskified, Melio) show **no detected leaks** of senior roles into the junior pipeline; every surviving role was later dropped by downstream location gates, leaving zero final keeps for this test set (by design).

**Headline:** The ATS module now features a robust, evidence-driven filtering pipeline (“ATS Guard”) that successfully blocks senior and irrelevant roles inside the ATS workers, with full observability via raw debug logs and run summaries.

---

## 2. System Architecture View (Hybrid Model with Push-Down Predicates)

### 2.1 High-Level Hybrid Model

- The system is a **Hybrid LinkedIn + ATS job aggregation engine**:
  - **LinkedIn Legacy Module:**
    - Entry point: `scraper.js`
    - Uses LinkedIn Voyager via `linkedin_client.js`, applies shared filters from `filters_shared.js`, and writes into `PATHS.LINKEDIN.OUTPUT` and `PATHS.LINKEDIN.LOGS.*`.
  - **ATS Hub & Spoke Module:**
    - **Hub:** `ats/orchestrator.js`
      - Loads companies from `data/companies_list.json` via `ats/config/companiesConfig.js`.
      - Creates an HTTP client (`ats/utils/httpClient.js`) and routes each company to a worker based on `company.type` (`greenhouse`, `comeet`).
      - Aggregates **unified jobs** from `ats/utils/normalizeJob.js` and per-company stats into `ats_run_summary_*.json` under `PATHS.ATS.LOGS.SUMMARIES`.
    - **Spokes:**
      - `ats/workers/greenhouseWorker.js` (Greenhouse API integration).
      - `ats/workers/comeetWorker.js` (Comeet API integration).
    - **Shared ATS utilities:** `ats/utils/httpClientWrapper.js`, `ats/utils/locationGate.js`, `ats/utils/semanticGate.js`, `ats/utils/normalizeJob.js`.

### 2.2 Push-Down Predicates Inside Workers

- The ATS filter strategy has shifted from “filter at the orchestrator” to **“push predicates down into workers”**:
  - The **Orchestrator** no longer performs semantic title filtering; instead, it:
    - Delegates **ATS Guard** decisions to the workers.
    - Applies only **location** (`passesLocationGate`) and **legacy semantic** (`passesSemanticGate`) checks to jobs that have already passed ATS Guard.
  - Each **Worker** now implements the full predicate pipeline:
    1. **API Fetch:**  
       - Greenhouse: `GreenhouseWorker.fetchAllJobs` calls the Greenhouse Boards API (`/jobs?content=true`).  
       - Comeet: `ComeetWorker.fetchAllJobs` calls `https://www.comeet.com/jobs-api/2.0/company/{uid}/positions`.
    2. **Enrichment & Guard Evaluation:**  
       - For every raw job, the worker:
         - Derives title + location (defensive extraction helpers).
         - Calls `evaluateAtsGuard(job, { companyId, source })`.
         - Attaches `_debug_analysis` with:
           - `companyId`, `title`, `location`
           - `atsGuardVerdict: 'PASS' | 'FAIL'`
           - `atsGuardReason: string | null`
           - `verdict`: short human-readable summary, e.g. `"ATS_GUARD: FAIL: title_senior (...) | ..."` or `"PASS"`.
         - Updates per-company guard stats in a **single pass** (fetched / passed / dropped by title / department / description).
    3. **Raw Logging (Pre-Filter):**  
       - Workers call `maybeWriteRawDebugFile(rawJobs, company)` which writes `raw_jobs_debug_{companyId}_{timestamp}.json` under `PATHS.ATS.LOGS.RAW`.  
       - These raw files contain **all jobs (PASS + FAIL)** with full `_debug_analysis`, giving complete observability into ATS Guard decisions.
    4. **Filtering:**  
       - Unless `ATS_GUARD_DRY_RUN === 'true'`, workers construct a filtered list:
         - `filteredJobs = rawJobs.filter(job => job._debug_analysis.atsGuardVerdict === 'PASS')`.
       - Workers return `{ jobs: filteredJobs, stats }` back to the orchestrator.
    5. **Normalization (Hub-level):**  
       - Orchestrator iterates **only over jobs that passed ATS Guard**:
         - Runs `normalizeJob(rawJob, company)` to convert ATS-specific shapes into the unified model.
         - Applies `passesLocationGate(unified.location)` and `passesSemanticGate(unified.title)` as a final safety net.
         - Appends accepted jobs into `allUnifiedJobs`.

### 2.3 Data vs. Logic Separation

- **`config/vocabulary.js` – Rules Definition (Data):**
  - Holds **static configuration**:
    - `departmentsBlacklist`: e.g., `"Sales"`, `"New Business"`, `"Corporate Strategy"`, `"Customer Org"`, `"Human Resources"`, `"Finance"`, `"Product Management"`.
    - `allowedTechnicalDepartments`: e.g., `"Engineering"`, `"Development"`, `"Business Technologies"`, `"Research"`.
    - `technicalTitleKeywords`: e.g., `"engineer"`, `"developer"`, `"devops"`, `"full stack"`, `"data scientist"`, `"salesforce"` (added to avoid over-filtering Salesforce roles).
    - `titleSeniorPatterns`: regexes marking senior/leadership/commercial titles (`Senior`, `Head of`, `Manager`, `Director`, `Account Executive`, `Business Development`, etc.).
    - `contentSeniorityPatterns`: regex patterns for seniority phrases inside job descriptions (3+ / 4+ / 5+ years, plus explicit phrases observed in logs).
    - Optional `companyOverrides` (currently not used but ready for per-company tuning).
- **`ats/filters/ats_guard.js` – Logic Engine:**
  - Encapsulates the **filtering strategy**:
    - Extracts normalized fields: `title`, `location`, `departments`, `description`.
    - Normalizes HTML into plain text for reliable regex matching.
    - Applies the **Cheap-to-Expensive** pipeline:
      1. Title-based checks (cheap).
      2. Department blacklist checks (medium).
      3. Description-based seniority regex (expensive).
  - Returns a structured result:  
    - `{ verdict: 'PASS' | 'FAIL', reason: string | null, details: { companyId, source, title, location, departments } }`.

---

## 3. Core Achievements (This Phase 5 Session)

### 3.1 ATS Guard Implementation – Cheap-to-Expensive Pipeline

- **Title Check (Cheap):**
  - Uses `technicalTitleKeywords` to quickly reject non-technical titles:
    - Example drops: `"Account Executive"`, `"Business Development Manager"`, `"Corporate Development Manager"`.
  - Applies `titleSeniorPatterns` to kill obviously senior roles regardless of “engineer” presence:
    - `"Senior Data Analyst"`, `"Head of DevOps"`, `"Engineering Manager"`, `"Account Director"`, etc.
  - Produces reasons like:  
    - `"FAIL: title_not_technical (Account Executive - Private Equity)"`  
    - `"FAIL: title_senior (Data Science Team lead)"`.

- **Department Check (Medium):**
  - Looks at `departments[].name` and blocks jobs in blacklisted departments:
    - Example: `"Customer Org"` at Riskified → `"FAIL: department (Customer Org)"` for `Customer Success Engineer`.
  - This layer is intentionally conservative: only a small set of clearly non-technical / GTM / G&A orgs are blocked globally.

- **Description Check (Expensive – Regex):**
  - After normalization (see below), uses `contentSeniorityPatterns` to catch hidden seniors:
    - Generic patterns:
      - `\b[3-9]\s*\+?\s*(?:years|yrs)\b`
      - `([3-9]|1[0-9])\s*\+?\s*(?:years|yrs)\s+of\s+experience`
      - `([3-9]|1[0-9])\s*-\s*[0-9]+\+?\s*(?:years|yrs)\s+of\s+experience`
      - `\+\s*[3-9]\s*(?:years|yrs)\b`
    - Concrete phrases from real logs:
      - `"4+ years of experience in a data-centric industry role"` (Riskified – Data Integration Engineer).
      - `"5+ years of experience in DevOps"` (Riskified – DevOps Engineer).
      - `"3+ years of proven experience designing and implementing machine learning algorithms"` (Riskified – Data Scientist).
      - `"4-5+ years of professional experience as a software engineer"` (Melio – Full Stack Engineer).
  - This stage is the **primary defense against “hidden seniors”** where the title alone is ambiguous.

### 3.2 HTML Normalization Fix – Closing Critical Leaks

- Earlier, descriptions were analyzed as raw HTML with entities like `&lt;li&gt;5+ years`, causing regexes to miss `\b5+ years\b`.
- `normalizeContent` in `ats_guard.js` now:
  - Decodes **named entities**: `&lt;`, `&gt;`, `&amp;`, `&nbsp;`, `&quot;`, `&#39;`.
  - Decodes **numeric entities** (decimal and hex): `&#10;`, `&#xA;`, etc.
  - Strips **all HTML tags**, converting `<li>4+ years of experience</li>` to plain `"4+ years of experience"`.
  - Collapses whitespace to make word boundaries stable.
- Result: Phrases like `"4+ years of experience"`, `"5-7 years of experience"`, and `"3+ years"` appearing inside `<li>` or after line breaks are reliably matched by `contentSeniorityPatterns`.

### 3.3 Regex Tuning – Capturing Real-World Variants

- Based on real leaks observed in `logs/ats/raw/raw_jobs_debug_*.json`, the patterns were tuned to handle:
  - `4+ years of experience`, `5+ years of experience`, `3+ years of proven experience`.
  - Ranges like `4-5+ years of professional experience`.
  - Occurrences immediately after `<li>` or encoded entities.
- Calibration examples (now correctly **FAIL** by description_seniority):
  - **Riskified – Data Integration Engineer**: `"4+ years of experience in a data-centric industry role"`.
  - **Riskified – Data Scientist**: `"3+ years of proven experience designing and implementing machine learning algorithms"`.
  - **Riskified – DevOps Engineer**: `"5+ years of experience in DevOps, Site Reliability, Platform or Software Engineering roles."`
  - **Melio – Full Stack Engineer (NYC)**: `"4-5+ years of professional experience as a software engineer..."`.

### 3.4 Observability – Raw Debug Logs & Run Summaries

- **Raw Logs (`logs/ats/raw/raw_jobs_debug_{companyId}_{timestamp}.json`):**
  - Written by workers **before filtering**, so they include:
    - All jobs fetched from ATS (PASS + FAIL).
    - Full `_debug_analysis` with ATS Guard verdicts and reasons.
  - Used for forensic analysis:
    - Counts of PASS vs FAIL by reason.
    - Qualitative examples of good/bad drops.

- **Run Summary (`logs/ats/summaries/ats_run_summary_*.json`):**
  - Written by orchestrator with per-company stats:
    - `fetched`, `guardPassed`, `guardDropped`, `guardDroppedByTitle`, `guardDroppedByDepartment`, `guardDroppedByDescription`.
    - `kept`, `droppedLocation`, `droppedSemantic`, `errors`.
  - Also prints a **console summary** like:  
    - `ATS Guard summary: fetched=149, passed=6, dropped=143 (title=128, department=1, description=14)`.

### 3.5 Maintenance Tooling – `reset_ats_data.js`

- **New script:** `tools/reset_ats_data.js`
  - Uses `PATHS` to safely clean **only** ATS artifacts:
    - Deletes `output/ats/ats_enriched_jobs_*.json`.
    - Deletes `logs/ats/summaries/ats_run_summary_*.json`.
    - Deletes `logs/ats/filtered/ats_filtered_jobs_debug_*.json`.
    - Deletes `logs/ats/raw/raw_jobs_debug_*.json`.
  - Preserves directories; handles missing files gracefully.
  - Writes a JSON report under `logs/ats/cleanup/cleanup_report_{timestamp}.json`:
    - `timestamp`, `deleted_files_count`, `deleted_files` (relative paths).
  - Logs a concise console summary:
    - `"reset_ats_data: Deleted 15 files. Report saved to logs/ats/cleanup/cleanup_report_....json"`.

---

## 4. Contextual Delta – What Changed Since the Previous Snapshot?

### 4.1 Previous State (2026-01-09 Snapshot)

- **Infra:**  
  - Hub & Spoke ATS infrastructure in place; filesystem isolation via `config/paths.js` was solid.
  - Workers fetched ATS jobs and normalized them, but only **coarse** filters were active:
    - Location gating (`locationGate`).
    - Semantic title gating using shared LinkedIn heuristics (`semanticGate` via `filters_shared.js`).
- **Gaps Identified:**
  - Senior and staff roles were **leaking** into the junior feed, especially when titles were generic (“Software Engineer”, “Data Scientist”) but descriptions required 4–7+ years of experience or lead responsibilities.
  - No centralized vocabulary for ATS-specific departments, titles, and seniority phrases.
  - Observability was limited to final outputs and a basic filtered-debug log; there was no per-job explanation of *why* a job passed or failed at the ATS level.

### 4.2 Current State (2026-01-10 Snapshot)

- **Guarded Data Path:**
  - Every ATS job now passes through **ATS Guard** in the workers before reaching `normalizeJob`.
  - **Zero-leakage observed** in the latest calibration:
    - All clearly senior / multi-year-experience roles from Gong, Riskified, Melio were dropped by title or description.
    - A handful of borderline roles (“Sales Engineer”) passed ATS Guard but were later dropped by location, and there were **no PASS jobs** with hidden seniority patterns.
- **Refined Configuration:**
  - `config/vocabulary.js` now functions as a **single source of truth** for:
    - Department blacklists.
    - Seniority title patterns.
    - Description seniority patterns.
    - Technical title keywords (including **“Salesforce”** to avoid over-filtering Salesforce Analysts/Engineers).
- **Logic Improvements:**
  - HTML decoding and tag stripping means **seniority regexes actually see clean text**, closing the main leak vector from earlier runs.
  - Refined regexes treat **3+ years** as non-junior for ATS roles, consistent with observed market practice for senior positions.

---

## 5. Configuration Snapshot (Phase 5)

### 5.1 Key Files

- **`config/paths.js`** – Central filesystem layout:
  - `PATHS.ROOT` – repo root.
  - `PATHS.LINKEDIN.*` – LinkedIn-only outputs/logs (untouched by ATS tools).
  - `PATHS.ATS.OUTPUT` – `output/ats/`.
  - `PATHS.ATS.LOGS.ROOT` – `logs/ats/`.
  - `PATHS.ATS.LOGS.SUMMARIES` – `logs/ats/summaries/`.
  - `PATHS.ATS.LOGS.FILTERED` – `logs/ats/filtered/`.
  - `PATHS.ATS.LOGS.RAW` – `logs/ats/raw/`.
  - `PATHS.ATS.LOGS.ARCHIVE` – `logs/ats/archive/` (future use).

- **`config/vocabulary.js`** – Centralized ATS Guard rules:
  - Department blacklist and technical department allowlist.
  - Technical title keywords (now including `"salesforce"`).
  - Senior title patterns.
  - Description seniority regex patterns.

- **`ats/filters/ats_guard.js`** – Guard implementation.
- **`ats/orchestrator.js`** – Hub orchestrating companies, workers, and persistence.
- **`ats/workers/greenhouseWorker.js` / `ats/workers/comeetWorker.js`** – Vendor-specific ATS data sources, now embedding ATS Guard.
- **`tools/reset_ats_data.js`** – Scoped ATS data reset tool.

### 5.2 Current Operational Flags

- **DEBUG_RAW:** typically **`true`** during calibration:
  - Enables writing `raw_jobs_debug_{companyId}_{timestamp}.json` from workers.
  - Recommended to keep **on** through the first production cycles to maintain forensic visibility.

- **DRY_RUN:** currently **`true`** for calibration:
  - Orchestrator **skips writing** final `ats_enriched_jobs_*.json` when `DRY_RUN === 'true'`.
  - Still writes run summaries and filtered-debug logs.
  - **Production toggle:** set `DRY_RUN=false` to enable full output writes.

- **ATS_GUARD_DRY_RUN:** currently **`false`**:
  - When `false`: workers **actively filter** raw jobs based on ATS Guard verdicts.
  - When `true`: workers still compute guard stats and `_debug_analysis`, but **do not filter**, passing all jobs to the orchestrator for experimentation.
  - For production, `ATS_GUARD_DRY_RUN=false` is the intended default.

---

## 6. Observability & Maintenance Playbook

### 6.1 Monitoring Guard Effectiveness

- **High-Level Stats:**
  - Inspect `logs/ats/summaries/ats_run_summary_*.json`:
    - Per-company `fetched`, `guardPassed`, `guardDropped`, `guardDroppedByTitle`, `guardDroppedByDepartment`, `guardDroppedByDescription`.
    - Overall `status` (SUCCESS / PARTIAL_FAIL / ERROR).
  - Review console output for each run:
    - Global summary like:  
      - `ATS Guard summary: fetched=149, passed=6, dropped=143 (title=128, department=1, description=14)`.

- **Per-Job Decisions:**
  - Inspect `logs/ats/raw/raw_jobs_debug_{companyId}_{timestamp}.json`:
    - For each job:
      - `_debug_analysis.atsGuardVerdict` – PASS/FAIL.
      - `_debug_analysis.atsGuardReason` – concatenated reasons (title/department/description).
      - `_debug_analysis.verdict` – user-friendly summary string.
  - This is the primary source for:
    - Finding new senior patterns to add to `contentSeniorityPatterns`.
    - Verifying that department and title blacklists are behaving as intended.

- **Filtered Job Debug:**
  - `logs/ats/filtered/ats_filtered_jobs_debug_*.json`:
    - Written by orchestrator for **post-guard** drops (location and legacy semantic filters).
    - Shows where the second line of defense is trimming down ATS Guard survivors.

### 6.2 Maintenance & Reset

- **Safe ATS Reset:**
  - Command:
    - `node tools/reset_ats_data.js`
  - Behavior:
    - Deletes ATS-only artifacts:
      - `output/ats/ats_enriched_jobs_*.json`
      - `logs/ats/summaries/ats_run_summary_*.json`
      - `logs/ats/filtered/ats_filtered_jobs_debug_*.json`
      - `logs/ats/raw/raw_jobs_debug_*.json`
    - Leaves LinkedIn outputs/logs untouched.
    - Writes a report:
      - `logs/ats/cleanup/cleanup_report_{timestamp}.json` with counts and file list.

### 6.3 Calibration Workflow

- **When new companies or roles are added:**
  1. Enable `DEBUG_RAW=true`, `DRY_RUN=true`, `ATS_GUARD_DRY_RUN=false`.
  2. Run ATS orchestrator (`npm run ats`).
  3. Inspect:
     - `ats_run_summary_*.json` for guard stats.
     - `raw_jobs_debug_*.json` for edge-case roles.
  4. If leaks (hidden seniors) are detected:
     - Extend `contentSeniorityPatterns` in `config/vocabulary.js`.
     - Optionally refine `titleSeniorPatterns` or department lists.
  5. Repeat until **no suspicious survivors** remain.

---

## 7. Next Strategic Steps (Roadmap)

### 7.1 Immediate – Go-Live Preparation

- **Disable DRY_RUN for ATS:**  
  - Set `DRY_RUN=false` in the environment and run `npm run ats` to begin writing `ats_enriched_jobs_*.json` in `output/ats/`.
- **Keep DEBUG_RAW Enabled Initially:**  
  - Maintain `DEBUG_RAW=true` for the first few production cycles to ensure you can quickly investigate anomalies.

### 7.2 Short Term – Scale Company Coverage

- **Expand `data/companies_list.json`:**
  - Add more Greenhouse and Comeet companies now that:
    - ATS Guard is robust against senior roles and non-technical departments.
    - The hybrid architecture cleanly isolates ATS data and logs.
  - For each new company:
    - Run at least one **calibration run** with `DEBUG_RAW=true` before trusting results.

### 7.3 Mid Term – Unified Analytics & Dashboarding

- **Cross-Source Analytics:**
  - Build a simple **unified analyzer** to join:
    - LinkedIn summaries (`logs/linkedin/summaries/`).
    - ATS summaries (`logs/ats/summaries/`).
  - Provide views such as:
    - Overall job volume by source and company.
    - Guard effectiveness by company (drop rates, seniority patterns).
    - Conversion funnel from raw → filtered → enriched → matched candidates.

- **Dashboard / Visualization:**
  - Eventually expose these metrics via a small dashboard or CLI-based report:
    - Highlight potential leaks or over-filtering in near real-time.
    - Monitor department-based drop patterns to refine the blacklist over time.

### 7.4 Longer Term – Policy & ML-Assisted Guard

- Consider layering:
  - **Policy-based overrides** (`companyOverrides` in `config/vocabulary.js`) to tune rules for specific companies or verticals.
  - **ML/heuristic scoring** on top of ATS Guard to further rank roles by “junior fit” rather than simple pass/fail.

---

**Summary:** Phase 5.0 successfully transforms the ATS module from a basic ingestion layer into a **policy-driven, observable, and maintainable filter engine**. The combination of `config/vocabulary.js`, `ats/filters/ats_guard.js`, worker-integrated guard evaluation, and the new reset tooling positions the system well for safe ATS production runs and future scaling to additional companies and markets.


