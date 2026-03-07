# Optimal Prompt Architecture for a Perplexity Sonar Discovery Pipeline

## Executive Summary

This document provides the complete, production-ready prompt architecture for an autonomous Discovery Pipeline that queries the Perplexity `sonar` model to discover Israeli tech companies using Comeet, Greenhouse, or Workday as their ATS. The architecture leverages two complementary enforcement layers: the API-level `response_format` parameter with a JSON Schema for structural guarantees, and carefully engineered system/user prompts for semantic accuracy. All prompts are designed for direct injection into a Node.js `axios` call with `JSON.parse()` on the raw output.[^1][^2]

***

## Critical API-Level Configuration

Before examining the prompts, the single most impactful decision is to use the `response_format` parameter in the API request body. This is a native Perplexity feature that enforces JSON Schema compliance at the decoding level — the model is structurally incapable of outputting markdown fences, conversational filler, or malformed JSON when this is active.[^2][^1]

The `axios` request body should include:

```json
{
  "model": "sonar",
  "temperature": 0,
  "max_tokens": 4096,
  "messages": [ /* system + user messages */ ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "ats_discovery_result",
      "schema": {
        "type": "object",
        "properties": {
          "companies": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "company_name": { "type": "string" },
                "careers_page_url": { "type": "string" },
                "ats_api_url": { "type": "string" },
                "ats_identifier": { "type": "string" },
                "confidence": { "type": "string", "enum": ["verified", "likely", "unconfirmed"] }
              },
              "required": ["company_name", "careers_page_url", "ats_api_url", "ats_identifier", "confidence"],
              "additionalProperties": false
            }
          }
        },
        "required": ["companies"],
        "additionalProperties": false
      }
    }
  }
}
```

Key notes on this configuration:

- **`temperature: 0`** makes output deterministic, minimizing hallucinated company names or fabricated identifiers.[^3]
- **`additionalProperties: false`** at every object level prevents the model from injecting extra fields.[^4]
- The **`name` field** is required and must be 1–64 alphanumeric characters.[^2]
- The **first request** with a new JSON Schema may incur a 10–30 second delay as the schema is compiled; subsequent requests are fast.[^1]

***

## System Prompt (Exact Text)

```
You are an Israeli tech industry analyst specializing in recruitment technology infrastructure. Your task is to discover tech companies that have verified R&D or engineering centers in Israel and use a specific Applicant Tracking System. You MUST return ONLY raw JSON matching the enforced schema. Do not include any text outside the JSON object. Every company you return must be a real, currently operating company that you can verify through web search results. If you cannot verify a company uses the specified ATS with high confidence, do not include it. Never return a company from the exclusion list provided by the user.
```

### Why This Phrasing Works

- **Role anchoring** ("Israeli tech industry analyst specializing in recruitment technology infrastructure") primes the model's retrieval toward HR-tech and Israeli startup ecosystem sources rather than generic company databases.[^1]
- **"Verified R&D or engineering centers in Israel"** is intentionally specific — it steers web search queries toward careers pages and office listings, not just company HQs.
- **"MUST return ONLY raw JSON"** serves as a belt-and-suspenders safeguard alongside the `response_format` schema. Even though the schema enforces structure, the system prompt shapes the model's generation planning to avoid any preamble tokens.[^5][^6]
- **"Never return a company from the exclusion list"** establishes the deduplication contract at the instruction level.

***

## User Prompt Template (JavaScript Template Literal)

```javascript
const userPrompt = `Search for tech companies that have verified R&D or engineering operations in Israel and use ${ATS_NAME} as their Applicant Tracking System.

EXCLUSION LIST — do NOT return any of these companies under any circumstances:
${EXISTING_COMPANIES_JSON}

DISCOVERY INSTRUCTIONS:
- Search for Israeli tech companies whose careers pages or job boards are powered by ${ATS_NAME}.
- Each company MUST have a verified engineering or R&D presence in Israel (office, team, or hiring for Israel-based roles).
- Return between 5 and 15 NEW companies not in the exclusion list.
- For each company, provide the direct careers page URL and the ATS-specific API endpoint or identifier.

ATS-SPECIFIC CONFIGURATION:
${ATS_SCHEMA_AND_HINTS}

