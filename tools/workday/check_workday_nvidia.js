/**
 * NVIDIA Workday API POC
 * 
 * Tests direct access to NVIDIA's Workday internal JSON API
 * to verify we can scrape job data without browser automation.
 * 
 * URL Pattern: https://<tenant>.<instance>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
 */

const axios = require('axios');

const NVIDIA_WORKDAY_URL = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs';

const payload = {
    appliedFacets: {},
    limit: 20,
    offset: 0,
    searchText: ''
};

const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function checkNvidiaWorkdayAPI() {
    console.log('🔍 Testing NVIDIA Workday API...');
    console.log(`📡 URL: ${NVIDIA_WORKDAY_URL}`);
    console.log('');

    try {
        const response = await axios.post(NVIDIA_WORKDAY_URL, payload, { headers });

        console.log('✅ Connection Successful');
        console.log('');

        const data = response.data;

        // Log total jobs found
        const totalJobs = data.total || data.jobPostings?.length || 'Unknown';
        console.log(`📊 Total Jobs Found: ${totalJobs}`);
        console.log('');

        // Get the job postings array
        const jobs = data.jobPostings || data.jobs || [];

        if (jobs.length > 0) {
            console.log('🔎 First Job Object (for structure inspection):');
            console.log('═'.repeat(60));
            console.log(JSON.stringify(jobs[0], null, 2));
            console.log('═'.repeat(60));
            console.log('');

            // Highlight key fields if they exist
            const firstJob = jobs[0];
            console.log('📍 Key Fields Preview:');
            if (firstJob.title) console.log(`   • Title: ${firstJob.title}`);
            if (firstJob.externalPath) console.log(`   • External Path: ${firstJob.externalPath}`);
            if (firstJob.locationsText) console.log(`   • Location (text): ${firstJob.locationsText}`);
            if (firstJob.location) console.log(`   • Location: ${JSON.stringify(firstJob.location)}`);
            if (firstJob.postedOn) console.log(`   • Posted On: ${firstJob.postedOn}`);
        } else {
            console.log('⚠️ No job postings found in response.');
            console.log('Full response structure:');
            console.log(JSON.stringify(data, null, 2));
        }

    } catch (error) {
        console.log('❌ Connection Failed');
        console.log('');

        if (error.response) {
            // Server responded with error status
            console.log(`📛 Status Code: ${error.response.status}`);
            console.log(`📛 Status Text: ${error.response.statusText}`);
            console.log('');
            console.log('📄 Response Headers:');
            console.log(JSON.stringify(error.response.headers, null, 2));
            console.log('');
            console.log('📄 Response Data:');
            console.log(JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            // Request was made but no response received
            console.log('📛 No response received from server');
            console.log('📄 Error Details:', error.message);
        } else {
            // Error in setting up the request
            console.log('📛 Request Setup Error:', error.message);
        }

        console.log('');
        console.log('🔧 Full Error Object:');
        console.log(error.message);
    }
}

// Run the check
checkNvidiaWorkdayAPI();
