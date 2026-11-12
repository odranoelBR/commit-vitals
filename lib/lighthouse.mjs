import { spawn } from 'node:child_process';

/** Lighthouse 13 requires Node >= 22.19; older Node gets Lighthouse 12. */
export function lighthousePackage(configVersion, nodeVersion = process.versions.node) {
  if (configVersion) return `lighthouse@${configVersion}`;
  const [maj, min] = nodeVersion.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 19) ? 'lighthouse@13' : 'lighthouse@12';
}

/**
 * Runs Lighthouse once on this machine through npx (downloaded on first use,
 * then cached). Needs Chrome/Chromium installed; set CHROME_PATH to pick one.
 */
export function runLocalLighthouse(url, { formFactor = 'mobile', chromeFlags = [], pkg, timeoutMs = 240_000 } = {}) {
  const args = [
    '--yes',
    pkg,
    url,
    '--output=json',
    '--output-path=stdout',
    '--quiet',
    '--only-categories=performance',
    `--chrome-flags=${chromeFlags.join(' ')}`,
  ];
  if (formFactor === 'desktop') args.push('--preset=desktop');

  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'npx.cmd' : 'npx', args, { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Lighthouse timed out after ${timeoutMs / 1000}s for ${url}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 20_000) err = err.slice(-20_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start npx: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      if (code !== 0) {
        return reject(new Error(`Lighthouse exited with code ${code}: ${lastLines(err) || 'no output'}`));
      }
      try {
        const lhr = JSON.parse(text);
        if (lhr.runtimeError) return reject(new Error(`Lighthouse runtime error: ${lhr.runtimeError.message}`));
        resolve({ lhr });
      } catch {
        reject(new Error(`Lighthouse did not return JSON: ${lastLines(err) || text.slice(0, 300)}`));
      }
    });
  });
}

function lastLines(s, n = 6) {
  return s.trim().split('\n').slice(-n).join('\n');
}

/**
 * Runs Lighthouse on Google's servers through the PageSpeed Insights API.
 * Public URLs only. Also returns real-user (CrUX) field data when Google has it.
 */
export async function runPsi(url, { formFactor = 'mobile', apiKey, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', formFactor === 'desktop' ? 'DESKTOP' : 'MOBILE');
  endpoint.searchParams.set('category', 'PERFORMANCE');
  if (apiKey) endpoint.searchParams.set('key', apiKey);
  const res = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PageSpeed Insights ${res.status}: ${body?.error?.message ?? res.statusText}`);
  return { lhr: body.lighthouseResult, field: extractField(body.loadingExperience) };
}

export function extractField(loadingExperience) {
  const m = loadingExperience?.metrics;
  if (!m) return null;
  const p = (key) => m[key]?.percentile ?? null;
  const cls = p('CUMULATIVE_LAYOUT_SHIFT_SCORE');
  return {
    source: loadingExperience.origin_fallback ? 'origin' : 'url',
    overall: loadingExperience.overall_category ?? null,
    lcp: p('LARGEST_CONTENTFUL_PAINT_MS'),
    inp: p('INTERACTION_TO_NEXT_PAINT'),
    cls: cls === null ? null : cls / 100,
    fcp: p('FIRST_CONTENTFUL_PAINT_MS'),
    ttfb: p('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
  };
}

const METRIC_AUDITS = {
  lcp: 'largest-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbt: 'total-blocking-time',
  fcp: 'first-contentful-paint',
  si: 'speed-index',
  ttfb: 'server-response-time',
};

/** Pulls the numbers and the most useful hints out of a Lighthouse result (LHR). */
export function extractFromLhr(lhr) {
  if (!lhr?.audits) throw new Error('Lighthouse result has no audits');
  const metrics = {};
  const rawScore = lhr.categories?.performance?.score;
  metrics.score = typeof rawScore === 'number' ? Math.round(rawScore * 100) : null;
  for (const [key, id] of Object.entries(METRIC_AUDITS)) {
    const v = lhr.audits[id]?.numericValue;
    metrics[key] = typeof v === 'number' ? v : null;
  }

  const opportunities = Object.entries(lhr.audits)
    .map(([id, a]) => {
      if (a.score === null || a.score === undefined || a.score >= 0.9) return null;
      const ms = a.metricSavings ?? {};
      const savingsMs = Math.max(
        a.details?.overallSavingsMs ?? 0,
        (ms.LCP ?? 0) + (ms.FCP ?? 0) + (ms.TBT ?? 0),
      );
      const savingsBytes = a.details?.overallSavingsBytes ?? 0;
      const clsSaving = ms.CLS ?? 0;
      if (savingsMs <= 0 && savingsBytes <= 0 && clsSaving <= 0) return null;
      return {
        id,
        title: a.title,
        displayValue: a.displayValue ?? null,
        savingsMs: Math.round(savingsMs),
        savingsBytes: Math.round(savingsBytes),
        clsSaving: Math.round(clsSaving * 1000) / 1000,
      };
    })
    .filter(Boolean)
    .sort((x, y) => y.savingsMs - x.savingsMs || y.clsSaving - x.clsSaving || y.savingsBytes - x.savingsBytes)
    .slice(0, 6);

  return {
    metrics,
    opportunities,
    lcpElement: findLcpElement(lhr),
    lighthouseVersion: lhr.lighthouseVersion ?? null,
    userAgent: lhr.environment?.hostUserAgent ?? null,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? null,
    warnings: (lhr.runWarnings ?? []).slice(0, 5),
  };
}

function findLcpElement(lhr) {
  const items = lhr.audits?.['largest-contentful-paint-element']?.details?.items;
  if (!Array.isArray(items)) return null;
  const queue = [...items];
  while (queue.length) {
    const it = queue.shift();
    if (it?.node?.snippet) return { selector: it.node.selector ?? null, snippet: it.node.snippet.slice(0, 300) };
    if (Array.isArray(it?.items)) queue.push(...it.items);
  }
  return null;
}
