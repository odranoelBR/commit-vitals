# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-12

First public release.

### Added

- Lighthouse measurement per page with the median of N runs and the min/max spread.
- Two engines: `local` (Lighthouse via `npx`, v12 or v13 depending on Node) and `psi`
  (PageSpeed Insights API, with CrUX real-user data).
- History stored as one JSON file per run in `.vitals/runs/`, attributed to the commit read
  from local git.
- Regression detection against the previous comparable run: absolute + relative thresholds
  and non-overlapping run ranges.
- Per-page budgets.
- Optional wait-for-deploy (`<meta>` tag or response header carrying the commit SHA).
- Claude Code `PostToolUse` hook: measures every commit in the background, deduplicated by SHA.
- `install-git-hook` for commits made outside Claude Code.
- Zero-dependency MCP server with 8 tools.
- Skills: `setup`, `measure`, `schedule`, `report`, `regression-triage`.
- Self-contained HTML report with per-page timelines.
- CLI: `init`, `measure`, `status`, `history`, `compare`, `report`, `install-git-hook`, `where`.

[0.1.0]: https://github.com/odranoelBR/commit-vitals/releases/tag/v0.1.0
