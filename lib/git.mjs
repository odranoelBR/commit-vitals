import { execFileSync } from 'node:child_process';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Reads commit metadata straight from the local repository, so the commit a
 * measurement is attributed to never depends on what an AI or a user typed.
 * Returns null outside a git repository or before the first commit.
 */
export function readGitInfo(cwd) {
  try {
    const sha = git(cwd, ['rev-parse', 'HEAD']);
    const [subject, author, committedAt] = git(cwd, ['log', '-1', '--format=%s%x1f%an%x1f%cI']).split('\x1f');
    let branch = null;
    try {
      branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) || null;
    } catch {
      branch = null; // detached HEAD
    }
    let dirty = false;
    try {
      dirty = git(cwd, ['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).vitals']) !== '';
    } catch {
      dirty = false;
    }
    return { sha, shortSha: sha.slice(0, 7), branch, subject, author, committedAt, dirty };
  } catch {
    return null;
  }
}

export function headSha(cwd) {
  try {
    return git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/** Matches shell commands that create a commit: "git commit", "git -C x commit --amend", "git add . && git commit -m ...". */
export function isCommitCommand(command) {
  if (typeof command !== 'string') return false;
  return command
    .split(/&&|\|\||;|\n/)
    .some((part) => /^\s*(?:\S+=\S+\s+)*git(?:\s+-(?:C|c)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/.test(part));
}
