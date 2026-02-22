/**
 * Quick Add Single Comeet Company
 * 
 * Purpose: Add a single company to the database without running full bulk harvest
 * 
 * Usage:
 *   node tools/add_comeet_company.js <url-or-slug> [--force]
 *   npm run comeet:add <url-or-slug> [--force]
 * 
 * Examples:
 *   node tools/add_comeet_company.js https://www.comeet.com/jobs/example/12.00A
 *   node tools/add_comeet_company.js example
 *   node tools/add_comeet_company.js example --force
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'comeet_companies_auto.json');

// Browser settings
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Delay between requests (2-5 seconds)
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

// Page load timeout
const PAGE_TIMEOUT_MS = 30000;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Standard Promise-based delay helper
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate a random delay between min and max milliseconds
 */
function randomDelay(minMs, maxMs) {
    const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return delay(delayMs);
}

/**
 * Extract slug from URL (e.g., "monday" from "https://www.comeet.com/jobs/monday/41.00B")
 */
function extractSlugFromUrl(url) {
    const match = url.match(/\/jobs\/([^\/]+)\//);
    return match ? match[1] : null;
}

/**
 * Extract UID from URL (e.g., "41.00B" from "https://www.comeet.com/jobs/monday/41.00B")
 */
function extractUidFromUrl(url) {
    const match = url.match(/\/jobs\/[^\/]+\/([^\/]+)/);
    return match ? match[1] : null;
}

/**
 * Normalize company name to ID format
 */
function normalizeId(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

/**
 * Parse input argument to determine if it's a URL or slug
 * Returns: { url, slug, uid }
 */
function parseInput(input) {
    if (!input || typeof input !== 'string') {
        return null;
    }

    input = input.trim();

    // Check if it's a full URL
    if (input.startsWith('http://') || input.startsWith('https://')) {
        const slug = extractSlugFromUrl(input);
        const uid = extractUidFromUrl(input);
        return { url: input, slug, uid };
    }

    // Check if it's a partial URL (starts with comeet.com)
    if (input.includes('comeet.com/jobs/')) {
        if (!input.startsWith('http')) {
            input = 'https://' + input;
        }
        const slug = extractSlugFromUrl(input);
        const uid = extractUidFromUrl(input);
        return { url: input, slug, uid };
    }

    // Assume it's a slug - we'll need to construct URL
    // But we can't construct URL without UID, so we'll try common patterns
    const slug = input.toLowerCase().trim();
    return { url: null, slug, uid: null };
}

/**
 * Construct URL from slug (requires UID from page)
 */
function constructUrl(slug, uid) {
    if (!slug || !uid) return null;
    return `https://www.comeet.com/jobs/${slug}/${uid}`;
}

// ============================================================================
// SCRAPING LOGIC
// ============================================================================

/**
 * Extract COMPANY_DATA from a Comeet page using Puppeteer
 * (Reused from harvest_comeet_puppeteer.js)
 */
async function extractCompanyData(page, url) {
    try {
        // Navigate to the page
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: PAGE_TIMEOUT_MS
        });
        
        // Wait a bit for JavaScript to execute (randomized delay)
        await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
        
        // Extract COMPANY_DATA from window object or HTML source
        const companyData = await page.evaluate(() => {
            // Try window.COMPANY_DATA first (most common)
            if (window.COMPANY_DATA && typeof window.COMPANY_DATA === 'object') {
                return window.COMPANY_DATA;
            }
            
            // Try alternative variable names
            if (window.companyData && typeof window.companyData === 'object') {
                return window.companyData;
            }
            
            // Search in script tags for COMPANY_DATA assignment
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const content = script.textContent || script.innerHTML;
                
                // Try to find COMPANY_DATA = {...} pattern
                const patterns = [
                    /COMPANY_DATA\s*=\s*({[\s\S]*?});/,
                    /window\.COMPANY_DATA\s*=\s*({[\s\S]*?});/,
                    /var COMPANY_DATA\s*=\s*({[\s\S]*?});/,
                    /let COMPANY_DATA\s*=\s*({[\s\S]*?});/,
                    /const COMPANY_DATA\s*=\s*({[\s\S]*?});/
                ];
                
                for (const pattern of patterns) {
                    const match = content.match(pattern);
                    if (match && match[1]) {
                        try {
                            // Try to parse as JSON
                            const data = JSON.parse(match[1]);
                            if (data && (data.company_uid || data.uid || data.token)) {
                                return data;
                            }
                        } catch (e) {
                            // Try to extract token and uid directly with regex
                            const tokenMatch = content.match(/"token"\s*:\s*"([^"]+)"/);
                            const uidMatch = content.match(/"company_uid"\s*:\s*"([^"]+)"/);
                            const nameMatch = content.match(/"name"\s*:\s*"([^"]+)"/);
                            
                            if (tokenMatch || uidMatch) {
                                return {
                                    name: nameMatch ? nameMatch[1] : null,
                                    company_uid: uidMatch ? uidMatch[1] : null,
                                    token: tokenMatch ? tokenMatch[1] : null
                                };
                            }
                        }
                    }
                }
            }
            
            return null;
        });
        
        if (!companyData) {
            return null;
        }
        
        return {
            name: companyData.name || null,
            company_uid: companyData.company_uid || companyData.uid || null,
            token: companyData.token || null
        };
        
    } catch (error) {
        return null;
    }
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

