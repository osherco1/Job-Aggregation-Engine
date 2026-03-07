/**
 * Discovery Pipeline — Main Entry Point
 * 
 * Autonomous company discovery: LLM suggests → extractor classifies →
 * validators verify (GH/WD) → MongoDB stores.
 * Comeet leads are written to a CSV for local Puppeteer harvesting.
 *
 * Usage:
 *   node tools/discovery/run_discovery.js
 *   DISCOVERY_DRY_RUN=true node tools/discovery/run_discovery.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createStorageAdapter } = require('../../services/storage');
const { createEmailNotifier } = require('../../services/EmailNotifier');
const { createPerplexityClient } = require('./perplexityClient');
const { buildUserPrompt, getSystemPrompt, getAtsTypes, getAtsConfig } = require('./promptTemplates');
const { classifyAndExtract } = require('./extractor');

// Validators
const { validateCompanies: validateGreenhouse } = require('../greenhouse/validate_companies');
const { validateCompanies: validateWorkday } = require('../workday/validate_companies');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DRY_RUN = process.env.DISCOVERY_DRY_RUN === 'true';
const COMEET_CSV_PATH = path.join(__dirname, '..', 'comeet_list.csv');

const VALIDATORS = {
    greenhouse: validateGreenhouse,
    workday: validateWorkday,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter out companies with confidence: "unconfirmed".
 * @param {Array} companies - Universal LLM output objects
 * @returns {Array} Filtered companies (verified + likely only)
 */
function filterByConfidence(companies) {
    const kept = companies.filter(c => c.confidence !== 'unconfirmed');
    const dropped = companies.length - kept.length;
    if (dropped > 0) {
        console.log(`  🔽 Dropped ${dropped} unconfirmed companies`);
    }
    return kept;
}

/**
 * Generate a normalised ID from a company name.
 * @param {string} name
 * @returns {string}
 */
