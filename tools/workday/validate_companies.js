/**
 * Workday Company Validator
 * 
 * Validates proposed Workday company configs by establishing a session and
 * probing the jobs API. Mirrors the session-based approach from WorkdayWorker.
 *
 * Usage:
 *   node tools/workday/validate_companies.js '[{...}, {...}]'
 *   node tools/workday/validate_companies.js --file candidates.json
 *
 * Programmatic:
 *   const { validateCompanies } = require('./validate_companies');
 *   const result = await validateCompanies([{ id, name, url }]);
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REQUEST_TIMEOUT_MS = 30000;
const SESSION_INIT_DELAY_MS = 2000;
const INTER_COMPANY_DELAY_MS = 3000;

const REQUIRED_FIELDS = ['id', 'name', 'url'];

// Regex from WorkdayWorker._parseWorkdayUrl
const WORKDAY_URL_REGEX = /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?\/([^/?#]+)/i;

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
    'Sec-Fetch-Site': 'same-origin',
};

const SESSION_INIT_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    return delay(ms);
}

/**
 * Parse a Workday URL to extract tenant, instance, and site.
 * @param {string} url
 * @returns {{ tenant: string, instance: string, site: string } | null}
 */
function parseWorkdayUrl(url) {
    const match = url.match(WORKDAY_URL_REGEX);
    if (!match) return null;
    return { tenant: match[1], instance: match[2], site: match[3] };
}

/**
 * Validate a single company config against the Workday API.
 * @param {Object} company - Proposed company config
 * @returns {Promise<{ approved: boolean, company: Object, reason?: string, httpStatus?: number, jobCount?: number, tenant?: string, instance?: string, site?: string }>}
 */
