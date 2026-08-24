# Backend Architecture

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document describes the current implementation and does not override it.

The cross-repository production topology is defined in `floriankreutzer/conference-manager` by `docs/SAAS-PRODUCTION-TOPOLOGY.md`.

## Current foundation

The service uses Node.js 22 native HTTP and ECMAScript modules. Issues #47 and #48 established the trusted HTTP and Tenant boundaries. Issue #49 introduces PostgreSQL as the relational persistence platform and pins `pg` as the only runtime dependency.

The database driver is infrastructure-only. Application/domain/HTTP modules must not import `pg` or contain SQL. A future dependency or framework may be introduced only by a scoped reviewed issue and must preserve the existing contracts.

```text
Browser (untrusted)
  -> same-origin HTTPS /api/*
     -> src/server.js: bounded Node HTTP server
        -> src/app.js: transport composition and route dispatch
           -> src/security.js: request boundary / principal / CSRF contracts
           -> src/tenancy/tenant-context.js: principal-derived Tenant context
              -> application/domain services
                 -> tenant-scoped repository contracts
                    -> src/persistence/postgres/* infrastructure adapters
                       -> PostgreSQL 18

Deployment migration step
  -> scripts/db-migrate.mjs
     -> scripts/db-migrations.mjs
        -> migrations/*.sql
           -> PostgreSQL 18
```

## Module responsibilities

- `src/config.js` owns runtime and database environment parsing plus fail-closed production configuration.
- `src/api-error.js` owns safe API error classification and maps approved tenancy errors to safe transport codes.
- `src/domain/identifiers.js` owns stable internal UUID validation used across principal and Tenant boundaries.
- `src/security.js` owns HTTP-boundary validation primitives, security headers, bounded rate limiting, JSON validation, the internal principal shape and CSRF hook.
- `src/tenancy/tenant.js` owns the canonical Tenant record, lifecycle states and tenant-owned resource inventory.
- `src/tenancy/tenant-context.js` resolves Tenant context exclusively from the authenticated principal's internal Tenant ID.
- `src/tenancy/tenant-scoped-repository.js` enforces the tenant-scoped persistence port shape for tenant-owned resources.
- `src/persistence/postgres/pool.js` owns bounded PostgreSQL pooling, TLS mode and database/schema readiness checks.
- `src/persistence/postgres/transaction.js` owns the common commit/rollback transaction boundary.
- `src/persistence/postgres/tenant-repository.js` maps canonical Tenant records from PostgreSQL.
- `src/persistence/postgres/room-adapter.js` is the first concrete tenant-scoped resource adapter and establishes the fixed-SQL/parameter-binding pattern.
- `src/persistence/postgres/index.js` composes pool, Tenant loading and persistence readiness for process startup.
- `scripts/db-migrations.mjs` owns source-controlled migration discovery, checksums, advisory locking and transactional up/down execution.
- `src/logger.js` owns structured operational logs and accepts only bounded non-sensitive metadata.
- `src/app.js` composes transport/security/Tenant boundaries and remains independent of the database driver.
- `src/server.js` owns Node HTTP server bounds/timeouts.
- `src/index.js` composes optional development persistence and mandatory Pilot/Production persistence, then closes it during graceful shutdown.

## Dependency direction

HTTP handlers may call application services and security/tenancy policies. Application/domain code must not depend on Node HTTP objects, `pg`, migration files or provider SDK types.

Repository contracts define the direction from business logic to persistence. PostgreSQL adapters implement those contracts. SQL is fixed source code inside the PostgreSQL infrastructure boundary; application/user values are supplied as query parameters.

Migration scripts are deployment tooling, not request-time runtime. Request input can never select migration files or migration SQL.

## Tenant isolation boundary

Tenant identity is not read from a client header, query parameter, route parameter or body field. The internal principal is validated first; `createTenantContextGuard` loads the canonical Tenant using only `principal.tenantId`.

The canonical Tenant has an internal UUID and contains no Microsoft Entra tenant ID or other provider identity. Provider bindings remain separate records so external identifiers cannot substitute for ownership checks.

Tenant-owned repository operations are scoped by construction. PostgreSQL reinforces this boundary with non-null `tenant_id`, composite tenant-owned keys and tenant-aware foreign keys. A child resource cannot reference an object in another Tenant even when the foreign identifier is otherwise valid.

`ON DELETE RESTRICT` prevents physical Tenant deletion from orphaning retained tenant-owned data. Logical suspended/archived lifecycle behavior remains the normal access-control mechanism.

See `docs/TENANCY.md` and `docs/PERSISTENCE.md`.

## Persistence lifecycle

Schema ownership lives in `migrations/`. Migrations are paired up/down files, versioned numerically, checksummed after application and serialized with a PostgreSQL advisory lock.

The application never auto-migrates at startup. Deployment automation runs migrations first. Runtime readiness requires both a database connection and the exact expected schema version. This prevents serving traffic with a reachable but stale database.

The generic transaction helper commits only after successful work and attempts rollback/discards the client on failure. Domain-specific concurrency controls such as final booking exclusion remain later booking work.

## Foundation endpoints

`GET /api/v1/health/live` proves only that the process can serve requests.

`GET /api/v1/health/ready` evaluates registered readiness functions with a timeout and exposes only `ready` or `not_ready`. With production persistence configured, database connectivity and schema version are readiness dependencies. Connection strings, server names and driver errors are not exposed.

`GET /api/v1/session` first resolves the authenticated principal and then verifies the canonical Tenant from PostgreSQL when persistence is configured. The default principal resolver still fails closed until #50 installs the real session implementation.

## Principal and CSRF extension contracts

The principal resolver is injected into `createApp`. It must return the internal principal shape after server-side validation. Browser values cannot populate this contract directly.

The CSRF verifier is a separate injected function. `createPrincipalGuard().require(request, { csrf: true })` requires successful CSRF verification for POST/PUT/PATCH/DELETE. Issue #50 will bind it to the real session/CSRF mechanism.

## Rate limiting

The foundation rate limiter is local/in-memory and bounded. It protects a single process and is not a multi-instance distributed quota solution. Before horizontally scaled pilot use, the edge or a reviewed shared limiter must provide trustworthy client-key semantics.

## Deferred ownership

- #50: Real principal/session resolution, secure cookies, expiry/revocation/rotation and CSRF issuance/validation.
- #51: RBAC/object ownership/workflow authorization on top of Tenant and persistence boundaries.
- #52: Append-only/tamper-evident audit behavior on the structurally prepared audit storage.
- #53: Tenant entitlements.
- #54: Provider-neutral booking/calendar contracts and provider references.
- #55: Production observability platform and SLO-oriented diagnostics.
- #56: Frontend production-persistence migration onto the new API/database authority.
- #57: Complete threat model and production secure-configuration baseline.
