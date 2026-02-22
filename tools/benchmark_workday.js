#!/usr/bin/env node
/**
 * Workday Performance Benchmark Script
 * 
 * Verifies the searchText="Israel" optimization is working correctly.
 * Measures time and page count for heavy companies.
 * 
 * Usage: node tools/benchmark_workday.js
 * 
 * Success Criteria:
 * - Each company should take < 60 seconds (✅ PASS)
 * - > 120 seconds indicates optimization failure (⚠️ WARNING)
 * - Pages should be < 10 (not 100+)
 */

// Enable debug logging
process.env.DEBUG_WORKDAY = 'true';
process.env.ATS_QUIET_MODE = 'false';

const { WorkdayWorker } = require('../ats/workers/workdayWorker');

// ============================================================================
// BENCHMARK TARGETS (Known heavy companies)
// ============================================================================
const BENCHMARK_TARGETS = [
    {
        id: 'nvidia',
        name: 'NVIDIA',
        url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
        expectedJobsBefore: 2000,  // Without optimization
        expectedJobsAfter: 100     // With searchText="Israel"
    },
    {
        id: 'salesforce',
        name: 'Salesforce',
        url: 'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site',
        expectedJobsBefore: 1500,
        expectedJobsAfter: 50
    }
];

// Thresholds
const THRESHOLD_PASS_SEC = 60;      // < 60s = PASS
const THRESHOLD_WARN_SEC = 120;     // > 120s = WARNING
const PAGE_SIZE = 20;

// ============================================================================
// BENCHMARK RUNNER
// ============================================================================

async function benchmarkCompany(target) {
    console.log('\n' + '─'.repeat(60));
    console.log(`🔬 BENCHMARKING: ${target.name}`);
    console.log('─'.repeat(60));
    console.log(`   URL: ${target.url}`);
    console.log(`   Expected (before optimization): ~${target.expectedJobsBefore} jobs`);
    console.log(`   Expected (after optimization): ~${target.expectedJobsAfter} jobs`);
    console.log('');

    const startTime = Date.now();
    let result = {
        company: target.name,
        success: false,
        totalJobs: 0,
        pages: 0,
        durationSec: 0,
        verdict: 'UNKNOWN',
        error: null
    };

    try {
        // Instantiate worker
        const worker = new WorkdayWorker({
            name: target.name,
            url: target.url
        });

        // Fetch jobs (this is what we're benchmarking)
        console.log('   ⏱️  Starting fetch...\n');
        const fetchResult = await worker.fetchJobs();

        const endTime = Date.now();
        const durationMs = endTime - startTime;
        const durationSec = Math.round(durationMs / 1000);

        // Extract metrics
        const stats = fetchResult.stats;
        const totalJobs = stats.fetched;
        const pages = stats.pages;

        result.success = true;
        result.totalJobs = totalJobs;
        result.pages = pages;
        result.durationSec = durationSec;

        // Determine verdict
        if (durationSec < THRESHOLD_PASS_SEC) {
            result.verdict = 'PASS';
        } else if (durationSec < THRESHOLD_WARN_SEC) {
            result.verdict = 'ACCEPTABLE';
        } else {
            result.verdict = 'WARNING';
        }

    } catch (err) {
        const endTime = Date.now();
        result.durationSec = Math.round((endTime - startTime) / 1000);
        result.error = err.message;
        result.verdict = 'ERROR';
    }

    return result;
}