async function validateOne(company) {
    // --- Step 1: Schema check ---
    for (const field of REQUIRED_FIELDS) {
        if (!company[field] || String(company[field]).trim() === '') {
            return { approved: false, company, reason: `Missing required field: ${field}` };
        }
    }

    if (company.type && company.type !== 'workday') {
        return { approved: false, company, reason: `Invalid type: "${company.type}" (expected "workday")` };
    }

    const url = String(company.url).trim();

    // --- Step 2: Parse URL ---
    const parsed = parseWorkdayUrl(url);
    if (!parsed) {
        return { approved: false, company, reason: `Unable to parse Workday URL: ${url}` };
    }

    const { tenant, instance, site } = parsed;
    const baseUrl = `https://${tenant}.${instance}.myworkdayjobs.com`;
    const siteUrl = `${baseUrl}/${site}`;
    const apiUrl = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`;

    // --- Step 3: Create session-capable client ---
    const cookieJar = new CookieJar();
    const client = wrapper(axios.create({
        jar: cookieJar,
        withCredentials: true,
        timeout: REQUEST_TIMEOUT_MS,
    }));

    try {
        // --- Step 4: Session initialization ---
        const sessionResponse = await client.get(siteUrl, {
            headers: SESSION_INIT_HEADERS,
            maxRedirects: 5,
            validateStatus: () => true,
        });

        if (sessionResponse.status >= 400) {
            const bodySnippet = typeof sessionResponse.data === 'string'
                ? sessionResponse.data.substring(0, 500)
                : JSON.stringify(sessionResponse.data).substring(0, 500);
            console.error(`  🔍 [WD Validator Debug] Session init failed for: ${siteUrl}`);
            console.error(`     Status: ${sessionResponse.status} ${sessionResponse.statusText || ''}`);
            console.error(`     Body (first 500 chars): ${bodySnippet}`);
            return {
                approved: false,
                company,
                reason: `Session init failed: HTTP ${sessionResponse.status}`,
                httpStatus: sessionResponse.status,
            };
        }

        // Wait for Akamai sensors to settle
        await delay(SESSION_INIT_DELAY_MS);

        // --- Step 5: API probe ---
        const apiResponse = await client.post(apiUrl, {
            appliedFacets: {},
            limit: 20,
            offset: 0,
            searchText: '',
        }, {
            headers: {
                ...BROWSER_HEADERS,
                'Origin': baseUrl,
                'Referer': siteUrl,
            },
            validateStatus: () => true,
        });

        const status = apiResponse.status;

        // --- Step 6: Status check ---
        if (status === 403) {
            return {
                approved: false,
                company,
                reason: 'WAF blocked (403) — possible bot detection',
                httpStatus: 403,
            };
        }

        if (status < 200 || status >= 300) {
            return {
                approved: false,
                company,
                reason: `HTTP ${status}: ${apiResponse.statusText || 'Unknown'}`,
                httpStatus: status,
            };
        }

        // --- Step 7: Response shape validation ---
        const contentType = apiResponse.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
            return {
                approved: false,
                company,
                reason: `Response is not JSON (Content-Type: ${contentType})`,
                httpStatus: status,
            };
        }

        const data = apiResponse.data;

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return {
                approved: false,
                company,
                reason: `Expected JSON object, got ${Array.isArray(data) ? 'Array' : typeof data}`,
                httpStatus: status,
            };
        }

        // Workday returns { jobPostings: [...], total: N } or { jobs: [...] }
        const jobs = data.jobPostings || data.jobs;
        if (!Array.isArray(jobs)) {
            return {
                approved: false,
                company,
                reason: `Missing jobPostings/jobs array in response. Keys found: ${Object.keys(data).join(', ')}`,
                httpStatus: status,
            };
        }

        const total = typeof data.total === 'number' ? data.total : jobs.length;

        // Spot-check first job element
        if (jobs.length > 0) {
            const sample = jobs[0];
            const hasTitle = sample.title || (Array.isArray(sample.bulletFields) && sample.bulletFields.length > 0);
            const hasPath = sample.externalPath || sample.path;

            if (!hasTitle && !hasPath) {
                return {
                    approved: false,
                    company,
                    reason: `Job objects lack title/bulletFields and externalPath. Keys found: ${Object.keys(sample).join(', ')}`,
                    httpStatus: status,
                };
            }
        }

        // --- Step 8: Approved ---
        return {
            approved: true,
            company,
            jobCount: total,
            httpStatus: status,
            tenant,
            instance,
            site,
        };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            return { approved: false, company, reason: `Request timed out after ${REQUEST_TIMEOUT_MS}ms` };
        }
        return { approved: false, company, reason: `Network error: ${err.message}` };
    }
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate an array of proposed Workday company configs.
 * @param {Array<Object>} companies - Array of company config objects
 * @returns {Promise<{ approved: Array, rejected: Array }>}
 */
async function validateCompanies(companies) {
    if (!Array.isArray(companies) || companies.length === 0) {
        console.error('[Workday Validator] Input must be a non-empty array of company objects.');
        return { approved: [], rejected: [] };
    }

    const approved = [];
    const rejected = [];

    console.log(`\n[Workday Validator] Validating ${companies.length} company/ies...\n`);
    console.log(`  ⚠  Note: Workday validation is slower (~5-8s per company due to session init)\n`);

    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const label = company.name || company.id || `#${i}`;

        try {
            if (i > 0) {
                await randomDelay(2000, INTER_COMPANY_DELAY_MS);
            }

            const startMs = Date.now();
            const result = await validateOne(company);
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

            if (result.approved) {
                approved.push({
                    ...company,
                    tenant: result.tenant,
                    instance: result.instance,
                    site: result.site,
                    jobCount: result.jobCount,
                    validatedAt: new Date().toISOString(),
                });
                console.log(`  ✅  ${label} — APPROVED (${result.jobCount} jobs, ${elapsed}s)`);
            } else {
                rejected.push({ ...company, reason: result.reason, httpStatus: result.httpStatus });
                console.log(`  ❌  ${label} — REJECTED: ${result.reason} (${elapsed}s)`);
            }
        } catch (err) {
            rejected.push({ ...company, reason: `Unexpected error: ${err.message}` });
            console.log(`  ❌  ${label} — REJECTED: Unexpected error: ${err.message}`);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Workday Validator] Results: ${approved.length} approved, ${rejected.length} rejected`);
    console.log(`${'─'.repeat(60)}\n`);

    return { approved, rejected };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        let companies;

        if (args.includes('--file')) {
            const fileIdx = args.indexOf('--file') + 1;
            const filePath = path.resolve(args[fileIdx]);
            if (!fs.existsSync(filePath)) {
                console.error(`File not found: ${filePath}`);
                process.exit(1);
            }
            companies = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } else if (args.length > 0) {
            companies = JSON.parse(args[0]);
        } else {
            console.log('Usage:');
            console.log('  node tools/workday/validate_companies.js \'[{"id":"x","name":"X","url":"https://...myworkdayjobs.com/..."}]\'');
            console.log('  node tools/workday/validate_companies.js --file candidates.json');
            process.exit(0);
        }

        const result = await validateCompanies(companies);
        console.log(JSON.stringify(result, null, 2));
    })();
}

module.exports = { validateCompanies };
