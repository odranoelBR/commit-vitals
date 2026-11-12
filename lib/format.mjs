import { diffMetrics } from './compare.mjs';

const LABEL = {
  score: 'Score',
  lcp: 'LCP',
  cls: 'CLS',
  tbt: 'TBT',
  fcp: 'FCP',
  si: 'Speed Index',
  ttfb: 'TTFB',
  inp: 'INP',
};

export function fmtMetric(metric, value) {
  if (typeof value !== 'number') return '—';
  if (metric === 'score') return String(Math.round(value));
  if (metric === 'cls') return value.toFixed(3);
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function fmtDelta(metric, d) {
  if (!d) return '';
  const sign = d.delta > 0 ? '+' : '';
  const v =
    metric === 'score' ? `${sign}${d.delta}` : metric === 'cls' ? `${sign}${d.delta.toFixed(3)}` : `${sign}${Math.round(d.delta)} ms`;
  return d.pct === null || metric === 'score' || metric === 'cls' ? v : `${v} (${sign}${d.pct}%)`;
}

/**
 * Markdown summary written for both humans and AI agents: it states what
 * changed, against which commit, and what Lighthouse suggests fixing first.
 */
export function summarizeRun(record) {
  const g = record.git;
  const lines = [];
  const head = g ? `\`${g.shortSha}\` ${g.subject}${g.dirty ? ' (uncommitted changes present)' : ''}` : 'no git commit';
  lines.push(`## commit-vitals — ${head}`);
  lines.push(
    `${record.createdAt} · trigger: ${record.trigger} · ${record.engine} · ${record.formFactor} · median of ${record.runsPerUrl} run(s)` +
      (record.environment?.lighthouseVersion ? ` · Lighthouse ${record.environment.lighthouseVersion}` : ''),
  );
  const s = record.summary;
  if (s) {
    const verdict =
      s.failedPages > 0
        ? `⚠️ ${s.failedPages} page(s) could not be measured`
        : s.regressions > 0
          ? `🔴 ${s.regressions} regression(s) detected`
          : s.budgetFailures > 0
            ? `🟠 no regressions, but ${s.budgetFailures} budget(s) over limit`
            : '🟢 no regressions, all budgets met';
    lines.push('', `**${verdict}**`);
  }

  for (const r of record.results) {
    lines.push('', `### ${r.name} — ${r.url}`);
    if (r.error) {
      lines.push(`Not measured: ${r.error}`);
      continue;
    }
    const cells = ['score', 'lcp', 'cls', 'tbt', 'fcp'].map((m) => {
      const flag = r.regressions?.includes(m) ? ' 🔴' : r.improvements?.includes(m) ? ' 🟢' : '';
      const delta = r.deltas?.[m] ? ` (${fmtDelta(m, r.deltas[m])})` : '';
      return `${LABEL[m]} ${fmtMetric(m, r.metrics[m])}${delta}${flag}`;
    });
    lines.push(cells.join(' · '));
    if (r.baseline) lines.push(`Compared with \`${r.baseline.sha ?? r.baseline.runId}\` (${r.baseline.trigger}, ${r.baseline.createdAt}).`);
    else lines.push('First measurement of this page — nothing to compare yet.');
    const failed = r.budgets?.filter((b) => !b.pass) ?? [];
    if (failed.length) {
      lines.push(
        `Over budget: ${failed.map((b) => `${LABEL[b.metric] ?? b.metric} ${fmtMetric(b.metric, b.value)} ${b.metric === 'score' ? '<' : '>'} ${fmtMetric(b.metric, b.limit)}`).join(', ')}`,
      );
    }
    if (r.withinNoise?.length) {
      lines.push(`Changed, but within run-to-run noise (ranges overlap): ${r.withinNoise.map((m) => LABEL[m] ?? m).join(', ')}.`);
    }
    if (r.spread?.score && r.spread.score.max - r.spread.score.min >= 10) {
      lines.push(`Noisy: score varied ${r.spread.score.min}–${r.spread.score.max} across runs; treat small changes with care.`);
    }
    if (r.field) {
      const f = r.field;
      lines.push(
        `Real users (CrUX, ${f.source}, p75): LCP ${fmtMetric('lcp', f.lcp)} · INP ${fmtMetric('inp', f.inp)} · CLS ${fmtMetric('cls', f.cls)}`,
      );
    }
    if (r.lcpElement?.snippet) lines.push(`LCP element: \`${r.lcpElement.snippet.replace(/`/g, "'").slice(0, 160)}\``);
    if (r.opportunities?.length) {
      lines.push('Top opportunities:');
      for (const o of r.opportunities.slice(0, 4)) {
        const gain = [o.savingsMs ? `~${o.savingsMs} ms` : null, o.clsSaving ? `CLS −${o.clsSaving}` : null, o.savingsBytes ? `${Math.round(o.savingsBytes / 1024)} KiB` : null]
          .filter(Boolean)
          .join(', ');
        lines.push(`- ${o.title}${gain ? ` — ${gain}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

export function summarizeHistory(runs, { urlName, limit = 10 } = {}) {
  const rows = runs.slice(-limit).reverse();
  if (!rows.length) return 'No measurements yet.';
  const lines = ['| when | commit | trigger | page | score | LCP | CLS | TBT |', '|---|---|---|---|---|---|---|---|'];
  for (const run of rows) {
    for (const r of run.results) {
      if (urlName && r.name !== urlName) continue;
      const m = r.metrics ?? {};
      lines.push(
        `| ${run.createdAt.slice(0, 16).replace('T', ' ')} | ${run.git?.shortSha ?? '—'} | ${run.trigger} | ${r.name} | ${r.error ? 'error' : fmtMetric('score', m.score)} | ${fmtMetric('lcp', m.lcp)} | ${fmtMetric('cls', m.cls)} | ${fmtMetric('tbt', m.tbt)} |`,
      );
    }
  }
  return lines.join('\n');
}

export function compareRunsText(from, to, cfg) {
  const lines = [`## ${from.git?.shortSha ?? from.id} → ${to.git?.shortSha ?? to.id}`];
  for (const r of to.results) {
    const before = from.results.find((x) => x.name === r.name);
    if (!r.metrics || !before?.metrics) {
      lines.push(`- ${r.name}: not comparable`);
      continue;
    }
    const d = diffMetrics(before.metrics, r.metrics, cfg.regression, { beforeSpread: before.spread, afterSpread: r.spread });
    const parts = Object.entries(d.deltas).map(([m, v]) => `${m} ${v.delta > 0 ? '+' : ''}${v.delta}`);
    const verdict = d.regressions.length ? `🔴 worse: ${d.regressions.join(', ')}` : d.improvements.length ? `🟢 better: ${d.improvements.join(', ')}` : 'no significant change';
    lines.push(`- ${r.name}: ${verdict} (${parts.join(', ')})`);
  }
  return lines.join('\n');
}
