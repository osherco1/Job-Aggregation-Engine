# Sub-PRD: Workday Worker Calibration & Refactoring (v2.0)

## 1. Overview and Objectives

This document is a child PRD derived from the **MasterPRD-AutomatedCalibration&WorkerValidationSystem.md**. It defines the specific architectural refactoring and calibration requirements for the Workday ATS Worker (`ats/workers/workdayWorker.js`).

The objective is to eliminate the worker's current "ghost" status (where it drops data in-memory without persistence), fix critical flaws in its API payload handling (nested location facets, ID extraction, and ignored structured facets), achieve 100% observability parity with the main orchestrator loop, and leverage Workday's rich `workerSubType` / `jobFamilyGroup` facets to compensate for the permanent absence of job descriptions in the List API response.

> **Architectural Invariant**: The Workday worker is a **Spoke** — a session-based data-extraction and normalization adapter. It owns exactly three responsibilities: (1) Session management & API communication, (2) Nested facet traversal for server-side pre-filtering, and (3) Normalization of flat job objects into the UnifiedJob schema. All semantic filtering decisions are the exclusive responsibility of `ats/filters/ats_guard.js`.

---

## 2. Target Audience & Problem Statement

**Target Audience**: Lead Architect / System Administrator.

**Problem Statement**: The Workday worker currently operates in complete isolation. Dropped jobs are only tracked in transient memory and discarded at the end of the run, leaving the database blind to its filtering performance. Furthermore, empirical data analysis (baseline snapshot, 2026-03-01) revealed seven compounding defects:

| # | Defect | Impact |
|---|---|---|
| 1 | **Persistence Isolation** — `fetchJobs` counts `stats.droppedByReason` but never persists dropped jobs. `fetchAllJobs` then discards even the stats object. | Zero observability. The calibration system is completely blind to Workday. |
| 2 | **Nested Facet Traversal Failure** — `detectLocationFacet` reads `f.facetId` but the real API field is `f.facetParameter`. The `locationMainGroup` facet is a multi-tier hierarchy (`locationMainGroup` → `locationHierarchy1` / `locations`) that the flat-array scan cannot traverse. | Server-side Israel filtering silently fails. Worker falls back to `searchText` only, fetching far more jobs than necessary. |
| 3 | **ATS Guard Blindness** — `evaluateAtsGuard(rawJob)` passes the raw Workday object, which has `locationsText` (not `location`), no `departments`, no `content`/`description`. The Guard's `extractJobFields` reads empty strings for all three. | Guard operates on title regex only. Department blacklist and description seniority checks are inert — a 0% drop rate that is a bug, not a success. |
| 4 | **Structured Facet Waste** — The API returns `workerSubType` (e.g., "Intern (Fixed Term)", "New College Graduate", "Management") and `jobFamilyGroup` (e.g., "Engineering", "Sales") on every response, but the worker completely ignores them. | The single strongest signal for detecting junior/intern roles is discarded. With `description: null`, this is the only structured seniority data available. |
| 5 | **ID Extraction Fragility** — `bulletFields[0]` is assumed to contain a JR number, but Cisco uses plain numeric IDs (`"2007381"`) and Intel uses spotlight labels. The JR regex `/JR\d{4,}/` misses these entirely. | Inconsistent `jobId` format across tenants; potential dedup collisions when falling back to `externalPath` slugs. |
| 6 | **Multi-Location Blindness** — When `locationsText` is `"4 Locations"` or `"5 Locations"`, all fallback tiers fail. `externalPath` extraction recovers only the first city. | Israel-based multi-location jobs may be dropped by the client-side location filter. |
| 7 | **Return Contract Mismatch** — `fetchAllJobs` returns `result.jobs` (a bare array), while Comeet and Greenhouse return the standardized `{ jobs, stats }` object. | The orchestrator cannot process Workday run statistics, breaking cross-worker parity in the calibration report. |

---

