import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { median } from '../lib/stats.mjs';
import { extractFromLhr, lighthousePackage, extractField } from '../lib/lighthouse.mjs';
import { diffMetrics, checkBudgets } from '../lib/compare.mjs';
import { isCommitCommand } from '../lib/git.mjs';
import { writeConfig, loadConfig, nameFromUrl, findProjectRoot, DEFAULT_CONFIG } from '../lib/config.mjs';
import { measureProject, readMeta, waitForDeploy } from '../lib/measure.mjs';
import { listRuns } from '../lib/store.mjs';
import { summarizeRun } from '../lib/format.mjs';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  git('add', '.');
  git('commit', '-q', '-m', 'first commit');
  return { dir, git };
}

test('median handles odd, even and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null, undefined]), null);
});

test('picks Lighthouse 13 only on Node >= 22.19', () => {
  assert.equal(lighthousePackage(null, '20.10.0'), 'lighthouse@12');
  assert.equal(lighthousePackage(null, '22.18.0'), 'lighthouse@12');
  assert.equal(lighthousePackage(null, '22.19.0'), 'lighthouse@13');
  assert.equal(lighthousePackage(null, '24.1.0'), 'lighthouse@13');
  assert.equal(lighthousePackage('12.8.2', '24.1.0'), 'lighthouse@12.8.2');
});

test('extracts metrics, opportunities and the LCP element from an LHR', () => {
  const ex = extractFromLhr(fixture('lhr-fast.json'));
  assert.equal(ex.metrics.score, 92);
  assert.equal(ex.metrics.lcp, 1800);
  assert.equal(ex.metrics.cls, 0.05);
  assert.equal(ex.opportunities[0].id, 'render-blocking-resources');
  assert.ok(ex.opportunities.some((o) => o.id === 'unsized-images' && o.clsSaving === 0.04));
  assert.equal(ex.lcpElement.selector, 'div.hero > img');
});

test('extracts CrUX field data from PSI loadingExperience', () => {
  const f = extractField({
    overall_category: 'AVERAGE',
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2600 },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180 },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 7 },
    },
  });
  assert.deepEqual([f.lcp, f.inp, f.cls, f.source], [2600, 180, 0.07, 'url']);
  assert.equal(extractField(undefined), null);
});

test('a regression must beat both absolute and relative thresholds', () => {
  const t = DEFAULT_CONFIG.regression;
  const base = { score: 90, lcp: 2000, cls: 0.05, tbt: 100 };
  // +100ms LCP is 5%: below both thresholds -> noise
  assert.deepEqual(diffMetrics(base, { ...base, lcp: 2100 }, t).regressions, []);
  // +600ms LCP is 30%: regression
  assert.deepEqual(diffMetrics(base, { ...base, lcp: 2600 }, t).regressions, ['lcp']);
  // score -8 and CLS +0.1
  const d = diffMetrics(base, { ...base, score: 82, cls: 0.15 }, t);
  assert.deepEqual(d.regressions.sort(), ['cls', 'score']);
  assert.deepEqual(diffMetrics(base, { ...base, tbt: 20 }, t).improvements, ['tbt']);
});

test('budgets: score is a floor, everything else a ceiling', () => {
  const r = checkBudgets({ score: 85, lcp: 2000, cls: 0.2 }, { score: 90, lcp: 2500, cls: 0.1, tbt: 200 });
  assert.deepEqual(
    r.map((b) => [b.metric, b.pass]),
    [
      ['score', false],
      ['lcp', true],
      ['cls', false],
    ],
  );
});

test('detects commit commands, including chained and with options', () => {
  for (const c of ['git commit -m "x"', 'git add . && git commit -am wip', 'git -C app commit --amend --no-edit', 'cd web; git commit -m "y"', 'GIT_AUTHOR_NAME=a git commit -m z']) {
    assert.ok(isCommitCommand(c), c);
  }
  for (const c of ['git status', 'git log --grep commit', 'echo git commit', 'npm run commit-lint', 'gh pr create']) {
    assert.ok(!isCommitCommand(c), c);
  }
});

