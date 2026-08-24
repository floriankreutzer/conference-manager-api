# Production Secure Configuration Baseline

## Authority

Root `AGENTS.md` is authoritative. This document defines the minimum deployable security configuration for Pilot and Production. It is not an infrastructure-specific runbook; whichever hosting platform is selected must provide evidence that the equivalent controls are active.

The application must fail closed when security-sensitive configuration is missing or malformed. Production must never fall back to demo, in-memory, browser or unencrypted persistence authority.

## Deployment topology baseline

The supported browser deployment is logically same-origin:

```text
https://<public-host>/        -> frontend artifact
https://<public-host>/api/*   -> conference-manager-api
```

Required edge properties:

- HTTPS only for Pilot/Production; HTTP is redirected at the edge before application traffic is served.
- TLS certificate and hostname validation are mandatory. TLS 1.2 or newer is the minimum operational policy; prefer the platform's current secure TLS 1.3-capable profile.
- `/api/*` routes only to the trusted API service. User input cannot select an alternate upstream.
- CORS is not enabled for the normal browser path. Do not add wildcard or reflected `Access-Control-Allow-Origin` headers.
- Edge request/header/time limits must be equal to or stricter than the application limits where practical.
- A distributed/shared edge abuse-control policy is required for multi-instance Pilot/Production because the application limiter is process-local.
- The edge must not rewrite or inject Tenant/User/role/permission authority.
- Client-provided request/correlation identifiers may be forwarded for troubleshooting only if separately named; the application's `X-Request-Id` remains server-generated.
- `X-Forwarded-For` or similar forwarded client-address headers are not authorization inputs and are not currently trusted by the application limiter.

## Required runtime configuration

The application configuration parser is `src/config.js`. Values below are deployment configuration, not per-Tenant code changes.

| Variable | Pilot / Production baseline | Security rationale |
| --- | --- | --- |
| `NODE_ENV` | `pilot` or `production` | Enables fail-closed production requirements |
| `SERVICE_VERSION` | Required, 1-64 safe identifier chars | Support/release evidence; no secret/Tenant names |
| `BUILD_ID` | Required, 1-64 safe identifier chars | Deployment traceability; no secret/Tenant names |
| `PUBLIC_ORIGIN` | Required exact `https://` origin, no path/query/credentials | Host/Origin validation and same-origin trust boundary |
| `HOST` | Platform-controlled bind address | Runtime binding only; not public authority |
| `PORT` | 1-65535, platform-controlled | Bounded listener configuration |
| `MAX_BODY_BYTES` | Default 65536; max 1048576 | Request exhaustion bound |
| `MAX_RESPONSE_BYTES` | Default 1048576; max 4194304 | Response exhaustion / accidental data exposure bound |
| `RATE_LIMIT_MAX` | Default 120; tune from Pilot evidence | Process-local defense-in-depth only |
| `RATE_LIMIT_WINDOW_MS` | Default 60000 | Bounded rate window |
| `REQUEST_TIMEOUT_MS` | Default 15000; max 120000 | Slow-request bound |
| `HEADERS_TIMEOUT_MS` | Default 10000; max 60000 | Slowloris/header bound |
| `KEEP_ALIVE_TIMEOUT_MS` | Default 5000; max 60000 | Connection-resource bound |
| `READINESS_TIMEOUT_MS` | Default 1000; max 10000 | Dependency-health bound |
| `SESSION_TTL_SECONDS` | Default 28800; max 86400 | Session lifetime bound; shorter values preferred for Pilot/admin flows where usable |
| `DATABASE_URL` | Required from protected deployment secret/config | Authoritative PostgreSQL endpoint/credential reference |
| `DATABASE_SSL` | Exactly `verify-full` | Certificate + hostname verified database TLS |
| `DATABASE_POOL_MAX` | Default 10; max 50 | Database resource bound |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Default 5000; max 30000 | Connect bound |
| `DATABASE_IDLE_TIMEOUT_MS` | Default 30000; max 300000 | Idle connection bound |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Default 10000; max 120000 | Query/resource bound |
| `CSRF_SECRET` | Required, externally managed, 32-512 bytes | Session-bound HMAC synchronizer token secret |
| `AUDIT_HMAC_SECRET` | Required, externally managed, stable, 32-512 bytes | Audit integrity chain key |

The checked-in `.env.example` is a development template only. Pilot/Production values must come from the deployment platform's protected configuration/secret mechanism.

## Secrets and credential handling

Secrets include at minimum:

- PostgreSQL credentials/connection secret material;
- `CSRF_SECRET`;
- `AUDIT_HMAC_SECRET`;
- future Entra application/client credentials;
- future Microsoft Graph access/refresh tokens or credential references;
- future signing/private keys.

Rules:

1. Never commit secrets to Git, test fixtures, images, workflow YAML, documentation examples, browser code or issue/PR text.
2. Production/Pilot secrets are separate from development/test and from each other.
3. Application logs, metrics, audit metadata and public errors must not contain secret values.
4. Secret rotation must preserve service semantics. `CSRF_SECRET` rotation invalidates current CSRF material and therefore requires coordinated session handling.
5. `AUDIT_HMAC_SECRET` must not be rotated as an ordinary secret change. Existing audit records depend on it; rotation requires a reviewed integrity checkpoint/migration strategy.
6. Future provider access/refresh tokens remain server-side and are never placed in LocalStorage/sessionStorage.
7. Secret-store access is least-privilege to the runtime identity and deployment automation that requires it.

## HTTP security baseline

`src/security.js` is the application control owner. Pilot/Production responses must preserve:

- `Cache-Control: no-store`;
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`;
- `Cross-Origin-Opener-Policy: same-origin`;
- `Cross-Origin-Resource-Policy: same-origin`;
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY`;
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` in Pilot/Production.

The API does not emit HTML. The default-deny CSP therefore protects the API origin without needing script/style exceptions. Frontend CSP remains owned by the frontend/edge deployment and must not be weakened to satisfy the API.

Request hardening must preserve:

- method allowlist: GET, POST, PUT, PATCH, DELETE;
- rejection of absolute/protocol-relative request targets, traversal, malformed percent encoding and encoded path separators;
- strict JSON content type for JSON bodies;
- rejection of compressed request bodies until a bounded decompression policy exists;
- positive-schema validation and unknown-field rejection for state-changing payloads;
- exact Host match and exact match for any present Origin;
- bounded request/response/header/connection processing.

## Session and CSRF baseline

The application session cookie is `cm_session` and must preserve:

- `HttpOnly`;
- `Secure` for Pilot/Production;
- `SameSite=Lax`;
- `Path=/api`;
- no broad `Domain` attribute;
- bounded `Max-Age` backed by server-side expiry/revocation.

Cookie authentication does not replace CSRF protection. Every protected POST/PUT/PATCH/DELETE operation must require a valid server-generated/session-bound CSRF token unless a reviewed endpoint is explicitly designed without cookie authentication.

The browser may hold the CSRF token in runtime memory. It must not persist the session credential or provider tokens in LocalStorage/sessionStorage.

## Database baseline

- PostgreSQL 18 is authoritative production persistence for the current baseline.
- Pilot/Production use `DATABASE_SSL=verify-full` and a hostname/certificate-valid connection endpoint.
- SQL application values remain parameterized; do not interpolate client values into SQL text.
- Migrations are applied by deployment automation before application rollout; the application does not auto-migrate at startup.
- Readiness requires database connectivity and the exact expected schema version.
- Tenant ownership/referential integrity remains reinforced at database level where practical.
- Backups, restore tests, rollback evidence and retention are deployment responsibilities. A Pilot readiness decision requires evidence that restore is tested against the selected hosting platform.

## CORS, redirects and callbacks

Normal browser operation is same-origin and requires no CORS response headers. Introducing cross-origin browser API access is an architecture change.

The current API exposes no general redirect endpoint. Future Entra callbacks must use an exact server-configured registered redirect URI; browser query/body data cannot select the post-authentication authority or arbitrary redirect target.

Future outbound provider redirects are disabled by default or restricted to an explicit server-side allowlist and revalidated on each hop.

## Microsoft Entra and Graph secure configuration

These settings become mandatory only when the corresponding SaaS 1 adapter is implemented. Their absence in SaaS 0 is not an error because the adapters are not enabled.

Entra baseline:

- separate application registration for Pilot and Production;
- fixed tenant/authority policy appropriate to the onboarding model;
- exact redirect URI per environment;
- least-privilege application permissions/scopes;
- provider client credential or certificate in managed secret storage;
- issuer, audience, signature, state, nonce and time validation;
- explicit mapping from approved provider identity to internal Tenant/User records.

Graph baseline:

- fixed/allowlisted Microsoft Graph origin(s) and endpoint templates;
- least-privilege permissions for enabled capabilities only;
- server-side credential/token handling;
- explicit connect/read/write timeouts;
- bounded retry policy for safe/idempotent operations only;
- throttling handling without unbounded retry;
- provider response validation before business use;
- no user-controlled URL, provider reference or integration secret as authority.

## Logging, metrics and audit

Operational logging follows `docs/OBSERVABILITY.md`:

- structured JSON to stdout for collection;
- server-generated correlation ID;
- fixed route keys, not dynamic paths;
- no Tenant ID, User ID, session/cookie/CSRF values, provider tokens/references, connection strings or raw provider bodies;
- bounded low-cardinality metrics only.

Business/security audit follows `docs/AUDIT.md` and is separate from normal logs. Tenant-visible audit reads remain Tenant-scoped and integrity-verified.

## SAST, SCA, dependency and secret controls

Repository release controls are:

- SAST-oriented repository check: `npm run check:static` plus architecture-specific gates;
- SCA/high-severity vulnerability blocking: `npm run audit`;
- dependency/lock/license/lifecycle policy: `npm run check:dependencies` and the `Dependency Policy` workflow;
- source/high-confidence secret checks: `npm run check:secrets`;
- full-history secret scanning: Gitleaks `Secret Scan` workflow;
- deterministic locked install: `npm ci --ignore-scripts --no-fund`;
- pinned GitHub Actions by commit SHA.

GitHub-native Dependency Review/CodeQL capabilities depend on repository/account security entitlements. The enforced repository-local gates are the current equivalent controls and must not be removed merely because a native feature is unavailable.

## Dynamic security testing

Two DAST levels are required:

1. `npm run test:dast` is the repository release smoke gate. It starts the real HTTP server in isolated Test mode and verifies transport/security behavior through real HTTP requests, including Host/Origin, methods, request targets, security headers, CSRF, JSON validation/size limits and safe error responses.
2. Before an external Pilot readiness decision, run an authenticated DAST scan against the deployed non-production/Pilot candidate environment. It must cover all externally reachable routes, the actual edge/TLS/header configuration and the enabled Entra/Graph flows. Findings are triaged and high/critical findings block readiness unless an explicit risk decision exists.

A local DAST smoke test does not prove the selected cloud edge, TLS policy, WAF/rate limiting or provider registration is configured correctly.

## Environment separation

Development, Test, Pilot and Production must use separate data/credentials appropriate to their purpose.

- Never copy Production credentials into automated Test or developer environments.
- Pilot and Production use separate provider registrations/secrets unless an explicit reviewed architecture decision states otherwise.
- Pilot and Production databases are separate unless a reviewed data-promotion/migration plan exists.
- Test tenants intentionally include at least two independent tenants so cross-Tenant negative tests can execute.
- Production data is not used as generic security-test data.

## Deployment preflight

Before marking a Pilot/Production release candidate ready:

1. Confirm the release commit/PR has all required repository checks green.
2. Run `npm ci --ignore-scripts --no-fund`.
3. Run `npm run check`.
4. Run `npm run audit`.
5. Run PostgreSQL integration/migration tests against the supported database version when persistence changed.
6. Confirm Secret Scan and Dependency Policy passed for the final commit.
7. Supply `NODE_ENV`, HTTPS `PUBLIC_ORIGIN`, `SERVICE_VERSION`, `BUILD_ID`, database configuration and required secrets from protected deployment configuration.
8. Apply migrations before rollout and verify readiness reports only aggregate safe state.
9. Verify edge TLS, HSTS/header preservation, `/api/*` routing, distributed/shared rate limiting and no wildcard CORS.
10. Run deployed-environment DAST and the Pilot penetration-test scope before the external Pilot readiness decision.
11. Record backup/restore evidence and rollback owner/procedure for the selected hosting/database platform.

## Fail-closed deployment blockers

Do not deploy as Pilot/Production when any of the following is true:

- `PUBLIC_ORIGIN` is missing or not HTTPS;
- PostgreSQL is missing or TLS is not `verify-full`;
- `CSRF_SECRET`, `AUDIT_HMAC_SECRET`, release version or build ID is missing/invalid;
- required migrations/schema readiness are not current;
- required repository security/test checks are failing or pending;
- Tenant isolation tests for a changed Tenant-owned resource are absent/failing;
- enabled outbound provider destinations are not fixed/allowlisted or lack timeout/response validation;
- high/critical unresolved dependency, DAST or penetration-test findings lack an explicit approved risk decision;
- deployment would re-enable browser storage, client roles or client Tenant values as production authority.
