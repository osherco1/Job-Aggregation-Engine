require('dotenv').config();
const path = require('path');
const { PATHS } = require('./config/paths');
const { createStorageAdapter } = require('./services/storage');

let chalk;
try {
  // Optional dependency: use colored logs if available.
  // Falls back to plain console.log if chalk is not installed.
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  chalk = require('chalk');
} catch (e) {
  chalk = null;
}

const { fetchJobs, fetchJobDetails, LinkedInAuthChallengeError } = require('./linkedin_client');
const { sendJobReport } = require('./mailer');

// Centralized directories for all generated artifacts.
// NOTE: LinkedIn module must only ever write under PATHS.LINKEDIN.*.
const DATA_DIR = PATHS.DATA;
const OUTPUT_DIR = PATHS.LINKEDIN.OUTPUT;

// LEVEL_PREFIX captures junior / early-career intent across English + Hebrew.
// This is the full, verbose version used for most queries.
const LEVEL_PREFIX =
  '(Junior OR Student OR Intern OR Graduate OR "Entry Level" OR "0-2 years" OR "No experience" OR ג\'וניור OR סטודנט OR בוגר OR "ללא ניסיון")';

// COMPACT_LEVEL_PREFIX is a shorter variant used for specific queries that
// were hitting LinkedIn API complexity limits ("Boolean explosion").
const COMPACT_LEVEL_PREFIX =
  '(Junior OR Student OR Intern OR Graduate OR ג\'וניור OR סטודנט OR בוגר)';

// Niche clusters for the search matrix. Each entry becomes:
//   `${LEVEL_PREFIX} AND ${niche}`.
const NICHES = [
  // Backend (language- or framework-specific variants)
  '(Backend OR "Backend Developer") AND (Python OR Django OR Flask OR FastAPI)',
  '(Backend OR "Backend Developer") AND (Java OR Spring)',
  // Fullstack
  '(Fullstack OR "Full Stack" OR "Web Developer")',
  // Mobile
  '(Mobile OR "Mobile Developer") AND (iOS OR Android OR Swift OR Kotlin OR "React Native" OR Flutter)',
  '(iOS Developer OR "iOS Engineer" OR Swift)',
  '(Android Developer OR "Android Engineer" OR Kotlin)',
  // Data / AI (Data Scientist handled separately with compact prefix)
  '("Data Analyst" OR "Business Analyst" OR BI) AND (SQL OR Excel OR Tableau OR PowerBI)',
  // DevOps / Platform / Cloud
  '(DevOps OR "Platform Engineer" OR "SRE") AND (CI/CD OR Jenkins OR Docker OR Kubernetes OR AWS OR GCP OR Azure)',
  // Cyber / Security
  '(Cyber OR "Security Researcher" OR Security OR InfoSec OR SOC)',
  // QA / Automation
  '(QA OR "Quality Assurance" OR "Test Engineer" OR Automation OR Testing OR Selenium OR Cypress)',
  // Embedded / Low-level
  '(Embedded OR Firmware OR "C++" OR RTOS OR Kernel OR ARM)',
  // Systems / IT
  '("System Administrator" OR "Systems Administrator" OR IT OR "IT Support" OR "Helpdesk") AND (Linux OR Windows OR Active Directory)',
];

// Data Scientist / ML niche (uses COMPACT_LEVEL_PREFIX to reduce query length).
const DATA_SCIENTIST_NICHE =
  '("Data Scientist" OR "ML Engineer" OR "Machine Learning Engineer") AND (Python OR SQL OR PyTorch OR TensorFlow)';
const DATA_SCIENTIST_QUERY = `${COMPACT_LEVEL_PREFIX} AND ${DATA_SCIENTIST_NICHE}`;

// Cluster-based balanced queries that keep coverage high but reduce per-query complexity.
const CLUSTER_QUERIES = [
  // Cluster A: Enterprise Backend (Java, C#, Go)
  `${LEVEL_PREFIX} AND (Backend OR "Backend Developer") AND (Java OR "C#" OR .NET OR Go)`,
  // Cluster B: Web/Scripting Backend (Node, Python)
  `${LEVEL_PREFIX} AND (Backend OR "Backend Developer") AND (Node.js OR Python OR Django OR Express)`,
  // Cluster C: Modern Frontend (React, Vue) – use compact prefix (Phase 5.3: Expanded for better coverage)
  `${COMPACT_LEVEL_PREFIX} AND (Frontend OR "Front End" OR "Web Developer" OR "Full Stack") AND (React OR Vue OR "Next.js" OR TypeScript OR JavaScript)`,
  // Cluster D: Structural Frontend (Angular, TS, JS) – use compact prefix
  `${COMPACT_LEVEL_PREFIX} AND (Frontend OR "Front End") AND (Angular OR Typescript OR Javascript)`,
];

