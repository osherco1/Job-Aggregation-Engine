## QA System Handover – LinkedIn Job Bot (Phase 5)

**Date:** January 3, 2026  
**Phase:** 5.0 – ATS Integration & Optimization (Pre-Alpha)  
**Owner:** Lead Architect (AI & User)

---

## 1. Executive Status

- **Current Phase:** Phase 5 (ATS Integration & Optimization).
- **System Health:** Stable. The bot has recently undergone a QA Audit and a “Cluster Query” optimization pass to eliminate dead queries and reduce hardware/operations false positives.
- **Goal:** Fully autonomous sourcing of Junior/Student roles with **0% false positives** (no non-software “Engineer” roles) while preserving or improving yield.

---

## 2. System Architecture (The Mental Model)

### 2.1 End-to-End Data Flow

High-level pipeline:

1. **Search Matrix Construction (`scraper.js`)**
   - `LEVEL_PREFIX` encodes junior/early-career intent (English + Hebrew).
   - `NICHES` defines domain-specific slices (Backend, Fullstack, Mobile, Data/AI, DevOps, Cyber, QA, Embedded, Systems/IT).
   - `CLUSTER_QUERIES` adds 4 balanced boolean clusters (Enterprise Backend, Scripting Backend, Modern Frontend, Structural Frontend).
   - `SEARCH_QUERIES` is built as:
     - All `LEVEL_PREFIX AND {niche}` combinations from `NICHES`.
     - Plus the 4 pre-expanded `CLUSTER_QUERIES`.

2. **Voyager Search (`linkedin_client.js` – `fetchJobs`)**
   - For each query, `fetchJobs`:
     - Builds a **“golden”** LinkedIn Voyager URL targeting `voyagerJobsDashJobCards`.
     - Strictly encodes the boolean keyword expression while keeping the outer `query=(origin:...,keywords:...,locationUnion:...,selectedFilters:...)` block raw.
     - Executes the request via a centralized Axios client with redirects disabled.
   - The raw Voyager response is optionally persisted to `debug_artifacts/debug_linkedin_response.json` for schema debugging.

3. **Raw Parsing & Normalization (`linkedin_client.js` – `normalizeResponse`)**
   - Maps the normalized LinkedIn envelope (`elements` + `included`) into a flat list:
     - `{ jobId, title, company, location, postedAt, url }`.
   - Resolves job cards via `entityUrn` mappings, with a fallback numeric-ID match if the direct URN lookup fails.

4. **Semantic Filtering & Deduplication (`scraper.js`)**
   - **Deduplication:** Maintains a `seen_jobs.json` set under `data/` to avoid reprocessing already-seen job IDs.
   - **Filtering Engine:**
     - `BLACKLIST_KEYWORDS`: aggressive negative signals (Senior/Lead titles, Sales/Marketing, Finance, HR/Recruiting, plus new hardware/legal terms).
     - `WHITELIST_KEYWORDS`: positive signals that a role is technical/relevant (Software/Engineer/Data/etc., plus new “Computer Vision”, “Firmware”, “Integrator”).
     - `passesFilters(job, runStats, filteredJobsLog)`:
       - Drops titles containing **any** blacklist term.
       - Drops titles that contain **no** whitelist term.
       - Annotates `runStats.filteredOut` and `filtered_jobs_debug_*.json` with reasons (`Blacklist`, `Whitelist`, `AlreadySeen`).
   - **Enrichment:** For kept jobs, `fetchJobDetails` (GraphQL) fetches deep data (description, apply URL, employment type, repost flag, etc.), persisted per job into `debug_artifacts/debug_job_details_{jobId}.json`.

5. **Storage & Reporting**
   - New enriched jobs for a run are saved as `output/enriched_jobs_{timestamp}.json`.
   - Run-level telemetry (counts, per-query stats, filter breakdowns, error counters) is saved as:
     - `logs/run_summary_{timestamp}.json`
     - `logs/filtered_jobs_debug_{timestamp}.json`
   - The mailer composes and sends a daily HTML email (unless in `DRY_RUN` mode) summarizing new jobs.

