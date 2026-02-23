const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { sendCriticalAlert } = require('./mailer');

/**
 * Custom error class for LinkedIn authentication challenges
 * Replaces process.exit(1) to allow graceful shutdown
 */
class LinkedInAuthChallengeError extends Error {
  constructor(details) {
    super('CRITICAL_AUTH_CHALLENGE');
    this.name = 'LinkedInAuthChallengeError';
    this.details = details;
  }
}

// Single canonical User-Agent used for all LinkedIn requests.
const DEFAULT_USER_AGENT =
  process.env.LINKEDIN_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Build headers required by the LinkedIn Voyager API using secrets from process.env.
 * Expects the following environment variables to be set:
 *   - LINKEDIN_LI_AT
 *   - LINKEDIN_JSESSIONID
 *   - LINKEDIN_CSRF_TOKEN
 */
function getHeaders() {
  const {
    LINKEDIN_LI_AT,
    LINKEDIN_JSESSIONID,
    LINKEDIN_CSRF_TOKEN,
    LINKEDIN_ACCEPT_LANGUAGE,
  } = process.env;

  if (!LINKEDIN_LI_AT || !LINKEDIN_JSESSIONID || !LINKEDIN_CSRF_TOKEN) {
    throw new Error(
      'Missing LinkedIn auth config: please set LINKEDIN_LI_AT, LINKEDIN_JSESSIONID, and LINKEDIN_CSRF_TOKEN in your .env file.'
    );
  }

  // Ensure JSESSIONID cookie and Csrf-Token header are aligned. LinkedIn uses the
  // same opaque token value for both; a mismatch is a strong signal of bad copy/paste
  // from DevTools and tends to trigger security challenges.
  const normalizeToken = (value) =>
    String(value || '')
      .replace(/^"|"$/g, '')
      .trim();

  const normalizedCsrf = normalizeToken(LINKEDIN_CSRF_TOKEN);
  const normalizedJsession = normalizeToken(LINKEDIN_JSESSIONID);

  if (normalizedCsrf && normalizedJsession && normalizedCsrf !== normalizedJsession) {
    throw new Error(
      'LinkedIn auth mismatch: LINKEDIN_JSESSIONID does not match LINKEDIN_CSRF_TOKEN. ' +
      'Please copy both values from the same authenticated browser session.'
    );
  }

  const cookie = `li_at=${LINKEDIN_LI_AT}; JSESSIONID="${normalizedJsession}"`;

  return {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json',
    'Accept-Language': LINKEDIN_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
    'Csrf-Token': LINKEDIN_CSRF_TOKEN,
    Cookie: cookie,
    'X-RestLi-Protocol-Version': '2.0.0',
  };
}

// Base URL and endpoint for LinkedIn Voyager jobs API.
// NOTE: JOBS_ENDPOINT has been aligned with a working browser request (voyagerJobsDashJobCards).
const BASE_URL = 'https://www.linkedin.com';
const JOBS_ENDPOINT = '/voyager/api/voyagerJobsDashJobCards';
const JOB_POSTING_DECORATION_ID =
  'com.linkedin.voyager.dash.deco.jobs.jobPosting.FullJobPosting-100';
const JOB_POSTING_GRAPHQL_QUERY_ID =
  'voyagerJobsDashJobPostings.891aed7916d7453a37e4bbf5f1f60de4';

// Centralized directory for LinkedIn debug artifacts.
const DEBUG_DIR = path.join(__dirname, 'debug_artifacts');

function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (e) {
    console.error(`Failed to ensure directory ${dirPath}:`, e.message || e);
  }
}

// Centralized Axios client for all LinkedIn traffic with redirects hard-disabled.
const axiosClient = axios.create({
  // Never follow redirects – 302/303 almost always indicate an auth challenge or
  // login redirect, and following them looks extremely bot-like.
  maxRedirects: 0,
});

