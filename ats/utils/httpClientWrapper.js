/**
 * Enhanced HTTP client wrapper with retry, backoff, and cooldown logic
 * Supports provider-specific rate limiting and error handling
 */

const { createComeetRateLimiter } = require('./rateLimiter');

// Provider-specific rate limiters (singleton per provider)
const rateLimiters = {
  comeet: null,
};

/**
 * Get or create rate limiter for provider
 */
function getRateLimiter(provider) {
  if (provider === 'comeet') {
    if (!rateLimiters.comeet) {
      rateLimiters.comeet = createComeetRateLimiter();
    }
    return rateLimiters.comeet;
  }
  return null;
}

/**
 * Calculate exponential backoff with jitter
 */
function exponentialBackoff(attempt, baseMs, maxMs) {
  const exponential = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
  const jitter = Math.random() * 0.3 * exponential; // 0-30% jitter
  return Math.round(exponential + jitter);
}

/**
 * Extract Retry-After header value (seconds)
 */
function getRetryAfterSeconds(response) {
  if (!response || !response.headers) return null;
  const retryAfter = response.headers['retry-after'] || response.headers['Retry-After'];
  if (!retryAfter) return null;
  const seconds = parseInt(retryAfter, 10);
  return isNaN(seconds) ? null : seconds;
}

/**
 * Enhanced request with retry, backoff, and rate limiting
 */
async function requestWithRetry(httpClient, config, options = {}) {
  const {
    provider = null,
    maxRetries = 0,
    retryOn429 = true,
    retryOn5xx = false,
    retryOnTimeout = false,
    retryOnNetwork = false,
  } = options;

  let lastError = null;
  let lastResponse = null;
  let attempt = 0;

  // Rate limiting (if provider specified)
  const rateLimiter = provider ? getRateLimiter(provider) : null;

  while (attempt <= maxRetries) {
    try {
      // Apply rate limiting before request
      if (rateLimiter) {
        await rateLimiter.waitIfNeeded();
      }

      // Make request
      const response = await httpClient.requestWithDelay(config);

      // Success (2xx)
      if (response.status >= 200 && response.status < 300) {
        return { response, attempt, retried: attempt > 0 };
      }

      // Handle specific status codes
      const status = response.status;

      // 429: Rate limit - retry with backoff
      if (status === 429 && retryOn429 && attempt < maxRetries) {
        const retryAfter = getRetryAfterSeconds(response);
        const backoffMs = retryAfter
          ? retryAfter * 1000 + Math.random() * 2000 // Add jitter
          : exponentialBackoff(attempt + 1, 15000, 120000); // 15s, 30s, 60s, 120s cap

        // eslint-disable-next-line no-console
        console.warn(
          `[${provider || 'HTTP'}] Rate limited (429), retrying after ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        attempt++;
        lastResponse = response;
        continue;
      }

      // 5xx: Server error - optional retry
      if (status >= 500 && status < 600 && retryOn5xx && attempt < maxRetries) {
        const backoffMs = exponentialBackoff(attempt + 1, 5000, 30000); // 5s, 10s, 20s, 30s cap
        // eslint-disable-next-line no-console
        console.warn(
          `[${provider || 'HTTP'}] Server error (${status}), retrying after ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        attempt++;
        lastResponse = response;
        continue;
      }

      // Other status codes - no retry
      return { response, attempt, retried: attempt > 0 };

    } catch (error) {
      lastError = error;

      // Timeout - optional retry
      if (error.code === 'ECONNABORTED' && retryOnTimeout && attempt < maxRetries) {
        const backoffMs = exponentialBackoff(attempt + 1, 5000, 20000); // 5s, 10s, 20s cap
        // eslint-disable-next-line no-console
        console.warn(
          `[${provider || 'HTTP'}] Request timeout, retrying after ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        attempt++;
        continue;
      }

      // Network error - optional retry
      if (!error.response && retryOnNetwork && attempt < maxRetries) {
        const backoffMs = exponentialBackoff(attempt + 1, 5000, 20000);
        // eslint-disable-next-line no-console
        console.warn(
          `[${provider || 'HTTP'}] Network error, retrying after ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        attempt++;
        continue;
      }

      // No retry or max retries reached
      throw error;
    }
  }

  // Max retries reached
  if (lastResponse) {
    return { response: lastResponse, attempt, retried: true };
  }
  throw lastError || new Error('Max retries reached');
}

/**
 * Convenience wrapper to adapt the shared httpClient into a simple
 * requestWithDelay(config) function for workers.
 * Enhanced with retry/backoff support for Comeet provider.
 */
function requestWithDelayWrapper(httpClient, options = {}) {
  const {
    provider = null,
    enableRetries = false,
    maxRetries = 0,
  } = options;

  if (
    httpClient &&
    typeof httpClient.requestWithDelay === 'function'
  ) {
    if (enableRetries && provider === 'comeet') {
      // Enhanced wrapper with retry logic for Comeet
      return async (config) => {
        const result = await requestWithRetry(httpClient, config, {
          provider: 'comeet',
          maxRetries,
          retryOn429: true,
          retryOn5xx: true,
          retryOnTimeout: true,
          retryOnNetwork: false, // Network errors usually not worth retrying
        });
        return result.response;
      };
    }
    if (enableRetries && provider === 'greenhouse') {
      return async (config) => {
        const result = await requestWithRetry(httpClient, config, {
          provider: 'greenhouse',
          maxRetries: maxRetries || 1,
          retryOn429: true,
          retryOn5xx: true,
          retryOnTimeout: true,
          retryOnNetwork: false,
        });
        return result.response;
      };
    }
    // Standard wrapper without retries (but still uses rate limiting if provider specified)
    if (provider === 'comeet') {
      // Even without retries, apply rate limiting
      const rateLimiter = getRateLimiter('comeet');
      return async (config) => {
        if (rateLimiter) {
          await rateLimiter.waitIfNeeded();
        }
        return httpClient.requestWithDelay(config);
      };
    }
    // No provider specified - standard behavior
    return (config) => httpClient.requestWithDelay(config);
  }

  // Fallback: call the underlying client without delay if wrapper is misconfigured.
  const client = httpClient && httpClient.client ? httpClient.client : httpClient;
  return (config) => client.request(config);
}

module.exports = {
  requestWithDelayWrapper,
  requestWithRetry,
  getRateLimiter,
};
