# Platform projection outbox

## Source contract and release boundary

Canonical migration 044 and Demo overlay 009 add durable, coalescing invalidation demand for the
existing Tenant readiness and Microsoft fleet projections. This candidate does not prove a hosted
migration, deployment, provider restore or measured monthly saving. The three-customer seed version
and semantic checksum remain unchanged. Deploy only after PostgreSQL integration, the shared
role/Tenant/CSRF journey and both complete reset cycles pass in Chromium and WebKit.

## Atomic invalidation and authority

Seven source tables produce demand: Tenants, Tenant identity bindings, onboarding invitations,
Integrations, entitlements, Microsoft room mappings and capability health. Source-row triggers
write the outbox and invalidate existing snapshots in the same transaction. Rolled-back changes
produce neither durable demand nor a committed notification. Unchanged row updates do no work.
Each Tenant has at most one outbox row, carrying a monotonic source version within that queued
lifetime, first dirty time, next eligibility, bounded attempt count and fixed failure classification.
This mailbox is not an event history or security audit; multiple changes intentionally coalesce.

The protected trigger has a fixed `pg_catalog` search path and schema-qualified application objects.
PUBLIC cannot execute it directly. Customer has no outbox table privileges. Platform may dispatch;
reset may truncate the mailbox only inside the supported verified reset. There is no public queue
mutation route. Internal Tenant ownership comes from the committed source row, never notification
payload or browser input. Projections remain diagnostic reads, not authorization authority.

## Dispatch, ordering and recovery

The existing projection repository and policy rebuild current authoritative state. Default batches
contain at most 25 Tenants, with a supported maximum of 100. Dispatch stops starting another Tenant
after its 25-second elapsed work budget; an already-started Tenant retains normal statement/query
timeouts. This is not a claim that the entire transaction has a strict 25-second wall-clock deadline.
Candidate Tenant locks use `SKIP LOCKED`, followed by mailbox custody and snapshot writes. Version-
conditional acknowledgement commits with the complete rebuild. Multiple consumers cannot own the
same Tenant; a source change waiting on custody remains a new durable invalidation after commit.
Repeated empty dispatch does not advance snapshot revisions. Source deletion cascades its mailbox.

A failed Tenant rebuild rolls back its partial projection writes to a savepoint. The same transaction
retains demand with `projection_failed`, never raw SQL/driver/source details. Attempts one through
four become eligible after 30, 60, 120 and 240 seconds. Attempt five records terminal `poison` with a
480-second diagnostic next-eligibility timestamp; automatic dispatch excludes poison. Other Tenants
can still succeed. Transaction/connection/commit failure leaves demand unacknowledged for recovery.
A genuinely changed, committed source row resets that Tenant's attempts and poison state.

Investigate poison using protected operator access and the authoritative source, migration and
dependency evidence. Correct the underlying failure, then commit a legitimate source correction or
restart the compatible worker after a reviewed operator recovery. Do not invent a business change,
edit projection rows, delete poison evidence or disable a trigger to report recovery. A pure
infrastructure repair without a source correction requires a separately reviewed, bounded operator
requeue; this release exposes no browser or automatic destructive repair path.

## Wakeups and resource constraints

`LISTEN cm_platform_projection` uses one existing-pool connection with a fixed empty notification.
The notification only schedules a debounced one-second dispatch; the mailbox remains authoritative.
Startup and reconnect inspect durable work after LISTEN, covering commits in the subscription gap.
Full batches schedule another bounded dispatch. Worker operations serialize, burst wakeups coalesce,
and shutdown waits for an in-flight subscription, asynchronous release and active dispatch. Disconnect
discards the listener and re-establishes it on the existing polling/explicit-run cadence; there is
no reconnect loop, heartbeat query or keep-alive traffic. A single-connection pool uses durable
polling instead of reserving its only connection. Pool capacity is not increased by this change.

Session-scoped LISTEN requires the existing direct/unpooled PostgreSQL endpoint; do not replace it
with transaction pooling. The deployed Demo fallback remains ten minutes. Production retains its
independent default cadence. Existing startup/reset refresh and slow reconciliation reuse the same
projection owner. Reconciliation is at most one bounded batch per 15 minutes of worker activity;
there is no full-fleet loop or healthy-result cache. Source invalidation immediately marks existing
snapshots stale even when the worker is stopped. Large fleet reconciliation can take multiple
cadences; no immediate full-fleet freshness guarantee is claimed.

Neon may suspend an idle compute and close the listener. Durable demand and reconnect/fallback
cover missed notifications. No autosuspend, paid capacity or spending setting is changed. See
[PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html),
[Neon connection modes](https://neon.com/docs/connect/connect-from-any-app), and
[Neon compute lifecycle](https://neon.com/docs/introduction/compute-lifecycle).

## Observability and controlled rollback

The shared metrics registry records projection batch/outcome counts with fixed `event` or
`reconciliation` modes and fixed refreshed/retry/poison outcomes. Tenant identifiers, source values,
credentials and arbitrary error strings are not metric labels. Protected operator aggregate checks
may read queue count, oldest dirty time and attempts grouped only by the two fixed states. These
implementation counters do not establish delivered operational alerts or a measured cost baseline.

Database backup/restore must retain the mailbox with its authoritative source tables; restart and
bounded reconciliation recover demand after restore. This contract is not provider restore evidence.
Before an upgrade, quiesce both shared Demo services, apply canonical 001..044 and overlays 001..009
with the protected migration owner, run the canonical reset and start the exact compatible pair.
The reset atomically clears old queued demand and reseeds fresh intents for the three Tenants;
immutable private-object custody remains outside its truncation inventory.

For rollback, quiesce source writers, repair failures and successfully drain the mailbox with the
compatible worker, then stop it. Migration 044 down locks the mailbox and refuses any remaining
pending or poison row. Apply the compatible Demo overlay downgrade and canonical rollback in the
reviewed stopped-service order; neither process may serve with mismatched exact schema versions.
Earlier snapshots can remain stale until the old canonical reconciliation refresh. Prefer a forward
fix when a safe empty-queue downgrade cannot be established.
