import logging
import os
import sys

def setup_logging() -> logging.Logger:
    """
    Configure and return a root logger for the Job Bot.

    - Log level is controlled by env var JOBBOT_LOG_LEVEL (default: INFO).
    - Logs go to stdout.
    - Use a simple formatter including time, level, and message.
    """
    # Create logger
    logger = logging.getLogger("jobbot")
    
    # Avoid adding multiple handlers if setup_logging is called multiple times
    if logger.handlers:
        return logger

    # Set level from env
    log_level_str = os.getenv("JOBBOT_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, log_level_str, logging.INFO)
    logger.setLevel(level)

    # Create console handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(level)

    # Create formatter and add it to handler
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)

    # Add handler to logger
    logger.addHandler(handler)
    
    # Also configure the root logger to capture library logs if needed, 
    # but strictly following requirements, we return our named logger.
    # To ensure library logs (like sqlalchemy) are visible if we want, we could configure root,
    # but let's stick to the requested "jobbot" logger for now to keep it clean.
    
    return logger
