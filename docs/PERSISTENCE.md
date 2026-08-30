# PostgreSQL Persistence

## Decision

Conference Manager uses PostgreSQL 18 as the relational production persistence platform. The pinned `pg` driver is used directly so SQL, Tenant predicates, transaction boundaries, constraints and migrations remain explicit and reviewable.

Production should track supported PostgreSQL 18 minor releases through the managed database lifecycle. Major-version upgrades require a separate compatibility/migration decision.

## Security boundary

Database access exists only under `src/persistence/postgres`. Application/domain/authorization/HTTP modules must not import `pg` or contain SQL.

Production requirements include:

- `DATABASE_URL` supplied through deployment secret/configuration management;
- Pilot/Production `DATABASE_SSL=verify-full`;
- bounded pool/connection/idle/statement/query timeouts;
- PostgreSQL parameter binding for application/user values;
- no logging of connection strings, session tokens or raw driver Error objects;
- reviewed migration SQL selected only from the fixed source-controlled migration directory;
- a stable externally managed `AUDIT_HMAC_SECRET` for every DB-backed deployment; the HMAC key is not stored in PostgreSQL.

A configured `DATABASE_URL` without `AUDIT_HMAC_SECRET` fails configuration before persistence composition. The key must remain stable while existing audit rows depend on it. Key rotation requires an explicit audit-integrity migration/checkpoint design rather than a normal secret replacement.

## Schema ownership

`migrations/` is the schema source of truth.

Migration 001 establishes Tenant-owned product structures for tenants, users, sites, rooms, services, catering data, integrations, requests, notifications and audit-event relational storage.

Migration 002 establishes secure-session persistence:

- `users.security_version` for stale-privilege invalidation;
- server-side `sessions` rows;
- internal Tenant/User foreign-key ownership;
- unique SHA-256 session token hash;
- normalized provider identity reference;
- approved role/permission snapshot;
- session principal-version snapshot;
- issue/expiry/revocation timestamps;
- active-session lookup index.

Migration 003 establishes authoritative Request workflow persistence:

- allowlisted Request status constraint matching the server workflow;
- `status_reason` with bounded/trimmed database validation;
- reason storage restricted to `Rejected` and `Change Requested` states;
- `status_changed_at` machine timestamp.

Migration 004 establishes tenant-scoped audit integrity:

- refuses unexplained pre-existing audit rows rather than silently treating them as trusted evidence;
- adds bounded previous/new state and retention classification;
- adds `previous_hash`, `event_hash` and integrity version 1;
- adds Tenant/correlation and Tenant/hash indexes;
- installs an append-only trigger rejecting `UPDATE` and `DELETE`;
- establishes the audit integrity boundary consumed by later migrations.

Migration 005 establishes Tenant entitlement persistence:

- allowlisted stable capability IDs for the Microsoft-first pilot;
- explicit boolean entitlement state keyed by `(tenant_id, capability_id)`;
- Tenant foreign-key ownership with `ON DELETE RESTRICT`;
- `tenant.entitlement.changed` in the database audit-action allowlist;
- establishes the entitlement persistence boundary consumed by later integrations.

Migration 006 establishes booking-provider reference persistence:

- internal Tenant/Request/Integration composite ownership;
- opaque provider reference storage without provider-specific schema columns;
- deterministic create idempotency-key uniqueness per Tenant/Integration;
- `active`/`cancelled` local reference state;
- create correlation and timestamps.

Migration 007 establishes short-lived OIDC authentication transaction persistence:

- provider-scoped SHA-256 state hash as the one-time lookup key;
- SHA-256 nonce hash for callback validation;
- explicit creation/expiry timestamps;
- bounded provider/hash constraints;
- expiry index for cleanup;
- no authorization code, provider token, plaintext state or plaintext nonce persistence.

Migrations 008 through 016 add Tenant onboarding/identity claims, JIT User bindings, role administration, Microsoft 365 connection/mapping/write-entitlement/capability-health state and fixed Request/Tenant-lifecycle audit actions.

Migration 017 extends booking references:

- a positive non-null create-attempt number with no fabricated database default;
- a non-null provider connection identity reference;
- a non-null create-time provider resource binding;
- nullable provider event reference only while state is `pending`;
- `pending`, `active`, `compensating`, `compensated` and `cancelled` state/reference invariants;
- fail-closed application and rollback when populated references require reconciliation.

