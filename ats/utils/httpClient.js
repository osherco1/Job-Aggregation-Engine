const axios = require('axios');

function randomDelay(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  const delay = min + Math.random() * (max - min);
  const delayMs = Math.round(delay);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createHttpClient() {
  const client = axios.create({
    maxRedirects: 0,
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const status = error && error.response ? error.response.status : null;
      if (status === 302 || status === 303) {
        const url = (error.config && error.config.url) || 'N/A';
        // Per-company warning; the worker/orchestrator decides how to handle it.
        // We do not exit the process here.
        // eslint-disable-next-line no-console
        console.warn(
          `ATS redirect detected (status ${status}) for URL: ${url}`
        );
      }
      return Promise.reject(error);
    }
  );

  async function requestWithDelay(config, minDelayMs = 200, maxDelayMs = 500) {
    await randomDelay(minDelayMs, maxDelayMs);
    return client.request(config);
  }

  return {
    client,
    requestWithDelay,
  };
}

module.exports = {
  createHttpClient,
  randomDelay,
};


