import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeConfig } from '../lib/config.mjs';
import { waitForJob } from '../lib/background.mjs';
import { listRuns } from '../lib/store.mjs';
import { installGitHook } from '../lib/hook.mjs';

const CLI = fileURLToPath(new URL('../bin/commit-vitals.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/lhr-fast.json', import.meta.url));

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-hook-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

function runHook(payload) {
  const r = spawnSync(process.execPath, [CLI, 'hook'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, COMMIT_VITALS_FAKE_LHR: FAKE },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test('hook ignores non-commit commands and unconfigured projects', () => {
  const { dir } = repo();
  assert.equal(runHook({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git commit -m x' } }), null);
  writeConfig(dir, { urls: ['https://example.com/'], runs: 1 });
  assert.equal(runHook({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git status' } }), null);
  assert.equal(runHook({ tool_name: 'Edit', cwd: dir, tool_input: {} }), null);
  // garbage on stdin must not break the tool call
  const r = spawnSync(process.execPath, [CLI, 'hook'], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('hook measures a new commit once, in the background, and tells Claude how to get the result', async () => {
  const { dir, git } = repo();
  writeConfig(dir, { urls: [{ name: 'home', url: 'https://example.com/' }], runs: 1 });
  fs.writeFileSync(path.join(dir, 'a.txt'), '2');
  git('commit', '-q', '-am', 'second');

  const payload = { tool_name: 'Bash', cwd: dir, tool_input: { command: 'git commit -am second' } };
  const out = runHook(payload);
  assert.match(out.systemMessage, /measuring commit/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  const jobId = out.hookSpecificOutput.additionalContext.match(/job_id "([^"]+)"/)[1];

  const job = await waitForJob(dir, jobId, 30, { pollMs: 100 });
  assert.equal(job.status, 'done', JSON.stringify(job));
  const runs = listRuns(dir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'commit');
  assert.equal(runs[0].git.subject, 'second');

  // same HEAD again (e.g. a failed commit, or the git hook firing too): nothing new
  assert.equal(runHook(payload), null);
});

test('git post-commit hook install is idempotent and keeps existing content', () => {
  const { dir } = repo();
  const hookFile = path.join(dir, '.git', 'hooks', 'post-commit');
  fs.writeFileSync(hookFile, '#!/bin/sh\necho existing\n');
  installGitHook(dir);
  installGitHook(dir);
  const content = fs.readFileSync(hookFile, 'utf8');
  assert.match(content, /echo existing/);
  assert.equal(content.match(/# commit-vitals post-commit hook/g).length, 1);
  assert.ok(fs.statSync(hookFile).mode & 0o100);
});
