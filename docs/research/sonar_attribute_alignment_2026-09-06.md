# Sonar / Perplexity Research Prompt — External Attribute Alignment, Description Extraction & Blind-Spot Discovery

**Generated:** 2026-09-06
**Companion document:** `docs/DATA_CONTRACTS.md` (measured attribute inventories)
**Model:** Perplexity Sonar — **Deep Research / Reasoning mode**. This needs source-grounded answers against vendor documentation and maintainer repositories, not summarisation.

---

## How to use

Paste everything between `=== BEGIN ===` and `=== END ===` as a single prompt.

The prompt gives Sonar three distinct mandates, in ascending order of value to us:

1. **Falsify** — we hand over our measured inventories and ask it to find where they are wrong.
2. **Extend** — for the things we *do* know about, find the parts we only half-understand: allowed value sets, configurability, versioning, stability guarantees, edge-case behaviour.
3. **Reveal** — find the capability classes we never thought to ask about at all.

The third mandate is the important one, and it is the reason the prompt opens by disclosing our epistemic position rather than hiding it. **Every single thing this system knows about these four platforms was reverse-engineered from HTTP responses and code reading. We have never consulted an official API reference for any of them.** A prompt that only asks "is my field list correct?" can only ever return answers shaped by the questions we already knew to ask — which is precisely the failure mode that produced the fabricated attribute tables we just spent a day correcting.

Do **not** paste `DATA_CONTRACTS.md` itself — the prompt restates the measurements it needs. Feeding the full document invites agreement rather than audit.

---

=== BEGIN PROMPT ===

You are a technical research analyst auditing the **data-acquisition layer** of a job-aggregation ETL pipeline. I need **source-grounded, citable findings** about four external job platforms.

## Your three mandates

**1. FALSIFY.** I will hand you my measured attribute inventories. Actively try to break them. If a field I list as absent is in fact available under some condition — a query parameter, a different endpoint, a tenant setting, a newer API version, a different auth level — that is a high-value finding.

**2. EXTEND.** For everything I *do* know about, tell me what I only half-understand. I know a field's name and one sample value; I almost never know its allowed value set, whether it is vendor-controlled or employer-configurable, whether it is stable across edits and repostings, what it means when null, or which API version introduced it. Fill that in.

**3. REVEAL — this is the most valuable thing you can do for me.** Tell me about capability classes I did not ask about. See the section "My epistemic position" below: my knowledge of these platforms is *entirely* reverse-engineered from observed HTTP traffic. I am certain there are whole categories of capability I am blind to, and I cannot ask about them by name because I do not know they exist. Treat every question below as a floor, not a ceiling. **If the best finding in your research is an answer to a question I did not ask, lead with it.**

## Ground rules

- Distinguish explicitly between **(a)** official vendor documentation, **(b)** credible practitioner evidence (maintained open-source clients, GitHub issues, maintainer statements), and **(c)** your own inference.
- **Where you find no evidence, say "no evidence found."** A clear negative is more useful to me than a plausible guess. I have already been burned once by an internal document that inferred field names from code and invented half of them.
- Every field you claim exists must come with a source and, where possible, a date.
- Where a platform's behaviour is **tenant- or employer-configurable**, say so rather than presenting one tenant's shape as the platform's contract. That distinction is the entire reason for this research.

## My epistemic position — please read this before answering

Everything below under "What I have measured" was obtained by:

- capturing raw HTTP responses from 15 tenants per platform on a single day (2026-03-01),
- reading my own client code,
- and two live probes on 2026-09-06.

**I have never read an official API reference for any of these four platforms.** I do not know whether one exists for some of them. This means my mental model is biased in specific, predictable ways, and I would like you to correct for each:

| Bias | What I am probably blind to |
|---|---|
| I only know endpoints I happened to discover | Other endpoints on the same API — search, single-item, taxonomy/reference-data, company/board metadata, bulk export |
| I only know the response shape my sample produced | Fields that appear only for other employer configurations, other plan tiers, other job types, other locales |
| I only know pull | Push: webhooks, change feeds, incremental/delta sync, `If-Modified-Since` / ETag support, RSS or XML job feeds, Google-Jobs indexing feeds |
| I only know the internal/unofficial route | Official partner, affiliate, or public APIs — including paid ones — that would give me the same data supported and documented |
| I know no versioning story | API versions, deprecations, sunset dates, whether the endpoints I depend on are stable or incidental |
| I know no error semantics | What each status code officially means, documented rate limits, quota headers, retry guidance |
| I only know four platforms | Aggregators, public-sector data sources, or standards-based feeds that would cover the same Israeli market with less fragility |

