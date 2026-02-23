const path = require('path');
const { requestWithDelayWrapper } = require('../utils/httpClientWrapper');
const { PATHS } = require('../../config/paths');
const { evaluateAtsGuard } = require('../filters/ats_guard');

const DEBUG_GREENHOUSE = process.env.DEBUG_GREENHOUSE === 'true';
const ATS_GUARD_DRY_RUN = process.env.ATS_GUARD_DRY_RUN === 'true';
// Quiet mode: when true, detailed logs go to file only (not console)
const QUIET_MODE = process.env.ATS_QUIET_MODE !== 'false'; // Default: true

// Human-like delay configuration (to avoid WAF detection)
const GREENHOUSE_DELAY_MIN_MS = parseInt(process.env.GREENHOUSE_DELAY_MIN_MS, 10) || 6000;
const GREENHOUSE_DELAY_MAX_MS = parseInt(process.env.GREENHOUSE_DELAY_MAX_MS, 10) || 12000;

// Runtime log path for tailing
const RUNTIME_LOG_PATH = PATHS.ATS.LOGS.GREENHOUSE.RUNTIME_LOG;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Log message to runtime log file (for tailing in separate terminal)
 * @param {string} message - Log message
 * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
 * @param {StorageAdapter} storageAdapter - Optional storage adapter for logging
 */
