import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findProjectRoot, hasConfig, loadConfig } from './config.mjs';
import { isCommitCommand } from './git.mjs';
import { CLI_PATH, measureCommitOnce } from './background.mjs';

/**
 * Claude Code PostToolUse hook. Reads the hook payload, and when the Bash
 * command created a commit in a configured project, starts a background
 * measurement and tells Claude how to fetch the result later.
 * Must be fast and must never fail the tool call: returns null when there is
 * nothing to do.
 */
export function handleHookPayload(payload) {
  if (payload?.tool_name !== 'Bash') return null;
  if (!isCommitCommand(payload.tool_input?.command)) return null;
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findProjectRoot(cwd);
  if (!hasConfig(root)) return null;
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch {
    return null;
  }
  if (!cfg.onCommit.enabled) return null;
  const started = measureCommitOnce(root); // null when HEAD did not move (failed commit) or was measured already
  if (!started) return null;
  const short = started.sha.slice(0, 7);
  const jobId = started.job.id;
  const what = started.alreadyRunning
    ? `a measurement is already running (job ${jobId}); commit ${short} will be covered by the next one`
    : `measuring commit ${short} in the background (job ${jobId})`;
  return {
    systemMessage: `commit-vitals: ${what}`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `commit-vitals started measuring Core Web Vitals for commit ${short} (job ${jobId}). ` +
        `Before finishing your work, call the vitals_result tool with job_id "${jobId}" and wait_seconds 300 ` +
        'to check whether this commit caused a performance regression, and tell the user what you find.',
    },
  };
}

const GIT_HOOK_MARK = '# commit-vitals post-commit hook';

/** Installs (or refreshes) a git post-commit hook so commits made outside Claude are measured too. */
export function installGitHook(root) {
  let hooksDir;
  try {
    hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`${root} is not a git repository`);
  }
  hooksDir = path.resolve(root, hooksDir);
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, 'post-commit');
  const block = [
    GIT_HOOK_MARK,
    `if [ -f "${CLI_PATH}" ]; then`,
    `  "${process.execPath}" "${CLI_PATH}" measure --background --once-per-commit --trigger commit --project "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || true`,
    'fi',
    '# end commit-vitals',
  ].join('\n');

  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#!/bin/sh\n';
  if (content.includes(GIT_HOOK_MARK)) {
    content = content.replace(/# commit-vitals post-commit hook[\s\S]*?# end commit-vitals/, block);
  } else {
    content = `${content.replace(/\s*$/, '')}\n\n${block}\n`;
  }
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
  return file;
}
