#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DISCOVERY_DIR = path.join(PROJECT_ROOT, 'tools', 'discovery');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BASE_PROFILE = path.join(DISCOVERY_DIR, 'puppeteer_profile');

const ATS_LIST = ['comeet', 'greenhouse', 'workday'];

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function runProcess(command, args, cwd) {
    return new Promise((resolve, reject) => {
        console.log(`\n▶️ Running: ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, { cwd, stdio: 'inherit', shell: true });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Process exited with code ${code}`));
        });
        proc.on('error', (err) => reject(err));
    });
}

function safeDeleteDir(dirPath) {
    if (fs.existsSync(dirPath)) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            console.log(`   🗑️ Deleted ${dirPath}`);
        } catch (err) {
            console.warn(`   ⚠️ Could not delete ${dirPath}: ${err.message}`);
        }
    }
}

function safeDeleteFile(filePath) {
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            console.log(`   🗑️ Deleted ${path.basename(filePath)}`);
        } catch (err) {
            console.warn(`   ⚠️ Could not delete ${filePath}: ${err.message}`);
        }
    }
}

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('🚀 UNIFIED DISCOVERY & VALIDATION PIPELINE');
    console.log('═'.repeat(60) + '\n');

    // ==========================================
    // PHASE 0: Setup and Authentication Inheritance
    // ==========================================
    console.log('>> PHASE 0: Setup Profiles');
    if (!fs.existsSync(BASE_PROFILE)) {
        console.error(`❌ Base profile not found at ${BASE_PROFILE}. Ensure you have logged in via local_ui_discovery.js manually first.`);
        process.exit(1);
    }

    const profiles = {};
    for (const ats of ATS_LIST) {
        const profileDir = path.join(DISCOVERY_DIR, `profile_${ats}`);
        profiles[ats] = profileDir;
        safeDeleteDir(profileDir); // clean if exists
        fs.cpSync(BASE_PROFILE, profileDir, { recursive: true });
        console.log(`   📁 Cloned profile for ${ats} -> profile_${ats}`);
    }

    // ==========================================
    // PHASE 1: Parallel Discovery (Staggered)
    // ==========================================
    console.log('\n>> PHASE 1: Parallel Discovery (Staggered Launch)');
    const discoveryPromises = [];

    for (let i = 0; i < ATS_LIST.length; i++) {
        const ats = ATS_LIST[i];
        if (i > 0) {
            console.log(`\n   ⏳ Staggering next launch by 15 seconds to avoid bot detection...`);
            await delay(15000);
        }

        const promise = runProcess('node', [
            'tools/discovery/local_ui_discovery.js',
            '--ats', ats,
            '--profile', profiles[ats]
        ], PROJECT_ROOT).catch(err => {
            console.error(`❌ Discovery for ${ats} failed: ${err.message}`);
            return { failed: true, ats };
        });

        discoveryPromises.push(promise);
    }

    console.log('\n   ⏳ Waiting for all discovery processes to finish...');
    const discoveryResults = await Promise.all(discoveryPromises);

    // Check if everything failed
    if (discoveryResults.every(r => r && r.failed)) {
        console.error('❌ All discovery processes failed. Aborting pipeline.');
        process.exit(1);
    }

    // ==========================================
    // PHASE 2: Parallel Validation & Injection
    // ==========================================
    console.log('\n>> PHASE 2: Parallel Validation & Injection');

    const validationPromises = [];
    validationPromises.push(
        runProcess('node', ['tools/inject_and_validate.js'], PROJECT_ROOT).catch(err => {
            console.error(`❌ GW Validation failed: ${err.message}`);
        })
    );

    validationPromises.push(
        runProcess('node', ['tools/comeet/harvest_tokens.js', '--all'], PROJECT_ROOT).catch(err => {
            console.error(`❌ Comeet Validation failed: ${err.message}`);
        })
    ); // Use --all if we want to process everything, but harvest_tokens auto-filters to missings unless requested. Wait, discovery makes new entries with no tokens so it naturally catches them. No --all needed.
    // Let me remove --all.

    await Promise.all(validationPromises);

    // ==========================================
    // PHASE 3: Aggregation & Cleanup
    // ==========================================
    console.log('\n>> PHASE 3: Aggregation & Cleanup');

    const summaryGwPath = path.join(DATA_DIR, 'summary_inject_gw.json');
    const summaryComeetPath = path.join(DATA_DIR, 'summary_inject_comeet.json');

    let summaryGw = { greenhouse: { valid: 0, invalid: 0 }, workday: { valid: 0, invalid: 0 } };
    let summaryComeet = { comeet: { updated: 0, disabled: 0 } };

    if (fs.existsSync(summaryGwPath)) {
        try { summaryGw = JSON.parse(fs.readFileSync(summaryGwPath, 'utf8')); } catch (e) { }
    }

    if (fs.existsSync(summaryComeetPath)) {
        try { summaryComeet = JSON.parse(fs.readFileSync(summaryComeetPath, 'utf8')); } catch (e) { }
    }

    // Print Unified Summary Dashboard
    console.log('\n' + '═'.repeat(60));
    console.log('📊 UNIFIED INJECTION DASHBOARD');
    console.log('═'.repeat(60));
    console.log(`   Greenhouse : ${summaryGw.greenhouse?.valid || 0} valid | ${summaryGw.greenhouse?.invalid || 0} invalid`);
    console.log(`   Workday    : ${summaryGw.workday?.valid || 0} valid | ${summaryGw.workday?.invalid || 0} invalid`);
    console.log(`   Comeet     : ${summaryComeet.comeet?.updated || 0} updated | ${summaryComeet.comeet?.disabled || 0} disabled/failed`);
    console.log('═'.repeat(60) + '\n');

    // Cleanup Profiles & IPC JSONs
    console.log('   Cleaning up temporary files...');
    for (const ats of ATS_LIST) {
        safeDeleteDir(profiles[ats]);
    }
    safeDeleteFile(summaryGwPath);
    safeDeleteFile(summaryComeetPath);

    console.log('\n✅ Pipeline Complete!');
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
