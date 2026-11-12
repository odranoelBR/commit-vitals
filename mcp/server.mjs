#!/usr/bin/env node
/**
 * commit-vitals MCP server (stdio, JSON-RPC 2.0, newline-delimited).
 * Zero dependencies on purpose: the plugin works right after install,
 * with no `npm install` step.
 */
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, hasConfig, loadConfig, writeConfig } from '../lib/config.mjs';
import { findRun, listRuns, readJob, activeJob, listJobs } from '../lib/store.mjs';
import { compareRunsText, summarizeHistory, summarizeRun } from '../lib/format.mjs';
import { writeReport } from '../lib/report.mjs';
import { CLI_PATH, PLUGIN_ROOT, startBackgroundMeasure, waitForJob } from '../lib/background.mjs';

const VERSION = '0.1.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const projectDirProp = {
  project_dir: {
    type: 'string',
    description: 'Absolute path of the project. Defaults to the folder Claude Code was started in.',
  },
};

export const TOOLS = [
  {
    name: 'vitals_status',
    description:
      'Shows the commit-vitals setup for a project: configured pages, engine, budgets, any measurement in progress and the latest result. Call this first if unsure whether the project is set up.',
    inputSchema: { type: 'object', properties: { ...projectDirProp } },
  },
  {
    name: 'vitals_init',
    description:
      'Creates or updates .vitals/config.json with the pages to measure. Use engine "local" for localhost or private previews, "psi" (PageSpeed Insights) for public URLs and real-user CrUX data.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectDirProp,
        urls: {
          type: 'array',
          description: 'Pages to measure.',
          items: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Short id like "home" or "product"' }, url: { type: 'string' } },
            required: ['url'],
          },
        },
        engine: { type: 'string', enum: ['local', 'psi'] },
        form_factor: { type: 'string', enum: ['mobile', 'desktop'] },
        runs: { type: 'integer', minimum: 1, maximum: 9, description: 'Lighthouse runs per page; the median is stored.' },
        budgets: {
          type: 'object',
          description: 'Limits, e.g. {"score": 90, "lcp": 2500, "cls": 0.1, "tbt": 200}. LCP/TBT in ms.',
        },
      },
    },
  },
  {
    name: 'vitals_measure',
    description:
      'Measures the configured pages with Lighthouse for the current git commit (read from the repo, never guessed) and stores the result. Runs in the background; set wait_seconds to block until done (a run takes roughly 20-60 s per page per run). Call after committing a change that may affect page load.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectDirProp,
        pages: { type: 'array', items: { type: 'string' }, description: 'Page names to measure (default: all).' },
        trigger: { type: 'string', enum: ['mcp', 'commit', 'daily', 'manual'], default: 'mcp' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 900, default: 0 },
      },
    },
  },
  {
    name: 'vitals_result',
    description:
      'Gets the result of a measurement: metrics, regressions against the previous measurement, budget failures and the top Lighthouse opportunities. Without job_id returns the latest finished run. Can wait for a running job.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectDirProp,
        job_id: { type: 'string' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 900, default: 0 },
      },
    },
  },
  {
    name: 'vitals_history',
    description: 'Table of recent measurements (score, LCP, CLS, TBT per page and commit).',
    inputSchema: {
      type: 'object',
      properties: { ...projectDirProp, page: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
    },
  },
  {
    name: 'vitals_compare',
    description: 'Compares the measurements of two commits (SHA prefixes). "to" defaults to the latest run.',
    inputSchema: {
      type: 'object',
      properties: { ...projectDirProp, from: { type: 'string' }, to: { type: 'string' } },
      required: ['from'],
    },
  },
  {
    name: 'vitals_report',
    description:
      'Writes a self-contained HTML report (.vitals/report.html): per-page timeline of score, LCP, CLS and TBT with commit/daily points, budgets and the full history table. Returns the file path.',
    inputSchema: { type: 'object', properties: { ...projectDirProp } },
  },
  {
    name: 'vitals_setup_info',
    description:
      'Returns the absolute paths of node and the commit-vitals CLI, plus ready-to-use commands for cron or a git post-commit hook. Use when scheduling daily measurements.',
    inputSchema: { type: 'object', properties: { ...projectDirProp } },
  },
];