// Global interceptor: treat any 302/303 seen from LinkedIn as an immediate
// critical auth failure. This is our last line of defence against running the
// bot while under a challenge / captcha wall.
axiosClient.interceptors.response.use(
  (response) => {
    if (response && (response.status === 302 || response.status === 303)) {
      console.error(
        'CRITICAL: LinkedIn Auth Challenge Detected (302). Stopping immediately.'
      );
      try {
        // Fire-and-forget alert email
        sendCriticalAlert({
          status: response.status,
          url: response.config && response.config.url,
          timestamp: new Date().toISOString(),
          source: 'response',
        });
      } catch (e) {
        console.error(
          'sendCriticalAlert failed while handling LinkedIn auth challenge:',
          e.message || e
        );
      }
      // Throw error instead of process.exit(1) to allow graceful shutdown
      return Promise.reject(new LinkedInAuthChallengeError({
        status: response.status,
        url: response.config && response.config.url,
        timestamp: new Date().toISOString(),
        source: 'response',
      }));
    }
    return response;
  },
  (error) => {
    const status = error && error.response ? error.response.status : null;
    if (status === 302 || status === 303) {
      console.error(
        'CRITICAL: LinkedIn Auth Challenge Detected (302). Stopping immediately.'
      );
      try {
        // Fire-and-forget alert email
        sendCriticalAlert({
          status,
          url: error.config && error.config.url,
          timestamp: new Date().toISOString(),
          source: 'error',
        });
      } catch (e) {
        console.error(
          'sendCriticalAlert failed while handling LinkedIn auth challenge:',
          e.message || e
        );
      }
      // Throw error instead of process.exit(1) to allow graceful shutdown
      return Promise.reject(new LinkedInAuthChallengeError({
        status,
        url: error.config && error.config.url,
        timestamp: new Date().toISOString(),
        source: 'error',
      }));
    }
    return Promise.reject(error);
  }
);

// Simple randomized sleep helper for future direct client-side throttling if needed.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract a numeric job id from a URN or id string, e.g. "urn:li:fs_normalized_jobPosting:(urn:li:jobPosting:123456789)"
 */
function extractJobId(value) {
  if (!value || typeof value !== 'string') return null;
  // Robust numeric extraction: take the first sequence of digits from the URN,
  // which works for patterns like "urn:li:fsd_jobPosting:123", "(123,JOBS_SEARCH)", etc.
  const match = value.match(/(\d+)/);
  return match ? match[0] : null;
}

/**
 * Normalize the raw Voyager jobs API response into a flat array of job objects.
 * Handles both shapes:
 *  - { elements: [...] }
 *  - { data: { elements: [...], paging: {...}, included: [...] } }
 *
 * Uses `elements[].jobCardUnion.*jobPostingCard` references to objects in the
 * `included` array where the actual job card data lives.
 *
 * Each job object has: { jobId, title, company, location, postedAt, url }.
 */
