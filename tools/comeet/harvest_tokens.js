#!/usr/bin/env node
/**
 * Comeet Token Harvester
 * 
 * Batch-update tokens for all companies in comeet_companies_auto.json.
 * Uses Puppeteer to scrape career pages and extract COMPANY_DATA tokens.
 * 
 * Usage:
 *   node tools/comeet/harvest_tokens.js              # Update all missing tokens
 *   node tools/comeet/harvest_tokens.js --all        # Re-fetch ALL tokens
 *   node tools/comeet/harvest_tokens.js --company landa  # Update specific company
 * 
 * Features:
 *   - Parallel execution with concurrency limit
 *   - Progress tracking and logging
 *   - Saves after each batch to avoid data loss
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'comeet_companies_auto.json');

// Concurrency settings
const CONCURRENCY_LIMIT = 3;  // Parallel browser pages (be nice to Comeet)

// Browser settings
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Delay between requests (human-like)
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 4000;

// Page load timeout
const PAGE_TIMEOUT_MS = 30000;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function randomDelay(minMs, maxMs) {
    const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return delay(delayMs);
}

function constructUrl(id, uid) {
    // Comeet career page URL pattern: /jobs/{slug}/{uid}
    // Example: https://www.comeet.com/jobs/jeenai/DA.008
    // VERIFIED: This is the correct format - /jobs/careers/{uid} does NOT work!
    return `https://www.comeet.com/jobs/${id}/${uid}`;
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

function loadCompanies() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf-8');
            const data = JSON.parse(content);
            return Array.isArray(data) ? data : [];
        }
    } catch (err) {
        console.error(`❌ Error loading database: ${err.message}`);
    }
    return [];
}

function saveCompanies(companies) {
    const sorted = [...companies].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
    fs.writeFileSync(DATA_FILE, JSON.stringify(sorted, null, 2));
}

// ============================================================================
// TOKEN EXTRACTION (via Puppeteer)
// ============================================================================

async function extractTokenFromPage(page, url) {
    try {
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: PAGE_TIMEOUT_MS
        });

        await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);

        const companyData = await page.evaluate(() => {
            // Try window.COMPANY_DATA first
            if (window.COMPANY_DATA && typeof window.COMPANY_DATA === 'object') {
                return window.COMPANY_DATA;
            }

            // Try alternative variable names
            if (window.companyData && typeof window.companyData === 'object') {
                return window.companyData;
            }

            // Search in script tags
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const content = script.textContent || script.innerHTML;

                // Pattern matching for COMPANY_DATA
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
                            const data = JSON.parse(match[1]);
                            if (data && (data.company_uid || data.uid || data.token)) {
                                return data;
                            }
                        } catch (e) {
                            // Try direct regex extraction
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

        if (companyData && companyData.token) {
            return {
                token: companyData.token,
                name: companyData.name || null,
                uid: companyData.company_uid || companyData.uid || null
            };
        }

        return null;

    } catch (error) {
        return null;
    }
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

async function processCompany(page, company) {
    const url = constructUrl(company.id, company.uid);

    try {
        const result = await extractTokenFromPage(page, url);

        if (result && result.token) {
            return {
                success: true,
                token: result.token,
                name: result.name || company.name
            };
        } else {
            return { success: false, error: 'Token not found on page' };
        }
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function processInBatches(companies, browser, concurrency = CONCURRENCY_LIMIT) {
    const results = [];
    let updated = 0;
    let failed = 0;
    let skipped = 0;

    // Create a pool of pages
    const pages = [];
    for (let i = 0; i < concurrency; i++) {
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        pages.push(page);
    }

    // Process in chunks
    for (let i = 0; i < companies.length; i += concurrency) {
        const chunk = companies.slice(i, i + concurrency);

        const promises = chunk.map(async (company, idx) => {
            const page = pages[idx % pages.length];
            const result = await processCompany(page, company);
            return { company, result };
        });

        const chunkResults = await Promise.all(promises);

        for (const { company, result } of chunkResults) {
            if (result.success) {
                company.token = result.token;
                if (result.name && !company.name) {
                    company.name = result.name;
                }
                updated++;
                console.log(`   ✅ ${company.id}: Token found (${result.token.substring(0, 12)}...)`);
            } else {
                failed++;
                console.log(`   ❌ ${company.id}: ${result.error}`);
            }
            results.push({ company, result });
        }

        // Progress update
        const progress = Math.min(i + concurrency, companies.length);
        console.log(`\n   📊 Progress: ${progress}/${companies.length} (${Math.round(progress / companies.length * 100)}%)\n`);

        // Save after each batch to avoid data loss
        saveCompanies(companies);

        // Small delay between batches
        if (i + concurrency < companies.length) {
            await delay(1000);
        }
    }

    // Cleanup pages
    for (const page of pages) {
        await page.close();
    }

    return { updated, failed, skipped, results };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('🔑 Comeet Token Harvester');
    console.log('═'.repeat(60));

    // Parse arguments
    const args = process.argv.slice(2);
    const fetchAll = args.includes('--all');
    const companyIdIdx = args.indexOf('--company');
    const specificCompany = companyIdIdx !== -1 ? args[companyIdIdx + 1] : null;

    // Load companies
    console.log(`\n📂 Loading database: ${DATA_FILE}`);
    let companies = loadCompanies();
    console.log(`   Found ${companies.length} companies`);

    if (companies.length === 0) {
        console.log('❌ No companies found in database');
        process.exit(1);
    }

    // Filter companies to process
    let toProcess;
    if (specificCompany) {
        toProcess = companies.filter(c => c.id === specificCompany);
        if (toProcess.length === 0) {
            console.log(`❌ Company "${specificCompany}" not found`);
            process.exit(1);
        }
        console.log(`   🎯 Processing specific company: ${specificCompany}`);
    } else if (fetchAll) {
        toProcess = companies;
        console.log(`   🔄 Re-fetching ALL ${toProcess.length} tokens`);
    } else {
        toProcess = companies.filter(c => !c.token);
        console.log(`   🔍 Found ${toProcess.length} companies missing tokens`);
    }

    if (toProcess.length === 0) {
        console.log('\n✅ All companies already have tokens!');
        console.log('   Use --all flag to re-fetch all tokens');
        process.exit(0);
    }

    // Launch browser
    console.log('\n🌐 Launching browser...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    try {
        console.log(`\n🔑 Harvesting tokens (concurrency: ${CONCURRENCY_LIMIT})...\n`);

        const { updated, failed } = await processInBatches(toProcess, browser, CONCURRENCY_LIMIT);

        // Final save
        saveCompanies(companies);

        // Summary
        console.log('\n' + '═'.repeat(60));
        console.log('📊 SUMMARY');
        console.log('═'.repeat(60));
        console.log(`   ✅ Updated: ${updated}`);
        console.log(`   ❌ Failed:  ${failed}`);
        console.log(`   📁 File:    ${DATA_FILE}`);
        console.log('═'.repeat(60));

    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
