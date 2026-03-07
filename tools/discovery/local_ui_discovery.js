#!/usr/bin/env node
/**
 * Local UI Discovery Pipeline (Human-in-the-Loop)
 *
 * Drives the Perplexity Web UI via Puppeteer to discover new ATS companies,
 * replacing the costly Perplexity API pipeline.
 *
 * Current scope: Comeet-only discovery.
 *
 * Usage:
 *   node tools/discovery/local_ui_discovery.js               # manual injection (default)
 *   node tools/discovery/local_ui_discovery.js --auto-inject  # auto-run injection tools
 *
 * Flow:
 *   1. Launch Puppeteer (headless: false, persisted profile)
 *   2. Query MongoDB for existing Comeet company names → inject into prompt
 *   3. Type hardcoded prompt → wait for Copy button → extract JSON
 *   4. Classify URLs via extractor.js → write JSON + CSV
 *   5. Handoff to inject_and_validate.js + harvest_tokens.js
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { MongoClient } = require('mongodb');
const { classifyAndExtract } = require('./extractor');

// ============================================================================
// PATHS
// ============================================================================

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const COMEET_CSV_PATH = path.join(__dirname, '..', 'comeet_list.csv');
const PROFILE_DIR = path.join(__dirname, 'puppeteer_profile');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PERPLEXITY_URL = 'https://www.perplexity.ai/';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;        // 5 min for human login
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;    // 5 min per query
const STREAMING_BUFFER_MS = 2000;                // post-copy-button wait
const INTER_QUERY_DELAY_MS = 12_000;             // cooldown between ATS types
const TYPE_DELAY_MS = 15;                        // keyboard.type() per-char delay

const AUTO_INJECT = process.argv.includes('--auto-inject');

// Placeholder token replaced at runtime with DB company names
const DB_PLACEHOLDER = '[INJECT_DB_COMPANIES_HERE]';

// ============================================================================
// DOM SELECTORS (single update point when Perplexity UI changes)
// ============================================================================

const SELECTORS = {
    inputBox: '#ask-input[contenteditable="true"], [contenteditable="true"][role="textbox"]',
    answerContainer: '.prose.text-pretty, [data-testid="answer"]',
    codeBlock: 'pre code',
};

// ============================================================================
// HARDCODED PROMPTS
// ============================================================================

const PROMPTS = {
    comeet: `# MISSION: Comeet ATS Company Discovery — Israel

## WHO YOU ARE
You are an expert web researcher specializing in Israeli tech company recruitment infrastructure. Your task is to discover exactly 15 Israeli tech companies that use the "Comeet" ATS (now branded as Spark Hire Recruit) for their hiring, which are NOT already in our database.

## CONTEXT: COMEET ATS
Comeet collaborative hiring platform exposes public careers pages with predictable URL patterns:
- https://www.comeet.com/jobs/{company-slug}/{uid-code}
- https://www.comeet.co/jobs/{company-slug}/{uid-code}
We ONLY need you to find these public career page URLs. Do not attempt to find API tokens.

## COMPANIES ALREADY IN OUR DATABASE (DO NOT INCLUDE THESE)
${DB_PLACEHOLDER}

## YOUR TASK — STEP BY STEP

Step 1: Broad Discovery
Search the web for Israeli tech companies using Comeet ATS. Use these search strategies:
- Search for \`site:comeet.co/jobs\` or \`site:comeet.com/jobs\`
- Search for companies listed on TheirStack, Bloomberry, BuiltWith, or Wappalyzer as Comeet users.
- Look for Israeli startup career pages that embed Comeet widgets.
- Check startup directories (e.g., Start-Up Nation Central, Finder.vc) cross-referenced with Comeet.

Step 2: Validate Each Company
- Verify the company is based in Israel OR has significant Israel R&D.
- Verify the careers page URL is a valid Comeet URL.
- Verify the company is NOT in the exclusion list.

Step 3: Strict Output Formatting
You MUST find and return exactly 15 companies.
You MUST return ONLY a valid JSON block inside \`\`\`json ... \`\`\` tags. No other conversational text.
The JSON must perfectly match this exact schema:

\`\`\`json
{
  "companies": [
    {
      "company_name": "Company Display Name",
      "careers_page_url": "https://www.comeet.com/jobs/slug/uid",
      "evidence": "Brief note on where you found this or proof they use Comeet",
      "confidence": "high"
    }
  ]
}
\`\`\``,
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Robust JSON extraction with 3-tier fallback.
 * @param {string} rawText - Raw text from the Perplexity answer
 * @returns {Object|Array} Parsed JSON
 */
