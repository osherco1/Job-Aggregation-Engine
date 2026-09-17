# DATA_CONTRACTS.md — Source-to-Sink Attribute & Schema Reference

> **Generated:** 2026-09-06
> **Codebase state:** `main` @ `cc26c75` (Telegram control plane)
> **Scope:** every attribute the system can see, does see, transforms, persists, and emits — per worker.
> **Status:** **authoritative** for data shapes. Supersedes `docs/analysis/ats_guard_and_raw_payload_analysis.md` (2026-02-26) and §21–§26, §34 of `docs/SYSTEM_REFERENCE.md` (2026-03-23) wherever they disagree. See §12 Errata.

---

## 0. Method & evidence provenance

Every attribute claim in this document is tagged with how it was established. Nothing here is inferred from field-access patterns alone — that was the failure mode of the previous analysis, which produced a "Missing Gold" table that turned out to be substantially fictional for Workday and LinkedIn.

| Tag | Meaning |
|---|---|
| **[M]** | **Measured** — counted across a corpus of captured payloads held in this repo. Coverage % is real. |
| **[P]** | **Probed** — verified by a live request from this machine on 2026-09-06. |
| **[C]** | **Code** — read directly from the current source. |
| **[U]** | **Unverified** — plausible, not confirmed. Explicitly flagged; never presented as fact. |

### Corpora used

| Corpus | Location | Size | Captured |
|---|---|---|---|
| Comeet raw list payloads | `data/raw_samples/comeet/*.json` | 15 companies · **358 positions** | 2026-03-01 |
| Greenhouse raw board payloads | `data/raw_samples/greenhouse/*.json` | 15 boards (13 non-empty) · **624 jobs** | 2026-03-01 |
| Workday raw listing payloads | `data/raw_samples/workday/*.json` | 15 tenants · **300 postings** | 2026-03-01 |
| LinkedIn GraphQL job details | `archive/debug_job_details_*.json` | **279 full responses** | ~2026-02 |
| Live probes | — | Comeet list + position detail (Elementor); Workday list + job detail (NVIDIA) | 2026-09-06 |

---

## 1. End-to-end data flow (as built, not as designed)

```
                          ┌───────────────────────────────────────────────┐
Phase 0                   │ knownJobIds = loadSentHistory() ∪ loadSeenJobIds()
(orchestrator.js:588-602) │  = ats_sent_history ∪ seen_jobs   → one Set<string>
                          └───────────────────────────────────────────────┘
                                            │
        ┌───────────────────────────────────┴────────────────────────────┐
        │ Promise.allSettled                                             │
        ▼                                                                ▼
  PHASE 1 — ATS (Promise.all, 3 workers true-parallel)            PHASE 2 — LinkedIn
        │                                                                │
   ┌────┴─────┬──────────────┬─────────────┐                    search (17 boolean queries)
   ▼          ▼              ▼             │                             │
 Comeet   Greenhouse      Workday          │                    normalizeResponse()
   │          │              │             │                     (elements → included URN resolve)
   │          │              │             │                             │
   │          │              │             │                      seenIds silent dedup
   │          │              │             │                             │
   ▼          ▼              ▼             │                    fetchJobDetails() GraphQL ← 1 req/job
 [0] silent dedup (knownJobIds)   (none)   │                             │
 [1] filterJob()  — LOCATION GATE ONLY     │                    passesFilters()
 [2] normalize<Source>Job() → UnifiedJob   │                     (BLACKLIST → WHITELIST on title)
 [3] evaluateStructuredGate()  (Comeet only)                             │
 [4] evaluateAtsGuard(guardPayload)  ← NOT the raw job                   │
   │                                       │                             │
   └───────────────┬───────────────────────┘                             │
                   ▼                                                     ▼
             writeCalibrationRejected(dropped)              writeCalibrationRejected(dropped)
             encounteredJobIds → saveSeenJobIds()                        │
                   │                                                     │
                   └──────────────────┬──────────────────────────────────┘
                                      ▼
Phase 3   JobStateService.filterNewJobs(allJobs)
          ├─ ats_sent_history membership
          ├─ within-run duplicate
          └─ RUN_FREQUENCY_CAP (default 3) per (company, canonicalTitle)   ← undocumented before now
                                      ▼
Phase 4   TelegramNotifier.sendUnifiedReport()   (gated: newJobs>0 ∨ errors>0 ∨ heartbeat hour)
                                      ▼
Phase 5   persistSentHistory()  [fail-fast]  → ats_sent_history
Phase 5b  writeCalibrationPassed(newJobs)    → calibration_passed
```

**The single most important structural fact, and the one every older document gets wrong:**

> All three ATS workers build a **`guardPayload`** — a small, explicitly-constructed object derived from the *normalized* job — and pass **that** to `evaluateAtsGuard()`. They do **not** pass the raw API object.
> `comeetWorker.js:862`, `greenhouseWorker.js:608`, `workdayWorker.js:524`

This makes the guard source-agnostic and fixes the Comeet/Workday "dead gate" problems described in the Feb analysis. It also means **the guard can only ever see what normalization chose to carry forward.** Every attribute not copied into `guardPayload` is invisible to filtering, no matter how rich the raw payload is. The guard's input contract is:

```js
// The complete set of keys evaluateAtsGuard() reads (ats_guard.js:19-80, 284-296)
{
  title,                 // string
  location,              // string | {name|fullName|city|region|country}
  departments,           // [{name}]  — or job.structuredDepartment as a single string
  description,           // string | null   (null → description check SKIPPED, not failed)
  structuredLevel,       // string | null   — or structuredSignals.experience_level
  structuredSignals: { employment_type },   // read for the junior-bypass only
  isStructuredStudent,   // bool — set by the structured gate
}
```

---

## 2. Comeet

### 2.1 Acquisition

