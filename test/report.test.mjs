import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeConfig } from '../lib/config.mjs';
import { measureProject } from '../lib/measure.mjs';
import { writeReport, seriesFor } from '../lib/report.mjs';
import { listRuns } from '../lib/store.mjs';

const fx = (n) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), 'utf8'));

test('report renders charts, budgets, regressions and escapes page content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-rep-'));
  writeConfig(dir, { urls: [{ name: 'home', url: 'https://example.com/?q=<script>' }, { name: 'empty', url: 'https://example.com/x' }], runs: 1 });
  await measureProject(dir, { trigger: 'commit', only: ['home'], runner: async () => ({ lhr: fx('lhr-fast.json') }) });
  await measureProject(dir, { trigger: 'daily', only: ['home'], runner: async () => ({ lhr: fx('lhr-slow.json') }) });

  const pts = seriesFor(listRuns(dir), 'home', 'lcp');
  assert.deepEqual(pts.map((p) => [p.trigger, p.value, p.regressed]), [['commit', 1800, false], ['daily', 3400, true]]);

  const html = fs.readFileSync(writeReport(dir), 'utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal((html.match(/<svg /g) ?? []).length, 4); // 4 charts for the measured page
  assert.match(html, /class="budget"/);
  assert.match(html, /pt daily bad/);
  assert.match(html, /No measurements yet\./); // the never-measured page
  assert.ok(!html.includes('<script>'), 'URL must be escaped');
});
