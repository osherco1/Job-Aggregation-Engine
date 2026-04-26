// Shared blacklist / whitelist and title-level filter logic used by both
// the LinkedIn scraper and the ATS semantic gate. This file intentionally
// contains no side effects so it can be safely required from multiple modules.
//
// --- Phase 5.2 Calibration Notes (2026-01-24) ---
// Investigation: "Full Stack Developer @ solocate" was logged as REJECTED: Blacklist.
// ROOT CAUSE FOUND: The keyword 'STA' (Static Timing Analysis - chip design term)
// was matching as a substring in "Full STAck Developer".
// FIX: Replaced 'STA' with more specific terms 'Static Timing' and 'STA Engineer'
// to prevent false positives on valid "Full Stack" roles.

const { titleDomainRejectPatterns } = require('./config/vocabulary');

const BLACKLIST_KEYWORDS = [
  'Senior',
  'Lead',
  'Principal',
  'Manager',
  'Head of',
  'Director',
  'VP',
  'Chief',
  'Architect',
  '5+ years',
  '6+ years',
  '7+ years',
  '8+ years',
  // Marketing & Sales
  'Sales',
  'Sale',
  'Marketing',
  'Marketer',
  'Media',
  'Buyer',
  'B2B',
  'PPC',
  'Campaign',
  'Creative',
  'Digital',
  'Social Media',
  'SEO',
  // Finance & Accounting
  'Finance',
  'Financial',
  'Accounting',
  'Accountant',
  'Controller',
  'CPA',
  'Audit',
  'Auditor',
  'Bookkeeper',
  'Payroll',
  'Tax',
  'Economics',
  'Economist',
  // Non-Technical / Operations
  'HR',
  'Human Resources',
  'Recruiter',
  'Talent',
  'Office',
  'Admin',
  'Secretary',
  'Assistant',
  'Customer Success',
  'Operations',
  'Facility',
  'Agronomist',
  'Support Engineer',
  'CSM',
  'Support Representative',
  'Call Center',
  // Specific Noise
  'Language Analyst',
  'Online Data Analyst',
  'Content Writer',
  'Copywriter',
  'Translator',
  // Hebrew Keywords
  'שיווק',
  'מכירות',
  'כספים',
  'כלכלה',
  'מנהל חשבונות',
  'חשב',
  'מזכירה',
  'אדמיניסטרציה',
  'משאבי אנוש',
  'גיוס',
  // Additional non-software / irrelevant domains (QA audit)
  'Mechanical',
  'Mechatronics',
  'Electrical',
  'Electronics',
  'Power Engineer',
  'Analog',
  'ASIC',
  'VLSI',
  'Hardware',
  'Lawyer',
  'Attorney',
  'Legal',
  'Help Desk',
  'Support Specialist',
  'Instructional Designer',
  'Biotechnology',
  'Assembler',
  'Operator',
  // Additional non-tech / hardware leakage terms (QA Phase 5)
  'Plumbing',
  'Materials',
  'Process Engineer',
  'RTL',
  'Chip Design',
  // 'STA' removed - caused false positive on "Full Stack" (substring match)
  // Use more specific terms instead:
  'Static Timing',
  'STA Engineer',
  'Real Estate',
  'Pricing',
  'Credit',
  'Ads Assessor',
  'Inspector',
  'Technician',

  // --- Phase 5.2 Additions (Hardware & Non-Tech Guardrails) ---
  // Physics/Hardware
  'Optics',
  'Electro-Optical',
  'Optical',
  // Hardware Design
  'Board Design',
  'Circuit',
  // Hardware/Physical Engineering
  'Equipment Engineer',
  'Equipment Engineering',
  // QA Hardware
  'Failure Analysis',
  // Chip Design (Backend)
  'Physical Design',
  // Mechanical/Science
  'Solidworks',
  'Mechanic',
  'Physics',
  // Finance (additional)
  'Investment Banking',
  'Broker',
  'Trader',
  // HR (additional) - Note: "Talent" already exists above
  'Recruitment',
  'Talent Acquisition',
  // Marketing (additional)
  'Marcom',
  'Writer',
  'Content',
  // Civil/Industrial
  'Planner',
  'Urban',
  'Transport',
  // Design (non-tech)
  'Graphic Design',
  // Business roles
  'Co-Founder',
  'Business Development',
  // General/Medical
  'Technologist',

  // --- Phase 5.3 Additions (2026-02-02: Data Leakage Fix) ---
  // Finance & Administration (additional)
  'Assistant Controller',
  'Financial Controller',
  'Dealer',           // Blocks "Foreign Exchange Dealer"
  'Receptionist',
  'Office Manager',
  'Clerk',
  // Non-Software Engineering & Science
  'Chemist',
  'Chemistry',
  'Civil Engineer',
  'Construction',
  'Structural Engineer',
  'FAB Operation',
  'Industrial Engineer',
  // Operations, Sales, Tourism & Services
  'Tour',
  'Travel',
  'Steward',
  'Housekeeping',
  'Beauty',           // "Beauty Advisor"
  'SDR',
  'Sales Development',
  'Loss Prevention',
  'Store Associate',
  'Labeler',          // "Dental Labeler"

  // --- Strict Junior Software Focus (2026-03-07: FP extraction) ---
  // Hardware & Manufacturing (skip if already present: Mechanical, Electrical, Hardware, Chip Design, Physical Design)
  'NPI',
  'Material',
  'Electronic',
  'Pre-Silicon',
  'DFT',
  'Spare Parts',
  'SerDes',
  'Coating',
  'Validation Engineer',
  'EMC Test',
  'Accelerators',
  // Sales & Client-Facing
  'Presale',
  'Solutions Engineer',
  'Solution Engineer',
  'Account Executive',
  'Partner Engineer',
  'Mid-Enterprise',
  'Field Application',
  // IT, Infra, Support & Admin
  'Data Center',
  'NOC',
  'Technical Support',
  'Customer Support',
  'Field Service',
  'System Engineer',
  'SalesForce Admin',
  'IT Security',
  'IT Quality',
  'IT Specialist',
  // Analysts & Operations (non-dev)
  'System Analyst',
  'Business Analyst',
  'Product Analyst',
  'Research Analyst',
  'PMO',
  'Linguist',
  'Data Annotator',
  'Logistics',
  'Communications',
  'GRC Consultant',
  'Assembly',
  'volunteer',
  // Seniority & Leadership (English & Hebrew; Chief already above)
  'Expert',
  'First Engineer',
  'Team Leader',
  'Team Lead',
  'Research Scientist',
  'בכיר',
  'ניהול צוות',
  'מנוסה',
  'תעשיית המזון',

  // --- CAR 26-04 (substring complements to titleDomainRejectPatterns) ---
  'Formal Verification Engineer',
  'CAD Power Engineer',
  'Professional Services Engineer',
  'Forward Deployed Engineer',
  'GTM Engineer',
  'Student Project Coordinator',
  'Clinical Data Analyst',
  'Quality Section Analyst',
  'BI/Data Analyst',
  'IT Support',
  'Junior Data Scientist',
];