| Property | Value | Ref |
|---|---|---|
| Endpoint | `GET https://www.comeet.co/careers-api/1.0/company/{uid}/positions?token={token}` | `comeetWorker.js:536` **[C]** |
| Auth | Per-company token in query string. `uid` + `token` both from the `companies` collection. | **[C]** |
| Response | Bare JSON **array** of position objects (not enveloped) | **[M]** |
| Pagination | **None.** One request returns the company's entire open-position list. | **[C]** |
| Rate limiting | Token bucket, 9–11 s min interval, provider-scoped (`rateLimiter.js`) | **[C]** |
| Retries | 2, on 429/5xx (`requestWithDelayWrapper`, `enableRetries: true`) | **[C]** |
| Per-company jitter | 3–6 s before each company | **[C]** |
| WAF handling | 403/406 → 2–5 min cooldown, no retry, empty result | **[C]** |
| Timeout | 15 000 ms; `validateStatus: <500`; `maxRedirects: 5` | **[C]** |
| `?details=true` | **Has no effect.** Probed 2026-09-06: identical key set with and without. | **[P]** |

### 2.2 Raw attribute inventory — measured

Coverage across **358 positions / 15 companies**.

#### Stable core (100% present on every position)

| Attribute | Type | Example | Used? |
|---|---|---|---|
| `position_uid` | string | `"BE.650"` | ✅ → `jobId` (`comeet_{base}`; compound `A-B` split on `-`) |
| `name` | string | `"Full-Stack Developer"` | ✅ → `title` |
| `department` | string **(singular, not array)** | `"R&D"` | ✅ → `departments: [{name}]` in guardPayload |
| `location` | string | `"Israel - Ramat-Gan"` | ✅ fallback tier 3 |
| `location_object` | object | `{name, country, city, state, postal_code, street_name, arrival_instructions, street_number, timezone, location_uid}` | ⚠️ **only `country`/`name`/`city` read** |
| `employment_type` | string | `"Full-time"` | ✅ → `structuredSignals` + `normalizeEmploymentType()` |
| `experience_level` | string | `"Associate"` | ✅ → `structuredSignals` + `structuredLevel` |
| `Remote` | string | `"Hybrid"` | ✅ location gate |
| `careers_page_url` | string | comeet.com job URL | ✅ url fallback 2 |
| `careers_page_active_url` | string | company careers URL | ✅ url fallback 1 |
| `careers_page_detected_url` | string\|null | usually `null` | ❌ |
| `position_url` | string | **canonical single-position API URL, token included** | ❌ **← see §2.5** |
| `time_updated` | ISO8601 | `"2026-02-09T07:18:35Z"` | ⚠️ carried, never used |
| `company_name` | string | `"Elementor"` | ❌ (company name comes from config) |
| `email_name` | string | apply-by-email alias | ❌ |
| `picture_url` | string\|null | | ❌ |
| `is_discreet` | bool | | ❌ |
| `position_company_number` | string\|null | | ❌ |
| `req_company_number` | string (90%) | usually `""` | ❌ |

#### Company-defined content fields — the description problem

Comeet has **no fixed description field on the list endpoint.** Description content arrives as arbitrary, company-authored keys. `buildDescription()` (`comeetWorker.js:155-180`) sweeps every string property matching `/<[pulib][^>]*>/i` that is not on a 20-entry exclusion list, and concatenates them.

Keys actually harvested across the corpus **[M]**:

| Occurrences | Key | Is it a description? |
|---|---|---|
| 160 | `Responsibilities` | ✅ yes |
| 42 | `Advantages` | ✅ yes (nice-to-haves) |
| 22 | `Benefits` | ❌ boilerplate |
| 16 | `Work Environment` | ❌ boilerplate |
| 16 | `Statement` | ❌ DEI boilerplate |
| 12 | `Podcast` | ❌ **marketing noise** |
| 10 | `About Us` | ❌ boilerplate |
| 10 | `How You'll Spend Your Time` | ✅ yes |
| 7 | `Advantages:` | ✅ yes (colon variant — a separate key) |
| 6 | `What We Offer` | ❌ boilerplate |
| 5 | `About the role` | ✅ yes |
| 5 | `Character and Attitude Figure` | ~ |
| 4 | `About the Company` / `About Silk` | ❌ boilerplate |
| 1 each | `How to Apply?`, `Why join us?`, `Skills` | ❌ |

Non-content keys also observed and **correctly excluded** because they carry no HTML tags: `Group*`, `BU/Division`, `Sub Department`, `Role`, `Region`, `Team`, `Company`, `Experience`, `Hot position?`, `Address`.

**Two measured consequences:**

1. **49% of Comeet positions (174/358) produce `description === null`.** No HTML-bearing key exists on them at all. For half the Comeet corpus the description gate is structurally blind.
2. For the other 51%, the text that *is* assembled (median 1 238 chars, p90 2 651) mixes real requirements with marketing boilerplate. `contentSeniorityPatterns` runs over Podcast blurbs and benefits lists — a false-positive surface — and a **`Requirements` section is never among the harvested keys**, because Comeet does not expose one on this endpoint.

### 2.3 `experience_level` is free text, not an enum — measured

This field is treated as a structured signal by two gates. It is not structured. **26 distinct values across 15 companies; 40% null.**

| n | Value | `structuredGate` SENIORITY_RE | `structuredLevelIndicators` |
|---|---|---|---|
| 142 | *(null)* | — | — |
| 66 | `Senior` | ✅ FAIL | ✅ seniorFail |
| 25 | `Intermediate` | — | — |
| **18** | **`Experienced (3-5 Years)`** | ❌ **missed** | ❌ **missed** |
| **17** | **`Advanced (5-8 Years)`** | ❌ **missed** | ❌ **missed** |
| 17 | `Mid/Senior` | ✅ | ✅ |
| 14 | `Mid- Senior` | ✅ | ✅ |
| 9 | `Associate` | — | ❌ not in `juniorPass` |
| 9 | `Mid` | — | — |
| 8 | `Junior` | — | ✅ juniorPass |
| 7 | `Junior (1-2 years)` | — | ✅ juniorPass |
| **4** | **`Manager`** | ✅ FAIL | ❌ `'management'` ≠ `'manager'` |
| 4 | `Director` | ✅ | ✅ |
| 3 | `Management` | ✅ | ✅ |
| **2** | **`Expert (8+ Years)`** | ❌ **missed** | ❌ **missed** |
| 2 | `Intern` | — | ✅ juniorPass |
| **1** | **`Entry-level`** | — | ❌ **`juniorPass` holds `'entry level'`; `.includes()` fails on the hyphen** |
| 1 ea | `L2`, `L3`, `L3/L4` | ❌ | ❌ |
| 1 ea | `Team Lead`, `Lead` | ✅ | ❌ no `'lead'` in `seniorFail` |
| 1 | `Senior Manager` | ✅ | ✅ |
| 1 ea | `Mid- Level`, `Mid-Senior` | ~ | ~ |

