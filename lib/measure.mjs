import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { readGitInfo } from './git.mjs';
import { lighthousePackage, runLocalLighthouse, runPsi, extractFromLhr } from './lighthouse.mjs';
import { median, spread } from './stats.mjs';
import { annotateRun } from './compare.mjs';
import { listRuns, saveRun } from './store.mjs';

const METRICS = ['score', 'lcp', 'cls', 'tbt', 'fcp', 'si', 'ttfb'];

/** Collapses N Lighthouse samples of one page into medians plus their min/max spread. */
export function aggregateSamples(samples) {
  const metrics = {};
  const spreads = {};
  for (const m of METRICS) {
    const values = samples.map((s) => s.metrics[m]);
    metrics[m] = median(values);
    spreads[m] = spread(values);
  }
  // Hints come from the sample closest to the median score, not from an outlier.
  const rep = samples.reduce((best, s) =>
    Math.abs((s.metrics.score ?? 0) - (metrics.score ?? 0)) < Math.abs((best.metrics.score ?? 0) - (metrics.score ?? 0)) ? s : best,
  );
  return {
    metrics,
    spread: spreads,
    opportunities: rep.opportunities,
    lcpElement: rep.lcpElement,
    field: samples.map((s) => s.field).find(Boolean) ?? null,
    finalUrl: rep.finalUrl,
    warnings: rep.warnings,
    lighthouseVersion: rep.lighthouseVersion,
  };
}

/** Polls the page until it reports the expected commit (meta tag or response header). */
export async function waitForDeploy(url, git, waitFor, { log = () => {}, fetchImpl = fetch, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + (waitFor.timeoutSec ?? 600) * 1000;
  const matches = (value) =>
    typeof value === 'string' && value.length >= 7 && (git.sha.startsWith(value.trim()) || value.trim().startsWith(git.shortSha));
  let last = null;
  for (;;) {
    try {
      const probe = new URL(url);
      probe.searchParams.set('_cv', Date.now().toString(36));
      const res = await fetchImpl(probe, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
      if (waitFor.type === 'header') {
        last = res.headers.get(waitFor.name);
      } else {
        const html = await res.text();
        last = readMeta(html, waitFor.name);
      }
      if (matches(last)) return { ok: true, value: last };
    } catch (e) {
      last = `error: ${e.message}`;
    }
    if (Date.now() >= deadline) return { ok: false, value: last };
    log(`waiting for ${url} to serve ${git.shortSha} (currently: ${last ?? 'not found'})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function readMeta(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!new RegExp(`(?:name|property)\\s*=\\s*["']${esc}["']`, 'i').test(tag)) continue;
    const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Measures every configured page (or the ones in `only`), stores the run in
 * .vitals/runs/ and returns { record, file }.
 */
export async function measureProject(root, { trigger = 'manual', only, log = () => {}, runner, fetchImpl } = {}) {
  const cfg = loadConfig(root);
  const git = readGitInfo(root);
  const pages = only?.length ? cfg.urls.filter((u) => only.includes(u.name)) : cfg.urls;
  if (!pages.length) throw new Error(`No configured page matches: ${only.join(', ')}`);

  const pkg = cfg.engine === 'local' ? lighthousePackage(cfg.lighthouse.version) : 'pagespeed-insights-api';
  const apiKey = process.env[cfg.psi.apiKeyEnv];
  const run =
    runner ??
    ((url) =>
      cfg.engine === 'psi'
        ? runPsi(url, { formFactor: cfg.formFactor, apiKey })
        : runLocalLighthouse(url, { formFactor: cfg.formFactor, chromeFlags: cfg.lighthouse.chromeFlags, pkg }));

  const results = [];
  let lighthouseVersion = null;
  for (const page of pages) {
    if (trigger === 'commit' && cfg.onCommit.waitFor && git) {
      const w = await waitForDeploy(page.url, git, cfg.onCommit.waitFor, { log, fetchImpl });
      if (!w.ok) {
        results.push({
          name: page.name,
          url: page.url,
          error: `deploy not confirmed: ${page.url} never reported ${git.shortSha} via ${cfg.onCommit.waitFor.type} "${cfg.onCommit.waitFor.name}" (last value: ${w.value ?? 'none'})`,
        });
        continue;
      }
    }
    const samples = [];
    const errors = [];
    for (let i = 0; i < cfg.runs; i++) {
      log(`${page.name}: run ${i + 1}/${cfg.runs}`);
      try {
        const { lhr, field } = await run(page.url);
        const ex = extractFromLhr(lhr);
        ex.field = field ?? null;
        samples.push(ex);
      } catch (e) {
        errors.push(e.message);
        log(`${page.name}: ${e.message}`);
      }
    }
    if (!samples.length) {
      results.push({ name: page.name, url: page.url, error: errors[0] ?? 'unknown error' });
      continue;
    }
    const agg = aggregateSamples(samples);
    lighthouseVersion ??= agg.lighthouseVersion;
    delete agg.lighthouseVersion;
    results.push({ name: page.name, url: page.url, samples: samples.length, ...agg, ...(errors.length ? { sampleErrors: errors } : {}) });
  }

  const cpu = os.cpus()[0];
  const record = {
    schema: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    trigger,
    engine: cfg.engine,
    formFactor: cfg.formFactor,
    runsPerUrl: cfg.runs,
    git,
    environment: {
      lighthouseVersion,
      lighthousePackage: pkg,
      node: process.version,
      platform: `${os.platform()}-${os.arch()}`,
      cpus: os.cpus().length,
      cpuModel: cpu?.model?.trim() ?? null,
    },
    results,
  };
  annotateRun(record, listRuns(root), cfg);
  const file = saveRun(root, record);
  return { record, file };
}
