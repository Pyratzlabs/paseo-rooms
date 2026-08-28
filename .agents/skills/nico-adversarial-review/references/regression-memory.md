# Regression Memory

Use this as the default regression memory when the target repository does not provide `reviews/regression-memory.md`.

When reviewing, check each relevant pattern and cite concrete evidence. Mark irrelevant patterns as N/A. If the target repository has its own regression memory, prefer that file over this fallback.

## Patterns

### User Isolation And Cross-Tenant Access

Any user-scoped query, mutation, export, background job, webhook, or callback must prove that the acting identity can only access the intended user's or tenant's resources.

Check for:
- Direct object lookups by ID without user or tenant scoping.
- Admin or service clients used in user-facing paths without an explicit authorization boundary.
- Background jobs that process user-owned resources without preserving tenant context.

### SSRF And Outbound Integrations

Any code that fetches user-provided or provider-provided URLs must prevent access to internal networks, metadata services, local files, and unintended protocols.

Check for:
- URL fetchers without scheme, host, DNS, redirect, and private-IP validation.
- Webhooks or importers that trust callback URLs.
- Provider integrations that follow redirects into internal addresses.

### Secrets Exposure

Secrets, tokens, credentials, BYOK values, OAuth grants, and private keys must not appear in logs, URLs, command lines, artifacts, client bundles, telemetry, error responses, or plaintext persistence.

Check for:
- Logging full request/response bodies or headers.
- Passing secrets as CLI arguments instead of files or environment variables.
- Returning provider errors that echo credentials.

### Retry, Idempotency, And External Side Effects

Code that talks to payment providers, infrastructure APIs, queues, email/SMS providers, webhooks, or LLM/tool systems must handle retries and partial failures without duplicate harmful side effects.

Check for:
- Missing idempotency keys around create/charge/provision/send actions.
- Check-then-act races.
- Retries after a side effect but before local state is recorded.

### Server-Side Feature Gates

Feature flags, rollout controls, plan checks, role checks, and billing gates must be enforced on the server side for security or business-critical operations.

Check for:
- UI-only gating.
- API endpoints that rely on hidden buttons or disabled controls.
- Background jobs that bypass feature eligibility checks.

### Migration Safety

Migrations must preserve existing data, be safe to deploy with old and new code during rollout, and avoid irreversible destructive operations unless there is an explicit rollback plan.

Check for:
- Dropping or rewriting columns without backfill and compatibility windows.
- Non-idempotent data migrations.
- Assumptions about production data shape that are not validated.

### Production Parity In Tests

Tests must not silently weaken production-critical behavior through different settings, mocks, or bypasses.

Check for:
- Test-only settings that disable authentication, tenant isolation, retries, encryption, or provider validation.
- Mocks that accept invalid inputs production rejects.
- Assertions that only cover happy paths while risk lives in error or retry paths.