function nameToId(name) {
    return (name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * Append Comeet leads to comeet_list.csv.
 * Creates the file with headers if it does not exist.
 * @param {Array<Object>} leads - LLM candidate objects with company_name + careers_page_url
 */
function appendToComeetCsv(leads) {
    const needsHeader = !fs.existsSync(COMEET_CSV_PATH) || fs.statSync(COMEET_CSV_PATH).size === 0;
    const header = '"Company Name","Full Job Board URL"\n';

    let csvContent = needsHeader ? header : '';
    for (const lead of leads) {
        const name = (lead.company_name || '').replace(/"/g, '""');
        const url = (lead.careers_page_url || '').replace(/"/g, '""');
        csvContent += `"${name}","${url}"\n`;
    }

    fs.appendFileSync(COMEET_CSV_PATH, csvContent, 'utf-8');
    console.log(`  📝 Appended ${leads.length} Comeet leads to ${path.basename(COMEET_CSV_PATH)}`);
}

/**
 * Query existing companies of a specific ATS type from MongoDB.
 * @param {Object} storageAdapter
 * @param {string} atsType
 * @returns {Promise<Array<string>>}
 */
async function getExistingCompanyNames(storageAdapter, atsType) {
    const allCompanies = await storageAdapter.loadCompanies();
    return allCompanies
        .filter(c => c.type === atsType)
        .map(c => c.name);
}

/**
 * Insert approved companies into MongoDB via upsertCompany.
 * @param {Object} storageAdapter
 * @param {Array} approvedCompanies
 * @returns {Promise<Array>} Actually inserted companies
 */
async function insertApproved(storageAdapter, approvedCompanies) {
    if (DRY_RUN) {
        console.log(`  🏜️  DRY RUN: Would insert ${approvedCompanies.length} companies (skipped)`);
        return approvedCompanies; // pretend they were inserted for reporting
    }

    const inserted = [];

    for (const company of approvedCompanies) {
        const doc = {
            id: company.id,
            name: company.name,
            type: company.type,
            enabled: true,
            addedBy: 'discovery_pipeline',
        };

        // Copy ATS-specific fields
        if (company.uid) doc.uid = company.uid;
        if (company.token) doc.token = company.token;
        if (company.url) doc.url = company.url;

        try {
            await storageAdapter.upsertCompany(doc);
            inserted.push(company);
            console.log(`  💾 Upserted: ${company.name} (${company.id})`);
        } catch (err) {
            console.error(`  ❌ Failed to upsert ${company.name}: ${err.message}`);
        }
    }

    return inserted;
}

// ---------------------------------------------------------------------------
// Email Report Builder
// ---------------------------------------------------------------------------

/**
 * Build a markdown report summarizing the discovery run.
 * @param {Object} report
 * @returns {string}
 */
function buildReportMarkdown(report) {
    const lines = [];

    lines.push('# 🔍 Discovery Pipeline Report');
    lines.push(`**Run:** ${report.runTimestamp} | **Duration:** ${report.duration}`);
    if (DRY_RUN) lines.push('> ⚠️ **DRY RUN** — no companies were written to the database.');
    lines.push('');

    // Summary table
    lines.push('## Summary');
    lines.push('| ATS | LLM Suggested | Validated ✅ | Rejected ❌ | Inserted to DB |');
    lines.push('|-----|---------------|-------------|-------------|----------------|');

    for (const r of report.atsResults) {
        lines.push(`| ${r.atsType} | ${r.llmSuggested} | ${r.approved} | ${r.rejected.length} | ${r.inserted.length} |`);
    }

    const t = report.totals;
    lines.push(`| **Total** | **${t.suggested}** | **${t.approved}** | **${t.rejected}** | **${t.inserted}** |`);
    lines.push('');

    // Comeet CSV handoff
    if (report.comeetCsvCount > 0) {
        lines.push(`## 📋 Comeet CSV Handoff`);
        lines.push(`${report.comeetCsvCount} Comeet leads written to \`comeet_list.csv\` for local Puppeteer harvesting.`);
        lines.push('');
    }

    // Successfully added
    const allInserted = report.atsResults.flatMap(r => r.inserted);
    if (allInserted.length > 0) {
        lines.push(`## ✅ Successfully Added (${allInserted.length} companies)`);
        for (const r of report.atsResults) {
            if (r.inserted.length > 0) {
                lines.push(`### ${r.atsType}`);
                for (const c of r.inserted) {
                    const detail = c.uid ? `uid: ${c.uid}` : c.url ? `url: ${c.url}` : '';
                    lines.push(`- ${c.name} (\`${c.id}\`${detail ? `, ${detail}` : ''})`);
                }
            }
        }
        lines.push('');
    }

    // Rejected
    const allRejected = report.atsResults.flatMap(r => r.rejected);
    if (allRejected.length > 0) {
        lines.push(`## ❌ Rejected (${allRejected.length} companies)`);
        lines.push('| Company | ATS | Reason |');
        lines.push('|---------|-----|--------|');
        for (const r of report.atsResults) {
            for (const rej of r.rejected) {
                lines.push(`| ${rej.name || rej.id || '?'} | ${r.atsType} | ${rej.reason || 'Unknown'} |`);
            }
        }
        lines.push('');
    }

    // Errors
    const allErrors = report.atsResults.filter(r => r.error);
    if (allErrors.length > 0) {
        lines.push('## ⚠️ Pipeline Errors');
        for (const r of allErrors) {
            lines.push(`- **${r.atsType}:** ${r.error}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-ATS Processing
// ---------------------------------------------------------------------------

/**
 * Process a single ATS type: fetch existing → prompt LLM → extract → validate → insert.
 * Comeet candidates are routed to CSV instead of validation.
 *
 * @param {string} atsType
 * @param {Object} storageAdapter
 * @param {{ query: Function }} llmClient
 * @param {Object} comeetAccumulator - { leads: [] } shared accumulator for Comeet CSV writes
 * @returns {Promise<Object>} ATS result
 */
async function processAts(atsType, storageAdapter, llmClient, comeetAccumulator) {
    const atsConfig = getAtsConfig(atsType);
    const result = {
        atsType,
        llmSuggested: 0,
        approved: 0,
        rejected: [],
        inserted: [],
        error: null,
    };

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🔎 Processing ATS: ${atsConfig.label}`);
    console.log(`${'═'.repeat(60)}`);

    try {
        // Step 1: Get existing company names for dedup
        console.log(`\n  📋 Fetching existing ${atsType} companies from DB...`);
        const existingNames = await getExistingCompanyNames(storageAdapter, atsType);
        console.log(`     Found ${existingNames.length} existing companies`);

        // Step 2: Stage 1 — Deep research (sonar-deep-research, raw Markdown)
        console.log(`  🤖 Stage 1: Deep research via ${llmClient.discoveryModel}...`);
        console.log(`     ⏳ This may take 2-5 minutes per ATS type...`);
        const systemPrompt = getSystemPrompt();
        const userPrompt = buildUserPrompt(atsType, existingNames);

        const rawMarkdown = await llmClient.discoverCompaniesRaw(systemPrompt, userPrompt);
        console.log(`     ✅ Raw research complete (${rawMarkdown.length} chars)`);

        // Step 3: Stage 2 — Structured JSON parsing (sonar-pro, schema enforced)
        console.log(`  🧠 Stage 2: Parsing to JSON via ${llmClient.parserModel}...`);
        const parsed = await llmClient.parseCompaniesJson(rawMarkdown);
        let allCandidates = parsed.companies || [];
        result.llmSuggested = allCandidates.length;
        console.log(`     Parsed ${allCandidates.length} candidate companies from research`);

        if (allCandidates.length === 0) {
            console.log(`  ℹ️  No new companies suggested for ${atsType}`);
            return result;
        }

        // Step 3a: Hard deduplication — drop companies already in DB
        const existingNamesLower = existingNames.map(n => n.toLowerCase());
        const beforeDedup = allCandidates.length;
        allCandidates = allCandidates.filter(c => {
            const nameLower = (c.company_name || '').toLowerCase().trim();
            return !existingNamesLower.includes(nameLower);
        });
        const dedupDropped = beforeDedup - allCandidates.length;
        if (dedupDropped > 0) {
            console.log(`  🔽 Dropped ${dedupDropped} already-known companies (hard dedup)`);
        }

        // Step 3a: Confidence filter — drop "unconfirmed"
        const confident = filterByConfidence(allCandidates);

        if (confident.length === 0) {
            console.log(`  ℹ️  All suggestions were unconfirmed for ${atsType}`);
            return result;
        }

        // Step 4: Extract identifiers from URLs & route
        console.log(`  🔀 Classifying ${confident.length} candidate URLs via extractor...`);
        const validatorReady = [];
        const comeetLeads = [];

        for (const candidate of confident) {
            let { atsType: detectedType, extracted } = classifyAndExtract(candidate.careers_page_url);

            // Comeet fallback: if URL is unclassified but we're in the Comeet loop,
            // force it to Comeet CSV handoff (many Comeet embeds use custom domains)
            if (!detectedType && atsType === 'comeet') {
                detectedType = 'comeet';
                extracted = { careersUrl: candidate.careers_page_url };
            }

            if (detectedType === 'comeet') {
                // Route Comeet leads to CSV — no validation possible without Puppeteer
                comeetLeads.push(candidate);
                console.log(`     📋 ${candidate.company_name} → Comeet CSV handoff`);
                continue;
            }

            if (detectedType === atsType && extracted) {
                // URL matches the expected ATS type — build validator-ready object
                const id = nameToId(candidate.company_name);
                const base = { id, name: (candidate.company_name || '').trim(), type: atsType };

                if (atsType === 'greenhouse' && extracted.uid) {
                    validatorReady.push({ ...base, uid: extracted.uid });
                    console.log(`     ✅ ${candidate.company_name} → GH slug: ${extracted.uid}`);
                } else if (atsType === 'workday' && extracted.url) {
                    validatorReady.push({ ...base, url: extracted.url });
                    console.log(`     ✅ ${candidate.company_name} → WD url: ${extracted.url}`);
                }
            } else if (detectedType && detectedType !== atsType) {
                // URL matches a DIFFERENT ATS — log mismatch
                console.log(`     ⚠️  ${candidate.company_name}: URL detected as ${detectedType}, expected ${atsType} — skipping`);
            } else {
                // URL didn't match any known ATS pattern
                console.log(`     ❓ ${candidate.company_name}: Could not classify URL — skipping`);
            }
        }

        // Accumulate Comeet leads for CSV write at the end
        if (comeetLeads.length > 0) {
            comeetAccumulator.leads.push(...comeetLeads);
        }

        // Step 5: Validate GH/WD candidates via existing validators
        if (validatorReady.length > 0 && VALIDATORS[atsType]) {
            console.log(`  ✅ Running ${atsType} validator on ${validatorReady.length} candidates...`);
            const validator = VALIDATORS[atsType];
            const { approved, rejected } = await validator(validatorReady);

            result.approved = approved.length;
            result.rejected = rejected.map(r => ({ id: r.id, name: r.name, reason: r.reason }));

            // Step 6: Insert approved into DB
            if (approved.length > 0) {
                console.log(`\n  💾 Inserting ${approved.length} approved companies into DB...`);
                const inserted = await insertApproved(storageAdapter, approved);
                result.inserted = inserted.map(i => ({ id: i.id, name: i.name, uid: i.uid, url: i.url }));
            } else {
                console.log(`  ℹ️  No companies passed validation for ${atsType}`);
            }
        } else if (validatorReady.length === 0) {
            console.log(`  ℹ️  No extractable ${atsType} candidates from LLM output`);
        }
    } catch (err) {
        console.error(`  ❌ Error processing ${atsType}: ${err.message}`);
        result.error = err.message;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

async function run() {
    const startTime = Date.now();

    console.log('\n' + '🔍'.repeat(30));
    console.log('🤖 DISCOVERY PIPELINE (Decoupled Architecture)');
    console.log('🔍'.repeat(30));
    console.log(`   Started at: ${new Date().toISOString()}`);
    console.log(`   DRY_RUN: ${DRY_RUN}`);
    console.log('');

    // --- System Initialization ---
    let storageAdapter;
    let emailNotifier;
    let llmClient;

    try {
        storageAdapter = createStorageAdapter();
        emailNotifier = createEmailNotifier();
        llmClient = createPerplexityClient();
        console.log('✅ System initialized (MongoDB, Email, Perplexity)\n');
    } catch (err) {
        console.error(`❌ Initialization failed: ${err.message}`);
        process.exitCode = 1;
        return;
    }

    // --- Report accumulator ---
    const report = {
        runTimestamp: new Date().toISOString(),
        duration: null,
        atsResults: [],
        comeetCsvCount: 0,
        totals: { suggested: 0, approved: 0, rejected: 0, inserted: 0 },
    };

    // --- Shared Comeet lead accumulator ---
    const comeetAccumulator = { leads: [] };

    // --- Process each ATS sequentially ---
    const atsTypes = getAtsTypes(); // ['comeet', 'greenhouse', 'workday']

    for (const atsType of atsTypes) {
        const result = await processAts(atsType, storageAdapter, llmClient, comeetAccumulator);
        report.atsResults.push(result);

        // Accumulate totals
        report.totals.suggested += result.llmSuggested;
        report.totals.approved += result.approved;
        report.totals.rejected += result.rejected.length;
        report.totals.inserted += result.inserted.length;
    }

    // --- Write accumulated Comeet leads to CSV ---
    if (comeetAccumulator.leads.length > 0) {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  📋 COMEET CSV HANDOFF`);
        console.log(`${'═'.repeat(60)}`);
        appendToComeetCsv(comeetAccumulator.leads);
        report.comeetCsvCount = comeetAccumulator.leads.length;
    }

    // --- Duration ---
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    report.duration = `${mins}m ${secs}s`;

    // --- Final Summary ---
    console.log('\n' + '='.repeat(60));
    console.log('📋 DISCOVERY PIPELINE — FINAL SUMMARY');
    console.log('='.repeat(60));
    console.log(`   LLM suggested:    ${report.totals.suggested}`);
    console.log(`   Validated:        ${report.totals.approved}`);
    console.log(`   Rejected:         ${report.totals.rejected}`);
    console.log(`   Inserted to DB:   ${report.totals.inserted}`);
    console.log(`   Comeet CSV leads: ${report.comeetCsvCount}`);
    console.log(`   Duration:         ${report.duration}`);
    console.log(`   Dry run:          ${DRY_RUN}`);
    console.log('='.repeat(60));

    // --- Email Report (skip during dry runs) ---
    if (!DRY_RUN) {
        try {
            const reportMd = buildReportMarkdown(report);
            const subject = `🔍 Discovery Report: ${report.totals.inserted} new companies added`;
            const sent = await emailNotifier.sendCalibrationAlert(subject, reportMd, 'time');
            console.log(sent ? '\n📧 Report email sent' : '\n⚠  Report email failed');
        } catch (err) {
            console.error(`\n⚠  Failed to send email report: ${err.message}`);
        }
    } else {
        console.log('\n📧 DRY RUN: Email report skipped');
    }

    // --- Cleanup ---
    try {
        if (storageAdapter && typeof storageAdapter.close === 'function') {
            await storageAdapter.close();
        }
    } catch (err) {
        // non-fatal
    }

    console.log('\n✅ Discovery pipeline complete.\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
    run()
        .catch(err => {
            console.error('Discovery pipeline failed:', err.message || err);
            process.exitCode = 1;
        })
        .finally(() => {
            // Force exit after 5s if DB connection lingers
            setTimeout(() => {
                process.exit(process.exitCode || 0);
            }, 5000).unref();
        });
}

module.exports = { run };
