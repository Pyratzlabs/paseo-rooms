# TypeScript Code Quality

Use this reference for TypeScript, React, Next.js, frontend state, API clients, hooks, tests, and package code.

Primary documentation baselines:

- TypeScript strictness and basic types: https://www.typescriptlang.org/docs/handbook/2/basic-types.html
- TypeScript everyday types and narrowing: https://www.typescriptlang.org/docs/handbook/2/everyday-types.html
- typescript-eslint `no-explicit-any`: https://typescript-eslint.io/rules/no-explicit-any/

## Type Safety

- Prefer `strict` TypeScript. Treat `noImplicitAny` and `strictNullChecks` as core quality gates for new code.
- Avoid `any`. If a value is unknown at a boundary, type it as `unknown`, validate/narrow it, then expose a precise type.
- Avoid type assertions (`as Foo`) unless the code proves the invariant nearby. Repeated assertions usually mean the boundary type is wrong.
- Model domain states with discriminated unions instead of nullable field clusters or boolean flag piles.
- Use exhaustive checks for unions where missing a case would be wrong behavior.
- Do not widen literals accidentally when literal types carry meaning; use `as const` or `satisfies` where appropriate.
- Keep generated API types separate from domain/view models. Transform at boundaries rather than leaking transport shapes everywhere.
- Use branded or nominal-ish types for IDs, currencies, units, or provider-specific identifiers when mixups are plausible.
- Prefer `ReadonlyArray`, readonly object shapes, and immutable updates where mutation would make state harder to reason about.

## Runtime Boundaries

- TypeScript types do not validate runtime data. Validate external inputs: API responses, localStorage, URL params, form data, postMessage, feature flags, env vars, and provider payloads.
- Parse and normalize data once at the boundary. Downstream code should not repeatedly defend against the same malformed shape.
- Keep error shapes explicit. Do not assume caught values are `Error`.
- Avoid silently defaulting invalid data to acceptable-looking values when that hides upstream bugs.

## React Components

- Components should be named after UI/domain purpose and keep rendering logic readable.
- Keep state minimal and derived values derived. Avoid storing values that can be computed from props/query data.
- Avoid mirroring props into state unless there is a deliberate editing/draft lifecycle.
- Keep effects for synchronization with external systems. Do not use `useEffect` to compute render-only values.
- Effects need complete dependencies or an explicit, justified alternative.
- Stable callbacks and memoization should solve measured or structural problems, not decorate every component.
- Avoid prop drilling by extracting cohesive components or using context for stable cross-cutting state. Do not use context for rapidly changing local state without considering render cost.
- Ensure loading, empty, error, and success states are complete and do not duplicate contradictory UI.
- Handle text overflow, responsive constraints, disabled/busy states, and repeated user actions.

## Next.js And Server Boundaries

- Keep server components server-only unless interactivity requires a client component.
- Place `"use client"` at the smallest interactive boundary.
- Do not import server-only code, secrets, filesystem access, database clients, or privileged SDKs into client bundles.
- Fetch data at the server boundary when it improves correctness, cache control, or initial render. Fetch on the client when interaction or freshness requires it.
- Be explicit about caching, revalidation, and `no-store` semantics for user-specific data.
- Use route handlers and server actions as API boundaries with validation, authorization, and typed responses.
- Treat URL params and search params as untrusted runtime input.
- Metadata, redirects, not-found states, loading states, and error boundaries should be intentional for user-facing routes.

## Data Fetching And State

- Query keys should include every parameter that changes the fetched result.
- Mutations should update or invalidate the exact affected queries.
- Avoid duplicating server state in local state.
- Race-prone interactions should handle stale responses, cancellation, optimistic rollback, and repeated submits.
- API client functions should have narrow responsibilities and consistent error handling.
- Keep cache lifetime aligned with product expectations, not arbitrary defaults.

## Forms

- Validate at runtime with a shared schema where practical.
- Keep form defaults, schema, UI fields, and submit payload in sync.
- Preserve user input across recoverable errors.
- Distinguish field errors from form/global errors.
- Disable or guard duplicate submits when side effects are not idempotent.
- Avoid making UI-only validation the source of truth for business rules.

## Testing

- Test user-visible behavior and important state transitions, not component internals.
- Cover loading, empty, error, success, validation, and permission/eligibility states when relevant.
- Mock network at the request boundary, not by mocking every hook implementation.
- Assert accessibility-relevant labels and roles when using Testing Library.
- Avoid brittle snapshots of large component trees.
- Add type-level tests or compile-time assertions for tricky public types when useful.

## Performance

- Avoid unnecessary client components, large client bundles, repeated serialization, and heavy work during render.
- Keep expensive calculations memoized only when they are truly expensive or preserve referential identity for child components.
- Virtualize large lists and paginate or stream large data sets.
- Use images, fonts, and dynamic imports according to framework conventions.
- Watch for render loops, unstable dependencies, provider values recreated every render, and context updates that re-render large trees.

## TypeScript Review Smells

- `any`, `as unknown as`, non-null assertions, disabled lint rules, or `// @ts-ignore` near business logic.
- Optional fields everywhere instead of a modeled state transition.
- A hook that fetches, transforms, mutates, navigates, and displays errors all at once.
- A client component wrapping a full route because one small child needs interactivity.
- Query invalidation that uses broad cache clearing because the affected contract is unclear.
- Runtime JSON consumed directly as a typed object.
- Tests that pass by mocking the hook under review instead of the behavior boundary.