## 3. Architecture: Hub & Spoke Contract

The Workday worker is a **Spoke** — a session-based data-extraction and normalization adapter. It owns exactly three responsibilities:

```
┌──────────────────────────────────────────────────────────┐
│                    Workday Spoke                          │
│                                                          │
│  1. SESSION — Establish PLAY_SESSION + wday_vps_cookie   │
│  2. FETCH   — POST to /wday/cxs/{tenant}/{site}/jobs    │
│     ├─ Nested facet detection (locationMainGroup)        │
│     ├─ Dual-filter: searchText + appliedFacets           │
│     └─ Paginated retrieval (20/page, 5-6s jitter)       │
│  3. NORMALIZE — Map flat job + facet data → UnifiedJob   │
│     ├─ Robust ID extraction (JR / numeric / slug)        │
│     ├─ Location cascade (locationsText → externalPath)   │
│     └─ Facet-to-field mapping:                           │
│        • workerSubType  → structuredLevel                │
│        • jobFamilyGroup → structuredDepartment           │
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
│  ● Structured Seniority Fast-Track (structuredLevel)     │
│  ● Description Seniority Check — N/A for Workday        │
│    (description: null; structuredLevel compensates)       │
└──────────────────────────────────────────────────────────┘
```

**What the worker MUST NOT do**:
- Contain any title blacklist or whitelist array.
- Run any `.includes('senior')` or `.includes('manager')` checks on titles.
- Maintain a local department blacklist.
- Execute any description-scanning regex.

**What the worker MUST do** (unique to Workday):
- Extract `workerSubType` and `jobFamilyGroup` from the response-level `facets[]` array and map them onto each job as `structuredLevel` and `structuredDepartment`. These fields are the primary compensation mechanism for the permanent `description: null` limitation.
- Construct a dedicated `guardPayload` for the ATS Guard that explicitly declares `departments`, `description`, `structuredLevel`, and `structuredDepartment`, so the Guard can route the job through the correct evaluation path.

---

## 4. Functional Requirements

### 4.1 Session & Fetching Protocol

**Session Init**: GET the main career site page to establish `PLAY_SESSION` and `wday_vps_cookie`. Wait 2s for Akamai sensors. Proceed to API calls on success. On failure, log `WARN` and attempt API calls anyway (some tenants work without cookies).

**API Endpoint**: `POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`

**Pagination**: Page size = 20. Loop with `offset += 20` while `jobs.length === 20 && offset < total`. Enforce 5–6s random jitter ("Ironclad Jitter") between pages.

**Dual-Filter Strategy**:
1. **PRIMARY** — `searchText: "Israel"` (always applied, server-side text search).
2. **BONUS** — `appliedFacets: { [facetParam]: [valueId] }` (applied only if `detectLocationFacet` successfully traverses the nested hierarchy and finds an Israel value).

**HTTP Error Handling & WAF Observability**:

| Scenario | Required Behavior |
|---|---|
| HTTP 200 | Normal processing. Log page stats. |
| **HTTP 403 (WAF block)** | **CRITICAL**: Log `ERROR` with `[WAF_BLOCK]` prefix including tenant name, page offset, and timestamp. Increment `stats.wafBlocks` counter. Persist the 403 event in `stats.httpErrors[]` as `{ status: 403, offset, timestamp }`. Do NOT crash — set `hasMore = false` and return partial results. |
| HTTP 429 (rate limit) | Log `WARN`. No retry (Workday has no `Retry-After` header). Set `hasMore = false`. |
| HTTP 5xx (server error) | Log `WARN`. Increment `stats.serverErrors`. Set `hasMore = false`. |
| Network error / timeout | Log `ERROR`. Record in `stats.errors[]`. Set `hasMore = false`. |

**Rationale for 403 observability**: Workday's Akamai WAF is the primary operational risk for this worker. Silent 403s during pagination cause partial data collection without any indication in the calibration report. The `stats.wafBlocks` counter and `stats.httpErrors[]` array provide the administrator with immediate visibility.