Please tell me what falls into each of those rows for each platform, **even where I have not asked a specific question about it.**

## The system

A personal job-discovery pipeline for **entry-level / junior / student software roles in Israel**. It ingests from four sources, normalises to a common job record, applies a filter stack (location gate → structured-level gate → title gate → department gate → description gate), deduplicates, and pushes matches to Telegram. Node.js on Google Cloud Run, MongoDB Atlas. Single user, personal use.

The filter stack's quality is bounded by attribute availability. Two structural problems drive this research:

1. **Description coverage is uneven and, in two of four sources, absent or near-absent.** The description gate — which scans for years-of-experience requirements ("5+ years") and leadership language — is the only gate that can catch a senior role wearing a junior-looking title. It currently runs on roughly one source out of four.
2. **Seniority and department classification is done with regex over freeform title strings**, when several platforms appear to publish their own structured classification of the same job.

## What I have measured (falsify and extend this)

Corpus: Comeet 358 positions / 15 companies; Greenhouse 624 jobs / 13 boards; Workday 300 postings / 15 tenants (all captured 2026-03-01); LinkedIn 279 full GraphQL job-detail responses (~2026-02); plus live probes on 2026-09-06.

### Comeet — `GET https://www.comeet.co/careers-api/1.0/company/{uid}/positions?token={token}`

- Returns a bare JSON array. 100%-present fields: `position_uid`, `name`, `department` (a **string**, not an array), `location`, `location_object{name,country,city,state,postal_code,street_name,arrival_instructions,street_number,timezone,location_uid}`, `employment_type`, `experience_level`, `Remote`, `careers_page_url`, `careers_page_active_url`, `careers_page_detected_url`, `position_url`, `time_updated`, `company_name`, `email_name`, `picture_url`, `is_discreet`, `position_company_number`, `req_company_number`.
- **There is no `description` field on this endpoint.** Description content arrives as arbitrary, company-authored keys containing HTML — `Responsibilities`, `Advantages`, `Benefits`, `Work Environment`, `About Us`, `Podcast`, `Statement`, `How You'll Spend Your Time`, and dozens more. **49% of positions carry no HTML-bearing key at all**, so half my Comeet corpus has no description whatsoever.
- Adding `?details=true` to the list endpoint produced a **byte-identical key set** when probed on 2026-09-06.
- The per-row `position_url` (`.../positions/{position_uid}?token=...`) **does** return `description` and `requirements` as first-class fields, plus `position_slug`, `is_internal`, `questionnaires`, `email_alias`, and several referral-reward fields.
- `experience_level` is **free text, not an enum**: 26 distinct values across 15 companies, 40% null, including `Senior`, `Intermediate`, `Experienced (3-5 Years)`, `Advanced (5-8 Years)`, `Expert (8+ Years)`, `Mid/Senior`, `Mid- Senior`, `Associate`, `Junior (1-2 years)`, `Entry-level`, `L2`, `L3/L4`, `Team Lead`, `Manager`.
- I never observed `categories` or `details` arrays, which older third-party write-ups describe.

### Greenhouse — `GET https://boards-api.greenhouse.io/v1/boards/{uid}/jobs?content=true`

- Returns `{jobs, meta}`. 100%-present per job: `id`, `internal_job_id`, `title`, `content` (double-HTML-encoded; median 6 648 chars), `location{name}`, `offices[{id,name,location,parent_id,child_ids}]`, `departments[{id,name,parent_id,child_ids}]`, `absolute_url`, `first_published`, `updated_at`, `requisition_id`, `language`, `company_name`, `metadata[]`, `data_compliance[]`.
- One field appeared on only 5 jobs across 3 boards: `education`, value `"education_required"`.
- `metadata[]` is present as an array on 100% of jobs but is **populated on only one of thirteen boards**. Where populated, the names are: `Job Level`, `Career Site Main Categories`, `Full-Time or Part-Time`, `Employee Class`, `Equity Grant?`, `Benefit Eligibility`, `Compensation Planner`, `Sourcing System`, `Reason for opening`, `Job Name`, `Hiring Range`, `Bonus`. `Job Level` values are bare integers (`"7"`, `"6"`) or integer-plus-label strings (`"7 - Account Manager, Software Engineer, Individual Contributors (ICs)"`).
- No pagination — the whole board comes back in one response.

