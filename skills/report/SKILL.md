---
name: report
description: Generate the commit-vitals HTML report — per-page timeline of score, LCP, CLS and TBT with commit and daily points, budgets and full history. Use when the user wants to see the performance history, a chart, or something to share with the team.
---

# Performance report

1. Call `vitals_report` (it writes `.vitals/report.html`) and give the user
   the path as a clickable link.
2. In two or three sentences, say what the timeline shows: the trend of each
   page since the first measurement, the worst current metric versus its
   budget, and the most recent regression (commit and metric), if any.
3. If the user wants to share it, the file is self-contained (no external
   assets) — it can be attached, hosted, or published as a page as-is.
