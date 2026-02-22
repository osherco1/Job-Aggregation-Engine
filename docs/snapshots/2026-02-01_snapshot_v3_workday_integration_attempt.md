# 📊 System Snapshot v3 - Workday Integration Attempt

**Date:** 2026-02-01  
**Phase:** 5 → 6 Transition (ATS Expansion → Cloud Preparation)  
**Status:** 🚧 **BLOCKED / IN-PROGRESS**

---

## 🎯 Executive Summary

We have successfully reverse-engineered the **Workday internal API** (`wday/cxs`) and confirmed valid job data exists via manual testing tools (`check_workday_nvidia.js`, `inspect_nvidia_locations.js`).

A production-ready `WorkdayWorker` class was implemented with:
- Zero-Config URL parsing (auto-extracts tenant/instance/site)
- Session management via `tough-cookie` + `axios-cookiejar-support`
- Dynamic Israel facet ID detection
- ATS Guard integration for title filtering

### ❌ Critical Blocker

The smoke test (`test_workday_loop.js`) **fails to return jobs**:
- Intel, NVIDIA, GM all return `undefined jobs` or empty arrays
- Location facet detection returns `null` for all companies
- ~180s runtime for NVIDIA indicates pagination is running but filtering fails

### 🔍 Root Cause Hypothesis

1. **Test Script Bug:** `jobs.length` is called on object `{ jobs, stats }` not the array
2. **Facet Key Mismatch:** Worker expects `facetId` but raw API uses different key names
3. **Normalization Failures:** GM shows `missing title in job, skipping. Keys: bulletFields`

---

## 🏗️ System Architecture View

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (HUB)                        │
│              ats/orchestrator.js                            │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┬─────────────┐
        ▼             ▼             ▼             ▼
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│ LinkedIn  │  │  Comeet   │  │Greenhouse │  │ Workday   │
│ (Voyager) │  │           │  │           │  │   🚧      │
│    ✅     │  │    ✅     │  │    ✅     │  │   ❌      │
└───────────┘  └───────────┘  └───────────┘  └───────────┘
     STABLE        STABLE        STABLE      EXPERIMENTAL
```

### Active Spokes (Production Ready)
| Spoke | API Type | Companies | Status |
|-------|----------|-----------|--------|
| LinkedIn | GraphQL (Voyager) | Via Search | ✅ Stable |
| Comeet | REST JSON | 50+ | ✅ Stable |
| Greenhouse | REST JSON | 30+ | ✅ Stable |

### Experimental Spoke (Blocked)
| Spoke | API Type | Companies | Status |
|-------|----------|-----------|--------|
| Workday | Internal CXS API | 20 targets | ❌ Failing |

### Infrastructure
- **Runtime:** Node.js 22.x
- **State:** Local file DB (`data/seen_jobs.json`)
- **Sessions:** `tough-cookie` v6.0.0 + `axios-cookiejar-support` v6.0.5

---

## 📋 Current Phase Status

### Phase 5: ATS Integration

| Component | Status | Notes |
|-----------|--------|-------|
| Comeet Worker | ✅ STABLE | 50+ companies, production ready |
| Greenhouse Worker | ✅ STABLE | 30+ companies, production ready |
| Workday Worker | ❌ UNSTABLE | Session works, facet/normalization failing |
| ATS Guard | ✅ STABLE | Title/seniority filtering operational |
| Unified Orchestrator | ✅ STABLE | Parallel execution, email notifications |

### Phase 6: Cloud Migration

| Task | Status | Blocker |
|------|--------|---------|
| Lambda Handler | ⏸️ Pending | Workday stabilization |
| DynamoDB Migration | ⏸️ Pending | Workday stabilization |
| EventBridge Scheduler | ⏸️ Pending | Workday stabilization |

---

## ✅ Core Achievements (This Session)

### 1. Research & Validation
- Confirmed Workday "Hidden API" approach viable (vs. Puppeteer)
- Validated JSON response structure via `check_workday_nvidia.js`
- Discovered location facet format: `{ descriptor, id, count }`

### 2. Data Bank Creation
Created `data/workday_companies.json` with **20 high-value targets**:
```
Intel, NVIDIA, General Motors, Salesforce, Workday,
Dell, Cisco, KLA, Applied Materials, Marvell,
Samsung, Genesys, Medtronic, Deutsche Bank, Checkout.com,
HPE, Yahoo, Kyndryl, Pfizer, Chevron
```

### 3. Infrastructure Integration
- Added `tough-cookie` v6.0.0 to `package.json`
- Added `axios-cookiejar-support` v6.0.5 for cookie persistence
- Implemented `initSession()` with 2s Akamai delay

### 4. Tooling
- `tools/check_workday_nvidia.js` - API connectivity POC
- `tools/inspect_nvidia_locations.js` - Facet raw dump utility
- `tools/test_workday_loop.js` - Multi-company smoke test

---

## 🔬 Technical Delta (Problem Space)

### Log Analysis

| Log Message | Interpretation |
|-------------|----------------|
| `[WD WARN] No location facet found` | `detectIsraelId()` returns null |
| `[WD WARN] Normalize: missing title` | Raw JSON structure differs from expected |
| `Fetched undefined jobs` | Test script accesses `.length` on object |

### The Return Value Bug

**In `test_workday_loop.js`:**
```javascript
const jobs = await worker.fetchJobs();
console.log(`Fetched ${jobs.length} jobs`);  // ❌ WRONG!
```

**Actually `fetchJobs()` returns:**
```javascript
return { jobs: allJobs, stats };  // Object, not array
```

**Fix needed:**
```javascript
const result = await worker.fetchJobs();
console.log(`Fetched ${result.jobs.length} jobs`);
```

### Performance Observations

| Company | Duration | Interpretation |
|---------|----------|----------------|
| Intel | 36s | Quick pagination (small dataset or early exit) |
| NVIDIA | 181s | Full 2000 job pagination (20 jobs/page × 100 pages) |
| GM | 64s | Medium pagination, normalization failures |

---

## ⚙️ Configuration Snapshot

### WorkdayWorker Constants

```javascript
PAGE_LIMIT = 20;                    // Jobs per API request
WORKDAY_DELAY_MIN_MS = 200;         // Min delay between requests
WORKDAY_DELAY_MAX_MS = 500;         // Max delay between requests
SESSION_INIT_DELAY_MS = 2000;       // Akamai sensor delay

