/**
 * JobStateService - Deduplication system for ATS jobs
 *
 * Maintains a history of job IDs that have been sent via email.
 * Prevents duplicate notifications across runs.
 * Applies a run-scoped frequency cap: max N jobs per (company, canonical title) per run.
 *
 * Uses StorageAdapter for persistence (file-based locally, MongoDB in cloud).
 */

// #region agent log
const _dbgLog=(m,d,h)=>{try{require('fs').appendFileSync(require('path').join(__dirname,'..', '.cursor','debug.log'),JSON.stringify({location:m,data:d,hypothesisId:h,timestamp:Date.now()})+'\n');}catch(_){}};
// #endregion

const RUN_FREQUENCY_CAP = parseInt(process.env.RUN_FREQUENCY_CAP, 10) >= 1
    ? parseInt(process.env.RUN_FREQUENCY_CAP, 10)
    : 3;

/**
 * Normalize company identifier from job for frequency key.
 * Priority: sourceCompanyId > companyId > companyName > company > 'unknown-company'.
 */
function getCompanyKey(job) {
    if (!job || typeof job !== 'object') return 'unknown-company';
    const raw = job.sourceCompanyId ?? job.companyId ?? job.companyName ?? job.company;
    if (raw == null || typeof raw !== 'string') return 'unknown-company';
    const s = String(raw).trim().toLowerCase();
    return s || 'unknown-company';
}

/**
 * Derive canonical title for frequency-cap key: same role across cities becomes one key.
 * - Lowercase, normalize dashes, collapse whitespace.
 * - Remove trailing location suffix after " - " or " | " (e.g. " - Tokyo", " | Zurich").
 * - Remove bracketed/id fragments like (#12345), (req-123), (job id: 123).
 */
