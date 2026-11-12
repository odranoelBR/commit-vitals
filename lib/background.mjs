import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activeJob, isAlive, jobsDir, logsDir, readJob, writeJob } from './store.mjs';
import { headSha } from './git.mjs';

export const CLI_PATH = fileURLToPath(new URL('../bin/commit-vitals.mjs', import.meta.url));
export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

function newJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Starts a measurement in a detached process so the caller (a hook, an MCP
 * tool) returns immediately. Only one measurement per project runs at a time:
 * two Chromes in parallel would skew each other's numbers.
 */
export function startBackgroundMeasure(root, { trigger = 'manual', only } = {}) {
  const existing = activeJob(root);
  if (existing) return { job: existing, alreadyRunning: true };

  const id = newJobId();
  fs.mkdirSync(logsDir(root), { recursive: true });
  const logFile = path.join(logsDir(root), `${id}.log`);
  const fd = fs.openSync(logFile, 'a');
  const args = [CLI_PATH, 'measure', '--project', root, '--trigger', trigger, '--job', id];
  if (only?.length) args.push('--only', only.join(','));
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: process.env });
  fs.closeSync(fd);
  const job = {
    id,
    status: 'running',
    pid: child.pid,
    trigger,
    only: only ?? null,
    sha: headSha(root),
    startedAt: new Date().toISOString(),
    log: logFile,
  };
  writeJob(root, job);
  child.unref();
  return { job, alreadyRunning: false };
}

/**
 * Starts a commit-triggered measurement unless HEAD was already measured
 * (the Claude Code hook and the git hook may both fire for the same commit).
 */
export function measureCommitOnce(root) {
  const sha = headSha(root);
  if (!sha) return null;
  fs.mkdirSync(jobsDir(root), { recursive: true });
  const marker = path.join(jobsDir(root), 'last-commit-sha');
  let last = null;
  try {
    last = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    /* first time */
  }
  if (last === sha) return null;
  fs.writeFileSync(marker, sha);
  return { sha, ...startBackgroundMeasure(root, { trigger: 'commit' }) };
}

export async function waitForJob(root, id, seconds, { pollMs = 2000 } = {}) {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  for (;;) {
    let job = readJob(root, id);
    if (!job || job.status === 'done' || job.status === 'failed') return job;
    if (!isAlive(job.pid)) {
      // The process died without recording its result (killed, machine slept...).
      job = { ...job, status: 'failed', error: 'process exited unexpectedly', finishedAt: new Date().toISOString() };
      writeJob(root, job);
      return job;
    }
    if (Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