**~13% of populated values carry a seniority signal that neither gate recognises.** The two vocabularies also disagree with each other (`manager`, `lead` are in one and not the other; `staff`, `principal` in the other and not the first), so a job's fate depends on which gate happens to see it first.

`employment_type` is comparatively tame — 11 raw values, normalised by `normalizeEmploymentType()` into a closed 7-value enum. `Remote` has 5 values: `Hybrid` 132, *(null)* 115, `Remote` 91, `On-site` 18, `False` 2.

### 2.4 Normalization output — `UnifiedJob` (Comeet)

`normalizeComeetJob()` `comeetWorker.js:186-258` **[C]**

```js
{
  jobId, source: 'comeet', sourceCompanyId, companyName,
  title, location, url, description,           // description may be null (49%)
  department,          // string, singular
  Remote,              // raw passthrough
  time_updated,        // raw passthrough, unused
  country,             // location_object.country
  raw,                 // ← the ENTIRE raw object is retained in memory
  structuredSignals: { experience_level, employment_type },
  employmentType,      // normalized enum
  fallbackTier,        // 1..4 — which location tier resolved
  // added post-gate:
  matchedLocationKeyword, matchedKeywords, gate, isStructuredStudent
}
```

Location resolution is a 4-tier cascade: `location_object.country` → `.name` → `.city` → top-level `location` string → `'Unknown'`. Note **tier 1 wins**, so `location` for an Israeli job is usually the literal string `"IL"`, not a city name — which is what reaches the Telegram report.

### 2.5 Unaccessed surface — the position-detail endpoint **[P]**

`position_url` is present on **100% of list rows** and already carries the auth token. Probed live 2026-09-06 (Elementor):

`GET {position_url}` → **200**, returns the same object **plus 12 fields**:

| Field | Content | Value on the probed job |
|---|---|---|
| **`description`** | Canonical role description, HTML | **923 chars** |
| **`requirements`** | **Canonical requirements section, HTML** | **1 702 chars — contained `"2-4 years of experience in Application Security…"`** |
| `position_slug` | `"appsec-architect"` | stable URL slug |
| `is_internal` | bool | internal-only postings |
| `questionnaires` | array | application-form complexity |
| `email_alias`, `is_consent_needed`, `is_sms_consent_needed`, `referrals_reward`, `is_reward`, `is_company_reward`, `company_referrals_reward` | — | low value |

This is the highest-value unexploited attribute in the system: `requirements` is precisely the field `contentSeniorityPatterns` was written to scan, it is canonical rather than company-improvised, and it closes the 49% description gap. Cost: one extra request per surviving position, after the location gate has already cut volume.

---

## 3. Greenhouse

### 3.1 Acquisition

| Property | Value | Ref |
|---|---|---|
| Endpoint | `GET https://boards-api.greenhouse.io/v1/boards/{uid}/jobs?content=true` | `greenhouseWorker.js:411` **[C]** |
| Auth | None — public board API | **[C]** |
| Response | `{ jobs: [...], meta: {...} }` | **[M]** |
| Pagination | **None.** `?content=true` returns the full board with descriptions inline. | **[M]** |
| Rate limiting | None. 6–12 s per-company jitter only. | **[C]** |
| Retries | 1 | **[C]** |
| Failure mode | non-200 → log, empty result, no cooldown. In the corpus `snyk` returned **404** (dead board slug) and `papaya` returned **200 with zero jobs**. Both are silent. | **[M]** |

### 3.2 Raw attribute inventory — measured

**624 jobs / 13 non-empty boards. Every field below is present on 100% of jobs.** Greenhouse is by far the most consistent of the four sources.

| Attribute | Type | Used? | Notes |
|---|---|---|---|
| `id` | number | ✅ → `jobId` = **`gh_{id}`** | note the prefix — see §8 |
| `title` | string | ✅ | |
| `content` | string | ✅ → `description` | **double-HTML-encoded** (`&lt;p&gt;`). Median **6 648** chars, p90 **11 153** — 5× richer than Comeet. |
| `location` | `{name}` | ✅ | freeform, e.g. `"Remote - New York"` |
| `offices` | `[{id, name, location, parent_id, child_ids}]` | ✅ **location gate only** | hierarchical; `offices[].location` is structured geo |
| `departments` | `[{id, name, parent_id, child_ids}]` | ✅ full array carried to the guard | the only source with a true department array |
| `absolute_url` | string | ✅ → `url` | |
| `first_published` | ISO8601 | ✅ → `postedAt` (preferred) | |
| `updated_at` | ISO8601 | ✅ → `updatedAt` | |
| `metadata` | `[{id, name, value, value_type}]` | ⚠️ **carried, one name read** | see §3.3 |
| `requisition_id` | string | ⚠️ carried, unused | |
| `internal_job_id` | number | ⚠️ carried, unused | cross-posting dedup key |
| `language` | string | ⚠️ carried, unused | `"en"` |
| `company_name` | string | ❌ | |
| `data_compliance` | `[{type, requires_consent, retention_period, …}]` | ❌ | GDPR flags |
| `education` | string | ❌ | **only 5 jobs / 3 boards**; value `"education_required"` |

### 3.3 `metadata[]` — real structured fields, almost entirely unread

`extractStructuredLevel()` (`greenhouseWorker.js:161`) scans `metadata[]` for a name in `['job level','level','seniority','experience level']`. Measured across the corpus:

| n | `metadata[].name` |
|---|---|
| 107 | **Job Level** ← the only one read |
| 107 | Career Site Main Categories |
| 107 | Full-Time or Part-Time |
| 107 | Employee Class |
| 107 | Equity Grant? · Benefit Eligibility · Compensation Planner · Sourcing System |
| 77 | Reason for opening · Job Name |
| 29 | Hiring Range |
| 25 | Bonus |

