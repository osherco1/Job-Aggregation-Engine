/**
 * Discovery Pipeline — Static URL Extractor
 * 
 * Deterministic regex-based extraction of ATS identifiers from careers page URLs.
 * Replaces the LLM's former role in producing ats_identifier / ats_api_url.
 *
 * Usage:
 *   const { classifyAndExtract } = require('./extractor');
 *   const result = classifyAndExtract('https://boards.greenhouse.io/monday');
 *   // => { atsType: 'greenhouse', extracted: { uid: 'monday' } }
 */

// ---------------------------------------------------------------------------
// Regex Patterns
// ---------------------------------------------------------------------------

// Greenhouse: boards.greenhouse.io/{board_token} or boards-api URL
const GH_BOARD_RE = /boards\.greenhouse\.io\/([a-z0-9_-]+)/i;
const GH_API_RE = /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i;

// Workday: {tenant}.{wdN}.myworkdayjobs.com (forgiving — path not required)
const WD_URL_RE = /([a-zA-Z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com/i;

// Comeet: comeet.com/jobs/... or comeet.co/...
const COMEET_JOBS_RE = /comeet\.com\/jobs\//i;
const COMEET_CO_RE = /comeet\.co\//i;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a careers page URL and extract ATS-specific identifiers.
 *
 * @param {string} url - The raw careers_page_url from the LLM
 * @returns {{ atsType: string|null, extracted: Object|null }}
 *   - greenhouse => { uid: 'board_token' }
 *   - workday    => { url: 'https://tenant.wdN.myworkdayjobs.com/site' }
 *   - comeet     => { careersUrl: url }  (no token/uid extraction possible)
 *   - null       => unrecognised URL
 */
function classifyAndExtract(url) {
    if (!url || typeof url !== 'string') {
        return { atsType: null, extracted: null };
    }

    const trimmed = url.trim();

    // --- Greenhouse ---
    const ghBoard = trimmed.match(GH_BOARD_RE);
    if (ghBoard) {
        return { atsType: 'greenhouse', extracted: { uid: ghBoard[1].toLowerCase() } };
    }
    const ghApi = trimmed.match(GH_API_RE);
    if (ghApi) {
        return { atsType: 'greenhouse', extracted: { uid: ghApi[1].toLowerCase() } };
    }

    // --- Workday ---
    const wd = trimmed.match(WD_URL_RE);
    if (wd) {
        // Pass through the original URL — Workday requires the full tenant path
        return { atsType: 'workday', extracted: { url: trimmed } };
    }

    // --- Comeet ---
    if (COMEET_JOBS_RE.test(trimmed) || COMEET_CO_RE.test(trimmed)) {
        return { atsType: 'comeet', extracted: { careersUrl: trimmed } };
    }

    // --- Unknown ---
    return { atsType: null, extracted: null };
}

module.exports = { classifyAndExtract };