function logRuntime(message, level = 'INFO', storageAdapter = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}\n`;

  // If storage adapter is provided, use it for structured logging
  if (storageAdapter) {
    // Fire-and-forget log write
    storageAdapter.writeRunLog({
      type: 'runtime',
      source: 'greenhouse',
      timestamp,
      payload: { message, level },
    }).catch(() => {
      // Ignore errors - logging is non-critical
    });
  }

  // Always log to console if not in quiet mode, or if it's an error
  if (!QUIET_MODE || level === 'ERROR') {
    if (level === 'ERROR') {
      console.error(`[GH] ${message}`);
    }
  }
}

/**
 * Random delay between min and max milliseconds (human-like pacing)
 * @param {number} minMs - Minimum delay in milliseconds
 * @param {number} maxMs - Maximum delay in milliseconds
 * @returns {Promise<number>} Actual delay applied
 */
function randomDelay(minMs, maxMs) {
  const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
  return new Promise(resolve => setTimeout(() => resolve(delayMs), delayMs));
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLength = 500) {
  if (!str || typeof str !== 'string') return str;
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...[truncated]';
}

/**
 * Generate safe filename from company name
 */
function safeCompanyName(companyName) {
  return (companyName || 'unknown').replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

/**
 * Generate timestamp string for filenames
 */
function timestampString() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Decode HTML entities in description (basic implementation)
 */
function decodeHtml(html) {
  if (!html || typeof html !== 'string') return html;
  // Basic HTML entity decoding - can be enhanced if needed
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Save raw API response (debug only)
 * @param {string} companyName
 * @param {Object} rawResponse
 * @param {StorageAdapter} storageAdapter
 */
async function saveRawResponse(companyName, rawResponse, storageAdapter) {
  if (!DEBUG_GREENHOUSE || !storageAdapter) return;

  try {
    const timestamp = timestampString();
    const safeName = safeCompanyName(companyName);
    const payload = {
      companyName: safeName,
      rawResponse,
    };

    await storageAdapter.writeRunLog({
      type: 'raw',
      source: 'greenhouse',
      timestamp: `${safeName}_${timestamp}`,
      payload,
    });
    logRuntime(`[RAW] Saved raw response for ${safeName}`, 'DEBUG', storageAdapter);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('GreenhouseWorker: failed to save raw response:', err.message || err);
  }
}

/**
 * Save dropped jobs with reasons
 * @param {string} companyName
 * @param {Array} droppedJobs
 * @param {StorageAdapter} storageAdapter
 */
async function saveDroppedJobs(companyName, droppedJobs, storageAdapter) {
  if (!droppedJobs || droppedJobs.length === 0 || !storageAdapter) return;

  try {
    const timestamp = timestampString();
    const safeName = safeCompanyName(companyName);

    await storageAdapter.writeRunLog({
      type: 'filtered',
      source: 'greenhouse',
      timestamp: `${safeName}_${timestamp}`,
      payload: {
        companyName: safeName,
        droppedJobs,
      },
    });
    logRuntime(`[DROPPED] Saved ${droppedJobs.length} dropped jobs for ${safeName}`, 'INFO', storageAdapter);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('GreenhouseWorker: failed to save dropped jobs:', err.message || err);
  }
}

/**
 * Save error information
 * @param {string} companyName
 * @param {Object} errorInfo
 * @param {StorageAdapter} storageAdapter
 */
async function saveErrorInfo(companyName, errorInfo, storageAdapter) {
  if (!storageAdapter) return;

  try {
    const timestamp = timestampString();
    const safeName = safeCompanyName(companyName);

    await storageAdapter.writeRunLog({
      type: 'error',
      source: 'greenhouse',
      timestamp: `${safeName}_${timestamp}`,
      payload: {
        companyName: safeName,
        errorInfo,
      },
    });
    logRuntime(`[ERROR] Saved error info for ${safeName}`, 'WARN', storageAdapter);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('GreenhouseWorker: failed to save error info:', err.message || err);
  }
}

/**
 * Save run summary
 * @param {Object} runStats
 * @param {StorageAdapter} storageAdapter
 */
async function saveRunSummary(runStats, storageAdapter) {
  if (!storageAdapter) return;

  try {
    const timestamp = timestampString();
    await storageAdapter.writeRunLog({
      type: 'summary',
      source: 'greenhouse',
      timestamp,
      payload: runStats,
    });
    logRuntime(`[SUMMARY] Saved run summary`, 'INFO', storageAdapter);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('GreenhouseWorker: failed to save run summary:', err.message || err);
  }
}

// ============================================================================
// NORMALIZATION & FILTERING LOGIC
// ============================================================================

/**
 * Normalize raw Greenhouse job to UnifiedJob structure
 */
function normalizeGreenhouseJob(rawJob, company) {
  if (!rawJob || !rawJob.id || !rawJob.title) {
    return null;
  }

  // Extract location from job.location.name
  let location = '';
  if (rawJob.location) {
    if (typeof rawJob.location === 'string') {
      location = rawJob.location;
    } else if (typeof rawJob.location === 'object' && rawJob.location.name) {
      location = String(rawJob.location.name).trim();
    }
  }

  // Extract description from job.content (decode HTML if needed)
  let description = null;
  if (rawJob.content) {
    description = decodeHtml(String(rawJob.content).trim());
  }

  // Extract URL from job.absolute_url
  let url = '';
  if (rawJob.absolute_url) {
    url = String(rawJob.absolute_url).trim();
  }

  // Extract postedAt from job.updated_at
  let postedAt = null;
  if (rawJob.updated_at) {
    postedAt = String(rawJob.updated_at).trim();
  }

  return {
    jobId: `greenhouse_${String(rawJob.id).trim()}`,
    source: 'greenhouse',
    sourceCompanyId: company.id,
    companyName: company.name || company.id,
    title: String(rawJob.title).trim(),
    location: location,
    url: url,
    description: description,
    postedAt: postedAt,
    raw: rawJob,
  };
}

/**
 * Explicit job filter with reason tracking
 * Returns: { passed: boolean, reason?: string }
 */
function filterJob(rawJob) {
  if (!rawJob) {
    return { passed: false, reason: 'Invalid job data' };
  }

  // Location filter: Must be Israel (IL) or Remote
  let locationStr = '';
  if (rawJob.location) {
    if (typeof rawJob.location === 'string') {
      locationStr = rawJob.location;
    } else if (typeof rawJob.location === 'object') {
      locationStr = rawJob.location.name || rawJob.location.city || rawJob.location.country || '';
    }
  }

  const locationLower = locationStr.toLowerCase();
  const isIsrael = locationLower.includes('israel') ||
    locationLower.includes('tel aviv') ||
    locationLower.includes('tel-aviv') ||
    locationLower.includes('haifa') ||
    locationLower.includes('jerusalem') ||
    (rawJob.location && typeof rawJob.location === 'object' && rawJob.location.country === 'IL');
  const isRemote = locationLower.includes('remote');

  if (!isIsrael && !isRemote) {
    return { passed: false, reason: `Location: ${locationStr || 'Unknown'} (not IL/Remote)` };
  }

  // Title filter: No Senior/VP/Manager in title
  const title = (rawJob.title || '').toLowerCase();
  const titleBlacklist = ['senior', 'sr.', 'sr ', 'vp ', 'vice president', 'manager', 'director', 'head of', 'lead '];
  const hasBlacklistedTitle = titleBlacklist.some(term => title.includes(term));

  if (hasBlacklistedTitle) {
    return { passed: false, reason: `Title: Contains blacklisted term (${rawJob.title})` };
  }

  // Department filter: Tech/Product/Design only (if departments exist)
  if (rawJob.departments && Array.isArray(rawJob.departments) && rawJob.departments.length > 0) {
    const deptNames = rawJob.departments
      .map(dept => (dept.name || dept).toLowerCase().trim())
      .filter(Boolean);

    const blacklist = [
      'sales',
      'legal',
      'finance',
      'hr',
      'human resources',
      'marketing'
    ];

    const hasBlacklistedDept = deptNames.some(deptName =>
      blacklist.some(blacklisted =>
        deptName === blacklisted || deptName.includes(blacklisted)
      )
    );

    if (hasBlacklistedDept) {
      // Exception: "Product Marketing" is technical
      const hasProductMarketing = deptNames.some(deptName => deptName.includes('product marketing'));
      if (!hasProductMarketing) {
        const deptDisplay = rawJob.departments.map(d => d.name || d).join(', ');
        return { passed: false, reason: `Department: ${deptDisplay} (non-technical)` };
      }
    }
  }

  // All filters passed
  return { passed: true };
}

// ============================================================================
// WORKER CLASS
// ============================================================================

class GreenhouseWorker {
  constructor(httpClient, storageAdapter = null) {
    this.httpClient = httpClient;
    this.storageAdapter = storageAdapter;

    // Initialize run statistics
    this.runStats = {
      startTime: new Date().toISOString(),
      endTime: null,
      companiesProcessed: 0,
      companiesSucceeded: 0,
      companiesFailed: 0,
      totalFetched: 0,
      totalKept: 0,
      totalDropped: 0,
      droppedByReason: {},
      errors: [],
      companies: []
    };
  }

  /**
   * Reset run statistics (call at start of new run)
   */
  resetRunStats() {
    this.runStats = {
      startTime: new Date().toISOString(),
      endTime: null,
      companiesProcessed: 0,
      companiesSucceeded: 0,
      companiesFailed: 0,
      totalFetched: 0,
      totalKept: 0,
      totalDropped: 0,
      droppedByReason: {},
      errors: [],
      companies: []
    };
  }

  /**
   * Finalize run statistics and save summary
   * Should be called by orchestrator after all companies are processed
   */
  async finalizeRun() {
    this.runStats.endTime = new Date().toISOString();
    this.runStats.totalDurationMs = new Date(this.runStats.endTime) - new Date(this.runStats.startTime);
    await saveRunSummary(this.runStats, this.storageAdapter);
  }

  /**
   * Get current run statistics (for inspection)
   */
  getRunStats() {
    return { ...this.runStats };
  }

  /**
   * Fetch all open jobs for a given company configured as type 'greenhouse'.
   * Uses Greenhouse public API with ?content=true parameter.
   *
   * @param {Object} company - Company config with { uid, name, id }
   * @returns {Promise<{jobs: Array<UnifiedJob>, stats: object}>}
   */
  async fetchAllJobs(company) {
    // Human-like delay before fetching (avoid WAF detection)
    const delayMs = await randomDelay(GREENHOUSE_DELAY_MIN_MS, GREENHOUSE_DELAY_MAX_MS);
    logRuntime(`Sleeping for ${delayMs}ms before fetching ${company.name || company.id}...`, 'DEBUG', this.storageAdapter);

    const companyStartTime = Date.now();
    const emptyResult = {
      jobs: [],
      stats: {
        fetched: 0,
        passedLocation: 0,
        droppedLocation: 0,
        passedDepartment: 0,
        droppedDepartment: 0,
        passedGuard: 0,
        droppedGuard: 0,
        droppedByTitle: 0,
        droppedByDepartment: 0,
        droppedByDescription: 0,
        normalized: 0,
        status200: 0,
        status403: 0,
        status406: 0,
        status429: 0,
        statusOther: 0,
        timeout: 0,
        networkError: 0,
        retries: 0,
        httpDurationMs: 0,
        processingDurationMs: 0,
        totalDurationMs: 0,
      },
    };

    // Validate UID
    if (!company || !company.uid) {
      // eslint-disable-next-line no-console
      console.error(
        `[ERROR] Missing UID for company: ${company?.name ?? company?.id ?? 'unknown'}`
      );
      return emptyResult;
    }

    const uid = String(company.uid).trim();

    if (!uid) {
      // eslint-disable-next-line no-console
      console.error(
        `[ERROR] Empty UID for company: ${company.name || company.id || 'unknown'}`
      );
      return emptyResult;
    }

    // Greenhouse public API endpoint with ?content=true
    const targetUrl = `https://boards-api.greenhouse.io/v1/boards/${uid}/jobs?content=true`;

    const requestWithDelay = requestWithDelayWrapper(this.httpClient);

    let httpStartTime = 0;
    let httpDurationMs = 0;
    let processingStartTime = 0;
    let processingDurationMs = 0;
    let statusCode = null;
    let errorInfo = null;

    try {
      logRuntime(`Fetching: ${company.name || company.id} (UID: ${uid})`, 'DEBUG', this.storageAdapter);

      httpStartTime = Date.now();
      const response = await requestWithDelay({
        method: 'GET',
        url: targetUrl,
        maxRedirects: 5,
        timeout: 15000,
        validateStatus: (status) => status < 500
      });
      httpDurationMs = Date.now() - httpStartTime;
      statusCode = response.status;

      // Handle non-200 status codes
      if (response.status !== 200) {
        logRuntime(`HTTP ${response.status} for ${company.id}: ${response.statusText}`, 'WARN', this.storageAdapter);

        errorInfo = {
          companyId: company.id,
          companyName: company.name,
          uid: uid,
          requestUrl: targetUrl,
          statusCode: response.status,
          statusText: response.statusText,
          headers: response.headers || {},
          bodySnippet: truncate(JSON.stringify(response.data || {}), 500),
          durationMs: httpDurationMs,
          attempt: 1,
          retried: false,
        };
        await saveErrorInfo(company.name || company.id, errorInfo, this.storageAdapter);

        // Update run statistics
        this.runStats.companiesProcessed += 1;
        this.runStats.companiesFailed += 1;
        this.runStats.errors.push({
          companyId: company.id,
          companyName: company.name,
          error: `HTTP ${response.status}: ${response.statusText}`,
          timestamp: new Date().toISOString()
        });

        const result = { ...emptyResult };
        if (response.status === 403) {
          result.stats.status403 = 1;
        } else if (response.status === 406) {
          result.stats.status406 = 1;
        } else if (response.status === 429) {
          result.stats.status429 = 1;
        } else {
          result.stats.statusOther = 1;
        }
        result.stats.httpDurationMs = httpDurationMs;
        result.stats.totalDurationMs = Date.now() - companyStartTime;
        return result;
      }

      // Success (200) - process jobs
      processingStartTime = Date.now();

      // Greenhouse API returns { jobs: [...] }
      const rawJobs = (response.data && Array.isArray(response.data.jobs))
        ? response.data.jobs
        : (Array.isArray(response.data) ? response.data : []);

      if (rawJobs.length === 0) {
        logRuntime(`No jobs found for ${company.name || company.id}`, 'INFO', this.storageAdapter);

        // Save raw response even if no jobs
        await saveRawResponse(company.name || company.id, response.data, this.storageAdapter);

        // Update run statistics
        this.runStats.companiesProcessed += 1;
        this.runStats.companiesSucceeded += 1;

        const result = { ...emptyResult };
        result.stats.status200 = 1;
        result.stats.httpDurationMs = httpDurationMs;
        result.stats.processingDurationMs = Date.now() - processingStartTime;
        result.stats.totalDurationMs = Date.now() - companyStartTime;
        return result;
      }

      const stats = {
        fetched: rawJobs.length,
        passedLocation: 0,
        droppedLocation: 0,
        passedDepartment: 0,
        droppedDepartment: 0,
        passedGuard: 0,
        droppedGuard: 0,
        droppedByTitle: 0,
        droppedByDepartment: 0,
        droppedByDescription: 0,
        normalized: 0,
        status200: 1,
        status403: 0,
        status406: 0,
        status429: 0,
        statusOther: 0,
        timeout: 0,
        networkError: 0,
        retries: 0,
        httpDurationMs: 0,
        processingDurationMs: 0,
        totalDurationMs: 0,
      };

      const allNormalizedJobs = [];
      const unifiedJobs = [];
      const droppedJobs = []; // Track dropped jobs with reasons

      // Process each raw job
      for (const rawJob of rawJobs) {
        // Apply explicit filter with reason tracking
        const filterResult = filterJob(rawJob);

        if (!filterResult.passed) {
          // Job was filtered out - track it
          const normalized = normalizeGreenhouseJob(rawJob, company);
          droppedJobs.push({
            jobId: rawJob.id ? `greenhouse_${rawJob.id}` : 'unknown',
            title: rawJob.title || 'Unknown',
            location: (rawJob.location && typeof rawJob.location === 'object' && rawJob.location.name)
              ? rawJob.location.name
              : (typeof rawJob.location === 'string' ? rawJob.location : 'Unknown'),
            reason: filterResult.reason || 'Unknown filter reason',
            raw: rawJob,
            normalized: normalized
          });

          // Update stats by reason category
          const reasonKey = filterResult.reason ? filterResult.reason.split(':')[0] : 'Unknown';
          stats.droppedByReason = stats.droppedByReason || {};
          stats.droppedByReason[reasonKey] = (stats.droppedByReason[reasonKey] || 0) + 1;

          // Legacy stats for compatibility
          if (filterResult.reason && filterResult.reason.startsWith('Location:')) {
            stats.droppedLocation += 1;
          } else if (filterResult.reason && filterResult.reason.startsWith('Department:')) {
            stats.droppedDepartment += 1;
          } else if (filterResult.reason && filterResult.reason.startsWith('Title:')) {
            stats.droppedByTitle += 1;
          }

          continue;
        }

        stats.passedLocation += 1;
        stats.passedDepartment += 1;

        // Normalize to UnifiedJob
        const unified = normalizeGreenhouseJob(rawJob, company);
        if (!unified) {
          droppedJobs.push({
            jobId: rawJob.id ? `greenhouse_${rawJob.id}` : 'unknown',
            title: rawJob.title || 'Unknown',
            location: (rawJob.location && typeof rawJob.location === 'object' && rawJob.location.name)
              ? rawJob.location.name
              : (typeof rawJob.location === 'string' ? rawJob.location : 'Unknown'),
            reason: 'Normalization failed',
            raw: rawJob
          });
          continue;
        }
        stats.normalized += 1;
        allNormalizedJobs.push(unified);

        // ATS Guard (for seniority/title filtering)
        const guard = evaluateAtsGuard(rawJob, {
          companyId: company.id,
          source: 'greenhouse',
        });

        // Attach debug analysis
        if (!rawJob._debug_analysis || typeof rawJob._debug_analysis !== 'object') {
          rawJob._debug_analysis = {};
        }

        rawJob._debug_analysis.companyId = company.id;
        rawJob._debug_analysis.title = unified.title || null;
        rawJob._debug_analysis.location = unified.location || null;
        rawJob._debug_analysis.atsGuardVerdict = guard.verdict;
        rawJob._debug_analysis.atsGuardReason = guard.reason;
        rawJob._debug_analysis.verdict =
          guard.verdict === 'PASS'
            ? 'PASS'
            : `ATS_GUARD: ${guard.reason}`;

        // Track guard stats
        if (guard.verdict === 'PASS') {
          stats.passedGuard += 1;
          unifiedJobs.push(unified);
        } else {
          stats.droppedGuard += 1;
          const reasonLower = (guard.reason || '').toLowerCase();

          // Track dropped by ATS guard
          droppedJobs.push({
            jobId: unified.jobId,
            title: unified.title,
            location: unified.location,
            reason: `ATS_GUARD: ${guard.reason}`,
            raw: rawJob,
            normalized: unified
          });

          // Update stats by reason
          stats.droppedByReason = stats.droppedByReason || {};
          stats.droppedByReason['ATS_GUARD'] = (stats.droppedByReason['ATS_GUARD'] || 0) + 1;

          // Legacy stats
          if (reasonLower.includes('title_')) {
            stats.droppedByTitle += 1;
          }
          if (reasonLower.includes('department')) {
            stats.droppedByDepartment += 1;
          }
          if (reasonLower.includes('description_seniority')) {
            stats.droppedByDescription += 1;
          }
        }
      }

      processingDurationMs = Date.now() - processingStartTime;

      // Save raw API response (debug only)
      await saveRawResponse(company.name || company.id, response.data, this.storageAdapter);

      // Save dropped jobs with reasons
      if (droppedJobs.length > 0) {
        await saveDroppedJobs(company.name || company.id, droppedJobs, this.storageAdapter);
      }

      // Filter by ATS guard verdict (unless dry run)
      const finalJobs = ATS_GUARD_DRY_RUN ? allNormalizedJobs : unifiedJobs;

      // Update stats with timing and totals
      stats.httpDurationMs = httpDurationMs;
      stats.processingDurationMs = processingDurationMs;
      stats.totalDurationMs = Date.now() - companyStartTime;
      stats.kept = finalJobs.length;
      stats.dropped = droppedJobs.length;

      // Update run statistics
      this.runStats.companiesProcessed += 1;
      this.runStats.companiesSucceeded += 1;
      this.runStats.totalFetched += stats.fetched;
      this.runStats.totalKept += stats.kept;
      this.runStats.totalDropped += stats.dropped;

      // Aggregate dropped by reason
      if (stats.droppedByReason) {
        for (const [reason, count] of Object.entries(stats.droppedByReason)) {
          this.runStats.droppedByReason[reason] = (this.runStats.droppedByReason[reason] || 0) + count;
        }
      }

      // Store company-level stats
      this.runStats.companies.push({
        companyId: company.id,
        companyName: company.name,
        ...stats
      });

      const companyLabel = company.name || company.id || uid;
      logRuntime(
        `${companyLabel} - Fetched: ${stats.fetched}, ` +
        `Guard: ${stats.passedGuard}/${stats.droppedGuard}, ` +
        `Final: ${finalJobs.length}`,
        'INFO',
        this.storageAdapter
      );

      return { jobs: finalJobs, stats };
    } catch (err) {
      const message = err && err.message ? err.message : err;
      const errorCode = err.code || null;
      const isTimeout = errorCode === 'ECONNABORTED';
      const isNetworkError = !err.response && errorCode;

      // eslint-disable-next-line no-console
      console.warn(
        `GreenhouseWorker: failed to fetch jobs for company ${company.id}: ${message}`
      );

      // Calculate HTTP duration if request started
      if (httpStartTime > 0) {
        httpDurationMs = Date.now() - httpStartTime;
      }

      // Save error information
      errorInfo = {
        companyId: company.id,
        companyName: company.name,
        uid: uid,
        requestUrl: targetUrl,
        statusCode: err.response ? err.response.status : null,
        statusText: err.response ? err.response.statusText : null,
        errorCode: errorCode,
        errorMessage: message,
        headers: err.response ? (err.response.headers || {}) : null,
        bodySnippet: err.response && err.response.data
          ? truncate(JSON.stringify(err.response.data), 500)
          : null,
        durationMs: httpDurationMs,
        attempt: 1,
        retried: false,
      };
      await saveErrorInfo(company.name || company.id, errorInfo, this.storageAdapter);

      // Update run statistics
      this.runStats.companiesProcessed += 1;
      this.runStats.companiesFailed += 1;
      this.runStats.errors.push({
        companyId: company.id,
        companyName: company.name,
        error: isTimeout ? 'Timeout' : (isNetworkError ? 'Network Error' : message),
        timestamp: new Date().toISOString()
      });

      const result = { ...emptyResult };
      if (isTimeout) {
        result.stats.timeout = 1;
      } else if (isNetworkError) {
        result.stats.networkError = 1;
      } else {
        result.stats.networkError = 1;
      }
      result.stats.httpDurationMs = httpDurationMs;
      result.stats.totalDurationMs = Date.now() - companyStartTime;
      return result;
    }
  }
}

module.exports = {
  GreenhouseWorker,
};
