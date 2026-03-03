/**
 * Unified Job Orchestrator
 * 
 * Central controller for all job sources: LinkedIn, Comeet, Greenhouse.
 * Handles deduplication, unified email notifications, and error aggregation.
 */

const path = require('path');
const { PATHS } = require('../config/paths');
const { createStorageAdapter } = require('../services/storage');

const { loadCompaniesConfig } = require('./config/companiesConfig');
const { createHttpClient } = require('./utils/httpClient');
const { normalizeJob } = require('./utils/normalizeJob');
const { passesLocationGate } = require('./utils/locationGate');
const { passesSemanticGate } = require('./utils/semanticGate');
const { ComeetWorker } = require('./workers/comeetWorker');
const { GreenhouseWorker } = require('./workers/greenhouseWorker');
const { WorkdayWorker } = require('./workers/workdayWorker');
const { LinkedInAuthChallengeError } = require('../linkedin_client');
const { sendCriticalAlert } = require('../mailer');
const { checkVolumeTrigger, runCalibrationAndNotify } = require('../services/calibration/calibrationReport');

// Services (factories - will be called in run() function)
const { createJobStateService } = require('../services/JobStateService');
const { createEmailNotifier } = require('../services/EmailNotifier');

// LinkedIn scraper (optional - may not be available)
let runLinkedinScraper = null;
try {
  const scraperModule = require('../scraper');
  runLinkedinScraper = scraperModule.runLinkedinScraper;
} catch (err) {
  console.warn('Orchestrator: LinkedIn scraper not available:', err.message);
}

// #region agent log
const _dbgLog=(m,d,h)=>{try{require('fs').appendFileSync(require('path').join(__dirname,'..', '.cursor','debug.log'),JSON.stringify({location:m,data:d,hypothesisId:h,timestamp:Date.now()})+'\n');}catch(_){}};
// #endregion
const DRY_RUN = process.env.DRY_RUN === 'true';
const SKIP_LINKEDIN = process.env.SKIP_LINKEDIN === 'true';
const SKIP_ATS = process.env.SKIP_ATS === 'true';

// ATS module must only ever write under PATHS.ATS.*.
const OUTPUT_DIR = PATHS.ATS.OUTPUT;
const LOGS_SUMMARIES_DIR = PATHS.ATS.LOGS.SUMMARIES;
const LOGS_FILTERED_DIR = PATHS.ATS.LOGS.FILTERED;

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

