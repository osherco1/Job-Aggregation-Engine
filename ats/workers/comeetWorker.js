const path = require('path');
const https = require('https');
const { requestWithDelayWrapper } = require('../utils/httpClientWrapper');
const { PATHS } = require('../../config/paths');
const { evaluateAtsGuard } = require('../filters/ats_guard');
const { evaluateStructuredGate } = require('../filters/structuredGate');

const DEBUG_COMEET = process.env.DEBUG_COMEET === 'true';
const ATS_GUARD_DRY_RUN = process.env.ATS_GUARD_DRY_RUN === 'true';
// Quiet mode: when true, detailed logs go to file only (not console)
const QUIET_MODE = process.env.ATS_QUIET_MODE !== 'false'; // Default: true

// Configurable delays via env vars (with safe defaults)
const COMEET_DELAY_MIN_MS = parseInt(process.env.COMEET_DELAY_MIN_MS || (DEBUG_COMEET ? '3000' : '3000'), 10);
const COMEET_DELAY_MAX_MS = parseInt(process.env.COMEET_DELAY_MAX_MS || (DEBUG_COMEET ? '6000' : '6000'), 10);

// Cooldown durations (configurable via env)
const COOLDOWN_403_406_MIN_MS = parseInt(process.env.COMEET_COOLDOWN_403_MIN_MS || '120000', 10); // 2 minutes
const COOLDOWN_403_406_MAX_MS = parseInt(process.env.COMEET_COOLDOWN_403_MAX_MS || '300000', 10); // 5 minutes

// Runtime log path for tailing
const RUNTIME_LOG_PATH = PATHS.ATS.LOGS.COMEET.RUNTIME_LOG;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Log message to console (debugging only; no DB writes)
 * @param {string} message - Log message
 * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
 * @param {StorageAdapter} storageAdapter - Ignored (kept for API compatibility)
 */
function logRuntime(message, level = 'INFO', storageAdapter = null) {
  if (!QUIET_MODE || level === 'ERROR') {
    if (level === 'ERROR') {
      console.error(`[CM] ${message}`);
    }
  }
}

/**
 * Random delay helper for human-like throttling
 */
function randomDelay(minMs, maxMs) {
  const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Redact token from URL for safe logging
 */
function redactToken(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/[?&]token=[^&]+/gi, '?token=***REDACTED***');
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
 * Save raw API response (debug only — console only, no DB)
 * @param {string} companyName
 * @param {Object} rawResponse
 * @param {StorageAdapter} storageAdapter
 */
async function saveRawResponse(companyName, rawResponse, storageAdapter) {
  if (!DEBUG_COMEET) return;
  const safeName = safeCompanyName(companyName);
  console.log(`[CM][RAW] Response for ${safeName}`);
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
    // FIX 1 & 5: Use lightweight calibration_rejected instead of bloated writeRunLog.
    // Data stripping happens in writeCalibrationRejected (defense in depth).
    await storageAdapter.writeCalibrationRejected(droppedJobs);
    logRuntime(`[DROPPED] Saved ${droppedJobs.length} dropped jobs for ${companyName} to calibration_rejected`, 'INFO', storageAdapter);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ComeetWorker: failed to save dropped jobs:', err.message || err);
  }
}

/**
 * Save error information (console only, no DB)
 * @param {string} companyName
 * @param {Object} errorInfo
 * @param {StorageAdapter} storageAdapter
 */
async function saveErrorInfo(companyName, errorInfo, storageAdapter) {
  const safeName = safeCompanyName(companyName);
  const safeErrorInfo = {
    ...errorInfo,
    requestUrl: errorInfo.requestUrl ? redactToken(errorInfo.requestUrl) : null,
  };
  console.error(`[CM][ERROR] ${safeName}:`, JSON.stringify(safeErrorInfo));
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
      source: 'comeet',
      timestamp,
      payload: runStats,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ComeetWorker: failed to save run summary:', err.message || err);
  }
}

// ============================================================================
// NORMALIZATION & FILTERING LOGIC
// ============================================================================

/**
 * Smart description builder: concatenates all HTML-containing string fields
 */
