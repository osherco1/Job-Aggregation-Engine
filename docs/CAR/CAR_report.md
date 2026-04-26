# Calibration Aggregation Report (CAR)
**Files Analyzed:** `docs/analyze/calibration_2026-04-26T06-42-43.md`, `docs/analyze/calibration_2026-04-23T14-25-14.md`, `docs/analyze/calibration_2026-04-12T14-23-08.md`  
**Total Jobs:** 343 / 1,761,544 *(aggregated passed / aggregated rejected across the three windows; the 2026-04-26 file was counted once)*

---

## 1. Actionable Code Adjustments (The Delta)

### Tokens to ADD to Reject Lists
Use as title/description tokens (case-insensitive), tuned to your existing guard style:

```javascript
// Domain noise (non–software-development engineering & GTM)
const TITLE_DOMAIN_REJECT_EXTRA = [
  /\bchip\s+design\b/i,
  /\bphysical\s+design\b/i,
  /\bSTA\s+engineer\b/i,
  /\bASIC\b/i,
  /\bVLSI\b/i,
  /\bformal\s+verification\s+engineer\b/i,
  /\bNPI\b.*\bengineer\b/i,
  /\bNOC\s+engineer\b/i,
  /\bprocess\s+engineer\b/i,
  /\bmechanical\s+engineer/i,
  /\bcad\s+power\s+engineer\b/i,
  /\banalog\s+ic\s+design\b/i,
  /\bvalidation\s+engineer\b/i, // when not paired with software/embedded app stack
  /\bsales\s+engineer\b/i,
  /\bsolutions\s+engineer\b/i,
  /\bprofessional\s+services\s+engineer\b/i,
  /\bforward\s+deployed?\s+engineer\b/i,
  /\bcelery\b.*\bGTM\s+engineer\b/i,
  /\bGTM\s+engineer\b/i,
  /\bdata\s+scientist\b/i,
  /\bjunior\s+data\s+scientist\b/i,
  /\bbi\s*\/\s*data\s+analyst\b/i,
  /\bclinical\s+data\s+analyst\b/i,
  /\bquality\s+section\s+analyst\b/i,
  /\bhelp\s*desk\b/i,
  /\bit\s+support\b/i,
  /\btechnical\s+support\s+engineer\b/i,
  /\bstudent\s+project\s+coordinator\b/i,
];

// Seniority noise already in passes
const TITLE_SENIORITY_REJECT_EXTRA = [
  /\bQA\s+team\s+leader\b/i,
  /\bteam\s+lead(er)?\b/i, // optional: narrow to QA/Infra if too broad
];
```

### Tokens to ADD to Allow Lists
```javascript
// Hebrew / ATS normalization: treat as technical software roles (pair with your junior/student gates)
const TITLE_TECH_ALLOW_EXTRA = [
  /מפתח\/ת\s+תוכנה/i,      // software developer
  /מפתח\/ת\s+צב"ד/i,      // embedded — keep if your product scope includes embedded SW
  /מפתח\/ת\s+BSP/i,
];

// Optional: disambiguate “developer” in junior support hybrids ( CommIT case )
const JUNIOR_DEV_HINTS = [
  /\bjunior\s+developer\b/i,
  /\bjunior\s+software\s+engineer\b/i,
  /\bintern\s+software\b/i,
  /\bstudent\s+.*\b(engineer|developer)\b/i,
];
```

### Regex / logic snippets
```javascript
// Down-rank or hard-reject Speechify-style bulk geo clones unless junior/student present
const BARE_SOFTWARE_ENGINEER = /^(software\s+engineer)\b/i;
const HAS_ENTRY_SIGNAL =
  /\b(junior|intern|student|graduate|entry[\s-]level|associate|0\s*-\s*2|no\s+experience)\b/i;
// Pseudologic: if (company === 'Speechify' || title matches many geo suffixes) require HAS_ENTRY_SIGNAL
```

```javascript
// FN fix: if title matches JUNIOR_DEV_HINTS, bypass or downgrade structured_seniority:Senior from ATS alone
if (/\bjunior\s+developer\b/i.test(normalizedTitle)) {
  // do not reject on structured_level:Senior without description confirmation
}
```

---

## 2. Confirmed False Positives (Noise that passed)

| Job Title | Company | Why it's noise | Suggested Filter Update |
|-----------|---------|----------------|-------------------------|
| QA Team Leader | Maytronics | FP Type 1: explicit lead seniority | Extend `title_senior` / lead tokens to catch `QA Team Lead` / `Team Leader` |
| Sales Engineer – East Coast | Nagomi Security | FP Type 2: sales-track “engineer” | Route `Sales Engineer` to `department (Sales)` or `title_not_technical` for GTM |
| Solutions Engineer (multiple) | Mixpanel, DealHub, NICE, … | FP Type 2: presales / customer engineering | Same as above for `Solutions Engineer` when not paired with strong SDE stack |
| Professional Services Engineer | NICE | FP Type 2: delivery/consulting, not product SDE | Add `Professional Services` to non-dev or sales-adjacent title path |
| Forward Deployed Engineer / CX Outbound Solution Engineer | NICE | FP Type 2: implementation / CX engineering | Add FDE / outbound solution patterns to GTM or exception list requiring dev keywords |
| Data Scientist / Junior Data Scientist | Teads, Marketeam.ai, ppltx, … | FP Type 2: analytics / ML science, not SWE golden target | Re-tighten `engineer` keyword pass: require `software|backend|frontend|full[\s-]?stack|developer|embedded application` |
| Junior BI/Data Analyst | Experis Academy Israel | FP Type 2: analyst track | Already `title_not_technical` in rejects for analysts — align pass keyword `engineer` |
| Chip / Physical Design / STA / ASIC / PHY / CAD Power Engineer | NVIDIA, Cisco, Intel, … | FP Type 2: hardware / silicon, not app software | Add HW silicon tokens to reject list (see arrays) |
| Algorithm Engineer | KLA | FP Type 2: HW/algorithms in semicon context | Contextual: require `software` / `development` / app stack if keeping |
| Celery- GTM Engineer | Team8 | FP Type 2: go-to-market labeling | Add `GTM Engineer` token |
| Digital Health Stealth Startup- Automation Engineer / RPA Specialist | Team8 | FP Type 2: RPA/automation ops | Optional: require programming stack tokens for “automation engineer” |
| NOC Engineer | GK8 by Galaxy | FP Type 2: ops NOC | Add `NOC Engineer` |
| Technical Support Engineer | Navina | FP Type 2: support | Add alongside IT support |
| Chief System Engineer | XTEND | FP Type 1: “Chief” seniority | Chief/head tokens in seniority guard |
| Sales Engineer, Central | Axonius | FP Type 2 | Appears in 2026-04-26 passes — hard reject sales engineer |
| Data Scientist, Prime Video Sports Science | Amazon Science | FP Type 2 | Data science vs SWE |
| ~180× “Software Engineer, Platform \| iOS …” city variants | Speechify | FP Type 3: bare SWE with no student/junior signal | Company- or pattern-specific rule: geo-suffixed SWE requires entry signal (section 1) |

