import os
import time
from playwright.sync_api import sync_playwright

def setup_auth():
    """
    Launches a HEADED browser with a persistent context.
    The user can log in manually. The session cookies will be saved 
    to the './browser_profile' directory.
    """
    # Define the persistent user data directory (local to project)
    user_data_dir = os.path.join(os.getcwd(), "browser_profile")
    
    print(f"[*] Launching browser with profile stored in: {user_data_dir}")
    print("[*] Please log in to LinkedIn manually.")
    print("[*] Once logged in, you can close the browser window or press Enter here to exit.")

    with sync_playwright() as p:
        # Launch persistent context
        # headless=False so the user can see and interact
        browser = p.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            headless=False,
            channel="chrome",  # Uses installed Chrome if available, optional
            args=["--no-sandbox", "--disable-setuid-sandbox"]
        )
        
        page = browser.new_page()
        page.goto("https://www.linkedin.com/login")
        
        # Keep script running until user decides to close
        input("\n[PRESS ENTER] to save session and close browser...")
        
        browser.close()
        print("[*] Browser closed. Session saved to 'browser_profile'.")

if __name__ == "__main__":
    setup_auth()
