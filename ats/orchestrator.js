/**
 * Unified Job Orchestrator
 * 
 * Central controller for all job sources: LinkedIn, Comeet, Greenhouse.
 * Handles deduplication, unified email notifications, and error aggregation.
 */

const path = require('path');
const fs = require('fs');
const { PATHS } = require('../config/paths');

const { loadCompaniesConfig } = require('./config/companiesConfig');
const { createHttpClient } = require('./utils/httpClient');
const { normalizeJob } = require('./utils/normalizeJob');
const { passesLocationGate } = require('./utils/locationGate');
const { passesSemanticGate } = require('./utils/semanticGate');
const { ComeetWorker } = require('./workers/comeetWorker');
const { GreenhouseWorker } = require('./workers/greenhouseWorker');
const { WorkdayWorker } = require('./workers/workdayWorker');

// Workday companies list
let workdayCompanies = [];
try {
  workdayCompanies = require('../data/workday_companies.json');
} catch (err) {
  console.warn('Orchestrator: workday_companies.json not found or invalid:', err.message);
}

// Services
const { jobStateService } = require('../services/JobStateService');
const { emailNotifier } = require('../services/EmailNotifier');

// LinkedIn scraper (optional - may not be available)
let runLinkedinScraper = null;
try {
  const scraperModule = require('../scraper');
  runLinkedinScraper = scraperModule.runLinkedinScraper;
} catch (err) {
  console.warn('Orchestrator: LinkedIn scraper not available:', err.message);
}

const DRY_RUN = process.env.DRY_RUN === 'true';
const SKIP_LINKEDIN = process.env.SKIP_LINKEDIN === 'true';
const SKIP_ATS = process.env.SKIP_ATS === 'true';

// ATS module must only ever write under PATHS.ATS.*.
const OUTPUT_DIR = PATHS.ATS.OUTPUT;
const LOGS_SUMMARIES_DIR = PATHS.ATS.LOGS.SUMMARIES;
const LOGS_FILTERED_DIR = PATHS.ATS.LOGS.FILTERED;

function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    console.error(`Failed to ensure directory ${dirPath}:`, err.message || err);
  }
}

function initRunSummary(totalCompanies) {
  return {
    startTime: new Date().toISOString(),
    endTime: null,
    status: 'IN_PROGRESS',
    companiesTotal: totalCompanies,
    companiesSucceeded: 0,
    companiesFailed: 0,
    companies: [],
  };
}

function initCompanyStats(company) {
  return {
    companyId: company.id,
    source: company.type,
    fetched: 0,
    guardPassed: 0,
    guardDropped: 0,
    guardDroppedByTitle: 0,
    guardDroppedByDepartment: 0,
    guardDroppedByDescription: 0,
    kept: 0,
    droppedLocation: 0,
    droppedSemantic: 0,
    errors: 0,
  };
}

function deriveStatus(runStats, errors) {
  if (errors.length > 0 && runStats.companiesSucceeded === 0) return 'ERROR';
  if (errors.length > 0) return 'PARTIAL_FAIL';
  if (runStats.companiesFailed === 0) return 'SUCCESS';
  if (runStats.companiesSucceeded === 0) return 'ERROR';
  return 'PARTIAL_FAIL';
}

const filteredJobsBuffer = [];

function logFilteredJob(reason, unifiedJob, company) {
  filteredJobsBuffer.push({
    reason,
    title: unifiedJob.title,
    location: unifiedJob.location,
    companyId: company.id,
    source: unifiedJob.source,
  });
}

async function persistResults(allUnifiedJobs, runStats) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  ensureDir(OUTPUT_DIR);
  ensureDir(LOGS_SUMMARIES_DIR);
  ensureDir(LOGS_FILTERED_DIR);

  const jobsFile = path.join(
    OUTPUT_DIR,
    `ats_enriched_jobs_${timestamp}.json`
  );
  const summaryFile = path.join(
    LOGS_SUMMARIES_DIR,
    `ats_run_summary_${timestamp}.json`
  );
  const filteredFile = path.join(
    LOGS_FILTERED_DIR,
    `ats_filtered_jobs_debug_${timestamp}.json`
  );

  if (!DRY_RUN) {
    try {
      fs.writeFileSync(
        jobsFile,
        JSON.stringify(allUnifiedJobs, null, 2),
        'utf-8'
      );
      console.log(`Saved unified jobs to ${jobsFile}`);
    } catch (err) {
      console.error(
        'Failed to write unified jobs file:',
        err.message || err
      );
    }
  } else {
    console.log(
      `[DRY_RUN] Skipping write of unified jobs file (would be ${jobsFile})`
    );
  }

  try {
    fs.writeFileSync(
      summaryFile,
      JSON.stringify(runStats, null, 2),
      'utf-8'
    );
    console.log(`Saved run summary to ${summaryFile}`);
  } catch (err) {
    console.error(
      'Failed to write run summary file:',
      err.message || err
    );
  }

  try {
    fs.writeFileSync(
      filteredFile,
      JSON.stringify(filteredJobsBuffer, null, 2),
      'utf-8'
    );
    console.log(`Saved filtered jobs debug log to ${filteredFile}`);
  } catch (err) {
    console.error(
      'Failed to write filtered jobs debug file:',
      err.message || err
    );
  }
}

