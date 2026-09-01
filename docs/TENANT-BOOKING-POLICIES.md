# Tenant Booking Policies

## Authority and scope

Root AGENTS.md, docs/CODING-STANDARDS.md, docs/ARCHITECTURE.md,
docs/AUTHORIZATION.md, docs/AUDIT.md, docs/PERSISTENCE.md, docs/SECURITY.md and
docs/TENANT-SETTINGS-CONTRACTS.md remain authoritative.

This bounded domain owns the Tenant booking-policy configuration required by
SaaS 2 issue #84. It does not replace Request authorization, workflow,
availability, pricing, Tenant isolation or audit rules.

## Rule classification

The following controls are immutable platform invariants and are never Tenant
configuration:

- authenticated Principal and server-derived Tenant/actor;
- deny-by-default role, permission and Request ownership checks;
- final server-side room/provider availability;
- valid UTC schedule ordering and technical request bounds;
- server-authoritative price and provider identities;
- optimistic revision checks and atomic audit evidence;
- historical Request integrity and Production no-fallback behavior.

The allowlisted Tenant-configurable rules are:

- minimum lead time in elapsed minutes;
- maximum advance window in elapsed minutes;
- cancellation window in elapsed minutes;
- change window in elapsed minutes;
- a Tenant-configured maximum participant rule; Request composition v2 separately enforces the
  immutable platform maximum of 500, so configuration can restrict but never raise that bound;
- optional allowlists of active Sites, rooms and services.

No expression, script, arbitrary workflow, client-defined transition or custom
code is accepted.

## Public aggregate

The bounded routes are:

- GET and PUT /api/v1/tenant/settings/booking-policies
- GET /api/v1/tenant/settings/booking-policies/history
- GET /api/v1/tenant/settings/booking-policies/history/{revision}

The settings envelope uses schemaVersion 1, a positive aggregate revision and
expectedRevision on PUT. The mutable configuration contains one to 128
effective policy versions. Each version has:

- a stable bounded ID;
- a canonical millisecond UTC effectiveFrom instant;
- the exact allowlisted rules above.

Unknown fields, unsupported schema versions, malformed revisions, duplicate
IDs/effective instants, invalid bounds and excessive collections fail closed.
Tenant, actor, audit outcome and resulting revision are never request fields.

GET routes require a known Tenant plus tenant_admin and tenant:configure.
PUT additionally requires the existing session-bound CSRF control.

## Effective-time semantics

Policy evaluation uses the server clock as evaluationInstant. The selected
version is the latest version whose effectiveFrom is not later than that
instant. Request start and evaluation values are canonical UTC instants.

All policy windows are fixed elapsed-minute durations. A daylight-saving
transition therefore neither creates nor removes an enforcement hour. Site
time zones remain authoritative for local presentation and schedule
conversion before a canonical UTC Request reaches this evaluator; browser
local time is never policy authority.

An already effective version is immutable and cannot be removed. A new version
cannot be inserted retroactively. Future versions may be corrected before they
become effective through a current-revision update. At least one version must
be effective at the mutation instant.

The default version is platform-default-v1, effective from
1970-01-01T00:00:00.000Z. It permits a zero-minute lead/change/cancellation
window, a 366-day maximum advance window, the policy aggregate's compatibility
participant limit and all active Tenant resources. Request v2 still applies its
500-participant platform maximum first. This is an explicit compatibility
default, not a replacement for immutable platform checks.

## Request enforcement and snapshots

The bounded application service exposes evaluateCurrentForRequest for Request
create, resubmit and confirmed-booking change integration. The caller supplies
a server-derived Tenant ID, authoritative Request/resource facts and the
server-validated v2 participant count.

A successful evaluation returns the aggregate revision, selected policy
version, effective instant, evaluation instant and immutable rule snapshot.
Request composition v2 persists that snapshot with the authoritative Request
representation so later configuration changes cannot reinterpret historical
Requests.

Confirmation, workflow transition and cancellation use
evaluateSnapshotForRequest with the immutable snapshot already attached to the
Tenant-scoped Request. The operation window is measured from the current server
instant, but the rules are not reselected from newer Tenant configuration.
Malformed or missing persisted snapshots fail closed. A confirmed or historical
Request is therefore never retroactively reinterpreted after a policy change.

Violation codes are stable and localization-ready:

- BOOKING_POLICY_LEAD_TIME_VIOLATION
- BOOKING_POLICY_ADVANCE_WINDOW_VIOLATION
- BOOKING_POLICY_CANCELLATION_WINDOW_VIOLATION
- BOOKING_POLICY_CHANGE_WINDOW_VIOLATION
- BOOKING_POLICY_PARTICIPANT_LIMIT_VIOLATION
- BOOKING_POLICY_SITE_NOT_ALLOWED
- BOOKING_POLICY_ROOM_NOT_ALLOWED
- BOOKING_POLICY_SERVICE_NOT_ALLOWED

Only the numeric limit needed for presentation is attached where applicable.
Tenant IDs, actor IDs and provider details are not violation parameters.

## Persistence, history and rollback

Migration 024 creates a domain-specific current configuration and immutable
revision history. It provisions the explicit default for existing and future
Tenants without fabricating customer-specific restrictions.

An update locks booking_policies_revision for the authenticated internal
Tenant, validates the expected revision and active same-Tenant references,
persists the new configuration, advances only that revision, records both
history snapshots and appends tenant.configuration.changed in one PostgreSQL
transaction. A stale writer changes nothing. Audit failure rolls back the
configuration and revision.

There is deliberately no destructive configuration-history rollback endpoint.
Customer rollback is represented by a newly scheduled effective version, so
an already applied policy and historical interpretation are never deleted.
Migration 024 down fails closed after any history, revision advance or
non-default configuration exists; a forward fix or reviewed data migration is
then required.

The central composition root registers the route module, service and PostgreSQL
repository, so the administration API and Request integration are reachable
under schema version 34. Policy administration remains a separate bounded
owner; Request composition consumes only its public evaluation/snapshot
contract.
