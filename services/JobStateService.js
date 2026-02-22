/**
 * JobStateService - Deduplication system for ATS jobs
 * 
 * Maintains a history of job IDs that have been sent via email.
 * Prevents duplicate notifications across runs.
 * 
 * Storage: data/ats_sent_jobs_history.json
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'ats_sent_jobs_history.json');

class JobStateService {
    constructor() {
        this.sentJobIds = new Set();
        this.newJobIds = new Set(); // IDs added in current run (pending commit)
        this.loaded = false;
    }

    /**
     * Load sent job history from disk
     */
    loadHistory() {
        if (this.loaded) return;

        try {
            if (fs.existsSync(HISTORY_FILE)) {
                const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
                const data = JSON.parse(raw);

                if (data && Array.isArray(data.sentJobIds)) {
                    this.sentJobIds = new Set(data.sentJobIds);
                    console.log(`JobStateService: Loaded ${this.sentJobIds.size} job IDs from history`);
                }
            } else {
                console.log('JobStateService: No history file found, starting fresh');
            }
        } catch (err) {
            console.error('JobStateService: Failed to load history:', err.message);
            this.sentJobIds = new Set();
        }

        this.loaded = true;
    }

    /**
     * Filter jobs to only return NEW jobs (not in history)
     * Updates internal state with new job IDs (pending commit)
     * 
     * @param {Array} jobs - Array of job objects with jobId field
     * @returns {Array} - Only jobs that haven't been sent before
     */
    filterNewJobs(jobs) {
        if (!this.loaded) {
            this.loadHistory();
        }

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
     * Commit pending new job IDs to history and persist to disk
     * Should only be called after successful email notification
     */
    persistState() {
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

        // Ensure directory exists
        const dir = path.dirname(HISTORY_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Save to disk
        try {
            const data = {
                lastUpdated: new Date().toISOString(),
                totalCount: this.sentJobIds.size,
                sentJobIds: Array.from(this.sentJobIds),
            };

            fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
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

// Singleton instance
const jobStateService = new JobStateService();

module.exports = {
    JobStateService,
    jobStateService,
};
