# Sonar / Perplexity Research Prompt — 2026-09-06

**Purpose:** obtain external, citable evidence to discriminate between two competing explanations for a 73× collapse in LinkedIn job-discovery yield observed between April and May 2026.
**Companion document:** `docs/CAR/CAR_2026-09-06_backlog_analysis.md`
**Model:** Perplexity Sonar (Deep Research / Reasoning mode recommended — this needs source-grounded answers, not summarization)

---

## How to use

Paste everything between the `=== BEGIN ===` / `=== END ===` markers as a single prompt. It is deliberately self-contained: it restates the measurements so the model reasons against evidence rather than trusting our conclusions.

**Do not** paste the CAR report itself — it contains our thesis, and we want an independent read. The whole point is to avoid confirming ourselves.

---

=== BEGIN PROMPT ===

You are a research analyst investigating a job-scraping system's data-collection failure. I need **source-grounded, citable findings** — not speculation. Where you cannot find evidence, say so explicitly rather than inferring. Distinguish clearly between (a) official documentation, (b) credible developer reports, and (c) your own inference.

## Context: the system

A personal job-discovery bot for **entry-level software roles in Israel**, running since March 2026, unchanged in its LinkedIn code path since 2026-03-03.

It calls LinkedIn's **authenticated internal Voyager API** (not the public guest endpoint) with a single logged-in session:

- Endpoint: `GET https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards`
- `decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220` (pinned version string)
- `q=jobSearch`, `count=25`, `start` paginated over `[0, 25, 50, 75]`
- Query: `(origin:JOB_SEARCH_PAGE_JOB_FILTER, keywords:<boolean string>, locationUnion:(geoId:101620260), selectedFilters:(sortBy:List(DD), experience:List(1,2), timePostedRange:List(r604800)), spellCorrectionEnabled:true)`
- Headers include `x-restli-protocol-version: 2.0.0`, `accept: application/vnd.linkedin.normalized+json+2.1`
- Load: 17 distinct boolean queries, ~30 runs/day (raised from ~13/day in May 2026), roughly **500–1,000 requests/day** from one account
- Response parsing walks `data.elements[].jobCardUnion['*jobPostingCard']` and resolves those URNs against the `included[]` array

## Context: what was measured

Over 27 internal calibration reports (2026-03-07 → 2026-08-28), on a consistent 30-day rolling window:

| Metric | Mar 2026 | Apr 2026 | May–Aug 2026 |
|---|---|---|---|
| Job cards returned per query execution | 2.33 | 1.97 | 1.72 |
| **NEW (not-previously-seen) jobs per query execution** | **0.1604** | **0.0813** | **0.0022** |
| Absolute new jobs discovered per day | ~37 | ~18.5 | **~1.1** |
| Reposts detected per 1,000 executions | 35.9 | 20.5 | 0.36 |
| HTTP success rate | 100% | 100% | **100%** |
| HTTP errors / 429s / auth challenges | 0 | 0 | **0** |

Key additional observations:

1. **Card delivery stayed roughly flat (−26%) while the *new* fraction collapsed 73×.** From May onward, over 99.8% of returned cards were already seen. The result set behaves like a frozen inventory.
2. **Intermittent total blackouts.** In the 30-day window ending 2026-06-27, four distinct Backend queries (e.g. `(Junior OR Student OR Intern OR Graduate) AND (Backend OR "Backend Developer") AND (Python OR Django OR Flask OR FastAPI)`) returned **zero parsed job cards across ~900 consecutive executions**, then **fully recovered** in July. A Mobile query has been returning zero continuously since May.
3. **No error signal of any kind** — no 429, no 403, no redirect to auth challenge, no empty-body errors. Always HTTP 200.
4. **Correlated vendor signal:** the same system's *Workday* scraper began receiving **403 WAF blocks in May 2026 for the first time ever** (~206/week, steady since). Different vendor, same infrastructure and time window.
5. The decline **began around 2026-04-07 to 2026-04-12**, before the polling-frequency increase in May.

## The two hypotheses to discriminate

- **H1 — LinkedIn-side silent degradation.** LinkedIn changed something: response schema/decoration versioning, entry-level filter behaviour, anti-automation throttling that degrades result sets while still returning HTTP 200, or result-set caps for high-volume clients.
- **H2 — Genuine market contraction.** Entry-level/junior software hiring in Israel genuinely fell to ~1–2 new qualifying postings/day between April and August 2026, and the system is reporting reality correctly.

---

## Research questions

Answer each separately, with sources and dates. **Prioritize Q1–Q3.**

### Q1 — LinkedIn Voyager API changes (Feb–Sep 2026) ⭐ highest priority
- Any documented or community-reported changes to `voyagerJobsDashJobCards`, its `decorationId` versioning (specifically `JobSearchCardsCollection-220` — is it current, deprecated, or superseded?), or the `jobCardUnion` / `*jobPostingCard` response shape?
- Did LinkedIn introduce new job-card union types (promoted, dismissed, wrapper, "verified", AI-recommendation cards) that a parser expecting only `*jobPostingCard` would silently drop?
- Evidence from maintainers of open-source LinkedIn scrapers (`linkedin-api` by tomquirk, `staticwebdev`/`linkedin-jobs-scraper`, `JobFunnel`, `linkedin-api-client`, Apify/Bright Data LinkedIn actors). **Check their GitHub issues and commit history for Q2–Q3 2026 breakage reports.**
- Did LinkedIn change `timePostedRange` (`r604800`), `experience:List(1,2)`, or `sortBy:List(DD)` filter semantics in 2026?

