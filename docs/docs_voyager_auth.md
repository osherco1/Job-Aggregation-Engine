# LinkedIn Voyager Auth Setup

This project uses the internal **LinkedIn Voyager API** and therefore requires
authenticated cookies and a CSRF token from a real logged‑in browser session.

## 1. Required environment variables

Create a `.env` file in the project root (next to `scraper.js`) with:

```bash
LINKEDIN_LI_AT="your_li_at_cookie_value"
LINKEDIN_JSESSIONID="your_jsessionid_cookie_value"
LINKEDIN_CSRF_TOKEN="your_csrf_token_value"
```

These values are **secrets**. Never commit the actual values to Git.
The `.gitignore` in this repo already ignores `.env`.

## 2. How to capture the values from your browser

1. Open `https://www.linkedin.com/` in Chrome (or another Chromium browser)
   and make sure you are logged in.
2. Open **DevTools → Network** and filter by `voyager` or `jobs`.
3. Click on a jobs search result page and select one of the
   `https://www.linkedin.com/voyager/api/...` requests.
4. In the **Headers** tab:
   - Under **Request Headers**, locate:
     - `cookie` → copy the `li_at` and `JSESSIONID` parts.
     - `csrf-token` (or similar header) → copy its value.
5. Paste them into your `.env` as:
   - `LINKEDIN_LI_AT`
   - `LINKEDIN_JSESSIONID`
   - `LINKEDIN_CSRF_TOKEN`

## 3. Running the scraper

1. Install dependencies:

```bash
npm install
```

2. Run:

```bash
node scraper.js
```

If everything is configured correctly, you should see:

- No `Missing LinkedIn auth config` error.
- No HTTP 401/403 from LinkedIn.
- A JSON array of jobs printed to the console, each with:
  - `jobId`, `title`, `company`, `location`, `date`, `url`.

## 4. Handling cookie / CSRF expiry

LinkedIn periodically expires sessions. Symptoms:

- The script starts failing with HTTP **401** or **403** from the Voyager API.
- The console logs a message like:
  > LinkedIn authentication failed with status 401/403. Please refresh LINKEDIN_LI_AT, LINKEDIN_JSESSIONID, and LINKEDIN_CSRF_TOKEN in your .env from an authenticated browser session.

When this happens:

1. Repeat the capture steps in section 2 to grab **fresh** `li_at`, `JSESSIONID`,
   and CSRF token values from a new browser session.
2. Update `.env` with the new values.
3. Re‑run `node scraper.js`.

You do **not** need to change any code: only refresh the secrets in `.env`.