### Workday — `POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`

- Body `{appliedFacets, limit, offset, searchText}`. Response `{total, jobPostings[], facets[], userAuthenticated}`.
- **Each `jobPostings[]` row contains exactly five fields on all 15 tenants:** `title`, `externalPath`, `locationsText`, `postedOn` (relative text — `"Posted 2 Days Ago"`, never a date), `bulletFields` (containing **only** the requisition number, e.g. `["JR2013520"]`).
- Two optional extras: `timeType` on 3/15 tenants, `remoteType` on 4/15.
- **Absent from every row on every tenant:** `jobCategory`, `managementLevel`, `jobFamilyGroup`, `requisitionType`, `workerType`, `isRemote`, `subtitleText`, `jobSchedule`, `jobRequisition`, `primaryLocation`, `postingLocation`, `additionalLocations`, `id`, `jobRequisitionId`, `postingDate`. **There is no description on the listing endpoint.**
- `total` saturates at exactly **2000** on large tenants.
- The `facets[]` array exposes facet *parameters* whose values are absent from the rows — on NVIDIA: `jobFamilyGroup`, `workerSubType`, `timeType`, `locationMainGroup`.
- The per-job detail endpoint `GET {cxs_base}{externalPath}` returned **200** with a `jobPostingInfo` object containing `jobDescription`, `timeType`, `startDate` (a real ISO date), `jobReqId`, `country{descriptor,id}`, `jobRequisitionLocation{descriptor,country{alpha2Code}}`, `posted`, `canApply`, `externalUrl`, `jobPostingId`, `jobPostingSiteId`, `questionnaireId`, `includeResumeParsing`. An expired job path returned **403**.

### LinkedIn — `voyagerJobsDashJobPostings` GraphQL, `data.jobsDashJobPostingsById`

- **38 fields, all present on 100% of 279 captured responses.**
- Notable and currently unused: `standardizedTitle{name}` (populated on 82% — values like `Software Engineer`, `Full Stack Engineer`, `Data Analyst`, `Student`, `Help Desk Specialist`); `jobFunctions` (populated on 91%, as **enum codes**: `ENG`, `IT`, `QA`, `SALE`, `BD`, `MGMT`, `MNFC`, `HR`, `MRKT`, `EDU`, `TRNG`, `DSGN`, `ART`, `OTHR`, often multi-valued); `industryV2Taxonomy[{name}]`; `expireAt`; `closedAt`; `jobState`; `location` (a full Geo object); `createdAt`; `contractorJob`.
- **`seniorityLevel` does not appear in this response at all** — 0 of 279 — despite third-party write-ups treating it as a headline field.
- `workplaceTypes`, `workRemoteAllowed`, `skillsDescription`, and `posterId` are present as keys but **`null` on 279/279**.
- `companyApplyUrl` / `trackingPixelUrl` frequently reveal the underlying ATS: of 279 jobs, 14 pointed at myworkdayjobs.com, 11 at comeet.com, 9 at greenhouse.io, 3 at lever.co, 142 were Easy Apply with no external URL.

---

## Research questions

Q0 is the blind-spot sweep and matters most. Q1 and Q2 are the concrete pain. Treat all of them as a floor.

### Q0 — The complete surface, and what I never thought to ask ⭐⭐ highest priority

For **each** of Comeet, Greenhouse, Workday, and LinkedIn:

- **Does an official, public API reference exist**, and where? Give me the canonical URL. If the endpoint I am using is undocumented but a documented equivalent exists, say so plainly — I would rather migrate to a supported surface than keep reverse-engineering one.
- **Enumerate the full endpoint surface** of the relevant API, not just the endpoints I mentioned. What else is there — single-item, search, taxonomy/reference data, board or company metadata, departments/offices listings, bulk export, application submission?
- **Is there a push or delta mechanism?** Webhooks, change feeds, incremental sync, `If-Modified-Since` / `ETag` / conditional-request support, RSS or XML job feeds, Google-for-Jobs indexing feeds, sitemap-based discovery. I currently poll everything on every run and diff client-side; if any of these exist I am doing this the hard way.
- **Is there an official or partner API — including a paid one — that supplies this same data supported and documented?** What are the access requirements and realistic cost for an individual rather than a company? I would consider paying for stability on at least one source.
- **What is the versioning and deprecation story?** Is the endpoint I depend on versioned, stable, deprecated, or incidental? Any announced sunsets? For LinkedIn Voyager specifically: is the pinned `decorationId` / `queryId` pattern known to rotate, and how do maintained clients handle that?
- **What are the documented error semantics and rate limits** — status-code meanings, quota headers, `Retry-After` behaviour, official guidance on cadence?
- **Free-form:** name up to five things about this platform's data surface that a well-informed engineer would know and that someone who only reverse-engineered the traffic would very likely miss. This question is deliberately open. Please actually answer it rather than restating the above.