function normalizeResponse(data, included = []) {
  const root = data || {};
  const envelope =
    root && root.data && typeof root.data === 'object'
      ? root.data
      : root;

  const elements = Array.isArray(envelope.elements) ? envelope.elements : [];
  const includedArray = Array.isArray(included) ? included : [];

  // 1. Build Map from entityUrn -> included item
  const includedMap = {};
  includedArray.forEach((item) => {
    if (
      item &&
      typeof item === 'object' &&
      typeof item.entityUrn === 'string'
    ) {
      includedMap[item.entityUrn] = item;
    }
  });

  const mapKeys = Object.keys(includedMap);

  if (!elements.length) {
    if (!Array.isArray(envelope.elements)) {
      console.warn(
        'normalizeResponse: unexpected LinkedIn response shape (no `elements` array on root or data).'
      );
    } else {
      console.log('normalizeResponse: elements array present but empty.');
    }
  }

  // 2. Map Elements -> flat job objects
  const mapped = elements
    .map((element, index) => {
      if (!element || !element.jobCardUnion) {
        return null;
      }

      const union = element.jobCardUnion;

      // Primary reference URN
      let refUrn =
        union['*jobPostingCard'] || union.jobPostingCard?.entityUrn || null;

      // Try exact match in includedMap
      let jobData =
        refUrn && Object.prototype.hasOwnProperty.call(includedMap, refUrn)
          ? includedMap[refUrn]
          : null;

      // If exact match fails, attempt soft numeric ID matching.
      if (!jobData && refUrn) {
        const numericId = extractJobId(refUrn);

        if (numericId) {
          const softKey = mapKeys.find((k) => k.includes(numericId));
          if (softKey) {
            jobData = includedMap[softKey];
          }
        }
      }

      if (!jobData) {
        // Without a resolved jobData object we cannot safely extract fields.
        console.warn(`⚠️ Failed to resolve jobData for URN: ${refUrn}`);
        return null;
      }

      // 1. Extract Job ID (prioritize jobPostingUrn, fallback to entityUrn/refUrn)
      const jobIdSource =
        jobData.jobPostingUrn || jobData.entityUrn || refUrn;
      const jobId = extractJobId(jobIdSource);

      // 2. Extract Title (nested text first, then flat field)
      const title = jobData.title?.text || jobData.jobPostingTitle || null;

      // 3. Extract Company & Location (allow nulls, downstream can handle)
      const company = jobData.primaryDescription?.text || null;
      const location = jobData.secondaryDescription?.text || null;

      // 4. Extract Date
      let postedAt = null;
      if (Array.isArray(jobData.footerItems)) {
        const dateItem = jobData.footerItems.find(
          (item) => item && item.type === 'LISTED_DATE'
        );
        if (dateItem && dateItem.timeAt) {
          try {
            postedAt = new Date(dateItem.timeAt).toISOString();
          } catch {
            postedAt = null;
          }
        }
      }

      // 5. Validation – require jobId and title only
      if (!jobId || !title) {
        console.warn(
          `⚠️ Dropping job. Missing fields -> JobID: ${jobId}, Title: ${title ? 'OK' : 'MISSING'
          }, URN: ${refUrn}`
        );
        return null;
      }

      return {
        jobId,
        title,
        company,
        location,
        postedAt, // ISO string or null
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        applyMethod: 'Easy Apply', // placeholder; actual enrichment happens later
      };
    })
    .filter(Boolean);

  console.log(
    `normalizeResponse: parsed ${mapped.length} jobs from LinkedIn response`
  );
  return mapped;
}

/**
 * Fetch jobs from LinkedIn Voyager API using the voyagerJobsDashJobCards endpoint.
 * Uses a strict, manually-encoded "golden" URL template captured from a working browser request.
 * @param {string} keywords - Search keywords (e.g. 'Java' or complex boolean string).
 * @param {number} start - Pagination offset (multiples of 25).
 */
