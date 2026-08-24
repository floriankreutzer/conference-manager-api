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
- advances expected runtime schema readiness to version 4.

The raw session token, CSRF token and audit HMAC key are never persisted.

## Tenant integrity

Tenant-owned tables use non-null internal `tenant_id`. Composite keys/foreign keys include `tenant_id` where one Tenant-owned entity references another, preventing a valid identifier from another Tenant being attached accidentally.

`ON DELETE RESTRICT` prevents physical Tenant deletion from orphaning retained data. Same business resource IDs may exist independently in separate Tenants while duplicates inside one Tenant fail deterministically.

Session rows reference `(tenant_id, user_id)`, so a session cannot attach an internal User from another Tenant.

Request lookup and workflow mutation are always parameterized by internal `tenant_id` plus Request ID. A Request ID from another Tenant therefore resolves as absent without a global lookup.

Audit rows are likewise Tenant-owned. Append/list/verification operations receive one internal Tenant ID, and each Tenant has an independent HMAC chain beginning with `previous_hash = NULL`.

## Request workflow concurrency

`createPostgresRequestRepository` implements Tenant-scoped Request access and status-conditional workflow mutation.

A transition update includes the previously authorized current status in its `WHERE` predicate:

```text
tenant_id + request id + expected current status
```

This provides optimistic workflow concurrency. If another operation changes the Request between the authorized read and the write, the stale update affects zero rows and the application returns `409 REQUEST_STATE_CONFLICT` rather than overwriting the newer state.

The repository persists only the server policy decision (`nextStatus`, validated reason and server timestamp). Client-supplied target status/owner/Tenant fields do not reach the repository contract.

A successful Request transition and its server-generated audit event execute in one PostgreSQL transaction. The transition is not committed if the required audit append fails.

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
- rolls back only the latest applied migration.

Commands:

```bash
npm run db:migrate
npm run db:rollback
```

The app does not auto-migrate on process start. Deployment automation runs migrations before app rollout. Runtime readiness requires connectivity and exact schema version 4 for this foundation.

## Transaction contract

`withPostgresTransaction` obtains a dedicated client, begins a transaction, sets transaction-local UTC, executes work, commits only after success, and rolls back/discards the client after failure.

Business/session services must not report successful persistence before the authoritative transaction commits.

Session issuance, revocation and rotation persist their corresponding success audit event in the same transaction as the session mutation. Rotation additionally locks the current session, inserts the replacement using current User `security_version`, revokes the previous session and appends the audit evidence before commit.

Request workflow transitions conditionally update the row and append the success audit event in the same transaction. A failed audit insert therefore prevents a successful Request transition from becoming authoritative.

Failure/denial events for operations that did not commit an authoritative mutation are separate audit appends because there is no successful business transaction to join.

Booking concurrency will receive additional domain-specific exclusion/atomicity controls; Request workflow state concurrency is not a room double-booking guarantee.

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

## Testing evidence required

Database changes require PostgreSQL integration coverage for applicable migration/version/checksum behavior, tenant-scoped repositories, composite FK isolation, invalid constraints, duplicate/concurrent writes, transaction rollback, schema readiness and cross-Tenant persistence.

Session persistence additionally requires real PostgreSQL tests for raw-token non-persistence, session resolution, cross-Tenant issuance rejection, expiry, revocation, stale privilege invalidation, rotation and migration rollback/reapply.

Request authorization persistence additionally requires real PostgreSQL tests for same-ID Tenant isolation, cross-Tenant absence, workflow constraints, invalid status/reason combinations and stale/concurrent transition protection.

Audit persistence additionally requires real PostgreSQL tests for:

- schema version 4 migration behavior;
- independent Tenant chains;
- Tenant-scoped listing;
- append-only UPDATE/DELETE rejection;
- HMAC chain verification;
- detectable row tampering;
- unaffected integrity of another Tenant after one Tenant is tampered;
- atomic rollback when required audit persistence fails;
- migration rollback/reapply where applicable.

The DB suites share migration state and are therefore executed serially with `--test-concurrency=1` to prevent test-runner races from weakening the migration/integrity evidence.

CI runs database tests against an isolated PostgreSQL 18 service after the normal quality/security gate.
