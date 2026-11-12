# Contributing to commit-vitals

Thanks for helping make performance regressions impossible to miss.

## Branching model: git-flow

| Branch | Purpose |
|---|---|
| `main` | released versions only; every merge is tagged `vX.Y.Z` |
| `develop` | integration branch; always green |
| `feature/<name>` | new work, branched from `develop`, merged back with `--no-ff` |
| `release/<x.y.z>` | version bump + changelog, merged into `main` **and** `develop` |
| `hotfix/<x.y.z>` | urgent fix from `main`, merged into `main` **and** `develop` |

```bash
git checkout develop && git pull
git checkout -b feature/user-flows
# ...work, commit...
git push -u origin feature/user-flows   # open a PR against develop
```

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): …`, `fix: …`,
`docs: …`, `test: …`, `chore: …`. Explain *why* in the body when it isn't obvious.

## Development

- **No runtime dependencies.** The plugin must work right after install, without
  `npm install`. Use Node's standard library; Lighthouse is invoked through `npx`.
- Node **18.20+** compatible code (CI runs 18, 20 and 22).
- Run `npm test` before pushing. Tests use `node:test` and never launch Chrome — measurements
  use the `runner` option or `COMMIT_VITALS_FAKE_LHR` with fixtures in `test/fixtures/`.
- To try a real measurement:

  ```bash
  mkdir /tmp/try && cd /tmp/try && git init -q && git commit -q --allow-empty -m init
  node /path/to/commit-vitals/bin/commit-vitals.mjs init --url home=https://example.com/ --runs 1
  node /path/to/commit-vitals/bin/commit-vitals.mjs measure
  ```

- To try the plugin inside Claude Code from your checkout:
  `/plugin marketplace add /path/to/commit-vitals` then `/plugin install commit-vitals@commit-vitals`.

## Layout

```text
.claude-plugin/   plugin.json + marketplace.json
.mcp.json         registers the MCP server
hooks/            PostToolUse hook (git commit → background measurement)
skills/           setup, measure, schedule, report, regression-triage
mcp/server.mjs    MCP server (stdio JSON-RPC, zero deps)
bin/              CLI
lib/              config, git, lighthouse, measure, compare, store, format, report, hook
test/             node:test suites + fixtures
```

## Design principles

1. **Never attribute a number to the wrong commit.** Read git locally; refuse to measure
   when a deploy can't be confirmed.
2. **Don't cry wolf.** Medians, absolute + relative thresholds, non-overlapping ranges.
3. **Write for the AI and the human at once.** Summaries state what changed, against what,
   and what to fix first.