Migration 018 adds nullable `sites.time_zone`. Existing Sites remain explicitly unknown instead of receiving a fabricated UTC default. Application Configuration accepts only bounded identifiers validated against the server IANA database, while PostgreSQL reinforces the bounded identifier shape.

Migration 019 adds confirmed-booking change persistence and enforces one open proposal per confirmed Request.

Migration 020 adds independent optimistic revision counters for the Organization, Locations, Catalogue, Booking Policies and Cost Allocation Tenant Admin aggregates. It does not create a generic settings table/document, and rollback fails closed after any aggregate revision advances beyond its initial value.

Migration 021 adds bounded JSON details columns for Sites and Rooms plus immutable `tenant_location_revisions`. It leaves existing Site time zones and local/provider identifiers unchanged.

Migration 022 adds the bounded current Organization row and append-only Organization revisions. Existing and future Tenants receive a neutral revision-1 snapshot without fabricated legal, registration or branding data.

Migration 023 adds the bounded service/equipment/catering Catalogue model, applicability relations and append-only Catalogue revisions. Existing and future Tenants receive a revision-1 snapshot; existing service identifiers remain authoritative.

Migration 024 adds effective-dated Booking Policy configuration plus immutable policy revisions. Its explicit platform default adds no customer-specific restriction.

Migration 025 adds Cost Allocation configuration, Tenant-scoped cost centers and immutable allocation revisions. Allocation remains disabled unless the Tenant explicitly enables it.

Migration 026 adds monotonic `users.lifecycle_revision` state for disable/reactivate concurrency. It does not replace the independent `security_version` session-authority control.

Migration 027 establishes Request composition v2 persistence:

- Tenant/Room-composite `tenant_room_prices`, seeded deterministically at zero in the current
  Organization default currency;
- one appended Catalogue snapshot containing Room prices and one Catalogue-revision advance per
  existing Tenant;
- explicit `requests.schema_version`, monotonic `request_version` and a bounded immutable
  `request_snapshot` for schema v2;
- append-only, Tenant/Request-composite `request_revisions` containing a complete public record for
  each Request version;
- one explicit `migrated_legacy` schema-v1/version-1 history row per pre-existing Request;
- full schema/base-version/composition fields for confirmed-booking proposals.

Migration 028 adds the Tenant- and actor-scoped bulk-validation receipt ledger described in
`docs/TENANT-BULK-TRANSFER.md`. It stores hashes and bounded replay responses rather than imported
settings payloads, and its rollback refuses to remove receipt evidence after first use.

Migration 029 establishes the dedicated Platform identity boundary: normalized operators, canonical
roles/permissions, target-Tenant scopes, opaque sessions, one-time authentication transactions and
security-version invalidation.

Migration 030 establishes append-only, HMAC-chained Platform audit evidence and the singleton chain
state/checkpoint contract. Platform audit is a separate authorization and integrity domain from
Tenant audit.

Migration 031 establishes the transactional Platform operations core: Tenant lifecycle/entitlement/
session revisions, invitation lineage, idempotency receipts, package history, recovery contexts,
dual-control grants, alert outboxes and the persistence needed by canonical operation services.

Migration 032 establishes bounded read-model persistence for fleet readiness, readiness evidence,
Microsoft fleet health, discovery observations and support diagnostics.

Migration 033 establishes append-only metering, period/revision projections, operational quotas,
quota receipts and the deployment-to-Tenant runtime inventory.

The all-role Tenant presentation contract reuses the current Organization row and
`organization_revision`. Its managed-brand policy maps one fixed reference to a code-shipped preset
and therefore introduces no upload metadata, asset table, external object reference or migration.

Runtime schema readiness advances to exactly version 33. The migration runner remains the sole owner of transactions, checksums and `schema_migrations` bookkeeping.

No entitlement row means disabled. The raw session token, CSRF token, OIDC transaction secret, OIDC plaintext state/nonce and audit HMAC key are never persisted.

## Tenant integrity

Tenant-owned tables use non-null internal `tenant_id`. Composite keys/foreign keys include `tenant_id` where one Tenant-owned entity references another, preventing a valid identifier from another Tenant being attached accidentally.

`ON DELETE RESTRICT` prevents physical Tenant deletion from orphaning retained data. Same business resource IDs may exist independently in separate Tenants while duplicates inside one Tenant fail deterministically.

