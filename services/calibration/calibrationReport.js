/**
 * Calibration report generation and dual-trigger (volume + time).
 * Master PRD: aggregation queries, .md report, volume-based cleanup.
 */

const VOLUME_THRESHOLD_BYTES = 350 * 1024 * 1024; // 350 MB
const CALIBRATION_REJECTED = 'calibration_rejected';
const CALIBRATION_PASSED = 'calibration_passed';
const RUN_SUMMARIES = 'run_summaries';
const LINKEDIN_LOOKBACK_DAYS = 30;

/**
 * Check if database size exceeds volume threshold.
 * @param {import('../storage/MongoStorageAdapter')} storageAdapter
 * @returns {Promise<boolean>}
 */
async function checkVolumeTrigger(storageAdapter) {
  if (!storageAdapter || typeof storageAdapter.getDbSizeBytes !== 'function') return false;
  const bytes = await storageAdapter.getDbSizeBytes();
  return bytes >= VOLUME_THRESHOLD_BYTES;
}

/**
 * Run volume cleanup protocol (purge calibration_rejected >7d, drop zombie collections).
 * @param {import('../storage/MongoStorageAdapter')} storageAdapter
 * @returns {Promise<Object>}
 */
async function runVolumeCleanup(storageAdapter) {
  if (!storageAdapter || typeof storageAdapter.runVolumeCleanupProtocol !== 'function') {
    return { purgedRejected: 0, droppedCollections: [] };
  }
  return storageAdapter.runVolumeCleanupProtocol();
}

/**
 * Run aggregation pipelines and return markdown report.
 * @param {import('../storage/MongoStorageAdapter')} storageAdapter
 * @returns {Promise<string>}
 */
