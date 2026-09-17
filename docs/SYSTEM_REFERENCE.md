# SYSTEM_REFERENCE.md — Job Aggregation Engine

> ⚠️ **PARTIALLY SUPERSEDED — 2026-09-06.** Sections §21–§26 and §34 (guard internals, worker
> internal flows, data shapes, job-ID conventions) drifted from the code between 2026-03-23 and
> 2026-09-06. For anything concerning **attributes, schemas, payload shapes, gate inputs, dedup
> keys, or persistence field lists**, `docs/DATA_CONTRACTS.md` is authoritative — it is
> evidence-tagged against captured payloads and live probes. §12 of that file lists the specific
> corrections. The infrastructure, calibration, quota, and deployment sections here remain current.


> **Generated:** 2026-03-23  
> **Codebase Version:** v7.1 (Distributed Resilience & Quota Catch-22 Resolution)  
> **Source of Truth for:** Browser-based Lead Architect (Gemini/ChatGPT/Claude Web)  
> **Codebase State:** GCS-backed distributed calibration lock, quota-exhaustion fail-safe alerting, 200MB volume threshold (chosen to leave ample logical and memory headroom for calibration report generation before aggressive purge), aggressive purge protocol, and Cloud Run retry hardening.

---

## 1. Project Identity

**Name:** Job Aggregation Engine (aka "LinkedIn Job Bot" / "JobBot")  
**Repository:** `https://github.com/osherco1/Job-Aggregation-Engine`  
**Owner:** oshercohen78  
**Version:** v7.1 (commit `eed9505` on `main`)  
**Active Branch:** `main`

**Purpose:** Automated job aggregation engine targeting junior/entry-level technical positions in Israel. The system scrapes four data sources on a scheduled basis:

1. **LinkedIn** — Via reverse-engineered Voyager REST API (search + per-job GraphQL enrichment)
2. **Comeet** — Via public token-based API v1.0
3. **Greenhouse** — Via public boards API
4. **Workday** — Via session-based Play Framework API with Akamai WAF evasion

The pipeline deduplicates jobs across runs using persistent history in MongoDB, applies a multi-layer filter pipeline (location gate → structured gate → ATS guard → semantic gate), and emails a consolidated HTML report via Gmail SMTP. Runs as a Google Cloud Run Job triggered by Cloud Scheduler.

---

## 2. Tech Stack

| Layer | Technology | Version/Details |
|-------|-----------|----------------|
| Runtime | Node.js | `20-slim` (from Dockerfile `FROM node:20-slim`) |
| Database | MongoDB Atlas M0 | Free tier, 512MB limit, database `jobbot_db` |
| Compute | Google Cloud Run Jobs | Region: `europe-west1`, single container execution |
| Scheduling | Google Cloud Scheduler | Cron: `*/30 8-22 * * *` (every 30 min, 08:00–22:00 UTC) |
| CI/CD | Google Cloud Build | `cloudbuild.yaml` → Docker build + push to GCR |
| Secrets | GCP Secret Manager | LinkedIn cookies, MongoDB URI, SMTP credentials |
| Email | Gmail SMTP via nodemailer ^7.0.11 | App Password auth via `JOBBOT_SMTP_PASS` |
| Container | Docker | Image: `gcr.io/$PROJECT_ID/jobbot-image` |
| Distributed Lock / Atomic Flags | @google-cloud/storage ^7.14.0 | GCS lock file (`ifGenerationMatch:0`) + exactly-once quota alert flag |
| HTTP Client | axios ^1.13.2 | With cookie jar support (`axios-cookiejar-support` ^6.0.5) for Workday |
| Cookie Management | tough-cookie ^6.0.0 | Workday PLAY_SESSION / wday_vps_cookie management |
| HTML Parsing | cheerio ^1.1.2 | Available in deps but not actively used in core pipeline |
| Environment | dotenv ^16.6.1 | `.env` loading for local development only |
| DB Driver | mongodb ^6.0.0 | Native MongoDB driver for Atlas connection |

---

## 3. Architecture Overview

### High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloud Run Job Container                       │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ ats/orchestrator.js  (Entry Point — CMD in Dockerfile)       │    │
│  │                                                               │    │
│  │  Phase 0: Pre-load                                            │    │
│  │  ├── createStorageAdapter() ──► MongoStorageAdapter            │    │
│  │  └── storageAdapter.loadSentHistory() ──► knownJobIds (Set)   │    │
│  │                                                               │    │
│  │  PARALLEL PHASE (Promise.allSettled):                         │    │
│  │  ├── Phase 1: ATS Workers (Promise.all — true parallel)      │    │
│  │  │   ├── comeetWorker.js ──► Comeet API (token-based)        │    │
│  │  │   │   ├── Silent dedup via knownJobIds ──► skip           │    │
│  │  │   │   ├── filterJob() ──► Location + Title + Department   │    │
│  │  │   │   ├── evaluateStructuredGate() ──► Fast-track         │    │
│  │  │   │   └── evaluateAtsGuard() ──► Title/Dept/Description   │    │
│  │  │   ├── greenhouseWorker.js ──► Greenhouse Public API       │    │
│  │  │   │   ├── Silent dedup via knownJobIds ──► skip           │    │
│  │  │   │   ├── filterJob() ──► Location + Title + Department   │    │
│  │  │   │   └── evaluateAtsGuard() ──► Title/Dept/Description   │    │
│  │  │   └── workdayWorker.js ──► Workday Session API            │    │
│  │  │       ├── Session init (cookie jar + Akamai settle)       │    │
│  │  │       ├── detectLocationFacet() ──► Israel facet ID       │    │
│  │  │       ├── Paginate with searchText="Israel"               │    │
│  │  │       └── evaluateAtsGuard() ──► Title/Dept/Description   │    │
│  │  │                                                            │    │
│  │  └── Phase 2: LinkedIn Scraper (scraper.js)                  │    │
│  │      ├── Multi-query search (16 boolean queries × 4 pages)   │    │
│  │      ├── seenIds dedup ──► skip already-seen                 │    │
│  │      ├── fetchJobDetails() ──► GraphQL enrichment per job    │    │
│  │      └── passesFilters() ──► Blacklist + Whitelist title     │    │
│  │                                                               │    │
│  │  Phase 3: Deduplication                                       │    │
│  │  └── JobStateService.filterNewJobs() ──► ats_sent_history    │    │
│  │                                                               │    │
│  │  Phase 4: Email Notification                                  │    │
│  │  ├── Gatekeeper: newJobs>0 OR errors>0 OR isHeartbeatHour   │    │
│  │  └── EmailNotifier.sendUnifiedReport() ──► Gmail SMTP        │    │
│  │                                                               │    │
│  │  Phase 5: Persist State                                       │    │
│  │  ├── JobStateService.persistState() ──► ats_sent_history     │    │
│  │  │   └── FAIL-FAST: throws on error ──► rollback if needed   │    │
│  │  └── writeCalibrationPassed() ──► calibration_passed         │    │
│  │                                                               │    │
│  │  Teardown:                                                    │    │
│  │  ├── storageAdapter.close() in finally block                  │    │
│  │  └── setTimeout(process.exit, 5000).unref() fail-safe        │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  Storage: MongoStorageAdapter ──► MongoDB Atlas (M0 Free Tier)       │
│  Database: jobbot_db                                                  │
│  Collections: seen_jobs, ats_sent_history, companies,                │
│               calibration_rejected, calibration_passed, run_summaries │
│                                                                       │
│  ❌ NO WRITES to run_logs (constant removed, gate hardcoded)          │
│  ❌ NO WRITES to enriched_jobs (method deleted from all layers)       │
│  ❌ NO NODE_ENV dependency (all gates are hardcoded)                  │
└─────────────────────────────────────────────────────────────────────┘

     Cloud Scheduler (*/30 8-22 * * *)
              │
              ▼
     Cloud Run Job execution trigger
              │
              ▼
     node ats/orchestrator.js
