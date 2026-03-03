#!/usr/bin/env node

/**
 * sample_raw_ats_data.js — Standalone diagnostic tool
 *
 * Samples raw, untouched API responses from all 3 ATS providers to establish
 * "Ground Truth" for payload schema analysis before any refactoring.
 *
 * Usage:
 *   node tools/sample_raw_ats_data.js
 *   node tools/sample_raw_ats_data.js --limit 5        (override per-ATS sample size)
 *   node tools/sample_raw_ats_data.js --only workday   (sample a single ATS type)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const OUTPUT_ROOT = path.join(DATA_DIR, 'raw_samples');

const DEFAULT_SAMPLE_SIZE = 15;
const INTER_REQUEST_DELAY_MS = 2000;
const HTTP_TIMEOUT_MS = 20000;

const COMEET_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.comeet.com/',
  'Origin': 'https://www.comeet.com',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
};

const WORKDAY_BROWSER_HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: DEFAULT_SAMPLE_SIZE, only: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      opts.limit = parseInt(args[i + 1], 10) || DEFAULT_SAMPLE_SIZE;
      i++;
    } else if (args[i] === '--only' && args[i + 1]) {
      opts.only = args[i + 1].toLowerCase();
      i++;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeName(name) {
  return (name || 'unknown').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function selectSample(companies, limit) {
  if (companies.length <= limit) return [...companies];
  return shuffleArray(companies).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Company List Loaders (standalone — no StorageAdapter dependency)
// ---------------------------------------------------------------------------

function loadComeetCompanies() {
  const filePath = path.join(DATA_DIR, 'comeet_companies_auto.json');
  if (!fs.existsSync(filePath)) {
    console.warn('  [WARN] comeet_companies_auto.json not found — checking companies_list.json');
    return loadComeetFromMainList();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return (Array.isArray(raw) ? raw : []).map(c => ({
      id: String(c.id || '').trim(),
      name: String(c.name || c.id || '').trim(),
      uid: String(c.uid || '').trim(),
      token: c.token ? String(c.token).trim() : null,
    })).filter(c => c.id && c.uid && c.token);
  } catch (err) {
    console.error(`  [ERROR] Failed to load comeet_companies_auto.json: ${err.message}`);
    return [];
  }
}

function loadComeetFromMainList() {
  const filePath = path.join(DATA_DIR, 'companies_list.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return (Array.isArray(raw) ? raw : [])
      .filter(c => (c.type || '').toLowerCase() === 'comeet')
      .map(c => ({
        id: String(c.id || '').trim(),
        name: String(c.name || c.id || '').trim(),
        uid: String(c.uid || '').trim(),
        token: c.token ? String(c.token).trim() : null,
      }))
      .filter(c => c.id && c.uid && c.token);
  } catch (err) {
    console.error(`  [ERROR] Failed to load companies_list.json: ${err.message}`);
    return [];
  }
}

function loadGreenhouseCompanies() {
  const filePath = path.join(DATA_DIR, 'greenhouse_list.csv');
  if (!fs.existsSync(filePath)) {
    console.warn('  [WARN] greenhouse_list.csv not found');
    return [];
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];

    const companies = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map(p => p.trim());
      const [id, name, , uid] = parts;
      if (!id || !uid) continue;
      companies.push({
        id,
        name: name || id,
        uid,
      });
    }
    return companies;
  } catch (err) {
    console.error(`  [ERROR] Failed to load greenhouse_list.csv: ${err.message}`);
    return [];
  }
}

function loadWorkdayCompanies() {
  const filePath = path.join(DATA_DIR, 'workday_companies.json');
  if (!fs.existsSync(filePath)) {
    console.warn('  [WARN] workday_companies.json not found');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return (Array.isArray(raw) ? raw : []).map(c => ({
      id: String(c.id || '').trim(),
      name: String(c.name || c.id || '').trim(),
      url: String(c.url || '').trim(),
    })).filter(c => c.id && c.url);
  } catch (err) {
    console.error(`  [ERROR] Failed to load workday_companies.json: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// ATS Samplers
// ---------------------------------------------------------------------------

/**
 * Comeet: GET https://www.comeet.co/careers-api/1.0/company/{uid}/positions?token={token}
 * Replicates the exact production endpoint from comeetWorker.js line 519.
 */
