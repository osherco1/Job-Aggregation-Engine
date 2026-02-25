# Job Pipeline Lifecycle Analysis

> **Generated:** 2026-02-26  
> **Purpose:** Calibration Infrastructure Preparation — full static trace of every job posting from raw API response to final persistence or rejection.  
> **Scope:** Comeet, Greenhouse, Workday, LinkedIn  

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Comeet Worker](#2-comeet-worker)
3. [Greenhouse Worker](#3-greenhouse-worker)
4. [Workday Worker](#4-workday-worker)
5. [LinkedIn Scraper](#5-linkedin-scraper)
6. [Shared Filter Infrastructure](#6-shared-filter-infrastructure)
7. [Orchestrator — Final Assembly](#7-orchestrator--final-assembly)
8. [Cross-Cutting Observations](#8-cross-cutting-observations)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        orchestrator.run()                          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Promise.allSettled([                                        │  │
│  │     runAtsWorkers()      ←── Comeet + Greenhouse + Workday  │  │
│  │     runLinkedInPhase()   ←── LinkedIn Scraper               │  │
│  │  ])                                                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              ↓                                     │
│                    allJobs = [...atsJobs, ...linkedinJobs]         │
│                              ↓                                     │
│              jobStateService.filterNewJobs(allJobs)                │
│                    (dedup against ats_sent_history)                │
│                              ↓                                     │
│              emailNotifier.sendUnifiedReport(newJobs, errors)     │
│                              ↓                                     │
│              jobStateService.persistState()                        │
│              storageAdapter.writeCalibrationPassed(newJobs)        │
└─────────────────────────────────────────────────────────────────────┘
```

**Key principle:** ATS workers (Comeet, Greenhouse, Workday) run in **true parallel** via `Promise.all()`, and the entire ATS phase runs in parallel with the LinkedIn phase via `Promise.allSettled()`.

---

## 2. Comeet Worker

**Source file:** `ats/workers/comeetWorker.js`

### 2.1 Raw Payload Extraction

**API endpoint:**
```
GET https://www.comeet.co/careers-api/1.0/company/${uid}/positions?token=${token}
```

**Response shape:** A flat JSON **array** of position objects.

```javascript
const rawJobs = Array.isArray(response.data) ? response.data : [];
```

Each raw position object contains fields like:
- `position_uid` — unique position identifier
- `name` — job title
- `location_object` — `{ name, city, country }` (structured)
- `location` — string fallback
- `Remote` — string field (`"Remote"` or empty)
- `department` — string (e.g. `"Engineering"`)
- `careers_page_active_url`, `careers_page_url`, `url_comeet_hosted_page` — URL chain
- Various HTML-containing string fields (description, requirements, etc.)

### 2.2 Normalization Phase

**Function:** `normalizeComeetJob(rawJob, company)` (line 246)

| Unified Field       | Source                                                                                              |
|----------------------|-----------------------------------------------------------------------------------------------------|
| `jobId`              | `"comeet_" + String(rawJob.position_uid).trim()`                                                    |
| `source`             | `"comeet"` (hardcoded)                                                                              |
| `sourceCompanyId`    | `company.id` (from config)                                                                          |
| `companyName`        | `company.name \|\| company.id`                                                                      |
| `title`              | `String(rawJob.name).trim()`                                                                        |
| `location`           | **Fallback chain:** `rawJob.location_object.name` → `rawJob.location_object.city` → `rawJob.location` |
| `url`                | **Fallback chain:** `rawJob.careers_page_active_url` → `rawJob.careers_page_url` → `rawJob.url_comeet_hosted_page` |
| `description`        | `buildDescription(rawJob)` — see below                                                              |
| `raw`                | Full `rawJob` object attached                                                                       |

**Validation gate:** Returns `null` (skip) if `!rawJob.position_uid || !rawJob.name`.

**`buildDescription(rawJob)` logic (line 214):**
- Iterates all own properties of `rawJob`
- Skips keys in `excludedKeys` set: `position_uid`, `location_uid`, `email_name`, `position_url`, `careers_page_url`, etc.
- Keeps only string values matching `/<[pulib][^>]*>/i` (HTML tag pattern)
- Joins all qualifying strings with `\n\n`

### 2.3 Location Gate (Pre-filter)

**Function:** `filterJob(rawJob)` (line 289) — runs **before** normalization.

**Exact conditions:**

```
PASS if:
  rawJob.location_object.country === 'IL'
  OR (location_object.name || '').toLowerCase().includes('remote')
  OR (location_object.city || '').toLowerCase().includes('remote')
  OR (rawJob.Remote || '').toLowerCase() === 'remote'

FAIL if:
  !rawJob.location_object                     → reason: "Location: Missing location data"
  None of the above conditions met            → reason: "Location: {name} (not IL/Remote)"
```

**Note:** There is also a standalone `passesLocationGate(rawJob)` function (line 357) that implements the same logic but is **not called** in the `fetchAllJobs` flow. It appears to be legacy code.

### 2.4 Semantic Gate (Blacklist/Whitelist)

**Execution order inside `fetchAllJobs()` (line 797–904):**

#### Gate 1: `filterJob(rawJob)` — Worker-level pre-filter (inline)

Runs **before** normalization. Three checks in sequence:

1. **Location filter** (described above)
2. **Title blacklist** (line 317–324):
   ```javascript
   const titleBlacklist = ['senior', 'sr.', 'sr ', 'vp ', 'vice president',
                           'manager', 'director', 'head of', 'lead '];
   ```
   - Case-insensitive substring match on `rawJob.name`
   - Rejection reason: `"Title: Contains blacklisted term ({rawJob.name})"`

3. **Department blacklist** (line 327–348):
   ```javascript
   const blacklist = ['sales', 'legal', 'finance', 'hr', 'human resources', 'marketing'];
   ```
   - Case-insensitive match on `rawJob.department` (string, not array)
   - **Exception:** `dept.includes('product marketing')` → PASS
   - Rejection reason: `"Department: {rawJob.department} (non-technical)"`

If `filterJob` returns `{ passed: false }`, the job is added to `droppedJobs[]` with a **lightweight payload** (no `raw`, no `normalized`):
```javascript
{
  jobId: rawJob.position_uid ? `comeet_${rawJob.position_uid}` : 'unknown',
  title: rawJob.name || 'Unknown',
  companyName: company.name || company.id,
  location: rawJob.location_object?.name || rawJob.location || 'Unknown',
  url: rawJob.careers_page_active_url || rawJob.careers_page_url || '',
  reason: filterResult.reason,
  source: 'comeet',
}
```

#### Gate 2: `evaluateAtsGuard(rawJob, context)` — Shared ATS guard (post-normalization)

Called at line 851 **after** successful normalization. Receives the **raw** job (not normalized).

Three sub-checks in **short-circuit** order:

1. **`runTitleCheck(title)`** — Uses `technicalTitleKeywords` and `titleSeniorPatterns` from `config/vocabulary.js`
   - FAIL if title doesn't contain any `technicalTitleKeywords` → `"FAIL: title_not_technical"`
   - FAIL if title matches any `titleSeniorPatterns` regex → `"FAIL: title_senior"`
2. **`runDepartmentCheck(departments)`** — Only runs if title check passed
   - Uses `departmentsBlacklist` from `config/vocabulary.js`
   - Exact case-insensitive match → `"FAIL: department ({name})"`
3. **`runDescriptionCheck(description)`** — Only runs if title AND department passed
   - Normalizes HTML to plaintext via `normalizeContent()`
   - Tests against `contentSeniorityPatterns` (years-of-experience, leadership language)
   - → `"FAIL: description_seniority (years/leadership pattern)"`

**Verdict routing:**
- `guard.verdict === 'PASS'` → pushed to `unifiedJobs[]`
- `guard.verdict === 'FAIL'` → pushed to `droppedJobs[]` with `reason: "ATS_GUARD: {guard.reason}"`

**Dry run override:** If `ATS_GUARD_DRY_RUN=true`, `finalJobs = allNormalizedJobs` (all jobs pass regardless of guard verdict).

### 2.5 Deduplication

**Not performed at the worker level.** The worker returns all jobs that passed filters. Deduplication happens in the orchestrator's Phase 3 (see Section 7).

### 2.6 Final State & Routing

**Return value to orchestrator:**
```javascript
{ jobs: finalJobs, stats: { fetched, passedLocation, droppedLocation, ... } }
```

Each job in `finalJobs` has the **UnifiedJob** shape:
```javascript
{
  jobId: "comeet_<position_uid>",
  source: "comeet",
  sourceCompanyId: "<company.id>",
  companyName: "<company.name>",
  title: "<job title>",
  location: "<location string>",
  url: "<careers page URL>",
  description: "<concatenated HTML descriptions>",
  raw: { /* full raw API object */ }
}
```

**Rejected jobs:** Persisted via `storageAdapter.writeCalibrationRejected(droppedJobs)` within the worker (line 141).

---

## 3. Greenhouse Worker

**Source file:** `ats/workers/greenhouseWorker.js`

### 3.1 Raw Payload Extraction

**API endpoint:**
```
GET https://boards-api.greenhouse.io/v1/boards/${uid}/jobs?content=true
```

**Response shape:** JSON object with a `jobs` array.

```javascript
const rawJobs = (response.data && Array.isArray(response.data.jobs))
  ? response.data.jobs
  : (Array.isArray(response.data) ? response.data : []);
```

Each raw job object contains:
- `id` — numeric job ID
- `title` — job title string
- `location` — object `{ name }` or string
- `content` — HTML description (due to `?content=true`)
- `absolute_url` — full URL to job posting
- `updated_at` — ISO timestamp
- `departments` — **array** of objects `[{ id, name }]`

### 3.2 Normalization Phase

**Function:** `normalizeGreenhouseJob(rawJob, company)` (line 211)

| Unified Field       | Source                                                                 |
|----------------------|------------------------------------------------------------------------|
| `jobId`              | `"greenhouse_" + String(rawJob.id).trim()`                             |
| `source`             | `"greenhouse"` (hardcoded)                                             |
| `sourceCompanyId`    | `company.id`                                                           |
| `companyName`        | `company.name \|\| company.id`                                         |
| `title`              | `String(rawJob.title).trim()`                                          |
| `location`           | `rawJob.location.name` (if object) or `rawJob.location` (if string)    |
| `url`                | `rawJob.absolute_url`                                                  |
| `description`        | `decodeHtml(rawJob.content)` — basic HTML entity decoding              |
| `postedAt`           | `rawJob.updated_at`                                                    |
| `raw`                | Full `rawJob` object attached                                          |

**Validation gate:** Returns `null` if `!rawJob.id || !rawJob.title`.

### 3.3 Location Gate (Pre-filter)

**Function:** `filterJob(rawJob)` (line 262) — runs **before** normalization.

**Location extraction:**
```javascript
// From rawJob.location — handles both string and object shapes
locationStr = rawJob.location.name || rawJob.location.city || rawJob.location.country || ''
```

**Exact conditions:**
```
isIsrael = locationLower.includes('israel')
        || locationLower.includes('tel aviv')
        || locationLower.includes('tel-aviv')
        || locationLower.includes('haifa')
        || locationLower.includes('jerusalem')
        || (rawJob.location.country === 'IL')

isRemote = locationLower.includes('remote')

PASS if: isIsrael || isRemote
FAIL if: neither → reason: "Location: {locationStr} (not IL/Remote)"
```

**Key difference from Comeet:** Greenhouse checks for city name substrings (`'tel aviv'`, `'haifa'`, `'jerusalem'`) in addition to the `'IL'` country code, because Greenhouse's location object doesn't always have a structured `country` field.

### 3.4 Semantic Gate (Blacklist/Whitelist)

**Identical two-gate structure to Comeet:**

#### Gate 1: `filterJob(rawJob)` — Worker-level pre-filter

1. **Location** (described above)
2. **Title blacklist** — Same list as Comeet:
   ```javascript
   ['senior', 'sr.', 'sr ', 'vp ', 'vice president', 'manager', 'director', 'head of', 'lead ']
   ```
3. **Department blacklist** — Same list, but checks `rawJob.departments` **array** (not a single string):
   ```javascript
   const deptNames = rawJob.departments.map(dept => (dept.name || dept).toLowerCase().trim());
   ```
   - Same `['sales', 'legal', 'finance', 'hr', 'human resources', 'marketing']` blacklist
   - Same "product marketing" exception
   - Rejection reason: `"Department: {deptDisplay} (non-technical)"`

#### Gate 2: `evaluateAtsGuard(rawJob, context)` — identical behavior

Called at line 639 post-normalization. Same `runTitleCheck` → `runDepartmentCheck` → `runDescriptionCheck` cascade.

**Dropped jobs handling:** Identical lightweight payload structure, persisted via `writeCalibrationRejected()`.

### 3.5 Deduplication

**Not performed at the worker level.** Orchestrator Phase 3.

### 3.6 Final State & Routing

**Return value:**
```javascript
{ jobs: finalJobs, stats: { fetched, passedLocation, droppedLocation, ... } }
```

Each job in `finalJobs`:
```javascript
{
  jobId: "greenhouse_<id>",
  source: "greenhouse",
  sourceCompanyId: "<company.id>",
  companyName: "<company.name>",
  title: "<title>",
  location: "<location string>",
  url: "<absolute_url>",
  description: "<decoded HTML content>",
  postedAt: "<updated_at>",
  raw: { /* full raw API object */ }
}
```

---

## 4. Workday Worker

**Source file:** `ats/workers/workdayWorker.js`

### 4.1 Raw Payload Extraction

**Session initialization:** Unlike Comeet/Greenhouse, Workday requires an active session.

1. **`initSession()`** — GET request to the career site page to establish `PLAY_SESSION` and `wday_vps_cookie` via `tough-cookie` jar.
2. **`detectLocationFacet()`** — POST to API with `{ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }` to discover the Israel location facet ID dynamically.

**API endpoint:**
```
POST https://<tenant>.<instance>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
```

**URL construction:** Fully automatic from `config.url` via `_parseWorkdayUrl()`:
```
Regex: /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?\/([^/?#]+)/i
→ { tenant: match[1], instance: match[2], site: match[3] }
```

**Request payload (dual filter strategy):**
```javascript
{
  appliedFacets: {
    [locationFacet.facetParam]: [locationFacet.valueId]  // BONUS: if facet detected
  },
  limit: 20,           // PAGE_LIMIT constant
  offset: 0,           // increments by 20
  searchText: "Israel"  // PRIMARY: always applied
}
```

**Response shape:**
```javascript
const jobs = data.jobPostings || data.jobs || [];
const totalJobs = data.total;
```

Each raw job posting contains varying fields depending on tenant:
- `title` (sometimes missing)
- `bulletFields` — array (index 0 = title, index 1+ = location/category)
- `jobRequisition.title` — nested title
- `externalPath` — URL path with potential JR number
- `locationsText` — location string
- `location.descriptor` / `primaryLocation.descriptor` — nested location
- `postedOn` / `postedDate` — relative date string (`"Today"`, `"3 days ago"`)

### 4.2 Normalization Phase

**Method:** `_normalizeJob(rawJob)` (line 562)

**Title extraction — Cascading Fallback (4 levels):**

| Priority | Source                                       | Condition                        |
|----------|----------------------------------------------|----------------------------------|
| 1        | `rawJob.title`                               | String, non-empty                |
| 2        | `rawJob.bulletFields[0]`                     | Array exists, first element      |
| 3        | `rawJob.jobRequisition.title`                | Nested object exists             |
| 4        | `rawJob.name`                                | String fallback                  |

Returns `null` if no title found.

**Job ID extraction — Cascading Fallback (6 levels):**

| Priority | Source                                       | Variable                           |
|----------|----------------------------------------------|-------------------------------------|
| 1        | `rawJob.id`                                  | Direct ID field                     |
| 2        | `rawJob.jobId`                               | Alternate ID field                  |
| 3        | `rawJob.jobRequisitionId`                    | Requisition ID                      |
| 4        | `externalPath.match(/_(JR\d+)$/)` or `externalPath.match(/([A-Z0-9_-]+)$/i)` | Regex on URL path |
| 5        | `externalPath.replace(/[\/\s]/g, '_')`       | Cleaned path as ID                  |
| 6        | Title/bulletFields JR match: `/(JR\d{4,})/` | JR requisition number extraction    |
| 7        | `"unknown_" + Date.now()`                    | **Non-deterministic fallback**      |

**Final jobId format:** `"workday_" + tenant + "_" + jobId`

**Location extraction — Cascading Fallback (5 levels):**

| Priority | Source                                   | Condition                                   |
|----------|------------------------------------------|---------------------------------------------|
| 1        | `rawJob.locationsText`                   | String, non-empty                           |
| 2        | `rawJob.bulletFields[1+]`                | Contains comma, country code, Israel terms, or "remote" |
| 3        | `rawJob.location.descriptor` / `rawJob.primaryLocation.descriptor` | Nested object    |
| 4        | `rawJob.postingLocation`                 | String or object with `.descriptor`/`.name` |
| 5        | `externalPath` regex `/job/([^/]+)/`     | Extract from URL, replace `-` with `, `     |

**Special handling:** If location is `"2 Locations"` or contains `" Locations"`, continues to lower-priority sources.

**Other fields:**

| Unified Field    | Source                                                                     |
|------------------|----------------------------------------------------------------------------|
| `url`            | `${this.siteUrl}${externalPath}` or `this.siteUrl`                        |
| `description`    | **Always `null`** — Workday list API does not include full descriptions     |
| `postedAt`       | Relative date parsing: `"Today"` → now, `"Yesterday"` → now-1d, `"N days ago"` → now-Nd |

### 4.3 Location Gate (Pre-filter)

**Workday uses a three-tier location filtering strategy:**

#### Tier 1: Server-side `searchText` (always active)
```javascript
const searchText = 'Israel';  // Sent in every POST payload
```
This is the **primary** filter — reduces ~2000 jobs to ~50-100 by asking Workday's search engine to pre-filter.

#### Tier 2: Server-side facet filter (bonus, if detected)
```javascript
if (locationFacet) {
  appliedFacets[locationFacet.facetParam] = [locationFacet.valueId];
}
```
Dynamic detection: the worker POSTs with `limit: 1` to discover facets, searches for a facet whose ID/label contains `"location"`, then finds a value matching `ISRAEL_TERMS`:
```javascript
const ISRAEL_TERMS = ['israel', 'tel aviv', 'tel-aviv', 'yokneam', 'haifa',
                      'herzliya', 'raanana', 'petah tikva', 'jerusalem'];
```

#### Tier 3: Client-side location filter (fallback, only if no facet)
```javascript
if (!locationFacet) {
  const location = (unified.location || '').toLowerCase();
  if (!matchesIsrael(location) && !location.includes('remote')) {
    // DROP — reason: 'Location'
    continue;
  }
}
```

### 4.4 Semantic Gate (Blacklist/Whitelist)

**Single gate:** Only `evaluateAtsGuard()` is used. **No worker-level title/department blacklist.**

```javascript
const guard = evaluateAtsGuard(rawJob, {
  companyId: this.companyName,
  source: 'workday'
});

if (guard.verdict !== 'PASS' && !ATS_GUARD_DRY_RUN) {
  stats.dropped += 1;
  stats.droppedByReason['ATS_GUARD'] = (stats.droppedByReason['ATS_GUARD'] || 0) + 1;
  continue;
}
```

**Key difference from Comeet/Greenhouse:** Workday has **no** inline `filterJob()` pre-filter. It relies entirely on `evaluateAtsGuard()` for semantic filtering.

**Important note on `evaluateAtsGuard` field extraction for Workday:**
The guard's `extractJobFields(job)` extracts:
- `title` from `job.title || job.name || job.position` — may miss `bulletFields[0]`
- `description` from `job.content || job.description` — always empty for Workday (list API)
- `departments` from `job.departments` array — likely empty for Workday

This means the guard's **department check and description check are effectively no-ops** for Workday jobs. Only the title check is meaningful.

### 4.5 Deduplication

**Not performed at the worker level.** Orchestrator Phase 3.

### 4.6 Final State & Routing

**Critical architectural difference:** `fetchAllJobs(company)` returns **only the jobs array**, not `{ jobs, stats }`:

```javascript
async fetchAllJobs(company) {
  const result = await this.fetchJobs();
  return result.jobs;  // Array<UnifiedJob> directly
}
```

The orchestrator's `processWorkdayBatch()` handles this correctly by iterating the returned array directly.

Each job:
```javascript
{
  jobId: "workday_<tenant>_<id>",
  source: "workday",
  sourceCompanyId: "<tenant>",
  companyName: "<config.name>",
  title: "<extracted title>",
  location: "<extracted location>",
  url: "<siteUrl + externalPath>",
  description: null,
  postedAt: "<parsed relative date or null>",
  raw: { /* full raw API object */ }
}
```

**Dropped jobs:** Workday does **not** call `writeCalibrationRejected()`. Dropped jobs are only tracked via `stats.droppedByReason` counters — no individual dropped records are persisted.

---

## 5. LinkedIn Scraper

**Source files:** `scraper.js` (orchestration), `linkedin_client.js` (API client), `filters_shared.js` (filter logic)

### 5.1 Raw Payload Extraction

**Two-phase data acquisition:**

#### Phase A: Job Search (bulk listing)

**API endpoint:**
```
GET https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards
    ?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220
    &count=25
    &q=jobSearch
    &query=(origin:JOB_SEARCH_PAGE_JOB_FILTER,
            keywords:<encodedQuery>,
            locationUnion:(geoId:101620260),
            selectedFilters:(sortBy:List(DD),
                            experience:List(1,2),
                            timePostedRange:List(r604800)),
            spellCorrectionEnabled:true)
    &start=<offset>
```

**Server-side filters baked into query:**
- `geoId:101620260` — Israel
- `experience:List(1,2)` — Entry level + Associate
- `timePostedRange:List(r604800)` — Past week
- `sortBy:List(DD)` — Date descending

**Search query matrix:** 16 total boolean queries across niches (Backend, Fullstack, Mobile, Data/AI, DevOps, Cyber, QA, Embedded, Systems) × 4 page offsets `[0, 25, 50, 75]`.

**Response shape:**
```javascript
{
  data: {
    elements: [...],    // Job card references
    paging: { total, count, start },
    included: [...]     // Resolved job card objects
  }
}
```

**`normalizeResponse(data, included)` (linkedin_client.js line 195):**

1. Builds a Map from `included[]` keyed by `entityUrn`
2. For each `element` in `elements[]`:
   - Extracts URN from `element.jobCardUnion['*jobPostingCard']`
   - Resolves to `included` object via exact match or soft numeric ID match
   - Extracts fields:

| Field      | Source                                         |
|------------|------------------------------------------------|
| `jobId`    | `extractJobId(jobData.jobPostingUrn \|\| jobData.entityUrn)` — first `\d+` match |
| `title`    | `jobData.title.text \|\| jobData.jobPostingTitle` |
| `company`  | `jobData.primaryDescription.text`               |
| `location` | `jobData.secondaryDescription.text`             |
| `postedAt` | `footerItems[type='LISTED_DATE'].timeAt` → ISO string |
| `url`      | `"https://www.linkedin.com/jobs/view/${jobId}/"` |

**Validation:** Drops if `!jobId || !title`.

#### Phase B: Job Enrichment (per-job detail fetch)

**API endpoint:**
```
GET https://www.linkedin.com/voyager/api/graphql
    ?variables=(jobPostingUrn:urn%3Ali%3Afsd_jobPosting%3A<jobId>)
    &queryId=voyagerJobsDashJobPostings.891aed7916d7453a37e4bbf5f1f60de4
```

**`fetchJobDetails(jobId)` returns:**
```javascript
{
  description: root.description.text,     // Full plaintext description
  companyApplyUrl: root.companyApplyUrl,   // External apply link
  listedAt: root.originalListedAt || root.listedAt,
  skillsDescription: root.skillsDescription,
  employmentType: root.employmentStatus.localizedName,
  appliesCount: root.appliesCount || root.numApplicants,
  simpleApplication: root.simpleApplication || root.easyApply,
  isRepost: root.repostedJob || root.jobView?.repostedJob || root.jobPosting?.repostedJob,
  recruiter: { id: root.posterId, name: null },
}
```

**Enriched job shape** (scraper.js line 389):
```javascript
{
  ...job,                    // From Phase A (jobId, title, company, location, url, postedAt)
  source: 'linkedin',
  companyName: job.company,
  description,               // From Phase B
  applyUrl, skills, employmentType, listedAt, appliesCount,
  applyMethodEasyApply, workplaceTypes, recruiterUrl,
  simpleApplication, recruiter, skillsDescription, isRepost,
}
```

### 5.2 Location Gate (Pre-filter)

**There is no explicit client-side location filter in the LinkedIn pipeline.**

Location filtering is handled entirely **server-side** by the Voyager API via:
```
locationUnion:(geoId:101620260)   // = Israel
```

This is a fundamental architectural difference from the ATS workers.

### 5.3 Semantic Gate (Blacklist/Whitelist)

**Single gate:** `passesFilters(enrichedJob, runStats, filteredJobsLog)` (scraper.js line 99)

**Uses `BLACKLIST_KEYWORDS` and `WHITELIST_KEYWORDS` from `filters_shared.js`.**

**Execution order:**

1. **Blacklist check** (immediate drop):
   ```javascript
   for (const kw of BLACKLIST_KEYWORDS) {
     if (titleLower.includes(kw.toLowerCase())) {
       // DROP — reason: "Blacklist", matched keyword logged
       return false;
     }
   }
   ```
   - 100+ keywords including seniority (`Senior`, `Lead`, `Principal`), non-tech departments (`Sales`, `Marketing`, `Finance`, `HR`), hardware (`ASIC`, `VLSI`, `Mechanical`), Hebrew terms, and more.
   - **Short-circuits on first match.**

2. **Whitelist check** (must have at least one):
   ```javascript
   const hasWhitelist = WHITELIST_KEYWORDS.some(kw => titleLower.includes(kw.toLowerCase()));
   if (!hasWhitelist) {
     // DROP — reason: "Whitelist"
     return false;
   }
   ```
   - ~30 keywords: `Software`, `Developer`, `Engineer`, `Data`, `QA`, `DevOps`, `Cloud`, `Fullstack`, `Frontend`, `Backend`, `Mobile`, `Embedded`, `Cyber`, `Security`, `Intern`, `Junior`, `Student`, etc.

**Key difference from ATS workers:** LinkedIn uses **only** `filters_shared.js` title-level filtering. It does **not** use `evaluateAtsGuard()`, meaning:
- No `technicalTitleKeywords` / `titleSeniorPatterns` from `config/vocabulary.js`
- No `departmentsBlacklist` check
- No `contentSeniorityPatterns` description analysis
- No short-circuit optimization (blacklist always runs all keywords)

### 5.4 Deduplication

**Two-level deduplication for LinkedIn:**

#### Level 1: In-scraper dedup (scraper.js line 219, 325)

```javascript
seenIds = await storage.loadSeenJobIds();        // Load from seen_jobs collection
// ...
if (seenIds.has(job.jobId)) {
  runStats.filteredOut.alreadySeen += 1;
  continue;                                       // Skip — don't even enrich
}
// After enrichment:
seenIds.add(job.jobId);                           // Mark as seen immediately
```

This prevents re-enriching (expensive API call) for jobs seen in **any** prior LinkedIn run.

**Persistence:** `await storage.saveSeenJobIds(seenIds)` at end of run (scraper.js line 524).

#### Level 2: Orchestrator-level dedup (shared with ATS)

`jobStateService.filterNewJobs(allJobs)` checks against `ats_sent_history` — the set of job IDs that have already been **emailed** to the user. (See Section 7.)

### 5.5 Final State & Routing

**Return value to orchestrator:**
```javascript
{ jobs: allNewJobs, errors: fetchErrors }
```

Each job in `allNewJobs`:
```javascript
{
  jobId: "<numeric LinkedIn ID>",
  source: "linkedin",
  companyName: "<company name>",
  title: "<title>",
  company: "<company name>",
  location: "<location>",
  url: "https://www.linkedin.com/jobs/view/<jobId>/",
  postedAt: "<ISO date>",
  description: "<full description text>",
  applyUrl: null,
  skills: null,
  employmentType: "<type>",
  listedAt: <timestamp>,
  appliesCount: <number>,
  applyMethodEasyApply: <boolean>,
  isRepost: <boolean>,
  recruiter: { id, name },
  // ... other enrichment fields
}
```

---

## 6. Shared Filter Infrastructure

### 6.1 `filters_shared.js` — LinkedIn Title Filter

**Location:** `filters_shared.js` (project root)

**Exports:**
- `BLACKLIST_KEYWORDS` — 100+ string array
- `WHITELIST_KEYWORDS` — ~30 string array
- `titlePassesSemanticFilters(title)` — combined check function

**`titlePassesSemanticFilters` logic:**
1. For each `BLACKLIST_KEYWORDS`: if `titleLower.includes(kw.toLowerCase())` → return `false`
2. Check if any `WHITELIST_KEYWORDS` match → if none match, return `false`
3. Otherwise return `true`

**Used by:**
- `scraper.js` → `passesFilters()` (directly imports `BLACKLIST_KEYWORDS` / `WHITELIST_KEYWORDS`)
- `ats/utils/semanticGate.js` → `passesSemanticGate()` (wraps `titlePassesSemanticFilters`)

**Note:** `semanticGate.js` is imported by `orchestrator.js` but is **never called** in the current orchestrator flow. It appears to be dead code from an earlier architecture where the orchestrator applied its own semantic filter layer.

### 6.2 `ats/filters/ats_guard.js` — ATS Semantic Guard

**Location:** `ats/filters/ats_guard.js`

**Exports:** `evaluateAtsGuard(job, context)`

**Field extraction (`extractJobFields`):**
- `title` ← `job.title || job.name || job.position`
- `location` ← `job.location` (string) or `job.location.name || .fullName || .city || .region || .country`
- `departments` ← `job.departments[].name` (array)
- `description` ← `job.content || job.description` (string)

**Three-stage pipeline (short-circuit):**

| Stage | Function | Vocabulary Source | Failure Reason |
|-------|----------|-------------------|----------------|
| 1 (cheap) | `runTitleCheck(title)` | `technicalTitleKeywords`, `titleSeniorPatterns` | `title_not_technical` or `title_senior` |
| 2 (medium) | `runDepartmentCheck(departments)` | `departmentsBlacklist` | `department ({name})` |
| 3 (expensive) | `runDescriptionCheck(description)` | `contentSeniorityPatterns` | `description_seniority` |

Short-circuit: Stage 2 only runs if Stage 1 passed. Stage 3 only runs if Stages 1+2 passed.

**Used by:** Comeet, Greenhouse, and Workday workers.  
**NOT used by:** LinkedIn scraper.

### 6.3 `ats/utils/locationGate.js` — Orchestrator Location Gate

**Location:** `ats/utils/locationGate.js`

**Exports:** `passesLocationGate(location)`

**Logic:**
```
PASS if: location contains 'israel' OR any ISRAEL_CITIES match
PASS if: location === 'remote' (exact, case-insensitive)
FAIL if: location contains 'remote' but NOT 'israel' (e.g., "Remote - US")
FAIL if: none of the above
```

**ISRAEL_CITIES list:**
```
tel aviv, tel-aviv, herzliya, haifa, jerusalem, rehovot, ramat gan,
petah tikva, netanya, ra'anana, hod hasharon, kfar saba, givatayim
```

**Status:** Imported by `orchestrator.js` but **never called** in the current flow. Dead code from an earlier architecture.

### 6.4 `config/vocabulary.js` — ATS Guard Vocabulary

**`departmentsBlacklist`:** `Sales`, `New Business`, `Corporate Strategy`, `Customer Org`, `Human Resources`, `Finance`, `Product Management`

**`technicalTitleKeywords`:** `engineer`, `developer`, `devops`, `sre`, `software engineer`, `full stack`, `backend`, `front end`, `data engineer`, `data scientist`, `ml engineer`, `qa engineer`, `security engineer`, `salesforce`

**`titleSeniorPatterns`:** 14 regex patterns including `/\bSenior\b/i`, `/\bLead\b/i`, `/\bManager\b/i`, `/\bDirector\b/i`, `/\bAccount Executive\b/i`, etc.

**`contentSeniorityPatterns`:** 12 regex patterns matching years-of-experience requirements (`3+`, `4-5+`, `7+` years), specific job description phrases, and leadership language.

---

## 7. Orchestrator — Final Assembly

**Source file:** `ats/orchestrator.js`

### 7.1 Parallel Execution Phase

```javascript
const [atsResult, linkedinResult] = await Promise.allSettled([
  runAtsWorkers(atsErrors, storageAdapter),     // Comeet + Greenhouse + Workday in parallel
  runLinkedInPhase(linkedinErrors, storageAdapter),
]);
```

Inside `runAtsWorkers()`, all three ATS batches run in parallel:
```javascript
const [comeetResult, greenhouseResult, workdayResult] = await Promise.all([
  processBatch(comeetCompanies, comeetWorker, 'comeet', ...),
  processBatch(greenhouseCompanies, greenhouseWorker, 'greenhouse', ...),
  processWorkdayBatch(workdayCompanies, ...),
]);
```

### 7.2 Job Collection

```javascript
const allJobs = [...atsJobs, ...linkedinJobs];
```

**`processBatch` normalization (line 156–167):**
```javascript
const workerResult = await worker.fetchAllJobs(company);
let rawJobs = workerResult;
// Handle both return shapes:
if (workerResult && !Array.isArray(workerResult) && Array.isArray(workerResult.jobs)) {
  rawJobs = workerResult.jobs;  // Comeet/Greenhouse: { jobs: [...], stats }
}
// Workday: already returns Array directly
for (const rawJob of rawJobs || []) {
  if (rawJob && rawJob.jobId) {
    jobs.push(rawJob);
  }
}
```

### 7.3 Deduplication (Phase 3)

**Service:** `JobStateService` (`services/JobStateService.js`)

```javascript
const newJobs = await jobStateService.filterNewJobs(allJobs);
```

**`filterNewJobs(jobs)` implementation:**

1. **Load history:** `this.sentJobIds = await this.storageAdapter.loadSentHistory()` — loads the Set of all job IDs previously emailed.

2. **For each job:**
   - Skip if `!job.jobId`
   - Skip if `this.sentJobIds.has(jobId)` — already emailed in a prior run
   - Skip if `this.newJobIds.has(jobId)` — already added in THIS run (cross-source dedup)
   - Otherwise: add to `this.newJobIds` and include in output

3. **Returns** only genuinely new jobs.

**Persistence (Phase 5):**
- On email success: `jobStateService.persistState()` — merges `newJobIds` into `sentJobIds`, writes to `ats_sent_history` via storage adapter.
- On email failure: `jobStateService.rollback()` — clears `newJobIds` (jobs will be re-detected next run).

### 7.4 Calibration Persistence

**After successful email:**
```javascript
if (emailSuccess && newJobs.length > 0 && !DRY_RUN) {
  await storageAdapter.writeCalibrationPassed(newJobs);
}
```

**During worker execution:**
```javascript
// In Comeet/Greenhouse workers:
await storageAdapter.writeCalibrationRejected(droppedJobs);

// In orchestrator (for orchestrator-level filtered jobs):
await storageAdapter.writeCalibrationRejected(filteredJobsBuffer);
```

### 7.5 Email Gating Rules

```javascript
const hasNewJobs = newJobs.length > 0;
const hasErrors = errors.length > 0;
const isHeartbeatHour = new Date().getUTCHours() === 6;  // 08:00 Israel time

// Send email ONLY if:
//   1. New jobs found, OR
//   2. Errors occurred, OR
//   3. Heartbeat hour (daily sign-of-life)
if (!hasNewJobs && !hasErrors && !isHeartbeatHour) {
  // SKIP email — run is still logged to MongoDB
}
```

---

## 8. Cross-Cutting Observations

### 8.1 Filter Inconsistencies Across Workers

| Aspect | Comeet | Greenhouse | Workday | LinkedIn |
|--------|--------|------------|---------|----------|
| **Location pre-filter** | Inline `filterJob()` — IL country code + "remote" | Inline `filterJob()` — city names + "remote" | Server-side `searchText` + optional facet + client fallback | Server-side `geoId` in API query |
| **Title blacklist (worker)** | 9 terms in `filterJob()` | 9 terms (same) in `filterJob()` | **None** | `BLACKLIST_KEYWORDS` (100+ terms) |
| **Department blacklist (worker)** | 6 terms + product marketing exception | 6 terms (same) + product marketing exception | **None** | **None** |
| **ATS Guard** | Yes (post-normalization) | Yes (post-normalization) | Yes (post-normalization) | **Not used** |
| **Description analysis** | Yes (via ATS Guard) | Yes (via ATS Guard) | **Effectively no-op** (no description available) | **None** |
| **Dropped jobs persistence** | `writeCalibrationRejected()` | `writeCalibrationRejected()` | **Not persisted** (counter only) | `filteredJobsLog` in run summary |

### 8.2 Dual Filtering Problem (Comeet/Greenhouse)

Comeet and Greenhouse run **two overlapping** filter stages:

1. `filterJob()` — inline title/department blacklist with 9/6 hardcoded terms
2. `evaluateAtsGuard()` — vocabulary-driven title/department/description check

These overlap significantly. For example, both check for `'senior'` and `'manager'` in titles. The inline `filterJob()` catches some jobs that the ATS guard would also catch, but uses different (shorter) keyword lists.

### 8.3 LinkedIn Dedup Asymmetry

LinkedIn has **two** deduplication layers:
1. `seen_jobs` (in-scraper) — prevents re-enrichment across LinkedIn runs
2. `ats_sent_history` (orchestrator) — prevents re-emailing across all sources

ATS workers have **only** layer 2. This means ATS workers re-fetch and re-filter all jobs every run, relying solely on the orchestrator to prevent duplicate emails.

### 8.4 Return Shape Inconsistency

| Worker | `fetchAllJobs()` Return Type |
|--------|-------------------------------|
| Comeet | `{ jobs: Array, stats: Object }` |
| Greenhouse | `{ jobs: Array, stats: Object }` |
| Workday | `Array` (jobs only) |
| LinkedIn | `{ jobs: Array, errors: Array }` |

The orchestrator's `processBatch()` handles this polymorphism at line 157–161.

### 8.5 `normalizeJob.js` — Unused Legacy Module

`ats/utils/normalizeJob.js` exports `normalizeJob()` which dispatches to `normalizeComeetJob` / `normalizeGreenhouseJob` — but these are **different implementations** from the ones in the worker files (different field mappings, different ID prefixes: `comeet_` vs `comeet_`, `gh_` vs `greenhouse_`). This module is imported by `orchestrator.js` but is **never called** in the current flow.

### 8.6 Dead Code Inventory

| Module | Function | Status |
|--------|----------|--------|
| `ats/utils/normalizeJob.js` | `normalizeJob()` | Imported but never called |
| `ats/utils/locationGate.js` | `passesLocationGate()` | Imported but never called |
| `ats/utils/semanticGate.js` | `passesSemanticGate()` | Imported but never called |
| `comeetWorker.js` | `passesLocationGate()` (line 357) | Defined but never called |
| `comeetWorker.js` | `passesDepartmentGate()` (line 386) | Defined but never called |

These appear to be remnants of an earlier architecture where the orchestrator applied its own filter layer post-worker.
