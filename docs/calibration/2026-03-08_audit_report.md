# Calibration Session Audit Report
**Date:** 2026-03-08
**Role:** Technical Writer & Lead Architect

## 🧠 רקע לכיול
The system was experiencing a very low pass rate (0.15%), improperly dropping legitimate junior and student roles while simultaneously allowing irrelevant non-software roles to pass through. The primary goal of this calibration session was to laser-focus the pipeline to operate EXCLUSIVELY on Junior, Student, and Entry-level SOFTWARE roles.

## 📊 תובנות עיקריות מהניתוח
- **False Positives (Garbage that passed):** The "Engineer" whitelist was found to be too broad. It allowed roles in Sales (e.g., Regional Sales Engineer), Hardware/Manufacturing (e.g., Mechanical/NPI Engineer), and Senior/Lead positions to pass the initial filters.
- **Global Spam Anomaly:** Discovered the "Speechify" anomaly where the exact same generic job posting ("Software Engineer, Platform") successfully bypassed the filters in 200+ global cities, flooding the database.
- **False Negatives (Gold that dropped):** 
  1. The `description_seniority` regex (`[3-9] years`) was overly strict and inadvertently killed valid entry-level jobs (e.g., at Figma, Via) because stating "3+ years" is very often listed as a nice-to-have requirement for juniors rather than a hard block.
  2. The `title_not_technical` filter was dropping highly valid student jobs (e.g., "QA Student", "Algo Researcher") because they were not explicitly included in the strict core vocabulary list.

## 🛠️ הוראות כיול שניתנו לקרסור
- **Blacklist Update (`filters_shared.js`):** Injected massive arrays of terms targeting Hardware (Mechanical, Chip Design), Sales (Presale, Account Exec), Support (NOC, IT), and Seniority (Chief, Expert).
- **Vocabulary Expansion (`config/vocabulary.js`):** Appended 6 specific strings to `technicalTitleKeywords` (e.g., 'qa', 'tester', 'algo', 'algo researcher').
- **Regex Softening:** Changed generic years-of-experience regex limits from `[3-9]` to `[4-9]` years to soften the strictness and allow nice-to-have requirements to pass.
- **Student Bypass Logic (`ats_guard.js`):** Added specific logic so that if a job title explicitly contains "student", "intern", or "junior", it completely bypasses the `runDescriptionCheck` (Tier 3), effectively protecting entry-level software talent from overly aggressive secondary guards.

## ✅ תוצאות הכיול שבוצע
- All code modifications were applied successfully without breaking existing operational invariants.
- Verification tests passed flawlessly:
  - "Junior Backend Engineer" with "5+ years" in the description successfully bypassed the guard.
  - "QA Student" passed the title check.
  - "Junior Account Executive" was correctly blocked.
- The changes were pushed to Git (`main`) and successfully deployed to Google Cloud Run (`jobbot-runner`).

## 📈 KPIs ומטרות למדידה בעתיד
- **Next Session Priority:** Implement a runtime Frequency Cap (Dedup) to definitively solve the Speechify global spam anomaly. The planned implementation will limit identical titles per company per run to a maximum of 3 occurrences.
- **Future KPIs:** We will aggressively measure the Pass Ratio in the next calibration report. The expectation is to see a drop in total passed jobs (due to heavy hardware and sales filtering) but a massive, measurable increase in the *quality and relevance* of the passed jobs (True Positives).
