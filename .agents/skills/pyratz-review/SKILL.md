---
name: pyratz-review
description: Use this skill when reviewing a PR/MR, branch into a target branch, local diff, implementation plan, or code change for Pyratz/HER and you want both adversarial security review and code-quality review in one report. Defaults branch review target to main. This orchestrates nico-adversarial-review and nico-code-quality-review, preserves both pass outputs, and adds a strict gate verdict.
---

# Pyratz Review

## Purpose

Use this skill to run the full Pyratz review standard: one adversarial/security pass plus one code-quality/maintainability pass, then concatenate both review artifacts behind a strict gate verdict.

This is an orchestration skill. It depends on sibling skills:

- `../nico-adversarial-review/SKILL.md`
- `../nico-code-quality-review/SKILL.md`

If either sibling skill is missing or cannot be read, say which one is unavailable and continue with the available pass. Do not pretend both passes ran.

When subagents are available, run the adversarial/security pass and the code-quality pass in separate dedicated subagents. Each child reviewer should receive only the resolved review target, repository context it independently gathers, and its own skill instructions. Do not show either child reviewer the other pass output before both child reports are complete.

## Review Target Resolution

Treat branch reviews as reviews of a source branch into a target branch.

- **Target branch parameter:** Accept target branch wording such as `against <branch>`, `into <branch>`, `target <branch>`, `base <branch>`, or `--target <branch>`.
- **Default target branch:** If no target branch is supplied, use `main`.
- **Source branch parameter:** If the user supplies a branch, MR/PR URL, or diff identifier, use that as the source. Otherwise use the current branch / `HEAD`.
- **Branch diff:** For branch reviews, review the merge-base diff from target to source, using a three-dot range such as `origin/main...HEAD` or `origin/<target>...<source>`. Fetch the target branch first when reasonable.
- **Working tree fallback:** Do not review only unstaged/untracked files when the user asks for a branch review or gives no explicit target while on a non-target branch. Review the current branch into the target branch instead. Use the working tree as the target only when the user explicitly asks for a local diff / working tree review, or when there is no meaningful branch diff and local changes are the only requested change.
- **Report scope:** State the resolved source and target branches, the exact diff range reviewed, and whether uncommitted changes were included or excluded.

## Review Workflow

1. Resolve the review target: MR/PR diff, source branch into target branch, changed files, implementation plan, or local working tree. Default branch target is `main`.
2. Read enough context to evaluate behavior: changed files, nearby contracts, tests, config, migrations, API clients, shared helpers, and relevant docs.
3. Load and follow `../nico-adversarial-review/SKILL.md`.
   - Load its referenced files as needed.
   - Produce security, abuse, regression-memory, and red-team findings when applicable.
4. Load and follow `../nico-code-quality-review/SKILL.md`.
   - Load its referenced files as needed.
   - Produce correctness, maintainability, architecture, test, performance, Django, and TypeScript findings when applicable.
5. Preserve each child review's findings, severity labels, wording, verdict, risk score, review depth, verification notes, and residual-risk notes. Do not summarize, merge, rewrite, soften, or deduplicate the child reports.
6. Run verification commands that cover both passes when reasonable: tests, typecheck, lint, build, migration checks, diff checks, focused repro commands, or query/performance checks. If a child review already ran verification, preserve that output in its section and mention shared verification only in the gate summary.
7. Produce one concatenated report using `references/pyratz-review-template.md`.

## Gate Verdict

The top of the report must include a short gate summary before the child reports.

- **DO NOT MERGE** if either child review says `DO NOT MERGE`, reports a Blocker/Critical finding, or reports a failed required verification gate that blocks deploy/merge.
- **REQUEST CHANGES** if either child review says `REQUEST CHANGES`, reports any Major finding, or marks a required review area as blocked in a way that prevents confidence.
- **APPROVE WITH ADVISORIES** if neither child requests changes and at least one child has only Minor / Advisory findings or non-blocking residual risk.
- **APPROVE** only when both child reviews approve with no material findings and no blocking verification gaps.

When verdicts conflict, use the strictest child verdict. Do not downgrade an adversarial request-changes verdict because the code-quality pass approves, and do not downgrade a quality request-changes verdict because the adversarial pass approves.

The gate summary may include counts by pass, but it must not replace either child review.

## Preservation Rules

- Keep the adversarial/security review and code-quality review as separate sections.
- Do not deduplicate findings across passes. Repeated findings are useful signal that both lenses found the same issue.
- Do not rewrite child findings into a shared style. Preserve attack paths, quality impacts, confidence notes, and verification requirements.
- Do not collapse "no findings" sections. Preserve each child review's depth, reviewed scope, verification, and residual risk.
- If a child pass cannot run, mark the gate verdict at least `REQUEST CHANGES` unless the user explicitly allowed a partial review.

## Output Rules

Lead with the gate summary, then concatenate the two child reports.

Always include:

- Gate verdict.
- Child verdicts for adversarial/security and code quality.
- Security/adversarial risk.
- Code-quality risk.
- Review depth for each pass.
- Verification performed and blocked checks.
- Exact next action.

After the gate summary, include:

1. `## Adversarial / Security Review` with the full preserved output from `nico-adversarial-review`.
2. `## Code Quality Review` with the full preserved output from `nico-code-quality-review`.

If there are no material findings, state in the gate summary that both passes ran, both approved, and whether any residual risk remains.
