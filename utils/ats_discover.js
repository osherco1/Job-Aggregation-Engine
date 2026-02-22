/**
 * ATS Credential Discovery & Config Generator
 * 
 * Purpose: Bulk discovery of ATS (Applicant Tracking System) credentials from 
 * public career pages. Generates a config file for the job aggregator.
 * 
 * Supports: Comeet (UID/Token) and Greenhouse (Board Token)
 * 
 * Strategy: "Static First, Headless Fallback"
 *   - Phase 1: Fast static HTML analysis with axios + cheerio
 *   - Phase 2: Headless browser with network interception (only if Phase 1 fails)
 * 
 * Usage: 
 *   node utils/ats_discover.js
 *   
 *   Or import as module:
 *   const { discoverAts, bulkDiscover } = require('./utils/ats_discover');
 * 
 * Output: data/companies_list.json
 */

const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const USER_AGENT = 
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const AXIOS_TIMEOUT = 15000;       // 15 seconds for static fetch
const PUPPETEER_TIMEOUT = 30000;   // 30 seconds for headless
const NETWORK_SNIFF_WAIT = 5000;   // Wait 5s for async requests

// Output file path
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'companies_list.json');

// ============================================================================
// INPUT: Companies to discover
// ============================================================================

const TARGETS = [
  { name: 'Monday.com', url: 'https://www.monday.com/careers' },
  { name: 'Wiz', url: 'https://www.wiz.io/careers' },
  { name: 'Gong', url: 'https://www.gong.io/careers/' },
  { name: 'AppsFlyer', url: 'https://www.appsflyer.com/careers/' },
  { name: 'Riskified', url: 'https://www.riskified.com/careers/' },
  { name: 'Melio', url: 'https://www.melio.com/careers' },
  { name: 'Fiverr', url: 'https://www.fiverr.com/jobs' },
];

// ============================================================================
// REGEX PATTERNS
// ============================================================================

