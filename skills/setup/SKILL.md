---
name: setup
description: Set up commit-vitals in the current project — choose the pages to measure, the engine, budgets and how commits are measured. Use when the user wants to start tracking Lighthouse / Core Web Vitals per commit, or asks to configure commit-vitals.
argument-hint: "[url ...]"
---

# Set up commit-vitals

Goal: leave the project with a working `.vitals/config.json`, a first baseline
measurement, and the user knowing what happens on each commit.

User arguments (may be empty): $ARGUMENTS

## 1. Check the current state

Call the `vitals_status` MCP tool. If the project is already configured, show
the summary and ask what the user wants to change instead of starting over.

## 2. Decide the pages

- Use URLs from the arguments if given. Otherwise propose 2–4 pages that
  represent the site's templates (home, a listing, a detail/product page, the
  heaviest landing page), reading the router or sitemap if helpful. Ask the
  user to confirm. One page per *template* beats many pages of the same kind.
- Give each a short `name` (`home`, `product`, `checkout`).

## 3. Pick the engine — explain the trade-off in one line each

| Engine | Use when | Note |
|---|---|---|
| `local` (default) | localhost, preview deploys, staging behind VPN | Runs Lighthouse on this machine via `npx`; needs Chrome. |
| `psi` | public production URLs | Google's PageSpeed Insights API; also returns real-user CrUX data. Set `PSI_API_KEY` for higher quotas. |

The PSI engine cannot reach localhost or private hosts; `vitals_init` will
reject that combination.

## 4. Budgets and runs

Defaults: score ≥ 90, LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms, median of 3
runs. Keep the defaults unless the user has targets. Fewer than 3 runs makes
the history noisy.

## 5. Save

Call `vitals_init` with `urls`, `engine`, `form_factor`, `runs` and `budgets`.

## 6. Measuring "the code of this commit"

Explain briefly: right after `git commit`, a deployed URL still serves the old
code. Offer the option that fits their workflow:

- **Measure a local production build** (`local` engine + `http://localhost:…`
  of `build && preview`, not the dev server — dev servers are 3–10× slower and
  mean nothing).
- **Wait for the deploy**: if the site exposes the commit SHA in
  `<meta name="commit-sha" content="…">` or a response header, edit
  `.vitals/config.json` → `onCommit.waitFor`
  (`{"type": "meta", "name": "commit-sha", "timeoutSec": 600}`). Offer to add
  that meta tag to their layout if it is missing.
- **Don't measure on commit** (`onCommit.enabled: false`) and rely on the daily
  schedule only.

## 7. Baseline

Call `vitals_measure` with `wait_seconds: 600` and show the result. This first
run is the baseline every later commit is compared to.

## 8. Wrap up

- Suggest committing the `.vitals/` folder (config + `runs/`) so the team
  shares the history; `jobs/`, `logs/` and `report.html` are already
  gitignored.
- Mention `/commit-vitals:schedule` for daily checks and
  `/commit-vitals:report` for the chart.
