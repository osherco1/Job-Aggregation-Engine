# False Negatives Data Mining & Rescue Operation

**Source:** `docs\analyze\calibration_2026-03-07T20-07-24.md` — Exhaustive List: Rejected Jobs (Semantic & Guard)  
**Methodology:** Targeted grep/chunk search for high-signal keywords (Backend, Frontend, Fullstack, Software Engineer, Developer, DevOps, Data Scientist, Algorithm, Student, Junior, Intern); excluded rows with Senior/Principal/Manager/Director in title (except borderline Team Lead). Exact rows extracted from the document.

---

## 1. False Negatives Table (exact rows from report)

| Job Title | Company | Drop Reason | Suspected Overly-Strict Rule/Regex |
|-----------|---------|-------------|------------------------------------|
| Backend Software Engineer | Next Insurance | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` (e.g. `/\b[3-9]\s*\+?\s*(?:years|yrs)\b/i` or leadership phrases in description body) |
| Backend Engineer | Via | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Algorithm Developer | Via | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Software Engineer, Fullstack - Figma Weave (Tel Aviv, Israel) | Figma | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Software Engineer, Backend - Figma Weave (Tel Aviv, Israel) | Figma | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Backend Engineer - AI-Driven Development | Bringg | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Software Engineer (gai) | Armis Security | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Software Engineer | Armis Security | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Backend Engineer, Data Apps | Melio | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Full Stack Engineer | Melio | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Backend Engineer | Wiz | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Frontend Engineer | Wiz | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| DevOps Engineer | Wiz | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Detection Software Engineer | Wiz | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Data Engineer | Wiz | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Application Engineer | Wiz | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Software Engineer | Apiiro | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Data Science Engineer | Apiiro | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Data Scientist | Taboola | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Algorithm Engineer | Taboola | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Full- Stack Engineer | Taboola | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| DevOps Engineer | Taboola | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Data Scientist | Placer.ai | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Mobile Engineer | Fireblocks | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Back End Engineer (Yotpo Discover) | Yotpo | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Data Scientist | AppsFlyer | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Data Engineer | AppsFlyer | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Backend Engineer | AppsFlyer | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Android Developer | Similarweb | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Full Stack Developer | Obligo | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Backend Developer | Obligo | ATS_GUARD: FAIL: description_seniority (years/leadership pattern) | `contentSeniorityPatterns` |
| Algo Researcher | Via | ATS_GUARD: FAIL: title_not_technical (Algo Researcher) | ATS Guard `technicalTitleKeywords` / title classifier (does not recognize "Algo Researcher") |
| QA Student | DealHub | ATS_GUARD: FAIL: title_not_technical (QA Student) | ATS Guard title classifier (QA + Student not recognized as technical) |
| Junior Mobile QA Tester | Rounds | ATS_GUARD: FAIL: title_not_technical (Junior Mobile QA Tester) | ATS Guard title classifier |
| Business Ops Data Analysis Intern | HP Inc. | ATS_GUARD: FAIL: title_not_technical (Business Ops Data Analysis Intern) | ATS Guard title classifier |
| Wireless Connectivity Master's/PhD Student Position | General Motors | ATS_GUARD: FAIL: title_not_technical (Wireless Connectivity Master's/PhD Student Position) | ATS Guard title classifier |
| Laser Development PhD Student | NVIDIA | ATS_GUARD: FAIL: title_not_technical (Laser Development PhD Student) | ATS Guard title classifier |
| Software Architect | Applied Materials | ATS_GUARD: FAIL: title_not_technical (Software Architect) | ATS Guard title classifier ("Architect" not in technical list or blocked) |
| Software Architect (Hands On) | Armis Security | ATS_GUARD: FAIL: title_not_technical (Software Architect (Hands On)) | ATS Guard title classifier |
| Software Architect | Personetics | ATS_GUARD: FAIL: title_not_technical (Software Architect) | ATS Guard title classifier |
| Backend Team Lead (Symfony) | CapsLock | ATS_GUARD: FAIL: title_senior (Backend Team Lead (Symfony)) | ATS Guard `titleSeniorPatterns` / "Team Lead" or "Lead" treated as senior |
| Windows Internals Team Lead | Cybereason | ATS_GUARD: FAIL: title_not_technical \| FAIL: title_senior | Title classifier + title_senior (Team Lead) |

---

## 2. Summary: Which filter does the most damage to valid jobs

### Primary cause: **description_seniority (contentSeniorityPatterns)**

- **Impact:** The report shows **19,463** rejections for `ATS_GUARD: FAIL: description_seniority (years/leadership pattern)` (see Top Specific Rejection Reasons in the calibration report). Targeted mining found **100+** rejected lines with this reason; many are plain "Backend Engineer", "Software Engineer", "Full Stack Engineer", "Data Engineer", "DevOps Engineer", "Data Scientist", "Algorithm Engineer", "Android Developer", "Mobile Engineer" with **no seniority in the title**.
- **Mechanism:** In `config/vocabulary.js`, `contentSeniorityPatterns` runs over the **job description body**. Any match causes the job to be dropped. Patterns include:
  - `/\b[3-9]\s*\+?\s*(?:years|yrs)\b/i` — e.g. "3+ years" or "5 years" (often used as "preferred" or "nice to have" in junior roles).
  - Years-of-experience variants: "X years of experience", "X–Y years of experience".
  - Leadership phrases: "experienced team leader", "experience in managing managers", "lead a large and growing team".
- **Why it hurts:** Many entry-level or junior-appropriate roles list "3+ years preferred" or similar in the description. A single match in the body fails the entire job even when the **title** is clearly non-senior (e.g. "Backend Engineer", "Software Engineer"). Israel-relevant examples: **Figma (Tel Aviv)**, **Via**, **Melio**, **Wiz**, **Apiiro**, **Bringg**, **Next Insurance**, **Taboola**, **Placer.ai**, **AppsFlyer**, **Obligo**, **Similarweb**, **Yotpo**, **Fireblocks**.

### Secondary cause: **title_not_technical (ATS Guard title classifier)**

- **Impact:** Legitimate tech roles are dropped because the title is not recognized as technical. Examples:
  - **Algo Researcher** (Via) — algorithmic/research dev role.
  - **QA Student**, **Junior Mobile QA Tester** — QA roles.
  - **Software Architect** (Applied Materials, Armis, Personetics) — hands-on or principal track.
  - **Laser Development PhD Student**, **Wireless Connectivity Master's/PhD Student Position** — research/PhD roles in tech.
  - **Business Ops Data Analysis Intern** — data/analytics intern.
- **Mechanism:** ATS Guard uses `technicalTitleKeywords` (and related logic) to decide if a title is "technical". If the title string is not recognized, the job fails with `title_not_technical`. Unusual but valid titles (e.g. "Algo Researcher", "QA Student", "Software Architect") are not in the allowed set or are misclassified.

### Tertiary cause: **title_senior (Team Lead / Lead in title)**

- **Impact:** **Backend Team Lead (Symfony)** (CapsLock) and **Windows Internals Team Lead** (Cybereason) are dropped by `title_senior`. "Team Lead" can be a mid-level or first-step leadership role, not necessarily senior.
- **Mechanism:** `titleSeniorPatterns` in vocabulary (or equivalent) likely treats "Lead" or "Team Lead" as senior. No exception for "Backend/Frontend/Software + Team Lead" or "Team Lead + (stack)" when the rest of the title is clearly dev.

---

**Recommendation (for later implementation):**  
1. **Relax or narrow `contentSeniorityPatterns`** so that description-body matches do not override a **junior-friendly title** (e.g. title contains "Engineer", "Developer", "Software", "Data Scientist", "DevOps" and does **not** contain "Senior", "Principal", "Staff", "Lead", "Manager", "Director", "Head of").  
2. **Extend `technicalTitleKeywords`** (or the title classifier) to include: "Algo Researcher", "QA Student", "Software Architect", "PhD Student" (in tech context), "Data Analysis Intern".  
3. **Whitelist or soften** "Team Lead" when the title also contains a clear dev/stack term (e.g. "Backend Team Lead (Symfony)") so it is not rejected solely by `title_senior`.
