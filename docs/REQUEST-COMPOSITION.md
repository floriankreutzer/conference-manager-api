# Request Composition v2

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`,
`docs/API.md`, `docs/AUTHORIZATION.md`, `docs/PERSISTENCE.md` and
`docs/SECURITY.md` remain authoritative. This document defines the Request
composition boundary introduced by SaaS 2 issue #126 and migration 027.

Request composition v2 is the single current Request model. It connects the
existing Organization, Locations, Catalogue, Booking Policies and Cost
Allocation owners without creating a generic settings service or a second
Request implementation. Equipment selection is deliberately outside this
schema. Request workflow statuses and transition identifiers remain unchanged.

The browser is a drafting client only. It may submit stable Tenant-local
resource IDs, quantities, allocation percentages and the configuration
revisions it observed. It never supplies authoritative Tenant, requester,
workflow state, price, calculated total, policy result, allocation amount,
snapshot time, audit actor/outcome or Request version result.

## Versioned write contracts

### Create

`POST /api/v1/application/requests` requires CSRF and this exact outer body:

```json
{
  "schemaVersion": 2,
  "request": {
    "title": "Quarterly planning",
    "roomId": "room-berlin-1",
    "startsAt": "2026-09-01T10:00:00.000Z",
    "endsAt": "2026-09-01T11:00:00.000Z",
    "internalParticipants": 12,
    "externalParticipants": 2,
    "serviceIds": ["video-support"],
    "catering": {
      "participantCount": 14,
      "packageSelection": {
        "packageId": "lunch",
        "variantId": "vegetarian"
      },
      "itemQuantities": [
        { "itemId": "coffee", "quantity": 14 }
      ]
    },
    "dietaryRequirements": "One gluten-free meal.",
    "specialRequirements": null,
    "allocations": [
      { "costCenterId": "engineering", "percentageBasisPoints": 10000 }
    ],
    "configurationRevisions": {
      "organization": 4,
      "locations": 8,
      "catalogue": 12,
      "bookingPolicies": 3,
      "costAllocation": 6
    }
  }
}
```

The existing production-application response envelope remains version 1. A
successful create returns HTTP 201 with
`{ "schemaVersion": 1, "request": <public Request> }`; the nested Request is
schema version 2 and Request version 1.

Employees obtain selectable facts and all five freshness tokens from
`GET /api/v1/application/catalog`. That endpoint reads the current drafting
catalogue, the non-authoritative effective `bookingPolicy` snapshot, and
`costAllocation` drafting facts (`allocationRequired` plus active cost centers)
under one repeatable-read snapshot. Its outer application envelope is schema
version 1; this does not change the nested Request schema version.

### Resubmit after a change request

`POST /api/v1/application/requests/{requestId}/resubmissions` requires the
owning Employee, `request:read`, CSRF and this exact body:

```json
{
  "schemaVersion": 2,
  "expectedVersion": 3,
  "request": { "...": "the complete canonical v2 Request draft" }
}
```

Partial patches are not accepted. The Request must still be owned by the
authenticated Employee, have status `Change Requested`, and have the submitted
`expectedVersion`. A successful resubmission reevaluates the complete draft
against current server authority, changes the status to `Submitted`, advances
the Request version once, stores a new immutable snapshot and history record,
and appends the success audit event in the same transaction. A valid legacy v1
Request is upgraded to schema v2 by this path. Stale state or version returns
HTTP 409 `REQUEST_STATE_CONFLICT` without a partial write.

### Confirmed-booking proposal

`POST /api/v1/requests/{requestId}/booking-change` requires CSRF and accepts a
complete composition proposal, not a schedule-only patch:

```json
{
  "schemaVersion": 2,
  "expectedVersion": 5,
  "request": { "...": "the complete canonical v2 Request draft" }
}
```

The existing confirmed-booking ownership and Conference Manager authorization
rules remain in force. Proposal creation locks and revalidates the confirmed
Request and expected Request version, evaluates the complete draft against the
current five configuration revisions, and persists an immutable next-version
authority snapshot transactionally. For a change, the change-window rule is
evaluated against the locked current confirmed Request start; lead time,
advance time and applicability are evaluated against the proposed schedule.

A proposal is participant-count-only only when Room, schedule and every
non-participant composition field remain unchanged; the catering participant
count may track the changed participant count. That narrow change is applied
immediately and atomically when current capacity, policy, Catalogue and
allocation authority permit it. Any Room, schedule, service, package/item,
title, requirement or allocation change, and any configuration-revision-only
refresh, is persisted pending Conference Manager decision and leaves the
original Request/calendar event unchanged. A later approved apply advances the
Request version, stores the persisted v2 snapshot as the new authoritative
Request representation, appends a `booking_changed` Request-history record and
commits the existing booking-change audit/notification effects atomically.
Provider-side calendar work retains the existing idempotency, revalidation and
compensation contract; it is not represented as distributed-transactional with
PostgreSQL.

Approval is resumable from the persisted `applying` state. An applying attempt
retains its stable room-move idempotency identity across an unknown provider
outcome; a new identity is used only after target cleanup is known to have
succeeded. A retry after an unknown database finish result rereads the Request
and proposal and returns an already-applied result without compensating it.
Cancellation of a confirmed Request conflicts while approval is applying. A
pending proposal is instead changed atomically to terminal `superseded` when
the confirmed Request is cancelled, with server-authored audit evidence.

Unknown schema versions, unknown fields and partial v2 Request bodies fail
closed. No route silently interprets them as legacy v1.

Booking-change GET, propose and decision responses use
`{ "schemaVersion": 2, "result": { "change": ..., "requestRef": ... } }` for
successful reads and mutations. `requestRef` contains only `id`,
`schemaVersion`, `version` and `status`; clients reload Request detail when
needed. A current proposal exposes
`requestSchemaVersion: 2`, its base Request version and the complete normalized
proposed `request` draft. Its read-only `proposedRequest` is the sole complete
public Request-shaped next-version projection and is built from the persisted
authority snapshot; neither `proposedRequest` nor that snapshot is a browser
write field. A legacy proposal remains explicit as
`requestSchemaVersion: 1` with composed `request: null`; the server does not
infer a historical v2 composition from legacy schedule columns and returns
`proposedRequest: null`.

## Draft validation

The `request` object is a closed positive schema with exactly the fields shown
in the create example. The following bounds apply before persistence:

| Field | Rule |
| --- | --- |
| `title` | Trimmed NFC text, 1-160 characters; markup/control and bidirectional-control characters are rejected. |
| `roomId` and selected IDs | Tenant-local identifier, 1-128 allowlisted identifier characters. |
| `startsAt`, `endsAt` | Canonical millisecond UTC instants equal to `Date.prototype.toISOString()`; positive interval no longer than 24 hours. |
| Participants | Each count is an integer from 0 through 500; combined total is 1 through 500. |
| `serviceIds` | At most 200 unique IDs. |
| Catering participant count | Integer from 0 through 500 and no greater than total Request participants; a selected package requires at least one catering participant. |
| Package selection | Exactly `packageId` and `variantId`, or `null`. |
| Direct catering items | At most 100 unique item IDs; each integer quantity is 1 through 1,000. |
| Requirements | `null` or trimmed NFC text up to 2,000 characters with unsafe control/markup characters rejected. |
| Allocations | At most 100 unique cost-center IDs; each percentage is 1-10,000 integer basis points. The Cost Allocation owner enforces required/optional and exact 10,000-basis-point totals. |
| Configuration revisions | Exactly five positive safe integers: `organization`, `locations`, `catalogue`, `bookingPolicies`, and `costAllocation`. |

Selection collections are normalized into deterministic stable-ID order. The
participant platform limit for v2 is 500 even if an older settings snapshot or
legacy Request admitted a larger value. Booking Policy may impose a lower
Tenant-configured limit but never a higher platform limit.

## Authoritative evaluation and pricing

Create, resubmit and confirmed-change proposal evaluate one coherent current
configuration view inside the owning PostgreSQL transaction. The repository:

1. derives Tenant and requester from the authenticated Principal;
2. locks and revalidates the active Tenant and User;
3. compares all five observed configuration revisions with current values;
4. resolves the active same-Tenant Room and Site, authoritative Site time zone,
   capacity and Room price;
5. resolves only active, same-Tenant and applicable Catalogue selections;
6. selects and evaluates the current Booking Policy for the operation;
7. validates active same-Tenant cost centers and calculates the allocation
   snapshot from the server total;
8. constructs and persists the immutable Request snapshot and required audit
   evidence before commit.

Cross-Tenant, inactive, missing, inapplicable or internally inconsistent
references fail as unavailable. For create/resubmit, a revision changed since
the browser loaded its draft returns `409 REQUEST_STATE_CONFLICT`; a confirmed
proposal uses `409 BOOKING_CHANGE_CONFLICT`. Unavailable current composition
authority returns `409 REQUEST_CONFIGURATION_UNAVAILABLE`. Validation errors
return `400 VALIDATION_FAILED`. None of these paths accepts a browser-computed
fallback.

All money uses non-negative safe integer minor units. The total is calculated
once by the backend as:

- Room price once per Request;
- each selected service price once per Request;
- selected package **variant** price multiplied by catering participant count;
- each direct catering-item unit price multiplied by its quantity;
- zero for a direct item line already included in the selected package.

The package's own catalogue price is descriptive and is not a separate base
fee or part of currency resolution. An included item is snapshotted but is not
charged again. Every charge-line price, including a zero-priced Room, service,
variant or explicitly selected direct-item line, must use one currency;
mixed-currency composition is rejected. When the authoritative total is zero,
the Request currency is the current Organization default currency.

Cost allocation uses the deterministic largest-remainder calculation defined
in `docs/TENANT-COST-ALLOCATION.md`; allocated plus unallocated minor units must
equal the authoritative Request total exactly.

## Immutable snapshot and public projection

Every v2 Request row stores a bounded snapshot containing:

- `schemaVersion: 2`, positive `requestVersion` and server `capturedAt`;
- the five exact configuration revisions;
- normalized title, requirements, service IDs and catering selections;
- Room, service, package-variant, included-item and direct-item identity/name/
  description/price facts plus line totals and the integer-minor breakdown;
- the selected effective Booking Policy snapshot;
- the calculated Cost Allocation snapshot.

Later Tenant settings changes do not reinterpret an existing snapshot. Workflow
mutations advance the Request version and history while retaining the
composition facts selected for that version. Resubmission and an applied
confirmed change create a newly evaluated composition snapshot.

The public Request omits internal Tenant ID and requester User ID. Its common
fields are `schemaVersion`, `version`, `id`, `roomId`, `status`, nullable
`statusReason`, canonical schedule, participant counts, `statusChangedAt`,
`createdAt` and `updatedAt`. A v2 record additionally returns `details`,
`pricing`, `configurationRevisions`, `policy` and `allocations` from its
persisted snapshot. Public values are historical facts, not authority that may
be echoed to bypass current validation.

## History and legacy compatibility

Conference Manager reporting reads the same immutable public Request projection through
`GET /api/v1/application/reports/requests`. Its bounded keyset pages select `startsAt` in an explicit
canonical UTC `[from, to)` interval and declare whether the range page sequence is complete. It is a
read contract over canonical Requests, not a second report aggregate or a browser-recomputed price
model. A client must follow the returned opaque cursor until `complete: true`; the legacy unpaged
application list is not completeness evidence for a range report.

`GET /api/v1/requests/{requestId}/history` applies the same active-Tenant,
permission and object-ownership decision as the single-Request read. Missing,
cross-Tenant and same-Tenant non-owned Employee Requests are concealed as
`404 NOT_FOUND`. The bounded newest-first response is:

```json
{
  "schemaVersion": 2,
  "requestId": "server-correlation-id",
  "history": [
    {
      "version": 3,
      "schemaVersion": 2,
      "operation": "resubmitted",
      "capturedAt": "2026-09-01T09:30:00.000Z",
      "request": { "...": "complete public Request at this version" }
    }
  ]
}
```

The response `requestId` follows the API's existing convention and is the
server correlation ID; the domain Request ID remains the path identifier and
inside every historical public Request record. History operations are
`migrated_legacy`, `created`, `resubmitted`, `transitioned` and
`booking_changed`. History rows are append-only and bounded to 100 records per
read.

Migration 027 classifies every pre-existing Request as schema v1, version 1 and
creates its `migrated_legacy` history record. Legacy public records explicitly
return these composition-only fields as `null`:

- `details`;
- `pricing`;
- `configurationRevisions`;
- `policy`;
- `allocations`.

The API never fabricates missing legacy prices, catalogue selections, policy or
allocation facts. Existing valid workflow reads and transitions remain
available. A valid owner resubmission from `Change Requested` is the deliberate
upgrade path to v2; any unknown or malformed stored schema fails closed.

## Persistence, deployment and rollback

Migration 027:

- adds Tenant/Room-owned `tenant_room_prices` and seeds each existing Room with
  zero in the Tenant's Organization default currency;
- appends a Catalogue snapshot containing `roomPrices` and advances each
  Tenant's Catalogue revision once, making an already-open client revision
  intentionally stale;
- adds `schema_version`, `request_version` and bounded `request_snapshot` to
  `requests`;
- creates append-only `request_revisions` with Tenant-composite ownership;
- backfills one explicit legacy history record per existing Request;
- installs deferred current-revision integrity checks that reject mutations of
  revision-managed Requests when the current row diverges from its immutable revision record;
- adds v2 schema/base-version/composition storage to
  `booking_change_requests`.

Deployment must run `npm run db:migrate` before application rollout and verify
exact schema readiness at version 34. The application does not auto-migrate.
Operators should expect all pre-migration Catalogue editors to reload because
the migration advances that aggregate revision. Conference Managers with
`tenant:catalogue:manage` should configure intentional Room prices after rollout;
Tenant Admin alone is denied. The zero seed preserves deterministic compatibility
and does not assert a customer price decision.

Migration 027 down takes exclusive locks and fails closed after any v2 Request,
non-migration Request history, changed Room price, later Catalogue mutation or
v2 booking-change proposal exists. Once the feature is used, prefer a reviewed
forward fix or restore/PITR decision; do not bypass the rollback guard or delete
history to force a downgrade.

## Required validation evidence

Changes to this boundary require, as applicable:

- closed-schema, canonical-time, participant-500 and collection-boundary tests;
- exact price arithmetic tests, including package inclusion, no base fee,
  mixed currency, all-zero default currency and total overflow;
- Booking Policy and Cost Allocation positive/negative snapshot tests;
- same-Tenant success plus cross-Tenant, inactive, inapplicable and stale
  revision/version denial tests;
- owner/manager/Tenant Admin separation and history BOLA/IDOR tests;
- same-manager propose/approve persistence evidence with equal initiator/decider IDs and separately attributed audit operations;
- direct Employee non-owner, Tenant Admin other-user and Conference Manager cross-Tenant booking-change denial/audit tests;
- create, resubmit, workflow and confirmed-change version/history tests;
- audit-failure rollback and concurrent configuration/request mutation tests;
- migration 027 up/down/reapply, legacy backfill, constraints, readiness and
  fail-closed populated rollback tests;
- the full repository quality, dependency, static, secret, DAST and PostgreSQL
  integration gates.