function printResult(result) {
    console.log('\n' + '═'.repeat(60));
    console.log(`📊 RESULT: ${result.company}`);
    console.log('═'.repeat(60));

    if (result.error) {
        console.log(`   ❌ ERROR: ${result.error}`);
        console.log(`   Duration: ${result.durationSec}s`);
        return;
    }

    const verdictIcon = result.verdict === 'PASS' ? '✅' :
        result.verdict === 'ACCEPTABLE' ? '🟡' :
            result.verdict === 'WARNING' ? '⚠️' : '❌';

    console.log(`   Total Jobs Fetched: ${result.totalJobs}`);
    console.log(`   Pages Retrieved: ${result.pages}`);
    console.log(`   Duration: ${result.durationSec} seconds`);
    console.log('');
    console.log(`   ${verdictIcon} VERDICT: ${result.verdict}`);

    // Analysis
    if (result.pages <= 10) {
        console.log(`   📉 Pagination: OPTIMAL (${result.pages} pages - searchText filter working)`);
    } else if (result.pages <= 30) {
        console.log(`   📊 Pagination: ACCEPTABLE (${result.pages} pages)`);
    } else {
        console.log(`   📈 Pagination: TOO HIGH (${result.pages} pages - filter may not be working!)`);
    }

    if (result.durationSec < THRESHOLD_PASS_SEC) {
        console.log(`   ⚡ Speed: EXCELLENT (< ${THRESHOLD_PASS_SEC}s)`);
    } else if (result.durationSec < THRESHOLD_WARN_SEC) {
        console.log(`   🐢 Speed: SLOW (${result.durationSec}s - but acceptable)`);
    } else {
        console.log(`   🐌 Speed: TOO SLOW (${result.durationSec}s > ${THRESHOLD_WARN_SEC}s threshold)`);
    }
}

function printSummary(results) {
    console.log('\n');
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║' + '         BENCHMARK SUMMARY                                '.substring(0, 58) + '║');
    console.log('╠' + '═'.repeat(58) + '╣');

    let totalTime = 0;
    let passCount = 0;
    let warnCount = 0;
    let errorCount = 0;

    for (const r of results) {
        totalTime += r.durationSec;
        if (r.verdict === 'PASS' || r.verdict === 'ACCEPTABLE') passCount++;
        else if (r.verdict === 'WARNING') warnCount++;
        else errorCount++;

        const status = r.verdict === 'PASS' ? '✅' :
            r.verdict === 'ACCEPTABLE' ? '🟡' :
                r.verdict === 'WARNING' ? '⚠️' : '❌';
        const line = `  ${status} ${r.company}: ${r.totalJobs} jobs, ${r.pages} pages, ${r.durationSec}s`;
        console.log('║ ' + line.padEnd(56) + ' ║');
    }

    console.log('╠' + '═'.repeat(58) + '╣');
    console.log('║ ' + `Total Time: ${totalTime} seconds (${Math.round(totalTime / 60)} min)`.padEnd(56) + ' ║');
    console.log('║ ' + `Pass: ${passCount} | Warn: ${warnCount} | Error: ${errorCount}`.padEnd(56) + ' ║');
    console.log('╚' + '═'.repeat(58) + '╝');

    // Extrapolation
    const avgTimePerCompany = totalTime / results.length;
    const estimatedFor20 = Math.round(avgTimePerCompany * 20 / 60);
    console.log(`\n📈 Extrapolation: 20 companies ≈ ${estimatedFor20} minutes`);

    if (estimatedFor20 < 15) {
        console.log('   ✅ PRODUCTION READY - Optimization is working!');
    } else if (estimatedFor20 < 30) {
        console.log('   🟡 ACCEPTABLE - Consider adding concurrency for faster runs');
    } else {
        console.log('   ⚠️ TOO SLOW - searchText filter may not be reducing results');
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║' + '    WORKDAY PERFORMANCE BENCHMARK                         '.substring(0, 58) + '║');
    console.log('║' + '    Testing searchText="Israel" optimization              '.substring(0, 58) + '║');
    console.log('╚' + '═'.repeat(58) + '╝');
    console.log('');
    console.log('Thresholds:');
    console.log(`   ✅ PASS: < ${THRESHOLD_PASS_SEC} seconds`);
    console.log(`   ⚠️ WARNING: > ${THRESHOLD_WARN_SEC} seconds`);
    console.log(`   📉 Optimal Pages: < 10`);

    const results = [];

    for (const target of BENCHMARK_TARGETS) {
        const result = await benchmarkCompany(target);
        printResult(result);
        results.push(result);
    }

    printSummary(results);
}

main().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
