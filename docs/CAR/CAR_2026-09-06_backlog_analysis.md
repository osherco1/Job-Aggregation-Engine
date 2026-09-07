# Calibration Aggregation Report (CAR) — 2026-09-06
## Backlog Analysis: 16 unaddressed calibration reports (2026-05-22 → 2026-08-28)

**Last calibration actually ingested:** `ceb0f5c` (2026-04-26) — *"apply CAR 26-04 calibration delta (Speechify guard, Comeet bypass, dictionaries)"*
**Backlog:** 16 reports, all untracked in git, spanning **2026-05-22 → 2026-08-28** (~14 weeks)
**Baseline used for trend:** the 11 previously-calibrated reports (2026-03-07 → 2026-04-26)

---

## 0. Methodology — and one correction that changes the numbers

### 0.1 Metrics inherited from the 26-04 CAR

The prior CAR examined five things. This report keeps all five and adds a sixth:

| # | Method | Kept? |
|---|--------|-------|
| 1 | Actionable code delta (tokens to add/remove) | ✅ §5 |
| 2 | Confirmed false positives (noise that passed) | ✅ §4.1 |
| 3 | Confirmed false negatives (gold that was lost) | ✅ §4.2 |
| 4 | Systemic drift & anomalies (gates >25% of rejections) | ✅ §3 |
| 5 | Ambiguous items for human review | ✅ §6 |
| 6 | **Longitudinal yield trend (new)** — required to answer "is LinkedIn underperforming?" | ➕ §2 |

### 0.2 The window correction (important)

A single calibration report mixes **three different time windows**. Comparing across them silently produces garbage. Verified in `services/calibration/calibrationReport.js`:

| Report section | Window | Source |
|---|---|---|
| `LinkedIn Search Efficiency` (queries, alreadySeen, blacklist, reposts, dead/top queries) | **30 days rolling** | `LINKEDIN_LOOKBACK_DAYS = 30` (line 17) |
| `Operational Health` | **7 days** | line 350 |
| `Global Metrics`, `Passed/Rejected by Source`, `by Gate`, exhaustive lists | **since last purge** (bounded by 60-day TTL or the 200 MB volume trigger) | `countDocuments()`, line 75-76 |

**Consequences that invalidate naive readings:**

1. `Passed by Source → linkedin` is **not** comparable to `Total Queries Run`. Any "LinkedIn passes per query" ratio mixes a since-purge numerator with a 30-day denominator. My first pass made this error; it is corrected throughout.
2. Consecutive reports (e.g. 05-29 and 05-30) **overlap by 29 of 30 days**. They are not independent samples. Trend claims are only made across multi-week gaps.
3. `Total Queries Run` rising 3,179 → 15,300 is **mostly the 30-day window filling up**, not a cadence explosion. The system starts 2026-03-03; the 03-07 report contains only ~4 days of data. Cadence is derived as `queries / 17 distinct queries / 30 days` instead.

### 0.3 Metric semantics verified in code (not assumed)

- **`raw`** = job cards **successfully parsed** by `normalizeResponse()`, not the HTTP payload size (`scraper.js:317`). A parse failure and an empty market are **indistinguishable** in this metric. This matters in §3.3.
- **"Avg N jobs/run"** = `newTotal / runsWithData` — **new** jobs per run, 30-day window. The cleanest cross-report metric available.
- **"Dead query"** = `rawTotal === 0` across the *entire* 30-day window (`calibrationReport.js:191`).
- **Matrix size = 17 distinct queries**, constant since March (`Total Queries Run / runs-per-query` is exactly 17 in every report).

---

## 1. Headline

> **Your ATS instinct is right, and your LinkedIn instinct is right — but LinkedIn's problem is not the one the reports appear to show.**
>
> LinkedIn is **still returning job cards at a near-constant rate** (2.33 → 1.72 cards per query-run, −26% over six months). What collapsed is the **new** fraction of those cards: **0.1604 → 0.0022 new jobs per query-run, a 73× collapse**. The worker is re-reading a frozen inventory ~1.7 items deep, and almost nothing enters it.
>
> In absolute terms LinkedIn discovery fell from **~37 new jobs/day → ~1.1 new jobs/day**, *while polling frequency was doubled*. The extra polling bought nothing.

