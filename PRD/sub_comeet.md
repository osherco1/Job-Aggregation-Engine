Sub-PRD: Comeet Worker Calibration & Optimization (v1.1)
1. Overview and Objectives
This document is a child PRD derived from the MasterPRD-AutomatedCalibration&WorkerValidationSystem.md. It defines the specific architectural refactoring required for the Comeet ATS Worker (ats/workers/comeetWorker.js).
The objective is to eliminate "data murder" (loss of rich API metadata), fix the pipeline disconnect that blinds the ATS Guard, and fully utilize Comeet's structured data (e.g., experience_level) to drastically improve filtering precision and automated calibration observability.

2. Target Audience & Problem Statement
Target Audience: Lead Architect / System Administrator.

Problem Statement: The current Comeet worker discards highly valuable structured fields (department, Remote, experience_level, time_updated) during normalization. Furthermore, it passes raw, unmapped data to ats_guard.js, which expects a different schema. Consequently, the Guard is "blind" to Comeet's departments and job descriptions, relying solely on title regex. Finally, when filtering does occur, the exact matched keywords are discarded, making calibration impossible. Empirical analysis of raw Comeet payloads has also revealed three additional data-integrity hazards: compound position UIDs that cause phantom duplicates, nullable location objects that crash the location gate, and inconsistent employment_type strings that bypass the Structured Gate's normalization logic.

3. Features and Functionality
Pipeline Handoff Correction: The worker must pass a fully normalized UnifiedJob (or properly mapped adapter object) to evaluateAtsGuard, ensuring the Guard can actually read the department and description fields.

Zero Data Loss (Schema Expansion): The _normalizeJob function must be refactored to explicitly extract and map department, Remote (Work Model), time_updated, and location_object.country into the final job object, rather than discarding them.

Compound UID Deduplication: The Comeet API can return compound position_uid values that encode multiple locations in a single string (e.g., `F8.D56-74.503`). The worker MUST split the UID by the `-` delimiter and use the first segment as the canonical base dedup ID (e.g., `comeet_F8.D56`). Without this, the same role posted to multiple locations generates distinct jobId values that bypass Silent Dedup and appear as separate listings downstream.

Defensive Location Fallback Chain: Both the `location` string field and the `location_object` can occasionally be `null` or incomplete in real Comeet payloads (observed in positions with empty country codes or missing city data). The worker must implement a safe, ordered fallback chain for location resolution:
  1. `location_object.country` (ISO 2-letter code — most reliable for geo-filtering)
  2. `location_object.name` (human-readable composite, e.g., "Tel Aviv, Israel")
  3. `location` (top-level flat string)
  4. `"Unknown"` (terminal fallback — the job must never crash or silently drop due to missing location)
The same chain must be applied in filterJob before the country === 'IL' check, so that a null location_object triggers a graceful rejection with reason `"Location: missing location data"` instead of an uncaught TypeError.

Employment Type Normalization: The Comeet API delivers inconsistent employment_type strings across companies (observed variants: `"Full-time"`, `"Full time"`, `"Full Time Employee"`, `"Shifts"`, `"Temporary"`). The worker must normalize these into a closed enum before they reach the Structured Gate or the UnifiedJob:
  - `"full-time"` (canonical form for all full-time variants)
  - `"part-time"`
  - `"shifts"`
  - `"temporary"`
  - `"contract"`
  - `"internship"`
  - `"unknown"` (fallback for null or unrecognized values)
This normalization function must be a standalone utility (e.g., normalizeEmploymentType) so it can be reused across other ATS workers that exhibit the same variance.

Structured Seniority Fast-Track: The worker must utilize the native experience_level (e.g., "Junior (1-2 years)") and the normalized employment_type (e.g., "shifts") as primary filtering signals, significantly reducing the reliance on fuzzy regex HTML scanning.

Granular Observability: The worker and the Guard must replace boolean checks (.some()) with retrieval checks (.find()) to return and persist the exact Whitelist keyword that passed a job, or the exact Blacklist pattern that rejected it.

4. User Experience (UX) Requirements
Zero-Touch Operation: Operates implicitly within the orchestrator lifecycle.

Calibration Accuracy: The administrator reviewing the weekly .md calibration report (defined in the Master PRD) will now see accurate drop rates for Comeet's Department and Semantic gates, instead of seeing 0% drop rates caused by the current "blindness" bug.

