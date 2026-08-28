---
name: nico-code-quality-review
description: Use this skill when reviewing or improving code quality, maintainability, correctness, architecture, tests, performance, readability, Django backend patterns, Python style, TypeScript types, React/Next.js code, or implementation quality without focusing primarily on security vulnerabilities.
---

# Nico Code Quality Review

## Purpose

Use this skill to review a code change for implementation quality rather than adversarial security. The review should find maintainability risks, correctness bugs, hidden coupling, brittle abstractions, weak tests, type gaps, performance regressions, readability issues, and framework-specific misuse.

## Reference Files

Load only the references relevant to the reviewed change:

- `references/general-code-quality.md`: baseline quality rubric for all languages and stacks. Read this for every code-quality review.
- `references/django-code-quality.md`: Django, Django REST Framework, ORM, Celery, migrations, and Python backend guidance.
- `references/typescript-code-quality.md`: TypeScript, React, Next.js, frontend state, data fetching, and type-safety guidance.
- `references/code-quality-review-template.md`: formal review artifact for MR/PR reviews or implementation readiness checks.

## Review Workflow

1. Understand the story, acceptance criteria, and changed files.
2. Read the implementation and nearby contracts: callers, models/types, tests, config, migrations, API clients, and shared helpers.
3. Load `general-code-quality.md`, then load Django and/or TypeScript references when the changed files touch those areas.
4. Classify review depth:
   - **Concise**: docs, copy, isolated styling, or mechanical cleanup.
   - **Standard**: normal feature or bug-fix change with local behavior.
   - **Deep**: shared abstractions, data model changes, concurrency, migrations, API contracts, critical workflows, or broad refactors.
5. Check correctness before polish. Prefer findings that could cause wrong behavior, fragile maintenance, test blind spots, or future change hazards.
6. Run targeted verification when reasonable: tests, typecheck, lint, build, formatting, migration checks, or focused reproduction commands.
7. Report findings first, ordered by severity, with concrete file and line references.
8. End with a clear verdict and exact next action.

## Severity Standard

- **Blocker**: likely wrong behavior, data corruption/loss, broken deploy/build, incompatible migration, severe performance regression, or a design that prevents the feature from working.
- **Major**: maintainability or correctness risk that should be fixed before merge: brittle abstraction, leaky API contract, missing important test, N+1 query, race-prone flow, type escape, duplicated domain logic, or hidden coupling.
- **Minor / Advisory**: readability, naming, small duplication, local simplification, non-blocking test improvement, or future-proofing suggestion.

Every substantive finding should include:

- Location.
- Issue.
- Impact.
- Suggested fix.
- Verification.

Do not pad reviews. If there are no material findings, say so and describe the review depth, files reviewed, verification performed, and residual risk.

## Output Rules

For ordinary code reviews, lead with findings. Keep summaries short.

For formal MR/PR review artifacts, follow `references/code-quality-review-template.md`. Use the same visual severity format as `nico-adversarial-review`: 🔴 Blocker, 🟠 Major, and 🟡 Minor / Advisory.

If the user asks you to fix issues, implement the fixes after the review unless they explicitly ask for review only.
