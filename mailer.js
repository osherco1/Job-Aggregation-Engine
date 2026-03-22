require('dotenv').config();

const nodemailer = require('nodemailer');

/**
 * Safely escape HTML entities to prevent rendering issues.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return 'N/A';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a timestamp (ms since epoch) or ISO string into a readable date.
 */
function formatDate(value) {
  if (!value) return 'N/A';
  try {
    const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (Number.isNaN(d.getTime())) return 'N/A';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'N/A';
  }
}

/**
 * Format a timestamp into a relative "age" string, e.g. "3h ago" or "2d ago".
 */
function formatRelativeAge(value) {
  if (!value) return 'N/A';
  try {
    const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (Number.isNaN(d.getTime())) return 'N/A';

    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 0) return 'just now';

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays >= 1) {
      return `${diffDays}d ago`;
    }
    return `${diffHours || 0}h ago`;
  } catch {
    return 'N/A';
  }
}

/**
 * Create a nodemailer transport using Gmail and environment credentials.
 */
function createTransport() {
  const { JOBBOT_SMTP_USER, JOBBOT_SMTP_PASS } = process.env;

  if (!JOBBOT_SMTP_USER || !JOBBOT_SMTP_PASS) {
    throw new Error(
      'Missing JOBBOT_SMTP_USER or JOBBOT_SMTP_PASS in environment. Please add them to your .env file.'
    );
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: JOBBOT_SMTP_USER,
      pass: JOBBOT_SMTP_PASS,
    },
  });
}

/**
 * Send an HTML email report containing a table of jobs.
 * @param {Array<Object>} jobs - Enriched job objects from the scraper.
 */
