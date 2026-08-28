---
name: nico-adversarial-review
description: Use this skill when performing adversarial code reviews, MR/PR reviews, implementation readiness checks, or security-focused review reports that need risk scoring, regression-memory checks, red-team scenarios, severity-tagged findings, and a clear merge verdict.
---

# Nico Adversarial Review

## Purpose

Use this skill to review a code change as an adversarial reviewer. The review should look for exploitable bugs, behavioral regressions, unsafe assumptions, missing tests, weak rollback paths, and product-quality risks before merge.

## Reference Files

Load only the references needed for the current review:

- `references/CODE-REVIEW-METHODOLOGY.md`: mandatory baseline for every adversarial review. Read this before issuing a verdict.
- `references/review-operating-system.md`: use for risk classification, regression memory, weekly quality reports, red-team scenarios, and whole-codebase audit workflows.
- `references/regression-memory.md`: default regression memory to check when the target repo does not provide its own `reviews/regression-memory.md`.
- `references/adversarial-review-template.md`: use when the user asks for a formal review artifact or when reporting an MR/PR review.

## Review Workflow

1. Understand the requested review target: MR/PR diff, changed files, implementation plan, or local working tree.
2. Read the relevant source, tests, config, migrations, and surrounding code. Do not review only the changed lines when behavior depends on nearby contracts.
3. Classify risk as Low, Medium, High, or Critical using `review-operating-system.md`.
4. Run the adversarial checklist from `CODE-REVIEW-METHODOLOGY.md`.
5. Check regression memory. Prefer the target repo's `reviews/regression-memory.md` when present; otherwise use the bundled `references/regression-memory.md`. If neither can be read, mark regression-memory checks as blocked rather than inventing evidence.
6. For High or Critical changes, add red-team scenarios covering privilege escalation, cross-tenant data exposure, cost or infra abuse, state/retry/race abuse, and observability or rollback failure where applicable.
7. Run targeted verification commands when available and reasonable: tests, typecheck, lint, build, migration checks, or security-specific repro commands.
8. Report findings first, ordered by severity, with concrete file and line references.
9. End with a clear verdict and exact next action.

## Finding Standard

Every substantive finding must include:

- Severity: blocker/critical, major/adversarial, or minor/advisory.
- Location: file and line when available.
- Attack vector or failure path.
- Impact.
- Confidence.
- Concrete fix.
- Verification required.

Do not give a shallow approval. If review depth was limited, say exactly what was not reviewed and downgrade confidence.

## Output Rules

For ordinary code reviews, lead with findings. Keep summary and change context secondary.

For formal MR/PR review artifacts, follow `references/adversarial-review-template.md` and include:

- Verdict.
- Risk Score.
- Scope.
- Story / Plan Alignment.
- Regression Memory Checks.
- Attack Surface.
- Adversarial Checklist.
- Red-Team Scenarios when required.
- Findings.
- Verification Gates.
- Summary with merge recommendation.

If there are no findings, state that clearly, include the review depth, verification performed, and residual risk.