// Comeet patterns
const COMEET_TOKEN_RE = /["']token["']\s*:\s*["']([^"']+)["']/i;
const COMEET_UID_RE = /["']company-uid["']\s*:\s*["']([^"']+)["']/i;
const COMEET_UID_ALT_RE = /["']company_uid["']\s*:\s*["']([^"']+)["']/i;
const COMEET_INIT_RE = /COMEET\s*\.\s*init\s*\(\s*\{([^}]+)\}/i;

// Additional Comeet URL patterns
const COMEET_API_URL_RE = /comeet\.co[m]?\/(?:careers-api|jobs-api)\/[\d.]+\/company\/([^/\s"']+)/i;
const COMEET_EMBED_URL_RE = /comeet\.co[m]?\/[^"'\s]*\?[^"'\s]*company[_-]?uid=([^&"'\s]+)/i;

// Greenhouse patterns (supports both boards.greenhouse.io and job-boards.greenhouse.io)
const GREENHOUSE_TOKEN_RE = /(?:boards|job-boards)\.greenhouse\.io(?:\/embed\/job_board\/js\?for=|\/embed\/job_board\?for=|\/v1\/boards\/|\/)([a-z0-9_-]+)/i;
const GREENHOUSE_IFRAME_RE = /src=["']([^"']*(?:boards|job-boards)\.greenhouse\.io[^"']*)["']/gi;

// ============================================================================
// PHASE 1: STATIC ANALYSIS
// ============================================================================

/**
 * Fetch HTML content using axios.
 * @param {string} url - Target URL
 * @returns {Promise<string|null>} HTML content or null on failure
 */
async function fetchHtml(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: AXIOS_TIMEOUT,
      maxRedirects: 5,
    });
    return response.data;
  } catch (err) {
    console.log(`  [STATIC] Failed to fetch: ${err.message}`);
    return null;
  }
}

/**
 * Extract Comeet credentials from HTML content.
 * @param {string} html - HTML content
 * @returns {{ uid: string|null, token: string|null, source: string }|null}
 */
function extractComeetFromHtml(html) {
  let uid = null;
  let token = null;
  let source = '';

  // Strategy 1: Look for COMEET.init({ ... })
  const initMatch = html.match(COMEET_INIT_RE);
  if (initMatch) {
    const initBlock = initMatch[1];
    const uidMatch = initBlock.match(COMEET_UID_RE) || initBlock.match(COMEET_UID_ALT_RE);
    const tokenMatch = initBlock.match(COMEET_TOKEN_RE);
    
    if (uidMatch) uid = uidMatch[1];
    if (tokenMatch) token = tokenMatch[1];
    
    if (uid || token) {
      source = 'COMEET.init()';
    }
  }

  // Strategy 2: Look for comeet.co/careers-api URLs
  if (!uid) {
    const apiMatch = html.match(COMEET_API_URL_RE);
    if (apiMatch) {
      uid = apiMatch[1];
      source = 'Comeet API URL';
    }
  }

  // Strategy 3: Look for embed URL with company_uid param
  if (!uid) {
    const embedMatch = html.match(COMEET_EMBED_URL_RE);
    if (embedMatch) {
      uid = embedMatch[1];
      source = 'Comeet Embed URL';
    }
  }

  // Strategy 4: Search for standalone token/uid definitions
  if (!uid) {
    const standaloneUid = html.match(COMEET_UID_RE) || html.match(COMEET_UID_ALT_RE);
    if (standaloneUid) {
      uid = standaloneUid[1];
      source = 'Standalone UID';
    }
  }
  
  if (!token) {
    const standaloneToken = html.match(COMEET_TOKEN_RE);
    if (standaloneToken) {
      token = standaloneToken[1];
      if (!source) source = 'Standalone Token';
    }
  }

  if (uid || token) {
    return { uid, token, source };
  }

  return null;
}

/**
 * Extract Greenhouse board token from HTML content.
 * @param {string} html - HTML content
 * @returns {{ board_token: string, source: string }|null}
 */
function extractGreenhouseFromHtml(html) {
  // Strategy 1: Direct regex match on greenhouse URLs
  const directMatch = html.match(GREENHOUSE_TOKEN_RE);
  if (directMatch) {
    return {
      board_token: directMatch[1],
      source: 'Greenhouse URL pattern',
    };
  }

  // Strategy 2: Parse with cheerio for iframes and links
  const $ = cheerio.load(html);
  
  // Check iframes (both boards.greenhouse.io and job-boards.greenhouse.io)
  const iframes = $('iframe[src*="greenhouse.io"], iframe[data-src*="greenhouse.io"]');
  for (let i = 0; i < iframes.length; i++) {
    const src = $(iframes[i]).attr('src') || $(iframes[i]).attr('data-src');
    if (src) {
      const match = src.match(GREENHOUSE_TOKEN_RE);
      if (match) {
        return {
          board_token: match[1],
          source: 'Greenhouse iframe',
        };
      }
    }
  }

  // Check links (both boards.greenhouse.io and job-boards.greenhouse.io)
  const links = $('a[href*="greenhouse.io"]');
  for (let i = 0; i < links.length; i++) {
    const href = $(links[i]).attr('href');
    if (href) {
      const match = href.match(GREENHOUSE_TOKEN_RE);
      if (match) {
        return {
          board_token: match[1],
          source: 'Greenhouse link',
        };
      }
    }
  }

  // Check script sources (both boards.greenhouse.io and job-boards.greenhouse.io)
  const scripts = $('script[src*="greenhouse.io"]');
  for (let i = 0; i < scripts.length; i++) {
    const src = $(scripts[i]).attr('src');
    if (src) {
      const match = src.match(GREENHOUSE_TOKEN_RE);
      if (match) {
        return {
          board_token: match[1],
          source: 'Greenhouse script',
        };
      }
    }
  }

  // Strategy 3: Check for job-boards style links in href attributes
  const jobBoardLinks = $('a[href*="job-boards.greenhouse.io"]');
  for (let i = 0; i < jobBoardLinks.length; i++) {
    const href = $(jobBoardLinks[i]).attr('href');
    if (href) {
      // Extract token from job-boards.greenhouse.io/{token} or job-boards.greenhouse.io/{token}/jobs/...
      const jobBoardMatch = href.match(/job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i);
      if (jobBoardMatch) {
        return {
          board_token: jobBoardMatch[1],
          source: 'Greenhouse job-boards link',
        };
      }
    }
  }

  return null;
}

/**
 * Phase 1: Static analysis of career page.
 * @param {string} url - Target URL
 * @returns {Promise<{ provider: string, uid: string|null, token: string|null, board_token: string|null }|null>}
 */
async function staticAnalysis(url) {
  console.log(`  [PHASE 1] Static analysis...`);
  
  const html = await fetchHtml(url);
  if (!html) {
    console.log(`  [PHASE 1] Could not fetch HTML.`);
    return null;
  }

  console.log(`  [PHASE 1] Fetched ${html.length} bytes. Searching for ATS patterns...`);

  // Try Comeet first
  const comeet = extractComeetFromHtml(html);
  if (comeet && (comeet.uid || comeet.token)) {
    console.log(`  [PHASE 1] Found Comeet credentials via ${comeet.source}`);
    return {
      provider: 'comeet',
      uid: comeet.uid,
      token: comeet.token,
      board_token: null,
    };
  }

  // Try Greenhouse
  const greenhouse = extractGreenhouseFromHtml(html);
  if (greenhouse) {
    console.log(`  [PHASE 1] Found Greenhouse credentials via ${greenhouse.source}`);
    return {
      provider: 'greenhouse',
      uid: null,
      token: null,
      board_token: greenhouse.board_token,
    };
  }

  console.log(`  [PHASE 1] No ATS credentials found in static HTML.`);
  return null;
}

// ============================================================================
// PHASE 2: HEADLESS FALLBACK
// ============================================================================

/**
 * Extract credentials from a URL (network request).
 * @param {string} requestUrl - Request URL to analyze
 * @returns {{ provider: string, uid: string|null, token: string|null, board_token: string|null }|null}
 */
function extractFromNetworkUrl(requestUrl) {
  // Check for Comeet
  if (requestUrl.includes('api.comeet.com') || requestUrl.includes('comeet.co')) {
    try {
      const urlObj = new URL(requestUrl);
      const params = urlObj.searchParams;
      
      // Check query params
      const token = params.get('token');
      const uid = params.get('company-uid') || params.get('company_uid') || params.get('uid');
      
      // Check URL path for UID
      let pathUid = null;
      const pathMatch = requestUrl.match(COMEET_API_URL_RE);
      if (pathMatch) {
        pathUid = pathMatch[1];
      }

      const finalUid = uid || pathUid;
      
      if (finalUid || token) {
        return {
          provider: 'comeet',
          uid: finalUid,
          token: token,
          board_token: null,
        };
      }
    } catch (e) {
      // URL parsing failed, try regex fallback
      const apiMatch = requestUrl.match(COMEET_API_URL_RE);
      if (apiMatch) {
        return {
          provider: 'comeet',
          uid: apiMatch[1],
          token: null,
          board_token: null,
        };
      }
    }
  }

  // Check for Greenhouse (both boards.greenhouse.io and job-boards.greenhouse.io)
  if (requestUrl.includes('boards-api.greenhouse.io') || 
      requestUrl.includes('boards.greenhouse.io') ||
      requestUrl.includes('job-boards.greenhouse.io') ||
      requestUrl.includes('greenhouse.io/embed')) {
    const match = requestUrl.match(GREENHOUSE_TOKEN_RE);
    if (match) {
      return {
        provider: 'greenhouse',
        uid: null,
        token: null,
        board_token: match[1],
      };
    }
    
    // Alternative: Extract from API path /v1/boards/{token} or job-boards path
    const apiMatch = requestUrl.match(/(?:boards-api|job-boards)\.greenhouse\.io\/(?:v1\/boards\/)?([a-z0-9_-]+)/i);
    if (apiMatch) {
      return {
        provider: 'greenhouse',
        uid: null,
        token: null,
        board_token: apiMatch[1],
      };
    }
  }

  return null;
}

/**
 * Phase 2: Headless browser analysis with network interception.
 * @param {string} url - Target URL
 * @returns {Promise<{ provider: string, uid: string|null, token: string|null, board_token: string|null }|null>}
 */
async function headlessAnalysis(url) {
  console.log(`  [PHASE 2] Headless browser analysis...`);
  
  let browser = null;
  let page = null;
  const findings = [];

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(USER_AGENT);

    // Set up network interception
    const requestHandler = (request) => {
      const reqUrl = request.url();
      const extracted = extractFromNetworkUrl(reqUrl);
      if (extracted) {
        console.log(`  [PHASE 2] Network intercept: ${extracted.provider} credentials found`);
        console.log(`            URL: ${reqUrl.substring(0, 100)}...`);
        findings.push(extracted);
      }
    };

    page.on('request', requestHandler);

    // Navigate to page
    console.log(`  [PHASE 2] Navigating to ${url}...`);
    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: PUPPETEER_TIMEOUT,
      });
    } catch (navErr) {
      // Retry with less strict condition
      console.log(`  [PHASE 2] networkidle2 timeout, retrying with domcontentloaded...`);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PUPPETEER_TIMEOUT,
      });
    }

    // Wait for additional async requests
    console.log(`  [PHASE 2] Waiting ${NETWORK_SNIFF_WAIT / 1000}s for async requests...`);
    await new Promise(resolve => setTimeout(resolve, NETWORK_SNIFF_WAIT));

    // Check if we found anything via network
    if (findings.length > 0) {
      // Return the first (most likely correct) finding
      return findings[0];
    }

    // Fallback: Search the rendered DOM
    console.log(`  [PHASE 2] No network hits. Searching rendered DOM...`);
    const pageContent = await page.content();
    
    const comeet = extractComeetFromHtml(pageContent);
    if (comeet && (comeet.uid || comeet.token)) {
      console.log(`  [PHASE 2] Found Comeet in rendered DOM via ${comeet.source}`);
      return {
        provider: 'comeet',
        uid: comeet.uid,
        token: comeet.token,
        board_token: null,
      };
    }

    const greenhouse = extractGreenhouseFromHtml(pageContent);
    if (greenhouse) {
      console.log(`  [PHASE 2] Found Greenhouse in rendered DOM via ${greenhouse.source}`);
      return {
        provider: 'greenhouse',
        uid: null,
        token: null,
        board_token: greenhouse.board_token,
      };
    }

    console.log(`  [PHASE 2] No ATS credentials found.`);
    return null;

  } catch (err) {
    console.warn(`  [PHASE 2] Puppeteer error: ${err.message}`);
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================================
// MAIN DISCOVERY FUNCTION
// ============================================================================

/**
 * Discover ATS credentials from a career page URL.
 * Uses "Static First, Headless Fallback" strategy.
 * 
 * @param {string} url - Career page URL
 * @returns {Promise<{ provider: string, uid: string|null, token: string|null, board_token: string|null }|null>}
 *          Returns credentials object or null if nothing found.
 */
async function discoverAts(url) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🔍 Discovering ATS for: ${url}`);
  console.log('─'.repeat(60));

  // Phase 1: Static analysis (fast)
  const staticResult = await staticAnalysis(url);
  if (staticResult) {
    console.log(`✅ SUCCESS (Static): ${staticResult.provider.toUpperCase()}`);
    return staticResult;
  }

  // Phase 2: Headless fallback (slow)
  const headlessResult = await headlessAnalysis(url);
  if (headlessResult) {
    console.log(`✅ SUCCESS (Headless): ${headlessResult.provider.toUpperCase()}`);
    return headlessResult;
  }

  console.log(`❌ FAILED: No ATS credentials detected.`);
  return null;
}

// ============================================================================
// BULK DISCOVERY & CONFIG GENERATION
// ============================================================================

/**
 * Generate a config-ready ID from company name.
 * @param {string} name - Company name
 * @returns {string} Lowercase ID suitable for config
 */
function generateId(name) {
  return name
    .toLowerCase()
    .replace(/\.com$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Convert discovery result to PRD-compliant config format.
 * @param {string} name - Company name
 * @param {{ provider: string, uid: string|null, token: string|null, board_token: string|null }} result
 * @returns {{ id: string, name: string, type: string, uid: string }|null}
 */
function toConfigFormat(name, result) {
  if (!result) return null;

  const id = generateId(name);
  
  if (result.provider === 'comeet') {
    // For Comeet, use uid (company_uid) as the identifier
    const uid = result.uid || result.token;
    if (!uid) return null;
    
    return {
      id,
      name,
      type: 'comeet',
      uid,
    };
  } else if (result.provider === 'greenhouse') {
    // For Greenhouse, use board_token as uid
    if (!result.board_token) return null;
    
    return {
      id,
      name,
      type: 'greenhouse',
      uid: result.board_token,
    };
  }
  
  return null;
}

/**
 * Bulk discover ATS credentials for multiple companies.
 * @param {Array<{ name: string, url: string }>} targets - Array of targets
 * @returns {Promise<Array<{ id: string, name: string, type: string, uid: string }>>}
 */
async function bulkDiscover(targets) {
  console.log(`\n📋 Processing ${targets.length} targets...\n`);
  
  const configs = [];
  const results = [];

  for (const target of targets) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏢 ${target.name}`);
    console.log(`   URL: ${target.url}`);
    console.log('═'.repeat(60));

    const result = await discoverAts(target.url);
    const config = toConfigFormat(target.name, result);
    
    results.push({
      name: target.name,
      url: target.url,
      result,
      config,
      success: config !== null,
    });

    if (config) {
      configs.push(config);
    }

    // Small delay between targets to be polite
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { configs, results };
}

