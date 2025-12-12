import logging
import time
import random
import os
import re
import hashlib
from typing import List, Dict
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright, Page, BrowserContext

from .config import settings

logger = logging.getLogger("jobbot")

class LinkedInNavigator:
    """
    The 'Navigator' (Agent 1 Implementation).
    Responsible for driving the browser, handling navigation, scrolling, and retrieving raw data.
    """
    def __init__(self, page: Page):
        self.page = page

    def go_to_search(self, url: str):
        """Navigate to the search URL."""
        logger.info(f"Navigating to search URL: {url}")
        self.page.goto(url, wait_until="domcontentloaded")
        self.random_sleep(2, 4)

    def scroll_infinite(self, scrolls: int = 5):
        """
        Scrolls down execution N times to trigger infinite loading.
        """
        logger.info(f"Starting infinite scroll ({scrolls} times)...")
        for i in range(scrolls):
            # Scroll to bottom
            self.page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            logger.debug(f"Scroll {i+1}/{scrolls} complete.")
            
            # Random sleep to let content load and mimic human behavior
            self.random_sleep(2, 4)

    def get_page_source(self) -> str:
        """Return raw HTML."""
        return self.page.content()

    def random_sleep(self, min_sec: float, max_sec: float):
        time.sleep(random.uniform(min_sec, max_sec))


class LinkedInAnalyst:
    """
    The 'Analyst' (Agent 1 Implementation).
    Responsible for parsing raw HTML (safe extraction) and structuring data.
    """
    def parse_jobs(self, html_content: str) -> List[Dict]:
        soup = BeautifulSoup(html_content, 'html.parser')

        # 1. Multiple Selectors for Job Cards
        potential_selectors = [
            ".job-card-container",
            ".job-card-list__entity-lockup",
            "li.occludable-update" # Common container for list items
        ]

        job_cards = []
        for selector in potential_selectors:
            found = soup.select(selector)
            if found:
                logger.info(f"Analyst: Found {len(found)} cards using selector '{selector}'")
                job_cards = found
                break

        if not job_cards:
            # Fallback: Try generic list items that look like job cards
            job_cards = soup.select("li")
            if job_cards:
                 logger.warning(f"Analyst: No standard selectors matched. Trying generic 'li' ({len(job_cards)} items).")

        logger.info(f"Analyst processing {len(job_cards)} potential job cards.")

        parsed_jobs = []
        failure_count = 0

        for i, card in enumerate(job_cards):
            try:
                job_data = self._extract_job_data(card)
                if job_data:
                    parsed_jobs.append(job_data)
                else:
                    failure_count += 1
                    if failure_count <= 3:
                        logger.debug(f"Failed to extract item #{i}: No valid ID/URL found.")
            except Exception as e:
                failure_count += 1
                if failure_count <= 3:
                     logger.warning(f"Exception parsing item #{i}: {e}")

        logger.info(f"Analyst extracted {len(parsed_jobs)} valid jobs.")
        return parsed_jobs

    def _extract_job_data(self, card) -> Dict:
        """Extract details from a single card soup object."""

        # 2. Field Fallbacks for Title and URL
        # Try to find the primary anchor
        title_tag = card.select_one(".job-card-list__title")
        if not title_tag:
            # Fallback: Look for any link containing /jobs/view/
            title_tag = card.select_one("a[href*='/jobs/view/']")

        # Title
        title = title_tag.get_text(strip=True) if title_tag else "Unknown Title"

        # URL
        url_raw = title_tag['href'] if title_tag else ""
        if not url_raw:
             # Try finding any link
             any_link = card.select_one("a")
             if any_link:
                 url_raw = any_link.get("href", "")

        # Clean URL
        url = url_raw.split("?")[0] if url_raw else ""

        # 3. Job ID Strategy
        job_id = None

        # Strategy A: data-entity-urn
        urn = card.get("data-entity-urn", "")
        if urn:
            parts = urn.split(":")
            if len(parts) > 0:
                job_id = parts[-1]

        # Strategy B: Extract from URL
        if not job_id and url:
            # Regex for /jobs/view/123456... or currentJobId=123456
            match = re.search(r'currentJobId=(\d+)', url_raw) or re.search(r'/view/(\d+)', url)
            if match:
                job_id = match.group(1)

        # Strategy C: Hash the URL
        if not job_id and url:
            job_id = hashlib.md5(url.encode()).hexdigest()

        if not job_id:
            # If we don't have an ID and barely found a URL, it might not be a job card.
            return None

        # Company
        company_tag = card.select_one(".job-card-container__company-name")
        if not company_tag:
            company_tag = card.select_one(".artdeco-entity-lockup__subtitle") # Another common one
        company = company_tag.get_text(strip=True) if company_tag else "Unknown Company"

        # Location
        loc_tag = card.select_one(".job-card-container__metadata-item")
        if not loc_tag:
             loc_tag = card.select_one(".artdeco-entity-lockup__caption") # Another common one
        location = loc_tag.get_text(strip=True) if loc_tag else "Unknown Location"

        # Posted Date
        time_tag = card.select_one("time")
        posted = time_tag.get_text(strip=True) if time_tag else "Recently"

        return {
            "job_id": job_id,
            "title": title,
            "company": company,
            "location": location,
            "posted": posted,
            "url": url
        }


