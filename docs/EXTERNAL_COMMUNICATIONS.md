# EXTERNAL_COMMUNICATIONS.md — How This System Talks to Its 4 Data Sources

> **Scope.** This document covers exactly the four **inbound job-data sources**: LinkedIn,
> Comeet, Greenhouse, Workday — how the system authenticates to each, what it sends on the
> wire, and how it paces/retries/recovers. It deliberately excludes MongoDB, Telegram, and
> Gmail SMTP: those are internal storage / outbound notification channels, not job sources.
>
> **Method.** Built by reading the current worker/client code directly (file:line citations
> throughout), not by summarizing `SYSTEM_REFERENCE.md` or `DATA_CONTRACTS.md`. Those two
> documents already contain per-source communication detail, but `SYSTEM_REFERENCE.md` flags
> its own §21–§26 as drifted, and this pass found **three concrete corrections** to both
> documents — listed in §8. Treat this file as current as of commit `9ce0a86`
> (2026-09-08, "replace broken boolean query matrix with full-listing harvest"). Re-verify
> against source before trusting it after future worker changes — the same freshness caveat
> `DATA_CONTRACTS.md` applies to itself.

---

## 1. At a glance

| Source | Protocol | Auth mechanism | Credential lives in | Session state | Custom headers/spoofing | Shared rate limiter | Retries | Silent dedup before fetch |
|---|---|---|---|---|---|---|---|---|
| **LinkedIn** | Voyager REST (search) + GraphQL (detail) | Cookie + CSRF header, 3 secrets | GCP Secret Manager → Cloud Run env vars | None — cookies passed on every call | Yes, own `axiosClient` | No (fixed jitter only) | None built-in (throws on failure) | Yes (`seenIds`) |
| **Comeet** | REST, token in query string | Per-company token | `companies` dataset (DB/config), not a secret manager entry | None | Yes, hardcoded Chrome spoof | **Yes** — 9–11s token bucket | 2, on 429/5xx | Yes (`knownJobIds`) |
| **Greenhouse** | REST, public | None | N/A (public board slug) | None | No | No | 1, on 429/5xx | Yes (`knownJobIds`) |
| **Workday** | REST, session cookies | Cookie jar negotiated fresh per run | N/A — no secret, just a public careers URL | Yes — `PLAY_SESSION` + Akamai `wday_vps_cookie`, per-run, per-company | Yes, hardcoded Chrome spoof | No (fixed jitter only) | **None** | **No** |

---

## 2. LinkedIn — Voyager API

Entry point: [`linkedin_client.js`](../linkedin_client.js), driven from [`scraper.js`](../scraper.js).

### 2.1 Transport

