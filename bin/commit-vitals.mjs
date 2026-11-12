#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, hasConfig, loadConfig, writeConfig } from '../lib/config.mjs';
import { measureProject } from '../lib/measure.mjs';
import { findRun, listRuns, readJob, writeJob, activeJob } from '../lib/store.mjs';
import { compareRunsText, summarizeHistory, summarizeRun } from '../lib/format.mjs';
import { CLI_PATH, measureCommitOnce, startBackgroundMeasure } from '../lib/background.mjs';
import { handleHookPayload, installGitHook } from '../lib/hook.mjs';
import { writeReport } from '../lib/report.mjs';

const HELP = `commit-vitals — Lighthouse & Core Web Vitals for every commit

Usage: commit-vitals <command> [options]

Commands
  init        Create .vitals/config.json
                --url <name=url|url>   page to measure (repeatable)
                --engine local|psi     where Lighthouse runs (default: local)
                --form-factor mobile|desktop
                --runs <n>             runs per page, median is kept (default: 3)
  measure     Measure all pages now and store the result
                --trigger manual|commit|daily|mcp
                --only <name,name>     measure a subset
                --background           return immediately, measure in a detached process
                --once-per-commit      background, and skip if HEAD was already measured
                --json                 print the run record instead of the summary
  status      Show config, running job and the latest result
  history     Table of recent measurements      [--limit n] [--page name]
  compare     Latest run vs its baseline, or two commits: compare <shaA> <shaB>
  report      Write the HTML timeline report     [--out file] (default .vitals/report.html)
  install-git-hook   Add a git post-commit hook (measures commits made outside Claude Code)
  hook        Claude Code PostToolUse hook entry point (reads the payload on stdin)
  where       Print the paths this CLI runs from (useful for cron)

Global options
  --project <dir>   project folder (default: nearest folder with .vitals/, else git root)
`;

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    const next = argv[i + 1];
    const value = inline !== undefined ? inline : next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (key in args) args[key] = [].concat(args[key], value);
    else args[key] = value;
  }
  return args;
}

const list = (v) => (v === undefined || v === true ? [] : [].concat(v));

const commands = {
  async init(args, root) {
    const urls = list(args.url).map((u) => {
      const m = String(u).match(/^([\w.-]+)=(https?:\/\/.+)$/);
      return m ? { name: m[1], url: m[2] } : { url: String(u) };
    });
    if (!urls.length && !hasConfig(root)) throw new Error('Pass at least one --url, e.g. --url home=https://example.com');
    const partial = {};
    if (urls.length) partial.urls = urls;
    if (args.engine) partial.engine = args.engine;
    if (args['form-factor']) partial.formFactor = args['form-factor'];
    if (args.runs) partial.runs = Number(args.runs);
    const saved = writeConfig(root, partial);
    console.log(`Saved ${root}/.vitals/config.json`);
    console.log(JSON.stringify(saved, null, 2));
  },

  async measure(args, root) {
    const only = list(args.only).flatMap((s) => String(s).split(',')).filter(Boolean);
    const trigger = typeof args.trigger === 'string' ? args.trigger : 'manual';
    if (args['once-per-commit']) {
      const started = measureCommitOnce(root);
      console.log(started ? `Started job ${started.job.id} for ${started.sha.slice(0, 7)}.` : 'HEAD already measured; nothing to do.');
      return;
    }
    if (args.background) {
      const { job, alreadyRunning } = startBackgroundMeasure(root, { trigger, only });
      console.log(alreadyRunning ? `A measurement is already running (job ${job.id}).` : `Started job ${job.id}. Log: ${job.log}`);
      return;
    }
    const jobId = typeof args.job === 'string' ? args.job : null;
    const log = (msg) => console.error(`[commit-vitals] ${msg}`);
    try {
      const { record, file } = await measureProject(root, { trigger, only, log });
      if (jobId) writeJob(root, { ...readJob(root, jobId), status: 'done', finishedAt: new Date().toISOString(), runId: record.id, runFile: file, summary: record.summary });
      console.log(args.json ? JSON.stringify(record, null, 2) : summarizeRun(record));
      console.error(`[commit-vitals] saved ${file}`);
    } catch (e) {
      if (jobId) writeJob(root, { ...readJob(root, jobId), status: 'failed', finishedAt: new Date().toISOString(), error: e.message });
      throw e;
    }
  },

  async status(args, root) {
    const cfg = loadConfig(root);
    console.log(`Project: ${root}`);
    console.log(`Engine: ${cfg.engine} · ${cfg.formFactor} · ${cfg.runs} run(s) per page`);
    for (const u of cfg.urls) console.log(`  - ${u.name}: ${u.url}`);
    const job = activeJob(root);
    if (job) console.log(`\nRunning: job ${job.id} (${job.trigger}) since ${job.startedAt}`);
    const last = findRun(root);
    console.log(last ? `\n${summarizeRun(last)}` : '\nNo measurements yet.');
  },

  async history(args, root) {
    console.log(summarizeHistory(listRuns(root), { limit: Number(args.limit) || 10, urlName: typeof args.page === 'string' ? args.page : undefined }));
  },

  async compare(args, root) {
    const [a, b] = args._.slice(1);
    if (!a) {
      const last = findRun(root);
      console.log(last ? summarizeRun(last) : 'No measurements yet.');
      return;
    }
    const from = findRun(root, a);
    const to = findRun(root, b);
    if (!from || !to) throw new Error(`No run found for ${!from ? a : b ?? 'latest'}`);
    console.log(compareRunsText(from, to, loadConfig(root)));
  },

  // Claude Code PostToolUse hook: payload on stdin, JSON (or nothing) on stdout. Never fails.
  async hook() {
    let payload = {};
    try {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return;
    }
    try {
      const out = handleHookPayload(payload);
      if (out) console.log(JSON.stringify(out));
    } catch (e) {
      console.error(`commit-vitals hook: ${e.message}`);
    }
  },

  async 'install-git-hook'(args, root) {
    const file = installGitHook(root);
    console.log(`Installed ${file}\nCommits made outside Claude Code are measured too. Re-run after updating the plugin.`);
  },

  async report(args, root) {
    const file = writeReport(root, typeof args.out === 'string' ? args.out : undefined);
    console.log(`Report written to ${file}`);
  },

  async where() {
    console.log(JSON.stringify({ node: process.execPath, cli: CLI_PATH }, null, 2));
  },

  async help() {
    console.log(HELP);
  },
};

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const name = args._[0] ?? 'help';
  const cmd = commands[name];
  if (!cmd || args.help) {
    console.log(HELP);
    return name === 'help' || args.help ? 0 : 1;
  }
  const root = findProjectRoot(typeof args.project === 'string' ? args.project : process.cwd());
  await cmd(args, root);
  return 0;
}

export { commands };

function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`commit-vitals: ${e.message}`);
      process.exit(1);
    },
  );
}