### Q2 — Silent throttling / result-set degradation ⭐ highest priority
- Is LinkedIn documented (officially or by practitioners) to **degrade result sets while returning HTTP 200** — serving stale, truncated, or cached results to high-volume authenticated clients rather than returning 429?
- What request-rate thresholds are reported before Voyager degrades or soft-blocks? Is **500–1,000 requests/day from a single authenticated account** above or below reported thresholds?
- Is there a known **pagination cap** (e.g. results beyond `start=25/50/100` returning empty, or `paging.total` being capped/unreliable)?
- Are there reports of **query-specific, intermittent, multi-week zero-result blackouts that later self-recover** — matching observation #2?

### Q3 — Israeli entry-level tech job market, Apr–Aug 2026 ⭐ highest priority
This directly tests H2. I need **quantitative** data, not sentiment.
- Volume of junior/entry-level/student/intern **software** roles posted in Israel, monthly, Feb–Sep 2026, from any measurable source (LinkedIn Economic Graph, Israel Innovation Authority, CBS Israel, Start-Up Nation Central, IVC, TheMarker/Calcalist/Globes tech-employment coverage, Israeli job boards: AllJobs, Drushim, JobMaster, Ethosia).
- Was there a **step-change contraction between April and May 2026** specifically?
- Benchmark: **is ~1–2 new qualifying entry-level tech postings per day across all of Israel plausible?** Israel has ~400k tech workers; my system's boolean queries cover backend/frontend/fullstack/mobile/QA/DevOps/data/security. Estimate the realistic daily volume of *new* entry-level postings in that scope.
- Any Israel-specific disruption in this window (macro, security, funding, seasonal/holiday hiring freeze, reserve-duty effects)?

### Q4 — Anti-bot posture changes, Q2 2026
- Did **Cloudflare / Akamai / AWS WAF** ship changes in Apr–May 2026 that would newly block datacenter-IP scrapers? (My Workday scraper started getting 403s in May 2026 for the first time.)
- Did **Workday** specifically change its WAF/bot posture in 2026? Do LinkedIn and Workday share a detection vendor or reputation feed that could explain a simultaneous change?
- Is the system likely running from a **cloud IP range** (GCP Cloud Run) that got newly reputation-flagged in this window?

### Q5 — Detection & mitigation practice
- How do mature scrapers **detect silent degradation** (HTTP 200 with degraded content)? Canary queries, `paging.total` vs returned-count reconciliation, pre-parse vs post-parse counts, golden-set regression?
- What are current, legitimate alternatives for **entry-level Israeli tech jobs**: LinkedIn's official Job Posting/Talent APIs (access requirements, cost, feasibility for an individual), Google Jobs schema, Comeet/Greenhouse/Lever/SmartRecruiters public job boards, Israeli aggregators with APIs?
- For a *personal* job-search bot, what request cadence against LinkedIn is considered non-abusive and sustainable?

---

## Output format

1. **Verdict on H1 vs H2** — which does the external evidence support? State confidence (high/medium/low) and say plainly if the evidence is insufficient to decide.
2. **Evidence table** — finding · source · date · which hypothesis it supports · strength.
3. **Q1–Q5 answers** — concise, cited. Explicitly flag every question where you found *no* evidence.
4. **Falsifiers** — what evidence would overturn your verdict?
5. **Recommended actions**, split into: (a) diagnostic steps before any code change, (b) code/architecture changes, (c) cadence/infrastructure changes.
6. **Confidence caveats** — where you are inferring rather than citing.

## Constraints

- Prefer **primary sources**: official docs, GitHub issues/commits, maintainer statements, statistical agencies. Mark forum/Reddit/blog claims as lower-confidence.
- **Every quantitative claim needs a date and a source.** Prefer Feb 2026 – Sep 2026; note when the best available source is older.
- If evidence is thin or absent for a question, **say so explicitly** — a clear "no evidence found" is more useful to me than a plausible guess.
- Do not assume my system is broken *or* correct. Both are live possibilities; the measurements above are consistent with either until external evidence discriminates.

=== END PROMPT ===

---

## What each answer changes on our side

| Sonar verdict | Action |
|---|---|
| **H1 — schema/decoration drift** | Fix `normalizeResponse()` for new card union types; unpin/refresh `decorationId`. Highest-value outcome — restores the funnel. |
| **H1 — silent throttling** | Cut cadence to ~12 runs/day, add jitter, consider session rotation/residential egress. Cheap, fast. |
| **H2 — real market contraction** | System is correct; the matrix is too narrow. Broaden the 17 queries (drop the stack clause), reconsider `experience:List(1,2)`, shift weight to ATS sources. |
| **Inconclusive** | Ship §5.2 of the CAR (pre-parse vs post-parse counters) and re-measure over two weeks. This is the fallback and it settles the question internally within one cycle. |

**Independent of the outcome:** ship §5.1 (the `technicalTitleKeywords` FN fix). It recovers ~1,500 wrongly-rejected Intel/NVIDIA student software roles and is correct under every hypothesis.