Session rows reference `(tenant_id, user_id)`, so a session cannot attach an internal User from another Tenant.

Request lookup, history and workflow/composition mutation are always parameterized by internal
`tenant_id` plus Request ID. A Request ID from another Tenant therefore resolves as absent without
a global lookup. Request history references `(tenant_id, request_id)`, and Room prices reference
`(tenant_id, room_id)`, so syntactically valid cross-Tenant identifiers cannot attach to either
authority.

Audit rows are likewise Tenant-owned. Append/list/verification operations receive one internal Tenant ID, and each Tenant has an independent HMAC chain beginning with `previous_hash = NULL`.

Entitlement rows use `(tenant_id, capability_id)` as their primary key. The same capability can therefore be enabled independently for separate Tenants, while unknown capability IDs are rejected by the database allowlist.

Booking-provider references use `(tenant_id, request_id, integration_id)` as their primary key and Tenant-composite foreign keys to both Request and Integration. A provider reference or idempotency key is unique only within one Tenant/Integration boundary, so identical opaque provider values in separate Tenants cannot cross-link ownership.

The create-attempt number is part of the server-derived idempotency scope. Pending reconciliation retains its number/key/resource; only a completed `compensated` row may advance to the next attempt, rotate the key and bind the current resource before another provider create.

Booking references do not snapshot the Microsoft 365 optimistic `connection_version`: routine connection verification can advance it without changing provider identity. Transactional booking authority is the exact Integration/provider reference, required lifecycle status and active identity binding under locks.

OIDC authentication transactions exist before an internal Tenant is known and therefore deliberately do not carry a Tenant ID. They are not business records and cannot authorize Tenant access. Their authority is limited to one short-lived provider/state-hash pair used to complete the external authentication protocol.

## OIDC replay and concurrency

`createPostgresOidcTransactionRepository` owns the shared pre-authentication replay boundary.

Login start inserts one short-lived provider/state-hash/nonce-hash transaction. Before each insert, expired transactions are removed opportunistically.

Callback completion atomically executes the equivalent of:

```text
DELETE FROM oidc_auth_transactions
WHERE provider = expected_provider
  AND state_hash = expected_state_hash
  AND expires_at > callback_time
RETURNING nonce_hash
```

Only one concurrent consumer can receive the nonce hash. A second callback using the same state returns no row and fails authentication. This works across multiple API processes because the one-time decision is made in PostgreSQL rather than process memory.

The repository never accepts or stores a Tenant ID from the browser or provider callback. Tenant/User claiming happens only after the external identity has been validated by the provider adapter.

## Request composition, version and workflow concurrency

`createPostgresRequestRepository` implements Tenant-scoped Request access, bounded history,
current-configuration composition and status/version-conditional workflow mutation.

A v2 create or resubmit obtains the active Tenant/User and current Organization, Locations,
Catalogue, Booking Policies and Cost Allocation revisions under the owning transaction. It compares
all five with the observed draft, resolves the same-Tenant Room/Site/Room-price and selected current
configuration under locks, evaluates policy/pricing/allocation, then inserts or replaces the Request
snapshot. The browser cannot race a settings mutation into a mixed configuration snapshot or
persist its own prices.

Resubmission additionally locks the Request and requires:

```text
tenant_id + request id + requester user id + Change Requested + expected request version
```

A workflow transition continues to require the previously authorized status. Every successful
workflow or composition mutation increments `request_version`; a stale status, Request version or
configuration revision returns `409 REQUEST_STATE_CONFLICT` rather than overwriting newer state.
Client-supplied target status/owner/Tenant and calculated snapshot fields do not reach the repository
contract.

The updated Request, one complete `request_revisions` record and the server-generated success audit
event execute in one PostgreSQL transaction. Failure of history or audit persistence prevents the
Request mutation from committing. History reads use only internal Tenant ID plus Request ID and are
bounded newest-first.

Confirmed-booking proposal creation applies the same full v2 authority evaluation under the locked
confirmed Request and expected version. It persists the proposed draft/immutable next-version
snapshot rather than reevaluating historical business facts from a later Catalogue or policy. A
participant-count-only change may apply atomically; any other composition change remains a separate
pending aggregate until manager decision and existing calendar revalidation/compensation.

## Audit append and verification

`createPostgresAuditRepository` owns durable audit integrity.

For each append it:

