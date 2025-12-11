import traceback
import os

from .config import settings
from .logging_config import setup_logging
from .state_store import init_db, filter_new_jobs, mark_jobs_as_seen
from .email_client import send_email, build_jobs_email
from .linkedin_client import search_jobs

def run_once(logger, dry_run=False):
    logger.info("=== LinkedIn Job Bot - Phase 3 run_once() ===")

    # 1. Init DB
    init_db()
    
    # 2. Validate SMTP config
    smtp_ok = settings.validate_basic()
    if not smtp_ok:
        logger.warning("SMTP config is incomplete. Email sending may fail.")

    # 3. Fetch jobs from LinkedIn client (currently dummy)
    jobs = search_jobs()
    total_count = len(jobs)
    # Logging for search_jobs is handled inside the client as well, but good to have high level log
    logger.info("search_jobs() returned %d jobs.", total_count)

    # 4. Filter new jobs
    # Even in dry run, we want to see what WOULD be new
    new_jobs = filter_new_jobs(jobs)
    logger.info("%d new jobs since last run.", len(new_jobs))

    # 5. Build email
    subject, html_body = build_jobs_email(new_jobs, total_count)

    if dry_run:
        logger.info("[DRY RUN] Skipping email sending and DB update.")
        logger.info("[DRY RUN] Would have sent email with subject: %s", subject)
        logger.info("[DRY RUN] Would have marked %d jobs as seen.", len(new_jobs))
        return

    # 6. Send email (always, even if no new jobs)
    send_email(subject, html_body)

    # 7. Mark new jobs as seen
    if new_jobs:
        mark_jobs_as_seen(new_jobs)
        logger.info("Marked %d new jobs as seen.", len(new_jobs))

    logger.info("run_once() finished successfully.")

def main():
    logger = setup_logging()
    logger.info("JobBot main() started.")

    # Check for DRY RUN mode
    # "true", "1", "yes" are considered True
    dry_run = os.getenv("JOBBOT_DRY_RUN", "false").lower() in ("1", "true", "yes")

    if dry_run:
        logger.info("DRY RUN mode enabled. Will NOT send real emails or modify DB.")

    try:
        run_once(logger, dry_run=dry_run)

    except Exception as e:
        logger.exception("Unhandled exception in main()")

        # Build an error email subject/body
        tb_str = traceback.format_exc()
        subject = "[LinkedIn JobBot] ERROR during job run"
        html_body = f"""
        <html>
          <body>
            <p>An unexpected error occurred in the LinkedIn Job Bot.</p>
            <pre>{tb_str}</pre>
          </body>
        </html>
        """

        # Try to send an error email; swallow errors if SMTP is broken or we are in dry run
        # Wait, requirements say "Attempt to send an error email", but if we are in dry run, 
        # normally we shouldn't send emails. However, if the dry run CRASHES, maybe we should?
        # Requirement 2 says: "In non-dry-run mode, if an unhandled exception occurs..."
        # So we should only send error email if NOT dry run.
        if not dry_run:
            try:
                send_email(subject, html_body)
            except Exception:
                logger.exception("Failed to send error notification email.")
        else:
            logger.info("[DRY RUN] Suppressing error email for exception.")

    finally:
        logger.info("JobBot main() exiting.")

if __name__ == "__main__":
    main()
