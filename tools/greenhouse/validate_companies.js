/**
 * Greenhouse Company Validator
 * 
 * Validates proposed Greenhouse company configs by probing the public boards API.
 * Checks schema, HTTP status, Content-Type, and response shape ({ jobs: [...] } with id + title).
 *
 * Usage:
 *   node tools/greenhouse/validate_companies.js '[{...}, {...}]'
 *   node tools/greenhouse/validate_companies.js --file candidates.json
 *
 * Programmatic:
 *   const { validateCompanies } = require('./validate_companies');
 *   const result = await validateCompanies([{ id, name, type, uid }]);
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REQUEST_TIMEOUT_MS = 15000;
const INTER_COMPANY_DELAY_MS = 2000;
const GREENHOUSE_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';

const REQUIRED_FIELDS = ['id', 'name', 'uid'];

const BROWSER_HEADERS = {
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
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
 * Validate a single company config against the Greenhouse public API.
 * @param {Object} company - Proposed company config
 * @returns {Promise<{ approved: boolean, company: Object, reason?: string, httpStatus?: number, jobCount?: number }>}
 */
async function validateOne(company) {
    // --- Step 1: Schema check ---
    for (const field of REQUIRED_FIELDS) {
        if (!company[field] || String(company[field]).trim() === '') {
            return { approved: false, company, reason: `Missing required field: ${field}` };
        }
    }

    if (company.type && company.type !== 'greenhouse') {
        return { approved: false, company, reason: `Invalid type: "${company.type}" (expected "greenhouse")` };
    }

    const uid = String(company.uid).trim();

    // --- Step 2: Build URL ---
    const url = `${GREENHOUSE_API_BASE}/${uid}/jobs?content=true`;

    try {
        // --- Step 3: HTTP GET ---
        const response = await axios.get(url, {
            timeout: REQUEST_TIMEOUT_MS,
            headers: BROWSER_HEADERS,
            maxRedirects: 5,
            validateStatus: () => true,
        });

        const status = response.status;

        // --- Step 4: Status check ---
        if (status !== 200) {
            return {
                approved: false,
                company,
                reason: `HTTP ${status}: ${response.statusText || 'Unknown'}`,
                httpStatus: status,
            };
        }

        // --- Step 5: Response shape validation ---
        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
            return {
                approved: false,
                company,
                reason: `Response is not JSON (Content-Type: ${contentType})`,
                httpStatus: status,
            };
        }

        const data = response.data;

        // Greenhouse API returns { jobs: [...] } or sometimes a raw array
        let jobs;
        if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.jobs)) {
            jobs = data.jobs;
        } else if (Array.isArray(data)) {
            jobs = data;
        } else {
            return {
                approved: false,
                company,
                reason: `Expected { jobs: [...] } or Array, got ${typeof data}`,
                httpStatus: status,
            };
        }

        // Empty array = valid board with 0 open positions
        if (jobs.length > 0) {
            const sample = jobs[0];
            if (sample.id == null || !sample.title) {
                return {
                    approved: false,
                    company,
                    reason: `Job objects lack expected fields (id, title). Keys found: ${Object.keys(sample).join(', ')}`,
                    httpStatus: status,
                };
            }
        }

        // --- Step 6: Approved ---
        return {
            approved: true,
            company,
            jobCount: jobs.length,
            httpStatus: status,
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
 * Validate an array of proposed Greenhouse company configs.
 * @param {Array<Object>} companies - Array of company config objects
 * @returns {Promise<{ approved: Array, rejected: Array }>}
 */
async function validateCompanies(companies) {
    if (!Array.isArray(companies) || companies.length === 0) {
        console.error('[Greenhouse Validator] Input must be a non-empty array of company objects.');
        return { approved: [], rejected: [] };
    }

    const approved = [];
    const rejected = [];

    console.log(`\n[Greenhouse Validator] Validating ${companies.length} company/ies...\n`);

    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const label = company.name || company.id || `#${i}`;

        try {
            if (i > 0) {
                await randomDelay(1500, INTER_COMPANY_DELAY_MS);
            }

            const result = await validateOne(company);

            if (result.approved) {
                approved.push({ ...company, jobCount: result.jobCount, validatedAt: new Date().toISOString() });
                console.log(`  ✅  ${label} — APPROVED (${result.jobCount} jobs)`);
            } else {
                rejected.push({ ...company, reason: result.reason, httpStatus: result.httpStatus });
                console.log(`  ❌  ${label} — REJECTED: ${result.reason}`);
            }
        } catch (err) {
            rejected.push({ ...company, reason: `Unexpected error: ${err.message}` });
            console.log(`  ❌  ${label} — REJECTED: Unexpected error: ${err.message}`);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Greenhouse Validator] Results: ${approved.length} approved, ${rejected.length} rejected`);
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
            console.log('  node tools/greenhouse/validate_companies.js \'[{"id":"x","name":"X","uid":"board-slug"}]\'');
            console.log('  node tools/greenhouse/validate_companies.js --file candidates.json');
            process.exit(0);
        }

        const result = await validateCompanies(companies);
        console.log(JSON.stringify(result, null, 2));
    })();
}

module.exports = { validateCompanies };
