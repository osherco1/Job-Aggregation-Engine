### Filesystem & PATHS Standard

This project uses a centralized `PATHS` object in `config/paths.js` to keep
LinkedIn and ATS artifacts strictly separated.

- **Never** scan bare `output/` or `logs/` from new code.
- Always import `PATHS` and select the specific branch you need:
  - LinkedIn: `PATHS.LINKEDIN.OUTPUT`, `PATHS.LINKEDIN.LOGS.SUMMARIES`, `PATHS.LINKEDIN.LOGS.FILTERED`, etc.
  - ATS: `PATHS.ATS.OUTPUT`, `PATHS.ATS.LOGS.SUMMARIES`, `PATHS.ATS.LOGS.FILTERED`, etc.
- Existing tools under `tools/` are **LinkedIn-only** and must reference only
  `PATHS.LINKEDIN.*` plus shared, non-source-specific helpers such as
  `PATHS.DATA` or `PATHS.DEBUG_ARTIFACTS`.
- Any future script that needs to handle multiple sources must:
  - Accept an explicit flag such as `--source=linkedin|ats|all`.
  - Map that flag to a concrete set of `PATHS.*` branches instead of scanning
    the project root.


