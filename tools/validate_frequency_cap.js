/**
 * Dry validation for runtime frequency cap (JobStateService).
 * Run: node tools/validate_frequency_cap.js
 *
 * Asserts:
 * - Same company + same canonical title (e.g. "Software Engineer, Platform - Tokyo" vs "... - New York") -> max 3 kept.
 * - Different company or different role -> not capped together.
 */

const { createJobStateService } = require('../services/JobStateService');

const mockStorage = {
    loadSentHistory: async () => new Set(),
    persistSentHistory: async () => {},
};

function run() {
    const service = createJobStateService(mockStorage);

    // Speechify-style: 5 jobs, same company, same canonical title (location suffix stripped)
    const speechifyJobs = [
        { jobId: 'li_1', title: 'Software Engineer, Platform - Tokyo', sourceCompanyId: 'speechify' },
        { jobId: 'li_2', title: 'Software Engineer, Platform - New York', sourceCompanyId: 'speechify' },
        { jobId: 'li_3', title: 'Software Engineer, Platform - Zurich', sourceCompanyId: 'speechify' },
        { jobId: 'li_4', title: 'Software Engineer, Platform - Berlin', sourceCompanyId: 'speechify' },
        { jobId: 'li_5', title: 'Software Engineer, Platform - Tel Aviv', sourceCompanyId: 'speechify' },
    ];

    // Two distinct roles from same company -> should both be kept (different canonical titles)
    const mixedCompany = [
        ...speechifyJobs,
        { jobId: 'gh_1', title: 'Junior Backend Developer', sourceCompanyId: 'speechify' },
        { jobId: 'gh_2', title: 'QA Engineer', sourceCompanyId: 'speechify' },
    ];

    return service.filterNewJobs(mixedCompany).then((newJobs) => {
        const stats = service.getStats();

        const speechifyPlatformCount = newJobs.filter(
            (j) => j.sourceCompanyId === 'speechify' && (j.title || '').includes('Software Engineer, Platform')
        ).length;
        const totalKept = newJobs.length;

        console.log('Validation results:');
        console.log('  Input:', mixedCompany.length, 'jobs');
        console.log('  Output:', totalKept, 'jobs');
        console.log('  Capped:', stats.lastRunCappedCount);
        console.log('  Speechify "Platform" kept:', speechifyPlatformCount);
        console.log('  Sample capped keys:', stats.lastRunTopCappedKeys);

        if (stats.lastRunCappedCount !== 2) {
            throw new Error(`Expected 2 capped jobs (5 Platform - 3 kept), got ${stats.lastRunCappedCount}`);
        }
        if (speechifyPlatformCount !== 3) {
            throw new Error(`Expected 3 "Software Engineer, Platform" jobs kept, got ${speechifyPlatformCount}`);
        }
        if (totalKept !== 5) {
            throw new Error(`Expected 5 total kept (3 Platform + 2 other roles), got ${totalKept}`);
        }

        console.log('\n✅ Frequency cap validation passed.');
    });
}

run().catch((err) => {
    console.error('Validation failed:', err.message);
    process.exitCode = 1;
});
