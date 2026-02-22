const departmentsBlacklist = [
  // Non-technical / go-to-market / G&A departments observed in ATS logs
  'Sales', // Melio / Riskified
  'New Business', // Gong
  'Corporate Strategy', // Riskified
  'Customer Org', // Riskified
  'Human Resources', // Riskified
  'Finance', // Melio (Junior Reconciliation Analyst)
  // Product orgs are typically not junior IC engineering roles; can be overridden per company
  'Product Management', // Melio Product Manager, Monetization / Orchestration
];

const allowedTechnicalDepartments = [
  // Clearly technical orgs from evidence
  'Engineering', // Melio / Gong
  'Development', // Riskified (DevOps Engineer)
  'Business Technologies', // Riskified (Data Integration Engineer)
  'Research', // Riskified (Data Scientist)
];

// Technical keywords that indicate this is at least an engineering / data / platform role.
// Used by ats_guard's cheap title check.
const technicalTitleKeywords = [
  'engineer',
  'developer',
  'devops',
  'sre',
  'software engineer',
  'full stack',
  'backend',
  'front end',
  'data engineer',
  'data scientist',
  'ml engineer',
  'qa engineer',
  'security engineer',
  'salesforce', // Salesforce Analyst / Engineer roles should not be dropped as non-technical
];

// Seniority and leadership indicators in titles
const titleSeniorPatterns = [
  /\bSenior\b/i, // "Senior Data Analyst", "Senior Data Engineer"
  /\bSr\.?\b/i,
  /\bStaff\b/i,
  /\bPrincipal\b/i,
  /\bLead\b/i, // generic "Lead" roles
  /\bTeam Lead\b/i, // "Data Science Team lead"
  /\bTech Lead\b/i, // "Data and AI Infra Tech Lead"
  /\bHead of\b/i, // "Head of DevOps"
  /\bHead\b/i,
  /\bDirector\b/i, // "Account Director"
  /\bManager\b/i, // "Engineering Manager", "Product Manager"
  // Common senior commercial / GTM titles that are never junior dev roles
  /\bAccount Executive\b/i,
  /\bAccount Director\b/i,
  /\bAccount Manager\b/i,
  /\bBusiness Development\b/i,
];

// Seniority patterns in rich-text descriptions (HTML-ish content / description field)
const contentSeniorityPatterns = [
  // Generic years-of-experience gates: treat 3+ years as non-junior for ATS roles.
  /\b[3-9]\s*\+?\s*(?:years|yrs)\b/i,

  // Stricter variants with explicit "of experience"
  /\b([3-9]|1[0-9])\s*\+?\s*(?:years|yrs)\s+of\s+experience\b/i,
  /\b([3-9]|1[0-9])\s*-\s*[0-9]+\+?\s*(?:years|yrs)\s+of\s+experience\b/i, // "4-5+ years of professional experience"
  /\+\s*[3-9]\s*(?:years|yrs)\b/i, // "+5 years as DevOps Engineer/SRE", "+3 years" etc.

  // Concrete phrases observed in Melio / Riskified / Gong logs
  /4-5\+?\s*years of professional experience as a software engineer/i, // Melio Full Stack Engineer (NYC)
  /7\+\s*years of experience in data infra or backend engineering/i, // Melio Data and AI Infra Tech Lead
  /4\+\s*years as a Product Manager/i, // Melio Product Manager roles
  /5\+\s*years of backend development experience/i, // Gong Backend Engineer
  /4\+\s*years of experience in a data-centric industry role/i, // Riskified Data Integration Engineer
  /5\+\s*years of experience in DevOps/i, // Riskified DevOps Engineer
  /Senior DevOps Engineer/i, // appears inside DevOps Engineer description

  // Leadership / management language in descriptions
  /experienced team leader/i, // Head of DevOps
  /experience in managing managers/i,
  /lead a large and growing team/i,
];

// Optional per-company overrides (kept simple for now; can be extended later)
const companyOverrides = {
  // Example structure – currently empty, but left here for future tuning
  // melio: {
  //   allowedTechnicalDepartments: ['Engineering', 'Product Management'],
  // },
};

module.exports = {
  departmentsBlacklist,
  allowedTechnicalDepartments,
  technicalTitleKeywords,
  titleSeniorPatterns,
  contentSeniorityPatterns,
  companyOverrides,
};


