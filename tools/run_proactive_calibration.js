/**
 * On-Demand Production Calibration & Purge Tool
 *
 * Connects to production MongoDB, generates a calibration report, writes it to docs/analyze/.
 * By default (safe mode): only reports what would be deleted; no DB mutations.
 * With --confirm: updates the calibration timer and purges calibration_rejected and calibration_passed.
 *
 * Usage:
 *   node tools/run_proactive_calibration.js           # Safe mode (report + would-delete counts)
 *   node tools/run_proactive_calibration.js --confirm # Full flow (report + timer reset + purge)
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
  const reportCutoffTime = new Date();
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

    const purgeFilter = {
      $or: [
        { createdAt: { $lte: reportCutoffTime } },
        { createdAt: { $exists: false } },
      ],
    };

    const rejCol = await storageAdapter.getCollection(CALIBRATION_REJECTED);
    const passCol = await storageAdapter.getCollection(CALIBRATION_PASSED);

    if (!confirmPurge) {
      const wouldDeleteRejected = await rejCol.countDocuments(purgeFilter);
      const wouldDeletePassed = await passCol.countDocuments(purgeFilter);
      console.log('');
      console.log('[SAFE MODE] No database changes were made.');
      console.log(`Would delete: calibration_rejected: ${wouldDeleteRejected}, calibration_passed: ${wouldDeletePassed}`);
      console.log('To perform purge and timer reset, run with --confirm');
      return;
    }

    await storageAdapter.updateLastCalibrationTime();
    console.log('Calibration timer updated (lastCalibrationAt set to now).');

    const rejResult = await rejCol.deleteMany(purgeFilter);
    const passResult = await passCol.deleteMany(purgeFilter);
    console.log(`Purged calibration_rejected: ${rejResult.deletedCount} document(s).`);
    console.log(`Purged calibration_passed: ${passResult.deletedCount} document(s).`);
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
