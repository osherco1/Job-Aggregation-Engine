## 1. Executive Summary & Phase Status

- **Current Phase:** **Phase 5.0 – ATS Integration (Infrastructure Complete / Data Tuning Pending)**
- **High-Level Status:** The system has successfully transitioned to a **Hybrid Architecture** with strict filesystem isolation between **LinkedIn** and **ATS** flows, as defined in `config/paths.js`.  
  - The **LinkedIn scraper** (`scraper.js`) now writes exclusively into the `PATHS.LINKEDIN` tree.  
  - The **ATS Orchestrator** (`ats/orchestrator.js`) is stable, writes exclusively into the `PATHS.ATS` tree, and is successfully ingesting data from several Greenhouse companies.  
  - We have confirmed **configuration gaps** (wrong or outdated UIDs/types in `data/companies_list.json`) and **data quality issues** (Senior/Staff roles leaking into the junior feed), which require a focused tuning pass.

Overall, infra is in good shape; the remaining work is configuration correction, filter hardening, and richer observability for ATS.

---

## 2. System Architecture (The “Hybrid” Model)

### 2.1 High-Level Model

- The system is now a **Hybrid LinkedIn + ATS job aggregation engine**:
  - **LinkedIn “Legacy” Module:**  
    - Entry point: `scraper.js`  
    - Uses the LinkedIn Voyager APIs (via `linkedin_client.js`) and an email layer (`mailer.js`).  
    - Applies shared filters from `filters_shared.js` and writes enriched job artifacts plus run telemetry.
  - **ATS “Hub & Spoke” Module:**  
    - Entry point: `ats/orchestrator.js`  
    - Loads `data/companies_list.json` and acts as a **hub** that routes each company to a **spoke** worker based on `type` (e.g., `greenhouse`, `comeet`).  
    - Spoke workers (`ComeetWorker`, `GreenhouseWorker`) fetch raw jobs via the configured ATS API/client, then normalize into a **unified job model** via `normalizeJob`.
    - `locationGate` and `semanticGate` are applied to drop out-of-scope locations and roles.

Conceptually:
- **Hub:** `ats/orchestrator.js` – coordinates companies, http client, and workers; aggregates unified jobs and run stats.
- **Spokes:** `workers/comeetWorker.js`, `workers/greenhouseWorker.js` – per-vendor integrations, encapsulating vendor-specific API quirks.
- **Shared Utilities:** `utils/httpClient.js`, `utils/locationGate.js`, `utils/semanticGate.js`, `utils/normalizeJob.js`.

### 2.2 Filesystem Isolation via `config/paths.js`

`config/paths.js` introduces a single **authoritative** `PATHS` object:

- **Project Root:**
  - `PATHS.ROOT` – repo root
  - Shared helpers:  
    - `PATHS.DATA` → `data/`  
    - `PATHS.DEBUG_ARTIFACTS` → `debug_artifacts/`  
    - `PATHS.ARCHIVE_ROOT` → `archive/`

- **LinkedIn branch (`PATHS.LINKEDIN`):**
  - **Output:**
    - `PATHS.LINKEDIN.OUTPUT` → `output/linkedin/`  
      - `scraper.js` writes `enriched_jobs_*.json` here.
  - **Logs:**
    - `PATHS.LINKEDIN.LOGS.ROOT` → `logs/linkedin/`
    - `PATHS.LINKEDIN.LOGS.SUMMARIES` → `logs/linkedin/summaries/`  
      - `scraper.js` writes `run_summary_*.json` here.
    - `PATHS.LINKEDIN.LOGS.FILTERED` → `logs/linkedin/filtered/`  
      - `scraper.js` writes `filtered_jobs_debug_*.json` here.
    - `PATHS.LINKEDIN.LOGS.ARCHIVE` → `logs/linkedin/archive/`  
      - `tools/archive_logs.js` moves older LinkedIn logs/output/debug artifacts here.

