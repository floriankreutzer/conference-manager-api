# Backend Architecture

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document describes the current implementation and does not override it.

The cross-repository production topology is defined in `floriankreutzer/conference-manager` by `docs/SAAS-PRODUCTION-TOPOLOGY.md`.

## Current foundation

The service uses Node.js 22 native HTTP and ECMAScript modules. Issues #47-#50 establish the trusted HTTP boundary, hard Tenant isolation, PostgreSQL persistence and the provider-neutral server-side identity/session boundary. `pg` remains the only runtime dependency.

```text
Browser (untrusted)
  -> same-origin HTTPS /api/*
     -> src/server.js: bounded Node HTTP server
        -> src/app.js: transport composition and route dispatch
           -> src/identity/session-service.js: session/CSRF/Principal boundary
              -> src/persistence/postgres/session-repository.js
                 -> PostgreSQL 18
           -> src/tenancy/tenant-context.js: principal-derived Tenant context
              -> application/domain services
                 -> tenant-scoped repository contracts
                    -> src/persistence/postgres/* adapters
                       -> PostgreSQL 18

Future identity provider
  -> provider-specific OIDC adapter
     -> validated/mapped trusted identity
        -> provider-neutral session issuance
```

Provider-specific identity claims and SDK types do not cross into business services. The future Entra adapter validates and maps external identity before session issuance.

## Module responsibilities

- `src/config.js` owns runtime/database/session environment parsing and fail-closed production configuration.
- `src/api-error.js` owns safe API error classification.
- `src/domain/identifiers.js` owns stable internal UUID validation.
- `src/security.js` owns generic HTTP-boundary validation, security headers, rate limiting, JSON validation and the transport Principal guard.
- `src/identity/principal.js` owns the provider-neutral trusted-identity and internal-Principal shapes.
- `src/identity/session-cookie.js` owns strict `cm_session` parsing/serialization and cookie attributes.
- `src/identity/session-service.js` owns opaque token generation/hashing, CSRF derivation/verification, issuance, resolution, rotation and revocation.
- `src/tenancy/tenant.js` owns Tenant lifecycle semantics and the tenant-owned resource inventory.
- `src/tenancy/tenant-context.js` resolves Tenant context exclusively from the authenticated Principal's internal Tenant ID.
- `src/tenancy/tenant-scoped-repository.js` enforces tenant-scoped persistence ports.
- `src/persistence/postgres/pool.js` owns bounded PostgreSQL pooling, TLS policy and database/schema readiness.
- `src/persistence/postgres/session-repository.js` owns session persistence and authoritative expiry/revocation/security-version checks.
- `src/persistence/postgres/transaction.js` owns the common commit/rollback transaction boundary.
- `src/persistence/postgres/index.js` composes pool, Tenant loading, Session repository and readiness.
- `scripts/db-migrations.mjs` owns source-controlled migration discovery, checksums, advisory locking and transactional up/down execution.
- `src/logger.js` owns bounded non-sensitive operational logs.
- `src/app.js` composes transport, session, CSRF and Tenant boundaries without importing PostgreSQL or provider SDKs.
- `src/index.js` is the runtime composition root and graceful-shutdown owner.

## Dependency direction

HTTP handlers call security/identity/Tenant/application contracts. Application/domain code must not depend on Node HTTP objects, `pg`, migrations, provider claims or provider SDK types.

PostgreSQL adapters implement repository contracts using fixed source-controlled SQL and parameter binding. Identity-provider adapters added later translate validated provider claims to internal identity contracts before business/session code sees them.

## Tenant and identity trust boundary

Tenant identity is never selected from a client header, query parameter, route parameter or body field. Session resolution produces an internal Principal; Tenant context then loads the canonical Tenant using only `principal.tenantId`.

The internal Principal contains internal User/Tenant IDs, a normalized provider identity reference, approved roles/permissions and bounded session metadata. Provider-specific claim structures remain outside this contract.

The public session endpoint intentionally omits provider identity references, internal session IDs, token hashes and provider tokens.

## Session architecture

The browser receives a 256-bit opaque `cm_session` cookie. Only SHA-256 of that token is persisted. Session resolution requires a matching non-revoked/non-expired row, active User, current User `security_version`, and session-available Tenant lifecycle state.

Cookie policy is `HttpOnly`, `SameSite=Lax`, `Path=/api`, no broad `Domain`, and `Secure` for HTTPS. Pilot/Production require HTTPS and therefore always use `Secure`.

Cookie-authenticated unsafe operations require an HMAC-derived synchronizer token supplied as `X-CSRF-Token`. Pilot/Production require the HMAC secret from deployment secret management.

Role/permission changes increment `users.security_version`. Existing sessions immediately fail resolution when their stored `principal_version` becomes stale. A server-authorized rotation can create a replacement session with the newly approved snapshot and revoke the previous session atomically.

See `docs/IDENTITY-SESSION.md` for the normative flow.

## Persistence lifecycle

Schema ownership lives in `migrations/`. Migrations are paired up/down files, numerically versioned, checksum protected and serialized by a PostgreSQL advisory lock.

The application never auto-migrates at startup. Deployment automation runs migrations first. Runtime readiness requires database connectivity and the exact expected schema version.

Migration 001 establishes tenant-owned product structures. Migration 002 adds User security-version state and server-side sessions.

## Foundation endpoints

`GET /api/v1/health/live` proves only process liveness.

`GET /api/v1/health/ready` exposes only `ready`/`not_ready`; PostgreSQL connectivity and expected schema version are readiness dependencies when persistence is configured.

`GET /api/v1/session` resolves the PostgreSQL-backed session, validates Tenant context and returns minimized internal presentation context plus the current CSRF token.

`DELETE /api/v1/session` requires the authenticated Principal and valid CSRF token, revokes the server-side session and clears the cookie.

## Rate limiting

The foundation rate limiter is local/in-memory and bounded. It is not a multi-instance quota service. A trusted edge/shared limiter design remains required before horizontally scaled production abuse controls are claimed complete.

## Deferred ownership

- #51: RBAC/object ownership/workflow authorization on top of the Tenant/Principal boundaries.
- #52: Append-only/tamper-evident audit behavior and security-event persistence.
- #53: Tenant entitlements.
- #54: Provider-neutral booking/calendar contracts and provider adapters.
- #55: Production observability and SLO-oriented diagnostics.
- #56: Frontend production-persistence migration onto API/database authority.
- #57: Complete threat model and production secure-configuration baseline.
