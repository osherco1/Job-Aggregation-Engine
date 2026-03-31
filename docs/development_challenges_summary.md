# Development Challenges Summary (ETL Pipeline Construction)

## Scope
This document summarizes core **development-time** engineering challenges encountered while building the LinkedIn + ATS ETL system, based on snapshot files under `docs/snapshots`.

Focus areas:
- Pipeline construction hurdles (ingestion, parsing, normalization, dedup, enrichment, persistence)
- Architectural pivots made during development
- Technical complexity suitable for data-engineering interview discussion

---

## 1) API Reverse Engineering and Contract Discovery

### Challenge
The team had to integrate data sources with unstable or poorly documented contracts:
- LinkedIn Voyager search requests were sensitive to exact query encoding and nesting
- Comeet required tokenized API usage and endpoint archaeology
- Workday CXS behavior differed across tenants and facet discovery was unreliable

### Why it was hard
- Browser-visible behavior and direct HTTP behavior diverged
- Minor URL/encoding mistakes produced hard failures (400/404/301/403/406)
- Source-specific anti-bot/WAF constraints shaped request strategy

### Development pivot
- Treated API contract discovery as a first-class engineering task
- Built source-specific retrieval strategies instead of forcing one generic fetch layer
- Used controlled fallback logic (e.g., Workday searchText filtering when facets failed)

### Outcome
The ETL shifted from fragile endpoint assumptions to resilient, source-aware ingestion logic.

---

## 2) Parsing Pointer-Based and Unstructured Payloads into a Unified Schema

### Challenge
Raw payloads were heterogeneous:
- LinkedIn used `elements` + `included` pointer-style objects
- ATS systems returned different field shapes and naming conventions
- Some important fields existed only in optional or nested structures

### Why it was hard
- A single logical job could be split across multiple references
- URN linking could fail or drift
- Missing/misaligned fields created silent data-quality risks

### Development pivot
- Introduced normalization rules per source and a shared canonical model
- Added pointer resolution maps with fallback matching for LinkedIn entities
- Enforced schema/shape validation in ingestion and discovery workflows

### Outcome
The pipeline moved from source-specific brittle parsing to normalized, analyzable records.

---

## 3) Deduplication, Idempotency, and Stable Identifier Design

### Challenge
Duplicate notifications and inconsistent state emerged during development due to:
- Unstable identifiers (notably Workday fallback IDs)
- Persistence failures under storage pressure
- Runtime state leakage (warm container/module buffer effects)

### Why it was hard
- Dedup depended on both deterministic IDs and successful state writes
- Logging/calibration data growth indirectly broke core correctness paths
- Multiple storage collections had overlapping concerns and legacy write paths

### Development pivot
- Reworked ID generation toward deterministic extraction
- Added fail-fast persistence behavior for sent-history paths
- Introduced cleaner separation of dedup state vs calibration logging
- Added TTL-based retention and silent pre-filter dedup controls

### Outcome
Idempotency became explicit and testable, reducing duplicate sends and replay noise.

---

## 4) Anti-Bot Controls, Session Safety, and Request Pacing

### Challenge
ETL throughput had to be balanced against anti-bot systems and auth/session fragility.

### Why it was hard
- Redirect behavior and aggressive retries could look automated
- Large query matrices and deep pagination increased request pressure
- Enrichment stages added extra API calls and coupling

### Development pivot
- Introduced jitter and staged pacing across query/pagination/enrichment calls
- Treated certain redirect patterns as auth challenges, not normal retries
- Added cooldown/backoff patterns and safer control flow

### Outcome
The ingestion layer became slower-but-safer, with fewer hard lockouts/challenges.

---

## 5) Search Matrix Design and Precision/Recall Trade-Offs

### Challenge
Large boolean query sets produced dead searches and false positives (role mismatch noise).

### Why it was hard
- Broad terms improved recall but hurt precision
- Narrow terms improved precision but reduced coverage
- Query quality varied by source behavior and index semantics

### Development pivot
- Replaced weak mega-queries with targeted query clusters
- Expanded blacklist/whitelist logic from observed false positives
- Added log analysis around dead queries and top performers

### Outcome
Search quality became an iterative data product rather than static keyword lists.

---

## 6) ATS Guarding: Filtering Beyond Titles

### Challenge
Title-only filters missed “hidden seniority” embedded in descriptions and HTML-rich fields.

### Why it was hard
- Many postings used vague/junior-looking titles with senior requirements in body text
- HTML entities/tags degraded regex effectiveness

### Development pivot
- Implemented layered filtering (cheap checks first, expensive checks later)
- Added HTML decode + tag stripping before experience-pattern checks
- Externalized guard vocabulary/config for maintainability

### Outcome
Filtering became semantically stronger and less vulnerable to title-only blind spots.

---

## 7) Storage and Cloud-Ready Architecture Refactor

### Challenge
Early architecture mixed local filesystem assumptions with runtime control flow that did not fit cloud execution.

### Why it was hard
- Direct filesystem coupling reduced portability
- Singleton/global state increased warm-container risk
- Hard exits (`process.exit`-style flow) reduced orchestration safety

### Development pivot
- Added storage abstraction layers (file vs Mongo-backed implementations)
- Shifted to factory-created services and clearer dependency boundaries
- Improved error pathways to allow graceful orchestration behavior

### Outcome
The ETL became more deployable and maintainable across local and cloud environments.

---

## 8) Company Discovery Pipeline: LLM Outputs + Deterministic Validation

### Challenge
Discovery for new companies/ATS endpoints combined probabilistic model outputs with strict ingestion requirements.

### Why it was hard
- LLM outputs were not reliably structured end-to-end
- Hallucinated slugs/tokens broke downstream fetchers
- URL mutations could return non-obvious server errors

### Development pivot
- Moved to staged generation + parsing flow with stronger schema controls
- Added deterministic URL/identifier extractors and source-specific validators
- Used DB dedup and validation gates before committing discovery results

### Outcome
Discovery evolved from prompt-dependent extraction to validator-gated ETL inputs.

---

## 9) Architectural Pivots That Changed System Direction

- **Hub-and-spoke ATS architecture:** separated LinkedIn and ATS outputs/logs to reduce cross-contamination.
- **Config as ETL contract:** recognized that bad company config (`type`, `uid`, slug/token) can mimic parser bugs; added explicit validation discipline.
- **Observability redesign:** reduced heavy raw payload retention and introduced bounded calibration persistence (TTL + scoped collections).
- **Source-specialized workers:** accepted per-ATS differences instead of over-generalizing too early.

---

## 10) Interview-Ready Top 3 Development Challenges

1. **Dedup + Idempotency under real storage constraints**  
   Building stable identifiers and reliable persistence was critical; oversized logs and unstable IDs produced duplicate notifications until state handling was redesigned.

2. **Reverse engineering multi-source APIs under anti-bot constraints**  
   The team had to discover true contracts (Voyager/Comeet/Workday), then engineer source-aware pacing/retry/session behavior to keep ingestion both valid and safe.

3. **Normalizing heterogeneous raw payloads into a canonical schema**  
   Pointer-heavy JSON, nested unstructured fields, and ATS schema drift required robust resolution, parsing, and validation before records were dependable for filtering and notification.

---

## Snapshot Coverage
This summary was synthesized from all markdown snapshots under `docs/snapshots` (23 files), including:
- System handover snapshots (`2025-12` through `2026-02`)
- Workday and project architecture snapshots
- March 2026 incident/fix snapshots (dedup, Mongo, discovery pipeline, and orchestration hardening)

