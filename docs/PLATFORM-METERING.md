# Platform Metering and Operational Quotas

## Authority and scope

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` are authoritative. This document defines the
application and PostgreSQL contracts introduced for SaaS 3 issue #98. The isolated Platform HTTP
route module and control-plane UI remain separate integration surfaces; neither may weaken the
server-side permission, target-scope, source-authority, audit or transaction contracts here.

Metering is a dedicated Tenant-scoped operational read model. It is not:

- the low-cardinality process telemetry described by `docs/OBSERVABILITY.md`;
- authentication or authorization authority;
- a Tenant entitlement grant;
- billing, invoicing, payment or subscription-provider state;
- User-level productivity surveillance.

## Approved dimensions

The application contract has one closed dimension vocabulary:

| Dimension | Kind | Authoritative meaning |
| --- | --- | --- |
| `active_users` | gauge | active internal Users at the reconciliation watermark |
| `active_rooms` | gauge | active Tenant-owned Rooms at the reconciliation watermark |
| `requests_created` | counter | authoritative Requests created in the UTC period |
| `bookings_confirmed` | counter | authoritative booking confirmations in the UTC period |
| `integration_operations` | counter | completed allowlisted server integration operations in the UTC period |

Adding a dimension requires a reviewed semantic definition, authoritative source, privacy review,
retention decision, reconciliation rule and quota behavior. Storage volume is deliberately not an
approved dimension until a concrete product and authoritative-source requirement exists.

## Event recording and replay safety

`recordUsageEvent` is an internal application port and must not be exposed as an HTTP endpoint.
Composition creates `createPlatformUsageEventSourceAuthority`, injects its policy into the metering
service, and injects only the bound recorder into successful domain use cases. The recorder fixes the
event type through `recordRequestCreated`, `recordBookingConfirmed` or
`recordIntegrationOperationCompleted`; no serializable browser value can reproduce its closure-held
source context. A successful domain use case supplies the internal Tenant ID, an authoritative
source-event UUID and authoritative UTC occurrence time. The caller cannot submit units: every
accepted event contributes exactly one unit to its fixed dimension.

Accepted events are:

| Event | Dimension |
| --- | --- |
| `request.created` | `requests_created` |
| `booking.confirmed` | `bookings_confirmed` |
| `integration.operation.completed` | `integration_operations` |

The service derives a SHA-256 source key from Tenant and source-event UUID and a separate SHA-256
payload digest from event type, fixed dimension, occurrence time and the fixed unit. It does not send
the raw source UUID to persistence. PostgreSQL enforces global uniqueness for
`(tenant_id, source_event_key)` and updates the aggregate atomically. An exact retry returns
`duplicate`; reuse of the same authoritative source identity with different type, time or dimension
returns an explicit replay conflict. The uniqueness is not period-scoped, so moving a replay to
another month cannot double-count it. The same source UUID remains independent in another Tenant.

PostgreSQL serializes each Tenant-period projection with a transaction-scoped advisory lock. Distinct
events remain additive even when their server ingestion timestamps are equal; concurrent exact
replays increment once.

## Period and completeness semantics

Aggregation periods are UTC calendar months. A period is represented by an inclusive start and
exclusive end, for example `2026-08-01T00:00:00.000Z` through
`2026-09-01T00:00:00.000Z`. Local Tenant time zones do not change the operational ledger boundary.

Every period has one explicit data state:

- `complete`: every approved dimension has a non-negative integer value at the stated watermark;
- `partial`: at least part of the source data is available, but it is not safe to treat the period
  as complete;
- `unknown`: no dimension value is trusted and all values are `null`.

Persistence is responsible for deriving completeness from its authoritative event and
reconciliation watermarks. A missing or late source must become `partial` or `unknown`; it must not
be represented as zero. Quota evaluation returns an unknown restriction for a configured quota
unless the relevant usage record is complete.

The watermark contract distinguishes three times:

- `occurredAt` is the authoritative domain occurrence supplied through the trusted producer;
- `recordedAt` is the server application clock at the recording call;
- `ingested_at` is a millisecond-normalized PostgreSQL clock value assigned at the durable insert.

`eventWatermark` is an inclusive database-ingestion watermark. The PostgreSQL usage-source adapter
takes the same Tenant-period lock as event recording, reads ledger counters and current gauges in a
server transaction, and returns its database-owned observation as both `measuredAt` and
`eventWatermark`. Reconciliation folds only events with `ingested_at > eventWatermark` and
`ingested_at <= reconciledAt`. This closes the snapshot/commit race without trusting an application
timestamp. A watermark or measurement older than the current projection returns
`PLATFORM_METERING_RECONCILIATION_WATERMARK_CONFLICT`; it never silently overwrites newer facts.

`createPostgresPlatformUsageSource` requires an explicit `counterProducersReady` decision. Until all
three bound producer calls are wired after authoritative successful mutations and their replay path
is operational, composition must pass `false`, making the record `partial`. Active User and Room
gauges are complete only for the current UTC period because the current schema has no historical
gauge ledger. Historical reconciliation therefore retains known counters but reports `partial`
rather than inventing historical gauge values.

## Platform read and Tenant target boundary

`getUsagePeriod` requires the dedicated `platform:metering:read` permission. The service then calls
a separate Tenant-target policy before repository access. The Tenant ID is an internal ID and is
never accepted as authority merely because a browser supplied it.

The PostgreSQL read and its server-derived `platform.metering.read` evidence commit in one
transaction. Target denial occurs before persistence access and is exposed to the HTTP boundary as
`PlatformOperationDeniedError`, not an internal 500. Read evidence contains only the period and
aggregate data category, never source identities or Tenant content.

The repository result must match the authorized Tenant and exact requested period. Its DTO is
closed and rejects unexpected content. The Platform projection contains only:

- internal Tenant ID;
- UTC period and completeness state;
- aggregate dimension values;
- reconciliation and measurement timestamps;
- fixed operational quota metadata.

It cannot contain User IDs, Request IDs, titles, subjects, attendees, free-text requirements,
provider payloads or source-event identities. Tenant-facing access is not part of this contract. If
added later, it requires a separate same-Tenant policy and a separately reviewed minimized DTO.

## Reconciliation and backfill

Reconciliation reads values through the injected authoritative usage-source port; an operator
cannot submit replacement counters. `reconcileUsagePeriod` and the inclusive, maximum-24-month
`backfillUsagePeriods` operation require `platform:recovery:execute`, including its Platform
step-up requirement, plus separate Tenant-target authorization.

All requested source snapshots are validated before `reconcilePeriods` is called. The repository
receives the validated period batch and one server-derived reconciliation time, locks periods in
sorted order, rejects any stale watermark before writing, and applies the batch plus one
`platform.recovery.executed` audit event atomically. Partial success is never reported.

Reconciliation is idempotent for the same authoritative source watermark. `event_watermark` and
`reconciled_at` cannot be cleared or decreased. Every changed period first copies its complete prior
revision into the append-only `platform_metering_period_revisions` table. Events, period revisions,
quota receipts and current rollups are retained for at least 24 months; protected triggers reject
early deletion or mutation. A source correction may replace a value or make a current projection
partial only because the prior revision remains reproducible. Rollback migration 033 refuses to
drop any retained P1 data and requires reviewed cleanup after retention.

## Operational quota semantics

Quota policies are per Tenant and fixed dimension. The policy state is explicit:

- `configured`: at least one non-negative `softLimit` or `hardLimit` exists, with soft not greater
  than hard;
- `not_configured`: both limits are deliberately absent;
- `unknown`: policy metadata could not be established.

Limits are inclusive maxima. A projected value greater than the soft limit produces
`soft_exceeded` without restricting the operation. A projected value greater than the hard limit
produces `hard_exceeded` and `restrictsAdditionalUsage: true`. Missing policy or usage produces an
`unknown` restriction with `restrictsAdditionalUsage: null`; the caller must apply the documented
operation-specific fail-safe behavior.

The quota service returns only restriction metadata. It intentionally has no `allowed`,
`authorized`, `entitled`, billing or price field. A consuming use case must preserve this order:

```text
authentication -> authorization -> entitlement -> business invariants -> quota restriction
```

A quota can restrict an otherwise valid operation. It can never grant an operation denied by
authorization, entitlement or another domain invariant. Quota-policy changes require
`platform:quota:manage`, fresh Platform step-up, separate target scope, exact Tenant/dimension
confirmation, a bounded reason, compare-and-set revision and a UUID idempotency key. PostgreSQL
rechecks the current operator security version and target scope while holding the quota lock. It
then appends `platform.tenant.quota.changed`, changes the quota and writes the immutable
request-digest receipt in one transaction. Audit failure rolls all three effects back; an exact
retry returns the prior safe result and key reuse with changed intent conflicts. A consuming
business transaction remains responsible for its server-derived quota-enforcement evidence because
quota evaluation itself is not a Platform-operator mutation.

## Application ports

`createPlatformMeteringService` requires:

- `repository.recordEvent`: atomic Tenant-scoped deduplication and aggregation;
- `repository.readPeriod`: the closed authoritative period/quota read model;
- `repository.reconcilePeriods`: atomic reconciliation/backfill persistence;
- `repository.setOperationalQuota`: target-revalidated quota CAS, audit and durable receipt;
- `usageSource.readPeriod`: server-derived source-of-truth aggregation;
- `authorizationPolicy.authorize`: dedicated Platform permission enforcement;
- `tenantTargetPolicy.authorize`: independent Tenant-target scope enforcement;
- `auditService.createEvent`: trusted Platform read, recovery and quota-change evidence;
- `usageEventSourcePolicy.authorize`: closure-bound internal producer authority;
- a server clock.

No port accepts raw browser counters, arbitrary dimensions, arbitrary event units or audit
authority. `createPostgresPlatformMeteringRepository` requires the separate Platform audit
repository. `createPostgresPlatformUsageSource` requires the explicit producer-readiness flag.

## Verification and remaining integration

`tests/platform-metering.test.js` covers fixed producer bindings, source-key/payload-digest conflict,
replay, opaque Tenant-specific keys, period boundaries, malformed and browser-shaped input,
403-compatible permission/target denial, cross-Tenant mismatch, minimized projections,
soft/hard/unknown quotas and bounded reconciliation/backfill. The migration-backed database suite
covers concurrent replay and distinct equal-time events, authoritative source readiness, cross-Tenant
aggregation, stale watermarks, append-only corrections, 24-month retention, quota CAS/idempotency,
atomic audit/receipt rollback and guarded migration rollback.

Remaining integration outside this module:

- wire the three bound recorder methods after authoritative successful server-side domain mutations,
  then and only then change `counterProducersReady` from `false` to `true`;
- Platform HTTP/UI integration through the isolated Platform session and API boundary;
- Demo fixtures and operational evidence.
