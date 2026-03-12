/**
 * On-Demand Production Calibration & Purge Tool
 *
 * Connects to production MongoDB, generates a calibration report, writes it to docs/analyze/.
 * By default (safe mode): only reports what would be deleted; no DB mutations.
 * With --confirm: aggressive purge (all calibration_rejected + calibration_passed), timer reset, and zombie collection drops.
 *
 * Usage:
 *   node tools/run_proactive_calibration.js           # Safe mode (report + would-delete counts)
 *   node tools/run_proactive_calibration.js --confirm # Aggressive purge (report + timer reset + full calibration purge)
 *
 * Requires MONGODB_URI in .env.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { MongoStorageAdapter } = require('../services/storage/MongoStorageAdapter');
const { generateCalibrationReportMd } = require('../services/calibration/calibrationReport');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'docs', 'analyze');
const CALIBRATION_REJECTED = 'calibration_rejected';
const CALIBRATION_PASSED = 'calibration_passed';

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  const confirmPurge = process.argv.includes('--confirm');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('Error: MONGODB_URI not found in environment variables');
    console.error('  Please set MONGODB_URI in your .env file');
    process.exit(1);
  }

  const storageAdapter = new MongoStorageAdapter(mongoUri);

  try {
    const md = await generateCalibrationReportMd(storageAdapter);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    const timestamp = timestampForFilename();
    const outputPath = path.join(OUTPUT_DIR, `calibration_${timestamp}.md`);
    fs.writeFileSync(outputPath, md, 'utf8');
    console.log(`Report written to ${outputPath}`);

    if (!confirmPurge) {
      const rejCol = await storageAdapter.getCollection(CALIBRATION_REJECTED);
      const passCol = await storageAdapter.getCollection(CALIBRATION_PASSED);
      const wouldDeleteRejected = await rejCol.countDocuments({});
      const wouldDeletePassed = await passCol.countDocuments({});
      console.log('');
      console.log('[SAFE MODE] No database changes were made.');
      console.log(`Would delete (aggressive): calibration_rejected: ${wouldDeleteRejected}, calibration_passed: ${wouldDeletePassed}`);
      console.log('To perform aggressive purge and timer reset, run with --confirm');
      return;
    }

    console.log('[AGGRESSIVE PURGE] Running runVolumeCleanupProtocol({ mode: "aggressive" })...');
    const cleanup = await storageAdapter.runVolumeCleanupProtocol({ mode: 'aggressive' });
    console.log(`Purged calibration_rejected: ${cleanup.purgedRejected}, calibration_passed: ${cleanup.purgedPassed}, run_summaries: ${cleanup.purgedRunSummaries}, dropped: ${(cleanup.droppedCollections || []).join(', ') || 'none'}`);

    await storageAdapter.updateLastCalibrationTime();
    console.log('Calibration timer updated (lastCalibrationAt set to now).');
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  } finally {
    if (typeof storageAdapter.close === 'function') {
      await storageAdapter.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message || err);
  process.exit(1);
});