function extractJSON(rawText) {
    const trimmed = (rawText || '').trim();

    // Attempt 1: direct JSON.parse
    try {
        return JSON.parse(trimmed);
    } catch { /* fall through */ }

    // Attempt 2: fenced ```json ... ``` code block
    const fenced = trimmed.match(/```json\s*([\s\S]*?)```/);
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch { /* fall through */ }
    }

    // Attempt 3: largest JSON-like substring (object or array)
    const braces = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (braces) {
        try {
            return JSON.parse(braces[1]);
        } catch { /* fall through */ }
    }

    throw new Error('Could not extract valid JSON from Perplexity response');
}

/**
 * Back up existing data files before overwriting.
 */
function backupDataFiles() {
    const today = new Date().toISOString().split('T')[0];
    const backupDir = path.join(DATA_DIR, `backup_${today}`);

    const filesToBackup = [
        'comeet_companies_israel.json',
    ];

    let backedUp = false;
    for (const file of filesToBackup) {
        const src = path.join(DATA_DIR, file);
        if (fs.existsSync(src)) {
            if (!backedUp) {
                fs.mkdirSync(backupDir, { recursive: true });
                backedUp = true;
            }
            fs.copyFileSync(src, path.join(backupDir, file));
        }
    }

    if (backedUp) {
        console.log(`  📦 Backed up existing data files to ${path.basename(backupDir)}/`);
    }
}

/**
 * Append Comeet leads to comeet_list.csv.
 * @param {Array<Object>} leads - Objects with company_name + careers_page_url
 */
function appendToComeetCsv(leads) {
    if (!leads || leads.length === 0) return;

    const needsHeader = !fs.existsSync(COMEET_CSV_PATH) || fs.statSync(COMEET_CSV_PATH).size === 0;
    const header = '"Company Name","Full Job Board URL"\n';

    let csvContent = needsHeader ? header : '';
    for (const lead of leads) {
        const name = (lead.company_name || '').replace(/"/g, '""');
        const url = (lead.careers_page_url || '').replace(/"/g, '""');
        csvContent += `"${name}","${url}"\n`;
    }

    fs.appendFileSync(COMEET_CSV_PATH, csvContent, 'utf-8');
    console.log(`  📝 Appended ${leads.length} Comeet leads to ${path.basename(COMEET_CSV_PATH)}`);
}

// ============================================================================
// MONGODB: FETCH EXISTING COMPANIES
// ============================================================================

/**
 * Query MongoDB for existing Comeet company names.
 * Uses the same connection pattern as inject_and_validate.js.
 * @returns {Promise<string[]>} Array of company names
 */
async function fetchExistingComeetNames() {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        console.warn('  ⚠️  MONGODB_URI not set — cannot fetch existing companies. Prompt will have empty exclusion list.');
        return [];
    }

    let client;
    try {
        client = new MongoClient(mongoUri, {
            maxPoolSize: 3,
            serverSelectionTimeoutMS: 10000,
        });
        await client.connect();

        // Extract DB name from URI
        const dbName = (() => {
            try {
                const p = new URL(mongoUri).pathname;
                return p && p.length > 1 ? p.substring(1) : 'jobbot_db';
            } catch {
                return 'jobbot_db';
            }
        })();

        const db = client.db(dbName);
        const collection = db.collection('companies');

        const comeetDocs = await collection
            .find({ type: 'comeet', enabled: { $ne: false } })
            .project({ name: 1, _id: 0 })
            .toArray();

        const names = comeetDocs.map(d => d.name).filter(Boolean);
        console.log(`  📋 Fetched ${names.length} existing Comeet companies from MongoDB`);
        return names;
    } catch (err) {
        console.error(`  ❌ MongoDB query failed: ${err.message}`);
        console.warn('  ⚠️  Proceeding with empty exclusion list.');
        return [];
    } finally {
        if (client) {
            await client.close();
        }
    }
}

/**
 * Build the final prompt string with DB company names injected.
 * @param {string} atsType
 * @param {string[]} existingNames
 * @returns {string}
 */
function buildPrompt(atsType, existingNames) {
    const template = PROMPTS[atsType];
    if (!template) {
        throw new Error(`No prompt template for ATS type: ${atsType}`);
    }

    const exclusionList = existingNames.length > 0
        ? existingNames.join(', ')
        : '(none — this is the first run)';

    return template.replace(DB_PLACEHOLDER, exclusionList);
}

// ============================================================================
// PERPLEXITY UI INTERACTION
// ============================================================================

/**
 * Detect the current page state: Turnstile challenge, CF interstitial, or app ready.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string>} 'TURNSTILE_CHALLENGE' | 'CF_INTERSTITIAL' | 'APP_READY' | 'UNKNOWN'
 */
async function detectPageState(page) {
    return await page.evaluate(() => {
        // 1. Turnstile iframe
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
            const src = iframe.src || '';
            if (src.includes('challenges.cloudflare.com') || src.includes('turnstile')) {
                return 'TURNSTILE_CHALLENGE';
            }
        }

        // 2. CF interstitial page
        const challengeEl = document.getElementById('challenge-running');
        const bodyText = document.body?.innerText || '';
        if (challengeEl || bodyText.includes('Checking your browser')
            || bodyText.includes('Just a moment')) {
            return 'CF_INTERSTITIAL';
        }

        // 3. App ready — Lexical input visible
        const inputBox = document.querySelector('#ask-input[contenteditable="true"], [contenteditable="true"][role="textbox"]');
        if (inputBox && inputBox.offsetHeight > 0) {
            return 'APP_READY';
        }

        return 'UNKNOWN';
    });
}

