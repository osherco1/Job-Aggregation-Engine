# Incident context — MongoDB M0 quota, lock/purge path, email-before-persist, Cloud Run retries

Forensic read of the repository as of this document’s authoring. **No code was modified** for this report.

---

## Core Execution Flow

Trace of `ats/orchestrator.js` in runtime order, with the calibration / volume / lock / purge segment inside **Phase 1 (ATS)**.

1. **Module entry (scheduled / container CMD)** — `node ats/orchestrator.js` runs `run()`; on failure, `process.exitCode = 1` and a 5s fail-safe `process.exit` (`ats/orchestrator.js:672–686`).

2. **`run()` opens a storage adapter** — `createStorageAdapter()` (`ats/orchestrator.js:541`).

3. **`run()` main `try` block** (`ats/orchestrator.js:543–659`):
   - **Load sent history for ATS silent dedup** — `knownJobIds = await storageAdapter.loadSentHistory()` unless `RESET_DEDUP=true` (`ats/orchestrator.js:567–572`).
   - **Parallel phase** — `Promise.allSettled([ runAtsWorkers(...), runLinkedInPhase(...) ])` (`ats/orchestrator.js:577–580`). Errors from a rejected phase are merged into `errors` (`ats/orchestrator.js:582–607`).
   - **Merge jobs** — `allJobs = [...atsJobs, ...linkedinJobs]` (`ats/orchestrator.js:610`).
   - **Services** — `createJobStateService(storageAdapter)`, `createEmailNotifier()` (`ats/orchestrator.js:614–615`).
   - **Phase 3 — Deduplication** — `deduplicateJobs(allJobs, jobStateService)` → `filterNewJobs` (`ats/orchestrator.js:622`).
   - **Phase 4 — Email** — `emailSuccess = await sendNotification(newJobs, errors, emailNotifier)` (`ats/orchestrator.js:625`). Inside `sendNotification`, when not skipped by DRY_RUN / gatekeeper rules, this calls `emailNotifier.sendUnifiedReport(newJobs, errors)` (`ats/orchestrator.js:469–503`).
   - **Phase 5 — Persist** — `await persistState(emailSuccess, jobStateService)` (`ats/orchestrator.js:628`). If `emailSuccess` and not `DRY_RUN`, this awaits `jobStateService.persistState()` (`ats/orchestrator.js:521–526`), which calls `storageAdapter.persistSentHistory(...)` (see `services/JobStateService.js:163–190`).
   - **Phase 5b — `writeCalibrationPassed`** — only if `emailSuccess && newJobs.length > 0 && !DRY_RUN`; errors are **logged only**, not rethrown (`ats/orchestrator.js:631–637`).
   - **Return summary object** (`ats/orchestrator.js:652–659`).

4. **`run()` `finally`** — `await storageAdapter.close()` (`ats/orchestrator.js:660–668`).

5. **Inside `runAtsWorkers` (Phase 1 ATS)** — after workers finish and `persistResults(...)` is called (`ats/orchestrator.js:304`):
   - **`checkVolumeTrigger(storageAdapter)`** — `services/calibration/calibrationReport.js:18–21` (delegates to `storageAdapter.getDbSizeBytes()` when present).
   - **Time trigger** — `getLastCalibrationTime()` vs 7 days (`ats/orchestrator.js:308–313`).
   - **If volume OR time** (`ats/orchestrator.js:315–366`):
     - Build `ownerId`, then if `acquireCalibrationLock` exists, **`try` / `catch`** around `await storageAdapter.acquireCalibrationLock({ ownerId })` (`ats/orchestrator.js:324–334`). On throw, `lockThrew = true` (error **not** logged as thrown until later paths).
     - **If `lockThrew` and trigger was volume** (`triggerType === 'volume'`) — logs critical message, then **`runVolumeCleanupProtocol({ mode: 'aggressive' })` without holding the lock** (`ats/orchestrator.js:337–347`). If cleanup throws, error is logged and **rethrown** (`ats/orchestrator.js:344–346`).
     - **If `lockThrew` and trigger was time** — warning only; calibration / purge via normal path is skipped (`ats/orchestrator.js:348–349`).
     - **Else if lock API missing or lock acquired** — `runCalibrationAndNotify(...)`, optional `updateLastCalibrationTime`, and `releaseCalibrationLock` in `finally` (`ats/orchestrator.js:351–365`).
   - **Outer `catch` on the whole calibration block** — logs warning and **rethrows** (`ats/orchestrator.js:368–370`). That reject propagates out of `runAtsWorkers`, so the ATS branch of `Promise.allSettled` becomes **rejected** (parallel phase still completes for LinkedIn if that side succeeds).

