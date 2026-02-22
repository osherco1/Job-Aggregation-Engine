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

// LinkedIn-only accepted jobs viewer.
const OUTPUT_DIR = PATHS.LINKEDIN.OUTPUT;

function color(colorFn, text) {
  if (colorFn && typeof colorFn === 'function') {
    return colorFn(text);
  }
  return text;
}

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`Output directory not found: ${OUTPUT_DIR}`);
    console.log('Total files scanned: 0, Total jobs found: 0');
    return;
  }

  const allFiles = fs.readdirSync(OUTPUT_DIR);
  const enrichedFiles = allFiles
    .filter((name) => /^enriched_jobs_.*\.json$/i.test(name))
    // Sort by filename descending, which matches chronological order for the
    // ISO-like timestamps used in the filenames (newest first).
    .sort((a, b) => {
      if (a < b) return 1;
      if (a > b) return -1;
      return 0;
    });

  if (enrichedFiles.length === 0) {
    console.log('No enriched_jobs_*.json files found in output directory.');
    console.log('Total files scanned: 0, Total jobs found: 0');
    return;
  }

  let totalJobs = 0;

  enrichedFiles.forEach((fileName) => {
    const fullPath = path.join(OUTPUT_DIR, fileName);
    const header = `--- ${fileName} ---`;
    console.log(color(chalk && chalk.yellow, header));

    let raw;
    try {
      raw = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      console.error(`Failed to read ${fileName}:`, err.message || err);
      return;
    }

    let jobs;
    try {
      jobs = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to parse JSON in ${fileName}:`, err.message || err);
      return;
    }

    if (!Array.isArray(jobs)) {
      console.log('  (File does not contain an array of jobs)');
      return;
    }

    jobs.forEach((job, index) => {
      const title = job && job.title ? String(job.title) : 'Untitled';
      const company =
        job && job.company ? String(job.company) : 'Unknown company';
      const line = `${index + 1}. ${title} @ ${company}`;
      console.log(color(chalk && chalk.cyan, line));
    });

    totalJobs += jobs.length;
    console.log(); // Blank line between files for readability.
  });

  console.log(
    `Total files scanned: ${enrichedFiles.length}, Total jobs found: ${totalJobs}`
  );
}

if (require.main === module) {
  main();
}

module.exports = { main };