/**
 * Wait for Perplexity to be ready, handling Turnstile/CF challenges gracefully.
 * Polls every 3 s for up to 5 min.
 * @param {import('puppeteer').Page} page
 */
async function waitForAppReady(page) {
    const POLL_INTERVAL = 3000;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let lastState = '';

    console.log('\n⏳ Waiting for Perplexity to be ready (up to 5 min)...');

    while (Date.now() < deadline) {
        const state = await detectPageState(page);

        if (state === 'APP_READY') {
            console.log('✅ Perplexity is ready (#ask-input detected).\n');
            return;
        }

        // Only log when state changes to avoid console spam
        if (state !== lastState) {
            if (state === 'TURNSTILE_CHALLENGE') {
                console.log('  ⚠️  Cloudflare Turnstile detected — please solve the challenge in the browser window.');
            } else if (state === 'CF_INTERSTITIAL') {
                console.log('  ⏳ Cloudflare is checking the browser... waiting for it to pass.');
            } else {
                console.log('  ⏳ Page is loading... waiting for #ask-input to appear.');
            }
            lastState = state;
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    throw new Error('Timed out waiting for Perplexity to be ready (5 min). Turnstile may have blocked access.');
}

/**
 * Ensures "Deep research" or "Pro" mode is active before submitting.
 * Handles the popup menu clicking dynamically.
 * @param {import('puppeteer').Page} page
 */
async function ensureDeepResearch(page) {
    console.log('  🔍 Ensuring Deep Research mode is active...');
    const INPUT = '#ask-input[contenteditable="true"], [contenteditable="true"][role="textbox"]';
    await page.waitForSelector(INPUT, { visible: true, timeout: 30000 });

    // 1) Click the exact "+" button using its precise aria-label
    const PLUS_BTN_SELECTOR = 'button[aria-label="Add files or tools"]';
    try {
        await page.waitForSelector(PLUS_BTN_SELECTOR, { visible: true, timeout: 5000 });
        await page.click(PLUS_BTN_SELECTOR);
    } catch (e) {
        throw new Error(`Could not locate the + button using selector: ${PLUS_BTN_SELECTOR}`);
    }

    // Wait for Radix UI dialog animation to open
    await new Promise(r => setTimeout(r, 500));

    // 2) Find and click "Deep research" inside the dialog
    const clicked = await page.evaluate(() => {
        // Radix dialogs usually append near the end of the body or in a wrapper
        const dialogs = document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper]');
        const container = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document;

        const items = container.querySelectorAll('button, [role="menuitem"], [role="button"], div[tabindex], [class*="Item"]');
        const re = /deep research|research/i;

        for (const el of items) {
            const text = (el.innerText || el.textContent || '').trim();
            if (re.test(text) && text.length < 30) {
                // Check if already active
                const isChecked = el.getAttribute('aria-checked') === 'true' ||
                    el.getAttribute('aria-selected') === 'true' ||
                    el.getAttribute('data-state') === 'checked' ||
                    el.querySelector('svg[class*="check"]') !== null ||
                    el.querySelector('[data-state="checked"]') !== null;

                if (!isChecked) {
                    el.click();
                    return { found: true, activated: true, text };
                }
                return { found: true, activated: false, text }; // Already active
            }
        }
        return { found: false };
    });

    if (!clicked.found) {
        throw new Error('Menu opened but "Deep research" item not found inside the dialog');
    }

    if (!clicked.activated) {
        console.log(`  ✅ ${clicked.text} was already active. Closing menu...`);
        await page.keyboard.press('Escape'); // Close the dialog
    } else {
        console.log(`  ✅ Activated: ${clicked.text}`);
    }

    // Settle DOM before typing
    await new Promise(r => setTimeout(r, 600));
}

/**
 * Paste a prompt into the Perplexity Lexical input and submit.
 * Uses execCommand('insertText') to safely inject text into contenteditable.
 * @param {import('puppeteer').Page} page
 * @param {string} promptText
 */
async function injectPrompt(page, promptText) {
    const INPUT_SELECTOR = '#ask-input[contenteditable="true"], [contenteditable="true"][role="textbox"]';
    const SUBMIT_SELECTOR = 'button[aria-label*="Submit"], button[aria-label*="Send"], button[type="submit"]';

    // 1: Wait for the Lexical editor and focus it
    await page.waitForSelector(INPUT_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(INPUT_SELECTOR);
    await new Promise(r => setTimeout(r, 200));

    // 2: Inject text via execCommand (bulk insert)
    await page.evaluate((text) => {
        document.execCommand('insertText', false, text);
    }, promptText);

    // 3: Dispatch an 'input' event to force React state sync
    await page.evaluate(() => {
        const el = document.querySelector('#ask-input[contenteditable="true"], [contenteditable="true"][role="textbox"]');
        if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 4: Adaptive wait for submit button to become enabled (max 5 seconds)
    console.log(`  ⏳ Syncing Lexical state and waiting for Submit button...`);
    const startWait = Date.now();
    let submitReady = false;
    while (Date.now() - startWait < 5000) {
        submitReady = await page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            return btn !== null && !btn.disabled;
        }, SUBMIT_SELECTOR);
        if (submitReady) break;
        await new Promise(r => setTimeout(r, 200));
    }

    if (!submitReady) {
        console.warn('  ⚠️ Submit button not enabled, attempting Enter fallback...');
        // Fallback: prime Lexical natively, then Enter
        await page.keyboard.type(' ', { delay: 50 });
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 300));
        await page.keyboard.press('Enter');
    } else {
        // 5: Click submit button safely
        await page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            if (btn) btn.click();
        }, SUBMIT_SELECTOR);
    }

    console.log('  ⌨️  Prompt submitted, waiting for generation...');
}

