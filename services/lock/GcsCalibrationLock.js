/**
 * GCS-backed distributed calibration lock (atomic create via ifGenerationMatch: 0).
 * Falls back to MongoDB system_state lock when GCS_LOCK_BUCKET is unset (local dev).
 */

const { Storage } = require('@google-cloud/storage');

/** @type {Storage|null} */
let _storage = null;

function getStorage() {
  if (!_storage) {
    _storage = new Storage();
  }
  return _storage;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isPreconditionFailed(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 412) return true;
  if (String(code) === '412') return true;
  const msg = String(err.message || '');
  if (/412|Precondition Failed|conditionNotMet/i.test(msg)) return true;
  const reasons = err.errors;
  if (Array.isArray(reasons)) {
    return reasons.some((e) => e && String(e.reason || '').includes('conditionNotMet'));
  }
  return false;
}

/**
 * Remove lock object if its expiresAt is in the past (or object missing).
 * @param {string} bucketName
 * @param {string} lockPath
 * @returns {Promise<boolean>} true if stale/missing lock was cleared
 */
async function cleanupStaleLock(bucketName, lockPath) {
  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(lockPath);
  try {
    const [exists] = await file.exists();
    if (!exists) {
      return true;
    }
    const [buf] = await file.download();
    let doc;
    try {
      doc = JSON.parse(buf.toString('utf8'));
    } catch {
      await file.delete({ ignoreNotFound: true });
      return true;
    }
    const exp = doc.expiresAt ? new Date(doc.expiresAt) : null;
    if (!exp || Number.isNaN(exp.getTime()) || exp.getTime() > Date.now()) {
      return false;
    }
    await file.delete({ ignoreNotFound: true });
    console.log('GcsCalibrationLock: removed stale lock object');
    return true;
  } catch (err) {
    if (err.code === 404) return true;
    console.warn('GcsCalibrationLock: cleanupStaleLock failed:', err.message || err);
    return false;
  }
}

/**
 * @param {{
 *   bucketName?: string|null,
 *   lockPath: string,
 *   ownerId: string,
 *   ttlMs?: number,
 *   storageAdapter?: { acquireCalibrationLock?: Function, releaseCalibrationLock?: Function }|null
 * }} opts
 * @returns {Promise<{ acquired: boolean, ownerId?: string, expiresAt?: Date }>}
 */
async function acquireLock(opts = {}) {
  // Default TTL: 1 hour. Stale-lock recovery floor — bucket lifecycle is day-granular,
  // so this in-app TTL is the primary lever for orphaned-lock cleanup after OOM crashes.
  const { lockPath, ownerId, ttlMs = 60 * 60 * 1000, storageAdapter } = opts;
  const bucketName = opts.bucketName && String(opts.bucketName).trim();

  if (!ownerId || typeof ownerId !== 'string') {
    return { acquired: false };
  }

  if (!bucketName) {
    if (storageAdapter && typeof storageAdapter.acquireCalibrationLock === 'function') {
      return storageAdapter.acquireCalibrationLock({ ownerId, ttlMs });
    }
    // FileStorageAdapter / local: no distributed lock — single process, treat as acquired.
    console.warn(
      'GcsCalibrationLock: no GCS_LOCK_BUCKET and no Mongo lock API; single-process calibration (no distributed lock)'
    );
    return { acquired: true, ownerId, expiresAt: new Date(Date.now() + ttlMs) };
  }

  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(lockPath);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const payload = JSON.stringify({
    ownerId,
    lockedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const saveOpts = {
    contentType: 'application/json; charset=utf-8',
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
  };

  async function tryCreate() {
    await file.save(Buffer.from(payload, 'utf8'), saveOpts);
  }

  try {
    await tryCreate();
    console.log(
      `GcsCalibrationLock: acquired by ${ownerId}, expiresAt=${expiresAt.toISOString()}`
    );
    return { acquired: true, ownerId, expiresAt };
  } catch (err) {
    if (!isPreconditionFailed(err)) {
      throw err;
    }
    const cleaned = await cleanupStaleLock(bucketName, lockPath);
    if (cleaned) {
      try {
        await tryCreate();
        console.log(`GcsCalibrationLock: acquired after stale cleanup by ${ownerId}`);
        return { acquired: true, ownerId, expiresAt };
      } catch (err2) {
        if (isPreconditionFailed(err2)) {
          console.log('GcsCalibrationLock: lock held by another instance after retry');
          return { acquired: false };
        }
        throw err2;
      }
    }
    console.log('GcsCalibrationLock: lock held (valid, not stale)');
    return { acquired: false };
  }
}

/**
 * @param {{
 *   bucketName?: string|null,
 *   lockPath: string,
 *   ownerId: string,
 *   storageAdapter?: { acquireCalibrationLock?: Function, releaseCalibrationLock?: Function }|null
 * }} opts
 * @returns {Promise<boolean>}
 */
async function releaseLock(opts = {}) {
  const { lockPath, ownerId, storageAdapter } = opts;
  const bucketName = opts.bucketName && String(opts.bucketName).trim();

  if (!ownerId) {
    return false;
  }

  if (!bucketName) {
    if (storageAdapter && typeof storageAdapter.releaseCalibrationLock === 'function') {
      return storageAdapter.releaseCalibrationLock({ ownerId });
    }
    return true;
  }

  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(lockPath);

  try {
    const [exists] = await file.exists();
    if (!exists) {
      return false;
    }
    const [buf] = await file.download();
    let doc;
    try {
      doc = JSON.parse(buf.toString('utf8'));
    } catch {
      console.warn('GcsCalibrationLock: lock file corrupt; deleting');
      await file.delete({ ignoreNotFound: true });
      return false;
    }
    if (doc.ownerId !== ownerId) {
      console.warn(
        `GcsCalibrationLock: release skipped — owner mismatch (expected ${ownerId}, got ${doc.ownerId})`
      );
      return false;
    }
    await file.delete({ ignoreNotFound: true });
    console.log(`GcsCalibrationLock: released by ${ownerId}`);
    return true;
  } catch (err) {
    console.warn('GcsCalibrationLock: releaseLock failed:', err.message || err);
    return false;
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  cleanupStaleLock,
  isPreconditionFailed,
};
