import fs from 'node:fs';
import path from 'node:path';
import { vitalsDir } from './config.mjs';

export const runsDir = (root) => path.join(vitalsDir(root), 'runs');
export const jobsDir = (root) => path.join(vitalsDir(root), 'jobs');
export const logsDir = (root) => path.join(vitalsDir(root), 'logs');

/**
 * One file per measurement session. Unique names mean teammates never get
 * merge conflicts when they all commit their own history.
 */
export function runFileName(record) {
  const stamp = record.createdAt.replace(/[:.]/g, '-');
  return `${stamp}_${record.git?.shortSha ?? 'nogit'}_${record.trigger}.json`;
}

export function saveRun(root, record) {
  const dir = runsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, runFileName(record));
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return file;
}

/** All runs, oldest first. Unreadable files are skipped, not fatal. */
export function listRuns(root) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      rec._file = path.join(dir, f);
      out.push(rec);
    } catch {
      /* ignore broken file */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findRun(root, ref) {
  const runs = listRuns(root);
  if (!ref) return runs.at(-1) ?? null;
  const matches = runs.filter((r) => r.id === ref || r.git?.sha?.startsWith(ref));
  return matches.at(-1) ?? null;
}

// ---- background jobs ------------------------------------------------------

export function jobFile(root, id) {
  return path.join(jobsDir(root), `${id}.json`);
}

export function writeJob(root, job) {
  fs.mkdirSync(jobsDir(root), { recursive: true });
  fs.writeFileSync(jobFile(root, job.id), JSON.stringify(job, null, 2));
}

export function readJob(root, id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(root, id), 'utf8'));
  } catch {
    return null;
  }
}

export function listJobs(root) {
  const dir = jobsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJob(root, f.replace(/\.json$/, '')))
    .filter(Boolean)
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The job currently measuring this project, if any (stale jobs are marked failed). */
export function activeJob(root) {
  for (const job of listJobs(root).reverse()) {
    if (job.status !== 'running' && job.status !== 'queued') continue;
    if (isAlive(job.pid)) return job;
    writeJob(root, { ...job, status: 'failed', error: 'process exited unexpectedly', finishedAt: new Date().toISOString() });
  }
  return null;
}
