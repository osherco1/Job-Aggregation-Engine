const fs = require('fs');
const path = require('path');
// שים לב: וודא שהשם תואם בדיוק לקובץ שיצרת (WorkdayWorker או workdayWorker)
const { WorkdayWorker } = require('../../ats/workers/workdayWorker');

async function runTest() {
    try {
        // 1. טעינת הבנק
        const dataPath = path.join(__dirname, '../data/workday_companies.json');
        if (!fs.existsSync(dataPath)) {
            throw new Error(`Data file not found at: ${dataPath}`);
        }
        const companies = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

        // 2. בחירת קבוצת ביקורת (3 החברות הראשונות: Intel, Nvidia, GM)
        const testBatch = companies.slice(0, 3);

        console.log(`🧪 Starting Workday Smoke Test on ${testBatch.length} companies...`);

        for (const company of testBatch) {
            console.log(`\n════════════════════════════════════════════════════════════`);
            console.log(`🏢 Processing: ${company.name}`);
            console.log(`🔗 URL: ${company.url}`);

            try {
                const worker = new WorkdayWorker(company);

                // מדידת זמנים
                const start = Date.now();
                const jobs = await worker.fetchJobs();
                const duration = ((Date.now() - start) / 1000).toFixed(2);

                console.log(`✅ Success! Fetched ${jobs.length} jobs in ${duration}s`);

                if (jobs.length > 0) {
                    console.log(`📄 Sample Job [0]:`);
                    console.log(`   Title: ${jobs[0].title}`);
                    console.log(`   Location: ${jobs[0].location}`);
                    console.log(`   URL: ${jobs[0].url}`);
                    console.log(`   ID: ${jobs[0].jobId}`);
                } else {
                    console.log(`⚠️ No jobs found (Check if Israel filter is too strict?)`);
                }

            } catch (err) {
                console.error(`❌ CRITICAL FAILURE: ${err.message}`);
                console.error(err);
            }
        }
    } catch (globalErr) {
        console.error("Script Error:", globalErr.message);
    }
}

runTest();