---

## 2. Longitudinal trend (all columns 30-day-window consistent)

### 2.1 Era summary

| Metric (per query-run unless noted) | A: Mar 07–31 | B: Apr 07–26 *(last calibrated)* | C: May 22–Aug 28 *(backlog)* | C vs B |
|---|---|---|---|---|
| LinkedIn runs/day | 13.5 | 13.4 | **30.0** | **+124%** |
| raw cards / query-run | 2.33 | 1.97 | 1.72 | −13% |
| alreadySeen / query-run | 2.17 | 1.89 | 1.71 | −10% |
| **NEW / query-run** | **0.1604** | **0.0813** | **0.0022** | **−97%  (37×)** |
| blacklist per 1k query-runs | 96.2 | 51.7 | **2.1** | −96% |
| reposts per 1k query-runs | 35.9 | 20.5 | **0.36** | −98% |
| best query, new jobs/run | 0.10 | 0.07 | 0.04 | −43% |
| **absolute new jobs/day** | **~36.8** | **~18.5** | **~1.1** | **−94%** |

### 2.2 The divergence that defines the problem

```
raw cards/query-run    2.33 ──▁▁▁──> 1.97 ──▁▁▁──> 1.72     (essentially flat)
NEW  /query-run      0.1604 ──▼▼▼──> 0.0813 ──▼▼▼──> 0.0022  (73x collapse)
                                                    └── seen ≈ raw to 2 decimals
```

From May onward, `alreadySeen/query-run` (1.71) equals `raw/query-run` (1.72) **to two decimal places**. Over 99.8% of everything LinkedIn returns has already been seen.

### 2.3 Per-report detail (30-day-consistent columns only)

| Date | runs/day | raw/run | seen/run | best new/run | blk/1k | repost/1k | dead queries |
|---|---|---|---|---|---|---|---|
| 2026-03-07 | 6.2 | 2.31 | 2.18 | 0.11 | 73.9 | 34.3 | 0 |
| 2026-03-24 | 17.4 | 2.41 | 2.24 | 0.10 | 102.0 | 40.1 | 0 |
| 2026-03-31 | 20.0 | 2.44 | 2.27 | 0.10 | 104.7 | 38.1 | 0 |
| 2026-04-07 | 16.7 | 2.46 | 2.28 | 0.09 | 111.8 | 40.8 | 0 |
| 2026-04-12 | 15.5 | 2.26 | 2.12 | 0.08 | 86.5 | 34.3 | 0 |
| 2026-04-23 | 12.2 | 1.99 | 1.91 | 0.07 | 46.8 | 16.2 | 0 |
| **2026-04-26** | 12.5 | 1.68 | 1.64 | 0.06 | 21.7 | 11.0 | 1 |
| **2026-05-22** | **28.8** | 1.69 | 1.69 | 0.07 | **2.4** | **0.1** | 1 |
| 2026-06-09 | 30.1 | 1.77 | 1.77 | 0.07 | 2.3 | 0.6 | 2 |
| 2026-06-17 | 30.1 | 1.66 | 1.66 | 0.06 | 2.0 | 0.5 | **6** |
| 2026-06-27 | 30.0 | 1.59 | 1.59 | 0.03 | 2.2 | 0.5 | **6** |
| 2026-07-19 | 30.0 | 1.89 | 1.89 | 0.02 | 2.6 | 0.6 | 1 |
| 2026-08-11 | 30.0 | 1.59 | 1.59 | 0.01 | 1.7 | 0.2 | 1 |
| 2026-08-28 | 30.0 | 1.68 | 1.68 | 0.02 | 2.0 | 0.3 | 1 |

**The decline is a decay from mid-April, not a step change in May.** `blk/1k` falls 111.8 → 86.5 → 46.8 → 21.7 → 2.4 across April, *before* the May cadence change. Whatever started this began around **2026-04-07 to 2026-04-12**.

---

## 3. Systemic drift & anomalies

### 3.1 The LinkedIn code path did not change

`scraper.js` — the entire LinkedIn discovery pipeline — has **not been modified since 2026-03-03** (`5c9e7f3`). The only commit touching `linkedin_client.js` in the window (`cc26c75`, 2026-05-18) was cosmetic: Gmail→Telegram alerting, plus removal of debug artifact writing. No change to query construction, pagination, dedup, or parsing.