**All 107 come from a single board (Taboola).** `metadata` is present as an array on 100% of jobs, but it is empty or non-level for every other board — so `structuredLevel` is `null` for roughly **83%** of the Greenhouse corpus.

And where it *is* populated, the values are unusable as-is **[M]**:

```
78 × "7"
 7 × "6"
 7 × "7 - Account Manager, Software Engineer, Individual Contributors (ICs)"
 4 × "6 - Director on the Right, Account Director, Team Lead, Manager, Principal Engineer"
 2 × "5 - Director on the Left, Sr. Director, Director, Country Manager, Sr. Principal Engineer"
 1 × "8 - Intern, Student, SDR, Content Editor/Reviewer"
```

A bare `"7"` matches nothing in `structuredLevelIndicators` and is silently neutral. The descriptive variants would match on substrings like `"Director"` and **fail a job whose level is Individual Contributor** — the label text for levels 6 and 7 both contain the word `Director`. A live false-negative hazard, currently masked only by how rarely the descriptive form appears.

Untouched but genuinely useful: **`Full-Time or Part-Time`** and **`Employee Class`** are per-company structured employment signals on the same 107 jobs; `Career Site Main Categories` is a company-side taxonomy.

### 3.4 Normalization output — `UnifiedJob` (Greenhouse)

```js
{
  jobId: `gh_${id}`, source: 'greenhouse', sourceCompanyId, companyName,
  title, location, url, description,      // decodeHtml() single pass over content
  postedAt, updatedAt,
  offices,          // full raw array
  departments,      // [{id,name,child_ids,parent_id}]
  metadata,         // full raw array — carried but unread downstream
  structuredLevel,  // null for ~83%
  language, requisitionId, internalJobId,
  raw,
  matchedLocationKeyword, matchedKeywords, gate
}
```

The location gate pools `location.name/.city/.country` **plus** every `offices[].name` and `offices[].location`, lowercases, joins, and substring-matches. `'remote'` anywhere in that pool is an unconditional pass — including `"Remote - New York"`, which is the single most common `location.name` value in the corpus. **[C][M]**

---

## 4. Workday

### 4.1 Acquisition

