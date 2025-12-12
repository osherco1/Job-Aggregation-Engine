import os
from dotenv import load_dotenv

# Load environment variables once at import time
load_dotenv()

class Settings:
    def __init__(self):
        # SMTP / Email
        self.smtp_host = os.getenv("JOBBOT_SMTP_HOST")
        self.smtp_port = int(os.getenv("JOBBOT_SMTP_PORT", "587"))
        self.smtp_user = os.getenv("JOBBOT_SMTP_USER")
        self.smtp_pass = os.getenv("JOBBOT_SMTP_PASS")
        self.to_email = os.getenv("JOBBOT_TO_EMAIL")

        # LinkedIn credentials (for later phases)
        self.linkedin_email = os.getenv("LINKEDIN_EMAIL")
        self.linkedin_password = os.getenv("LINKEDIN_PASSWORD")

        # Job Search settings
        self.linkedin_search_url = os.getenv("LINKEDIN_SEARCH_URL")
        self.linkedin_location = os.getenv("JOBBOT_LOCATION", "Israel")
        self.time_filter = os.getenv("JOBBOT_TIME_FILTER", "Past 24 hours")
        
        # Browser / Playwright
        self.chrome_user_data_dir = os.getenv("CHROME_USER_DATA_DIR", "./browser_profile")
        self.headless = os.getenv("HEADLESS_MODE", "true").lower() == "true"
        # Override headless if dry run is explicitly set
        if os.getenv("JOBBOT_DRY_RUN", "false").lower() == "true":
            self.headless = False

        # Database
        self.database_url = os.getenv("DATABASE_URL", "sqlite:///jobs.db")

    def validate_basic(self) -> bool:
        """
        Validate that the minimum SMTP config is present:
        JOBBOT_SMTP_HOST, JOBBOT_SMTP_USER, JOBBOT_SMTP_PASS, JOBBOT_TO_EMAIL.
        Print a warning listing which ones are missing.
        Return True if all required vars are present, else False.
        """
        required_vars = {
            "JOBBOT_SMTP_HOST": self.smtp_host,
            "JOBBOT_SMTP_USER": self.smtp_user,
            "JOBBOT_SMTP_PASS": self.smtp_pass,
            "JOBBOT_TO_EMAIL": self.to_email,
        }
        
        missing = [key for key, value in required_vars.items() if not value]
        
        if missing:
            print(f"WARNING: Missing SMTP configuration: {', '.join(missing)}")
            return False
            
        return True

# Singleton instance
settings = Settings()