/**
 * Wait for generation to complete by detecting the main "Copy" button
 * (excluding copy buttons inside <pre>/<code> blocks).
 * @param {import('puppeteer').Page} page
 */
async function waitForGeneration(page) {
    console.log('  ⏳ Deep Research is running. Patiently waiting for generation to finish...');

    while (true) {
        try {
            const isReady = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button[aria-label="Copy"]'));
                return buttons.some(b => !b.closest('pre') && !b.closest('code'));
            });

            if (isReady) {
                break; // Copy button found, generation is complete!
            }
        } catch (error) {
            // If the error is about execution context destruction due to navigation,
            // we simply ignore it and let the loop try again on the next tick.
            // (Silently catching ensures the script doesn't crash during the URL change)
        }

        // Wait 2 seconds before checking again (prevents CPU spam)
        await new Promise(r => setTimeout(r, 2000));
    }

    // Streaming buffer — ensure final tokens are flushed
    await new Promise(r => setTimeout(r, 2000));

    console.log('  ✅ Generation complete (Copy button detected).');
}

/**
 * Extract the JSON/answer text from the Perplexity response container.
 * Targets the new `div[id^="markdown-content-"]` structure.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string>}
 */
async function extractAnswerText(page) {
    const jsonString = await page.evaluate(() => {
        const markdownBlocks = Array.from(document.querySelectorAll('div[id^="markdown-content-"]'));
        const last = markdownBlocks[markdownBlocks.length - 1];
        if (!last) return null;

        const codeEls = Array.from(last.querySelectorAll('pre.not-prose code, pre code'));
        if (codeEls.length === 0) return null;

        const isJson = (codeEl) => {
            const pre = codeEl.closest('pre');
            const wrapper = pre?.closest('.codeWrapper') || pre;
            const lang = wrapper?.querySelector('[data-testid="code-language-indicator"]')?.textContent?.trim()?.toLowerCase();
            if (lang && lang.includes('json')) return true;
            return (codeEl.className || '').toLowerCase().includes('json');
        };

        const jsonCode = codeEls.find(isJson) || codeEls[0];
        return jsonCode ? (jsonCode.innerText || '').trim() : null;
    });

    if (!jsonString) {
        throw new Error('Could not find Perplexity answer container (or no code blocks within it)');
    }

    console.log(`  📋 Extracted JSON string (${jsonString.length} chars)`);
    return jsonString;
}

