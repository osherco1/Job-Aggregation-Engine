/**
 * EmailNotifier - Unified email notification service
 * 
 * Sends consolidated job reports from all sources (LinkedIn, Comeet, Greenhouse).
 * Handles job mapping to legacy format, error summaries, and "no jobs" notifications.
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

// Source labels for email display
const SOURCE_LABELS = {
    linkedin: '🔗 LinkedIn',
    comeet: '🟢 Comeet',
    greenhouse: '🌿 Greenhouse',
};

/**
 * Safely escape HTML entities
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return 'N/A';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Format timestamp to relative age
 */
function formatRelativeAge(value) {
    if (!value) return 'N/A';
    try {
        const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
        if (Number.isNaN(d.getTime())) return 'N/A';

        const now = Date.now();
        const diffMs = now - d.getTime();
        if (diffMs < 0) return 'just now';

        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);

        if (diffDays >= 1) {
            return `${diffDays}d ago`;
        }
        return `${diffHours || 0}h ago`;
    } catch {
        return 'N/A';
    }
}

/**
 * Create nodemailer transport
 */
function createTransport() {
    const { JOBBOT_SMTP_USER, JOBBOT_SMTP_PASS } = process.env;

    if (!JOBBOT_SMTP_USER || !JOBBOT_SMTP_PASS) {
        throw new Error(
            'Missing JOBBOT_SMTP_USER or JOBBOT_SMTP_PASS in environment.'
        );
    }

    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: JOBBOT_SMTP_USER,
            pass: JOBBOT_SMTP_PASS,
        },
    });
}

/**
 * Map unified job to legacy email format
 */
function mapToLegacyFormat(job) {
    const sourceLabel = SOURCE_LABELS[job.source] || job.source || 'Unknown';

    return {
        // Legacy expects these fields
        title: `[${sourceLabel}] ${job.title || 'Untitled'}`,
        company: job.companyName || job.company || job.sourceCompanyId || 'Unknown Company',
        location: job.location || 'Unknown Location',
        url: job.url || job.applyUrl || null,
        applyUrl: job.applyUrl || job.url || null,
        postedAt: job.postedAt || job.listedAt || null,
        listedAt: job.listedAt || job.postedAt || null,
        // Pass through other fields for rich display
        employmentType: job.employmentType || null,
        skills: job.skills || null,
        recruiter: job.recruiter || null,
        recruiterUrl: job.recruiterUrl || null,
        applyMethodEasyApply: job.applyMethodEasyApply || false,
        appliesCount: job.appliesCount || null,
        workplaceTypes: job.workplaceTypes || null,
        // Keep original source for reference
        _originalSource: job.source,
    };
}

/**
 * Generate job card HTML
 */
function generateJobCard(job) {
    const title = escapeHtml(job.title || 'N/A');
    const company = escapeHtml(job.company || 'N/A');
    const location = escapeHtml(job.location || 'N/A');
    const postedAtRelative = job.postedAt ? formatRelativeAge(job.postedAt) : 'N/A';
    const postedLabel = job.postedAt ? `Posted ${postedAtRelative}` : 'Posted date unknown';

    const linkHref = job.applyUrl || job.url || null;
    const applyButton = linkHref
        ? `<a href="${escapeHtml(linkHref)}" style="display:inline-block;padding:6px 12px;background-color:#0a66c2;color:#ffffff;text-decoration:none;border-radius:4px;font-size:13px;">Apply</a>`
        : '';

    return `
    <div style="border:1px solid #dddddd;border-radius:6px;padding:12px 14px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-size:15px;font-weight:bold;color:#0a66c2;">${title}</div>
          <div style="font-size:13px;color:#444;margin-top:2px;">${company}</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">${location}</div>
        </div>
        <div style="text-align:right;font-size:12px;color:#666;">
          <div>${escapeHtml(postedLabel)}</div>
        </div>
      </div>
      <div style="margin-top:10px;">${applyButton}</div>
    </div>
  `;
}

/**
 * Generate error summary HTML
 */
function generateErrorSummary(errors) {
    if (!errors || errors.length === 0) return '';

    const errorRows = errors
        .map(err => {
            const source = escapeHtml(err.source || 'Unknown');
            const message = escapeHtml(err.message || 'Unknown error');
            return `<li><strong>${source}:</strong> ${message}</li>`;
        })
        .join('');

    return `
    <div style="background-color:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 14px;margin-bottom:16px;">
      <div style="font-weight:bold;color:#856404;margin-bottom:8px;">⚠️ Errors During Run (${errors.length})</div>
      <ul style="margin:0;padding-left:20px;color:#856404;font-size:13px;">
        ${errorRows}
      </ul>
    </div>
  `;
}

/**
 * Generate source summary HTML
 */
function generateSourceSummary(jobs) {
    const counts = {};
    for (const job of jobs) {
        const source = job._originalSource || job.source || 'unknown';
        counts[source] = (counts[source] || 0) + 1;
    }

    const parts = Object.entries(counts)
        .map(([source, count]) => {
            const label = SOURCE_LABELS[source] || source;
            return `${label}: ${count}`;
        })
        .join(' | ');

    return parts || 'No jobs';
}

class EmailNotifier {
    constructor() {
        this.transporter = null;
    }

    /**
     * Initialize transporter (lazy)
     */
    getTransporter() {
        if (!this.transporter) {
            this.transporter = createTransport();
        }
        return this.transporter;
    }

