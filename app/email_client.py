import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import List, Dict, Optional, Tuple
from .config import settings

# Setup logger
logger = logging.getLogger("jobbot")

def send_email(subject: str, html_body: str, text_body: Optional[str] = None) -> None:
    """
    Send an email using SMTP settings from `settings`.
    Uses STARTTLS on the configured port.
    """
    # Validate required settings
    if not all([settings.smtp_host, settings.smtp_user, settings.smtp_pass, settings.to_email]):
        logger.error("Cannot send email. Missing SMTP configuration.")
        return

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = settings.smtp_user
        msg["To"] = settings.to_email

        if text_body:
            msg.attach(MIMEText(text_body, "plain"))
        
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_pass)
            server.send_message(msg)
        
        logger.info(f"Email sent to {settings.to_email}.")

    except Exception:
        logger.exception("Failed to send email.")
        # Do not re-raise, allow flow to continue

def build_jobs_email(new_jobs: List[Dict], total_count: int) -> Tuple[str, str]:
    """
    Build (subject, html_body) for a job digest email.
    """
    new_count = len(new_jobs)
    
    # Subject
    if new_count > 0:
        subject = f"[LinkedIn JobBot] {new_count} new jobs (total {total_count})"
    else:
        subject = f"[LinkedIn JobBot] No new jobs (total {total_count})"
    
    # HTML Body
    html_parts = []
    html_parts.append(f"<h2>Job Search Digest</h2>")
    html_parts.append(f"<p>Total jobs found in this run: <strong>{total_count}</strong></p>")
    html_parts.append(f"<p>New jobs since last run: <strong>{new_count}</strong></p>")
    
    if new_count > 0:
        html_parts.append("<hr>")
        html_parts.append("<h3>New Jobs Found:</h3>")
        html_parts.append("<table border='1' cellpadding='5' style='border-collapse: collapse;'>")
        html_parts.append("<tr><th>Title</th><th>Company</th><th>Location</th><th>Posted</th><th>Link</th></tr>")
        
        for job in new_jobs:
            title = job.get("title", "N/A")
            company = job.get("company", "N/A")
            location = job.get("location", "N/A")
            posted = job.get("posted", "N/A")
            url = job.get("url", "#")
            
            html_parts.append(f"<tr>")
            html_parts.append(f"<td>{title}</td>")
            html_parts.append(f"<td>{company}</td>")
            html_parts.append(f"<td>{location}</td>")
            html_parts.append(f"<td>{posted}</td>")
            html_parts.append(f"<td><a href='{url}'>Apply</a></td>")
            html_parts.append(f"</tr>")
        
        html_parts.append("</table>")
    else:
        html_parts.append("<p>No new jobs since last run.</p>")
        
    html_body = "\n".join(html_parts)
    
    return subject, html_body