### 4.2 Location Gate (Hard Filter — Worker Responsibility)

The Location Gate is the **only** filter that remains inside the worker. It runs after normalization to discard obviously irrelevant global jobs early.

**Behavior**:
- If a server-side facet filter was applied (Israel facet detected), the client-side location gate is **skipped** (trust the API).
- If no facet filter was applied, inspect `unified.location` against the centralized `israelLocationKeywords` from `config/vocabulary.js`. Also pass if location contains `"remote"`.
- Jobs matching `"remote"` but not Israel are **kept** (conservative — let the Guard decide).

The worker MUST NOT contain a hardcoded `ISRAEL_TERMS` array. Import `israelLocationKeywords` from `config/vocabulary.js`.

### 4.3 Data Normalization (`_normalizeJob`)

All extracted jobs must be converted to the **UnifiedJob** schema. The normalization function is the core of the Spoke's value.

| Unified Field | Raw Workday Field | Normalization Rule |
|---|---|---|
| `jobId` | `bulletFields[]`, `externalPath` | **Robust regex cascade** — see Section 4.4. |
| `title` | `title`, `bulletFields[]` | First candidate that is not JR-only, not a location indicator, not an employment-type string. `rawJob.title` wins in practice. |
| `companyName` | (from config) | `this.companyName` injected at construction. |
| `location` | `locationsText`, `externalPath` | Primary: `locationsText`. If it contains "N Locations", fall back to `externalPath` city extraction. See Section 4.5. |
| `url` | `externalPath` | `{siteUrl}{externalPath}`. |
| `postedAt` | `postedOn` | Parse relative strings ("Posted Today", "Posted 2 Days Ago") to ISO dates. |
| `description` | — | **Hardcoded `null`**. The Workday List API does not return descriptions. This is a permanent limitation, not a bug. |
| `structuredLevel` | Response-level `facets[]` → `workerSubType` | **NEW — MANDATORY**. See Section 4.6. |
| `structuredDepartment` | Response-level `facets[]` → `jobFamilyGroup` | **NEW — MANDATORY**. See Section 4.6. |
| `timeType` | `timeType` | **NEW** — Preserve if present (e.g., `"Full time"`). Not all tenants return this field. |
| `source` | (hardcoded) | `'workday'` |
| `sourceCompanyId` | `this.tenant` | Extracted from URL at construction. |
| `raw` | (entire object) | Retained for debug mode only. |

### 4.4 Robust ID Extraction

The current JR-only regex (`/JR\d{4,}/`) fails for tenants that use plain numeric IDs (Cisco: `"2007381"`) or spotlight labels (Intel). The extraction must use a unified regex cascade:

**Canonical ID Regex**: `/^(JR[-]?\d+|R\d+|\d{5,})$/i`

**Extraction cascade** (in priority order):

1. `bulletFields[]` — scan all elements (not just last) against the canonical regex. First match wins.
2. `externalPath` — extract the segment after the last `_` (e.g., `..._JR2013520-1` → `JR2013520`, `..._2007381` → `2007381`). Strip trailing `-N` suffixes.
3. `rawJob.title` / `rawJob.name` — scan for embedded JR patterns (rare, last resort).

**Final `jobId` format**: `workday_{tenant}_{extractedId}`

Examples:
- NVIDIA: `workday_nvidia_JR2013520`
- Cisco: `workday_cisco_2007381`
- Unknown: `workday_intel_Senior-Engineer_path-slug` (slug fallback — should be rare)

### 4.5 Location Fallback Chain

| Tier | Source | When Used |
|---|---|---|
| 1 | `rawJob.locationsText` | Primary. Works for most jobs. |
| 2 | `externalPath` → `/job/([^/]+)/` | When `locationsText` contains `"N Locations"`. Extracts first city, replaces `-` with `, `. |
| 3 | `"Multiple Locations"` (literal) | Terminal fallback when tier 2 also fails. The job is preserved with a generic location — the Guard decides its fate. |

