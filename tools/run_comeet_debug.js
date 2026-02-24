/**
 * Comeet-Only Debug Runner
 * 
 * Purpose: Run ComeetWorker in debug mode without orchestrator/Greenhouse
 * Used for debugging, performance tuning, and verifying timing/throttling
 * 
 * Usage:
 *   node tools/run_comeet_debug.js [--limit N] [--company "name"] [--no-batch-pause]
 * 
 * Or via npm:
 *   npm run comeet:debug
 *   npm run comeet:debug:sample
 */

// Set DEBUG_COMEET automatically for this script
process.env.DEBUG_COMEET = 'true';

const { loadCompaniesConfig } = require('../ats/config/companiesConfig');
const { createHttpClient } = require('../ats/utils/httpClient');
const { ComeetWorker } = require('../ats/workers/comeetWorker');
const { parseBatchPauseConfig, mergeBatchPauseConfig, randomDelay } = require('../ats/utils/comeetRunConfig');

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
// MAIN EXECUTION
// ============================================================================

async function main() {
  const args = parseArgs();
  const startTime = Date.now();

  console.log('🚀 Comeet-Only Debug Runner');
  console.log('='.repeat(60));
  console.log(`   DEBUG_COMEET: ${process.env.DEBUG_COMEET}`);
  console.log('');

  // Load companies using the config loader (gets merged list from both files)
  console.log('📂 Loading companies...');
  let allCompanies;
  try {
    allCompanies = loadCompaniesConfig();
    console.log(`   ✅ Loaded ${allCompanies.length} total companies`);
  } catch (error) {
    console.error(`❌ Error loading companies: ${error.message}`);
    process.exit(1);
  }

  // Filter to Comeet companies only
  const comeetCompanies = allCompanies.filter(c => 
    c && c.type === 'comeet' && c.enabled !== false
  );
  console.log(`   📊 Found ${comeetCompanies.length} Comeet companies\n`);

  if (comeetCompanies.length === 0) {
    console.error('❌ No Comeet companies found');
    process.exit(1);
  }

  // Apply filters
  let companies = comeetCompanies;
  
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

  // Parse batch pause configuration
  const baseBatchConfig = parseBatchPauseConfig();
  const batchConfig = mergeBatchPauseConfig(baseBatchConfig, {
    noBatchPause: args.noBatchPause,
  });

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
  const worker = new ComeetWorker(httpClient);
  
  // Reset run stats at start
  worker.resetRunStats();

  console.log(`📋 Processing ${companies.length} companies:\n`);
  companies.forEach((c, i) => {
    console.log(`   ${i + 1}. ${c.name || c.id} (${c.id})`);
  });
  console.log('');

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