CONFIDENCE LEVELS:
- "verified": You found direct evidence in search results that the company uses ${ATS_NAME} and has Israel R&D.
- "likely": Strong indirect evidence (e.g., job posting URL patterns match ${ATS_NAME} format, Israel office mentioned).
- "unconfirmed": The company appears in ${ATS_NAME}-related contexts but full verification was not possible.

Return the JSON object now.`;
```

***

## ATS-Specific Hints Variable (`ATS_SCHEMA_AND_HINTS`)

This variable should be populated from a configuration map. Below are the exact hint strings for each ATS.

### Comeet

```javascript
const COMEET_HINTS = `For Comeet, the careers API endpoint follows this pattern:
- API URL: https://www.comeet.co/careers-api/2.0/company/{COMPANY_UID}/positions?token={API_TOKEN}
- The COMPANY_UID is a short hex-dot code (e.g., "A2.00C", "F4.123").
- The API_TOKEN is a 32-character hex string (e.g., "2ACD5C02AC10081008AB01560180C804").
- Set "ats_api_url" to the full API URL with both uid and token filled in.
- Set "ats_identifier" to the COMPANY_UID value only.
- Careers pages are typically at: https://www.comeet.com/jobs/{company-slug} or embedded on the company website.
- Look for companies whose job pages load widgets from comeet.co or comeet.com domains.`;
```

This is based on the confirmed Comeet Careers API v2.0 endpoint structure as observed in production usage, where the company UID (hex-dot format) and a 32-character hex token are both required query parameters.[^7][^8]

### Greenhouse

```javascript
const GREENHOUSE_HINTS = `For Greenhouse, the public Job Board API endpoint follows this pattern:
- API URL: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
- The board_token is a URL-friendly lowercase slug (e.g., "monday", "wix", "ironSource").
- Set "ats_api_url" to the full boards-api URL with the board_token filled in.
- Set "ats_identifier" to the board_token value only.
- Hosted career pages are at: https://boards.greenhouse.io/{board_token}
- Adding ?content=true to the API URL returns full job descriptions.
- Look for companies whose careers pages redirect to or embed boards.greenhouse.io.`;
```

The Greenhouse Job Board API is publicly documented and uses a simple `board_token` slug to identify each company's job board.[^9][^10]

### Workday

```javascript
const WORKDAY_HINTS = `For Workday, external career sites follow this URL pattern:
- Career site URL: https://{company_slug}.wd{N}.myworkdayjobs.com/{locale_or_path}/
- {company_slug} is typically the company name in lowercase (e.g., "monday", "checkpoint", "cellebrite").
- {N} is a Workday datacenter number, typically 1, 2, 3, or 5 (e.g., wd1, wd3, wd5).
- {locale_or_path} is usually "en-US/External" or a company-specific path like "{Company}-Careers".
- Workday does NOT have a public JSON API. Set "ats_api_url" to the full career site URL.
- Set "ats_identifier" to the "{company_slug}.wd{N}" portion (e.g., "checkpoint.wd3").
- Look for job listings or careers pages hosted on myworkdayjobs.com domains.`;
```

Workday external career sites consistently use the `{slug}.wd{N}.myworkdayjobs.com` domain pattern, where N corresponds to a datacenter instance.[^11][^12][^13]

***

## Complete Node.js Integration Example

```javascript
const axios = require('axios');

const ATS_CONFIGS = {
  comeet: { name: 'Comeet', hints: COMEET_HINTS },
  greenhouse: { name: 'Greenhouse', hints: GREENHOUSE_HINTS },
  workday: { name: 'Workday', hints: WORKDAY_HINTS },
};

const SYSTEM_PROMPT = `You are an Israeli tech industry analyst specializing in recruitment technology infrastructure. Your task is to discover tech companies that have verified R&D or engineering centers in Israel and use a specific Applicant Tracking System. You MUST return ONLY raw JSON matching the enforced schema. Do not include any text outside the JSON object. Every company you return must be a real, currently operating company that you can verify through web search results. If you cannot verify a company uses the specified ATS with high confidence, do not include it. Never return a company from the exclusion list provided by the user.`;

const JSON_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "ats_discovery_result",
    schema: {
      type: "object",
      properties: {
        companies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              company_name: { type: "string" },
              careers_page_url: { type: "string" },
              ats_api_url: { type: "string" },
              ats_identifier: { type: "string" },
              confidence: {
                type: "string",
                enum: ["verified", "likely", "unconfirmed"]
              }
            },
            required: [
              "company_name",
              "careers_page_url",
              "ats_api_url",
              "ats_identifier",
              "confidence"
            ],
            additionalProperties: false
          }
        }
      },
      required: ["companies"],
      additionalProperties: false
    }
  }
};

async function discoverCompanies(atsKey, existingCompanies) {
  const ats = ATS_CONFIGS[atsKey];
  const existingJson = JSON.stringify(
    existingCompanies.map(c => c.company_name)
  );

  const userPrompt = `Search for tech companies that have verified R&D or engineering operations in Israel and use ${ats.name} as their Applicant Tracking System.

