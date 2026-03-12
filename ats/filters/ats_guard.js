const {
  departmentsBlacklist,
  allowedTechnicalDepartments,
  technicalTitleKeywords,
  titleSeniorPatterns,
  contentSeniorityPatterns,
  structuredLevelIndicators,
} = require('../../config/vocabulary');

/**
 * Best-effort extraction of core fields from a raw ATS job or UnifiedJob.
 * Works for Greenhouse, Comeet, Workday, and guardPayload-shaped objects.
 */
function extractJobFields(job) {
  if (!job || typeof job !== 'object') {
    return {
      title: '',
      location: '',
      departments: [],
      description: '',
      structuredLevel: null,
    };
  }

  const title = job.title || job.name || job.position || '';

  let location = '';
  const rawLocation = job.location;
  if (typeof rawLocation === 'string') {
    location = rawLocation;
  } else if (rawLocation && typeof rawLocation === 'object') {
    location =
      rawLocation.name ||
      rawLocation.fullName ||
      rawLocation.city ||
      rawLocation.region ||
      rawLocation.country ||
      '';
  }

  let departments = [];
  if (Array.isArray(job.departments)) {
    departments = job.departments
      .map((d) => (d && d.name ? String(d.name).trim() : null))
      .filter(Boolean);
  }
  // Workday: single structuredDepartment string -> treat as one department
  if (departments.length === 0 && job.structuredDepartment) {
    departments = [String(job.structuredDepartment).trim()];
  }

  let description = '';
  if (job.content != null) {
    description = String(job.content);
  } else if (job.description != null) {
    description = String(job.description);
  }
  // Workday: description is permanently null; do not stringify null
  if (job.description === null && job.content == null) {
    description = '';
  }

  const structuredLevel =
    job.structuredLevel != null
      ? job.structuredLevel
      : job.structuredSignals && job.structuredSignals.experience_level != null
        ? job.structuredSignals.experience_level
        : null;

  return {
    title: String(title).trim(),
    location: String(location).trim(),
    departments,
    description,
    structuredLevel: structuredLevel ? String(structuredLevel).trim() : null,
  };
}

function normalizeContent(htmlLike) {
  if (!htmlLike || typeof htmlLike !== 'string') return '';
  let text = htmlLike;

  // Basic named HTML entities.
  text = text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // Numeric entities (decimal and hex), e.g. &#10; or &#xA;.
  text = text
    .replace(/&#(\d+);/g, (_, code) => {
      const num = parseInt(code, 10);
      return Number.isFinite(num) ? String.fromCharCode(num) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const num = parseInt(hex, 16);
      return Number.isFinite(num) ? String.fromCharCode(num) : '';
    });

  // Strip HTML tags.
  text = text.replace(/<[^>]+>/g, ' ');

  // Collapse whitespace.
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Cheap title-level check to quickly discard non-technical or clearly senior roles.
 * Returns reasons with matched pattern for calibration aggregation.
 */