class LinkedInClient:
    """
    Main Client orchestrating the Navigator and Analyst.
    """
    def __init__(self):
        # FORCE HEADED MODE
        # LinkedIn detects headless requests very easily. 
        # We must override the setting to ensure reliability.
        self.headless = False 
        self.user_data_dir = os.path.abspath(settings.chrome_user_data_dir)
        self.search_url = settings.linkedin_search_url
        self.playwright = None
        self.browser_context = None
        self.page = None

    def connect(self):
        """Initializes Playwright with persistent context."""
        logger.info(f"Initializing LinkedIn Client (Headless: {self.headless}, Profile: {self.user_data_dir})")
        
        self.playwright = sync_playwright().start()
        
        # Ensure profile dir exists
        if not os.path.exists(self.user_data_dir):
            os.makedirs(self.user_data_dir, exist_ok=True)

        try:
            self.browser_context = self.playwright.chromium.launch_persistent_context(
                user_data_dir=self.user_data_dir,
                channel="chrome",
                headless=self.headless,
                args=["--no-sandbox", "--disable-setuid-sandbox"],
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            # Get the first page or create new
            self.page = self.browser_context.pages[0] if self.browser_context.pages else self.browser_context.new_page()
            
            # Basic stealth
            self.page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            
        except Exception as e:
            logger.error(f"Failed to launch browser: {e}")
            raise

    def search_jobs(self) -> List[Dict]:
        """
        Executes the full search flow:
        1. Navigate to specific Search URL.
        2. Scroll to load more jobs.
        3. Parse results.
        """
        if not self.search_url:
            logger.error("LINKEDIN_SEARCH_URL is not set in configuration.")
            return []

        if not self.page:
            self.connect()

        navigator = LinkedInNavigator(self.page)
        analyst = LinkedInAnalyst()

        try:
            # 1. Navigation
            navigator.go_to_search(self.search_url)
            
            # --- SANITY CHECK ---
            title = self.page.title()
            logger.info(f"Page Title: {title}")
            
            # If we are redirected to login/signup, ABORT.
            if "Sign In" in title or "Sign Up" in title or "Join" in title:
                logger.error("AUTH WALL DETECTED! The bot is not logged in.")
                raise RuntimeError("Auth Wall detected. Please run 'setup_auth.py' again (ensure you close all Chrome windows first).")
            # --------------------

            # 2. Infinite Scroll
            navigator.scroll_infinite(scrolls=4) # Configurable

            # 3. Extraction
            html = navigator.get_page_source()
            jobs = analyst.parse_jobs(html)
            
            logger.info(f"Search complete. Extracted {len(jobs)} jobs.")
            return jobs

        except Exception as e:
            logger.exception("Error during job search execution.")
            # Re-raise so main.py can handle it (send error email)
            raise e
        finally:
            self.close()

    def close(self):
        if self.browser_context:
            self.browser_context.close()
        if self.playwright:
            self.playwright.stop()

def search_jobs() -> List[Dict]:
    """
    Wrapper for backward compatibility with main.py.
    Instantiates the LinkedInClient and runs the search.
    """
    client = LinkedInClient()
    return client.search_jobs()