| Property | Value | Ref |
|---|---|---|
| Listing endpoint | `POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | **[C][P]** |
| URL derivation | `_parseWorkdayUrl()` regex-extracts `tenant`/`instance`/`site` from the configured careers URL | `workdayWorker.js:200` **[C]** |
| Auth | Session cookies. `GET {siteUrl}` first → `PLAY_SESSION` + `wday_vps_cookie`, then a 2 000 ms Akamai settle. | **[C]** |
| Body | `{ appliedFacets, limit: 20, offset, searchText: 'Israel' }` | **[C]** |
| Pagination | 20/page, `offset += 20`, stops when `page < 20` or `offset >= total` | **[C]** |
| Jitter | 5–6 s between pages | **[C]** |
| Retries | None | **[C]** |
| Instance model | **New `WorkdayWorker` per company** — session and facet cache are per-instance | **[C]** |
| Silent dedup | **None.** Workday alone re-processes every posting every run. | **[C]** |
| Response | `{ total, jobPostings: [...], facets: [...], userAuthenticated }` | **[M][P]** |
| **`total` cap** | Capped at **2000** (NVIDIA reports exactly 2000) — the facet strategy exists to get under it | **[M]** |

### 4.2 Raw attribute inventory — measured, and where the old docs were most wrong

**300 postings / 15 tenants. The listing endpoint returns exactly five fields, plus at most one optional sixth.**

| Attribute | Coverage | Tenants | Example | Used? |
|---|---|---|---|---|
| `title` | **100%** | 15/15 | `"Senior Chip Design Verification Engineer"` | ✅ |
| `externalPath` | **100%** | 15/15 | `"/job/Israel-Yokneam/Senior-Chip-Design-Verification-Engineer_JR2013520-1"` | ✅ id + url |
| `locationsText` | **100%** | 15/15 | `"Israel, Yokneam"` | ✅ |
| `postedOn` | **100%** | 15/15 | `"Posted 2 Days Ago"` — **relative text, not a date** | ✅ parsed heuristically |
| `bulletFields` | **100%** | 15/15 | `["JR2013520"]` — **just the JR number** | ✅ id fallback |
| `timeType` | 20% | **3/15** (checkout, chevron, cisco) | `"Full time"` | ⚠️ carried, unused |
| `remoteType` | 26% | **4/15** (general-motors, kyndryl, samsung, workday) | `"Onsite"` | ❌ **not read at all** |

**That is the entire listing surface.** The following, all listed as "Missing Gold" in the 2026-02-26 analysis, **do not exist on this endpoint on any of the 15 tenants**: `jobCategory`, `managementLevel`, `jobFamilyGroup`, `requisitionType`, `workerType`, `isRemote`, `subtitleText`, `jobSchedule`, `jobRequisition`, `primaryLocation`, `postingLocation`, `additionalLocations`, `id`, `jobId`, `jobRequisitionId`, `name`, `postingDate`.

Two further corrections to the record:

- **`title` is never null.** The claim that NVIDIA returns `title: null` with the title in `bulletFields[0]` is false — NVIDIA returns a correct `title` on 100% of postings, and `bulletFields` contains only the JR number. The worker's 4-tier title cascade is defensive scaffolding for a case that does not occur in the corpus.
- **`bulletFields` is `[JR]`, not `[title, location, timeType, JR]`.** The location-scanning loop over `bulletFields[1..]` therefore never finds anything.

### 4.3 Facets — a server-side filter surface, mostly unused

The listing response carries a `facets[]` array. NVIDIA's facet parameters **[P]**:

```
jobFamilyGroup · workerSubType · timeType · locationMainGroup
```

`detectLocationFacet()` traverses `locationMainGroup` → `locationHierarchy1` / `locations` / `locationHierarchy2` looking for an Israel value and applies it as `appliedFacets`. **[C]**

The other three facet parameters are never touched. This matters: values that are *absent from the listing rows* are nonetheless **available as server-side filters**. `workerSubType` and `jobFamilyGroup` can constrain the result set before it is ever paginated — which both cuts request volume and works around the 2 000-row cap. Currently all of that classification work is attempted client-side against a title string. **[U — the per-tenant value IDs still need enumeration.]**

### 4.4 The description gap — and that it is closeable **[P]**

`_normalizeJob()` hard-codes `description: null` (`workdayWorker.js:807`), and `ats_guard.js:64` / `:238` contain explicit special-case handling for it — `description === null` makes `runDescriptionCheck` return PASS rather than run. Workday jobs are therefore admitted or rejected on **title alone**.

That is a design decision resting on a false premise. Probed live 2026-09-06:

```
GET https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite{externalPath}
→ 200 OK
```

It requires the same session cookies the worker already establishes, and `externalPath` is already on every row. Returns `jobPostingInfo`:

| Field | Value from probe | Why it matters |
|---|---|---|
| **`jobDescription`** | full HTML description | **closes the gap — Workday is the largest rejection corpus and currently carries zero description signal** |
| `timeType` | `"Full time"` | available for **all** tenants here, vs 3/15 on the listing |
| `startDate` | `"2026-09-04"` | **a real date** — replaces `"Posted 2 Days Ago"` heuristic parsing |
| `jobReqId` | `"JR2024628"` | canonical id, no regex extraction from a URL slug |
| `country.alpha2Code` | `"IL"` | **deterministic ISO country code — replaces substring matching on `locationsText`** |
| `jobRequisitionLocation` | `{descriptor, country:{alpha2Code}}` | structured location |
| `posted`, `canApply` | `true` | staleness / closed-posting detection |
| `externalUrl`, `jobPostingId`, `jobPostingSiteId`, `id`, `questionnaireId`, `includeResumeParsing` | — | |

Caveats measured during probing: an expired job path returned **403**, and the detail call is more WAF-sensitive than the listing call — the same jitter and session discipline would be needed, and per-job cost is real. **[P]**

### 4.5 Normalization output — `UnifiedJob` (Workday)

```js
{
  jobId: `workday_${tenant}_${JR|rawId}`,
  source: 'workday', sourceCompanyId: tenant, companyName,
  title, location, url,
  description: null,              // hard-coded
  postedAt,                       // parsed from "Posted N Days Ago" — today/yesterday/N days only
  structuredLevel: null,          // hard-coded
  structuredDepartment: null,     // hard-coded → the guard's department check is a no-op
  timeType,                       // present on 3/15 tenants
  raw
}
```

`postedAt` parsing handles `today`, `yesterday`, and `/(\d+)\s*day/`. `"Posted 30+ Days Ago"` and `"Posted Last Week"` yield `null`. **[C]**

---

## 5. LinkedIn

### 5.1 Acquisition — two phases

**Phase A — search.** `GET /voyager/api/voyagerJobsDashJobCards`, `decorationId=…JobSearchCardsCollection-220`, `q=jobSearch`, `count=25`, `start ∈ [0,25,50,75]`. The query string is hand-encoded to survive Voyager's parser (`(`→`%28`, `)`→`%29`, `+`→`%20`). Filters: `geoId:101620260` (Israel), `experience:List(1,2)`, `timePostedRange:List(r604800)`, `sortBy:List(DD)`. Auth via `li_at` + `JSESSIONID` + a matching `Csrf-Token`. 17 queries, batched 5 at a time with 2–3 min cool-offs. **[C]**

**Phase A parsing.** `normalizeResponse()` walks `elements[].jobCardUnion['*jobPostingCard']` and resolves each URN against `included[]` (exact match, then soft numeric match). Any element failing the chain is dropped with `return null`. The card yields only: `jobId`, `title.text`, `primaryDescription.text` (company), `secondaryDescription.text` (location), `footerItems[type=LISTED_DATE].timeAt`. **[C]**

**Phase B — enrichment.** `GET /voyager/api/graphql?variables=(jobPostingUrn:…)&queryId=voyagerJobsDashJobPostings.891aed7916d7453a37e4bbf5f1f60de4`, one request per surviving job, 3–6 s apart. **[C]**

### 5.2 Phase B attribute inventory — measured across 279 captured responses

`data.jobsDashJobPostingsById` contains **38 fields, all present on 100% of the 279 responses.**

#### Consumed (14)

`description.text` · `companyApplyUrl` · `title` · `skillsDescription` · `employmentStatus.localizedName` · `originalListedAt` / `listedAt` · `appliesCount` / `numApplicants` · `simpleApplication` / `easyApply` · `posterId` · `repostedJob` · `entityUrn` · `jobPostingUrn`

#### Present, unconsumed — ranked by measured value

| Field | Coverage | Observed values | Assessment |
|---|---|---|---|
| **`standardizedTitle.name`** | **82%** (228/279) | `Software Engineer`, `Full Stack Engineer`, `Data Analyst`, `Quality Assurance Engineer`, `Student`, `Back End Developer`, `Help Desk Specialist`, `Sales Engineer`, `Talent Acquisition Specialist` | **LinkedIn's own normalised title taxonomy.** The system currently substring-matches freeform titles against a 24-token keyword list; this is the vendor's canonical classification of the same job. Directly addresses `title_not_technical` misfires. |
| **`jobFunctions`** | **91%** (255/279) | **enum codes**, not prose: `ENG`, `IT`, `QA`, `SALE`, `BD`, `MGMT`, `MNFC`, `HR`, `MRKT`, `EDU`, `TRNG`, `DSGN`, `ART`, `OTHR`. Multi-valued — `ENG+IT` is the modal value at 53/279. | Structured function classification — the equivalent of a department array, which LinkedIn jobs otherwise entirely lack. **Codes, not the human-readable strings the old analysis assumed.** |
| **`industryV2Taxonomy`** | 100% | `[{name: "Computer Hardware Manufacturing"}]` | company-sector context |
| **`expireAt`** | 100% | epoch ms — **275 of 279 archived jobs are already past their `expireAt`** | posting-validity signal, absent from the pipeline entirely |
| **`closedAt` / `jobState`** | 100% | `null` / `"LISTED"` on all 279 | closed-posting detection |
| **`companyApplyUrl` + `trackingPixelUrl`** | 100% | | **see §5.3** |
| `location` | 100% | full Geo object: `{abbreviatedLocalizedName: "Tel Aviv District, Israel", …}` | structured geo vs. the card's freeform `secondaryDescription` string |
| `companyDetails.jobCompany.company` | 100% | full company entity | canonical company name + URN |
| `createdAt` | 100% | epoch ms | distinct from `listedAt` / `originalListedAt` |
| `contractorJob` | 100% | `false` | |
| `jobApplicationLimitReached` | 100% | `false` | |
| `preDashNormalizedJobPostingUrn`, `trackingUrn`, `suspendReasons`, `trustReview`, `trustReviewDecision`, `encryptedPricingParameters`, `jobBudget`, `creditBasedPromotion`, `freeTrialExpireAt`, `jobManagementEligibilities`, `openToHiringJobShowcase`, `eligibleForSharingProfileWithPoster`, `jobPostingTalentQuestions`, `repostedJobId`, `_type`, `_recipeType` | 100% | | low/no value |

#### Confirmed absent — corrections to the record

| Field | Old doc claim | Measured reality |
|---|---|---|
| **`seniorityLevel`** | "🔴 CRITICAL — a single check would replace the entire blacklist" | **Does not exist in the response.** 0/279. |
| **`workplaceTypes`** | "🟡 HIGH" | Present as a key, `null` on **279/279**. |
| `workRemoteAllowed` | — | `null` on 279/279 |
| `formattedSalary`, `formattedLocation`, `numApplied` | claimed | not present |
| `skillsDescription` | consumed | present but **`null` on 279/279** — the pipeline carries an always-empty field |
| `posterId` | consumed → `recruiter.id` | **`null` on 279/279** — the recruiter object is never constructed |

### 5.3 Cross-source origin detection — an unexploited join key **[M]**

`companyApplyUrl` and `trackingPixelUrl` frequently reveal the ATS backing a LinkedIn posting. Across the 279:

| n | Resolved origin |
|---|---|
| 142 | Easy Apply / no external URL |
| 100 | other / unrecognised host |
| 14 | **myworkdayjobs.com** |
| 11 | **comeet.com** |
| 9 | **greenhouse.io** |
| 3 | lever.co |

**34 of 279 (12%) of LinkedIn jobs resolve to an ATS this system already scrapes directly** — and one sample's `trackingPixelUrl` was literally `https://www.comeet.com/jobs/deltagalil/78.000?coref=…`, which contains the Comeet company UID *and* the position UID. These are the same postings arriving twice through different pipes, deduplicated by neither (`comeet_78.000` and `4099334589` are different keys). It is also a free company-discovery feed: 3 Lever hosts appeared in a corpus of 279, for a platform the system does not yet support.

