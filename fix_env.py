import os
import re

env_path = ".env"

if os.path.exists(env_path):
    with open(env_path, "r") as f:
        content = f.read()
    
    # Check if DATABASE_URL exists and needs replacement
    if "DATABASE_URL=" in content:
        # Pattern to match DATABASE_URL assignment until the end of the line
        pattern = r"^DATABASE_URL=.*$"
        
        # Check if it's already correct to avoid unnecessary writes (though harmless)
        if "DATABASE_URL=sqlite:///jobs.db" not in content:
            new_content = re.sub(pattern, "DATABASE_URL=sqlite:///jobs.db", content, flags=re.MULTILINE)
            
            with open(env_path, "w") as f:
                f.write(new_content)
            print("Successfully updated DATABASE_URL in .env to sqlite:///jobs.db")
        else:
            print("DATABASE_URL is already set to sqlite:///jobs.db")
    else:
        # If it doesn't exist, append it
        with open(env_path, "a") as f:
            f.write("\nDATABASE_URL=sqlite:///jobs.db\n")
        print("Appended DATABASE_URL=sqlite:///jobs.db to .env")
else:
    # Create .env if it doesn't exist (from example technically better, but this ensures the key var exists)
    with open(env_path, "w") as f:
        f.write("DATABASE_URL=sqlite:///jobs.db\n")
    print("Created .env with DATABASE_URL=sqlite:///jobs.db")
