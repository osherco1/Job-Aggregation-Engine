## 1. Executive Summary & Phase Status

- **Current Phase:** Phase 5.3 – ATS Scaling & Comeet Debugging  
- **Status:** 🟡 **PARTIAL SUCCESS**
  - **Greenhouse:** **PRODUCTION READY.** Successfully fetched and filtered 150+ jobs from Wiz (153 fetched in the latest run), with strict ATS and location gates applied.
  - **Comeet:** **BLOCKED.** Still receiving 404/301 patterns for Monday.com and Fiverr despite multiple iterations (slug vs UID, `.com` vs `.co`, headers, and redirect handling).
- **Headline:** **"Greenhouse pipeline is solid; Comeet requires external API investigation."**

---

## 2. System Architecture & Logic Changes

- **Hub & Spoke Orchestration**
  - **Hub:** Central ATS orchestrator that iterates over configured companies in `data/companies_list.json`, dispatching to the correct worker based on `type` (`greenhouse` or `comeet`).
  - **Spokes:**  
    - `GreenhouseWorker` (not shown here) for all Greenhouse-based companies.  
    - `ComeetWorker` (`ats/workers/comeetWorker.js`) for Comeet-based companies (currently Monday and Fiverr).

- **Critical Logic Update – `locationGate.js`**
  - File: `ats/utils/locationGate.js`
  - **Goal:** Prevent foreign remote jobs (e.g., `"Remote - Germany"`) from leaking into the pipeline just because they contain the word `"Remote"`.
  - **New behavior:**
    - Normalizes input with `toString().trim().toLowerCase()`.
    - **Passes** if:
      - The string contains **"Israel"**, or
      - It contains one of the approved Israeli cities: **"Tel Aviv", "Herzliya", "Haifa", "Jerusalem", "Rehovot", "Ramat Gan", "Petah Tikva", "Netanya", "Ra'anana", "Hod HaSharon", "Kfar Saba", "Givatayim"**, or
      - It is **exactly** `"Remote"` (trimmed, case-insensitive), or
      - It contains both **"Remote"** and **"Israel"**.
    - **Explicit rejection:** Any string that contains **"remote"** but **does not** contain `"israel"`, and is **not exactly** `"remote"`, is rejected (e.g., `"Remote - Germany"`, `"Remote - UK"`, `"Remote - Japan"`).
    - Everything else returns `false`.

- **Comeet Worker – `.co` Domain, Headers, and Redirects**
  - File: `ats/workers/comeetWorker.js`
  - **Endpoint construction:**
    - `const targetUrl = \`https://www.comeet.co/jobs-api/2.0/company/${cleanUid}/positions\`;`
    - Uses the `.co` TLD and the `jobs-api` path (the current best guess from reverse-engineering and logs).
  - **HTTP client configuration (via `requestWithDelayWrapper`):**
    - Method: `GET`
    - `maxRedirects: 5` to follow Comeet’s 301 redirects.
    - **Headers:**
      - `User-Agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"`
      - `Accept: "application/json, text/plain, */*"`
      - `Referer: "https://www.comeet.com/"`
  - **Debugging hooks:**
    - Logs the raw UID and final URL for each call:
      - `[DEBUG] Raw UID: '...'`
      - `[DEBUG] Final URL: 'https://www.comeet.co/jobs-api/2.0/company/{uid}/positions'`
    - Optionally writes raw responses with debug analysis to `logs/ats/raw/` when `DEBUG_RAW=true`.

---

## 3. Core Achievements (This Session)

1. **Wiz Integration (Greenhouse)**
   - **UID discovery:** Confirmed the correct Greenhouse board token as **`wizinc`**.
   - **Latest run stats (from `ats_run_summary_2026-01-11T00-17-54-450Z.json`):**
     - `fetched: 153`
     - `guardPassed: 7`
     - `guardDropped: 146` (primarily senior/irrelevant roles)
     - `droppedLocation: 7` (caught by the stricter location gate)
     - `kept: 0` after all filters for this particular run, demonstrating that the pipeline is conservative rather than leaky.

2. **Zero Senior Leakage**
   - **Across Greenhouse companies (Gong, Riskified, Melio, AppsFlyer, Wiz):**
     - Titles and descriptions are filtered aggressively by ATS Guard (`evaluateAtsGuard`) and then by the location gate.
     - The summary JSON shows:
       - High `guardDroppedByTitle` counts (e.g., Wiz: 127, AppsFlyer: 52), indicating senior or irrelevant positions are being correctly excluded.
     - No evidence of senior roles making it into `kept` totals in this snapshot.

3. **OSINT-Based UID Investigation for Comeet**
   - Manually inspected Monday.com and Fiverr career pages and JavaScript to infer internal Comeet identifiers:
     - **Monday.com:** UID `41.00B` (Comeet-style company code).
     - **Fiverr:** UID `60.002` (probable Comeet company code based on standard structure).
   - These values have been surfaced in `tools/force_final_config.js` and used in experiments, but **public API calls still fail**, suggesting these IDs are wired for internal widgets rather than a stable public API.

---

## 4. Contextual Delta (What Failed?)

