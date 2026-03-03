1. Overview and Objectives
A high-level summary of the product's vision and goals.
This document serves as the Master PRD for the Automated Calibration System. It defines the overarching architecture, standardized metrics, and operational triggers for monitoring all job aggregation workers.
From this Master PRD, specific sub-PRDs (e.g., WorkerCalibration_Comeet.md, WorkerCalibration_LinkedIn.md) will be derived to address the unique logic and API behaviors of each specific worker. The ultimate goal is a zero-touch, highly observable system that automatically validates its own precision and database health.

2. Target Audience & Problem Statement
Identification of the customer personas and the specific pain points.

Target Audience: Lead Architect / System Administrator.

Problem Statement: Currently, detecting silent failures (e.g., a worker dropping all jobs due to a faulty location regex) or database quota exhaustion relies on manual monitoring. We lack an automated "Command and Control" loop that tells us why jobs are failing or passing across different distinct sources, and we risk crashing the Cloud Run pipeline due to accumulated database bottlenecks.

3. Features and Functionality
A detailed list of what the product must do.

Inside-Out Metric Definition: The system defines the desired metrics first (what we need to know), and enforces the logging of these metrics during worker execution.

Dual-Trigger Mechanism:

Time-based: Executes every 7 days from the last successful calibration.

Volume-based (Quota Protection): Executes if the M0 MongoDB nears capacity (e.g., >350MB).

Automated Bottleneck Remediation (On Volume Trigger): If triggered by database volume, the system will not just report, but actively execute a cleanup protocol targeting known bottlenecks:

Hard-purging calibration_rejected records older than 7 days.

Verifying and dropping legacy zombie collections (run_logs, enriched_jobs) if resurrected by stale instances.

Compacting run_summaries.

Direct-Download Email Delivery: The final calibration report will be formatted as a Markdown (.md) file and attached directly to an alert email as a downloadable file (MIME attachment), allowing the administrator to easily save and file it locally.

4. User Experience (UX) Requirements
Descriptions of the intended user flow.

Zero-Touch Operation: The system runs implicitly within the ats/orchestrator.js lifecycle.

Frictionless Archiving: The administrator receives an email titled "🚨 System Alert: DB Volume Trigger" or "📊 Weekly Calibration Report". The email contains a brief summary in the body and a .md attachment. The user downloads the .md file with one click and saves it to their local machine/repository.

5. Technical Specifications (Inside-Out Design)
Details for the engineering team.

5.1 Step 1: What do we want to know? (The Metrics)
Before querying the DB, we define the exact questions we need answered per worker type:

Global Metrics (All Workers):

What is the total ratio of jobs fetched vs. jobs passed?

How many jobs were skipped cleanly via Silent Dedup (knownJobIds)?

Average run execution time.

ATS Workers (Comeet & Greenhouse):

How many jobs were dropped specifically by the Location Gate? (Ensuring we don't fetch irrelevant global jobs) .

How many jobs were dropped by the Structured Gate? (Seniority metadata).

How many jobs were dropped by the Semantic Gate (ATS Guard)? (Title Blacklist vs. Whitelist) .

Validation: For passed jobs, what was the matched Whitelist keyword that allowed it through?

Workday Worker (Specific Needs):

How many 403 (WAF block) responses were encountered?

Are dynamic location facets resolving correctly, or falling back to raw text search?

5.2 Step 2: Gap Analysis & Required DB Support
Based on the metrics above, we identify what the database currently supports and what functionality must be added:

Currently Supported: Silent Dedup stats are saved in run_summaries. Rejection reasons are saved in calibration_rejected.

GAP 1 (Passed Validation): Currently, calibration_passed only saves lightweight metadata. We must modify the passesFilters and evaluateStructuredGate functions to append a matchedReason or matchedKeywords field to the UnifiedJob object, which will be saved in calibration_passed.

GAP 2 (Workday Errors): 403 blocks are currently console-logged. We must add a worker_health or append HTTP error codes to run_summaries so the calibration script can track WAF blocks.

5.3 Step 3: Database Queries (Aggregation)
The calibration script will run aggregation pipelines (using $match, $group, $count) across calibration_rejected, calibration_passed, and run_summaries to extract the defined metrics.

6. Release Plan & Timeline
Phase 1: Update the Core Data Models (Address GAP 1 & GAP 2 to ensure data is actually saved).

Phase 2: Develop the aggregation queries and the Markdown generation script.

Phase 3: Implement the Dual-Trigger logic (Volume + Time) and Bottleneck Cleanup protocol.

Phase 4: Update EmailNotifier.js to support .md attachments.

Phase 5: Break down this Master PRD into specific Worker PRDs.

7. Metrics for Success
Proactive Mitigation: 100% of Volume-Based triggers successfully execute the cleanup protocol and prevent MongoDB quota exceeded errors.

Insight Generation: The generated .md report explicitly identifies which specific filter (e.g., Location vs. Blacklist) is responsible for the highest drop rate per worker.