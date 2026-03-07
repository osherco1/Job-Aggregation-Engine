/**
 * Comeet Token & UID Harvester using Puppeteer
 * 
 * Purpose: Harvests API tokens and Company UIDs from Comeet career pages
 * by scraping the window.COMPANY_DATA global variable using Puppeteer.
 * Validated companies are inserted directly into MongoDB.
 * 
 * Usage: node tools/comeet/harvest_comeet_puppeteer.js
 * 
 * Input:  tools/comeet_list.csv (columns: "Company Name", "Full Job Board URL")
 * Output: MongoDB companies collection (via StorageAdapter.upsertCompany)
 * 
 * Requirements:
 *   - puppeteer: npm install puppeteer
 *   - CSV file with proper format
 *   - MONGODB_URI environment variable set
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { createStorageAdapter } = require('../../services/storage');
const { validateCompanies: validateComeet } = require('./validate_companies');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CSV_FILE = path.join(__dirname, '..', 'comeet_list.csv');

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

// ============================================================================
// CSV PARSING
// ============================================================================

/**
 * Simple CSV parser that handles quoted fields
 * Supports two formats:
 * 1. Old format: "Company Name", "Full Job Board URL", "Unique ID"
 * 2. New format: "id", "name", "type", "uid", "token" (constructs URL from id and uid)
 */
function parseCSV(csvContent) {
    const lines = csvContent.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (lines.length === 0) return [];

    // Parse header
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine);

    // Find column indices - support both old and new formats
    const nameIndex = headers.findIndex(h => {
        const lower = h.toLowerCase();
        return lower.includes('company name') || lower === 'name';
    });
    const urlIndex = headers.findIndex(h => {
        const lower = h.toLowerCase();
        return lower.includes('full job board url') || (lower.includes('url') && !lower.includes('token'));
    });
    const uidIndex = headers.findIndex(h => {
        const lower = h.toLowerCase();
        return lower.includes('unique id') || lower === 'uid';
    });
    const idIndex = headers.findIndex(h => h.toLowerCase() === 'id');

    // New format: has id, name, uid columns (construct URL)
    if (idIndex !== -1 && nameIndex !== -1 && uidIndex !== -1) {
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            if (values.length > Math.max(idIndex, nameIndex, uidIndex)) {
                const id = values[idIndex]?.trim();
                const companyName = values[nameIndex]?.trim();
                const uniqueId = values[uidIndex]?.trim();

                if (id && companyName && uniqueId) {
                    // Construct URL from id (slug) and uid
                    const url = `https://www.comeet.com/jobs/${id}/${uniqueId}`;
                    rows.push({ companyName, url, uniqueId, id });
                }
            }
        }
        return rows;
    }

    // Old format: requires name and URL
    if (nameIndex === -1 || urlIndex === -1) {
        throw new Error('CSV must contain either: (1) "id", "name", "uid" columns, or (2) "Company Name" and "Full Job Board URL" columns');
    }

    // Parse data rows (old format)
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length > Math.max(nameIndex, urlIndex)) {
            const companyName = values[nameIndex]?.trim();
            const url = values[urlIndex]?.trim();
            const uniqueId = uidIndex !== -1 && values.length > uidIndex ? values[uidIndex]?.trim() : null;

            // Skip rows with invalid URLs or "Not Found" status
            if (companyName && url && url !== 'Not Found' && url.startsWith('http')) {
                rows.push({ companyName, url, uniqueId });
            }
        }
    }

    return rows;
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                // Escaped quote
                current += '"';
                i++; // Skip next quote
            } else {
                // Toggle quote state
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // Field separator
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    // Add last field
    values.push(current);

    return values;
}

/**
 * Extract slug from URL (e.g., "monday" from "https://www.comeet.com/jobs/monday/41.00B")
 */
