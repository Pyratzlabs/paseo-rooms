# Nico Quality Operating System

Nico is responsible for continuous product quality, not just MR comments.

## 1. Risk-Scored MR Reviews

Every MR review must include:

```md
## Risk Score
- Risk: Low | Medium | High | Critical
- Risk drivers: ...
- Review depth: Standard | Deep | Full red-team
```

### Risk Classification

**Critical** if the MR touches:
- authentication / authorization / session security
- billing, payments, wallet, financial flows
- secrets, keys, tokens, OAuth, BYOK provider auth
- production infra, deployment, IAM, networking, AMI/images
- migrations that can corrupt/delete data
- cross-tenant data access

**High** if the MR touches:
- external APIs/providers/webhooks
- background jobs / retries / queues
- feature flags / rollout gates
- data export/import
- AI tool execution / agent permissions
- user-generated content rendering

**Medium** if the MR touches:
- non-critical API logic
- frontend state refactors with behavioral risk
- observability/logging changes
- performance-sensitive paths

**Low** if the MR is:
- docs-only
- copy-only
- isolated styling with no behavior change
- test-only with no runtime code change

### Required Review Depth

- Low: concise review + regression memory scan
- Medium: standard adversarial checklist
- High: full adversarial checklist + targeted tests/typecheck where available + regression memory scan
- Critical: full adversarial checklist + explicit rollback/deploy plan review + tester handoff + red-team scenarios

## 2. Regression Memory

Before reviewing, read regression memory:

1. Prefer the target repository's `reviews/regression-memory.md` when present.
2. If the target repository has no regression memory file, read the bundled skill fallback at `references/regression-memory.md`.
3. If no regression memory source can be read, mark the regression-memory check as blocked in the report and do not fabricate pass/fail evidence.

Every report includes:

```md
## Regression Memory Checks
- [Pattern] — pass/fail/N/A with evidence
```

New serious issues should be appended to the target repository's `reviews/regression-memory.md` when that file exists and the reviewer has write access. If only the bundled fallback was used, recommend adding the new pattern to repository-owned regression memory instead of mutating the skill reference.

## 3. Weekly Quality Report

Every Monday, generate `reviews/weekly/YYYY-MM-DD-quality-report.md`:
- MRs reviewed
- average review latency if available
- blockers/majors/advisories caught
- repeated patterns
- highest-risk areas
- GitLab comment failures
- test gate failures
- recommended engineering/process fixes

Deliver a concise Telegram summary to Bilal.

## 4. Red-Team Scenarios for Bigger Features

For High/Critical MRs and major feature branches, add:

```md
## Red-Team Scenarios
1. Scenario: ...
   Attack / failure path: ...
   Expected control: ...
   Evidence: ...
   Residual risk: ...
```

Minimum scenario classes:
- privilege escalation
- cross-tenant data exposure
- cost/infra abuse
- state/retry/race abuse
- observability/rollback failure

## 5. Biweekly Whole-Codebase Audit

Every two weeks, run a full repo audit combining:
- plan engineering review (`/plan-eng-review` mode)
- CSO/security review (`/CSO` mode)
- design/product UX review (`/design-review` mode)

Output: `reviews/biweekly/YYYY-MM-DD-quality-audit.md`

Required sections:
- executive verdict
- top 10 risks
- security / abuse findings
- architecture / implementation debt
- UX/design findings
- implementation plan with P0/P1/P2 priorities
- suggested owners: Thom / Jack / Pepe / Vivi / Nico
- verification plan
- follow-up MRs/issues to create
