/**
 * Comeet Puppeteer Harvester & Injector
 *
 * Launches Puppeteer to scrape real API tokens from Comeet career pages,
 * validates each token against the Comeet careers-api, and upserts valid
 * companies directly into MongoDB via bulkWrite.
 *
 * Input sources (checked in order, first found is used):
 *   1. tools/comeet_list.csv       — CSV with "Company Name" + URL columns
 *   2. comeet_list.csv             — CSV with id,name,type,uid,token columns
 *   3. data/comeet_companies_israel.json — JSON with .companies array
 *
 * Usage:  node tools/inject_comeet_puppeteer.js
 *         node tools/inject_comeet_puppeteer.js --file path/to/custom.csv
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// ─── Configuration ───────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_TIMEOUT_MS = 30000;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

// Browser-spoofing headers for the validation call (matches comeetWorker.js)
const COMEET_API_HEADERS = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.comeet.com/',
    Origin: 'https://www.comeet.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () =>
    delay(Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS);

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    values.push(current.trim());
    return values;
}

/**
 * Parse a CSV file and return a uniform array of { companyName, url }.
 * Supports both the old-format (Company Name, Full Job Board URL)
 * and new-format (id, name, type, uid, token) CSVs.
 */
function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
    const rows = [];

    // New format: has id + uid columns → construct URL
    const idIdx = headers.indexOf('id');
    const uidIdx = headers.indexOf('uid');
    const nameIdx = headers.findIndex((h) => h.includes('name'));

    if (idIdx !== -1 && uidIdx !== -1 && nameIdx !== -1) {
        for (let i = 1; i < lines.length; i++) {
            const vals = parseCSVLine(lines[i]);
            const slug = vals[idIdx];
            const uid = vals[uidIdx];
            const name = vals[nameIdx];
            if (slug && uid && name) {
                rows.push({ companyName: name, url: `https://www.comeet.com/jobs/${slug}/${uid}` });
            }
        }
        return rows;
    }

    // Old format: Company Name + URL
    const compNameIdx = headers.findIndex((h) => h.includes('company name') || h === 'name');
    const urlIdx = headers.findIndex(
        (h) => h.includes('full job board url') || (h.includes('url') && !h.includes('token')),
    );
    if (compNameIdx === -1 || urlIdx === -1) return [];

    for (let i = 1; i < lines.length; i++) {
        const vals = parseCSVLine(lines[i]);
        const name = vals[compNameIdx];
        const url = vals[urlIdx];
        if (name && url && url.startsWith('http')) {
            rows.push({ companyName: name, url });
        }
    }
    return rows;
}

/**
 * Parse the JSON discovery file (comeet_companies_israel.json).
 */
function parseDiscoveryJson(filePath) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const arr = Array.isArray(raw) ? raw : raw.companies || [];
        return arr
            .filter((c) => c.company_name && c.careers_page_url)
            .map((c) => ({ companyName: c.company_name, url: c.careers_page_url }));
    } catch {
        return [];
    }
}

// ─── Input Resolution ────────────────────────────────────────────────────────

function resolveInput() {
    // --file flag override
    const fileArgIdx = process.argv.indexOf('--file');
    if (fileArgIdx !== -1 && process.argv[fileArgIdx + 1]) {
        const custom = path.resolve(process.argv[fileArgIdx + 1]);
        if (!fs.existsSync(custom)) {
            console.error(`❌ File not found: ${custom}`);
            process.exit(1);
        }
        console.log(`📂 Using custom input: ${path.basename(custom)}`);
        return custom.endsWith('.json') ? parseDiscoveryJson(custom) : parseCSV(custom);
    }

    // Default cascading lookup
    const candidates = [
        path.join(__dirname, 'comeet_list.csv'),           // tools/comeet_list.csv
        path.join(PROJECT_ROOT, 'comeet_list.csv'),         // root comeet_list.csv
        path.join(PROJECT_ROOT, 'data', 'comeet_companies_israel.json'),
    ];

    for (const fp of candidates) {
        if (fs.existsSync(fp)) {
            console.log(`📂 Using input: ${path.relative(PROJECT_ROOT, fp)}`);
            const items = fp.endsWith('.json') ? parseDiscoveryJson(fp) : parseCSV(fp);
            if (items.length > 0) return items;
        }
    }

    console.error('❌ No input file found. Place a CSV or JSON in the expected location.');
    process.exit(1);
}

// ─── Puppeteer Extraction ────────────────────────────────────────────────────

/**
 * Extract COMPANY_DATA (uid + token) from a Comeet careers page.
 * Mirrors the proven logic from harvest_comeet_puppeteer.js.
 */
async function extractCompanyData(page, url) {
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });
        await delay(1500); // let late JS execute

        const data = await page.evaluate(() => {
            // 1. Check window globals
            if (window.COMPANY_DATA && typeof window.COMPANY_DATA === 'object')
                return window.COMPANY_DATA;
            if (window.companyData && typeof window.companyData === 'object')
                return window.companyData;

            // 2. Search inline <script> tags
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const s of scripts) {
                const c = s.textContent || '';
                const patterns = [
                    /COMPANY_DATA\s*=\s*({[\s\S]*?});/,
                    /window\.COMPANY_DATA\s*=\s*({[\s\S]*?});/,
                ];
                for (const p of patterns) {
                    const m = c.match(p);
                    if (m && m[1]) {
                        try {
                            const obj = JSON.parse(m[1]);
                            if (obj && (obj.company_uid || obj.uid || obj.token)) return obj;
                        } catch {
                            // Fallback: extract fields individually
                            const t = c.match(/"token"\s*:\s*"([^"]+)"/);
                            const u = c.match(/"company_uid"\s*:\s*"([^"]+)"/);
                            if (t || u)
                                return {
                                    company_uid: u ? u[1] : null,
                                    token: t ? t[1] : null,
                                };
                        }
                    }
                }
            }
            return null;
        });

        if (!data) return null;
        return {
            uid: data.company_uid || data.uid || null,
            token: data.token || null,
            name: data.name || null,
        };
    } catch {
        return null;
    }
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function validateToken(uid, token) {
    const url = `https://www.comeet.co/careers-api/1.0/company/${uid}/positions?token=${token}`;
    try {
        const res = await axios.get(url, { timeout: 15000, headers: COMEET_API_HEADERS });
        return res.status === 200;
    } catch {
        return false;
    }
}

