function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeComeetJob(rawJob, company) {
  if (!rawJob || !rawJob.uid || !rawJob.name) {
    return null;
  }

  const jobId = `comeet_${safeString(rawJob.uid)}`;

  return {
    jobId,
    source: 'comeet',
    sourceCompanyId: company.id,
    title: safeString(rawJob.name),
    location: safeString(
      rawJob.location && rawJob.location.name
        ? rawJob.location.name
        : ''
    ),
    url: safeString(rawJob.url_active_page),
    description:
      rawJob.description != null ? String(rawJob.description) : null,
    raw: rawJob,
  };
}

function normalizeGreenhouseJob(rawJob, company) {
  if (!rawJob || rawJob.id == null || !rawJob.title) {
    return null;
  }

  const jobId = `gh_${safeString(rawJob.id)}`;

  return {
    jobId,
    source: 'greenhouse',
    sourceCompanyId: company.id,
    title: safeString(rawJob.title),
    location: safeString(
      rawJob.location && rawJob.location.name
        ? rawJob.location.name
        : ''
    ),
    url: safeString(rawJob.absolute_url),
    description:
      rawJob.content != null ? String(rawJob.content) : null,
    raw: rawJob,
  };
}

function normalizeJob(rawJob, company) {
  if (!company || !company.type) return null;
  if (company.type === 'comeet') {
    return normalizeComeetJob(rawJob, company);
  }
  if (company.type === 'greenhouse') {
    return normalizeGreenhouseJob(rawJob, company);
  }
  return null;
}

module.exports = {
  normalizeJob,
};