/**
 * Save configs to JSON file.
 * @param {Array<{ id: string, name: string, type: string, uid: string }>} configs
 * @param {string} filePath
 */
async function saveConfigs(configs, filePath) {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    
    // Write JSON with nice formatting
    await fs.writeFile(filePath, JSON.stringify(configs, null, 2), 'utf-8');
    console.log(`\n📁 Config saved to: ${filePath}`);
    return true;
  } catch (err) {
    console.error(`\n❌ Failed to save config: ${err.message}`);
    return false;
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Main function for CLI execution.
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       ATS CREDENTIAL DISCOVERY & CONFIG GENERATOR          ║');
  console.log('║         Static First, Headless Fallback Strategy           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nTargets to scan: ${TARGETS.length}`);
  console.log(`Output file: ${OUTPUT_FILE}\n`);

  if (TARGETS.length === 0) {
    console.log('⚠️  No targets configured. Add companies to the TARGETS array.');
    return;
  }

  // Run bulk discovery
  const { configs, results } = await bulkDiscover(TARGETS);

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 DISCOVERY SUMMARY');
  console.log('═'.repeat(60));

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`\n✅ Successfully discovered: ${successful.length}`);
  for (const r of successful) {
    const type = r.config.type.toUpperCase();
    console.log(`   • ${r.name}: ${type} (uid: "${r.config.uid}")`);
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed / Not found: ${failed.length}`);
    for (const r of failed) {
      console.log(`   • ${r.name}: No supported ATS detected`);
    }
  }

  // Save config
  if (configs.length > 0) {
    await saveConfigs(configs, OUTPUT_FILE);
    
    console.log('\n📋 Generated Config:');
    console.log(JSON.stringify(configs, null, 2));
  } else {
    console.log('\n⚠️  No configs generated. Config file not created.');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Total: ${successful.length}/${results.length} successful`);
  console.log('─'.repeat(60));
  console.log('\n✨ Discovery complete.');
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error(`\n💥 Fatal error: ${err.message}`);
    process.exit(1);
  });
}

// Export for use as module
module.exports = {
  discoverAts,
  bulkDiscover,
  saveConfigs,
  staticAnalysis,
  headlessAnalysis,
  extractComeetFromHtml,
  extractGreenhouseFromHtml,
  toConfigFormat,
  generateId,
  TARGETS,
};
