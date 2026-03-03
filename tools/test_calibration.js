/**
 * Calibration Report Test Script
 *
 * Generates the calibration Markdown report and writes it to output/test_calibration_report.md.
 * Requires MongoDB (MONGODB_URI in .env).
 *
 * Usage: node tools/test_calibration.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { MongoStorageAdapter } = require('../services/storage/MongoStorageAdapter');
const { generateCalibrationReportMd } = require('../services/calibration/calibrationReport');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'test_calibration_report.md');

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('Error: MONGODB_URI not found in environment variables');
    console.error('  Please set MONGODB_URI in your .env file');
    process.exit(1);
  }

  const storageAdapter = new MongoStorageAdapter(mongoUri);

  let md;
  try {
    md = await generateCalibrationReportMd(storageAdapter);
  } catch (err) {
    console.error('Failed to generate calibration report:', err.message || err);
    process.exit(1);
  } finally {
    if (typeof storageAdapter.close === 'function') {
      await storageAdapter.close().catch(() => {});
    }
  }

  try {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_FILE, md, 'utf8');
    console.log(`Calibration report written to ${OUTPUT_FILE}`);
  } catch (err) {
    console.error('Failed to write report file:', err.message || err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message || err);
  process.exit(1);
});
