/**
 * MongoStorageAdapter - MongoDB Atlas storage implementation
 * 
 * Implements the StorageAdapter interface using MongoDB native driver.
 * Designed for cloud deployment on Google Cloud Run Jobs.
 */

const { MongoClient } = require('mongodb');
const { StorageAdapter } = require('./StorageAdapter');
// #region agent log
const _dbgLog=(m,d,h)=>{try{require('fs').appendFileSync(require('path').join(__dirname,'..','..', '.cursor','debug.log'),JSON.stringify({location:m,data:d,hypothesisId:h,timestamp:Date.now()})+'\n');}catch(_){}};
// #endregion

class MongoStorageAdapter extends StorageAdapter {
  constructor(mongoUri) {
    super();
    if (!mongoUri) {
      throw new Error('MongoStorageAdapter requires a MongoDB URI');
    }
    this.mongoUri = mongoUri;
    this.client = null;
    this.db = null;
    this.connected = false;
    
    // Collection names
    this.collections = {
      SEEN_JOBS: 'seen_jobs',
      ATS_SENT_HISTORY: 'ats_sent_history',
      COMPANIES: 'companies',
      RUN_LOGS: 'run_logs',
      ENRICHED_JOBS: 'enriched_jobs',
      CALIBRATION_REJECTED: 'calibration_rejected',
      CALIBRATION_PASSED: 'calibration_passed',
      RUN_SUMMARIES: 'run_summaries',
    };

    // TTL indexes setup flag (avoid re-creating on every reconnect)
    this._ttlIndexesEnsured = false;
    
    // Database name (extracted from URI or default)
    this.dbName = this._extractDbName(mongoUri);
  }

  /**
   * Extract database name from MongoDB URI
   * @param {string} uri - MongoDB connection string
   * @returns {string} Database name
   */
  _extractDbName(uri) {
    try {
      const url = new URL(uri);
      // Extract database name from path (e.g., /jobbot_db)
      const pathname = url.pathname;
      if (pathname && pathname.length > 1) {
        return pathname.substring(1); // Remove leading '/'
      }
      // Default database name if not specified in URI
      return 'jobbot_db';
    } catch (err) {
      // Fallback to default if URI parsing fails
      return 'jobbot_db';
    }
  }

  /**
   * Connect to MongoDB (lazy initialization)
   * @returns {Promise<void>}
   */
  async _ensureConnected() {
    if (this.connected && this.client && this.db) {
      return;
    }

    try {
      if (!this.client) {
        this.client = new MongoClient(this.mongoUri, {
          maxPoolSize: 10,
          minPoolSize: 1,
          serverSelectionTimeoutMS: 5000,
        });
      }

      if (!this.connected) {
        await this.client.connect();
        this.connected = true;
        this.db = this.client.db(this.dbName);
        console.log(`MongoStorageAdapter: Connected to database '${this.dbName}'`);

        // Ensure TTL indexes on first connection (non-blocking)
        if (!this._ttlIndexesEnsured) {
          this._ttlIndexesEnsured = true;
          this._ensureTTLIndexes().catch(err =>
            console.warn('MongoStorageAdapter: TTL index setup warning:', err.message || err)
          );
        }
      }
    } catch (err) {
      this.connected = false;
      throw new Error(`MongoStorageAdapter: Failed to connect to MongoDB: ${err.message || err}`);
    }
  }

  /**
   * Get a collection reference
   * @param {string} collectionName
   * @returns {Promise<Collection>}
   */
  async _getCollection(collectionName) {
    await this._ensureConnected();
    return this.db.collection(collectionName);
  }

  /**
   * Load seen job IDs from seen_jobs collection
   * @returns {Promise<Set<string>>}
   */
  async loadSeenJobIds() {
    try {
      const collection = await this._getCollection(this.collections.SEEN_JOBS);
      const docs = await collection.find({}).toArray();
      const jobIds = new Set(docs.map(doc => String(doc._id)));
      return jobIds;
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to load seen job IDs:', err.message || err);
      return new Set();
    }
  }

  /**
   * Save seen job IDs to seen_jobs collection
   * @param {Set<string>} ids
   * @returns {Promise<void>}
   */
  async saveSeenJobIds(ids) {
    if (!ids || ids.size === 0) {
      return;
    }

    try {
      const collection = await this._getCollection(this.collections.SEEN_JOBS);
      const now = new Date();
      
      // Use bulk write for efficiency
      const operations = Array.from(ids).map(jobId => ({
        updateOne: {
          filter: { _id: jobId },
          update: {
            $set: {
              _id: jobId,
              source: 'linkedin',
              firstSeenAt: now,
            },
            $setOnInsert: {
              createdAt: now,
            },
          },
          upsert: true,
        },
      }));

      if (operations.length > 0) {
        await collection.bulkWrite(operations, { ordered: false });
      }
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to save seen job IDs:', err.message || err);
    }
  }

