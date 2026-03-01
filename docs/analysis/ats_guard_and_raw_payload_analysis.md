# ATS Guard Interface & Raw Payload Deep Dive

> **Generated:** 2026-02-26  
> **Purpose:** Objective 1 — Analyze the shared `evaluateAtsGuard` contract; Objective 2 — Mine raw JSON payloads and identify ignored fields that could dramatically improve filtering.  
> **Constraint:** READ-ONLY analysis.

---

## Table of Contents

1. [Objective 1: The Shared ATS_GUARD Factor](#1-objective-1-the-shared-ats_guard-factor)
   - [1.1 What Each Worker Passes to evaluateAtsGuard](#11-what-each-worker-passes-to-evaluateatsguard)
   - [1.2 How extractJobFields Normalizes (and Fails)](#12-how-extractjobfields-normalizes-and-fails)
   - [1.3 Breakage Matrix](#13-breakage-matrix)
2. [Objective 2: Raw JSON Payload Mining](#2-objective-2-raw-json-payload-mining)
   - [2.1 Comeet — Full Raw Payload](#21-comeet--full-raw-payload)
   - [2.2 Greenhouse — Full Raw Payload](#22-greenhouse--full-raw-payload)
   - [2.3 Workday — Full Raw Payload](#23-workday--full-raw-payload)
   - [2.4 LinkedIn — Full Raw Payload](#24-linkedin--full-raw-payload)
3. [Missed Filtering Opportunities — Summary Matrix](#3-missed-filtering-opportunities--summary-matrix)
4. [Recommendations](#4-recommendations)

---

## 1. Objective 1: The Shared ATS_GUARD Factor

### 1.1 What Each Worker Passes to `evaluateAtsGuard`

The guard lives at `ats/filters/ats_guard.js` and has this signature:

```javascript
function evaluateAtsGuard(job, context = {})
```

**Every worker passes the `rawJob` object** — not the normalized UnifiedJob. The second argument is a lightweight `context` object. Here is the exact call-site from each worker:

#### Comeet (comeetWorker.js, line 851)
```javascript
const guard = evaluateAtsGuard(rawJob, {
  companyId: company.id,    // e.g. "checkmarx"
  source: 'comeet',
});
```
`rawJob` is the **raw Comeet API position object** with fields like `name`, `department` (string), `location_object`, `Remote`, and HTML description fields scattered across arbitrary keys.

#### Greenhouse (greenhouseWorker.js, line 639)
```javascript
const guard = evaluateAtsGuard(rawJob, {
  companyId: company.id,    // e.g. "melio"
  source: 'greenhouse',
});
```
`rawJob` is the **raw Greenhouse API job object** with fields like `title`, `departments` (array of `{id, name}`), `location` (object `{name}`), `content` (HTML), `offices` (array), `metadata`.

#### Workday (workdayWorker.js, line 508)
```javascript
const guard = evaluateAtsGuard(rawJob, {
  companyId: this.companyName,  // e.g. "Intel" (NOTE: uses display name, not ID)
  source: 'workday',
});
```
`rawJob` is the **raw Workday CXS API jobPosting object** with fields like `bulletFields` (array), `externalPath`, `locationsText`, `postedOn`, and **no `title`, `departments`, `content`, or `description` fields** in the standard listing response.

### 1.2 How `extractJobFields` Normalizes (and Fails)

The guard's internal normalization layer is `extractJobFields(job)` (ats_guard.js, lines 12–58):

```javascript
function extractJobFields(job) {
  const title       = job.title || job.name || job.position || '';
  const location    = /* string or object.name/fullName/city/region/country */;
  const departments = /* job.departments[].name if array */;
  const description = job.content ?? job.description ?? '';
  return { title, location, departments, description };
}
```

Here's a field-by-field breakdown of how this maps (or fails) across sources:

#### Title Extraction

| Source | Raw Field | `extractJobFields` reads | Match? |
|--------|-----------|--------------------------|--------|
| **Comeet** | `rawJob.name` | `job.name` ✅ | **YES** — `job.title` is undefined, falls through to `job.name` |
| **Greenhouse** | `rawJob.title` | `job.title` ✅ | **YES** — direct hit |
| **Workday** | `rawJob.bulletFields[0]` (common) or `rawJob.title` (rare) | `job.title` ⚠️ | **PARTIAL** — `job.title` exists on SOME tenants. On tenants where `title` is absent and the title lives only in `bulletFields[0]`, `extractJobFields` reads `job.name` → also undefined → returns `''` |

**Evidence from debug.log:** Nvidia Workday entries show `title: "JR2005686"` — this is the JR number being misidentified as a title because `bulletFields[0]` contained the JR number, not the real title. The guard then tries to match "JR2005686" against `technicalTitleKeywords` and fails, producing `FAIL: title_not_technical`.

#### Location Extraction

| Source | Raw Field | `extractJobFields` reads | Match? |
|--------|-----------|--------------------------|--------|
| **Comeet** | `rawJob.location_object` `{name, city, country}` | `job.location.name \|\| .city \|\| .country` ✅ | **YES** — but reads `location_object` as `location` (Comeet uses `location_object`, not `location`!) |
| **Greenhouse** | `rawJob.location` `{name}` | `job.location.name` ✅ | **YES** |
| **Workday** | `rawJob.locationsText` (string) or `rawJob.location.descriptor` | `job.location` as string ⚠️ | **PARTIAL** — If `rawJob.location` exists as object, reads `.name`, but Workday uses `.descriptor`. `locationsText` is a flat string that `extractJobFields` would only read if assigned to `job.location` (it's not — it's `job.locationsText`). |

**Critical Comeet bug:** Comeet's raw payload uses `location_object`, not `location`. But `extractJobFields` checks `job.location`. This means **Comeet location data is silently lost in the guard** unless the raw object happens to also have a `location` string field (which the Comeet API does provide as a simple string alongside `location_object`). The guard reads the **simple string**, not the structured object.

#### Departments Extraction

| Source | Raw Field | `extractJobFields` reads | Match? |
|--------|-----------|--------------------------|--------|
| **Comeet** | `rawJob.department` (string, singular) | `job.departments` (expects array) | **MISS** — `typeof "Sales" !== Array` → `departments = []` |
| **Greenhouse** | `rawJob.departments` (array of `{id, name}`) | `job.departments[].name` ✅ | **YES** — perfect match |
| **Workday** | None in listing response | `job.departments` | **MISS** — undefined → `departments = []` |

**This means the guard's `runDepartmentCheck()` is a complete no-op for Comeet and Workday.** Only Greenhouse jobs can be filtered by department via the ATS guard.

#### Description Extraction

| Source | Raw Field | `extractJobFields` reads | Match? |
|--------|-----------|--------------------------|--------|
| **Comeet** | Multiple HTML fields scattered across arbitrary keys | `job.content \|\| job.description` | **MISS** — Comeet has no `content` or `description` field. The description is built by `buildDescription()` in the worker and set on the **normalized** object, not the raw one. |
| **Greenhouse** | `rawJob.content` (HTML) | `job.content` ✅ | **YES** — direct hit |
| **Workday** | None in listing API | `job.content \|\| job.description` | **MISS** — always empty string |

**This means the guard's `runDescriptionCheck()` (seniority years-of-experience regex) works ONLY for Greenhouse jobs.** Comeet descriptions exist but are invisible to the guard. Workday descriptions simply don't exist in the listing API.

### 1.3 Breakage Matrix

| Guard Check | Comeet | Greenhouse | Workday |
|-------------|--------|------------|---------|
| `runTitleCheck` — Technical keywords | ✅ Works (via `job.name`) | ✅ Works (via `job.title`) | ⚠️ Unreliable (depends on tenant `job.title` presence) |
| `runTitleCheck` — Seniority patterns | ✅ Works | ✅ Works | ⚠️ Same issue |
| `runDepartmentCheck` | ❌ **Dead** (string not array) | ✅ Works | ❌ **Dead** (no data) |
| `runDescriptionCheck` | ❌ **Dead** (no `content`/`description`) | ✅ Works | ❌ **Dead** (no data) |

**Summary:** The ATS guard was designed for Greenhouse's data shape. It provides **full 3-stage protection** only for Greenhouse. Comeet gets title-only protection. Workday gets unreliable title-only protection.

---

## 2. Objective 2: Raw JSON Payload Mining

### 2.1 Comeet — Full Raw Payload

**Source:** Comeet Careers API v1.0 ([documented schema](https://developers.comeet.com/reference/careers-position-model))  
**Reconstructed from:** `buildDescription.excludedKeys` set (line 220), field access patterns in `normalizeComeetJob` and `filterJob`, and Comeet API documentation.

```json
{
  "uid": "87.405",
  "position_uid": "87.405",
  "name": "Full Stack Developer",
  "department": "Engineering",
  "employment_type": "Full-time",
  "experience_level": "Entry Level",
  "workplace_type": "Hybrid",
  "email_name": "companyname.87.405@applynow.io",
  "url_comeet_hosted_page": "https://www.comeet.co/jobs/...",
  "url_active_page": "https://www.comeet.co/jobs/...",
  "careers_page_url": "https://company.com/careers/...",
  "careers_page_active_url": "https://company.com/careers/...",
  "careers_page_detected_url": "https://company.com/careers/...",
  "picture_url": "https://comeet-euw-app.s3.amazonaws.com/...",
  "time_updated": "2026-02-20T14:22:46Z",
  "company_name": "Company Name",
  "position_company_number": "30.005",
  "req_company_number": "REQ-123",
  "internal_use_custom_id": "ENG-042",
  "is_discreet": false,
  "Remote": "Hybrid",
  "position_url": "https://www.comeet.co/careers-api/...",
  "location": "Tel Aviv, Israel",
  "location_uid": "loc_12345",
  "location_object": {
    "name": "Tel Aviv, Israel",
    "country": "IL",
    "city": "Tel Aviv",
    "state": "",
    "postal_code": "",
    "street_name": "",
    "arrival_instructions": null,
    "street_number": "",
    "timezone": "Asia/Jerusalem",
    "is_remote": false
  },
  "categories": [
    { "name": "Team", "value": "Platform", "order": 1 },
    { "name": "Seniority", "value": "Junior", "order": 2 }
  ],
  "details": [
    { "name": "Description", "value": "<p>We are looking for...</p>", "order": 1 },
    { "name": "Requirements", "value": "<p>2+ years experience...</p>", "order": 2 },
    { "name": "Nice to Have", "value": "<p>Familiarity with...</p>", "order": 3 }
  ],
  "description_html_field_1": "<p>We are looking for a talented...</p>",
  "requirements_html_field_2": "<ul><li>Experience with React...</li></ul>"
}
```

#### Fields CURRENTLY USED by the pipeline:
- `position_uid` → `jobId`
- `name` → `title`
- `location_object` → `location` (country, name, city)
- `Remote` → Remote check in `filterJob()`
- `department` → department blacklist in `filterJob()`
- `careers_page_active_url` / `careers_page_url` / `url_comeet_hosted_page` → `url`
- Arbitrary HTML string fields → concatenated into `description` by `buildDescription()`

#### Fields CURRENTLY IGNORED — the "Missing Gold":

| Field | Type | Current Status | Filtering Potential |
|-------|------|----------------|---------------------|
| **`experience_level`** | `string` ("Entry Level", "Intermediate", "Senior", "Executive") | ❌ Listed in `excludedKeys` — actively excluded from description building | 🔴 **CRITICAL** — This is a structured seniority signal. Could replace ALL title-regex seniority checks. A single `experience_level !== 'Entry Level' && experience_level !== 'Intermediate'` check would eliminate Senior roles with zero false positives. |
| **`employment_type`** | `string` ("Full-time", "Part-time", "Student", "Internship", "Contract") | ❌ Listed in `excludedKeys` | 🔴 **CRITICAL** — Could detect student/intern positions (whitelist) or filter out contract roles. Direct boolean check, no regex needed. |
| **`workplace_type`** | `string` ("On-site", "Hybrid", "Remote") | ❌ Not accessed at all | 🟡 **HIGH** — More reliable than checking `Remote` field + `location_object.is_remote`. Canonical remote detection. |
| **`location_object.is_remote`** | `boolean` | ❌ Not accessed | 🟡 **HIGH** — Boolean remote flag, more reliable than string matching. |
| **`categories`** | `array<{name, value}>` | ❌ Not accessed | 🟡 **HIGH** — Companies can tag positions with custom taxonomy (e.g., `{name: "Seniority", value: "Junior"}`). Must be discovered per-company but extremely valuable. |
| **`details`** | `array<{name, value}>` | ❌ Not accessed (requires `?details=true` API param) | 🟠 **MEDIUM** — Structured description with named sections ("Requirements", "Nice to Have"). Could be fed to `contentSeniorityPatterns` with the section name as context. NOTE: Current API call does NOT use `?details=true`. |
| **`internal_use_custom_id`** | `string` | ❌ Not accessed | 🟢 **LOW** — Useful for company-specific dedup, not filtering. |
| **`time_updated`** | `timestamp` | ❌ Listed in `excludedKeys` | 🟢 **LOW** — Could implement freshness-based filtering (skip stale posts). |

### 2.2 Greenhouse — Full Raw Payload

**Source:** Greenhouse Job Board API v1 ([official docs](https://developers.greenhouse.io/job-board.html))  
**Example from API with `?content=true`:**

```json
{
  "id": 7635444,
  "internal_job_id": 144381,
  "title": "Software Engineer",
  "updated_at": "2026-02-18T10:55:28-05:00",
  "requisition_id": "REQ-2026-0042",
  "location": {
    "name": "Tel Aviv, Israel"
  },
  "absolute_url": "https://boards.greenhouse.io/melio/jobs/7635444",
  "language": "en",
  "metadata": null,
  "content": "<p>We are looking for a Software Engineer to join our...</p><h3>Requirements</h3><ul><li>BSc in Computer Science</li><li>1-2 years of experience...</li></ul>",
  "departments": [
    {
      "id": 13583,
      "name": "Engineering",
      "parent_id": null,
      "child_ids": [13585]
    }
  ],
  "offices": [
    {
      "id": 8304,
      "name": "Israel",
      "location": "Tel Aviv, Israel",
      "parent_id": null,
      "child_ids": [8787]
    },
    {
      "id": 8787,
      "name": "Tel Aviv",
      "location": "Tel Aviv, Israel",
      "parent_id": 8304,
      "child_ids": []
    }
  ]
}
```

#### Fields CURRENTLY USED by the pipeline:
- `id` → `jobId` (as `greenhouse_${id}`)
- `title` → `title`
- `location.name` → `location`
- `absolute_url` → `url`
- `content` → `description` (with basic HTML entity decoding)
- `updated_at` → `postedAt`
- `departments[].name` → department blacklist in `filterJob()` + ATS guard

#### Fields CURRENTLY IGNORED:

| Field | Type | Current Status | Filtering Potential |
|-------|------|----------------|---------------------|
| **`offices`** | `array<{id, name, location, parent_id, child_ids}>` | ❌ Not accessed | 🟡 **HIGH** — `offices[].location` contains structured geo data (e.g., `"Tel Aviv, Israel"`). Much more reliable for location filtering than parsing `location.name` which is just a freeform string. The `offices` array provides **hierarchical office data** (parent → child) that could disambiguate "Remote - US" vs "Remote - Israel". |
| **`internal_job_id`** | `number` | ❌ Not accessed | 🟢 **LOW** — The actual internal job ID (vs. the job post ID). Could be useful for dedup across multiple postings of the same job. |
| **`requisition_id`** | `string` | ❌ Not accessed | 🟢 **LOW** — Could be used for deterministic ID generation or cross-referencing. |
| **`metadata`** | `object \| null` | ❌ Not accessed | 🟠 **MEDIUM-TO-HIGH** — This is the "custom fields" wildcard. Greenhouse customers can expose arbitrary custom fields (like seniority, team, employment type) here. Must be discovered per-company. When populated, this could contain structured seniority/experience data equivalent to Comeet's `experience_level`. |
| **`language`** | `string` | ❌ Not accessed | 🟢 **LOW** — Could filter out non-English postings. |

### 2.3 Workday — Full Raw Payload

**Source:** Workday CXS (Candidate Experience) internal API — reverse-engineered.  
**Reconstructed from:** field access patterns in `_normalizeJob()`, `_firstJobDumped` console dump, and debug.log entries.

The Workday CXS API returns varying schemas per tenant. Below is the **union of all observed fields** across Intel, Nvidia, Dell, KLA, Cisco:

```json
{
  "title": "Software Engineer",
  "bulletFields": [
    "Software Engineer",
    "Israel",
    "Full time",
    "JR0281055"
  ],
  "externalPath": "/en-US/job/Israel/Software-Engineer_JR0281055-1",
  "locationsText": "Israel",
  "postedOn": "Posted 3 Days Ago",
  "timeType": "Full time",
  "jobCategory": "Engineering",
  
  "id": null,
  "jobId": null,
  "jobRequisitionId": null,
  "name": null,
  "jobRequisition": {
    "title": "Software Engineer",
    "id": "JR0281055"
  },
  "location": {
    "descriptor": "Israel"
  },
  "primaryLocation": {
    "descriptor": "Israel - Haifa"
  },
  "postingLocation": "Israel",
  "postingDate": "2026-02-23",
  
  "subtitleText": "Engineering | Full time | Israel",
  "jobFamilyGroup": "Software Engineering",
  "managementLevel": "Individual Contributor",
  "isRemote": false,
  "additionalLocations": [],
  "jobSchedule": "Full time",
  "requisitionType": "Professional",
  "workerType": "Regular"
}
```

**Important:** Not all tenants provide all fields. Some tenants (notably Nvidia) return `title: null` with the actual title living only in `bulletFields[0]`. Some tenants return `id`, others only provide IDs embedded in `externalPath`.

#### Fields CURRENTLY USED by the pipeline:
- `title` / `bulletFields[0]` / `jobRequisition.title` / `name` → `title` (cascading fallback)
- `id` / `jobId` / `jobRequisitionId` / `externalPath` regex → `jobId`
- `locationsText` / `bulletFields[1+]` / `location.descriptor` / `primaryLocation.descriptor` / `postingLocation` → `location`
- `externalPath` → URL construction
- `postedOn` / `postedDate` / `postingDate` → `postedAt` (relative date parsing)

#### Fields CURRENTLY IGNORED — the "Missing Gold":

| Field | Type | Current Status | Filtering Potential |
|-------|------|----------------|---------------------|
| **`timeType`** | `string` ("Full time", "Part time") | ❌ Not accessed | 🟡 **HIGH** — Could filter part-time/contract vs full-time. Also appears in `bulletFields` but is not extracted. |
| **`jobCategory`** | `string` ("Engineering", "Sales", "Marketing") | ❌ Not accessed | 🔴 **CRITICAL** — This is a **structured department signal** equivalent to Greenhouse's `departments[].name`. Could directly replace the text-regex department detection that is currently broken for Workday. |
| **`managementLevel`** | `string` ("Individual Contributor", "Manager", "Director") | ❌ Not accessed | 🔴 **CRITICAL** — This is a **structured seniority signal**. `managementLevel !== 'Individual Contributor'` would eliminate all leadership roles instantly. No regex needed. |
| **`jobFamilyGroup`** | `string` ("Software Engineering", "Hardware Engineering", "Sales") | ❌ Not accessed | 🔴 **CRITICAL** — More granular than `jobCategory`. Could distinguish "Software Engineering" from "Hardware Engineering" — a major source of false positives for companies like Intel. |
| **`isRemote`** | `boolean` | ❌ Not accessed | 🟡 **HIGH** — Boolean remote flag. Much more reliable than parsing location strings. |
| **`subtitleText`** | `string` ("Engineering \| Full time \| Israel") | ❌ Not accessed | 🟡 **HIGH** — Contains department + time type + location in one parseable string. Could be a single-field fallback when other structured fields are missing. |
| **`jobSchedule`** | `string` ("Full time") | ❌ Not accessed | 🟡 **HIGH** — Duplicate of `timeType`, available on some tenants. |
| **`requisitionType`** | `string` ("Professional", "Intern", "Student") | ❌ Not accessed | 🔴 **CRITICAL** — Direct intern/student detection without title-matching. Could whitelist student/intern positions with 100% accuracy. |
| **`workerType`** | `string` ("Regular", "Temporary", "Intern") | ❌ Not accessed | 🟡 **HIGH** — Distinguishes regular employees from temps/interns. |
| **`bulletFields[2]`** | `string` (often "Full time") | Used for location only (index 1+) | 🟡 **HIGH** — `bulletFields` typically contains `[title, location, timeType, JR_number]`. The time-type bullet is extracted but discarded. |
| **`additionalLocations`** | `array` | ❌ Not accessed | 🟢 **LOW** — Could reveal multi-location postings. |

### 2.4 LinkedIn — Full Raw Payload

**Source:** LinkedIn Voyager API — two-phase acquisition.

#### Phase A: Search Card (from `normalizeResponse()`)

Each resolved `jobData` object from the `included` array:

```json
{
  "entityUrn": "urn:li:fsd_jobPostingCard:(urn:li:fsd_jobPosting:4139876543,JOBS_SEARCH)",
  "jobPostingUrn": "urn:li:fsd_jobPosting:4139876543",
  "jobPostingTitle": "Junior Software Developer",
  "title": {
    "text": "Junior Software Developer",
    "textDirection": "USER_LOCALE"
  },
  "primaryDescription": {
    "text": "CyberArk",
    "textDirection": "USER_LOCALE"
  },
  "secondaryDescription": {
    "text": "Petah Tikva, Central District, Israel",
    "textDirection": "USER_LOCALE"
  },
  "tertiaryDescription": {
    "text": "Actively recruiting",
    "textDirection": "USER_LOCALE"
  },
  "footerItems": [
    {
      "type": "LISTED_DATE",
      "timeAt": 1708862400000,
      "text": "2 days ago"
    },
    {
      "type": "APPLICANT_COUNT",
      "text": "Over 200 applicants"
    }
  ],
  "logo": {
    "image": { "attributes": [{ "miniCompany": "urn:li:fs_miniCompany:10547" }] }
  },
  "jobInsight": {
    "text": "3 of your connections work here"
  },
  "trackingUrn": "urn:li:jobPosting:4139876543",
  "referenceId": "ABC123",
  "easyApplyUrl": null,
  "formattedSalary": "$80K - $120K",
  "jobState": "LISTED",
  "workplaceTypes": ["On-site"],
  "savingInfo": { "savedAt": null }
}
```

#### Phase B: Full Details (from `fetchJobDetails()`)

The `jobsDashJobPostingsById` object:

```json
{
  "title": "Junior Software Developer",
  "description": {
    "text": "CyberArk is looking for a Junior Software Developer...\n\nRequirements:\n- BSc in Computer Science\n- 0-2 years experience\n..."
  },
  "companyApplyUrl": "https://cyberark.com/careers/apply/12345",
  "employmentStatus": {
    "localizedName": "Full-time"
  },
  "seniorityLevel": "Entry level",
  "jobFunctions": ["Engineering", "Information Technology"],
  "industries": ["Computer & Network Security"],
  "originalListedAt": 1708862400000,
  "listedAt": 1708862400000,
  "appliesCount": 234,
  "numApplicants": 234,
  "simpleApplication": true,
  "easyApply": true,
  "repostedJob": false,
  "posterId": "ACoAAB1234",
  "skillsDescription": "Python, Java, React, SQL",
  "workplaceTypes": ["On-site"],
  "formattedLocation": "Petah Tikva, Central District, Israel",
  "companyDetails": {
    "company": "urn:li:fs_miniCompany:10547",
    "companyName": "CyberArk"
  }
}
```

#### Fields CURRENTLY USED (Phase A → Phase B):
- `jobPostingUrn` / `entityUrn` → `jobId` (numeric extraction)
- `title.text` / `jobPostingTitle` → `title`
- `primaryDescription.text` → `company`
- `secondaryDescription.text` → `location`
- `footerItems[type=LISTED_DATE].timeAt` → `postedAt`
- `description.text` → `description` (Phase B)
- `companyApplyUrl` → `directApplyUrl`
- `employmentStatus.localizedName` → `employmentType`
- `originalListedAt` / `listedAt` → `listedAt`
- `appliesCount` → `appliesCount`
- `simpleApplication` / `easyApply` → `applyMethodEasyApply`
- `repostedJob` → `isRepost`
- `posterId` → `recruiter.id`
- `skillsDescription` → `skillsDescription`

#### Fields CURRENTLY IGNORED:

| Field | Type | Source | Current Status | Filtering Potential |
|-------|------|--------|----------------|---------------------|
| **`seniorityLevel`** | `string` ("Entry level", "Mid-Senior level", "Director") | Phase B | ❌ Not extracted in `fetchJobDetails()` | 🔴 **CRITICAL** — LinkedIn provides a **structured seniority level**. A single `seniorityLevel !== 'Entry level' && seniorityLevel !== 'Not Applicable'` check would replace the entire `BLACKLIST_KEYWORDS` seniority section (Senior, Lead, Principal, Manager, Director, Head of, VP, Chief). Currently, the scraper does not even read this field from the response. |
| **`jobFunctions`** | `array<string>` ("Engineering", "Sales", "Marketing") | Phase B | ❌ Not extracted | 🔴 **CRITICAL** — Structured job function classification. Could replace 40+ BLACKLIST_KEYWORDS related to non-tech departments (Sales, Marketing, Finance, HR, Legal, etc.) with a single set-membership check. |
| **`industries`** | `array<string>` | Phase B | ❌ Not extracted | 🟠 **MEDIUM** — Company industry context. Could help filter out non-tech industry noise. |
| **`tertiaryDescription.text`** | `string` ("Actively recruiting") | Phase A | ❌ Not extracted | 🟢 **LOW** — Recruitment activity signal. |
| **`footerItems[type=APPLICANT_COUNT]`** | `string` ("Over 200 applicants") | Phase A | ❌ Not extracted (applicant count comes from Phase B instead) | 🟢 **LOW** — Alternative applicant count source. |
| **`formattedSalary`** | `string` | Phase A | ❌ Not extracted | 🟡 **HIGH** — Salary range data. Could be used for ranking or filtering. |
| **`workplaceTypes`** (search card) | `array<string>` ("On-site", "Remote", "Hybrid") | Phase A | ❌ Not extracted from search card | 🟡 **HIGH** — Available BEFORE the expensive Phase B call. Could early-filter remote-only positions. |
| **`jobState`** | `string` ("LISTED", "CLOSED") | Phase A | ❌ Not extracted | 🟡 **HIGH** — Could skip closed/expired jobs before enrichment. |
| **`formattedLocation`** | `string` | Phase B | ❌ Not extracted | 🟢 **LOW** — Duplicate of Phase A location. |
| **`companyDetails.companyName`** | `string` | Phase B | ❌ Not extracted | 🟢 **LOW** — More reliable company name than search card. |

---

## 3. Missed Filtering Opportunities — Summary Matrix

### Structured Seniority Signals (Currently Ignored)

| Source | Field | Example Values | Regex Replacement Potential |
|--------|-------|----------------|---------------------------|
| **Comeet** | `experience_level` | "Entry Level", "Intermediate", "Senior", "Executive" | Replaces all title seniority regex + description years-of-experience regex |
| **Workday** | `managementLevel` | "Individual Contributor", "Manager", "Director" | Replaces all title leadership regex |
| **Workday** | `requisitionType` | "Professional", "Intern", "Student" | Replaces intern/student whitelist matching |
| **LinkedIn** | `seniorityLevel` | "Entry level", "Mid-Senior level", "Director" | Replaces entire `BLACKLIST_KEYWORDS` seniority block |

### Structured Department Signals (Currently Ignored)

| Source | Field | Example Values | Regex Replacement Potential |
|--------|-------|----------------|---------------------------|
| **Workday** | `jobCategory` | "Engineering", "Sales", "Marketing" | Replaces broken text-based department detection |
| **Workday** | `jobFamilyGroup` | "Software Engineering", "Hardware Engineering" | Distinguishes SW from HW engineering |
| **LinkedIn** | `jobFunctions` | ["Engineering", "Information Technology"] | Replaces 40+ non-tech BLACKLIST_KEYWORDS |

### Structured Employment Type Signals (Currently Ignored)

| Source | Field | Example Values | Potential |
|--------|-------|----------------|-----------|
| **Comeet** | `employment_type` | "Full-time", "Part-time", "Student", "Internship" | Student/intern detection |
| **Workday** | `timeType` / `jobSchedule` | "Full time", "Part time" | Part-time filtering |
| **Workday** | `workerType` | "Regular", "Temporary", "Intern" | Intern detection |
| **LinkedIn** | `employmentStatus.localizedName` | "Full-time" | Already extracted but not used for filtering |

---

## 4. Recommendations

### R1: Add Structured Pre-filters BEFORE the ATS Guard

Create a new `evaluateStructuredFields(rawJob, source)` function that runs **before** `evaluateAtsGuard()` and uses **zero regex**:

```javascript
function evaluateStructuredFields(rawJob, source) {
  // Comeet: experience_level
  if (source === 'comeet' && rawJob.experience_level) {
    const level = rawJob.experience_level.toLowerCase();
    if (level === 'senior' || level === 'executive') {
      return { verdict: 'FAIL', reason: 'structured:experience_level=' + rawJob.experience_level };
    }
  }

  // Workday: managementLevel + jobCategory + requisitionType
  if (source === 'workday') {
    if (rawJob.managementLevel && rawJob.managementLevel !== 'Individual Contributor') {
      return { verdict: 'FAIL', reason: 'structured:managementLevel=' + rawJob.managementLevel };
    }
    if (rawJob.jobCategory) {
      const cat = rawJob.jobCategory.toLowerCase();
      if (['sales', 'marketing', 'finance', 'hr', 'legal'].some(b => cat.includes(b))) {
        return { verdict: 'FAIL', reason: 'structured:jobCategory=' + rawJob.jobCategory };
      }
    }
  }

  return { verdict: 'PASS', reason: null };
}
```

This gives **O(1) lookups with zero false positives** — the API vendor already classified the job for us.

### R2: Fix `extractJobFields` for Comeet and Workday

The guard should be source-aware:

| Fix | Change |
|-----|--------|
| Comeet departments | Check `typeof job.department === 'string'` → wrap into `[job.department]` |
| Comeet description | Check for Comeet `details` array → concatenate `details[].value` |
| Workday title | Add `job.bulletFields?.[0]` to title fallback chain |
| Workday description | Accept that this is structurally absent; skip `runDescriptionCheck` for Workday |

### R3: Extract `seniorityLevel` and `jobFunctions` from LinkedIn Phase B

In `fetchJobDetails()`, add two lines to the return object:

```javascript
seniorityLevel: root.seniorityLevel || null,
jobFunctions: Array.isArray(root.jobFunctions) ? root.jobFunctions : null,
```

Then in `passesFilters()`, add a fast structured check before the keyword loop:

```javascript
if (job.seniorityLevel && !['Entry level', 'Not Applicable', 'Internship'].includes(job.seniorityLevel)) {
  return false; // Mid-Senior, Director, Executive, etc.
}
```

### R4: Use Comeet `?details=true` API Parameter

The current Comeet API call does not request structured details. Adding `?details=true` to the endpoint would provide named description sections (`"Description"`, `"Requirements"`, `"Nice to Have"`), which could be fed to `contentSeniorityPatterns` as structured input rather than the current approach of concatenating all HTML fields.

### R5: Build a Calibration Dashboard for Structured Fields

Before implementing R1-R4 in production, run a calibration pass that **logs** these structured fields alongside the current regex verdicts. This creates a truth table:

```
| jobId | regex_verdict | experience_level | managementLevel | seniorityLevel | agree? |
```

This data would quantify the false-positive rate of the current regex approach and validate that the structured fields are reliably populated across all companies.