### Q1 — Job description extraction, per platform ⭐ highest priority

For each of Comeet, Greenhouse, Workday, and LinkedIn:

- **What is the officially documented way to obtain a full job description**, and does it require a second request per job? Cite the vendor's own reference where one exists.
- Are there **query parameters, headers, API versions, or endpoint variants** that return descriptions in bulk rather than per job? (For Comeet specifically: is there any documented parameter that makes the *list* endpoint return `description`/`requirements`? I could not make `?details=true` do anything.)
- **Comeet:** is the per-position endpoint (`/positions/{position_uid}?token=`) officially documented, is its response schema published, and are `description` / `requirements` **guaranteed** fields or company-configurable like the list endpoint's content keys? Is there a documented reason ~half of positions carry no content on the list endpoint — a company setting, a plan tier, the `is_discreet` flag?
- **Workday:** is the CXS per-job detail endpoint documented anywhere, officially or by practitioners? Is `jobPostingInfo.jobDescription` stable across tenants? Are there **rate-limit or WAF thresholds reported specifically for the detail endpoint** versus the listing endpoint? I saw a 403 on one expired path and 200 on a fresh one — is 403 the documented response for an expired posting, or a block?
- **Is `schema.org/JobPosting` JSON-LD present on the public careers pages** of each of these four platforms? Google for Jobs indexing effectively requires it, so a JSON-LD `description` may be a **universal, vendor-neutral description fallback** working identically across all four — and extending free to platforms I do not yet support. Confirm per platform, with example page structures, and note whether the JSON-LD is server-rendered or client-injected (the latter would make it unusable without a headless browser). Also: what *other* schema.org properties do these platforms populate — `experienceRequirements`, `educationRequirements`, `employmentType`, `validThrough`, `baseSalary`, `occupationalCategory`? Several of those would feed my filter stack directly.
- What do maintained open-source scrapers do for descriptions on each platform? Check actual code and recent issues in: `tomquirk/linkedin-api`, the `JobSpy` forks (`speedyapply`, `Bunsly`, `cullenwatson`), Workday CXS clients, Greenhouse Job Board / Harvest client libraries, and Apify / Bright Data actors for LinkedIn, Workday, and Greenhouse.

### Q2 — Fields I may be missing, and fields I only half-understand ⭐ highest priority

- **Greenhouse:** what is the complete documented field list for `GET /v1/boards/{board}/jobs?content=true` and for the single-job endpoint `GET /v1/boards/{board}/jobs/{id}`? Does the single-job endpoint return anything the list endpoint does not? What exactly is `metadata[]` — how is it configured by the employer, what `value_type`s exist, is there any *standard* key or is it entirely custom, and is it exposed on the public board API only when the employer opts in? Is `education` documented? Is the newer `job-boards.greenhouse.io` host a different API surface from `boards-api.greenhouse.io`, and is either deprecated? Does the board API expose **departments and offices as their own endpoints** with a fuller hierarchy than the per-job embed?
- **Workday:** given that `facets[]` exposes `jobFamilyGroup`, `workerSubType`, and `timeType` as facet *parameters*, **how do I enumerate their allowed values and value IDs**, and can I pass them in `appliedFacets` to filter server-side? Is the `total: 2000` ceiling a documented cap, and is faceting the accepted workaround? Do any tenants expose a `jobFamily`, `jobProfile`, or seniority facet? Is the facet set itself tenant-configurable, and is there an endpoint that returns the full facet tree rather than the trimmed version that comes back with a `limit:1` query?
- **LinkedIn:** is there a **published or reverse-engineered code list** for `jobFunctions` (`ENG`, `IT`, `QA`, `SALE`, `BD`, `MGMT`, `MNFC`, `HR`, `MRKT`, `EDU`, `TRNG`, `DSGN`, `ART`, `OTHR`)? What is `standardizedTitle` — drawn from a published title taxonomy, and is the full taxonomy retrievable? Does `seniorityLevel` (or an equivalent experience-level field) exist under a **different `queryId`, decoration, or endpoint**? Under what conditions do `workplaceTypes` / `workRemoteAllowed` become non-null — are they populated only for certain posting types or only via a different decoration? Is `industryV2Taxonomy` mappable to LinkedIn's published industry code list?
- **Comeet:** what is the official Careers API field reference? Do `categories` and `details` arrays exist, and under what conditions? Is `experience_level` drawn from a fixed vocabulary in the Comeet product UI, or is it a free-text employer field (my data strongly suggests the latter — confirm or refute)? Same for `employment_type` and `Remote`. Is the careers-API token per-company, rotatable, or scoped in ways I should know about?