6. **Observability Layer (`tools/analyze_logs.js`)**
   - Reads all `run_summary_*.json` and aggregated filter logs.
   - Produces a **SYSTEM HEALTH REPORT** with:
     - Success rate, average run duration, quota hits.
     - Total queries run, filtering calibration (blacklist/whitelist counts), reposts.
     - **Dead Queries** (queries that consistently returned 0 results).
     - **Top Performers** (queries with highest new-job yield).
   - Appends summaries of:
     - Accepted jobs across all `enriched_jobs_*.json`.
     - Rejected jobs across all `filtered_jobs_debug_*.json`.
   - The full report is both printed to stdout and persisted under `docs/analyze/calibration_report_{timestamp}.txt`.

### 2.2 “No-Redirects” Protocol (`linkedin_client.js`)

- All LinkedIn traffic goes through `axiosClient` with:
  - `maxRedirects: 0` – the client **never** follows 302/303 responses.
  - A global response interceptor that:
    - Treats any 302/303 as a **critical auth challenge** (captcha / SSO redirect).
    - Logs a critical error and fires `sendCriticalAlert` with metadata (status, URL, timestamp).
    - Immediately calls `process.exit(1)` to stop the bot and avoid hammering a challenged session.
- Rationale:
  - Voyager redirects are almost always caused by authentication challenges or login flows.
  - Following them would look bot-like and can worsen account risk.
  - Hard-stopping on 302/303 ensures the bot only runs against a **clean, fully authenticated** session.

---

## 3. Core Technical Achievements

### 3.1 Matrix Architecture (SEARCH_QUERIES)

- **Junior Intent Prefix:** `LEVEL_PREFIX` injects early-career intent into every query, in both English and Hebrew.
- **Niche Matrix (`NICHES`):**
  - Backend (Python/Django/Flask/FastAPI; Java/Spring).
  - Fullstack.
  - Mobile (iOS, Android, React Native, Flutter).
  - Data & AI (Data Scientist, ML Engineer, Data Analyst).
  - DevOps / Platform / Cloud.
  - Cyber / Security.
  - QA / Automation.
  - Embedded / Low-level.
  - Systems / IT.
