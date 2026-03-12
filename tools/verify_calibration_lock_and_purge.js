/**
 * Verification script for DB Volume Trigger Stabilization: lock exclusivity and purge behavior.
 * Run with MONGODB_URI in .env. Does not send emails.
 *
 * Scenarios:
 * 1. Lock acquire/release: one process acquires, releases; second acquire succeeds.
 * 2. Lock exclusivity: two owners try to acquire; only one succeeds.
 * 3. Stale lock recovery: preseed expired lock, next acquire succeeds (steals lock).
 * 4. Purge mode aggressive: runVolumeCleanupProtocol({ mode: 'aggressive' }) and report counts.
 */

require('dotenv').config();

const { MongoStorageAdapter } = require('../services/storage/MongoStorageAdapter');

const LOCK_ID = 'calibration_lock';
const LOCK_TTL_MS = 5000;

async function ensureConnected(adapter) {
  if (typeof adapter._ensureConnected === 'function') {
    await adapter._ensureConnected();
  }
}

async function scenario1_acquireRelease(adapter) {
  console.log('\n--- Scenario 1: Acquire then release ---');
  const ownerId = `verify-${process.pid}-${Date.now()}`;
  const r1 = await adapter.acquireCalibrationLock({ ownerId, ttlMs: LOCK_TTL_MS });
  if (!r1.acquired) {
    console.log('  FAIL: first acquire did not get lock');
    return false;
  }
  console.log('  OK: acquired lock');
  const released = await adapter.releaseCalibrationLock({ ownerId });
  if (!released) {
    console.log('  FAIL: release returned false');
    return false;
  }
  console.log('  OK: released lock');
  const r2 = await adapter.acquireCalibrationLock({ ownerId, ttlMs: LOCK_TTL_MS });
  if (!r2.acquired) {
    console.log('  FAIL: second acquire after release did not get lock');
    return false;
  }
  await adapter.releaseCalibrationLock({ ownerId });
  console.log('  OK: re-acquired and released');
  return true;
}

async function scenario2_exclusivity(adapter) {
  console.log('\n--- Scenario 2: Lock exclusivity (two owners) ---');
  const ownerA = `ownerA-${Date.now()}`;
  const ownerB = `ownerB-${Date.now()}`;
  const rA = await adapter.acquireCalibrationLock({ ownerId: ownerA, ttlMs: LOCK_TTL_MS });
  if (!rA.acquired) {
    console.log('  FAIL: ownerA did not acquire');
    return false;
  }
  const rB = await adapter.acquireCalibrationLock({ ownerId: ownerB, ttlMs: LOCK_TTL_MS });
  if (rB.acquired) {
    console.log('  FAIL: ownerB acquired while ownerA held lock');
    await adapter.releaseCalibrationLock({ ownerId: ownerA });
    return false;
  }
  console.log('  OK: only one owner held lock');
  await adapter.releaseCalibrationLock({ ownerId: ownerA });
  return true;
}

async function scenario3_staleLockRecovery(adapter) {
  console.log('\n--- Scenario 3: Stale lock recovery ---');
  const col = await adapter.getCollection('system_state');
  const expired = new Date(Date.now() - 60000);
  await col.updateOne(
    { _id: LOCK_ID },
    {
      $set: {
        isLocked: true,
        ownerId: 'stale-owner',
        lockedAt: expired,
        expiresAt: expired,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  const ownerId = `stealer-${Date.now()}`;
  const r = await adapter.acquireCalibrationLock({ ownerId, ttlMs: LOCK_TTL_MS });
  if (!r.acquired) {
    console.log('  FAIL: could not steal expired lock');
    return false;
  }
  console.log('  OK: stole expired lock');
  await adapter.releaseCalibrationLock({ ownerId });
  return true;
}

async function scenario4_aggressivePurge(adapter) {
  console.log('\n--- Scenario 4: Aggressive purge (counts only) ---');
  const result = await adapter.runVolumeCleanupProtocol({ mode: 'aggressive' });
  console.log('  purgedRejected:', result.purgedRejected);
  console.log('  purgedPassed:', result.purgedPassed);
  console.log('  purgedRunSummaries:', result.purgedRunSummaries);
  console.log('  droppedCollections:', result.droppedCollections);
  console.log('  OK: runVolumeCleanupProtocol completed (no throw)');
  return true;
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set. Create .env with MONGODB_URI.');
    process.exit(1);
  }

  const adapter = new MongoStorageAdapter(mongoUri);
  let ok = true;
  try {
    await ensureConnected(adapter);
    ok = (await scenario1_acquireRelease(adapter)) && ok;
    ok = (await scenario2_exclusivity(adapter)) && ok;
    ok = (await scenario3_staleLockRecovery(adapter)) && ok;
    ok = (await scenario4_aggressivePurge(adapter)) && ok;
  } finally {
    await adapter.close().catch(() => {});
  }

  console.log(ok ? '\nAll verification scenarios passed.' : '\nSome scenarios failed.');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Verification failed:', err.message || err);
  process.exit(1);
});
