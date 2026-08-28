# Adversarial Review Template

Use this as the standard review artifact for merge requests, pull requests, and implementation readiness checks.

## Verdict

**Verdict:** APPROVE | APPROVE WITH ADVISORIES | REQUEST CHANGES | DO NOT MERGE

One concise paragraph explaining the merge decision and the highest-risk reason.

## Risk Score

- **Risk:** Low | Medium | High | Critical
- **Risk drivers:** Authentication, authorization, billing, secrets, infra, migrations, external APIs, background jobs, feature flags, AI/tool execution, user-generated content, or other relevant surfaces.
- **Review depth:** Concise | Standard adversarial checklist | Full adversarial checklist | Full red-team

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

## Regression Memory Checks

- **Known pattern 1:** Pass | Fail | N/A. Evidence:
- **Known pattern 2:** Pass | Fail | N/A. Evidence:
- **Known pattern 3:** Pass | Fail | N/A. Evidence:

Examples of patterns to check:
- User isolation and cross-tenant access.
- SSRF in URL fetchers and outbound integrations.
- Secrets in logs, command lines, files, env, or client bundles.
- Retry/idempotency after external side effects.
- Feature flags enforced server-side, not only in UI.
- Migrations are reversible/idempotent and preserve existing data.
- Test settings do not silently differ from production-critical behavior.

## Attack Surface

- **Inputs:** Params, headers, body fields, cookies, localStorage, URL segments, files, env vars, CLI args.
- **Trust boundaries:** Client to server, user to admin, tenant to tenant, service to service, app to provider.
- **Auth/authz dependencies:** Existing guards this change relies on.
- **State changes:** Database, cache, queues, files, cookies, sessions, provider resources.
- **Outputs / leakage risk:** API responses, logs, errors, exports, telemetry, user-visible UI.

## Adversarial Checklist

- **Auth:** Can this be reached without the intended identity/session/API key?
- **Authorization:** Can a user act on another user or tenant's resources?
- **Input validation:** What happens with missing, malformed, overlong, unicode, replayed, or out-of-order inputs?
- **Injection:** SQL, command, template, prompt, path traversal, SSRF, XSS, deserialization.
- **Secrets:** Are tokens exposed in logs, URLs, process lists, artifacts, errors, client code, or persisted plaintext?
- **State / concurrency:** Double-submit, retry, race, partial failure, stale cache, rollback.
- **External APIs:** Timeout, retry policy, idempotency key, rate limits, provider error mapping.
- **Cost / abuse:** Can a user amplify spend, jobs, outbound calls, storage, or logs?
- **Observability:** Are failures visible without leaking internals?
- **Rollback:** Can the change be disabled or reverted cleanly?
- **Tests:** Are security and regression paths covered, not only happy paths?

## Red-Team Scenarios

1. **Scenario:** Privilege escalation or cross-tenant access.
   - **Attack / failure path:**
   - **Expected control:**
   - **Evidence:**
   - **Residual risk:**

2. **Scenario:** State, retry, or race abuse.
   - **Attack / failure path:**
   - **Expected control:**
   - **Evidence:**
   - **Residual risk:**

3. **Scenario:** Cost, infra, provider, or tool abuse.
   - **Attack / failure path:**
   - **Expected control:**
   - **Evidence:**
   - **Residual risk:**

## Findings

### 🔴 BLOCKER: Title

- **Location:** `path/to/file.ext:line`
- **Attack vector / issue description:**
- **Impact:**
- **Confidence:** High | Medium | Low
- **Chain potential:**
- **Fix:** Specific required change.
- **Verification:** Test, command, or manual check required.

### 🟠 MAJOR / ADVERSARIAL: Title

- **Location:** `path/to/file.ext:line`
- **Attack vector / issue description:**
- **Impact:**
- **Confidence:** High | Medium | Low
- **Chain potential:**
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
- **🟠 Majors / adversarial:** 0
- **🟡 Minors / advisories:** 0
- **Merge recommendation:** Approve | Request changes | Do not merge.

Close with the exact next action: merge, fix specific findings, run missing gate, or re-review after changes.