/**
 * Load existing companies from JSON file
 */
function loadExistingCompanies() {
    try {
        if (fs.existsSync(OUTPUT_FILE)) {
            const content = fs.readFileSync(OUTPUT_FILE, 'utf-8');
            const existing = JSON.parse(content);
            if (Array.isArray(existing)) {
                return existing;
            }
        }
    } catch (error) {
        // File doesn't exist or invalid - return empty array
    }
    return [];
}

/**
 * Check if a company has a valid token
 */
function hasValidToken(company) {
    return company && company.token && typeof company.token === 'string' && company.token.trim().length > 0;
}

/**
 * Find company by ID in existing companies
 */
function findCompanyById(companies, id) {
    return companies.find(c => c && c.id === id);
}

/**
 * Determine merge action for a new company
 * Returns: { action: 'added'|'updated'|'skipped', reason?: string }
 */
function determineMergeAction(existingCompanies, newCompany) {
    if (!newCompany || !newCompany.id) {
        return { action: 'skipped', reason: 'invalid company data' };
    }
    
    const existingCompany = findCompanyById(existingCompanies, newCompany.id);
    const newHasToken = hasValidToken(newCompany);
    
    if (existingCompany) {
        const existingHasToken = hasValidToken(existingCompany);
        
        if (newHasToken) {
            // New version has token - update
            return { action: 'updated' };
        } else if (existingHasToken) {
            // Old has token, new doesn't - keep old
            return { action: 'skipped', reason: 'existing token preserved' };
        } else {
            // Neither has token - keep existing
            return { action: 'skipped', reason: 'no token in new data' };
        }
    } else {
        // New company - add it
        return { action: 'added' };
    }
}

/**
 * Save companies to file
 */
