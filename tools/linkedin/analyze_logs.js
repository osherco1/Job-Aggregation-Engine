const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../config/paths');

const PROJECT_ROOT = PATHS.ROOT;
const LINKEDIN_LOGS_SUMMARIES_DIR = PATHS.LINKEDIN.LOGS.SUMMARIES;
const LINKEDIN_LOGS_FILTERED_DIR = PATHS.LINKEDIN.LOGS.FILTERED;
const OUTPUT_DIR = PATHS.LINKEDIN.OUTPUT;
const ANALYZE_DIR = path.join(PROJECT_ROOT, 'docs', 'analyze');

// Simple buffered logger for the main report output
const logBuffer = [];
function log(message = '') {
  const text = String(message);
  console.log(text);
  logBuffer.push(text);
}

function ensureAnalyzeDir() {
  try {
    fs.mkdirSync(ANALYZE_DIR, { recursive: true });
  } catch (err) {
    console.error(
      `Failed to ensure analyze output directory at ${ANALYZE_DIR}:`,
      err.message || err
    );
  }
}

function buildReportFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  return `calibration_report_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.txt`;
}

function buildAcceptedJobsSection() {
  const lines = [];
  let total = 0;

  if (!fs.existsSync(OUTPUT_DIR)) {
    lines.push('Output directory not found; no accepted jobs to display.');
    return { lines, total };
  }

  let files;
  try {
    files = fs.readdirSync(OUTPUT_DIR);
  } catch (err) {
    lines.push(`Failed to read output directory: ${err.message || err}`);
    return { lines, total };
  }

  const enrichedFiles = files
    .filter((name) => /^enriched_jobs_.*\.json$/i.test(name))
    .sort();

  if (!enrichedFiles.length) {
    lines.push('No enriched_jobs_*.json files found; no accepted jobs to display.');
    return { lines, total };
  }

  let index = 1;

  enrichedFiles.forEach((fileName) => {
    const fullPath = path.join(OUTPUT_DIR, fileName);

    let raw;
    try {
      raw = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      lines.push(`Failed to read ${fileName}: ${err.message || err}`);
      return;
    }

    let jobs;
    try {
      jobs = JSON.parse(raw);
    } catch (err) {
      lines.push(`Failed to parse JSON in ${fileName}: ${err.message || err}`);
      return;
    }

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return;
    }

    jobs.forEach((job) => {
      const title = job && job.title ? String(job.title) : 'Untitled';
      const company =
        job && job.company ? String(job.company) : 'Unknown company';
      lines.push(`${index}. ${title} @ ${company}`);
      index += 1;
      total += 1;
    });
  });

  if (!total) {
    lines.push('No accepted jobs found across active files.');
  }

  return { lines, total };
}

function buildRejectedJobsSection() {
  const lines = [];
  let total = 0;

  if (!fs.existsSync(LINKEDIN_LOGS_FILTERED_DIR)) {
    lines.push('LinkedIn filtered logs directory not found; no rejected jobs to display.');
    return { lines, total };
  }

  let files;
  try {
    files = fs.readdirSync(LINKEDIN_LOGS_FILTERED_DIR);
  } catch (err) {
    lines.push(
      `Failed to read LinkedIn filtered logs directory: ${err.message || err}`
    );
    return { lines, total };
  }

  const rejectedFiles = files
    .filter((name) => /^filtered_jobs_debug_.*\.json$/i.test(name))
    .sort();

  if (!rejectedFiles.length) {
    lines.push(
      'No filtered_jobs_debug_*.json files found; no rejected jobs to display.'
    );
    return { lines, total };
  }

  let index = 1;

  rejectedFiles.forEach((fileName) => {
    const fullPath = path.join(LINKEDIN_LOGS_FILTERED_DIR, fileName);

    let raw;
    try {
      raw = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      lines.push(`Failed to read ${fileName}: ${err.message || err}`);
      return;
    }

    let entries;
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      lines.push(`Failed to parse JSON in ${fileName}: ${err.message || err}`);
      return;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    entries.forEach((job) => {
      const title = job && job.title ? String(job.title) : 'Untitled';
      const company =
        job && job.company ? String(job.company) : 'Unknown company';
      const reason = job && job.reason ? String(job.reason) : 'Unknown reason';
      lines.push(
        `${index}. ${title} @ ${company} -> REJECTED: ${reason}`
      );
      index += 1;
      total += 1;
    });
  });

  if (!total) {
    lines.push('No rejected jobs found across active files.');
  }

  return { lines, total };
}

