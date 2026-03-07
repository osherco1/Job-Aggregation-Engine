/**
 * Perplexity LLM Client — Two-Stage Pipeline
 * 
 * Stage 1 (Discovery): sonar-deep-research — raw Markdown, no JSON schema
 * Stage 2 (Parsing):   sonar-pro — strict JSON schema enforcement
 *
 * Requires env: PERPLEXITY_API_KEY
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

// Stage 1: Deep research (2-5 min agentic search, raw Markdown output)
const DISCOVERY_MODEL = 'sonar-deep-research';
const DISCOVERY_TIMEOUT_MS = 600000; // 10 minutes

// Stage 2: Fast structured parsing (JSON schema enforced)
const PARSER_MODEL = 'sonar-pro';
const PARSER_TIMEOUT_MS = 60000; // 1 minute

const RETRY_DELAY_MS = 10000;
const MAX_RETRIES = 1;

/**
 * Strict JSON Schema for Stage 2 parsing.
 * Enforced at the Perplexity decoding level.
 */
const RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'ats_discovery_result',
        schema: {
            type: 'object',
            properties: {
                companies: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            company_name: { type: 'string' },
                            careers_page_url: { type: 'string' },
                            evidence: { type: 'string' },
                            confidence: { type: 'string', enum: ['verified', 'likely', 'unconfirmed'] },
                        },
                        required: ['company_name', 'careers_page_url', 'evidence', 'confidence'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['companies'],
            additionalProperties: false,
        },
    },
};

// ---------------------------------------------------------------------------
// Internal: shared request helper with retries
// ---------------------------------------------------------------------------

/**
 * @param {import('axios').AxiosInstance} client
 * @param {Object} payload
 * @returns {Promise<string>} assistant message content
 */
async function _requestWithRetries(client, payload) {
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 0) {
                console.log(`  ⏳ Retrying Perplexity request (attempt ${attempt + 1})...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }

            const response = await client.post('', payload);

            if (
                response.data &&
                response.data.choices &&
                response.data.choices.length > 0 &&
                response.data.choices[0].message
            ) {
                return response.data.choices[0].message.content;
            }

            throw new Error('Unexpected Perplexity response structure: missing choices[0].message.content');
        } catch (err) {
            lastError = err;

            // Don't retry on auth errors
            if (err.response && (err.response.status === 401 || err.response.status === 403)) {
                throw new Error(`Perplexity auth error (${err.response.status}): Check PERPLEXITY_API_KEY`);
            }

            // Don't retry on bad request
            if (err.response && err.response.status === 400) {
                const detail = err.response.data?.error?.message || err.response.statusText || 'Bad Request';
                throw new Error(`Perplexity bad request (400): ${detail}`);
            }

            if (attempt < MAX_RETRIES) {
                console.warn(`  ⚠  Perplexity request failed: ${err.message}. Will retry...`);
                continue;
            }
        }
    }

    throw lastError || new Error('Perplexity request failed after retries');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a two-stage Perplexity pipeline client.
 * @returns {{ discoverCompaniesRaw, parseCompaniesJson, discoveryModel, parserModel }}
 */
function createPerplexityClient() {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
        throw new Error('PERPLEXITY_API_KEY environment variable is required');
    }

    const authHeaders = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    // Stage 1 client (long timeout)
    const discoveryClient = axios.create({
        baseURL: PERPLEXITY_API_URL,
        timeout: DISCOVERY_TIMEOUT_MS,
        headers: authHeaders,
    });

    // Stage 2 client (short timeout)
    const parserClient = axios.create({
        baseURL: PERPLEXITY_API_URL,
        timeout: PARSER_TIMEOUT_MS,
        headers: authHeaders,
    });

    /**
     * Stage 1: Deep research discovery.
     * Uses sonar-deep-research with high search context. No JSON schema.
     * Returns raw Markdown text with the LLM's full research output.
     *
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @returns {Promise<string>} Raw Markdown research output
     */
    async function discoverCompaniesRaw(systemPrompt, userPrompt) {
        const payload = {
            model: DISCOVERY_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.2,
            max_tokens: 4096,
            web_search_options: {
                search_context_size: 'high',
            },
            reasoning_effort: 'high',
            // NO response_format — let the model output freely
        };

        return _requestWithRetries(discoveryClient, payload);
    }

    /**
     * Stage 2: Structured JSON parsing.
     * Uses sonar-pro with strict JSON schema to parse raw Markdown into structured data.
     *
     * @param {string} rawMarkdown - The raw Markdown output from Stage 1
     * @returns {Promise<Object>} Parsed JSON object matching RESPONSE_FORMAT schema
     */
    async function parseCompaniesJson(rawMarkdown) {
        const payload = {
            model: PARSER_MODEL,
            messages: [
                {
                    role: 'system',
                    content: 'You are a data parser. Extract company information from the research report below into the required JSON schema. Preserve ALL companies mentioned. For each company, extract the company_name, careers_page_url (the most specific careers/jobs URL found), evidence (brief note about the source), and confidence level. CRITICAL: For the careers_page_url, you MUST extract the actual ATS job board URL (e.g., matching myworkdayjobs.com or boards.greenhouse.io or comeet.com/jobs) from the text, NOT the generic company homepage.',
                },
                {
                    role: 'user',
                    content: `Parse the following research report into the JSON schema. Extract every company mentioned with its careers page URL.\n\n---\n${rawMarkdown}\n---`,
                },
            ],
            temperature: 0,       // Deterministic parsing
            max_tokens: 4096,
            response_format: RESPONSE_FORMAT,
        };

        const raw = await _requestWithRetries(parserClient, payload);
        return JSON.parse(raw);
    }

    return {
        discoverCompaniesRaw,
        parseCompaniesJson,
        discoveryModel: DISCOVERY_MODEL,
        parserModel: PARSER_MODEL,
        // Legacy compat — expose model string for logging
        model: `${DISCOVERY_MODEL} → ${PARSER_MODEL}`,
    };
}

module.exports = { createPerplexityClient };