- **ATS branch (`PATHS.ATS`):**
  - **Output:**
    - `PATHS.ATS.OUTPUT` → `output/ats/`  
      - `ats/orchestrator.js` writes `ats_enriched_jobs_*.json` here.
  - **Logs:**
    - `PATHS.ATS.LOGS.ROOT` → `logs/ats/`
    - `PATHS.ATS.LOGS.SUMMARIES` → `logs/ats/summaries/`  
      - `ats/orchestrator.js` writes `ats_run_summary_*.json` here.
    - `PATHS.ATS.LOGS.FILTERED` → `logs/ats/filtered/`  
      - `ats/orchestrator.js` writes `ats_filtered_jobs_debug_*.json` here.
    - `PATHS.ATS.LOGS.ARCHIVE` → `logs/ats/archive/` (reserved for future ATS archiving).

**Key point:** there is **no** generic `OUTPUT` or `LOGS` at the top level of `PATHS`; every consumer must opt into either **LinkedIn** or **ATS** explicitly.

### 2.3 Iron Rule of Scope – Legacy Tools are LinkedIn-Only

To avoid ATS/LinkedIn cross-contamination, all existing tools under `tools/` are **explicitly constrained**:

- **`tools/analyze_logs.js`**
  - Reads **only LinkedIn** run summaries from `PATHS.LINKEDIN.LOGS.SUMMARIES`.
  - Reads **only LinkedIn** filtered/debug logs from `PATHS.LINKEDIN.LOGS.FILTERED`.
  - Reads **only LinkedIn** enriched jobs from `PATHS.LINKEDIN.OUTPUT`.
  - Its health report therefore reflects **LinkedIn module health only** by design.

- **`tools/reset_data.js`**
  - Deletes:
    - `data/seen_jobs.json` (LinkedIn dedupe state) via `PATHS.DATA`.
    - LinkedIn enriched jobs under `PATHS.LINKEDIN.OUTPUT`.
    - LinkedIn debug artifacts under `PATHS.DEBUG_ARTIFACTS` with the `debug_job_detai*` and `debug_linkedin_response.json` patterns.
    - LinkedIn run summaries and filtered logs under `PATHS.LINKEDIN.LOGS.{SUMMARIES,FILTERED}`.
  - **Never touches ATS** outputs or logs, and never scans `output/` or `logs/` generically.

- **`tools/archive_logs.js`**
  - Archives only:
    - LinkedIn run summaries from `PATHS.LINKEDIN.LOGS.SUMMARIES`.
    - LinkedIn filtered logs from `PATHS.LINKEDIN.LOGS.FILTERED`.
    - LinkedIn enriched jobs from `PATHS.LINKEDIN.OUTPUT`.
    - LinkedIn debug artifacts from `PATHS.DEBUG_ARTIFACTS`.
  - All archived files land in `PATHS.LINKEDIN.LOGS.ARCHIVE`.  
  - No ATS paths are scanned or moved.

- **Viewers & Helpers:**
  - `tools/show_acc_history.js` → reads only from `PATHS.LINKEDIN.OUTPUT`.
  - `tools/show_rejected_history.js` → reads only from `PATHS.LINKEDIN.LOGS.FILTERED`.
  - `tools/restore_recent_logs.js` → restores only LinkedIn logs/output/debug artifacts from `logs/linkedin/archive/` (and legacy `archive/`) back to the **LinkedIn** trees.

**Iron Rule:** Existing tools remain **LinkedIn-only**; any future hybrid or ATS-only tools must be introduced as **new entry points** and explicitly choose `PATHS.ATS` or both via flags (e.g., `--source=linkedin|ats|all`).

---

## 3. Key Technical Achievements (This Session)

### 3.1 Infrastructure Refactor – `config/paths.js` and Directory Creation

- Introduced `config/paths.js` as the **single source of truth** for filesystem layout.
- Updated:
  - `scraper.js` to use:
    - `PATHS.DATA` for `seen_jobs.json`.
    - `PATHS.LINKEDIN.OUTPUT` for `enriched_jobs_*.json`.
    - `PATHS.LINKEDIN.LOGS.SUMMARIES` for `run_summary_*.json`.
    - `PATHS.LINKEDIN.LOGS.FILTERED` for `filtered_jobs_debug_*.json`.
  - `ats/orchestrator.js` to use:
    - `PATHS.ATS.OUTPUT` for `ats_enriched_jobs_*.json`.
    - `PATHS.ATS.LOGS.SUMMARIES` for `ats_run_summary_*.json`.
    - `PATHS.ATS.LOGS.FILTERED` for `ats_filtered_jobs_debug_*.json`.
