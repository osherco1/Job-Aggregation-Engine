# LinkedIn Voyager Encoding Guide (2025)

## Overview: The "Voyager 400 Challenge"

LinkedIn's 2025 Voyager jobs API (`voyagerJobsDashJobCards`) is extremely sensitive to how URLs are encoded. Standard URL encoding patterns that work for most REST APIs often result in **HTTP 400 Bad Request** when used against Voyager.

Two key facts make this tricky:

- The **outer Voyager query structure** (the `query=(origin:...,keywords:...,locationUnion:...,selectedFilters:...)` block) must stay in a very specific, mostly raw format.
- The **internal boolean logic** inside `keywords:` (e.g. `(Junior OR Student OR Intern ...)`) must be encoded much more strictly than `encodeURIComponent` does by default.

This guide documents the encoding rules and the final working implementation used in `fetchJobs`.

## The Golden Rules of Encoding

### 1. Structural vs. Content

- **Structural part (RAW)**:
  - The **outer query structure** must stay raw and match the browser's working request:
    - `query=(origin:JOB_SEARCH_PAGE_JOB_FILTER,keywords:...,locationUnion:(geoId:101620260),selectedFilters:(sortBy:List(DD),experience:List(1,2),timePostedRange:List(r604800)),spellCorrectionEnabled:true)`
  - The parentheses and commas in this outer block (everything except the keyword expression) should **not** be re-encoded or altered.

- **Content part (ENCODED)**:
  - The value after `keywords:` is the **only part** that needs strict encoding.
  - This value may contain complex boolean logic: `(Junior OR Student OR Intern OR "Entry Level" OR Graduate) AND ...`.

### 2. Internal Boolean Logic Must Be Encoded

LinkedIn treats the `keywords:` block as a nested expression that **must** be encoded safely:

- Every space inside the keyword expression must become `%20`.
- Every `(` must become `%28`.
- Every `)` must become `%29`.
- There must **not** be raw parentheses inside the `keywords:` block in the final URL.

The rest of the query (e.g. `origin:`, `locationUnion:`, `selectedFilters:`) remains in the raw Voyager DSL format.

### 3. The Node.js `encodeURIComponent` Bug (for Voyager)

In Node.js, `encodeURIComponent` does **not** encode `(` or `)`:

- `"("` stays `"("` instead of `%28`
- `")"` stays `")"` instead of `%29`

For Voyager, this is a problem: the API expects **encoded** parentheses inside the `keywords:` block. If raw `(` or `)` slip through, you get a 400.

To fix this, we **post-process** the result of `encodeURIComponent`:

```js
const encodedKeywords = encodeURIComponent(keywords)
  .replace(/\(/g, '%28')
  .replace(/\)/g, '%29')
  .replace(/\+/g, '%20');
```

- This ensures that:
  - All parentheses are `%28` / `%29`.
  - Any `+` produced by intermediate encoding (or libraries) is normalized back to `%20`.

## Final `fetchJobs` Code Snippet

The working implementation in `linkedin_client.js` looks like this:

```js
const axios = require('axios');
const fs = require('fs');

const BASE_URL = 'https://www.linkedin.com';
const JOBS_ENDPOINT = '/voyager/api/voyagerJobsDashJobCards';

async function fetchJobs(keywords, start = 0) {
  const count = 25;
  const headers = getHeaders(); // Uses cookies / CSRF from .env

  // 1. Fully encode the keywords string, and force encoding of parentheses and spaces.
  // Node's encodeURIComponent leaves () unencoded, but Voyager expects %28 and %29
  // inside the keywords block: keywords:%28Junior%20OR...%29
  const keywordString = typeof keywords === 'string' ? keywords : String(keywords || '');
  const encodedKeywords = encodeURIComponent(keywordString)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\+/g, '%20');

  // 2. Gold-standard query template based on successful browser request.
  const queryValue =
    `(origin:JOB_SEARCH_PAGE_JOB_FILTER,` +
    `keywords:${encodedKeywords},` +
    `locationUnion:(geoId:101620260),` +
    `selectedFilters:(sortBy:List(DD),experience:List(1,2),timePostedRange:List(r604800)),` +
    `spellCorrectionEnabled:true)`;

  const url =
    `${BASE_URL}${JOBS_ENDPOINT}` +
    `?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220` +
    `&count=${count}` +
    `&q=jobSearch` +
    `&query=${queryValue}` +
    `&start=${start}`;

  console.log('🚀 FORCED ENCODING URL:', url);

  const response = await axios.get(url, { headers });

  // Optional: persist raw response for debugging
  fs.writeFileSync(
    'debug_linkedin_response.json',
    JSON.stringify(response.data, null, 2),
    'utf-8'
  );

  return normalizeResponse(response.data);
}
```

This snippet captures the core rules:

- Raw Voyager structure outside `keywords:`
- Aggressively encoded `keywords` block
- Manual URL construction (no `params` object) to prevent double-encoding

## Troubleshooting

- **Status 400 (Bad Request):**
  - Inspect the logged URL.
  - Under `keywords:`, look for any **raw `(` or `)`** – they must be `%28` / `%29`.
  - Look for `+` characters where spaces should be – they must be `%20`.
  - Confirm that the `query=` segment begins with `query=(origin:JOB_SEARCH_PAGE_JOB_FILTER,...` and not some differently encoded form.

- **Empty `elements` Array (No Jobs Returned):**
  - Verify that the `decorationId` matches the schema you reverse-engineered:
    - `com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220`
  - If LinkedIn changes the `decorationId` or schema, the response shape can change and `normalizeResponse` may need updates.
  - Ensure the `timePostedRange` filter (e.g. `r604800` for last 7 days) is appropriate for your use case—too strict filters may yield zero results.

With this encoding strategy, the LinkedIn Voyager jobs endpoint accepts complex boolean keyword expressions without 400 errors, while still returning a stable, parseable JSON structure for automated job scraping.


