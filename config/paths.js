const path = require('path');

// Project root (one level up from config/).
const ROOT = path.resolve(__dirname, '..');

/**
 * Centralized filesystem layout for the job bot.
 *
 * IMPORTANT:
 * - Do NOT introduce generic OUTPUT or LOGS roots here that mix sources.
 * - Always go through PATHS.LINKEDIN.* or PATHS.ATS.* for anything under
 *   output/ or logs/.
 */
const PATHS = {
  ROOT,

  // Shared, non-source-specific helpers (safe for both modules).
  DATA: path.join(ROOT, 'data'),
  DEBUG_ARTIFACTS: path.join(ROOT, 'debug_artifacts'),
  ARCHIVE_ROOT: path.join(ROOT, 'archive'),

  LINKEDIN: {
    OUTPUT: path.join(ROOT, 'output', 'linkedin'),
    LOGS: {
      ROOT: path.join(ROOT, 'logs', 'linkedin'),
      SUMMARIES: path.join(ROOT, 'logs', 'linkedin', 'summaries'),
      FILTERED: path.join(ROOT, 'logs', 'linkedin', 'filtered'),
      // Archive location for LinkedIn logs / outputs managed by archive_logs.js.
      ARCHIVE: path.join(ROOT, 'logs', 'linkedin', 'archive'),
    },
  },

  ATS: {
    OUTPUT: path.join(ROOT, 'output', 'ats'),
    LOGS: {
      ROOT: path.join(ROOT, 'logs', 'ats'),
      SUMMARIES: path.join(ROOT, 'logs', 'ats', 'summaries'),
      FILTERED: path.join(ROOT, 'logs', 'ats', 'filtered'),
      RAW: path.join(ROOT, 'logs', 'ats', 'raw'),
      ARCHIVE: path.join(ROOT, 'logs', 'ats', 'archive'),
      // Provider-specific directories
      COMEET: {
        PRODUCTION: path.join(ROOT, 'logs', 'ats', 'comeet', 'production'),
        DEBUG: path.join(ROOT, 'logs', 'ats', 'comeet', 'debug'),
        // Structured logging subdirectories
        SUMMARIES: path.join(ROOT, 'logs', 'ats', 'comeet', 'summaries'),
        DROPPED: path.join(ROOT, 'logs', 'ats', 'comeet', 'dropped'),
        ERRORS: path.join(ROOT, 'logs', 'ats', 'comeet', 'errors'),
        RAW: path.join(ROOT, 'logs', 'ats', 'comeet', 'raw'),
        // Runtime log for tailing in separate terminal
        RUNTIME_LOG: path.join(ROOT, 'logs', 'ats', 'comeet', 'runtime.log'),
      },
      GREENHOUSE: {
        PRODUCTION: path.join(ROOT, 'logs', 'ats', 'greenhouse', 'production'),
        DEBUG: path.join(ROOT, 'logs', 'ats', 'greenhouse', 'debug'),
        // Structured logging subdirectories
        SUMMARIES: path.join(ROOT, 'logs', 'ats', 'greenhouse', 'summaries'),
        DROPPED: path.join(ROOT, 'logs', 'ats', 'greenhouse', 'dropped'),
        ERRORS: path.join(ROOT, 'logs', 'ats', 'greenhouse', 'errors'),
        RAW: path.join(ROOT, 'logs', 'ats', 'greenhouse', 'raw'),
        // Runtime log for tailing in separate terminal
        RUNTIME_LOG: path.join(ROOT, 'logs', 'ats', 'greenhouse', 'runtime.log'),
      },
    },
  },
};

module.exports = { PATHS };