---

## Error Propagation Analysis

### Where quota / DB errors can be swallowed or masked (run still proceeds toward email)

| Location | Behavior | Effect on P0 scenario |
|----------|----------|------------------------|
| `MongoStorageAdapter.loadSentHistory` | `catch` → log → **`return new Set()`** | `services/storage/MongoStorageAdapter.js:181–196`. If reads fail (e.g. extreme overload), dedup history is empty → jobs may be treated as “new” repeatedly. |
| `MongoStorageAdapter.getDbSizeBytes` | `catch` → warn → **`return 0`** | `services/storage/MongoStorageAdapter.js:523–534`. Volume trigger is **false** if `dbStats` fails; volume-based purge path may not run. |
| `MongoStorageAdapter.saveSeenJobIds` | `catch` → log only | `services/storage/MongoStorageAdapter.js:172–174`. LinkedIn-related persistence can fail silently. |
| `persistResults` → `writeRunLog` | `catch` → log only | `ats/orchestrator.js:97–109`. Run summary write failure does not stop the run. |
| `getLastCalibrationTime` | `catch` → warn → **`new Date(0)`** | `services/storage/MongoStorageAdapter.js:602–612`. Can make **time** calibration trigger look “overdue.” |
| `updateLastCalibrationTime` | `catch` → warn only | `services/storage/MongoStorageAdapter.js:619–629`. Timer may not persist. |
| `runLinkedInPhase` | internal `catch` → push errors, **`return []`** | `ats/orchestrator.js:413–437`. LinkedIn failure does not crash the orchestrator. |
| `sendNotification` | `sendUnifiedReport` returns boolean; **no throw** on SMTP failure | `ats/orchestrator.js:495–503`. `emailSuccess === false` → `persistState` **rolls back** pending IDs (`ats/orchestrator.js:527–529`). |

### Where quota / persistence errors crash the run (after email if email succeeded)

| Location | Behavior |
|----------|----------|
| `MongoStorageAdapter.persistSentHistory` | Logs, then **`throw err`** | `services/storage/MongoStorageAdapter.js:238–244`. |
| `JobStateService.persistState` | Logs, then **`throw err`** | `services/JobStateService.js:186–189`. |
| `persistState` (orchestrator) | No local `try/catch` | `ats/orchestrator.js:509–530` → rejection bubbles to `run().catch` (`ats/orchestrator.js:673–676`). |

**Ordering implication:** Phase 4 (email) runs **before** Phase 5 (`persistState`) (`ats/orchestrator.js:625–628`). If `sendUnifiedReport` returns `true` but MongoDB then refuses writes during `persistSentHistory`, the process still **sent** the email and then **exits with failure** on the uncaught rejection from `await persistState(...)` inside `run()`’s `try`.

### Alignment with the reported “Catch-22” narrative

- **Lock acquisition** uses **`updateOne` + `findOneAndUpdate`** on `system_state` (`services/storage/MongoStorageAdapter.js:646–669`). Under **Atlas M0 quota exceeded**, those writes can fail; the orchestrator **catches** that in the inner lock `try/catch` (`ats/orchestrator.js:324–334`).
- **Current repo behavior (volume + lock throw):** emergency **`runVolumeCleanupProtocol({ mode: 'aggressive' })`** without lock (`ats/orchestrator.js:337–347`). If that path **did not exist** in the deployed revision, or **emergency cleanup also cannot write/delete** under quota, the old story applies: no effective purge, ATS phase may still complete (depending on where failure surfaces), later phases can still send email, then **`persistSentHistory` fails** and the job exits non-zero.
- **`getDbSizeBytes`** in this repo uses **`dbStats.storageSize`**, else **`dataSize`**, and **does not add `indexSize`** (`services/storage/MongoStorageAdapter.js:523–530`). If Atlas billing/quota aligns more closely with **storage + indexes**, the **volume trigger may under-fire** relative to actual quota pressure (operational nuance for the SRE).

---

## Critical Code Snippets

### `checkVolumeTrigger` — `services/calibration/calibrationReport.js`

```javascript
async function checkVolumeTrigger(storageAdapter) {
  if (!storageAdapter || typeof storageAdapter.getDbSizeBytes !== 'function') return false;
  const bytes = await storageAdapter.getDbSizeBytes();
  return bytes >= VOLUME_THRESHOLD_BYTES;
}
```
(`services/calibration/calibrationReport.js:18–21`; threshold constant at `services/calibration/calibrationReport.js:7`.)

### `getDbSizeBytes` (how “volume” is measured) — `services/storage/MongoStorageAdapter.js`

