---
name: visual-qa
description: Run browser-based visual quality assurance for web apps using Playwright or an equivalent browser automation flow. Use when Codex needs to start an app, inspect screenshots across desktop/mobile viewports, test realistic UI interactions, catch visual regressions such as overlap/clipping/blank states/responsive layout issues, and report concrete findings before handing work back.
---

# Visual QA

## Workflow

1. Identify how the app runs locally.
   - Prefer existing scripts such as `make frontend-e2e`, `npm run test:e2e`, `npm run dev`, or Playwright configs.
   - Reuse seeded integration flows when they exist.
   - If a server fails because of sandbox restrictions, rerun the same command with the required approval instead of inventing a weaker check.

2. Exercise real user paths.
   - Cover the primary changed workflow, not just page load.
   - Include at least one desktop viewport and one mobile viewport.
   - Prefer real backend integration when available; otherwise use existing deterministic mocks.

3. Capture and inspect screenshots.
   - Use Playwright screenshots, traces, or browser automation artifacts.
   - Inspect screenshots directly with image viewing when possible.
   - Check for blank screens, clipped text, overlapping controls, broken spacing, unusable mobile layout, incorrect loading/error states, and important content hidden below fixed UI.

4. Verify interaction results.
   - Confirm visible state changes after actions.
   - Confirm forms can be completed, submitted, cancelled, and retried when relevant.
   - Confirm API-backed flows render the returned data, not only optimistic UI.

5. Report with evidence.
   - Lead with findings, ordered by severity.
   - Include viewport, path, action, screenshot/artifact path, and exact UI symptom.
   - If no issues are found, say what flows and viewports were checked.
   - Do not claim visual QA is complete if screenshots were not inspected.

## Practical Commands

Prefer project-native commands first:

```bash
make frontend-e2e
make frontend-e2e-integration
```

For ad hoc inspection, use Playwright to start or attach to the app, navigate the changed pages, and save screenshots under a temporary artifact directory such as `/tmp/visual-qa-<task>/`.

## Acceptance Bar

A visual QA pass is acceptable when:

- The app was exercised in a real browser.
- Screenshots were captured and inspected for each relevant viewport.
- The changed workflow was executed end to end.
- Any failures are reproducible with concise steps.
- The final report distinguishes automated test pass/fail from human visual inspection.
