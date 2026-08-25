# Backend Architecture

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document describes the current implementation and does not override it.

The cross-repository production topology is defined in `floriankreutzer/conference-manager` by `docs/SAAS-PRODUCTION-TOPOLOGY.md`.

## Current foundation

The service uses Node.js 22 native HTTP and ECMAScript modules. The implemented foundation includes:

- a bounded same-origin HTTP boundary;
- hard Tenant isolation and PostgreSQL 18 persistence;
- provider-neutral server-side sessions and CSRF protection;
- Microsoft Entra OIDC authentication, Tenant claiming and JIT User provisioning;
- deny-by-default Tenant roles and permissions;
- Tenant-scoped role administration with stale-session invalidation;
- Tenant-scoped tamper-evident audit evidence;
- server-side Tenant entitlements;
- provider-neutral booking/calendar contracts and opaque provider references;
- a Tenant-scoped Microsoft 365 admin-consent, verification, reconnect and disconnect lifecycle;
- production observability, threat-model and secure-configuration gates.

Runtime dependencies are limited to exact-pinned `pg` and `@azure/msal-node`. Provider-specific Microsoft handling uses bounded native HTTP plus a bounded MSAL transport isolated inside identity/integration adapters; Microsoft SDK types do not enter application or domain contracts.

```text
Browser (untrusted)
  -> same-origin HTTPS /api/*
     -> src/server.js: bounded Node HTTP server
        -> src/app.js: transport composition and route dispatch
           -> src/identity/session-service.js: session/CSRF/Principal boundary
              -> src/persistence/postgres/session-repository.js
                 -> PostgreSQL 18
           -> src/tenancy/tenant-context.js: Principal-derived Tenant context
              -> application services
                 -> src/authorization/policy.js
                 -> Tenant-scoped PostgreSQL repositories
           -> src/audit/audit-service.js
              -> src/persistence/postgres/audit-repository.js
                 -> PostgreSQL 18 append-only HMAC chain

Microsoft Entra ID (external and untrusted)
  -> src/identity/entra-client.js: OIDC protocol validation
     -> provider-neutral external identity
        -> Tenant claiming or JIT User resolution
           -> provider-neutral application session issuance

Microsoft identity platform / Microsoft Graph (external and untrusted)
  -> src/integrations/microsoft365-client.js: fixed destinations and bounded transport
     -> Tenant-scoped admin consent and base-permission verification
        -> src/application/microsoft365-connection-service.js
           -> PostgreSQL connection/consent state and audit evidence

Future Microsoft calendar capability adapters
  -> fixed Microsoft Graph endpoint templates
     -> validated provider-neutral calendar result
        -> existing booking integration service
```

Provider claims, Microsoft response bodies and provider SDK types do not cross into business services. The Entra adapter validates and maps external identity before session issuance. The Microsoft 365 connection client validates provider results before the application service sees them. Future Places, free/busy and calendar-event adapters must preserve the URL-free provider-neutral booking contract and the outbound controls defined by `docs/THREAT-MODEL.md`.

## Module responsibilities