5. Technical Specifications (Inside-Out Design)
5.1 Step 1: What do we want to know? (The Metrics)
Exactly which Whitelist keyword (e.g., "qa engineer") allowed a Comeet job to pass?

Exactly which Blacklist regex pattern (e.g., /\bSenior\b/i) caused a Comeet job to fail?

What is the ratio of jobs passed via structured experience_level vs. text-based regex fallback?

How many jobs were deduplicated due to compound UID splitting (multi-location dedup count)?

How many jobs hit the location fallback chain at each tier (country → name → string → unknown)?

What is the distribution of raw employment_type values before normalization, and how many were corrected?

5.2 Step 2: Gap Analysis & Required DB Support
GAP 1 (Guard Blindness): ats_guard.extractJobFields looks for Greenhouse-style job.departments (array) and job.content. Comeet provides job.department (string) and custom HTML fields. We must build a Comeet-to-Guard adapter or update the UnifiedJob schema.

GAP 2 (Data Flattening): Fields mapped in comeetWorker.js L216-230 do not include department, Remote, or time_updated. The UnifiedJob schema must be updated to support these.

GAP 3 (Keyword Loss): Functions runTitleCheck and runDescriptionCheck return generic boolean/string results. They must be updated to return matchedKeywords and matchedBlacklists arrays.

GAP 4 (Compound UID Collisions): The current jobId construction (`comeet_${position_uid}`) treats compound UIDs (e.g., `F8.D56-74.503`) as atomic strings. When the same role is posted to multiple locations, each compound UID generates a distinct jobId, causing the same logical position to bypass Silent Dedup and appear N times in the output. The dedup key must be derived from the base segment only (split by `-`, take index 0).

GAP 5 (Nullable Location Object): filterJob (L243-263) accesses location_object.country without a null guard on location_object itself. If the API returns a position where location_object is null or location_object.country is an empty string (observed in raw samples: Rapyd `"Senior Reconciliation Analyst"` has `country: ""`), the worker either crashes or silently misclassifies. A defensive fallback chain must be inserted before any property access.

GAP 6 (Employment Type Variance): The Structured Gate (structuredGate.js L19) reads employment_type as-is. Variants like `"Full time"` vs. `"Full-time"` vs. `"Full Time Employee"` cause inconsistent matching against the STUDENT_RE regex and prevent reliable enum-based fast-tracking. A normalization layer must sit between raw extraction and Gate evaluation.

5.3 Step 3: Database Queries (Aggregation)
Will leverage the Master PRD's $group queries on calibration_rejected and calibration_passed matching source: "comeet", grouping specifically by the newly preserved matchedKeywords and failedChecks fields.

Additional aggregation dimensions for the new gaps:
- Group by `dedup.compoundSplit: true` to measure multi-location dedup impact.
- Group by `location.fallbackTier` to detect data-quality degradation in the Comeet API over time.
- Group by `employmentType.rawValue` vs. `employmentType.normalizedValue` to track normalization corrections.

6. Release Plan & Timeline
Phase 1 (Data Preservation & Integrity): Refactor comeetWorker.js (_normalizeJob and filterJob) to preserve department, Remote, time_updated, and exact position_uid bases. Implement compound UID splitting for dedup, the defensive location fallback chain, and the normalizeEmploymentType utility.

Phase 2 (Guard Integration Fix): Fix the handoff in comeetWorker.js (L837) to ensure the ATS Guard receives readable department and description data.

Phase 3 (Observability Upgrade): Update ats_guard.js to return exact matched arrays instead of booleans.

Phase 4 (Structured Fast-Track): Implement the logic to auto-pass or auto-fail based on experience_level and normalized employment_type before running regex.

7. Metrics for Success
Observability: 100% of Comeet jobs saved to calibration_passed and calibration_rejected contain the precise matchedKeywords or matchedBlacklistPatterns.

Gate Activation: The Department and Description gates in the weekly calibration report show active drop percentages for Comeet (proving the blindness bug is fixed).

Efficiency: A measurable reduction in false positives for junior roles due to the prioritization of the experience_level field over raw description regex.

Dedup Accuracy: Zero phantom duplicates from compound UIDs — verified by asserting that no two calibration_passed records share the same base position UID within a single run.

Location Resilience: Zero uncaught TypeErrors from null location_object access. The fallback tier distribution is logged and visible in the calibration report.

Type Consistency: 100% of employment_type values stored in calibration_passed and calibration_rejected use the canonical enum, regardless of raw API variance.