```javascript
  async getDbSizeBytes() {
    try {
      await this._ensureConnected();
      const stats = await this.db.command({ dbStats: 1 });
      if (stats.storageSize != null && Number.isFinite(Number(stats.storageSize))) {
        return Number(stats.storageSize);
      }
      return stats.dataSize != null ? Number(stats.dataSize) : 0;
    } catch (err) {
      console.warn('MongoStorageAdapter: getDbSizeBytes failed:', err.message || err);
      return 0;
    }
  }
```
(`services/storage/MongoStorageAdapter.js:523–534`.)

### `acquireCalibrationLock` — `services/storage/MongoStorageAdapter.js`

```javascript
  async acquireCalibrationLock(options = {}) {
    const { ownerId, ttlMs = 15 * 60 * 1000 } = options;
    if (!ownerId || typeof ownerId !== 'string') {
      return { acquired: false };
    }
    await this._ensureConnected();
    const col = await this._getCollection(this.collections.SYSTEM_STATE);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await col.updateOne(
      { _id: 'calibration_lock' },
      { $setOnInsert: { isLocked: false, updatedAt: now } },
      { upsert: true }
    );
    const filter = {
      _id: 'calibration_lock',
      $or: [
        { isLocked: { $ne: true } },
        { expiresAt: { $lte: now } },
      ],
    };
    const update = {
      $set: {
        isLocked: true,
        ownerId,
        lockedAt: now,
        expiresAt,
        updatedAt: now,
      },
    };
    const doc = await col.findOneAndUpdate(filter, update, {
      returnDocument: 'after',
    });
    if (!doc) {
      return { acquired: false };
    }
    const acquired = doc.ownerId === ownerId && doc.isLocked === true;
    if (acquired) {
      console.log(`MongoStorageAdapter: Calibration lock acquired by ${ownerId}, expiresAt=${expiresAt.toISOString()}`);
    }
    return {
      acquired,
      ownerId: doc.ownerId,
      expiresAt: doc.expiresAt,
      lockDoc: doc,
    };
  }
```
(`services/storage/MongoStorageAdapter.js:637–683`.)

**Note:** There is **no** `try/catch` inside `acquireCalibrationLock`; Mongo driver errors propagate to the caller. The orchestrator wraps the call in `try/catch` (`ats/orchestrator.js:324–334`).

### `persistSentHistory` — `services/storage/MongoStorageAdapter.js`

```javascript
  async persistSentHistory(ids, metadata = {}) {
    if (!ids || ids.size === 0) {
      return;
    }

    try {
      const collection = await this._getCollection(this.collections.ATS_SENT_HISTORY);
      const now = new Date();

      const operations = Array.from(ids).map(jobId => ({
        updateOne: {
          filter: { _id: jobId },
          update: {
            $set: {
              lastUpdatedAt: now,
              ...metadata,
            },
            $setOnInsert: {
              sentAt: now,
              createdAt: now,
            },
          },
          upsert: true,
        },
      }));

      if (operations.length > 0) {
        const result = await collection.bulkWrite(operations, { ordered: false });
      }
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to persist sent history:', err.message || err);
      throw err;
    }
  }
```
(`services/storage/MongoStorageAdapter.js:205–245` — debug logging regions omitted in excerpt for clarity; full file contains `#region agent log` blocks.)

### Orchestrator — calibration / lock / emergency purge / outer rethrow — `ats/orchestrator.js`

