/**
 * Workable JSON-LD / __NEXT_DATA__ Description Probe
 *
 * Fetches a Workable job page HTML and extracts the job description from either:
 * 1. JSON-LD Schema.org JobPosting (script[type="application/ld+json"])
 * 2. Fallback: __NEXT_DATA__ script (props.pageProps.job.description)
 *
 * Usage: node tools/probe_workable_description.js
 */

const axios = require('axios');
const cheerio = require('cheerio');

const TARGET_URL = 'https://apply.workable.com/nuvei/j/6CDEE23387/';
const FALLBACK_URL = 'https://apply.workable.com/j/6CDEE23387';
const PREVIEW_LENGTH = 500;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function extractFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const html = $(scripts[i]).html();
    if (!html || !html.trim()) continue;
    try {
      const data = JSON.parse(html);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && item['@type'] === 'JobPosting' && item.description) {
          return item.description;
        }
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }
  return null;
}

function extractFromNextData($) {
  const script = $('#__NEXT_DATA__');
  if (!script.length) return null;
  const html = script.html();
  if (!html || !html.trim()) return null;
  try {
    const data = JSON.parse(html);
    const desc = data?.props?.pageProps?.job?.description;
    return desc || null;
  } catch (e) {
    return null;
  }
}

async function probe(url) {
  const response = await axios.get(url, {
    headers: HEADERS,
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const $ = cheerio.load(response.data);

  let description = extractFromJsonLd($);
  let source = 'JSON-LD JobPosting';

  if (!description) {
    description = extractFromNextData($);
    source = '__NEXT_DATA__ (props.pageProps.job.description)';
  }

  return { description, source };
}

async function main() {
  console.log('Probing Workable job page for description...\n');
  console.log(`Primary URL: ${TARGET_URL}`);
  console.log(`Fallback URL: ${FALLBACK_URL}\n`);

  let result = null;
  let lastError = null;

  for (const url of [TARGET_URL, FALLBACK_URL]) {
    try {
      result = await probe(url);
      if (result.description) {
        console.log(`✅ Success (${url})`);
        console.log(`   Source: ${result.source}\n`);
        break;
      }
    } catch (err) {
      lastError = err;
      console.log(`⚠️  Failed (${url}): ${err.message}`);
    }
  }

  if (!result || !result.description) {
    console.error('\n❌ Could not extract description from any URL.');
    console.error('   Workable serves a minimal SPA shell; JSON-LD and __NEXT_DATA__ are not present in the initial HTML.');
    console.error('   Job content is loaded client-side via JavaScript. Consider Puppeteer for full rendering.');
    if (lastError) console.error('   Last error:', lastError.message);
    process.exit(1);
  }

  const preview = result.description.slice(0, PREVIEW_LENGTH);
  console.log('--- Description preview (first 500 chars) ---');
  console.log(preview);
  if (result.description.length > PREVIEW_LENGTH) {
    console.log('\n... [truncated]');
  }
  console.log('\n--- End preview ---');
  console.log(`\nTotal length: ${result.description.length} characters`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