// ============================================================================
// COMEET OUTPUT WRITER
// ============================================================================

/**
 * Classify extracted companies via extractor, write JSON + CSV.
 * @param {Object} parsed - Parsed JSON with .companies array
 * @returns {number} Number of valid companies written
 */
function writeComeetOutput(parsed) {
    const today = new Date().toISOString().split('T')[0];
    const companies = parsed.companies || (Array.isArray(parsed) ? parsed : []);

    const validated = [];
    for (const c of companies) {
        const url = c.careers_page_url || '';
        const { atsType: detected } = classifyAndExtract(url);

        // Accept if extractor detects Comeet, or if URL contains comeet domain
        if (detected === 'comeet' || /comeet\.(com|co)/i.test(url)) {
            validated.push({
                company_name: c.company_name,
                careers_page_url: url,
                confidence: c.confidence || 'high',
                evidence: c.evidence || '',
            });
            console.log(`     ✅ ${c.company_name} → Comeet`);
        } else {
            console.log(`     ⚠️  ${c.company_name} — URL not recognised as Comeet, skipping`);
        }
    }

    // Write comeet_companies_israel.json
    const output = {
        metadata: {
            ats: 'Comeet (now Spark Hire Recruit)',
            search_date: today,
            target_region: 'Israel',
            total_new_companies: validated.length,
            source: 'local_ui_discovery',
        },
        companies: validated,
    };

    const outPath = path.join(DATA_DIR, 'comeet_companies_israel.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`  💾 Wrote ${validated.length} Comeet companies to ${path.basename(outPath)}`);

    // Append to comeet_list.csv for harvest_tokens.js
    appendToComeetCsv(validated);

    return validated.length;
}

// ============================================================================
// HANDOFF
// ============================================================================

function runHandoff() {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  🚀 Injection Handoff');
    console.log(`${'═'.repeat(60)}`);

    if (AUTO_INJECT) {
        console.log('\n  Running inject_and_validate.js...');
        try {
            execSync('node tools/inject_and_validate.js', {
                stdio: 'inherit',
                cwd: PROJECT_ROOT,
            });
        } catch (err) {
            console.error(`  ❌ inject_and_validate.js failed: ${err.message}`);
        }

        console.log('\n  Running harvest_tokens.js...');
        try {
            execSync('node tools/comeet/harvest_tokens.js', {
                stdio: 'inherit',
                cwd: PROJECT_ROOT,
            });
        } catch (err) {
            console.error(`  ❌ harvest_tokens.js failed: ${err.message}`);
        }
    } else {
        console.log('\n  ✅ Discovery complete. To inject into MongoDB, run:\n');
        console.log('     node tools/inject_and_validate.js');
        console.log('     node tools/comeet/harvest_tokens.js');
        console.log('\n  (or re-run with --auto-inject to execute automatically)\n');
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('  🔬 Local UI Discovery Pipeline (Comeet)');
    console.log('  ' + new Date().toISOString());
    console.log('═'.repeat(60));

    // Step 1: Fetch existing company names from MongoDB
    console.log('\n  📡 Connecting to MongoDB for exclusion list...');
    const existingNames = await fetchExistingComeetNames();

    // Step 2: Back up existing data files
    backupDataFiles();

    // Step 3: Launch Puppeteer
    console.log('\n  🚀 Launching browser...');
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1280, height: 900 },
        userDataDir: PROFILE_DIR,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars'
        ],
    });

    let companiesFound = 0;

    try {
        const pages = await browser.pages();
        const page = pages[0];
        page.setDefaultNavigationTimeout(60000);
        await page.goto(PERPLEXITY_URL, { waitUntil: 'domcontentloaded' });

        // Brief pause to let the React shell hydrate before polling
        await new Promise(r => setTimeout(r, 1000));

        // Wait for login
        await waitForAppReady(page);

        // Process Comeet only
        for (const atsType of ['comeet']) {
            console.log(`\n${'═'.repeat(60)}`);
            console.log(`  🔎 Processing ATS: ${atsType.toUpperCase()}`);
            console.log(`${'═'.repeat(60)}`);

            try {
                // Build prompt with DB exclusion list injected
                const promptText = buildPrompt(atsType, existingNames);
                console.log(`  📝 Prompt built (${promptText.length} chars, ${existingNames.length} excluded companies)`);

                // Ensure "Deep research" is active before injecting
                await ensureDeepResearch(page);

                // Inject prompt
                await injectPrompt(page, promptText);

                // Wait for generation
                await waitForGeneration(page);

                // Extract answer
                const rawText = await extractAnswerText(page);

                // Parse JSON
                let parsed;
                try {
                    parsed = extractJSON(rawText);
                    console.log('  🧩 JSON parsed successfully');
                } catch (parseErr) {
                    console.error(`  ❌ JSON extraction failed: ${parseErr.message}`);
                    console.error('  📄 Raw text dump (first 2000 chars):');
                    console.error('  ' + '─'.repeat(50));
                    console.error(rawText.substring(0, 2000));
                    console.error('  ' + '─'.repeat(50));

                    // Write raw text to file for debugging
                    const dumpPath = path.join(DATA_DIR, `raw_dump_${atsType}_${Date.now()}.txt`);
                    fs.writeFileSync(dumpPath, rawText, 'utf-8');
                    console.error(`  💾 Full raw text saved to ${path.basename(dumpPath)}`);
                    continue; // skip to next ATS type (or end)
                }

                // Classify + write output
                companiesFound = writeComeetOutput(parsed);

            } catch (err) {
                console.error(`  ❌ Error processing ${atsType}: ${err.message}`);
            }

            // Session reset (for future multi-ATS support)
            // console.log(`\n  🔄 Resetting session... (${INTER_QUERY_DELAY_MS / 1000}s cooldown)`);
            // await page.goto(PERPLEXITY_URL, { waitUntil: 'domcontentloaded' });
            // await new Promise(r => setTimeout(r, INTER_QUERY_DELAY_MS));
        }
    } catch (err) {
        console.error(`\n❌ Fatal browser error: ${err.message}`);
    } finally {
        await browser.close();
        console.log('\n  🔌 Browser closed.');
    }

    // Summary
    console.log(`\n${'─'.repeat(60)}`);
    console.log('  📊 Discovery Summary');
    console.log(`${'─'.repeat(60)}`);
    console.log(`   Comeet companies found: ${companiesFound}`);
    console.log(`${'─'.repeat(60)}`);

    // Handoff
    runHandoff();
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
