# Sub-PRD: Greenhouse Worker Calibration & Optimization (v2.0)

## 1. Overview and Objectives

This document is a child PRD derived from the **MasterPRD-AutomatedCalibration&WorkerValidationSystem.md**. It defines the specific architectural refactoring required for the Greenhouse ATS Worker (`ats/workers/greenhouseWorker.js`).

The objective is to eliminate "data murder" (loss of rich `offices[]` metadata, discarded `first_published` timestamps, ignored `metadata[]` custom fields), fix the Location Gate's reliance on hardcoded city arrays, and enforce the **Hub & Spoke** contract where the worker is strictly an **adapter** that normalizes data and hands it off to the centralized `evaluateAtsGuard` module.

> **Architectural Invariant**: The Greenhouse worker MUST NOT contain any local semantic filtering logic (title blacklists, whitelist checks, department blacklists, description regex). All semantic decisions are the exclusive responsibility of `ats/filters/ats_guard.js` and its single centralized Vocabulary Bank (`config/vocabulary.js`). This is mandatory for cross-worker calibration parity with Comeet and future Workday spokes.

---

## 2. Target Audience & Problem Statement

**Target Audience**: Lead Architect / System Administrator.

**Problem Statement**: The current Greenhouse worker suffers from five compounding defects:

| # | Defect | Impact |
|---|---|---|
| 1 | **Dual-filter architecture** — `filterJob()` runs a local title blacklist and department blacklist *before* `evaluateAtsGuard()`, using different term lists. | Maintenance divergence: two independent blacklists with different terms. Calibration reports cannot attribute drops to a single source of truth. |
| 2 | **Hardcoded location cities** — Location gate checks a static list (`"tel aviv"`, `"haifa"`, `"jerusalem"`) embedded in worker code, missing "Herzliya" and "Rehovot". | Silent data loss for companies headquartered in those cities (e.g., Check Point, Elbit). |
| 3 | **`offices[]` array ignored** — The richest geo-metadata in the payload (`offices[].location: "Tel Aviv-Yafo, Tel Aviv District, Israel"`) is never inspected. | Jobs with vague `location.name` (e.g., `"Israel"`) that have precise office strings are either misclassified or dropped. Multi-office jobs are invisible. |
| 4 | **`first_published` discarded** — `postedAt` maps to `updated_at`, inflating apparent job freshness on every minor edit. | Stale jobs re-surface as "new" after salary or description tweaks, polluting candidate feeds. |
| 5 | **`metadata[]` discarded** — Polymorphic custom fields like "Job Level" (Taboola), "Hiring Range" (Riskified) are silently dropped. | Lost structured seniority signals that could bypass expensive fuzzy description regex entirely. |

---

## 3. Architecture: Hub & Spoke Contract

The Greenhouse worker is a **Spoke** — a pure data-extraction and normalization adapter. It owns exactly two responsibilities:

```
┌──────────────────────────────────────────────────────────┐
│                    Greenhouse Spoke                       │
│                                                          │
│  1. FETCH   — HTTP GET to boards-api.greenhouse.io       │
│  2. NORMALIZE — Map raw payload → UnifiedJob schema      │
│                                                          │
│  Outputs: { jobs: UnifiedJob[], stats }                  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│              Hub: evaluateAtsGuard()                      │
│              Source: ats/filters/ats_guard.js             │
│              Vocab:  config/vocabulary.js                 │
│                                                          │
│  ● Title Technical Check (technicalTitleKeywords)        │
│  ● Title Seniority Check (titleSeniorPatterns)           │
│  ● Department Check (departmentsBlacklist)               │
│  ● Description Seniority Check (contentSeniorityPatterns)│
│  ● Structured Seniority Fast-Track (metadata signals)    │
└──────────────────────────────────────────────────────────┘
```

**What the worker MUST NOT do**:
- Contain any `titleBlacklist` or `titleWhitelist` array.
- Run any `.includes('senior')` or `.includes('manager')` checks on titles.
- Maintain a local `departmentBlacklist`.
- Execute any description-scanning regex.

All of these belong to the Guard. The worker's `filterJob()` function must be reduced to a single concern: the **Location Gate** (geo-filtering), and even that must use the centralized location vocabulary rather than hardcoded strings.

---

## 4. Functional Requirements

### 4.1 Fetching Protocol

**Endpoint**: `GET https://boards-api.greenhouse.io/v1/boards/{uid}/jobs?content=true`

**Pagination**: None required. Greenhouse's public Board API returns all active jobs in a single response.