async function persistResults(allUnifiedJobs, runStats, storageAdapter) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // FIX 1: Replaced writeEnrichedJobs (bloated) with calibration_passed.
  // calibration_passed is now written AFTER dedup+email in run(), not here.
  // This eliminates the massive enriched_jobs collection.
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Skipping write of unified jobs`);
  }

  // Write run summary (now routed to run_summaries collection with 30-day TTL)
  try {
    await storageAdapter.writeRunLog({
      type: 'summary',
      source: 'ats',
      timestamp,
      payload: runStats,
    });
    console.log(`Saved run summary via storage adapter`);
  } catch (err) {
    console.error(
      'Failed to write run summary:',
      err.message || err
    );
  }

  // Workers persist their own dropped jobs to calibration_rejected; no orchestrator-level buffer.
}

/**
 * Process a batch of companies with a specific worker
 * Returns { jobs: [], stats: { succeeded, failed }, errors: [] }
 */
async function processBatch(companies, worker, workerName, progressCallback, knownJobIds) {
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
      const workerResult = await worker.fetchAllJobs(company, knownJobIds);
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
async function runAtsWorkers(errors, storageAdapter, knownJobIds) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 PHASE 1: ATS Workers (Comeet, Greenhouse & Workday) - PARALLEL');
  console.log('='.repeat(60));

  if (SKIP_ATS) {
    console.log('⏭️  Skipping ATS workers (SKIP_ATS=true)');
    return [];
  }

  const companies = await loadCompaniesConfig(storageAdapter);
  
  // Filter workday companies from the merged list
  const workdayCompanies = companies.filter(c => c.type === 'workday');

  // Split companies by type
  const comeetCompanies = companies.filter(c => c.type === 'comeet');
  const greenhouseCompanies = companies.filter(c => c.type === 'greenhouse');

  const workdayCompanyCount = workdayCompanies.length;

  console.log(`📂 Loaded ${companies.length + workdayCompanyCount} companies:`);
  console.log(`   Comeet: ${comeetCompanies.length}, Greenhouse: ${greenhouseCompanies.length}, Workday: ${workdayCompanyCount}`);

  const httpClient = createHttpClient();
  const comeetWorker = new ComeetWorker(httpClient, storageAdapter);
  const greenhouseWorker = new GreenhouseWorker(httpClient, storageAdapter);

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
    const workdayRunStats = [];

    for (let i = 0; i < wdCompanies.length; i++) {
      const company = wdCompanies[i];

      if (progressCallback) {
        progressCallback('workday', i + 1, wdCompanies.length);
      }

      try {
        const worker = new WorkdayWorker(
          { name: company.name, url: company.url },
          { storageAdapter, knownJobIds }
        );

        const { jobs: companyJobs, stats: companyStats } = await worker.fetchAllJobs(company);

        for (const job of companyJobs || []) {
          if (job && job.jobId) {
            jobs.push(job);
          }
        }
        workdayRunStats.push({ companyId: company.id, companyName: company.name, ...companyStats });
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

    return { jobs, stats: { succeeded, failed }, errors: batchErrors, workdayRunStats };
  }

  // Run ALL THREE batches in TRUE PARALLEL
  const [comeetResult, greenhouseResult, workdayResult] = await Promise.all([
    processBatch(comeetCompanies, comeetWorker, 'comeet', (name, current, total) => {
      comeetProgress = current;
      updateProgress();
    }, knownJobIds),
    processBatch(greenhouseCompanies, greenhouseWorker, 'greenhouse', (name, current, total) => {
      greenhouseProgress = current;
      updateProgress();
    }, knownJobIds),
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
    await comeetWorker.finalizeRun();
  }
  if (typeof greenhouseWorker.finalizeRun === 'function') {
    await greenhouseWorker.finalizeRun();
  }

  // Build run stats for persistence (include Workday)
  const totalCompanies = companies.length + workdayCompanyCount;
  const runStats = initRunSummary(totalCompanies);
  runStats.companiesSucceeded = comeetResult.stats.succeeded + greenhouseResult.stats.succeeded + workdayResult.stats.succeeded;
  runStats.companiesFailed = comeetResult.stats.failed + greenhouseResult.stats.failed + workdayResult.stats.failed;
  runStats.endTime = new Date().toISOString();
  runStats.status = deriveStatus(runStats, errors);

  await persistResults(allAtsJobs, runStats, storageAdapter);

  // Dual-trigger calibration (Master PRD): volume >= 350MB OR time >= 7 days since last calibration
  try {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const volumeTriggered = await checkVolumeTrigger(storageAdapter);
    const lastCal = typeof storageAdapter.getLastCalibrationTime === 'function'
      ? await storageAdapter.getLastCalibrationTime()
      : new Date(0);
    const timeTriggered = (Date.now() - lastCal.getTime()) >= SEVEN_DAYS_MS;

    if (volumeTriggered || timeTriggered) {
      const triggerType = volumeTriggered ? 'volume' : 'time';
      console.log(`Calibration trigger: ${triggerType} (volume=${volumeTriggered}, timeSinceLastCal=${Math.round((Date.now() - lastCal.getTime()) / 3600000)}h)`);
      const emailNotifier = createEmailNotifier();
      const ok = await runCalibrationAndNotify(storageAdapter, emailNotifier, triggerType);
      if (ok && typeof storageAdapter.updateLastCalibrationTime === 'function') {
        await storageAdapter.updateLastCalibrationTime();
        console.log('Calibration timer reset');
      }
    }
  } catch (calErr) {
    console.warn('Calibration check failed:', calErr.message || calErr);
  }

  // Summary with Workday
  console.log(`✅ ATS Phase complete: ${allAtsJobs.length} jobs`);
  console.log(`   Comeet: ${comeetResult.jobs.length}, Greenhouse: ${greenhouseResult.jobs.length}, Workday: ${workdayResult.jobs.length}`);

  return allAtsJobs;
}


/**
 * Phase 2: Run LinkedIn scraper
 */
async function runLinkedInPhase(errors, storageAdapter) {
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
    const result = await runLinkedinScraper({ skipEmail: true, storage: storageAdapter });
    const linkedinJobs = result.jobs || [];
    const scraperErrors = result.errors || [];

    // Surface any fetch/detail errors from the scraper into the orchestrator's error list
    if (scraperErrors.length > 0) {
      console.warn(`⚠️  LinkedIn scraper encountered ${scraperErrors.length} non-fatal error(s)`);
      errors.push(...scraperErrors);
    }

    console.log(`✅ LinkedIn Phase complete: ${linkedinJobs.length} jobs`);
    return linkedinJobs;
  } catch (err) {
    const errorMsg = err && err.message ? err.message : String(err);
    
    // Handle critical auth challenge
    if (err instanceof LinkedInAuthChallengeError) {
      console.error('🛑 CRITICAL: LinkedIn authentication challenge detected');
      try {
        await sendCriticalAlert(err.details);
      } catch (alertErr) {
        console.error('Failed to send critical alert:', alertErr.message || alertErr);
      }
      errors.push({
        source: 'LinkedIn',
        message: 'CRITICAL_AUTH_CHALLENGE - LinkedIn authentication failed',
        details: err.details,
      });
    } else {
      console.error(`LinkedIn scraper failed: ${errorMsg}`);
      errors.push({
        source: 'LinkedIn',
        message: errorMsg,
      });
    }

    return [];
  }
}

/**
 * Phase 3: Deduplication
 */
async function deduplicateJobs(allJobs, jobStateService) {
  console.log('\n' + '='.repeat(60));
  console.log('🔄 PHASE 3: Deduplication');
  console.log('='.repeat(60));

  // Filter new jobs (loadHistory is called inside filterNewJobs)
  const newJobs = await jobStateService.filterNewJobs(allJobs);

  console.log(`✅ Deduplication complete: ${newJobs.length} new jobs out of ${allJobs.length} total`);

  return newJobs;
}

/**
 * Phase 4: Email Notification
 *
 * Gatekeeper rules (to avoid ~32 "no jobs" emails per day on a 45-min schedule):
 *   1. ALWAYS send if new jobs were found.
 *   2. ALWAYS send if any errors occurred (LinkedIn blocks, ATS failures, etc.).
 *   3. Send once per day at the heartbeat hour (UTC 6 = 08:00 Israel time) as a "sign of life".
 *   4. Otherwise, skip the email — the run is still logged to Cloud Run + MongoDB.
 */
async function sendNotification(newJobs, errors, emailNotifier) {
  console.log('\n' + '='.repeat(60));
  console.log('📧 PHASE 4: Email Notification');
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('[DRY_RUN] Skipping email notification');
    return true;
  }

  const hasNewJobs = Array.isArray(newJobs) && newJobs.length > 0;
  const hasErrors = Array.isArray(errors) && errors.length > 0;
  const isHeartbeatHour = new Date().getUTCHours() === 6;

  if (!hasNewJobs && !hasErrors && !isHeartbeatHour) {
    console.log('Skip sending empty report (no jobs, no errors, not heartbeat hour)');
    return true;
  }

  // Log which gate triggered the email
  const triggers = [];
  if (hasNewJobs) triggers.push(`${newJobs.length} new jobs`);
  if (hasErrors) triggers.push(`${errors.length} errors`);
  if (isHeartbeatHour) triggers.push('heartbeat hour (UTC 6 / IL 08:00)');
  console.log(`📨 Sending email — triggered by: ${triggers.join(', ')}`);

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
async function persistState(emailSuccess, jobStateService) {
  console.log('\n' + '='.repeat(60));
  console.log('💾 PHASE 5: Persist State');
  console.log('='.repeat(60));

  // #region agent log
  _dbgLog('orchestrator.js:persistState',{emailSuccess,pendingNewIds:jobStateService.getStats().pendingCount,historyCount:jobStateService.getStats().historyCount},'H5');
  // #endregion

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/61a56e06-6640-4063-b879-e276fdb70bb5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e92a09'},body:JSON.stringify({sessionId:'e92a09',location:'orchestrator.js:persistState',message:'persistState branch',data:{DRY_RUN,emailSuccess,pendingCount:jobStateService.getStats().pendingCount},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (DRY_RUN) {
    jobStateService.rollback();
    console.log('[DRY_RUN] Skipping persistState (no side-effects in test mode)');
  } else if (emailSuccess) {
    await jobStateService.persistState();
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

  // Create storage adapter (will be FileStorageAdapter locally, MongoStorageAdapter in cloud)
  const storageAdapter = createStorageAdapter();

  try {
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

    // Load known job IDs BEFORE the parallel phase (for ATS silent dedup)
    const knownJobIds = process.env.RESET_DEDUP === 'true'
      ? new Set()
      : await storageAdapter.loadSentHistory();
    if (process.env.RESET_DEDUP === 'true') {
      console.log('⚠️  [TEST MODE] Bypassing Silent Dedup (knownJobIds empty)');
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/61a56e06-6640-4063-b879-e276fdb70bb5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e92a09'},body:JSON.stringify({sessionId:'e92a09',location:'orchestrator.js:knownJobIds',message:'knownJobIds loaded',data:{size:knownJobIds.size,RESET_DEDUP:process.env.RESET_DEDUP},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const [atsResult, linkedinResult] = await Promise.allSettled([
      runAtsWorkers(atsErrors, storageAdapter, knownJobIds),
      runLinkedInPhase(linkedinErrors, storageAdapter),
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

    // Create service instances using factories
    const jobStateService = createJobStateService(storageAdapter);
    const emailNotifier = createEmailNotifier();

    // #region agent log
    _dbgLog('orchestrator.js:pre-dedup',{totalJobsCollected:allJobs.length,sampleJobIds:allJobs.slice(0,5).map(j=>j.jobId)},'H2');
    // #endregion

    // Phase 3: Deduplication
    const newJobs = await deduplicateJobs(allJobs, jobStateService);

    // Phase 4: Email Notification
    const emailSuccess = await sendNotification(newJobs, errors, emailNotifier);

    // Phase 5: Persist State
    await persistState(emailSuccess, jobStateService);

    // Phase 5b: Write calibration_passed (lightweight, post-dedup, post-email)
    if (emailSuccess && newJobs.length > 0 && !DRY_RUN) {
      try {
        await storageAdapter.writeCalibrationPassed(newJobs);
        console.log(`✅ Saved ${newJobs.length} passed jobs to calibration_passed`);
      } catch (err) {
        console.error('Failed to write calibration passed:', err.message || err);
      }
    }

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
  } finally {
    // CRITICAL: Close the storage adapter to release resources (e.g., MongoDB connection pool).
    // Without this, the Node.js event loop never clears and the process hangs indefinitely,
    // consuming Cloud Run execution time and incurring unnecessary costs.
    try {
      await storageAdapter.close();
    } catch (closeErr) {
      console.error('Failed to close storage adapter:', closeErr.message || closeErr);
    }
  }
}

if (require.main === module) {
  run()
    .catch((err) => {
      console.error('Orchestrator failed:', err && err.message ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => {
      // Fail-safe: guarantee the process terminates even if some handle leaked.
      // The storageAdapter.close() in run()'s finally block handles graceful teardown;
      // this setTimeout is a last-resort safeguard for Cloud Run cost protection.
      setTimeout(() => {
        console.warn('⚠️  Process did not exit naturally — forcing shutdown.');
        process.exit(process.exitCode || 0);
      }, 5000).unref(); // unref() so this timer alone won't keep the process alive
    });
}

module.exports = { run };
