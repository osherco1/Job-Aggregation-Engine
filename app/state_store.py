import os
import logging
from datetime import datetime
from typing import List, Dict, Set
from sqlalchemy import create_engine, Column, String, DateTime, select
from sqlalchemy.orm import declarative_base, sessionmaker

# Setup logger
logger = logging.getLogger("jobbot")

Base = declarative_base()

def get_database_url() -> str:
    """Get database URL from environment variable or default to sqlite."""
    url = os.getenv("DATABASE_URL", "sqlite:///jobs.db")
    # Fix for Render: SQLAlchemy requires postgresql:// but Render provides postgres://
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url

def get_engine():
    """Create and return the SQLAlchemy engine."""
    url = get_database_url()
    return create_engine(url, future=True)

# Create SessionLocal class bound to the engine
SessionLocal = sessionmaker(bind=get_engine(), autocommit=False, autoflush=False)

class JobSeen(Base):
    """Model to track jobs we have already seen and processed."""
    __tablename__ = "jobs_seen"

    job_id = Column(String, primary_key=True, index=True)
    title = Column(String, nullable=True)
    company = Column(String, nullable=True)
    url = Column(String, nullable=True)
    first_seen_at = Column(DateTime, default=datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.utcnow)

def init_db():
    """Create tables if they don't exist."""
    try:
        engine = get_engine()
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables checked/created.")
    except Exception:
        logger.exception("Failed to initialize database.")
        raise

def filter_new_jobs(jobs: List[Dict]) -> List[Dict]:
    """
    Receives a list of job dicts with at least a 'job_id' key.
    Returns ONLY the jobs that are NOT yet in the jobs_seen table.
    """
    if not jobs:
        logger.info("No jobs to filter (input list empty).")
        return []

    job_ids = {job["job_id"] for job in jobs}
    
    with SessionLocal() as session:
        # Query existing job IDs
        try:
            existing_jobs = session.execute(
                select(JobSeen.job_id).where(JobSeen.job_id.in_(job_ids))
            ).scalars().all()
            
            existing_ids = set(existing_jobs)
        except Exception:
            logger.exception("Database error during filter_new_jobs")
            raise
        
    return [job for job in jobs if job["job_id"] not in existing_ids]

def mark_jobs_as_seen(jobs: List[Dict]) -> None:
    """
    Insert or update JobSeen rows for the given jobs.
    """
    if not jobs:
        return

    session = SessionLocal()
    try:
        count = 0
        for job in jobs:
            job_id = job["job_id"]
            db_job = session.get(JobSeen, job_id)
            
            if not db_job:
                # Create new
                db_job = JobSeen(
                    job_id=job_id,
                    title=job.get("title"),
                    company=job.get("company"),
                    url=job.get("url"),
                    first_seen_at=datetime.utcnow(),
                    last_seen_at=datetime.utcnow()
                )
                session.add(db_job)
                count += 1
            else:
                # Update existing
                db_job.last_seen_at = datetime.utcnow()
                # Optionally update other fields if they changed
                if job.get("title"): db_job.title = job.get("title")
                if job.get("company"): db_job.company = job.get("company")
                if job.get("url"): db_job.url = job.get("url")
        
        session.commit()
        logger.info(f"Marked {len(jobs)} jobs as seen in database.") # Log total processed in this batch, or specifically new inserts if preferred, but len(jobs) is requirement.
    except Exception as e:
        session.rollback()
        logger.exception("[ERROR] mark_jobs_as_seen failed")
        raise # Re-raise to let caller handle if critical, though Requirement says "so caller can continue or decide", main loop handles exceptions.
    finally:
        session.close()