### 5.4 LinkedIn job shape after enrichment

`scraper.js:390` spreads the Phase-A card and overlays Phase-B details. LinkedIn jobs **never enter `evaluateAtsGuard`** — they are filtered only by `passesFilters()`, a two-step title test: reject on any of ~200 `BLACKLIST_KEYWORDS`, then require at least one of 32 `WHITELIST_KEYWORDS`. No location gate (the `geoId` filter is trusted), no department gate, no description gate. The rich `description.text` fetched in Phase B is used for display only. **[C]**

---

## 6. UnifiedJob — the cross-source field matrix

There is no single UnifiedJob type. Each worker emits a different shape, and `ats/types/interfaces.d.ts` describes none of them (it declares 8 fields and only `'comeet' | 'greenhouse'` as sources). Actual population:

| Field | Comeet | Greenhouse | Workday | LinkedIn |
|---|:--:|:--:|:--:|:--:|
| `jobId` | `comeet_{uid}` | `gh_{id}` | `workday_{tenant}_{JR}` | bare numeric |
| `source` | ✅ | ✅ | ✅ | ✅ |
| `sourceCompanyId` | company.id | company.id | **tenant** | ✗ |
| `companyName` | ✅ | ✅ | ✅ | ✅ (`company`) |
| `title` / `location` / `url` | ✅ | ✅ | ✅ | ✅ |
| `description` | 51% | 100% | **always null** | ✅ (unused for filtering) |
| `postedAt` | ✗ (`time_updated`) | ✅ | heuristic | ✅ |
| `departments` | `department` string | full array | `structuredDepartment: null` | ✗ |
| `structuredLevel` | via `structuredSignals` | ~17% | always null | ✗ |
| `employmentType` | ✅ normalized enum | ✗ | `timeType` (3/15) | ✅ raw |
| `raw` | ✅ | ✅ | ✅ | ✗ |
| `metadata` / `offices` | ✗ | ✅ carried | ✗ | ✗ |
| `fallbackTier` | ✅ | ✗ | ✗ | ✗ |
| `appliesCount`, `isRepost`, `skills`, `recruiter` | ✗ | ✗ | ✗ | ✅ |

**Structural asymmetry, stated plainly:** LinkedIn jobs bypass the ATS gate stack entirely; Workday jobs bypass the description and department checks because those fields are hard-coded null; Comeet jobs bypass the description check ~49% of the time by accident. Only Greenhouse traverses the full gate stack with real data on every field.

---

## 7. Gate contracts

