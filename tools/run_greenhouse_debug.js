/**
 * Greenhouse-Only Debug Runner
 * 
 * Purpose: Run GreenhouseWorker in debug mode without orchestrator/Comeet
 * Used for debugging, performance tuning, and verifying timing/throttling
 * 
 * Data Source: data/greenhouse_list.csv (CSV format: id,name,type,uid,token)
 * 
 * Usage:
 *   node tools/run_greenhouse_debug.js [--limit N] [--company "name"] [--no-batch-pause]
 * 
 * Or via npm:
 *   npm run greenhouse:debug
 *   npm run greenhouse:debug:sample
 */

// Set DEBUG_GREENHOUSE automatically for this script
process.env.DEBUG_GREENHOUSE = 'true';

const fs = require('fs');
const path = require('path');
const { createHttpClient } = require('../ats/utils/httpClient');
const { GreenhouseWorker } = require('../ats/workers/greenhouseWorker');

// ============================================================================
// CSV PARSING
// ============================================================================

/**
 * Parse greenhouse_list.csv into company objects
 * Format: id,name,type,uid,token (header row is ignored)
 * 
 * @returns {Array<{id: string, name: string, type: string, uid: string}>}
 */
function parseGreenhouseCsv() {
    const csvPath = path.join(__dirname, '..', 'data', 'greenhouse_list.csv');

    if (!fs.existsSync(csvPath)) {
        throw new Error(`CSV file not found: ${csvPath}`);
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

    // Skip header row
    if (lines.length < 2) {
        throw new Error('CSV file has no data rows');
    }

    const companies = [];

    // Start from index 1 to skip header
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(',');
        if (parts.length < 4) {
            console.warn(`⚠️  Skipping invalid CSV row ${i + 1}: ${line}`);
            continue;
        }

        const [id, name, type, uid] = parts.map(p => p.trim());

        if (!id || !uid) {
            console.warn(`⚠️  Skipping row ${i + 1} with missing id or uid: ${line}`);
            continue;
        }

        companies.push({
            id,
            name: name || id,
            type: 'greenhouse',
            uid,
        });
    }

    return companies;
}

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        limit: null,
        company: null,
        noBatchPause: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--limit' && args[i + 1]) {
            const limitValue = parseInt(args[i + 1], 10);
            if (isNaN(limitValue) || limitValue < 1) {
                console.warn(`⚠️  Warning: Invalid --limit value "${args[i + 1]}", ignoring`);
            } else {
                config.limit = limitValue;
            }
            i++;
        } else if (arg === '--company' && args[i + 1]) {
            config.company = args[i + 1];
            i++;
        } else if (arg === '--no-batch-pause') {
            config.noBatchPause = true;
        } else if (arg.startsWith('--')) {
            console.warn(`⚠️  Warning: Unknown flag "${arg}", ignoring`);
        }
    }

    return config;
}

// ============================================================================
// BATCH PAUSE UTILITIES
// ============================================================================

/**
 * Get batch pause configuration
 */
function getBatchPauseConfig(noBatchPause) {
    return {
        enabled: !noBatchPause,
        batchSize: 10,
        pauseMinMs: 10000,  // 10 seconds
        pauseMaxMs: 30000,  // 30 seconds
    };
}

/**
 * Random delay between min and max milliseconds
 */
