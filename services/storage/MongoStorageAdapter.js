/**
 * MongoStorageAdapter - MongoDB Atlas storage implementation
 * 
 * Implements the StorageAdapter interface using MongoDB native driver.
 * Designed for cloud deployment on Google Cloud Run Jobs.
 */

const { MongoClient } = require('mongodb');
const { StorageAdapter } = require('./StorageAdapter');

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
    };
    
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
      return jobIds;
    } catch (err) {
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
        await collection.bulkWrite(operations, { ordered: false });
      }
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to persist sent history:', err.message || err);
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
   * Write a run log entry to run_logs collection
   * @param {Object} entry - { type, source, timestamp, payload }
   * @returns {Promise<void>}
   */
  async writeRunLog(entry) {
    const { type, source, timestamp, payload } = entry;
    
    if (!type || !source) {
      console.warn('MongoStorageAdapter: writeRunLog requires type and source');
      return;
    }

    try {
      const collection = await this._getCollection(this.collections.RUN_LOGS);
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

