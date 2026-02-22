const {
  departmentsBlacklist,
  technicalTitleKeywords,
  titleSeniorPatterns,
  contentSeniorityPatterns,
} = require('../../config/vocabulary');

/**
 * Best-effort extraction of core fields from a raw ATS job object.
 * Works for both Greenhouse and Comeet payloads.
 */
function extractJobFields(job) {
  if (!job || typeof job !== 'object') {
    return {
      title: '',
      location: '',
      departments: [],
      description: '',
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

  const description =
    job.content != null
      ? String(job.content)
      : job.description != null
        ? String(job.description)
        : '';

  return {
    title: String(title).trim(),
    location: String(location).trim(),
    departments,
    description,
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
 */
function runTitleCheck(title) {
  const reasons = [];
  const trimmed = (title || '').trim();

  if (!trimmed) {
    reasons.push('FAIL: title_missing');
    return { passed: false, reasons };
  }

  const lower = trimmed.toLowerCase();

  // Technical keywords that indicate this is at least an engineering / data role.
  const looksTechnical = (technicalTitleKeywords || []).some((k) =>
    lower.includes(k.toLowerCase())
  );
  if (!looksTechnical) {
    reasons.push(`FAIL: title_not_technical (${trimmed})`);
  }

  // Senior / leadership patterns from vocabulary.
  if (titleSeniorPatterns.some((re) => re.test(trimmed))) {
    reasons.push(`FAIL: title_senior (${trimmed})`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

/**
 * Department-level check (medium cost).
 */
function runDepartmentCheck(departments) {
  if (!Array.isArray(departments) || departments.length === 0) {
    return { passed: true, reasons: [] };
  }

  const reasons = [];
  const blacklist = departmentsBlacklist || [];

  const blacklistedDept = departments.find((name) =>
    blacklist.some((b) => b.toLowerCase() === String(name).toLowerCase())
  );

  if (blacklistedDept) {
    reasons.push(`FAIL: department (${blacklistedDept})`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

/**
 * Description/content analysis (expensive).
 */
function runDescriptionCheck(description) {
  const normalized = normalizeContent(description);
  if (!normalized) {
    return { passed: true, reasons: [] };
  }

  const hit = contentSeniorityPatterns.some((re) => re.test(normalized));
  if (!hit) {
    return { passed: true, reasons: [] };
  }

  return {
    passed: false,
    reasons: ['FAIL: description_seniority (years/leadership pattern)'],
  };
}

/**
 * Main guard API.
 *
 * @param {Object} job Raw ATS job (Greenhouse / Comeet shape).
 * @param {Object} context Optional context (e.g. { companyId, source }).
 * @returns {{ verdict: 'PASS' | 'FAIL', reason: string | null, details: object }}
 */
function evaluateAtsGuard(job, context = {}) {
  const { title, location, departments, description } = extractJobFields(job);

  const titleResult = runTitleCheck(title);
  const departmentResult = titleResult.passed
    ? runDepartmentCheck(departments)
    : { passed: false, reasons: [] };
  const descriptionResult =
    titleResult.passed && departmentResult.passed
      ? runDescriptionCheck(description)
      : { passed: false, reasons: [] };

  const allReasons = [
    ...titleResult.reasons,
    ...departmentResult.reasons,
    ...descriptionResult.reasons,
  ];

  const verdict = allReasons.length ? 'FAIL' : 'PASS';
  const reason = allReasons.length ? allReasons.join(' | ') : null;

  return {
    verdict,
    reason,
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


