/**
 * MongoStorageAdapter - MongoDB Atlas storage implementation
 * 
 * Implements the StorageAdapter interface using MongoDB native driver.
 * Designed for cloud deployment on Google Cloud Run Jobs.
 */

const { MongoClient } = require('mongodb');
const { StorageAdapter } = require('./StorageAdapter');
// #region agent log
const _dbgLog = (m, d, h) => { try { require('fs').appendFileSync(require('path').join(__dirname, '..', '..', '.cursor', 'debug.log'), JSON.stringify({ location: m, data: d, hypothesisId: h, timestamp: Date.now() }) + '\n'); } catch (_) { } };
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
      CALIBRATION_REJECTED: 'calibration_rejected',
      CALIBRATION_PASSED: 'calibration_passed',
      RUN_SUMMARIES: 'run_summaries',
      SYSTEM_STATE: 'system_state',
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
   * Public collection access for calibration aggregations.
   * @param {string} collectionName
   * @returns {Promise<Collection>}
   */
  async getCollection(collectionName) {
    return this._getCollection(collectionName);
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
              source: 'linkedin',
              lastSeenAt: now,
            },
            $setOnInsert: {
              firstSeenAt: now,
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
      _dbgLog('MongoStorageAdapter.js:loadSentHistory:OK', { count: jobIds.size, sampleIds: Array.from(jobIds).slice(0, 5) }, 'H1');
      // #endregion
      return jobIds;
    } catch (err) {
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:loadSentHistory:CATCH', { error: err.message || String(err) }, 'H1');
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
              lastUpdatedAt: now,
              ...metadata,
            },
            $setOnInsert: {
              sentAt: now,
              createdAt: now,
            },
          },
          upsert: true,
        },
      }));

      if (operations.length > 0) {
        const result = await collection.bulkWrite(operations, { ordered: false });
        // #region agent log
        _dbgLog('MongoStorageAdapter.js:persistSentHistory:OK', { opsCount: operations.length, upsertedCount: result.upsertedCount, modifiedCount: result.modifiedCount, matchedCount: result.matchedCount }, 'H4');
        // #endregion
      }
    } catch (err) {
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:persistSentHistory:CATCH', { error: err.message || String(err), idsCount: ids ? ids.size : 0 }, 'H4');
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
      const passCol = await this._getCollection(this.collections.CALIBRATION_PASSED);
      const sumCol = await this._getCollection(this.collections.RUN_SUMMARIES);
      const seenCol = await this._getCollection(this.collections.SEEN_JOBS);
      const sentCol = await this._getCollection(this.collections.ATS_SENT_HISTORY);

      // 60-day TTL for calibration_rejected + support for aggregation match/sort on gate/createdAt
      await rejCol.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 60 * 24 * 60 * 60, background: true }
      );
      await rejCol.createIndex(
        { gate: 1, createdAt: -1 },
        { background: true }
      );
      // 60-day TTL for calibration_passed (prevents unbounded growth)
      await passCol.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 60 * 24 * 60 * 60, background: true }
      );
      // 30-day TTL for run_summaries
      await sumCol.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, background: true }
      );
      // 90-day TTL for seen_jobs (bounds LinkedIn dedup memory). Risk: jobs >90d may reappear as "new".
      // Legacy docs without createdAt do not expire until backfilled.
      await seenCol.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, background: true }
      );
      // 180-day TTL for ats_sent_history (bounds ATS dedup). Risk: jobs older than TTL can be re-emailed if reposted; monitor duplicate rate.
      await sentCol.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 180 * 24 * 60 * 60, background: true }
      );
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:_ensureTTLIndexes:OK', { calibrationRejectedTTL: '60d', calibrationPassedTTL: '60d', runSummariesTTL: '30d', seenJobsTTL: '90d', atsSentHistoryTTL: '180d' }, 'FIX1');
      // #endregion
      console.log('MongoStorageAdapter: TTL indexes ensured (calibration_rejected=60d, calibration_passed=60d, run_summaries=30d, seen_jobs=90d, ats_sent_history=180d)');
    } catch (err) {
      // #region agent log
      _dbgLog('MongoStorageAdapter.js:_ensureTTLIndexes:CATCH', { error: err.message || String(err) }, 'FIX1');
      // #endregion
      console.warn('MongoStorageAdapter: TTL index creation warning:', err.message || err);
    }
  }

  /**
   * Strip a job object to lightweight calibration metadata.
   * Removes raw API responses, HTML descriptions, and embedded objects.
   * Preserves observability fields for calibration aggregation (gate, matchedKeywords, etc.).
   * @param {Object} job - Any job-like object
   * @returns {Object} Lightweight calibration record with core + observability fields
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
      // Observability fields for calibration report aggregation
      gate: job.gate || undefined,
      matchedKeywords: Array.isArray(job.matchedKeywords) ? job.matchedKeywords : undefined,
      matchedBlacklistPatterns: Array.isArray(job.matchedBlacklistPatterns) ? job.matchedBlacklistPatterns : undefined,
      structuredLevel: job.structuredLevel || undefined,
      structuredDepartment: job.structuredDepartment || undefined,
      matchedLocationKeyword: job.matchedLocationKeyword || undefined,
      employmentType: job.employmentType || undefined,
      fallbackTier: job.fallbackTier != null ? job.fallbackTier : undefined,
    };
  }

  /**
   * Aggregated view of rejected jobs for calibration reporting.
   * Groups by title + reason + gate and returns counts plus sample companies.
   * @param {number} limit - Max number of grouped signatures to return
   * @returns {Promise<Array<{title:string,reason:string,gate:string,count:number,latestCreatedAt:Date,sampleCompanies:string[]}>>}
   */
  async getCalibrationRejectedAggregated(limit = 1000) {
    const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(Number(limit), 5000)
      : 1000;

    const rejCol = await this._getCollection(this.collections.CALIBRATION_REJECTED);

    const pipeline = [
      {
        $match: {
          $and: [
            { $or: [{ gate: { $nin: ['location'] } }, { gate: { $exists: false } }] },
            { reason: { $not: /^Location/i } },
          ],
        },
      },
      {
        $project: {
          title: { $ifNull: ['$title', 'Unknown'] },
          reason: { $ifNull: ['$reason', 'N/A'] },
          gate: { $ifNull: ['$gate', 'unknown'] },
          companyName: {
            $ifNull: [
              '$companyName',
              { $ifNull: ['$companyId', { $ifNull: ['$sourceCompanyId', 'N/A'] }] },
            ],
          },
          createdAt: { $ifNull: ['$createdAt', new Date(0)] },
        },
      },
      {
        $group: {
          _id: {
            title: '$title',
            reason: '$reason',
            gate: '$gate',
          },
          count: { $sum: 1 },
          latestCreatedAt: { $max: '$createdAt' },
          sampleCompaniesSet: { $addToSet: '$companyName' },
        },
      },
      {
        $project: {
          _id: 0,
          title: '$_id.title',
          reason: '$_id.reason',
          gate: '$_id.gate',
          count: 1,
          latestCreatedAt: 1,
          sampleCompanies: { $slice: ['$sampleCompaniesSet', 3] },
        },
      },
      { $sort: { count: -1, latestCreatedAt: -1 } },
      { $limit: safeLimit },
    ];

    return rejCol.aggregate(pipeline).toArray();
  }

  /**
   * Write a run log entry. Only type 'summary' is persisted to MongoDB (run_summaries).
   * Any other type (runtime, error, raw, filtered) returns immediately without writing.
   *
   * @param {Object} entry - { type, source, timestamp, payload }
   * @returns {Promise<void>}
   */
  async writeRunLog(entry) {
    const { type, source, timestamp, payload } = entry;

    if (type !== 'summary') {
      return; // Only summaries are persisted to MongoDB
    }

    if (!source) {
      console.warn('MongoStorageAdapter: writeRunLog requires source');
      return;
    }

    try {
      const collection = await this._getCollection(this.collections.RUN_SUMMARIES);
      const now = new Date();
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
      console.error('MongoStorageAdapter: Failed to write run log:', err.message || err);
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
      _dbgLog('MongoStorageAdapter.js:writeCalibrationRejected:OK', { count: docs.length }, 'FIX1');
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
      _dbgLog('MongoStorageAdapter.js:writeCalibrationPassed:OK', { count: docs.length }, 'FIX1');
      // #endregion
    } catch (err) {
      console.error('MongoStorageAdapter: Failed to write calibration passed:', err.message || err);
    }
  }

  /**
   * Logical database footprint for Atlas M0 quota alignment (dbStats).
   * Uses dataSize + indexSize (ignores compressed storageSize).
   * @returns {Promise<number>} size in bytes, or 0 on error
   */
  async getDbQuotaBytes() {
    try {
      await this._ensureConnected();
      const stats = await this.db.command({ dbStats: 1 });
      const dataSize = Number(stats.dataSize) || 0;
      const indexSize = Number(stats.indexSize) || 0;
      const total = dataSize + indexSize;
      console.log(
        `MongoStorageAdapter: dbStats dataSize=${dataSize}, indexSize=${indexSize}, total=${total}`
      );
      return total;
    } catch (err) {
      console.warn('MongoStorageAdapter: getDbQuotaBytes failed:', err.message || err);
      return 0;
    }
  }

  /**
   * @deprecated Prefer getDbQuotaBytes(); alias returns same as getDbQuotaBytes for compatibility.
   * @returns {Promise<number>}
   */
  async getDbSizeBytes() {
    return this.getDbQuotaBytes();
  }

  /**
   * Volume-based cleanup protocol (Master PRD). Supports explicit modes:
   * - aggressive: delete ALL documents from calibration_rejected and calibration_passed (mandatory when volume threshold exceeded).
   * - retention24h: delete records older than 24h from both calibration collections.
   * - legacy7d: delete calibration_rejected >7d only (legacy behavior).
   * Also drops zombie collections (run_logs, enriched_jobs) and prunes old run_summaries.
   * @param {{ mode?: 'aggressive' | 'retention24h' | 'legacy7d' }} [options] - defaults to legacy7d
   * @returns {Promise<{ purgedRejected: number, purgedPassed: number, purgedRunSummaries: number, droppedCollections: string[] }>}
   */
  async runVolumeCleanupProtocol(options = {}) {
    const mode = options.mode || 'legacy7d';
    const result = {
      purgedRejected: 0,
      purgedPassed: 0,
      purgedRunSummaries: 0,
      droppedCollections: [],
    };

    await this._ensureConnected();
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const rejCol = await this._getCollection(this.collections.CALIBRATION_REJECTED);
    const passCol = await this._getCollection(this.collections.CALIBRATION_PASSED);

    if (mode === 'aggressive') {
      const rejResult = await rejCol.deleteMany({});
      const passResult = await passCol.deleteMany({});
      result.purgedRejected = rejResult.deletedCount || 0;
      result.purgedPassed = passResult.deletedCount || 0;
    } else if (mode === 'retention24h') {
      const rejFilter = { $or: [{ createdAt: { $lte: twentyFourHoursAgo } }, { createdAt: { $exists: false } }] };
      const passFilter = { $or: [{ createdAt: { $lte: twentyFourHoursAgo } }, { createdAt: { $exists: false } }] };
      const rejResult = await rejCol.deleteMany(rejFilter);
      const passResult = await passCol.deleteMany(passFilter);
      result.purgedRejected = rejResult.deletedCount || 0;
      result.purgedPassed = passResult.deletedCount || 0;
    } else {
      const rejResult = await rejCol.deleteMany({ createdAt: { $lt: sevenDaysAgo } });
      result.purgedRejected = rejResult.deletedCount || 0;
    }

    const zombieNames = ['run_logs', 'enriched_jobs'];
    const collections = await this.db.listCollections().toArray();
    const names = collections.map((c) => c.name);
    for (const z of zombieNames) {
      if (names.includes(z)) {
        await this.db.collection(z).drop();
        result.droppedCollections.push(z);
      }
    }

    const sumCol = await this._getCollection(this.collections.RUN_SUMMARIES);
    const sumResult = await sumCol.deleteMany({ createdAt: { $lt: thirtyDaysAgo } });
    result.purgedRunSummaries = sumResult.deletedCount || 0;

    return result;
  }

  /**
   * Get the last successful calibration timestamp from system_state.
   * @returns {Promise<Date>} Last calibration date, or epoch (1970) if never run.
   */
  async getLastCalibrationTime() {
    try {
      const col = await this._getCollection(this.collections.SYSTEM_STATE);
      const doc = await col.findOne({ _id: 'calibration_timer' });
      return doc && doc.lastCalibrationAt instanceof Date
        ? doc.lastCalibrationAt
        : new Date(0);
    } catch (err) {
      console.warn('MongoStorageAdapter: getLastCalibrationTime failed:', err.message || err);
      return new Date(0);
    }
  }

  /**
   * Update the last calibration timestamp to now. Called after a successful calibration run.
   * @returns {Promise<void>}
   */
  async updateLastCalibrationTime() {
    try {
      const col = await this._getCollection(this.collections.SYSTEM_STATE);
      await col.updateOne(
        { _id: 'calibration_timer' },
        { $set: { lastCalibrationAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.warn('MongoStorageAdapter: updateLastCalibrationTime failed:', err.message || err);
    }
  }

  /**
   * Acquire distributed calibration lock. Only one process may hold the lock; stale locks (expiresAt <= now) are stolen.
   * @param {{ ownerId: string, ttlMs?: number }} options - ownerId required; ttlMs defaults to 15 minutes
   * @returns {Promise<{ acquired: boolean, ownerId?: string, expiresAt?: Date, lockDoc?: Object }>}
   */
  async acquireCalibrationLock(options = {}) {
    const { ownerId, ttlMs = 15 * 60 * 1000 } = options;
    if (!ownerId || typeof ownerId !== 'string') {
      return { acquired: false };
    }
    await this._ensureConnected();
    const col = await this._getCollection(this.collections.SYSTEM_STATE);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await col.updateOne(
      { _id: 'calibration_lock' },
      { $setOnInsert: { isLocked: false, updatedAt: now } },
      { upsert: true }
    );
    const filter = {
      _id: 'calibration_lock',
      $or: [
        { isLocked: { $ne: true } },
        { expiresAt: { $lte: now } },
      ],
    };
    const update = {
      $set: {
        isLocked: true,
        ownerId,
        lockedAt: now,
        expiresAt,
        updatedAt: now,
      },
    };
    const doc = await col.findOneAndUpdate(filter, update, {
      returnDocument: 'after',
    });
    if (!doc) {
      return { acquired: false };
    }
    const acquired = doc.ownerId === ownerId && doc.isLocked === true;
    if (acquired) {
      console.log(`MongoStorageAdapter: Calibration lock acquired by ${ownerId}, expiresAt=${expiresAt.toISOString()}`);
    }
    return {
      acquired,
      ownerId: doc.ownerId,
      expiresAt: doc.expiresAt,
      lockDoc: doc,
    };
  }

  /**
   * Release calibration lock. Only the current owner may release (enforced by filter).
   * @param {{ ownerId: string }} options
   * @returns {Promise<boolean>} true if lock was released by this owner
   */
  async releaseCalibrationLock(options = {}) {
    const { ownerId } = options;
    if (!ownerId) return false;
    await this._ensureConnected();
    const col = await this._getCollection(this.collections.SYSTEM_STATE);
    const now = new Date();
    const result = await col.findOneAndUpdate(
      { _id: 'calibration_lock', ownerId, isLocked: true },
      { $set: { isLocked: false, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const released = !!result && result.isLocked === false;
    if (released) {
      console.log(`MongoStorageAdapter: Calibration lock released by ${ownerId}`);
    }
    return released;
  }

  /**
   * Upsert a company document into the companies collection.
   * Uses company.id as the MongoDB _id for idempotent inserts.
   * @param {Object} company - Company object with at least { id, name, type }
   * @returns {Promise<void>}
   */
  async upsertCompany(company) {
    if (!company || !company.id) {
      throw new Error('upsertCompany requires a company with an id field');
    }

    try {
      const collection = await this._getCollection(this.collections.COMPANIES);
      const now = new Date();

      const doc = {
        id: company.id,
        name: company.name,
        type: company.type,
        enabled: company.enabled !== undefined ? company.enabled : true,
        updatedAt: now,
      };

      // Copy ATS-specific fields if present
      if (company.uid) doc.uid = company.uid;
      if (company.token) doc.token = company.token;
      if (company.url) doc.url = company.url;
      if (company.addedBy) doc.addedBy = company.addedBy;

      await collection.updateOne(
        { _id: company.id },
        {
          $set: doc,
          $setOnInsert: { addedAt: now },
        },
        { upsert: true }
      );
    } catch (err) {
      console.error(`MongoStorageAdapter: Failed to upsert company '${company.id}':`, err.message || err);
      throw err;
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