async function sendJobReport(jobs) {
  const jobList = Array.isArray(jobs) ? jobs : [];

  if (jobList.length === 0) {
    console.log('sendJobReport: No jobs provided, skipping email.');
    return;
  }

  const { JOBBOT_SMTP_USER, JOBBOT_TO_EMAIL } = process.env;
  const toAddress = JOBBOT_TO_EMAIL || JOBBOT_SMTP_USER;

  if (!toAddress) {
    throw new Error(
      'No recipient email configured. Set JOBBOT_SMTP_USER (and optionally JOBBOT_TO_EMAIL) in your .env file.'
    );
  }

  const transporter = createTransport();

  const cardsHtml = jobList
    .map((job) => {
      const title = escapeHtml(job.title || 'N/A');
      const employmentType = job.employmentType
        ? escapeHtml(job.employmentType)
        : '';
      const titleWithType = employmentType
        ? `${title} (${employmentType})`
        : title;
      const company = escapeHtml(job.company || 'N/A');
      const location = escapeHtml(job.location || 'N/A');
      // Prefer listedAt (GraphQL) as the "Posted At" source; if missing,
      // fall back to the search card's postedAt value.
      const postedAtSource = job.listedAt || job.postedAt;
      const postedAtRelative = postedAtSource
        ? formatRelativeAge(postedAtSource)
        : 'N/A';
      const postedLabel = postedAtSource
        ? `Posted ${postedAtRelative}`
        : 'Posted date unknown';

      const easyApply = job.applyMethodEasyApply === true;
      const appliesCount =
        typeof job.appliesCount === 'number' ? job.appliesCount : null;

      // Header tags: Easy Apply (green) and Applicants (blue), if present.
      const headerTags = [];
      if (easyApply) {
        headerTags.push(
          `<span style="display:inline-block;margin-right:6px;padding:2px 8px;border-radius:999px;background-color:#daf5d5;color:#0b7a26;font-size:11px;font-weight:600;">⚡ Easy Apply</span>`
        );
      }
      if (appliesCount && Number.isFinite(appliesCount) && appliesCount > 0) {
        headerTags.push(
          `<span style="display:inline-block;margin-right:6px;padding:2px 8px;border-radius:999px;background-color:#e3f2ff;color:#0a66c2;font-size:11px;font-weight:600;">👥 ${escapeHtml(
            String(appliesCount)
          )} Applicants</span>`
        );
      }

      const headerTagsHtml = headerTags.length
        ? `<div style="margin-top:4px;">${headerTags.join('')}</div>`
        : '';

      // Workplace hint: still useful but secondary; infer from explicit types or location.
      let workplaceLabel = '';
      if (Array.isArray(job.workplaceTypes) && job.workplaceTypes.length > 0) {
        const types = job.workplaceTypes.map((t) => String(t).toLowerCase());
        if (types.some((t) => t.includes('remote'))) workplaceLabel = 'Remote';
        if (types.some((t) => t.includes('hybrid'))) workplaceLabel = 'Hybrid';
        if (
          types.some((t) => t.includes('on-site') || t.includes('onsite'))
        )
          workplaceLabel = 'On-site';
      } else if (job.location) {
        const locLower = String(job.location).toLowerCase();
        if (locLower.includes('remote')) workplaceLabel = 'Remote';
        else if (locLower.includes('hybrid')) workplaceLabel = 'Hybrid';
        else if (locLower.includes('on-site') || locLower.includes('onsite'))
          workplaceLabel = 'On-site';
      }

      const workplaceHtml = workplaceLabel
        ? `<div style="font-size:12px;color:#555;margin-top:2px;">🏢 ${escapeHtml(
            workplaceLabel
          )}</div>`
        : '';

      const skillsArray = Array.isArray(job.skills)
        ? job.skills.filter(Boolean)
        : [];
      const skillsPreview = skillsArray.slice(0, 5);
      const skillsHtml = skillsPreview.length
        ? `<div style="margin-top:8px;font-size:12px;color:#555;">
             <div style="font-weight:600;margin-bottom:2px;">Key Skills</div>
             <ul style="margin:0 0 0 18px;padding:0;">
               ${skillsPreview
                 .map(
                   (s) =>
                     `<li style="margin:0 0 2px 0;">${escapeHtml(String(s))}</li>`
                 )
                 .join('')}
             </ul>
           </div>`
        : '';

      // Recruiter section: name and profile link if we have them.
      const recruiter =
        job && typeof job.recruiter === 'object' ? job.recruiter : null;
      const recruiterFirst = recruiter?.firstName || '';
      const recruiterLast = recruiter?.lastName || '';
      const recruiterName = [recruiterFirst, recruiterLast]
        .filter(Boolean)
        .join(' ');
      const recruiterProfileUrl = recruiter?.profileUrl || job.recruiterUrl;

      let recruiterLine = 'Recruiter: Not listed';
      if (recruiterName && recruiterProfileUrl) {
        recruiterLine = `Recruiter: ${recruiterName} - <a href="${escapeHtml(
          recruiterProfileUrl
        )}" style="color:#0a66c2;text-decoration:none;">Profile</a>`;
      } else if (recruiterName) {
        recruiterLine = `Recruiter: ${recruiterName}`;
      } else if (recruiterProfileUrl) {
        recruiterLine = `Recruiter: <a href="${escapeHtml(
          recruiterProfileUrl
        )}" style="color:#0a66c2;text-decoration:none;">Profile</a>`;
      }

      const recruiterHtml = `<div style="margin-top:6px;font-size:12px;color:#555;">👤 ${recruiterLine}</div>`;

      const linkHref = job.applyUrl || job.url || null;
      const linkCell = linkHref
        ? `<a href="${escapeHtml(
            linkHref
          )}" style="display:inline-block;padding:6px 12px;background-color:#0a66c2;color:#ffffff;text-decoration:none;border-radius:4px;font-size:13px;">Apply</a>`
        : 'N/A';

      const applyButton = linkCell ? linkCell : '';

      return `
        <div style="border:1px solid #dddddd;border-radius:6px;padding:12px 14px;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:15px;font-weight:bold;color:#0a66c2;">${titleWithType}</div>
              <div style="font-size:13px;color:#444;margin-top:2px;">${company}</div>
              <div style="font-size:12px;color:#666;margin-top:2px;">${location}</div>
              ${workplaceHtml}
            </div>
            <div style="text-align:right;font-size:12px;color:#666;">
              <div>${escapeHtml(postedLabel)}</div>
              ${headerTagsHtml}
            </div>
          </div>
          ${recruiterHtml}
          ${skillsHtml}
          <div style="margin-top:10px;">${applyButton}</div>
        </div>
      `;
    })
    .join('');

  const html = `
    <html>
      <body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333333;margin:0;padding:16px;background-color:#f6f6f6;">
        <div style="max-width:800px;margin:0 auto;background-color:#ffffff;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden;">
          <div style="padding:12px 16px;border-bottom:1px solid #e0e0e0;background-color:#0a66c2;color:#ffffff;">
            <h2 style="margin:0;font-size:18px;">LinkedIn Job Bot - Daily Report</h2>
            <p style="margin:4px 0 0 0;font-size:13px;opacity:0.9;">
              ${jobList.length} new job${jobList.length === 1 ? '' : 's'} found
            </p>
          </div>
          <div style="padding:16px;">
            ${cardsHtml}
            <p style="margin-top:16px;font-size:12px;color:#777777;">
              This report was generated automatically by your local LinkedIn Job Bot.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  const subject = `LinkedIn Job Bot - ${jobList.length} new job${
    jobList.length === 1 ? '' : 's'
  } found`;

  try {
    const info = await transporter.sendMail({
      from: JOBBOT_SMTP_USER || toAddress,
      to: toAddress,
      subject,
      html,
    });

    console.log('sendJobReport: email sent, messageId:', info.messageId);
  } catch (err) {
    // Nodemailer typically uses code "EAUTH" with a responseCode of 535 for bad auth
    const code = err && (err.responseCode || err.code);
    console.error('sendJobReport: failed to send email:', err.message || err);

    if (code === 535 || String(code) === '535') {
      console.error('Authentication error (535). Check your App Password in .env');
    }

    throw err;
  }
}

/**
 * Send a minimal, high-priority alert email when the bot detects a critical
 * authentication failure (e.g. LinkedIn redirecting to a challenge / captcha).
 * This reuses the same SMTP configuration as the regular job report.
 * @param {object|string} details - Optional diagnostic details to include.
 * @param {string} [subjectOverride] - Optional subject line (e.g. quota emergency).
 */
async function sendCriticalAlert(details, subjectOverride) {
  const { JOBBOT_SMTP_USER, JOBBOT_TO_EMAIL } = process.env;
  const toAddress = JOBBOT_TO_EMAIL || JOBBOT_SMTP_USER;

  if (!toAddress) {
    console.error(
      'sendCriticalAlert: No recipient email configured. Set JOBBOT_SMTP_USER (and optionally JOBBOT_TO_EMAIL) in your .env file.'
    );
    return;
  }

  const transporter = createTransport();
  const timestamp = new Date().toISOString();

  const detailsPayload =
    typeof details === 'string'
      ? details
      : JSON.stringify(details || {}, null, 2);

  const resolvedSubject =
    subjectOverride ||
    'JobBot CRITICAL ALERT: LinkedIn Auth Challenge Detected';
  const text = `A critical alert was raised by JobBot.

Time (UTC): ${timestamp}

Details:
${detailsPayload}
`;

  try {
    const info = await transporter.sendMail({
      from: JOBBOT_SMTP_USER || toAddress,
      to: toAddress,
      subject: resolvedSubject,
      text,
    });

    console.log('sendCriticalAlert: email sent, messageId:', info.messageId);
  } catch (err) {
    console.error(
      'sendCriticalAlert: failed to send alert email:',
      err.message || err
    );
  }
}

module.exports = {
  sendJobReport,
  sendCriticalAlert,
};