function extractSlugFromUrl(url) {
    const match = url.match(/\/jobs\/([^\/]+)\//);
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

// ============================================================================
// SCRAPING LOGIC
// ============================================================================

/**
 * Extract COMPANY_DATA from a Comeet page using Puppeteer
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
            return null; // Return null instead of throwing - will be handled gracefully
        }

        return {
            name: companyData.name || null,
            company_uid: companyData.company_uid || companyData.uid || null,
            token: companyData.token || null
        };

    } catch (error) {
        // Return null on error instead of throwing - allows processing to continue
        return null;
    }
}

/**
 * Process a single company URL
 */
async function processCompany(page, companyName, url, uniqueIdFromCsv, index, total) {
    console.log(`\n[${index}/${total}] Processing: ${companyName}`);
    console.log(`   URL: ${url}`);

    try {
        const data = await extractCompanyData(page, url);

        // Handle case where COMPANY_DATA is not found - log warning but don't crash
        if (!data) {
            console.warn(`   ⚠️  Warning: COMPANY_DATA not found on page - skipping`);
            return null;
        }

        // Only require token - uid can come from CSV as fallback
        if (!data.token) {
            console.warn(`   ⚠️  Warning: Token not found - skipping`);
            return null;
        }

        // Use scraped uid if available, otherwise fallback to CSV uniqueId
        const finalUid = data.company_uid || uniqueIdFromCsv;

        if (!finalUid) {
            console.warn(`   ⚠️  Warning: UID not found in HTML and not available in CSV - skipping`);
            return null;
        }

        const slug = extractSlugFromUrl(url) || normalizeId(companyName);

        const result = {
            id: slug,
            name: data.name || companyName,
            type: 'comeet',
            uid: finalUid,
            token: data.token
        };

        // Log success message with source of UID
        const uidSource = data.company_uid ? 'scraped' : 'CSV';
        console.log(`   ✅ Success! Extracted ${companyName} | UID: ${finalUid} (${uidSource}) | Token: ${data.token.substring(0, 10)}...`);

        return result;

    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        return null;
    }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
    console.log('🚀 Comeet Token & UID Harvester');
    console.log('='.repeat(60));

    // Check dependencies
    try {
        require('puppeteer');
    } catch (e) {
        console.error('❌ Error: puppeteer is not installed.');
        console.error('   Install it with: npm install puppeteer');
        process.exit(1);
    }

    // Initialize storage adapter (MongoDB)
    let storageAdapter;
    try {
        storageAdapter = createStorageAdapter();
        console.log('✅ Storage adapter initialized');
    } catch (err) {
        console.error(`❌ Failed to initialize storage: ${err.message}`);
        process.exit(1);
    }

    // Load existing companies from DB (for dedup during processing)
    console.log(`\n📂 Loading existing companies from DB...`);
    const allCompanies = await storageAdapter.loadCompanies();
    const existingComeet = allCompanies.filter(c => c.type === 'comeet');
    const existingIds = new Set(existingComeet.map(c => c.id));
    console.log(`   📂 Found ${existingComeet.length} existing Comeet companies in DB`);

    // Read and parse CSV
    console.log(`\n📂 Reading CSV file: ${path.basename(CSV_FILE)}`);
    let csvContent;
    try {
        csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
    } catch (error) {
        console.error(`❌ Error reading CSV file: ${error.message}`);
        await storageAdapter.close();
        process.exit(1);
    }

    const companies = parseCSV(csvContent);
    console.log(`   ✅ Found ${companies.length} companies to process\n`);

    if (companies.length === 0) {
        console.error('❌ No valid companies found in CSV file');
        await storageAdapter.close();
        process.exit(1);
    }

    // Launch browser with stealth mode
    console.log('🌐 Launching browser with stealth mode...');
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();

    // Set realistic user agent
    await page.setUserAgent(USER_AGENT);

    // Set extra headers
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9'
    });

    // Remove webdriver property
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false
        });
    });

    const results = [];
    const total = companies.length;

    // Process each company
    for (let i = 0; i < companies.length; i++) {
        const { companyName, url, uniqueId } = companies[i];

        try {
            const result = await processCompany(page, companyName, url, uniqueId, i + 1, total);
            if (result) {
                results.push(result);
            }
        } catch (error) {
            console.error(`   ❌ Unexpected error: ${error.message}`);
        }

        // Random delay between requests (except for the last one)
        if (i < companies.length - 1) {
            const delayMs = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
            console.log(`   ⏳ Waiting ${Math.floor(delayMs / 1000)}s before next request...`);
            await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
        }
    }

    // Close browser
    await browser.close();

    // Harvest complete
    console.log('\n' + '='.repeat(60));
    console.log(`✅ Harvesting complete!`);
    console.log(`   Processed: ${companies.length} companies`);
    console.log(`   Successfully extracted: ${results.length} companies`);
    console.log(`   Failed: ${companies.length - results.length} companies`);

    // Validate & upsert each harvested company into MongoDB
    console.log(`\n🔄 Validating & upserting to MongoDB...`);
    let upserted = 0;
    let skipped = 0;
    let validationFailed = 0;

    for (const company of results) {
        // Validate token via Comeet API
        const { approved, rejected } = await validateComeet([company]);

        if (approved.length > 0) {
            try {
                await storageAdapter.upsertCompany({
                    ...company,
                    addedBy: 'harvest_comeet_puppeteer',
                });
                if (existingIds.has(company.id)) {
                    console.log(`   🔄 Updated: ${company.name} (${company.id})`);
                } else {
                    console.log(`   ➕ Added: ${company.name} (${company.id})`);
                }
                upserted++;
            } catch (err) {
                console.error(`   ❌ DB error for ${company.name}: ${err.message}`);
            }
        } else {
            const reason = rejected[0]?.reason || 'Unknown';
            console.log(`   ⏭️  Validation failed: ${company.name} — ${reason}`);
            validationFailed++;
        }
    }

    console.log(`\n   📊 DB Results:`);
    console.log(`      Upserted: ${upserted}`);
    console.log(`      Validation failed: ${validationFailed}`);
    console.log(`      Total in DB: ${existingComeet.length + upserted} (approx)`);

    // Cleanup
    await storageAdapter.close();
    console.log('='.repeat(60) + '\n');
}

// Run main function
if (require.main === module) {
    main().catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { main };