function rootFrom(args) {
  return findProjectRoot(args?.project_dir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function jobText(job) {
  if (!job) return 'Job not found.';
  if (job.status === 'failed') return `Measurement ${job.id} failed: ${job.error ?? 'unknown error'}. Log: ${job.log}`;
  return `Measurement ${job.id} is ${job.status} (started ${job.startedAt}, trigger ${job.trigger}). Log: ${job.log}`;
}

function resultForJob(root, job) {
  if (job?.status === 'done') {
    const run = findRun(root, job.runId);
    if (run) return summarizeRun(run);
  }
  return jobText(job);
}

export const handlers = {
  async vitals_status(args) {
    const root = rootFrom(args);
    if (!hasConfig(root)) {
      return `commit-vitals is not set up in ${root}. Ask the user which pages to measure, then call vitals_init.`;
    }
    const cfg = loadConfig(root);
    const lines = [
      `Project: ${root}`,
      `Engine: ${cfg.engine} · ${cfg.formFactor} · median of ${cfg.runs} run(s)`,
      `Budgets: ${JSON.stringify(cfg.budgets)}`,
      `Measure on commit: ${cfg.onCommit.enabled ? 'yes' : 'no'}${cfg.onCommit.waitFor ? ` (waits for deploy via ${cfg.onCommit.waitFor.type} "${cfg.onCommit.waitFor.name}")` : ''}`,
      'Pages:',
      ...cfg.urls.map((u) => `- ${u.name}: ${u.url}`),
    ];
    const job = activeJob(root);
    if (job) lines.push('', jobText(job));
    const last = findRun(root);
    lines.push('', last ? summarizeRun(last) : 'No measurements yet.');
    return lines.join('\n');
  },

  async vitals_init(args) {
    const root = rootFrom(args);
    const partial = {};
    if (args.urls) partial.urls = args.urls;
    if (args.engine) partial.engine = args.engine;
    if (args.form_factor) partial.formFactor = args.form_factor;
    if (args.runs) partial.runs = args.runs;
    if (args.budgets) partial.budgets = args.budgets;
    if (!partial.urls && !hasConfig(root)) throw new Error('Provide at least one url.');
    const saved = writeConfig(root, partial);
    return `Saved ${root}/.vitals/config.json:\n${JSON.stringify(saved, null, 2)}\n\nCommit the .vitals/ folder so the team shares the history.`;
  },

  async vitals_measure(args) {
    const root = rootFrom(args);
    loadConfig(root); // fail fast with a helpful message
    const { job, alreadyRunning } = startBackgroundMeasure(root, { trigger: args.trigger ?? 'mcp', only: args.pages });
    const prefix = alreadyRunning ? `A measurement was already running; not starting another.\n` : '';
    if (!args.wait_seconds) {
      return `${prefix}${jobText(job)}\nCall vitals_result with job_id "${job.id}" (and wait_seconds) to get the numbers.`;
    }
    const done = await waitForJob(root, job.id, args.wait_seconds);
    return prefix + resultForJob(root, done);
  },

  async vitals_result(args) {
    const root = rootFrom(args);
    if (args.job_id) {
      const job = args.wait_seconds ? await waitForJob(root, args.job_id, args.wait_seconds) : readJob(root, args.job_id);
      return resultForJob(root, job);
    }
    const running = activeJob(root);
    if (running && args.wait_seconds) return resultForJob(root, await waitForJob(root, running.id, args.wait_seconds));
    const last = findRun(root);
    const note = running ? `${jobText(running)}\n\nLatest finished result:\n\n` : '';
    return last ? note + summarizeRun(last) : `${note}No measurements yet. Call vitals_measure.`;
  },

  async vitals_history(args) {
    const root = rootFrom(args);
    return summarizeHistory(listRuns(root), { urlName: args.page, limit: args.limit ?? 10 });
  },

  async vitals_compare(args) {
    const root = rootFrom(args);
    const from = findRun(root, args.from);
    const to = findRun(root, args.to);
    if (!from) throw new Error(`No measurement found for commit ${args.from}`);
    if (!to) throw new Error(`No measurement found for commit ${args.to}`);
    return compareRunsText(from, to, loadConfig(root));
  },

  async vitals_report(args) {
    const root = rootFrom(args);
    const file = writeReport(root);
    return `Report written to ${file}`;
  },

  async vitals_setup_info(args) {
    const root = rootFrom(args);
    const node = process.execPath;
    const stable = 'npx -y github:odranoelBR/commit-vitals';
    return JSON.stringify(
      {
        project: root,
        node,
        cli: CLI_PATH,
        pluginRoot: PLUGIN_ROOT,
        note: 'The plugin folder can change when the plugin updates; the npx command is stable across updates.',
        cron: `0 9 * * * cd "${root}" && ${stable} measure --trigger daily >> .vitals/logs/cron.log 2>&1`,
        cronPinned: `0 9 * * * cd "${root}" && "${node}" "${CLI_PATH}" measure --trigger daily >> .vitals/logs/cron.log 2>&1`,
        gitHook: `"${node}" "${CLI_PATH}" install-git-hook --project "${root}"`,
        recentJobs: listJobs(root).slice(-3),
      },
      null,
      2,
    );
  },
};

// ---- JSON-RPC plumbing ------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

export async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => isRequest && { jsonrpc: '2.0', id, result };
  const fail = (code, message) => isRequest && { jsonrpc: '2.0', id, error: { code, message } };

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'commit-vitals', version: VERSION },
        instructions:
          'commit-vitals measures Lighthouse / Core Web Vitals per git commit. After committing a change that can affect page load (assets, CSS, JS, images, fonts, third-party tags, SSR), call vitals_measure, then vitals_result. If regressions appear, explain the likely cause from the diff and the listed opportunities, and offer a fix.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const handler = handlers[params?.name];
      if (!handler) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const text = await handler(params.arguments ?? {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (method?.startsWith('notifications/')) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

export function serve(input = process.stdin) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const out = await handleMessage(msg);
    if (out) send(out);
  });
}

try {
  if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
} catch {
  /* imported, not executed */
}