function saveCompanies(companies) {
    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Sort by id for consistent output
    const sorted = [...companies].sort((a, b) => {
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
    });
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2));
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
    console.log('🚀 Add Single Comeet Company');
    console.log('='.repeat(60));
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('❌ Error: Missing argument');
        console.error('   Usage: node tools/add_comeet_company.js <url-or-slug> [--force]');
        console.error('   Example: node tools/add_comeet_company.js https://www.comeet.com/jobs/example/12.00A');
        console.error('   Example: node tools/add_comeet_company.js example');
        process.exit(1);
    }
    
    const input = args[0];
    const force = args.includes('--force');
    
    // Check dependencies
    try {
        require('puppeteer');
    } catch (e) {
        console.error('❌ Error: puppeteer is not installed.');
        console.error('   Install it with: npm install puppeteer');
        process.exit(1);
    }
    
    // Parse input
    const parsed = parseInput(input);
    if (!parsed) {
        console.error('❌ Error: Invalid input format');
        console.error('   Provide either a full URL or a company slug');
        process.exit(1);
    }
    
    // Load existing companies
    console.log(`\n📂 Loading existing database...`);
    const existingCompanies = loadExistingCompanies();
    console.log(`   Found ${existingCompanies.length} existing companies`);
    
    // Determine target URL and company ID
    let targetUrl = parsed.url;
    let companyId = parsed.slug;
    
    // If we only have a slug, we need to construct URL after scraping
    // For now, try to find the company in existing DB to get UID
    if (!targetUrl && companyId) {
        const existing = findCompanyById(existingCompanies, companyId);
        if (existing && existing.uid) {
            targetUrl = constructUrl(companyId, existing.uid);
            console.log(`   📍 Constructed URL from existing data: ${targetUrl}`);
        } else {
            console.error(`❌ Error: Cannot construct URL from slug "${companyId}"`);
            console.error('   Please provide a full URL or ensure the company exists in the database');
            process.exit(1);
        }
    }
    
    if (!targetUrl) {
        console.error('❌ Error: Could not determine target URL');
        process.exit(1);
    }
    
    // Extract company ID from URL if not already set
    if (!companyId) {
        companyId = extractSlugFromUrl(targetUrl);
    }
    
    if (!companyId) {
        console.error('❌ Error: Could not extract company ID from URL');
        process.exit(1);
    }
    
    // Pre-check: Does company already exist?
    const existingCompany = findCompanyById(existingCompanies, companyId);
    if (existingCompany && !force) {
        console.log(`\n⚠️  Company "${companyId}" already exists in database`);
        console.log(`   Name: ${existingCompany.name || 'N/A'}`);
        console.log(`   UID: ${existingCompany.uid || 'N/A'}`);
        console.log(`   Token: ${existingCompany.token ? existingCompany.token.substring(0, 10) + '...' : 'N/A'}`);
        console.log(`\n   Use --force flag to update the token`);
        process.exit(0);
    }
    
    if (existingCompany && force) {
        console.log(`\n🔄 Force mode: Will update existing company "${companyId}"`);
    }
    
    // Launch browser
    console.log(`\n🌐 Launching browser...`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9'
    });
    
    // Remove webdriver property
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false
        });
    });
    
    // Extract company data
    console.log(`\n🔍 Harvesting company data from: ${targetUrl}`);
    const data = await extractCompanyData(page, targetUrl);
    
    await browser.close();
    
    // Validate extracted data
    if (!data) {
        console.error(`\n❌ Error: Could not extract COMPANY_DATA from page`);
        console.error('   This might not be a valid Comeet career page');
        process.exit(1);
    }
    
    if (!data.token) {
        console.error(`\n❌ Error: Token not found on page`);
        console.error('   The page might be protected or the company might not use Comeet');
        process.exit(1);
    }
    
    const finalUid = data.company_uid || parsed.uid;
    if (!finalUid) {
        console.error(`\n❌ Error: UID not found`);
        console.error('   Could not extract company UID from page or URL');
        process.exit(1);
    }
    
    // Create company object
    const newCompany = {
        id: companyId,
        name: data.name || companyId,
        type: 'comeet',
        uid: finalUid,
        token: data.token
    };
    
    console.log(`\n✅ Successfully extracted company data:`);
    console.log(`   ID: ${newCompany.id}`);
    console.log(`   Name: ${newCompany.name}`);
    console.log(`   UID: ${newCompany.uid}`);
    console.log(`   Token: ${newCompany.token.substring(0, 15)}...`);
    
    // Merge with existing companies
    console.log(`\n🔄 Merging with database...`);
    const mergeResult = determineMergeAction(existingCompanies, newCompany);
    
    // Build merged company list
    const companyMap = new Map();
    
    // Add all existing companies
    for (const company of existingCompanies) {
        if (company && company.id) {
            companyMap.set(company.id, { ...company });
        }
    }
    
    // Apply merge action
    if (mergeResult.action === 'added' || mergeResult.action === 'updated') {
        companyMap.set(newCompany.id, { ...newCompany });
    }
    // If skipped, existing company is already in map, no action needed
    
    const allCompanies = Array.from(companyMap.values());
    
    // Save to file
    saveCompanies(allCompanies);
    
    // Report result
    console.log(`\n${'='.repeat(60)}`);
    if (mergeResult.action === 'added') {
        console.log(`✅ Successfully added "${newCompany.name}" to database`);
    } else if (mergeResult.action === 'updated') {
        console.log(`✅ Successfully updated "${newCompany.name}" in database`);
    } else {
        console.log(`⚠️  Skipped: ${mergeResult.reason}`);
    }
    console.log(`   Total companies in database: ${allCompanies.length}`);
    console.log(`   File: ${OUTPUT_FILE}`);
    console.log('='.repeat(60) + '\n');
}

// Run main function
if (require.main === module) {
    main().catch(error => {
        console.error('\n❌ Fatal error:', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    });
}

module.exports = { main };