### Q3 — Deduplication and cross-source identity

12% of the LinkedIn jobs I capture resolve, via `companyApplyUrl` or `trackingPixelUrl`, to an ATS I already scrape directly — so I ingest the same posting twice under two unrelated IDs.

- What are the established techniques for **cross-source job deduplication**? Specifically: parsing ATS identifiers out of apply URLs, canonical requisition IDs, and content-based methods (title+company+location normalisation, MinHash/SimHash on descriptions, embedding similarity). What precision do practitioners report?
- Are Greenhouse `internal_job_id`, Greenhouse `requisition_id`, Workday `jobReqId`, and Comeet `position_uid` **stable across repostings and edits**, or do they rotate? This determines whether they can serve as dedup keys. This is exactly the kind of stability guarantee I cannot learn by observation.
- Is there a documented URL grammar for extracting board/tenant and job ID from apply URLs on Greenhouse, Lever, Workday, Comeet, SmartRecruiters, Workable, and Ashby?

### Q4 — Platforms adjacent to my current four

My LinkedIn corpus surfaced Lever-hosted jobs, and Israeli tech employers use platforms I do not ingest.

- For **Lever, SmartRecruiters, Workable, Ashby, Rippling, and Recruitee**: does each have a **public, unauthenticated job-board API**? Give the endpoint pattern, whether the **description is in the list response or requires a per-job call**, what structured seniority/employment/department fields are exposed, and any documented rate limits or terms-of-use constraints for reading public postings.
- Which are **most used by Israeli tech employers**, as far as you can determine?
- **Beyond ATS platforms:** are there aggregators, standards-based feeds, or Israeli-market job sources with public APIs or structured feeds (AllJobs, Drushim, JobMaster, Ethosia, government employment-service data, university career portals) that would cover this market with less fragility than scraping four vendor APIs? I have not investigated this at all.

### Q5 — Attribute quality practice for junior-role filtering

- Current practical techniques for **inferring seniority from a description** when no structured level field exists — years-of-experience regex, requirement-section parsing, classifier/LLM approaches. Reported error rates, and known failure modes (e.g. "3+ years preferred" in a nice-to-have block, or a years figure inside a company-description paragraph).
- Is there value in mapping raw titles to a **standard occupational taxonomy** — ESCO, O\*NET-SOC, ISCO-08? Free APIs or downloadable datasets? Do any handle **Hebrew-language job titles**?
- Comeet descriptions arrive as unlabelled, company-named HTML sections. What are the accepted techniques for **segmenting a description into responsibilities / requirements / benefits / company boilerplate**, so a seniority scan runs only over requirements? Open-source implementations?
- How do practitioners handle **bilingual (Hebrew/English) postings** in an ETL filter stack?

### Q6 — Access legitimacy and sustainability

Single-user personal job-search tool. I want it on the right side of both terms of service and good citizenship.

- What do **Comeet, Greenhouse, Workday, and LinkedIn** say in their terms about programmatic reading of *public* job postings? Where are the public board APIs explicitly intended for third-party consumption?
- What cadence is acceptable for each? Current volumes: Comeet ~45 companies × 1 request; Greenhouse ~15 boards × 1 request; Workday ~15 tenants × several paginated requests; LinkedIn several hundred authenticated requests/day. **Adding per-job description fetches would multiply ATS request counts by roughly the surviving jobs per company** — does that cross a threshold anywhere, and what mitigations are standard (conditional requests, caching by `updated_at`, fetching descriptions only for jobs that survive earlier gates)?

### Q7 — What would you build differently?

Given everything you found: if you were building this pipeline **with full documentation access from day one**, what would you do differently from what I have described? Name the architectural choices I made *because* I was reverse-engineering — and which of them a documented approach would render unnecessary. Be specific and concrete; I am asking for a design critique grounded in what you found, not general best practice.

---

## Output format

**Lead with section 1.** If the strongest thing you found is an answer to a question I did not ask, it belongs at the top of the response, not buried in an appendix.