/**
 * Process a batch of companies with a specific worker
 * Returns { jobs: [], stats: { succeeded, failed }, errors: [] }
 */
async function processBatch(companies, worker, workerName, progressCallback) {
  const jobs = [];
  const batchErrors = [];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];

    // Report progress
    if (progressCallback) {
      progressCallback(workerName, i + 1, companies.length);
    }

    try {
      const workerResult = await worker.fetchAllJobs(company);
      let rawJobs = workerResult;

      if (workerResult && !Array.isArray(workerResult) && Array.isArray(workerResult.jobs)) {
        rawJobs = workerResult.jobs;
      }

      for (const rawJob of rawJobs || []) {
        if (rawJob && rawJob.jobId) {
          jobs.push(rawJob);
        }
      }
      succeeded += 1;
    } catch (err) {
      failed += 1;
      const errorMsg = err && err.message ? err.message : String(err);
      batchErrors.push({
        source: `${workerName}/${company.id}`,
        message: errorMsg,
      });
    }
  }

  return { jobs, stats: { succeeded, failed }, errors: batchErrors };
}

/**
 * Phase 1: Run ATS workers (Comeet, Greenhouse & Workday) in TRUE PARALLEL
 */
async function runAtsWorkers(errors) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 PHASE 1: ATS Workers (Comeet, Greenhouse & Workday) - PARALLEL');
  console.log('='.repeat(60));

  if (SKIP_ATS) {
    console.log('⏭️  Skipping ATS workers (SKIP_ATS=true)');
    return [];
  }

  const companies = loadCompaniesConfig();

  // Split companies by type
  const comeetCompanies = companies.filter(c => c.type === 'comeet');
  const greenhouseCompanies = companies.filter(c => c.type === 'greenhouse');

  // Workday companies loaded from separate file
  const workdayCompanyCount = workdayCompanies.length;

  console.log(`📂 Loaded ${companies.length + workdayCompanyCount} companies:`);
  console.log(`   Comeet: ${comeetCompanies.length}, Greenhouse: ${greenhouseCompanies.length}, Workday: ${workdayCompanyCount}`);

  const httpClient = createHttpClient();
  const comeetWorker = new ComeetWorker(httpClient);
  const greenhouseWorker = new GreenhouseWorker(httpClient);

  // Reset worker stats
  comeetWorker.resetRunStats();
  greenhouseWorker.resetRunStats();

  // Progress tracking (thread-safe counters)
  let comeetProgress = 0;
  let greenhouseProgress = 0;
  let workdayProgress = 0;
  const comeetTotal = comeetCompanies.length;
  const greenhouseTotal = greenhouseCompanies.length;
  const workdayTotal = workdayCompanyCount;

  // Progress callback that updates console
  const updateProgress = () => {
    process.stdout.write(`\r   Comeet: ${comeetProgress}/${comeetTotal} | Greenhouse: ${greenhouseProgress}/${greenhouseTotal} | Workday: ${workdayProgress}/${workdayTotal}   `);
  };

  console.log(''); // Empty line for progress updates

  // =========================================================================
  // WORKDAY BATCH PROCESSOR (uses instance-per-company pattern)
  // =========================================================================
  async function processWorkdayBatch(wdCompanies, progressCallback) {
    const jobs = [];
    const batchErrors = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < wdCompanies.length; i++) {
      const company = wdCompanies[i];

      if (progressCallback) {
        progressCallback('workday', i + 1, wdCompanies.length);
      }

      try {
        // Workday requires a new worker instance per company (different tenant/site)
        const worker = new WorkdayWorker({
          name: company.name,
          url: company.url
        });

        // fetchAllJobs now returns Array<UnifiedJob> directly
        const companyJobs = await worker.fetchAllJobs(company);

        for (const job of companyJobs || []) {
          if (job && job.jobId) {
            jobs.push(job);
          }
        }
        succeeded += 1;
      } catch (err) {
        failed += 1;
        const errorMsg = err && err.message ? err.message : String(err);
        batchErrors.push({
          source: `workday/${company.id}`,
          message: errorMsg,
        });
        console.error(`\n   [Workday/${company.id}] Error: ${errorMsg}`);
      }
    }

    return { jobs, stats: { succeeded, failed }, errors: batchErrors };
  }

  // Run ALL THREE batches in TRUE PARALLEL
  const [comeetResult, greenhouseResult, workdayResult] = await Promise.all([
    processBatch(comeetCompanies, comeetWorker, 'comeet', (name, current, total) => {
      comeetProgress = current;
      updateProgress();
    }),
    processBatch(greenhouseCompanies, greenhouseWorker, 'greenhouse', (name, current, total) => {
      greenhouseProgress = current;
      updateProgress();
    }),
    processWorkdayBatch(workdayCompanies, (name, current, total) => {
      workdayProgress = current;
      updateProgress();
    }),
  ]);

  console.log(''); // New line after progress

  // Merge results from ALL workers
  const allAtsJobs = [
    ...comeetResult.jobs,
    ...greenhouseResult.jobs,
    ...workdayResult.jobs
  ];

  // Merge errors
  errors.push(
    ...comeetResult.errors,
    ...greenhouseResult.errors,
    ...workdayResult.errors
  );

  // Finalize worker run statistics
  if (typeof comeetWorker.finalizeRun === 'function') {
    comeetWorker.finalizeRun();
  }
  if (typeof greenhouseWorker.finalizeRun === 'function') {
    greenhouseWorker.finalizeRun();
  }

  // Build run stats for persistence (include Workday)
  const totalCompanies = companies.length + workdayCompanyCount;
  const runStats = initRunSummary(totalCompanies);
  runStats.companiesSucceeded = comeetResult.stats.succeeded + greenhouseResult.stats.succeeded + workdayResult.stats.succeeded;
  runStats.companiesFailed = comeetResult.stats.failed + greenhouseResult.stats.failed + workdayResult.stats.failed;
  runStats.endTime = new Date().toISOString();
  runStats.status = deriveStatus(runStats, errors);

  await persistResults(allAtsJobs, runStats);

  // Summary with Workday
  console.log(`✅ ATS Phase complete: ${allAtsJobs.length} jobs`);
  console.log(`   Comeet: ${comeetResult.jobs.length}, Greenhouse: ${greenhouseResult.jobs.length}, Workday: ${workdayResult.jobs.length}`);

  return allAtsJobs;
}