```

### Calibration & Quota Resilience Control Path (v7.1)

Within `runAtsWorkers()`, calibration is now an explicit post-summary control path with distributed locking and fail-safe behavior:

1. `checkVolumeTrigger(storageAdapter)` compares logical DB size (`dataSize + indexSize`) to `VOLUME_THRESHOLD_BYTES` (200MB). The threshold is intentionally well below the Atlas 512MB cap so the job can materialize the markdown report in memory before any aggressive purge runs.
2. Trigger condition is `volumeTriggered || timeTriggered` (7-day cadence fallback).
3. `GcsCalibrationLock.acquireLock()` is attempted first (`GCS_LOCK_BUCKET` path) with Mongo `system_state` fallback in local/no-bucket scenarios.
4. On successful lock acquire: generate markdown report first; volume triggers then run `runVolumeCleanupProtocol({ mode: 'aggressive' })` (delete all `calibration_rejected` + `calibration_passed`); then send calibration email (report attached); then update timer.
5. Quota error `code=8000` is handled in top-level `run().catch`: `handleQuotaExhaustion()` sends exactly one emergency alert via atomic GCS flag and exits with `process.exit(0)` to prevent Cloud Run retry loops.

### Phase Timing & Parallelism

| Phase | Name | Parallelism | File:Line | Description |
|-------|------|-------------|-----------|-------------|
| 0 | Load knownJobIds | Sequential (before parallel) | `orchestrator.js:601-603` | `const knownJobIds = await storageAdapter.loadSentHistory()` (or empty Set if `RESET_DEDUP=true`) |
| 1+2 | ATS + LinkedIn | **True Parallel** via `Promise.allSettled` | `orchestrator.js:611-614` | Total runtime = max(ATS, LinkedIn), not sum |
| 1 | ATS Workers | **Parallel** via `Promise.all` (Comeet ‖ Greenhouse ‖ Workday) | `orchestrator.js:230-295` | Three batch branches with isolated error collection |
| 2 | LinkedIn | Parallel with Phase 1 | `orchestrator.js:611-614` | Sequential internally (query → paginate → enrich) |
| 2.5 | Calibration Trigger Path | Sequential (inside ATS phase) | `orchestrator.js:314-415` | Trigger gate + lock acquire + report + (volume purge) + calibration email + timer reset + lock release |
| 3 | Deduplication | Sequential | `orchestrator.js:656` | `jobStateService.filterNewJobs(allJobs)` via `deduplicateJobs()` |
| 4 | Email | Sequential | `orchestrator.js:659` | `emailNotifier.sendUnifiedReport(newJobs, errors)` |
| 5 | Persist | Sequential | `orchestrator.js:662` | `jobStateService.persistState()` |
| 5b | Calibration Passed Write | Sequential | `orchestrator.js:664-672` | `storageAdapter.writeCalibrationPassed(newJobs)` after successful report email |

---

## 4. File Map

### `ats/` — Orchestrator & Core Pipeline

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `ats/orchestrator.js` (733 lines) | Entry point. Runs ATS+LinkedIn in parallel, owns calibration trigger flow with lock/report/purge/email sequencing, and enforces quota fail-safe exit masking. | `{ run }` | `services/storage`, `services/JobStateService`, `services/EmailNotifier`, `services/calibration/calibrationReport`, `services/lock/GcsCalibrationLock`, `services/emergency/gcsAlertManager`, all workers, `linkedin_client`, `mailer`, `config/paths` |
| `ats/config/companiesConfig.js` (22 lines) | Thin wrapper around `StorageAdapter.loadCompanies()` | `{ loadCompaniesConfig, COMPANIES_FILE }` | `path` |

### `ats/workers/` — ATS Source Workers

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `ats/workers/comeetWorker.js` (923 lines) | Fetches jobs from Comeet token-based API v1.0. Implements silent dedup, filterJob, structured gate, ATS guard. Has its own `passesLocationGate()` and `passesDepartmentGate()`. | `{ ComeetWorker }` | `httpClientWrapper`, `ats_guard`, `structuredGate`, `config/paths` |
| `ats/workers/greenhouseWorker.js` (695 lines) | Fetches jobs from Greenhouse public boards API (`/v1/boards/{uid}/jobs?content=true`). Implements silent dedup, filterJob, ATS guard. | `{ GreenhouseWorker }` | `httpClientWrapper`, `ats_guard`, `config/paths` |
| `ats/workers/workdayWorker.js` (747 lines) | Session-based Workday scraper. Establishes PLAY_SESSION cookie, detects Israel location facet dynamically, paginates with dual filter strategy (searchText + facet). New worker instance per company. | `{ WorkdayWorker, createWorkdayWorker }` | `axios`, `tough-cookie`, `axios-cookiejar-support`, `ats_guard`, `config/paths` |

### `ats/filters/` — Filter Gates

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `ats/filters/ats_guard.js` (214 lines) | Three-tier seniority/relevance guard: title check → department check → description check. Extracts fields from both Greenhouse and Comeet raw payloads. | `{ evaluateAtsGuard }` | `config/vocabulary` |
| `ats/filters/structuredGate.js` (34 lines) | Fast-track using Comeet's `structuredSignals.experience_level` and `employment_type`. FAIL on seniority regex, WHITELIST on student/intern regex, CONTINUE otherwise. | `{ evaluateStructuredGate }` | None |

### `ats/utils/` — HTTP & Utility Layer

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `ats/utils/httpClient.js` (53 lines) | Creates Axios instance with `maxRedirects: 0`. Interceptor warns on 302/303. Provides `requestWithDelay(config, minMs, maxMs)`. | `{ createHttpClient, randomDelay }` | `axios` |
| `ats/utils/httpClientWrapper.js` (210 lines) | Enhanced wrapper with exponential backoff retry logic. Supports per-provider rate limiting (Comeet). Handles 429 (Retry-After or backoff 15s→120s), 5xx (5s→30s), timeout (5s→20s). | `{ requestWithDelayWrapper, requestWithRetry, getRateLimiter }` | `rateLimiter` |
| `ats/utils/rateLimiter.js` (59 lines) | Simple token bucket rate limiter. `createComeetRateLimiter()` defaults to 9-11s randomized interval. | `{ RateLimiter, createComeetRateLimiter }` | None |
| `ats/utils/normalizeJob.js` (68 lines) | Normalize Comeet/Greenhouse raw job → `{ jobId, source, sourceCompanyId, title, location, url, description, raw }`. Used by orchestrator-level `processBatch()`. | `{ normalizeJob }` | None |
| `ats/utils/locationGate.js` (53 lines) | Israel city list + "Remote" exact-match gate. Accepts: Israel keyword, 13 Israeli cities, exact "Remote". Rejects: "Remote - USA", "Remote - UK", etc. | `{ passesLocationGate }` | None |
| `ats/utils/semanticGate.js` (10 lines) | Thin delegate to `filters_shared.titlePassesSemanticFilters()`. | `{ passesSemanticGate }` | `filters_shared` |
| `ats/utils/comeetRunConfig.js` (63 lines) | Batch pause configuration. Parses `COMEET_BATCH_SIZE`, `COMEET_BATCH_PAUSE_MIN/MAX_MS` from env. Provides `randomDelay()` helper. | `{ parseBatchPauseConfig, mergeBatchPauseConfig, randomDelay }` | None |

### `services/` — Business Logic Services

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `services/JobStateService.js` (135 lines) | Deduplication service. `filterNewJobs()` loads history, returns only new jobs, tracks pending IDs. `persistState()` merges pending → history and calls `storageAdapter.persistSentHistory()` (fail-fast: throws). `rollback()` clears pending on email failure. | `{ JobStateService, createJobStateService }` | StorageAdapter |
| `services/EmailNotifier.js` (308 lines) | Unified email report generator. Maps jobs to legacy format with source labels, generates HTML cards with Apply buttons, handles error summaries, "no jobs" display. Uses Gmail SMTP via nodemailer. | `{ EmailNotifier, createEmailNotifier }` | `nodemailer`, `dotenv` |

### `services/storage/` — Storage Adapter Layer

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `services/storage/StorageAdapter.js` (136 lines) | Abstract interface defining the storage contract. All methods are async. Adds default no-op/empty implementations for calibration/report helpers (`writeCalibrationRejected`, `writeCalibrationPassed`, `getCalibrationRejectedAggregated`) and keeps `close()` as no-op by default. | `{ StorageAdapter }` | None |
| `services/storage/MongoStorageAdapter.js` (782 lines) | MongoDB Atlas implementation. 7 collection constants including `SYSTEM_STATE`; bounded TTL strategy (60d/60d/30d/90d/180d), logical quota sizing (`getDbQuotaBytes()`), cleanup modes (`aggressive`, `retention24h`, `legacy7d`), lock APIs (`acquireCalibrationLock`, `releaseCalibrationLock`), and fail-fast `persistSentHistory()`. | `{ MongoStorageAdapter }` | `mongodb`, `StorageAdapter` |
| `services/storage/FileStorageAdapter.js` (390 lines) | Local file-based implementation. Reads/writes JSON under `data/`. Merges `companies_list.json`, `comeet_companies_auto.json`, `greenhouse_list.csv`, `workday_companies.json`. The only code path that uses `csv-parser`. | `{ FileStorageAdapter }` | `fs`, `path`, `csv-parser` (optional), `StorageAdapter`, `config/paths` |
| `services/storage/index.js` (30 lines) | Factory function `createStorageAdapter()`. Selects adapter based on `STORAGE_BACKEND` env var or presence of `MONGODB_URI`. | `{ createStorageAdapter, FileStorageAdapter, MongoStorageAdapter }` | Both adapters |

### `services/lock/` — Distributed Coordination

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `services/lock/GcsCalibrationLock.js` (210 lines) | Distributed calibration lock using GCS object preconditions (`ifGenerationMatch: 0`) with stale-lock cleanup and Mongo lock fallback when `GCS_LOCK_BUCKET` is unset. | `{ acquireLock, releaseLock, cleanupStaleLock, isPreconditionFailed }` | `@google-cloud/storage` |

### `services/emergency/` — Quota Exhaustion Safeguards

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `services/emergency/gcsAlertManager.js` (119 lines) | Exactly-once quota exhaustion emergency alerting via atomic GCS flag creation; exposes `isQuotaExhaustedError` and `handleQuotaExhaustion`. | `{ isQuotaExhaustedError, handleQuotaExhaustion, DEFAULT_FLAG_PATH }` | `@google-cloud/storage`, `mailer` |

### `config/` — Configuration

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `config/paths.js` (68 lines) | Centralized filesystem layout. `PATHS.ROOT`, `PATHS.DATA`, `PATHS.LINKEDIN.*`, `PATHS.ATS.*` with per-provider subdirectories (Comeet, Greenhouse). | `{ PATHS }` | `path` |
| `config/vocabulary.js` (100 lines) | ATS filter vocabulary. `departmentsBlacklist` (7), `allowedTechnicalDepartments` (4), `technicalTitleKeywords` (14), `titleSeniorPatterns` (15 regex), `contentSeniorityPatterns` (14 regex), `companyOverrides` (empty). | All listed | None |

### Root-Level Modules

| File Path | Purpose | Key Exports | Dependencies |
|-----------|---------|-------------|-------------|
| `filters_shared.js` (298 lines) | Shared blacklist (~200 keywords) / whitelist (32 keywords) and `titlePassesSemanticFilters()`. Used by both LinkedIn scraper and ATS semantic gate. Phase 5.3 Strict Junior additions (2026-03-07). No side effects. | `{ BLACKLIST_KEYWORDS, WHITELIST_KEYWORDS, titlePassesSemanticFilters }` | None |
| `linkedin_client.js` (570 lines) | LinkedIn Voyager API client. `fetchJobs()` for paginated search, `fetchJobDetails()` for GraphQL enrichment. Centralized `axiosClient` with `maxRedirects: 0` and global 302/303 interceptor. `LinkedInAuthChallengeError` class. | `{ getHeaders, fetchJobs, normalizeResponse, fetchJobDetails, LinkedInAuthChallengeError }` | `axios`, `services/notifications/TelegramAdminNotifier` |
| `scraper.js` (525 lines) | LinkedIn multi-query scraper. Defines 16 search queries (`SEARCH_QUERIES`) across 11 niches + 4 clusters + 1 data science query. Paginated search (4 pages × 25 results each), per-job enrichment, binary title filter. Daily cap: 500 new jobs. | `{ runLinkedinScraper }` | `linkedin_client`, `mailer`, `filters_shared`, `services/storage` |
| `mailer.js` | Legacy LinkedIn email report sender. `sendJobReport()` generates HTML card-based email — used only by the standalone `scraper.js` path. Critical-alert email path has been removed; control-plane alerts now use `services/notifications/TelegramAdminNotifier.js`. | `{ sendJobReport }` | `nodemailer`, `dotenv` |
| `services/notifications/TelegramAdminNotifier.js` | Admin/control-plane notifier via Telegram Bot API. `sendAlert(severity, title, details)` posts severity-tagged HTML messages (CRITICAL/WARNING/INFO with `<pre>` payload). `sendCalibrationAlert(subject, md, triggerType)` uploads the markdown report as a document via `sendDocument` (multipart/form-data, `knownLength` set to avoid Cloud Run chunking). Dedicated Bottleneck limiter (~1.1s). Reads `TELEGRAM_BOT_TOKEN` + `ADMIN_CHAT_ID`. Never throws. | `{ TelegramAdminNotifier, createTelegramAdminNotifier }` | `axios`, `bottleneck`, `form-data`, `dotenv` |

### `tools/` — Development & Debugging Tools (excluded from Docker)

| File Path | Purpose |
|-----------|---------|
| `tools/analyze_logs.js` | Log analysis utility |
| `tools/reset_data.js` | Data reset utility |
| `tools/run_proactive_calibration.js` | **Proactive calibration CLI.** Safe mode: generates MD report to `docs/analyze/`, shows would-delete counts. `--confirm`: runs `runVolumeCleanupProtocol({ mode: 'aggressive' })`, then updates `system_state.calibration_timer`. |
| `tools/emergency_purge.js` | Direct emergency nuke utility for `calibration_rejected` + `calibration_passed` when report generation is too heavy under quota pressure. |
| `tools/verify_calibration_lock_and_purge.js` | Verification suite for lock acquire/release, stale-lock stealing, exclusivity, and aggressive purge behavior. |
| `tools/comeet_hunter.js` | Single Comeet company discovery |
| `tools/comeet_hunter_mass.js` | Mass Comeet company discovery |
| `tools/comeet/harvest_tokens.js` | Puppeteer token harvester. Fetches Comeet tokens from `window.COMPANY_DATA`. On failure: sets `enabled: false` in MongoDB (prevents infinite retry loops from Perplexity hallucinations). |
| `tools/run_comeet_debug.js` | Debug mode runner for Comeet |
| `tools/clean_comeet_debug_logs.js` | Clean up debug log artifacts |
| `tools/add_comeet_company.js` | Add company to Comeet config |
| `tools/inject_and_validate.js` | Workday/Greenhouse HTTP validation only. **Cannot** handle Comeet (requires harvest_tokens.js for token ecosystem). |
| `tools/sample_raw_ats_data.js` | Sample raw ATS data collector |
| `tools/discovery/local_ui_discovery.js` | Perplexity UI automation for company discovery |
| `tools/discovery/run_discovery.js` | Discovery pipeline runner |

### `services/calibration/` — Calibration Report Generation

| File Path | Purpose |
|-----------|---------|
| `services/calibration/calibrationReport.js` (499 lines) | `checkVolumeTrigger()`, `runVolumeCleanup()`, `generateCalibrationReportMd()`, `runCalibrationAndNotify()`. Defines 200MB `VOLUME_THRESHOLD_BYTES` (headroom for report-before-purge) and fail-fast cleanup contract. |

---

## 5. MongoDB Collections

### Active Collections (7)

| Collection | Purpose | Key Fields | TTL | Write Method | Read Method |
|-----------|---------|-----------|-----|-------------|------------|
| `seen_jobs` | LinkedIn dedup memory — tracks every job ID ever seen in search results | `_id` (jobId), `source: 'linkedin'`, `firstSeenAt` ($setOnInsert), `lastSeenAt` ($set), `createdAt` ($setOnInsert) | **90 days** (TTL index on `createdAt`) | `saveSeenJobIds(ids)` — `bulkWrite` with `upsert: true`, `ordered: false` | `loadSeenJobIds()` — `find({}).toArray()` → `Set<string>` from `_id` |
| `ats_sent_history` | ATS+LinkedIn dedup — job IDs that were successfully emailed | `_id` (jobId), `sentAt` ($setOnInsert), `lastUpdatedAt` ($set), `createdAt` ($setOnInsert), `...metadata` | **180 days** (TTL index on `createdAt`) | `persistSentHistory(ids, metadata)` — `bulkWrite` with `upsert: true`, `ordered: false`. **FAIL-FAST: throws on error** | `loadSentHistory()` — `find({}).toArray()` → `Set<string>` from `_id` |
| `companies` | ATS company configs (pre-seeded via manual insert) | `_id`, `name`, `type` (comeet/greenhouse/workday), `uid`, `token`, `url`, `apiBaseUrl`, `enabled` | None (static) | Manual seed | `loadCompanies()` — `find({ enabled: { $ne: false } }).toArray()` |
| `calibration_rejected` | Lightweight metadata of jobs rejected by business-logic filters. For filter tuning analysis. | `jobId`, `title`, `companyName`, `location`, `url`, `reason`, `source`, `createdAt` | **60 days** (TTL index on `createdAt`) | `writeCalibrationRejected(jobs)` — `insertMany(docs, { ordered: false })` | Manual Atlas query (filter by `reason` for tuning) |
| `calibration_passed` | Lightweight metadata of jobs that passed all filters and were emailed | `jobId`, `title`, `companyName`, `location`, `url`, `source`, `createdAt` | **60 days** (TTL index on `createdAt`) | `writeCalibrationPassed(jobs)` — `insertMany(docs, { ordered: false })` | Manual Atlas query |
| `run_summaries` | Per-run execution statistics for observability | `runId`, `source` (ats/comeet/greenhouse/linkedin), `type: 'summary'`, `timestamp`, `payload` (full stats), `createdAt` | **30 days** (TTL index on `createdAt`) | `writeRunLog({ type: 'summary', ... })` — `insertOne(doc)` | Manual Atlas query |
| `system_state` | Calibration timer + fallback lock state | `_id`, `lastCalibrationAt` (`calibration_timer`), `isLocked`, `ownerId`, `expiresAt` (`calibration_lock`) | None | `updateLastCalibrationTime()`, `acquireCalibrationLock()`, `releaseCalibrationLock()` | `getLastCalibrationTime()` |

### TTL Index Configuration

Created automatically on first connection via `MongoStorageAdapter._ensureTTLIndexes()`:

| Collection | Index Field | TTL Seconds | TTL Days |
|-----------|-------------|-------------|----------|
| `seen_jobs` | `createdAt` | 7,776,000 | 90 days |
| `ats_sent_history` | `createdAt` | 15,552,000 | 180 days |
| `calibration_rejected` | `createdAt` | 5,184,000 | 60 days |
| `calibration_passed` | `createdAt` | 5,184,000 | 60 days |
| `run_summaries` | `createdAt` | 2,592,000 | 30 days |

### Eradicated Collections

| Collection | Status | Evidence | Why Removed |
|-----------|--------|----------|------------|
| `run_logs` | **DEAD** | No `RUN_LOGS` constant in `MongoStorageAdapter.js:26-33`. `writeRunLog()` has hardcoded gate: `if (type !== 'summary') { return; }` at `MongoStorageAdapter.js:434`. | Accumulated thousands of `runtime`, `error`, and `raw` documents per run (~6.7MB/day). Replaced by console-only logging + summary-only DB writes. |
| `enriched_jobs` | **DEAD** | `writeEnrichedJobs()` deleted from all 3 adapter layers. Zero function calls remain in active code. Only reference is comment at `orchestrator.js:97`. | Stored full raw API responses + HTML descriptions (2-10KB each). Each run wrote hundreds of docs, rapidly consuming 512MB M0 quota. Replaced by `calibration_passed` (lightweight ~200 bytes/doc). |

**Ghost Writer Warning:** If these collections reappear in Atlas, it means a stale Cloud Run deployment is running old code. Resolution: `gcloud run jobs deploy jobbot-runner --source . --region europe-west1`.

---

## 6. Storage Adapter Pattern

### Abstract Interface (`services/storage/StorageAdapter.js`)

Every method is `async`. Default implementations throw for required methods and no-op for optional ones.

| Method Signature | Required | Default |
|-----------------|----------|---------|
| `loadSeenJobIds()` → `Promise<Set<string>>` | Yes | throws |
| `saveSeenJobIds(ids: Set<string>)` → `Promise<void>` | Yes | throws |
| `hasSeenJob(jobId: string)` → `Promise<boolean>` | No | Loads + checks |
| `markJobSeen(jobId: string, source: string)` → `Promise<void>` | No | Loads + adds + saves |
| `loadSentHistory()` → `Promise<Set<string>>` | Yes | throws |
| `persistSentHistory(ids: Set<string>, metadata?: Object)` → `Promise<void>` | Yes | throws |
| `loadCompanies()` → `Promise<Array<Object>>` | Yes | throws |
| `writeRunLog(entry: { type, source, timestamp, payload })` → `Promise<void>` | Yes | throws |
| `writeCalibrationRejected(jobs: Array<Object>)` → `Promise<void>` | No | no-op |
| `writeCalibrationPassed(jobs: Array<Object>)` → `Promise<void>` | No | no-op |
| `getCalibrationRejectedAggregated(limit?: number)` → `Promise<Array<Object>>` | No | empty array |
| `upsertCompany(company: Object)` → `Promise<void>` | Yes | throws |
| `close()` → `Promise<void>` | No | no-op |

### `FileStorageAdapter` — Local Development

- Reads/writes JSON files under `PATHS.DATA` (`data/`)
- `loadSeenJobIds()` → `data/seen_jobs.json` (JSON array)
- `loadSentHistory()` → `data/ats_sent_jobs_history.json` (JSON: `{ sentJobIds: [...], lastUpdated, totalCount }`)
- `loadCompanies()` → Merges 4 sources in parallel: `companies_list.json`, `comeet_companies_auto.json`, `greenhouse_list.csv`, `workday_companies.json`
- `writeRunLog()` → Routes to `logs/` subdirectories by source and type
- `writeCalibrationRejected()` and `writeCalibrationPassed()` → inherited no-op (file adapter doesn't write calibration data)
- `close()` → inherited no-op (no connections to close)
- The ONLY code path that uses `csv-parser` (devDependency) for Greenhouse CSV parsing. Falls back to manual line-by-line parsing if `csv-parser` is unavailable.

### `MongoStorageAdapter` — Cloud Production

- Connects to MongoDB Atlas via `MongoClient` with `maxPoolSize: 10`, `minPoolSize: 1`, `serverSelectionTimeoutMS: 5000`
- Lazy connection: `_ensureConnected()` called before every operation
- Database name extracted from URI path or defaults to `jobbot_db`
- 7 collection constants (`SEEN_JOBS`, `ATS_SENT_HISTORY`, `COMPANIES`, `CALIBRATION_REJECTED`, `CALIBRATION_PASSED`, `RUN_SUMMARIES`, `SYSTEM_STATE`)
- TTL indexes created on first connection (non-blocking, `_ensureTTLIndexes()`) for 60d/60d/30d/90d/180d lifecycle bounds
- `getDbQuotaBytes()` reads logical usage via `dbStats.dataSize + dbStats.indexSize` (used by volume trigger)
- `runVolumeCleanupProtocol(options)` supports `aggressive`, `retention24h`, `legacy7d`; throws on Mongo errors (fail-fast)
- `acquireCalibrationLock()` / `releaseCalibrationLock()` provide Mongo fallback distributed lock semantics in `system_state`
- `_stripJobForCalibration(job)` strips heavy payload fields while preserving calibration observability fields
- `persistSentHistory()`: **FAIL-FAST** — catches error, logs it, then re-throws (`MongoStorageAdapter.js:238-245`)
- `close()`: Closes `MongoClient` connection, sets `connected = false`

### Factory Function (`services/storage/index.js`)

```
function createStorageAdapter():
  if (STORAGE_BACKEND === 'mongo') OR (MONGODB_URI is set):
    if (!MONGODB_URI):
      throw Error('STORAGE_BACKEND=mongo requires MONGODB_URI')
    return new MongoStorageAdapter(MONGODB_URI)
  else:
    return new FileStorageAdapter()  // Default: local dev
