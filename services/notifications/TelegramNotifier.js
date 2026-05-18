/**
 * TelegramNotifier - Unified push notification service via Telegram Bot API.
 *
 * Mirrors the public contract of services/EmailNotifier.js:
 *   - sendUnifiedReport(jobs, errors) -> Promise<boolean> (never throws)
 *
 * Message shape: one HTML summary message followed by one HTML card per job.
 * Each card carries an inline keyboard "Apply" URL button.
 * Outbound calls are paced by a module-scope Bottleneck limiter (~1.1s minTime).
 */

require('dotenv').config();
const axios = require('axios');
const Bottleneck = require('bottleneck');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_CHARS = 4096;
const SAFE_BODY_CHARS = 3500;

const SOURCE_LABELS = {
    linkedin: '🔗 LinkedIn',
    comeet: '🟢 Comeet',
    greenhouse: '🌿 Greenhouse',
    workday: '🏢 Workday',
};

function mapToLegacyFormat(job) {
    const sourceLabel = SOURCE_LABELS[job.source] || job.source || 'Unknown';

    return {
        title: `[${sourceLabel}] ${job.title || 'Untitled'}`,
        company: job.companyName || job.company || job.sourceCompanyId || 'Unknown Company',
        location: job.location || 'Unknown Location',
        url: job.url || job.applyUrl || null,
        applyUrl: job.applyUrl || job.url || null,
        postedAt: job.postedAt || job.listedAt || null,
        listedAt: job.listedAt || job.postedAt || null,
        employmentType: job.employmentType || null,
        skills: job.skills || null,
        recruiter: job.recruiter || null,
        recruiterUrl: job.recruiterUrl || null,
        applyMethodEasyApply: job.applyMethodEasyApply || false,
        appliesCount: job.appliesCount || null,
        workplaceTypes: job.workplaceTypes || null,
        _originalSource: job.source,
    };
}

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

const tgClient = axios.create({
    baseURL: TELEGRAM_API_BASE,
    timeout: 15000,
    validateStatus: () => true,
});

const limiter = new Bottleneck({ minTime: 1100, maxConcurrent: 1 });

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatRelativeAge(value) {
    if (!value) return null;
    try {
        const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
        if (Number.isNaN(d.getTime())) return null;
        const diffMs = Date.now() - d.getTime();
        if (diffMs < 0) return 'just now';
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays >= 1) return `${diffDays}d ago`;
        return `${diffHours || 0}h ago`;
    } catch {
        return null;
    }
}

function truncate(str, max) {
    if (!str) return '';
    if (str.length <= max) return str;
    return str.slice(0, max - 3) + '...';
}

function buildSummaryHtml(mappedJobs, errors) {
    const jobCount = mappedJobs.length;
    const errCount = errors.length;

    const header = jobCount > 0
        ? `🤖 <b>Job Bot Report</b> — ${jobCount} new job${jobCount === 1 ? '' : 's'}`
        : `🤖 <b>Job Bot Report</b> — 📭 No new jobs`;

    const lines = [header];

    if (jobCount > 0) {
        const counts = {};
        for (const job of mappedJobs) {
            const src = job._originalSource || 'unknown';
            counts[src] = (counts[src] || 0) + 1;
        }
        const sourceParts = Object.entries(counts).map(([src, n]) => {
            const label = SOURCE_LABELS[src] || src;
            return `${label}: ${n}`;
        });
        if (sourceParts.length > 0) {
            lines.push(`<i>Sources:</i> ${escapeHtml(sourceParts.join(' | '))}`);
        }
    }

    if (errCount > 0) {
        lines.push('');
        lines.push(`⚠️ <b>Errors (${errCount})</b>`);
        for (const err of errors) {
            const source = escapeHtml(err.source || 'Unknown');
            const message = escapeHtml(truncate(err.message || 'Unknown error', 200));
            lines.push(`• <b>${source}:</b> ${message}`);
        }
    } else if (jobCount === 0) {
        lines.push('');
        lines.push('<i>All sources were checked but no new matching positions were discovered.</i>');
    }

    return truncate(lines.join('\n'), MAX_MESSAGE_CHARS);
}