const SEARCH_QUERIES = [
  ...NICHES.map((niche) => `${LEVEL_PREFIX} AND ${niche}`),
  DATA_SCIENTIST_QUERY,
  ...CLUSTER_QUERIES,
];

// Daily cap on *new* jobs to avoid overwhelming downstream processing/email.
const DAILY_NEW_JOBS_LIMIT = 500;

const {
  BLACKLIST_KEYWORDS,
  WHITELIST_KEYWORDS,
} = require('./filters_shared');

/**
 * Combined blacklist / whitelist title filter.
 * - DROP if any BLACKLIST_KEYWORD appears in the title (case-insensitive).
 * - DROP if none of the WHITELIST_KEYWORDS appear in the title.
 * - KEEP everything else.
 *
 * Also updates runStats / filteredJobsLog when provided.
 */
function passesFilters(job, runStats, filteredJobsLog) {
  const rawTitle = job && job.title ? String(job.title) : '';
  const rawCompany = job && job.company ? String(job.company) : 'Unknown company';
  const titleLower = rawTitle.toLowerCase();

  // 1) Blacklist: immediate skip on senior indicators.
  for (const kw of BLACKLIST_KEYWORDS) {
    if (titleLower.includes(kw.toLowerCase())) {
      const msg = `Skipped: Blacklisted title -> "${rawTitle}" (matched "${kw}")`;
      if (chalk && typeof chalk.red === 'function') {
        console.log(chalk.red(msg));
      } else {
        console.log(msg);
      }
      if (runStats && runStats.filteredOut) {
        runStats.filteredOut.blacklist += 1;
      }
      if (Array.isArray(filteredJobsLog)) {
        filteredJobsLog.push({
          title: rawTitle,
          company: rawCompany,
          reason: 'Blacklist',
        });
      }
      return false;
    }
  }

  // 2) Whitelist: ensure at least one technical/relevant term.
  const hasWhitelist = WHITELIST_KEYWORDS.some((kw) =>
    titleLower.includes(kw.toLowerCase())
  );
  if (!hasWhitelist) {
    const msg = `Skipped: Non-tech title -> "${rawTitle}" (no whitelist keyword match)`;
    if (chalk && typeof chalk.yellow === 'function') {
      console.log(chalk.yellow(msg));
    } else {
      console.log(msg);
    }
    if (runStats && runStats.filteredOut) {
      runStats.filteredOut.whitelist += 1;
    }
    if (Array.isArray(filteredJobsLog)) {
      filteredJobsLog.push({
        title: rawTitle,
        company: rawCompany,
        reason: 'Whitelist',
      });
    }
    return false;
  }

  return true;
}

// Simple sleep helper to space out requests and reduce bot detection risk.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adaptive jitter helper: waits for a random duration between minMs and maxMs.
 * Logs the exact wait time for debugging / observability.
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<number>} The actual delay in milliseconds.
 */
async function randomDelay(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  const delay = min + Math.random() * (max - min);
  const delayMs = Math.round(delay);
  const seconds = (delayMs / 1000).toFixed(1);
  console.log(`⏱️ Waiting ${seconds}s (jitter range ${min}-${max}ms)...`);
  await sleep(delayMs);
  return delayMs;
}

/**
 * Main LinkedIn scraper function
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipEmail - If true, skip email sending (for orchestrator integration)
 * @param {StorageAdapter} options.storage - Storage adapter instance (defaults to createStorageAdapter())
 * @returns {Promise<{jobs: Array, errors: Array}>} - Jobs found and any fetch errors encountered
 */