async function generateCalibrationReportMd(storageAdapter) {
  if (!storageAdapter) return '# Calibration Report\n\nNo storage adapter.';

  const lines = [];
  const now = new Date().toISOString();

  lines.push('# ATS Calibration Report');
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push('');

  try {
    const rejCol = await storageAdapter.getCollection(CALIBRATION_REJECTED);
    const passCol = await storageAdapter.getCollection(CALIBRATION_PASSED);
    const sumCol = await storageAdapter.getCollection(RUN_SUMMARIES);

    const rejectedTotal = await rejCol.countDocuments();
    const passedTotal = await passCol.countDocuments();
    const ratio = passedTotal + rejectedTotal > 0
      ? ((passedTotal / (passedTotal + rejectedTotal)) * 100).toFixed(2)
      : '0';
    lines.push('## Global Metrics');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Jobs passed | ${passedTotal} |`);
    lines.push(`| Jobs rejected | ${rejectedTotal} |`);
    lines.push(`| Pass ratio | ${ratio}% |`);
    lines.push('');

    // LinkedIn Search Efficiency (Query Matrix) — derived from run_summaries + calibration_rejected
    const linkedinLookbackStart = new Date(Date.now() - LINKEDIN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const linkedinSummaries = await sumCol.find({
      source: 'linkedin',
      createdAt: { $gte: linkedinLookbackStart },
    }).toArray();

    lines.push('## LinkedIn Search Efficiency (Query Matrix)');
    lines.push('');

    if (linkedinSummaries.length === 0) {
      lines.push('_No LinkedIn run summaries available in the selected window._');
      lines.push('');
    } else {
      let totalRuns = linkedinSummaries.length;
      let successRuns = 0;
      let totalDurationSec = 0;
      let durationCount = 0;
      let totalQuotaHits = 0;
      let totalQueriesRun = 0;
      let totalBlacklist = 0;
      let totalWhitelist = 0;
      let totalAlreadySeen = 0;
      let totalReposts = 0;
      let totalErrors = 0;

      const queryAgg = {}; // { [query]: { rawTotal, newTotal, runsWithData, zeroRawRuns } }

      for (const doc of linkedinSummaries) {
        const payload = doc.payload || {};
        const status = payload.status || 'UNKNOWN';
        if (status === 'SUCCESS' || status === 'QUOTA_REACHED') {
          successRuns += 1;
        }

        const start = payload.startTime ? new Date(payload.startTime) : null;
        const end = payload.endTime ? new Date(payload.endTime) : null;
        if (
          start &&
          end &&
          !Number.isNaN(start.getTime()) &&
          !Number.isNaN(end.getTime())
        ) {
          const dur = (end.getTime() - start.getTime()) / 1000;
          if (dur >= 0) {
            totalDurationSec += dur;
            durationCount += 1;
          }
        }

        const filteredOut = payload.filteredOut || {};
        const errors = typeof payload.errors === 'number' ? payload.errors : 0;

        if (filteredOut.quotaHit) {
          totalQuotaHits += 1;
        }
        totalQueriesRun += typeof payload.totalQueries === 'number' ? payload.totalQueries : 0;
        totalBlacklist += typeof filteredOut.blacklist === 'number' ? filteredOut.blacklist : 0;
        totalWhitelist += typeof filteredOut.whitelist === 'number' ? filteredOut.whitelist : 0;
        totalAlreadySeen += typeof filteredOut.alreadySeen === 'number' ? filteredOut.alreadySeen : 0;
        totalReposts += typeof payload.repostsDetected === 'number' ? payload.repostsDetected : 0;
        totalErrors += errors;

        const queryLog = payload.queryLog || {};
        for (const [query, stats] of Object.entries(queryLog)) {
          if (!queryAgg[query]) {
            queryAgg[query] = {
              rawTotal: 0,
              newTotal: 0,
              runsWithData: 0,
              zeroRawRuns: 0,
            };
          }
          const raw = typeof stats.raw === 'number' ? stats.raw : 0;
          const nw = typeof stats.new === 'number' ? stats.new : 0;
          const agg = queryAgg[query];
          agg.rawTotal += raw;
          agg.newTotal += nw;
          agg.runsWithData += 1;
          if (raw === 0) {
            agg.zeroRawRuns += 1;
          }
        }
      }

      const successRate = totalRuns
        ? ((successRuns / totalRuns) * 100).toFixed(1)
        : '0.0';
      const avgDurationSec = durationCount > 0 ? totalDurationSec / durationCount : NaN;

      lines.push('### LinkedIn Run Health');
      lines.push('');
      lines.push(`- Success Rate: ${successRate}%`);
      lines.push(`- Avg Duration: ${Number.isFinite(avgDurationSec) && avgDurationSec >= 0 ? `${avgDurationSec.toFixed(1)}s` : 'N/A'}`);
      lines.push(`- Total Quota Hits: ${totalQuotaHits}`);
      lines.push(`- Total Queries Run: ${totalQueriesRun}`);
      lines.push('');
      lines.push('### LinkedIn Filtering Calibration');
      lines.push('');
      lines.push(`- Blacklist Rejections: ${totalBlacklist}`);
      lines.push(`- Whitelist Rejections: ${totalWhitelist}`);
      lines.push(`- AlreadySeen (Silent Dedup): ${totalAlreadySeen}`);
      lines.push(`- Reposts Detected: ${totalReposts}`);
      lines.push(`- Total Errors: ${totalErrors}`);
      lines.push('');

      const deadQueries = Object.entries(queryAgg)
        .filter(([, agg]) => agg.runsWithData > 0 && agg.rawTotal === 0)
        .sort(([, a], [, b]) => b.zeroRawRuns - a.zeroRawRuns);

      const topPerformers = Object.entries(queryAgg)
        .filter(([, agg]) => agg.newTotal > 0 && agg.runsWithData > 0)
        .map(([query, agg]) => ({
          query,
          avgNewPerRun: agg.newTotal / agg.runsWithData,
          runsWithData: agg.runsWithData,
        }))
        .sort((a, b) => b.avgNewPerRun - a.avgNewPerRun)
        .slice(0, 5);

      lines.push('### Dead Queries (Matrix Calibration)');
      lines.push('');
      if (deadQueries.length === 0) {
        lines.push('- None detected in this window.');
      } else {
        for (const [query, agg] of deadQueries) {
          lines.push(
            `- "${query}" (Failed ${agg.zeroRawRuns} time(s) with zero raw results)`
          );
        }
      }
      lines.push('');

      lines.push('### Top Performers');
      lines.push('');
      if (topPerformers.length === 0) {
        lines.push('- No queries with non-zero yield in this window.');
      } else {
        for (const item of topPerformers) {
          lines.push(
            `- "${item.query}" (Avg ${item.avgNewPerRun.toFixed(
              2
            )} jobs/run over ${item.runsWithData} run(s))`
          );
        }
      }
      lines.push('');

      const linkedinRejByReason = await rejCol.aggregate([
        { $match: { source: 'linkedin', gate: 'linkedin_title' } },
        {
          $group: {
            _id: { $ifNull: ['$reason', '(no reason)'] },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 15 },
      ]).toArray();

      lines.push('### LinkedIn Semantic Drops (Title Filter)');
      lines.push('');
      if (linkedinRejByReason.length === 0) {
        lines.push('_No LinkedIn semantic rejections recorded in calibration_rejected._');
      } else {
        lines.push('| Reason | Count |');
        lines.push('|--------|-------|');
        for (const r of linkedinRejByReason) {
          const reasonStr = (r._id != null ? String(r._id) : '(no reason)').replace(/\|/g, '\\|');
          lines.push(`| ${reasonStr} | ${r.count} |`);
        }
      }
      lines.push('');
    }

    const bySourceRej = await rejCol.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    lines.push('## Rejected by Source');
    lines.push('');
    lines.push('| Source | Count |');
    lines.push('|--------|-------|');
    for (const r of bySourceRej) {
      lines.push(`| ${r._id || 'unknown'} | ${r.count} |`);
    }
    lines.push('');

    const byGate = await rejCol.aggregate([
      { $match: { gate: { $exists: true, $ne: null } } },
      { $group: { _id: '$gate', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    lines.push('## Rejected by Gate');
    lines.push('');
    lines.push('| Gate | Count |');
    lines.push('|------|-------|');
    for (const g of byGate) {
      lines.push(`| ${g._id || 'unknown'} | ${g.count} |`);
    }
    lines.push('');

    const byReason = await rejCol.aggregate([
      {
        $match: {
          reason: { $not: /^Location/i },
          $or: [{ gate: { $ne: 'location' } }, { gate: { $exists: false } }],
        },
      },
      { $group: { _id: { $ifNull: ['$reason', '(no reason)'] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 25 },
    ]).toArray();
    lines.push('## Top Specific Rejection Reasons');
    lines.push('');
    lines.push('| Reason | Count |');
    lines.push('|--------|-------|');
    for (const r of byReason) {
      const reasonStr = (r._id != null ? String(r._id) : '(no reason)').replace(/\|/g, '\\|');
      lines.push(`| ${reasonStr} | ${r.count} |`);
    }
    lines.push('');

    const bySourcePass = await passCol.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    lines.push('## Passed by Source');
    lines.push('');
    lines.push('| Source | Count |');
    lines.push('|--------|-------|');
    for (const p of bySourcePass) {
      lines.push(`| ${p._id || 'unknown'} | ${p.count} |`);
    }
    lines.push('');

    // Pipeline 6: Top Pass Keywords (unwind matchedKeywords from calibration_passed)
    try {
      const topKeywords = await passCol.aggregate([
        { $match: { matchedKeywords: { $exists: true, $ne: null } } },
        { $unwind: '$matchedKeywords' },
        { $group: { _id: '$matchedKeywords', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 15 },
      ]).toArray();
      if (topKeywords.length > 0) {
        lines.push('## Top Pass Keywords');
        lines.push('');
        lines.push('| Keyword | Count |');
        lines.push('|---------|-------|');
        for (const k of topKeywords) {
          lines.push(`| ${k._id || 'unknown'} | ${k.count} |`);
        }
        lines.push('');
      }
    } catch (_kwErr) {
      lines.push('## Top Pass Keywords');
      lines.push('');
      lines.push('_Aggregation unavailable._');
      lines.push('');
    }

    // Pipeline 7: Operational Health (skippedDedup + wafBlocks from run_summaries, last 7 days)
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const healthDocs = await sumCol.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: null,
            totalSkippedDedup: {
              $sum: { $ifNull: ['$payload.totalSkippedDedup', 0] }
            },
            wafBlocks: {
              $sum: { $ifNull: ['$payload.wafBlocks', 0] }
            },
            runs: { $sum: 1 },
            avgDurationMs: {
              $avg: { $ifNull: ['$payload.totalDurationMs', 0] }
            },
          },
        },
      ]).toArray();
      const h = healthDocs[0] || { totalSkippedDedup: 0, wafBlocks: 0, runs: 0, avgDurationMs: 0 };
      lines.push('## Operational Health (last 7 days)');
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      lines.push(`| Total runs | ${h.runs} |`);
      lines.push(`| Jobs skipped (Silent Dedup) | ${h.totalSkippedDedup} |`);
      lines.push(`| Workday WAF blocks (403) | ${h.wafBlocks} |`);
      lines.push(`| Avg run duration | ${h.avgDurationMs ? Math.round(h.avgDurationMs / 1000) + 's' : 'N/A'} |`);
      lines.push('');
    } catch (_healthErr) {
      lines.push('## Operational Health (last 7 days)');
      lines.push('');
      lines.push('_Aggregation unavailable._');
      lines.push('');
    }

    // Exhaustive List: ALL Passed Jobs (no limit)
    try {
      const allPassed = await passCol.find({}).sort({ createdAt: -1 }).toArray();
      lines.push('## Exhaustive List: Passed Jobs');
      lines.push('');
      if (allPassed.length === 0) {
        lines.push('_No passed jobs in calibration_passed._');
      } else {
        for (const j of allPassed) {
          const title = (j.title || 'Unknown').replace(/\n/g, ' ').trim();
          const company = (j.companyName || j.companyId || j.sourceCompanyId || 'N/A').replace(/\n/g, ' ').trim();
          const kw = Array.isArray(j.matchedKeywords) && j.matchedKeywords.length > 0
            ? j.matchedKeywords.join(', ')
            : 'none';
          lines.push(`- ${title} @ ${company} (Keyword: ${kw})`);
        }
      }
      lines.push('');
    } catch (_passErr) {
      lines.push('## Exhaustive List: Passed Jobs');
      lines.push('');
      lines.push('_Query unavailable._');
      lines.push('');
    }

    // Exhaustive List: ALL Semantic Rejected Jobs (exclude location gate + Location:* reasons)
    try {
      const allRejected = await rejCol.find({
        $and: [
          { $or: [{ gate: { $nin: ['location'] } }, { gate: { $exists: false } }] },
          { reason: { $not: /^Location/i } },
        ],
      }).sort({ createdAt: -1 }).toArray();
      lines.push('## Exhaustive List: Rejected Jobs (Semantic & Guard)');
      lines.push('');
      if (allRejected.length === 0) {
        lines.push('_No semantic/guard rejections (location-only drops excluded)._');
      } else {
        for (const j of allRejected) {
          const title = (j.title || 'Unknown').replace(/\n/g, ' ').trim();
          const company = (j.companyName || j.companyId || j.sourceCompanyId || 'N/A').replace(/\n/g, ' ').trim();
          const reason = (j.reason || 'N/A').replace(/\n/g, ' ').trim();
          lines.push(`- ${title} @ ${company} -> REJECTED: ${reason}`);
        }
      }
      lines.push('');
    } catch (_rejErr) {
      lines.push('## Exhaustive List: Rejected Jobs (Semantic & Guard)');
      lines.push('');
      lines.push('_Query unavailable._');
      lines.push('');
    }

    const recentSummaries = await sumCol.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    if (recentSummaries.length > 0) {
      lines.push('## Recent Run Summaries (sample)');
      lines.push('');
      for (const s of recentSummaries) {
        const src = s.source || s.payload?.source || '?';
        const ts = s.createdAt || s.timestamp;
        lines.push(`- **${src}** @ ${ts}`);
      }
    }
  } catch (err) {
    lines.push('## Error');
    lines.push('');
    lines.push(`Report generation failed: ${err.message || err}`);
  }

  return lines.join('\n');
}

/**
 * Run calibration: optionally run cleanup (on volume trigger), generate report, send email with .md attachment.
 * @param {import('../storage/MongoStorageAdapter')} storageAdapter
 * @param {import('../EmailNotifier')} emailNotifier
 * @param {'volume'|'time'} triggerType
 * @returns {Promise<boolean>}
 */
async function runCalibrationAndNotify(storageAdapter, emailNotifier, triggerType) {
  if (triggerType === 'volume') {
    const cleanup = await runVolumeCleanup(storageAdapter);
    console.log(`Calibration: Volume cleanup purged ${cleanup.purgedRejected} rejected, dropped: ${(cleanup.droppedCollections || []).join(', ') || 'none'}`);
  }

  const md = await generateCalibrationReportMd(storageAdapter);
  if (emailNotifier && typeof emailNotifier.sendCalibrationAlert === 'function') {
    const subject = triggerType === 'volume'
      ? '\u{1F6A8} System Alert: DB Volume Trigger'
      : '\u{1F4CA} Weekly Calibration Report';
    return emailNotifier.sendCalibrationAlert(subject, md, triggerType);
  }
  console.log('Calibration report (no email):\n' + md.substring(0, 500) + '...');
  return true;
}

module.exports = {
  checkVolumeTrigger,
  runVolumeCleanup,
  generateCalibrationReportMd,
  runCalibrationAndNotify,
  VOLUME_THRESHOLD_BYTES,
};
