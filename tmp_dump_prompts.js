/**
 * Temporary script: Dump fully-interpolated discovery prompts with real exclusion lists.
 * Usage: node tmp_dump_prompts.js
 */
require('dotenv').config();

const { createStorageAdapter } = require('./services/storage');
const { buildUserPrompt, getSystemPrompt, getAtsTypes } = require('./tools/discovery/promptTemplates');

(async () => {
    const storage = createStorageAdapter();
    const allCompanies = await storage.loadCompanies();
    const systemPrompt = getSystemPrompt();

    for (const atsType of getAtsTypes()) {
        const names = allCompanies.filter(c => c.type === atsType).map(c => c.name);
        const userPrompt = buildUserPrompt(atsType, names);

        console.log(`\n${'#'.repeat(80)}`);
        console.log(`# ${atsType.toUpperCase()} (${names.length} existing companies)`);
        console.log(`${'#'.repeat(80)}\n`);
        console.log(`[SYSTEM PROMPT]: ${systemPrompt}\n`);
        console.log(`[USER PROMPT]: ${userPrompt}`);
    }

    await storage.close();
    process.exit(0);
})();
