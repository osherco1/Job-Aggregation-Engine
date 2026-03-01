/**
 * API Field Probe Script
 *
 * Standalone script that hits Comeet, Greenhouse, and Workday APIs directly
 * to verify the presence and values of structured "Missing Gold" fields.
 *
 * Outputs:
 *   .cursor/api_probe_results.md   — Human-readable Markdown report
 *   .cursor/api_probe_raw_dump.json — Full raw JSON for deep inspection
 *
 * Usage: node scripts/probe_api_fields.js
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TIMEOUT = 25000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const JOBS_TO_SAMPLE = 5;

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, '.cursor');
const MD_PATH = path.join(OUTPUT_DIR, 'api_probe_results.md');
const JSON_PATH = path.join(OUTPUT_DIR, 'api_probe_raw_dump.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function truncateHtml(str, max = 120) {
  if (!str || typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.substring(0, max) + '...[truncated]';
}

function stripHtmlForRaw(job) {
  if (!job || typeof job !== 'object') return job;
  const clone = { ...job };
  for (const key of Object.keys(clone)) {
    if (typeof clone[key] === 'string' && clone[key].length > 500 && /<[a-z][\s\S]*>/i.test(clone[key])) {
      clone[key] = clone[key].substring(0, 300) + '\n...[HTML truncated, ' + clone[key].length + ' chars total]';
    }
  }
  return clone;
}

// ============================================================================
// GREENHOUSE
// ============================================================================

const GREENHOUSE_COMPANIES = [
  { id: 'melio', name: 'Melio', uid: 'melio' },
  { id: 'riskified', name: 'Riskified', uid: 'riskified' },
  { id: 'snyk', name: 'Snyk', uid: 'snyk' },
];

async function probeGreenhouse(company) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.uid}/jobs?content=true`;
  try {
    const resp = await axios.get(url, { timeout: TIMEOUT });
    const jobs = resp.data?.jobs || (Array.isArray(resp.data) ? resp.data : []);
    const sample = jobs.slice(0, JOBS_TO_SAMPLE);

    return {
      source: 'greenhouse',
      company: company.name,
      totalJobs: jobs.length,
      status: 'OK',
      firstRawJob: jobs.length > 0 ? stripHtmlForRaw(jobs[0]) : null,
      sample: sample.map(j => ({
        title: j.title || '(none)',
        id: j.id,
        metadata: j.metadata,
        offices: j.offices ? j.offices.map(o => ({ id: o.id, name: o.name, location: o.location })) : null,
        internal_job_id: j.internal_job_id ?? '(absent)',
        requisition_id: j.requisition_id ?? '(absent)',
        language: j.language ?? '(absent)',
        departments: j.departments ? j.departments.map(d => ({ id: d.id, name: d.name })) : null,
        _allKeys: Object.keys(j).sort(),
      })),
    };
  } catch (err) {
    return { source: 'greenhouse', company: company.name, status: 'ERROR', error: err.response ? `HTTP ${err.response.status}` : err.message };
  }
}

// ============================================================================
// COMEET
// ============================================================================

async function loadComeetCompanies() {
  for (const relPath of ['data/comeet_companies_auto.json', 'data/companies_list.json']) {
    const p = path.join(PROJECT_ROOT, relPath);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const comeet = raw.filter(c => (c.type === 'comeet' || relPath.includes('comeet')) && c.token && c.uid);
      if (comeet.length > 0) return comeet.slice(0, 3);
    } catch (e) { /* ignore */ }
  }
  return [];
}

