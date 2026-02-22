#!/usr/bin/env node
/**
 * Comeet Token Debug Tool
 * 
 * Diagnose why token harvesting fails for a specific company.
 * Opens browser in VISIBLE mode and logs all details.
 * 
 * Usage:
 *   node tools/comeet/debug_token.js <company-id>
 *   node tools/comeet/debug_token.js jeenai
 *   node tools/comeet/debug_token.js landa
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'comeet_companies_auto.json');
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'logs', 'debug');

// ============================================================================
// URL CONSTRUCTION VARIANTS
// ============================================================================

function constructUrls(company) {
    const urls = [];

    // Variant 1: /jobs/careers/{uid} (what harvester currently uses - WRONG)
    if (company.uid) {
        urls.push({
            label: 'careers/{uid}',
            url: `https://www.comeet.com/jobs/careers/${company.uid}`
        });
    }

    // Variant 2: /jobs/{slug}/{uid} (CORRECT format)
    if (company.id && company.uid) {
        urls.push({
            label: '{slug}/{uid}',
            url: `https://www.comeet.com/jobs/${company.id}/${company.uid}`
        });
    }

    // Variant 3: /jobs/{slug} (might redirect)
    if (company.id) {
        urls.push({
            label: '{slug}',
            url: `https://www.comeet.com/jobs/${company.id}`
        });
    }

    // Variant 4: Custom slug if different from id
    if (company.slug && company.slug !== company.id) {
        urls.push({
            label: 'custom-slug/{uid}',
            url: `https://www.comeet.com/jobs/${company.slug}/${company.uid}`
        });
    }

    return urls;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('🔍 Comeet Token Debug Tool');
    console.log('═'.repeat(60));

    const companyId = process.argv[2];

    if (!companyId) {
        console.error('❌ Usage: node tools/comeet/debug_token.js <company-id>');
        console.error('   Example: node tools/comeet/debug_token.js jeenai');
        process.exit(1);
    }

    // Load company data
    console.log(`\n📂 Loading database...`);
    let companies = [];
    try {
        const content = fs.readFileSync(DATA_FILE, 'utf-8');
        companies = JSON.parse(content);
    } catch (err) {
        console.error(`❌ Error loading database: ${err.message}`);
        process.exit(1);
    }

    const company = companies.find(c => c.id === companyId);
    if (!company) {
        console.error(`❌ Company "${companyId}" not found in database`);
        console.log(`   Available IDs: ${companies.slice(0, 10).map(c => c.id).join(', ')}...`);
        process.exit(1);
    }

    console.log(`\n📋 Company Data from JSON:`);
    console.log(`   ID:    ${company.id}`);
    console.log(`   Name:  ${company.name}`);
    console.log(`   UID:   ${company.uid}`);
    console.log(`   Slug:  ${company.slug || '(not set)'}`);
    console.log(`   Token: ${company.token ? company.token.substring(0, 15) + '...' : '❌ MISSING'}`);

    // Ensure screenshot directory exists
    if (!fs.existsSync(SCREENSHOT_DIR)) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    // Generate URL variants to test
    const urlVariants = constructUrls(company);

    console.log(`\n🔗 URL Variants to Test:`);
    for (const v of urlVariants) {
        console.log(`   [${v.label}] ${v.url}`);
    }

    // Launch browser in VISIBLE mode
    console.log(`\n🌐 Launching browser (VISIBLE MODE)...`);
    const browser = await puppeteer.launch({
        headless: false,  // VISIBLE!
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1400,900'
        ],
        defaultViewport: { width: 1400, height: 900 }
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Test each URL variant
    for (let i = 0; i < urlVariants.length; i++) {
        const variant = urlVariants[i];
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`🧪 Testing Variant ${i + 1}: [${variant.label}]`);
        console.log(`   URL: ${variant.url}`);

        try {
            // Navigate
            const response = await page.goto(variant.url, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            // Wait for JS to execute
            await new Promise(r => setTimeout(r, 3000));

            // Get final URL (after redirects)
            const finalUrl = page.url();
            console.log(`   📍 Final URL: ${finalUrl}`);
            console.log(`   📊 Status: ${response.status()}`);

            // Check for redirect
            if (finalUrl !== variant.url) {
                console.log(`   ↪️  REDIRECTED!`);
            }

            // Extract page title
            const title = await page.title();
            console.log(`   📄 Page Title: ${title}`);

            // Try to extract COMPANY_DATA
            const companyData = await page.evaluate(() => {
                // Check window object
                if (window.COMPANY_DATA && typeof window.COMPANY_DATA === 'object') {
                    return { source: 'window.COMPANY_DATA', data: window.COMPANY_DATA };
                }
                if (window.companyData && typeof window.companyData === 'object') {
                    return { source: 'window.companyData', data: window.companyData };
                }

                // Search in script tags
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const content = script.textContent || '';

                    // Look for token pattern
                    const tokenMatch = content.match(/"token"\s*:\s*"([^"]+)"/);
                    if (tokenMatch) {
                        return {
                            source: 'script-regex',
                            data: { token: tokenMatch[1] },
                            scriptSnippet: content.substring(0, 500)
                        };
                    }
                }

                return null;
            });

            if (companyData) {
                console.log(`\n   ✅ COMPANY_DATA FOUND!`);
                console.log(`   📍 Source: ${companyData.source}`);
                if (companyData.data.token) {
                    console.log(`   🔑 Token: ${companyData.data.token.substring(0, 20)}...`);
                }
                if (companyData.data.name) {
                    console.log(`   🏢 Name: ${companyData.data.name}`);
                }
                if (companyData.data.company_uid) {
                    console.log(`   🆔 UID: ${companyData.data.company_uid}`);
                }
            } else {
                console.log(`\n   ❌ COMPANY_DATA NOT FOUND`);

                // Dump head content for debugging
                const headContent = await page.evaluate(() => {
                    return document.head.innerHTML.substring(0, 2000);
                });
                console.log(`\n   📄 HEAD Content (first 500 chars):`);
                console.log(`   ${headContent.substring(0, 500).replace(/\n/g, '\n   ')}`);
            }

            // Take screenshot
            const screenshotPath = path.join(SCREENSHOT_DIR, `debug_${company.id}_v${i + 1}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`\n   📸 Screenshot saved: ${screenshotPath}`);

        } catch (err) {
            console.log(`   ❌ Error: ${err.message}`);
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🔍 DEBUG COMPLETE`);
    console.log(`   Screenshots saved to: ${SCREENSHOT_DIR}`);
    console.log(`\n   Press Ctrl+C to close browser...`);

    // Keep browser open for manual inspection
    await new Promise(() => { });
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
