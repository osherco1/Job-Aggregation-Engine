#!/usr/bin/env node
/**
 * CLI Utility: Add Workday Company
 * 
 * Parses a Workday Career Site URL and adds the company to the database.
 * 
 * Usage:
 *   node tools/add_workday_company.js <url>
 *   node tools/add_workday_company.js "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
 *   node tools/add_workday_company.js   (interactive prompt mode)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');

// Path to Workday companies database
const COMPANIES_FILE = path.join(__dirname, '..', 'data', 'workday_companies.json');

// ============================================================================
// URL PARSING
// ============================================================================

/**
 * Parse a Workday careers URL to extract tenant, instance, and site.
 * Pattern: https://<tenant>.<instance>.myworkdayjobs.com/<site>
 * 
 * @param {string} url - Full Workday URL
 * @returns {{ tenant: string, instance: string, site: string, baseUrl: string } | null}
 */
function parseWorkdayUrl(url) {
    // Normalize URL
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http')) {
        normalizedUrl = 'https://' + normalizedUrl;
    }

    // Pattern: https://tenant.instance.myworkdayjobs.com/site
    const regex = /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?\/([^/?#]+)/i;
    const match = normalizedUrl.match(regex);

    if (!match) {
        return null;
    }

    return {
        tenant: match[1],
        instance: match[2],
        site: match[3],
        baseUrl: `https://${match[1]}.${match[2]}.myworkdayjobs.com/${match[3]}`
    };
}

/**
 * Generate a URL-friendly ID from the tenant name
 * @param {string} tenant 
 * @returns {string}
 */
function generateId(tenant) {
    return tenant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Format tenant name as company name (capitalize first letter)
 * @param {string} tenant 
 * @returns {string}
 */
function formatCompanyName(tenant) {
    // Handle common abbreviations
    const upperCaseNames = ['ibm', 'hp', 'hpe', 'kla', 'sap', 'nxp', 'amd'];
    if (upperCaseNames.includes(tenant.toLowerCase())) {
        return tenant.toUpperCase();
    }
    // Capitalize first letter
    return tenant.charAt(0).toUpperCase() + tenant.slice(1);
}

// ============================================================================
// URL VALIDATION
// ============================================================================

/**
 * Validate that the URL is reachable with a lightweight HEAD request
 * @param {string} url 
 * @returns {Promise<{ valid: boolean, status?: number, error?: string }>}
 */
function validateUrl(url) {
    return new Promise((resolve) => {
        const protocol = url.startsWith('https') ? https : http;
        const timeout = 10000; // 10 seconds

        const req = protocol.request(url, { method: 'HEAD', timeout }, (res) => {
            // Accept 2xx, 3xx, and 403 (WAF protection but site exists)
            const valid = res.statusCode < 500;
            resolve({ valid, status: res.statusCode });
        });

        req.on('error', (err) => {
            resolve({ valid: false, error: err.message });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ valid: false, error: 'Request timeout' });
        });

        req.end();
    });
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

/**
 * Load existing companies from JSON file
 * @returns {Array}
 */
function loadCompanies() {
    try {
        if (fs.existsSync(COMPANIES_FILE)) {
            const content = fs.readFileSync(COMPANIES_FILE, 'utf-8');
            return JSON.parse(content);
        }
    } catch (err) {
        console.error(`Warning: Could not load existing companies: ${err.message}`);
    }
    return [];
}

/**
 * Save companies to JSON file
 * @param {Array} companies 
 */
function saveCompanies(companies) {
    // Ensure data directory exists
    const dataDir = path.dirname(COMPANIES_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2), 'utf-8');
}

/**
 * Check if a company with the given ID already exists
 * @param {Array} companies 
 * @param {string} id 
 * @returns {boolean}
 */
function companyExists(companies, id) {
    return companies.some(c => c.id === id);
}

// ============================================================================
// INTERACTIVE PROMPT
// ============================================================================

/**
 * Prompt user for input
 * @param {string} question 
 * @returns {Promise<string>}
 */
function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ADD WORKDAY COMPANY');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Get URL from argument or prompt
    let url = process.argv[2];

    if (!url) {
        url = await prompt('Enter Workday Career Site URL: ');
    }

    if (!url) {
        console.error('❌ Error: URL is required');
        process.exit(1);
    }

    // Parse URL
    console.log(`\n📎 Parsing URL: ${url}`);
    const parsed = parseWorkdayUrl(url);

    if (!parsed) {
        console.error('❌ Error: Invalid Workday URL format');
        console.error('   Expected: https://<tenant>.<instance>.myworkdayjobs.com/<site>');
        console.error('   Example:  https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite');
        process.exit(1);
    }

    console.log('   ✅ Parsed successfully:');
    console.log(`      Tenant:   ${parsed.tenant}`);
    console.log(`      Instance: ${parsed.instance}`);
    console.log(`      Site:     ${parsed.site}`);

    // Generate company details
    const id = generateId(parsed.tenant);
    const name = formatCompanyName(parsed.tenant);

    // Allow user to override name
    const customName = await prompt(`\nCompany name [${name}]: `);
    const finalName = customName || name;

    // Validate URL
    console.log('\n🔍 Validating URL...');
    const validation = await validateUrl(parsed.baseUrl);

    if (!validation.valid) {
        console.error(`❌ URL validation failed: ${validation.error || `HTTP ${validation.status}`}`);
        const proceed = await prompt('Proceed anyway? (y/N): ');
        if (proceed.toLowerCase() !== 'y') {
            console.log('Aborted.');
            process.exit(1);
        }
    } else {
        console.log(`   ✅ URL is reachable (HTTP ${validation.status})`);
    }

    // Load existing companies
    const companies = loadCompanies();

    // Check for duplicates
    if (companyExists(companies, id)) {
        console.error(`\n❌ Error: Company with ID "${id}" already exists`);
        const existing = companies.find(c => c.id === id);
        console.log(`   Existing: ${existing.name} - ${existing.url}`);
        process.exit(1);
    }

    // Create new company object
    const newCompany = {
        id,
        name: finalName,
        url: parsed.baseUrl
    };

    console.log('\n📋 New company entry:');
    console.log(JSON.stringify(newCompany, null, 2));

    // Confirm
    const confirm = await prompt('\nAdd this company? (Y/n): ');
    if (confirm.toLowerCase() === 'n') {
        console.log('Aborted.');
        process.exit(0);
    }

    // Save
    companies.push(newCompany);
    saveCompanies(companies);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  ✅ SUCCESS: Added "${finalName}" to workday_companies.json`);
    console.log(`     Total companies: ${companies.length}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
