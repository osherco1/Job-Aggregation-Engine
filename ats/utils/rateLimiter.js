/**
 * Rate limiter utility for enforcing minimum intervals between requests
 * Implements a simple token bucket-style limiter with min interval enforcement
 */

class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.lastRequestTime = 0;
  }

  /**
   * Wait if necessary to enforce minimum interval since last request
   * @returns {Promise<void>}
   */
  async waitIfNeeded() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Reset the limiter (useful for testing or after long cooldowns)
   */
  reset() {
    this.lastRequestTime = 0;
  }
}

/**
 * Create a rate limiter for Comeet API
 * Default: 9-11 seconds randomized interval (5.5-6.7 RPM)
 * Configurable via COMEET_RATE_LIMIT_MIN_MS and COMEET_RATE_LIMIT_MAX_MS env vars
 */
function createComeetRateLimiter() {
  const minMs = parseInt(process.env.COMEET_RATE_LIMIT_MIN_MS || '9000', 10);
  const maxMs = parseInt(process.env.COMEET_RATE_LIMIT_MAX_MS || '11000', 10);
  // Randomize between minMs and maxMs for natural variation
  const minInterval = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  return new RateLimiter(minInterval);
}

module.exports = {
  RateLimiter,
  createComeetRateLimiter,
};