The worker MUST NOT drop a job solely because location extraction failed. Set a fallback and let the location gate + Guard handle it.

### 4.6 Facet-to-Field Mapping: `workerSubType` & `jobFamilyGroup` (MANDATORY)

**Context**: Workday's List API returns `description: null` for every job. This means the ATS Guard's `runDescriptionCheck` (content seniority regex) is permanently inert for Workday. The `workerSubType` and `jobFamilyGroup` facets are the **only** structured signals available to compensate. Deferring this to "Future Scope" would leave the Guard operating on title-only heuristics for the entire Workday pipeline — an unacceptable accuracy gap.

**API reality** (from raw samples):

The `facets[]` array is returned at the **response level**, not per-job. It contains aggregate counts, not per-job associations. However, the facet data provides tenant-level classification that can be used in two ways:

**Strategy A — Per-Job `bulletFields` / `timeType` mapping** (where available):
Some tenants embed `timeType` directly on each job object. When present, map it.

**Strategy B — Response-Level Facet Lookup Table** (primary strategy):
1. On the first API response, parse `facets[]` and build two lookup maps:
   - `workerSubTypeLookup`: `{ id → descriptor }` (e.g., `"0c40f6bd..." → "Intern (Fixed Term)"`)
   - `jobFamilyGroupLookup`: `{ id → descriptor }` (e.g., `"0c40f6bd..." → "Engineering"`)
2. Cache these maps on the worker instance for the duration of the run.
3. During normalization, the worker cannot directly associate a specific facet value to a specific job from the List API alone. Therefore:
   - Set `structuredLevel = null` per-job by default from the list endpoint.
   - Set `structuredDepartment = null` per-job by default from the list endpoint.
   - **Preserve the full facet lookup maps on `stats`** so the calibration system can report on the tenant's distribution (e.g., "NVIDIA has 101 Intern postings, 76 New College Grad postings").

**Strategy C — Per-Job Detail Fetch** (targeted enrichment, optional but recommended for Phase 2+):
For jobs that pass the Location Gate and are candidates for the Guard, the worker MAY issue a targeted GET to `/wday/cxs/{tenant}/{site}/jobs/{externalPath}` to retrieve the full job detail, which includes the per-job facet associations. If this is implemented:
   - Set `structuredLevel` to the matched `workerSubType.descriptor` (e.g., `"Intern (Fixed Term)"`, `"New College Graduate"`, `"Regular Employee"`, `"Management"`).
   - Set `structuredDepartment` to the matched `jobFamilyGroup.descriptor` (e.g., `"Engineering"`, `"Sales"`).
   - Apply the same Ironclad Jitter delay (5-6s) for each detail fetch.

**Guard responsibility** (in `ats_guard.js`):

The ATS Guard must check `structuredLevel` **before** `runDescriptionCheck`. Known mappings:

| `workerSubType` descriptor | Guard action |
|---|---|
| `"Intern (Fixed Term)"`, `"Intern (Fixed Term) (Seasonal) (Trainee)"` | **Fast-PASS** — this is a junior/student role. |
| `"New College Graduate"` | **Fast-PASS** — entry-level role. |
| `"Academic (Fixed Term)"` | **Fast-PASS** — academic/student role. |
| `"Regular Employee"`, `"Regular"` | **Neutral** — proceed to title checks. |
| `"Management"` | **Fast-FAIL** — senior/management role. |
| `null` (not available) | **Neutral** — fall back to title-only heuristics. |

Similarly for `structuredDepartment` / `jobFamilyGroup`:

| `jobFamilyGroup` descriptor | Guard action |
|---|---|
| `"Engineering"`, `"IT - Information Technology"`, `"Research"` | Passes department gate (technical department). |
| `"Sales"`, `"Legal"`, `"Human Resources"`, `"Facilities"` | Checked against `departmentsBlacklist`. |
| `null` (not available) | Skip department check (no data). |