- `src/config.js` owns runtime, database, Entra, Microsoft 365, session and audit-secret configuration with fail-closed Pilot/Production validation.
- `src/api-error.js` owns safe public error classification, including authorization concealment, audit-integrity failures and Microsoft 365 lifecycle errors.
- `src/domain/identifiers.js` owns stable internal UUID validation.
- `src/domain/request-workflow.js` owns canonical Request status and transition identifiers.
- `src/domain/request.js` validates canonical Request records returned from persistence.
- `src/security.js` owns generic HTTP-boundary validation, security headers, rate limiting, JSON validation and the transport Principal guard.
- `src/identity/principal.js` owns provider-neutral trusted-identity and internal-Principal shapes.
- `src/identity/entra-client.js` owns fixed-authority Entra authorization-code/PKCE handling and positive token/claim validation.
- `src/identity/entra-auth-service.js` owns one-time OIDC transaction orchestration, provider identity resolution and application-session issuance.
- `src/identity/provider-identity-resolver.js` routes validated external identities to Tenant claiming or JIT User resolution without exposing provider claims to business code.
- `src/identity/jit-user-service.js` maps an active Tenant identity binding and validated provider User reference to an internal User and server-controlled role/permission snapshot.
- `src/identity/session-cookie.js` owns strict `cm_session` parsing, serialization and cookie attributes.
- `src/identity/session-service.js` owns opaque token generation/hashing, CSRF derivation/verification, issuance, resolution, rotation and revocation.
- `src/onboarding/tenant-onboarding-service.js` owns invitation redemption, explicit Tenant claim confirmation, binding lifecycle and associated audit evidence.
- `src/tenancy/tenant.js` owns Tenant lifecycle semantics and the Tenant-owned resource inventory.
- `src/tenancy/tenant-context.js` resolves Tenant context exclusively from the authenticated Principal's internal Tenant ID.
- `src/tenancy/tenant-scoped-repository.js` enforces generic Tenant-scoped persistence ports.
- `src/authorization/policy.js` owns recognized Tenant roles/permissions, capability checks, object ownership, Request transition authorization and Tenant audit-read capability.
- `src/application/request-service.js` coordinates Tenant-scoped Request loading, authorization, optimistic workflow writes and correlated audit outcomes.
- `src/application/tenant-user-administration-service.js` owns authorized Tenant role reads/writes, last-admin protection and stale-session invalidation through User security versions.
- `src/application/microsoft365-connection-service.js` owns Tenant Admin authorization, Entra-binding corroboration, one-time consent state, connection verification, reconnect/disconnect and audit-safe public results.
- `src/http/microsoft365-routes.js` owns the strict same-origin Microsoft 365 HTTP contract, callback query allowlist and fixed result redirects.
- `src/integrations/microsoft365-client.js` owns fixed Microsoft identity/Graph origins, admin-consent URL construction, application-token acquisition, bounded provider transport and base-permission verification.
- `src/audit/event.js` owns the fixed event taxonomy, bounded secret-minimized event validation and canonical integrity payload.
- `src/audit/audit-service.js` derives Tenant, actor and time from trusted context, authorizes Tenant audit reads and records denial/read evidence.
- `src/entitlements/capabilities.js` owns stable product capability IDs and the authorization/entitlement/rollout intersection.
- `src/entitlements/entitlement-service.js` owns fail-closed Tenant capability evaluation and deny-by-default operator entitlement changes.
- `src/integrations/calendar-contract.js` owns the provider-neutral calendar port, response validation and stable provider failure taxonomy.
- `src/integrations/booking-reference.js` owns the opaque provider-reference persistence model.
- `src/application/booking-integration-service.js` coordinates authorized and entitled availability, reservation validation and idempotent calendar operations without provider-specific types.
- `src/persistence/postgres/pool.js` owns bounded PostgreSQL pooling, TLS policy and exact schema readiness.
- `src/persistence/postgres/session-repository.js` owns session persistence and authoritative expiry, revocation and security-version checks.
- `src/persistence/postgres/request-repository.js` owns Tenant-scoped Request lookup and status-conditional workflow updates.
- `src/persistence/postgres/audit-repository.js` owns per-Tenant append serialization, HMAC signing, Tenant-scoped listing and chain verification.
- `src/persistence/postgres/entitlement-repository.js` owns Tenant-scoped entitlement reads and audit-atomic entitlement changes.
- `src/persistence/postgres/booking-reference-repository.js` owns Tenant-scoped room-conflict lookup and audit-atomic opaque provider-reference persistence.
- `src/persistence/postgres/tenant-onboarding-repository.js` owns Tenant invitation, identity-binding and claim persistence.
- `src/persistence/postgres/jit-user-repository.js` owns internal User/provider binding persistence and profile synchronization.
- `src/persistence/postgres/tenant-user-admin-repository.js` owns Tenant role persistence, concurrency control and last-admin enforcement.
- `src/persistence/postgres/microsoft365-connection-repository.js` owns Tenant-scoped Microsoft 365 connection state, actor-bound one-time consent transactions, optimistic versions and audit-atomic lifecycle changes.
- `src/persistence/postgres/transaction.js` owns the common commit/rollback transaction boundary.
- `src/persistence/postgres/index.js` composes the PostgreSQL repositories and readiness checks.
- `scripts/db-migrations.mjs` owns source-controlled migration discovery, checksums, advisory locking and transactional up/down execution.
- `src/logger.js` owns bounded non-sensitive operational logs, separate from durable audit evidence.
- `src/app.js` composes transport, session, CSRF, Tenant, audit and application boundaries without importing PostgreSQL or provider SDKs.
- `src/index.js` is the runtime composition root and graceful-shutdown owner.
- `scripts/check-architecture.mjs` prevents architecture, migration and composition drift.
- `scripts/check-security-baseline.mjs` prevents drift between the documented Pilot/Production security baseline and executable controls.
- `scripts/security-dast.mjs` exercises the real HTTP server in isolated Test mode.
- `docs/ENTRA-AUTHENTICATION.md` defines the Entra authentication and Tenant-claiming contract.
- `docs/MICROSOFT365-CONNECTION.md` defines the Microsoft 365 connection lifecycle and provider trust boundary.
- `docs/THREAT-MODEL.md` is the canonical SaaS threat, control and residual-risk model.
- `docs/PRODUCTION-SECURE-CONFIGURATION.md` is the canonical Pilot/Production deployment security baseline.
- `docs/PILOT-PENETRATION-TEST.md` defines the independent Pilot security-assessment scope and exit criteria.