function readRunSummaries() {
  let files;
  try {
    files = fs.existsSync(LINKEDIN_LOGS_SUMMARIES_DIR)
      ? fs.readdirSync(LINKEDIN_LOGS_SUMMARIES_DIR)
      : [];
  } catch (err) {
    console.error(
      'Failed to read LinkedIn summaries directory:',
      err.message || err
    );
    return [];
  }

  const summaryFiles = files.filter((name) =>
    /^run_summary_.*\.json$/i.test(name)
  );

  const runs = [];

  for (const name of summaryFiles) {
    const fullPath = path.join(LINKEDIN_LOGS_SUMMARIES_DIR, name);
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(raw);
      const match = name.match(/^run_summary_(.+)\.json$/i);
      const timestamp = match ? match[1] : null;
      let endTime = data.endTime || data.startTime || null;
      let endDate = null;
      if (endTime) {
        const d = new Date(endTime);
        if (!Number.isNaN(d.getTime())) {
          endDate = d;
        }
      }
      runs.push({ file: name, data, endDate, timestamp });
    } catch (err) {
      console.error(
        `Failed to read or parse ${fullPath}:`,
        err.message || err
      );
    }
  }

  runs.sort((a, b) => {
    if (!a.endDate && !b.endDate) return 0;
    if (!a.endDate) return 1;
    if (!b.endDate) return -1;
    return b.endDate - a.endDate;
  });

  return runs;
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'N/A';
  return `${seconds.toFixed(1)}s`;
}

