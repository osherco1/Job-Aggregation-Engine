/**
 * Standalone test harness for services/notifications/TelegramNotifier.
 *
 * Usage:
 *   node tools/test_telegram_notifier.js              # --full (default)
 *   node tools/test_telegram_notifier.js --full       # 6 mock jobs + 2 errors
 *   node tools/test_telegram_notifier.js --empty      # zero jobs, zero errors
 *   node tools/test_telegram_notifier.js --errors-only# zero jobs, 3 errors
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.
 *
 * Manual verification checklist:
 *   - Summary arrives as message #1 with source breakdown line.
 *   - Each job arrives as a separate message with an "Apply" button.
 *   - HTML special chars in titles render as literal text (no execution / escaping bugs).
 *   - --full elapsed time is roughly (N_messages - 1) * 1100ms — proves bottleneck pacing.
 *   - --empty shows just one summary message, no cards.
 *   - With TELEGRAM_BOT_TOKEN=invalid, script logs failure and returns false WITHOUT throwing.
 */

require('dotenv').config();
const { createTelegramNotifier } = require('../services/notifications/TelegramNotifier');

const MOCK_JOBS_FULL = [
    {
        jobId: 'li_001',
        source: 'linkedin',
        title: 'Senior Backend Engineer',
        company: 'Acme Tech',
        location: 'Tel Aviv, Israel',
        url: 'https://www.linkedin.com/jobs/view/li_001',
        applyUrl: 'https://www.linkedin.com/jobs/view/li_001',
        listedAt: Date.now() - 3 * 60 * 60 * 1000,
        applyMethodEasyApply: true,
        appliesCount: 42,
        employmentType: 'Full-time',
    },
    {
        jobId: 'cm_002',
        source: 'comeet',
        title: 'Product Manager',
        company: 'BetaWorks',
        location: 'Remote',
        url: 'https://www.comeet.com/jobs/betaworks/12345',
        listedAt: Date.now() - 26 * 60 * 60 * 1000,
    },
    {
        jobId: 'gh_003',
        source: 'greenhouse',
        title: 'Staff DevOps Engineer',
        company: 'CloudCo',
        location: 'Hybrid — Herzliya',
        url: 'https://boards.greenhouse.io/cloudco/jobs/003',
        skills: ['Kubernetes', 'Terraform', 'AWS', 'CI/CD', 'Go'],
    },
    {
        jobId: 'wd_004',
        source: 'workday',
        title: 'Director of Engineering',
        company: 'MegaCorp',
        location: 'New York, NY',
        url: 'https://megacorp.wd1.myworkdayjobs.com/job/004',
        recruiter: { firstName: 'Dana', lastName: 'Levi', profileUrl: 'https://www.linkedin.com/in/dana-levi' },
        listedAt: Date.now() - 5 * 60 * 60 * 1000,
    },
    {
        jobId: 'li_005',
        source: 'linkedin',
        title: 'Frontend Developer <script>alert(1)</script>',
        company: 'EscapeMe & Co. <test>',
        location: 'Tel Aviv',
        url: 'https://www.linkedin.com/jobs/view/li_005',
        applyMethodEasyApply: false,
        skills: ['React', 'TypeScript', 'CSS'],
    },
    {
        jobId: 'li_006',
        source: 'linkedin',
        title: 'Data Scientist (No URL)',
        company: 'StealthCo',
        location: 'Unknown',
    },
];

const MOCK_ERRORS_FULL = [
    { source: 'comeet/acme_co', message: 'Network timeout after 30s' },
    { source: 'greenhouse/widgetcorp', message: 'HTTP 503 Service Unavailable' },
];

const MOCK_ERRORS_ONLY = [
    { source: 'LinkedIn', message: 'CRITICAL_AUTH_CHALLENGE - LinkedIn authentication failed', details: { status: 302 } },
    { source: 'comeet/foo', message: 'Connection reset by peer' },
    { source: 'workday/bar', message: 'Invalid response: expected JSON, got text/html' },
];

function pickScenario() {
    const flag = (process.argv[2] || '--full').toLowerCase();
    if (flag === '--empty') return { name: 'empty', jobs: [], errors: [], expectedMessages: 1 };
    if (flag === '--errors-only' || flag === '--errors') {
        return { name: 'errors-only', jobs: [], errors: MOCK_ERRORS_ONLY, expectedMessages: 1 };
    }
    return { name: 'full', jobs: MOCK_JOBS_FULL, errors: MOCK_ERRORS_FULL, expectedMessages: 1 + MOCK_JOBS_FULL.length };
}

(async () => {
    const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env — aborting.');
        process.exit(1);
    }

    const scenario = pickScenario();
    const notifier = createTelegramNotifier();

    const expectedMinMs = (scenario.expectedMessages - 1) * 1100;
    console.log('='.repeat(60));
    console.log(`Telegram notifier test — scenario: ${scenario.name}`);
    console.log(`Jobs: ${scenario.jobs.length}, Errors: ${scenario.errors.length}`);
    console.log(`Expected messages: ${scenario.expectedMessages} (min elapsed ~${expectedMinMs}ms)`);
    console.log('='.repeat(60));

    const t0 = Date.now();
    const ok = await notifier.sendUnifiedReport(scenario.jobs, scenario.errors);
    const elapsed = Date.now() - t0;

    console.log('-'.repeat(60));
    console.log(`Result: ${ok ? 'SUCCESS' : 'FAILURE'} (return value: ${ok})`);
    console.log(`Elapsed: ${elapsed}ms`);
    if (ok && elapsed < expectedMinMs - 200) {
        console.warn(`⚠️  Elapsed (${elapsed}ms) is below expected minimum (${expectedMinMs}ms). Bottleneck may not be pacing correctly.`);
    } else if (ok) {
        console.log('✅ Pacing looks correct.');
    }

    process.exit(ok ? 0 : 1);
})();