## Dependency direction

HTTP handlers call security, identity, Tenant, application and audit contracts. Application services call authorization/domain policies and repository/provider ports. Application, domain and authorization code must not depend on Node HTTP objects, `pg`, migrations, raw provider claims or provider SDK types.

PostgreSQL adapters implement repository contracts using fixed source-controlled SQL and parameter binding. Identity-provider adapters translate validated provider claims to internal identity contracts before business/session code sees them. Microsoft provider adapters construct fixed endpoint templates internally and translate validated provider results into bounded internal contracts before application services consume them.

Security governance and test scripts may inspect repository source and configuration, but they do not become runtime dependencies and must not introduce alternate business rules.

## Tenant and identity trust boundary

Tenant identity is never selected from a client header, query parameter, route parameter or body field. Session resolution produces an internal Principal; Tenant context loads the canonical Tenant using only `principal.tenantId`.

The internal Principal contains internal User/Tenant IDs, a normalized provider identity reference, approved roles/permissions and bounded session metadata. Provider-specific claim structures remain outside this contract.

The public session endpoint intentionally omits provider identity references, internal session IDs, token hashes and provider tokens.

Microsoft Entra remains external and untrusted until `src/identity/entra-client.js` validates OIDC signature, issuer, audience, state, nonce, time and organizational-account policy. The validated external Tenant/User references are then resolved through server-side Tenant identity bindings and JIT User persistence before an application session is issued. Email domains, display names, browser-selected Tenant IDs and raw Entra group claims are not authorization authority.

A Microsoft 365 connection is bound to the already claimed Entra Tenant. The callback provider Tenant value corroborates that binding and the one-time consent transaction; it never selects the internal Tenant.

## Authorization architecture

Business authorization is deny-by-default and occurs after Principal and Tenant resolution.

The recognized Tenant roles are `employee`, `conference_manager` and `tenant_admin`. `platform_admin` is intentionally outside this Tenant role model. Unknown roles or permissions invalidate the Principal for business authorization.

A capability requires both a recognized permission on the server Principal and a role allowed to use that permission. Role alone and permission alone are insufficient.

Request repositories always receive the server-resolved internal Tenant ID. Employee Request access additionally checks `request.requesterUserId === principal.userId`. Non-owned Employee objects and cross-Tenant IDs are concealed as not found to avoid BOLA/IDOR existence disclosure.

Conference Manager Request scope is the authenticated internal Tenant. Tenant Admin capabilities remain separate from Conference Manager Request operations. Tenant audit access requires `tenant:audit:read`; Tenant role administration requires `tenant:users:manage`; Microsoft 365 connection administration requires `tenant:integrations:manage`.

Request workflow transitions are server-defined. The browser selects only a transition identifier; the policy determines eligible current state, target state, role/permission requirement and reason rule. Persistence includes the previously authorized status so concurrent changes yield a conflict instead of a stale overwrite.

See `docs/AUTHORIZATION.md` for the complete role, permission and workflow matrix.

## Session architecture

The browser receives a 256-bit opaque `cm_session` cookie. Only SHA-256 of that token is persisted. Session resolution requires a matching non-revoked and non-expired row, active User, current User `security_version`, and session-available Tenant lifecycle state.

Cookie policy is `HttpOnly`, `SameSite=Lax`, `Path=/api`, no broad `Domain`, and `Secure` for HTTPS. Pilot/Production require HTTPS and therefore always use `Secure`.