EXCLUSION LIST — do NOT return any of these companies under any circumstances:
${existingJson}

DISCOVERY INSTRUCTIONS:
- Search for Israeli tech companies whose careers pages or job boards are powered by ${ats.name}.
- Each company MUST have a verified engineering or R&D presence in Israel (office, team, or hiring for Israel-based roles).
- Return between 5 and 15 NEW companies not in the exclusion list.
- For each company, provide the direct careers page URL and the ATS-specific API endpoint or identifier.

ATS-SPECIFIC CONFIGURATION:
${ats.hints}

CONFIDENCE LEVELS:
- "verified": You found direct evidence in search results that the company uses ${ats.name} and has Israel R&D.
- "likely": Strong indirect evidence (e.g., job posting URL patterns match ${ats.name} format, Israel office mentioned).
- "unconfirmed": The company appears in ${ats.name}-related contexts but full verification was not possible.

Return the JSON object now.`;

  const { data } = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: 'sonar',
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: JSON_SCHEMA,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  return JSON.parse(data.choices.message.content);
}

// Cron loop
async function runDiscoveryPipeline() {
  for (const atsKey of Object.keys(ATS_CONFIGS)) {
    const existing = await getExistingFromMongoDB(atsKey);
    const result = await discoverCompanies(atsKey, existing);
    // result.companies is a typed array — safe to iterate
    for (const company of result.companies) {
      await upsertToMongoDB(atsKey, company);
    }
  }
}
```

***

## Why This Architecture Minimizes Failure Modes

### JSON Reliability: Two-Layer Enforcement

The `response_format` parameter with `json_schema` type operates at the **token decoding** level — the model's output logits are masked so that structurally invalid tokens are impossible. This is fundamentally different from asking for JSON in a prompt, which is an unenforceable "hope." The system prompt's JSON instruction acts as a second layer to prevent edge cases where the model might try to output reasoning tokens before the JSON object.[^14][^2][^1]

### Deduplication: Negative-Space Anchoring

The exclusion list is injected as a flat JSON array of company names directly into the user prompt. This approach works better than complex instructions like "check against this database" because the model processes the exclusion list as part of its input context, making name-matching a pattern-avoidance task rather than a retrieval task. The phrasing "do NOT return any of these companies under any circumstances" uses imperative negation which language models handle more reliably than conditional logic.[^1]

### Hallucination Minimization

Three mechanisms work together:

- **`temperature: 0`** eliminates sampling randomness, selecting the highest-probability token at every step.[^3]
- **Role-specific system prompt** narrows the model's generative distribution toward Israeli tech ecosystem knowledge rather than global company databases.
- **Confidence tiers** give the model an "escape valve" — instead of fabricating confident-sounding data for uncertain cases, it can honestly mark entries as "unconfirmed," which downstream code can handle separately.[^1]

### ATS Configuration Accuracy

Rather than asking the model to "figure out the API format," each ATS hint provides the **exact URL template with placeholder labels** and realistic examples. This converts the task from open-ended generation (high hallucination risk) to template-filling (low hallucination risk). The Sonar model can then use its web search capability to verify and fill in company-specific values like board tokens or UIDs.[^9][^7]

***

## Known Limitations and Mitigations

