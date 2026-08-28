# General Code Quality

Use this checklist for every code-quality review. Focus on concrete risks, not personal preference.

## Correctness

- The implementation satisfies the stated story and does not rely on unstated happy-path assumptions.
- Edge cases are handled deliberately: empty input, missing fields, null/undefined, duplicate requests, retries, ordering, time zones, pagination boundaries, and partial failure.
- Error paths preserve useful state, return actionable errors, and avoid swallowing exceptions that should fail fast.
- State transitions are explicit and valid. Impossible states are represented as impossible where the language allows it.
- Data transformations are deterministic, reversible when necessary, and covered by tests when business-critical.
- Time, randomness, environment, and external services are injected or isolated enough to test predictably.

## Design And Architecture

- The change belongs in the right module, feature, app, package, or layer.
- Public APIs are small, cohesive, and named after domain concepts rather than implementation details.
- Dependencies point in the intended direction. Lower-level modules do not import feature/UI/application code.
- Shared helpers encode genuinely shared concepts, not accidental duplication between two call sites.
- Abstractions remove real complexity. Do not add factories, managers, hooks, base classes, or generic utilities before there is stable repetition.
- Side effects are kept at boundaries. Pure computation stays separate from IO where practical.
- Configuration is centralized and typed/validated. Environment variables are not scattered through business logic.
- Backwards compatibility is considered for public APIs, persisted data, background jobs, clients, and rollout windows.

## Maintainability

- Names explain intent and domain meaning. Avoid names that only restate type or implementation.
- Functions do one coherent thing and expose clear inputs/outputs.
- Branching complexity is justified. Deep nesting, boolean flag piles, and large conditionals should be simplified or decomposed.
- Duplication is removed when it represents the same rule. Duplication is acceptable when similar code is likely to evolve differently.
- Comments explain why, tradeoffs, invariants, or non-obvious constraints. They do not narrate obvious code.
- Dead code, unused exports, stale TODOs, and orphaned files are removed or tracked.
- Formatting and linting are consistent with the repo, with no unrelated style churn.

## Function Size And Shape

- Long functions are not automatically wrong, but they must earn their length.
- A function is too long when it mixes levels of abstraction, handles multiple reasons to change, hides distinct phases, or makes the happy path hard to see.
- Prefer extracting named helpers for cohesive sub-steps, especially validation, data loading, transformation, side effects, and response construction.
- Do not extract only to satisfy a line count. Extraction should improve naming, testability, reuse, or local reasoning.

## Tests

- Tests cover the behavior that can break, not only implementation details.
- Each meaningful branch has coverage: success, validation failure, permission/eligibility failure, missing dependency, provider error, retry, and boundary cases when applicable.
- Regression tests are added for bug fixes.
- Tests are deterministic and isolated: no wall-clock dependence, random order dependence, network leaks, shared mutable state, or hidden production calls.
- Assertions check observable behavior and important side effects, not just that a function was called.
- Test factories and fixtures express relevant domain state clearly.
- Snapshot tests are small, intentional, and reviewed as behavior contracts, not bulk output dumps.

## Performance And Resource Use

- Hot paths avoid unnecessary repeated work, unbounded loops, N+1 IO, excessive serialization, needless re-renders, and loading more data than needed.
- Expensive operations are moved out of request/render paths when possible.
- Caches have clear invalidation and freshness rules.
- Pagination, batching, streaming, or chunking is used for unbounded collections.
- Large files, exports, logs, and payloads have limits and backpressure where appropriate.

## Observability And Operations

- Important failures are visible through logs, metrics, traces, job state, or user-facing status.
- Logs include enough context to debug without leaking sensitive data.
- Background work has retry, timeout, idempotency, and dead-letter/failure visibility when relevant.
- Feature flags, rollout controls, and fallback paths are server-side where behavior must be reliable.
- Deploy and rollback implications are understood for migrations, API changes, long-running jobs, queues, and persisted state.

## Review Smells

Treat these as prompts for deeper inspection:

- "Just a refactor" that changes tests, models, API responses, serialization, ordering, or lifecycle hooks.
- A new abstraction introduced with only one caller.
- Type casts, broad exception handlers, or ignored lint rules near important logic.
- A function whose phases cannot be summarized quickly or whose middle cannot be changed without re-reading the whole function.
- A large diff with no tests because "behavior is unchanged".
- Business rules duplicated across frontend, backend, jobs, and tests.
- Code that depends on implicit ordering, current time, process-global state, or default framework behavior.
- A change that makes the easy case cleaner but pushes complexity into every caller.
