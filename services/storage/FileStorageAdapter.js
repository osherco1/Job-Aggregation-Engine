/**
 * FileStorageAdapter - File-based storage implementation
 * 
 * Wraps all existing fs operations to maintain 100% compatibility with local dev.
 * This is the ONLY adapter that uses csv-parser (for greenhouse_list.csv).
 */

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../config/paths');

// Only FileStorageAdapter requires csv-parser
let csvParser;
try {
  csvParser = require('csv-parser');
} catch (err) {
  // csv-parser may not be installed in production (it's in devDependencies)
  // This is fine - only local dev uses FileStorageAdapter
  csvParser = null;
}

const { StorageAdapter } = require('./StorageAdapter');

class FileStorageAdapter extends StorageAdapter {
  constructor() {
    super();
    this.dataDir = PATHS.DATA;
    this.outputDir = PATHS.ATS.OUTPUT;
    this.linkedinOutputDir = PATHS.LINKEDIN.OUTPUT;
  }

  /**
   * Ensure directory exists (recursive)
   * @param {string} dirPath - Directory path to ensure exists
   */
  _ensureDir(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    } catch (err) {
      console.error(`FileStorageAdapter: Failed to ensure directory ${dirPath}:`, err.message || err);
    }
  }

  /**
   * Sanitize timestamp for use in filenames (Windows-safe)
   * Replaces colons, dots, and other illegal characters with dashes
   * @param {string} timestamp - ISO timestamp string (optional)
   * @returns {string} - Sanitized timestamp safe for filenames
   */
  _sanitizeTimestamp(timestamp) {
    const raw = timestamp || new Date().toISOString();
    // Replace colons, dots, and any other problematic characters with dashes
    return String(raw).replace(/[:.]/g, '-');
  }

  /**
   * Load seen job IDs from data/seen_jobs.json
   * @returns {Promise<Set<string>>}
   */
  async loadSeenJobIds() {
    const filePath = path.join(this.dataDir, 'seen_jobs.json');
    
    try {
      this._ensureDir(this.dataDir);
      if (!fs.existsSync(filePath)) {
        return new Set();
      }
      
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      
      if (Array.isArray(parsed)) {
        return new Set(parsed);
      }
      
      return new Set();
    } catch (err) {
      console.error('FileStorageAdapter: Failed to load seen_jobs.json, starting with empty memory:', err.message || err);
      return new Set();
    }
  }

  /**
   * Save seen job IDs to data/seen_jobs.json
   * @param {Set<string>} ids
   * @returns {Promise<void>}
   */
  async saveSeenJobIds(ids) {
    const filePath = path.join(this.dataDir, 'seen_jobs.json');
    
    try {
      this._ensureDir(this.dataDir);
      const arr = Array.from(ids);
      fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf-8');
    } catch (err) {
      console.error('FileStorageAdapter: Failed to save seen_jobs.json:', err.message || err);
    }
  }

  /**
   * Load sent job history from data/ats_sent_jobs_history.json
   * @returns {Promise<Set<string>>}
   */
  async loadSentHistory() {
    const filePath = path.join(this.dataDir, 'ats_sent_jobs_history.json');
    
    try {
      this._ensureDir(this.dataDir);
      if (!fs.existsSync(filePath)) {
        return new Set();
      }
      
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      
      if (data && Array.isArray(data.sentJobIds)) {
        return new Set(data.sentJobIds);
      }
      
      return new Set();
    } catch (err) {
      console.error('FileStorageAdapter: Failed to load ats_sent_jobs_history.json:', err.message || err);
      return new Set();
    }
  }

  /**
   * Persist sent job history to data/ats_sent_jobs_history.json
   * @param {Set<string>} ids
   * @param {Object} metadata - Optional metadata
   * @returns {Promise<void>}
   */
  async persistSentHistory(ids, metadata = {}) {
    const filePath = path.join(this.dataDir, 'ats_sent_jobs_history.json');
    
    try {
      this._ensureDir(this.dataDir);
      const data = {
        lastUpdated: new Date().toISOString(),
        totalCount: ids.size,
        sentJobIds: Array.from(ids),
        ...metadata,
      };
      
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('FileStorageAdapter: Failed to persist ats_sent_jobs_history.json:', err.message || err);
    }
  }

  /**
   * Load and parse greenhouse_list.csv
   * This is the ONLY code path that uses csv-parser
   * @returns {Promise<Array>}
   */
  async _loadGreenhouseCsv() {
    const filePath = path.join(this.dataDir, 'greenhouse_list.csv');
    
    if (!fs.existsSync(filePath)) {
      return [];
    }

    // If csv-parser is not available, fall back to manual parsing
    if (!csvParser) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
        
        // Skip header row
        if (lines.length < 2) {
          return [];
        }
        
        const companies = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          const parts = line.split(',').map(p => p.trim());
          const [id, name, , uid] = parts; // Skip type (column 2)
          
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
      } catch (err) {
        console.warn(`FileStorageAdapter: Failed to read greenhouse_list.csv: ${err.message}`);
        return [];
      }
    }

    // Use csv-parser if available (preferred method)
    return new Promise((resolve, reject) => {
      const companies = [];
      const stream = fs.createReadStream(filePath)
        .pipe(csvParser())
        .on('data', (row) => {
          const { id, name, uid } = row;
          if (id && uid) {
            companies.push({
              id: String(id).trim(),
              name: (name || id).trim(),
              type: 'greenhouse',
              uid: String(uid).trim(),
              token: null,
              enabled: true,
            });
          }
        })
        .on('end', () => {
          resolve(companies);
        })
        .on('error', (err) => {
          console.warn(`FileStorageAdapter: Failed to parse greenhouse_list.csv: ${err.message}`);
          resolve([]); // Return empty array on error
        });
    });
  }

  /**
   * Load and parse a JSON file, returning an array
   * @param {string} filePath
   * @param {string} errorContext - 'required' or 'optional'
   * @returns {Promise<Array>}
   */
  async _loadJsonFile(filePath, errorContext) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      
      if (!Array.isArray(parsed)) {
        throw new Error(`${path.basename(filePath)} must contain an array`);
      }
      
      return parsed;
    } catch (err) {
      if (errorContext === 'optional') {
        return [];
      }
      throw new Error(
        `Failed to read ${path.basename(filePath)} at ${filePath}: ${err.message || err}`
      );
    }
  }

  /**
   * Normalize a company entry to standard format
   */
  _normalizeCompany(entry) {
    return {
      id: String(entry.id || '').trim(),
      name: String(entry.name || '').trim(),
      type: entry.type === 'greenhouse' ? 'greenhouse' : (entry.type === 'workday' ? 'workday' : 'comeet'),
      uid: String(entry.uid || '').trim(),
      token: entry.token ? String(entry.token).trim() : undefined,
      apiBaseUrl: entry.apiBaseUrl ? String(entry.apiBaseUrl).trim() : undefined,
      url: entry.url ? String(entry.url).trim() : undefined,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
    };
  }

  /**
   * Load companies from all sources and merge them
   * Merges: companies_list.json, comeet_companies_auto.json, greenhouse_list.csv, workday_companies.json
   * @returns {Promise<Array<Object>>}
   */
  async loadCompanies() {
    const COMPANIES_FILE = path.join(this.dataDir, 'companies_list.json');
    const COMEET_COMPANIES_FILE = path.join(this.dataDir, 'comeet_companies_auto.json');
    const WORKDAY_COMPANIES_FILE = path.join(this.dataDir, 'workday_companies.json');
    
    // Load all sources in parallel
    const [mainCompanies, comeetCompanies, greenhouseCompanies, workdayCompanies] = await Promise.all([
      this._loadJsonFile(COMPANIES_FILE, 'required'),
      this._loadJsonFile(COMEET_COMPANIES_FILE, 'optional'),
      this._loadGreenhouseCsv(),
      this._loadJsonFile(WORKDAY_COMPANIES_FILE, 'optional'),
    ]);

    // Normalize workday companies (they have { id, name, url } structure)
    const normalizedWorkday = (workdayCompanies || []).map(entry => ({
      id: String(entry.id || '').trim(),
      name: String(entry.name || '').trim(),
      type: 'workday',
      uid: String(entry.url || '').trim(), // Workday uses url as uid
      url: String(entry.url || '').trim(),
      enabled: true,
    }));

    // Normalize all companies
    const allCompanies = [
      ...mainCompanies,
      ...comeetCompanies,
      ...greenhouseCompanies,
      ...normalizedWorkday,
    ]
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => this._normalizeCompany(entry))
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

  /**
   * Write a run log entry to the appropriate log file
   * @param {Object} entry - { type, source, timestamp, payload }
   * @returns {Promise<void>}
   */
  async writeRunLog(entry) {
    const { type, source, timestamp, payload } = entry;
    
    if (!type || !source) {
      console.warn('FileStorageAdapter: writeRunLog requires type and source');
      return;
    }

    try {
      // Sanitize timestamp for Windows compatibility (remove colons, dots, etc.)
      const logTimestamp = this._sanitizeTimestamp(timestamp);
      
      let targetDir;
      let filename;

      if (source === 'linkedin') {
        if (type === 'summary') {
          targetDir = PATHS.LINKEDIN.LOGS.SUMMARIES;
          filename = `run_summary_${logTimestamp}.json`;
        } else if (type === 'filtered') {
          targetDir = PATHS.LINKEDIN.LOGS.FILTERED;
          filename = `filtered_jobs_debug_${logTimestamp}.json`;
        } else {
          // Default to summaries for unknown types
          targetDir = PATHS.LINKEDIN.LOGS.SUMMARIES;
          filename = `run_log_${logTimestamp}.json`;
        }
      } else if (source === 'ats' || source === 'comeet' || source === 'greenhouse' || source === 'workday') {
        if (type === 'summary') {
          if (source === 'comeet') {
            targetDir = PATHS.ATS.LOGS.COMEET.SUMMARIES;
            filename = `run_summary_${logTimestamp}.json`;
          } else if (source === 'greenhouse') {
            targetDir = PATHS.ATS.LOGS.GREENHOUSE.SUMMARIES;
            filename = `run_summary_${logTimestamp}.json`;
          } else {
            targetDir = PATHS.ATS.LOGS.SUMMARIES;
            filename = `ats_run_summary_${logTimestamp}.json`;
          }
        } else if (type === 'filtered') {
          if (source === 'comeet') {
            targetDir = PATHS.ATS.LOGS.COMEET.DROPPED;
            filename = `dropped_${logTimestamp}.json`;
          } else if (source === 'greenhouse') {
            targetDir = PATHS.ATS.LOGS.GREENHOUSE.DROPPED;
            filename = `dropped_${logTimestamp}.json`;
          } else {
            targetDir = PATHS.ATS.LOGS.FILTERED;
            filename = `ats_filtered_jobs_debug_${logTimestamp}.json`;
          }
        } else if (type === 'error') {
          if (source === 'comeet') {
            targetDir = PATHS.ATS.LOGS.COMEET.ERRORS;
            filename = `error_${logTimestamp}.json`;
          } else if (source === 'greenhouse') {
            targetDir = PATHS.ATS.LOGS.GREENHOUSE.ERRORS;
            filename = `error_${logTimestamp}.json`;
          } else {
            targetDir = PATHS.ATS.LOGS.FILTERED;
            filename = `error_${logTimestamp}.json`;
          }
        } else if (type === 'raw') {
          if (source === 'comeet') {
            targetDir = PATHS.ATS.LOGS.COMEET.RAW;
            filename = `raw_${logTimestamp}.json`;
          } else if (source === 'greenhouse') {
            targetDir = PATHS.ATS.LOGS.GREENHOUSE.RAW;
            filename = `raw_${logTimestamp}.json`;
          } else {
            targetDir = PATHS.ATS.LOGS.RAW;
            filename = `raw_${logTimestamp}.json`;
          }
        } else {
          // Default to summaries
          targetDir = PATHS.ATS.LOGS.SUMMARIES;
          filename = `run_log_${logTimestamp}.json`;
        }
      } else {
        // Unknown source - default location
        targetDir = PATHS.ATS.LOGS.SUMMARIES;
        filename = `run_log_${logTimestamp}.json`;
      }

      const filePath = path.join(targetDir, filename);
      // Ensure the target directory exists (recursive) right before write
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.error('FileStorageAdapter: Failed to write run log:', err.message || err);
    }
  }

}

module.exports = { FileStorageAdapter };

