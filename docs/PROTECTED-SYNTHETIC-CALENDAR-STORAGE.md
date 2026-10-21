# Protected synthetic calendar storage

This additive storage foundation prepares durable, network-free synthetic
calendar state for the owned protected Customer runtime. It does not activate an
adapter, integration, room import, endpoint, identity or deployment. Full SaaS1
acceptance remains tracked by application issue351/milestone2. The existing
Microsoft branch and closed Demo simulator are unchanged.

## Custody and transaction boundary

Canonical migration063 adds private `synthetic_calendar_resources` and
`synthetic_calendar_events`. Resource ownership fixes DEV/INT, the non-reusable
UUID epoch, internal Tenant, current generation, actual Integration and Room.
The Integration must truthfully declare `synthetic_calendar`, active status and
its exact generation connection reference; no Microsoft binding or consent row
is manufactured. Resource preparation permits preparing/active generations and
eligible onboarding/ready/active Tenants. Event writes require an active Tenant
and generation, current deployment UUID, current active Platform owner and its
unchanged security version. PROD and REAL classification fail closed.

Trigger-only SECURITY DEFINER routines use fixed `pg_catalog` search paths,
qualified relations and exact relation/operation/level/depth checks. PUBLIC and
explicit Demo roles receive no execution permission. Authenticated session_user
must be the exact environment/surface credential or the migration routine owner;
SET ROLE cannot make a foreign authenticated credential eligible. The owned runtime needs no
Customer UPDATE on Platform actors, sessions, generations or deployment rows.
Event writes hold the existing shared reset barrier and current custody row
locks through commit. This is provider-state custody, not a replacement for
Customer session/CSRF, role, entitlement or workflow authorization.

Every event write advances its exact private resource tuple. Concurrent writes
therefore serialize per Tenant/Room. The subsequent overlap check uses half-open
periods, rejects conflicts with23P01 and allows adjacent reservations. A stale
repeatable-read writer encounters40001 at the changed resource tuple, rather
than accepting an overlap hidden by its old snapshot. Failed writes roll back
both the resource revision and event mutation. No additional extension, hash
collision identity or non-transactional lock cache is used.

Events retain minimal internal IDs, idempotency key, bounded finite UTC period,
state and revisions. Ownership and idempotency fields are immutable. Cancellation
is terminal and preserves the prior period. Row deletion is denied. The future
adapter must normalize provider contract input/results, bind retries to the
same persisted record, and keep canonical booking reference/audit/compensation
logic. SQL storage alone does not prove that complete business flow.

## Migration, grants and recovery

Schema readiness, bounded role plan, retained upgrade/readback, media/recovery
operators and exact inventories now require canonical63/Demo28. Existing001–062
and Demo001–027 remain byte-identical. Older rollback probes drain only the new
empty063 before executing their unchanged historical assertions. Both tables
retain their rows across protected generation replacement; no reset path deletes
REAL customers, invitations, sessions, keys or audit history.

Demo overlay028 grants only TRUNCATE on these private tables to the fixed reset
role; Customer/Platform Demo roles cannot read or mutate them. Empty-only
truncate guards keep the permanent closed Demo reset usable but reject populated
synthetic history. Down migration and overlay rollback also require empty
history. The protected role manifest permits Customer SELECT on resources and
SELECT/INSERT/UPDATE on events; Platform can prepare resources with SELECT/INSERT
only. No role receives event DELETE or direct resource UPDATE/TRUNCATE. Runtime
processes still cannot import the operator-only installer. No live role/schema
has been provisioned.

## Evidence and remaining acceptance

Native exact-source execution is pending. The new database case retains prior
migration checksums, checks private/default and Demo privileges, trigger policy,
actual current synthetic generation, foreign/REAL/UUID/integration/Room denial,
positive create, adjacent periods, duplicate idempotency, conflicts, terminal
cancellation, a stale RR writer, simultaneous competing writes, disabled-owner
refusal and unchanged retained history/rollback/truncate denial. Test roles use
local SET ROLE plus an actual foreign session_user refusal; this case does not
prove password/TLS or a browser session. The
separate owned-root tests cover actual TLS/SCRAM process startup.

The adapter, generation resource preparation, final booking authority, discovery
and import, honest Customer capabilities/UI, media, complete two-surface browser
acceptance and actual keys/recovery/sender/owner/artifact cutover remain open.
Existing full native, real expiry, shared browser journey and four permanent
three-customer/two-reset gates remain required. No live provider, email, cloud
compute, paid capacity or migration is activated by this preparation.

The first completed native run119185292573 failed at the historical publication
role-grant assertion: its rollback stack had not drained the new empty Demo028,
leaving the old publication overlay ledger applied after its table was recreated.
Each existing Empty027 probe now first drains Empty028, just as canonical probes
drain Empty063. Expected grants, immutable sources and historical recovery
assertions remain unchanged. No production storage/privilege rule changed in
this correction; native exact-source rerun is required.

The same not-yet-accepted063 candidate also prepares a narrow boolean
`protected_lock_synthetic_calendar_source` for the forthcoming owned final
booking guard. It derives actor/source/User/session only from consumed current
UUID custody and locks mutable rows in that order without granting Customer
Platform UPDATE. NOWAIT contention returns false; RR serialization remains a
failure. Exact environment/surface session_user or routine owner is required;
PUBLIC/Demo execution is denied and only the protected Customer manifest grants
EXECUTE. The caller must still validate the full current principal/proof/evidence
before and after this lock under its mandatory live shared transaction. This
port alone grants no admission or booking. Native unknown-custody/Demo denial
are prepared here; positive consumed-session/concurrent revocation/final-write
acceptance belongs to the forthcoming runtime integration and remains open.
Accepted001–062 are untouched; this addition is to the unmerged063 candidate.
