#!/usr/bin/env bash
# GCS lock bucket + lifecycle (stale lock breaker) + Cloud Run Job env / retries.
# Edit PROJECT_ID, REGION, JOB_NAME, NEW_RECIPIENT_EMAIL before running.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-<your-gcp-project-id>}"
REGION="${REGION:-europe-west1}"
BUCKET_NAME="${GCS_LOCK_BUCKET:-${PROJECT_ID}-jobbot-locks}"
JOB_NAME="${JOB_NAME:-jobbot-runner}"
NEW_RECIPIENT_EMAIL="${NEW_RECIPIENT_EMAIL:-<new-email-address>}"

echo "Using PROJECT_ID=${PROJECT_ID} REGION=${REGION} BUCKET=${BUCKET_NAME} JOB=${JOB_NAME}"

# ── 1. Create GCS bucket (if not exists) ──
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" &>/dev/null; then
  gcloud storage buckets create "gs://${BUCKET_NAME}" --location="${REGION}"
  echo "Created bucket gs://${BUCKET_NAME}"
else
  echo "Bucket gs://${BUCKET_NAME} already exists"
fi

# ── 2. Object Lifecycle Management: delete objects older than 1 day ──
# Breaks orphaned calibration locks; also expires quota-alert flag for daily re-alert if needed.
LIFECYCLE_FILE="$(mktemp)"
trap 'rm -f "${LIFECYCLE_FILE}"' EXIT
cat > "${LIFECYCLE_FILE}" <<'LIFECYCLE_EOF'
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 1 }
    }
  ]
}
LIFECYCLE_EOF

gcloud storage buckets update "gs://${BUCKET_NAME}" --lifecycle-file="${LIFECYCLE_FILE}"
echo "Lifecycle policy applied: delete objects older than 1 day"

# ── 3. Cloud Run Job env vars ──
gcloud run jobs update "${JOB_NAME}" \
  --region "${REGION}" \
  --update-env-vars "GCS_LOCK_BUCKET=${BUCKET_NAME},JOBBOT_TO_EMAIL=${NEW_RECIPIENT_EMAIL}"
echo "Cloud Run Job env vars updated (GCS_LOCK_BUCKET, JOBBOT_TO_EMAIL)"

# ── 4. Disable task retries ──
gcloud run jobs update "${JOB_NAME}" \
  --region "${REGION}" \
  --max-retries 0
echo "Cloud Run Job max-retries set to 0"

# ── 5. Verify ──
echo ""
echo "=== Verification ==="
gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" --format="yaml(spec.template.spec.containers[0].env)" || true
gcloud storage buckets describe "gs://${BUCKET_NAME}" --format="yaml(lifecycle)" || true