**Retry**: The worker currently has zero retry logic (retries are only wired for Comeet). Add a single-retry with exponential backoff for transient failures (HTTP 429, 5xx, `ECONNABORTED`). Reuse the existing `requestWithRetry` infrastructure from `httpClientWrapper.js` by passing `{ provider: 'greenhouse', maxRetries: 1, retryOn429: true, retryOn5xx: true, retryOnTimeout: true }`.

**Politeness Delay**: Retain the current human-like random delay (6–12 seconds) between company requests. Do not reduce this — it is calibrated to avoid Greenhouse WAF blocks.

### 4.2 Location Gate (Hard Filter — Worker Responsibility)

The Location Gate is the **only** filter that remains inside the worker. It runs before normalization to discard obviously irrelevant global jobs early, saving processing and Guard invocations.

**Data Sources** (both must be inspected, in order):

1. `rawJob.location.name` — the primary location string.
2. `rawJob.offices[]` — iterate every office object, inspecting both `offices[i].name` and `offices[i].location`.

**Matching Algorithm**:
1. Aggregate all location strings from both sources into a single array.
2. Lowercase each string.
3. Check against the **centralized location list** exported from `config/vocabulary.js` (new export: `israelLocationKeywords`). The worker MUST NOT contain a hardcoded city list.
4. Also pass if any aggregated string contains `"remote"`.

**Required vocabulary.js addition**:

```javascript
const israelLocationKeywords = [
  'israel',
  'tel aviv',
  'tel-aviv',
  'herzliya',
  'haifa',
  'rehovot',
  'jerusalem',
  'ramat gan',
  'petah tikva',
  'beer sheva',
  'netanya',
];
```

**Rationale**: Centralizing the city list in vocabulary.js allows all spokes (Greenhouse, Comeet, Workday) to share the same location vocabulary, and the calibration system to report on location-gate accuracy uniformly.

### 4.3 Data Normalization (`normalizeGreenhouseJob`)

All extracted jobs must be converted to the **UnifiedJob** schema. The normalization function is the core of the Spoke's value — it must extract every useful field from the raw payload, including fields the Guard will need downstream.

| Unified Field | Raw Greenhouse Field | Normalization Rule |
|---|---|---|
| `jobId` | `id` | **Must be prefixed with `gh_`** (e.g., `gh_7644473003`). Current `greenhouse_` prefix is incorrect and breaks dedup parity. |
| `title` | `title` | Trimmed string. |
| `companyName` | `company_name` | Use the payload's `company_name`. Fallback to orchestrator `company.name` if missing. |
| `location` | `location.name` | Primary location string, trimmed. |
| `offices` | `offices[]` | **NEW** — Preserve the full `offices` array as-is. Each office object contains `{ id, name, location, child_ids, parent_id }`. |
| `url` | `absolute_url` | Direct apply link. |
| `postedAt` | `first_published` | **Use `first_published`** to represent the true creation date. Fallback to `updated_at` only if `first_published` is null. |
| `updatedAt` | `updated_at` | **NEW** — Preserve separately for staleness detection. |
| `description` | `content` | HTML content with basic entity decoding. |
| `departments` | `departments[]` | **Full array** — preserve `{ id, name, child_ids, parent_id }` objects, not just names. The Guard needs the names for filtering; the hierarchy is preserved for future calibration analysis. |
| `metadata` | `metadata` | **NEW** — Preserve the full polymorphic `metadata` array as-is. See Section 4.4. |
| `language` | `language` | **NEW** — Preserve for potential multilingual filtering. |
| `requisitionId` | `requisition_id` | **NEW** — Preserve for cross-posting dedup (same requisition re-posted under new job ID). |
| `internalJobId` | `internal_job_id` | **NEW** — Preserve for admin cross-referencing. |
| `source` | (hardcoded) | `'greenhouse'` |
| `sourceCompanyId` | `company.id` | From orchestrator config. |
| `raw` | (entire object) | Retained for debug mode only. Strip in production via a flag to reduce storage. |

### 4.4 Metadata Extraction — Structured Seniority Fast-Track

The `metadata` field is a polymorphic array whose shape varies by company. Observed examples from raw samples:

```json
// Riskified
"metadata": [
  { "id": 24683490002, "name": "Hiring Range", "value": null, "value_type": "currency_range" }
]

// Taboola (observed in other Greenhouse boards)
"metadata": [
  { "name": "Job Level", "value": "Junior", "value_type": "single_select" },
  { "name": "Employment Type", "value": "Full-Time", "value_type": "single_select" }
]
```

**Worker responsibility** (normalization, not filtering):