/**
 * Phase 2: Run LinkedIn scraper
 */
async function runLinkedInPhase(errors) {
  console.log('\n' + '='.repeat(60));
  console.log('🔗 PHASE 2: LinkedIn Scraper');
  console.log('='.repeat(60));

  if (SKIP_LINKEDIN) {
    console.log('⏭️  Skipping LinkedIn (SKIP_LINKEDIN=true)');
    return [];
  }

  if (!runLinkedinScraper) {
    console.log('⏭️  LinkedIn scraper not available');
    return [];
  }

  try {
    console.log('🔍 Starting LinkedIn scraper (skipEmail mode)...');
    const linkedinJobs = await runLinkedinScraper({ skipEmail: true });
    console.log(`✅ LinkedIn Phase complete: ${linkedinJobs.length} jobs`);
    return linkedinJobs;
  } catch (err) {
    const errorMsg = err && err.message ? err.message : String(err);
    console.error(`LinkedIn scraper failed: ${errorMsg}`);

    errors.push({
      source: 'LinkedIn',
      message: errorMsg,
    });

    return [];
  }
}

/**
 * Phase 3: Deduplication
 */
function deduplicateJobs(allJobs) {
  console.log('\n' + '='.repeat(60));
  console.log('🔄 PHASE 3: Deduplication');
  console.log('='.repeat(60));

  // Load history
  jobStateService.loadHistory();

  // Filter new jobs
  const newJobs = jobStateService.filterNewJobs(allJobs);

  console.log(`✅ Deduplication complete: ${newJobs.length} new jobs out of ${allJobs.length} total`);

  return newJobs;
}

