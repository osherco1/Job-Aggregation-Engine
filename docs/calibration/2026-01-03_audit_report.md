# QA Audit & Calibration Report
**Date:** January 3, 2026
**Version:** 5.0 (Optimization Sprint)
**Analyst:** Lead Architect (AI & User)

## 1. Trigger & Findings
Analysis of the logs (Scope: 33 runs, 528 queries) revealed two major issues:
* **High False Positive Rate (Hardware Leak):** The system was accepting "Engineer" roles that are not Software (e.g., Mechanical, Electrical, Chip Design). This is common in the Israeli market (Elbit, Rafael, Intel).
* **Dead Queries (100% Failure):** Three specific boolean queries consistently returned 0 results due to high complexity (LinkedIn Complexity Limit).
    * *Failed Pattern:* `(Long Junior String) AND (List of 5+ Backends) AND (List of 5+ Languages)`.

## 2. Actions Taken
### A. Logic Hardening (Filters)
* **Blacklist Expansion:** Added aggressive hardware/operational keywords to block non-SW roles.
    * *Keywords Added:* "Mechanical", "Mechatronics", "Electrical", "VLSI", "ASIC", "Hardware", "Legal", "Attorney", "Help Desk".
* **Whitelist Refinement:** Added "Computer Vision", "Firmware", "Integrator" to prevent valid edge-case rejections.

### B. Matrix Re-Architecture (The "Cluster Strategy")
Instead of long monolithic queries, we split the "Dead Queries" into semantic clusters to balance granularity and complexity.
* **Removed:** 3 Complex Queries (Backend+Lang mixtures).
* **Added:** 4 Balanced Cluster Queries:
    1.  **Enterprise Backend:** (Java, C#, Go, .NET)
    2.  **Scripting Backend:** (Node.js, Python, Express)
    3.  **Modern Frontend:** (React, Vue, Next.js)
    4.  **Structural Frontend:** (Angular, TS, JS)

## 3. Success Metrics (What to expect in next run)
1.  **Zero Dead Queries:** All new cluster queries should return > 0 results.
2.  **Cleaner Accepted List:** Significant reduction in "Mechanical/Electrical" roles.
3.  **Yield Stability:** Total unique jobs should remain stable or increase slightly due to better query resolution.

## 4. Watchlist for Next Audit (v5.1)
* **Monitor "Firmware":** We allowed "Firmware" in the Whitelist. Check if this introduces too much Embedded/Hardware noise (C/Assembly roles) that we don't want.
* **Monitor "Integrator":** Check if this keyword brings in low-tech manual QA jobs.
* **Cluster Performance:** Verify that "Cluster A" (Enterprise) isn't still too heavy for LinkedIn.