**This section is MANDATORY for Phase 1. It is NOT future scope.**

---

## 5. Non-Functional Requirements

### 5.1 Return Contract Standardization

**Current state**: `fetchAllJobs` returns `result.jobs` (a bare array), discarding the stats object. Comeet and Greenhouse both return `{ jobs, stats }`.

**Required change**: `fetchAllJobs` MUST return the standardized `{ jobs, stats }` object. The `stats` object must include:

```javascript
{
  fetched: Number,        // Total jobs received from API across all pages
  kept: Number,           // Jobs that passed all gates
  dropped: Number,        // Jobs that failed any gate
  droppedByReason: {},    // { Location: N, ATS_GUARD: N, Normalization: N, Dedup: N }
  pages: Number,          // Total pages fetched
  searchTextFilter: true, // Whether searchText was applied
  facetFilterApplied: Boolean,  // Whether server-side facet filter was active
  wafBlocks: Number,      // Count of HTTP 403 responses (WAF)
  httpErrors: [],         // Array of { status, offset, timestamp }
  serverErrors: Number,   // Count of HTTP 5xx responses
  workerSubTypes: {},     // Facet distribution: { "Regular Employee": 1872, "Intern": 101, ... }
  jobFamilyGroups: {},    // Facet distribution: { "Engineering": 1499, "Sales": 210, ... }
}
```

**Rationale**: The orchestrator and calibration system depend on the `{ jobs, stats }` contract to generate cross-worker reports. Stripping stats in `fetchAllJobs` creates a blind spot that makes Workday invisible in the weekly calibration report.

### 5.2 Observability & Persistence

Every job processed must produce a lightweight trace record suitable for the calibration system:

- **Passed jobs** → `calibration_passed` with: `jobId`, `title`, `companyName`, `location`, `structuredLevel`, `structuredDepartment`, `matchedLocationKeyword`, `source: 'workday'`. Note: `description` is always `null`; `structuredLevel` is the compensating field.
- **Dropped jobs** → `calibration_rejected` with: `jobId`, `title`, `companyName`, `location`, `reason`, `gate` (which gate: `location | title | department | structured_level | dedup`), `structuredLevel`, `structuredDepartment`, `source: 'workday'`.
- **WAF events** → `run_summaries` with: `wafBlocks`, `httpErrors[]`, tenant name, and timestamp. This allows the administrator to track anti-bot block rates per tenant over time.

### 5.3 Error Handling & Fail-Safe

**Invariant**: The worker must never crash the orchestrator loop. Every code path must return the `{ jobs, stats }` contract.

| Scenario | Required Behavior |
|---|---|
| Session init failure | Log `WARN`. Proceed to API calls. Return `{ jobs: [], stats }` if API also fails. |
| HTTP 403 during pagination | Log `[WAF_BLOCK] ERROR`. Increment `stats.wafBlocks`. Record in `stats.httpErrors[]`. Set `hasMore = false`. Return partial results. |
| HTTP 429 / 5xx | Log `WARN`. Record in stats. Set `hasMore = false`. |
| Normalization failure | Increment `stats.droppedByReason.Normalization`. Persist to `calibration_rejected` with `reason: "Normalization failure"`. |
| All pages empty | Return `{ jobs: [], stats }` with `stats.fetched = 0`. |

---

## 6. Gap Analysis & Required Changes

### GAP 1 — Persistence Isolation (CRITICAL)

**Current state**: `fetchJobs` counts `stats.droppedByReason` in memory but does not persist dropped jobs anywhere. `fetchAllJobs` then strips even the stats.

**Required change**: Introduce a `droppedJobs` array inside `fetchJobs`. For every dropped job, append `{ rawJob, unified (if available), reason, gate, timestamp }`. At the end of the run, execute `storageAdapter.writeCalibrationRejected(droppedJobs)` and `storageAdapter.writeRunSummary(stats)`. The `fetchJobs` constructor must accept `storageAdapter` and `knownJobIds` as dependencies.

