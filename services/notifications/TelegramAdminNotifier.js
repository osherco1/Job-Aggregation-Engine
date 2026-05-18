/**
 * TelegramAdminNotifier - Operator / control-plane notifications via Telegram.
 *
 * Public contract:
 *   - sendAlert(severity, title, details)               -> Promise<boolean>  (never throws)
 *   - sendCalibrationAlert(subject, reportMd, triggerType) -> Promise<boolean>  (never throws)
 *
 * Targets ADMIN_CHAT_ID on the shared TELEGRAM_BOT_TOKEN. A dedicated
 * Bottleneck limiter keeps admin alerts from starving behind user job-report bursts.
 */

require('dotenv').config();
const axios = require('axios');
const Bottleneck = require('bottleneck');
const FormData = require('form-data');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_CHARS = 4096;
const SAFE_DETAILS_CHARS = 3500;

const SEVERITY = {
    CRITICAL: { prefix: '\u{1F6A8} <b>[CRITICAL]</b>' },
    WARNING:  { prefix: '⚠️ <b>[WARNING]</b>' },
    INFO:     { prefix: 'ℹ️ <b>[INFO]</b>' },
};

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

function truncate(str, max) {
    if (!str) return '';
    if (str.length <= max) return str;
    return str.slice(0, max - 3) + '...';
}

function parseRetryAfter(response) {
    const fromBody = response && response.data && response.data.parameters && response.data.parameters.retry_after;
    if (typeof fromBody === 'number' && fromBody > 0) return fromBody;
    const header = response && response.headers && (response.headers['retry-after'] || response.headers['Retry-After']);
    const parsed = parseInt(header, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
}

function stringifyDetails(details) {
    if (details === null || details === undefined) return '';
    if (typeof details === 'string') return details;
    try {
        return JSON.stringify(details, null, 2);
    } catch {
        return String(details);
    }
}

function resolveSeverity(severity) {
    const key = String(severity || '').toUpperCase();
    return SEVERITY[key] || SEVERITY.INFO;
}

class TelegramAdminNotifier {
    constructor() {
        this._sendMessageOnce = this._sendMessageOnce.bind(this);
        this._sendDocumentOnce = this._sendDocumentOnce.bind(this);
    }

    _getCreds() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.ADMIN_CHAT_ID;
        if (!token || !chatId) {
            console.error('TelegramAdminNotifier: TELEGRAM_BOT_TOKEN or ADMIN_CHAT_ID missing from environment');
            return null;
        }
        return { token, chatId };
    }

    async _sendMessageOnce(token, payload) {
        const attempt = async () => tgClient.post(`/bot${token}/sendMessage`, payload);
        let response = await limiter.schedule(attempt);
        if (response.status === 429) {
            const retryAfter = parseRetryAfter(response) || 1;
            console.warn(`TelegramAdminNotifier: 429 on sendMessage — sleeping ${retryAfter}s then retrying once`);
            await sleep(retryAfter * 1000);
            response = await limiter.schedule(attempt);
        }
        if (response.status >= 200 && response.status < 300 && response.data && response.data.ok === true) {
            return true;
        }
        const description = response && response.data && response.data.description;
        throw new Error(`Telegram sendMessage failed: status=${response.status} ${description || ''}`.trim());
    }

    async _sendDocumentOnce(token, chatId, buffer, filename, contentType, caption) {
        const buildForm = () => {
            const form = new FormData();
            form.append('chat_id', String(chatId));
            if (caption) {
                form.append('caption', truncate(caption, 1024));
                form.append('parse_mode', 'HTML');
            }
            form.append('document', buffer, {
                filename,
                contentType,
                knownLength: buffer.length,
            });
            return form;
        };

        const attempt = async () => {
            const form = buildForm();
            return tgClient.post(`/bot${token}/sendDocument`, form, {
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
        };

        let response = await limiter.schedule(attempt);
        if (response.status === 429) {
            const retryAfter = parseRetryAfter(response) || 1;
            console.warn(`TelegramAdminNotifier: 429 on sendDocument — sleeping ${retryAfter}s then retrying once`);
            await sleep(retryAfter * 1000);
            response = await limiter.schedule(attempt);
        }
        if (response.status >= 200 && response.status < 300 && response.data && response.data.ok === true) {
            return true;
        }
        const description = response && response.data && response.data.description;
        throw new Error(`Telegram sendDocument failed: status=${response.status} ${description || ''}`.trim());
    }

    async sendAlert(severity, title, details) {
        const creds = this._getCreds();
        if (!creds) return false;

        const { prefix } = resolveSeverity(severity);
        const timestamp = new Date().toISOString();
        const safeTitle = escapeHtml(title || 'Untitled Alert');
        const detailsText = truncate(stringifyDetails(details), SAFE_DETAILS_CHARS);
        const lines = [
            `${prefix} ${safeTitle}`,
            `<i>UTC: ${timestamp}</i>`,
        ];
        if (detailsText) {
            lines.push('');
            lines.push(`<pre>${escapeHtml(detailsText)}</pre>`);
        }
        const text = truncate(lines.join('\n'), MAX_MESSAGE_CHARS);

        try {
            await this._sendMessageOnce(creds.token, {
                chat_id: creds.chatId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            console.log(`TelegramAdminNotifier: alert sent [${String(severity || 'INFO').toUpperCase()}] ${title || ''}`);
            return true;
        } catch (err) {
            console.error('TelegramAdminNotifier: sendAlert failed:', err.message || err);
            return false;
        }
    }

    async sendCalibrationAlert(subject, reportMd, triggerType = 'time') {
        const creds = this._getCreds();
        if (!creds) return false;

        const md = typeof reportMd === 'string' ? reportMd : String(reportMd || '');
        const buffer = Buffer.from(md, 'utf8');
        const timestamp = new Date().toISOString();
        const safeSubject = escapeHtml(subject || 'Calibration Report');
        const safeTrigger = escapeHtml(String(triggerType || 'time'));

        const summary = truncate(
            [
                `\u{1F4CA} <b>${safeSubject}</b>`,
                `<i>Trigger: ${safeTrigger} · UTC: ${timestamp}</i>`,
                'Full report attached.',
            ].join('\n'),
            MAX_MESSAGE_CHARS
        );

        try {
            await this._sendMessageOnce(creds.token, {
                chat_id: creds.chatId,
                text: summary,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        } catch (err) {
            console.error('TelegramAdminNotifier: calibration summary message failed:', err.message || err);
            return false;
        }

        try {
            await this._sendDocumentOnce(
                creds.token,
                creds.chatId,
                buffer,
                'calibration-report.md',
                'text/markdown; charset=utf-8',
                null
            );
            console.log(`TelegramAdminNotifier: calibration report sent (${buffer.length} bytes, trigger=${triggerType})`);
            return true;
        } catch (err) {
            console.error('TelegramAdminNotifier: calibration document upload failed:', err.message || err);
            return false;
        }
    }
}

let _instance = null;
function createTelegramAdminNotifier() {
    if (!_instance) _instance = new TelegramAdminNotifier();
    return _instance;
}

module.exports = {
    TelegramAdminNotifier,
    createTelegramAdminNotifier,
};
