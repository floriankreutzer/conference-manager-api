# Catering initial orders and quote decisions

## Implemented scope

Canonical migration 048 and Demo privileges overlay 014 retain initial Catering orders, sealed
commercial positions, immutable quote/decision history and optimistic current state. The independent
server flag `CATERING_ORDERS_ENABLED` defaults to false; only exact `true` or `false` is accepted.
Demo activation is rejected. Migration and reset create no orders, quotes, decisions or delivery jobs.

The Conference Manager must hold `request:manage` in an active Tenant with a current opaque session.
Tenant Admin technical configuration does not authorize commercial preparation or approval.
Every mutation locks/rechecks Tenant, active User/security version, session, current Request and
current Integration configuration, and commits its required audit event in the same transaction.

## Same-origin API

All envelopes use `schemaVersion: 1`. Unknown fields and queries are rejected. Unsafe methods require
the existing session-bound CSRF token and same-origin validation. Tenant/actor identity comes only
from trusted session context. UUID references are opaque, not authority.

| Method and path | Input / result |
| --- | --- |
| GET `/api/v1/tenant/catering/orders` | Optional `requestId`, `afterOrderId`; at most 20 ordered references and next cursor |
| POST `/api/v1/tenant/catering/orders` | `requestId`, `commandId`, `expectedRequestVersion`, `expectedAssignmentRevision`; initial references |
| GET `/api/v1/tenant/catering/orders/{orderId}` | Immutable commercial snapshot and current quote/decision/state |
| PUT `/api/v1/tenant/catering/orders/{orderId}/quote` | `expectedStateRevision`, `expectedQuoteRevision`, `cost`, `expiresAt` |
| POST `/api/v1/tenant/catering/orders/{orderId}/decision` | `expectedStateRevision`, `expectedQuoteRevision`, `decision` (`approved` / `rejected`) |

Command bodies are limited to the smaller of the runtime ceiling and 4096 UTF-8 bytes. List responses
are capped at 65536 bytes; detail responses at 524288 bytes, also bounded by the runtime ceiling.
Conflicts require an explicit reload and decision; neither server nor client silently reapplies writes.

## Historical and concurrency authority

Preparation requires the exact current Confirmed Request version and current sealed ownership
revision whose canonical Catalogue revision matches that Request snapshot. It explicitly uses the
Manager-selected current ownership; it does not infer historical ownership from timestamps.
One immutable order is prepared per participating Integration, with no partial preparation if any
connection is unavailable. The per-Tenant Request/Integration uniqueness constraint prevents duplicates.
Replaying the same command and source revisions returns existing references without another write;
a different command conflicts. There is no automatic Request-confirmation hook or historical backfill.

The commercial source is reconstructed from exact immutable Request, Catalogue and assignment
revisions. A package is one charged position, retaining descriptive membership; included items are
not charged again. At most 100 direct items plus one package are accepted. Unit-price limits remain
unchanged; aggregate minor-unit amounts must remain safe integers below `Number.MAX_SAFE_INTEGER`.
Conference selling prices are separate from supplier cost, which is initially unknown (`null`).

Deferred constraints verify exact position membership/count/total, source revisions and complete
version/state/head custody before sealing. Sealed history cannot be appended to or rewritten. Quotes
and decisions form independent immutable revision sequences. Every decision references the exact
quote revision, amount and currency; a new quote clears the current decision. State changes require
the expected revision. Approving requires an unexpired quote, unchanged Confirmed Request, current
connection capability and future conference start. Deferred checks repeat approval expiry/security
version validation at commit. Unknown supplier cost always requires explicit Manager acceptance,
including when technical initial-order mode is automatic.

The initial states exposed here are `pending_quote`, `pending_manager_review`, `released` and
`rejected`. Release records approval only. It sends no supplier order and creates no durable job.
Later delivery states cannot be overwritten through these quote/decision commands. Change, cancel,
exception versions, transport receipts, background processing and provider quotes remain separate work.

## Privileges, recovery and evidence

Customer roles can insert immutable business history and update guarded heads/state; they cannot
update/delete history or insert seals. Two narrow fixed-search-path security-definer triggers own
position sealing/completeness checks; direct execution is revoked. Platform receives no order access.
Reset receives SELECT/TRUNCATE for the eight order tables and preserves the canonical three-customer
semantic checksum. Migration down locks all eight tables and the audit table and refuses any order history or retained
order audit actions before restoring the previous exact action allowlist; use a
reviewed forward fix or restore decision for populated environments.

No credentials, supplier URLs, requester identity, raw provider payloads or session tokens are exposed
in order DTOs/audit metadata. No dependencies or outbound network capabilities are introduced.
Native tests cover closed schemas, scope, policy, aggregate limits, HTTP/session/CSRF and adapter
boundaries. PostgreSQL tests cover actual privileges, concurrency/replay, audit rollback, exact old
source reconstruction, quote replacement, revocation, reset and guarded rollback. Test presence alone
is not evidence of execution; accepted CI must be bound to the exact candidate head before merging.
