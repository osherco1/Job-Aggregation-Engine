const path = require('path');

const PROJECT_ROOT = __dirname ? path.join(__dirname, '..', '..') : process.cwd();
const COMPANIES_FILE = path.join(PROJECT_ROOT, 'data', 'companies_list.json');

/**
 * Load companies configuration via StorageAdapter
 * 
 * This is now a thin wrapper around StorageAdapter.loadCompanies(), which handles
 * merging companies_list.json, comeet_companies_auto.json, greenhouse_list.csv, and workday_companies.json.
 * 
 * @param {StorageAdapter} storageAdapter - Storage adapter instance (required)
 * @returns {Promise<Array<Object>>} Array of normalized company config objects
 */
async function loadCompaniesConfig(storageAdapter) {
  if (!storageAdapter) {
    throw new Error('loadCompaniesConfig requires a storageAdapter parameter');
  }

  return await storageAdapter.loadCompanies();
}

module.exports = {
  loadCompaniesConfig,
  COMPANIES_FILE,
};