| Limitation | Impact | Mitigation |
|---|---|---|
| First request with new schema has 10–30s cold start[^1] | Slower initial cron run | Run a warm-up request on pipeline startup |
| Sonar web search may not find every company | Incomplete discovery | Run pipeline on a recurring schedule; companies accumulate over time |
| Workday has no public JSON API[^11] | `ats_api_url` is a career site URL, not an API | Downstream scraper must handle HTML rather than JSON |
| Model may still hallucinate UIDs/tokens for Comeet | Bad API URLs that 404 | Add a validation step: HTTP HEAD each `ats_api_url` and discard non-200 responses |
| `max_tokens` truncation can break JSON[^15] | `JSON.parse()` crash | Set `max_tokens: 4096` generously; cap requested companies at 15 |
| Recursive/unconstrained schemas not supported[^15] | Schema design constraint | Keep schema flat (no `dict[str, Any]` or recursive types) |

***

## Post-Processing Recommendations

After calling `JSON.parse()` on `choices.message.content`, add these validation steps before MongoDB upsert:

1. **Schema validation**: Run the parsed object through a lightweight JSON Schema validator (e.g., `ajv`) to catch edge cases.
2. **URL liveness check**: HTTP HEAD each `careers_page_url` and `ats_api_url` — discard entries returning non-2xx status codes.
3. **Duplicate check**: Even with the exclusion list, perform a case-insensitive `company_name` match against MongoDB before insert.
4. **Confidence filtering**: Optionally skip `"unconfirmed"` entries or route them to a manual review queue.

---

## References

1. [Core Features - Perplexity](https://docs.perplexity.ai/docs/sonar/features) - Streaming, structured outputs, and prompting best practices for the Sonar API

2. [Output Control - Perplexity](https://docs.perplexity.ai/docs/agent-api/output-control) - For example, include phrases like “Please return the data as a JSON object with the following struct...

3. [sonar | AI/ML API Documentation](https://docs.aimlapi.com/api-references/text-models-llm/perplexity/sonar)

4. [API response is not JSON parsable despite specified response format](https://community.openai.com/t/api-response-is-not-json-parsable-despite-specified-response-format/1014311) - I'm experiencing an issue where, despite specifying a JSON response format in an API call, the retur...

5. [Can I have the API return in json and only json?](https://www.reddit.com/r/perplexity_ai/comments/1hhhwhl/can_i_have_the_api_return_in_json_and_only_json/) - Can I have the API return in json and only json?

6. [Perplexity Module not outputing the right JSON format to parse it in ...](https://community.make.com/t/perplexity-module-not-outputing-the-right-json-format-to-parse-it-in-make/57132) - I am calling in my scenario Perplexity module and telling him to give the required results in JSON f...

7. [Hot Positions - Moon Active](https://www.moonactive.com/hot-positions/) - JOIN THE CREW We’re looking for incredible people who have a desire to create, develop and deliver a...

8. [Careers website FAQs - Spark Hire Recruit Support](https://recruit-support.sparkhire.com/hc/en-us/articles/40045062742171-Careers-website-FAQs) - To find your Company UID and API token, from your avatar at the top right, navigate to Settings > So...

9. [Introduction – Job Board API - Developer Resources | Greenhouse](https://developers.greenhouse.io/job-board.html) - With our Job Board API, you will have easy access to a simple JSON representation of your company's ...

10. [Job board URL for Greenhouse-hosted job board](https://support.greenhouse.io/hc/en-us/articles/360020776251-Job-board-URL-for-Greenhouse-hosted-job-board) - Permissions: Site Admin Product tier: Available for all current subscription tiers (Core, Plus, and ...

11. [Workday Job Scraper - Enterprise Career Sites - Apify](https://apify.com/tropical_quince/workday-job-scraper) - Scrape Workday career sites for job postings, departments, locations. Works with Fortune 500 Workday...

12. [How to place Workday job listings on your WordPress](https://flawlessthemes.com/workday-job-listings-on-your-wordpress/) - Learn how to place Workday job listings on your WordPress site. It offers to list in many ways. This...

13. [Is anyone able to help me or thoroughly explain the various Workday accounts/portals (for the same company) I supposedly have to have ?](https://www.reddit.com/r/workday/comments/1239aic/is_anyone_able_to_help_me_or_thoroughly_explain/)

14. [Sonar reasoning pro - Perplexity](https://docs.perplexity.ai/docs/getting-started/models/models/sonar-reasoning-pro) - The sonar-reasoning-pro model is designed to output a <think> section ... As a result, the response_...

15. [Structured Outputs Guide - Perplexityperplexity.mintlify.app › guides › structured-outputs](https://perplexity.mintlify.app/guides/structured-outputs)

