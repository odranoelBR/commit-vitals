---
name: regression-triage
description: Explain and fix a Core Web Vitals / Lighthouse regression reported by commit-vitals. Use whenever a commit-vitals result (vitals_result, vitals_measure, a hook message) shows a regression or a budget failure, or the user asks why performance got worse after a commit.
---

# Triage a performance regression

A commit-vitals result tells you **what** got worse, on **which page**, and
**against which baseline commit**. Your job is to find **why** and propose the
smallest fix.

## 1. Read the signal before acting

- Only metrics marked 🔴 are regressions. They passed both an absolute and a
  relative threshold, so they are above normal noise.
- If the result says *Noisy* (score varied ≥ 10 points across runs), re-measure
  once with `vitals_measure` before blaming code.
- A budget failure without a regression means the page was already over the
  limit — that is debt, not a new problem. Say so.

## 2. Find what changed

Run `git diff <baseline-sha>..HEAD --stat`, then read the relevant hunks.
Map metrics to likely causes:

| Metric | Usual suspects in a diff |
|---|---|
| **LCP** | bigger/unoptimized hero image, lost `fetchpriority="high"` or `<link rel="preload">`, image turned `loading="lazy"` above the fold, new render-blocking CSS/JS or web font, slower SSR/data fetch (TTFB up too) |
| **CLS** | images/iframes/ads without `width`/`height` or `aspect-ratio`, content injected above existing content, late web-font swap, banners/cookie bars pushing layout |
| **TBT** | new or larger JS bundle, heavy synchronous work on load, new third-party script, hydration of a large tree |
| **FCP / TTFB** | server response slower, redirects added, blocking `<head>` resources |

Use the result's *LCP element* and *Top opportunities* to confirm: they come
from the measured page, not from guesses.

## 3. Report to the user

Three short parts:

1. **What**: `LCP on /product went 1.9 s → 3.1 s (+63%) since a1b2c3d.`
2. **Why** (with evidence): the line in the diff and the matching opportunity.
3. **Fix**: the concrete change, and offer to make it.

## 4. Verify the fix

After the fix is committed, the commit hook measures again. Otherwise call
`vitals_measure` with `wait_seconds: 600`. Report the before/after for the
regressed metric. A fix that does not move the metric beyond noise is not
proven — say so honestly.

## Don't

- Don't call a change a regression when the result did not flag it.
- Don't compare a `mobile` run to a `desktop` run, or `local` to `psi`;
  commit-vitals already avoids that when it picks the baseline.
- Don't "fix" by changing budgets or thresholds unless the user asks.
