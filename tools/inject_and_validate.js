/**
 * Inject & Validate Tool
 *
 * Reads discovery JSON files from data/, actively validates each company
 * against its ATS API, and upserts the valid ones into MongoDB `companies`.
 *
 * Expected files in data/:
 *   - workday_israel_companies.json       (direct array)
 *   - greenhouse_israeli_companies.json   (object with .companies array)
 *   - comeet_companies_israel.json        (object with .companies array)
 *
 * Usage:  node tools/inject_and_validate.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// ─── Paths ───────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');

const FILES = {
    workday: path.join(DATA_DIR, 'workday_israel_companies.json'),
    greenhouse: path.join(DATA_DIR, 'greenhouse_israeli_companies.json'),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pause execution for `ms` milliseconds */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Random delay between 1 000 – 2 000 ms to avoid rate-limiting */
const rateLimitDelay = () => sleep(1000 + Math.random() * 1000);

/** Safe JSON file reader – returns [] on missing / malformed files */
function loadJson(filePath) {
    if (!fs.existsSync(filePath)) {
        console.warn(`  ⚠️  File not found: ${path.basename(filePath)}`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
        console.error(`  ❌ Failed to parse ${path.basename(filePath)}: ${err.message}`);
        return null;
    }
}

// ─── Validation & Mapping ────────────────────────────────────────────────────

async function validateAndMap() {
    const valid = [];
    const invalid = [];

    // ── Workday ──────────────────────────────────────────────────────────────
    const workdayRaw = loadJson(FILES.workday);
    const workdayList = Array.isArray(workdayRaw) ? workdayRaw : [];
    console.log(`\n🏢 Workday: ${workdayList.length} candidates`);

    for (const c of workdayList) {
        try {
            await axios.get(c.careers_page_url, { timeout: 15000 });
            valid.push({ name: c.company_name, type: 'workday', url: c.careers_page_url });
            console.log(`  ✅ ${c.company_name}`);
        } catch (err) {
            const reason = err.response
                ? `HTTP ${err.response.status}`
                : err.code || err.message;
            invalid.push({ name: c.company_name, type: 'workday', reason });
            console.log(`  ❌ ${c.company_name} — ${reason}`);
        }
        await rateLimitDelay();
    }

    // ── Greenhouse ───────────────────────────────────────────────────────────
    const greenhouseRaw = loadJson(FILES.greenhouse);
    const greenhouseList =
        greenhouseRaw && Array.isArray(greenhouseRaw.companies)
            ? greenhouseRaw.companies
            : Array.isArray(greenhouseRaw)
                ? greenhouseRaw
                : [];
    console.log(`\n🌱 Greenhouse: ${greenhouseList.length} candidates`);

    for (const c of greenhouseList) {
        const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${c.board_token}/jobs`;
        try {
            await axios.get(apiUrl, { timeout: 15000 });
            valid.push({ name: c.company_name, type: 'greenhouse', uid: c.board_token });
            console.log(`  ✅ ${c.company_name}`);
        } catch (err) {
            const reason = err.response
                ? `HTTP ${err.response.status}`
                : err.code || err.message;
            invalid.push({ name: c.company_name, type: 'greenhouse', reason });
            console.log(`  ❌ ${c.company_name} — ${reason}`);
        }
        await rateLimitDelay();
    }

    return { valid, invalid };
}

// ─── MongoDB Injection ───────────────────────────────────────────────────────

function buildBulkOps(validCompanies) {
    const now = new Date();

    return validCompanies.map((doc) => {
        // Build the filter depending on ATS type
        const filter =
            doc.type === 'workday'
                ? { url: doc.url, type: 'workday' }
                : { uid: doc.uid, type: doc.type };

        // Fields to always set
        const $set = { name: doc.name, type: doc.type, updatedAt: now };

        if (doc.url) $set.url = doc.url;
        if (doc.uid) $set.uid = doc.uid;
        if (doc.token) $set.token = doc.token;

        return {
            updateOne: {
                filter,
                update: {
                    $set,
                    $setOnInsert: { enabled: true, createdAt: now },
                },
                upsert: true,
            },
        };
    });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('🔧 Inject & Validate — ATS Company Loader');
    console.log('='.repeat(60));

    // 1. Validate against ATS APIs
    const { valid, invalid } = await validateAndMap();

    // 2. Print validation summary
    const countByType = (arr, type) => arr.filter((x) => x.type === type).length;

    console.log('\n' + '─'.repeat(60));
    console.log('📊 Validation Summary');
    console.log('─'.repeat(60));
    console.log(`  Workday    — Valid: ${countByType(valid, 'workday')}  |  Invalid: ${countByType(invalid, 'workday')}`);
    console.log(`  Greenhouse — Valid: ${countByType(valid, 'greenhouse')}  |  Invalid: ${countByType(invalid, 'greenhouse')}`);
    console.log(`  TOTAL      — Valid: ${valid.length}  |  Invalid: ${invalid.length}`);

    if (invalid.length > 0) {
        console.log('\n❌ Invalid companies:');
        for (const entry of invalid) {
            console.log(`   [${entry.type}] ${entry.name} — ${entry.reason}`);
        }
    }

    if (valid.length === 0) {
        console.log('\n⚠️  No valid companies to inject. Exiting.');
        return;
    }

    // 3. Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        console.error('\n❌ MONGODB_URI not found in environment. Cannot inject.');
        process.exit(1);
    }

    let client;
    try {
        client = new MongoClient(mongoUri, {
            maxPoolSize: 5,
            serverSelectionTimeoutMS: 10000,
        });
        await client.connect();
        console.log('\n🔗 Connected to MongoDB');

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

        // 4. Build & execute bulkWrite
        const ops = buildBulkOps(valid);
        const result = await collection.bulkWrite(ops, { ordered: false });

        const summaryData = {
            greenhouse: { valid: countByType(valid, 'greenhouse'), invalid: countByType(invalid, 'greenhouse') },
            workday: { valid: countByType(valid, 'workday'), invalid: countByType(invalid, 'workday') }
        };
        fs.writeFileSync(path.join(DATA_DIR, 'summary_inject_gw.json'), JSON.stringify(summaryData, null, 2), 'utf-8');

        console.log('\n' + '='.repeat(60));
        console.log('✅ Injection Complete');
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

module.exports = { validateAndMap, buildBulkOps };