async function probeComeet(company) {
  const url = `https://www.comeet.co/careers-api/1.0/company/${company.uid}/positions?token=${company.token}`;
  try {
    const resp = await axios.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const jobs = Array.isArray(resp.data) ? resp.data : [];
    const sample = jobs.slice(0, JOBS_TO_SAMPLE);

    return {
      source: 'comeet',
      company: company.name || company.id,
      totalJobs: jobs.length,
      status: 'OK',
      firstRawJob: jobs.length > 0 ? stripHtmlForRaw(jobs[0]) : null,
      sample: sample.map(j => ({
        title: j.name || '(none)',
        uid: j.uid || j.position_uid || '(none)',
        experience_level: j.experience_level ?? '(absent)',
        employment_type: j.employment_type ?? '(absent)',
        workplace_type: j.workplace_type ?? '(absent)',
        categories: j.categories ?? '(absent)',
        details: j.details ? j.details.map(d => ({ name: d.name, hasValue: !!(d.value && d.value.length > 0) })) : '(absent)',
        department: j.department ?? '(absent)',
        location_is_remote: j.location_object?.is_remote ?? j.location?.is_remote ?? '(absent)',
        internal_use_custom_id: j.internal_use_custom_id ?? '(absent)',
        _allKeys: Object.keys(j).sort(),
      })),
    };
  } catch (err) {
    return { source: 'comeet', company: company.name || company.id, status: 'ERROR', error: err.response ? `HTTP ${err.response.status}` : err.message };
  }
}

// ============================================================================
// WORKDAY
// ============================================================================

