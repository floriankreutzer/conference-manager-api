# Tenant Cost Allocation

## Authority and scope

Root AGENTS.md, docs/CODING-STANDARDS.md, docs/ARCHITECTURE.md,
docs/AUTHORIZATION.md, docs/AUDIT.md, docs/PERSISTENCE.md, docs/SECURITY.md and
docs/TENANT-SETTINGS-CONTRACTS.md remain authoritative.

This bounded domain owns Tenant cost-center master data, allocation policy and
authoritative percentage snapshot calculation for SaaS 2 issue #85.

## Approved model

The supported allocation model is percentage-only. Percentages are represented
as integer basis points:

- 10,000 basis points equals exactly 100.00 percent;
- each supplied entry is between 1 and 10,000 basis points;
- duplicate cost-center IDs are rejected;
- every non-empty allocation totals exactly 10,000;
- an empty allocation is accepted only when allocationRequired is false.

Floating-point percentages and browser-calculated totals are not accepted.
Amount-based allocation is not part of this contract and requires a separate
approved product decision.

## Public aggregate

The bounded routes are:

- GET and PUT /api/v1/tenant/settings/cost-allocation
- GET /api/v1/tenant/settings/cost-allocation/history
- GET /api/v1/tenant/settings/cost-allocation/history/{revision}

The settings envelope uses schemaVersion 1, a positive aggregate revision and
expectedRevision on PUT. Configuration contains:

- allocationRequired;
- up to 1,000 cost centers with stable ID, uppercase code, bounded name,
  optional organizational group and active state.

Unknown fields, unsupported schema versions, malformed revisions, duplicate
IDs/codes, invalid text and excessive collections fail closed. Tenant, actor,
audit outcome, authoritative total, currency and resulting revision are never
accepted by the administration route.

GET routes require a known Tenant plus tenant_admin and tenant:configure.
PUT additionally requires the existing session-bound CSRF control.

Cost centers are never physically removed by the API. Deactivation preserves
the stable ID. New Request allocation rejects missing or inactive cost centers,
including syntactically valid IDs owned only by another Tenant.

## Authoritative validation and rounding

The bounded application service exposes snapshotForAuthoritativeRequest for
integration after the backend has calculated the authoritative total and
currency. Browser labels, cost-center metadata, prices and calculated amounts
are ignored.

The server resolves each ID through the Tenant-scoped configuration and
snapshots its code, name and group with the percentage. Minor units are
distributed with the deterministic largest-remainder method:

1. multiply total minor units by each integer basis-point share;
2. take the integer quotient for every entry;
3. distribute remaining minor units by descending remainder;
4. break equal remainders by stable cost-center ID.

Allocated minor units therefore sum exactly to the authoritative total for a
non-empty allocation. Optional empty allocation records the whole amount as
unallocated. The snapshot also contains schema version, configuration revision,
server snapshot time and currency.

Request composition v2 persists this immutable snapshot in every newly
evaluated Request version. Later cost-center rename, regrouping or deactivation
must not reinterpret historical Requests or Manager reporting.

## Persistence, history and rollback

Migration 025 creates:

- Tenant-scoped normalized cost-center master data;
- one explicit allocationRequired row for every existing and future Tenant;
- immutable aggregate revision history.

An update locks cost_allocation_revision for the authenticated internal Tenant,
validates expected revision and archive-only lifecycle, applies the master data,
advances only that revision, records both history snapshots and appends
tenant.configuration.changed in one PostgreSQL transaction. A stale writer
changes nothing. Audit failure rolls back configuration, cost centers and
revision.

There is deliberately no destructive history rollback endpoint. A previous
business state is reapplied as a new current-revision mutation while retaining
all cost-center IDs. Migration 025 down fails closed after any history, cost
center data, required-policy change or revision advance exists; a forward fix
or reviewed data migration is then required.

The central composition root registers the route module, service and PostgreSQL
repository, so the administration API and Request integration are reachable
under current schema version 42. Cost Allocation administration remains a separate
bounded owner; Request composition consumes only its authoritative snapshot
contract after server pricing.