**A 73× yield collapse occurred with zero code change on the affected path.** The cause is therefore external (LinkedIn-side), environmental (cadence/infrastructure), or a market reality.

### 3.2 The ATS "collapse" in May is an accounting artifact — and is healthy

Within the same purge window, source composition flipped:

| Report | Workday | Greenhouse | Comeet | Interpretation |
|---|---|---|---|---|
| 2026-04-26 | 41,026 | 245,777 | 183,633 | GH+CMT = 91% of rejections |
| 2026-08-28 | 110,518 | 260 | 227 | Workday = 99.6% |

This is **not** a Greenhouse/Comeet failure. Commit `c6b7591` (2026-03-31) *"resolve ATS silent dedup quota leak by unifying knownJobIds with seen_jobs"* stopped re-processing the same jobs every run. The gigantic March/April Greenhouse/Comeet counts were the **same jobs re-rejected repeatedly**. Both still pass jobs today (GH 3–25, CMT 5–33 per window). `Operational Health → Jobs skipped (Silent Dedup) = 1,306,936` is that fix working.

**Critically, that commit touched only `ats/orchestrator.js` and the three ATS workers — not `scraper.js`.** So the LinkedIn decline **cannot** be explained as the same accounting correction. This is the single most important control in this analysis: it rules out the most attractive benign explanation.

Corollary: the `location` gate falling 45.6% → 0.4% and `title` rising 43.9% → 99.5% are downstream of the same dedup fix, not a filter regression.

### 3.3 Dead queries are intermittent — the strongest anomaly

