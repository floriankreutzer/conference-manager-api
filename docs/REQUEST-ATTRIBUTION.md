# Persisted Request attribution (API-03)

The authoritative contract is frontend milestone issue #187 and API issue #71.
Attribution is display evidence owned by the Request boundary. It is never a
browser-selected identity or an authorization source.

## Exact response representation

Application Request list/create/resubmit/report, Request detail/transition/history,
and booking-change read/propose/decision responses use outer `schemaVersion: 3`.
Nested Request `schemaVersion` still describes composition v1/v2/v3 independently.
The new fields are:

- Request `requesterAttribution: { displayName }`;
- history `actorAttribution: { displayName, roleAtAction } | null`;
- change `initiatorAttribution: { displayName, roleAtAction }`;
- change `deciderAttribution: { displayName, roleAtAction } | null`.

Names are persisted as trimmed NFC Unicode strings of 1–160 code points. Cc/Cf/Cs
format, control and surrogate code points, line/paragraph separators, bidirectional
overrides/isolates and zero-width controls are rejected rather than removed or
rendered. Roles are exactly `employee`, `conference_manager` or `null`; null
means the historical role is unknown. History with no historical actor exposes
a null object. Names are never replaced with the viewing Principal or a browser
fixture. Exact write schemas continue rejecting every attribution field and other identity authority.
No Tenant/User keys, email field, provider subject, permission assignments, active
status or session data are exposed by these objects.

Pending, immediately applied participant-only and returned-to-pending proposals
have no decider. A separately approved or self-approved proposal has independent
initiator and decider snapshots. The GET returns an open proposal first, otherwise
the latest applied/rejected proposal corresponding to the currently confirmed
Request version or the proposal superseded by the current cancellation. This
supports a persisted decision display after refresh without returning an obsolete
proposal against a later unrelated Request version. A terminal result is not an
open proposal and does not prevent another proposal while the Request remains
eligible and confirmed.

## Mutation and persistence

Migration 036 follows Equipment migration 035. It adds constrained relational
name/role columns on `requests`, `request_revisions` and `booking_change_requests`.
Tenant-composite User lookup runs in the same transaction as each mutation.
The requester is captured once. Every revision captures its own actor; proposals
and decisions capture their actors separately. The common authorization-policy
helper records the actual Manager-first branch for cancellation and proposals;
creation/resubmission use the Employee path and approvals use the Manager path.
No current directory role lookup reconstructs historical authorization.

The migration may capture a legacy actor's currently stored name through its
Tenant-composite key, while leaving the historical role null. It does not claim
the name was unchanged since the original action. Missing legacy actors remain
null. Rename and deactivation affect future captures, never prior snapshots.
Database triggers preserve requester/initiator immutability, append-only history
and decider identifier/name/role coherence. They canonicalize legitimate source
names to NFC and fail closed when a current or legacy source contains forbidden
Unicode format controls; they never silently strip a spoofing control. New writers
must supply action roles; old writers cannot commit incomplete post-cutover action evidence.

Migration 038 removes default `PUBLIC EXECUTE` from the privileged migration-state
marker and all three attribution trigger functions. The trigger functions execute
as their migration owner with a fixed `pg_catalog` search path and schema-qualified
application references. Restricted runtime writes still fire the bounded triggers,
but runtime, reset and otherwise unprivileged roles cannot invoke any of those four
functions directly. The down migration restores the exact schema-37 function
security, search-path and grant state before removing only migration 038 bookkeeping.

The old immutable revision JSON and HMAC audit-chain canonical payloads remain
unchanged. Display-name PII is not added to audit events, logs, metrics or cursor
payloads. Read adapters combine immutable requester columns with historical JSON
only after the existing same-Tenant/object authorization path. No directory API
or new permission is introduced.

## Deployment and recovery

1. Deploy the coordinated frontend compatibility stage accepting exact response
   v2 and v3 and independently accepting the supported Request compositions.
2. Drain old API writers. Apply canonical migrations through 038 explicitly and
   verify exact integrated readiness 38.
3. Deploy API v3 projection writers/readers, then the restored frontend surfaces.

List/history/report cursor purposes are separately advanced for the v3 projection;
pre-cutover cursors fail with `400` and clients restart their bounded page sequence.
The API does not silently add attribution to a schema-v2 envelope.

Migration 036 down is permitted only before any post-cutover attribution evidence
was written. Its transactionally maintained migration flag causes populated
rollback to fail before removing any columns. Use a reviewed forward fix after
cutover use; never clear the flag in a customer database. Migration-only tests of
older schema owners explicitly reset newer test evidence through their existing
isolated rollback harness; the attribution migration suite uses the production
runner and verifies the real guard directly.

## Verification

Unit/API coverage verifies exact minimized shapes, no attribution injection,
Employee/Manager/dual-role paths, permission and object concealment, null-decision
semantics, current-version decision refresh, and cursor-purpose rejection.
PostgreSQL coverage verifies scoped backfill, all four attribution snapshots rejecting
Unicode control/format spoofing, NFC preservation, snapshot immutability, rename and
deactivation, duplicate cross-Tenant User IDs, actor/decision integrity, migration
up/down/reapply and post-cutover rollback refusal. Existing workflow, composition,
transaction/audit rollback and role/security suites remain required.