// Preserve high-value technical titles that may contain broad blacklist terms
// (e.g. "Security Operations Center Analyst" contains "Operations").
const PROTECTED_TITLE_PATTERNS = [
  /\balgo\s+researcher\b/i,
  /\bthreat\s+intelligence\s+researcher\b/i,
  /\bsoc\s+analyst\b/i,
  /\bsecurity\s+operations\s+center\s+analyst\b/i,
];

const WHITELIST_KEYWORDS = [
  'Software',
  'Developer',
  'Engineer',
  'Data',
  // Analyst: Replaced generic 'Analyst' with specific tech-related variants (Phase 5.3)
  'Data Analyst',
  'Business Analyst',
  'System Analyst',
  'Security Analyst',
  'SOC Analyst',
  'Scientist',
  'QA',
  'Quality',
  'Cyber',
  'Security',
  'DevOps',
  'Cloud',
  'Fullstack',
  'Frontend',
  'Backend',
  'Mobile',
  'Embedded',
  'Student',
  'Intern',
  'Junior',
  // Researcher: Made more specific to tech context (Phase 5.3)
  'Security Researcher',
  'AI Researcher',
  'ML Researcher',
  'Research Engineer',
  'Automation',
  // Additional positive signals (QA audit)
  'Computer Vision',
  'Firmware',
  'Integrator',
  // CAR 26-04: Hebrew software / embedded dev titles
  'מפתח/ת תוכנה',
  'מפתח/ת צב"ד',
  'מפתח/ת BSP',
];

function titlePassesSemanticFilters(title) {
  const rawTitle = title ? String(title) : '';
  const titleLower = rawTitle.toLowerCase();

  if (PROTECTED_TITLE_PATTERNS.some((re) => re.test(rawTitle))) {
    return true;
  }

  if ((titleDomainRejectPatterns || []).some((re) => re.test(rawTitle))) {
    return false;
  }

  for (const kw of BLACKLIST_KEYWORDS) {
    if (titleLower.includes(kw.toLowerCase())) {
      return false;
    }
  }

  const hasWhitelist = WHITELIST_KEYWORDS.some((kw) =>
    titleLower.includes(kw.toLowerCase())
  );

  if (!hasWhitelist) {
    return false;
  }

  return true;
}

module.exports = {
  BLACKLIST_KEYWORDS,
  WHITELIST_KEYWORDS,
  PROTECTED_TITLE_PATTERNS,
  titlePassesSemanticFilters,
};


