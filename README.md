# Conference Manager API

Trusted production backend for the Conference Manager SaaS application.

## Scope

This repository owns the server-side trust boundary defined by the frontend architecture decision in `conference-manager/docs/SAAS-PRODUCTION-TOPOLOGY.md`.
The browser remains untrusted. Production authorization, tenant isolation, persistence, audit, entitlements, booking integrity, identity adapters, and external integration credentials are server-side responsibilities.

The SaaS 0 / issues #47 and #48 foundation currently provides:

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
- canonical internal Tenant entity and lifecycle states;
- Tenant context resolved exclusively from the authenticated server-side principal;
- fail-closed suspended/archived Tenant handling;
- explicit tenant-owned resource inventory;
- tenant-scoped repository contract without unscoped object lookup/update/delete methods;
- client Tenant-field manipulation rejection and returned-resource ownership validation;
- CSRF verification hook for future cookie-authenticated state-changing endpoints;
- safe structured operational logging without copying authorization/cookie headers;
- regression, progression and adversarial tests including cross-tenant read/update/delete, manipulated Tenant selectors, guessed IDs and concurrent tenants.

Relational persistence, real session resolution, RBAC/object-ownership policy, audit persistence, and provider integrations are intentionally not implemented yet because they belong to SaaS 0 issues #49-#54.

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
- `GET /api/v1/session` — protected principal/Tenant-context contract. It returns `401` without a server principal and `403` for unknown, suspended or archived Tenant context.

Client-provided Tenant headers, parameters or body fields do not establish Tenant context. See `docs/TENANCY.md` for the lifecycle, ownership and repository rules.

See `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/TENANCY.md`.

## Required validation

```bash
npm run check
npm run audit
```

CI uses `npm ci --ignore-scripts --no-fund`, then runs the audit and quality gate. The separate Dependency Policy workflow revalidates the locked dependency graph, exact direct versions, license policy, lifecycle-script policy, and high-severity vulnerability audit. Full-history Gitleaks scanning is an additional pull-request/security gate.

GitHub's native Dependency Review action is not available for this private user-owned repository without GitHub Code Security/Advanced Security. The repository-local Dependency Policy gate is therefore the enforced supply-chain review control. If the repository later gains native Dependency Review capability, it should be enabled in addition to this gate or replace it only after equivalent coverage is demonstrated.