### GAP 2 — Server-Side Facet Traversal Failure (CRITICAL)

**Current state**: `detectLocationFacet` reads `f.facetId` (nonexistent field). The real field is `f.facetParameter`. Furthermore, `locationMainGroup` is a nested structure: its `values[]` contains sub-facet objects (each with their own `facetParameter` and `values[]`), not location entries directly.

**Required change**: Rewrite `detectLocationFacet` to:
1. Find the facet where `f.facetParameter === 'locationMainGroup'`.
2. Iterate its `values[]` (the sub-facets).
3. For each sub-facet, scan its inner `values[]` for a `descriptor` matching Israel terms.
4. Prefer `locationHierarchy1` (country-level, e.g., `"Israel"` with count 363) for broad filtering.
5. Fall back to `locations` (city-level, e.g., `"Tel Aviv-Yafo, Israel"`) if hierarchy1 is absent (as with Cisco).

### GAP 3 — ID Extraction Fragility (HIGH)

**Current state**: The JR regex `/JR\d{4,}/` misses Cisco's numeric-only IDs (`"2007381"`), producing unstable path-slug-based jobIds.

**Required change**: Implement the canonical regex cascade per Section 4.4. Scan all `bulletFields` elements (not just last-to-first for JR), then `externalPath` slug, with a stable fallback chain.

### GAP 4 — ATS Guard Receives Empty Fields (CRITICAL)

