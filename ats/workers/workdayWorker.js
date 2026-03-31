/**
 * Workday Worker (Session-Based)
 *
 * "Zero-Config Intelligence" - receives simple config { name, url },
 * automatically extracts tenant/instance/site and constructs API endpoints.
 *
 * CRITICAL: Workday (Play Framework) requires:
 * 1. PLAY_SESSION cookie (established via initial GET)
 * 2. wday_vps_cookie (Akamai tracking)
 * 3. Proper browser headers to avoid WAF blocks
 *
 * Supports dynamic Israel location facet detection to bypass the 2000 job limit.
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { PATHS } = require('../../config/paths');
const { evaluateAtsGuard } = require('../filters/ats_guard');
const { israelLocationKeywords } = require('../../config/vocabulary');

const DEBUG_WORKDAY = process.env.DEBUG_WORKDAY === 'true';
const ATS_GUARD_DRY_RUN = process.env.ATS_GUARD_DRY_RUN === 'true';
const QUIET_MODE = process.env.ATS_QUIET_MODE !== 'false'; // Default: true

// Human-like delay configuration - STRICT "Ironclad Jitter" policy
// Workday WAF (Akamai) is very sensitive to rapid requests
// Minimum 5 seconds between pagination requests to simulate slow human browsing
const WORKDAY_DELAY_MIN_MS = parseInt(process.env.WORKDAY_DELAY_MIN_MS, 10) || 5000;
const WORKDAY_DELAY_MAX_MS = parseInt(process.env.WORKDAY_DELAY_MAX_MS, 10) || 6000;

// Session initialization delay (let Akamai sensors settle)
const SESSION_INIT_DELAY_MS = 2000;

// Page size for job fetching
const PAGE_LIMIT = 20;

// Standard browser headers
const BROWSER_HEADERS = {
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Ensure directory exists (recursive)
 */
function ensureDir(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    } catch (err) {
        console.error(`WorkdayWorker: failed to ensure directory ${dirPath}:`, err.message || err);
    }
}

/**
 * Log message (respects QUIET_MODE)
 */
function log(message, level = 'INFO') {
    if (!QUIET_MODE || level === 'ERROR' || level === 'WARN') {
        const prefix = level === 'ERROR' ? '[WD ERROR]' : level === 'WARN' ? '[WD WARN]' : '[WD]';
        console.log(`${prefix} ${message}`);
    }
}

/**
 * Random delay between min and max milliseconds
 */
function randomDelay(minMs, maxMs) {
    const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    return new Promise(resolve => setTimeout(() => resolve(delayMs), delayMs));
}

/**
 * Fixed delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if text matches Israel-related terms (uses centralized vocabulary).
 */