- Both modules use `fs.mkdirSync(..., { recursive: true })` wrappers (`ensureDir` style) to guarantee directories exist before writes.

### 3.2 Safe Migration – `tools/migrate_structure.js`

- Implemented `tools/migrate_structure.js` as a **one-time, idempotent migration** to move legacy LinkedIn artifacts into the new layout:
  - Creates all relevant LinkedIn and ATS directories via `ensureDirRecursive`.
  - Moves only:
    - `output/enriched_jobs_*.json` → `output/linkedin/`.
    - `logs/run_summary_*.json` → `logs/linkedin/summaries/`.
    - `logs/filtered_jobs_debug_*.json` → `logs/linkedin/filtered/`.
  - **ATS files are explicitly left in place**, including:
    - `ats_enriched_jobs_*.json`
    - `ats_run_summary_*.json`
    - `ats_filtered_jobs_debug_*.json`
  - Logs all moves as:  
    `Moved <label> file: <source-relative-path> -> <dest-relative-path>`.

Result: Historical LinkedIn data remains intact but is now visible to the refactored LinkedIn-only tools in their new subtrees.

### 3.3 ATS Connectivity – Greenhouse Companies

- `ats/orchestrator.js` reads `data/companies_list.json` and uses the `type` field to pick the correct worker:
  - `type: "greenhouse"` → `GreenhouseWorker` (e.g., **Gong**, **Riskified**, **Melio**, **Lemonade**, **Wiz**).
  - `type: "comeet"` → `ComeetWorker` (e.g., **Fiverr**, **Monday**).
- We have **verified working connectivity and normalized output** for at least:
  - **Gong**
  - **Riskified**
  - **Melio**

These show up under `output/ats/ats_enriched_jobs_*.json` and corresponding `logs/ats/{summaries,filtered}/`.

### 3.4 Tooling – `tools/find_uid.js` (Conceptual Role)

- `tools/find_uid.js` is introduced (or planned) as a support tool to help:
  - Discover and validate **correct ATS UIDs** for each company (e.g., Greenhouse organization slug or Comeet UID).
  - Reduce the guesswork and trial/error currently visible in `data/companies_list.json` (where some entries use placeholder or incorrect UIDs).
- This tool will be central to **fixing misconfigured companies** like **Monday**, **Lemonade**, and **Wiz** by programmatically searching their ATS endpoints and surfacing the canonical UID pattern.

---

## 4. Contextual Delta (What Changed Since Last Snapshot?)

### 4.1 Previous State

- Filesystem:
  - All enriched jobs lived directly under `output/` (LinkedIn and ATS mixed).
  - All run summaries and filtered logs lived under `logs/` without source separation.
  - Tools like `analyze_logs.js`, `reset_data.js`, and `archive_logs.js` implicitly assumed a **single-source LinkedIn world**.
- ATS:
  - ATS orchestrator existed but the stability and correctness of each company configuration were not fully validated.
  - It was unclear which companies were actually delivering clean, normalized data.

### 4.2 Current State

- Filesystem:
  - **LinkedIn and ATS are now strictly namespaced**:
    - `output/linkedin/` vs `output/ats/`.
    - `logs/linkedin/{summaries,filtered,archive}/` vs `logs/ats/{summaries,filtered,archive}/`.
  - Existing tools have been **surgically constrained** to LinkedIn (`PATHS.LINKEDIN.*` only).
  - A dedicated migration script (`tools/migrate_structure.js`) has successfully moved historical LinkedIn data into the new tree.

- ATS:
  - Orchestrator is confirmed to be producing:
    - `output/ats/ats_enriched_jobs_*.json`.
    - `logs/ats/summaries/ats_run_summary_*.json`.
    - `logs/ats/filtered/ats_filtered_jobs_debug_*.json`.
  - We have a clear understanding of **which companies are working** (Gong, Riskified, Melio) and which are misconfigured (Monday, Lemonade, Wiz).