test('config: names derived from URLs, invalid configs rejected, PSI cannot reach localhost', () => {
  assert.equal(nameFromUrl('https://shop.com/'), 'home');
  assert.equal(nameFromUrl('https://shop.com/products/shoe/'), 'products-shoe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  assert.throws(() => writeConfig(dir, { urls: [] }), /at least one page/);
  assert.throws(() => writeConfig(dir, { engine: 'psi', urls: ['http://localhost:3000/'] }), /private host/);
  writeConfig(dir, { urls: ['https://shop.com/', 'https://shop.com/cart'] });
  const cfg = loadConfig(dir);
  assert.deepEqual(cfg.urls.map((u) => u.name), ['home', 'cart']);
  assert.equal(cfg.runs, 3);
  assert.equal(findProjectRoot(path.join(dir)), dir);
  assert.ok(fs.readFileSync(path.join(dir, '.vitals', '.gitignore'), 'utf8').includes('jobs/'));
});

test('reads meta tags in any attribute order', () => {
  assert.equal(readMeta('<meta content="abc1234" name="commit-sha">', 'commit-sha'), 'abc1234');
  assert.equal(readMeta("<meta name='commit-sha' content='def5678'/>", 'commit-sha'), 'def5678');
  assert.equal(readMeta('<meta name="other" content="x">', 'commit-sha'), null);
});

test('waitForDeploy resolves once the page reports the commit', async () => {
  const git = { sha: 'abcdef1234567890', shortSha: 'abcdef1' };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const html = calls < 3 ? '<meta name="commit-sha" content="0000000">' : '<meta name="commit-sha" content="abcdef1">';
    return { text: async () => html, headers: new Map() };
  };
  const r = await waitForDeploy('https://x.dev/', git, { type: 'meta', name: 'commit-sha', timeoutSec: 5 }, { fetchImpl, intervalMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(calls, 3);
});

test('measureProject stores medians, git info and flags a regression against the baseline', async () => {
  const { dir, git } = tmpRepo();
  writeConfig(dir, { urls: [{ name: 'home', url: 'https://example.com/' }], runs: 3 });

  const fast = fixture('lhr-fast.json');
  const slow = fixture('lhr-slow.json');
  const first = await measureProject(dir, { trigger: 'manual', runner: async () => ({ lhr: fast }) });
  assert.equal(first.record.results[0].metrics.score, 92);
  assert.equal(first.record.results[0].baseline, null);
  assert.equal(first.record.git.subject, 'first commit');

  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>slower</h1>');
  git('commit', '-q', '-am', 'add huge hero image');
  // two slow samples and one fast outlier: the median must be slow
  const samples = [slow, fast, slow];
  const second = await measureProject(dir, { trigger: 'commit', runner: async () => ({ lhr: samples.shift() }) });
  const res = second.record.results[0];
  assert.equal(res.metrics.lcp, 3400);
  assert.ok(res.regressions.includes('lcp'));
  assert.ok(res.regressions.includes('score'));
  assert.equal(res.baseline.sha, first.record.git.shortSha);
  assert.equal(second.record.summary.regressions >= 2, true);
  assert.equal(listRuns(dir).length, 2);

  const text = summarizeRun(second.record);
  assert.match(text, /regression/);
  assert.match(text, /add huge hero image/);
  assert.match(text, /Eliminate render-blocking resources/);
});

test('a page that fails every run is recorded as an error, not a crash', async () => {
  const { dir } = tmpRepo();
  writeConfig(dir, { urls: ['https://example.com/'], runs: 2 });
  const { record } = await measureProject(dir, {
    runner: async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    },
  });
  assert.match(record.results[0].error, /ERR_NAME_NOT_RESOLVED/);
  assert.equal(record.summary.failedPages, 1);
});
