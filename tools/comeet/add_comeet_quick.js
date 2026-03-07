#!/usr/bin/env node
/**
 * Quick Add Comeet Company (Direct Mode)
 * 
 * Add a company directly to the database when you know the UID.
 * No scraping required - just provide ID, name, and UID.
 * Fetches the token via a lightweight HTTP probe, validates,
 * and upserts into MongoDB.
 * 
 * Usage:
 *   node tools/comeet/add_comeet_quick.js --id <id> --name <name> --uid <uid>
 *   node tools/comeet/add_comeet_quick.js <name> <uid>
 * 
 * Examples:
 *   node tools/comeet/add_comeet_quick.js --id jeen-ai --name "Jeen.ai" --uid "DA.008"
 *   node tools/comeet/add_comeet_quick.js "Jeen.ai" "DA.008"
 *   node tools/comeet/add_comeet_quick.js Landa A4.000
 */

require('dotenv').config();

const https = require('https');
const { createStorageAdapter } = require('../../services/storage');
const { validateCompanies: validateComeet } = require('./validate_companies');

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

function parseArgs(args) {
    const result = { id: null, name: null, uid: null, force: false };

    // Check for --force flag
    if (args.includes('--force')) {
        result.force = true;
        args = args.filter(a => a !== '--force');
    }

    // Try named arguments first
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--id' && args[i + 1]) {
            result.id = args[i + 1];
            i++;
        } else if (args[i] === '--name' && args[i + 1]) {
            result.name = args[i + 1];
            i++;
        } else if (args[i] === '--uid' && args[i + 1]) {
            result.uid = args[i + 1];
            i++;
        }
    }

    // If no named args found, try positional
    if (!result.id && !result.name && !result.uid) {
        const positional = args.filter(a => !a.startsWith('--'));
        if (positional.length >= 3) {
            result.id = positional[0];
            result.name = positional[1];
            result.uid = positional[2];
        } else if (positional.length === 2) {
            // Assume id and uid, use id as name
            result.id = positional[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
            result.name = positional[0];
            result.uid = positional[1];
        }
    }

    // Normalize ID
    if (result.id) {
        result.id = result.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    }

    return result;
}

// ============================================================================
// TOKEN FETCHING (via Comeet API discovery)
// ============================================================================

function fetchToken(uid) {
    return new Promise((resolve, reject) => {
        // Try to get token from Comeet page
        const url = `https://www.comeet.com/jobs/api/company/${uid}`;

        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.token) {
                        resolve(json.token);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));

        // Timeout after 10 seconds
        setTimeout(() => resolve(null), 10000);
    });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('🚀 Quick Add Comeet Company');
    console.log('═'.repeat(60));

    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage:
  node tools/comeet/add_comeet_quick.js --id <id> --name <name> --uid <uid>
  node tools/comeet/add_comeet_quick.js <name> <uid>

Examples:
  node tools/comeet/add_comeet_quick.js --id jeen-ai --name "Jeen.ai" --uid "DA.008"
  node tools/comeet/add_comeet_quick.js "Jeen.ai" "DA.008"
  node tools/comeet/add_comeet_quick.js Landa A4.000

Options:
  --force    Overwrite existing company with same UID
  --help     Show this help message
`);
        process.exit(0);
    }

    const parsed = parseArgs(args);

    if (!parsed.uid) {
        console.error('❌ Error: UID is required');
        console.error('   Usage: node tools/comeet/add_comeet_quick.js <name> <uid>');
        process.exit(1);
    }

    // Auto-generate ID from name if not provided
    if (!parsed.id && parsed.name) {
        parsed.id = parsed.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }

    if (!parsed.id) {
        console.error('❌ Error: ID is required (or provide --name to auto-generate)');
        process.exit(1);
    }

    // Use ID as name if not provided
    if (!parsed.name) {
        parsed.name = parsed.id;
    }

    console.log(`\n📋 Company Details:`);
    console.log(`   ID:   ${parsed.id}`);
    console.log(`   Name: ${parsed.name}`);
    console.log(`   UID:  ${parsed.uid}`);

    // Initialize storage adapter (MongoDB)
    let storageAdapter;
    try {
        storageAdapter = createStorageAdapter();
        console.log('✅ Storage adapter initialized');
    } catch (err) {
        console.error(`❌ Failed to initialize storage: ${err.message}`);
        process.exit(1);
    }

    // Load existing companies from DB
    console.log(`\n📂 Loading existing companies from DB...`);
    const allCompanies = await storageAdapter.loadCompanies();
    const existingComeet = allCompanies.filter(c => c.type === 'comeet');
    console.log(`   Found ${existingComeet.length} existing Comeet companies`);

    // Check for duplicates
    const existingByUid = existingComeet.find(c => c.uid === parsed.uid);
    const existingById = existingComeet.find(c => c.id === parsed.id);

    if (existingByUid && !parsed.force) {
        console.log(`\n⚠️  Company with UID "${parsed.uid}" already exists:`);
        console.log(`   ID: ${existingByUid.id}, Name: ${existingByUid.name}`);
        console.log(`   Use --force to overwrite`);
        await storageAdapter.close();
        process.exit(0);
    }

    if (existingById && !parsed.force) {
        console.log(`\n⚠️  Company with ID "${parsed.id}" already exists:`);
        console.log(`   UID: ${existingById.uid}, Name: ${existingById.name}`);
        console.log(`   Use --force to overwrite`);
        await storageAdapter.close();
        process.exit(0);
    }

    // Try to fetch token from Comeet API
    console.log(`\n🔍 Fetching token from Comeet API...`);
    const token = await fetchToken(parsed.uid);

    if (!token) {
        console.log(`   ⚠️  Could not fetch token automatically`);
        console.log(`   The company will NOT be added without a valid token.`);
        console.log(`   Try using the full harvester script instead.`);
        await storageAdapter.close();
        process.exit(1);
    } else {
        console.log(`   ✅ Token found: ${token.substring(0, 15)}...`);
    }

    // Create new company entry
    const newCompany = {
        id: parsed.id,
        name: parsed.name,
        type: 'comeet',
        uid: parsed.uid,
        token: token,
    };

    // Validate token via Comeet API
    console.log(`\n🔍 Validating token via Comeet API...`);
    const { approved, rejected } = await validateComeet([newCompany]);

    if (approved.length === 0) {
        const reason = rejected[0]?.reason || 'Unknown';
        console.error(`\n❌ Validation failed: ${reason}`);
        console.error('   The token may be invalid or the Comeet API may be unreachable');
        await storageAdapter.close();
        process.exit(1);
    }

    console.log(`   ✅ Token validated successfully`);

    // Upsert to MongoDB
    console.log(`\n🔄 Upserting to MongoDB...`);
    try {
        await storageAdapter.upsertCompany({
            ...newCompany,
            addedBy: 'add_comeet_quick',
        });
    } catch (err) {
        console.error(`\n❌ Failed to upsert: ${err.message}`);
        await storageAdapter.close();
        process.exit(1);
    }

    const action = existingByUid || existingById ? 'Updated' : 'Added';
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ ${action} "${parsed.name}" successfully in MongoDB!`);
    console.log('═'.repeat(60));

    await storageAdapter.close();
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