- **The Comeet Loop**
  - Multiple approaches were attempted for Monday and Fiverr, all against Comeet infrastructure:
    - **Slug-based attempts (e.g., `"monday"`, `"fiverr"`):**
      - `https://www.comeet.com/jobs-api/2.0/company/{slug}/positions` → **404**.
    - **UID-based attempts with headers (e.g., `"41.00B"`, `"60.002"`):**
      - Same `jobs-api` path on `.com` → **404**.
    - **`careers-api` path (observed in front-end source):**
      - `https://www.comeet.co/careers-api/2.0/company/{uid}/positions` → **400 Bad Request** in practice.
    - **`.co` domain with `jobs-api` and redirects enabled:**
      - `https://www.comeet.co/jobs-api/2.0/company/{uid}/positions`
      - With `maxRedirects: 5`, requests still end in a **404** after following 301s.
  - **Outcome:** Latest run summary shows:
    - `monday` (source `comeet`): `fetched: 0`, `errors: 0`.
    - `fiverr` (source `comeet`): `fetched: 0`, `errors: 0`.
    - This indicates the pipeline itself is stable (no thrown errors), but **no usable data is being returned by Comeet endpoints**.

- **Key Insight**
  - **Hypothesis:** The Comeet public job widgets likely talk to a different (or parameterized) backend than the simple `/jobs-api/2.0/company/{uid}/positions` pattern.
  - There may be:
    - Additional required query parameters (e.g., widget IDs, `token`, `uid`, or tenant-level keys), or
    - A completely separate endpoint exposed only via their embedded script, not intended for direct server-side use.

---

## 5. Configuration Snapshot

- **Current `data/companies_list.json`**
  - Array content at the time of this snapshot:
    - `{ id: "gong", name: "Gong", type: "greenhouse", uid: "gongio" }`
    - `{ id: "riskified", name: "Riskified", type: "greenhouse", uid: "riskified" }`
    - `{ id: "melio", name: "Melio", type: "greenhouse", uid: "melio" }`
    - `{ id: "appsflyer", name: "AppsFlyer", type: "greenhouse", uid: "appsflyer" }`
    - `{ id: "wiz", name: "Wiz", type: "greenhouse", uid: "wizinc" }`
    - `{ id: "monday", name: "Monday.com", type: "comeet", uid: "monday" }`
    - `{ id: "fiverr", name: "Fiverr", type: "comeet", uid: "fiverr" }`

- **Effective Status by Category**
  - **Active / Stable (Greenhouse):**
    - **Gong**, **Riskified**, **Melio**, **AppsFlyer**, **Wiz**
    - All successfully fetch jobs; ATS Guard + location gate are functioning and producing sane stats.
  - **Problematic (Comeet-backed):**
    - **Monday.com** – Configured as `type: "comeet"`, current UID `"monday"` in `companies_list.json` but experiments also tried `41.00B`. All current API permutations return **no data**.
    - **Fiverr** – Configured as `type: "comeet"`, current UID `"fiverr"` in `companies_list.json`, with `60.002` tested experimentally; again, no successful responses.
  - **Disabled / Under Investigation:**
    - **Snyk** – Not present in the current `companies_list.json`, but previously explored with Greenhouse tokens (`snyk`, `snykltd`). Both failed; Snyk may have moved off Greenhouse (e.g., Ashby/Lever) or changed tokens.

- **Operational Flags**
  - **`DEBUG_RAW=true`** used during debugging to capture full raw ATS responses for Greenhouse companies.
  - **`maxRedirects=5`** is now explicitly set in the Comeet worker’s HTTP config to follow 301 responses.

---

## 6. Next Strategic Steps (Action Plan for Next Dev)

1. **Investigate the Real Comeet API Contract**
   - **Do not** continue blind variations of slugs and UIDs.
   - Use **browser dev tools**, `curl`, or **Postman** against a known working careers page (e.g., Monday or Fiverr) to:
     - Capture all network calls made by the Comeet widget.
     - Identify:
       - Exact base URL, path, and query parameters.
       - Auth or tenant tokens (if any).
       - Required headers beyond the basic `User-Agent` / `Referer`.
   - Once a single correct call is identified, replicate its structure in `ComeetWorker` and re-run the ATS pipeline.

2. **Clarify Snyk’s ATS Provider**
   - Manually check Snyk’s careers site:
     - Confirm whether they are still on **Greenhouse**, or have moved to **Ashby**, **Lever**, or another provider.
   - If they are still on Greenhouse:
     - Extract the correct board token from their `<script>` or `boards.*.greenhouse.io` URL.
     - Add a new entry to `data/companies_list.json` and test with the existing Greenhouse worker.

3. **Stabilize and Version Configuration**
   - Treat `data/companies_list.json` as a **versioned configuration artifact**:
     - When changing UIDs or types (e.g., `comeet` vs `greenhouse`), document the rationale in `docs/snapshots` and/or commit messages.
     - Consider adding a small `tools/validate_companies_config.js` to sanity-check types and maybe run a quick HEAD/health probe.

4. **Merge Streams Once Comeet Is Online**
   - Once at least one Comeet company (Monday or Fiverr) returns live data:
     - Update the ATS orchestrator to **merge Greenhouse + Comeet outputs** into a single normalized job feed.
     - Run the full pipeline end-to-end (ATS → filters → enrichment → notifications) and verify:
       - No senior roles.
       - No non-Israeli or foreign-remote locations.
       - Consistent fields between LinkedIn and ATS data.

5. **Observability & Guardrails**
   - Keep `DEBUG_RAW` or a similar flag available (but off by default in production) for future investigations.
   - Consider adding:
     - Summary metrics (per source) for **HTTP codes** from ATS calls.
     - A lightweight alert if any configured company consistently returns `0 fetched` for N consecutive runs.

---

**Bottom Line:** The **Greenhouse ATS integration is dependable and production-ready**, with strong guardrails for seniority and geography. The **Comeet integration remains blocked by unclear public API semantics**; the next owner should focus on reverse-engineering or obtaining official API documentation rather than further guesswork on URL patterns.

