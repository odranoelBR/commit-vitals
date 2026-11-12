#!/usr/bin/env node
// Builds a demo project with a realistic history and renders its report.
// Used for the screenshot in the README:  node scripts/demo-report.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeConfig, loadConfig } from '../lib/config.mjs';
import { aggregateSamples } from '../lib/measure.mjs';
import { annotateRun } from '../lib/compare.mjs';
import { saveRun, listRuns } from '../lib/store.mjs';
import { writeReport } from '../lib/report.mjs';

const out = path.resolve(process.argv[2] ?? 'demo-project');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
writeConfig(out, {
  urls: [
    { name: 'home', url: 'https://shop.example.com/' },
    { name: 'product', url: 'https://shop.example.com/p/trail-runner' },
  ],
  runs: 3,
});
const cfg = loadConfig(out);

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (v, pct) => v * (1 + (rand() - 0.5) * pct);

// [trigger, sha, subject, home{score,lcp,cls,tbt}, product{...}]
const steps = [
  ['commit', 'a1c9e02', 'feat: new landing layout', [91, 2100, 0.04, 140], [86, 2500, 0.06, 210]],
  ['daily', 'a1c9e02', '', [90, 2150, 0.04, 150], [86, 2480, 0.06, 205]],
  ['commit', '5be17d4', 'chore: bump analytics SDK', [89, 2200, 0.04, 190], [85, 2550, 0.06, 240]],
  ['daily', '5be17d4', '', [89, 2180, 0.05, 185], [85, 2530, 0.06, 236]],
  ['commit', '0f3a8c1', 'feat: full-width hero video', [72, 3650, 0.05, 200], [84, 2560, 0.06, 245]],
  ['commit', 'e47d2b9', 'perf: hero poster image + preload, lazy video', [93, 1950, 0.04, 180], [85, 2540, 0.06, 240]],
  ['daily', 'e47d2b9', '', [92, 1980, 0.21, 185], [85, 2520, 0.07, 238]],
  ['commit', '9c21f70', 'fix: reserve space for promo banner', [93, 1960, 0.03, 175], [86, 2500, 0.05, 235]],
  ['commit', 'd8e3a55', 'perf: split product gallery bundle', [93, 1940, 0.03, 170], [92, 2150, 0.04, 120]],
  ['daily', 'd8e3a55', '', [94, 1930, 0.03, 165], [91, 2170, 0.04, 125]],
];

const lhr = ([score, lcp, cls, tbt]) => ({
  lighthouseVersion: '12.8.2',
  categories: { performance: { score: Math.min(1, jitter(score, 0.03) / 100) } },
  audits: {
    'largest-contentful-paint': { numericValue: jitter(lcp, 0.06) },
    'cumulative-layout-shift': { numericValue: Math.max(0, jitter(cls, 0.08)) },
    'total-blocking-time': { numericValue: jitter(tbt, 0.12) },
    'first-contentful-paint': { numericValue: jitter(lcp * 0.55, 0.05) },
    'speed-index': { numericValue: jitter(lcp * 0.9, 0.05) },
    'render-blocking-resources': {
      score: 0.4,
      title: 'Eliminate render-blocking resources',
      details: { type: 'opportunity', overallSavingsMs: Math.round(lcp * 0.12) },
    },
    'uses-responsive-images': {
      score: 0.5,
      title: 'Properly size images',
      details: { type: 'opportunity', overallSavingsMs: Math.round(lcp * 0.08), overallSavingsBytes: 180_000 },
    },
  },
});

const start = Date.parse('2026-10-28T09:00:00Z');
steps.forEach(([trigger, sha, subject, home, product], i) => {
  const createdAt = new Date(start + i * 31 * 3600_000).toISOString();
  const results = [
    ['home', cfg.urls[0].url, home],
    ['product', cfg.urls[1].url, product],
  ].map(([name, url, m]) => {
    const agg = aggregateSamples([0, 1, 2].map(() => {
      const raw = lhr(m);
      const s = Math.round(raw.categories.performance.score * 100);
      return {
        metrics: {
          score: s,
          lcp: raw.audits['largest-contentful-paint'].numericValue,
          cls: raw.audits['cumulative-layout-shift'].numericValue,
          tbt: raw.audits['total-blocking-time'].numericValue,
          fcp: raw.audits['first-contentful-paint'].numericValue,
          si: raw.audits['speed-index'].numericValue,
          ttfb: 180,
        },
        opportunities: [
          { id: 'render-blocking-resources', title: 'Eliminate render-blocking resources', savingsMs: Math.round(m[1] * 0.12), savingsBytes: 0, clsSaving: 0 },
          { id: 'uses-responsive-images', title: 'Properly size images', savingsMs: Math.round(m[1] * 0.08), savingsBytes: 180_000, clsSaving: 0 },
        ],
        lcpElement: null,
      };
    }));
    return { name, url, samples: 3, ...agg };
  });
  const record = {
    schema: 1,
    id: randomUUID(),
    createdAt,
    trigger,
    engine: 'local',
    formFactor: 'mobile',
    runsPerUrl: 3,
    git: { sha: sha.padEnd(40, '0'), shortSha: sha, branch: 'main', subject: subject || '(daily check of deployed site)', author: 'Demo', dirty: false },
    environment: { lighthouseVersion: '12.8.2' },
    results,
  };
  annotateRun(record, listRuns(out), cfg);
  saveRun(out, record);
});

console.log(writeReport(out));