function runTitleCheck(title) {
  const reasons = [];
  const matchedKeywords = [];
  const matchedBlacklistPatterns = [];
  const trimmed = (title || '').trim();

  if (!trimmed) {
    reasons.push('FAIL: title_missing');
    return { passed: false, reasons, matchedKeywords, matchedBlacklistPatterns };
  }

  const lower = trimmed.toLowerCase();

  // Technical keywords that indicate this is at least an engineering / data role.
  const technicalKw = (technicalTitleKeywords || []).find((k) =>
    lower.includes(k.toLowerCase())
  );
  if (technicalKw) {
    matchedKeywords.push(technicalKw);
  }
  if (!(technicalTitleKeywords || []).some((k) => lower.includes(k.toLowerCase()))) {
    reasons.push(`FAIL: title_not_technical (${trimmed})`);
  }

  // Senior / leadership patterns from vocabulary.
  const seniorPattern = (titleSeniorPatterns || []).find((re) => re.test(trimmed));
  if (seniorPattern) {
    matchedBlacklistPatterns.push(seniorPattern.toString());
    reasons.push(`FAIL: title_senior (${trimmed})`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    matchedKeywords,
    matchedBlacklistPatterns,
  };
}

/**
 * Department-level check (medium cost).
 * Technical Override Rule: if any department is in allowedTechnicalDepartments, job passes
 * regardless of other blacklisted co-departments (e.g. Sales Engineer in Engineering + Sales).
 */
function runDepartmentCheck(departments) {
  if (!Array.isArray(departments) || departments.length === 0) {
    return { passed: true, reasons: [], gate: 'department' };
  }

  const reasons = [];
  const blacklist = departmentsBlacklist || [];
  const technicalDepts = allowedTechnicalDepartments || [];

  const deptNames = departments.map((d) => String(d).trim().toLowerCase());
  const hasTechnical = deptNames.some((name) =>
    technicalDepts.some((t) => t.toLowerCase() === name)
  );
  const blacklistedDept = departments.find((name) =>
    blacklist.some((b) => b.toLowerCase() === String(name).toLowerCase())
  );

  if (hasTechnical) {
    return { passed: true, reasons: [], gate: 'department' };
  }
  if (blacklistedDept) {
    reasons.push(`FAIL: department (${blacklistedDept})`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    gate: 'department',
  };
}

/**
 * Structured level fast-track: fast-PASS for junior, fast-FAIL for senior, neutral otherwise.
 */
function runStructuredLevelCheck(structuredLevel) {
  if (structuredLevel == null || String(structuredLevel).trim() === '') {
    return { passed: true, reasons: [], fastTrack: false, gate: 'structured_level' };
  }
  const val = String(structuredLevel).trim().toLowerCase();
  const junior = (structuredLevelIndicators && structuredLevelIndicators.juniorPass) || [];
  const senior = (structuredLevelIndicators && structuredLevelIndicators.seniorFail) || [];
  if (junior.some((k) => val.includes(k))) {
    return { passed: true, reasons: [], fastTrack: true, gate: 'structured_level' };
  }
  if (senior.some((k) => val.includes(k))) {
    return {
      passed: false,
      reasons: [`FAIL: structured_level (${structuredLevel})`],
      fastTrack: true,
      gate: 'structured_level',
    };
  }
  return { passed: true, reasons: [], fastTrack: false, gate: 'structured_level' };
}

/**
 * Description/content analysis (expensive).
 * Explicit null handling for Workday (description permanently null).
 */
function runDescriptionCheck(description) {
  if (description === null) {
    return { passed: true, reasons: [], gate: 'description' };
  }
  const normalized = normalizeContent(description);
  if (!normalized) {
    return { passed: true, reasons: [], gate: 'description' };
  }

  const hitPattern = (contentSeniorityPatterns || []).find((re) => re.test(normalized));
  if (!hitPattern) {
    return { passed: true, reasons: [], gate: 'description' };
  }

  return {
    passed: false,
    reasons: ['FAIL: description_seniority (years/leadership pattern)'],
    matchedBlacklistPatterns: [hitPattern.toString()],
    gate: 'description',
  };
}

/**
 * Main guard API.
 *
 * @param {Object} job Raw ATS job or UnifiedJob / guardPayload shape.
 * @param {Object} context Optional context (e.g. { companyId, source }).
 * @returns {{ verdict: 'PASS'|'FAIL', reason: string|null, details: object, gate: string|null, matchedKeywords: string[], matchedBlacklistPatterns: string[] }}
 */
function evaluateAtsGuard(job, context = {}) {
  const { title, location, departments, description, structuredLevel } =
    extractJobFields(job);

  const titleResult = runTitleCheck(title);
  const departmentResult = titleResult.passed
    ? runDepartmentCheck(departments)
    : { passed: false, reasons: [], gate: 'department' };
  const structuredResult =
    titleResult.passed && departmentResult.passed
      ? runStructuredLevelCheck(structuredLevel)
      : { passed: true, reasons: [], fastTrack: false, gate: 'structured_level' };

  // Student/Entry-level bypass: skip description_seniority when role is explicitly junior.
  // This leniency must not bypass title/department/structured checks.
  const isExplicitJuniorTitle = /\b(student|intern|internship|junior|entry\s*level|graduate)\b/i.test(title);
  const isStructuredStudentEmployment = !!(
    job &&
    job.structuredSignals &&
    typeof job.structuredSignals.employment_type === 'string' &&
    /\b(student|intern|internship)\b/i.test(job.structuredSignals.employment_type)
  );
  const isStructuredStudentFlag = !!(job && job.isStructuredStudent);
  const shouldBypassDescriptionForJunior =
    isExplicitJuniorTitle || isStructuredStudentEmployment || isStructuredStudentFlag;
  let descriptionResult;
  if (
    titleResult.passed &&
    departmentResult.passed &&
    structuredResult.passed &&
    shouldBypassDescriptionForJunior
  ) {
    descriptionResult = {
      passed: true,
      reasons: [],
      gate: 'description',
    };
  } else if (
    titleResult.passed &&
    departmentResult.passed &&
    structuredResult.passed
  ) {
    descriptionResult = runDescriptionCheck(description);
  } else {
    descriptionResult = { passed: false, reasons: [], gate: 'description' };
  }

  const allReasons = [
    ...titleResult.reasons,
    ...departmentResult.reasons,
    ...structuredResult.reasons,
    ...descriptionResult.reasons,
  ];

  const failedResult = titleResult.passed
    ? departmentResult.passed
      ? structuredResult.passed
        ? descriptionResult
        : descriptionResult
      : departmentResult
    : titleResult;
  const failGate =
    !titleResult.passed
      ? 'title'
      : !departmentResult.passed
        ? 'department'
        : !structuredResult.passed
          ? 'structured_level'
          : !descriptionResult.passed
            ? 'description'
            : null;

  const verdict = allReasons.length ? 'FAIL' : 'PASS';
  const reason = allReasons.length ? allReasons.join(' | ') : null;

  const matchedKeywords = titleResult.matchedKeywords || [];
  const matchedBlacklistPatterns = [
    ...(titleResult.matchedBlacklistPatterns || []),
    ...(descriptionResult.matchedBlacklistPatterns || []),
  ];

  return {
    verdict,
    reason,
    gate: failGate,
    matchedKeywords,
    matchedBlacklistPatterns,
    details: {
      companyId: context.companyId || null,
      source: context.source || null,
      title: title || null,
      location: location || null,
      departments,
    },
  };
}

module.exports = {
  evaluateAtsGuard,
};