1. obtains a transaction-scoped advisory lock derived from the internal Tenant ID;
2. verifies that the Tenant exists;
3. loads the latest event hash for that Tenant;
4. computes HMAC-SHA-256 over the canonical event payload plus the previous hash;
5. inserts the event with `previous_hash`, `event_hash` and integrity version 1.

Canonical object-key sorting keeps the HMAC stable after PostgreSQL `jsonb` normalization.

Tenant-chain verification reads the Tenant's events oldest-to-newest and validates the stored previous-hash linkage and HMAC using timing-safe hash comparison. Tenant-visible audit reads fail closed when verification fails.

The database trigger rejects ordinary row UPDATE/DELETE operations. The HMAC chain detects modified or reordered rows while the HMAC key remains protected. It does not independently prove completeness against a privileged deletion of an entire chain suffix or restoration of an older database snapshot. External anchoring/WORM export and independently controlled retention remain later production-hardening decisions.

## Migration framework

Migrations are paired reviewed files:

```text
NNN_name.up.sql
NNN_name.down.sql
```

The migration runner:

- discovers only the fixed `migrations/` directory;
- requires complete up/down pairs;
- orders migrations numerically;
- stores version/name/SHA-256 checksum/application time in `schema_migrations`;
- rejects altered/missing applied migration source;
- serializes concurrent runners with a PostgreSQL advisory lock;
- runs each migration transactionally;
- supports repeatable `up`;
- rolls back only the latest applied migration through `rollbackLatest`, while migration-focused tests may use `rollbackToVersion` to target the historical migration under test.

Commands:

```bash
npm run db:migrate
npm run db:rollback
```

The app does not auto-migrate on process start. Deployment automation runs migrations before app rollout. Runtime readiness requires connectivity and exact schema version 33.

## Shared Demo persistence

The SaaS 3.5 Shared Demo Runtime uses one isolated PostgreSQL database for both the customer and
Platform process. It is deliberately not an in-memory/browser state authority. Four distinct
database principals separate normal customer access, normal Platform access, destructive
reset/seed capability and migration ownership. All four URLs must resolve to the same
`conference_manager_demo_*` database, while their roles, passwords and complete URLs must remain
distinct.

The canonical `migrations/` stream remains the source of the business schema and must contain the
exact applied sequence `001..033`. The independent `demo-migrations/` stream has its own
`demo_schema_migrations` ledger, checksum and advisory lock; current Demo overlay version `001`
installs the immutable database sentinel, provider/persona reference tables, minimized views and
role grants. It reads but never writes the canonical `schema_migrations` ledger.

Reset uses the reset-only role and first verifies the sentinel key, current database and role,
recorded distinct principals, complete canonical migration sequence and exact expected table
inventory. It validates the source fixture's domain-separated semantic checksum before destructive
SQL. Normal customer and Platform requests hold one shared advisory lock; reset holds the matching
exclusive lock and runs truncate, seed, provider/persona insertion and semantic readback in one
serializable transaction. A checksum, inventory, lock, seed or readback failure rolls back the
complete operation.

For an HTTP reset, the reset transaction revalidates the exact internal Platform session and
operator security version while holding the exclusive lock. Truncation preserves PostgreSQL
sequence positions; audit and operational identifiers therefore remain monotonic, and the reset
role requires sequence usage rather than sequence ownership.

Reset intentionally preserves the two migration ledgers and immutable sentinel. It resets all
authoritative customer/Platform business, session, audit, projection and metering rows while
preserving identity-sequence positions. It is not a Production migration or backup/restore mechanism and its role must
never be provisioned against a Pilot/Production database. See `docs/SHARED-DEMO-RUNTIME.md`.

## Transaction contract

`withPostgresTransaction` obtains a dedicated client, begins a transaction, sets transaction-local UTC, executes work, commits only after success, and rolls back/discards the client after failure.

Business/session services must not report successful persistence before the authoritative transaction commits.

Session issuance, revocation and rotation persist their corresponding success audit event in the same transaction as the session mutation. Issuance locks the User and Tenant and requires the trusted role/permission snapshot's expected `security_version` to equal the current User value before insertion. Rotation additionally locks the current session, inserts the replacement using current User `security_version`, revokes the previous session and appends the audit evidence before commit.

JIT provisioning locks the complete external identity tuple and then locks and revalidates the exact active Tenant/provider-Tenant binding inside the same transaction that resolves or creates the local User. Its returned authorization snapshot includes the exact User `security_version`, closing the gap between role resolution and session insertion.