async function fetchJobs(keywords, start = 0) {
  const count = 25;
  const headers = getHeaders();

  // 1. Force Encoding: Node's encodeURIComponent misses parentheses, causing
  // 400 errors on Voyager. We manually patch the encoded string for safety.
  const keywordString =
    typeof keywords === 'string' ? keywords : String(keywords || '');
  const encodedKeywords = encodeURIComponent(keywordString)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\+/g, '%20');

  // 2. Construct the "Golden Rule" query structure (raw structure + encoded keywords).
  // Note: timePostedRange:List(r604800) = Past Week.
  const queryValue =
    `(origin:JOB_SEARCH_PAGE_JOB_FILTER,` +
    `keywords:${encodedKeywords},` +
    `locationUnion:(geoId:101620260),` +
    `selectedFilters:(sortBy:List(DD),experience:List(1,2),timePostedRange:List(r604800)),` +
    `spellCorrectionEnabled:true)`;

  // 3. Build final URL manually – no axios params object to avoid re-encoding.
  const url =
    `${BASE_URL}${JOBS_ENDPOINT}` +
    `?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220` +
    `&count=${count}` +
    `&q=jobSearch` +
    `&query=${queryValue}` +
    `&start=${start}`;

  console.log('🚀 FORCED ENCODING URL:', url); // Keep for debugging

  try {
    // 4. Execute with the centralized safe client (handles redirects & headers).
    const response = await axiosClient.get(url, {
      headers: {
        ...headers,
        // Voyager prefers the normalized JSON media type.
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        // Ensure the Rest.li protocol header is always present.
        'x-restli-protocol-version': '2.0.0',
      },
    });

    const root = response.data || {};
    const envelope =
      root && root.data && typeof root.data === 'object'
        ? root.data
        : root;

    // Optional: persist raw response for debugging the JSON structure / parser.
    try {
      ensureDir(DEBUG_DIR);
      const debugPath = path.join(DEBUG_DIR, 'debug_linkedin_response.json');
      fs.writeFileSync(debugPath, JSON.stringify(root, null, 2), 'utf-8');
      console.log(`Saved raw response to ${debugPath}`);
    } catch (e) {
      console.error(
        'Failed to write debug_linkedin_response.json:',
        e.message || e
      );
    }

    const included =
      (envelope && Array.isArray(envelope.included)
        ? envelope.included
        : Array.isArray(root.included)
          ? root.included
          : []) || [];

    const jobs = normalizeResponse(root, included);
    const paging = envelope.paging || null;

    return { jobs, paging };
  } catch (error) {
    const status = error && error.response ? error.response.status : null;

    // 401 remains a CRITICAL_AUTH_FAIL so the caller can stop cleanly.
    if (status === 401) {
      console.error(
        `LinkedIn authentication failure detected (status ${status}).` +
        ' Please refresh LINKEDIN_LI_AT, LINKEDIN_JSESSIONID, and LINKEDIN_CSRF_TOKEN in your .env from an authenticated browser session.'
      );
      throw new Error('CRITICAL_AUTH_FAIL');
    }

    if (error.response) {
      if (status === 403) {
        console.error(
          `LinkedIn authentication failed with status ${status}. ` +
          'Please refresh LINKEDIN_LI_AT, LINKEDIN_JSESSIONID, and LINKEDIN_CSRF_TOKEN in your .env from an authenticated browser session.'
        );
      } else {
        console.error(
          `LinkedIn API request failed with status ${status}:`,
          error.response.data || error.message
        );
      }

      console.error(
        'API Error:',
        status,
        error.response.data || error.message
      );
    } else {
      console.error('LinkedIn API request failed:', error.message || error);
    }
    throw error;
  }
}

/**
 * Fetch full job details for a given jobId using the reverse-engineered Voyager GraphQL endpoint.
 * Uses queryId voyagerJobsDashJobPostings.* with a URL-encoded variables block:
 *   variables=(jobPostingUrn:urn:li:fsd_jobPosting:{jobId})
 *
 * Returns a normalized object containing:
 *  - description: from jobPosting.description.text
 *  - applyUrl: from jobPosting.companyApplyUrl
 *  - title: from jobPosting.title
 *  - skills: best-effort extraction if skills are present in the response
 *
 * NOTE: Callers are responsible for spacing out calls (e.g. 3–6s) to respect rate limits.
 * @param {string|number} jobId
 * @returns {Promise<{ description: string|null, applyUrl: string|null, title: string|null, skills: string[]|null }|null>}
 */