Cookie-authenticated unsafe operations require an HMAC-derived synchronizer token supplied as `X-CSRF-Token`. Pilot/Production require the HMAC secret from deployment secret management.

Role/permission changes increment `users.security_version`. Existing sessions immediately fail resolution when their stored `principal_version` becomes stale. A server-authorized rotation can create a replacement session with the newly approved snapshot and revoke the previous session atomically.

Session issue, revoke and rotation construct server-controlled security events. The PostgreSQL session repository commits success evidence in the same transaction as the session mutation.

See `docs/IDENTITY-SESSION.md` for the normative flow.

## Audit architecture

Tenant audit evidence is a durable security/business data model, not an operational log stream.

`src/audit/event.js` accepts only a fixed action, outcome and retention taxonomy, server identifiers/timestamps and bounded flat primitive state/metadata. Credential-sensitive field names and nested values are rejected.

`src/persistence/postgres/audit-repository.js` serializes appends per internal Tenant using a transaction-scoped advisory lock. Each event is HMAC-SHA-256 signed over a canonical payload and the previous Tenant event hash. `GET /api/v1/audit` verifies the complete Tenant chain before returning records.

Migration 004 installs a database trigger that rejects `UPDATE` and `DELETE` against `audit_events`. This prevents ordinary mutation while the HMAC chain detects modified or reordered rows if the key remains protected.

The integrity model does not provide external completeness proof against privileged deletion of an entire suffix or restoration of an older database snapshot. External anchoring/WORM export and independent retention remain deployment/governance decisions before stronger completeness claims are made.

See `docs/AUDIT.md` for the normative event/integrity contract.

## Persistence lifecycle

Schema ownership lives in `migrations/`. Migrations are paired up/down files, numerically versioned, checksum protected and serialized by a PostgreSQL advisory lock.

The application never auto-migrates at startup. Deployment automation runs migrations first. Runtime readiness requires database connectivity and exact expected schema version 11.

- Migration 001 establishes Tenant-owned product structures.
- Migration 002 adds User security-version state and server-side sessions.
- Migration 003 constrains authoritative Request workflow state and adds workflow reason/change timestamps.
- Migration 004 upgrades audit storage to the append-only HMAC-chained event contract.
- Migration 005 adds allowlisted Tenant entitlements and entitlement audit taxonomy.
- Migration 006 adds Tenant-scoped opaque booking-provider references.
- Migration 007 adds one-time OIDC authentication transactions.
- Migration 008 adds Tenant onboarding invitations, Tenant identity claims and bindings.
- Migration 009 adds JIT User identity bindings.
- Migration 010 adds Tenant role administration and claimant bootstrap state.
- Migration 011 adds Microsoft 365 connection lifecycle state and actor-bound one-time admin-consent transactions.

Every migration that removes security/business evidence includes a fail-closed rollback guard.

## Microsoft 365 connection architecture

`src/application/microsoft365-connection-service.js` is the trusted use-case boundary for Microsoft 365 Tenant connection administration. It requires the authenticated internal Tenant Admin role, `tenant:integrations:manage`, the Principal-derived Tenant context and an active Entra Tenant binding.

The browser cannot supply an internal Tenant ID or provider Tenant authority. Consent state is 256-bit random data; only its SHA-256 hash is stored. The transaction is bound to internal Tenant, actor User, Integration, provider Tenant, optimistic connection version and expiry. Starting a new connection invalidates older pending consent state. Callback replay, actor mismatch, expiry, changed binding and stale connection versions fail closed.

The provider client uses fixed Microsoft identity and Graph origins, disables redirects, bounds request time and provider request/response size, validates provider response shapes and maps provider failures to stable internal classifications. The base connection verifies `Place.Read.All` and `Calendars.ReadBasic.All`; it does not claim calendar write access.

See `docs/MICROSOFT365-CONNECTION.md` for the normative contract.

## Booking and calendar integration architecture

`src/application/booking-integration-service.js` is an internal use-case boundary, not a browser endpoint. It preserves Employee/Conference Manager workflow semantics and requires same-active-Tenant binding, explicit server authorization and configured Tenant entitlement before provider access.

Availability and provisional/final reservation validation first apply the Tenant-scoped local overlap rule. Provider-specific room/resource mapping remains inside provider adapters. Calendar create uses a deterministic server-derived SHA-256 idempotency key so recovery after external success plus local persistence failure can reuse the same provider event instead of creating a duplicate.