- **Cluster Strategy (`CLUSTER_QUERIES`):**
  - Adds 4 “balanced” boolean queries to replace earlier dead mega-queries:
    1. Enterprise Backend: (Java, C#, Go, .NET).
    2. Scripting Backend: (Node.js, Python, Django, Express).
    3. Modern Frontend: (React, Vue, Next.js).
    4. Structural Frontend: (Angular, TS, JS).
- **Active Matrix Size:** `SEARCH_QUERIES` currently contains **17** queries: 13 niche-derived queries + 4 cluster queries.

### 3.2 Filtering Engine (Logic Hardening)

- Tightened title filters to dramatically reduce **hardware / legal / operational** noise:
  - Expanded `BLACKLIST_KEYWORDS` to include terms like “Mechanical”, “Mechatronics”, “Electrical”, “VLSI”, “ASIC”, “Hardware”, “Legal”, “Attorney”, “Help Desk”, and other operational roles.
  - Extended `WHITELIST_KEYWORDS` with “Computer Vision”, “Firmware”, “Integrator” to protect valid edge-case software roles from being dropped.
- The filter is binary and explainable:
  - Any blacklist hit → immediate drop with a logged reason.
  - No whitelist hits → drop as “Non-tech title”.
  - Everything else passes into enrichment and reporting.

### 3.3 Observability (Dead Queries & False Positives)

- `tools/analyze_logs.js` is the primary analytics lens:
  - Aggregates historic runs to spot:
    - **Dead Queries:** queries with `rawTotal === 0` across all runs with data.
    - **Top Performers:** queries with highest average `new` jobs per run.
  - Surfaces error rates, quota hits, and filtering balances (blacklist vs whitelist rejections).
- Calibration loop:
  - Analyzer output feeds into matrix adjustments (e.g., replacing dead mega-queries with cluster queries).
  - Filter stats (e.g., high whitelist rejections) directly inform blacklist/whitelist tuning.

---

## 4. Configuration Snapshot (Dynamic Extraction – 2026-01-03)

All values below are extracted from the **live** `scraper.js` and related modules as of this snapshot.

- **DAILY_NEW_JOBS_LIMIT**
  - Current value: `500`
  - Location: `scraper.js` (`DAILY_NEW_JOBS_LIMIT`).

- **Randomized Jitter (RANDOM_DELAY)**
  - Helper: `randomDelay(minMs, maxMs)` in `scraper.js`.
  - Key call sites:
    - **Between distinct boolean queries:** `10,000–20,000 ms` (10–20 seconds).
    - **Between paginated jobSearch pages:** `3,000–7,000 ms` (3–7 seconds).
    - **Between individual job-detail (`fetchJobDetails`) calls:** `3,000–6,000 ms` (3–6 seconds).
    - **Between batches of queries (cool-off):** `120,000–180,000 ms` (2–3 minutes).

- **Total Number of Active Queries**
  - `NICHES.length = 13`
  - `CLUSTER_QUERIES.length = 4`
  - **Total `SEARCH_QUERIES` entries = 17**

- **Sample Blacklist Keywords (Top 5 by definition order)**
  - `Senior`
  - `Lead`
  - `Principal`
  - `Manager`
  - `Head of`

- **Sample Whitelist Keywords (Top 5 by definition order)**
  - `Software`
  - `Developer`
  - `Engineer`
  - `Data`
  - `Analyst`

---

## 5. Maintenance & Tooling

### 5.1 Audit Workflow (`npm run analyze`)

- **Command:** `npm run analyze`
- **Implementation:** `node tools/analyze_logs.js`
- **Purpose:**
  - Read all historic `run_summary_*.json` and `filtered_jobs_debug_*.json` under `logs/`.
  - Emit a consolidated **SYSTEM HEALTH REPORT** to stdout.
  - Persist the same report to `docs/analyze/calibration_report_{timestamp}.txt`.
- **When to Run:**
  - After a calibration sprint or a change to `SEARCH_QUERIES` / filters.
  - Before and after production-like runs to compare dead queries and yield.

### 5.2 Data Cleanup (`npm run reset`)

- **Command:** `npm run reset`
- **Implementation:** `node tools/reset_data.js`
- **What it does:**
  - Deletes `data/seen_jobs.json` (resets deduplication memory).
  - Deletes `debug_artifacts/debug_linkedin_response.json`.
  - Deletes all `enriched_jobs_*.json` in `output/`.
  - Deletes all `debug_job_details_*.json` in `debug_artifacts/`.
  - Deletes legacy flat `logs/run_summary.json` and `logs/filtered_jobs_debug.json` if present.
- **When to Run:**
  - Before a new calibration cycle.
  - Before moving to a new environment or after a major schema change.

---

## 6. Strategic Roadmap (Next Steps)

- **Immediate – ATS Integration (Phase 5 Core Objective)**
  - Finalize adapters for **Comeet** and **Greenhouse** using the enriched job payload as a source of truth.
  - Ensure that deduplication, filtering, and enrichment semantics are preserved end-to-end into the ATS pipeline.

- **Pending – Orchestrator Refactor**
  - Refactor `scraper.js` into a modular `Orchestrator` (class or service) that:
    - Encapsulates matrix construction, batching, rate control, enrichment, and persistence.
    - Exposes a clean API for future schedulers, ATS plugins, or web front-ends.
  - Target: Improved testability (unit-level around the orchestrator), clearer separation of concerns, and easier feature toggling.

- **Monitor – Cluster Query Yield**
  - In the next runs, use `npm run analyze` to:
    - Confirm that all 4 **Cluster Queries** now return > 0 results (no dead clusters).
    - Track yield and quality per cluster (Enterprise vs Scripting vs Frontend variants).
  - Feed findings back into:
    - Matrix tuning (e.g., splitting or merging clusters).
    - Filter adjustments if new hardware/ops leakage is detected.


# Session Update: ATS Debugging & Config Analysis

## System Architecture View (Hybrid – LinkedIn + ATS Hub & Spoke)

- Orchestrator (`ats/orchestrator.js`) פועל כ־Hub מרכזי:
  - טוען את `data/companies_list.json` ומייצר רשימת חברות לפי `type` (`comeet` / `greenhouse`).
  - יוצר HTTP Client משותף (`ats/utils/httpClient.js`) עם `maxRedirects: 0` ו־jitter מובנה (200–500ms לכל בקשה ATS).
  - מריץ לולאה סיקוונציאלית על החברות: קורא ל־Workers, מנרמל (`normalizeJob`), מחיל Gates (Location + Semantic), וכותב תוצרים ל־`output/` ו־`logs/`.
- Workers (Spokes):
  - `ComeetWorker` ו־`GreenhouseWorker` בונים `targetUrl` לפי `uid` מנוקה (`cleanUid`) ומבצעים קריאת HTTP דרך `requestWithDelay`.
  - מבצעים `fetchAllJobs` לכל חברה ומחזירים מערך raw jobs לנרמול.
- Normalization & Filtering:
  - `normalizeJob` ממפה לכל UnifiedJob: `jobId` עם prefix (`comeet_` / `gh_`), `title`, `location`, `url`, `description`.
  - `LocationGate` מסנן מראש כל מיקום שלא מכיל Israel/Tel Aviv/Herzliya/Remote וכו'.
  - `SemanticGate` משתמש ב־`filters_shared.js` (Blacklist/Whitelist) כדי להפיל כותרות Senior/Non-Tech ולשמר רק Junior/Tech.

## Debugging Findings – Phase 5 ATS Run (`npm run ats`)

### 1. Silence Is Success – HTTP 200 ללא רעש

- המערכת בנויה כך ש־Workers מדפיסים **WARN/ERROR רק על כשל**; חוסר לוגים מעיד על ריצה תקינה (200 OK) מבחינת HTTP.
- במהלך הריצה:
  - **Gong, Riskified, Melio** – לא נרשמו WARN/ERROR עבור ה־UID שלהם, מה שמצביע על:
    - חיבור מוצלח ל־Greenhouse API עבור החברות האלה.
    - הופעת משרות מנורמלות בקובצי `output/ats_enriched_jobs_*.json` (subject לפילטרים).
  - אמת מידה: `logs/ats_run_summary_*.json` + `output/ats_enriched_jobs_*.json` משמשים כ־"execution log" ו־"enriched_jobs.json" בפועל.

### 2. Configuration Audits – Root Cause Analysis

- **Monday.com**  
  - מצב: מוגדרת כ־`type: "comeet"` ב־`companies_list.json`.  
  - תוצאה: קריאת Comeet ל־`https://www.comeet.com/jobs-api/2.0/company/monday/positions` מחזירה **404**.  
  - אבחנה: Monday.com משתמשת בפועל ב־**Greenhouse**; שגיאה בקונפיגורציה (Type + Endpoint), לא בקוד ה־Worker.

- **Lemonade**  
  - מצב: `type: "greenhouse"`, `uid: "lemonade"`.  
  - תוצאה: קריאה ל־`https://boards-api.greenhouse.io/v1/boards/lemonade/jobs?content=true` מחזירה **404**.  
  - אבחנה: Greenhouse board בפועל הוא `lemonadeinc`; כלומר **UID שגוי**. זהו פגם Data (קובץ קונפיגורציה), לא בעיית קוד.

- **Wiz**  
  - מצב: מוגדרת כ־Greenhouse.  
  - תוצאה: 404 על ה־Greenhouse URL; בבדיקה ידנית התברר ש־Wiz **היגרה ל־Ashby** (ATS שכרגע לא נתמך).  
  - אבחנה: מקור הבעיה הוא **בחירה ב־ATS לא נכון** (הגירה למערכת אחרת), נדרש טיפול רמת Product/Config (להשבית/להסיר).

- **Fiverr**  
  - מצב: מוגדרת כ־`type: "comeet"`, `uid: "fiverr"`.  
  - תוצאה: 404 מצד Comeet.  
  - אבחנה (סבירה): UID או Type אינם תואמים ל־API בפועל (ייתכן מעבר ל־Greenhouse/ATS אחר או UID שגוי). שוב – **טעות Data**.

## Configuration Snapshot – Phase 5 State

- **DAILY_NEW_JOBS_LIMIT**  
  - ערך נוכחי בקוד (`scraper.js`): `500`.  
  - יישום: תקרת משרות חדשות (LinkedIn) כדי להגן על ה־Mailer ועל ה־Pipeline בדו"ח היומי.

- **JITTER (Anti-Bot Delays)**  
  - LinkedIn (`scraper.js`):  
    - בין שאילתות Boolean שונות: `randomDelay(10000, 20000)` → 10–20 שניות.  
    - בין עמודי jobSearch (pagination): `randomDelay(3000, 7000)` → 3–7 שניות.  
    - בין קריאות `fetchJobDetails`: `randomDelay(3000, 6000)` → 3–6 שניות.  
    - Cool-off בין Batches: `randomDelay(120000, 180000)` → 2–3 דקות.  
  - ATS (`ats/utils/httpClient.js`):  
    - כל בקשת ATS (Comeet/Greenhouse) עוברת דרך `requestWithDelay(config, 200, 500)` → **200–500ms** ג'יטר.

- **BLACKLIST_KEYWORDS (מקור: `filters_shared.js`)**  
  - רשימה מלאה (מייצגת את ה־Logic הנוכחי):
    - Senior, Lead, Principal, Manager, Head of, Director, VP, Chief, Architect, 5+ years, 6+ years, 7+ years, 8+ years.  
    - Sales, Sale, Marketing, Marketer, Media, Buyer, B2B, PPC, Campaign, Creative, Digital, Social Media, SEO.  
    - Finance, Financial, Accounting, Accountant, Controller, CPA, Audit, Auditor, Bookkeeper, Payroll, Tax, Economics, Economist.  
    - HR, Human Resources, Recruiter, Talent, Office, Admin, Secretary, Assistant, Customer Success, CSM, Support Representative, Call Center.  
    - Language Analyst, Online Data Analyst, Content Writer, Copywriter, Translator.  
    - (Hebrew) שיווק, מכירות, כספים, כלכלה, מנהל חשבונות, חשב, מזכירה, אדמיניסטרציה, משאבי אנוש, גיוס.  
    - Mechanical, Mechatronics, Electrical, Electronics, Power Engineer, Analog, ASIC, VLSI, Hardware, Lawyer, Attorney, Legal, Help Desk, Support Specialist, Instructional Designer, Biotechnology, Assembler, Operator.

- **Status of `data/companies_list.json`**  
  - מצב נוכחי: **Hybrid** – חלק מהחברות תקינות (Gong, Riskified, Melio), אחרות פגומות (Monday, Lemonade, Wiz, Fiverr).  
  - סטטוס: **Requires immediate manual patching based on debug logs** – ה־Type וה־UID צריכים להיבדק מול ה־ATS האמיתי של כל חברה (כולל בדיקה אם המערכת עדיין Comeet/Greenhouse או היגרה ל־Ashby/אחר).

## Observability – מקורות אמת לריצת ATS

- **ATS Run Summaries**  
  - `logs/ats_run_summary_*.json` – משקפים מדדי ריצה: `fetched`, `kept`, `droppedLocation`, `droppedSemantic`, `errors` לכל חברה.  
  - קבצים אלו מהווים את המקבילה ל־`execution.log` ברמת מערכת.

- **Enriched Jobs (ATS)**  
  - `output/ats_enriched_jobs_*.json` – מכילים את כל המשרות שעברו את ה־Location Gate + Semantic Gate.  
  - שימשו לאימות ה־"Silence is Success" – כאשר מופיעות משרות עבור Gong/Riskified/Melio ללא WARN בלוגים, אנו מניחים HTTP 200 + סנכרון תקין.

- **Filtered Jobs Debug**  
  - `logs/ats_filtered_jobs_debug_*.json` – תיעוד סנסיטיבי של כל drop (Location / Semantic), כולל `title`, `location`, `companyId`, `source`.  
  - מספקים שקיפות מלאה לתהליך הסינון וקריטיים לאודיטים עתידיים.

## Next Strategic Steps (Phase 5+)

1. Patch `companies_list.json` (Data Hygiene)
   - לתקן באופן יזום:
     - Monday.com → לעדכן ל־`type: "greenhouse"` + UID אמיתי ב־Greenhouse (ולוודא 200 דרך curl/Postman).  
     - Lemonade → לשנות UID ל־`lemonadeinc`.  
     - Fiverr/Wiz → להחליט האם להסיר/להשבית עד ש־ATS ו־UID יזוהו בוודאות (במיוחד במקרה Wiz→Ashby).

2. Verify Data Integrity for "Silent" Companies
   - להריץ `npm run ats` לאחר עדכון ה־config ולוודא:
     - Gong, Riskified, Melio ממשיכים להופיע ב־`ats_enriched_jobs_*.json`.  
     - אין קפיצה חריגה ב־`droppedLocation` / `droppedSemantic` עבורם (סימן לפילטר אגרסיבי מדי).

3. Implement `utils/find_uid.js` (UID Discovery Tool)
   - כלי CLI שיקבל:
     - `company name` + `ats type` (comeet/greenhouse) וינסה:
       - להריץ בקשות בדיקה על UIDים סבירים (למשל `lemonade`, `lemonadeinc`) עם rate-limit נמוך.  
       - לרשום את ה־UID הראשון שמחזיר 200 ופורמט JSON תקין.  
   - מטרה: לצמצם תלות במחקר ידני ולחסוך זמן QA בכל פעם שחברה משנה Board / UID.
