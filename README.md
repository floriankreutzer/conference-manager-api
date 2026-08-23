# Conference Manager API

Trusted production backend for the Conference Manager SaaS application.

## Scope

This repository owns the server-side trust boundary defined by the frontend architecture decision in `conference-manager/docs/SAAS-PRODUCTION-TOPOLOGY.md`.
The browser remains untrusted. Production authorization, tenant isolation, persistence, audit, entitlements, booking integrity, identity adapters, and external integration credentials are server-side responsibilities.

The SaaS 0 / issue #47 foundation currently provides:

- Node.js 22 native HTTP runtime with no third-party runtime dependencies;
- same-origin `/api/*` policy with host and Origin validation;
- server-generated correlation/request IDs;
- secure JSON error envelopes without stack/configuration disclosure;
- liveness and readiness endpoints;
- response/request size and timeout bounds;
- security headers and HSTS for pilot/production mode;
- bounded in-memory rate-limit extension point;
- positive JSON-object/schema validation primitives;
- provider-neutral internal principal guard;
- CSRF verification hook for future cookie-authenticated state-changing endpoints;
- safe structured operational logging without copying authorization/cookie headers;
- regression, progression, malformed-input, origin/host/traversal, readiness, principal, CSRF, and rate-limit tests.

Tenant persistence, real session resolution, tenant isolation, RBAC policy, audit persistence, and provider integrations are intentionally not implemented here because they belong to SaaS 0 issues #48-#54.

## Run locally

```bash
cp .env.example .env
set -a
. ./.env
set +a
npm start
```

The default development origin is `http://localhost:3000`.

## API foundation

- `GET /api/v1/health/live` — process liveness; no configuration details.
- `GET /api/v1/health/ready` — readiness aggregate; returns `503` when a registered readiness dependency fails or times out.
- `GET /api/v1/session` — protected principal-context contract. It fails closed with `401` until the server-side principal resolver is supplied by the session/identity implementation.

See `docs/API.md`, `docs/ARCHITECTURE.md`, and `docs/SECURITY.md`.

## Required validation

```bash
npm run check
npm run audit
```

CI uses `npm ci --ignore-scripts --no-fund`, then runs the audit and quality gate. Dependency Review and full-history secret scanning are separate pull-request/security gates.