async function fetchJobDetails(jobId) {
  if (!jobId) {
    throw new Error('fetchJobDetails: jobId is required');
  }

  const headers = getHeaders();
  const idStr = String(jobId);
  const urn = `urn:li:fsd_jobPosting:${idStr}`;
  const encodedUrn = encodeURIComponent(urn);
  const url = `${BASE_URL}/voyager/api/graphql?variables=(jobPostingUrn:${encodedUrn})&queryId=${JOB_POSTING_GRAPHQL_QUERY_ID}`;

  console.log(`Fetching full job details for jobId=${idStr}`);
  console.log('🔗 Full Details URL:', url);

  try {
    const response = await axiosClient.get(url, {
      headers: {
        ...headers,
        'X-RestLi-Protocol-Version': '2.0.0',
      },
    });
    const outer = response.data || {};
    const root =
      outer && outer.data && typeof outer.data === 'object'
        ? outer.data.jobsDashJobPostingsById
        : outer.jobsDashJobPostingsById;

    // Persist raw details for debugging / schema exploration.
    try {
      ensureDir(DEBUG_DIR);
      const detailsPath = path.join(
        DEBUG_DIR,
        `debug_job_details_${idStr}.json`
      );
      fs.writeFileSync(detailsPath, JSON.stringify(outer, null, 2), 'utf-8');
      console.log(`Saved raw job details to ${detailsPath}`);
    } catch (e) {
      console.error(
        `Failed to write debug_job_details_${idStr}.json:`,
        e.message || e
      );
    }

    // 1. Validate root object presence
    if (!root || typeof root !== 'object') {
      console.error(
        `fetchJobDetails: jobsDashJobPostingsById not found for jobId=${jobId}`
      );
      return null;
    }

    // 2. Extract fields from jobsDashJobPostingsById
    let description =
      root.description && typeof root.description.text === 'string'
        ? root.description.text
        : null;
    if (description) {
      // Normalize newlines for readability
      description = description.replace(/\r\n/g, '\n').trim();
    }

    const companyApplyUrl = root.companyApplyUrl || null;

    const listedAt =
      root.originalListedAt != null
        ? root.originalListedAt
        : root.listedAt != null
          ? root.listedAt
          : null;

    const recruiterId = root.posterId || null;
    const recruiterName = null; // Placeholder – can be enriched later when poster data is available

    const skillsDescription =
      typeof root.skillsDescription === 'string'
        ? root.skillsDescription
        : null;

    // Basic repost detection: some Voyager shapes expose a boolean like
    // `repostedJob` either on the root, jobView, or nested jobPosting object.
    let isRepost = false;
    if (root && typeof root === 'object') {
      if (root.repostedJob === true) {
        isRepost = true;
      } else if (
        root.jobView &&
        typeof root.jobView === 'object' &&
        root.jobView.repostedJob === true
      ) {
        isRepost = true;
      } else if (
        root.jobPosting &&
        typeof root.jobPosting === 'object' &&
        root.jobPosting.repostedJob === true
      ) {
        isRepost = true;
      }
    }

    // Preserve compatibility with existing enrichment logic by returning a
    // slightly richer object while honoring the requested structure.
    const simpleApplication =
      root.simpleApplication === true || root.easyApply === true || false;

    return {
      description,
      // Keep `applyUrl` separate from the LinkedIn job URL so that the primary
      // link in reports remains the LinkedIn job page. Expose the external
      // company apply link via `directApplyUrl` instead.
      applyUrl: null,
      directApplyUrl: companyApplyUrl,
      companyApplyUrl,
      // Optional extras for downstream scoring/reporting.
      title: root.title || null,
      skills: null,
      skillsDescription,
      employmentType:
        root.employmentStatus && root.employmentStatus.localizedName
          ? root.employmentStatus.localizedName
          : null,
      listedAt,
      appliesCount:
        root.appliesCount ||
        root.numApplicants ||
        root.numApplied ||
        root.numSimpleApplications ||
        null,
      simpleApplication,
      applyMethodEasyApply: simpleApplication,
      workplaceTypes: null,
      recruiterUrl: null,
      recruiter: recruiterId
        ? { id: recruiterId, name: recruiterName }
        : null,
      recruiterName,
      recruiterId,
      isRepost,
    };
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 404) {
        console.warn(
          `LinkedIn JobPostings returned 404 for jobId=${jobId} (job may be expired or deleted); returning empty details.`
        );
        return {
          description: null,
          applyUrl: null,
          skills: null,
        };
      }
      if (status === 429) {
        console.error(
          `LinkedIn JobPostings returned 429 (rate limited) for jobId=${jobId}.`,
          error.response.data || error.message
        );
        // Let the caller decide how to back off / retry.
        throw new Error(
          `Rate limited (429) while fetching job details for jobId=${jobId}`
        );
      }

      console.error(
        `LinkedIn JobPostings request failed for jobId=${jobId} with status ${status}:`,
        error.response.data || error.message
      );
    } else {
      console.error(
        `LinkedIn JobPostings request failed for jobId=${jobId}:`,
        error.message || error
      );
    }
    throw error;
  }
}

module.exports = {
  getHeaders,
  fetchJobs,
  normalizeResponse,
  fetchJobDetails,
  LinkedInAuthChallengeError,
};