| Window | Queries returning **zero** raw results for the entire 30 days |
|---|---|
| Mar 07 – Apr 23 | none |
| Apr 26 | Frontend (Angular/TS/JS) |
| May 22 – Jun 09 | Mobile; + Frontend |
| **Jun 17 – Jun 27** | **6 queries** — *all four Backend variants* (Python/Django, Java/Spring, Java/C#/.NET/Go, Node/Express) + Frontend + Mobile |
| Jul 19 – Aug 28 | Mobile only |

All four Backend queries returned **zero parsed cards across ~900 consecutive runs over 30 days**, then **recovered** in July. "Junior Backend Developer, Python, Israel, past week" returning literally nothing for a month and then resuming is not a market phenomenon.

Because `raw` is counted **post-parse** (§0.3), this signature is equally consistent with:
- LinkedIn returning nothing, **or**
- LinkedIn returning cards the parser silently fails to extract.

The system cannot currently tell these apart, and the debug capture that could (`debug_linkedin_response.json`) was **removed on 2026-05-18** in `cc26c75` — the same window the collapse consolidated.

### 3.4 Parser fragility (the mechanism that would make §3.3 invisible)

`normalizeResponse()` requires **all** of:
- `decorationId=…JobSearchCardsCollection-220` (a **pinned** internal version)
- `envelope.elements[]`
- `element.jobCardUnion`
- `union['*jobPostingCard']` resolving into `included[]`

Any element failing this chain is silently dropped (`return null`). A LinkedIn-side schema change — new card union key, a wrapper type, a promoted/dismissed card variant — yields **HTTP 200, zero errors, 100% "success rate", and near-zero parsed jobs**. This is precisely the observed signature: `Success Rate 100.0%`, `Total Errors 0`, `Total Quota Hits 0` in every single backlog report, while yield fell 73×.

### 3.5 Load profile (for the external research)

- 17 queries × 30 runs/day = **510 query-executions/day**
- Pagination `[0,25,50,75]`, short-circuited by `start >= paging.total`; at raw≈1.7 most queries stop after page 1–2 → **~500–1,000 Voyager requests/day**, sustained, single authenticated account
- Endpoint: `/voyager/api/voyagerJobsDashJobCards` (authenticated internal API, not the public guest endpoint)
- Filters: `geoId:101620260` (Israel), `experience:List(1,2)` (Internship + Entry), `timePostedRange:List(r604800)` (past 7 days), `sortBy:List(DD)`
- **`Workday WAF blocks (403)` appear for the first time in May and hold steady at ~206/week** — independent evidence that *some* anti-automation posture changed in this period, on a different vendor.

---

## 4. Filter quality (unchanged methodology from 26-04)

### 4.1 False positives — 1,144 passed rows classified

| Category | Count | Share |
|---|---|---|
| Ambiguous bare title | 615 | 53.8% |
| Clean entry signal | 402 | 35.1% |
| **FP — GTM/support/presales** | 60 | 5.2% |
| **FP — hardware/silicon** | 33 | 2.9% |
| **FP — seniority leak** | 20 | 1.7% |
| **FP — non-technical** | 14 | 1.2% |
| **Total FP (conservative, title-only)** | **127** | **11.1%** |

- `engineer` alone triggers **677 / 1,144 (59%)** of all passes — still the dominant loose token flagged in 26-04.
- **Speechify geo-clones: the 26-04 fix worked.** 74.9% of passes (03-07) → ~5% (era C), but it **recurs in bursts** (05-29: 17.3%, 07-31: 13.2%), so the guard is leaky rather than fixed. All 1,558 non-Israel geo passes across all reports are Speechify except 7.
- Surviving FP classes match 26-04 exactly: Solution/Application/Support Engineer (GTM), Thermal/PHY/RF/CAD/Full-Chip (silicon), `Delivery Engineer II/III`, `Software Engineer III`, `Architect`.

### 4.2 False negatives — a precise, high-value regression

**1,557 occurrences** of entry-level **software** roles rejected as `title_not_technical`:

| Occurrences | Title | Company |
|---|---|---|
| 592 | Software student for validation tools team | Intel |
| 516 | Data Science Student for AI Solutions Group | Intel |
| 390 | Security Software development student | Intel |
| 14 | Software Student, DOCA Verification | NVIDIA |
| 12 | AI and HPC Data Center Student | NVIDIA |
| 6 | Embedded Software Intern | Marvell |
| 6 | Automation Infrastructure Student | NVIDIA |
| 4 | Software Verification Student – SONiC | NVIDIA |
| 3 | Software SDK Student | NVIDIA |

**Root cause (confirmed in code, not inferred).** `config/vocabulary.js:87` `technicalTitleKeywords` is matched by plain substring (`ats_guard.js:133`). The list contains `'software engineer'` but **not bare `'software'`**, and `'data scientist'` but **not `'data science'`**:

- `"Software student for validation tools team"` → has `software`, but not `software engineer`/`engineer`/`developer` → **FAIL**
- `"Security Software development student"` → `development` does not contain `developer` → **FAIL**
- `"Data Science Student…"` → `data science` ≠ `data scientist` → **FAIL**

Three missing tokens account for **1,498 of 1,557** FN occurrences (96%). These are Intel/NVIDIA student software positions — the exact golden target.

**By gate:** `title_not_technical` 1,557 · `linkedin_title: Blacklist` 31 · `title_domain` 14.

---

## 5. Actionable delta

### 5.1 P0 — FN fix (pure win, no FP risk, recovers the target profile)

```javascript
// config/vocabulary.js — technicalTitleKeywords
+ 'software',            // "Software student…", "Software Verification Student"
+ 'software development',// "Security Software development student"
+ 'data science',        // "Data Science Student for AI Solutions Group"
+ 'programmer',
+ 'embedded',
```
`'software'` is safe here: `title_domain` and `title_senior` still run independently, so `Senior Software Architect` remains rejected on its own gates.

### 5.2 P0 — restore LinkedIn observability (blocks the whole diagnosis)

The decisive question of §3.3 cannot be answered from the current telemetry. Restore, behind a sampling flag, what `cc26c75` removed:

```javascript
// linkedin_client.js — sample ~1% of responses, or all responses for a dead query
// Record BEFORE parsing:
//   response.status, envelope.paging?.total,
//   Array.isArray(envelope.elements) ? envelope.elements.length : null,  // pre-parse count
//   jobs.length                                                          // post-parse count
```
**`elements.length > 0 && jobs.length === 0` is the single decisive signal** separating "LinkedIn returned nothing" from "our parser broke". Log it as a distinct counter (`parseDropped`) in `runStats`, and surface it in the calibration report next to Dead Queries.

### 5.3 P1 — FP tightening (carry-over from 26-04, still unapplied)

```javascript
const TITLE_DOMAIN_REJECT_EXTRA = [
  /\bthermal\s+engineer\b/i, /\bPHY\b/i, /\bRF\s+hardware\b/i,
  /\bfull[- ]chip\b/i, /\bCAD\s+engineer/i, /\blayout\b/i,
];
const TITLE_GTM_REJECT_EXTRA = [
  /\b(account|partner\s+value|associate)\s+solution\s+engineer\b/i,
  /\bapplication\s+engineer\b/i,      // Cadence/CEVA presales
  /\bsupport\s+engineer\b.*\btier\b/i,
  /\b(support|cloud|devops)\s+operations\s+engineer\b/i,
];
const TITLE_SENIORITY_REJECT_EXTRA = [
  /\bengineer\s+(II|III|IV)\b/i,      // "Delivery Engineer II", "Software Engineer III"
  /\bexperienced\b/i, /\barchitect\b/i,
];
```

### 5.4 P1 — cadence

Polling doubled (13.4 → 30 runs/day) and absolute discovery **fell** 18.5 → 1.1 jobs/day. On a `timePostedRange=r604800` (7-day) window, 30 runs/day re-reads the same week ~210 times. **Revert to ~12 runs/day** — it costs nothing in recall and halves the anti-automation exposure that §3.5 implicates. Do this *only after* 5.2 is deployed, so the change is measurable.

### 5.5 P2 — Speechify guard is leaky, not fixed

Bursts recur (05-29, 07-31). Make the geo-clone rule structural: reject when `company === 'Speechify'` **and** the title carries a city/country suffix, unless an entry signal is present.

---

## 6. The thesis, and what would falsify it

### Thesis
> Between **2026-04-07 and 2026-05-22**, the LinkedIn worker transitioned from *discovering* jobs to *re-reading a frozen ~1.7-item inventory*. Card delivery held roughly constant (−13%) while the **new** fraction collapsed **73×**. This happened with **zero changes to the LinkedIn code path**, and is **not** explained by the March 31 dedup fix (which touched only ATS workers). The system reports itself perfectly healthy throughout — 100% success, 0 errors, 0 quota hits — because its only health signal is *post-parse* card count, which cannot distinguish an empty market from a broken parser or a silently throttled response.

### Three surviving hypotheses, in priority order

**H1 — Silent LinkedIn-side degradation (throttling or schema drift).** Best explains: intermittent all-Backend death for 900 consecutive runs then recovery; 100% success with 0 errors; the pinned `JobSearchCardsCollection-220` decoration; the simultaneous first-ever Workday 403 WAF blocks. *Predicts:* `elements.length > 0 && jobs.length === 0`, or `paging.total` ≫ returned count.

**H2 — Genuine market flow (system is correct).** The 7-day window means there is no deep backlog; after cold start the only new items are true new postings. ~1–2 entry-level tech postings/day in Israel matching a narrow boolean is *not absurd*. Supported by raw/query-run staying flat — an API being throttled would more likely return **less**. *Predicts:* independent sources show a comparable Israeli junior-hiring contraction over Apr–Aug 2026.

**H3 — Cold-start exhaustion.** March discovery was inflated by an empty `seen_jobs`. Weakened but not eliminated: the 30-day lookback smears cold start until ~April 10, yet decline *continued* 19.7 → 9.0 → 1.5 **after** cold start left the window. Explains part of era A→B, not B→C.

**Explicitly ruled out:** dedup-accounting artifact (§3.2 — wrong code path); unbounded `seen_jobs` growth (90-day TTL, `MongoStorageAdapter.js:309`); code regression (`scraper.js` unchanged since 03-03).

### Decisive experiment (cheap, local, no deploy)
Run **one** of the dead Backend queries manually and record `elements.length` vs `jobs.length` vs `paging.total`.

| Observation | Verdict |
|---|---|
| `elements.length > 0`, `jobs.length == 0` | **H1 confirmed — parser/schema drift.** Fix `normalizeResponse`. |
| `elements.length == 0`, `paging.total == 0` | **H2/H3** — query genuinely empty; re-scope the matrix. |
| `elements.length == 0`, `paging.total > 0` | **H1 confirmed — throttling/truncation.** Reduce cadence, rotate session. |

This single measurement discriminates all three. Everything in §5.2 exists to make it permanent.

---

## 7. Ambiguous — requires human judgement

- **Is ~1.1 new LinkedIn jobs/day acceptable?** If H2 holds, the system is working and the matrix is simply too narrow for the market. That is a **scope** decision, not a bug fix.
- **17 queries is a very small matrix.** Every query is a 3-clause boolean AND (entry-signal AND role AND stack). The stack clause may be the limiter — `Junior AND Backend` without the language clause would test this.
- **`experience:List(1,2)`** depends on employer-supplied seniority metadata, which is sparsely populated. It may be silently excluding most genuinely junior postings.
- **615 ambiguous bare titles (53.8% of passes)** — `Software Developer @ KLA`, `QA Engineer @ SuperPlay` — cannot be adjudicated from titles alone; needs description-level seniority, which currently rejects only 0.0–0.2% of volume (the `description` gate is nearly inert in era C).
- **Whether to keep Data Science / BI in scope at all** — the 26-04 CAR flagged these as FP, yet `data science` is proposed as an FN fix in §5.1. These conflict; your call decides which.

---

## 8. Answer to the original question

> *"My Workday ATS is functioning relatively good, and LinkedIn's yield relative to its magnitude is low."*

**Confirmed, with a correction to the framing.**

- **ATS is genuinely healthy.** Its apparent May "collapse" is the dedup fix working; it now processes ~110k unique Workday rejections and yields ~38 passes/window against a real, high-volume corpus.
- **LinkedIn is not low-yield because its filters are too strict.** Its filters barely fire — blacklist rejects only ~2 per 1,000 query-runs. **LinkedIn is low-yield because almost nothing new reaches the filters at all.** The funnel is starved at the source, not clogged downstream.
- **The magnitude asymmetry you sensed is real and measurable:** LinkedIn spends ~510 query-executions/day to surface ~1.1 new jobs/day, and you doubled that spend in May for no gain.
- **Why you couldn't pinpoint it:** every health signal the system emits is green. Workday fails **loudly** (403s you can count); LinkedIn fails **silently** (HTTP 200, 100% success, 0 errors). You were reading the one dashboard that is structurally incapable of showing this failure.

**Next step:** the Sonar research (`sonar_research_prompt_2026-09-06.md`) tests **H1 vs H2** against public evidence. Hold code changes except §5.1 (FN fix — independently correct regardless of outcome) until it returns.

---

# §9. ROOT CAUSE — CONFIRMED EMPIRICALLY (2026-09-06)

**All hypotheses in §6 are now settled by direct measurement against the live API. The cause is the query matrix ("Boolean explosion"), not rate limiting, not parser drift, not the market.**

## 9.1 What was ruled OUT (measured, not argued)

| Hypothesis | Test | Result | Verdict |
|---|---|---|---|
| **Rate limiting / throttling** | 60+ live requests, deep pagination to `start=225` | HTTP 200 throughout, full 25 elements/page, 185–189 `included` objects, no 429/403, no latency growth | ❌ **REFUTED** |
| **Parser / schema drift (H1)** | `elements` vs `withUnion` vs `withRef` vs `resolved` | **Identical in every call** (25/25/25/25). Union key still `*jobPostingCard`. Element keys unchanged | ❌ **REFUTED** |
| **Auth / session degradation** | Live session vs production headers | Valid, returns real data instantly | ❌ **REFUTED** |
| **Market contraction (H2)** | Deep-paginated the entry-level Israel pool, past 7 days | **250–275 unique junior postings; 113 (45%) tech-relevant** | ❌ **REFUTED as primary cause** |

The Sonar research's H1/H2 framing was aimed at the wrong layer. The market is healthy and the client is healthy. **The queries are broken.**

## 9.2 What IS the cause

All 17 production queries, run live with production filters:

| | combined `paging.total` |
|---|---|
| **17 production queries** | **33** |
| Simplified equivalents | 2,679 (inflated — see 9.4) |
| **Queries returning literally 0** | **11 of 17** |

Per-query: `backend-py 0 · backend-java 0 · fullstack 0 · mobile 0 · devops 0 · clusterA 0 · clusterB 0 · clusterC 0 · qa 10 · ios 4 · android 4 · embedded 4 · sysadmin 4 · data-analyst 3 · data-scientist 2 · cyber 1 · clusterD 1`

## 9.3 The precise failure mechanism

LinkedIn's Voyager keyword parser **silently fails on complex boolean expressions**, returning `total: 0` with HTTP 200. Demonstrated by a monotonicity violation — *adding OR alternatives, which can only widen a search, drives results to zero*:

| Query | total |
|---|---|
| `Junior AND Backend` | 214 |
| `(Junior) AND (Backend)` | 214 |
| **`(Junior) AND (Backend OR "Backend Developer")`** | **0** |
| `(Junior OR Student) AND (Backend) AND (Python)` | 239 |
| `(...5 terms... OR Entry Level) AND (Backend) AND (Python)` | 245 |
| **`(...5 terms... OR "Entry Level") AND (Backend) AND (Python)`** | **11** |
| `(...11 terms...) AND (Backend OR "Backend Developer") AND (Python OR Django OR Flask OR FastAPI)` | **0** |

Two distinct failure modes:
1. **Quoted phrase inside an OR group** collapses the query — results drop to exactly what the quoted phrase returns alone (`"Entry Level"` = 11), discarding the rest of the expression.
2. **Multi-term OR groups on the right of an `AND`** zero the query outright.

`scraper.js:30` already documents this: *"COMPACT_LEVEL_PREFIX is a shorter variant used for specific queries that were hitting LinkedIn API complexity limits (Boolean explosion)."* **The workaround was applied to only 4 of 17 queries and was insufficient — 2 of those 4 still return 0.**

## 9.4 Why "just simplify the queries" is NOT the fix

Simplified queries return **near-identical result sets**. Across 5 supposedly-distinct repaired queries: **58% of job IDs appeared in more than one**, and the top results were the same companies in the same order. **LinkedIn largely ignores the role term and matches the entry clause**, returning the generic junior pool sorted by date.

So the 2,679 figure is heavily duplicated. Running 17 simplified queries yields ~17 copies of the same ~250-job pool, not 17 niches.

## 9.5 Why March looked healthy

The queries were **always** broken — `raw/query-run` was only 2.33 even in March. March's apparent productivity was **cold-start absorption**: the same tiny broken result set was entirely unseen when `seen_jobs` was empty. Once absorbed, discovery fell to the trickle the broken queries can sustain.

**This is the answer to "why am I not getting the numbers I used to get": you never had a working query matrix. You had a one-time backlog.**

## 9.6 Measured gap

| | jobs |
|---|---|
| Unique junior/entry postings, Israel, past 7 days | **250–275** |
| Tech-relevant among them | **113** |
| What the bot currently discovers | **~8/week (1.1/day)** |
| **Capture rate** | **~7%** |

## 9.7 Corrected fix

Replace the 17-query boolean matrix with **a small number of broad, simple queries, deeply paginated, filtered locally**. The local filtering stack (`ats_guard`, dictionaries) is already strong and is where niche targeting belongs.

```javascript
// scraper.js — replace SEARCH_QUERIES
const SEARCH_QUERIES = [
  "Junior OR Student OR Intern OR Graduate OR ג'וניור OR סטודנט OR בוגר",  // 250-275 pool
  'Software Engineer',        // 106 with entry filter
  'Developer',
];
const pageOffsets = [0,25,50,75,100,125,150,175,200,225];  // was [0,25,50,75]
```
Rules derived from measurement: **no quoted phrases**, **no OR groups to the right of an AND**, **max ~2 clauses**. Verify any new query returns non-zero *before* shipping it — a zero-result query is indistinguishable from a broken one in current telemetry.

This also removes the justification for 30 runs/day: 3 queries × 10 pages, twice daily, covers the full pool with ~60 requests/day instead of ~500–1,000.

## 9.8 Revised status of earlier sections

- §5.1 (FN token fix) — **still valid, ship it.**
- §5.2 (pre/post-parse counters) — **still valid**, but downgrade to P1; the parser is fine. Add a **`paging.total === 0` alarm** as P0 instead — that is the signal that was missing for six months.
- §5.4 (cadence cut) — **valid, and now strongly justified**: cadence was never the constraint.
- §6 H1/H2/H3 — **superseded by this section.**
