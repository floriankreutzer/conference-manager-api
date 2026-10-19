# Reviewed versions over a confirmed supplier order

This increment adds a Manager-owned proposal over the latest fully confirmed
supplier version. A proposal is an immutable commercial snapshot, not a send,
confirmation or cancellation. It starts at `pending_quote`, without a quote or
decision. The prior effective version remains effective until a complete supplier
receipt confirms its replacement or cancellation. Conference cancellation alone
does not cancel a supplier order.

## API and authority

The existing default-off, non-Demo delivery flag also composes
`GET/POST /api/v1/tenant/catering/orders/{orderId}/versions`.
The trusted session supplies Tenant, actor and security epoch. Only a current
Conference Manager with `request:manage` may use it; writes recheck the actual
session, active user and Tenant under the existing authority locks. Cookie writes
require same-origin CSRF validation. Foreign objects are concealed.

GET has only the optional positive `afterOrderVersion` cursor (default 1). It
returns schema version 1, order/request IDs, current order state, current request
version/status, assignment revision, effective basis including supplier cost,
allowed operations, up to 20 consecutive proposals and a next cursor. Each public
proposal omits internal Tenant, command, actor, session and security-epoch data.

POST accepts exactly `schemaVersion: 1`, UUID `commandId`, positive
`expectedOrderVersion`, `expectedStateRevision`, `expectedRequestVersion`,
`expectedAssignmentRevision`, `operation` and a trimmed 1–1000 character
`justification` without control characters. Operations are:

| Operation | Commercial source | Current conference evidence |
| --- | --- | --- |
| `change` | New confirmed conference snapshot and current matching assignment | Confirmed request newer than effective basis |
| `exception` | Effective confirmed commercial source and assignment | Same confirmed request version as basis |
| `cancel` | Effective confirmed commercial source and assignment | Current confirmed or cancelled conference |

All operations require justification because publication/cutoff policy has not
yet been established. No cutoff or supplier acceptance is inferred. The provider
must currently support the operation. An unresolved prior version blocks a new
one. A resolved rejected or provably unsent failed proposal may be replaced;
partial, unknown and in-flight outcomes require reconciliation first.

An exact command/body/actor/epoch replay returns the saved version without another
audit append. A conflicting reuse is rejected. Fresh proposals compare all four
version counters under lock and atomically append snapshot, positions, state,
proposal evidence, head and HMAC audit. Audit excludes justification. There is no
automatic retry or outbound provider call in this operation.

Existing quote/decision endpoints accept `expectedOrderVersion`. Omission means
version 1 only, preserving the initial-version wire contract without allowing an
old request to match a new version's reused state/quote revision counters.
`GET /orders/{orderId}?orderVersion=N` returns an explicitly scoped historical
detail; mutation endpoints always target the current head.

## Persistence and recovery

Canonical migration 051 and Demo privilege overlay 017 add append-only
`catering_version_proposals`. Tenant-qualified foreign keys bind the sealed basis,
new version, request evidence and actor. Independent SQL guards verify the actual
confirmed basis, resolved prior version, current request/configuration, source,
actor epoch and initial proposal state. A complete-looking version without
proposal evidence cannot seal. No pre-existing version greater than 1 is inferred
or backfilled: such a migration requires review.

`catering_order_source_current` distinguishes commercial source from current
conference evidence for cancellation after conference cancellation. Existing
delivery authority keeps current head, quote, exact decision, decider epoch,
configuration, expiry, schedule and lease checks. It does not grant write authority.
Customer receives SELECT/INSERT and the source predicate only; Platform receives
neither; Reset may truncate the new table with the full deterministic fixture.

Rollback is allowed only with no proposals, later versions or retained version
audit actions. Revoke overlay 017 before rolling back/recreating 051, then reapply
both migrations and privileges. Audit-only history also blocks destructive
rollback. Existing manual facts are preserved by an otherwise empty 051 rollback.

## Scope and verification

Native domain, application, HTTP and architectural negative tests cover closed
schemas, minimization, Tenant/role/session scope, concurrency counters and replay.
The dedicated PostgreSQL test exercises actual Customer/Platform/Reset grants,
empty/populated/audit-only rollback, concurrent identical commands, audit failure
atomicity, historical immutability, stale quote/decision versions, complete versus
partial/substitution receipts, 20/21 pagination, conference versus supplier
cancellation, live session/CSRF HTTP and filled deterministic reset. Its conference
revision input is controlled synthetic setup, not evidence of a live calendar or
Employee booking operation. PostgreSQL and browser execution must be recorded
against the exact candidate commit before acceptance.

Still open: withdrawal/replacement before any confirmed supplier order, first
physical dispatch after unsent changes, newly assigned supplier order creation,
acceptance of changed supplier positions, published catalogue/availability and
lead-time/cutoff rules, supplier adapters/credentials and supplier qualification.
This increment alone does not complete SaaS4 or authorize live supplier activity.