**Current state**: `evaluateAtsGuard(rawJob, { companyId, source })` passes the raw Workday job object. The Guard's `extractJobFields` reads `job.location` (empty — real field is `locationsText`), `job.departments` (empty — doesn't exist), and `job.content`/`job.description` (empty — doesn't exist).

**Required change**: Construct a dedicated `guardPayload` before calling `evaluateAtsGuard`:

```javascript
const guardPayload = {
  title: unified.title,
  location: unified.location,
  departments: unified.structuredDepartment
    ? [{ name: unified.structuredDepartment }]
    : [],
  description: null,
  structuredLevel: unified.structuredLevel,
};
evaluateAtsGuard(guardPayload, { companyId: this.companyName, source: 'workday' });
```

This ensures the Guard sees properly mapped fields and can apply the department blacklist and structured seniority fast-track.

### GAP 5 — Structured Facet Waste (CRITICAL — formerly "Future Scope")

**Current state**: `workerSubType` and `jobFamilyGroup` facets are returned by the API on every response but completely ignored. This data is the only structured seniority signal available for Workday (since `description: null`).

**Required change**: Implement Section 4.6 in full. At minimum (Phase 1): parse the facets, build lookup maps, persist the distributions in `stats`, and expose the maps for future per-job enrichment. The Guard must be updated to accept and evaluate `structuredLevel`.

### GAP 6 — Return Contract Mismatch (HIGH)

**Current state**: `fetchAllJobs` (line 750) returns `result.jobs` — a bare array. Comeet and Greenhouse workers return `{ jobs, stats }`.

**Required change**: Refactor `fetchAllJobs` to return `{ jobs: result.jobs, stats: result.stats }` directly. Update the orchestrator's `processWorkdayBatch` to expect and destructure this standardized contract. This is required for the calibration system to generate cross-worker reports.

### GAP 7 — HTTP 403 WAF Blindness (HIGH)

**Current state**: The pagination loop catches all errors uniformly in a single `catch` block, logs a generic message, and sets `hasMore = false`. HTTP 403 responses (Akamai WAF blocks) are indistinguishable from timeouts, DNS errors, or server bugs. There is no counter, no structured record, and no way to detect WAF block trends.

**Required change**: In the `fetchJobs` pagination loop, inspect `err.response?.status` before entering the generic error handler:

```javascript
if (err.response?.status === 403) {
  stats.wafBlocks = (stats.wafBlocks || 0) + 1;
  stats.httpErrors.push({
    status: 403,
    offset,
    timestamp: new Date().toISOString()
  });
  log(`[WAF_BLOCK] ${this.companyName} blocked at offset ${offset}`, 'ERROR');
}
```

Persist `stats.wafBlocks` and `stats.httpErrors` in `run_summaries` so the administrator can track block rates per tenant over time and adjust jitter timing or proxy strategy accordingly.

---

## 7. Release Plan & Timeline

| Phase | Scope | Files Touched |
|---|---|---|
| **Phase 1: Core Normalization & Facet Fixes** | Rewrite `_normalizeJob` (ID regex cascade, location fallback chain). Rewrite `detectLocationFacet` (nested traversal via `facetParameter`). Parse `workerSubType` and `jobFamilyGroup` facets into lookup maps. Add `structuredLevel` and `structuredDepartment` to UnifiedJob output. | `ats/workers/workdayWorker.js` |
| **Phase 2: Orchestrator Parity & Persistence** | Modify constructor to accept `storageAdapter` and `knownJobIds`. Build `droppedJobs` array. Persist to `calibration_rejected` and `run_summaries`. Refactor `fetchAllJobs` to return `{ jobs, stats }`. Add HTTP 403 detection and `stats.wafBlocks` counter. | `ats/workers/workdayWorker.js` |
| **Phase 3: ATS Guard Bridging** | Implement the `guardPayload` mapping so the Guard receives `title`, `location`, `departments`, `structuredLevel`, and `description: null`. Update `evaluateAtsGuard` to check `structuredLevel` before `runDescriptionCheck` (fast-pass/fast-fail for Intern, NCG, Management). | `ats/workers/workdayWorker.js`, `ats/filters/ats_guard.js` |
| **Phase 4: Orchestrator Integration** | Update `processWorkdayBatch` in `orchestrator.js` to inject `storageAdapter` and `knownJobIds`, and to destructure the new `{ jobs, stats }` return contract. Import `israelLocationKeywords` from `config/vocabulary.js` and remove hardcoded `ISRAEL_TERMS`. | `ats/orchestrator.js`, `config/vocabulary.js` |

---

## 8. Metrics for Success

| KPI | Target | Measurement |
|---|---|---|
| **Observability** | 100% of jobs dropped by the Workday worker are successfully written to the `calibration_rejected` MongoDB collection with precise `gate` and `reason` fields. | Weekly calibration report. |
| **Facet Detection Rate** | Server-side location facet detection succeeds for >90% of Workday tenants, significantly reducing HTTP payload size. | `stats.facetFilterApplied` across all tenants in `run_summaries`. |
| **Structured Level Coverage** | Track what percentage of Workday tenants return usable `workerSubType` facets. Baseline measurement in first calibration cycle. | `stats.workerSubTypes` distribution in `run_summaries`. |
| **WAF Block Visibility** | 100% of HTTP 403 events are captured in `stats.wafBlocks` and `stats.httpErrors[]`, visible in `run_summaries`. Zero silent partial collections. | `run_summaries` aggregation on `wafBlocks > 0`. |
| **Return Contract Parity** | `fetchAllJobs` returns `{ jobs, stats }` for Workday, matching Comeet and Greenhouse. The orchestrator processes all three identically. | Integration test. |
| **ID Stability** | Zero dedup collisions caused by inconsistent ID formats. `workday_{tenant}_{id}` is deterministic for both JR-number and numeric-only tenants. | Compare pre/post refactor jobId distributions for Cisco and NVIDIA. |
| **Guard Activation** | The `structuredLevel` fast-track and `structuredDepartment` mapping produce non-null values in the calibration report, proving the Guard is no longer title-only for Workday. | `calibration_passed` aggregation on `structuredLevel IS NOT NULL`. |
