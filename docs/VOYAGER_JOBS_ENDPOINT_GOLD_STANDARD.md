# Voyager Jobs Endpoint — Reverse-Engineered Gold Standard

**Endpoint:** `GET /voyager/api/voyagerJobsDashJobCards`
**Method:** black-box hypothesis→test→confirm loop, ~230 live authenticated probes, 2026-09-06/07
**Status:** all rules below are **measured**, not inferred. There is no official documentation for this API; the measurements *are* the specification.

---

## 0. Measurement validity

**Noise floor = 0.** The identical query repeated 5× returned `263, 263, 263, 263, 263`. Totals are deterministic within a session, so *every* difference reported below is signal, not variance. Zeros are also deterministic — the production backend query returned `0,0,0,0,0` on 5 consecutive runs.

This is what makes the rest trustworthy. It also means a `total` of 0 is a reproducible property of the query, never a transient glitch.

---

## 1. THE GOLD STANDARD

```javascript
// The whole entry-level Israel pool in 7 requests.
const BASE = 'https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards';
const DECO = 'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220';

function goldUrl(start) {
  const query =
    `(origin:JOB_SEARCH_PAGE_JOB_FILTER,` +
    `keywords:%20,` +                                  // single SPACE = unrestricted
    `locationUnion:(geoId:101620260),` +
    `selectedFilters:(sortBy:List(DD),experience:List(1,2),timePostedRange:List(r604800)),` +
    `spellCorrectionEnabled:true)`;
  return `${BASE}?decorationId=${DECO}&count=100&q=jobSearch&query=${query}&start=${start}`;
}

// start = 0,100,200,300,400,500,600  → 674 unique jobs, 7 requests
```

**Validated end-to-end:**

| | production today | gold standard |
|---|---|---|
| requests per run | 68 (17 queries × 4 pages × count 25) | **7** |
| unique jobs returned | **33** | **674** |
| tech-relevant | ~20 | **209** |
| tech & not-senior | — | **194** |

**20× more jobs for 9.7× fewer requests.**

The core principle: **this endpoint is a listing API, not a search API. Retrieve the pool, filter locally.** Your `ats_guard` and dictionaries are already strong and are the right place for niche targeting.

---

## 2. Confirmed rules

### 2.1 `keywords` is required, and a single space unlocks everything

| keywords | result |
|---|---|
| `` (empty) | **HTTP 400** |
| `%20` (single space) | **675** — unrestricted pool |
| `Junior OR Student OR …` (your prefix) | 243 |

A space satisfies the required-parameter check while imposing no term restriction. **This single change more than doubles reachable inventory** versus the junior clause, before any other fix.

### 2.2 Double quotes are matched LITERALLY — never send them

| query | total |
|---|---|
| `Backend` | 190 |
| `"Backend"` | **5** |
| `Python` | 291 |
| `"Python"` | **3** |
| `Developer` | 201 |
| `"Developer"` | **15** |
| `"Backend Developer"` | **0** |

Quoting a *single word* collapses it — so this is not phrase-matching semantics, it is the `"` character entering the search term. **Every one of your 17 production queries contains quoted phrases.**

Escaping variants (for completeness):

| form | total | verdict |
|---|---|---|
| `%22…%22` (production) | 0 | broken |
| `\"…\"` → `%5C%22` | 197 | works, but **not** phrase matching (197 > unquoted 73) |
| `'…'` single quotes | 163 | works, loose |
| `“…”` curly | 0 | broken |

Escaping does not buy phrase semantics. There is no working phrase-quote syntax. Use rule 2.3 instead.

### 2.3 Implicit space is the strictest operator — use it for phrases

| query | total | |
|---|---|---|
| `Backend` | 190 | |
| `Developer` | 204 | |
| `Backend Developer` | **75** | ← implicit space: strictest |
| `Backend AND Developer` | 175 | explicit AND is *looser* |
| `Backend OR Developer` | 208 | OR ≈ union |

**Counter-intuitive but consistent: the space is stronger than the word `AND`.** To express a phrase, write it bare — no quotes, no operator.

### 2.4 Operator support

| operator | behaviour |
|---|---|
| `OR` / `or` / `Or` | works, case-insensitive (259 / 261 / 259) |
| `AND` / `and` | works, case-insensitive, but weaker than a plain space |
| `,` | behaves as OR (259) |
| `\|` | **broken** — treated literally (17) |
| `NOT`, `-term` | no error, no measurable filtering |

### 2.5 Parenthesised boolean structure is largely IGNORED

| query | total |
|---|---|
| `(Junior OR Student) AND (Backend OR Frontend) AND (Python OR Java)` | 228 |
| …same **plus** `AND (Israel OR Tel Aviv)` | **229** |
| `(Junior)` | 233 |
| `((Junior OR Student) AND Backend)` | 237 |
| `Junior OR Student AND Backend` | 236 |

Adding an entire AND clause moved the result by 1. Complex boolean expressions collapse toward a generic ~230-result bag. **You cannot express niche targeting through this parameter.**

### 2.6 Some 3-clause shapes deterministically return 0