    /**
     * Send unified job report
     * Handles: jobs found, no jobs, and error summary
     * 
     * @param {Array} jobs - Array of unified job objects
     * @param {Array} errors - Array of error objects { source, message }
     * @returns {Promise<boolean>} - true if sent successfully
     */
    async sendUnifiedReport(jobs, errors = []) {
        const { JOBBOT_SMTP_USER, JOBBOT_TO_EMAIL } = process.env;
        const toAddress = JOBBOT_TO_EMAIL || JOBBOT_SMTP_USER;

        if (!toAddress) {
            console.error('EmailNotifier: No recipient email configured');
            return false;
        }

        try {
            const transporter = this.getTransporter();
            const jobList = Array.isArray(jobs) ? jobs : [];
            const errorList = Array.isArray(errors) ? errors : [];

            // Map jobs to legacy format
            const mappedJobs = jobList.map(mapToLegacyFormat);

            // Generate email content
            const errorSummaryHtml = generateErrorSummary(errorList);
            const sourceSummary = generateSourceSummary(mappedJobs);

            let subject;
            let bodyContent;

            if (mappedJobs.length > 0) {
                // Case A: Jobs found
                subject = `Job Bot Report - ${mappedJobs.length} new job${mappedJobs.length === 1 ? '' : 's'} found`;

                const cardsHtml = mappedJobs.map(generateJobCard).join('');

                bodyContent = `
          ${errorSummaryHtml}
          <div style="margin-bottom:16px;font-size:13px;color:#555;">
            <strong>Sources:</strong> ${sourceSummary}
          </div>
          ${cardsHtml}
        `;
            } else {
                // Case B: No jobs found
                subject = 'Job Bot Report - No new jobs found today';

                bodyContent = `
          ${errorSummaryHtml}
          <div style="text-align:center;padding:40px 20px;">
            <div style="font-size:48px;margin-bottom:16px;">📭</div>
            <div style="font-size:18px;color:#666;margin-bottom:8px;">No New Jobs Found</div>
            <div style="font-size:14px;color:#888;">
              All sources were checked but no new matching positions were discovered.
            </div>
          </div>
        `;
            }

            const html = `
        <html>
          <body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333333;margin:0;padding:16px;background-color:#f6f6f6;">
            <div style="max-width:800px;margin:0 auto;background-color:#ffffff;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden;">
              <div style="padding:12px 16px;border-bottom:1px solid #e0e0e0;background-color:#0a66c2;color:#ffffff;">
                <h2 style="margin:0;font-size:18px;">🤖 Unified Job Bot Report</h2>
                <p style="margin:4px 0 0 0;font-size:13px;opacity:0.9;">
                  ${mappedJobs.length} new job${mappedJobs.length === 1 ? '' : 's'} | ${errorList.length} error${errorList.length === 1 ? '' : 's'}
                </p>
              </div>
              <div style="padding:16px;">
                ${bodyContent}
                <p style="margin-top:16px;font-size:12px;color:#777777;">
                  This report was generated automatically by your Job Bot orchestrator.
                  <br>Sources: LinkedIn, Comeet, Greenhouse
                </p>
              </div>
            </div>
          </body>
        </html>
      `;

            await transporter.sendMail({
                from: JOBBOT_SMTP_USER || toAddress,
                to: toAddress,
                subject,
                html,
            });

            console.log(`EmailNotifier: Email sent successfully to ${toAddress}`);
            return true;
        } catch (err) {
            console.error('EmailNotifier: Failed to send email:', err.message || err);
            return false;
        }
    }

    /**
     * Send calibration alert with Markdown report as MIME attachment (Master PRD).
     * @param {string} subject - e.g. "System Alert: DB Volume Trigger" or "Weekly Calibration Report"
     * @param {string} reportMd - Full markdown content of the report
     * @param {'volume'|'time'} [triggerType] - volume or time-based trigger
     * @returns {Promise<boolean>}
     */
    async sendCalibrationAlert(subject, reportMd, triggerType = 'time') {
        const { JOBBOT_SMTP_USER, JOBBOT_TO_EMAIL } = process.env;
        const toAddress = JOBBOT_TO_EMAIL || JOBBOT_SMTP_USER;

        if (!toAddress) {
            console.error('EmailNotifier: No recipient email configured');
            return false;
        }

        try {
            const transporter = this.getTransporter();
            const summary = triggerType === 'volume'
                ? 'Database size exceeded the threshold. Cleanup protocol was executed. See attached report.'
                : 'Weekly calibration report. See attached .md file.';

            await transporter.sendMail({
                from: JOBBOT_SMTP_USER || toAddress,
                to: toAddress,
                subject,
                text: summary + '\n\n---\nReport attached as calibration-report.md',
                html: `<p>${escapeHtml(summary)}</p><p>Report attached as <strong>calibration-report.md</strong></p>`,
                attachments: [
                    {
                        filename: 'calibration-report.md',
                        content: Buffer.from(reportMd || '', 'utf8'),
                        contentType: 'text/markdown; charset=utf-8',
                    },
                ],
            });

            console.log(`EmailNotifier: Calibration alert sent to ${toAddress}`);
            return true;
        } catch (err) {
            console.error('EmailNotifier: Failed to send calibration alert:', err.message || err);
            return false;
        }
    }
}

/**
 * Factory function to create an EmailNotifier instance
 * @returns {EmailNotifier}
 */
function createEmailNotifier() {
    return new EmailNotifier();
}

module.exports = {
    EmailNotifier,
    createEmailNotifier,
};
