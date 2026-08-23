# Backend Architecture

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document describes the current implementation and does not override it.

The cross-repository production topology is defined in `floriankreutzer/conference-manager` by `docs/SAAS-PRODUCTION-TOPOLOGY.md`.

## Current foundation

The service uses Node.js 22 native HTTP and ECMAScript modules. SaaS 0 issue #47 deliberately introduces no third-party runtime dependency. This keeps the first trusted boundary small and auditable while the database, identity, and provider implementations remain owned by later issues.

A future dependency or HTTP framework may be introduced only by a scoped reviewed issue. It must preserve the contracts and trust boundaries in this repository instead of bypassing them.

```text
Browser (untrusted)
  -> same-origin HTTPS /api/*
     -> src/server.js: bounded Node HTTP server
        -> src/app.js: transport composition and route dispatch
           -> src/security.js: request boundary / principal / CSRF contracts
              -> future application/domain services
                 -> future repository / identity / integration ports
                    -> future infrastructure adapters
```

## Module responsibilities

- `src/config.js` owns runtime environment parsing and fail-closed production configuration.
- `src/api-error.js` owns safe API error classification.
- `src/security.js` owns HTTP-boundary validation primitives, security headers, bounded rate limiting, JSON body/schema validation, the internal principal shape, and the CSRF verification hook.
- `src/logger.js` owns structured operational logs and intentionally accepts only bounded non-sensitive metadata.
- `src/app.js` composes the request boundary and the foundation endpoints. It must remain transport-focused and must not absorb tenant/business/persistence logic.
- `src/server.js` owns Node HTTP server bounds/timeouts.
- `src/index.js` owns process startup and graceful shutdown only.

## API dependency direction

HTTP handlers may call application services and security policies. Application/domain code added later must not depend on Node HTTP request/response objects, database drivers, or provider-specific SDK types.

Provider-specific identity claims and Microsoft Graph objects will be translated at adapter boundaries. Database access will be behind repository contracts. Tenant and authorization rules will remain independently testable.

## Foundation endpoints

`GET /api/v1/health/live` proves only that the process can serve requests.

`GET /api/v1/health/ready` evaluates registered readiness functions with a timeout and exposes only `ready` or `not_ready`. Dependency names, connection strings, hostnames, credentials, and exception details are intentionally absent from the response.

`GET /api/v1/session` exercises the protected-principal contract. The default resolver returns no principal, so the endpoint fails closed until issue #50 installs the real server-side session/identity resolver. Returned data is limited to internal user ID, internal tenant ID, and roles required by the presentation layer; those values remain untrusted when later sent back by the browser.

## Principal and CSRF extension contracts

The principal resolver is injected into `createApp`. It must return the internal principal shape after server-side validation. Browser values cannot populate this contract directly.

The CSRF verifier is a separate injected function. `createPrincipalGuard().require(request, { csrf: true })` requires successful CSRF verification for POST/PUT/PATCH/DELETE. Issue #50 will bind it to the real server-side session/CSRF mechanism.

## Rate limiting

The foundation rate limiter is deliberately local/in-memory and bounded. It protects a single process and provides the hook point for endpoint limits.

It is not a multi-instance distributed quota solution and must not be described as one. Before horizontally scaled pilot use, the edge or a reviewed shared server-side limiter must provide trustworthy client-key semantics; untrusted `X-Forwarded-For` values must not be accepted directly.

## Deferred ownership

- #48: Tenant entity/context and hard tenant isolation.
- #49: Relational database, repositories, transactions, migrations, backup/restore strategy.
- #50: Real principal/session resolution, secure cookies, expiry/revocation/rotation, CSRF issuance/validation.
- #51: RBAC/object ownership/workflow authorization.
- #52: Append-only/tamper-evident audit persistence.
- #53: Tenant entitlements.
- #54: Provider-neutral booking/calendar integration contracts.
- #55: Production observability platform and SLO-oriented diagnostics.
- #57: Complete threat model and production secure-configuration baseline.