---

## 3. Confirmed False Negatives (Gold that was lost)

| Job Title | Company | Reject Tag Applied | Why tag is wrong |
|-----------|---------|--------------------|------------------|
| Junior developer (with technical support experience) | CommIT | `STRUCTURED_GATE: structured_seniority:Senior` | Title explicitly marks junior software development; seniority gate contradicts title. |
| מפתח/ת תוכנה *(software developer)* | CommIT | `ATS_GUARD: FAIL: title_not_technical` | Clear software development role; failure is i18n / tokenizer gap, not “non-technical.” |

*Note:* Plain `Software Engineer` / `Backend Engineer` / `Mobile Engineer` rows rejected only on `description_seniority` appear repeatedly (e.g. ClickHouse, Wiz, AppsFlyer). Those are **probable** FNs if postings are actually entry-level; the calibration lines do not prove seniority, so they are not listed as confirmed.

---

## 4. Systemic Drift & Anomalies

- **Gates above 25% of rejections (aggregated across the three files):**  
  - **`location` ~46.4%** (816,537 / 1,761,544) — largest bucket; dominates every window.  
  - **`title` ~43.7%** (769,879 / 1,761,544) — second largest; nearly tied with location.  
  Neither `structured_level` (~6.9%) nor `description` (~2.6%) exceeds 25% alone; **`description_seniority`** is a *reason* under the description gate, not the full gate volume.

- **Recurring rejection reasons (per-file top reasons, same shape):**  
  - `STRUCTURED_GATE: structured_seniority:Senior` — very high counts.  
  - `ATS_GUARD: FAIL: title_senior` on tokens like `QA Team Lead`, `Backend Team Lead`, `Senior Software Engineer`.  
  - `ATS_GUARD: FAIL: title_not_technical` on sales, HR, design, RevOps, PM.  

- **Tokens / patterns driving FNs:**  
  - **`description_seniority`** on titles that are otherwise vanilla SWE/backend/full-stack/mobile — strips “gold” when JD asks for “years” generically.  
  - **`structured_seniority:Senior`** misfiring on **junior-titled** rows (CommIT).  
  - **`title_not_technical`** on **non-English software titles** (Hebrew at CommIT).

- **Company-specific formatting:**  
  - **Speechify:** Massive Greenhouse expansion of the same SWE title across cities — inflates pass count and bypasses junior signal.  
  - **NVIDIA / Intel / Cisco / Samsung Israel:** Hardware-centric “engineer” titles satisfy keyword `engineer` and pass.  
  - **CommIT:** Hebrew titles and “Junior developer” expose both **FN** (i18n + structured seniority) and calibration visibility.  
  - **Qualitest / Experis-style:** Numeric prefix IDs (`21493 - Junior QA…`) — ensure regex does not strip leading junior tokens.

---

## 5. Ambiguous Items (Requires Human Review)

- **Full-Stack Software Developer (Junior–Mid) @ Axioma** — “Junior–Mid” spans golden target and mid-level; needs JD or structured level.  
- **Full Stack Engineer / Fullstack Engineer @ AppsFlyer, Gini-Apps** — Software dev role likely mid+ with no entry signal in title.  
- **DevOps Engineer @ Tipalti, eToro, CommIT** — Dev role; seniority unstated in title (some rejects show same pattern with `description_seniority` elsewhere).  
- **Software Engineer @ Oligo Security** — Bare SWE; could be new-grad or senior.  
- **AI Engineer / AI/ML Engineer @ Gini-Apps, YO IT Consulting** — Dev-adjacent; level unclear without description.  
- **Security Researcher @ Paragon** — Can be heavy software; can be ops-heavy; golden target depends on stack.  
- **Computer Vision Engineer @ Orca-AI** — ML engineering; user may or may not treat as in-scope “algorithms” SWE.  
- **Algorithm Engineer @ KLA** — Borderline algorithms vs silicon implementation.  
- **מפתח/ת צב"ד @ CommIT** (rejected as `title_not_technical` in samples) — Likely embedded software in Hebrew; scope vs hardware unclear.  
- **Post Silicon Validation Student @ Intel** (rejected `title_not_technical` in 04-23) — “Student” matches experience gate; role is validation/silicon more than product software — human call.  
- **Associate Solution Engineer @ NICE** — “Associate” suggests junior; work may be presales not product engineering.