1. **Extension & revelation findings** — things I did not know to ask about, ranked by *how much they would change the design*. For each: what it is, source, and what it would let me stop doing. Explicitly flag anything that would let me **replace a reverse-engineered path with a documented one**, or **replace polling with push/delta**.
2. **Per-platform attribute table** — for each platform: `field · endpoint that returns it · documented or observed · vendor-controlled or employer-configurable · stable across edits? · source · is it already in my inventory`. Put **fields I did not list** at the top of each table.
3. **Description-acquisition matrix** — per platform: best available method, cost in requests per job, reliability, cited source. Include the JSON-LD / schema.org route as a row, marked available or not per platform.
4. **Direct falsification list** — every claim in "What I have measured" you found evidence against, with sources. Where you found evidence *supporting* my measurements, say so briefly; do not pad.
5. **Q0–Q7 answers**, concise and cited.
6. **Ranked recommendations** — highest ETL-quality gain per unit of implementation and request cost, with the evidence class behind each.
7. **Explicit gaps** — every question where you found no evidence. Do not fill these with inference.

## Constraints

- Prefer **primary sources**: vendor API references and developer portals, GitHub repositories and issue threads, maintainer statements. Mark forum, Reddit, and blog claims as lower confidence.
- Prefer sources from **2025–2026**; note explicitly when the best available source is older, since these are all evolving internal or semi-public APIs.
- Do not assume my measurements are right. They come from a 15-tenant sample captured on a single day in March 2026, plus two live probes. **They are a lower bound on what exists, not an upper bound** — treat every "absent" claim as "absent from my sample," and tell me when it is present elsewhere.

=== END PROMPT ===

---

## What each class of answer changes on our side

### Revelation-class (Q0) — would change the architecture

| Finding | Action |
|---|---|
| A documented official/partner API supplies the same data | Migrate off the reverse-engineered path. Removes an entire class of silent-breakage risk. |
| Webhooks, change feeds, or conditional requests exist | Stop polling-and-diffing. Cuts request volume, makes per-job description fetches affordable, and removes the freshness guesswork. |
| Server-rendered `schema.org/JobPosting` JSON-LD across platforms | One vendor-neutral description extractor replaces four per-platform ones — and extends free to Lever/Workable/Ashby. `experienceRequirements` / `validThrough` would feed the filter stack directly. |
| Israeli-market aggregator or standards-based feed exists | Potentially a better-conditioned source than four vendor APIs. We have never looked. |
| Our endpoints are deprecated or the decoration/queryId rotates | Pin-and-monitor becomes a maintenance requirement, not an optional hardening. |

### Falsification / extension-class (Q1–Q2) — would change the ETL

| Finding | Action |
|---|---|
| Comeet per-position endpoint is documented and `description`/`requirements` are guaranteed | Add a post-location-gate detail fetch. Closes the 49% description blind spot and feeds `contentSeniorityPatterns` the requirements text it was written for. **Highest expected value of the known options.** |
| Comeet list endpoint has a bulk-description parameter after all | Strictly better — one request instead of N. |
| Workday detail endpoint is safe at our volume | Add detail fetch for survivors. Gives our largest corpus its first description signal, plus `country.alpha2Code` and a real `startDate`. |
| Workday detail trips WAF at scale | Fall back to JSON-LD on the public job page, or fetch only for title-gate survivors. |
| `jobFunctions` code list is published | Replace ~40 non-technical blacklist keywords with a set-membership test on a structured field. |
| `standardizedTitle` is a retrievable taxonomy | Replace freeform-title substring matching for LinkedIn with vendor classification. |
| Workday facet values are enumerable | Filter `workerSubType` / `jobFamilyGroup` server-side — fewer requests *and* an escape from the 2 000-row cap. |
| ATS IDs are stable across repostings | Build cross-source dedup on requisition IDs; kill the 12% duplicate ingestion. |
| Any field turns out employer-configurable rather than vendor-controlled | Stop treating it as a reliable gate input; demote to a hint. This applies to Greenhouse `metadata` and probably Comeet `experience_level`. |

**Independent of what comes back:** the two vocabulary defects in `DATA_CONTRACTS.md` §2.3 — `Experienced (3-5 Years)` / `Advanced (5-8 Years)` / `Expert (8+ Years)` / `Manager` / `Lead` going unrecognised, and `juniorPass` holding `'entry level'` where the data says `'Entry-level'` — are measured against our own corpus and correct to fix regardless.