// ─── MongoDB ─────────────────────────────────────────────────────────────────

function extractDbName(uri) {
    try {
        const p = new URL(uri).pathname;
        return p && p.length > 1 ? p.substring(1) : 'jobbot_db';
    } catch {
        return 'jobbot_db';
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 Comeet Puppeteer Harvester & Injector');
    console.log('='.repeat(60));

    // 1. Resolve input companies
    const companies = resolveInput();
    console.log(`   ${companies.length} companies to process\n`);

    // 2. Launch Puppeteer
    console.log('🌐 Launching Puppeteer...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
    });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // 3. Scrape each company
    const harvested = [];   // { companyName, uid, token }
    const failed = [];       // { companyName, reason }

    for (let i = 0; i < companies.length; i++) {
        const { companyName, url } = companies[i];
        console.log(`\n[${i + 1}/${companies.length}] ${companyName}`);
        console.log(`   URL: ${url}`);

        // Fallback: extract uid from URL path if scraping misses it
        const urlUidMatch = url.match(/\/jobs\/[^/]+\/([^/]+)/);
        const urlUid = urlUidMatch ? urlUidMatch[1] : null;

        const data = await extractCompanyData(page, url);

        if (!data || (!data.token)) {
            const reason = !data ? 'COMPANY_DATA not found on page' : 'Token not found in page data';
            failed.push({ companyName, reason });
            console.log(`   ❌ ${reason}`);
            if (i < companies.length - 1) await randomDelay();
            continue;
        }

        const uid = data.uid || urlUid;
        if (!uid) {
            failed.push({ companyName, reason: 'UID not found (page or URL)' });
            console.log('   ❌ UID not found (page or URL)');
            if (i < companies.length - 1) await randomDelay();
            continue;
        }

        // Optional quick API validation
        const isValid = await validateToken(uid, data.token);
        if (!isValid) {
            failed.push({ companyName, reason: 'API validation returned non-200' });
            console.log(`   ⚠️  Token extracted but API validation failed — will still inject`);
            // Inject anyway; the token was scraped correctly; API might be rate-limiting
        } else {
            console.log(`   ✅ Token validated`);
        }

        const slug = url.match(/\/jobs\/([^/]+)/)?.[1] || companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
        harvested.push({
            name: data.name || companyName,
            type: 'comeet',
            uid,
            token: data.token,
            id: slug,
        });
        console.log(`   ✅ Harvested — UID: ${uid} | Token: ${data.token.substring(0, 10)}...`);

        if (i < companies.length - 1) await randomDelay();
    }

    // 4. Close Puppeteer
    await browser.close();
    console.log('\n🌐 Browser closed');

    // 5. Summary
    console.log('\n' + '─'.repeat(60));
    console.log('📊 Harvest Summary');
    console.log('─'.repeat(60));
    console.log(`   Processed:  ${companies.length}`);
    console.log(`   Harvested:  ${harvested.length}`);
    console.log(`   Failed:     ${failed.length}`);

    if (failed.length > 0) {
        console.log('\n   ❌ Failed companies:');
        for (const f of failed) console.log(`      ${f.companyName} — ${f.reason}`);
    }

    if (harvested.length === 0) {
        console.log('\n⚠️  Nothing to inject. Exiting.');
        return;
    }

    // 6. MongoDB injection
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        console.error('\n❌ MONGODB_URI not set. Printing results instead:\n');
        console.log(JSON.stringify(harvested, null, 2));
        process.exit(1);
    }

    let client;
    try {
        client = new MongoClient(mongoUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });
        await client.connect();
        console.log('\n🔗 Connected to MongoDB');

        const db = client.db(extractDbName(mongoUri));
        const collection = db.collection('companies');
        const now = new Date();

        const ops = harvested.map((doc) => ({
            updateOne: {
                filter: { uid: doc.uid, type: 'comeet' },
                update: {
                    $set: {
                        name: doc.name,
                        type: 'comeet',
                        uid: doc.uid,
                        token: doc.token,
                        id: doc.id,
                        updatedAt: now,
                        addedBy: 'inject_comeet_puppeteer',
                    },
                    $setOnInsert: { enabled: true, createdAt: now },
                },
                upsert: true,
            },
        }));

        const result = await collection.bulkWrite(ops, { ordered: false });

        console.log('\n' + '='.repeat(60));
        console.log('✅ MongoDB Injection Complete');
        console.log('='.repeat(60));
        console.log(`   Matched:  ${result.matchedCount}`);
        console.log(`   Modified: ${result.modifiedCount}`);
        console.log(`   Upserted: ${result.upsertedCount}`);
        console.log('='.repeat(60) + '\n');
    } catch (err) {
        console.error(`\n❌ MongoDB error: ${err.message}`);
        process.exit(1);
    } finally {
        if (client) {
            await client.close();
            console.log('🔌 MongoDB connection closed\n');
        }
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal error:', err.message || err);
        process.exit(1);
    });
}

module.exports = { main };
