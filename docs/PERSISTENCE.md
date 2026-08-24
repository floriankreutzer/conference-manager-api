# PostgreSQL Persistence

## Decision

Conference Manager uses PostgreSQL 18 as the relational production persistence platform. The application uses the pinned `pg` driver directly rather than an ORM so SQL, tenant predicates, transaction boundaries, constraints, and migrations remain explicit and reviewable.

The production deployment should track supported PostgreSQL 18 minor releases and apply current security/bug-fix releases through the managed database lifecycle. Major-version upgrades require a separate compatibility and migration decision.

## Security boundary

Database access exists only under `src/persistence/postgres`. Application/domain/HTTP modules must not import `pg` or contain SQL.

Production database requirements:

- `DATABASE_URL` is supplied through deployment secret/configuration management and never source control;
- Pilot/Production requires `DATABASE_SSL=verify-full`;
- TLS certificate verification must not be disabled in Pilot/Production;
- connection strings and driver Error objects are not logged;
- pool size, connection timeout, idle timeout, statement timeout, and query timeout are bounded;
- SQL values from application/user data use PostgreSQL parameters (`$1`, `$2`, ...);
- migration SQL is trusted, reviewed source code and is never selected or constructed from request input.

## Schema ownership

`migrations/` is the source of truth for the database schema. The first migration establishes tenant-owned structural tables for:

- tenants;
- users;
- sites;
- rooms;
- services;
- catering packages and items;
- integrations;
- requests;
- notifications;
- audit-event storage structure.

The audit table created here provides only relational ownership/referential structure. Append-only/tamper-evident audit behavior and event policy remain issue #52.

Tenant-owned tables use internal `tenant_id` ownership. Where entities reference another tenant-owned entity, composite foreign keys include `tenant_id` so a valid identifier from Tenant A cannot be attached to an object in Tenant B.

Business identifiers such as room/site/request IDs remain tenant-scoped text identifiers to preserve compatibility with the existing product contracts. Internal Tenant and User identifiers use UUIDs.

Machine timestamps use `timestamptz`. Locale-specific date, time, currency, and number presentation remains a frontend responsibility.

## Migration framework

Migration files use reviewed pairs:

```text
NNN_name.up.sql
NNN_name.down.sql
```

The migration runner:

- discovers only the fixed source-controlled `migrations/` directory;
- requires complete up/down pairs;
- orders migrations by numeric version;
- stores version, name, SHA-256 checksum, and application timestamp in `schema_migrations`;
- refuses to continue if an already-applied migration source/checksum changes;
- uses a PostgreSQL advisory lock so two deployment jobs cannot migrate concurrently;
- executes each migration in a transaction;
- supports repeatable `up` execution;
- rolls back only the latest applied migration.

Commands:

```bash
npm run db:migrate
npm run db:rollback
```

The application process does not auto-migrate at startup. Deployment automation owns migration execution. Runtime readiness requires both database connectivity and the expected schema version, preventing a new application version from serving against a stale schema.

## Transaction contract

`withPostgresTransaction` is the common write-transaction boundary. It obtains a dedicated pooled client, begins a transaction, sets transaction-local time zone to UTC, runs the supplied write operation, commits only on success, and rolls back/discards the connection on failure.

Business services must not return successful write outcomes before the authoritative database transaction has committed.

Booking concurrency receives additional domain-specific atomic/exclusion controls in the booking implementation issues; the generic transaction helper is not by itself a double-booking guarantee.

## Tenant isolation and database constraints

The schema reinforces the #48 application boundary:

- tenant-owned tables have non-null `tenant_id`;
- tenant-owned primary keys are generally `(tenant_id, id)`;
- cross-tenant child references use `(tenant_id, foreign_id)` composite foreign keys;
- tenant deletion uses `ON DELETE RESTRICT` so referenced tenant data cannot become orphaned;
- same business resource ID may exist independently in separate tenants;
- duplicate resource IDs inside one tenant fail deterministically;
- malformed capacities, schedules, prices, currencies, names, and lifecycle states are constrained where the schema owns those semantics.

Repository queries remain tenant-scoped by construction in addition to database constraints. Constraints are defense in depth, not a substitute for authorization.

## Backup, restore, and deployment rollback

Pilot and Production must use managed PostgreSQL backup capabilities with encrypted backups and point-in-time recovery where the selected hosting platform supports them.

Before a schema-changing production deployment:

1. verify the latest backup/PITR recovery point is healthy;
2. run migration validation in a representative non-production environment;
3. deploy/run migrations as a separately observable deployment step;
4. verify schema readiness;
5. deploy the application version;
6. monitor database/application health before completing the release.

Rollback policy:

- application rollback is preferred when the schema change is backward-compatible;
- `npm run db:rollback` may be used only when the down migration has been validated and its data-loss impact is explicitly acceptable;
- the initial schema down migration drops tables and is therefore intended for bootstrap/test rollback, not as a blind rollback for a populated Pilot/Production database;
- destructive or data-transforming migration failures in a populated environment require a reviewed forward-fix or restore/PITR decision rather than automatic down-migration;
- restore procedures must be periodically exercised before General Availability; documentation alone is not sufficient evidence.

## Testing evidence required

Database changes require PostgreSQL integration tests covering, as applicable:

- migration up, repeat-up, rollback, and reapply;
- migration checksum/version behavior;
- tenant-scoped repositories;
- composite foreign-key isolation;
- duplicates and concurrent writes;
- malformed/constraint-invalid data;
- transaction rollback on failed writes;
- schema readiness state;
- cross-tenant persistence attempts.

CI runs these tests against an isolated PostgreSQL 18 service after the normal quality/security gate.