async function sampleComeet(company, outputDir) {
  const url = `https://www.comeet.co/careers-api/1.0/company/${company.uid}/positions?token=${company.token}`;

  const response = await axios.get(url, {
    headers: COMEET_HEADERS,
    timeout: HTTP_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  const outPath = path.join(outputDir, `${safeName(company.id)}.json`);
  const envelope = {
    _meta: {
      source: 'comeet',
      companyId: company.id,
      companyName: company.name,
      uid: company.uid,
      endpoint: url.replace(/token=[^&]+/, 'token=***REDACTED***'),
      httpStatus: response.status,
      sampledAt: new Date().toISOString(),
      jobCount: Array.isArray(response.data) ? response.data.length : null,
    },
    raw: response.data,
  };

  fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2), 'utf-8');
  return { status: response.status, jobCount: envelope._meta.jobCount };
}

/**
 * Greenhouse: GET https://boards-api.greenhouse.io/v1/boards/{uid}/jobs?content=true
 * Replicates the exact production endpoint from greenhouseWorker.js line 404.
 */
async function sampleGreenhouse(company, outputDir) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.uid}/jobs?content=true`;

  const response = await axios.get(url, {
    timeout: HTTP_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  const jobs = response.data?.jobs || (Array.isArray(response.data) ? response.data : []);

  const outPath = path.join(outputDir, `${safeName(company.id)}.json`);
  const envelope = {
    _meta: {
      source: 'greenhouse',
      companyId: company.id,
      companyName: company.name,
      uid: company.uid,
      endpoint: url,
      httpStatus: response.status,
      sampledAt: new Date().toISOString(),
      jobCount: jobs.length,
    },
    raw: response.data,
  };

  fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2), 'utf-8');
  return { status: response.status, jobCount: jobs.length };
}

/**
 * Workday: Session-based flow replicating workdayWorker.js exactly.
 *
 * Step 1: Parse URL to extract tenant, instance, site
 * Step 2: GET {siteUrl} to establish PLAY_SESSION / wday_vps cookies
 * Step 3: POST {apiEndpoint} with { appliedFacets: {}, limit: 20, offset: 0, searchText: '' }
 *         to capture the full first-page response including facets metadata.
 */
async function sampleWorkday(company, outputDir) {
  const regex = /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?\/([^/?#]+)/i;
  const match = company.url.match(regex);
  if (!match) {
    throw new Error(`Unable to parse Workday URL: ${company.url}`);
  }

  const tenant = match[1];
  const instance = match[2];
  const site = match[3];
  const baseUrl = `https://${tenant}.${instance}.myworkdayjobs.com`;
  const siteUrl = `${baseUrl}/${site}`;
  const apiEndpoint = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`;

  // Step 1: Establish session cookies (replicate initSession from workdayWorker.js:222)
  const cookieJar = new CookieJar();
  const client = wrapper(axios.create({
    jar: cookieJar,
    withCredentials: true,
    timeout: 30000,
    headers: {
      ...WORKDAY_BROWSER_HEADERS,
      'Origin': baseUrl,
      'Referer': siteUrl,
    },
  }));

  const sessionResponse = await client.get(siteUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
    validateStatus: () => true,
  });

  // Wait for Akamai sensors to settle (same 2s as production)
  await delay(2000);

  const cookies = await cookieJar.getCookies(baseUrl);
  const cookieNames = cookies.map(c => c.key);

  // Step 2: Fetch first page of jobs with empty filters (captures full facets + job schema)
  const payload = {
    appliedFacets: {},
    limit: 20,
    offset: 0,
    searchText: '',
  };

  const jobsResponse = await client.post(apiEndpoint, payload, {
    validateStatus: () => true,
  });

  const jobPostings = jobsResponse.data?.jobPostings || jobsResponse.data?.jobs || [];

  const outPath = path.join(outputDir, `${safeName(company.id)}.json`);
  const envelope = {
    _meta: {
      source: 'workday',
      companyId: company.id,
      companyName: company.name,
      originalUrl: company.url,
      parsedTenant: tenant,
      parsedInstance: instance,
      parsedSite: site,
      siteUrl,
      apiEndpoint,
      sessionInitStatus: sessionResponse.status,
      cookiesEstablished: cookieNames,
      jobsApiStatus: jobsResponse.status,
      sampledAt: new Date().toISOString(),
      totalReported: jobsResponse.data?.total || null,
      jobCountThisPage: jobPostings.length,
      facetCount: (jobsResponse.data?.facets || []).length,
      requestPayload: payload,
    },
    raw: jobsResponse.data,
  };

  fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2), 'utf-8');
  return {
    sessionStatus: sessionResponse.status,
    apiStatus: jobsResponse.status,
    cookies: cookieNames,
    totalJobs: jobsResponse.data?.total || null,
    pageJobs: jobPostings.length,
    facets: (jobsResponse.data?.facets || []).length,
  };
}

// ---------------------------------------------------------------------------
// Batch Runner
// ---------------------------------------------------------------------------

async function runBatch(atsName, companies, limit, samplerFn) {
  const sample = selectSample(companies, limit);
  const outputDir = path.join(OUTPUT_ROOT, atsName);
  ensureDir(outputDir);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${atsName.toUpperCase()} — Sampling ${sample.length} of ${companies.length} companies`);
  console.log(`  Output: ${path.relative(PROJECT_ROOT, outputDir)}/`);
  console.log('='.repeat(60));

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < sample.length; i++) {
    const company = sample[i];
    const label = company.name || company.id;

    try {
      const result = await samplerFn(company, outputDir);
      succeeded++;

      if (atsName === 'workday') {
        console.log(
          `  [${i + 1}/${sample.length}] ${label} — ` +
          `session: ${result.sessionStatus}, api: ${result.apiStatus}, ` +
          `total: ${result.totalJobs ?? '?'}, page: ${result.pageJobs}, ` +
          `facets: ${result.facets}, cookies: [${result.cookies.join(', ')}]`
        );
      } else {
        console.log(
          `  [${i + 1}/${sample.length}] ${label} — ` +
          `HTTP ${result.status}, ${result.jobCount ?? '?'} jobs`
        );
      }
    } catch (err) {
      failed++;
      const code = err.response?.status || err.code || '';
      console.error(
        `  [${i + 1}/${sample.length}] ${label} — FAILED: ${code} ${err.message}`
      );
    }

    if (i < sample.length - 1) {
      await delay(INTER_REQUEST_DELAY_MS);
    }
  }

  console.log(`  Result: ${succeeded} succeeded, ${failed} failed\n`);
  return { succeeded, failed, total: sample.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log('');
  console.log('  RAW ATS DATA SAMPLER');
  console.log('  ====================');
  console.log(`  Sample size per ATS: ${opts.limit}`);
  if (opts.only) console.log(`  Filtering to: ${opts.only}`);
  console.log(`  Output root: ${path.relative(PROJECT_ROOT, OUTPUT_ROOT)}/`);
  console.log(`  Timestamp: ${new Date().toISOString()}`);

  ensureDir(OUTPUT_ROOT);

  const results = {};

  // --- Comeet ---
  if (!opts.only || opts.only === 'comeet') {
    const comeetCompanies = loadComeetCompanies();
    if (comeetCompanies.length === 0) {
      console.log('\n  [SKIP] No Comeet companies available (missing token data)');
    } else {
      results.comeet = await runBatch('comeet', comeetCompanies, opts.limit, sampleComeet);
    }
  }

  // --- Greenhouse ---
  if (!opts.only || opts.only === 'greenhouse') {
    const greenhouseCompanies = loadGreenhouseCompanies();
    if (greenhouseCompanies.length === 0) {
      console.log('\n  [SKIP] No Greenhouse companies available');
    } else {
      results.greenhouse = await runBatch('greenhouse', greenhouseCompanies, opts.limit, sampleGreenhouse);
    }
  }

  // --- Workday ---
  if (!opts.only || opts.only === 'workday') {
    const workdayCompanies = loadWorkdayCompanies();
    if (workdayCompanies.length === 0) {
      console.log('\n  [SKIP] No Workday companies available');
    } else {
      results.workday = await runBatch('workday', workdayCompanies, opts.limit, sampleWorkday);
    }
  }

  // --- Summary ---
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('='.repeat(60));
  console.log('  SAMPLING COMPLETE');
  console.log('='.repeat(60));
  for (const [ats, r] of Object.entries(results)) {
    console.log(`  ${ats.padEnd(12)} ${r.succeeded}/${r.total} succeeded`);
  }
  console.log(`  Duration: ${elapsed}s`);
  console.log(`  Files written to: ${path.relative(PROJECT_ROOT, OUTPUT_ROOT)}/`);
  console.log('');

  // Write a manifest file for easy downstream consumption
  const manifest = {
    sampledAt: new Date().toISOString(),
    durationSeconds: parseFloat(elapsed),
    sampleSizePerAts: opts.limit,
    results,
    files: {},
  };

  for (const atsName of ['comeet', 'greenhouse', 'workday']) {
    const dir = path.join(OUTPUT_ROOT, atsName);
    if (fs.existsSync(dir)) {
      manifest.files[atsName] = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_ROOT, '_manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  console.log(`  Manifest: ${path.relative(PROJECT_ROOT, path.join(OUTPUT_ROOT, '_manifest.json'))}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exitCode = 1;
});
