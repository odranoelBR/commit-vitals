import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const VITALS_DIR = '.vitals';
export const CONFIG_FILE = 'config.json';

/** Defaults merged under every project config. */
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  // 'local' runs Lighthouse on this machine (works with localhost and private previews).
  // 'psi' calls the PageSpeed Insights API (public URLs only, adds real-user CrUX data).
  engine: 'local',
  formFactor: 'mobile', // 'mobile' | 'desktop'
  runs: 3, // Lighthouse runs per URL; the median is stored
  urls: [], // [{ name, url, budgets? }]
  budgets: { score: 90, lcp: 2500, cls: 0.1, tbt: 200 },
  // A change is a regression only when it is worse than BOTH the absolute and the relative threshold.
  regression: { score: 5, lcpMs: 150, lcpPct: 10, cls: 0.02, tbtMs: 75, tbtPct: 20 },
  onCommit: {
    enabled: true,
    // Wait until the deployed page reports the new commit before measuring, e.g.
    // { "type": "meta", "name": "commit-sha", "timeoutSec": 600 }
    // { "type": "header", "name": "x-commit-sha", "timeoutSec": 600 }
    waitFor: null,
  },
  lighthouse: {
    version: null, // e.g. "12.8.2"; null picks the newest major supported by your Node
    chromeFlags: ['--headless=new', '--no-sandbox'],
  },
  psi: { apiKeyEnv: 'PSI_API_KEY' },
});

export function vitalsDir(root) {
  return path.join(root, VITALS_DIR);
}

export function configPath(root) {
  return path.join(vitalsDir(root), CONFIG_FILE);
}

function gitRoot(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Finds the project root: the nearest folder with .vitals/config.json,
 * otherwise the git root, otherwise the start folder itself.
 */
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(configPath(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot(start) ?? path.resolve(start);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function hasConfig(root) {
  return fs.existsSync(configPath(root));
}

export function loadConfig(root) {
  const file = configPath(root);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No commit-vitals config at ${file}. Run "/commit-vitals:setup" in Claude Code or "commit-vitals init --url home=https://example.com".`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`Invalid ${file}:\n- ${errors.join('\n- ')}`);
  return cfg;
}

export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, '');
    if (!p) return 'home';
    return p.split('/').filter(Boolean).join('-').toLowerCase().slice(0, 60);
  } catch {
    return 'page';
  }
}

export function normalizeUrls(urls) {
  const used = new Set();
  return urls.map((entry) => {
    const e = typeof entry === 'string' ? { url: entry } : { ...entry };
    let name = e.name || nameFromUrl(e.url);
    let n = 2;
    const base = name;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    return { ...e, name };
  });
}

export function validateConfig(cfg) {
  const errors = [];
  if (!['local', 'psi'].includes(cfg.engine)) errors.push(`engine must be "local" or "psi" (got "${cfg.engine}")`);
  if (!['mobile', 'desktop'].includes(cfg.formFactor)) errors.push(`formFactor must be "mobile" or "desktop"`);
  if (!Number.isInteger(cfg.runs) || cfg.runs < 1 || cfg.runs > 9) errors.push('runs must be an integer between 1 and 9');
  if (!Array.isArray(cfg.urls) || cfg.urls.length === 0) errors.push('urls must list at least one page');
  const names = new Set();
  for (const u of cfg.urls ?? []) {
    if (!u?.url) {
      errors.push('every url entry needs a "url"');
      continue;
    }
    let parsed;
    try {
      parsed = new URL(u.url);
    } catch {
      errors.push(`not a valid URL: ${u.url}`);
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) errors.push(`only http(s) URLs are supported: ${u.url}`);
    if (cfg.engine === 'psi' && isPrivateHost(parsed.hostname)) {
      errors.push(`engine "psi" cannot reach private host ${parsed.hostname}; use engine "local"`);
    }
    if (!u.name) errors.push(`url ${u.url} has no name`);
    else if (names.has(u.name)) errors.push(`duplicate url name "${u.name}"`);
    names.add(u.name);
  }
  return errors;
}

export function isPrivateHost(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.test') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]' ||
    host === '0.0.0.0'
  );
}

const VITALS_GITIGNORE = `# commit-vitals: measurement history in runs/ is meant to be committed.
jobs/
logs/
report.html
`;

/** Creates or updates .vitals/config.json. Returns the saved config (without defaults). */
export function writeConfig(root, partial, { merge = true } = {}) {
  const dir = vitalsDir(root);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  const file = configPath(root);
  const current = merge && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = { ...current, ...partial };
  if (partial.urls) next.urls = normalizeUrls(partial.urls);
  const errors = validateConfig(deepMerge(structuredClone(DEFAULT_CONFIG), next));
  if (errors.length) throw new Error(`Config not saved:\n- ${errors.join('\n- ')}`);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, VITALS_GITIGNORE);
  return next;
}