function buildDescription(rawJob) {
  if (!rawJob || typeof rawJob !== 'object') {
    return null;
  }

  const htmlTagPattern = /<[pulib][^>]*>/i;
  const excludedKeys = new Set([
    'position_uid', 'location_uid', 'email_name', 'position_url',
    'careers_page_url', 'careers_page_active_url', 'careers_page_detected_url',
    'picture_url', 'time_updated', 'position_company_number', 'req_company_number',
    'company_name', 'is_discreet', 'location_object', 'location', 'name',
    'department', 'employment_type', 'experience_level', 'Remote'
  ]);

  const descriptionParts = [];

  for (const key in rawJob) {
    if (!Object.prototype.hasOwnProperty.call(rawJob, key)) continue;
    if (excludedKeys.has(key)) continue;

    const value = rawJob[key];
    if (typeof value === 'string' && value.trim() && htmlTagPattern.test(value)) {
      descriptionParts.push(value.trim());
    }
  }

  return descriptionParts.length > 0 ? descriptionParts.join('\n\n') : null;
}

/**
 * Normalize raw Comeet job to UnifiedJob structure
 */
function normalizeComeetJob(rawJob, company) {
  if (!rawJob || !rawJob.position_uid || !rawJob.name) {
    return null;
  }

  // Extract URL with fallback chain
  let url = '';
  if (rawJob.careers_page_active_url) {
    url = String(rawJob.careers_page_active_url).trim();
  } else if (rawJob.careers_page_url) {
    url = String(rawJob.careers_page_url).trim();
  } else if (rawJob.url_comeet_hosted_page) {
    url = String(rawJob.url_comeet_hosted_page).trim();
  }

  // Extract location from location_object
  let location = '';
  if (rawJob.location_object && typeof rawJob.location_object === 'object') {
    location = rawJob.location_object.name || rawJob.location_object.city || '';
  } else if (typeof rawJob.location === 'string') {
    location = rawJob.location;
  }

  // Build description from HTML fields
  const description = buildDescription(rawJob);

  return {
    jobId: `comeet_${String(rawJob.position_uid).trim()}`,
    source: 'comeet',
    sourceCompanyId: company.id,
    companyName: company.name || company.id,
    title: String(rawJob.name).trim(),
    location: location.trim(),
    url: url,
    description: description,
    raw: rawJob,
    structuredSignals: {
      experience_level: rawJob.experience_level || null,
      employment_type: rawJob.employment_type || null,
    },
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
  if (!rawJob.location_object) {
    return { passed: false, reason: 'Location: Missing location data' };
  }

  const locObj = rawJob.location_object;
  const locationName = (locObj.name || '').toLowerCase();
  const locationCity = (locObj.city || '').toLowerCase();
  const remoteField = (rawJob.Remote || '').toLowerCase();

  // Check if country is Israel
  if (locObj.country === 'IL') {
    // Pass location check
  } else if (locationName.includes('remote') ||
    locationCity.includes('remote') ||
    remoteField === 'remote') {
    // Pass location check (Remote)
  } else {
    // Fail location check
    const locationStr = locObj.name || locObj.city || locObj.country || 'Unknown';
    return { passed: false, reason: `Location: ${locationStr} (not IL/Remote)` };
  }

  // Title filter: No Senior/VP/Manager in title
  const title = (rawJob.name || '').toLowerCase();
  const titleBlacklist = ['senior', 'sr.', 'sr ', 'vp ', 'vice president', 'manager', 'director', 'head of', 'lead '];
  const hasBlacklistedTitle = titleBlacklist.some(term => title.includes(term));

  if (hasBlacklistedTitle) {
    return { passed: false, reason: `Title: Contains blacklisted term (${rawJob.name})` };
  }

  // Department filter: Tech/Product/Design only
  if (rawJob.department) {
    const dept = String(rawJob.department).toLowerCase().trim();
    const blacklist = [
      'sales',
      'legal',
      'finance',
      'hr',
      'human resources',
      'marketing'
    ];

    const isBlacklisted = blacklist.some(blacklisted =>
      dept === blacklisted || dept.includes(blacklisted)
    );

    if (isBlacklisted) {
      // Exception: "Product Marketing" is technical
      if (!dept.includes('product marketing')) {
        return { passed: false, reason: `Department: ${rawJob.department} (non-technical)` };
      }
    }
  }

  // All filters passed
  return { passed: true };
}

/**
 * Location gate: Keep Israel (IL) and Remote locations (legacy compatibility)
 */
function passesLocationGate(rawJob) {
  if (!rawJob || !rawJob.location_object) {
    return false;
  }

  const locObj = rawJob.location_object;

  // Keep if country is Israel
  if (locObj.country === 'IL') {
    return true;
  }

  // Keep if location name contains "Remote" (case-insensitive)
  const locationName = (locObj.name || '').toLowerCase();
  const locationCity = (locObj.city || '').toLowerCase();
  const remoteField = (rawJob.Remote || '').toLowerCase();

  if (locationName.includes('remote') ||
    locationCity.includes('remote') ||
    remoteField === 'remote') {
    return true;
  }

  return false;
}

/**
 * Department gate: Drop non-technical departments (legacy compatibility)
 */
function passesDepartmentGate(rawJob) {
  if (!rawJob || !rawJob.department) {
    return true; // No department info = pass (let ATS guard handle it)
  }

  const dept = String(rawJob.department).toLowerCase().trim();
  const blacklist = [
    'sales',
    'legal',
    'finance',
    'hr',
    'human resources',
    'marketing'
  ];

  // Check if department matches blacklist
  const isBlacklisted = blacklist.some(blacklisted =>
    dept === blacklisted || dept.includes(blacklisted)
  );

  if (isBlacklisted) {
    // Exception: "Product Marketing" is technical
    if (dept.includes('product marketing')) {
      return true;
    }
    return false;
  }

  return true;
}

// ============================================================================
// WORKER CLASS
// ============================================================================

class ComeetWorker {
  constructor(httpClient, storageAdapter = null) {
    this.httpClient = httpClient;
    this.storageAdapter = storageAdapter;

    // HTTPS Agent with keepAlive for persistent connections
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 50,
      maxFreeSockets: 10
    });

    // Chrome spoofing headers
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.comeet.com/',
      'Origin': 'https://www.comeet.com',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site'
    };

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
   * Fetch all open jobs for a given company configured as type 'comeet'.
   * Uses token-based API v1.0 with anti-bot protection, rate limiting, and retries.
   *
   * @param {Object} company - Company config with { uid, token, name, id }
   * @param {Set<string>} [knownJobIds] - Set of job IDs already sent (for silent dedup; skip calibration_rejected)
   * @returns {Promise<{jobs: Array<UnifiedJob>, stats: object}>}
   */
  async fetchAllJobs(company, knownJobIds) {
    const companyStartTime = Date.now();
    const emptyResult = {
      jobs: [],
      stats: {
        fetched: 0,
        skippedDedup: 0,
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
        cooldownAppliedMs: 0,
        httpDurationMs: 0,
        processingDurationMs: 0,
        totalDurationMs: 0,
      },
    };

    // Human-like throttling: random delay at start (configurable via env)
    await randomDelay(COMEET_DELAY_MIN_MS, COMEET_DELAY_MAX_MS);

    // Validate token
    if (!company || !company.token) {
      // eslint-disable-next-line no-console
      console.warn(
        `[WARN] Missing token for company: ${company?.name ?? company?.id ?? 'unknown'}`
      );
      return emptyResult;
    }

    // Validate UID
    if (!company || !company.uid) {
      // eslint-disable-next-line no-console
      console.error(
        `[ERROR] Missing UID for company: ${company?.name ?? company?.id ?? 'unknown'}`
      );
      return emptyResult;
    }

    const uid = String(company.uid).trim();
    const token = String(company.token).trim();

    if (!uid || !token) {
      // eslint-disable-next-line no-console
      console.error(
        `[ERROR] Empty UID or token for company: ${company.name || company.id || 'unknown'}`
      );
      return emptyResult;
    }

    // Token-based API endpoint v1.0
    const targetUrl = `https://www.comeet.co/careers-api/1.0/company/${uid}/positions?token=${token}`;

    // Enhanced wrapper with retry logic and rate limiting for Comeet
    const requestWithDelay = requestWithDelayWrapper(this.httpClient, {
      provider: 'comeet',
      enableRetries: true,
      maxRetries: 2, // Max 2 retries for 429/5xx
    });

    let httpStartTime = 0;
    let httpDurationMs = 0;
    let processingStartTime = 0;
    let processingDurationMs = 0;
    let statusCode = null;
    let retries = 0;
    let cooldownAppliedMs = 0;
    let errorInfo = null;

      try {
        logRuntime(`Fetching: ${company.name || company.id} (UID: ${uid})`, 'DEBUG', this.storageAdapter);

      httpStartTime = Date.now();
      const response = await requestWithDelay({
        method: 'GET',
        url: targetUrl,
        maxRedirects: 5,
        headers: this.headers,
        httpsAgent: this.httpsAgent,
        timeout: 15000,
        validateStatus: (status) => status < 500
      });
      httpDurationMs = Date.now() - httpStartTime;
      statusCode = response.status;

      // Handle WAF blocking (403/406) - apply cooldown, no retry
      if (response.status === 403 || response.status === 406) {
        const cooldownMs = Math.floor(
          Math.random() * (COOLDOWN_403_406_MAX_MS - COOLDOWN_403_406_MIN_MS + 1) + COOLDOWN_403_406_MIN_MS
        );
        cooldownAppliedMs = cooldownMs;

        // eslint-disable-next-line no-console
        console.warn(
          `ComeetWorker: WAF blocked (${response.status}) for company ${company.id}, applying ${Math.round(cooldownMs / 1000)}s cooldown`
        );

        // Save error debug data
        errorInfo = {
          companyId: company.id,
          companyName: company.name,
          uid: uid,
          requestUrl: targetUrl,
          statusCode: response.status,
          statusText: response.statusText,
          headers: {
            'retry-after': response.headers['retry-after'] || response.headers['Retry-After'] || null,
            'server': response.headers['server'] || null,
            'cf-ray': response.headers['cf-ray'] || response.headers['CF-Ray'] || null,
          },
          bodySnippet: truncate(JSON.stringify(response.data || {}), 500),
          durationMs: httpDurationMs,
          attempt: 1,
          retried: false,
          cooldownAppliedMs: cooldownMs,
        };
        await saveErrorInfo(company.name || company.id, errorInfo, this.storageAdapter);

        // Update run statistics
        this.runStats.companiesProcessed += 1;
        this.runStats.companiesFailed += 1;
        this.runStats.errors.push({
          companyId: company.id,
          companyName: company.name,
          error: `WAF blocked (${response.status})`,
          timestamp: new Date().toISOString()
        });

        // Apply cooldown
        await new Promise(resolve => setTimeout(resolve, cooldownMs));

        const result = { ...emptyResult };
        result.stats.status403 = response.status === 403 ? 1 : 0;
        result.stats.status406 = response.status === 406 ? 1 : 0;
        result.stats.httpDurationMs = httpDurationMs;
        result.stats.cooldownAppliedMs = cooldownMs;
        result.stats.totalDurationMs = Date.now() - companyStartTime;
        return result;
      }

      // Handle 429 (rate limit) - should be handled by retry logic, but log if it still happens
      if (response.status === 429) {
        // eslint-disable-next-line no-console
        console.warn(
          `ComeetWorker: Rate limited (429) for company ${company.id} after retries`
        );

        errorInfo = {
          companyId: company.id,
          companyName: company.name,
          uid: uid,
          requestUrl: targetUrl,
          statusCode: 429,
          statusText: response.statusText,
          headers: {
            'retry-after': response.headers['retry-after'] || response.headers['Retry-After'] || null,
            'server': response.headers['server'] || null,
            'cf-ray': response.headers['cf-ray'] || response.headers['CF-Ray'] || null,
          },
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
          error: 'Rate limited (429)',
          timestamp: new Date().toISOString()
        });

        const result = { ...emptyResult };
        result.stats.status429 = 1;
        result.stats.httpDurationMs = httpDurationMs;
        result.stats.totalDurationMs = Date.now() - companyStartTime;
        return result;
      }

      // Handle other non-200 status codes
      if (response.status !== 200) {
        // eslint-disable-next-line no-console
        console.warn(
          `ComeetWorker: HTTP ${response.status} for company ${company.id}: ${response.statusText}`
        );

        errorInfo = {
          companyId: company.id,
          companyName: company.name,
          uid: uid,
          requestUrl: targetUrl,
          statusCode: response.status,
          statusText: response.statusText,
          headers: {
            'retry-after': response.headers['retry-after'] || response.headers['Retry-After'] || null,
            'server': response.headers['server'] || null,
            'cf-ray': response.headers['cf-ray'] || response.headers['CF-Ray'] || null,
          },
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
        result.stats.statusOther = 1;
        result.stats.httpDurationMs = httpDurationMs;
        result.stats.totalDurationMs = Date.now() - companyStartTime;
        return result;
      }

      // Success (200) - process jobs
      processingStartTime = Date.now();
      const rawJobs = Array.isArray(response.data) ? response.data : [];

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
        skippedDedup: 0,
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
        cooldownAppliedMs: 0,
        httpDurationMs: 0,
        processingDurationMs: 0,
        totalDurationMs: 0,
      };

      const allNormalizedJobs = [];
      const unifiedJobs = [];
      const droppedJobs = []; // Track dropped jobs with reasons

      // Process each raw job
      for (const rawJob of rawJobs) {
        // STEP 0: Silent dedup — skip already-known jobs (no calibration_rejected write)
        const jobId = rawJob.position_uid
          ? `comeet_${String(rawJob.position_uid).trim()}`
          : null;

        if (jobId && knownJobIds && knownJobIds.has(jobId)) {
          stats.skippedDedup = (stats.skippedDedup || 0) + 1;
          continue;
        }

        // STEP 1: Business logic filters (explicit filter with reason tracking)
        const filterResult = filterJob(rawJob);

        if (!filterResult.passed) {
          // Job was filtered out - track it (lightweight, no raw/normalized)
          droppedJobs.push({
            jobId: rawJob.position_uid ? `comeet_${rawJob.position_uid}` : 'unknown',
            title: rawJob.name || 'Unknown',
            companyName: company.name || company.id,
            location: rawJob.location_object?.name || rawJob.location || 'Unknown',
            url: rawJob.careers_page_active_url || rawJob.careers_page_url || '',
            reason: filterResult.reason || 'Unknown filter reason',
            source: 'comeet',
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
        const unified = normalizeComeetJob(rawJob, company);
        if (!unified) {
          droppedJobs.push({
            jobId: rawJob.position_uid ? `comeet_${rawJob.position_uid}` : 'unknown',
            title: rawJob.name || 'Unknown',
            companyName: company.name || company.id,
            location: rawJob.location_object?.name || rawJob.location || 'Unknown',
            url: rawJob.careers_page_active_url || rawJob.careers_page_url || '',
            reason: 'Normalization failed',
            source: 'comeet',
          });
          continue;
        }
        stats.normalized += 1;
        allNormalizedJobs.push(unified);

        // ── Structured Fast-Track Gate (runs before regex-based ATS Guard) ──
        const structGate = evaluateStructuredGate(unified, 'comeet');

        if (structGate.verdict === 'FAIL') {
          stats.droppedGuard += 1;
          stats.droppedByReason = stats.droppedByReason || {};
          stats.droppedByReason['STRUCTURED_GATE'] = (stats.droppedByReason['STRUCTURED_GATE'] || 0) + 1;
          droppedJobs.push({
            jobId: unified.jobId,
            title: unified.title,
            companyName: company.name || company.id,
            location: unified.location,
            url: unified.url || '',
            reason: `STRUCTURED_GATE: ${structGate.reason}`,
            source: 'comeet',
          });
          continue;
        }

        if (structGate.verdict === 'WHITELIST') {
          stats.passedGuard += 1;
          unifiedJobs.push(unified);
          continue;
        }

        // ── ATS Guard (regex-based seniority/title filtering) ──
        const guard = evaluateAtsGuard(rawJob, {
          companyId: company.id,
          source: 'comeet',
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

          // Track dropped by ATS guard (lightweight, no raw/normalized)
          droppedJobs.push({
            jobId: unified.jobId,
            title: unified.title,
            companyName: company.name || company.id,
            location: unified.location,
            url: unified.url || '',
            reason: `ATS_GUARD: ${guard.reason}`,
            source: 'comeet',
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
        `ComeetWorker: failed to fetch jobs for company ${company.id}: ${message}`
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
        headers: err.response ? {
          'retry-after': err.response.headers['retry-after'] || err.response.headers['Retry-After'] || null,
          'server': err.response.headers['server'] || null,
          'cf-ray': err.response.headers['cf-ray'] || err.response.headers['CF-Ray'] || null,
        } : null,
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
  ComeetWorker,
};
