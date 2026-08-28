---
name: feature-lifecycle-loop
description: Use when implementing a Business Builder feature slice with the established architect, implementation, pyratz review, visual QA, and iteration workflow, including subagent delegation, tests, screenshot inspection, and cleanup.
---

# Feature Lifecycle Loop

Use this workflow for non-trivial Business Builder feature work.

## Sequence

1. Spawn an architect subagent before editing code. Ask for an implementation plan against the current codebase, explicit reuse opportunities, risks, and test strategy. The architect must not edit files.
2. Implement the slice locally using existing repo patterns. Keep Django services, API serializers/views, generated OpenAPI/Orval types, React surfaces, and tests in sync when the behavior crosses boundaries.
3. Run the focused checks first, then broaden to the relevant repo checks. Regenerate API types with `make generate-api` whenever the schema changes.
4. Spawn a pyratz-style review subagent against the current diff. Ask it to lead with bugs, regressions, missing tests, type issues, security risks, and architectural drift. The reviewer must not edit files.
5. For UI-facing changes, use the `visual-qa` skill and/or spawn a visual QA subagent. Exercise the running app in desktop and mobile viewports, inspect screenshots, and verify the user workflow rather than only checking that tests pass.
6. Fix the findings that matter for this stage of the product. Record explicitly when a finding is intentionally deferred.
7. Iterate checks, pyratz review, and visual QA until the remaining issues are either resolved or consciously accepted.
8. Stop dev servers and remove temporary specs, screenshots, or scripts unless they are intended repo artifacts.
9. When the user has asked for commits and the review loop is complete, create semantic commits. Split commits by coherent concern, keep generated artifacts with the code that requires them, and avoid mixing skill/process documentation with product implementation when a separate commit is clearer.

## Defaults

- Prefer fake local agents and deterministic fixtures until the product has a real agent runtime.
- Keep the human-visible workflow coherent before optimizing internals.
- Do not commit unless the user asks for commits.
- Once commits are requested, commit after reviews and verification are done rather than before the loop has converged.
- Preserve user changes and do not revert unrelated work.
