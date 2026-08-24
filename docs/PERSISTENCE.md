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
- reviewed migration SQL selected only from the fixed source-controlled migration directory.

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
- `status_changed_at` machine timestamp;
- expected schema version 3.

The raw session token and CSRF token are never persisted.

The audit table provides relational ownership only. Append-only/tamper-evident audit behavior remains #52.

## Tenant integrity

Tenant-owned tables use non-null internal `tenant_id`. Composite keys/foreign keys include `tenant_id` where one Tenant-owned entity references another, preventing a valid identifier from another Tenant being attached accidentally.

`ON DELETE RESTRICT` prevents physical Tenant deletion from orphaning retained data. Same business resource IDs may exist independently in separate Tenants while duplicates inside one Tenant fail deterministically.

Session rows reference `(tenant_id, user_id)`, so a session cannot attach an internal User from another Tenant.

Request lookup and workflow mutation are always parameterized by internal `tenant_id` plus Request ID. A Request ID from another Tenant therefore resolves as absent without a global lookup.

## Request workflow concurrency

`createPostgresRequestRepository` implements two Request operations for the #51 authorization slice:

- `findByTenantIdAndId(tenantId, requestId)`;
- `transitionByTenantIdAndId(...)`.

A transition update includes the previously authorized current status in its `WHERE` predicate:

```text
tenant_id + request id + expected current status
```

This provides optimistic workflow concurrency. If another operation changes the Request between the authorized read and the write, the stale update affects zero rows and the application returns `409 REQUEST_STATE_CONFLICT` rather than overwriting the newer state.

The repository persists only the server policy decision (`nextStatus`, validated reason and server timestamp). Client-supplied target status/owner/Tenant fields do not reach the repository contract.

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

The app does not auto-migrate on process start. Deployment automation runs migrations before app rollout. Runtime readiness requires connectivity and the exact expected schema version.

## Transaction contract

`withPostgresTransaction` obtains a dedicated client, begins a transaction, sets transaction-local UTC, executes work, commits only after success, and rolls back/discards the client after failure.

Business/session services must not report successful persistence before the authoritative transaction commits.

Session rotation is implemented as one transaction: the current session is locked, the replacement is inserted using the current User `security_version`, then the previous session is revoked. Failure prevents a partial rotation.

Request workflow updates are single conditional SQL statements and therefore atomic at row-update level. Their expected-current-status predicate is the concurrency control for #51.

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
- use `npm run db:rollback` only when the down migration was validated and data-loss impact is explicitly acceptable;
- destructive down migrations are bootstrap/test tools unless separately approved for populated environments;
- populated-environment destructive/data-transforming failures require reviewed forward-fix or restore/PITR decisions;
- restore procedures must be exercised before General Availability.

Migration 002 down removes the session table/security-version column and therefore invalidates all server sessions. It is not a transparent production rollback and requires an explicit authentication-impact decision.

Migration 003 down removes `status_reason`, `status_changed_at` and the Request workflow constraints. Any populated-environment rollback would lose persisted status reasons/change timestamps and weaken database workflow validation, so it requires an explicit data/security-impact decision rather than automatic rollback.

## Testing evidence required

Database changes require PostgreSQL integration coverage for applicable migration/version/checksum behavior, tenant-scoped repositories, composite FK isolation, invalid constraints, duplicate/concurrent writes, transaction rollback, schema readiness and cross-Tenant persistence.

Session persistence additionally requires real PostgreSQL tests for raw-token non-persistence, session resolution, cross-Tenant issuance rejection, expiry, revocation, stale privilege invalidation, rotation and migration rollback/reapply.

Request authorization persistence additionally requires real PostgreSQL tests for:

- same Request ID isolation across different Tenants;
- cross-Tenant Request lookup returning absent;
- server workflow status constraints;
- invalid status/reason combinations;
- Tenant-specific transitions;
- concurrent/stale expected-status writes allowing at most one winner;
- migration 003 rollback/reapply while preserving independent migration 002 regression coverage.

CI runs database tests against an isolated PostgreSQL 18 service after the normal quality/security gate.
