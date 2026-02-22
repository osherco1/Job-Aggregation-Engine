const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../config/paths');

let chalk;
try {
  // Optional dependency: use colored logs if available.
  // Falls back to plain console.log if chalk is not installed.
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  chalk = require('chalk');
} catch (e) {
  chalk = null;
}

// LinkedIn-only rejected jobs viewer.
const LOGS_DIR = PATHS.LINKEDIN.LOGS.FILTERED;

function color(colorFn, text) {
  if (colorFn && typeof colorFn === 'function') {
    return colorFn(text);
  }
  return text;
}

function main() {
  if (!fs.existsSync(LOGS_DIR)) {
    console.error(`Logs directory not found: ${LOGS_DIR}`);
    console.log('Total rejected jobs found: 0');
    return;
  }

  const allFiles = fs.readdirSync(LOGS_DIR);

  // Filter to only the filtered_jobs_debug_*.json files and attach mtime for sorting.
  const filteredLogFiles = allFiles
    .filter((name) => /^filtered_jobs_debug_.*\.json$/i.test(name))
    .map((name) => {
      const fullPath = path.join(LOGS_DIR, name);
      try {
        const stats = fs.statSync(fullPath);
        return { name, fullPath, mtimeMs: stats.mtimeMs };
      } catch (err) {
        console.error(`Failed to stat ${name}:`, err.message || err);
        return null;
      }
    })
    .filter(Boolean)
    // Newest files first by modification time.
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (filteredLogFiles.length === 0) {
    console.log('No filtered_jobs_debug_*.json files found in logs directory.');
    console.log('Total rejected jobs found: 0');
    return;
  }

  let totalRejected = 0;

  filteredLogFiles.forEach(({ name, fullPath }) => {
    const header = `=== Log: ${name} ===`;
    console.log(color(chalk && chalk.cyan, header));

    let raw;
    try {
      raw = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      console.error(`Failed to read ${name}:`, err.message || err);
      console.log(); // blank line between files
      return;
    }

    let entries;
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to parse JSON in ${name}:`, err.message || err);
      console.log(); // blank line between files
      return;
    }

    if (!Array.isArray(entries)) {
      console.log('  (File does not contain an array of rejected jobs)');
      console.log(); // blank line between files
      return;
    }

    entries.forEach((job) => {
      const title = job && job.title ? String(job.title) : 'Untitled';
      const company =
        job && job.company ? String(job.company) : 'Unknown company';
      const reason = job && job.reason ? String(job.reason) : 'Unknown reason';

      const reasonText = color(chalk && chalk.red, reason);
      const line = `${title} @ ${company} -> REJECTED: ${reasonText}`;
      console.log(line);
      totalRejected += 1;
    });

    console.log(); // blank line between files
  });

  console.log(`Total rejected jobs found: ${totalRejected}`);
}

if (require.main === module) {
  main();
}

module.exports = { main };