```

---

## 7. Factory Pattern & State Management

### Factory Functions

| Factory | File | Signature | Returns |
|---------|------|-----------|---------|
| `createStorageAdapter()` | `services/storage/index.js` | `()` → `StorageAdapter` | `FileStorageAdapter` or `MongoStorageAdapter` based on env |
| `createJobStateService(storageAdapter)` | `services/JobStateService.js` | `(StorageAdapter)` → `JobStateService` | New instance with adapter reference |
| `createEmailNotifier()` | `services/EmailNotifier.js` | `()` → `EmailNotifier` | New instance (lazy transport init) |
| `createComeetRateLimiter()` | `ats/utils/rateLimiter.js` | `()` → `RateLimiter` | 9-11s randomized interval |
| `createWorkdayWorker(company)` | `ats/workers/workdayWorker.js` | `(company)` → `WorkdayWorker` | New instance per company |
| `createHttpClient()` | `ats/utils/httpClient.js` | `()` → `{ client, requestWithDelay }` | Axios instance with `maxRedirects: 0` |

### Why Singletons Were Eliminated

Cloud Run Jobs can reuse warm containers across invocations. Module-level singletons would leak state (job IDs, connection handles, error counts) between runs. All services are instantiated fresh inside `run()`:

- `orchestrator.js:575` → `createStorageAdapter()`
- `orchestrator.js:648` → `createJobStateService(storageAdapter)`
- `orchestrator.js:649` → `createEmailNotifier()`

### Orchestrator-Level Calibration (Removed)

The orchestrator no longer maintains a `filteredJobsBuffer`. Workers persist their own dropped jobs to `calibration_rejected` directly. Orchestrator-level semantic/location drops are handled by workers before jobs reach the orchestrator.

### Worker Instance Patterns

- **Comeet & Greenhouse:** Single worker instance shared across all companies of that type. Created once before `Promise.all`. `resetRunStats()` called before batch.
- **Workday:** New `WorkdayWorker` instance per company (`orchestrator.js:228`) because each company has a different tenant/instance/site URL requiring separate cookie jars and API endpoints.

---

## 8. Filter Pipeline

### ATS Jobs: Full Pipeline (Comeet, Greenhouse, Workday)

```
Raw ATS API Response (all jobs for a company)
  │
  ├── [Step 0] Silent Dedup (Comeet + Greenhouse only)
  │     ├── Build jobId: comeet_{position_uid} or greenhouse_{id}
  │     ├── Check: knownJobIds.has(jobId)
  │     │   ├── YES → stats.skippedDedup++; continue (NO calibration write)
  │     │   └── NO → proceed
  │     └── Source: comeetWorker.js:750-757, greenhouseWorker.js:531-539
  │         NOTE: Workday does NOT receive knownJobIds
  │
  ├── [Step 1] Worker-Level Business Logic Filter (filterJob)
  │     ├── Location Gate:
  │     │   ├── Comeet: locObj.country === 'IL' OR name/city contains 'remote'
  │     │   ├── Greenhouse: location string contains Israel cities or 'remote'
  │     │   └── Workday: searchText="Israel" server-side + optional facet + client-side matchesIsrael()
  │     ├── Title Gate: Local blacklist check (senior, sr., vp, director, head of, lead, manager)
  │     └── Department Gate: Local blacklist (sales, legal, finance, hr, marketing)
  │         Exception: "Product Marketing" is allowed
  │
  ├── [Step 2] Normalize → UnifiedJob
  │     ├── Comeet: normalizeComeetJob() → { jobId: 'comeet_{uid}', source, title, location, url, description, raw, structuredSignals }
  │     ├── Greenhouse: normalizeGreenhouseJob() → { jobId: 'greenhouse_{id}', source, title, location, url, description, raw }
  │     └── Workday: _normalizeJob() → { jobId: 'workday_{tenant}_{JR or id}', source, title, location, url, raw }
  │
  ├── [Step 3] Structured Gate (Comeet ONLY — structuredGate.js)
  │     ├── Reads: job.structuredSignals.experience_level, job.structuredSignals.employment_type
  │     ├── FAIL: experience_level matches /\b(senior|lead|staff|principal|director|executive|manager|head\sof|vp|vice\spresident)\b/i
  │     ├── WHITELIST: employment_type matches /\b(student|internship|intern)\b/i → skip ATS Guard, add to results
  │     └── CONTINUE: proceed to ATS Guard
  │
  ├── [Step 4] ATS Guard (ats_guard.js — all three sources)
  │     ├── Tier 1 — Title Check (cheap):
  │     │   ├── Must match at least one technicalTitleKeyword (14 terms from vocabulary.js)
  │     │   │   e.g.: engineer, developer, devops, sre, data engineer, qa engineer, security engineer, salesforce
  │     │   └── Must NOT match any titleSeniorPattern (15 regex patterns from vocabulary.js)
  │     │       e.g.: /\bSenior\b/i, /\bSr\.?\b/i, /\bStaff\b/i, /\bLead\b/i, /\bManager\b/i, /\bDirector\b/i
  │     │
  │     ├── Tier 2 — Department Check (medium cost — only if title passes):
  │     │   └── Must NOT be in departmentsBlacklist (7 entries: Sales, New Business, Corporate Strategy, Customer Org, Human Resources, Finance, Product Management)
  │     │
  │     └── Tier 3 — Description Check (expensive — only if title+dept pass):
  │         ├── Normalizes HTML → plain text (entity decoding, tag stripping)
  │         └── Must NOT match any contentSeniorityPattern (14 regex)
  │             e.g.: /\b[3-9]\s*\+?\s*(?:years|yrs)\b/i, /experienced team leader/i
  │
  └── [Final] PASS → UnifiedJob added to worker results, flows to Phase 3 dedup
```

### LinkedIn Jobs: Pipeline

```
LinkedIn Voyager Search Response (per query per page)
  │
  ├── normalizeResponse() → extract jobs from Voyager elements + included map
  │
  ├── [Step 0] seenIds Dedup
  │     ├── Check: seenIds.has(job.jobId)
  │     │   ├── YES → filteredJobsLog.push(AlreadySeen); continue
  │     │   └── NO → mark seenIds.add(job.jobId); proceed
  │     └── Source: scraper.js:325-337
  │
  ├── [Step 1] Enrich via GraphQL
  │     ├── fetchJobDetails(jobId) → description, applyUrl, skills, employmentType, listedAt, appliesCount, isRepost
  │     ├── Delay: randomDelay(3000, 6000) between each enrichment call
  │     └── On 404: return empty details (job expired). On 429: throw (caller handles).
  │
  ├── [Step 2] Binary Title Filter (passesFilters in scraper.js:99-152)
  │     ├── BLACKLIST_KEYWORDS scan (147 keywords, case-insensitive substring match)
  │     │   └── ANY match → DROP (reason: "Blacklist")
  │     ├── WHITELIST_KEYWORDS scan (32 keywords, case-insensitive substring match)
  │     │   └── NONE match → DROP (reason: "Whitelist")
  │     └── Source: filters_shared.js:229-248 via scraper.js:99-152
  │
  ├── [Step 3] Daily Quota Check
  │     └── allNewJobs.length >= 500 (DAILY_NEW_JOBS_LIMIT, scraper.js:84) → stop scraping
  │
  └── [Final] PASS → enriched job added to allNewJobs, flows to Phase 3 dedup
