# Django Code Quality

Use this reference for Django, Django REST Framework, ORM, Celery, migrations, management commands, and Python backend code.

Primary documentation baselines:

- Django database optimization: https://docs.djangoproject.com/en/5.2/topics/db/optimization/
- Django transactions: https://docs.djangoproject.com/en/5.2/topics/db/transactions/
- Django testing: https://docs.djangoproject.com/en/5.2/topics/testing/

## Models And Domain Logic

- Models should express persistence and invariant boundaries clearly. Keep sprawling business workflows in services/tasks when model methods become orchestration.
- Use explicit `related_name`, `db_table`, constraints, indexes, and choices when they are part of the domain contract.
- Prefer database constraints for invariants the database can enforce: uniqueness, non-null, check constraints, and foreign keys.
- Avoid duplicating domain rules between serializers, views, tasks, and models. Put the rule in one layer and call it consistently.
- Keep signal usage rare and obvious. Hidden side effects in signals are hard to trace, test, and order correctly.
- Do not override `save()` for broad workflows unless the invariant must always apply at persistence time. Prefer explicit service functions for multi-step operations.
- Use timezone-aware datetimes and Django timezone utilities. Do not mix naive datetimes with persisted or user-visible times.

## QuerySets, Managers, And ORM Use

- QuerySets should preserve required scoping and authorization boundaries before evaluation.
- Use custom QuerySet/manager methods for reusable query concepts, not one-off filters that obscure call-site behavior.
- Avoid evaluating QuerySets accidentally through `list()`, `len()`, truthiness, logging, template rendering, or repeated iteration.
- Use `exists()` for existence checks and `count()` for counts when objects are not needed.
- Use `select_related()` for single-valued relationships and `prefetch_related()` for multi-valued relationships when accessing related objects in loops.
- Use `only()` / `defer()` sparingly. They can help large rows but can also create hidden extra queries.
- Use database aggregation, annotation, and bulk operations where they reduce Python loops without hiding business meaning.
- Beware `bulk_create()` and `bulk_update()` bypassing `save()`, validation, and signals.
- Use `select_for_update()` and transactions for check-then-write flows that must be serialized.
- Inspect query count and generated SQL for list endpoints, admin pages, exports, and background jobs.

## Transactions And Concurrency

- Wrap multi-write invariants in `transaction.atomic()` and keep transactions short.
- Avoid network calls, slow provider calls, and long CPU work inside database transactions.
- Use `transaction.on_commit()` for side effects that should only run after a successful commit.
- Make background tasks idempotent. Retried tasks should not duplicate external side effects or corrupt state.
- Store idempotency keys, provider identifiers, or state-machine transitions when retries can replay work.
- Handle stale objects and concurrent updates with explicit locking, optimistic version checks, or state transition guards.

## Views, DRF, And API Boundaries

- Views should be thin: parse request, authorize, call domain/service logic, serialize response.
- Keep permission and eligibility checks server-side even if the UI also hides actions.
- Use explicit serializer fields. Avoid exposing model fields accidentally through broad `fields = "__all__"`.
- Separate read serializers from write serializers when input and output shapes differ.
- Validate input in serializers or domain commands, not in scattered view code.
- Return consistent response envelopes and error codes where the project has a standard.
- Avoid leaking ORM/model internals through API contracts unless they are stable domain language.
- Pagination, filtering, ordering, and limits should be explicit for list endpoints.

## Migrations

- Migrations must be deploy-safe with old and new code during rolling deploys.
- Split risky data changes into expand, backfill, switch, and contract phases when needed.
- Avoid irreversible destructive changes without a rollback and data preservation plan.
- Make data migrations idempotent, batched for large tables, and resumable when production volume matters.
- Do not import live models in migrations; use historical models from `apps.get_model()`.
- Consider locks, table rewrites, default values, and index creation cost.
- Test migrations or add focused checks when data shape assumptions are non-trivial.

## Celery And Background Jobs

- Tasks should be small, named after durable domain actions, and safe to retry.
- Pass stable identifiers into tasks, not large mutable objects or serialized model snapshots.
- Fetch fresh state inside the task and re-check eligibility before side effects.
- Configure timeouts, retry policy, backoff, and failure visibility deliberately.
- Distinguish transient provider failures from permanent validation/domain failures.
- Avoid task chains that hide partial failure without persisted progress state.

## Python Style And Typing

- Prefer small typed functions with explicit return values over mutation-heavy procedures.
- Avoid broad `except Exception` unless the handler logs context, preserves failure visibility, and intentionally continues.
- Use dataclasses, TypedDicts, enums, or small value objects when dictly-typed payloads become contracts.
- Do not use mutable default arguments.
- Keep imports acyclic. If a service import creates a cycle, the boundary likely needs adjustment.
- Use dependency injection or local wrappers for provider clients to keep tests deterministic.

## Django Test Quality

- Tests should assert HTTP status, response shape, persisted state, side effects, and relevant authorization/eligibility behavior.
- Use factories to make domain setup clear. Avoid large fixture blobs unless they represent stable external contracts.
- Use `assertNumQueries` or equivalent checks for endpoints and jobs where query count matters.
- Prefer `TestCase` for normal database tests and `TransactionTestCase` when transaction behavior itself is under test.
- Mock external services at the boundary and assert the important request payload, not internal call trivia.
- Add regression tests for previously broken behavior and migration/data-shape edge cases.

## Django Review Smells

- A view that contains complex orchestration, several queries, and provider calls.
- A serializer that silently mutates multiple models.
- A migration that drops/renames data in one step.
- A loop over model instances that touches related fields without prefetching.
- A task that can be retried but has no idempotency guard.
- A broad manager method that bypasses tenant/user scoping.
- Tests that force-authenticate the happy path but skip unauthenticated, unauthorized, and wrong-owner cases.