function randomDelay(minMs, maxMs) {
    const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Small delay between companies (1-3 seconds)
 */
function smallDelay() {
    return randomDelay(1000, 3000);
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
    const args = parseArgs();
    const startTime = Date.now();

    console.log('🚀 Greenhouse-Only Debug Runner');
    console.log('='.repeat(60));
    console.log(`   DEBUG_GREENHOUSE: ${process.env.DEBUG_GREENHOUSE}`);
    console.log('');

    // Parse companies from CSV
    console.log('📂 Loading companies from CSV...');
    let allCompanies;
    try {
        allCompanies = parseGreenhouseCsv();
        console.log(`   ✅ Loaded ${allCompanies.length} companies from greenhouse_list.csv`);
    } catch (error) {
        console.error(`❌ Error loading companies: ${error.message}`);
        process.exit(1);
    }

    if (allCompanies.length === 0) {
        console.error('❌ No companies found in CSV');
        process.exit(1);
    }

    // Apply filters
    let companies = allCompanies;

    if (args.company) {
        companies = companies.filter(c =>
            c.id === args.company ||
            (c.name && c.name.toLowerCase().includes(args.company.toLowerCase()))
        );
        console.log(`   🎯 Filtered to company: "${args.company}" (${companies.length} found)\n`);
    }

    if (args.limit && args.limit > 0) {
        companies = companies.slice(0, args.limit);
        console.log(`   📊 Limited to first ${args.limit} companies\n`);
    }

    if (companies.length === 0) {
        console.error('❌ No companies to process');
        process.exit(1);
    }

    // Batch pause configuration
    const batchConfig = getBatchPauseConfig(args.noBatchPause);

    console.log('📋 Configuration:');
    console.log(`   Companies to process: ${companies.length}`);
    console.log(`   Batch pause: ${batchConfig.enabled ? 'enabled' : 'disabled'}`);
    if (batchConfig.enabled) {
        console.log(`      Batch size: ${batchConfig.batchSize}`);
        console.log(`      Pause range: ${batchConfig.pauseMinMs}-${batchConfig.pauseMaxMs}ms`);
    }
    console.log('');

    // Initialize HTTP client and worker
    const httpClient = createHttpClient();
    const worker = new GreenhouseWorker(httpClient);

    // Reset run stats at start
    worker.resetRunStats();

    console.log(`📋 Processing ${companies.length} companies:\n`);
    companies.forEach((c, i) => {
        console.log(`   ${i + 1}. ${c.name || c.id} (${c.id})`);
    });
    console.log('');

    // Track totals
    let totalJobs = 0;
    let totalFetched = 0;

    // Process companies serially
    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const companyIndex = i + 1;

        console.log(`\n[${companyIndex}/${companies.length}] Processing: ${company.name || company.id}`);
        console.log('-'.repeat(60));

        try {
            const result = await worker.fetchAllJobs(company);

            const jobsCount = result.jobs ? result.jobs.length : 0;
            const stats = result.stats || {};

            totalJobs += jobsCount;
            totalFetched += stats.fetched || 0;

            console.log(`   ✅ Completed: ${jobsCount} jobs kept`);
            if (stats.fetched) {
                console.log(`   📊 Stats: Fetched=${stats.fetched}, Kept=${jobsCount}, Dropped=${stats.dropped || 0}`);
            }

            // Apply batch pause if enabled and we've processed a full batch (and not the last company)
            if (batchConfig.enabled && companyIndex % batchConfig.batchSize === 0 && companyIndex < companies.length) {
                const pauseStartTime = Date.now();
                const pauseMs = Math.floor(
                    Math.random() * (batchConfig.pauseMaxMs - batchConfig.pauseMinMs + 1) + batchConfig.pauseMinMs
                );

                console.log(`\n⏸️  Batch pause: sleeping ${pauseMs}ms after processing company #${companyIndex} (batch of ${batchConfig.batchSize})`);
                console.log(`   Progress: ${companyIndex}/${companies.length} companies processed`);

                await randomDelay(batchConfig.pauseMinMs, batchConfig.pauseMaxMs);

                const actualPauseMs = Date.now() - pauseStartTime;
                console.log(`   ✅ Resuming after batch pause (actual: ${actualPauseMs}ms)\n`);
            } else if (companyIndex < companies.length) {
                // Small delay between individual companies (1-3s)
                await smallDelay();
            }
        } catch (error) {
            console.error(`   ❌ Unexpected error: ${error.message}`);
            if (error.stack) {
                console.error(`   Stack: ${error.stack}`);
            }
        }
    }

    // Finalize run statistics and generate summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Finalizing run statistics...');
    worker.finalizeRun();

    // Get final stats
    const finalStats = worker.getRunStats();
    const totalDurationMs = Date.now() - startTime;

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Run Summary');
    console.log('='.repeat(60));
    console.log(`   Total companies: ${finalStats.companiesProcessed}`);
    console.log(`   Succeeded: ${finalStats.companiesSucceeded}`);
    console.log(`   Failed: ${finalStats.companiesFailed}`);
    console.log(`   Total jobs fetched: ${finalStats.totalFetched}`);
    console.log(`   Total jobs kept: ${finalStats.totalKept}`);
    console.log(`   Total jobs dropped: ${finalStats.totalDropped}`);

    if (Object.keys(finalStats.droppedByReason || {}).length > 0) {
        console.log(`\n   Dropped by reason:`);
        for (const [reason, count] of Object.entries(finalStats.droppedByReason)) {
            console.log(`     ${reason}: ${count}`);
        }
    }

    if (finalStats.errors && finalStats.errors.length > 0) {
        console.log(`\n   Errors: ${finalStats.errors.length}`);
        finalStats.errors.slice(0, 5).forEach(err => {
            console.log(`     - ${err.companyId}: ${err.error}`);
        });
        if (finalStats.errors.length > 5) {
            console.log(`     ... and ${finalStats.errors.length - 5} more`);
        }
    }

    console.log(`\n   Timing:`);
    console.log(`     Total duration: ${Math.round(totalDurationMs / 1000)}s`);
    if (finalStats.totalDurationMs) {
        console.log(`     Worker duration: ${Math.round(finalStats.totalDurationMs / 1000)}s`);
    }
    console.log('='.repeat(60) + '\n');
}

// Run main function
if (require.main === module) {
    main().catch(error => {
        console.error('\n❌ Fatal error:', error);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    });
}

module.exports = { main };
