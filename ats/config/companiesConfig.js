const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname ? path.join(__dirname, '..', '..') : process.cwd();
const COMPANIES_FILE = path.join(PROJECT_ROOT, 'data', 'companies_list.json');
const COMEET_COMPANIES_FILE = path.join(PROJECT_ROOT, 'data', 'comeet_companies_auto.json');
const GREENHOUSE_FILE = path.join(PROJECT_ROOT, 'data', 'greenhouse_list.csv');

/**
 * Load and parse greenhouse_list.csv
 * Format: id,name,type,uid,token (header row is skipped)
 * @returns {Array} Array of company objects
 */
function loadGreenhouseCsv() {
  if (!fs.existsSync(GREENHOUSE_FILE)) {
    return [];
  }

  let content;
  try {
    content = fs.readFileSync(GREENHOUSE_FILE, 'utf-8');
  } catch (err) {
    console.warn(`Warning: Failed to read greenhouse_list.csv: ${err.message}`);
    return [];
  }

  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

  // Skip header row (first line)
  if (lines.length < 2) {
    return [];
  }

  const companies = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',').map(p => p.trim());
    const [id, name, , uid] = parts; // Skip type (column 2), we hardcode it

    if (!id || !uid) {
      continue;
    }

    companies.push({
      id,
      name: name || id,
      type: 'greenhouse',
      uid,
      token: null,
      enabled: true,
    });
  }

  return companies;
}

/**
 * Load and parse a JSON file, returning an array
 */
function loadJsonFile(filePath, errorContext) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (errorContext === 'optional') {
      return [];
    }
    throw new Error(
      `Failed to read ${path.basename(filePath)} at ${filePath}: ${err.message || err}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${path.basename(filePath)}: ${err.message || err}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain an array of company definitions`);
  }

  return parsed;
}

/**
 * Normalize a company entry to standard format
 */
function normalizeCompany(entry) {
  return {
    id: String(entry.id || '').trim(),
    name: String(entry.name || '').trim(),
    type: entry.type === 'greenhouse' ? 'greenhouse' : 'comeet',
    uid: String(entry.uid || '').trim(),
    token: entry.token ? String(entry.token).trim() : undefined,
    apiBaseUrl: entry.apiBaseUrl ? String(entry.apiBaseUrl).trim() : undefined,
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
  };
}

function loadCompaniesConfig() {
  // Load main companies list (required)
  const mainCompanies = loadJsonFile(COMPANIES_FILE, 'required');

  // Load Comeet companies from auto-generated file (optional - if missing, just use main list)
  const comeetCompanies = loadJsonFile(COMEET_COMPANIES_FILE, 'optional');

  // Load Greenhouse companies from CSV file (optional)
  const greenhouseCompanies = loadGreenhouseCsv();

  // Normalize all companies
  const allCompanies = [
    ...mainCompanies,
    ...comeetCompanies,
    ...greenhouseCompanies
  ]
    .filter((entry) => entry && typeof entry === 'object')
    .map(normalizeCompany)
    .filter((entry) => entry.id && entry.name && entry.uid && entry.enabled);

  // Remove duplicates by id (prefer main list over comeet list if both exist)
  const companyMap = new Map();
  for (const company of allCompanies) {
    if (!companyMap.has(company.id)) {
      companyMap.set(company.id, company);
    }
  }

  return Array.from(companyMap.values());
}

module.exports = {
  loadCompaniesConfig,
  COMPANIES_FILE,
};