| query | total |
|---|---|
| `(J OR S) AND (Backend) AND (Python OR Java OR React OR Node OR Linux)` | 208 |
| `(J OR S) AND (Backend) AND (Django OR Flask)` | 210 |
| `(J OR S) AND (Backend) AND (Django OR Flask OR FastAPI)` | **0** |
| `Django OR Flask OR FastAPI` *(standalone)* | 172 |

Not term count (5 common terms fine), not rarity (standalone fine), not position (all three positions → 0). A specific interaction of ≥3 AND-clauses with certain OR-groups trips a failure that returns HTTP 200 + `total: 0`. **This is unpredictable — which is the strongest argument for abandoning boolean queries entirely rather than trying to write "safe" ones.**

### 2.7 `keywords` barely discriminates — the decisive finding

Page-1 results for `FastAPI`:

> Lung Cancer Specialist · Shipping Coordinator · Biz Ops Coordinator · B2C Sales · Research Assistant · Researcher – Biochemistry

Pairwise Jaccard overlap of returned job IDs:

| | FastAPI | Django | Python | Junior |
|---|---|---|---|---|
| **FastAPI** | — | 79% | 79% | 79% |
| **Django** | 79% | — | 79% | 61% |
| **Python** | 79% | 79% | — | 61% |

`title-contains-keyword` was **0/25** for FastAPI, Django, Python and QA.

Tested and **refuted**: that `sortBy:DD` was discarding relevance ranking. With `sortBy:List(R)`, FastAPI still returns *Field Engineer, Researcher – Biochemistry, Mechanical Engineer* (0/25 title hits). Relevance sorting does not restore precision.

Narrow multi-word phrases are the exception — `Cyber Security` → 5 results, all genuine Penetration Testers. But `Backend Developer` and `Mobile Developer` both return ~80 with **92% mutual overlap**, i.e. both collapse to matching "Developer".

**Conclusion: keyword-based niche partitioning does not work on this endpoint.**

### 2.8 Pagination and `count`

- **`count=100` works** and returns 100 elements. You are using `count=25` — 4× the requests for the same data.
- **Ceiling ≈ 700**: `start=600` returns 74 elements; `start=700` returns 0.
- `paging.total` is stable across pages and trustworthy.

### 2.9 Filter economics (keywords=`%20`, Israel)

| filters | total |
|---|---|
| `experience:1,2` + past week | **675** |
| no experience filter + past week | **4,379** |
| `experience:1,2` + past month | 1,807 |
| `experience:1,2,3` + past week | 1,125 |
| `experience:2` (entry only) | 630 |
| `experience:1` (internship only) | 45 |
| no filters at all | 14,347 |

`experience:List(1,2)` discards ~85% of the past-week pool. Since the ceiling is ~700, dropping it puts 4,379 jobs behind a 700-item window — so **keep it** unless you shard by time (see 3.2).

---

## 3. Recommended implementation

### 3.1 Replace the query matrix

```javascript
// scraper.js — delete LEVEL_PREFIX, COMPACT_LEVEL_PREFIX, NICHES,
// CLUSTER_QUERIES, DATA_SCIENTIST_QUERY, SEARCH_QUERIES.
const SEARCH_QUERIES = [' '];                                  // single space
const pageOffsets = [0,100,200,300,400,500,600];               // count=100
```
…and set `count = 100` in `linkedin_client.js:314`. Everything else stays; local filtering already does the real work.

### 3.2 If you want more than 675/week

The ~700 ceiling is per query+filter combination, so **shard by time** rather than by keyword:

```javascript
// 7 daily windows instead of 1 weekly window — each well under the ceiling
timePostedRange:List(r86400)   // run daily; past-24h = 146 jobs
```
Daily harvest at `r86400` = ~146 jobs × 7 = ~1,022/week with zero ceiling risk, versus 675 capped. Sharding by `experience` (`1` vs `2`) is a second axis if needed.

### 3.3 Guardrails

- **Alarm on `paging.total === 0`.** Six months of silent failure happened because nothing watched this. It is the single highest-value telemetry change.
- **Canary check before shipping any query change** — a query that returns 0 is indistinguishable from a broken one without this.
- Cadence: 7 requests × 2 runs/day = **14 requests/day**, versus ~2,040 today. The rate-limit question becomes moot.

### 3.4 Query-construction rules (if you ever hand-write one again)

1. Never send `"` — it is matched literally.
2. Use a bare space between words for phrases; do not use `AND`.
3. Never exceed 2 AND-clauses; 3+ can silently return 0.
4. `|` is broken; `,` means OR.
5. Always verify a new query returns non-zero before shipping it.

---

## 4. What this revises

- **"It's the quotes"** — correct, but incomplete. Quotes are one of three independent defects; boolean structure being ignored (2.5) and keywords not discriminating (2.7) matter more.
- **"No OR-groups to the right of an AND"** — **wrong**, retracted. `(Junior OR Student) AND (Backend OR Frontend)` = 225. Corrected in 2.5/2.6.
- **"Simplify the 17 queries"** — **wrong approach**, retracted. 17 simplified queries return 17 copies of the same pool (58% ID overlap). The answer is one listing call, not better keywords.
- **`sortBy` hypothesis** — raised and refuted in 2.7.
- **Market contraction (H2)** — 674 unique entry-level jobs live this week, 194 tech & non-senior. The market is not the constraint.