  /**
   * Load sent job history from ats_sent_history collection
   * @returns {Promise<Set<string>>}
   */
  async loadSentHistory() {
    try {
      const collection = await this._getCollection(this.collections.ATS_SENT_HISTORY);
      const docs = await collection.find({}).toArray();
      const jobIds = new Set(docs.map(doc => String(doc._id)));
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:loadSentHistory:OK',{count:jobIds.size,sampleIds:Array.from(jobIds).slice(0,5)},'H1');
      // #endregion
      return jobIds;
    } catch (err) {
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:loadSentHistory:CATCH',{error:err.message||String(err)},'H1');
      // #endregion
      console.error('MongoStorageAdapter: Failed to load sent history:', err.message || err);
      return new Set();
    }
  }

  /**
   * Persist sent job history to ats_sent_history collection
   * @param {Set<string>} ids
   * @param {Object} metadata - Optional metadata
   * @returns {Promise<void>}
   */
  async persistSentHistory(ids, metadata = {}) {
    if (!ids || ids.size === 0) {
      return;
    }

    try {
      const collection = await this._getCollection(this.collections.ATS_SENT_HISTORY);
      const now = new Date();
      
      // Use bulk write for efficiency
      const operations = Array.from(ids).map(jobId => ({
        updateOne: {
          filter: { _id: jobId },
          update: {
            $set: {
              _id: jobId,
              sentAt: now,
              ...metadata,
            },
            $setOnInsert: {
              createdAt: now,
            },
          },
          upsert: true,
        },
      }));

      if (operations.length > 0) {
        const result = await collection.bulkWrite(operations, { ordered: false });
        // #region agent log
        _dbgLog('MongoStorageAdapter.js:persistSentHistory:OK',{opsCount:operations.length,upsertedCount:result.upsertedCount,modifiedCount:result.modifiedCount,matchedCount:result.matchedCount},'H4');
        // #endregion
      }
    } catch (err) {
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:persistSentHistory:CATCH',{error:err.message||String(err),idsCount:ids?ids.size:0},'H4');
      // #endregion
      console.error('MongoStorageAdapter: Failed to persist sent history:', err.message || err);
      // FIX 2: FAIL-FAST — throw so orchestrator knows persistence failed
      throw err;
    }
  }

  /**
   * Load companies from companies collection
   * Note: This assumes companies have been pre-seeded into the collection.
   * No CSV/JSON parsing is performed.
   * @returns {Promise<Array<Object>>}
   */
  async loadCompanies() {
    try {
      const collection = await this._getCollection(this.collections.COMPANIES);
      const companies = await collection.find({ enabled: { $ne: false } }).toArray();
      
      // Convert MongoDB documents to plain objects, ensuring _id is converted to id
      return companies.map(doc => {
        const company = { ...doc };
        // Convert _id to id for consistency with file-based format
        if (company._id) {
          company.id = String(company._id);
          delete company._id;
        }
        return company;
      });
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to load companies:', err.message || err);
      return [];
    }
  }