Microsoft 365 consent start likewise locks and revalidates the active provider-Tenant binding before changing the connection and inserting the one-time consent row. Provider rebinding is rejected while any booking reference is not terminal `cancelled`. Callback consume locks the consent row and connection, revalidates actor, expiry, callback Tenant and the active provider binding, deletes the one-time row, and appends redacted rejection evidence within one transaction. After external verification, finalization revalidates both the exact active binding and the consumed `provider_reference` in the connection-update predicate, so an unbind or rebind during Graph I/O cannot commit verified state. A same-provider reconnect preserves a healthy verified connection until successful replacement; an allowed provider rebind resets verification and invalidates stale room mappings and capability-health snapshots atomically.

Locations/Rooms updates lock `tenants.locations_revision`, validate the current Tenant-owned set, preserve referenced identities (including the target of an applying confirmed-booking change), apply the local state, advance the revision, store the actual post-apply snapshot and append audit evidence in one transaction. Confirmed-booking approval takes a shared lock on the same Tenant row before validating and applying its target, so approval cannot race a location deactivation. Microsoft room import uses the same lock and snapshots and advances the aggregate once when it creates local Rooms. Provider-only synchronization does not mutate local configuration or advance the Locations revision.

Pre-activation identity unbind locks the Tenant, Microsoft 365 Integration and exact active binding. It returns a conflict if any booking reference is not `cancelled`; otherwise binding removal, User security-version increments, active-session revocation, consent-transaction deletion, Microsoft 365 disconnect/verification reset and `tenant.identity.unbound` evidence commit together.

Request v2 create/resubmit and workflow transitions conditionally persist the Request row, append
the complete immutable Request revision and append the success audit event in the same transaction.
A failed snapshot/history/audit insert therefore prevents a successful Request change from becoming
authoritative. Current composition evaluation also occurs inside that transaction and locks the
Tenant/configuration authority required to prevent a mixed-revision snapshot.

Conference Manager report reads use the canonical `requests` rows and their immutable Request-v2
snapshots; there is no parallel reporting model. Persistence requires the server-resolved Tenant ID,
the canonical UTC `starts_at` half-open range and a bounded `(starts_at, id)` keyset. Migration 027
adds `requests_tenant_report_range_idx (tenant_id, starts_at, id)`. The repository orders by the same
key, so duplicate schedule instants neither omit nor repeat rows across pages. The application fetches
one lookahead row and exposes an explicit completion flag/cursor instead of silently truncating.

Entitlement changes are serialized per Tenant/capability, update the allowlisted entitlement row and append `tenant.entitlement.changed` in the same transaction. A failed audit append rolls the entitlement change back; setting an already-effective value is idempotent and creates no false change event.

Booking-provider reference creation is serialized per Tenant/Request/Integration. Before provider create, a `pending` row audit-atomically binds attempt number, exact provider connection identity, create-time resource and deterministic key without a placeholder event reference. Reserve/retry and normal finalization lock and require that exact Integration/provider reference, `connected` status and, for Microsoft 365, exact active Entra binding. Finalization stores the real reference as `active`; if authority disappeared after external create, it instead stores the event as `compensating` so the caller can delete and complete `compensated`. An identical repeat does not append duplicate success evidence and a conflicting pair fails closed. Update, compensation and cancel local mutations append the required `calendar.operation` success event in the same PostgreSQL transaction.

The external calendar system is not part of that database transaction. A provider success followed by local finalization failure returns failure and is recovered with the persisted resource/idempotency scope; the provider contract must return the same existing external event instead of creating a duplicate. Pending cancellation performs that same reconciliation before delete and may do so after local disconnect, provided the persisted Integration/provider identity and active binding still match. A retry after completed compensation increments the attempt and rotates the key instead of reusing the deleted event's transaction ID.

Final Request confirmation passes a bounded provider-authority descriptor into its owning transaction. Before the room lock/update, persistence locks and requires the exact connected Integration/provider reference plus exact active identity binding; loss produces `provider_authority_conflict` without changing the Request. If the caller created an event, it compensates that event rather than committing under stale authority.

Failure/denial events for operations that did not commit an authoritative mutation are separate audit appends because there is no successful business transaction to join.