A dedicated axios instance (`axiosClient`, [linkedin_client.js:84-88](../linkedin_client.js#L84-L88)) is created with `maxRedirects: 0`. A global response interceptor ([linkedin_client.js:93-153](../linkedin_client.js#L93-L153)) treats **any** 302/303 from LinkedIn — success or error path — as a critical auth challenge: it throws `LinkedInAuthChallengeError` and fires a fire-and-forget Telegram admin alert via `TelegramAdminNotifier`. This is the strictest failure posture of the four sources; none of the ATS workers hard-stop the whole run on a single bad response.

### 2.2 Auth

Three secrets, validated and assembled by `getHeaders()` ([linkedin_client.js:30-72](../linkedin_client.js#L30-L72)):

| Env var | Header/cookie it becomes |
|---|---|
| `LINKEDIN_LI_AT` | `Cookie: li_at=...` |
| `LINKEDIN_JSESSIONID` | `Cookie: JSESSIONID="..."` |
| `LINKEDIN_CSRF_TOKEN` | `Csrf-Token: ...` header |

Before use, the client strips quotes/whitespace from `CSRF_TOKEN` and `JSESSIONID` and asserts they're equal ([linkedin_client.js:55-60](../linkedin_client.js#L55-L60)) — LinkedIn issues the same opaque value for both, so a mismatch means a bad copy-paste and is rejected immediately rather than sent (avoids tripping a security challenge). Missing vars throw synchronously ([linkedin_client.js:38-42](../linkedin_client.js#L38-L42)).

**Credential lifecycle:** these are not API keys — they're cookies lifted from a real, logged-in browser session. [`docs_voyager_auth.md`](docs_voyager_auth.md) documents the manual extraction procedure (DevTools → Network → copy `li_at`/`JSESSIONID`/csrf-token). In production they're bound as GCP Secret Manager secrets to Cloud Run env vars — but note the binding itself (`gcloud run jobs deploy ... --set-secrets=...` or equivalent) is **not checked into this repo**; it's an operational step done from Cloud Shell, so this document can't cite an exact command. There is no refresh automation: on 401/403/302 the operator manually re-extracts fresh values.

### 2.3 Endpoints & request shape

| Endpoint | Purpose |
|---|---|
| `GET /voyager/api/voyagerJobsDashJobCards` | Paginated search |
| `GET /voyager/api/graphql?queryId=voyagerJobsDashJobPostings...` | Per-job enrichment |

The search URL is **hand-built**, not passed through axios `params`, because Voyager's query-string parser rejects the parentheses/plus signs that `encodeURIComponent` produces by default — `(`/`)`/`+` are manually re-encoded to `%28`/`%29`/`%20` ([linkedin_client.js:321-324](../linkedin_client.js#L321-L324)). Fixed filters baked into every query: `geoId:101620260` (Israel), `experience:List(1,2)`, `timePostedRange:List(r604800)` (past week) ([linkedin_client.js:328-333](../linkedin_client.js#L328-L333)).

**Current query set is a single blank keyword** — `SEARCH_QUERIES = [' ']` ([scraper.js:96](../scraper.js#L96)) — meaning every run pulls LinkedIn's full unrestricted Israel/junior listing and filters client-side, rather than issuing multiple boolean keyword searches. This replaced a 16–17-query boolean matrix as of the commit this document is pinned to (2026-09-07 rewrite, see comment block at [scraper.js:78-95](../scraper.js#L78-L95)); the old matrix returned mostly zero-result queries because quoted phrases are matched *literally* by Voyager. **`DATA_CONTRACTS.md` §5.1 and `SYSTEM_REFERENCE.md` §24 still describe the old 16–17-query matrix — both are now stale on this specific point.** The old per-cluster query constants (`CLUSTER_QUERIES`, `DATA_SCIENTIST_QUERY`, [scraper.js:61-75](../scraper.js#L61-L75)) are still defined but no longer referenced anywhere — dead code left over from the rewrite.

Pagination is 7 fixed offsets, `[0, 100, 200, 300, 400, 500, 600]` ([scraper.js:239](../scraper.js#L239)), with `count=100` per page hardcoded in `fetchJobs()` ([linkedin_client.js:314](../linkedin_client.js#L314)). Note: the comment directly above the offsets array (*"multiples of 25 (Voyager standard page size)"*) is stale — the actual page size the code requests is 100, not 25.

### 2.4 Batching, jitter, cooldown

Queries are chunked into batches of 5 ([scraper.js:242-246](../scraper.js#L242-L246)) with a 2–3 minute cool-off between batches ([scraper.js:531-537](../scraper.js#L531-L537)) and 10–20s jitter between queries within a batch ([scraper.js:261](../scraper.js#L261)). **With only one query today, this machinery is inert** — one batch, one query, no cool-off ever fires. It's still wired for if/when the query matrix grows again. What actually throttles LinkedIn traffic right now:

- 3–7s between paginated search calls ([scraper.js:527](../scraper.js#L527))
- 3–6s between per-job GraphQL enrichment calls ([scraper.js:523](../scraper.js#L523))

Enrichment only happens for jobs that already pass the title blacklist/whitelist gate pre-enrichment ([scraper.js:377-389](../scraper.js#L377-L389)) — an explicit cost optimization, since a blank-keyword listing returns ~675 jobs/run and enriching every one would cost ~675 GraphQL calls.

### 2.5 Failure handling

| Condition | Behavior |
|---|---|
| Any 302/303 | Global interceptor throws `LinkedInAuthChallengeError` + Telegram CRITICAL alert, regardless of which call triggered it |
| 401 on search | Throws `CRITICAL_AUTH_FAIL`, stops the LinkedIn phase ([linkedin_client.js:378-385](../linkedin_client.js#L378-L385)) |
| 403 on search | Logged as an auth failure with a refresh prompt, error rethrown ([linkedin_client.js:387-398](../linkedin_client.js#L387-L398)) |
| 404 on job detail | Treated as expired/deleted — returns an empty-details object rather than throwing ([linkedin_client.js:552-561](../linkedin_client.js#L552-L561)) |
| 429 on job detail | Thrown to the caller; the only backoff is the fixed 3–6s inter-call spacing, no dedicated 429 handler |
| `paging.total === 0` | Logged as an explicit `ALERT` — this exact signature (HTTP 200, zero results) hid a 6-month LinkedIn outage previously, so it's now flagged loudly instead of silently passing ([scraper.js:292-302](../scraper.js#L292-L302)) |

---

## 3. Comeet

Entry point: [`ats/workers/comeetWorker.js`](../ats/workers/comeetWorker.js).

### 3.1 Endpoint & auth

```
GET https://www.comeet.co/careers-api/1.0/company/{uid}/positions?token={token}
```
([comeetWorker.js:533](../ats/workers/comeetWorker.js#L533))

`uid` and `token` are **per-company**, sourced from the company config (`companies` MongoDB collection / merged local config files) via `loadCompaniesConfig()` → `storageAdapter.loadCompanies()` ([ats/config/companiesConfig.js:15-21](../ats/config/companiesConfig.js#L15-L21)) — not from GCP Secret Manager or a single shared secret. Comeet auth is data, not config: adding a company means adding a token to the dataset, not to the deployment. Where each company's token was originally obtained is outside this codebase (presumably lifted from that company's own public Comeet-hosted careers page).

### 3.2 Transport & spoofing

Uses the shared `httpClient` ([ats/utils/httpClient.js](../ats/utils/httpClient.js)) with its own `https.Agent` (`keepAlive: true, maxSockets: 50`, [comeetWorker.js:385-390](../ats/workers/comeetWorker.js#L385-L390)) and a hardcoded Chrome-120 header block — `User-Agent`, `Referer`/`Origin: comeet.com`, `Sec-Fetch-*` — that is **not** overridable via env vars ([comeetWorker.js:393-402](../ats/workers/comeetWorker.js#L393-L402)).

### 3.3 Rate limiting

Two independent layers stack:
1. **Per-company jitter**: 3–6s random delay before every company fetch (`COMEET_DELAY_MIN_MS`/`MAX_MS`, [comeetWorker.js:15-16](../ats/workers/comeetWorker.js#L15-L16)).
2. **Process-wide token bucket**: a singleton `RateLimiter` enforces a hard 9–11s minimum interval between *any* two Comeet requests regardless of which company they're for (`createComeetRateLimiter()`, [ats/utils/rateLimiter.js:41-47](../ats/utils/rateLimiter.js#L41-L47)), applied inside `requestWithDelayWrapper` ([ats/utils/httpClientWrapper.js:200-209](../ats/utils/httpClientWrapper.js#L200-L209)). Comeet is the only one of the four sources with this second layer.

### 3.4 Retries & WAF handling

Up to 2 retries on 429/5xx, exponential backoff (15s → 30s → 60s → 120s cap, or the `Retry-After` header if present) via the shared `requestWithRetry()` ([ats/utils/httpClientWrapper.js:49-154](../ats/utils/httpClientWrapper.js#L49-L154)). A 403/406 (Cloudflare WAF) is treated differently — no retry, instead a one-time 2–5 minute cooldown before moving on ([comeetWorker.js:568-620](../ats/workers/comeetWorker.js#L568-L620)).

### 3.5 Correction: the documented batch pause doesn't run

`SYSTEM_REFERENCE.md` §11 documents `COMEET_BATCH_SIZE` / `COMEET_BATCH_PAUSE_*` env vars implying a pause every 12 companies. The parsing logic for this exists in [`ats/utils/comeetRunConfig.js`](../ats/utils/comeetRunConfig.js) — but that module is **never imported anywhere else in the codebase**. Companies are processed strictly sequentially in a plain `for` loop (`processBatch()`, [ats/orchestrator.js:135-180](../ats/orchestrator.js#L135-L180)) with no batch-level pause. Only the per-company delay and the token-bucket rate limiter (§3.3) actually throttle Comeet traffic today.

---

## 4. Greenhouse

Entry point: [`ats/workers/greenhouseWorker.js`](../ats/workers/greenhouseWorker.js).

### 4.1 Endpoint & auth

```
GET https://boards-api.greenhouse.io/v1/boards/{uid}/jobs?content=true
```
([greenhouseWorker.js:412](../ats/workers/greenhouseWorker.js#L412))

No authentication at all — it's a public board API. `uid` (the board slug) comes from the same company config as Comeet. `?content=true` returns full job descriptions inline, so there's no separate detail-fetch phase like LinkedIn's.

### 4.2 Transport, rate limiting, retries

Uses the same shared `httpClient` as Comeet, but with **no** custom headers or browser spoofing — the plainest of the four integrations. Throttling is a single layer: 6–12s random delay before each company (`GREENHOUSE_DELAY_MIN_MS`/`MAX_MS`, [greenhouseWorker.js:13-14](../ats/workers/greenhouseWorker.js#L13-L14)); there is no dedicated rate limiter/token bucket the way Comeet has one. Retries: 1, on 429/5xx, same shared `requestWithRetry()` helper.

### 4.3 Failure handling

Non-200 responses are logged and treated as an empty result with **no cooldown** — there's no WAF-specific branch here the way Comeet has 403/406 handling. This means a dead board slug (404) and a live-but-empty board (200 with `jobs: []`) both fail silently from the pipeline's perspective; the worker logs either case but the orchestrator doesn't currently distinguish "board gone" from "board just has no openings right now."

---

## 5. Workday

Entry point: [`ats/workers/workdayWorker.js`](../ats/workers/workdayWorker.js). This is the only source with a genuine session-negotiation handshake, and it's redone **from scratch every run** — one `WorkdayWorker` instance per company, nothing persisted between runs.

### 5.1 Session handshake

1. **`GET` the tenant's own public careers page** (`this.siteUrl`) — this seeds a `tough-cookie` jar (via `axios-cookiejar-support`'s `wrapper()`) with `PLAY_SESSION` and Akamai's `wday_vps_cookie` ([workdayWorker.js:223-276](../ats/workers/workdayWorker.js#L223-L276)).
2. **Fixed 2000ms sleep** to let Akamai's bot-detection sensors "settle" before the first real API call (`SESSION_INIT_DELAY_MS`, [workdayWorker.js:35](../ats/workers/workdayWorker.js#L35)).
3. **`POST` to `/wday/cxs/{tenant}/{site}/jobs`** — the cookie jar is attached automatically by the axios wrapper on every subsequent request for that company instance.

`tenant`/`instance`/`site` are regex-extracted from the plain careers URL configured per company ([`_parseWorkdayUrl()`](../ats/workers/workdayWorker.js#L200-L215)) — there is no separate API host to configure, every tenant is its own subdomain.

### 5.2 Auth model

Purely cookie-based session state — **no token, key, or secret of any kind**. This is structurally different from the other three sources: LinkedIn and Comeet both carry a static credential across runs; Workday's "credential" is a transient session negotiated fresh each time, indistinguishable from what a real browser would get.

### 5.3 Headers

Hardcoded Chrome-120 fingerprint — `User-Agent`, `Sec-Ch-Ua*`, `Sec-Fetch-*` (`BROWSER_HEADERS`, [workdayWorker.js:41-52](../ats/workers/workdayWorker.js#L41-L52)) — plus a per-instance `Origin`/`Referer` set to that tenant's own site. Not overridable via env vars, unlike LinkedIn's `LINKEDIN_USER_AGENT`/`LINKEDIN_ACCEPT_LANGUAGE`.

### 5.4 Server-side + client-side location filtering

`detectLocationFacet()` ([workdayWorker.js:284-371](../ats/workers/workdayWorker.js#L284-L371)) probes the tenant's facet tree for an Israel-matching value; when found, it's added as an `appliedFacets` filter on every page request. Independently, `searchText: "Israel"` is sent **unconditionally** on every request regardless of whether the facet was found — this is the primary filter, the facet is a bonus. This dual strategy exists because Workday caps `total` at 2000 (confirmed: some tenants report exactly 2000, meaning the true count is unknown and possibly truncated) — narrowing server-side is the only way to get under that cap.

### 5.5 Rate limiting & retries

5–6s randomized delay before **every** paginated request (`WORKDAY_DELAY_MIN_MS`/`MAX_MS`, [workdayWorker.js:31-32](../ats/workers/workdayWorker.js#L31-L32)) — the tightest jitter floor of the four sources, called out in the code's own comments as necessary because "Workday WAF (Akamai) is very sensitive to rapid requests." There are **no retries at all**: a single 403 or 5xx on any page aborts pagination for that company for the entire run, no cooldown, no backoff ([workdayWorker.js:565-586](../ats/workers/workdayWorker.js#L565-L586)).

### 5.6 No silent dedup

Unlike Comeet and Greenhouse, `WorkdayWorker.fetchAllJobs()` takes no `knownJobIds` argument ([workdayWorker.js:823-826](../ats/workers/workdayWorker.js#L823-L826) vs. Comeet/Greenhouse's `fetchAllJobs(company, knownJobIds)`) — every posting is refetched and reprocessed on every run. This is a known, intentional gap (documented in `SYSTEM_REFERENCE.md` §33), not an oversight this document is newly discovering.

---

## 6. Shared transport layer

| File | Role | Used by |
|---|---|---|
| [`ats/utils/httpClient.js`](../ats/utils/httpClient.js) | Bare axios factory, `maxRedirects: 0`; a 3xx only logs a warning here (contrast LinkedIn's hard interceptor) | Comeet, Greenhouse |
| [`ats/utils/httpClientWrapper.js`](../ats/utils/httpClientWrapper.js) | `requestWithRetry()` — the shared retry/backoff engine (429/5xx/timeout handling, exponential backoff with jitter) | Comeet, Greenhouse |
| [`ats/utils/rateLimiter.js`](../ats/utils/rateLimiter.js) | Token-bucket minimum-interval enforcement — only wired for Comeet (`getRateLimiter()` has a single `'comeet'` branch, [httpClientWrapper.js:16-24](../ats/utils/httpClientWrapper.js#L16-L24)) | Comeet only |

LinkedIn (`axiosClient` in `linkedin_client.js`) and Workday (the cookie-jar-wrapped client in `workdayWorker.js`) each maintain their **own** axios instance outside this shared layer — they don't go through `httpClient.js` or `httpClientWrapper.js` at all. So there are really three separate transport stacks in this codebase, not one: LinkedIn's, Workday's, and the shared one Comeet/Greenhouse use.

---

## 7. Credential inventory

| Credential | Source system | How it's obtained | How it's rotated | Where it's stored |
|---|---|---|---|---|
| `LINKEDIN_LI_AT`, `LINKEDIN_JSESSIONID`, `LINKEDIN_CSRF_TOKEN` | LinkedIn | Manually copied from an authenticated browser's DevTools (see [docs_voyager_auth.md](docs_voyager_auth.md)) | Manual, on-demand — triggered by a 401/403/302 in production | GCP Secret Manager → Cloud Run env vars (binding step not checked into this repo) |
| Comeet `{uid, token}` | Comeet | Per company; acquisition mechanism (how the token was first captured) is not part of this codebase | Not rotated by this system — static per company until the company config is manually updated | `companies` MongoDB collection / merged local config files, loaded via `storageAdapter.loadCompanies()` |
| Greenhouse `uid` | Greenhouse | Public board slug, no secret | N/A | Same company config as Comeet |
| Workday session cookies | Workday | Negotiated automatically, fresh, every run | N/A — nothing to rotate, it's ephemeral | In-memory `tough-cookie` jar, discarded when the `WorkdayWorker` instance is garbage-collected at end of run |

---

## 8. Corrections this document makes to existing docs

Found while reading source directly rather than trusting prior write-ups — flagging explicitly per the freshness caveat both `SYSTEM_REFERENCE.md` and `DATA_CONTRACTS.md` already carry:

1. **LinkedIn query matrix is gone.** `DATA_CONTRACTS.md` §5.1 ("17 queries, batched 5 at a time with 2–3 min cool-offs") and `SYSTEM_REFERENCE.md` §24 ("Search Query Matrix") both describe the pre-2026-09-07 boolean matrix. The live code (`scraper.js:96`) runs a single blank-keyword query; the batching/cool-off code around it is now dead weight for as long as that's true.
2. **Comeet batch-pause config is unwired.** `SYSTEM_REFERENCE.md` §11 lists `COMEET_BATCH_SIZE`/`COMEET_BATCH_PAUSE_*` as active configuration. `ats/utils/comeetRunConfig.js` implements the parsing but is imported nowhere — companies are processed one at a time with no batch pause.
3. **Stale page-size comment, not a bug.** `scraper.js:238`'s comment above the pagination offsets says "multiples of 25 (Voyager standard page size)"; the actual `count` sent to LinkedIn is 100 (`linkedin_client.js:314`). The offsets (`[0,100,...600]`) are already consistent with 100 — only the comment is wrong.

---

## Change Log

- **2026-09-08** — Initial version, built by direct source read against commit `9ce0a86`.
