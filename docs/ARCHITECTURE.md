# Backend Architecture

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document describes the current implementation and does not override it.

The cross-repository production topology is defined in `floriankreutzer/conference-manager` by `docs/SAAS-PRODUCTION-TOPOLOGY.md`.

## Current foundation

The service uses Node.js 22 native HTTP and ECMAScript modules. Issues #47-#52 establish the trusted HTTP boundary, hard Tenant isolation, PostgreSQL persistence, provider-neutral server-side sessions, deny-by-default Tenant authorization and tenant-scoped tamper-evident audit evidence. `pg` remains the only runtime dependency.

```text
Browser (untrusted)
  -> same-origin HTTPS /api/*
     -> src/server.js: bounded Node HTTP server
        -> src/app.js: transport composition and route dispatch
           -> src/identity/session-service.js: session/CSRF/Principal boundary
              -> src/persistence/postgres/session-repository.js
                 -> PostgreSQL 18
           -> src/tenancy/tenant-context.js: Principal-derived Tenant context
              -> src/application/request-service.js
                 -> src/authorization/policy.js
                    -> src/domain/request*.js
                 -> src/persistence/postgres/request-repository.js
                    -> PostgreSQL 18
           -> src/audit/audit-service.js: tenant audit authorization/event service
              -> src/persistence/postgres/audit-repository.js
                 -> PostgreSQL 18 append-only HMAC chain

Future identity provider
  -> provider-specific OIDC adapter
     -> validated/mapped trusted identity
        -> provider-neutral session issuance
```

Provider-specific identity claims and SDK types do not cross into business services. The future Entra adapter validates and maps external identity before session issuance.

## Module responsibilities

- `src/config.js` owns runtime/database/session/audit-secret environment parsing and fail-closed production configuration.
- `src/api-error.js` owns safe API error classification, including generic authorization/error concealment and audit-integrity failure responses.
- `src/domain/identifiers.js` owns stable internal UUID validation.
- `src/domain/request-workflow.js` owns canonical Request status/transition identifiers.
- `src/domain/request.js` validates canonical Request records returned from persistence.
- `src/security.js` owns generic HTTP-boundary validation, security headers, rate limiting, JSON validation and the transport Principal guard.
- `src/identity/principal.js` owns the provider-neutral trusted-identity and internal-Principal shapes.
- `src/identity/session-cookie.js` owns strict `cm_session` parsing/serialization and cookie attributes.
- `src/identity/session-service.js` owns opaque token generation/hashing, CSRF derivation/verification, issuance, resolution, rotation and revocation; lifecycle mutations construct server audit events.
- `src/tenancy/tenant.js` owns Tenant lifecycle semantics and the tenant-owned resource inventory.
- `src/tenancy/tenant-context.js` resolves Tenant context exclusively from the authenticated Principal's internal Tenant ID.
- `src/tenancy/tenant-scoped-repository.js` enforces generic tenant-scoped persistence ports.
- `src/authorization/policy.js` owns recognized Tenant roles/permissions, object ownership, Request transition authorization and Tenant audit-read capability.
- `src/application/request-service.js` coordinates Tenant-scoped Request loading, authorization, optimistic workflow writes and correlated audit outcomes.
- `src/audit/event.js` owns the fixed event taxonomy, bounded secret-minimized event validation and canonical integrity payload.
- `src/audit/audit-service.js` derives Tenant/actor/time from trusted context, authorizes tenant audit reads and records denial/read evidence.
- `src/persistence/postgres/pool.js` owns bounded PostgreSQL pooling, TLS policy and database/schema readiness.
- `src/persistence/postgres/session-repository.js` owns session persistence and authoritative expiry/revocation/security-version checks; successful lifecycle mutations append audit evidence in the same transaction.
- `src/persistence/postgres/request-repository.js` owns Tenant-scoped Request lookup and status-conditional workflow updates; successful transitions append audit evidence in the same transaction.
- `src/persistence/postgres/audit-repository.js` owns per-Tenant append serialization, HMAC signing, tenant-scoped listing and chain verification.
- `src/persistence/postgres/transaction.js` owns the common commit/rollback transaction boundary.
- `src/persistence/postgres/index.js` composes pool, Tenant loading, Session/Request/Audit repositories and readiness.
- `scripts/db-migrations.mjs` owns source-controlled migration discovery, checksums, advisory locking and transactional up/down execution.
- `src/logger.js` owns bounded non-sensitive operational logs, separate from durable audit evidence.
- `src/app.js` composes transport, session, CSRF, Tenant, audit and application boundaries without importing PostgreSQL or provider SDKs.
- `src/index.js` is the runtime composition root and graceful-shutdown owner.

## Dependency direction

HTTP handlers call security/identity/Tenant/application/audit contracts. Application services call authorization/domain policies and repository ports. Application/domain/authorization code must not depend on Node HTTP objects, `pg`, migrations, provider claims or provider SDK types.

PostgreSQL adapters implement repository contracts using fixed source-controlled SQL and parameter binding. Identity-provider adapters added later translate validated provider claims to internal identity contracts before business/session code sees them.

## Tenant and identity trust boundary

Tenant identity is never selected from a client header, query parameter, route parameter or body field. Session resolution produces an internal Principal; Tenant context then loads the canonical Tenant using only `principal.tenantId`.

The internal Principal contains internal User/Tenant IDs, a normalized provider identity reference, approved roles/permissions and bounded session metadata. Provider-specific claim structures remain outside this contract.

The public session endpoint intentionally omits provider identity references, internal session IDs, token hashes and provider tokens.