| Gate | File | Reads | Runs for | Verdicts |
|---|---|---|---|---|
| Location gate | per-worker `filterJob()` | Comeet: `location_object.country/name/city` → `location` → `Remote`. GH: `location.*` + `offices[].name/location`. WD: `locationsText` (client-side, only when no facet). | ATS only | pass / fail |
| Structured gate | `structuredGate.js` | `structuredSignals.experience_level`, `.employment_type`, `title` | **Comeet only** | `FAIL` / `CONTINUE` |
| ATS guard T1 title | `ats_guard.js:117` | `title` | all ATS | needs 1 of 24 `technicalTitleKeywords` (substring) or a Hebrew allow-regex; must not match 25 `titleSeniorPatterns` or 29 `titleDomainRejectPatterns` |
| ATS guard T2 department | `:172` | `departments[].name`, `structuredDepartment` | GH (real), Comeet (1-elem), **WD (no-op)** | `allowedTechnicalDepartments` override → then a 13-entry blacklist, exact match |
| ATS guard T3 structured level | `:200` | `structuredLevel` | GH ~17%, Comeet | `juniorPass` → fast-pass · `seniorFail` → fail · else neutral |
| ATS guard T4 description | `:229` | `description` | GH only in practice | `null` → **skipped**; else 14 `contentSeniorityPatterns` |
| Junior bypass | `:284-296` | `title` regex, `structuredSignals.employment_type`, `isStructuredStudent` | all ATS | skips **T4 only** |
| Speechify override | `:257` | `companyId === 'speechify'` + title | all ATS | pre-empts every other check |
| LinkedIn title filter | `filters_shared.js` | `title` | LinkedIn only | ~200 blacklist → 32 whitelist |

Two live inconsistencies, both **[C]**:

1. `structuredGate` returns only `FAIL` or `CONTINUE`. The `WHITELIST` branch it used to return is gone, but `comeetWorker.js:857` still contains an `if (structGate.verdict === 'WHITELIST')` block — **dead code** — and `SYSTEM_REFERENCE.md` §22 still documents the three-way verdict.
2. `structuredGate.SENIORITY_RE` and `vocabulary.structuredLevelIndicators.seniorFail` are two different vocabularies applied to the same `experience_level` string at two different points. See §2.3.

---

## 8. Dedup & the ID key space

| Source | Prefix | Construction | Notes |
|---|---|---|---|
| Comeet | `comeet_` | `position_uid`, split on `-`, first segment | compound-UID collapse prevents phantom duplicates |
| Greenhouse | **`gh_`** | numeric `id` | **not `greenhouse_`** — `SYSTEM_REFERENCE` §34 is wrong |
| Workday | `workday_{tenant}_` | `jobRequisition.id` → `externalPath` JR regex → path slug → `unknown_{Date.now()}` | |
| LinkedIn | *(none)* | first numeric run in `jobPostingUrn` / `entityUrn` | |

**Three dedup layers** **[C]**:

1. **Silent dedup (workers).** `knownJobIds` = `ats_sent_history` **∪** `seen_jobs`. Skipped jobs never reach a gate and never reach `calibration_rejected` — this is what makes rejection counts non-comparable across the March 2026 dedup fix. Comeet and Greenhouse honour it; **Workday does not**.
2. **`seen_jobs` write-back.** ATS `encounteredJobIds` (every ID seen, kept or dropped) are written to `seen_jobs` at `orchestrator.js:355`, giving ATS the same memory LinkedIn has.
3. **`JobStateService.filterNewJobs()`** — history membership, within-run duplicates, and a **run-scoped frequency cap**: at most `RUN_FREQUENCY_CAP` (default **3**) jobs per `{companyKey}__{canonicalTitle}`. `getCanonicalTitle()` strips trailing ` - City` / ` | City` suffixes, bracketed fragments, and `#123` / `req-123` tokens, so one role posted across ten cities collapses to one key. **Entirely undocumented before this file.**

Cross-source duplicates are **not** detected. The same posting reachable as `comeet_78.000` and as LinkedIn `4099334589` is two records (§5.3).

---

## 9. Persistence schemas

| Collection | Key | Written by | Payload | TTL |
|---|---|---|---|---|
| `seen_jobs` | `_id` = jobId | `saveSeenJobIds()` — LinkedIn cards + ATS encountered | `{_id, source, firstSeenAt, lastSeenAt, createdAt}` | 90 d |
| `ats_sent_history` | `_id` = jobId | `persistSentHistory()` (**fail-fast, throws**) | `{_id, sentAt, lastUpdatedAt, createdAt, ...metadata}` | 180 d |
| `companies` | `_id` | manual / discovery tools | `{name, type, uid, token, url, enabled}` | none |
| `calibration_rejected` | auto | `writeCalibrationRejected()` | `_stripJobForCalibration()` output | 60 d |
| `calibration_passed` | auto | `writeCalibrationPassed()` — post-dedup, post-send | same | 60 d |
| `run_summaries` | auto | `writeRunLog()` | worker `runStats` | 30 d |
| `system_state` | fixed keys | calibration timer + Mongo lock fallback | | none |

**`_stripJobForCalibration()`** (`MongoStorageAdapter.js:337`) is the entire observability contract — anything not in this list is unrecoverable after the run:

```
jobId · title · companyName · location · url · reason · source · gate
matchedKeywords · matchedBlacklistPatterns · structuredLevel
structuredDepartment · matchedLocationKeyword · employmentType · fallbackTier
```

Deliberately dropped: `raw`, `description`, `departments`, `offices`, `metadata`, `postedAt`. This is correct for quota reasons — but it means **no calibration analysis can ever ask a question about description content, department arrays, or posting age**, because that evidence is discarded at write time. Any attribute added to the pipeline that is meant to be *tuned* must also be added here.

---

## 10. Output surface

`TelegramNotifier.mapToLegacyFormat()` (`services/notifications/TelegramNotifier.js:27`) is the final projection. It emits:

`title` (source-label prefixed) · `company` · `location` · `url` · `applyUrl` · `postedAt`/`listedAt` · `employmentType` · `skills` · `recruiter` · `recruiterUrl` · `applyMethodEasyApply` · `appliesCount` · `workplaceTypes`

Six of those thirteen — `skills`, `recruiter`, `recruiterUrl`, `applyMethodEasyApply`, `appliesCount`, `workplaceTypes` — are LinkedIn-only, and §5.2 measured `skillsDescription`, `posterId`, and `workplaceTypes` as **null on 279/279**. The report therefore renders empty fields for every ATS job and for most LinkedIn jobs. Message limits: 4 096 chars hard, 3 500 soft body; Bottleneck limiter at 1.1 s. **[C]**

---

## 11. Ranked inventory of unexploited attribute surface

Ordered by expected ETL impact, with the evidence class for each.