1. After preserving the full `metadata` array on the UnifiedJob, the worker must also extract a convenience field `structuredLevel` by scanning `metadata` for an entry where `name` matches (case-insensitive) any of: `"Job Level"`, `"Level"`, `"Seniority"`, `"Experience Level"`.
2. If found, set `unifiedJob.structuredLevel = metadataEntry.value` (e.g., `"Junior"`, `"Mid-Level"`, `"Senior"`).
3. If not found, set `unifiedJob.structuredLevel = null`.

**Guard responsibility** (filtering — in `ats_guard.js`):

The ATS Guard must be updated to check `structuredLevel` **before** running the expensive description regex. If `structuredLevel` is a recognized junior indicator (e.g., `"Junior"`, `"Entry Level"`, `"Intern"`, `"Student"`), the Guard can **fast-pass** the job without scanning the HTML description. If it is a recognized senior indicator (e.g., `"Senior"`, `"Staff"`, `"Principal"`, `"Director"`), the Guard can **fast-fail**. This mirrors the Comeet sub-PRD's `experience_level` fast-track pattern.

### 4.5 Department Collision Override — Technical Override Rule

Greenhouse jobs can belong to **multiple departments** simultaneously. Observed example:

```json
"departments": [
  { "id": 4020743003, "name": "R&D", "parent_id": 4051763003 },
  { "id": 4008372006, "name": "Sales", "parent_id": null }
]
```

The current logic in both `filterJob()` and `ats_guard.js` applies a simple blacklist: if **any** department is blacklisted, the job is dropped. This creates false negatives for cross-functional roles (e.g., a Sales Engineer sitting in both "Engineering" and "Sales").

**Required behavior** (implemented in `ats_guard.js`, not the worker):

1. Extract all department names from the `departments[]` array.
2. Check each name against `departmentsBlacklist` (from `vocabulary.js`).
3. Check each name against `allowedTechnicalDepartments` (from `vocabulary.js`).
4. **Technical Override Rule**: If at least one department is in `allowedTechnicalDepartments`, the job **passes** the department gate regardless of whether other departments are blacklisted.
5. The job only **fails** the department gate if it has at least one blacklisted department and **zero** technical departments.

**The worker's role**: Ensure the full `departments[]` array (with objects, not just name strings) is preserved on the UnifiedJob so the Guard has the data it needs to apply this rule.

---

## 5. Non-Functional Requirements

### 5.1 Error Handling & Fail-Safe

| Scenario | Required Behavior |
|---|---|
| HTTP 404 (board not found, e.g., Snyk) | Log `WARN`. Return `{ jobs: [], stats }` with `status404: 1`. Proceed to next company. |
| HTTP 403 / 406 (WAF block) | Log `WARN`. Increment `status403` / `status406`. No crash. |
| HTTP 429 (rate limit) | **Retry once** after `Retry-After` header (or 15s default backoff). If second attempt fails, log `WARN` and proceed. |
| HTTP 5xx (server error) | **Retry once** after 5s backoff. If second attempt fails, log `WARN` and proceed. |
| Timeout (`ECONNABORTED`) | **Retry once** after 5s backoff. Log `WARN` on final failure. |
| Network error (DNS, connection refused) | No retry. Log `ERROR`. Proceed to next company. |

**Invariant**: The worker must never crash the orchestrator loop. Every code path must return the `{ jobs, stats }` contract.

### 5.2 Observability

Every job processed must produce a lightweight trace record suitable for the calibration system:

- **Passed jobs** → `calibration_passed` with: `jobId`, `title`, `companyName`, `location`, `matchedLocationKeyword`, `structuredLevel`, `matchedWhitelistKeyword` (from Guard), `source: 'greenhouse'`.
- **Dropped jobs** → `calibration_rejected` with: `jobId`, `title`, `companyName`, `location`, `reason` (from Guard: exact pattern that triggered the drop), `gate` (which gate: `location | title | department | description | structured_level`), `source: 'greenhouse'`.

---

## 6. Gap Analysis & Required Changes

### GAP 1 — Local Filter Duplication (CRITICAL)

**Current state**: `filterJob()` in `greenhouseWorker.js` (lines 208–278) contains a hardcoded title blacklist, department blacklist, and location gate — all independent of the Guard.

**Required change**: Gut `filterJob()` down to the Location Gate only. Remove the title blacklist array (`['senior', 'sr.', ...]`), the department blacklist array (`['sales', 'legal', ...]`), and all associated logic. After location filtering and normalization, pass the UnifiedJob directly to `evaluateAtsGuard()`.

### GAP 2 — Hardcoded Location Cities

**Current state**: Location keywords are hardcoded in `filterJob()` (lines 224–229): `'israel'`, `'tel aviv'`, `'tel-aviv'`, `'haifa'`, `'jerusalem'`. Missing: `'herzliya'`, `'rehovot'`.

