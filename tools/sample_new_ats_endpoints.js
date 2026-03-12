/**
 * Raw Sampling Script for 4 New ATS Platforms
 *
 * Fetches sample JSON from Lever, Ashby, Workable, and SmartRecruiters public APIs
 * to inspect exact response schemas before building production workers.
 *
 * Usage: node tools/sample_new_ats_endpoints.js
 * Output: data/new_ats_samples.json
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'new_ats_samples.json');

const ENDPOINTS = {
  workable: {
    url: 'https://apply.workable.com/api/v1/widget/accounts/nuvei',
    extractJobs: (res) => res.data?.jobs ?? res.data?.data?.jobs ?? [],
    needsDetails: true,
    detailsUrl: (shortcode) =>
      `https://apply.workable.com/api/v1/widget/accounts/nuvei/jobs/${shortcode}`,
    getId: (job) => job?.shortcode ?? job?.id,
  },
  smartrecruiters: {
    url: 'https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings?limit=2&offset=0',
    extractJobs: (res) => res.data?.content ?? res.data?.data ?? [],
    needsDetails: true,
    detailsUrl: (id) =>
      `https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings/${id}`,
    getId: (job) => job?.id ?? job?.identifier,
  },
};

async function sampleLever() {
  const url = 'https://api.eu.lever.co/v0/postings/mobileye?mode=json&limit=2';
  try {
    const raw = await axios.get(url, { timeout: 15000 });
    // Lever returns array directly (no wrapper)
    const jobs = Array.isArray(raw.data) ? raw.data : [];
    const sample = jobs.slice(0, 2);
    return { success: true, raw: raw.data, jobs: sample };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sampleAshby() {
  const url = 'https://api.ashbyhq.com/posting-api/job-board/deel?includeCompensation=true';
  try {
    const raw = await axios.get(url, { timeout: 15000 });
    const jobs = raw.data?.jobs ?? raw.data?.data?.jobs ?? [];
    const arr = Array.isArray(jobs) ? jobs : [];
    const sample = arr.slice(0, 2);
    return { success: true, raw: raw.data, jobs: sample };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sampleWorkable() {
  const cfg = ENDPOINTS.workable;
  try {
    const raw = await axios.get(cfg.url, { timeout: 15000 });
    const jobs = raw.data?.jobs ?? raw.data?.data?.jobs ?? [];
    const arr = Array.isArray(jobs) ? jobs : [];
    const sample = arr.slice(0, 2);

    let firstJobDetails = null;
    if (sample.length > 0) {
      const shortcode = cfg.getId(sample[0]);
      if (shortcode) {
        try {
          const detailsRes = await axios.get(cfg.detailsUrl(shortcode), {
            timeout: 15000,
          });
          firstJobDetails = detailsRes.data;
        } catch (e) {
          firstJobDetails = { _fetchError: e.message };
        }
      }
    }

    return {
      success: true,
      raw: raw.data,
      jobs: sample,
      firstJobDetails,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sampleSmartRecruiters() {
  const cfg = ENDPOINTS.smartrecruiters;
  try {
    const raw = await axios.get(cfg.url, { timeout: 15000 });
    const jobs = raw.data?.content ?? raw.data?.data ?? [];
    const arr = Array.isArray(jobs) ? jobs : [];
    const sample = arr.slice(0, 2);

    let firstJobDetails = null;
    if (sample.length > 0) {
      const id = cfg.getId(sample[0]);
      if (id) {
        try {
          const detailsRes = await axios.get(cfg.detailsUrl(id), {
            timeout: 15000,
          });
          firstJobDetails = detailsRes.data;
        } catch (e) {
          firstJobDetails = { _fetchError: e.message };
        }
      }
    }

    return {
      success: true,
      raw: raw.data,
      jobs: sample,
      firstJobDetails,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function main() {
  console.log('Fetching samples from 4 ATS endpoints...\n');

  const [lever, ashby, workable, smartrecruiters] = await Promise.all([
    sampleLever(),
    sampleAshby(),
    sampleWorkable(),
    sampleSmartRecruiters(),
  ]);

  const result = {
    generatedAt: new Date().toISOString(),
    lever: {
      success: lever.success,
      jobCount: lever.success ? lever.jobs.length : 0,
      ...lever,
    },
    ashby: {
      success: ashby.success,
      jobCount: ashby.success ? ashby.jobs.length : 0,
      ...ashby,
    },
    workable: {
      success: workable.success,
      jobCount: workable.success ? workable.jobs.length : 0,
      ...workable,
    },
    smartrecruiters: {
      success: smartrecruiters.success,
      jobCount: smartrecruiters.success ? smartrecruiters.jobs.length : 0,
      ...smartrecruiters,
    },
  };

  const dir = path.dirname(OUTPUT_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf8');

  const statuses = [
    ['Lever', lever.success, lever.success ? lever.jobs?.length : 0],
    ['Ashby', ashby.success, ashby.success ? ashby.jobs?.length : 0],
    ['Workable', workable.success, workable.success ? workable.jobs?.length : 0],
    ['SmartRecruiters', smartrecruiters.success, smartrecruiters.success ? smartrecruiters.jobs?.length : 0],
  ];

  statuses.forEach(([name, ok, count]) => {
    const icon = ok ? '✅' : '❌';
    const msg = ok ? `${count} jobs` : 'failed';
    console.log(`${icon} ${name}: ${msg}`);
  });

  const failed = statuses.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log('\nErrors:');
    failed.forEach(([name]) => {
      const r = result[name.toLowerCase()];
      if (r?.error) console.log(`  ${name}: ${r.error}`);
    });
  }

  console.log(`\n✅ Output written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
