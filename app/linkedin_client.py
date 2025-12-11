import logging
from typing import List, Dict
from .config import settings

# Setup logger
logger = logging.getLogger("jobbot")

def search_jobs() -> List[Dict]:
    """
    Placeholder LinkedIn client.

    In future phases, this function will perform a real LinkedIn job search
    (using either an allowed API or compliant HTML access) and return a list
    of job dicts.

    For NOW (Phase 2), it returns a fixed list of DUMMY jobs to allow us to:
    - Test database state handling.
    - Test email sending.
    - Test orchestration in main.py.

    Each job dict MUST contain at least:
    - job_id (str)
    - title (str)
    - company (str)
    - location (str)
    - posted (str)
    - url (str)
    """
    # Dummy data as requested
    dummy_jobs = [
        {
            "job_id": "12345",
            "title": "Student Software Engineer",
            "company": "Cool Startup",
            "location": "Tel Aviv, Israel",
            "posted": "1 day ago",
            "url": "https://www.linkedin.com/jobs/view/12345"
        },
        {
            "job_id": "67890",
            "title": "Junior Backend Developer",
            "company": "Big Tech Corp",
            "location": "Haifa, Israel",
            "posted": "2 hours ago",
            "url": "https://www.linkedin.com/jobs/view/67890"
        },
        {
            "job_id": "11223",
            "title": "Intern Full Stack",
            "company": "Another Company",
            "location": "Remote, Israel",
            "posted": "Just now",
            "url": "https://www.linkedin.com/jobs/view/11223"
        }
    ]
    
    logger.info("Returning %d dummy jobs from placeholder LinkedIn client.", len(dummy_jobs))
    return dummy_jobs
