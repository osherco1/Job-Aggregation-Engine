#!/usr/bin/env bash
# GCS lock bucket + lifecycle (stale lock breaker) + Cloud Run Job env / retries.
# Edit PROJECT_ID, REGION, JOB_NAME, NEW_RECIPIENT_EMAIL before running.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-<your-gcp-project-id>}"
REGION="${REGION:-europe-west1}"
BUCKET_NAME="${GCS_LOCK_BUCKET:-${PROJECT_ID}-jobbot-locks}"
JOB_NAME="${JOB_NAME:-jobbot-runner}"
SCHEDULER_JOB="${SCHEDULER_JOB:-jobbot-runner-trigger}"
NEW_RECIPIENT_EMAIL="${NEW_RECIPIENT_EMAIL:-<new-email-address>}"

echo "Using PROJECT_ID=${PROJECT_ID} REGION=${REGION} BUCKET=${BUCKET_NAME} JOB=${JOB_NAME}"

# ── 1. Create GCS bucket (if not exists) ──
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" &>/dev/null; then
  gcloud storage buckets create "gs://${BUCKET_NAME}" --location="${REGION}"
  echo "Created bucket gs://${BUCKET_NAME}"
else
  echo "Bucket gs://${BUCKET_NAME} already exists"
fi

# ── 2. Object Lifecycle Management: 1-day floor (GCS minimum granularity) ──
# True 1-hour stale-lock recovery is enforced by GcsCalibrationLock's in-app TTL
# (see services/lock/GcsCalibrationLock.js). This lifecycle rule is defense-in-depth.
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

# ── 3. Cloud Run Job: memory, task timeout, retries, env vars (single revision) ──
# task-timeout raised 900s -> 1800s on 2026-09-07: the LinkedIn phase now pulls the
# full 674-job listing in one pass. Steady-state runs are ~140s (down from ~760s),
# but the first run after a dedup reset is a cold start measured at 861s, and the
# orchestrator runs LinkedIn + ATS in the same task. 1800s covers that safely.
gcloud run jobs update "${JOB_NAME}" \
  --region "${REGION}" \
  --memory 1Gi \
  --task-timeout 1800s \
  --max-retries 0 \
  --update-env-vars "GCS_LOCK_BUCKET=${BUCKET_NAME},JOBBOT_TO_EMAIL=${NEW_RECIPIENT_EMAIL}"
echo "Cloud Run Job updated: memory=1Gi, task-timeout=1800s, max-retries=0, env vars set"

# ── 4. Cloud Scheduler HTTP trigger: attempt deadline + retry policy ──
# attemptDeadline=1800s gives Scheduler a 30-minute window (well past the 900s task
# timeout from §3 plus container startup), eliminating silent run drops.
# max-retry-attempts=1 + Cloud Run max-retries=0 prevents the retry-loop fan-out.
if gcloud scheduler jobs describe "${SCHEDULER_JOB}" --location "${REGION}" &>/dev/null; then
  gcloud scheduler jobs update http "${SCHEDULER_JOB}" \
    --location "${REGION}" \
    --attempt-deadline=1800s \
    --max-retry-attempts=1 \
    --max-backoff=60s
  echo "Cloud Scheduler ${SCHEDULER_JOB} updated: attempt-deadline=1800s, max-retry-attempts=1, max-backoff=60s"
else
  echo "WARN: Cloud Scheduler job ${SCHEDULER_JOB} not found in ${REGION}. Create it first, then re-run this script."
fi

# ── 5. Verify ──
echo ""
echo "=== Verification ==="
gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" --format="yaml(spec.template.spec.template.spec.containers[0].resources, spec.template.spec.template.spec.taskTimeout, spec.template.spec.taskCount, spec.template.spec.template.spec.containers[0].env)" || true
gcloud scheduler jobs describe "${SCHEDULER_JOB}" --location "${REGION}" --format="yaml(attemptDeadline, retryConfig)" || true
gcloud storage buckets describe "gs://${BUCKET_NAME}" --format="yaml(lifecycle)" || true
