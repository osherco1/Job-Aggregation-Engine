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

// Israel-related search terms (case-insensitive)
const ISRAEL_TERMS = ['israel', 'tel aviv', 'tel-aviv', 'yokneam', 'haifa', 'herzliya', 'raanana', 'petah tikva', 'jerusalem'];

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
 * Check if text matches Israel-related terms
 */
function matchesIsrael(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return ISRAEL_TERMS.some(term => lower.includes(term));
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
    constructor(config) {
        if (!config || !config.url) {
            throw new Error('WorkdayWorker: config.url is required');
        }

        this.config = config;
        this.companyName = config.name || 'Unknown';
        this.originalUrl = config.url;

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
        const regex = /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?\/([^/?#]+)/i;
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
     * Detect the Israel location facet dynamically by querying the API.
     * 
     * CRITICAL: Workday facet keys vary by tenant (e.g., 'locationHierarchy1', 
     * 'locations', 'CurrentLocation'). We must extract BOTH the facet parameter
     * name AND the value ID from the response.
     *
     * @returns {Promise<{facetParam: string, valueId: string}|null>} 
     *          Facet info object or null if not found
     */
    async detectLocationFacet() {
        // Return cached value if already looked up
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

            // Debug: Log all available facets for diagnostics
            if (DEBUG_WORKDAY) {
                log(`Available facets: ${JSON.stringify(facets.map(f => ({
                    id: f.facetId || f.facet || f.id,
                    label: f.descriptor || f.label || f.name
                })))}`);
            }

            // Find location facet - check multiple possible key patterns
            // Workday uses various names: locationHierarchy1, locations, CurrentLocation, etc.
            const locationFacet = facets.find(f => {
                // Handle both string and object facetId
                const facetId = typeof f.facetId === 'string' ? f.facetId :
                    typeof f.facet === 'string' ? f.facet :
                        typeof f.id === 'string' ? f.id : '';
                const facetLabel = f.descriptor || f.label || f.name || '';
                const searchStr = (facetId + ' ' + facetLabel).toLowerCase();
                return searchStr.includes('location');
            });

            if (!locationFacet) {
                log(`No location facet found for ${this.companyName}`, 'WARN');
                log(`Available facet keys: ${facets.map(f => f.facetId || f.facet || f.id || 'unknown').join(', ')}`, 'WARN');
                this._locationFacet = false;
                return null;
            }

            // CRITICAL: Extract the actual facet parameter name dynamically
            const facetParam = locationFacet.facetId || locationFacet.facet || locationFacet.id;
            if (!facetParam || typeof facetParam !== 'string') {
                log(`Location facet found but facetId is invalid: ${JSON.stringify(locationFacet)}`, 'WARN');
                this._locationFacet = false;
                return null;
            }

            log(`Found location facet with key: "${facetParam}"`);

            // Search for Israel in the facet values
            // Handle multiple possible structures: values, items, children, data
            const values = locationFacet.values || locationFacet.items ||
                locationFacet.children || locationFacet.data || [];

            if (values.length === 0) {
                log(`Location facet "${facetParam}" has no values`, 'WARN');
                this._locationFacet = false;
                return null;
            }

            const israelValue = values.find(v => {
                // Handle various label field names
                const label = v.descriptor || v.label || v.name || v.value ||
                    v.displayName || v.text || '';
                return matchesIsrael(label);
            });

            if (israelValue) {
                // Extract value ID - handle various field names
                const valueId = israelValue.id || israelValue.facetValue ||
                    israelValue.value || israelValue.facetParameter;
                const label = israelValue.descriptor || israelValue.label ||
                    israelValue.name || israelValue.displayName;
                const count = israelValue.count || '?';

                if (!valueId) {
                    log(`Israel found but value ID is missing: ${JSON.stringify(israelValue)}`, 'WARN');
                    this._locationFacet = false;
                    return null;
                }

                log(`Found Israel: "${label}" (Param: ${facetParam}, ID: ${valueId}, Jobs: ${count})`);

                // Cache and return the complete facet info
                this._locationFacet = { facetParam, valueId };
                return this._locationFacet;
            }

            log(`No Israel location found in ${values.length} locations for ${this.companyName}`, 'WARN');
            if (DEBUG_WORKDAY && values.length > 0) {
                log(`Sample locations: ${values.slice(0, 5).map(v =>
                    v.descriptor || v.label || v.name || 'unknown'
                ).join(', ')}...`);
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

        // Step 0: Initialize session (CRITICAL for Workday)
        const sessionOk = await this.initSession();
        if (!sessionOk) {
            log(`Session init failed for ${this.companyName}, attempting to continue anyway...`, 'WARN');
        }

        const allJobs = [];
        const stats = {
            fetched: 0,
            kept: 0,
            dropped: 0,
            droppedByReason: {},
            pages: 0,
            searchTextFilter: true,  // Primary strategy
            facetFilterApplied: false  // Bonus if detected
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

                stats.pages += 1;
                stats.fetched += jobs.length;

                // Process each job
                for (const rawJob of jobs) {
                    const unified = this._normalizeJob(rawJob);

                    if (!unified) {
                        stats.dropped += 1;
                        stats.droppedByReason['Normalization'] = (stats.droppedByReason['Normalization'] || 0) + 1;
                        continue;
                    }

                    // Apply location filter (if not already filtered by facet)
                    if (!locationFacet) {
                        const location = (unified.location || '').toLowerCase();
                        if (!matchesIsrael(location) && !location.includes('remote')) {
                            stats.dropped += 1;
                            stats.droppedByReason['Location'] = (stats.droppedByReason['Location'] || 0) + 1;
                            continue;
                        }
                    }

                    // Apply ATS Guard (title/seniority filter)
                    const guard = evaluateAtsGuard(rawJob, {
                        companyId: this.companyName,
                        source: 'workday'
                    });

                    if (guard.verdict !== 'PASS' && !ATS_GUARD_DRY_RUN) {
                        stats.dropped += 1;
                        stats.droppedByReason['ATS_GUARD'] = (stats.droppedByReason['ATS_GUARD'] || 0) + 1;
                        continue;
                    }

                    stats.kept += 1;
                    allJobs.push(unified);
                }

                log(`Page ${stats.pages}: ${jobs.length} jobs (offset: ${offset}, total: ${totalJobs || '?'})`);

                // Check if more pages
                offset += PAGE_LIMIT;
                hasMore = jobs.length === PAGE_LIMIT && (totalJobs === null || offset < totalJobs);

            } catch (err) {
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

        // Finalize stats
        this.runStats.endTime = new Date().toISOString();
        this.runStats.totalFetched = stats.fetched;
        this.runStats.totalKept = stats.kept;
        this.runStats.totalDropped = stats.dropped;

        log(`${this.companyName}: Fetched ${stats.fetched}, Kept ${stats.kept}, Dropped ${stats.dropped}`);

        return { jobs: allJobs, stats };
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
        // TITLE EXTRACTION - Cascading Fallback Strategy
        // =====================================================================
        // Priority: direct title > bulletFields[0] > jobRequisition.title > name
        let title = '';

        // Try 1: Direct title field
        if (rawJob.title && typeof rawJob.title === 'string') {
            title = rawJob.title.trim();
        }

        // Try 2: bulletFields array (common in Workday CXS responses)
        if (!title && Array.isArray(rawJob.bulletFields) && rawJob.bulletFields.length > 0) {
            // First bullet is usually the title
            title = (rawJob.bulletFields[0] || '').trim();
        }

        // Try 3: Nested jobRequisition object
        if (!title && rawJob.jobRequisition?.title) {
            title = rawJob.jobRequisition.title.trim();
        }

        // Try 4: Fallback to 'name' field
        if (!title && rawJob.name && typeof rawJob.name === 'string') {
            title = rawJob.name.trim();
        }

        if (!title) {
            log(`Normalize: missing title in job. Available keys: ${Object.keys(rawJob).join(', ')}`, 'WARN');
            if (DEBUG_WORKDAY) {
                log(`Raw job sample: ${JSON.stringify(rawJob).substring(0, 500)}...`);
            }
            return null;
        }

        // =====================================================================
        // JOB ID EXTRACTION
        // FIX 3: Deterministic IDs — extract JR number from title/bulletFields
        //        before falling back to non-deterministic Date.now()
        // =====================================================================
        const externalPath = rawJob.externalPath || rawJob.path || '';
        const jobIdMatch = externalPath.match(/_(JR\d+)$/) || externalPath.match(/([A-Z0-9_-]+)$/i);

        // FIX 3: Try to extract JR requisition number from title or bulletFields
        const _titleStr = rawJob.title || '';
        const _bulletsStr = Array.isArray(rawJob.bulletFields) ? rawJob.bulletFields.join(' ') : '';
        const _jrMatch = _titleStr.match(/(JR\d{4,})/) || _bulletsStr.match(/(JR\d{4,})/);

        const jobId = rawJob.id || rawJob.jobId || rawJob.jobRequisitionId ||
            (jobIdMatch ? jobIdMatch[1] : null) ||
            externalPath.replace(/[\/\s]/g, '_') ||
            (_jrMatch ? _jrMatch[1] : null) ||
            `unknown_${Date.now()}`;
        // #region agent log
        const _idSource = rawJob.id ? 'rawJob.id' : rawJob.jobId ? 'rawJob.jobId' : rawJob.jobRequisitionId ? 'rawJob.jobRequisitionId' : (jobIdMatch ? 'externalPath_regex' : (externalPath.replace(/[\/\s]/g, '_') ? 'externalPath_replace' : (_jrMatch ? 'title_bulletFields_JR' : 'DATE_NOW_FALLBACK')));
        try{require('fs').appendFileSync(require('path').join(__dirname,'..','..', '.cursor','debug.log'),JSON.stringify({location:'workdayWorker.js:_normalizeJob',data:{finalJobId:`workday_${this.tenant}_${jobId}`,idSource:_idSource,hasExternalPath:!!externalPath,jrExtracted:_jrMatch?_jrMatch[1]:null,title:title.substring(0,50)},hypothesisId:'H3',timestamp:Date.now()})+'\n');}catch(_){}
        // #endregion

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

        // Try 5: Extract from externalPath as last resort
        if (!location || location === '2 Locations' || location.includes(' Locations')) {
            const pathMatch = externalPath.match(/\/job\/([^/]+)\//);
            if (pathMatch) {
                location = pathMatch[1].replace(/-/g, ', ');
            }
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
            description: null, // Workday list API doesn't include full description
            postedAt,
            raw: rawJob
        };
    }

    /**
     * Fetch all jobs (alias for consistency with other workers).
     * Called by orchestrator.
     *
     * IMPORTANT: Returns ONLY the jobs array, not { jobs, stats }.
     * The orchestrator/tests expect Promise<Array<UnifiedJob>>.
     *
     * @param {Object} company - Company config (for compatibility)
     * @returns {Promise<Array<UnifiedJob>>} Array of normalized jobs
     */
    async fetchAllJobs(company) {
        const result = await this.fetchJobs();
        // CRITICAL: Return only the jobs array, not the full object
        return result.jobs;
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
 * @returns {WorkdayWorker}
 */
function createWorkdayWorker(company) {
    return new WorkdayWorker({
        name: company.name || company.id,
        url: company.url || company.uid
    });
}

module.exports = {
    WorkdayWorker,
    createWorkdayWorker
};