function main() {
  const allRuns = readRunSummaries();
  const selectedRuns = allRuns;

  const totalRuns = selectedRuns.length;

  let successRuns = 0;
  let totalDurationSec = 0;
  let durationCount = 0;
  let totalQuotaHits = 0;
  let totalQueriesRun = 0;
  let totalBlacklist = 0;
  let totalWhitelist = 0;
  let totalAlreadySeen = 0;
  let totalReposts = 0;
  let totalErrors = 0;
  const runsWithErrors = [];
  const queryAgg = {}; // { [query]: { rawTotal, newTotal, runsWithData, zeroRawRuns } }

  for (const { file, data } of selectedRuns) {
    const status = data.status || 'UNKNOWN';
    if (status === 'SUCCESS' || status === 'QUOTA_REACHED') {
      successRuns += 1;
    }

    const start = data.startTime ? new Date(data.startTime) : null;
    const end = data.endTime ? new Date(data.endTime) : null;
    if (
      start &&
      end &&
      !Number.isNaN(start.getTime()) &&
      !Number.isNaN(end.getTime())
    ) {
      const dur = (end.getTime() - start.getTime()) / 1000;
      if (dur >= 0) {
        totalDurationSec += dur;
        durationCount += 1;
      }
    }

    const filteredOut = data.filteredOut || {};
    const errors = typeof data.errors === 'number' ? data.errors : 0;

    totalQuotaHits += filteredOut.quotaHit ? 1 : 0;
    totalQueriesRun += typeof data.totalQueries === 'number' ? data.totalQueries : 0;
    totalBlacklist += typeof filteredOut.blacklist === 'number' ? filteredOut.blacklist : 0;
    totalWhitelist += typeof filteredOut.whitelist === 'number' ? filteredOut.whitelist : 0;
    totalAlreadySeen +=
      typeof filteredOut.alreadySeen === 'number' ? filteredOut.alreadySeen : 0;
    totalReposts += typeof data.repostsDetected === 'number' ? data.repostsDetected : 0;
    totalErrors += errors;

    if (errors > 0) {
      runsWithErrors.push({ file, errors, status });
    }

    // Aggregate per-query performance if present
    const queryLog = data.queryLog || {};
    Object.entries(queryLog).forEach(([query, stats]) => {
      if (!queryAgg[query]) {
        queryAgg[query] = {
          rawTotal: 0,
          newTotal: 0,
          runsWithData: 0,
          zeroRawRuns: 0,
        };
      }
      const raw = typeof stats.raw === 'number' ? stats.raw : 0;
      const nw = typeof stats.new === 'number' ? stats.new : 0;
      const agg = queryAgg[query];
      agg.rawTotal += raw;
      agg.newTotal += nw;
      agg.runsWithData += 1;
      if (raw === 0) {
        agg.zeroRawRuns += 1;
      }
    });
  }

  const successRate = totalRuns
    ? ((successRuns / totalRuns) * 100).toFixed(1)
    : '0.0';
  const avgDurationSec =
    durationCount > 0 ? totalDurationSec / durationCount : NaN;

  // Empty responses per-query are not currently tracked in run logs.
  const emptyResponsesNote =
    'N/A (per-query zero-result counters are not yet tracked in run logs)';

  const runsWithUniqueErrorSummaries = runsWithErrors.slice(0, 5).map((r) => {
    return `Run file: ${r.file} | errors: ${r.errors} | status: ${r.status}`;
  });

  const errorRateNote = totalRuns
    ? `${totalErrors} total errors across ${totalRuns} runs, ` +
    `${runsWithErrors.length} run(s) with non-zero errors`
    : 'No runs available to compute error rate.';

  // Derive dead queries (consistently zero raw results) and top performers.
  const deadQueries = Object.entries(queryAgg)
    .filter(([, agg]) => agg.runsWithData > 0 && agg.rawTotal === 0)
    .sort(([, a], [, b]) => b.zeroRawRuns - a.zeroRawRuns);

  const topPerformers = Object.entries(queryAgg)
    .filter(([, agg]) => agg.newTotal > 0 && agg.runsWithData > 0)
    .map(([query, agg]) => ({
      query,
      avgNewPerRun: agg.newTotal / agg.runsWithData,
      runsWithData: agg.runsWithData,
    }))
    .sort((a, b) => b.avgNewPerRun - a.avgNewPerRun)
    .slice(0, 5);

  const reportLines = [];
  reportLines.push('=== SYSTEM HEALTH REPORT ===');
  reportLines.push('Scope: All Runs');
  reportLines.push('');
  reportLines.push('1. Health Overview');
  reportLines.push(`   - Success Rate: ${successRate}%`);
  reportLines.push(`   - Avg Duration: ${formatSeconds(avgDurationSec)}`);
  reportLines.push(`   - Total Quota Hits: ${totalQuotaHits}`);
  reportLines.push('');
  reportLines.push('2. Search Efficiency');
  reportLines.push(`   - Total Queries Run: ${totalQueriesRun}`);
  reportLines.push(
    `   - Empty Responses (Zero Results): ${emptyResponsesNote}`
  );
  reportLines.push('');
  reportLines.push('3. Filtering Calibration');
  reportLines.push(`   - Blacklist Rejections: ${totalBlacklist}`);
  reportLines.push(
    `   - Whitelist Rejections: ${totalWhitelist} (If high, review whitelist keywords)`
  );
  reportLines.push(`   - Reposts Detected: ${totalReposts}`);
  reportLines.push('');
  reportLines.push('4. Recent Errors');
  if (runsWithUniqueErrorSummaries.length === 0) {
    reportLines.push('   - No errors recorded in the analyzed runs.');
  } else {
    runsWithUniqueErrorSummaries.forEach((line) => {
      reportLines.push(`   - ${line}`);
    });
  }
  reportLines.push('');
  reportLines.push(`(Error rate summary: ${errorRateNote})`);
  reportLines.push('');
  reportLines.push('5. Matrix Calibration (Dead Queries)');
  if (!deadQueries.length) {
    reportLines.push('   - None detected in this scope.');
  } else {
    reportLines.push('   - The following queries returned 0 results:');
    deadQueries.forEach(([query, agg]) => {
      reportLines.push(
        `     * "${query}" (Failed ${agg.zeroRawRuns} times)`
      );
    });
  }
  reportLines.push('');
  reportLines.push('6. Top Performers');
  if (!topPerformers.length) {
    reportLines.push('   - No queries with non-zero yield in this scope.');
  } else {
    topPerformers.forEach((item) => {
      reportLines.push(
        `     * "${item.query}" (Avg ${item.avgNewPerRun.toFixed(
          2
        )} jobs/run over ${item.runsWithData} runs)`
      );
    });
  }

  // Accepted jobs (all active files)
  const accepted = buildAcceptedJobsSection();
  reportLines.push('');
  reportLines.push('=== ✅ ACCUMULATED ACCEPTED JOBS (All Active Files) ===');
  accepted.lines.forEach((line) => reportLines.push(line));
  if (accepted.total) {
    reportLines.push(`(Total: ${accepted.total})`);
  }

  // Rejected jobs (all active files)
  const rejected = buildRejectedJobsSection();
  reportLines.push('');
  reportLines.push('=== 🚫 ACCUMULATED REJECTED JOBS (All Active Files) ===');
  rejected.lines.forEach((line) => reportLines.push(line));
  if (rejected.total) {
    reportLines.push(`(Total: ${rejected.total})`);
  }

  const reportText = reportLines.join('\n');
  log(reportText);

  // Persist buffered report to file
  ensureAnalyzeDir();
  try {
    const now = new Date();
    const fileName = buildReportFilename(now);
    const filePath = path.join(ANALYZE_DIR, fileName);
    const fileContents = logBuffer.join('\n');
    fs.writeFileSync(filePath, fileContents, 'utf-8');

    const relativePath = path.relative(PROJECT_ROOT, filePath);
    console.log(`📝 Report saved to: ${relativePath}`);
  } catch (err) {
    console.error('Failed to save calibration report:', err.message || err);
  }
}

main();


