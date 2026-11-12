---
name: schedule
description: Schedule a daily (or weekly) commit-vitals measurement of the project's pages. Use when the user wants performance checked every day, wants to catch regressions that come from content, CMS or third-party tags rather than commits, or asks to automate commit-vitals.
argument-hint: "[time, e.g. 09:00]"
---

# Schedule recurring measurements

Requested time (empty = ask, suggest 09:00 local): $ARGUMENTS

Why daily matters even with per-commit checks: production also changes
without commits — a new tag in a tag manager, a 2 MB banner uploaded by
marketing, a slower third-party script. Daily runs catch those.

## 1. Preconditions

Call `vitals_status`. If the project is not configured, run the setup flow
first. Then call `vitals_setup_info` to get the absolute paths and the
ready-made commands.

## 2. Offer the options (recommend one based on their situation)

### A. Claude desktop scheduled task — recommended in the Claude desktop app

Claude runs the measurement, reads the result and writes a short report, so
regressions come with an explanation. Runs while the app is open; a missed run
happens at next launch.

Create it with the scheduled-tasks tool (`create_scheduled_task`):

- `taskId`: `commit-vitals-daily-<project-folder-name>`
- `cronExpression`: from the requested time, local time, e.g. `0 9 * * *`
- `description`: `Daily Core Web Vitals check for <project>`
- `prompt` — fully self-contained, because each run starts with no memory:

  > In the project at `<absolute project path>`, use the commit-vitals MCP
  > tools. Call `vitals_measure` with `project_dir` set to that path,
  > `trigger: "daily"` and `wait_seconds: 900`. Then summarize: one line per
  > page with score, LCP, CLS and TBT and the change versus the previous run.
  > If there are regressions or budget failures, say which pages and the top
  > Lighthouse opportunities, and compare against `git log` since the
  > baseline commit to suggest a likely cause. Do not modify any files.

### B. System cron — zero tokens, runs even with the app closed

Show the `cron` line from `vitals_setup_info` and explain it uses
`npx github:odranoelBR/commit-vitals`, which keeps working after plugin
updates. Offer to add it with `crontab -e` (on macOS/Linux) — only with the
user's go-ahead, and append, never replace the existing crontab. On Windows,
offer an equivalent Task Scheduler command.

### C. Cloud routine (`/schedule`) — for public URLs, machine off

Works only with `engine: "psi"`, because a cloud agent cannot reach localhost.
Suggest it when the user wants runs that don't depend on their computer.

## 3. Confirm

Tell the user the schedule, where results land (`.vitals/runs/`, trigger
`daily`), and that `/commit-vitals:report` shows the timeline with commit and
daily points distinguished.
