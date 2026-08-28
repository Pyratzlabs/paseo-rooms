# Code Review Methodology — Adversarial Review Standard

_Established 2026-03-31 by Bilal. Mandatory for all MR reviews._

---

## Principles

1. **Every MR gets an adversarial review.** No exceptions. No "✅ Approved, no security issues" without the full pass.
2. **Think like an attacker.** For every endpoint, model, and data flow — ask "how would I break this?"
3. **If you can't do the deep review, say so.** Never give false confidence. "I haven't reviewed this in depth" is always better than a shallow approval.

---

## Review Process

### Step 1: Understand the Change
- Read the MR description and all changed files
- Identify the attack surface: new endpoints, auth changes, data flows, financial operations, external calls

### Step 2: Adversarial Analysis
For each finding, classify severity:

| Level | Tag | Meaning |
|-------|-----|---------|
| 🔴 | CRITICAL | Exploitable vulnerability, data leak, financial risk. **Blocks merge.** |
| 🟠 | ADVERSARIAL | Real attack vector but requires specific conditions, or design flaw that degrades security posture. **Should block merge.** |
| 🟡 | ADVISORY | Code smell, missing defense-in-depth, performance concern, or future risk. **Doesn't block but should be tracked.** |

### Step 3: Report Format
Every finding must include:

```
🔴/🟠/🟡 CATEGORY: One-Line Title

Attack vector / issue description (be specific — show the code)
Impact: What can an attacker do? What breaks?
Confidence: HIGH / MEDIUM / LOW
Fix: Concrete recommendation
```

### Step 4: Summary
End with a count: `X 🔴 · Y 🟠 · Z 🟡` and a clear merge recommendation.

---

## Adversarial Checklist

Run through these for every MR:

### Authentication & Authorization
- [ ] Are new endpoints properly authenticated?
- [ ] Is authorization checked (user can only access their own data)?
- [ ] Are there IDOR vulnerabilities (can user A access user B's resources)?
- [ ] Token/session handling — creation, invalidation, rotation

### Input Validation
- [ ] Are all user inputs validated server-side (not just frontend)?
- [ ] SQL injection, command injection, path traversal
- [ ] File uploads: type validation, size limits, path sanitization
- [ ] Rate limiting on new endpoints (especially auth, financial, pairing)

### Data Exposure
- [ ] Do error messages leak internal details (stack traces, IDs, infra info)?
- [ ] Are API responses scoped to the requesting user's data?
- [ ] Are secrets/keys properly scoped (not using management keys for user operations)?
- [ ] Logging — are sensitive values (tokens, passwords, PII) excluded?

### Financial / Business Logic
- [ ] Frontend-only gates on financial operations (MUST have backend validation)
- [ ] Race conditions on balance checks, payments, credits
- [ ] Idempotency on payment endpoints

### Infrastructure & Config
- [ ] IP extraction — using rightmost X-Forwarded-For (not leftmost/spoofable)?
- [ ] CORS, CSRF, cookie security settings
- [ ] Environment-specific assumptions (NUM_PROXIES, feature flags)
- [ ] Docker/container security (exposed ports, mounted secrets)

### State & Concurrency
- [ ] Race conditions between check-and-act operations
- [ ] Cache consistency (stale sessions, phantom reads)
- [ ] Soft delete consistency (filtered in all queries?)
- [ ] Migration safety (backward compatible? reversible?)

### Frontend-Specific
- [ ] XSS via user content rendering (innerHTML, dangerouslySetInnerHTML)
- [ ] CSRF tokens on state-changing requests
- [ ] Client-side regex from user input (ReDoS)
- [ ] Sensitive data in localStorage/sessionStorage

---

## When This Applies

- **Every MR on HER (mrchief.ai)** — mandatory
- **Every MR on FHEx402** — mandatory (smart contracts = higher stakes)
- **Artificial-Lab products** — mandatory before launch
- **Internal tooling** — advisory (use judgment)

---

## Integration with GitLab Watcher

The `gitlab-watcher` cron (Thom) detects new MRs. On every new MR notification:

1. Alfrawd fetches the full diff via GitLab API
2. Runs the adversarial review using this methodology
3. Reports findings to Bilal with the 🔴/🟠/🟡 format
4. **Never sends a "looks good" without completing the full checklist**

---

_This methodology is non-negotiable. Shallow reviews create false confidence, which is worse than no review at all._
