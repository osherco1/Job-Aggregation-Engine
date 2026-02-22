const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../config/paths');

// LinkedIn-only archive configuration.
const LINKEDIN_LOGS_SUMMARIES_DIR = PATHS.LINKEDIN.LOGS.SUMMARIES;
const LINKEDIN_LOGS_FILTERED_DIR = PATHS.LINKEDIN.LOGS.FILTERED;
const LINKEDIN_OUTPUT_DIR = PATHS.LINKEDIN.OUTPUT;
const LINKEDIN_DEBUG_DIR = PATHS.DEBUG_ARTIFACTS;
// Archive location dedicated to LinkedIn artifacts.
const LINKEDIN_ARCHIVE_DIR = PATHS.LINKEDIN.LOGS.ARCHIVE;

// Dynamic cutoff date: "today" at local midnight.
// Any file strictly BEFORE this date is archived; this date and after are kept.
const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
const CUTOFF_DATE_STR = `${year}-${month}-${day}`;
// Local midnight for today (00:00:00 local time).
const CUTOFF_DATE = new Date(year, now.getMonth(), now.getDate(), 0, 0, 0, 0);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Try to extract a YYYY-MM-DD date substring from a filename.
 * Returns the date string or null if no such pattern is found.
 */
function extractDateFromFilename(fileName) {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(fileName);
  return match ? match[1] : null;
}

/**
 * Decide whether a given file should be archived based on filename date if
 * present, otherwise fall back to the file's mtime.
 */
function shouldArchiveFile(name, stats) {
  const dateFromName = extractDateFromFilename(name);

  if (dateFromName) {
    // Lexicographic comparison is valid for YYYY-MM-DD formatted strings.
    return dateFromName < CUTOFF_DATE_STR;
  }

  // No parsable date in the filename; fall back to modification time.
  return stats.mtime < CUTOFF_DATE;
}

function processDirectory(baseDir, label, prefixes, archiveDir) {
  if (!fs.existsSync(baseDir)) {
    console.warn(`Skipping missing ${label} directory: ${baseDir}`);
    return { archived: 0, kept: 0 };
  }

  const entries = fs.readdirSync(baseDir);
  let archived = 0;
  let kept = 0;

  entries.forEach((name) => {
    const fullPath = path.join(baseDir, name);
    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch (err) {
      console.error(`Failed to stat ${label} entry ${name}:`, err.message || err);
      return;
    }

    if (!stats.isFile()) {
      return;
    }

    // Skip analysis_state.json explicitly (logs helper file).
    if (label === 'logs' && name === 'analysis_state.json') {
      return;
    }

    // Only process files with the configured prefixes.
    const matchesPrefix = prefixes.some((p) => name.startsWith(p));
    if (!matchesPrefix) {
      return;
    }

    if (shouldArchiveFile(name, stats)) {
      const destPath = path.join(archiveDir, name);
      try {
        fs.renameSync(fullPath, destPath);
        console.log(`Archived (${label}): ${name} -> archive/`);
        archived += 1;
      } catch (err) {
        console.error(`Failed to archive ${label} file ${name}:`, err.message || err);
      }
    } else {
      console.log(`Keeping recent ${label} file: ${name}`);
      kept += 1;
    }
  });

  return { archived, kept };
}

function main() {
  // NOTE: This archiver is LinkedIn-only by design. It must not touch ATS logs.
  ensureDir(LINKEDIN_ARCHIVE_DIR);
  console.log(
    `LinkedIn archiver running with cutoff date ${CUTOFF_DATE_STR} (files before this go to logs/linkedin/archive/)...`
  );

  const logsSummariesResult = processDirectory(
    LINKEDIN_LOGS_SUMMARIES_DIR,
    'LinkedIn logs (summaries)',
    ['run_summary_'],
    LINKEDIN_ARCHIVE_DIR
  );

  const logsFilteredResult = processDirectory(
    LINKEDIN_LOGS_FILTERED_DIR,
    'LinkedIn logs (filtered)',
    ['filtered_jobs_debug_'],
    LINKEDIN_ARCHIVE_DIR
  );

  const outputResult = processDirectory(
    LINKEDIN_OUTPUT_DIR,
    'LinkedIn output',
    ['enriched_jobs_'],
    LINKEDIN_ARCHIVE_DIR
  );

  const debugResult = processDirectory(
    LINKEDIN_DEBUG_DIR,
    'LinkedIn debug_artifacts',
    ['debug_job_details_', 'debug_linkedin_response'],
    LINKEDIN_ARCHIVE_DIR
  );

  const totalArchived =
    logsSummariesResult.archived +
    logsFilteredResult.archived +
    outputResult.archived +
    debugResult.archived;
  const totalKept =
    logsSummariesResult.kept +
    logsFilteredResult.kept +
    outputResult.kept +
    debugResult.kept;

  console.log('----------------------------------------');
  console.log(`Archiving completed.`);
  console.log(
    `LinkedIn logs (summaries): archived ${logsSummariesResult.archived}, kept ${logsSummariesResult.kept}`
  );
  console.log(
    `LinkedIn logs (filtered): archived ${logsFilteredResult.archived}, kept ${logsFilteredResult.kept}`
  );
  console.log(
    `LinkedIn output: archived ${outputResult.archived}, kept ${outputResult.kept}`
  );
  console.log(
    `LinkedIn debug artifacts: archived ${debugResult.archived}, kept ${debugResult.kept}`
  );
  console.log(
    `Total: archived ${totalArchived} files, kept ${totalKept} files.`
  );
}

if (require.main === module) {
  main();
}

module.exports = { main };