| # | Opportunity | Source | Evidence | Effect |
|---|---|---|---|---|
| 1 | **Comeet position-detail fetch** → canonical `description` + **`requirements`** | Comeet | **[P]** live 200 | Closes a **49%** description blind spot and supplies the requirements text `contentSeniorityPatterns` was written for. `position_url` is already in every row. |
| 2 | **Workday job-detail fetch** → `jobDescription`, `country.alpha2Code`, `startDate`, `timeType` | Workday | **[P]** live 200 | Gives the largest corpus its first description signal; replaces relative-date and string-location heuristics with canonical values. |
| 3 | **LinkedIn `standardizedTitle.name`** | LinkedIn | **[M]** 82% | Vendor-normalised title taxonomy in place of substring matching on freeform titles. |
| 4 | **LinkedIn `jobFunctions`** | LinkedIn | **[M]** 91% | The only structured department-equivalent available for LinkedIn jobs. Enum codes (`ENG`, `QA`, `SALE`…). |
| 5 | **Cross-source origin join** via `companyApplyUrl` / `trackingPixelUrl` | LinkedIn | **[M]** 12% resolve to a scraped ATS | Cross-source dedup + free company discovery (Lever hosts observed). |
| 6 | **Repair the `experience_level` vocabularies** | Comeet | **[M]** ~13% miss rate | `Experienced (3-5 Years)`, `Advanced (5-8 Years)`, `Expert (8+ Years)`, `Manager`, `Lead`, `Entry-level` (hyphen). Reconcile the two divergent lists. |
| 7 | **Workday server-side facets** `workerSubType`, `jobFamilyGroup` | Workday | **[P]** facets exist; **[U]** value IDs | Filter before pagination — cuts requests and evades the 2 000-row cap. |
| 8 | **Exclude boilerplate keys from Comeet `buildDescription()`** | Comeet | **[M]** | `Podcast`, `Statement`, `Benefits`, `About Us`, `What We Offer` are scanned for seniority patterns today. |
| 9 | **Greenhouse `metadata[]` beyond Job Level** | Greenhouse | **[M]** 1 board | `Full-Time or Part-Time`, `Employee Class`. Also: guard against `"7 - … Director …"` label text triggering `seniorFail`. |
| 10 | **`expireAt` / `posted` / `canApply`** | LinkedIn, Workday | **[M]** / **[P]** | Posting validity. 275/279 archived LinkedIn jobs were already expired. |
| 11 | **Greenhouse `offices[]` hierarchy, `internal_job_id`** | Greenhouse | **[M]** 100% | Disambiguate `"Remote - New York"`, which currently passes the location gate on the bare token `remote`. |
| 12 | **Workday `remoteType`** | Workday | **[M]** 4/15 tenants | Present and entirely unread. |

---

## 12. Errata — corrections to existing documentation

### `docs/analysis/ats_guard_and_raw_payload_analysis.md` (2026-02-26)

| Claim | Status |
|---|---|
| "Every worker passes the `rawJob` object" to the guard | **Obsolete** — all three now pass a constructed `guardPayload` |
| Comeet department check is "dead" (string vs array) | **Fixed** — normalization wraps it as `[{name}]` |
| Comeet description invisible to the guard | **Fixed** — `description` is on the guardPayload |
| Workday `jobCategory`, `managementLevel`, `jobFamilyGroup`, `requisitionType`, `workerType`, `isRemote`, `subtitleText` are available "Missing Gold" | **False** — none exist on the listing endpoint on any of 15 tenants **[M]** |
| Workday `title` is null on NVIDIA; `bulletFields = [title, location, timeType, JR]` | **False** — `title` is 100% present; `bulletFields` is `[JR]` **[M]** |
| LinkedIn `seniorityLevel` is available and "CRITICAL" | **False** — absent from 279/279 responses **[M]** |
| LinkedIn `jobFunctions` returns strings like `"Engineering"` | **Partly false** — returns enum codes (`ENG`, `IT`) **[M]** |
| LinkedIn `workplaceTypes`, `formattedSalary` usable | **False** — `workplaceTypes` null 279/279; `formattedSalary` absent **[M]** |
| R4: use Comeet `?details=true` | **False** — no effect **[P]**. The position-detail endpoint is the real answer. |
| Comeet `categories` / `details` arrays | **Not observed** in 358 positions or in live probes |

### `docs/SYSTEM_REFERENCE.md` (2026-03-23, v7.1)

| Section | Correction |
|---|---|
| §3, §13, §30 | Email/Gmail SMTP data plane → **Telegram** (`cc26c75`) |
| §21 | The guard is **four**-tier (+ structured level), plus a Speechify override and a junior bypass; 386 lines, not 214 |
| §22 | `structuredGate` no longer returns `WHITELIST`; it sets `isStructuredStudent` and returns `CONTINUE` |
| §25 | Workers pass `guardPayload`, not `rawJob` |
| §34 | Greenhouse prefix is **`gh_`**, not `greenhouse_` |
| §34 | The silent-dedup set is `ats_sent_history` **∪ `seen_jobs`**, not `ats_sent_history` alone |
| §34 | **Missing:** the `RUN_FREQUENCY_CAP` layer |
| §4 | `config/vocabulary.js` now also exports `israelLocationKeywords`, `structuredLevelIndicators`, `normalizeEmploymentType`, `titleDomainRejectPatterns`, `technicalTitleAllowPatterns` |
| §20 | Workers use `israelLocationKeywords` from vocabulary; `ats/utils/locationGate.js` is imported by the orchestrator but not applied on the live path |
| §4 | Line counts stale across the board (comeet 1047 not 923; workday 857 not 747; structuredGate 57 not 34) |

### `ats/types/interfaces.d.ts`

Declares an 8-field `UnifiedJob` with `source: 'comeet' | 'greenhouse'`. It does not describe any shape any worker actually emits. §6 above is the real matrix.

### Dead code

`ats/utils/normalizeJob.js`, `ats/utils/locationGate.js`, and `ats/utils/semanticGate.js` are imported by `ats/orchestrator.js:14-16` and never called. `normalizeJob.js` additionally reads `rawJob.uid` and `rawJob.url_active_page` — fields not present in any measured Comeet payload.
