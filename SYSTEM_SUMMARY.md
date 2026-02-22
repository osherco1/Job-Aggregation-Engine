# LinkedIn Job Bot - System Summary

> **Generated:** January 24, 2026  
> **Purpose:** Comprehensive onboarding guide and system documentation

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Project Metadata](#2-project-metadata)
3. [Folder Overview](#3-folder-overview)
4. [Architecture Overview](#4-architecture-overview)
5. [Project Status & Functionality Report](#5-project-status--functionality-report)
6. [Main Logic Flows](#6-main-logic-flows)
7. [Configuration & Environment](#7-configuration--environment)
8. [TODOs, FIXMEs & Technical Debt](#8-todos-fixmes--technical-debt)
9. [Testing, CI/CD & Documentation](#9-testing-cicd--documentation)

---

## 1. Executive Summary

**LinkedIn Job Bot** is a local automation system that aggregates junior/entry-level tech job listings from multiple sources:

1. **LinkedIn Voyager API** – Reverse-engineered scraper for LinkedIn jobs
2. **ATS Direct Integrations** – Official APIs for Greenhouse and Comeet applicant tracking systems

The bot filters jobs by seniority (targeting Junior/Student/Entry-Level roles), location (Israel-focused), and technical relevance, then sends daily email reports with curated job listings.

### Key Highlights

- **Current Phase:** Phase 5.3 – ATS Scaling & Comeet Debugging
- **Status:** 🟡 **PARTIAL SUCCESS**
  - **LinkedIn Voyager:** ✅ Production-ready
  - **Greenhouse ATS:** ✅ Production-ready (5 companies integrated)
  - **Comeet ATS:** ❌ Blocked (API investigation needed)
- **Primary Use Case:** Automated job discovery for junior tech professionals in Israel

---

## 2. Project Metadata

### Project Identity

| Property | Value |
|----------|-------|
| **Project Name** | LinkedIn Job Bot |
| **Domain** | Job Search Automation / Web Scraping |
| **Type** | Local CLI Tool with Email Notifications |
| **Primary Language** | JavaScript (Node.js) |
| **Runtime** | Node.js |

### Dependencies

```json
{
  "axios": "^1.13.2",        // HTTP client for API requests
  "cheerio": "^1.1.2",       // HTML parsing (minimal usage)
  "dotenv": "^16.6.1",       // Environment variable management
  "nodemailer": "^7.0.11",   // Email sending via SMTP/Gmail
  "puppeteer": "^24.35.0"    // Browser automation (token extraction)
}
```

### NPM Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `analyze` | `node tools/analyze_logs.js` | Generate calibration reports from run logs |
| `reset` | `node tools/reset_data.js` | Clean LinkedIn data for fresh runs |
| `ats` | `node ats/orchestrator.js` | Run ATS-only job scraping |

### Entry Points

| File | Purpose |
|------|---------|
| `scraper.js` | Main LinkedIn Voyager scraper |
| `ats/orchestrator.js` | ATS (Greenhouse/Comeet) job aggregator |
| `run_bot.bat` | Windows batch launcher for scraper |

---

## 3. Folder Overview

### Root Directory Structure

```
linkedin_job_bot/
├── archive/                  # Archived JSON data (370+ files)
├── ats/                      # ATS integration module
├── config/                   # Centralized configuration
├── data/                     # Runtime data files
├── debug_artifacts/          # Debug JSON dumps
├── docs/                     # Documentation & snapshots
├── logs/                     # Structured logging
├── node_modules/             # Dependencies
├── output/                   # Generated job reports
├── PRD/                      # Product requirements documents
├── promts/                   # AI assistant prompts
├── tools/                    # Utility scripts
├── scraper.js                # Main LinkedIn scraper
├── linkedin_client.js        # LinkedIn API client
├── mailer.js                 # Email notification system
├── filters_shared.js         # Shared filtering logic
├── run_bot.bat               # Windows launcher
├── package.json              # Project manifest
└── MAINTENANCE_PROTOCOL_V3.md # Operations manual
```

---

### `/ats` - ATS Integration Module

**Purpose:** Hub-and-spoke architecture for direct ATS API integrations.

| Path | Description |
|------|-------------|
| `ats/orchestrator.js` | **Hub** – Central coordinator that iterates companies and dispatches to workers |
| `ats/config/companiesConfig.js` | Loads and validates `companies_list.json` |
| `ats/filters/ats_guard.js` | Seniority and relevance filtering for ATS jobs |
| `ats/workers/greenhouseWorker.js` | **Spoke** – Fetches jobs from Greenhouse API |
| `ats/workers/comeetWorker.js` | **Spoke** – Fetches jobs from Comeet API (currently blocked) |
| `ats/utils/httpClient.js` | Axios-based HTTP client with rate limiting |
| `ats/utils/httpClientWrapper.js` | Convenience wrapper for workers |
| `ats/utils/locationGate.js` | Israel-focused location filtering |
| `ats/utils/normalizeJob.js` | Normalizes ATS responses to unified schema |
| `ats/utils/semanticGate.js` | Wrapper for shared semantic filters |
| `ats/types/interfaces.d.ts` | TypeScript interface definitions (documentation only) |

**Relationship with other folders:**
- Uses `config/vocabulary.js` for filter patterns
- Uses `config/paths.js` for filesystem paths
- Reads from `data/companies_list.json`
- Writes to `output/ats/` and `logs/ats/`

---

### `/config` - Configuration

**Purpose:** Centralized configuration and vocabulary definitions.

| File | Description |
|------|-------------|
| `paths.js` | **Critical** – Defines all filesystem paths (PATHS object) |
| `vocabulary.js` | Filter patterns: blacklist departments, senior title patterns, seniority regex |

**Key Architecture Rule:** Never scan bare `output/` or `logs/`. Always use `PATHS.LINKEDIN.*` or `PATHS.ATS.*`.

---

### `/data` - Runtime Data

**Purpose:** Persistent state and configuration files.

| File | Description |
|------|-------------|
| `seen_jobs.json` | Deduplication memory – LinkedIn job IDs already processed |
| `companies_list.json` | ATS company configurations (id, name, type, uid) |
| `companies_list_auto.json` | Auto-generated company list (experimental) |
| `candidates_bank.json` | Stored candidate/job data |

**Active Company Configurations:**

| Company | Type | UID | Status |
|---------|------|-----|--------|
| Gong | Greenhouse | `gongio` | ✅ Active |
| Riskified | Greenhouse | `riskified` | ✅ Active |
| Melio | Greenhouse | `melio` | ✅ Active |
| AppsFlyer | Greenhouse | `appsflyer` | ✅ Active |
| Wiz | Greenhouse | `wizinc` | ✅ Active |
| Monday.com | Comeet | `monday` | ❌ Blocked |
| Fiverr | Comeet | `fiverr` | ❌ Blocked |

---

### `/debug_artifacts` - Debug Output

**Purpose:** Raw API response dumps for debugging and schema exploration.

| Pattern | Source |
|---------|--------|
| `debug_linkedin_response.json` | LinkedIn Voyager search responses |
| `debug_job_details_*.json` | LinkedIn GraphQL job details |

**Note:** Contains 739+ JSON files. These are debugging artifacts that capture raw API responses.

---

### `/docs` - Documentation

**Purpose:** Project documentation, session logs, and analysis reports.

| Path | Description |
|------|-------------|
| `docs/analyze/` | Calibration reports from `npm run analyze` |
| `docs/calibration/` | Audit reports for filter tuning |
| `docs/diagrams/` | Architecture diagrams (text-based) |
| `docs/snapshots/` | Session handover documents for continuity |
| `ARCHITECTURE_PATHS.md` | Filesystem conventions documentation |
| `docs_voyager_auth.md` | LinkedIn authentication guide |
| `linkedin_encoding_guide.md` | URL encoding reference |
| `SESSION_SUMMARY_DEC_2025.md` | Historical session summary |

---

### `/logs` - Structured Logging

**Purpose:** Run summaries, filtered job logs, and debug outputs.

```
logs/
├── ats/
│   ├── archive/        # Archived ATS logs
│   ├── cleanup/        # Cleanup operation reports
│   ├── filtered/       # Jobs dropped by ATS filters
│   ├── raw/            # Raw ATS API responses (DEBUG_RAW=true)
│   └── summaries/      # ATS run summary JSON files
└── linkedin/
    ├── archive/        # Archived LinkedIn logs
    ├── filtered/       # Jobs dropped by LinkedIn filters
    └── summaries/      # LinkedIn run summary JSON files
```

---

### `/output` - Generated Reports

**Purpose:** Final enriched job reports ready for email.

```
output/
├── ats/
│   └── ats_enriched_jobs_*.json    # ATS pipeline output
└── linkedin/
    └── enriched_jobs_*.json        # LinkedIn pipeline output
```

---

### `/PRD` - Product Requirements

**Purpose:** Product specification documents.

| File | Description |
|------|-------------|
| `PRD.md` | Main product requirements (Hebrew) |
| `AcceptanceCriteria.md` | Success criteria definitions |
| `DataModel.md` | Data structure specifications |
| `UserStories.md` | User story definitions |

---

### `/promts` - AI Prompts

**Purpose:** Stored prompts for AI assistants (Cursor, Gemini).

| Path | Description |
|------|-------------|
| `promts/coursor/` | Cursor IDE prompts |
| `promts/gemini/` | Gemini AI prompts for analysis |

---

### `/tools` - Utility Scripts

**Purpose:** Maintenance, debugging, and operational utilities.

| Script | Purpose |
|--------|---------|
| `analyze_logs.js` | Generate calibration/health reports from run summaries |
| `archive_logs.js` | Archive old log files |
| `reset_data.js` | Clean LinkedIn data for fresh runs |
| `reset_ats_data.js` | Clean ATS data for fresh runs |
| `ats_scanner.js` | ATS endpoint scanner/debugger |
| `debug_comeet.js` | Comeet API debugging tool |
| `force_final_config.js` | Force configuration updates |
| `migrate_structure.js` | Data structure migration |
| `restore_recent_logs.js` | Restore archived logs |
| `show_acc_history.js` | Display accepted jobs history |
| `show_rejected_history.js` | Display rejected jobs history |
| `token_hunter.js` | LinkedIn token extraction |
| `token_hunter_puppeteer.js` | Puppeteer-based token extraction |
| `update_companies_phase5_1.js` | Company list update utility |
| `verify_fiverr_api.js` | Fiverr/Comeet API verification |

---

## 4. Architecture Overview

### Hub & Spoke Model

```
┌─────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATION                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────┐          ┌───────────────────────────────┐  │
│  │   scraper.js  │          │    ats/orchestrator.js        │  │
│  │ (LinkedIn Hub)│          │        (ATS Hub)              │  │
│  └───────┬───────┘          └───────────────┬───────────────┘  │
│          │                                  │                   │
│          ▼                                  ▼                   │
│  ┌───────────────┐          ┌───────────────┴───────────────┐  │
│  │linkedin_client│          │     Worker Dispatch           │  │
│  │ .js (Voyager) │          ├───────────────┬───────────────┤  │
│  └───────────────┘          │  Greenhouse   │    Comeet     │  │
│                             │   Worker      │    Worker     │  │
│                             └───────────────┴───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                         FILTERING LAYER                         │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  Location Gate  │  │  Semantic Gate  │  │   ATS Guard     │ │
│  │  (Israel only)  │  │ (Blacklist/WL)  │  │ (Title/Dept/Yrs)│ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                         OUTPUT LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  JSON Reports   │  │  Email Reports  │  │   Run Summaries │ │
│  │  (enriched_*)   │  │   (mailer.js)   │  │   (logs/*)      │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Fetch** → LinkedIn Voyager API / Greenhouse API / Comeet API
2. **Parse** → Normalize responses to unified job schema
3. **Filter** → Apply location gate, semantic filters, seniority checks
4. **Enrich** → Fetch job details (LinkedIn GraphQL)
5. **Dedupe** → Check against `seen_jobs.json`
6. **Report** → Generate JSON output + send email notification

---

## 5. Project Status & Functionality Report

### Current Functionality

| Feature | Status | Notes |
|---------|--------|-------|
| LinkedIn Voyager Job Search | ✅ Working | Multi-query boolean search matrix |
| LinkedIn Job Enrichment | ✅ Working | GraphQL-based detail fetching |
| Greenhouse ATS Integration | ✅ Working | 5 companies active |
| Comeet ATS Integration | ❌ Blocked | API semantics unclear |
| Email Notifications | ✅ Working | Gmail SMTP via nodemailer |
| Seniority Filtering | ✅ Working | Blacklist + years-of-experience detection |
| Location Filtering | ✅ Working | Israel cities + remote handling |
| Deduplication | ✅ Working | Persistent seen_jobs.json |
| Run Summaries & Analytics | ✅ Working | Per-run JSON logging |
| Critical Auth Alerting | ✅ Working | Email alerts on LinkedIn auth failure |

### Incomplete / Placeholder Components

| Component | Status | Notes |
|-----------|--------|-------|
| Comeet Worker | ❌ Blocked | Returns 404/301 for all companies; API investigation needed |
| Snyk Integration | ❌ Disabled | Company may have moved to different ATS |
| Skills Extraction | ⚠️ Partial | Field exists but not fully populated |
| Recruiter Details | ⚠️ Partial | `posterId` often null from LinkedIn |
| Repost Detection | ⚠️ Partial | Boolean flag exists, not always reliable |

### Deprecated Components

| Component | Notes |
|-----------|-------|
| `candidates_bank.json` | Legacy data store, not actively used |
| `companies_list_auto.json` | Experimental auto-generated list |

---

## 6. Main Logic Flows

### LinkedIn Scraper Flow (`scraper.js`)

```
1. Load seen job IDs from data/seen_jobs.json
2. Build search query matrix (NICHES + CLUSTER_QUERIES)
3. For each query batch (5 queries per batch):
   a. For each query:
      i.   Paginate through results (0, 25, 50, 75)
      ii.  Call fetchJobs() → LinkedIn Voyager API
      iii. Normalize response via includedMap lookup
      iv.  For each new job:
           - Mark as seen
           - Fetch details via fetchJobDetails() (GraphQL)
           - Apply blacklist/whitelist filters
           - If passes: add to allNewJobs
      v.   Random delays between calls (3-7s)
   b. Cool-off period between batches (2-3 min)
4. Save enriched jobs to output/linkedin/enriched_jobs_*.json
5. Send email report via mailer.js
6. Persist updated seen_jobs.json
7. Write run summary to logs/linkedin/summaries/
```

### ATS Orchestrator Flow (`ats/orchestrator.js`)

```
1. Load company configurations from data/companies_list.json
2. Initialize HTTP client with rate limiting
3. For each company:
   a. Dispatch to appropriate worker (Greenhouse/Comeet)
   b. Worker fetches all open positions
   c. Apply ATS Guard filtering (title, department, description)
   d. Normalize to unified job schema
   e. Apply Location Gate (Israel/Remote)
   f. Apply Semantic Gate (shared blacklist/whitelist)
   g. Accumulate kept jobs
4. Persist results:
   - output/ats/ats_enriched_jobs_*.json
   - logs/ats/summaries/ats_run_summary_*.json
   - logs/ats/filtered/ats_filtered_jobs_debug_*.json
```

### Filtering Pipeline

```
┌────────────────────────────────────────────────────────────┐
│                    JOB FILTERING PIPELINE                   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  INPUT: Raw Job                                            │
│         │                                                  │
│         ▼                                                  │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 1. ATS GUARD (ATS only)                              │ │
│  │    ├─ Title check: technical keywords required       │ │
│  │    ├─ Title check: senior patterns rejected          │ │
│  │    ├─ Department blacklist                           │ │
│  │    └─ Description: years-of-experience patterns      │ │
│  └──────────────────────────────────────────────────────┘ │
│         │                                                  │
│         ▼                                                  │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 2. LOCATION GATE                                     │ │
│  │    ├─ PASS: Contains "Israel" or Israeli city        │ │
│  │    ├─ PASS: Exactly "Remote" (no country specified)  │ │
│  │    ├─ FAIL: "Remote - Germany", "Remote - UK", etc.  │ │
│  │    └─ FAIL: Non-Israel locations                     │ │
│  └──────────────────────────────────────────────────────┘ │
│         │                                                  │
│         ▼                                                  │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 3. SEMANTIC GATE (BLACKLIST)                         │ │
│  │    REJECT if title contains:                         │ │
│  │    Senior, Lead, Principal, Manager, Director, VP,   │ │
│  │    Sales, Marketing, Finance, HR, Legal, Hardware... │ │
│  └──────────────────────────────────────────────────────┘ │
│         │                                                  │
│         ▼                                                  │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 4. SEMANTIC GATE (WHITELIST)                         │ │
│  │    REQUIRE at least one of:                          │ │
│  │    Software, Developer, Engineer, Data, QA, Cyber,   │ │
│  │    DevOps, Frontend, Backend, Mobile, Junior...      │ │
│  └──────────────────────────────────────────────────────┘ │
│         │                                                  │
│         ▼                                                  │
│  OUTPUT: Filtered Job (or DROPPED)                        │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 7. Configuration & Environment

### Required Environment Variables

Create a `.env` file in the project root:

```bash
# LinkedIn Authentication (from browser DevTools)
LINKEDIN_LI_AT=<your_li_at_cookie>
LINKEDIN_JSESSIONID=<your_jsessionid_cookie>
LINKEDIN_CSRF_TOKEN=<your_csrf_token>

# Optional LinkedIn Settings
LINKEDIN_USER_AGENT=<custom_user_agent>
LINKEDIN_ACCEPT_LANGUAGE=en-US,en;q=0.9

# Email Configuration (Gmail)
JOBBOT_SMTP_USER=your.email@gmail.com
JOBBOT_SMTP_PASS=<gmail_app_password>
JOBBOT_TO_EMAIL=recipient@email.com

# Debug Flags
DEBUG_RAW=false           # Save raw ATS responses
ATS_GUARD_DRY_RUN=false   # Skip ATS guard filtering
DRY_RUN=false             # Skip email sending
```

### Getting LinkedIn Credentials

1. Log into LinkedIn in your browser
2. Open Developer Tools (F12) → Network tab
3. Navigate to any LinkedIn page
4. Find a request to `linkedin.com`
5. Copy cookie values: `li_at`, `JSESSIONID`
6. Copy `Csrf-Token` header value

### Israeli Cities (Location Gate)

The location filter accepts these cities:
- Tel Aviv, Herzliya, Haifa, Jerusalem
- Rehovot, Ramat Gan, Petah Tikva, Netanya
- Ra'anana, Hod HaSharon, Kfar Saba, Givatayim

---

## 8. TODOs, FIXMEs & Technical Debt

### Active Blockers

| Issue | Location | Priority |
|-------|----------|----------|
| Comeet API returns 404/301 | `ats/workers/comeetWorker.js` | 🔴 High |
| Snyk ATS provider unknown | `data/companies_list.json` | 🟡 Medium |

### Technical Debt

| Area | Issue | Recommendation |
|------|-------|----------------|
| **Testing** | No automated tests | Add Jest unit tests for filters and normalizers |
| **CI/CD** | No pipeline defined | Add GitHub Actions for linting and basic tests |
| **Error Handling** | Generic catches in some places | Add specific error types and recovery strategies |
| **Type Safety** | JavaScript only | Consider migrating to TypeScript |
| **Secrets** | `.env` file only | Consider using a secrets manager for production |
| **Monitoring** | Console logs only | Add structured logging (Winston/Pino) |
| **Rate Limiting** | Simple delays | Add exponential backoff and retry logic |

### Code Comments of Note

- `linkedin_client.js`: Contains detailed comments about URL encoding issues
- `ats_guard.js`: Documents seniority pattern matching logic
- `locationGate.js`: Explains remote job handling edge cases

### Potential Improvements

1. **Unified Job Schema** – Create a single TypeScript type used by both LinkedIn and ATS modules
2. **Database Storage** – Replace JSON files with SQLite for better querying
3. **Web Dashboard** – Add a simple Express server with job review UI
4. **Retry Mechanism** – Add proper retry with exponential backoff
5. **Company Discovery** – Auto-discover new companies from LinkedIn job posts

---

## 9. Testing, CI/CD & Documentation

### Current State

| Aspect | Status | Notes |
|--------|--------|-------|
| **Unit Tests** | ❌ None | No test framework configured |
| **Integration Tests** | ❌ None | Manual testing only |
| **CI/CD Pipeline** | ❌ None | No GitHub Actions / CircleCI |
| **Linting** | ⚠️ Partial | ESLint comments present but no config file |
| **Type Checking** | ❌ None | Plain JavaScript, TypeScript interfaces are docs only |
| **Documentation** | ✅ Good | Extensive markdown docs in `/docs` |

### Documentation Assets

| Document | Purpose |
|----------|---------|
| `MAINTENANCE_PROTOCOL_V3.md` | Operations manual for API changes |
| `docs/ARCHITECTURE_PATHS.md` | Filesystem conventions |
| `docs/snapshots/*.md` | Session handover documents |
| `PRD/*.md` | Product requirements |
| `docs/diagrams/*.txt` | Architecture diagrams |

### Recommended Next Steps for New Developers

1. **Read** `MAINTENANCE_PROTOCOL_V3.md` for debugging procedures
2. **Set up** `.env` file with LinkedIn credentials
3. **Run** `node tools/reset_data.js` for clean state
4. **Test LinkedIn** with `node scraper.js`
5. **Test ATS** with `npm run ats`
6. **Review logs** in `logs/linkedin/` and `logs/ats/`

---

## Appendix: Quick Reference

### Common Commands

```bash
# Run LinkedIn scraper
node scraper.js

# Run ATS pipeline only
npm run ats

# Generate calibration report
npm run analyze

# Reset LinkedIn data
npm run reset

# Reset ATS data
node tools/reset_ats_data.js
```

### File Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| `enriched_jobs_*.json` | `output/linkedin/` | LinkedIn job reports |
| `ats_enriched_jobs_*.json` | `output/ats/` | ATS job reports |
| `run_summary_*.json` | `logs/linkedin/summaries/` | LinkedIn run stats |
| `ats_run_summary_*.json` | `logs/ats/summaries/` | ATS run stats |
| `filtered_jobs_debug_*.json` | `logs/*/filtered/` | Rejected job logs |
| `raw_jobs_debug_*.json` | `logs/ats/raw/` | Raw ATS responses |

### Key KPIs

- **Target Yield:** 5+ junior jobs per week from ATS alone
- **Precision Goal:** 100% Israel Tech (0 false positives)
- **Daily Limit:** 500 new LinkedIn jobs per run

---

*This document was generated by analyzing the complete codebase structure, reading all core modules, and synthesizing documentation from various sources within the repository.*

