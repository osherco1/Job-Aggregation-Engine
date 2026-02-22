const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../config/paths');

/**
 * Delete a single file if it exists.
 * Logs the deletion or does nothing if the file is missing.
 */
function deleteIfExists(filePath, deleted) {
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`Deleted: ${filePath}`);
      deleted.push(filePath);
    } catch (err) {
      console.error(`Failed to delete ${filePath}:`, err.message || err);
    }
  }
}

function main() {
  const rootDir = PATHS.ROOT;
  const dataDir = PATHS.DATA;
  const linkedinOutputDir = PATHS.LINKEDIN.OUTPUT;
  const linkedinSummariesDir = PATHS.LINKEDIN.LOGS.SUMMARIES;
  const linkedinFilteredDir = PATHS.LINKEDIN.LOGS.FILTERED;
  const debugDir = PATHS.DEBUG_ARTIFACTS;
  const deletedFiles = [];

  // NOTE: This script is LINKEDIN-ONLY by design.
  // It must never touch ATS data (see PATHS.ATS).

  // 1. seen_jobs.json – reset LinkedIn deduplication memory
  deleteIfExists(path.join(dataDir, 'seen_jobs.json'), deletedFiles);

  // 2. debug_linkedin_response.json – old LinkedIn debug artifact
  deleteIfExists(
    path.join(debugDir, 'debug_linkedin_response.json'),
    deletedFiles
  );

  // 3. enriched_jobs_*.json – LinkedIn reports in output/linkedin
  let outputFiles;
  try {
    outputFiles = fs.existsSync(linkedinOutputDir)
      ? fs.readdirSync(linkedinOutputDir)
      : [];
  } catch (err) {
    console.error(
      'Failed to read LinkedIn output directory:',
      err.message || err
    );
    outputFiles = [];
  }

  const enrichedPattern = /^enriched_jobs_.*\.json$/i;
  const debugJobDetailsPrefix = 'debug_job_detai';

  outputFiles.forEach((name) => {
    if (enrichedPattern.test(name)) {
      deleteIfExists(path.join(linkedinOutputDir, name), deletedFiles);
    }
  });

  // 4. debug_job_details_*.json – LinkedIn debug artifacts in ./debug_artifacts
  let debugFiles;
  try {
    debugFiles = fs.existsSync(debugDir) ? fs.readdirSync(debugDir) : [];
  } catch (err) {
    console.error(
      'Failed to read debug_artifacts directory:',
      err.message || err
    );
    debugFiles = [];
  }

  debugFiles.forEach((name) => {
    if (name.startsWith(debugJobDetailsPrefix)) {
      deleteIfExists(path.join(debugDir, name), deletedFiles);
    }
  });

  // 5. LinkedIn observability logs in logs/linkedin/{summaries,filtered}
  //    - run_summary_*.json in summaries/
  //    - filtered_jobs_debug_*.json in filtered/

  let summaryFiles;
  try {
    summaryFiles = fs.existsSync(linkedinSummariesDir)
      ? fs.readdirSync(linkedinSummariesDir)
      : [];
  } catch (err) {
    console.error(
      'Failed to read LinkedIn summaries directory:',
      err.message || err
    );
    summaryFiles = [];
  }

  summaryFiles
    .filter((name) => /^run_summary_.*\.json$/i.test(name))
    .forEach((name) => {
      deleteIfExists(path.join(linkedinSummariesDir, name), deletedFiles);
    });

  let filteredFiles;
  try {
    filteredFiles = fs.existsSync(linkedinFilteredDir)
      ? fs.readdirSync(linkedinFilteredDir)
      : [];
  } catch (err) {
    console.error(
      'Failed to read LinkedIn filtered logs directory:',
      err.message || err
    );
    filteredFiles = [];
  }

  filteredFiles
    .filter((name) => /^filtered_jobs_debug_.*\.json$/i.test(name))
    .forEach((name) => {
      deleteIfExists(path.join(linkedinFilteredDir, name), deletedFiles);
    });

  if (deletedFiles.length === 0) {
    console.log('Clean complete (no matching LinkedIn files found).');
  } else {
    console.log(`Clean complete. Total LinkedIn files deleted: ${deletedFiles.length}.`);
  }
}

main();