const WORKDAY_COMPANIES = [
  { id: 'intel', name: 'Intel', url: 'https://intel.wd1.myworkdayjobs.com/External' },
  { id: 'nvidia', name: 'NVIDIA', url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' },
  { id: 'dell', name: 'Dell Technologies', url: 'https://dell.wd1.myworkdayjobs.com/External' },
];

function parseWorkdayUrl(url) {
  const m = url.match(/https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/wday\/cxs\/[^/]+)?\/([^/?#]+)/i);
  if (!m) throw new Error(`Cannot parse Workday URL: ${url}`);
  return { tenant: m[1], instance: m[2], site: m[3] };
}

async function probeWorkday(company) {
  const { tenant, instance, site } = parseWorkdayUrl(company.url);
  const baseUrl = `https://${tenant}.${instance}.myworkdayjobs.com`;
  const apiEndpoint = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`;

  try {
    const { CookieJar } = require('tough-cookie');
    const { wrapper } = require('axios-cookiejar-support');

    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true, timeout: TIMEOUT, headers: { 'User-Agent': UA } }));

    await client.get(`${baseUrl}/${site}`);
    await sleep(2000);

    const resp = await client.post(apiEndpoint, {
      appliedFacets: {},
      limit: JOBS_TO_SAMPLE,
      offset: 0,
      searchText: 'Israel',
    }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    });

    const data = resp.data || {};
    const jobs = data.jobPostings || data.jobs || [];
    const total = data.total || jobs.length;

    return {
      source: 'workday',
      company: company.name,
      totalJobs: total,
      status: 'OK',
      firstRawJob: jobs.length > 0 ? stripHtmlForRaw(jobs[0]) : null,
      sample: jobs.slice(0, JOBS_TO_SAMPLE).map(j => ({
        title: j.title || (j.bulletFields && j.bulletFields[0]) || '(none)',
        externalPath: j.externalPath || '(absent)',
        managementLevel: j.managementLevel ?? '(absent)',
        jobCategory: j.jobCategory ?? '(absent)',
        jobFamilyGroup: j.jobFamilyGroup ?? '(absent)',
        requisitionType: j.requisitionType ?? '(absent)',
        workerType: j.workerType ?? '(absent)',
        timeType: j.timeType ?? '(absent)',
        jobSchedule: j.jobSchedule ?? '(absent)',
        isRemote: j.isRemote ?? '(absent)',
        subtitleText: j.subtitleText ?? '(absent)',
        bulletFields: j.bulletFields || '(absent)',
        locationsText: j.locationsText ?? '(absent)',
        postedOn: j.postedOn ?? '(absent)',
        _allKeys: Object.keys(j).sort(),
      })),
    };
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}` : err.message;
    return { source: 'workday', company: company.name, status: 'ERROR', error: detail };
  }
}

// ============================================================================
// MARKDOWN REPORT BUILDER
// ============================================================================

function buildMarkdownReport(results) {
  const lines = [];
  const ts = new Date().toISOString();

  lines.push('# API Field Probe Results');
  lines.push('');
  lines.push(`> **Generated:** ${ts}  `);
  lines.push('> **Purpose:** Verify presence of structured "Missing Gold" fields across ATS tenants.  ');
  lines.push(`> **Sample size:** First ${JOBS_TO_SAMPLE} jobs per company.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- GREENHOUSE ---
  lines.push('## 1. Greenhouse');
  lines.push('');
  for (const r of results.greenhouse) {
    lines.push(`### ${r.company}`);
    lines.push('');
    if (r.status !== 'OK') {
      lines.push(`**Status:** ${r.status} — ${r.error}`);
      lines.push('');
      continue;
    }
    lines.push(`**Status:** OK | **Total jobs:** ${r.totalJobs}`);
    lines.push('');
    lines.push('#### Targeted Fields (first 5 jobs)');
    lines.push('');
    lines.push('| # | Title | Departments | Offices | metadata | requisition_id | internal_job_id |');
    lines.push('|---|-------|-------------|---------|----------|----------------|-----------------|');
    r.sample.forEach((j, i) => {
      const depts = j.departments ? j.departments.map(d => d.name).join(', ') : '(none)';
      const offices = j.offices ? j.offices.map(o => `${o.name} [${o.location || ''}]`).join('; ') : '(none)';
      const meta = j.metadata === null ? 'null' : j.metadata === undefined ? '(absent)' : JSON.stringify(j.metadata).substring(0, 60);
      lines.push(`| ${i + 1} | ${j.title} | ${depts} | ${offices} | ${meta} | ${j.requisition_id} | ${j.internal_job_id} |`);
    });
    lines.push('');
    lines.push(`**All keys on first job:** \`${r.sample[0]?._allKeys?.join(', ') || '(empty)'}\``);
    lines.push('');
    if (r.firstRawJob) {
      lines.push('<details><summary>Full raw job #1 (click to expand)</summary>');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(r.firstRawJob, null, 2));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }
  }

  // --- COMEET ---
  lines.push('---');
  lines.push('');
  lines.push('## 2. Comeet');
  lines.push('');
  for (const r of results.comeet) {
    lines.push(`### ${r.company}`);
    lines.push('');
    if (r.status !== 'OK') {
      lines.push(`**Status:** ${r.status} — ${r.error || 'N/A'}`);
      lines.push('');
      continue;
    }
    lines.push(`**Status:** OK | **Total jobs:** ${r.totalJobs}`);
    lines.push('');
    lines.push('#### Targeted Fields (first 5 jobs)');
    lines.push('');
    lines.push('| # | Title | experience_level | employment_type | workplace_type | department | categories | location.is_remote |');
    lines.push('|---|-------|------------------|-----------------|----------------|------------|------------|--------------------|');
    r.sample.forEach((j, i) => {
      const cats = (j.categories && j.categories !== '(absent)') ? j.categories.map(c => `${c.name}=${c.value}`).join('; ') : '(absent)';
      lines.push(`| ${i + 1} | ${j.title} | ${j.experience_level} | ${j.employment_type} | ${j.workplace_type} | ${j.department} | ${cats} | ${j.location_is_remote} |`);
    });
    lines.push('');
    lines.push(`**All keys on first job:** \`${r.sample[0]?._allKeys?.join(', ') || '(empty)'}\``);
    lines.push('');
    if (r.firstRawJob) {
      lines.push('<details><summary>Full raw job #1 (click to expand)</summary>');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(r.firstRawJob, null, 2));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }
  }

  // --- WORKDAY ---
  lines.push('---');
  lines.push('');
  lines.push('## 3. Workday');
  lines.push('');
  for (const r of results.workday) {
    lines.push(`### ${r.company}`);
    lines.push('');
    if (r.status !== 'OK') {
      lines.push(`**Status:** ${r.status} — ${r.error}`);
      lines.push('');
      continue;
    }
    lines.push(`**Status:** OK | **Total jobs:** ${r.totalJobs}`);
    lines.push('');
    lines.push('#### Targeted Fields (first 5 jobs)');
    lines.push('');
    lines.push('| # | Title | timeType | managementLevel | jobCategory | jobFamilyGroup | requisitionType | workerType | isRemote |');
    lines.push('|---|-------|----------|-----------------|-------------|----------------|-----------------|------------|----------|');
    r.sample.forEach((j, i) => {
      lines.push(`| ${i + 1} | ${j.title} | ${j.timeType} | ${j.managementLevel} | ${j.jobCategory} | ${j.jobFamilyGroup} | ${j.requisitionType} | ${j.workerType} | ${j.isRemote} |`);
    });
    lines.push('');
    lines.push('#### Additional context');
    lines.push('');
    lines.push('| # | bulletFields | subtitleText | locationsText | postedOn |');
    lines.push('|---|-------------|--------------|---------------|----------|');
    r.sample.forEach((j, i) => {
      const bf = Array.isArray(j.bulletFields) ? j.bulletFields.join(' | ') : j.bulletFields;
      lines.push(`| ${i + 1} | ${bf} | ${j.subtitleText} | ${j.locationsText} | ${j.postedOn} |`);
    });
    lines.push('');
    lines.push(`**All keys on first job:** \`${r.sample[0]?._allKeys?.join(', ') || '(empty)'}\``);
    lines.push('');
    if (r.firstRawJob) {
      lines.push('<details><summary>Full raw job #1 (click to expand)</summary>');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(r.firstRawJob, null, 2));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const log = (msg) => process.stdout.write(msg + '\n');

  log('API Field Probe — starting ' + new Date().toISOString());

  const results = { greenhouse: [], comeet: [], workday: [] };

  // Greenhouse
  log('[1/3] Greenhouse...');
  for (const company of GREENHOUSE_COMPANIES) {
    log(`  ${company.name}...`);
    results.greenhouse.push(await probeGreenhouse(company));
    await sleep(2000);
  }

  // Comeet
  log('[2/3] Comeet...');
  const comeetCompanies = await loadComeetCompanies();
  if (comeetCompanies.length === 0) {
    log('  SKIPPED — no local token data found');
    results.comeet.push({ source: 'comeet', company: '(unavailable)', status: 'SKIPPED', error: 'No comeet_companies_auto.json or companies_list.json with tokens' });
  } else {
    for (const company of comeetCompanies) {
      log(`  ${company.name || company.id}...`);
      results.comeet.push(await probeComeet(company));
      await sleep(3000);
    }
  }

  // Workday
  log('[3/3] Workday...');
  for (const company of WORKDAY_COMPANIES) {
    log(`  ${company.name}...`);
    results.workday.push(await probeWorkday(company));
    await sleep(3000);
  }

  // Write files
  ensureDir(OUTPUT_DIR);

  const md = buildMarkdownReport(results);
  fs.writeFileSync(MD_PATH, md, 'utf-8');
  log(`\nMarkdown report -> ${MD_PATH}`);

  fs.writeFileSync(JSON_PATH, JSON.stringify(results, null, 2), 'utf-8');
  log(`Raw JSON dump   -> ${JSON_PATH}`);

  log('Done.');
}

main().catch(err => {
  const msg = `Probe FATAL: ${err.message || err}`;
  process.stderr.write(msg + '\n');
  try {
    ensureDir(OUTPUT_DIR);
    fs.writeFileSync(MD_PATH, `# API Field Probe — FATAL ERROR\n\n\`\`\`\n${msg}\n\`\`\`\n`, 'utf-8');
  } catch (_) { /* best effort */ }
  process.exitCode = 1;
});