**Required change**: Import `israelLocationKeywords` from `config/vocabulary.js`. Remove all inline city strings. Iterate both `location.name` and `offices[]` against the centralized list.

### GAP 3 — `offices[]` Ignored

**Current state**: The `offices` array is never read. Jobs with precise office geo-strings like `"Tel Aviv-Yafo, Tel Aviv District, Israel"` only get matched via the less precise `location.name`.

**Required change**: In the Location Gate, aggregate `offices[i].name` and `offices[i].location` into the location-matching pool before running keyword checks.

### GAP 4 — `first_published` Ignored

**Current state**: `postedAt` maps to `updated_at`. The `first_published` field is never read.

**Required change**: Map `postedAt` to `first_published`. Preserve `updated_at` as a separate `updatedAt` field.

### GAP 5 — `metadata[]` Ignored

**Current state**: The `metadata` array is never inspected. Structured seniority signals are lost.

**Required change**: Preserve `metadata` on the UnifiedJob. Extract `structuredLevel` convenience field per Section 4.4.

### GAP 6 — `jobId` Prefix Mismatch

**Current state**: Prefix is `greenhouse_` (e.g., `greenhouse_7644473003`).

**Required change**: Change prefix to `gh_` (e.g., `gh_7644473003`) for dedup parity with the expected schema.

### GAP 7 — Department Collision (in Guard)

**Current state**: `ats_guard.js` `runDepartmentCheck` fails the job if **any** department is blacklisted, ignoring co-existing technical departments.

**Required change**: Implement the Technical Override Rule per Section 4.5 inside `ats_guard.js`.

### GAP 8 — No Retry Logic for Greenhouse

**Current state**: `requestWithDelayWrapper` is called with no provider/retry options.

**Required change**: Pass `{ provider: 'greenhouse', enableRetries: true, maxRetries: 1, retryOn429: true, retryOn5xx: true, retryOnTimeout: true }`.

---

## 7. Release Plan & Timeline

| Phase | Scope | Files Touched |
|---|---|---|
| **Phase 1: Vocabulary Centralization** | Add `israelLocationKeywords` to `config/vocabulary.js`. | `config/vocabulary.js` |
| **Phase 2: Worker Gut & Rewire** | Remove local blacklists from `filterJob()`. Rewrite Location Gate to use `offices[]` + centralized vocabulary. Fix `jobId` prefix to `gh_`. Map `first_published` → `postedAt`. Preserve `offices`, `metadata`, `departments` (full objects), `language`, `requisitionId` on UnifiedJob. Extract `structuredLevel`. | `ats/workers/greenhouseWorker.js` |
| **Phase 3: Guard Enhancements** | Implement Technical Override Rule in `runDepartmentCheck`. Add `structuredLevel` fast-track before `runDescriptionCheck`. Return `matchedKeywords` / `matchedBlacklistPatterns` for observability. | `ats/filters/ats_guard.js` |
| **Phase 4: Retry Wiring** | Register Greenhouse as a provider in `httpClientWrapper.js`. Pass retry options from `fetchAllJobs`. | `ats/utils/httpClientWrapper.js`, `ats/workers/greenhouseWorker.js` |
| **Phase 5: Observability Integration** | Ensure passed and dropped jobs carry the required trace fields for the calibration system's aggregation queries. | `ats/workers/greenhouseWorker.js` |

---

## 8. Metrics for Success

| KPI | Target | Measurement |
|---|---|---|
| **Gate Attribution Accuracy** | 100% of Greenhouse jobs saved to `calibration_passed` and `calibration_rejected` carry the precise `gate`, `reason`, and `matchedKeywords` fields. | Weekly calibration report. |
| **Location Yield Parity** | Zero relevant Israel-based junior/student tech jobs lost due to missed `offices[]` parsing or missing city keywords. | Compare pre/post refactor yields for the same company set. |
| **Freshness Integrity** | `postedAt` reflects `first_published` for all jobs where the field is present. No false freshness from `updated_at`. | Spot-check sample of 50 jobs. |
| **Resilience** | 100% orchestrator-loop completion rate across the full company roster, regardless of individual Greenhouse board downtimes (404s, timeouts). | `run_summaries` logs. |
| **Structured Seniority Hit Rate** | Track what percentage of Greenhouse jobs carry a non-null `structuredLevel` from `metadata[]`. Baseline measurement in first calibration cycle. | `calibration_passed` aggregation on `structuredLevel IS NOT NULL`. |
| **Single Vocabulary Source** | Zero hardcoded filter terms remaining in `greenhouseWorker.js`. All semantic vocabulary sourced from `config/vocabulary.js`. | Code review / grep audit. |