/**
 * Phase 4: Email Notification
 */
async function sendNotification(newJobs, errors) {
  console.log('\n' + '='.repeat(60));
  console.log('📧 PHASE 4: Email Notification');
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('[DRY_RUN] Skipping email notification');
    return true;
  }

  const success = await emailNotifier.sendUnifiedReport(newJobs, errors);

  if (success) {
    console.log('✅ Email notification sent successfully');
  } else {
    console.log('❌ Email notification failed (see logs above)');
  }

  return success;
}

/**
 * Phase 5: Persist state
 */
function persistState(emailSuccess) {
  console.log('\n' + '='.repeat(60));
  console.log('💾 PHASE 5: Persist State');
  console.log('='.repeat(60));

  if (emailSuccess) {
    jobStateService.persistState();
    console.log('✅ Job history updated');
  } else {
    jobStateService.rollback();
    console.log('⚠️  Rolling back job history (email failed)');
  }
}

/**
 * Main orchestrator run function
 */
async function run() {
  const startTime = Date.now();
  const errors = [];

  console.log('\n' + '🚀'.repeat(30));
  console.log('🤖 UNIFIED JOB ORCHESTRATOR');
  console.log('🚀'.repeat(30));
  console.log(`   Started at: ${new Date().toISOString()}`);
  console.log(`   DRY_RUN: ${DRY_RUN}`);
  console.log(`   SKIP_LINKEDIN: ${SKIP_LINKEDIN}`);
  console.log(`   SKIP_ATS: ${SKIP_ATS}`);
  console.log('   MODE: Parallel Execution ⚡');
  console.log('');

  // ============================================================
  // PARALLEL PHASE: ATS + LinkedIn run simultaneously
  // Runtime = Max(Time_ATS, Time_LinkedIn), not Sum()
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('⚡ PARALLEL PHASE: ATS + LinkedIn (running simultaneously)');
  console.log('='.repeat(60));

  // Create separate error arrays to avoid race conditions
  const atsErrors = [];
  const linkedinErrors = [];

  const [atsResult, linkedinResult] = await Promise.allSettled([
    runAtsWorkers(atsErrors),
    runLinkedInPhase(linkedinErrors),
  ]);

  // Merge errors from both phases
  errors.push(...atsErrors, ...linkedinErrors);

  // Extract ATS jobs (handle rejection gracefully)
  let atsJobs = [];
  if (atsResult.status === 'fulfilled') {
    atsJobs = atsResult.value || [];
  } else {
    console.error('❌ ATS phase failed completely:', atsResult.reason);
    errors.push({
      source: 'ATS Phase',
      message: atsResult.reason?.message || String(atsResult.reason),
    });
  }

  // Extract LinkedIn jobs (handle rejection gracefully)
  let linkedinJobs = [];
  if (linkedinResult.status === 'fulfilled') {
    linkedinJobs = linkedinResult.value || [];
  } else {
    console.error('❌ LinkedIn phase failed completely:', linkedinResult.reason);
    errors.push({
      source: 'LinkedIn Phase',
      message: linkedinResult.reason?.message || String(linkedinResult.reason),
    });
  }

  // Combine all jobs from both phases
  const allJobs = [...atsJobs, ...linkedinJobs];
  console.log(`\n📊 Total jobs collected: ${allJobs.length} (ATS: ${atsJobs.length}, LinkedIn: ${linkedinJobs.length})`);

  // Phase 3: Deduplication
  const newJobs = deduplicateJobs(allJobs);

  // Phase 4: Email Notification
  const emailSuccess = await sendNotification(newJobs, errors);

  // Phase 5: Persist State
  persistState(emailSuccess);

  // Final Summary
  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  console.log('\n' + '='.repeat(60));
  console.log('📋 FINAL SUMMARY');
  console.log('='.repeat(60));
  console.log(`   Total jobs fetched: ${allJobs.length}`);
  console.log(`   New jobs (after dedup): ${newJobs.length}`);
  console.log(`   Errors: ${errors.length}`);
  console.log(`   Email sent: ${emailSuccess ? 'Yes' : 'No'}`);
  console.log(`   Duration: ${totalDuration}s (parallel execution)`);
  console.log('='.repeat(60) + '\n');

  // Return summary for testing
  return {
    totalJobs: allJobs.length,
    newJobs: newJobs.length,
    errors: errors.length,
    emailSuccess,
    duration: totalDuration,
  };
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Orchestrator failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { run };
