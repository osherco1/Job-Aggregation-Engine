/**
 * Discovery Pipeline — Prompt Templates (Sonar Architecture)
 * 
 * Builds system and user prompts for each ATS type.
 * Uses the Perplexity Sonar-optimized prompt architecture from:
 *   docs/Sonar Discovery Pipeline Prompts.md
 *
 * The LLM returns a simplified schema (company_name, careers_page_url,
 * evidence, confidence). ATS identifiers and tokens are extracted
 * deterministically by the static extractor module, NOT by the LLM.
 */

// ---------------------------------------------------------------------------
// System Prompt — Sonar-optimized with role anchoring
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an Israeli tech industry analyst specializing in recruitment technology infrastructure. Your task is to discover tech companies that have R&D or engineering centers in Israel and use a specific Applicant Tracking System. You MUST return ONLY raw JSON matching the enforced schema. Every company you return should be a real, operating company based on your web search results. For each company, provide the company name and a direct link to their careers or job board page. You do NOT need to extract API tokens, identifiers, or construct API URLs — just find the companies and their careers pages.`;

// ---------------------------------------------------------------------------
// ATS-Specific Hints (URL patterns for identification only)
// ---------------------------------------------------------------------------

const ATS_CONFIGS = {
    comeet: {
        label: 'Comeet',
        hints: `Look for companies whose careers pages are hosted on comeet.com or comeet.co domains,
or whose job boards embed widgets from comeet.co.
Careers pages are typically at: https://www.comeet.com/jobs/{company-slug}/{uid}
The company may also embed a Comeet widget on their own website.`,
    },

    greenhouse: {
        label: 'Greenhouse',
        hints: `Look for companies whose careers pages redirect to or embed boards.greenhouse.io.
Hosted career pages are at: https://boards.greenhouse.io/{board_token}
The board_token is a URL-friendly slug (e.g., "monday", "wix").
Companies may also embed Greenhouse job listings on their own website.`,
    },

    workday: {
        label: 'Workday',
        hints: `Look for companies whose job listings are hosted on myworkdayjobs.com domains.
Career sites follow: https://{company}.wd{N}.myworkdayjobs.com/{path}/
where {N} is a datacenter number (1, 2, 3, or 5).
The path is usually "en-US/External" or a company-specific path.`,
    },
};

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for a specific ATS type.
 * Follows the Sonar-optimized template with KNOWN COMPANIES, DISCOVERY
 * INSTRUCTIONS, ATS IDENTIFICATION HINTS, and CONFIDENCE LEVELS sections.
 *
 * @param {string} atsType - 'comeet' | 'greenhouse' | 'workday'
 * @param {Array<string>} existingCompanyNames - Company names to exclude (flat array)
 * @returns {string}
 */
function buildUserPrompt(atsType, existingCompanyNames) {
    const config = ATS_CONFIGS[atsType];
    if (!config) {
        throw new Error(`Unknown ATS type: ${atsType}`);
    }

    const exclusionJson = JSON.stringify(existingCompanyNames);

    return `Search for tech companies that have R&D or engineering operations in Israel and use ${config.label} as their Applicant Tracking System.

KNOWN COMPANIES (Do not include these in your output):
${exclusionJson}

DISCOVERY INSTRUCTIONS:
- Search for Israeli tech companies whose careers pages or job boards are powered by ${config.label}.
- Each company should have an engineering or R&D presence in Israel (office, team, or hiring for Israel-based roles).
- Aim for high-confidence candidate companies.
- You MUST find and return exactly 15 NEW companies. Do not stop searching until you have 15.
- For each company, provide the direct careers page URL and a brief note about what evidence you found.
- Return the results as a detailed Markdown list.

ATS IDENTIFICATION HINTS:
${config.hints}

CONFIDENCE LEVELS:
- "verified": You found direct evidence in search results that the company uses ${config.label} and has Israel R&D.
- "likely": Strong indirect evidence (e.g., job posting URL patterns match ${config.label} format, Israel office mentioned).
- "unconfirmed": The company appears in ${config.label}-related contexts but full verification was not possible.`;
}

/**
 * Get the system prompt.
 * @returns {string}
 */
function getSystemPrompt() {
    return SYSTEM_PROMPT;
}

/**
 * Get ATS config for a specific type.
 * @param {string} atsType
 * @returns {Object|null}
 */
function getAtsConfig(atsType) {
    return ATS_CONFIGS[atsType] || null;
}

/**
 * Get all supported ATS types.
 * @returns {string[]}
 */
function getAtsTypes() {
    return Object.keys(ATS_CONFIGS);
}

module.exports = {
    buildUserPrompt,
    getSystemPrompt,
    getAtsConfig,
    getAtsTypes,
};
