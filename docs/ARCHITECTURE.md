# Backend Architecture

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document describes the current implementation and does not override it.

The cross-repository production topology is defined in `floriankreutzer/conference-manager` by `docs/SAAS-PRODUCTION-TOPOLOGY.md`.

## Current foundation

The service uses Node.js 22 native HTTP and ECMAScript modules. SaaS 0 issues #47 and #48 deliberately introduce no third-party runtime dependency. This keeps the trusted boundary small and auditable while database, identity-provider and external-provider implementations remain owned by later issues.

A future dependency or HTTP framework may be introduced only by a scoped reviewed issue. It must preserve the contracts and trust boundaries in this repository instead of bypassing them.

```text
Browser (untrusted)
  -> same-origin HTTPS /api/*
     -> src/server.js: bounded Node HTTP server
        -> src/app.js: transport composition and route dispatch
           -> src/security.js: request boundary / principal / CSRF contracts
           -> src/tenancy/tenant-context.js: principal-derived Tenant context
              -> future application/domain services
                 -> src/tenancy/tenant-scoped-repository.js: tenant-scoped repository contract
                    -> future relational repository adapters
```

## Module responsibilities

- `src/config.js` owns runtime environment parsing and fail-closed production configuration.
- `src/api-error.js` owns safe API error classification and maps approved tenancy errors to safe transport codes.
- `src/domain/identifiers.js` owns stable internal UUID validation used across principal and Tenant boundaries.
- `src/security.js` owns HTTP-boundary validation primitives, security headers, bounded rate limiting, JSON body/schema validation, the internal principal shape, and the CSRF verification hook.
- `src/tenancy/tenant.js` owns the canonical Tenant record, lifecycle states and the tenant-owned resource inventory.
- `src/tenancy/tenant-context.js` resolves Tenant context exclusively from the authenticated principal's internal Tenant ID.
- `src/tenancy/tenant-scoped-repository.js` enforces the tenant-scoped persistence port shape for tenant-owned resources.
- `src/logger.js` owns structured operational logs and intentionally accepts only bounded non-sensitive metadata.
- `src/app.js` composes transport/security/Tenant boundaries. It must remain transport-focused and must not absorb business or persistence logic.
- `src/server.js` owns Node HTTP server bounds/timeouts.
- `src/index.js` owns process startup and graceful shutdown only.

## Dependency direction

HTTP handlers may call application services and security/tenancy policies. Application/domain code must not depend on Node HTTP request/response objects, database drivers, or provider-specific SDK types.

Provider-specific identity claims and Microsoft Graph objects are translated at adapter boundaries. Provider tenant identifiers never become internal ownership identifiers. Database access remains behind repository contracts. Tenant and authorization rules remain independently testable.

## Tenant isolation boundary

Tenant identity is not read from a client header, query parameter, route parameter or body field. The internal principal is validated first; `createTenantContextGuard` then loads the canonical Tenant using only `principal.tenantId`.

The canonical Tenant has an internal UUID and contains no Microsoft Entra tenant ID or other provider identity. Provider bindings remain separate records so external identifiers cannot substitute for ownership checks.

The lifecycle states are `pending`, `onboarding`, `ready`, `active`, `suspended`, and `archived`. Session/onboarding context is available only for pending/onboarding/ready/active tenants. Productive business access requires `active`. Suspended and archived tenants fail closed.

Tenant-owned repository operations are scoped by construction. The adapter contract has no unscoped `findById`, `updateById`, or `deleteById` operation. Tenant ID is supplied as a server-side context parameter, not inside mutation payloads, and returned resources are revalidated against the requested tenant.

See `docs/TENANCY.md` for the normative ownership inventory, lifecycle semantics, deletion/disable behavior and #49 persistence requirements.

## Foundation endpoints

`GET /api/v1/health/live` proves only that the process can serve requests.

`GET /api/v1/health/ready` evaluates registered readiness functions with a timeout and exposes only `ready` or `not_ready`. Dependency names, connection strings, hostnames, credentials, and exception details are intentionally absent from the response.

`GET /api/v1/session` first resolves the authenticated principal and then verifies the canonical Tenant. The default principal resolver returns no principal, so the endpoint still fails closed until #50 installs the real server-side session/identity resolver. A resolved response exposes only internal user ID, internal Tenant ID, Tenant lifecycle status and roles required by the presentation layer.

Client-supplied Tenant values do not influence this endpoint and remain untrusted if later sent back by the browser.

## Principal and CSRF extension contracts

The principal resolver is injected into `createApp`. It must return the internal principal shape after server-side validation. Browser values cannot populate this contract directly.

The CSRF verifier is a separate injected function. `createPrincipalGuard().require(request, { csrf: true })` requires successful CSRF verification for POST/PUT/PATCH/DELETE. Issue #50 will bind it to the real server-side session/CSRF mechanism.

## Rate limiting

The foundation rate limiter is deliberately local/in-memory and bounded. It protects a single process and provides the hook point for endpoint limits.

It is not a multi-instance distributed quota solution and must not be described as one. Before horizontally scaled pilot use, the edge or a reviewed shared server-side limiter must provide trustworthy client-key semantics; untrusted `X-Forwarded-For` values must not be accepted directly.

## Deferred ownership

- #49: Relational database, tenant-aware constraints, repositories, transactions, migrations and backup/restore strategy.
- #50: Real principal/session resolution, secure cookies, expiry/revocation/rotation and CSRF issuance/validation.
- #51: RBAC/object ownership/workflow authorization on top of the tenant boundary.
- #52: Append-only/tamper-evident tenant-scoped audit persistence.
- #53: Tenant entitlements.
- #54: Provider-neutral booking/calendar integration contracts.
- #55: Production observability platform and SLO-oriented diagnostics.
- #57: Complete threat model and production secure-configuration baseline.