Net effect: the environment is **ready for targeted tuning**, not structural surgery.

---

## 5. Configuration & Data Health

### 5.1 ATS Config Status (`data/companies_list.json`)

Current contents:

- **Greenhouse (`type: "greenhouse"`)**
  - `lemonade` – UID `"lemonade"` (**likely incorrect / not validated**).
  - `gong` – UID `"gongio"` (**working**).
  - `wiz` – UID `"wiz"` (**stale; Wiz moved to Ashby, so Greenhouse config is obsolete**).
  - `riskified` – UID `"riskified"` (**working**).
  - `melio` – UID `"melio"` (**working**).

- **Comeet (`type: "comeet"`)**
  - `fiverr` – UID `"fiverr"` (**needs validation, planned**).
  - `monday` – UID `"monday"` (**type/UID likely incorrect; needs correction**).

**Summary assessment:**

- **Success:** `gong`, `riskified`, `melio` – confirmed working Greenhouse integrations (fetched & normalized).
- **Failures / To Fix:**
  - **Monday** – Wrong `type` and/or `uid`; ATS returns no or invalid data.
  - **Lemonade** – UID appears incorrect; investigations show no or inconsistent data.
  - **Wiz** – Company has migrated from Greenhouse to Ashby; current `type: "greenhouse"` entry is now invalid and should be **removed or replaced** with an Ashby integration when/if implemented.
  - **Fiverr** – Conceptually targeted, but UID and type need verification using `tools/find_uid.js` or manual API inspection.

### 5.2 Data Quality – Senior Roles Leaking

- Observed in ATS output (e.g., in `output/ats/ats_enriched_jobs_*.json` and `logs/ats/filtered/`):
  - Entries like **"Staff Full Stack Engineer"**, **"Senior X"**, etc., that are outside the intended *junior* target.
- Likely causes:
  - **`filters_shared.js` Blacklist Gaps:**
    - Missing terms like `"Staff"` or variants; or
    - Case-sensitivity / partial match issues (e.g., `"staff"` vs `"Staff"`).
  - **Title-only filtering:**  
    - Some roles may have junior titles but descriptions clearly targeting **5+ years / senior-level experience**, which is currently not filtered.

**Conclusion:** Filters are good but not sufficient; we need both **stronger keyword coverage** and **description-based heuristics**.

---

## 6. Observability & Maintenance

### 6.1 Commands & Flows

- **LinkedIn Module:**
  - Run: `npm start`  
    - Entry: `scraper.js`  
    - Outputs: `output/linkedin/enriched_jobs_*.json`  
    - Logs: `logs/linkedin/summaries/run_summary_*.json`, `logs/linkedin/filtered/filtered_jobs_debug_*.json`

- **ATS Module:**
  - Run: `npm run ats`  
    - Entry: `ats/orchestrator.js`  
    - Outputs: `output/ats/ats_enriched_jobs_*.json`  
    - Logs: `logs/ats/summaries/ats_run_summary_*.json`, `logs/ats/filtered/ats_filtered_jobs_debug_*.json`

### 6.2 Health & Analysis

- **LinkedIn Health – `tools/analyze_logs.js`:**
  - Reads exclusively from **LinkedIn** paths:
    - `PATHS.LINKEDIN.LOGS.SUMMARIES`
    - `PATHS.LINKEDIN.LOGS.FILTERED`
    - `PATHS.LINKEDIN.OUTPUT`
  - Produces a **system health report** in `docs/analyze/calibration_report_*.txt`, summarizing:
    - Success rate, durations, quota hits.
    - Filter calibration (blacklist/whitelist hits, reposts).
    - Top-performing and “dead” queries.
    - Aggregated accepted vs. rejected jobs (LinkedIn only).

- **ATS Monitoring (Current State):**
  - No dedicated `tools/analyze_ats_logs.js` yet.  
  - Monitoring is done by:
    - Inspecting `logs/ats/summaries/ats_run_summary_*.json` manually.
    - Inspecting `logs/ats/filtered/ats_filtered_jobs_debug_*.json` for filter behavior.
    - Inspecting `output/ats/ats_enriched_jobs_*.json` for data quality and leakage.

