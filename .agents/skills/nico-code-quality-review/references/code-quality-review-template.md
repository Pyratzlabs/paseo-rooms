# Code Quality Review Template

Use this template for MR/PR reviews, implementation readiness checks, or larger refactor reviews.

## Verdict

**Verdict:** APPROVE | APPROVE WITH ADVISORIES | REQUEST CHANGES | DO NOT MERGE

One concise paragraph explaining the merge decision and the highest-risk quality concern.

## Quality Score

- **Quality risk:** Low | Medium | High | Critical
- **Risk drivers:** Correctness, maintainability, architecture, tests, migrations, performance, type safety, framework misuse, API contracts, observability, or other relevant surfaces.
- **Review depth:** Concise | Standard | Deep

## Scope

- Files / modules reviewed:
- Feature or story reviewed:
- Out of scope:
- Spec / MR description / acceptance criteria source:

## Story / Plan Alignment

- **Acceptance criterion 1:** Pass | Fail | Partial | N/A. Evidence:
- **Acceptance criterion 2:** Pass | Fail | Partial | N/A. Evidence:
- **Definition of done:** Pass | Fail | Partial | N/A. Evidence:
- **Architecture / design alignment:** Pass | Fail | Partial | N/A. Evidence:

## Implementation Surface

- **Inputs / contracts:** Params, props, request bodies, API responses, serializer fields, env vars, CLI args, config.
- **State changes:** Database, cache, queues, files, cookies, sessions, client state, provider resources.
- **Callers and dependencies:** Existing call sites, shared helpers, generated types, framework conventions, external APIs.
- **Error and edge paths:** Empty, malformed, overlong, stale, duplicate, out-of-order, partial failure, retry, rollback.
- **User-visible outputs:** API responses, UI states, errors, logs, telemetry, exports, background job side effects.

## Quality Checklist

- **Correctness:** Does the implementation satisfy behavior across happy paths, edge cases, and failure paths?
- **Contracts:** Are API, serializer, model, type, and component contracts explicit and compatible with callers?
- **Maintainability:** Is the design simple, localized, readable, and free of unnecessary abstraction or duplication?
- **Architecture boundaries:** Does the change respect ownership, dependency direction, tenant isolation, and framework boundaries?
- **Tests:** Are important behavior, regression paths, and failure modes covered without brittle over-mocking?
- **Performance:** Are query counts, render behavior, bundle impact, background work, and hot paths acceptable?
- **Observability:** Are failures visible and actionable without noisy or misleading logs?
- **Django / backend patterns:** Are ORM, migrations, DRF, Celery, settings, and transaction patterns correct where applicable?
- **TypeScript / frontend patterns:** Are types, React state, Next.js boundaries, data fetching, and accessibility correct where applicable?

## Quality Scenarios

1. **Scenario:** Correctness regression or broken contract.
   - **Failure path:**
   - **Expected behavior:**
   - **Evidence:**
   - **Residual risk:**

2. **Scenario:** Maintainability or architecture boundary failure.
   - **Failure path:**
   - **Expected structure:**
   - **Evidence:**
   - **Residual risk:**

3. **Scenario:** Test, performance, or framework-pattern gap.
   - **Failure path:**
   - **Expected control:**
   - **Evidence:**
   - **Residual risk:**

## Findings

### 🔴 BLOCKER: Title

- **Location:** `path/to/file.ext:line`
- **Issue description:**
- **Impact:**
- **Confidence:** High | Medium | Low
- **Fix:** Specific required change.
- **Verification:** Test, command, or manual check required.

### 🟠 MAJOR: Title

- **Location:** `path/to/file.ext:line`
- **Issue description:**
- **Impact:**
- **Confidence:** High | Medium | Low
- **Fix:** Specific required change.
- **Verification:** Test, command, or manual check required.

### 🟡 MINOR / ADVISORY: Title

- **Location:** `path/to/file.ext:line`
- **Issue description:**
- **Impact:**
- **Fix:** Specific recommended change.

## Verification Gates

- `command` — pass | fail | blocked. Evidence:
- `command` — pass | fail | blocked. Evidence:
- Manual review of `path/to/file.ext` — pass | fail. Evidence:

## Summary

- **🔴 Blockers:** 0
- **🟠 Majors:** 0
- **🟡 Minors / advisories:** 0
- **Merge recommendation:** Approve | Request changes | Do not merge.

Close with the exact next action: merge, fix specific findings, run missing gate, or re-review after changes.