function getCanonicalTitle(title) {
    if (title == null || typeof title !== 'string') return '';
    let s = String(title).trim();
    s = s.replace(/[\u2013\u2014\u2015]/g, '-');
    s = s.replace(/\s*[-|]\s*[^\-|]+$/i, '').trim();
    s = s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ');
    s = s.replace(/#\d+/gi, '').replace(/\breq[- ]?\d+/gi, '');
    s = s.replace(/\s+/g, ' ').trim().toLowerCase();
    return s || '';
}

/**
 * Build frequency key: companyKey__canonicalTitle (used only within a single run).
 */
function getFrequencyKey(job) {
    const companyKey = getCompanyKey(job);
    const canonicalTitle = getCanonicalTitle(job.title);
    return `${companyKey}__${canonicalTitle}`;
}

class JobStateService {
    constructor(storageAdapter) {
        if (!storageAdapter) {
            throw new Error('JobStateService requires a storageAdapter parameter');
        }
        this.storageAdapter = storageAdapter;
        this.sentJobIds = new Set();
        this.newJobIds = new Set(); // IDs added in current run (pending commit)
        this.lastRunInputCount = 0;
        this.lastRunNewCount = 0;
        this.lastRunCappedCount = 0;
        this.lastRunTopCappedKeys = [];
    }

    /**
     * Load sent job history from storage
     * @returns {Promise<void>}
     */
    async loadHistory() {
        try {
            this.sentJobIds = await this.storageAdapter.loadSentHistory();
            console.log(`JobStateService: Loaded ${this.sentJobIds.size} job IDs from history`);
        } catch (err) {
            console.error('JobStateService: Failed to load history:', err.message);
            this.sentJobIds = new Set();
        }
    }

    /**
     * Filter jobs to only return NEW jobs (not in history)
     * Updates internal state with new job IDs (pending commit)
     * 
     * @param {Array} jobs - Array of job objects with jobId field
     * @returns {Promise<Array>} - Only jobs that haven't been sent before
     */
    async filterNewJobs(jobs) {
        // Always load fresh on each invocation (no cached loaded state)
        await this.loadHistory();

        if (!Array.isArray(jobs) || jobs.length === 0) {
            this.lastRunInputCount = 0;
            this.lastRunNewCount = 0;
            this.lastRunCappedCount = 0;
            this.lastRunTopCappedKeys = [];
            return [];
        }

        const newJobs = [];
        const _dupDetails = { alreadySent: 0, alreadyInRun: 0, noJobId: 0, cappedByFrequency: 0 };
        const runFrequencyByKey = new Map();
        const cappedKeysSample = [];

        for (const job of jobs) {
            if (!job || !job.jobId) {
                _dupDetails.noJobId++;
                continue;
            }

            const jobId = String(job.jobId);

            if (this.sentJobIds.has(jobId)) {
                _dupDetails.alreadySent++;
                continue;
            }

            if (this.newJobIds.has(jobId)) {
                _dupDetails.alreadyInRun++;
                continue;
            }

            const freqKey = getFrequencyKey(job);
            const currentCount = runFrequencyByKey.get(freqKey) || 0;
            if (currentCount >= RUN_FREQUENCY_CAP) {
                _dupDetails.cappedByFrequency++;
                if (cappedKeysSample.length < 10) {
                    cappedKeysSample.push(freqKey);
                }
                continue;
            }

            runFrequencyByKey.set(freqKey, currentCount + 1);
            this.newJobIds.add(jobId);
            newJobs.push(job);
        }

        this.lastRunInputCount = jobs.length;
        this.lastRunNewCount = newJobs.length;
        this.lastRunCappedCount = _dupDetails.cappedByFrequency;
        this.lastRunTopCappedKeys = cappedKeysSample;

        // #region agent log
        _dbgLog('JobStateService.js:filterNewJobs',{inputCount:jobs.length,historySize:this.sentJobIds.size,newJobsCount:newJobs.length,dupDetails:_dupDetails,cappedByFrequency:_dupDetails.cappedByFrequency,topCappedKeys:cappedKeysSample,newJobIds:newJobs.map(j=>j.jobId).slice(0,10),historySample:Array.from(this.sentJobIds).slice(0,5)},'H1');
        // #endregion

        if (_dupDetails.cappedByFrequency > 0) {
            console.log(`JobStateService: Frequency cap (${RUN_FREQUENCY_CAP}/company+title): ${_dupDetails.cappedByFrequency} jobs dropped`);
        }
        console.log(`JobStateService: Filtered ${jobs.length} jobs -> ${newJobs.length} new jobs`);
        return newJobs;
    }

    /**
     * Commit pending new job IDs to history and persist to storage
     * Should only be called after successful email notification
     * @returns {Promise<void>}
     */
    async persistState() {
        if (this.newJobIds.size === 0) {
            console.log('JobStateService: No new jobs to persist');
            return;
        }

        // Merge new IDs into sent IDs
        for (const jobId of this.newJobIds) {
            this.sentJobIds.add(jobId);
        }

        const addedCount = this.newJobIds.size;
        this.newJobIds.clear();

        // Persist to storage
        try {
            const metadata = {
                lastUpdated: new Date().toISOString(),
                totalCount: this.sentJobIds.size,
            };

            await this.storageAdapter.persistSentHistory(this.sentJobIds, metadata);
            console.log(`JobStateService: Persisted ${addedCount} new job IDs (total: ${this.sentJobIds.size})`);
        } catch (err) {
            console.error('JobStateService: Failed to persist state:', err.message);
            // FIX 2: FAIL-FAST — propagate error to orchestrator so it doesn't falsely report success
            throw err;
        }
    }

    /**
     * Rollback pending new job IDs (if email failed)
     */
    rollback() {
        if (this.newJobIds.size > 0) {
            console.log(`JobStateService: Rolling back ${this.newJobIds.size} pending job IDs`);
            this.newJobIds.clear();
        }
    }

    /**
     * Get statistics (includes last run frequency-cap metrics)
     */
    getStats() {
        return {
            historyCount: this.sentJobIds.size,
            pendingCount: this.newJobIds.size,
            lastRunInputCount: this.lastRunInputCount,
            lastRunNewCount: this.lastRunNewCount,
            lastRunCappedCount: this.lastRunCappedCount,
            lastRunTopCappedKeys: this.lastRunTopCappedKeys || [],
        };
    }
}

/**
 * Factory function to create a JobStateService instance
 * @param {StorageAdapter} storageAdapter - Storage adapter instance (required)
 * @returns {JobStateService}
 */
function createJobStateService(storageAdapter) {
    return new JobStateService(storageAdapter);
}

module.exports = {
    JobStateService,
    createJobStateService,
};