```

### BLACKLIST_KEYWORDS Detail

| Property | Value |
|----------|-------|
| **Count** | ~200 keywords (Phase 5.3 Strict Junior additions 2026-03-07) |
| **Source** | `filters_shared.js:12-244` |
| **Categories** | Seniority & Leadership (13): Senior, Lead, Principal, Manager, Head of, Director, VP, Chief, Architect, 5-8+ years |
| | Marketing & Sales (13): Sales, Sale, Marketing, Marketer, Media, Buyer, B2B, PPC, Campaign, Creative, Digital, Social Media, SEO |
| | Finance & Accounting (13): Finance, Financial, Accounting, Accountant, Controller, CPA, Audit, Auditor, Bookkeeper, Payroll, Tax, Economics, Economist |
| | Non-Technical / Operations (12): HR, Human Resources, Recruiter, Talent, Office, Admin, Secretary, Assistant, Customer Success, CSM, Support Representative, Call Center |
| | Specific Noise (5): Language Analyst, Online Data Analyst, Content Writer, Copywriter, Translator |
| | Hebrew (10): שיווק, מכירות, כספים, כלכלה, מנהל חשבונות, חשב, מזכירה, אדמיניסטרציה, משאבי אנוש, גיוס |
| | Hardware / Non-Software (18): Mechanical, Mechatronics, Electrical, Electronics, Power Engineer, Analog, ASIC, VLSI, Hardware, Lawyer, Attorney, Legal, Help Desk, Support Specialist, Instructional Designer, Biotechnology, Assembler, Operator |
| | QA Phase 5 additions (8): Plumbing, Materials, Process Engineer, RTL, Chip Design, Static Timing, STA Engineer, Real Estate, Pricing, Credit, Ads Assessor, Inspector, Technician |
| | Phase 5.2 Hardware & Non-Tech (22): Optics, Electro-Optical, Optical, Board Design, Circuit, Equipment Engineer/Engineering, Failure Analysis, Physical Design, Solidworks, Mechanic, Physics, Investment Banking, Broker, Trader, Recruitment, Talent Acquisition, Marcom, Writer, Content, Planner, Urban, Transport, Graphic Design, Co-Founder, Business Development, Technologist |
| | Phase 5.3 Data Leakage Fix (20): Assistant/Financial Controller, Dealer, Receptionist, Office Manager, Clerk, Chemist, Chemistry, Civil Engineer, Construction, Structural Engineer, FAB Operation, Industrial Engineer, Tour, Travel, Steward, Housekeeping, Beauty, SDR, Sales Development, Loss Prevention, Store Associate, Labeler |
| **STA Calibration Fix** | `filters_shared.js:109-112`: `'STA'` was removed in Phase 5.2 because it matched as a substring in "Full STAck Developer" (false positive on valid Full Stack roles). Replaced with `'Static Timing'` and `'STA Engineer'`. |

### WHITELIST_KEYWORDS Detail

| Property | Value |
|----------|-------|
| **Count** | 32 keywords |
| **Source** | `filters_shared.js:191-227` |
| **Categories** | Core tech (4): Software, Developer, Engineer, Data |
| | Analyst variants (5): Data Analyst, Business Analyst, System Analyst, Security Analyst, SOC Analyst |
| | QA/Cyber/Security (4): Scientist, QA, Quality, Cyber, Security |
| | Cloud/DevOps/Stack (4): DevOps, Cloud, Fullstack, Frontend, Backend |
| | Platform (2): Mobile, Embedded |
| | Junior signals (3): Student, Intern, Junior |
| | Research variants (4): Security Researcher, AI Researcher, ML Researcher, Research Engineer |
| | Other (4): Automation, Computer Vision, Firmware, Integrator |
| **Phase 5.3 Change** | Generic 'Analyst' replaced with specific tech variants. Generic 'Researcher' replaced with specific tech variants. |

### Vocabulary-Based Filters (`config/vocabulary.js`)

| Filter | Count | Items/Patterns |
|--------|-------|----------------|
| `departmentsBlacklist` | 7 | Sales, New Business, Corporate Strategy, Customer Org, Human Resources, Finance, Product Management |
| `allowedTechnicalDepartments` | 4 | Engineering, Development, Business Technologies, Research |
| `technicalTitleKeywords` | 14 | engineer, developer, devops, sre, software engineer, full stack, backend, front end, data engineer, data scientist, ml engineer, qa engineer, security engineer, salesforce |
| `titleSeniorPatterns` | 15 regex | Senior, Sr., Staff, Principal, Lead, Team Lead, Tech Lead, Head of, Head, Director, Manager, Account Executive, Account Director, Account Manager, Business Development |
| `contentSeniorityPatterns` | 14 regex | Generic 3+ years patterns (4), specific company phrases (7: Melio, Riskified, Gong), leadership language (3) |

---

## 9. Critical Invariants (DO NOT DEVIATE)

1. **LinkedIn `maxRedirects: 0`** — The centralized Axios client at `linkedin_client.js:100` sets `maxRedirects: 0`. The global interceptor (`linkedin_client.js:106-166`) treats ANY 302/303 as a critical auth challenge: fires `_adminNotifier.sendAlert('CRITICAL', ...)` via `services/notifications/TelegramAdminNotifier.js`, throws `LinkedInAuthChallengeError`. NEVER follow LinkedIn redirects — they indicate an auth failure, login wall, or captcha challenge. Following them makes the bot look more suspicious.

2. **ATS httpClient `maxRedirects: 0`** — The shared ATS HTTP client created by `createHttpClient()` at `ats/utils/httpClient.js:98` also sets `maxRedirects: 0` and logs warnings on 302/303 via an interceptor. Individual worker requests for Comeet and Greenhouse override to `maxRedirects: 5` in their specific request configs (`comeetWorker.js:544`, `greenhouseWorker.js:422`). Workday uses its own Axios instance (no maxRedirects override — uses axios default).

3. **ATS fetch-all-then-filter** — Workers fetch ALL jobs from a company's API endpoint first, then filter locally. No server-side title/seniority filtering (except Workday which uses `searchText: 'Israel'` for location pre-filtering). Each worker applies politeness delays between companies. Failures are logged and continued (WARN + continue pattern), never crash the overall run. Errors are collected and surfaced in the email report.

4. **MongoDB `bulkWrite` with `upsert: true`** — `saveSeenJobIds()` at `MongoStorageAdapter.js:140-157` and `persistSentHistory()` at `MongoStorageAdapter.js:201-235` both use `bulkWrite()` with `ordered: false` and `upsert: true`. For calibration writes, `insertMany()` with `ordered: false` is used (`writeCalibrationRejected()` and `writeCalibrationPassed()`).

5. **`persistSentHistory` FAIL-FAST** — At `MongoStorageAdapter.js:232-234`: the `catch` block logs the error then re-throws: `throw err`. This propagates up to `JobStateService.persistState()` at `services/JobStateService.js:117-119` which also re-throws. The orchestrator MUST know if persistence failed — otherwise it would falsely believe the job IDs were saved and never re-send those jobs.

6. **Timestamp immutability** — `$setOnInsert` is used for creation timestamps: `firstSeenAt`/`createdAt` in `saveSeenJobIds()` (`MongoStorageAdapter.js:150-153`) and `sentAt`/`createdAt` in `persistSentHistory()` (`MongoStorageAdapter.js:213-216`). Only `lastSeenAt` and `lastUpdatedAt` are in the `$set` block. NEVER place creation timestamps in `$set` — it would make every document appear "fresh" and break TTL-based cleanup.

7. **Silent dedup — skip before filter** — Workers check `knownJobIds.has(jobId)` BEFORE any normalization, filtering, or calibration write. Comeet: `comeetWorker.js:754`, Greenhouse: `greenhouseWorker.js:536`. Pattern: `if (jobId && knownJobIds && knownJobIds.has(jobId)) { stats.skippedDedup++; continue; }`. No `calibration_rejected` document is created for skipped jobs — they are pure noise elimination. Workday does NOT receive `knownJobIds` (no silent dedup).

8. **`writeRunLog` summary-only gate** — At `MongoStorageAdapter.js:325`: `if (type !== 'summary') { return; }`. Only entries with `type: 'summary'` are persisted to `run_summaries`. All other types (`runtime`, `error`, `raw`, `filtered`) return immediately with no DB write. This is hardcoded — there is NO `NODE_ENV` dependency, NO environment variable override. This ensures identical behavior in local dev and production.

9. **Teardown: `close()` in `finally` + fail-safe `process.exit`** — `orchestrator.js:618`: `storageAdapter.close()` is called in the `finally` block of `run()`, ensuring the MongoDB connection pool is released even if an error occurred. Additionally, `orchestrator.js:637`: `process.exit(process.exitCode || 0)` serves as a last-resort fail-safe after timeout.

10. **No `writeEnrichedJobs`** — This method was permanently deleted from all 3 adapter layers (`StorageAdapter.js`, `MongoStorageAdapter.js`, `FileStorageAdapter.js`). The only reference in active `.js` code is a comment at `orchestrator.js:100`: "FIX 1: Replaced writeEnrichedJobs (bloated) with calibration_passed." Zero function calls remain. NEVER re-introduce this method.

11. **No orchestrator-level filteredJobsBuffer** — Workers persist their own dropped jobs to `calibration_rejected` directly. The orchestrator no longer maintains a module-level buffer for filtered jobs (`orchestrator.js:111` comment).

12. **`knownJobIds` loaded once, before parallel** — `orchestrator.js:520-522`: `const knownJobIds = await storageAdapter.loadSentHistory()` is called exactly ONCE before the `Promise.allSettled` parallel phase (or empty `Set` if `RESET_DEDUP=true`). This single `Set` is passed by reference to both `processBatch()` calls for Comeet and Greenhouse. Workday's `processWorkdayBatch()` does NOT receive `knownJobIds` — it has no silent dedup.

---

## 10. Jitter & Rate Limiting Configuration

### LinkedIn Delays

| Component | Min Delay | Max Delay | Source (file:line) | Env Override |
|-----------|----------|----------|-------------------|-------------|
| Query-level jitter (between search queries) | 10,000ms | 20,000ms | `scraper.js:244` | None |
| Enrichment delay (between fetchJobDetails calls) | 3,000ms | 6,000ms | `scraper.js:461` | None |
| Pagination delay (between search pages) | 3,000ms | 7,000ms | `scraper.js:465` | None |
| Batch cool-off (between groups of 5 queries) | 120,000ms | 180,000ms | `scraper.js:474` | None |
| Error recovery delay | 3,000ms | 7,000ms | `scraper.js:301` | None |
| Base httpClient delay | 200ms | 500ms | `httpClient.js:38` | None |

### Comeet Delays

| Component | Min Delay | Max Delay | Source (file:line) | Env Override |
|-----------|----------|----------|-------------------|-------------|
| Per-company delay (before fetch) | 3,000ms | 6,000ms | `comeetWorker.js:14-15` | `COMEET_DELAY_MIN_MS`, `COMEET_DELAY_MAX_MS` |
| Rate limiter (between requests) | 9,000ms | 11,000ms | `rateLimiter.js:49-50` | `COMEET_RATE_LIMIT_MIN_MS`, `COMEET_RATE_LIMIT_MAX_MS` |
| Batch pause (between groups) | 20,000ms | 30,000ms | `comeetRunConfig.js:14-15` | `COMEET_BATCH_PAUSE_MIN_MS`, `COMEET_BATCH_PAUSE_MAX_MS` |
| WAF 403/406 cooldown | 120,000ms | 300,000ms | `comeetWorker.js:18-19` | `COMEET_COOLDOWN_403_MIN_MS`, `COMEET_COOLDOWN_403_MAX_MS` |
| Retry backoff (429) | 15,000ms base | 120,000ms cap | `httpClientWrapper.js:89` | None (exponential + 0-30% jitter) |
| Retry backoff (5xx) | 5,000ms base | 30,000ms cap | `httpClientWrapper.js:103` | None (exponential + 0-30% jitter) |
| Retry backoff (timeout) | 5,000ms base | 20,000ms cap | `httpClientWrapper.js:122` | None (exponential + 0-30% jitter) |

### Greenhouse Delays

| Component | Min Delay | Max Delay | Source (file:line) | Env Override |
|-----------|----------|----------|-------------------|-------------|
| Per-company delay (before fetch) | 6,000ms | 12,000ms | `greenhouseWorker.js:12-13` | `GREENHOUSE_DELAY_MIN_MS`, `GREENHOUSE_DELAY_MAX_MS` |

### Workday Delays

| Component | Min Delay | Max Delay | Source (file:line) | Env Override |
|-----------|----------|----------|-------------------|-------------|
| Per-pagination delay | 5,000ms | 6,000ms | `workdayWorker.js:30-31` | `WORKDAY_DELAY_MIN_MS`, `WORKDAY_DELAY_MAX_MS` |
| Session init (Akamai settle) | 2,000ms (fixed) | — | `workdayWorker.js:34` | None |
| Facet detection delay | 5,000ms | 6,000ms | `workdayWorker.js:296` | Same as pagination |

---

## 11. Environment Variables

### Secrets (via GCP Secret Manager)

| Name | Purpose | Used In |
|------|---------|---------|
| `LINKEDIN_LI_AT` | LinkedIn `li_at` session cookie | `linkedin_client.js:31` |
| `LINKEDIN_JSESSIONID` | LinkedIn `JSESSIONID` cookie (must match CSRF token) | `linkedin_client.js:33` |
| `LINKEDIN_CSRF_TOKEN` | LinkedIn CSRF token for `Csrf-Token` header | `linkedin_client.js:34` |
| `MONGODB_URI` | MongoDB Atlas connection string (includes credentials) | `services/storage/index.js`, `MongoStorageAdapter.js` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token (shared by user-chat job reports and admin-chat control plane) | `services/notifications/TelegramNotifier.js`, `services/notifications/TelegramAdminNotifier.js` |
| `ADMIN_CHAT_ID` | Chat ID for operator/control-plane events (critical alerts + calibration reports). May equal `TELEGRAM_CHAT_ID` for single-chat setups. Missing → `TelegramAdminNotifier` logs + returns `false` (never throws). | `services/notifications/TelegramAdminNotifier.js` |
| `JOBBOT_SMTP_USER` | Gmail address for legacy job-report path (`scraper.js`) and discovery reports (`tools/discovery/run_discovery.js`) | `mailer.js`, `EmailNotifier.js` |
| `JOBBOT_SMTP_PASS` | Gmail App Password for SMTP auth (legacy SMTP path only) | `mailer.js`, `EmailNotifier.js` |

### Configuration (Cloud Run / `.env`)

| Name | Default | Purpose | Source |
|------|---------|---------|--------|
| `STORAGE_BACKEND` | `file` (if no `MONGODB_URI`) | `mongo` → MongoStorageAdapter; else FileStorageAdapter | `services/storage/index.js:12` |
| `TELEGRAM_CHAT_ID` | Not set | User-facing chat for job report cards (Telegram). Distinct from `ADMIN_CHAT_ID`. | `services/notifications/TelegramNotifier.js` |
| `JOBBOT_TO_EMAIL` | Falls back to `JOBBOT_SMTP_USER` | Recipient email for legacy SMTP paths (scraper + discovery report) | `mailer.js`, `EmailNotifier.js` |
| `GCS_LOCK_BUCKET` | Not set | Enables distributed lock + quota alert atomic flag via GCS object preconditions | `orchestrator.js`, `services/lock/GcsCalibrationLock.js`, `services/emergency/gcsAlertManager.js` |
| `GCS_QUOTA_ALERT_FLAG_PATH` | `flags/quota-alert-sent.flag` | Optional custom path for exactly-once quota alert flag object | `services/emergency/gcsAlertManager.js:66` |
| `NODE_ENV` | Not set locally; `production` in Dockerfile | Used by npm (no code dependency) | `Dockerfile:6` |

### Debug & Feature Flags

| Name | Default | Purpose | Source |
|------|---------|---------|--------|
| `DRY_RUN` | `false` | Skips email sending and data persistence | `orchestrator.js:40` |
| `SKIP_LINKEDIN` | `false` | Skips LinkedIn scraper phase entirely | `orchestrator.js:41` |
| `SKIP_ATS` | `false` | Skips all ATS workers | `orchestrator.js:42` |
| `RESET_DEDUP` | `false` | If `true`, bypasses silent dedup (knownJobIds = empty Set). For testing. | `orchestrator.js:520` |
| `DISCOVERY_DRY_RUN` | `false` | If `true`, discovery pipeline skips DB writes | `tools/discovery/run_discovery.js` |
| `DEBUG_COMEET` | `false` | Enables Comeet raw debug output to console | `comeetWorker.js:8` |
| `DEBUG_GREENHOUSE` | `false` | Enables Greenhouse raw debug output to console | `greenhouseWorker.js:6` |
| `DEBUG_WORKDAY` | `false` | Enables Workday raw debug output + facet diagnostics | `workdayWorker.js:23` |
| `ATS_GUARD_DRY_RUN` | `false` | Bypasses ATS Guard filtering (all jobs pass) | `comeetWorker.js:9`, `greenhouseWorker.js:7`, `workdayWorker.js:24` |
| `ATS_QUIET_MODE` | `true` (default: `!== 'false'`) | Suppresses non-error worker logs | `comeetWorker.js:11`, `greenhouseWorker.js:9`, `workdayWorker.js:25` |

### Rate Limiting Overrides

| Name | Default | Purpose |
|------|---------|---------|
| `COMEET_DELAY_MIN_MS` | `3000` | Min delay before Comeet company fetch |
| `COMEET_DELAY_MAX_MS` | `6000` | Max delay before Comeet company fetch |
| `COMEET_RATE_LIMIT_MIN_MS` | `9000` | Rate limiter min interval |
| `COMEET_RATE_LIMIT_MAX_MS` | `11000` | Rate limiter max interval |
| `COMEET_BATCH_PAUSE_ENABLED` | `true` | Enable batch pause between Comeet groups |
| `COMEET_BATCH_SIZE` | `12` | Companies per batch before pause |
| `COMEET_BATCH_PAUSE_MIN_MS` | `20000` | Batch pause min |
| `COMEET_BATCH_PAUSE_MAX_MS` | `30000` | Batch pause max |
| `COMEET_COOLDOWN_403_MIN_MS` | `120000` | WAF block cooldown min (2 min) |
| `COMEET_COOLDOWN_403_MAX_MS` | `300000` | WAF block cooldown max (5 min) |
| `GREENHOUSE_DELAY_MIN_MS` | `6000` | Min delay before Greenhouse company fetch |
| `GREENHOUSE_DELAY_MAX_MS` | `12000` | Max delay before Greenhouse company fetch |
| `WORKDAY_DELAY_MIN_MS` | `5000` | Min delay between Workday pagination requests |
| `WORKDAY_DELAY_MAX_MS` | `6000` | Max delay between Workday pagination requests |
| `LINKEDIN_USER_AGENT` | Chrome 120 UA string | Override User-Agent for LinkedIn requests |
| `LINKEDIN_ACCEPT_LANGUAGE` | `en-US,en;q=0.9` | Override Accept-Language header |

---

## 12. Error Handling & Failure Modes

| Failure Mode | Symptom | Root Cause | Resolution |
|-------------|---------|-----------|-----------|
| **MongoDB quota exceeded** | Error code `8000` or `"you are over your space quota"`; persistence/calibration lock writes can fail | Atlas M0 512MB storage limit reached | Primary: run `npm run calibrate:purge` (aggressive mode) or `node tools/emergency_purge.js` to free space fast. On orchestrator fatal path, `handleQuotaExhaustion()` sends one CRITICAL Telegram alert to `ADMIN_CHAT_ID` via GCS atomic flag and exits `0` to prevent Cloud Run retry storms. |
| **LinkedIn auth redirect (302/303)** | `LinkedInAuthChallengeError` thrown; 0 LinkedIn jobs; CRITICAL Telegram alert to `ADMIN_CHAT_ID` sent automatically | Session cookie (`li_at`) expired or LinkedIn flagged the bot | Rotate `LINKEDIN_LI_AT`, `JSESSIONID`, `CSRF_TOKEN` in Secret Manager from a fresh authenticated browser session. Ensure JSESSIONID matches CSRF_TOKEN. |
| **LinkedIn auth fail (401)** | `CRITICAL_AUTH_FAIL` error thrown; bot stops LinkedIn phase | Cookie invalid | Same as 302/303 resolution |
| **LinkedIn rate limit (429)** | `Rate limited (429)` error during fetchJobDetails | Too many enrichment requests too quickly | Built-in: scraper pauses 3-6s between enrichments. If persistent, increase delays. |
| **Workday WAF block (403)** | `403` status or `0 jobs` from specific Workday companies | Akamai anti-bot detection on Workday tenant | Increase `WORKDAY_DELAY_MIN/MAX_MS`. Review browser headers in `workdayWorker.js:42-54`. Some tenants may be permanently blocked. |
| **Workday location facet not found** | `[WD WARN] No location facet found` or `facetId is invalid` | Workday tenant uses non-standard facet naming | Non-blocking — worker falls back to `searchText: 'Israel'` only. May return some non-Israel jobs that get filtered client-side. |
| **Comeet WAF block (403/406)** | WAF blocked warning in logs; 2-5 min cooldown auto-applied | Comeet/Cloudflare rate protection triggered | Increase `COMEET_DELAY_*_MS` or `COMEET_COOLDOWN_*_MS`. The 2-5 min cooldown is automatic. |
| **Comeet rate limit (429)** | `429` responses persist after 2 retry attempts | API rate limit exceeded despite backoff | Increase `COMEET_RATE_LIMIT_*_MS` (currently 9-11s). Reduce `COMEET_BATCH_SIZE` (currently 12). |
| **Persist failure (fail-fast)** | Orchestrator logs `"Failed to persist sent history"` then crashes | MongoDB connectivity issue or quota exceeded during bulkWrite | Check MongoDB Atlas status, connectivity from Cloud Run region. If quota issue, clear old data and reduce TTLs. |
| **Calibration lock contention** | `"Calibration skipped: could not acquire calibration lock."` | Another job instance currently holds lock (GCS file exists and not stale) | Expected under overlaps. Keep behavior; only one runner should calibrate/email. Ensure `GCS_LOCK_BUCKET` is configured and lifecycle policy deletes stale lock objects (1 day). |
| **Stale Cloud Run deployment** | Zombie collections (`run_logs`, `enriched_jobs`) reappear in Atlas after manual drop | Cloud Run container still running pre-refactor Docker image | Redeploy: `gcloud run jobs deploy jobbot-runner --source . --region europe-west1` from Cloud Shell |
| **Email send failure** | `EmailNotifier: Failed to send email` in logs | SMTP auth failure (bad App Password) or Gmail restrictions | Verify `JOBBOT_SMTP_PASS` is valid Gmail App Password. `JobStateService.rollback()` is automatically called — pending job IDs are NOT committed to history. |
| **CSRF/JSESSIONID mismatch** | `LinkedInAuthChallengeError` thrown at startup | `LINKEDIN_CSRF_TOKEN` and `LINKEDIN_JSESSIONID` don't match | `linkedin_client.js:55-60` validates these match. Both values must be copied from the same browser session. |

---

## 13. Email Gatekeeper Logic

### 3-Condition Gate (`orchestrator.js:433-439`)

```javascript
const hasNewJobs = Array.isArray(newJobs) && newJobs.length > 0;
const hasErrors  = Array.isArray(errors) && errors.length > 0;
const isHeartbeatHour = new Date().getUTCHours() === 6;

if (!hasNewJobs && !hasErrors && !isHeartbeatHour) {
  // SKIP — no email sent
  // Run is still logged to Cloud Run stdout + MongoDB run_summaries
}
```

| Condition | Trigger | File:Line |
|-----------|---------|-----------|
| `newJobs.length > 0` | At least one new job survived dedup | `orchestrator.js:433` |
| `errors.length > 0` | Any ATS or LinkedIn error occurred during the run | `orchestrator.js:434` |
| `isHeartbeatHour` | Current UTC hour === 6 | `orchestrator.js:435` |

If **ANY** of the 3 conditions is true, email is sent. If **ALL** are false, email is skipped.

### Heartbeat Hour

- **UTC 6** = Israel Standard Time (IST, UTC+2) **08:00** — winter
- **UTC 6** = Israel Daylight Time (IDT, UTC+3) **09:00** — summer
- No dynamic timezone adjustment exists. Known limitation documented in snapshot P2 backlog.

### Email Report Format

Two templates exist:
1. **`EmailNotifier.sendUnifiedReport()`** (`services/EmailNotifier.js`) — Used by orchestrator for consolidated ATS + LinkedIn reports. Includes source labels (`🔗 LinkedIn`, `🟢 Comeet`, `🌿 Greenhouse`), error summary section, and job cards with Apply buttons.
2. **`mailer.sendJobReport()`** (`mailer.js`) — Legacy LinkedIn-only report. Used when scraper runs standalone (not through orchestrator).

### Control-Plane Alerts (Telegram Admin Chat)

Operator-facing critical alerts and calibration reports are delivered via [services/notifications/TelegramAdminNotifier.js](../services/notifications/TelegramAdminNotifier.js) to `ADMIN_CHAT_ID` (sharing the bot token with the user job-report channel).

- **`sendAlert(severity, title, details)`** — Posts an HTML message with a severity prefix (🚨 CRITICAL, ⚠️ WARNING, ℹ️ INFO). The `details` payload (string or object) is JSON-stringified and wrapped in `<pre>` for readable formatting. Used by:
  - `linkedin_client.js` 302/303 interceptors (LinkedIn auth challenge).
  - `ats/orchestrator.js` LinkedIn-phase catch (`LinkedInAuthChallengeError`).
  - `services/emergency/gcsAlertManager.js` (MongoDB quota exhaustion, gated by atomic GCS flag for exactly-once delivery).
- **`sendCalibrationAlert(subject, reportMd, triggerType)`** — Posts a short HTML summary message, then uploads the full markdown report via `sendDocument` (multipart/form-data with `knownLength` to keep Cloud Run egress un-chunked). Drop-in replacement for the legacy `EmailNotifier.sendCalibrationAlert` signature; called from `services/calibration/calibrationReport.js` via the notifier passed in by `ats/orchestrator.js`.

Both methods are fire-and-forget — they log and return `false` on transport failure rather than throwing, so callers never crash on a missing `ADMIN_CHAT_ID` or a Telegram 5xx.

---

## 14. Deployment & CI/CD

### Dockerfile

```dockerfile
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
USER node
CMD ["node", "ats/orchestrator.js"]
```

Key design decisions:
- `node:20-slim` — minimal base image
- `NODE_ENV=production` — standard Node.js convention (not used in application logic)
- `npm ci --omit=dev` — excludes `puppeteer` (~400MB) and `csv-parser` from image
- `--chown=node:node` — non-root security
- `CMD` → `ats/orchestrator.js` — the unified entry point

### `.dockerignore` Key Exclusions

| Excluded | Why |
|----------|-----|
| `tools/` | Development-only tooling |
| `debug_artifacts/` | Runtime debug output |
| `logs/`, `output/` | Generated at runtime, not needed in image |
| `data/` | Company configs and local state files (MongoDB in production) |
| `node_modules/` | Reinstalled via `npm ci` |
| `.env` | Secrets managed by GCP Secret Manager |
| `docs/`, `promts/`, `*.md` | Documentation (except README.md) |
| `test/`, `*.test.js`, `*.spec.js` | Test files |
| `.cursor/`, `plans/` | IDE-specific files |
| `Dockerfile`, `.dockerignore` | Not needed inside image |

### `cloudbuild.yaml`

```yaml
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-t', 'gcr.io/$PROJECT_ID/jobbot-image', '.']
- name: 'gcr.io/cloud-builders/docker'
  args: ['push', 'gcr.io/$PROJECT_ID/jobbot-image']
