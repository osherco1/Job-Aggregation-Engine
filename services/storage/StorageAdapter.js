/**
 * StorageAdapter - Abstract interface for storage operations
 * 
 * Defines the contract for all storage backends (file-based, MongoDB, etc.)
 * All methods are async to support both file I/O and database operations.
 */

class StorageAdapter {
  /**
   * Load seen job IDs (for LinkedIn deduplication)
   * @returns {Promise<Set<string>>} Set of job IDs that have been seen
   */
  async loadSeenJobIds() {
    throw new Error('loadSeenJobIds() must be implemented by subclass');
  }

  /**
   * Save seen job IDs (for LinkedIn deduplication)
   * @param {Set<string>} ids - Set of job IDs to persist
   * @returns {Promise<void>}
   */
  async saveSeenJobIds(ids) {
    throw new Error('saveSeenJobIds() must be implemented by subclass');
  }

  /**
   * Check if a job ID has been seen
   * @param {string} jobId - Job ID to check
   * @returns {Promise<boolean>}
   */
  async hasSeenJob(jobId) {
    const seen = await this.loadSeenJobIds();
    return seen.has(String(jobId));
  }

  /**
   * Mark a job as seen (convenience method)
   * @param {string} jobId - Job ID to mark as seen
   * @param {string} source - Source of the job (e.g., 'linkedin')
   * @returns {Promise<void>}
   */
  async markJobSeen(jobId, source) {
    const seen = await this.loadSeenJobIds();
    seen.add(String(jobId));
    await this.saveSeenJobIds(seen);
  }

  /**
   * Load sent job history (for ATS deduplication)
   * @returns {Promise<Set<string>>} Set of job IDs that have been sent via email
   */
  async loadSentHistory() {
    throw new Error('loadSentHistory() must be implemented by subclass');
  }

  /**
   * Persist sent job history (for ATS deduplication)
   * @param {Set<string>} ids - Set of job IDs that were sent
   * @param {Object} metadata - Optional metadata (e.g., { lastUpdated, totalCount })
   * @returns {Promise<void>}
   */
  async persistSentHistory(ids, metadata = {}) {
    throw new Error('persistSentHistory() must be implemented by subclass');
  }

  /**
   * Load companies configuration
   * Merges companies_list.json, comeet_companies_auto.json, greenhouse_list.csv, and workday_companies.json
   * @returns {Promise<Array<Object>>} Array of company config objects
   */
  async loadCompanies() {
    throw new Error('loadCompanies() must be implemented by subclass');
  }

  /**
   * Write a run log entry (fire-and-forget, non-critical)
   * Used for summaries, filtered jobs, errors, etc.
   * @param {Object} entry - Log entry with { type, source, timestamp, payload }
   * @returns {Promise<void>}
   */
  async writeRunLog(entry) {
    throw new Error('writeRunLog() must be implemented by subclass');
  }

  /**
   * Write lightweight rejected job data (calibration collection)
   * @param {Array<Object>} jobs - Array of { jobId, title, companyName, location, url, reason, source }
   * @returns {Promise<void>}
   */
  async writeCalibrationRejected(jobs) {
    // No-op default for non-Mongo adapters (e.g., FileStorageAdapter)
  }

  /**
   * Write lightweight passed job data (calibration collection)
   * @param {Array<Object>} jobs - Array of { jobId, title, companyName, location, url, source }
   * @returns {Promise<void>}
   */
  async writeCalibrationPassed(jobs) {
    // No-op default for non-Mongo adapters (e.g., FileStorageAdapter)
  }

  /**
   * Aggregated view of rejected jobs for calibration reporting.
   * Default implementation returns an empty array so non-Mongo adapters
   * simply render an empty section.
   * @param {number} limit - Max number of grouped signatures to return
   * @returns {Promise<Array<Object>>}
   */
  async getCalibrationRejectedAggregated(limit = 1000) {
    return [];
  }

  /**
   * Upsert a company document into the companies store.
   * Used by local Comeet tooling to inject validated companies into the DB.
   * @param {Object} company - Company object with at least { id, name, type }
   * @returns {Promise<void>}
   */
  async upsertCompany(company) {
    throw new Error('upsertCompany() must be implemented by subclass');
  }

  /**
   * Close / release any resources held by this adapter (e.g., database connections).
   * Subclasses that hold open connections MUST override this.
   * The default implementation is a no-op so file-based adapters work without changes.
   * @returns {Promise<void>}
   */
  async close() {
    // No-op by default (FileStorageAdapter has nothing to close)
  }
}

module.exports = { StorageAdapter };