ISRAEL_TERMS = [
  'israel', 'tel aviv', 'tel-aviv', 'yokneam',
  'haifa', 'herzliya', 'raanana', 'petah tikva', 'jerusalem'
];
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEBUG_WORKDAY` | `false` | Enable verbose logging |
| `ATS_GUARD_DRY_RUN` | `false` | Bypass title filtering |
| `ATS_QUIET_MODE` | `true` | Suppress non-error logs |

---

## 🚀 Next Strategic Steps

### Immediate (Bug Fixes)

1. **Fix Test Script Return Value**
   ```javascript
   // Change:
   const jobs = await worker.fetchJobs();
   console.log(`Fetched ${jobs.length} jobs`);
   
   // To:
   const { jobs, stats } = await worker.fetchJobs();
   console.log(`Fetched ${jobs.length} jobs (stats: ${JSON.stringify(stats)})`);
   ```

2. **Debug Normalization**
   - Add `console.log(JSON.stringify(rawJob, null, 2))` before `_normalizeJob`
   - Identify actual key names in raw response

3. **Hardcode Test Facet**
   - Use known NVIDIA Israel ID: `91336993fab910af6d6fa14badbcc1ec`
   - Verify if issue is discovery vs. fetching

### Short-Term (Stabilization)

4. **Fix Facet Detection Logic**
   - Raw dump shows `facet` not `facetId` as the key
   - Update `detectIsraelId()` to check correct property

5. **Handle Multi-Location Jobs**
   - Jobs with `locationsText: "2 Locations"` need special handling
   - Consider fetching individual job details for location array

### Medium-Term (Production)

6. **Integrate into Orchestrator**
   - Add Workday spoke to `ats/orchestrator.js`
   - Configure in `ats/config/companies.json`

7. **Proceed to Phase 6**
   - Lambda handler wrapper
   - DynamoDB state migration

---

## 📁 File References

| File | Purpose |
|------|---------|
| [workdayWorker.js](file:///c:/Users/kohen/OneDrive/Desktop/%D7%A4%D7%A8%D7%95%D7%99%D7%A7%D7%98%D7%99%D7%9D/linkedin_job_bot/ats/workers/workdayWorker.js) | Session-based worker class |
| [test_workday_loop.js](file:///c:/Users/kohen/OneDrive/Desktop/%D7%A4%D7%A8%D7%95%D7%99%D7%A7%D7%98%D7%99%D7%9D/linkedin_job_bot/tools/test_workday_loop.js) | Smoke test script |
| [workday_companies.json](file:///c:/Users/kohen/OneDrive/Desktop/%D7%A4%D7%A8%D7%95%D7%99%D7%A7%D7%98%D7%99%D7%9D/linkedin_job_bot/data/workday_companies.json) | 20 company targets |
| [check_workday_nvidia.js](file:///c:/Users/kohen/OneDrive/Desktop/%D7%A4%D7%A8%D7%95%D7%99%D7%A7%D7%98%D7%99%D7%9D/linkedin_job_bot/tools/check_workday_nvidia.js) | API connectivity POC |

---

*Generated: 2026-02-01T01:02:37+02:00*