function buildJobCardHtml(job) {
    const title = escapeHtml(job.title || 'Untitled');
    const company = escapeHtml(job.company || 'Unknown company');
    const location = escapeHtml(job.location || 'Unknown location');

    const lines = [`<b>${title}</b>`];
    lines.push(`🏢 ${company}`);
    lines.push(`📍 ${location}`);

    const postedSource = job.listedAt || job.postedAt;
    const rel = postedSource ? formatRelativeAge(postedSource) : null;
    if (rel) {
        lines.push(`🕒 Posted ${escapeHtml(rel)}`);
    }

    const tags = [];
    if (job.applyMethodEasyApply === true) tags.push('⚡ Easy Apply');
    if (typeof job.appliesCount === 'number' && job.appliesCount > 0) {
        tags.push(`👥 ${job.appliesCount} applicants`);
    }
    if (job.employmentType) tags.push(escapeHtml(String(job.employmentType)));
    if (tags.length > 0) {
        lines.push(tags.join(' • '));
    }

    if (Array.isArray(job.skills) && job.skills.length > 0) {
        const skills = job.skills.filter(Boolean).slice(0, 5).map((s) => escapeHtml(String(s)));
        if (skills.length > 0) {
            lines.push(`🛠 <i>Skills:</i> ${skills.join(', ')}`);
        }
    }

    const recruiter = job && typeof job.recruiter === 'object' ? job.recruiter : null;
    const recruiterName = recruiter
        ? [recruiter.firstName, recruiter.lastName].filter(Boolean).join(' ')
        : '';
    const recruiterUrl = (recruiter && recruiter.profileUrl) || job.recruiterUrl;
    if (recruiterName && recruiterUrl) {
        lines.push(`👤 Recruiter: <a href="${escapeHtml(recruiterUrl)}">${escapeHtml(recruiterName)}</a>`);
    } else if (recruiterName) {
        lines.push(`👤 Recruiter: ${escapeHtml(recruiterName)}`);
    } else if (recruiterUrl) {
        lines.push(`👤 Recruiter: <a href="${escapeHtml(recruiterUrl)}">Profile</a>`);
    }

    return truncate(lines.join('\n'), SAFE_BODY_CHARS);
}

function buildInlineKeyboard(job) {
    const url = job.applyUrl || job.url;
    if (!url) return null;
    return { inline_keyboard: [[{ text: '🔗 Apply', url }]] };
}

function parseRetryAfter(response) {
    const fromBody = response && response.data && response.data.parameters && response.data.parameters.retry_after;
    if (typeof fromBody === 'number' && fromBody > 0) return fromBody;
    const header = response && response.headers && (response.headers['retry-after'] || response.headers['Retry-After']);
    const parsed = parseInt(header, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
}

class TelegramNotifier {
    constructor() {
        this._sendOne = this._sendOne.bind(this);
    }

    async _callSendMessage(token, payload) {
        return tgClient.post(`/bot${token}/sendMessage`, payload);
    }

    async _sendOne(token, payload) {
        const attempt = async () => this._callSendMessage(token, payload);

        let response = await limiter.schedule(attempt);

        if (response.status === 429) {
            const retryAfter = parseRetryAfter(response) || 1;
            console.warn(`TelegramNotifier: 429 Too Many Requests — sleeping ${retryAfter}s then retrying once`);
            await sleep(retryAfter * 1000);
            response = await limiter.schedule(attempt);
        }

        if (response.status >= 200 && response.status < 300 && response.data && response.data.ok === true) {
            return true;
        }

        const description = response && response.data && response.data.description;
        throw new Error(
            `Telegram sendMessage failed: status=${response.status} ${description || ''}`.trim()
        );
    }

    async sendUnifiedReport(jobs, errors = []) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        if (!token || !chatId) {
            console.error('TelegramNotifier: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing from environment');
            return false;
        }

        const jobList = Array.isArray(jobs) ? jobs : [];
        const errorList = Array.isArray(errors) ? errors : [];
        const mappedJobs = jobList.map(mapToLegacyFormat);

        try {
            await this._sendOne(token, {
                chat_id: chatId,
                text: buildSummaryHtml(mappedJobs, errorList),
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });

            for (const job of mappedJobs) {
                const payload = {
                    chat_id: chatId,
                    text: buildJobCardHtml(job),
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                };
                const keyboard = buildInlineKeyboard(job);
                if (keyboard) payload.reply_markup = keyboard;
                await this._sendOne(token, payload);
            }

            console.log(`TelegramNotifier: report sent (${mappedJobs.length} job message${mappedJobs.length === 1 ? '' : 's'}, ${errorList.length} error${errorList.length === 1 ? '' : 's'})`);
            return true;
        } catch (err) {
            console.error('TelegramNotifier: Failed to send report:', err.message || err);
            return false;
        }
    }
}

function createTelegramNotifier() {
    return new TelegramNotifier();
}

module.exports = {
    TelegramNotifier,
    createTelegramNotifier,
};
