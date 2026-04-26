'use strict';

const SENIORITY_RE = /\b(senior|lead|staff|principal|director|executive|manager|head\sof|vp\b|vice\spresident)\b/i;
const STUDENT_RE = /\b(student|internship|intern)\b/i;

// CAR 26-04: junior dev title hints — bypass structured experience_level seniority fail
const JUNIOR_DEV_HINTS = [
  /\bjunior\s+developer\b/i,
  /\bjunior\s+software\s+engineer\b/i,
  /\bintern\s+software\b/i,
  /\bstudent\s+.*\b(engineer|developer)\b/i,
];

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
            const gateTitle = String(
                (job && (job.title || job.name || job.position)) || ''
            ).trim();
            if (JUNIOR_DEV_HINTS.some((re) => re.test(gateTitle))) {
                return {
                    verdict: 'CONTINUE',
                    reason: 'structured_junior_title_bypass',
                };
            }
            return { verdict: 'FAIL', reason: `structured_seniority:${expLevel}` };
        }

        if (empType && STUDENT_RE.test(empType)) {
            // Do not bypass ATS guard for student employment types.
            // Mark for downstream leniency (description check only) and continue.
            try {
                job.isStructuredStudent = true;
            } catch (_) {
                // Best-effort flag only; never fail the gate on mutation issues.
            }
            return { verdict: 'CONTINUE', reason: `structured_student:${empType}` };
        }
    }

    return { verdict: 'CONTINUE' };
}

module.exports = { evaluateStructuredGate };
