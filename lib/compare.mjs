import { round } from './stats.mjs';

const LOWER_IS_BETTER = ['lcp', 'cls', 'tbt', 'fcp', 'si', 'ttfb'];

export function budgetsFor(cfg, urlName) {
  const entry = cfg.urls.find((u) => u.name === urlName);
  return { ...cfg.budgets, ...(entry?.budgets ?? {}) };
}

/** [{ metric, value, limit, pass }] for every budget that has a value. */
export function checkBudgets(metrics, budgets) {
  const out = [];
  for (const [metric, limit] of Object.entries(budgets ?? {})) {
    if (limit === null || limit === undefined) continue;
    const value = metrics?.[metric];
    if (typeof value !== 'number') continue;
    const pass = metric === 'score' ? value >= limit : value <= limit;
    out.push({ metric, value, limit, pass });
  }
  return out;
}

/** Latest earlier run that measured this page successfully under the same conditions. */
export function findBaseline(runs, current, urlName) {
  const idx = runs.findIndex((r) => r.id === current.id);
  const earlier = idx === -1 ? runs.filter((r) => r.createdAt < current.createdAt) : runs.slice(0, idx);
  for (let i = earlier.length - 1; i >= 0; i--) {
    const r = earlier[i];
    if (r.engine !== current.engine || r.formFactor !== current.formFactor) continue;
    const res = r.results?.find((x) => x.name === urlName && x.metrics);
    if (res) return { run: r, result: res };
  }
  return null;
}

/**
 * Compares two metric sets. A metric regresses only if it got worse by more
 * than BOTH the absolute and the relative threshold, which keeps normal
 * Lighthouse noise from raising false alarms.
 */
export function diffMetrics(before, after, thresholds) {
  const t = thresholds;
  const deltas = {};
  const regressions = [];
  const improvements = [];
  for (const m of ['score', ...LOWER_IS_BETTER]) {
    const a = before?.[m];
    const b = after?.[m];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const delta = b - a;
    const pct = a === 0 ? null : (delta / a) * 100;
    deltas[m] = { before: a, after: b, delta: round(delta, m === 'cls' ? 3 : 0), pct: round(pct, 1) };

    let worse = false;
    let better = false;
    if (m === 'score') {
      worse = -delta >= t.score;
      better = delta >= t.score;
    } else if (m === 'cls') {
      worse = delta >= t.cls;
      better = -delta >= t.cls;
    } else if (m === 'lcp' || m === 'fcp' || m === 'si' || m === 'ttfb') {
      worse = delta >= t.lcpMs && (pct ?? 0) >= t.lcpPct;
      better = -delta >= t.lcpMs && -(pct ?? 0) >= t.lcpPct;
    } else if (m === 'tbt') {
      worse = delta >= t.tbtMs && (pct ?? 0) >= t.tbtPct;
      better = -delta >= t.tbtMs && -(pct ?? 0) >= t.tbtPct;
    }
    if (worse) regressions.push(m);
    if (better) improvements.push(m);
  }
  return { deltas, regressions, improvements };
}

/** Adds budgets and baseline comparison to every result of a run record (mutates and returns it). */
export function annotateRun(record, runs, cfg) {
  for (const res of record.results) {
    if (!res.metrics) continue;
    res.budgets = checkBudgets(res.metrics, budgetsFor(cfg, res.name));
    const base = findBaseline(runs, record, res.name);
    if (base) {
      res.baseline = {
        runId: base.run.id,
        sha: base.run.git?.shortSha ?? null,
        subject: base.run.git?.subject ?? null,
        createdAt: base.run.createdAt,
        trigger: base.run.trigger,
      };
      Object.assign(res, diffMetrics(base.result.metrics, res.metrics, cfg.regression));
    } else {
      res.baseline = null;
      res.regressions = [];
      res.improvements = [];
    }
  }
  record.summary = {
    pages: record.results.length,
    failedPages: record.results.filter((r) => r.error).length,
    regressions: record.results.reduce((n, r) => n + (r.regressions?.length ?? 0), 0),
    budgetFailures: record.results.reduce((n, r) => n + (r.budgets?.filter((b) => !b.pass).length ?? 0), 0),
  };
  return record;
}