The production application composes Tenant-scoped advisory availability with server-authoritative Request creation, then repeats local/provider validation for final confirmation. The final Request transaction locks the Request and Tenant/room scope, rechecks confirmed overlaps and provider authority, and appends the transition audit before commit; no parallel reservation authority is introduced by the booking adapter.

## Backup, restore and deployment rollback

Pilot/Production must use managed encrypted backups and point-in-time recovery where supported by the selected hosting platform.

Before schema-changing production deployment:

1. verify a healthy backup/PITR recovery point;
2. validate migrations in representative non-production;
3. run migrations as an observable deployment step;
4. verify schema readiness;
5. deploy the application;
6. monitor database/application health before release completion.

Rollback policy:

- prefer application rollback for backward-compatible schema changes;
- use `npm run db:rollback` only when the down migration was validated and data-loss/security impact is explicitly acceptable;
- destructive down migrations are bootstrap/test tools unless separately approved for populated environments;
- populated-environment destructive/data-transforming failures require reviewed forward-fix or restore/PITR decisions;
- restore procedures must be exercised before General Availability.

Migration 002 down removes the session table/security-version column and therefore invalidates all server sessions. It is not a transparent production rollback and requires an explicit authentication-impact decision.

Migration 003 down removes `status_reason`, `status_changed_at` and the Request workflow constraints. Any populated-environment rollback would lose persisted status reasons/change timestamps and weaken database workflow validation, so it requires an explicit data/security-impact decision rather than automatic rollback.

Migration 004 down removes the append-only trigger, integrity chain fields and retention/state extensions. On a populated environment this would weaken evidentiary controls and discard integrity metadata, so production rollback requires an explicit security/audit decision; a forward fix is preferred.

Migration 005 down fails closed when entitlement rows or entitlement-change audit evidence exists. Populated-environment rollback therefore requires an explicit entitlement/evidence migration decision rather than silently deleting commercial access state or its audit trail.

Migration 006 down fails closed when booking-provider reference rows exist. A populated rollback requires reviewed reconciliation because deleting the local mapping could orphan an external calendar event.

Migration 007 down removes only short-lived pre-authentication transaction state. Rolling it back invalidates any Entra sign-in flow already in progress, so authentication traffic must be drained or users must restart login after rollback. It does not delete established sessions or Tenant/User records.

Migration 017 up and down fail closed when booking references exist because neither a legacy create-time resource nor removal of a current binding is safe to infer automatically. Migration 018 down fails closed while any Site time zone is configured because dropping the column would lose booking/display authority; reviewed forward remediation is preferred.

Migration 020 down fails closed when any Tenant settings aggregate revision has advanced beyond `1`; removing active concurrency state after a settings mutation requires a reviewed forward fix or compatible application rollback.

Migration 021 down takes access-exclusive locks and fails closed when Locations history exists, any Locations revision has advanced, or any Site/Room detail value would be discarded. It cannot silently discard versioned Site/Room details or immutable history.

Migrations 022 and 023 down allow only their neutral revision-1 state and fail closed before discarding non-default Organization or Catalogue data, revision advances, history beyond the initial snapshot or new Catalogue relations.

Migrations 024 and 025 down fail closed after policy/allocation history, a revision advance, a non-default policy/allocation configuration or cost-center data exists. Customer history is not destructively rolled back.

Migration 026 down fails closed after any lifecycle revision advances beyond `1`; User disable/reactivate state must be retained or resolved through a reviewed forward migration.

Migration 027 down takes access-exclusive locks and fails closed after any schema-v2 Request,
non-migration Request revision, non-seed Room price, subsequent Catalogue mutation or v2
confirmed-change proposal exists. The up migration advances every existing Tenant's Catalogue
revision once to add Room prices; pre-migration Catalogue clients must reload. Once the new boundary
has been used, production rollback requires a reviewed forward fix, compatible application rollback
or restore/PITR decision rather than deletion of immutable history or bypass of the guard.

## Testing evidence required

Database changes require PostgreSQL integration coverage for applicable migration/version/checksum behavior, tenant-scoped repositories, composite FK isolation, invalid constraints, duplicate/concurrent writes, transaction rollback, schema readiness and cross-Tenant persistence.

Session persistence additionally requires real PostgreSQL tests for raw-token non-persistence, session resolution, cross-Tenant issuance rejection, expiry, revocation, stale privilege invalidation, role-change/issuance races, rotation and migration rollback/reapply.

