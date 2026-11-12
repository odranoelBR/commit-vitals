---
name: measure
description: Measure Lighthouse / Core Web Vitals for the current commit now and report regressions against the previous measurement. Use when the user asks to measure, re-test or check performance of the current code.
argument-hint: "[page-name ...]"
---

# Measure now

Pages requested (empty = all): $ARGUMENTS

1. Call `vitals_measure` with `trigger: "manual"`, the requested `pages`
   (if any) and `wait_seconds: 600`.
   - If it reports the project is not set up, run the setup flow
     (`/commit-vitals:setup`).
   - If a measurement is already running, wait for it with `vitals_result`
     instead of starting another — parallel Chrome runs skew each other.
2. Present the result compactly: one line per page with score, LCP, CLS, TBT
   and the change versus the baseline commit. Lead with the verdict
   (regressions / budget failures / all good).
3. If there are regressions, follow the `regression-triage` skill: connect the
   regression to what changed since the baseline commit and propose a fix.
4. If the working tree has uncommitted changes, say that the numbers include
   them but are attributed to the last commit.