options:
  logging: CLOUD_LOGGING_ONLY
images:
- 'gcr.io/$PROJECT_ID/jobbot-image'
```

Two-step pipeline: build Docker image → push to Google Container Registry. `CLOUD_LOGGING_ONLY` avoids storing build logs in Cloud Storage (cost optimization).

### Cloud Run Job Configuration

| Setting | Value |
|---------|-------|
| **Job name** | `jobbot-runner` |
| **Region** | `europe-west1` |
| **Memory** | Default (512Mi) |
| **Timeout** | Default (10 min for Jobs) |
| **Entrypoint** | `node ats/orchestrator.js` (from `CMD` in Dockerfile) |
| **Concurrency** | 1 (single task execution) |
| **Max retries** | `0` (manual hardening via `infrastructure_update.sh`) |

### Cloud Scheduler

| Setting | Value |
|---------|-------|
| **Cron expression** | `*/30 8-22 * * *` |
| **Timezone** | UTC (matches heartbeat logic) |
| **Frequency** | Every 30 minutes between 08:00–22:00 UTC |
| **Runs per day** | ~29 executions |

### Deploy Command

```bash
gcloud run jobs deploy jobbot-runner --source . --region europe-west1
```

This builds the image in Cloud Build, pushes to GCR, and updates the Cloud Run Job to use the new image. Must be run from a directory containing the `Dockerfile`.

### Infra Hardening Script

`infrastructure_update.sh` codifies production resiliency updates:
- Creates/validates GCS lock bucket
- Applies 1-day object lifecycle cleanup (stale lock + stale quota-flag breaker)
- Sets `GCS_LOCK_BUCKET` and `JOBBOT_TO_EMAIL` env vars on Cloud Run Job
- Sets `--max-retries 0` to disable retry storms during fatal quota incidents

---

## 15. Key Dependencies

### Production Dependencies (from `package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `axios` | ^1.13.2 | HTTP client for LinkedIn Voyager API, Comeet API, Greenhouse API |
| `axios-cookiejar-support` | ^6.0.5 | Cookie jar integration with axios for Workday session management |
| `cheerio` | ^1.1.2 | HTML parser — available but not actively used in core pipeline |
| `dotenv` | ^16.6.1 | Load `.env` file for local development |
| `mongodb` | ^6.0.0 | Native MongoDB driver for Atlas (MongoStorageAdapter) |
| `nodemailer` | ^7.0.11 | SMTP email delivery via Gmail |
| `tough-cookie` | ^6.0.0 | Cookie jar implementation for Workday PLAY_SESSION management |
| `@google-cloud/storage` | ^7.14.0 | Distributed calibration lock + exactly-once quota emergency alert flag |

### Dev Dependencies (excluded from Docker image)

| Package | Version | Purpose |
|---------|---------|---------|
| `csv-parser` | ^3.2.0 | Parse `greenhouse_list.csv` — only used by `FileStorageAdapter` in local dev |
| `puppeteer` | ^24.36.1 | Browser automation for tooling (e.g., `comeet_hunter`) — NOT used in core pipeline |
| `puppeteer-extra` | ^3.3.6 | Plugin framework for discovery/harvesting browser automation tools |
| `puppeteer-extra-plugin-stealth` | ^2.11.2 | Anti-detection plugin for discovery tooling (not used in core ATS/LinkedIn runtime) |

---

## 16. Calibration DB Architecture

### `calibration_rejected` — Filter Tuning Data

**Purpose:** Stores lightweight metadata of jobs rejected by business-logic filters. Enables reviewing filter accuracy: what was dropped, why, and whether it was a false positive.

**What it stores:** `{ jobId, title, companyName, location, url, reason, source, createdAt }`

**What is stripped:** Raw API responses (`raw` field), normalized job objects, HTML descriptions (`description` field). All stripped by `_stripJobForCalibration()` at `MongoStorageAdapter.js:337-356`.

**TTL:** 60 days via MongoDB TTL index on `createdAt` (created in `_ensureTTLIndexes()`).

**Write paths:**
- Comeet worker: `comeetWorker.js` → `storageAdapter.writeCalibrationRejected(droppedJobs)`
- Greenhouse worker: `greenhouseWorker.js` → `storageAdapter.writeCalibrationRejected(droppedJobs)`
- Workers persist their own drops; no orchestrator-level calibration_rejected writes.