JIT persistence additionally requires real PostgreSQL tests for an active binding removed between lookup and transaction, absent optional display names, concurrent first login, and audit-atomic provisioning.

Microsoft 365 connection persistence additionally requires real PostgreSQL tests for durable redacted callback rejection, healthy reconnect cancellation/expiry recovery, active provider rebinding, room-mapping invalidation and stale callback/version rejection.

OIDC transaction persistence additionally requires real PostgreSQL tests for schema version 7, plaintext non-persistence, valid one-time consume, expiry rejection, replay rejection, provider scoping, concurrent consume behavior and rollback/reapply.

Request authorization persistence additionally requires real PostgreSQL tests for same-ID Tenant isolation, cross-Tenant absence, workflow constraints, invalid status/reason combinations and stale/concurrent transition protection.

Audit persistence additionally requires real PostgreSQL tests for:

- schema version 4 audit migration behavior;
- independent Tenant chains;
- Tenant-scoped listing;
- append-only UPDATE/DELETE rejection;
- HMAC chain verification;
- detectable row tampering;
- unaffected integrity of another Tenant after one Tenant is tampered;
- atomic rollback when required audit persistence fails;
- migration rollback/reapply where applicable.

Entitlement persistence additionally requires real PostgreSQL tests for schema version 5, absent-is-disabled behavior, cross-Tenant independence, database capability allowlisting, rollout/entitlement intersection, audit-atomic changes and fail-closed populated rollback.

Booking-provider persistence additionally requires real PostgreSQL tests for Tenant-composite Request/Integration ownership, same-provider-value cross-Tenant independence, pre-write pending connection/resource binding, attempt/state/reference constraints, same-attempt idempotent finalization, compensated-attempt key rotation, remap/disconnect-safe cleanup, create/final-commit authority loss, overlap lookup, audit-atomic mutations and fail-closed populated migration/rollback.

Site-time-zone persistence additionally requires real PostgreSQL tests for nullable legacy migration, Tenant-scoped catalogue reads, room-to-Site booking context, audit-atomic correction through the versioned Locations owner, invalid bounded database shapes, exact schema readiness and fail-closed populated rollback.

Migration 019 adds `booking_change_requests`, its Tenant-scoped foreign keys, bounded proposal fields, decision metadata and the partial unique index that enforces exactly one open proposal per confirmed Request. Participant-only application and approved proposal application update the Request, append `request.booking_change` audit evidence and create the Requester notification in one transaction. Room moves additionally swap the persisted active provider reference in that same apply transaction.

Migration 020 additionally requires integration coverage that each aggregate revision initializes to `1`, only the intended revision is advanced by later owners, rollback remains available before first use, and populated rollback fails closed after any aggregate revision advances.

Migration 021 additionally requires real PostgreSQL coverage for runner-owned up/down/reapply, single-snapshot reads, Tenant isolation, stale and concurrent writes, immutable history, audit rollback, referenced deactivation, exact rollback snapshots and Microsoft room-import revision advancement.

Migrations 022 and 023 additionally require real PostgreSQL coverage for neutral auto-provisioning, immutable initial/current history, Tenant isolation, stale/concurrent writes, audit-atomic mutation, rollback/reapply and fail-closed populated rollback.

Migrations 024 and 025 additionally require real PostgreSQL coverage for explicit defaults, Tenant-scoped references, effective-policy/allocation validation, immutable history, stale/concurrent writes, audit-atomic mutation and fail-closed populated rollback.

Migration 026 additionally requires real PostgreSQL coverage for Tenant-scoped User listing, cross-Tenant concealment, monotonic lifecycle concurrency, last-admin protection, session revocation, audit atomicity and fail-closed populated rollback.

Migration 027 additionally requires real PostgreSQL coverage for zero/default-currency Room-price
seeding, Catalogue revision advancement, legacy Request/history backfill, v2 snapshot constraints,
Tenant-composite Room-price/history ownership, append-only history, create/resubmit/proposal
configuration coherence, stale Request/configuration versions, concurrent settings writes,
snapshot/history/audit rollback atomicity, schema readiness and fail-closed populated rollback.

The DB suites share migration state and are therefore executed serially with `--test-concurrency=1` to prevent test-runner races from weakening the migration/integrity evidence.

CI runs database tests against an isolated PostgreSQL 18 service after the normal quality/security gate.