### 6.3 Maintenance Utilities

- **`tools/reset_data.js`** – LinkedIn-only data reset (seen IDs, LinkedIn logs/output/debug artifacts).
- **`tools/archive_logs.js`** – LinkedIn-only archiving into `logs/linkedin/archive/`.
- **`tools/restore_recent_logs.js`** – LinkedIn-only selective restore from `logs/linkedin/archive/` (and legacy `archive/`).
- **`tools/migrate_structure.js`** – One-time migration from flat layout to nested LinkedIn structure; safe to re-run, but primarily intended as a post-refactor step.

---

## 7. Next Strategic Steps (Action Plan)

### 7.1 Fix Companies Config (Immediate)

1. **Run / refine `tools/find_uid.js`** to:
   - Discover canonical UIDs for:
     - **Monday** (Comeet or other ATS – verify correct vendor and UID).
     - **Lemonade** (Greenhouse slug or new ATS vendor if they migrated).
     - **Fiverr** (Comeet UID and schema).
   - Confirm working UIDs by:
     - Running `npm run ats` and verifying `ats_run_summary_*.json` entries show non-zero `fetched` counts and low error counts.
2. **Update `data/companies_list.json`:**
   - **Monday:** Fix `type` and `uid` based on actual ATS backend (likely Comeet, but verify).
   - **Lemonade:** Correct UID or vendor; if they changed ATS, update `type` and `uid` accordingly.
   - **Fiverr:** Validate and correct UID.
   - **Wiz:** Remove Greenhouse entry (or mark as inactive) until an Ashby integration is consciously implemented.

### 7.2 Logic Hardening – Phase 5.5

1. **Strengthen `filters_shared.js`:**
   - Extend **blacklist** to catch:
     - `"Staff"`, `"Principal"`, `"Lead"`, `"Architect"` and variants.
   - Ensure **case-insensitive** matching and robust substring checks.
2. **Description-Based Seniority Filtering:**
   - In addition to title-based rules, add **description scanning**:
     - Regex-style checks for patterns like:
       - `"5+ years"`, `"5 years of experience"`, `"7+ years"`, `"senior-level"`, etc.
   - This can live either:
     - In `filters_shared.js` as a shared helper (used by both modules), or
     - As a new ATS-specific gate that runs after `semanticGate`.
   - Goal: filter out senior roles even when the title appears junior but the description clearly targets experienced candidates.

### 7.3 Unified Reporting (Later Phase)

1. **Upgrade `tools/analyze_logs.js` to a Hybrid Analyzer:**
   - Add a `--source=` flag with values:
     - `linkedin` (default, preserves current behavior).
     - `ats`.
     - `all` (combined report or side-by-side sections).
   - Internally, map `--source` to:
     - `PATHS.LINKEDIN.*` for LinkedIn mode.
     - `PATHS.ATS.*` for ATS mode.
     - Both branches for hybrid mode.
2. **Introduce ATS-Focused Views:**
   - New tools, separate from legacy LinkedIn-only ones:
     - `tools/show_ats_acc_history.js` – similar to `show_acc_history.js` but reading from `PATHS.ATS.OUTPUT`.
     - `tools/show_ats_rejected_history.js` – similar to `show_rejected_history.js` but for `PATHS.ATS.LOGS.FILTERED`.
3. **Stretch Goal:** Unified dashboard view (CLI or web) that surfaces high-level KPIs for both LinkedIn and ATS in a single place, with explicit source labels.

---

### Closing Notes for the Next Developer

- **Infra is ready:** You can trust `PATHS` and the directory layout; do not reintroduce flat `output/` or `logs/` assumptions.
- **LinkedIn is stable:** The LinkedIn pipeline is mature and its tools are intentionally scoped to LinkedIn only.
- **ATS is promising but noisy:** Data flows correctly for several companies, but configuration and filter quality need tightening before ATS output can be treated as production-grade.
- **Your highest-impact next steps** are configuration repair (`data/companies_list.json` + `tools/find_uid.js`) and seniority-filter hardening (`filters_shared.js` + description scanning). Once those are in place, invest in ATS observability and unified reporting.***