  /**
   * Ensure TTL indexes on calibration and summary collections.
   * Called once on first connection. Non-blocking.
   * @returns {Promise<void>}
   */
  async _ensureTTLIndexes() {
    try {
      const rejCol = await this._getCollection(this.collections.CALIBRATION_REJECTED);
      const sumCol = await this._getCollection(this.collections.RUN_SUMMARIES);

      // 60-day TTL for calibration_rejected
      await rejCol.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 60 * 24 * 60 * 60, background: true }
      );
      // 30-day TTL for run_summaries
      await sumCol.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, background: true }
      );
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:_ensureTTLIndexes:OK',{calibrationRejectedTTL:'60d',runSummariesTTL:'30d'},'FIX1');
      // #endregion
      console.log('MongoStorageAdapter: TTL indexes ensured (calibration_rejected=60d, run_summaries=30d)');
    } catch (err) {
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:_ensureTTLIndexes:CATCH',{error:err.message||String(err)},'FIX1');
      // #endregion
      console.warn('MongoStorageAdapter: TTL index creation warning:', err.message || err);
    }
  }

  /**
   * Strip a job object to lightweight calibration metadata.
   * Removes raw API responses, HTML descriptions, and embedded objects.
   * @param {Object} job - Any job-like object
   * @returns {Object} Lightweight { jobId, title, companyName, location, url, reason, source }
   */
  _stripJobForCalibration(job) {
    return {
      jobId: job.jobId || undefined,
      title: job.title || undefined,
      companyName: job.companyName || job.companyId || job.sourceCompanyId || undefined,
      location: job.location || undefined,
      url: job.url || undefined,
      reason: job.reason || undefined,
      source: job.source || undefined,
    };
  }

  /**
   * Write a run log entry to run_logs or run_summaries collection.
   *
   * Production optimization:
   *   - type 'raw' and 'runtime' are SKIPPED entirely (these bloated the DB).
   *   - type 'summary' is redirected to the run_summaries collection (with TTL).
   *
   * @param {Object} entry - { type, source, timestamp, payload }
   * @returns {Promise<void>}
   */
  async writeRunLog(entry) {
    const { type, source, timestamp, payload } = entry;
    
    if (!type || !source) {
      console.warn('MongoStorageAdapter: writeRunLog requires type and source');
      return;
    }

    // FIX 1: Production — completely skip noisy log types that bloat the DB
    if (process.env.NODE_ENV === 'production' && (type === 'raw' || type === 'runtime')) {
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:writeRunLog:SKIPPED',{type,source,reason:'production_gate'},'FIX1');
      // #endregion
      return;
    }

    try {
      // Redirect summaries to dedicated TTL-indexed collection
      const collectionName = type === 'summary'
        ? this.collections.RUN_SUMMARIES
        : this.collections.RUN_LOGS;

      const collection = await this._getCollection(collectionName);
      const now = new Date();
      
      // Generate a unique runId if not provided (based on timestamp)
      const runId = timestamp || now.toISOString();
      
      await collection.insertOne({
        runId,
        source,
        type,
        timestamp: timestamp ? new Date(timestamp) : now,
        payload,
        createdAt: now,
      });
    } catch (err) {
      // Logging is non-critical, so we don't throw
      console.error('MongoStorageAdapter: Failed to write run log:', err.message || err);
    }
  }

  /**
   * Write enriched jobs array to enriched_jobs collection
   * @param {Array<Object>} jobs
   * @param {string} source - 'linkedin' or 'ats'
   * @returns {Promise<void>}
   */
  async writeEnrichedJobs(jobs, source = 'unknown') {
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return;
    }

    try {
      const collection = await this._getCollection(this.collections.ENRICHED_JOBS);
      const now = new Date();
      
      // Insert jobs with metadata
      const documents = jobs.map(job => ({
        ...job,
        source,
        enrichedAt: now,
        createdAt: now,
      }));

      // Use insertMany for batch insert
      if (documents.length > 0) {
        await collection.insertMany(documents, { ordered: false });
      }
    } catch (err) {
      // Logging is non-critical, so we don't throw
      console.error('MongoStorageAdapter: Failed to write enriched jobs:', err.message || err);
    }
  }

  /**
   * Write lightweight REJECTED job data to calibration_rejected collection.
   * All raw/HTML/description fields are stripped — only metadata is persisted.
   * Collection has a 60-day TTL index.
   *
   * @param {Array<Object>} jobs - Array of job-like objects (any shape)
   * @returns {Promise<void>}
   */
  async writeCalibrationRejected(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return;

    try {
      const collection = await this._getCollection(this.collections.CALIBRATION_REJECTED);
      const now = new Date();

      const docs = jobs.map(job => ({
        ...this._stripJobForCalibration(job),
        createdAt: now,
      }));

      await collection.insertMany(docs, { ordered: false });
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:writeCalibrationRejected:OK',{count:docs.length},'FIX1');
      // #endregion
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to write calibration rejected:', err.message || err);
    }
  }

  /**
   * Write lightweight PASSED job data to calibration_passed collection.
   * All raw/HTML/description fields are stripped — only metadata is persisted.
   *
   * @param {Array<Object>} jobs - Array of job-like objects (any shape)
   * @returns {Promise<void>}
   */
  async writeCalibrationPassed(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return;

    try {
      const collection = await this._getCollection(this.collections.CALIBRATION_PASSED);
      const now = new Date();

      const docs = jobs.map(job => ({
        ...this._stripJobForCalibration(job),
        createdAt: now,
      }));

      await collection.insertMany(docs, { ordered: false });
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:writeCalibrationPassed:OK',{count:docs.length},'FIX1');
      // #endregion
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to write calibration passed:', err.message || err);
    }
  }

  /**
   * Close the MongoDB connection
   * Should be called when the adapter is no longer needed (e.g., on process exit)
   * @returns {Promise<void>}
   */
  async close() {
    if (this.client && this.connected) {
      try {
        await this.client.close();
        this.connected = false;
        this.db = null;
        console.log('MongoStorageAdapter: Connection closed');
      } catch (err) {
        console.error('MongoStorageAdapter: Error closing connection:', err.message || err);
      }
    }
  }
}

module.exports = { MongoStorageAdapter };

