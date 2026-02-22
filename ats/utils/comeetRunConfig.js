/**
 * Centralized configuration for Comeet run settings
 * Handles batch pause configuration from env vars and CLI args
 */

/**
 * Parse batch pause configuration from env vars
 * @returns {Object} Batch pause config
 */
function parseBatchPauseConfig() {
  const enabled = process.env.COMEET_BATCH_PAUSE_ENABLED !== 'false'; // Default: true
  const batchSize = parseInt(process.env.COMEET_BATCH_SIZE || '12', 10);
  const pauseMinMs = parseInt(process.env.COMEET_BATCH_PAUSE_MIN_MS || '20000', 10);
  const pauseMaxMs = parseInt(process.env.COMEET_BATCH_PAUSE_MAX_MS || '30000', 10);

  return {
    enabled: enabled && batchSize > 0 && pauseMinMs > 0 && pauseMaxMs >= pauseMinMs,
    batchSize: Math.max(1, batchSize),
    pauseMinMs: Math.max(0, pauseMinMs),
    pauseMaxMs: Math.max(pauseMinMs, pauseMaxMs),
  };
}

/**
 * Merge CLI args into batch pause config
 * @param {Object} baseConfig - Base config from env vars
 * @param {Object} cliOverrides - CLI argument overrides
 * @returns {Object} Merged config
 */
function mergeBatchPauseConfig(baseConfig, cliOverrides = {}) {
  const merged = { ...baseConfig };

  if (cliOverrides.batchSize !== undefined) {
    merged.batchSize = Math.max(1, parseInt(cliOverrides.batchSize, 10));
  }
  if (cliOverrides.batchPauseMinMs !== undefined) {
    merged.pauseMinMs = Math.max(0, parseInt(cliOverrides.batchPauseMinMs, 10));
  }
  if (cliOverrides.batchPauseMaxMs !== undefined) {
    merged.pauseMaxMs = Math.max(merged.pauseMinMs, parseInt(cliOverrides.batchPauseMaxMs, 10));
  }
  if (cliOverrides.noBatchPause !== undefined) {
    merged.enabled = !cliOverrides.noBatchPause;
  }

  // Re-validate enabled state
  if (merged.enabled && (merged.batchSize <= 0 || merged.pauseMinMs <= 0 || merged.pauseMaxMs < merged.pauseMinMs)) {
    merged.enabled = false;
  }

  return merged;
}

/**
 * Random delay helper for batch pause
 * @param {number} minMs - Minimum delay in milliseconds
 * @param {number} maxMs - Maximum delay in milliseconds
 * @returns {Promise<void>}
 */
function randomDelay(minMs, maxMs) {
  const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

module.exports = {
  parseBatchPauseConfig,
  mergeBatchPauseConfig,
  randomDelay,
};

