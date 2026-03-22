/**
 * Exactly-once quota emergency alert via atomic GCS object creation (ifGenerationMatch: 0).
 * Winner sends email; losers get HTTP 412 and skip.
 */

const { Storage } = require('@google-cloud/storage');
const { sendCriticalAlert } = require('../../mailer');

const DEFAULT_FLAG_PATH = 'flags/quota-alert-sent.flag';

/** @type {Storage|null} */
let _storage = null;

function getStorage() {
  if (!_storage) {
    _storage = new Storage();
  }
  return _storage;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isQuotaExhaustedError(err) {
  if (!err || typeof err !== 'object') return false;
  const e = /** @type {{ code?: unknown, codeName?: unknown, message?: unknown }} */ (err);
  if (e.code === 8000) return true;
  if (String(e.codeName || '') === 'AtlasError' && /quota/i.test(String(e.message || ''))) {
    return true;
  }
  return false;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isPreconditionFailed(err) {
  if (!err) return false;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  if (code === 412) return true;
  if (String(code) === '412') return true;
  const msg = String(/** @type {{ message?: unknown }} */ (err).message || '');
  if (/412|Precondition Failed|conditionNotMet/i.test(msg)) return true;
  return false;
}

/**
 * @param {unknown} err
 * @returns {Promise<void>}
 */
async function handleQuotaExhaustion(err) {
  console.error(
    'FATAL: MongoDB Atlas M0 quota exceeded (error 8000). DB may reject writes.'
  );

  const bucketName = process.env.GCS_LOCK_BUCKET && String(process.env.GCS_LOCK_BUCKET).trim();
  if (!bucketName) {
    console.error(
      'gcsAlertManager: GCS_LOCK_BUCKET is not set; cannot atomically gate emergency email. Skipping alert.'
    );
    return;
  }

  const flagPath = process.env.GCS_QUOTA_ALERT_FLAG_PATH || DEFAULT_FLAG_PATH;
  const bucket = getStorage().bucket(bucketName);
  const flagFile = bucket.file(flagPath);

  const payload = JSON.stringify({
    sentAt: new Date().toISOString(),
    errorCode: /** @type {{ code?: unknown }} */ (err).code,
    errorMessage: String(/** @type {{ message?: unknown }} */ (err).message || err),
    pid: process.pid,
  });

  try {
    await flagFile.save(Buffer.from(payload, 'utf8'), {
      contentType: 'application/json; charset=utf-8',
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });

    await sendCriticalAlert(
      {
        type: 'QUOTA_EXHAUSTED',
        errorCode: 8000,
        message:
          'MongoDB Atlas M0 storage quota exceeded (512MB). All writes are blocked.',
        action:
          'Manual intervention: purge data in Atlas or upgrade tier. Then delete gs://' +
          bucketName +
          '/' +
          flagPath +
          ' to re-arm the alert.',
        timestamp: new Date().toISOString(),
      },
      'FATAL: JobBot MongoDB Quota Exhausted'
    );
    console.log('gcsAlertManager: emergency quota alert email sent (atomic flag created).');
  } catch (gcsErr) {
    if (isPreconditionFailed(gcsErr)) {
      console.log(
        'gcsAlertManager: quota alert flag already exists (412). Another instance sent the email. Skipping.'
      );
      return;
    }
    console.error(
      'gcsAlertManager: unexpected error during atomic flag / alert:',
      /** @type {{ message?: unknown }} */ (gcsErr).message || gcsErr
    );
  }
}

module.exports = {
  isQuotaExhaustedError,
  handleQuotaExhaustion,
  DEFAULT_FLAG_PATH,
};
