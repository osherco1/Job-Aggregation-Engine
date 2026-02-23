/**
 * JobStateService - Deduplication system for ATS jobs
 * 
 * Maintains a history of job IDs that have been sent via email.
 * Prevents duplicate notifications across runs.
 * 
 * Uses StorageAdapter for persistence (file-based locally, MongoDB in cloud).
 */

class JobStateService {
    constructor(storageAdapter) {
        if (!storageAdapter) {
            throw new Error('JobStateService requires a storageAdapter parameter');
        }
        this.storageAdapter = storageAdapter;
        this.sentJobIds = new Set();
        this.newJobIds = new Set(); // IDs added in current run (pending commit)
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
            return [];
        }

        const newJobs = [];

        for (const job of jobs) {
            if (!job || !job.jobId) {
                continue;
            }

            const jobId = String(job.jobId);

            // Check if already sent
            if (this.sentJobIds.has(jobId)) {
                continue;
            }

            // Check if already added in this run
            if (this.newJobIds.has(jobId)) {
                continue;
            }

            // This is a new job
            this.newJobIds.add(jobId);
            newJobs.push(job);
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
     * Get statistics
     */
    getStats() {
        return {
            historyCount: this.sentJobIds.size,
            pendingCount: this.newJobIds.size,
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