**Dedup optimization:** Silent dedup (Invariant #7) prevents already-known jobs from being written to `calibration_rejected`. This reduced write volume from ~700 docs/run (all rejects) to ~10-50 docs/run (only genuinely new rejects).

### `calibration_passed` — Email Analytics Data

**Purpose:** Stores lightweight metadata of jobs that passed all filters AND were successfully emailed. Enables understanding what the bot actually sends to the user.

**What it stores:** Same fields as rejected, minus `reason`.

**TTL:** 60 days via MongoDB TTL index on `createdAt` (created in `_ensureTTLIndexes()`).

**Write path:** Orchestrator writes after successful email + dedup: `orchestrator.js:664-672`. Gate: `if (emailSuccess && newJobs.length > 0 && !DRY_RUN)`.

### `_stripJobForCalibration(job)` Helper

Located at `MongoStorageAdapter.js` (see `_stripJobForCalibration`). Implementation:

```javascript
_stripJobForCalibration(job) {
  return {
    jobId: job.jobId || undefined,
    title: job.title || undefined,
    companyName: job.companyName || job.companyId || job.sourceCompanyId || undefined,
    location: job.location || undefined,
    url: job.url || undefined,
    reason: job.reason || undefined,
    source: job.source || undefined,
  };
}
```

**Why stripping is critical for 512MB quota:**
- Without stripping: Each raw Comeet/Greenhouse job is 2–10KB. At ~50 genuinely new rejects/run × 29 runs/day × 60-day TTL = ~250MB for rejected alone.
- With stripping: Each calibration doc is ~200 bytes. Same volume = ~5MB.
- The `raw` field on Comeet jobs can contain dozens of HTML-rich string fields. Greenhouse `content` fields contain full HTML job descriptions. These are the primary storage consumers.

---

## 17. Cost Profile

### GCP Free Tier Usage

| Service | Free Tier Allowance | Projected Usage | Status |
|---------|-------------------|-----------------|--------|
| Cloud Run Jobs | 2M requests + 360K vCPU-seconds/month | ~960 runs/month (29-32/day × 30 days), ~960 vCPU-seconds | Well within free tier |
| Cloud Build | 120 build-minutes/day | Occasional deploys only (~5/month) | Well within free tier |
| Cloud Scheduler | 3 free jobs | 1 job used | Well within free tier |
| Secret Manager | 6 active secret versions, 10K access ops | ~6 secrets, ~6K accesses/month | Well within free tier |
| Artifact Registry | 500MB storage | Single image ~150MB | Well within free tier |
| Cloud Logging | 50GB/month ingestion | Minimal (CLOUD_LOGGING_ONLY, no stored builds) | Well within free tier |

### MongoDB Atlas M0 Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Storage | 512MB | Hard limit, cannot be increased on M0 |
| Connections | 500 | App uses maxPoolSize: 10 |
| Operations | Shared cluster (throttled) | No dedicated IOPS |
| Backups | None | M0 does not include backups |
| Collections | No hard limit | Currently 6 active |
| Indexes | No hard limit | TTL indexes on 2 collections |

### Projected Steady-State Storage (~170MB total)

| Collection | Estimated Size | Growth Pattern | Bounding Mechanism |
|-----------|---------------|----------------|-------------------|
| `seen_jobs` | ~1MB | Grows slowly (~50 new LinkedIn IDs/run) | 90-day TTL |
| `ats_sent_history` | ~500KB | Grows slowly (~3-5 new emailed jobs/run) | 180-day TTL |
| `companies` | ~50KB | Static (manual seed) | None needed |
| `calibration_rejected` | ~80MB | ~5MB/month, bounded by 60-day TTL + silent dedup | 60-day TTL auto-cleanup |
| `calibration_passed` | ~15MB (bounded) | ~2.5MB/month | 60-day TTL |
| `run_summaries` | ~3MB | ~3MB/month, bounded by 30-day TTL | 30-day TTL auto-cleanup |
| **Total projected** | **~100MB** | Stabilizes within 2-3 months | Well within 512MB |

The storage projection dropped dramatically from pre-v6.2 estimates (~400MB for `calibration_rejected` alone) due to silent dedup eliminating ~90% of duplicate writes.

**Monitoring strategy:** Volume trigger gates on logical usage (`dataSize + indexSize`) at a 200MB threshold—well under the Atlas 512MB cap—so calibration can build the full markdown report before an aggressive purge frees space. Automated emergency Telegram alert to `ADMIN_CHAT_ID` is exactly-once gated via GCS atomic flag; manual Atlas dashboard monitoring is still recommended.

**Cost:** The entire system operates within GCP + MongoDB free tiers. Estimated monthly cost: **$0.00**. The only recurring cost risk is if the project exceeds free-tier limits — which would require significantly more companies, higher run frequency, or removing TTL indexes.

---

## 18. JobStateService Detailed Architecture

The `JobStateService` (`services/JobStateService.js`, 135 lines) is the central deduplication service. It maintains two `Set<string>` instances and orchestrates the "optimistic commit" pattern used for email-then-persist.

### State Model

| Property | Type | Purpose | Lifecycle |
|----------|------|---------|-----------|
| `sentJobIds` | `Set<string>` | Full history of job IDs that were previously emailed | Loaded fresh at start of `filterNewJobs()`, never cached between calls |
| `newJobIds` | `Set<string>` | IDs added during the current run (pending commit) | Populated by `filterNewJobs()`, committed by `persistState()`, cleared by `rollback()` |

### `filterNewJobs(jobs)` — Phase 3 Logic

**Location:** `JobStateService.js:45-87`

```
Input: Array of job objects from all sources (ATS + LinkedIn combined)
  │
  ├── loadHistory() — always loads fresh from storage (no cache)
  │    └── storageAdapter.loadSentHistory() → Set<string>
  │
  ├── For each job:
  │     ├── No jobId? → skip (noJobId++)
  │     ├── sentJobIds.has(jobId)? → skip (alreadySent++)
  │     ├── newJobIds.has(jobId)? → skip (alreadyInRun++)
  │     └── New! → newJobIds.add(jobId); newJobs.push(job)
  │
  └── Return: only genuinely new jobs
```

**Why "always loads fresh":** Line 47 — `await this.loadHistory()` is called at the start of every `filterNewJobs()` invocation, not just once. This prevents stale history when Cloud Run containers are reused across invocations.

**Three-way dedup:** The service checks against both the historical set (from DB) AND the current-run set. This prevents within-run duplicates when the same job appears in both a Comeet company feed and a Greenhouse feed.

### `persistState()` — Phase 5 Logic

**Location:** `JobStateService.js:94-121`

```
├── Guard: if newJobIds.size === 0 → return early
│
├── Merge newJobIds into sentJobIds (in-memory union)
│
├── Clear newJobIds (prevents double-commit)
│
├── Build metadata: { lastUpdated: ISO string, totalCount: sentJobIds.size }
│
├── storageAdapter.persistSentHistory(sentJobIds, metadata)
│     └── FAIL-FAST: on error → logs then re-throws (line 120)
│
└── On success: log count of new + total IDs
```

**Critical detail:** `this.newJobIds.clear()` at line 106 happens BEFORE the `persistSentHistory` call. If the persist fails, the IDs are already merged into `sentJobIds` (in-memory) but `newJobIds` is empty. This is intentional — the orchestrator catches the error and the fail-fast propagation prevents the run from reporting success. The in-memory state is irrelevant since the process exits.

### `rollback()` — Email Failure Recovery

**Location:** `JobStateService.js:127-132`

Called by the orchestrator if `emailNotifier.sendUnifiedReport()` returns `false`. Clears `newJobIds` so that `persistState()` becomes a no-op, ensuring that jobs which weren't emailed are NOT committed to history. They will be rediscovered and emailed on the next run.

### Sequence Diagram: Happy Path

```
orchestrator.js         JobStateService         MongoStorageAdapter
     │                       │                        │
     │ filterNewJobs(all)    │                        │
     │──────────────────────>│                        │
     │                       │ loadSentHistory()      │
     │                       │───────────────────────>│
     │                       │       Set<string>      │
     │                       │<───────────────────────│
     │     newJobs[]         │                        │
     │<──────────────────────│                        │
     │                       │                        │
     │ [send email OK]       │                        │
     │                       │                        │
     │ persistState()        │                        │
     │──────────────────────>│                        │
     │                       │ persistSentHistory()   │
     │                       │───────────────────────>│
     │                       │       void             │
     │                       │<───────────────────────│
     │     void              │                        │
     │<──────────────────────│                        │
```

### Sequence Diagram: Email Failure Path

```
orchestrator.js         JobStateService         EmailNotifier
     │                       │                      │
     │ filterNewJobs(all)    │                      │
     │──────────────────────>│                      │
     │     newJobs[]         │                      │
     │<──────────────────────│                      │
     │                       │                      │
     │ sendUnifiedReport()   │                      │
     │──────────────────────────────────────────── >│
     │     false (failure)   │                      │
     │<────────────────────────────────────────────│
     │                       │                      │
     │ rollback()            │                      │
     │──────────────────────>│                      │
     │  [newJobIds cleared]  │                      │
     │<──────────────────────│                      │
     │                       │                      │
     │ persistState()        │                      │
     │──────────────────────>│                      │
     │  [no-op: size === 0]  │                      │
     │<──────────────────────│                      │
```

---

## 19. HTTP Client Layer Architecture

The ATS workers share a layered HTTP client stack with progressively advanced capabilities.

### Layer 1: Base Client (`ats/utils/httpClient.js`)

**Factory:** `createHttpClient()` → `{ client: AxiosInstance, requestWithDelay: Function }`

| Property | Value | Line |
|----------|-------|------|
| `maxRedirects` | `0` | `httpClient.js:98` |
| Default min delay | 200ms | `httpClient.js:38` |
| Default max delay | 500ms | `httpClient.js:38` |

The base client applies a random delay (`randomDelay(minMs, maxMs)`) before every request via `requestWithDelay(config)`. An interceptor logs warnings on 302/303 responses.

### Layer 2: Rate Limiter (`ats/utils/rateLimiter.js`)

**Class:** `RateLimiter` — Enforces minimum interval between consecutive requests.

| Method | Behavior |
|--------|----------|
| `waitIfNeeded()` | Calculates `timeSinceLastRequest`. If less than `minIntervalMs`, sleeps the difference. Updates `lastRequestTime` after wait. |
| `reset()` | Sets `lastRequestTime = 0` (useful after long cooldowns) |

**Factory:** `createComeetRateLimiter()` — Creates a limiter with a randomized interval between `COMEET_RATE_LIMIT_MIN_MS` (default 9000) and `COMEET_RATE_LIMIT_MAX_MS` (default 11000). The interval is randomized once at creation time, not per-request.

**Singleton scope:** The `rateLimiters` map in `httpClientWrapper.js:9-11` stores one limiter per provider. Currently only `comeet` is supported. The limiter persists for the lifetime of the module (i.e., per Cloud Run container invocation).

### Layer 3: Retry Wrapper (`ats/utils/httpClientWrapper.js`)

**Function:** `requestWithRetry(httpClient, config, options)` — Adds exponential backoff retry logic on top of the base client.

**Exponential Backoff Formula (`httpClientWrapper.js:29-33`):**

```
exponential = min(baseMs × 2^(attempt-1), maxMs)
jitter = random(0, 0.3 × exponential)
finalDelay = exponential + jitter
```

| Retry Trigger | Base | Cap | Retry-After Respected | Source Line |
|---------------|------|-----|----------------------|-------------|
| 429 (Rate Limit) | 15,000ms | 120,000ms | Yes (+ 0-2s jitter) | `httpClientWrapper.js:85-98` |
| 5xx (Server Error) | 5,000ms | 30,000ms | No | `httpClientWrapper.js:101-111` |
| Timeout (`ECONNABORTED`) | 5,000ms | 20,000ms | N/A | `httpClientWrapper.js:120-129` |
| Network Error (no response) | 5,000ms | 20,000ms | N/A | `httpClientWrapper.js:132-141` |

**Max retries:** Configurable per-call. Comeet uses `maxRetries: 2`. Greenhouse and Workday use `maxRetries: 0` (no retries).

### Layer 4: Convenience Wrapper (`requestWithDelayWrapper`)

**Function:** `requestWithDelayWrapper(httpClient, options)` → `async (config) => response`

Returns a callable function matching the simple `(config) => Promise<response>` signature that workers expect. Routes to the appropriate layer:

| Provider | Retries Enabled | Rate Limiter | Retry Logic |
|----------|----------------|--------------|-------------|
| `comeet` + retries | Yes | Comeet (9-11s) | Full retry (429, 5xx, timeout) |
| `comeet` no retries | No | Comeet (9-11s) | None |
| Other/none | No | None | None |

---

## 20. Location Gate Logic

### Shared Location Gate (`ats/utils/locationGate.js`)

Used by Comeet and Greenhouse workers' `filterJob()` functions. Workday uses a separate internal implementation.

**Israel Cities List (13 cities, `locationGate.js:3-17`):**

| City | Notes |
|------|-------|
| tel aviv | Primary tech hub |
| tel-aviv | Hyphenated variant |
| herzliya | North Tel Aviv suburb (many tech campuses) |
| haifa | Northern hub |
| jerusalem | Capital |
| rehovot | Weizmann Institute area |
| ramat gan | Adjacent to Tel Aviv |
| petah tikva | Central Israel |
| netanya | Coastal city |
| ra'anana | Central Israel (with apostrophe) |
| hod hasharon | Sharon region |
| kfar saba | Sharon region |
| givatayim | Greater Tel Aviv |

**Matching Rules (priority order, `locationGate.js:19-48`):**

| # | Rule | Result | Example |
|---|------|--------|---------|
| 1 | Location contains "israel" (any case) | PASS | "Tel Aviv, Israel" → pass |
| 2 | Location contains any of 13 approved cities | PASS | "Herzliya" → pass |
| 3 | Location is exactly "Remote" (case-insensitive, trimmed) | PASS | "Remote" → pass |
| 4 | Location contains "remote" but NOT "israel" and is NOT exactly "Remote" | FAIL | "Remote - USA" → fail |
| 5 | Everything else | FAIL | "London, UK" → fail |

**Key subtlety:** "Remote - Israel" passes via rule #1 (contains "israel"), NOT via the remote rules. "Remote" (exact) passes via rule #3. "Remote - USA" fails via rule #4.

### Workday Israel Detection (`workdayWorker.js:40`)

Workday uses its own expanded terms list that includes additional cities not in the shared gate:

```
['israel', 'tel aviv', 'tel-aviv', 'yokneam', 'haifa', 'herzliya', 'raanana', 'petah tikva', 'jerusalem']
```

Notable differences from shared gate: includes `yokneam` (KLA/Intel campus area), uses `raanana` (no apostrophe), and is missing several cities from the shared list (`rehovot`, `ramat gan`, `netanya`, `hod hasharon`, `kfar saba`, `givatayim`). This is because Workday's server-side `searchText: 'Israel'` filter already handles most Israel-based jobs.

---

## 21. ATS Guard Detailed Internals

The ATS Guard (`ats/filters/ats_guard.js`, 214 lines) is a three-tier, short-circuit filter that progressively evaluates more expensive checks only if cheaper checks pass.

### Field Extraction (`extractJobFields`, lines 12-58)

Works with both Greenhouse and Comeet raw payloads by checking multiple field names:

| Field | Extraction Logic |
|-------|-----------------|
| `title` | `job.title` ‖ `job.name` ‖ `job.position` |
| `location` | String: direct. Object: `name` ‖ `fullName` ‖ `city` ‖ `region` ‖ `country` |
| `departments` | `job.departments[].name` (array of strings) |
| `description` | `job.content` ‖ `job.description` (full HTML string) |

### Tier 1: Title Check (`runTitleCheck`, lines 94-122)

**Cost:** Cheap (string contains + regex)

Two conditions, BOTH must be satisfied:

1. **Must be technical:** Title must contain at least one of 14 `technicalTitleKeywords` (case-insensitive substring match)
   - Failing this → `FAIL: title_not_technical`
2. **Must NOT be senior:** Title must NOT match any of 15 `titleSeniorPatterns` (regex test)
   - Failing this → `FAIL: title_senior`

**Short-circuit:** If title check fails, department and description checks are skipped entirely (lines 180-186).

### Tier 2: Department Check (`runDepartmentCheck`, lines 127-147)

**Cost:** Medium (array intersection)

Only runs if title check passed. Checks if ANY department name exactly matches (case-insensitive) any of the 7 `departmentsBlacklist` entries.

- `FAIL: department ({name})` if match found
- Automatically passes if `departments` is empty (many ATS entries don't have departments)

### Tier 3: Description Check (`runDescriptionCheck`, lines 152-167)

**Cost:** Expensive (HTML → text normalization + 14 regex scans over potentially long strings)

Only runs if BOTH title and department checks passed.

**Normalization pipeline (`normalizeContent`, lines 60-89):**
1. Decode named HTML entities (`&lt;`, `&gt;`, `&amp;`, `&nbsp;`, `&quot;`, `&#39;`)
2. Decode numeric HTML entities (decimal `&#10;` and hex `&#xA;`)
3. Strip all HTML tags (`<[^>]+>` → space)
4. Collapse whitespace

Then scans normalized text against 14 `contentSeniorityPatterns`:
- Generic years patterns: `/\b[3-9]\s*\+?\s*(?:years|yrs)\b/i`, `/\b(?:3|4|5|6|7|8|9|10)\+?\s*(?:years|yrs)\b/i`
- Company-specific patterns: Melio ("3+ years of relevant experience"), Riskified, Gong
- Leadership language: "experienced team leader", "proven leadership experience"

### Verdict Aggregation (lines 176-208)

All reasons from the three tiers are collected into `allReasons[]`. If any reasons exist → `FAIL`. Otherwise → `PASS`.

Return shape: `{ verdict: 'PASS'|'FAIL', reason: string|null, details: { companyId, source, title, location, departments } }`

---

## 22. Structured Gate Internals

The Structured Gate (`ats/filters/structuredGate.js`, 34 lines) is a Comeet-only fast-track filter that runs BEFORE the ATS Guard.

### Why It Exists

Comeet's API returns structured metadata fields (`experience_level`, `employment_type`) that other ATS platforms don't provide. This allows cheap pre-filtering without any text analysis.

### Regex Patterns

| Pattern | Purpose | Line |
|---------|---------|------|
| `SENIORITY_RE` = `/\b(senior\|lead\|staff\|principal\|director\|executive\|manager\|head\sof\|vp\b\|vice\spresident)\b/i` | Detect senior-level experience | `structuredGate.js:3` |
| `STUDENT_RE` = `/\b(student\|internship\|intern)\b/i` | Detect student/intern employment | `structuredGate.js:4` |

### Three-Way Verdict

| Condition | Verdict | Effect |
|-----------|---------|--------|
| `experience_level` matches `SENIORITY_RE` | `FAIL` | Job dropped immediately → `calibration_rejected` |
| `employment_type` matches `STUDENT_RE` | `WHITELIST` | Job passes directly → skip ATS Guard entirely |
| Neither condition | `CONTINUE` | Proceed to ATS Guard for full evaluation |

The `WHITELIST` verdict is particularly valuable: student/intern positions should always pass, regardless of what the ATS Guard might think about their title or description.

---

## 23. MongoDB Connection Management

### Connection Pool Configuration (`MongoStorageAdapter.js:43-48`)

| Setting | Value | Purpose |
|---------|-------|---------|
| `maxPoolSize` | 10 | Maximum concurrent connections to Atlas |
| `minPoolSize` | 1 | Minimum kept-alive connections |
| `serverSelectionTimeoutMS` | 5000 | Fail fast if cluster unreachable |
| `retryWrites` | true (default) | Automatic single-document write retry |
| `retryReads` | true (default) | Automatic read retry |

### Lazy Connection Pattern

`MongoStorageAdapter` does NOT connect in its constructor. Instead, every public method calls `_ensureConnected()` which:

1. Checks `this.connected` flag
2. If not connected: `await this.client.connect()`
3. Gets database handle: `this.client.db(this.dbName)`
4. Calls `_ensureTTLIndexes()` once (first connection only)
5. Sets `this.connected = true`

This means the first storage operation in each run incurs a connection delay (~200-500ms to Atlas). Subsequent operations reuse the pool.

### Database Name Resolution

The adapter extracts the database name from the MongoDB URI path component. If the URI contains no database name (e.g., ends in `/?appName=...`), it defaults to `'jobbot_db'`.

### TTL Index Idempotency

`_ensureTTLIndexes()` (`MongoStorageAdapter.js:270-295`) calls `createIndex()` with `{ background: true }`. MongoDB's `createIndex()` is idempotent — if the index already exists with the same spec, it's a no-op. If it exists with a different `expireAfterSeconds`, MongoDB throws an error. The method catches and warns (non-blocking) to avoid crashing on TTL mismatches during development.

### Graceful Shutdown (`close()`)

Calls `this.client.close()` and sets `this.connected = false`. Called from the orchestrator's `finally` block. If the connection was never established (e.g., all phases were skipped), `close()` is safe to call — `MongoClient.close()` is a no-op on an unconnected client.

---

## 24. LinkedIn Voyager API Details

### Endpoints

| Endpoint | Method | Purpose | File |
|----------|--------|---------|------|
| `/voyager/api/voyagerJobsDashJobCards` | GET | Paginated job search (25 results/page) | `linkedin_client.js:77` |
| `/voyager/api/graphql` | GET | Individual job details (GraphQL) | `linkedin_client.js:462` |

### Authentication Headers

All LinkedIn requests include these headers (built by `getHeaders()` at `linkedin_client.js:30-72`):

| Header | Value | Source |
|--------|-------|--------|
| `User-Agent` | Chrome 120 UA string | `LINKEDIN_USER_AGENT` env or hardcoded default |
| `Accept` | `application/json` | Hardcoded |
| `Accept-Language` | `en-US,en;q=0.9` | `LINKEDIN_ACCEPT_LANGUAGE` env or default |
| `Csrf-Token` | `LINKEDIN_CSRF_TOKEN` env var | Passed as-is |
| `Cookie` | `li_at={LI_AT}; JSESSIONID="{JSESSIONID}"` | Constructed from env vars |
| `X-RestLi-Protocol-Version` | `2.0.0` | Hardcoded |

For search requests, the `Accept` header is overridden to `application/vnd.linkedin.normalized+json+2.1` (`linkedin_client.js:365`).

### CSRF/JSESSIONID Validation

At `linkedin_client.js:47-60`, a validation check ensures `LINKEDIN_CSRF_TOKEN` and `LINKEDIN_JSESSIONID` resolve to the same value after stripping quotes. A mismatch throws an error immediately — it's a strong signal of bad copy-paste from DevTools and triggers security challenges.

### Search URL Construction ("Golden Rule")

The search URL is manually constructed to avoid axios re-encoding (`linkedin_client.js:326-355`):

```
BASE_URL/voyager/api/voyagerJobsDashJobCards
  ?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220
  &count=25
  &q=jobSearch
  &query=(
    origin:JOB_SEARCH_PAGE_JOB_FILTER,
    keywords:{encodedKeywords},
    locationUnion:(geoId:101620260),
    selectedFilters:(
      sortBy:List(DD),
      experience:List(1,2),
      timePostedRange:List(r604800)
    ),
    spellCorrectionEnabled:true
  )
  &start={offset}
```

Key parameters:
- `geoId:101620260` — Israel
- `experience:List(1,2)` — Entry Level (1) + Associate (2)
- `timePostedRange:List(r604800)` — Past week (604800 seconds)
- `sortBy:List(DD)` — Sort by date descending
- `count=25` — Standard Voyager page size
- Keywords are double-encoded: `encodeURIComponent()` + manual `(` → `%28`, `)` → `%29`, `+` → `%20`

### URN Resolution

LinkedIn Voyager responses use `elements[].jobCardUnion.*jobPostingCard` references to objects in the `included` array. The `normalizeResponse()` function (`linkedin_client.js:195-318`) resolves these:

1. Build `includedMap` from `included[].entityUrn` → item
2. For each element, extract `refUrn` from `jobCardUnion['*jobPostingCard']`
3. Look up `refUrn` in `includedMap` (exact match)
4. If exact match fails, extract numeric ID and do soft match (find any key containing that number)
5. Extract `jobId` from `jobPostingUrn || entityUrn || refUrn` (first numeric sequence)

### GraphQL Enrichment

`fetchJobDetails()` at `linkedin_client.js:453-627` fetches individual job details:

```
/voyager/api/graphql
  ?variables=(jobPostingUrn:{encodedUrn})
  &queryId=voyagerJobsDashJobPostings.891aed7916d7453a37e4bbf5f1f60de4
```

Returns: `description.text`, `companyApplyUrl`, `title`, `skillsDescription`, `employmentStatus.localizedName`, `originalListedAt`, `appliesCount`, `simpleApplication`, `posterId`, `repostedJob`.

### Search Query Matrix

The scraper defines 16 search queries across niches (`scraper.js:36-81`):

**Level Prefixes:**
- `LEVEL_PREFIX` (verbose): `(Junior OR Student OR Intern OR Graduate OR "Entry Level" OR "0-2 years" OR "No experience" OR ג'וניור OR סטודנט OR בוגר OR "ללא ניסיון")`
- `COMPACT_LEVEL_PREFIX` (short): `(Junior OR Student OR Intern OR Graduate OR ג'וניור OR סטודנט OR בוגר)`

**11 Niche Queries** (each: `LEVEL_PREFIX AND {niche}`):

| # | Niche | Focus |
|---|-------|-------|
| 1 | Backend Python | Python, Django, Flask, FastAPI |
| 2 | Backend Java | Java, Spring |
| 3 | Fullstack | Fullstack, Full Stack, Web Developer |
| 4 | Mobile | iOS, Android, Swift, Kotlin, React Native, Flutter |
| 5 | iOS | iOS Developer, iOS Engineer, Swift |
| 6 | Android | Android Developer, Android Engineer, Kotlin |
| 7 | Data/BI | Data Analyst, Business Analyst, BI, SQL, Excel, Tableau, PowerBI |
| 8 | DevOps | DevOps, Platform Engineer, SRE, CI/CD, Docker, K8s, AWS, GCP, Azure |
| 9 | Cyber | Cyber, Security Researcher, InfoSec, SOC |
| 10 | QA | QA, Quality Assurance, Test Engineer, Automation, Selenium, Cypress |
| 11 | Embedded | Embedded, Firmware, C++, RTOS, Kernel, ARM |

**1 Data Science Query** (uses `COMPACT_LEVEL_PREFIX`):
- Data Scientist, ML Engineer, Machine Learning Engineer + Python, SQL, PyTorch, TensorFlow

**4 Cluster Queries:**

| # | Cluster | Prefix | Focus |
|---|---------|--------|-------|
| A | Enterprise Backend | `LEVEL_PREFIX` | Java, C#, .NET, Go |
| B | Web/Scripting Backend | `LEVEL_PREFIX` | Node.js, Python, Django, Express |
| C | Modern Frontend | `COMPACT_LEVEL_PREFIX` | React, Vue, Next.js, TypeScript, JavaScript |
| D | Structural Frontend | `COMPACT_LEVEL_PREFIX` | Angular, TypeScript, JavaScript |

**Pagination:** 4 pages per query: offsets `[0, 25, 50, 75]` = up to 100 results per query.

**Batching:** Queries are chunked into batches of 5 (`BATCH_SIZE = 5` at `scraper.js:225`). Cool-off of 2-3 minutes between batches.

**Daily cap:** `DAILY_NEW_JOBS_LIMIT = 500` (`scraper.js:84`). When reached, scraping halts immediately.

---

## 25. Worker Internal Flows

### Comeet Worker Flow

```
ComeetWorker.fetchAllJobs(company, knownJobIds)
  │
  ├── randomDelay(3000-6000ms) — per-company human-like delay
  │
  ├── Validate: company.token and company.uid must exist
  │
  ├── Build URL: https://www.comeet.co/careers-api/1.0/company/{uid}/positions?token={token}
  │
  ├── requestWithDelayWrapper (with Comeet rate limiter + retry)
  │     ├── Rate limiter: 9-11s min interval between requests
  │     ├── Max retries: 2 (for 429/5xx)
  │     └── Config: maxRedirects: 5, timeout: 15000ms, validateStatus: < 500
  │
  ├── Handle errors:
  │     ├── 403/406: WAF blocked → apply 2-5 min cooldown → return empty
  │     ├── 429: Rate limited (after retries) → log → return empty
  │     └── Other non-200: log → return empty
  │
  └── Process 200 response (array of raw jobs):
        │
        ├── For each rawJob:
        │     ├── Step 0: Silent dedup — knownJobIds.has('comeet_{position_uid}')
        │     │     └── YES → skippedDedup++; skip (no DB write)
        │     ├── Step 1: filterJob(rawJob)
        │     │     ├── Location: locObj.country === 'IL' or remote
        │     │     ├── Title: no senior/sr/vp/manager/director/head of/lead
        │     │     └── Department: no sales/legal/finance/hr/marketing
        │     ├── Step 2: normalizeComeetJob(rawJob, company)
        │     │     └── Extracts structuredSignals: { experience_level, employment_type }
        │     ├── Step 3: evaluateStructuredGate(unified, 'comeet')
        │     │     ├── FAIL → droppedJobs.push + continue
        │     │     ├── WHITELIST → unifiedJobs.push + continue (skip ATS Guard)
        │     │     └── CONTINUE → proceed
        │     └── Step 4: evaluateAtsGuard(rawJob, { companyId, source: 'comeet' })
        │           ├── PASS → unifiedJobs.push
        │           └── FAIL → droppedJobs.push
        │
        ├── saveDroppedJobs → writeCalibrationRejected(droppedJobs)
        └── Return: { jobs: unifiedJobs, stats }
```

### Greenhouse Worker Flow

```
GreenhouseWorker.fetchAllJobs(company, knownJobIds)
  │
  ├── randomDelay(6000-12000ms) — per-company human-like delay
  │
  ├── Validate: company.uid must exist
  │
  ├── Build URL: https://boards-api.greenhouse.io/v1/boards/{uid}/jobs?content=true
  │
  ├── requestWithDelayWrapper (standard, no retries)
  │     └── Config: maxRedirects: 5, timeout: 15000ms, validateStatus: < 500
  │
  ├── Handle non-200: log → return empty (no retry, no cooldown)
  │
  └── Process 200 response (response.data.jobs or response.data array):
        │
        ├── For each rawJob:
        │     ├── Step 0: Silent dedup — knownJobIds.has('greenhouse_{id}')
        │     │     └── YES → skippedDedup++; skip
        │     ├── Step 1: filterJob(rawJob)
        │     │     ├── Location: contains Israel cities or 'remote'
        │     │     ├── Title: no senior/sr/vp/manager/director/head of/lead
        │     │     └── Department: no sales/legal/finance/hr/marketing
        │     ├── Step 2: normalizeGreenhouseJob(rawJob, company)
        │     └── Step 3: evaluateAtsGuard(rawJob, { companyId, source: 'greenhouse' })
        │           ├── PASS → unifiedJobs.push
        │           └── FAIL → droppedJobs.push
        │
        ├── saveDroppedJobs → writeCalibrationRejected(droppedJobs)
        └── Return: { jobs: unifiedJobs, stats }
```

### Workday Worker Flow

```
WorkdayWorker.fetchAllJobs(company)  // NOTE: No knownJobIds parameter
  │
  ├── WorkdayWorker is instantiated PER COMPANY (new instance each time)
  │     └── Constructor: parse URL → extract tenant, instance, site
  │         API: https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
  │
  ├── initSession()
  │     ├── GET site URL → establish PLAY_SESSION + wday_vps_cookie
  │     ├── Wait 2000ms for Akamai sensors to settle
  │     └── On failure: log warning, attempt to continue anyway
  │
  ├── detectLocationFacet()
  │     ├── POST to jobs API with empty query (limit: 1)
  │     ├── Search response facets for location-related facet
  │     ├── Search facet values for Israel-matching entry
  │     ├── Return { facetParam, valueId } or null
  │     └── Result is cached in this._locationFacet
  │
  ├── fetchJobs() — paginated loop
  │     ├── Build payload:
  │     │   ├── searchText: 'Israel' (PRIMARY filter — always applied)
  │     │   ├── appliedFacets: { [facetParam]: [valueId] } if detected (BONUS filter)
  │     │   ├── limit: 20 (PAGE_LIMIT)
  │     │   └── offset: 0, 20, 40, ...
  │     │
  │     ├── For each page:
  │     │   ├── randomDelay(5000-6000ms) between pages
  │     │   ├── POST to jobs API with payload
  │     │   │
  │     │   └── For each rawJob in response:
  │     │         ├── _normalizeJob(rawJob)
  │     │         │   ├── JR Number extraction (4-priority cascade):
  │     │         │   │   1. jobRequisition.id
  │     │         │   │   2. externalPath (URL slug)
  │     │         │   │   3. bulletFields (last bullet)
  │     │         │   │   4. title/name field
  │     │         │   ├── Title extraction: skip JR-only, location-like, employment-type strings
  │     │         │   ├── Location: cascading fallback (locationsText → bulletFields → location.descriptor → postingLocation → externalPath)
  │     │         │   └── jobId: 'workday_{tenant}_{JR or rawId}'
  │     │         ├── Location filter (if no facet): matchesIsrael() or remote
  │     │         └── evaluateAtsGuard(rawJob, { companyId, source: 'workday' })
  │     │
  │     └── hasMore = jobs.length === PAGE_LIMIT && offset < total
  │
  └── Return: result.jobs (array only, not { jobs, stats })
```

### Key Differences Between Workers

| Aspect | Comeet | Greenhouse | Workday |
|--------|--------|-----------|---------|
| **Instance pattern** | Shared singleton | Shared singleton | New instance per company |
| **Silent dedup** | Yes (knownJobIds) | Yes (knownJobIds) | No |
| **Structured Gate** | Yes | No | No |
| **ATS Guard** | Yes | Yes | Yes |
| **Rate limiter** | Yes (9-11s via rateLimiter.js) | No | No (delay only) |
| **Retry logic** | Yes (2 retries for 429/5xx) | No | No |
| **Cookie management** | No | No | Yes (tough-cookie jar) |
| **Pagination** | No (single request per company) | No (single request per company) | Yes (20 jobs/page) |
| **Server-side filtering** | No | No | Yes (searchText + optional facet) |
| **Auth** | Token in URL param | None (public API) | Session cookies |
| **Run summary** | Via storageAdapter.writeRunLog | Via storageAdapter.writeRunLog | Console only (no storageAdapter) |

---

## 26. Data File Formats (Local Dev)

### Company Configuration Files

| File | Format | ATS Type | Key Fields | Example |
|------|--------|----------|-----------|---------|
| `data/companies_list.json` | JSON array | Comeet | `{ id, name, type: 'comeet', uid, token, enabled }` | `{ "id": "moonactive", "name": "Moon Active", "type": "comeet", "uid": "...", "token": "..." }` |
| `data/comeet_companies_auto.json` | JSON array | Comeet | Same as companies_list | Auto-discovered companies |
| `data/greenhouse_list.csv` | CSV | Greenhouse | `id, name, type, uid` | `axonius,Axonius,greenhouse,axonius` |
| `data/workday_companies.json` | JSON array | Workday | `{ id, name, url }` | `{ "id": "nvidia", "name": "Nvidia", "url": "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite" }` |

`FileStorageAdapter.loadCompanies()` merges all 4 sources in parallel, normalizes to a common format, and deduplicates by `id` (first occurrence wins).

For MongoDB (`MongoStorageAdapter`), companies are pre-seeded into the `companies` collection with the same schema. `loadCompanies()` queries `{ enabled: { $ne: false } }`.

### Company Config Schema (MongoDB)

Each company document in the `companies` collection follows this schema:

| Field | Type | Required | Used By | Description |
|-------|------|----------|---------|-------------|
| `_id` | ObjectId/String | Yes | All | Converted to `id` by adapter |
| `name` | String | Yes | All | Human-readable company name (used in email reports) |
| `type` | String | Yes | Routing | `"comeet"`, `"greenhouse"`, or `"workday"` — determines which worker processes it |
| `uid` | String | Comeet/GH | API URL construction | Comeet company UID or Greenhouse board slug |
| `token` | String | Comeet | API auth | Comeet API token (appended to URL as `?token=`) |
| `url` | String | Workday | Session init | Full Workday careers URL (parsed for tenant/instance/site) |
| `enabled` | Boolean | No | All | If `false`, company is excluded from processing. Default: `true` (absence = enabled) |

### Company Count (as of v6.2)

| ATS Type | Count | Source of Truth |
|----------|-------|----------------|
| Comeet | ~15 companies | `companies` collection (migrated from JSON) |
| Greenhouse | ~15 companies | `companies` collection (migrated from CSV) |
| Workday | ~15 companies | `companies` collection (migrated from JSON) |
| **Total** | **~45 companies** | Varies by seeding state |

### State Files

| File | Format | Purpose |
|------|--------|---------|
| `data/seen_jobs.json` | JSON array of string IDs | LinkedIn dedup memory |
| `data/ats_sent_jobs_history.json` | JSON: `{ lastUpdated, totalCount, sentJobIds: [...] }` | ATS dedup history |

### Log Directory Structure

```
logs/
├── linkedin/
│   ├── summaries/          # run_summary_{timestamp}.json
│   ├── filtered/           # filtered_jobs_debug_{timestamp}.json
│   └── archive/            # Archived old logs
└── ats/
    ├── summaries/          # ats_run_summary_{timestamp}.json
    ├── filtered/           # ats_filtered_jobs_debug_{timestamp}.json
    ├── raw/                # Raw API responses
    ├── archive/            # Archived old logs
    ├── comeet/
    │   ├── production/
    │   ├── debug/
    │   ├── summaries/      # run_summary_{timestamp}.json
    │   ├── dropped/        # dropped_{timestamp}.json
    │   ├── errors/         # error_{timestamp}.json
    │   ├── raw/            # raw_{timestamp}.json
    │   └── runtime.log     # Tailing log
    └── greenhouse/
        ├── production/
        ├── debug/
        ├── summaries/      # run_summary_{timestamp}.json
        ├── dropped/        # dropped_{timestamp}.json
        ├── errors/         # error_{timestamp}.json
        ├── raw/            # raw_{timestamp}.json
        └── runtime.log     # Tailing log
```

All log paths are defined in `config/paths.js`. Timestamps in filenames are Windows-safe (colons replaced with dashes via `_sanitizeTimestamp()`).

---

## 27. NPM Scripts & Local Dev Commands

### Defined in `package.json`

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run ats` | `node ats/orchestrator.js` | Run full orchestrator (ATS + LinkedIn) |
| `npm run analyze` | `node tools/analyze_logs.js` | Analyze run logs |
| `npm run reset` | `node tools/reset_data.js` | Reset local data files |
| `npm run comeet-hunter` | `node tools/comeet_hunter.js` | Discover single Comeet company |
| `npm run comeet-mass` | `node tools/comeet_hunter_mass.js` | Mass Comeet company discovery |
| `npm run ats-discover` | `node utils/ats_discover.js` | ATS discovery utility |
| `npm run comeet:debug` | `node tools/run_comeet_debug.js --config data/comeet_companies_auto.json` | Debug Comeet run |
| `npm run comeet:debug:sample` | Same + `--limit 5` | Debug first 5 Comeet companies |
| `npm run comeet:debug:clean` | `node tools/clean_comeet_debug_logs.js` | Clean Comeet debug artifacts |
| `npm run comeet:add` | `node tools/add_comeet_company.js` | Add company to Comeet config |
| `npm run validate:comeet` | `node tools/comeet/validate_companies.js` | Validate Comeet companies in DB |
| `npm run validate:greenhouse` | `node tools/greenhouse/validate_companies.js` | Validate Greenhouse companies |
| `npm run validate:workday` | `node tools/workday/validate_companies.js` | Validate Workday companies |
| `npm run discover` | `node tools/discovery/run_discovery.js` | Run discovery pipeline |
| `npm run discover:dry` | `DISCOVERY_DRY_RUN=true node tools/discovery/run_discovery.js` | Discovery without DB writes |
| `npm run inject` | `node tools/inject_and_validate.js` | Inject discovered companies (Workday/Greenhouse only) |
| `npm run calibrate:report` | `node tools/run_proactive_calibration.js` | Safe calibration report → `docs/analyze/` |
| `npm run calibrate:purge` | `node tools/run_proactive_calibration.js --confirm` | Purge calibration DB + update timer |
| `npm run verify:calibration` | `node tools/verify_calibration_lock_and_purge.js` | Validate lock exclusivity, stale-lock recovery, and aggressive purge path |

### Common Local Dev Invocations

```powershell
# Full run (ATS + LinkedIn):
node ats/orchestrator.js

# ATS only (skip LinkedIn):
$env:SKIP_LINKEDIN="true"; node ats/orchestrator.js

# LinkedIn only (skip ATS):
$env:SKIP_ATS="true"; node ats/orchestrator.js

# Dry run (no email, no persistence):
$env:DRY_RUN="true"; node ats/orchestrator.js

# Dry run + ATS only:
$env:DRY_RUN="true"; $env:SKIP_LINKEDIN="true"; node ats/orchestrator.js

# Debug Comeet with verbose output:
$env:DEBUG_COMEET="true"; $env:ATS_QUIET_MODE="false"; $env:SKIP_LINKEDIN="true"; node ats/orchestrator.js

# ATS Guard dry run (see what would be filtered without filtering):
$env:ATS_GUARD_DRY_RUN="true"; $env:SKIP_LINKEDIN="true"; node ats/orchestrator.js

# Emergency direct purge (no report generation):
node tools/emergency_purge.js
```

---

## 28. Workday-Specific Architecture

Workday is architecturally distinct from Comeet and Greenhouse due to its Play Framework backend and Akamai WAF protection.

### URL Parsing

Workday career URLs follow the pattern:
```
https://{tenant}.{instance}.myworkdayjobs.com/{site}
```

Example: `https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite`

Parsed by `_parseWorkdayUrl()` (`workdayWorker.js:199-214`) using regex:
```
/https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?\/([^/?#]+)/i
```

Extracted: `tenant=nvidia`, `instance=wd5`, `site=NVIDIAExternalCareerSite`

Constructed API endpoint: `https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs`

### Session Management

Workday requires cookies established by visiting the career site first:

1. **GET** the site URL (`https://{tenant}.{instance}.myworkdayjobs.com/{site}`) with browser-like headers
2. This establishes `PLAY_SESSION` and `wday_vps_cookie` via Set-Cookie
3. Wait 2000ms for Akamai bot sensors to settle
4. All subsequent API calls use the `tough-cookie` jar which auto-attaches these cookies

### Dual Filter Strategy

Workday sites often have thousands of jobs globally. The worker uses two complementary filters:

1. **PRIMARY (always applied):** `searchText: 'Israel'` in the POST body — server-side text search that reduces results from ~2000 to ~50-100
2. **BONUS (if detected):** Location facet filter — `appliedFacets: { [facetParam]: [valueId] }` for the Israel location

Facet detection is attempted first via a discovery request. If it fails (varies by tenant), the worker falls back to searchText-only.

### Job ID Determinism (JR Number Extraction)

Workday job IDs are not always stable across API responses. The worker uses a 4-priority cascade to extract a deterministic identifier (`workdayWorker.js:578-615`):

1. `rawJob.jobRequisition.id` matching `/JR\d{4,}/` (most authoritative)
2. `externalPath` URL slug matching the same pattern
3. `bulletFields` array (NVIDIA puts JR as last bullet)
4. `title` or `name` field (last resort)

Fallback chain if no JR found: `rawJob.id` → `rawJob.jobId` → `rawJob.jobRequisitionId` → externalPath slug → `unknown_{Date.now()}`

Final jobId format: `workday_{tenant}_{JR or fallback}`

### Browser Spoofing Headers

Workday WAF (Akamai) is sensitive to bot-like headers. The worker uses Chrome 120 headers including `Sec-Ch-Ua`, `Sec-Fetch-*` headers (`workdayWorker.js:42-54`).

### Israel Location Detection

For client-side location filtering, the worker uses a broader set of Israel terms than the shared `locationGate.js`:

```javascript
const ISRAEL_TERMS = ['israel', 'tel aviv', 'tel-aviv', 'yokneam', 'haifa',
  'herzliya', 'raanana', 'petah tikva', 'jerusalem'];
```

(`workdayWorker.js:40`)

---

## 29. LinkedIn Client Architecture

### Centralized Axios Client

A single `axiosClient` instance is created at `linkedin_client.js:97-101` with `maxRedirects: 0`. All LinkedIn requests flow through this client.

### Global Interceptor (302/303 → Auth Challenge)

The interceptor at `linkedin_client.js:106-166` handles both success and error callbacks:

- **Success callback:** If `response.status` is 302 or 303 (unlikely since maxRedirects:0 prevents following, but defensive), fires `_adminNotifier.sendAlert('CRITICAL', ...)` via `TelegramAdminNotifier` and rejects with `LinkedInAuthChallengeError`.
- **Error callback:** If the error response status is 302 or 303, same behavior — CRITICAL Telegram alert to admin chat + throw.

This is the "last line of defence" against running the bot while under a challenge/captcha wall.

### `LinkedInAuthChallengeError` Class

Custom error class (`linkedin_client.js:10-16`) that replaces the old `process.exit(1)` pattern. Allows graceful shutdown where the orchestrator can catch the error, send an alert, and still clean up properly (close DB connections, etc.).

### Response Normalization

`normalizeResponse()` at `linkedin_client.js:195-318` handles two Voyager response shapes:
- `{ elements: [...] }` (direct)
- `{ data: { elements: [...], paging: {...}, included: [...] } }` (wrapped)

Each element's `jobCardUnion.*jobPostingCard` URN is resolved against the `included` array to extract `{ jobId, title, company, location, postedAt, url }`.

### Job Details Extraction

`fetchJobDetails()` at `linkedin_client.js:453-627` extracts from GraphQL response at `data.jobsDashJobPostingsById`:

| Field | Source | Notes |
|-------|--------|-------|
| `description` | `root.description.text` | Plain text, newlines normalized |
| `companyApplyUrl` | `root.companyApplyUrl` | External apply link |
| `listedAt` | `root.originalListedAt` ‖ `root.listedAt` | Original posting date (ms epoch) |
| `employmentType` | `root.employmentStatus.localizedName` | "Full-time", "Part-time", etc. |
| `appliesCount` | `root.appliesCount` ‖ `numApplicants` ‖ `numApplied` | Applicant count |
| `simpleApplication` | `root.simpleApplication` ‖ `root.easyApply` | Easy Apply flag |
| `isRepost` | `root.repostedJob` ‖ `root.jobView.repostedJob` ‖ `root.jobPosting.repostedJob` | Repost detection |
| `recruiterId` | `root.posterId` | LinkedIn member ID of poster |
| `skillsDescription` | `root.skillsDescription` | Skills text if available |

### Error Handling Per Status

| Status | Behavior | Location |
|--------|----------|----------|
| 302/303 | `LinkedInAuthChallengeError` thrown + CRITICAL Telegram alert to admin chat | Interceptor (`linkedin_client.js:106-166`) |
| 401 | `Error('CRITICAL_AUTH_FAIL')` thrown | `fetchJobs` error handler (`linkedin_client.js:405-411`) |
| 403 | Logged as auth failure (may indicate cookie issue) | `fetchJobs` error handler (`linkedin_client.js:414-419`) |
| 404 | Returns empty details `{ description: null, ... }` (job expired) | `fetchJobDetails` handler (`linkedin_client.js:594-603`) |
| 429 | `Error('Rate limited (429)')` thrown (caller decides backoff) | `fetchJobDetails` handler (`linkedin_client.js:604-612`) |
| Other | Logged and re-thrown | Both functions |

---

## 30. Email Template Architecture

### Unified Report (`services/EmailNotifier.js`)

The unified report sent by the orchestrator uses `EmailNotifier.sendUnifiedReport(jobs, errors)`:

**Source Labels:**
| Source | Label |
|--------|-------|
| `linkedin` | 🔗 LinkedIn |
| `comeet` | 🟢 Comeet |
| `greenhouse` | 🌿 Greenhouse |

**Job Card HTML Structure:**
Each job is rendered as a card with:
- Title (with source label prefix, e.g., `[🟢 Comeet] Software Engineer`)
- Company name
- Location
- Posted date (relative: "3d ago", "0h ago")
- Apply button (blue, links to job URL)

**Error Summary:**
If errors exist, a yellow warning banner lists each error with source and message.

**Two Report Cases:**
1. **Jobs found:** Subject: `"Job Bot Report - {N} new job(s) found"`, body contains cards + error summary
2. **No jobs found:** Subject: `"Job Bot Report - No new jobs found today"`, body shows 📭 empty state

### Legacy Report (`mailer.js`)

Used when LinkedIn scraper runs standalone (not via orchestrator). Enhanced card format with:
- Employment type badge
- Easy Apply indicator (green pill)
- Applicant count (blue pill)
- Workplace type (Remote/Hybrid/On-site)
- Key skills list (top 5)
- Recruiter name + profile link
- Apply button

---

## 31. Debug Instrumentation (Temporary)

The following files contain `_dbgLog` instrumentation from a previous Cursor debug session. These write synchronously to `.cursor/debug.log` using `fs.appendFileSync`. They are wrapped in `// #region agent log` / `// #endregion` blocks.

| File | Line | Hypothesis ID |
|------|------|---------------|
| `ats/orchestrator.js` | 37 | Various (H2, H5) |
| `services/storage/MongoStorageAdapter.js` | 11 | H1, H4, FIX1 |
| `services/JobStateService.js` | 11 | H1 |

**Status:** Should be removed after production verification succeeds. They have no functional impact but add unnecessary I/O to each run.

**How to find them:** Search for `#region agent log` or `_dbgLog` across the codebase.

---

## 32. Orchestrator Batch Processing & Error Aggregation

### `processBatch()` — Generic Worker Runner

**Location:** `orchestrator.js:119-163`

The `processBatch()` function is a generic sequential runner used by Comeet and Greenhouse. It iterates over companies, calling `worker.fetchAllJobs(company, knownJobIds)` for each.

**Error isolation pattern:** Each company is wrapped in its own `try/catch`. A single company failure does NOT stop processing other companies. Errors are collected into `batchErrors[]` with `{ source: '{workerName}/{companyId}', message }`.

**Result normalization:** The function handles two return shapes from workers:
- Array directly: `rawJobs = workerResult`
- Object with `jobs` array: `rawJobs = workerResult.jobs`

This dual-shape handling was introduced because workers evolved from returning arrays to returning `{ jobs, stats }` objects.

### `processWorkdayBatch()` — Workday-Specific Runner

**Location:** `orchestrator.js:213-313`

Unlike `processBatch()`, this creates a new `WorkdayWorker` instance per company because each Workday tenant requires its own session cookies and API endpoints.

### Error Aggregation Flow

```
runAtsWorkers()
  │
  ├── Promise.all([
  │     processBatch(comeet) → { jobs, errors }
  │     processBatch(greenhouse) → { jobs, errors }
  │     processWorkdayBatch(workday) → { jobs, errors }
  │   ])
  │
  ├── Merge all jobs: [...comeet.jobs, ...greenhouse.jobs, ...workday.jobs]
  │
  └── Merge all errors into orchestrator's `errors[]` array
        └── errors.push(...comeet.errors, ...greenhouse.errors, ...workday.errors)

run() — main function
  │
  ├── Promise.allSettled([
  │     runAtsWorkers(errors, ...) ← mutates shared errors array
  │     runLinkedInPhase(...)       ← returns { jobs, errors } independently
  │   ])
  │
  ├── Extract LinkedIn errors from its result
  │     └── linkedinResult.value.errors → merged into main errors[]
  │
  └── errors[] now contains ALL errors from ALL sources
        └── Passed to emailNotifier.sendUnifiedReport(newJobs, errors)
        └── Passed to persistResults() for run summary
```

### Orchestrator-Level Drops (Deprecated)

The orchestrator no longer maintains a `filteredJobsBuffer`. Workers persist their own dropped jobs to `calibration_rejected` directly. All filter drops occur at the worker level.

### Run Status Determination

**Location:** `orchestrator.js:78-84`

```javascript
function deriveStatus(runStats, errors) {
  if (errors.length > 0 && runStats.companiesSucceeded === 0) return 'ERROR';
  if (errors.length > 0) return 'PARTIAL_FAIL';
  if (runStats.companiesFailed === 0) return 'SUCCESS';
  if (runStats.companiesSucceeded === 0) return 'ERROR';
  return 'PARTIAL_FAIL';
}
```

Three possible statuses. `PARTIAL_FAIL` is the most common in practice — some Workday tenants occasionally return 403s while Comeet/Greenhouse succeed.

---

## 33. Common Gotchas & Architecture Decisions

### Why Workers Don't Share Instances Across Runs

Cloud Run warm containers reuse the same Node.js process. If workers stored state in module-level variables (which they do — e.g., `runStats`, `droppedJobs` arrays), they'd accumulate across runs. This is why:
- `comeetWorker.resetRunStats()` is called before each batch
- `JobStateService` always calls `loadHistory()` fresh, never caches
- No orchestrator-level buffer (workers persist their own calibration_rejected)

### Why `Promise.allSettled` for Top-Level, `Promise.all` for Workers

The orchestrator uses `Promise.allSettled()` for the top-level ATS+LinkedIn parallel execution (`orchestrator.js:530-532`). This ensures that if LinkedIn throws (e.g., `LinkedInAuthChallengeError`), ATS results are still collected and processed.

Within `runAtsWorkers()`, `Promise.all()` is used for the three worker types (`orchestrator.js:230-265`). Since individual company failures are already caught inside `processBatch()`, `Promise.all()` at this level is safe — it only rejects if the entire batch runner fails (e.g., MongoDB connectivity loss).

### Why Workday Has No Silent Dedup

Workday's `processWorkdayBatch()` does not pass `knownJobIds` to the worker. Two reasons:
1. Workday job IDs are less stable than Comeet/Greenhouse (JR numbers may change format across API versions)
2. Workday was added later in the architecture timeline, after the silent dedup pattern was established for the other two

This means Workday jobs go through the full `JobStateService.filterNewJobs()` dedup in Phase 3 instead. The practical impact is slightly more writes to `calibration_rejected` from Workday.

### Why `csv-parser` Is a Dev Dependency

`csv-parser` is used only by `FileStorageAdapter.loadCompanies()` to parse `greenhouse_list.csv`. In production (MongoDB), companies come from the `companies` collection. Since `npm ci --omit=dev` is used in the Dockerfile, `csv-parser` is excluded from the Docker image. The `FileStorageAdapter` has a fallback path that manually splits CSV lines if `csv-parser` is unavailable.

### CSRF/JSESSIONID Must Match

At `linkedin_client.js:47-60`, a validation check compares `LINKEDIN_CSRF_TOKEN` and `LINKEDIN_JSESSIONID` (after stripping surrounding quotes). They must be identical — LinkedIn uses the JSESSIONID cookie value as the CSRF token. A mismatch means the values were copied from different browser sessions, which will trigger a security challenge.

---

## 34. Job ID Conventions & Dedup Key Space

Understanding how job IDs are constructed is critical for dedup correctness.

### ID Format by Source

| Source | Format | Example | Construction | Uniqueness |
|--------|--------|---------|--------------|------------|
| LinkedIn | Numeric string | `"3847291056"` | Extracted from `jobPostingUrn` or `entityUrn` — first numeric sequence | Globally unique within LinkedIn |
| Comeet | `comeet_{position_uid}` | `"comeet_abc123def456"` | `comeetWorker.js` prefixes raw position UID | Unique per Comeet tenant; UID is a hex string |
| Greenhouse | `greenhouse_{id}` | `"greenhouse_4502891"` | `greenhouseWorker.js` prefixes raw numeric ID | Unique per Greenhouse board; numeric auto-increment |
| Workday | `workday_{tenant}_{JR or id}` | `"workday_nvidia_JR1234567"` | `workdayWorker.js` prefixes tenant + JR number or fallback ID | Unique per Workday tenant; JR is human-readable |

### Dedup Collision Risk

The source prefix (`comeet_`, `greenhouse_`, `workday_`) ensures no cross-source collisions. LinkedIn IDs have no prefix but are large numeric values with no overlap risk against prefixed strings.

Within each source, the UID/ID is guaranteed unique by the ATS platform. The only risk is Workday's fallback ID path (`unknown_{Date.now()}`) which could theoretically collide if two companies happen to return an unknown ID at the exact same millisecond — extremely unlikely.

### Where IDs Are Checked

| Checkpoint | Set Used | Purpose |
|-----------|----------|---------|
| Worker silent dedup | `knownJobIds` (from `ats_sent_history`) | Skip already-emailed jobs before filtering |
| LinkedIn seenIds dedup | `seenIds` (from `seen_jobs`) | Skip already-seen LinkedIn search results |
| Phase 3 dedup | `JobStateService.sentJobIds` (from `ats_sent_history`) | Final dedup before email for all sources |
| Phase 3 within-run dedup | `JobStateService.newJobIds` | Prevent same job from appearing twice in one email |

---

## 35. Snapshot System

The project maintains technical snapshots in `docs/snapshots/` that capture the full system state at a point in time. These are the Browser model's primary session-initialization context.

### Latest Snapshot

`docs/snapshots/snapshot_2026-03-20` — v7.1 (Distributed resilience, GCS lock/flag strategy, quota Catch-22 mitigation)

### Snapshot Contents

Each snapshot includes:
1. System Architecture View (ASCII diagram + collection table)
2. Current Phase Status (milestones, blockers)
3. Core Achievements (what changed and why)
4. Contextual Delta (vs. previous snapshot)
5. Configuration Snapshot (jitter, keywords, env vars)
6. Observability & Maintenance (commands, logs, failure modes)
7. Next Strategic Steps (P0/P1/P2 priorities)

### Session Transcripts

Detailed session logs are stored in `docs/rewsession/`. These provide the "why" behind architectural decisions and are referenced from snapshots.

---

## Change Log

| Date | Version | Sections Modified | Summary |
|------|---------|-------------------|---------|
| 2026-03-23 | v7.1 | §1, §2, §3, §4, §5, §6, §7, §11, §12, §14, §15, §16, §17, §27, §35 | Added GCS lock/alert architecture, logical quota trigger (200MB; report-then-purge headroom), aggressive cleanup modes, quota fail-safe exit masking, new scripts (`emergency_purge`, `verify:calibration`), TTL/index and file-map refresh |
| 2026-03-08 | v6.3 | §1, §3, §4, §5, §7, §8, §9, §11, §12, §13, §16, §18, §27, §31, §32, §33, §35 | Proactive calibration CLI, system_state collection, harvest_tokens failure evasion, filteredJobsBuffer removed, line count/line number updates, new tools (run_proactive_calibration, calibrationReport), RESET_DEDUP/DISCOVERY_DRY_RUN env vars |

---

## Quality Verification

- [x] Every file path mentioned exists in the workspace
- [x] All newly added/updated line number references verified via `rg` against current codebase
- [x] No TODO or placeholder sections
- [x] All 17 required sections present and populated (plus 18 bonus sections = 35 total)
- [x] Critical Invariants section (§9) contains 12 numbered rules with file:line evidence
- [x] No application code modifications were made — documentation update only
- [x] Tables used throughout for information density
