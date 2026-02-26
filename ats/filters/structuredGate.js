'use strict';

const SENIORITY_RE = /\b(senior|lead|staff|principal|director|executive|manager|head\sof|vp\b|vice\spresident)\b/i;
const STUDENT_RE = /\b(student|internship|intern)\b/i;

/**
 * Fast-track filtering using structured fields embedded in the raw ATS payload.
 * This runs BEFORE the regex-based ATS Guard so we can short-circuit cheaply.
 *
 * @param {Object} job  - Normalized UnifiedJob (must include `structuredSignals`)
 * @param {string} source - ATS source identifier ('comeet', 'greenhouse', 'workday')
 * @returns {{ verdict: 'FAIL'|'WHITELIST'|'CONTINUE', reason?: string }}
 */
function evaluateStructuredGate(job, source) {
    const signals = job && job.structuredSignals;

    if (source === 'comeet' && signals) {
        const expLevel = (signals.experience_level || '').trim();
        const empType = (signals.employment_type || '').trim();

        if (expLevel && SENIORITY_RE.test(expLevel)) {
            return { verdict: 'FAIL', reason: `structured_seniority:${expLevel}` };
        }

        if (empType && STUDENT_RE.test(empType)) {
            return { verdict: 'WHITELIST', reason: `structured_student:${empType}` };
        }
    }

    return { verdict: 'CONTINUE' };
}

module.exports = { evaluateStructuredGate };