function matchesIsrael(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const terms = israelLocationKeywords || [];
    return terms.some(term => lower.includes(term));
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

// ============================================================================
// WORKDAY WORKER CLASS (SESSION-BASED)
// ============================================================================

class WorkdayWorker {
    /**
     * @param {Object} config - Company configuration
     * @param {string} config.name - Company name (e.g., "Nvidia")
     * @param {string} config.url - Workday careers URL
     *   Pattern: https://<tenant>.<instance>.myworkdayjobs.com/.../<site>/...
     */
    constructor(config, options = {}) {
        if (!config || !config.url) {
            throw new Error('WorkdayWorker: config.url is required');
        }

        this.config = config;
        this.companyName = config.name || 'Unknown';
        this.originalUrl = config.url;
        this.storageAdapter = options.storageAdapter || null;
        this.knownJobIds = options.knownJobIds || null;

        // Parse URL to extract tenant, instance, and site
        const parsed = this._parseWorkdayUrl(config.url);
        this.tenant = parsed.tenant;
        this.instance = parsed.instance;
        this.site = parsed.site;

        // Construct URLs
        this.baseUrl = `https://${this.tenant}.${this.instance}.myworkdayjobs.com`;
        this.siteUrl = `${this.baseUrl}/${this.site}`;
        this.apiEndpoint = `${this.baseUrl}/wday/cxs/${this.tenant}/${this.site}/jobs`;

        // Initialize cookie jar for session management
        this.cookieJar = new CookieJar();

        // Create axios instance with cookie support
        this.client = wrapper(axios.create({
            jar: this.cookieJar,
            withCredentials: true,
            timeout: 30000,
            headers: {
                ...BROWSER_HEADERS,
                'Origin': this.baseUrl,
                'Referer': this.siteUrl
            }
        }));

        // Session state
        this._sessionInitialized = false;

        // Cache for location facet (null = not yet looked up, false = not found)
        // Structure: { facetParam: string, valueId: string } or false
        this._locationFacet = null;

        // Debug flag for first job dump
        this._firstJobDumped = false;

        // Run statistics
        this.runStats = {
            startTime: null,
            endTime: null,
            totalFetched: 0,
            totalKept: 0,
            totalDropped: 0,
            errors: []
        };

        log(`Initialized for ${this.companyName}`);
        log(`  Site URL: ${this.siteUrl}`);
        log(`  API: ${this.apiEndpoint}`);
    }

    /**
     * Parse Workday URL to extract tenant, instance, and site
     * Pattern: https://<tenant>.<instance>.myworkdayjobs.com/.../<site>/...
     *
     * @param {string} url - Workday careers URL
     * @returns {{ tenant: string, instance: string, site: string }}
     */
    _parseWorkdayUrl(url) {
        // Pattern: https://tenant.instance.myworkdayjobs.com/site
        // Example: https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
        const regex = /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?(?:\/[a-zA-Z]{2}(?:[_-][a-zA-Z]{2})?)?\/([^/?#]+)/i;
        const match = url.match(regex);

        if (!match) {
            throw new Error(`WorkdayWorker: Unable to parse Workday URL: ${url}`);
        }

        return {
            tenant: match[1],
            instance: match[2],
            site: match[3]
        };
    }

    /**
     * Initialize session by visiting the main career site
     * This establishes PLAY_SESSION and wday_vps_cookie
     *
     * @returns {Promise<boolean>} true if session established successfully
     */
    async initSession() {
        if (this._sessionInitialized) {
            log(`Session already initialized for ${this.companyName}`);
            return true;
        }

        log(`Initializing session for ${this.companyName}...`);

        try {
            // Step 1: GET the main career site page to establish cookies
            const response = await this.client.get(this.siteUrl, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });

            log(`Session init response: ${response.status}`);

            // Step 2: Wait for Akamai sensors to settle
            log(`Waiting ${SESSION_INIT_DELAY_MS}ms for Akamai sensors...`);
            await delay(SESSION_INIT_DELAY_MS);

            // Log cookies for debugging
            const cookies = await this.cookieJar.getCookies(this.baseUrl);
            if (DEBUG_WORKDAY) {
                log(`Cookies established: ${cookies.map(c => c.key).join(', ')}`);
            }

            // Check for critical cookies
            const hasPlaySession = cookies.some(c => c.key.includes('PLAY_SESSION') || c.key.includes('session'));
            const hasVpsCookie = cookies.some(c => c.key.includes('wday_vps'));

            if (cookies.length === 0) {
                log(`Warning: No cookies received for ${this.companyName}`, 'WARN');
            } else {
                log(`Session established with ${cookies.length} cookies`);
            }

            this._sessionInitialized = true;
            return true;

        } catch (err) {
            log(`Failed to initialize session: ${err.message}`, 'ERROR');
            this.runStats.errors.push({
                type: 'session_init',
                message: err.message,
                timestamp: new Date().toISOString()
            });
            return false;
        }
    }

    /**
     * Detect the Israel location facet via nested locationMainGroup traversal.
     * Uses facetParameter (not facetId). Prefers locationHierarchy1 (country), fallback to locations (city).
     *
     * @returns {Promise<{facetParam: string, valueId: string}|null>}
     */
    async detectLocationFacet() {
        if (this._locationFacet !== null) {
            return this._locationFacet || null;
        }

        log(`Detecting location facet for ${this.companyName}...`);

        try {
            await randomDelay(WORKDAY_DELAY_MIN_MS, WORKDAY_DELAY_MAX_MS);

            const response = await this.client.post(this.apiEndpoint, {
                appliedFacets: {},
                limit: 1,
                offset: 0,
                searchText: ''
            });

            const facets = response.data?.facets || [];
            if (facets.length === 0) {
                log(`No facets returned for ${this.companyName}`, 'WARN');
                this._locationFacet = false;
                return null;
            }

            const mainGroup = facets.find(
                (f) => (f.facetParameter || f.facetId || f.facet || f.id || '') === 'locationMainGroup'
            );

            const locationMain = mainGroup || facets.find((f) => {
                const label = (f.descriptor || f.label || f.name || '').toLowerCase();
                return label.includes('location');
            });
            if (!locationMain) {
                log(`No location facet for ${this.companyName}`, 'WARN');
                this._locationFacet = false;
                return null;
            }

            const subFacets = locationMain.values || locationMain.items || locationMain.children || [];
            const preferredOrder = ['locationHierarchy1', 'locations', 'locationHierarchy2'];

            for (const subKey of preferredOrder) {
                const subFacet = subFacets.find(
                    (s) => (s.facetParameter || s.facetId || s.id || '').toLowerCase() === subKey.toLowerCase()
                );
                if (!subFacet) continue;

                const innerValues = subFacet.values || subFacet.items || subFacet.children || [];
                const israelValue = innerValues.find((v) => {
                    const label = (v.descriptor || v.label || v.name || v.value || '').toString();
                    return matchesIsrael(label);
                });
                if (israelValue) {
                    const valueId = israelValue.id || israelValue.facetValue || israelValue.value || israelValue.facetParameter;
                    const facetParam = subFacet.facetParameter || subFacet.facetId || subFacet.id;
                    if (valueId && facetParam) {
                        log(`Found Israel in ${subKey}: ${israelValue.descriptor || israelValue.label} (ID: ${valueId})`);
                        this._locationFacet = { facetParam: String(facetParam), valueId: String(valueId) };
                        return this._locationFacet;
                    }
                }
            }

            const directValues = locationMain.values || locationMain.items || [];
            const directIsrael = directValues.find((v) => {
                const label = (v.descriptor || v.label || v.name || v.value || '').toString();
                return matchesIsrael(label);
            });
            if (directIsrael) {
                const valueId = directIsrael.id || directIsrael.facetValue || directIsrael.value;
                const facetParam = locationMain.facetParameter || locationMain.facetId || locationMain.id;
                if (valueId && facetParam) {
                    this._locationFacet = { facetParam: String(facetParam), valueId: String(valueId) };
                    return this._locationFacet;
                }
            }

            this._locationFacet = false;
            return null;
        } catch (err) {
            log(`Failed to detect location facet: ${err.message}`, 'ERROR');
            if (DEBUG_WORKDAY && err.response) {
                log(`Response status: ${err.response.status}`);
            }
            this._locationFacet = false;
            return null;
        }
    }

    /**
     * Fetch all jobs from Workday API (with pagination)
     *
     * @returns {Promise<{ jobs: Array, stats: Object }>}
     */
    async fetchJobs() {
        this.runStats.startTime = new Date().toISOString();
        const encounteredJobIds = new Set();

        // Step 0: Initialize session (CRITICAL for Workday)
        const sessionOk = await this.initSession();
        if (!sessionOk) {
            log(`Session init failed for ${this.companyName}, attempting to continue anyway...`, 'WARN');
        }

        const allJobs = [];
        const droppedJobs = [];
        const stats = {
            fetched: 0,
            kept: 0,
            dropped: 0,
            droppedByReason: {},
            pages: 0,
            searchTextFilter: true,
            facetFilterApplied: false,
            wafBlocks: 0,
            httpErrors: [],
            serverErrors: 0,
            workerSubTypes: {},
            jobFamilyGroups: {}
        };

        // =====================================================================
        // DUAL FILTER STRATEGY:
        // 1. PRIMARY: searchText="Israel" - Server-side text search (always applied)
        // 2. BONUS: Facet filter - Applied if we can detect the Israel facet ID
        // This combination gives us the best chance of reducing the result set.
        // =====================================================================

        // Step 1: Try to detect location facet (BONUS filter - may fail on some tenants)
        const locationFacet = await this.detectLocationFacet();
        stats.facetFilterApplied = !!locationFacet;

        // Build appliedFacets for filtering using DYNAMIC facet parameter
        const appliedFacets = {};
        if (locationFacet) {
            // BONUS: Apply facet filter in addition to searchText
            appliedFacets[locationFacet.facetParam] = [locationFacet.valueId];
            log(`BONUS: Applying facet filter: ${locationFacet.facetParam}=${locationFacet.valueId}`);
        } else {
            log(`Facet detection failed - relying on searchText filter only`, 'WARN');
        }

        // PRIMARY FILTER: Israel search text (server-side pre-filtering)
        // This is the key optimization - reduces ~2000 jobs to ~50-100
        const searchText = 'Israel';
        log(`PRIMARY: Using searchText="${searchText}" for server-side filtering`);

        // Step 2: Paginate through all jobs
        let offset = 0;
        let hasMore = true;
        let totalJobs = null;

        while (hasMore) {
            try {
                await randomDelay(WORKDAY_DELAY_MIN_MS, WORKDAY_DELAY_MAX_MS);

                // Payload with BOTH filters:
                // - searchText: Primary filter (always "Israel")
                // - appliedFacets: Bonus filter (if facet was detected)
                const payload = {
                    appliedFacets,
                    limit: PAGE_LIMIT,
                    offset,
                    searchText  // PRIMARY: Server-side text search
                };

                const response = await this.client.post(this.apiEndpoint, payload);

                const data = response.data;
                const jobs = data.jobPostings || data.jobs || [];
                totalJobs = data.total || totalJobs;

                if (stats.pages === 0 && Array.isArray(data.facets)) {
                    for (const f of data.facets) {
                        const param = (f.facetParameter || f.facetId || f.id || '').toLowerCase();
                        if (param.includes('workersubtype') || param.includes('worker_sub_type')) {
                            const vals = f.values || f.items || [];
                            for (const v of vals) {
                                const d = (v.descriptor || v.label || v.name || '').trim();
                                if (d) stats.workerSubTypes[d] = (stats.workerSubTypes[d] || 0) + (v.count || 0);
                            }
                        }
                        if (param.includes('jobfamilygroup') || param.includes('job_family')) {
                            const vals = f.values || f.items || [];
                            for (const v of vals) {
                                const d = (v.descriptor || v.label || v.name || '').trim();
                                if (d) stats.jobFamilyGroups[d] = (stats.jobFamilyGroups[d] || 0) + (v.count || 0);
                            }
                        }
                    }
                }

                stats.pages += 1;
                stats.fetched += jobs.length;

                const keywords = israelLocationKeywords || [];

                for (const rawJob of jobs) {
                    const unified = this._normalizeJob(rawJob);
                    if (unified && unified.jobId) {
                        encounteredJobIds.add(String(unified.jobId));
                    }

                    if (!unified) {
                        stats.dropped += 1;
                        stats.droppedByReason['Normalization'] = (stats.droppedByReason['Normalization'] || 0) + 1;
                        droppedJobs.push({
                            jobId: rawJob.externalPath ? `workday_${this.tenant}_unknown` : 'unknown',
                            title: rawJob.title || 'Unknown',
                            companyName: this.companyName,
                            location: rawJob.locationsText || 'Unknown',
                            reason: 'Normalization failed',
                            source: 'workday',
                            gate: 'normalization'
                        });
                        continue;
                    }

                    if (!locationFacet) {
                        const loc = (unified.location || '').toLowerCase();
                        const matchRemote = loc.includes('remote');
                        const matchIsrael = keywords.some((k) => loc.includes(k));
                        if (!matchIsrael && !matchRemote) {
                            stats.dropped += 1;
                            stats.droppedByReason['Location'] = (stats.droppedByReason['Location'] || 0) + 1;
                            droppedJobs.push({
                                jobId: unified.jobId,
                                title: unified.title,
                                companyName: this.companyName,
                                location: unified.location,
                                reason: `Location: ${unified.location} (not IL/Remote)`,
                                source: 'workday',
                                gate: 'location',
                                structuredLevel: unified.structuredLevel,
                                structuredDepartment: unified.structuredDepartment
                            });
                            continue;
                        }
                    }

                    const guardPayload = {
                        title: unified.title,
                        location: unified.location,
                        departments: unified.structuredDepartment ? [{ name: unified.structuredDepartment }] : [],
                        description: null,
                        structuredLevel: unified.structuredLevel
                    };
                    const guard = evaluateAtsGuard(guardPayload, {
                        companyId: this.companyName,
                        source: 'workday'
                    });

                    if (guard.verdict !== 'PASS' && !ATS_GUARD_DRY_RUN) {
                        stats.dropped += 1;
                        stats.droppedByReason['ATS_GUARD'] = (stats.droppedByReason['ATS_GUARD'] || 0) + 1;
                        droppedJobs.push({
                            jobId: unified.jobId,
                            title: unified.title,
                            companyName: this.companyName,
                            location: unified.location,
                            reason: guard.reason ? `ATS_GUARD: ${guard.reason}` : 'ATS_GUARD',
                            source: 'workday',
                            gate: guard.gate || 'ats_guard',
                            matchedBlacklistPatterns: guard.matchedBlacklistPatterns || [],
                            structuredLevel: unified.structuredLevel,
                            structuredDepartment: unified.structuredDepartment
                        });
                        continue;
                    }

                    stats.kept += 1;
                    unified.matchedKeywords = guard.matchedKeywords || [];
                    allJobs.push(unified);
                }

                log(`Page ${stats.pages}: ${jobs.length} jobs (offset: ${offset}, total: ${totalJobs || '?'})`);

                // Check if more pages
                offset += PAGE_LIMIT;
                hasMore = jobs.length === PAGE_LIMIT && (totalJobs === null || offset < totalJobs);

            } catch (err) {
                const status = err.response && err.response.status;
                if (status === 403) {
                    stats.wafBlocks = (stats.wafBlocks || 0) + 1;
                    stats.httpErrors.push({
                        status: 403,
                        offset,
                        timestamp: new Date().toISOString()
                    });
                    log(`[WAF_BLOCK] ${this.companyName} blocked at offset ${offset}`, 'ERROR');
                } else if (status >= 500) {
                    stats.serverErrors = (stats.serverErrors || 0) + 1;
                }
                log(`Pagination error at offset ${offset}: ${err.message}`, 'ERROR');
                this.runStats.errors.push({
                    type: 'pagination',
                    offset,
                    message: err.message,
                    timestamp: new Date().toISOString()
                });
                hasMore = false;
            }
        }

        this.runStats.endTime = new Date().toISOString();
        this.runStats.totalFetched = stats.fetched;
        this.runStats.totalKept = stats.kept;
        this.runStats.totalDropped = stats.dropped;

        if (this.storageAdapter) {
            try {
                if (droppedJobs.length > 0) {
                    await this.storageAdapter.writeCalibrationRejected(droppedJobs);
                }
                await this.storageAdapter.writeRunLog({
                    type: 'summary',
                    source: 'workday',
                    timestamp: this.runStats.endTime,
                    payload: { ...stats, companyName: this.companyName }
                });
            } catch (e) {
                log(`Failed to persist calibration/run summary: ${e.message}`, 'ERROR');
            }
        }

        log(`${this.companyName}: Fetched ${stats.fetched}, Kept ${stats.kept}, Dropped ${stats.dropped}`);

        return { jobs: allJobs, stats, encounteredJobIds };
    }

    /**
     * Normalize raw Workday job to UnifiedJob structure.
     * 
     * Uses "Cascading Fallback" strategy to handle varying Workday API schemas.
     * Different tenants return data in different structures (bulletFields, 
     * jobRequisition, flat fields, etc.).
     *
     * @param {Object} rawJob - Raw job from Workday API
     * @returns {Object|null} UnifiedJob or null if invalid
     */
    _normalizeJob(rawJob) {
        if (!rawJob) {
            log('Normalize: received null/undefined rawJob', 'WARN');
            return null;
        }

        // DEBUG: Dump first raw job for schema analysis
        if (!this._firstJobDumped) {
            this._firstJobDumped = true;
            log(`[DEBUG] First raw job object for ${this.companyName}:`);
            console.log(JSON.stringify(rawJob, null, 2));
        }

        // =====================================================================
        // ROBUST ID EXTRACTION — canonical regex supports JR, R-prefix, numeric (e.g. Cisco)
        // =====================================================================
        const CANONICAL_ID_RE = /^(JR[-]?\d+|R\d+|\d{5,})$/i;
        const JR_RE = /JR\d{4,}/;
        const JR_ONLY_RE = /^JR\d+$/i;

        const externalPath = rawJob.externalPath || rawJob.path || '';
        const bullets = Array.isArray(rawJob.bulletFields) ? rawJob.bulletFields : [];

        function extractIdFromPath(pathStr) {
            if (!pathStr) return null;
            const segment = pathStr.split('/').filter(Boolean).pop() || '';
            const parts = segment.split('_');
            for (let i = parts.length - 1; i >= 0; i--) {
                const cleaned = (parts[i] || '').replace(/-?\d+$/, '');
                if (CANONICAL_ID_RE.test(cleaned)) return cleaned;
                if (CANONICAL_ID_RE.test(parts[i])) return parts[i].replace(/-?\d+$/, '');
            }
            return null;
        }

        let extractedId = null;
        if (rawJob.jobRequisition?.id && CANONICAL_ID_RE.test(String(rawJob.jobRequisition.id).trim())) {
            extractedId = String(rawJob.jobRequisition.id).trim().replace(/-?\d+$/, '');
        }
        if (!extractedId) {
            const pathJr = externalPath.match(JR_RE);
            if (pathJr) extractedId = pathJr[0];
        }
        if (!extractedId) extractedId = extractIdFromPath(externalPath);
        if (!extractedId) {
            for (let i = 0; i < bullets.length; i++) {
                const val = String(bullets[i] || '').trim();
                if (CANONICAL_ID_RE.test(val)) {
                    extractedId = val.replace(/-?\d+$/, '');
                    break;
                }
            }
        }
        if (!extractedId && (rawJob.title || rawJob.name)) {
            const m = (rawJob.title || '').match(JR_RE) || (rawJob.name || '').match(JR_RE);
            if (m) extractedId = m[0];
        }

        const jobId = extractedId
            || rawJob.id || rawJob.jobId || rawJob.jobRequisitionId
            || (externalPath ? externalPath.replace(/^\//, '').replace(/[\/\s]/g, '_').substring(0, 80) : null)
            || `unknown_${Date.now()}`;

        // =====================================================================
        // TITLE EXTRACTION — skip JR-only strings and location-like strings
        // =====================================================================
        const locationIndicators = /^(\d+ Locations?|Israel|Remote|United States|US|India|UK|Germany|China|Japan)/i;
        const titleCandidates = [];

        if (rawJob.title && typeof rawJob.title === 'string') titleCandidates.push(rawJob.title.trim());
        for (const b of bullets) {
            if (b && typeof b === 'string') titleCandidates.push(b.trim());
        }
        if (rawJob.jobRequisition?.title) titleCandidates.push(rawJob.jobRequisition.title.trim());
        if (rawJob.name && typeof rawJob.name === 'string') titleCandidates.push(rawJob.name.trim());

        let title = '';
        for (const candidate of titleCandidates) {
            if (!candidate) continue;
            if (JR_ONLY_RE.test(candidate)) continue;
            if (locationIndicators.test(candidate)) continue;
            if (/^(Full time|Part time|Regular|Temporary)$/i.test(candidate)) continue;
            title = candidate;
            break;
        }

        if (!title) {
            log(`Normalize: missing title in job. Available keys: ${Object.keys(rawJob).join(', ')}`, 'WARN');
            if (DEBUG_WORKDAY) {
                log(`Raw job sample: ${JSON.stringify(rawJob).substring(0, 500)}...`);
            }
            return null;
        }

        // =====================================================================
        // LOCATION EXTRACTION - Cascading Fallback Strategy
        // =====================================================================
        let location = '';

        // Try 1: Direct locationsText field
        if (rawJob.locationsText && typeof rawJob.locationsText === 'string') {
            location = rawJob.locationsText;
        }

        // Try 2: bulletFields (location often at index 1 or 2)
        if ((!location || location.includes(' Locations')) && Array.isArray(rawJob.bulletFields)) {
            // Search bulletFields for location-like content (skip first which is usually title)
            for (let i = 1; i < rawJob.bulletFields.length; i++) {
                const field = rawJob.bulletFields[i] || '';
                // Check if this looks like a location (contains common patterns)
                if (field.match(/[A-Z]{2}[-\s]/i) || // State/country code pattern
                    field.includes(',') || // City, State format
                    matchesIsrael(field) ||
                    field.toLowerCase().includes('remote')) {
                    location = field;
                    break;
                }
            }
        }

        // Try 3: Nested location object
        if (!location && rawJob.location?.descriptor) {
            location = rawJob.location.descriptor;
        }
        if (!location && rawJob.primaryLocation?.descriptor) {
            location = rawJob.primaryLocation.descriptor;
        }

        // Try 4: postingLocation field
        if (!location && rawJob.postingLocation) {
            location = typeof rawJob.postingLocation === 'string' ?
                rawJob.postingLocation :
                rawJob.postingLocation.descriptor || rawJob.postingLocation.name || '';
        }

        // Try 5: Extract from externalPath when "N Locations"
        if (!location || location.includes(' Locations')) {
            const pathMatch = externalPath.match(/\/job\/([^/]+)\//);
            if (pathMatch) {
                location = pathMatch[1].replace(/-/g, ', ');
            }
        }
        if (!location || location.includes(' Locations')) {
            location = 'Multiple Locations';
        }

        // =====================================================================
        // URL CONSTRUCTION
        // =====================================================================
        const url = externalPath ? `${this.siteUrl}${externalPath}` : this.siteUrl;

        // =====================================================================
        // POSTED DATE EXTRACTION
        // =====================================================================
        let postedAt = null;
        const postedRaw = rawJob.postedOn || rawJob.postedDate || rawJob.postingDate || '';

        if (postedRaw) {
            const postedText = postedRaw.toLowerCase();
            const now = new Date();

            if (postedText.includes('today')) {
                postedAt = now.toISOString();
            } else if (postedText.includes('yesterday')) {
                now.setDate(now.getDate() - 1);
                postedAt = now.toISOString();
            } else {
                const daysMatch = postedText.match(/(\d+)\s*day/);
                if (daysMatch) {
                    now.setDate(now.getDate() - parseInt(daysMatch[1], 10));
                    postedAt = now.toISOString();
                }
            }
        }

        return {
            jobId: `workday_${this.tenant}_${jobId}`,
            source: 'workday',
            sourceCompanyId: this.tenant,
            companyName: this.companyName,
            title,
            location,
            url,
            description: null,
            postedAt,
            structuredLevel: null,
            structuredDepartment: null,
            timeType: rawJob.timeType != null ? String(rawJob.timeType) : undefined,
            raw: rawJob
        };
    }

    /**
     * Fetch all jobs (standardized contract: { jobs, stats }).
     *
     * @param {Object} company - Company config (for compatibility)
     * @returns {Promise<{ jobs: Array<UnifiedJob>, stats: Object }>}
     */
    async fetchAllJobs(company) {
        const result = await this.fetchJobs();
        return { jobs: result.jobs, stats: result.stats };
    }

    /**
     * Get current run statistics
     */
    getRunStats() {
        return { ...this.runStats };
    }
}

// ============================================================================
// FACTORY FUNCTION (for use by orchestrator)
// ============================================================================

/**
 * Create a WorkdayWorker instance for a company
 *
 * @param {Object} company - Company config with { name, url, uid }
 * @param {Object} [options] - { storageAdapter, knownJobIds }
 * @returns {WorkdayWorker}
 */
function createWorkdayWorker(company, options = {}) {
    return new WorkdayWorker(
        { name: company.name || company.id, url: company.url || company.uid },
        options
    );
}

module.exports = {
    WorkdayWorker,
    createWorkdayWorker
};
