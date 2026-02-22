/**
 * Verification Script for Refactored Workday Worker
 * 
 * Tests the following fixes:
 * 1. fetchAllJobs returns Array (not { jobs, stats })
 * 2. Dynamic facet detection works
 * 3. Job normalization extracts title/location correctly
 * 
 * Usage: node tools/verify_workday_fix.js
 */

const path = require('path');

// Enable debug mode for detailed output
process.env.DEBUG_WORKDAY = 'true';
process.env.ATS_QUIET_MODE = 'false';

// Import the WorkdayWorker
const { WorkdayWorker } = require('../../ats/workers/workdayWorker');

// Test target: NVIDIA (known complex Workday implementation)
const TEST_COMPANY = {
    id: 'nvidia',
    name: 'NVIDIA',
    uid: 'nvidia',
    type: 'workday',
    url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'
};

async function verifyWorkdayFix() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  WORKDAY WORKER VERIFICATION SCRIPT');
    console.log('  Target: NVIDIA (Complex JSON Structure)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    let passed = true;

    try {
        // Step 1: Instantiate the worker
        console.log('📦 Instantiating WorkdayWorker...');
        const worker = new WorkdayWorker({
            name: TEST_COMPANY.name,
            url: TEST_COMPANY.url
        });
        console.log(`   Site URL: ${worker.siteUrl}`);
        console.log(`   API Endpoint: ${worker.apiEndpoint}\n`);

        // Step 2: Call fetchAllJobs
        console.log('🔄 Calling fetchAllJobs()...\n');
        const startTime = Date.now();
        const result = await worker.fetchAllJobs(TEST_COMPANY);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('  VERIFICATION RESULTS');
        console.log('═══════════════════════════════════════════════════════════════\n');

        // Check 1: Return Type
        const isArray = Array.isArray(result);
        console.log(`✅ Return type is Array: ${isArray}`);
        if (!isArray) {
            console.log(`❌ CRITICAL: Expected Array, got ${typeof result}`);
            console.log(`   Actual type: ${Object.prototype.toString.call(result)}`);
            if (result && typeof result === 'object') {
                console.log(`   Object keys: ${Object.keys(result).join(', ')}`);
            }
            passed = false;
        }

        // Check 2: Job Count
        const jobs = isArray ? result : (result?.jobs || []);
        console.log(`📊 Jobs found: ${jobs.length} (fetched in ${elapsed}s)`);

        if (jobs.length === 0) {
            console.log('\n⚠️  WARNING: Zero jobs returned!');
            console.log('   Possible causes:');
            console.log('   - Location facet detection failed (no Israel ID found)');
            console.log('   - API request blocked by WAF/Akamai');
            console.log('   - Session initialization failed');
            console.log('   Check the DEBUG output above for details.\n');
            passed = false;
        } else {
            // Check 3: Normalization Quality
            const firstJob = jobs[0];
            console.log('\n📋 First Job Sample:');
            console.log(`   Job ID:   ${firstJob.jobId || '(missing)'}`);
            console.log(`   Title:    ${firstJob.title || '(missing)'}`);
            console.log(`   Location: ${firstJob.location || '(missing)'}`);
            console.log(`   Posted:   ${firstJob.postedAt || '(not parsed)'}`);
            console.log(`   URL:      ${firstJob.url || '(missing)'}`);

            // Validate title extraction
            if (!firstJob.title || firstJob.title === 'Unknown' || firstJob.title.trim() === '') {
                console.log('\n❌ CRITICAL FAILURE: Title is missing or "Unknown"!');
                console.log('   The _normalizeJob() cascading fallback did not work.');
                console.log('   Check the raw job dump above to identify the correct field.\n');
                passed = false;
            }

            // Validate location extraction
            if (!firstJob.location || firstJob.location.trim() === '') {
                console.log('\n⚠️  WARNING: Location is empty.');
                console.log('   The location fallback chain may need adjustment.\n');
            }

            // Show a few more jobs for confidence
            if (jobs.length > 1) {
                console.log('\n📋 Additional Samples (titles only):');
                jobs.slice(1, 5).forEach((job, i) => {
                    const title = job.title || '(no title)';
                    const loc = job.location || '(no location)';
                    console.log(`   ${i + 2}. ${title.substring(0, 50)}... | ${loc}`);
                });
            }
        }

        // Final verdict
        console.log('\n═══════════════════════════════════════════════════════════════');
        if (passed && jobs.length > 0) {
            console.log('  ✅ VERIFICATION PASSED');
            console.log('  All critical fixes are working correctly.');
        } else if (jobs.length === 0) {
            console.log('  ⚠️  VERIFICATION INCONCLUSIVE');
            console.log('  No jobs returned - cannot validate normalization.');
            console.log('  Check facet detection and session initialization.');
        } else {
            console.log('  ❌ VERIFICATION FAILED');
            console.log('  One or more critical issues detected.');
        }
        console.log('═══════════════════════════════════════════════════════════════\n');

        // Return stats for programmatic use
        return {
            passed,
            isArrayReturn: isArray,
            jobCount: jobs.length,
            sampleJob: jobs[0] || null,
            elapsed
        };

    } catch (err) {
        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('  ❌ VERIFICATION CRASHED');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`  Error: ${err.message}`);
        console.log(`  Stack: ${err.stack}`);
        console.log('═══════════════════════════════════════════════════════════════\n');

        return {
            passed: false,
            error: err.message
        };
    }
}

// Run verification
verifyWorkdayFix()
    .then(result => {
        process.exit(result.passed ? 0 : 1);
    })
    .catch(err => {
        console.error('Unhandled error:', err);
        process.exit(1);
    });