## Authorization architecture

Business authorization is deny-by-default and occurs after Principal and Tenant resolution.

The recognized Tenant roles are `employee`, `conference_manager` and `tenant_admin`. `platform_admin` is intentionally outside this Tenant role model. Unknown roles or permissions invalidate the Principal for business authorization.

A capability requires both a recognized permission on the server Principal and a role that is allowed to use that permission. Role alone and permission alone are insufficient.

Request repositories always receive the server-resolved internal Tenant ID. Employee Request access additionally checks `request.requesterUserId === principal.userId`. Non-owned Employee objects and cross-Tenant IDs are concealed as not found to avoid BOLA/IDOR existence disclosure.

Conference Manager Request scope is currently the authenticated internal Tenant. Tenant Admin capabilities remain separate from Conference Manager Request operations. Tenant audit access is a separate Tenant Admin capability requiring `tenant:audit:read`.

Request workflow transitions are server-defined. The browser selects only a transition identifier; the policy determines the eligible current state, target state, role/permission requirement and reason rule. The persistence update includes the previously authorized current status so a concurrent state change yields a conflict instead of a stale overwrite.

See `docs/AUTHORIZATION.md` for the complete role/permission and workflow matrix.

## Session architecture

The browser receives a 256-bit opaque `cm_session` cookie. Only SHA-256 of that token is persisted. Session resolution requires a matching non-revoked/non-expired row, active User, current User `security_version`, and session-available Tenant lifecycle state.

Cookie policy is `HttpOnly`, `SameSite=Lax`, `Path=/api`, no broad `Domain`, and `Secure` for HTTPS. Pilot/Production require HTTPS and therefore always use `Secure`.

Cookie-authenticated unsafe operations require an HMAC-derived synchronizer token supplied as `X-CSRF-Token`. Pilot/Production require the HMAC secret from deployment secret management.

Role/permission changes increment `users.security_version`. Existing sessions immediately fail resolution when their stored `principal_version` becomes stale. A server-authorized rotation can create a replacement session with the newly approved snapshot and revoke the previous session atomically.

Session issue/revoke/rotation construct server-controlled security events. The PostgreSQL session repository commits the success audit event in the same transaction as the corresponding session mutation.

See `docs/IDENTITY-SESSION.md` for the normative flow.

## Audit architecture

Tenant audit evidence is a durable security/business data model, not an operational log stream.

`src/audit/event.js` accepts only a fixed action/outcome/retention taxonomy, server identifiers/timestamps and bounded flat primitive state/metadata. Credential-sensitive field names and nested values are rejected.

`src/persistence/postgres/audit-repository.js` serializes append operations per internal Tenant using a transaction-scoped advisory lock. Each event is HMAC-SHA-256 signed over a canonical payload and the previous Tenant event hash. `GET /api/v1/audit` verifies the complete Tenant chain before returning records.

Migration 004 installs a database trigger that rejects `UPDATE` and `DELETE` against `audit_events`. This prevents ordinary in-database mutation while the HMAC chain detects modified/reordered rows if the key remains protected.

The integrity model does not provide external completeness proof against privileged deletion of an entire suffix or restoration of an older database snapshot. External anchoring/WORM export and independent retention remain later production-hardening work.

See `docs/AUDIT.md` for the normative event/integrity contract.

## Persistence lifecycle

Schema ownership lives in `migrations/`. Migrations are paired up/down files, numerically versioned, checksum protected and serialized by a PostgreSQL advisory lock.

The application never auto-migrates at startup. Deployment automation runs migrations first. Runtime readiness requires database connectivity and the exact expected schema version.

Migration 001 establishes tenant-owned product structures. Migration 002 adds User security-version state and server-side sessions. Migration 003 constrains authoritative Request workflow state and adds workflow reason/change timestamps. Migration 004 upgrades audit storage to the append-only, HMAC-chained event contract and advances runtime schema readiness to version 4.

## Foundation endpoints

`GET /api/v1/health/live` proves only process liveness.

`GET /api/v1/health/ready` exposes only `ready`/`not_ready`; PostgreSQL connectivity and expected schema version are readiness dependencies when persistence is configured.

`GET /api/v1/session` resolves the PostgreSQL-backed session, validates recognized roles/permissions and Tenant context, then returns minimized internal presentation context plus the current CSRF token.

`DELETE /api/v1/session` requires the authenticated Principal and valid CSRF token, revokes the server-side session, persists correlated audit evidence and clears the cookie.

`GET /api/v1/requests/{requestId}` performs active-Tenant plus object-level Request authorization before returning minimized Request data.

`POST /api/v1/requests/{requestId}/transitions` additionally requires CSRF and executes only an explicitly authorized server-side workflow transition; success audit evidence commits atomically with the workflow mutation.

`GET /api/v1/audit` requires Tenant Admin plus `tenant:audit:read`, verifies Tenant audit integrity, returns only Tenant-scoped presentation-safe event data and records the audit read itself.

## Rate limiting

The foundation rate limiter is local/in-memory and bounded. It is not a multi-instance quota service. A trusted edge/shared limiter design remains required before horizontally scaled production abuse controls are claimed complete.

## Deferred ownership

- #53: Tenant entitlements.
- #54: Provider-neutral booking/calendar contracts and provider adapters.
- #55: Production observability and SLO-oriented diagnostics.
- #56: Frontend production-persistence migration onto API/database authority.
- #57: Complete threat model and production secure-configuration baseline, including independent audit anchoring/retention decisions.