```javascript
  try {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const volumeTriggered = await checkVolumeTrigger(storageAdapter);
    const lastCal = typeof storageAdapter.getLastCalibrationTime === 'function'
      ? await storageAdapter.getLastCalibrationTime()
      : new Date(0);
    const timeTriggered = (Date.now() - lastCal.getTime()) >= SEVEN_DAYS_MS;

    if (volumeTriggered || timeTriggered) {
      const triggerType = volumeTriggered ? 'volume' : 'time';
      // ... logging ...
      const ownerId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const hasLock = typeof storageAdapter.acquireCalibrationLock === 'function';
      let lockAcquired = false;
      let lockThrew = false;
      let lockErr = null;

      if (hasLock) {
        try {
          const lockResult = await storageAdapter.acquireCalibrationLock({ ownerId });
          lockAcquired = lockResult.acquired;
          if (!lockAcquired) {
            console.log(`Calibration skipped: lock held by another process (current holder: ${lockResult.ownerId || 'unknown'})`);
          }
        } catch (e) {
          lockThrew = true;
          lockErr = e;
        }
      }

      if (lockThrew) {
        if (triggerType === 'volume') {
          console.error('Critical: calibration lock acquisition failed (likely at quota). Running emergency aggressive cleanup without lock...', lockErr?.message || lockErr);
          try {
            const cleanup = await storageAdapter.runVolumeCleanupProtocol({ mode: 'aggressive' });
            console.log(`Emergency aggressive cleanup completed: rejected=${cleanup.purgedRejected}, passed=${cleanup.purgedPassed || 0}, run_summaries=${cleanup.purgedRunSummaries || 0}`);
          } catch (cleanupErr) {
            console.error('Emergency cleanup failed — failing run to prevent scrape/email/persist loop:', cleanupErr?.message || cleanupErr);
            throw cleanupErr;
          }
        } else {
          console.warn('Calibration skipped: lock acquisition failed (time trigger, no bypass):', lockErr?.message || lockErr);
        }
      } else if (!hasLock || lockAcquired) {
        try {
          const emailNotifier = createEmailNotifier();
          const ok = await runCalibrationAndNotify(storageAdapter, emailNotifier, triggerType);
          if (ok && typeof storageAdapter.updateLastCalibrationTime === 'function') {
            await storageAdapter.updateLastCalibrationTime();
            console.log('Calibration timer reset');
          }
        } finally {
          if (hasLock && lockAcquired && typeof storageAdapter.releaseCalibrationLock === 'function') {
            await storageAdapter.releaseCalibrationLock({ ownerId }).catch((releaseErr) => {
              console.warn('Calibration lock release failed:', releaseErr.message || releaseErr);
            });
          }
        }
      }
    }
  } catch (calErr) {
    console.warn('Calibration check failed:', calErr.message || calErr);
    throw calErr;
  }
```
(`ats/orchestrator.js:307–370`.)

### Orchestrator — main `run()` `try` / `finally` and process exit — `ats/orchestrator.js`

```javascript
async function run() {
  // ...
  const storageAdapter = createStorageAdapter();

  try {
    // ... parallel ATS + LinkedIn, dedup, email, persistState, calibration_passed, summary ...
    await persistState(emailSuccess, jobStateService);
    // ... more ...
    return { /* summary */ };
  } finally {
    try {
      await storageAdapter.close();
    } catch (closeErr) {
      console.error('Failed to close storage adapter:', closeErr.message || closeErr);
    }
  }
}

if (require.main === module) {
  run()
    .catch((err) => {
      console.error('Orchestrator failed:', err && err.message ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => {
      setTimeout(() => {
        console.warn('⚠️  Process did not exit naturally — forcing shutdown.');
        process.exit(process.exitCode || 0);
      }, 5000).unref();
    });
}
```
(`ats/orchestrator.js:536–669` and `672–686` — body abbreviated with comment placeholders.)

**Exit behavior:** There is **no** `catch` on the main `run()` `try` that swallows errors. A failure in `await persistState(...)` rejects the promise from `run()`, the `.catch` sets **`process.exitCode = 1`**, and the **5s `setTimeout` calls `process.exit(process.exitCode || 0)`**, yielding **exit code 1** on persistence failure.

---

## Infrastructure Findings

| Artifact | Finding |
|----------|---------|
| **`Dockerfile`** | Production image; **`CMD ["node", "ats/orchestrator.js"]`** (`Dockerfile:21–22`). No retry flags. |
| **`cloudbuild.yaml`** | **Docker build + push** to `gcr.io/$PROJECT_ID/jobbot-image` only (`cloudbuild.yaml:1–8`). **No** `gcloud run jobs` step and **no** `max-retries` / `task-retries` keys. |
| **`deploy.sh`** | **Not present** in the repository (search for `deploy.sh` returned no file). |
| **CI / `gcloud run jobs create`** | **No** checked-in YAML or shell script in-repo that sets Cloud Run Job **task retry** policy. Docs and snapshots **mention** manual deploy patterns such as `gcloud run jobs deploy jobbot-runner --source . --region europe-west1` (e.g. `docs/snapshots/snapshot_2026-03-01.md`, `docs/SYSTEM_REFERENCE.md`) — **operational knowledge, not executable config in git**. |

**Conclusion for SRE:** **Task-level retries and max attempts** for the Cloud Run **Job** must be read from **Google Cloud Console** or **`gcloud run jobs describe`** for the live job resource. The repository **does not** version those settings. A non-zero **process exit** from Node (`process.exit(1)` / exit code 1 via the fail-safe path) typically marks the **execution as failed**; if the job is configured with **automatic task retries**, **each retry re-runs the full orchestrator**, which can **re-send email** for the same logical “new” jobs if **`ats_sent_history` was never updated** due to the prior persistence failure — consistent with the reported spam loop.

---

*End of report.*