async function runLinkedinScraper(options = {}) {
  const { skipEmail = false, storage = createStorageAdapter() } = options;

  const runStats = {
    startTime: new Date().toISOString(),
    status: 'IN_PROGRESS',
    totalQueries: 0,
    rawJobsFetched: 0,
    candidatesEnriched: 0,
    newJobsAdded: 0,
    repostsDetected: 0,
    // Per-query performance log: { [queryString]: { raw: number, new: number } }
    queryLog: {},
    filteredOut: {
      blacklist: 0,
      whitelist: 0,
      alreadySeen: 0,
      quotaHit: false,
    },
    errors: 0,
  };
  const filteredJobsLog = []; // To store { title, company, reason }
  const fetchErrors = []; // Surfaced to orchestrator for email gating

  const isDryRun = process.env.DRY_RUN === 'true';

  let quotaReached = false;
  const allNewJobs = [];
  let seenIds = new Set();
  let totalScanned = 0;

  try {
    console.log('🚀 Starting Clean Run v2.0 - Binary Filter Active');
    console.log('Starting LinkedIn Voyager multi-query job fetch...');

    seenIds = await storage.loadSeenJobIds();

    // Explicit pagination offsets in multiples of 25 (Voyager standard page size).
    const pageOffsets = [0, 25, 50, 75];

    // Chunk the matrix of queries into batches of 5.
    const BATCH_SIZE = 5;
    const queryBatches = [];
    for (let i = 0; i < SEARCH_QUERIES.length; i += BATCH_SIZE) {
      queryBatches.push(SEARCH_QUERIES.slice(i, i + BATCH_SIZE));
    }

    let isFirstQuery = true;

    for (let batchIndex = 0; batchIndex < queryBatches.length; batchIndex++) {
      const batch = queryBatches[batchIndex];
      console.log(
        `\n========== Starting Batch ${batchIndex + 1}/${queryBatches.length
        } (size=${batch.length}) ==========\n`
      );

      for (const query of batch) {
        if (quotaReached) break;
        if (!isFirstQuery) {
          // Query-level jitter between distinct Boolean search queries.
          await randomDelay(10000, 20000);
        }
        isFirstQuery = false;

        runStats.totalQueries += 1;
        if (!runStats.queryLog[query]) {
          runStats.queryLog[query] = { raw: 0, new: 0 };
        }

        let totalForQuery = null;
        console.log('\n========================================');
        console.log(`Searching for query: ${query}`);
        console.log('========================================');

        for (let i = 0; i < pageOffsets.length; i++) {
          if (quotaReached) break;
          const start = pageOffsets[i];
          console.log(
            `Fetching query "${query}" - page ${i + 1}/${pageOffsets.length
            } (start=${start})...`
          );

          let jobs = [];
          try {
            const result = await fetchJobs(query, start);
            const paging = result && result.paging ? result.paging : null;
            jobs = result && Array.isArray(result.jobs) ? result.jobs : [];

            if (paging && typeof paging.total === 'number') {
              if (totalForQuery == null) {
                totalForQuery = paging.total;
                console.log(
                  `Total jobs reported by LinkedIn for this query: ${totalForQuery}`
                );
              }
            }
          } catch (err) {
            runStats.errors += 1;
            if (err instanceof LinkedInAuthChallengeError || (err && err.message === 'CRITICAL_AUTH_FAIL')) {
              console.error(
                '🛑 STOPPING BOT: Authentication failed. Please update .env file.'
              );
              // Throw to let orchestrator know about critical failure
              throw err;
            }

            const errorMsg = err && err.message ? err.message : String(err);
            console.error(
              `Failed to fetch jobs for query "${query}" page ${i + 1}:`,
              errorMsg
            );
            // Surface to orchestrator so it can trigger an error-path email
            fetchErrors.push({
              source: `LinkedIn/fetchJobs`,
              message: `Query page ${i + 1} failed: ${errorMsg}`,
            });
            // Small randomized delay even on error to avoid hammering the endpoint (3–7 seconds).
            await randomDelay(3000, 7000);
            continue;
          }

          // Smart pagination: if LinkedIn reports a total and we've already
          // requested beyond that total, stop requesting further pages.
          if (totalForQuery != null && start >= totalForQuery) {
            console.log(
              `🏁 No more jobs left (Total: ${totalForQuery}, Current start: ${start}). Moving to next query.`
            );
            break;
          }

          const pageCount = Array.isArray(jobs) ? jobs.length : 0;
          totalScanned += pageCount;
          runStats.rawJobsFetched += pageCount;
          if (runStats.queryLog[query]) {
            runStats.queryLog[query].raw += pageCount;
          }
          console.log(`Jobs returned this page: ${pageCount}`);

          const pageNewJobs = [];
          for (const job of jobs || []) {
            if (!job || !job.jobId) continue;
            if (seenIds.has(job.jobId)) {
              runStats.filteredOut.alreadySeen += 1;
              const title = job.title || 'Untitled';
              const company = job.company || 'Unknown company';
              filteredJobsLog.push({
                title,
                company,
                reason: 'AlreadySeen',
              });
              continue;
            }
            pageNewJobs.push(job);
          }
          console.log(`New jobs this page (after dedup): ${pageNewJobs.length}`);

          // Accumulate enriched jobs across all queries/pages and update memory.
          for (const job of pageNewJobs) {
            if (quotaReached) break;
            // Always mark as seen, even if later dropped by the binary filter.
            seenIds.add(job.jobId);

            const title = job.title || 'Untitled';
            const company = job.company || 'Unknown company';

            const enrichMsg = `🔍 Enriching ${title} at ${company}...`;
            if (chalk && typeof chalk.cyan === 'function') {
              console.log(chalk.cyan(enrichMsg));
            } else {
              console.log(enrichMsg);
            }

            runStats.candidatesEnriched += 1;

            let details;
            try {
              details = await fetchJobDetails(job.jobId);
            } catch (err) {
              runStats.errors += 1;
              const detailErrorMsg = err && err.message ? err.message : String(err);
              console.error(
                `Failed to fetch job details for jobId=${job.jobId}:`,
                detailErrorMsg
              );
              fetchErrors.push({
                source: `LinkedIn/fetchJobDetails`,
                message: `jobId=${job.jobId}: ${detailErrorMsg}`,
              });
              details = {
                description: null,
                applyUrl: null,
                skills: null,
                employmentType: null,
                listedAt: null,
                appliesCount: null,
                applyMethodEasyApply: null,
                workplaceTypes: null,
                recruiterUrl: null,
                simpleApplication: null,
                recruiter: null,
                skillsDescription: null,
                isRepost: false,
              };
            }

            const enrichedJob = {
              ...job,
              source: 'linkedin', // Add source field for unified handling
              companyName: job.company || 'Unknown Company', // Add companyName for email compatibility
              description: details?.description || null,
              applyUrl: details?.applyUrl || null,
              skills: details?.skills || null,
              employmentType: details?.employmentType || null,
              // listedAt comes from GraphQL; if missing we keep null here and
              // let the mailer fall back to the search card's postedAt value.
              listedAt: details?.listedAt || null,
              appliesCount:
                typeof details?.appliesCount === 'number'
                  ? details.appliesCount
                  : null,
              applyMethodEasyApply:
                details?.applyMethodEasyApply === true ? true : false,
              workplaceTypes: Array.isArray(details?.workplaceTypes)
                ? details.workplaceTypes
                : null,
              recruiterUrl: details?.recruiterUrl || null,
              simpleApplication:
                details?.simpleApplication === true ? true : false,
              recruiter:
                details && typeof details.recruiter === 'object'
                  ? details.recruiter
                  : null,
              skillsDescription: details?.skillsDescription || null,
              isRepost: details?.isRepost === true,
            };

            if (enrichedJob.isRepost) {
              const msg = `⚠️ Job is a Repost: ${title}`;
              if (chalk && typeof chalk.yellow === 'function') {
                console.log(chalk.yellow(msg));
              } else {
                console.log(msg);
              }
              runStats.repostsDetected += 1;
            }

            if (!passesFilters(enrichedJob, runStats, filteredJobsLog)) {
              const dropMsg = `⏭️  DROPPED by Filter: jobId=${enrichedJob.jobId} | title="${title}"`;
              if (chalk && typeof chalk.red === 'function') {
                console.log(chalk.red(dropMsg));
              } else {
                console.log(dropMsg);
              }
            } else {
              const keepMsg = `✅ KEPT for reporting: jobId=${enrichedJob.jobId} | title="${title}"`;
              if (chalk && typeof chalk.green === 'function') {
                console.log(chalk.green(keepMsg));
              } else {
                console.log(keepMsg);
              }
              allNewJobs.push(enrichedJob);
              runStats.newJobsAdded += 1;
              if (runStats.queryLog[query]) {
                runStats.queryLog[query].new += 1;
              }

              if (allNewJobs.length >= DAILY_NEW_JOBS_LIMIT) {
                console.log(
                  `🛑 Daily limit of ${DAILY_NEW_JOBS_LIMIT} new jobs reached. Stopping search.`
                );
                quotaReached = true;
                runStats.filteredOut.quotaHit = true;
                break;
              }
            }

            // Randomized delay between each fetchJobDetails call to mimic human behaviour (3–6 seconds).
            await randomDelay(3000, 6000);
          }

          // Anti-bot delay between paginated jobSearch calls (3–7 seconds between every API call).
          await randomDelay(3000, 7000);
        }
      }

      // Cool-off period between batches to reduce detection risk.
      if (!quotaReached && batchIndex < queryBatches.length - 1) {
        console.log(
          '❄️ Batch finished. Entering Cool-off period (2-3 mins)...'
        );
        await randomDelay(120000, 180000);
      }
    }

    console.log('\n========== Run Summary ==========');
    console.log(`Total jobs scanned across all queries/pages: ${totalScanned}`);
    console.log(`Total new jobs found (deduped & enriched): ${allNewJobs.length}`);

    if (allNewJobs.length === 0) {
      console.log('No new jobs found in this run.');
    } else {
      console.log('\nEnriched jobs:');
      allNewJobs.forEach((job, index) => {
        const title = job.title || 'Untitled';
        const company = job.company || 'Unknown company';
        const location = job.location || 'Unknown location';
        const url = job.url || '';
        console.log(
          `${index + 1}. ${title} @ ${company} - ${location}${url ? ` (${url})` : ''}`
        );
      });

      // Persist enriched jobs via storage adapter (local dev only — collection is deprecated in prod)
      if (process.env.NODE_ENV !== 'production') {
        try {
          await storage.writeEnrichedJobs(allNewJobs, 'linkedin');
          console.log(`Saved enriched jobs via storage adapter`);
        } catch (e) {
          console.error('Failed to save enriched jobs:', e.message || e);
        }
      }

      // Send an email report summarizing all new enriched jobs (unless DRY_RUN or skipEmail).
      if (skipEmail) {
        console.log('📧 Skipping email (orchestrator mode).');
      } else if (isDryRun) {
        console.log('🥕 DRY RUN: Skipping email report.');
      } else {
        try {
          await sendJobReport(allNewJobs);
          const userEmail = process.env.EMAIL_TO || process.env.EMAIL_USER || 'N/A';
          console.log(`📧 Email report sent successfully to ${userEmail}`);
        } catch (e) {
          runStats.errors += 1;
          console.error('Failed to send email report:', e.message || e);
        }
      }
    }

    // Persist updated seen job IDs so duplicates are skipped next run.
    await storage.saveSeenJobIds(seenIds);
    runStats.status = quotaReached ? 'QUOTA_REACHED' : 'SUCCESS';
  } catch (err) {
    runStats.errors += 1;
    runStats.status = 'ERROR';
    console.error('Error in LinkedIn scraper:', err.message || err);
    // Re-throw for orchestrator to catch
    throw err;
  } finally {
    const logTimestamp = new Date().toISOString().split('.')[0].replace(/:/g, '-');
    runStats.endTime = new Date().toISOString();
    runStats.newJobsAdded = allNewJobs.length;

    try {
      // Write run summary via storage adapter
      await storage.writeRunLog({
        type: 'summary',
        source: 'linkedin',
        timestamp: logTimestamp,
        payload: runStats,
      });
      console.log(`Saved run summary via storage adapter`);
    } catch (e) {
      console.error('Failed to write run_summary:', e.message || e);
    }

    try {
      // Write filtered jobs debug log via storage adapter
      await storage.writeRunLog({
        type: 'filtered',
        source: 'linkedin',
        timestamp: logTimestamp,
        payload: filteredJobsLog,
      });
      console.log(`Saved filtered jobs debug log via storage adapter`);
    } catch (e) {
      console.error('Failed to write filtered_jobs_debug:', e.message || e);
    }
  }

  return { jobs: allNewJobs, errors: fetchErrors };
}

// Run as standalone script if executed directly
if (require.main === module) {
  runLinkedinScraper().catch((err) => {
    console.error('Fatal error in LinkedIn scraper:', err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { runLinkedinScraper };