Migration 006 persists only the internal Tenant/Request/Integration binding, opaque provider reference, idempotency key, state and correlation metadata. Local provider-reference mutations and `calendar.operation` evidence commit atomically. External provider work cannot participate in the PostgreSQL transaction; recovery uses idempotency rather than claiming distributed atomicity.

The Microsoft 365 connection lifecycle now establishes and verifies the Tenant connection boundary. Places discovery, room/resource mapping, free/busy, final availability enforcement and event create/update/cancel remain separate capability adapters tracked by SaaS 1 issues #64-#68. They must preserve fixed destinations, bounded transport, positive provider validation, least privilege, Tenant scoping, explicit retry classification and provider-neutral contracts.

See `docs/BOOKING-INTEGRATION.md` and `docs/MICROSOFT365-CONNECTION.md`.

## Foundation endpoints

- `GET /api/v1/health/live` proves only process liveness.
- `GET /api/v1/health/ready` exposes only `ready` or `not_ready`; PostgreSQL connectivity and exact schema version are dependencies.
- `GET /api/v1/health/status` exposes only aggregate operational and bounded build/environment state.
- `GET /api/v1/session` resolves the PostgreSQL-backed session, validates recognized roles/permissions and returns minimized presentation context plus CSRF token.
- `DELETE /api/v1/session` requires Principal and CSRF, revokes the session, persists audit evidence and clears the cookie.
- `GET /api/v1/requests/{requestId}` performs active-Tenant and object-level Request authorization.
- `POST /api/v1/requests/{requestId}/transitions` additionally requires CSRF and executes only a server-defined authorized transition.
- `GET /api/v1/audit` requires Tenant Admin plus `tenant:audit:read` and verifies Tenant audit integrity.
- `GET /api/v1/tenant/users` and `PUT /api/v1/tenant/users/{userId}/roles` expose Tenant-scoped role administration.
- `GET /api/v1/integrations/microsoft365` reads minimized Microsoft 365 connection state.
- `POST /api/v1/integrations/microsoft365/connect` starts actor-bound admin consent.
- `GET /api/v1/integrations/microsoft365/callback` validates and consumes the fixed callback contract.
- `POST /api/v1/integrations/microsoft365/verify` revalidates the base connection.
- `DELETE /api/v1/integrations/microsoft365` disconnects local connection state.

## Rate limiting and edge responsibility

The foundation rate limiter is local, in-memory and bounded. It is not a multi-instance quota service. Pilot/Production require trusted edge/shared abuse controls. Forwarded client-address headers are not currently trusted; introducing a trusted-proxy key model requires separate review.

## Production security release boundary

`docs/THREAT-MODEL.md` maps current and remaining Entra/Graph boundaries to concrete threats, OWASP/CWE classes, executable evidence and residual risks.

`docs/PRODUCTION-SECURE-CONFIGURATION.md` defines the Pilot/Production baseline for HTTPS/TLS, headers, cookies/CSRF, CORS, database TLS, secrets, provider egress, environment separation, observability and deployment blockers.

`npm run check` includes architecture, security-baseline, static, secret, dependency, style, unit and live HTTP DAST-smoke gates. PostgreSQL changes additionally require the PostgreSQL 18 integration job. These gates do not replace DAST against the actual Pilot edge or the independent penetration test defined in `docs/PILOT-PENETRATION-TEST.md`.

## Remaining SaaS 1 ownership

- Real independent Entra Tenant authentication and Tenant-claim acceptance evidence remains tracked by #58 and #59.
- The browser Tenant Admin Microsoft 365 connection surface remains cross-repository work in #62.
- Places discovery, room/resource mapping, free/busy, final availability enforcement and calendar event lifecycle remain #64-#68.
- Exchange Online Application RBAC and application-permission scope evidence remains #69.
- Connection health/recovery, activation workflow, isolation suite and operational runbook remain #70-#73.
- Production hosting/IaC, full frontend production API migration and production-like secure E2E evidence remain #113-#115.
- Platform Admin/developer operator Principal and audit APIs remain a separate authorization domain.
- External audit anchoring/WORM retention and selected-platform backup/restore evidence remain operational/governance decisions before stronger completeness or recovery claims are made.
