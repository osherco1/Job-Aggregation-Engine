/**
 * NVIDIA Workday Raw Facet Dumper
 * 
 * Dumps the raw facets JSON from the API response.
 * 
 * ⚠️ MANUAL INSPECTION REQUIRED:
 * Search the output for "Israel", "Tel Aviv", or "Yokneam" to find the location facet IDs.
 */

const axios = require('axios');

const NVIDIA_WORKDAY_URL = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs';

const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const payload = {
    appliedFacets: {},
    limit: 1,
    offset: 0,
    searchText: ''
};

async function dumpRawFacets() {
    console.log('🔍 NVIDIA Workday Raw Facet Dumper');
    console.log('═'.repeat(60));
    console.log('');
    console.log('⚠️  MANUAL INSPECTION REQUIRED:');
    console.log('    Search the output below for "Israel", "Tel Aviv", or "Yokneam"');
    console.log('    to find the location facet IDs and key names.');
    console.log('');
    console.log('═'.repeat(60));
    console.log('');

    try {
        const response = await axios.post(NVIDIA_WORKDAY_URL, payload, { headers });

        console.log('✅ API Response received');
        console.log('');
        console.log('📋 Top-level response keys:', Object.keys(response.data).join(', '));
        console.log('');

        // Dump the raw facets array
        console.log('📦 RAW FACETS ARRAY:');
        console.log('═'.repeat(60));
        console.log(JSON.stringify(response.data.facets, null, 2));
        console.log('═'.repeat(60));

    } catch (error) {
        console.log('❌ Request Failed');
        console.log('Error:', error.message);
        if (error.response) {
            console.log('Status:', error.response.status);
            console.log('Data:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

// Run the dumper
dumpRawFacets();
