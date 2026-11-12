import fs from 'node:fs';
import path from 'node:path';
import { vitalsDir, loadConfig } from './config.mjs';
import { listRuns } from './store.mjs';
import { budgetsFor } from './compare.mjs';
import { fmtMetric } from './format.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CHARTS = [
  { key: 'score', label: 'Performance score', higherIsBetter: true },
  { key: 'lcp', label: 'Largest Contentful Paint' },
  { key: 'cls', label: 'Cumulative Layout Shift' },
  { key: 'tbt', label: 'Total Blocking Time' },
];

/** Points for one page and metric, oldest first. */
export function seriesFor(runs, pageName, metric) {
  const pts = [];
  for (const run of runs) {
    const r = run.results?.find((x) => x.name === pageName);
    const v = r?.metrics?.[metric];
    if (typeof v !== 'number') continue;
    pts.push({
      value: v,
      trigger: run.trigger,
      sha: run.git?.shortSha ?? null,
      subject: run.git?.subject ?? '',
      createdAt: run.createdAt,
      regressed: r.regressions?.includes(metric) ?? false,
      formFactor: run.formFactor,
      engine: run.engine,
    });
  }
  return pts;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 2.4, 3.2, 4, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function chartSvg(points, { key, label }, budget) {
  const W = 560;
  const H = 180;
  const pad = { l: 52, r: 16, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = key === 'score' ? 100 : niceMax(Math.max(...points.map((p) => p.value), budget ?? 0) * 1.08);
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  const grid = ticks
    .map(
      (t) =>
        `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/>` +
        `<text x="${pad.l - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${esc(fmtMetric(key, t))}</text>`,
    )
    .join('');
  const showBudget = typeof budget === 'number' && budget <= max;
  const budgetLine = showBudget ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(budget)}" y2="${y(budget)}" class="budget"/>` : '';
  // Drawn last, with a halo, so data points never hide it.
  const budgetLabel = showBudget
    ? `<text x="${pad.l + 6}" y="${y(budget) - 5}" class="tick budget-label">budget ${esc(fmtMetric(key, budget))}</text>`
    : '';
  const line = points.length > 1 ? `<polyline class="line" points="${points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')}"/>` : '';
  const marks = points
    .map((p, i) => {
      const cx = x(i);
      const cy = y(p.value);
      const title = `${fmtMetric(key, p.value)} · ${p.trigger}${p.sha ? ` · ${p.sha}` : ''} · ${p.createdAt.slice(0, 16).replace('T', ' ')}${p.subject ? `\n${p.subject}` : ''}${p.regressed ? '\nregression' : ''}`;
      const shape =
        p.trigger === 'daily'
          ? `<rect x="${cx - 4.5}" y="${cy - 4.5}" width="9" height="9" rx="1.5" class="pt daily${p.regressed ? ' bad' : ''}"/>`
          : `<circle cx="${cx}" cy="${cy}" r="${p.trigger === 'commit' ? 5 : 4.5}" class="pt ${p.trigger === 'commit' ? 'commit' : 'manual'}${p.regressed ? ' bad' : ''}"/>`;
      return `<g><title>${esc(title)}</title>${shape}</g>`;
    })
    .join('');
  return `<figure class="chart"><figcaption>${esc(label)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} over time">${grid}${budgetLine}${line}${marks}${budgetLabel}</svg></figure>`;
}

function tile(key, value, budget, delta) {
  const pass = typeof budget !== 'number' ? null : key === 'score' ? value >= budget : value <= budget;
  const cls = pass === null ? '' : pass ? 'ok' : 'over';
  const d = delta && delta.delta !== 0 ? `<span class="delta ${delta.regressed ? 'worse' : ''}">${delta.delta > 0 ? '+' : ''}${esc(key === 'cls' ? delta.delta.toFixed(3) : key === 'score' ? delta.delta : Math.round(delta.delta) + ' ms')}</span>` : '';
  return `<div class="tile ${cls}"><div class="k">${esc(key.toUpperCase())}</div><div class="v">${esc(fmtMetric(key, value))}</div>${d}</div>`;
}

export function renderReport(root, { runs = listRuns(root), cfg = loadConfig(root), now = new Date() } = {}) {
  // Only chart runs comparable with the current setup.
  const comparable = runs.filter((r) => r.formFactor === cfg.formFactor && r.engine === cfg.engine);
  const project = path.basename(root);
  const pages = cfg.urls
    .map((page) => {
      const budgets = budgetsFor(cfg, page.name);
      const lastRun = [...comparable].reverse().find((r) => r.results?.some((x) => x.name === page.name && x.metrics));
      const last = lastRun?.results.find((x) => x.name === page.name);
      if (!last) {
        return `<section class="page"><h2>${esc(page.name)}</h2><p class="url">${esc(page.url)}</p><p class="empty">No measurements yet.</p></section>`;
      }
      const tiles = ['score', 'lcp', 'cls', 'tbt', 'fcp']
        .map((k) => tile(k, last.metrics[k], budgets[k], last.deltas?.[k] ? { ...last.deltas[k], regressed: last.regressions?.includes(k) } : null))
        .join('');
      const charts = CHARTS.map((c) => chartSvg(seriesFor(comparable, page.name, c.key), c, budgets[c.key])).join('');
      const opps = (last.opportunities ?? [])
        .slice(0, 5)
        .map((o) => `<li>${esc(o.title)}${o.savingsMs ? ` <span class="muted">~${o.savingsMs} ms</span>` : ''}${o.clsSaving ? ` <span class="muted">CLS −${o.clsSaving}</span>` : ''}</li>`)
        .join('');
      return `<section class="page">
  <h2>${esc(page.name)}</h2>
  <p class="url"><a href="${esc(page.url)}">${esc(page.url)}</a> · last measured ${esc(lastRun.createdAt.slice(0, 16).replace('T', ' '))}${lastRun.git ? ` at <code>${esc(lastRun.git.shortSha)}</code> ${esc(lastRun.git.subject)}` : ''}</p>
  <div class="tiles">${tiles}</div>
  <div class="charts">${charts}</div>
  ${opps ? `<h3>Top opportunities</h3><ol class="opps">${opps}</ol>` : ''}
</section>`;
    })
    .join('\n');

  const rows = [...comparable]
    .reverse()
    .slice(0, 50)
    .flatMap((run) =>
      run.results.map((r) => {
        const m = r.metrics ?? {};
        const bad = (k) => (r.regressions?.includes(k) ? ' class="worse"' : '');
        return `<tr><td>${esc(run.createdAt.slice(0, 16).replace('T', ' '))}</td><td><code>${esc(run.git?.shortSha ?? '—')}</code></td><td class="subject">${esc(run.git?.subject ?? '')}</td><td><span class="badge ${esc(run.trigger)}">${esc(run.trigger)}</span></td><td>${esc(r.name)}</td>${
          r.error
            ? `<td colspan="4" class="worse">${esc(r.error.slice(0, 120))}</td>`
            : `<td${bad('score')}>${esc(fmtMetric('score', m.score))}</td><td${bad('lcp')}>${esc(fmtMetric('lcp', m.lcp))}</td><td${bad('cls')}>${esc(fmtMetric('cls', m.cls))}</td><td${bad('tbt')}>${esc(fmtMetric('tbt', m.tbt))}</td>`
        }</tr>`;
      }),
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Commit Vitals · ${esc(project)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--accent:#2f6fde;--ok:#1f8a4c;--bad:#d1343a;--warn:#b86e00}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1b1b1f;--text:#ececef;--muted:#9a9aa2;--line:#2c2c32;--accent:#6c9cff;--ok:#4cc27e;--bad:#ff6b6b;--warn:#f0a63a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 64px}header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:24px}
h1{font-size:24px;margin:0}h2{font-size:19px;margin:0}h3{font-size:14px;margin:20px 0 6px;color:var(--muted);font-weight:600}
.muted,.url,.meta{color:var(--muted)}.url{margin:2px 0 14px;font-size:13px}a{color:var(--accent)}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.page{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:10px;padding:10px 12px;border-left:4px solid var(--line)}.tile.ok{border-left-color:var(--ok)}.tile.over{border-left-color:var(--bad)}
.tile .k{font-size:11px;letter-spacing:.06em;color:var(--muted)}.tile .v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
.delta{font-size:12px;color:var(--muted)}.delta.worse,.worse{color:var(--bad);font-weight:600}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:12px;margin-top:16px}
.chart{margin:0;border:1px solid var(--line);border-radius:10px;padding:10px 8px 4px}.chart figcaption{font-size:13px;font-weight:600;padding:0 6px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--line);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
.budget{stroke:var(--warn);stroke-dasharray:5 4;stroke-width:1.5}.budget-label{fill:var(--warn);paint-order:stroke;stroke:var(--card);stroke-width:4px;stroke-linejoin:round}
.line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;opacity:.55}
.pt{stroke:var(--card);stroke-width:1.5}.pt.commit{fill:var(--accent)}.pt.daily{fill:var(--muted)}.pt.manual{fill:var(--card);stroke:var(--accent);stroke-width:2}.pt.bad{fill:var(--bad);stroke:var(--bad)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--muted)}.legend span::before{content:"";display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px;border-radius:50%;background:var(--accent)}
.legend .l-daily::before{border-radius:2px;background:var(--muted)}.legend .l-manual::before{background:transparent;border:2px solid var(--accent);width:6px;height:6px}.legend .l-bad::before{background:var(--bad)}
.opps{margin:0;padding-left:20px}.empty{color:var(--muted)}
.tablewrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px}td.subject{white-space:normal;min-width:180px;max-width:340px}
.badge{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line)}.badge.commit{color:var(--accent)}.badge.daily{color:var(--muted)}
footer{margin-top:28px;font-size:12px;color:var(--muted)}
</style>
</head>
<body><main>
<header><h1>Commit Vitals · ${esc(project)}</h1><span class="meta">${esc(cfg.engine)} · ${esc(cfg.formFactor)} · median of ${cfg.runs} run(s) · ${comparable.length} measurement(s)</span></header>
<div class="legend" style="margin-bottom:16px"><span>commit</span><span class="l-daily">daily</span><span class="l-manual">manual / on request</span><span class="l-bad">regression</span></div>
${pages}
<h2 style="margin:28px 0 10px">History</h2>
<div class="tablewrap"><table><thead><tr><th>When (UTC)</th><th>Commit</th><th>Message</th><th>Trigger</th><th>Page</th><th>Score</th><th>LCP</th><th>CLS</th><th>TBT</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">No measurements yet.</td></tr>'}</tbody></table></div>
<footer>Generated ${esc(now.toISOString().slice(0, 16).replace('T', ' '))} UTC by <a href="https://github.com/odranoelBR/commit-vitals">commit-vitals</a>. Lab data from Lighthouse; hover a point for its commit.</footer>
</main></body></html>
`;
}

export function writeReport(root, outFile) {
  const file = outFile ? path.resolve(outFile) : path.join(vitalsDir(root), 'report.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderReport(root));
  return file;
}
