# Production Secure Configuration Baseline

## Authority

Root `AGENTS.md` is authoritative. This document defines the minimum deployable security configuration for Pilot and Production. It is not an infrastructure-specific runbook; the selected hosting platform must provide evidence that equivalent controls are active.

The application must fail closed when security-sensitive configuration is missing or malformed. Production must never fall back to demo, in-memory, browser or unencrypted persistence authority.

## Deployment topology baseline

The supported browser deployment is logically same-origin:

```text
https://<public-host>/        -> frontend artifact
https://<public-host>/api/*   -> conference-manager-api
```

Required edge properties:

- HTTPS only for Pilot/Production; HTTP redirects before application traffic is served.
- TLS certificate and hostname validation are mandatory. TLS 1.2 or newer is the minimum; prefer the platform's current TLS 1.3-capable profile.
- `/api/*` routes only to the trusted API service. User input cannot select an alternate upstream.
- CORS is not enabled for the normal browser path. Do not add wildcard or reflected `Access-Control-Allow-Origin`.
- Edge request, header and time limits should be equal to or stricter than application limits.
- Distributed/shared edge abuse control is required for multi-instance Pilot/Production because the application limiter is process-local.
- The edge must not rewrite or inject Tenant, User, role, permission or provider authority.
- The application's `X-Request-Id` remains server-generated.
- Forwarded client-address headers are not authorization inputs and are not currently trusted by the application limiter.

## Required runtime configuration

The parser is `src/config.js`. Values below are protected deployment configuration, not per-Tenant code changes.

| Variable | Pilot / Production baseline | Security rationale |
| --- | --- | --- |
| `NODE_ENV` | `pilot` or `production` | Enables fail-closed production requirements |
| `SERVICE_VERSION` | Required, 1-64 safe identifier chars | Release evidence without secrets/Tenant names |
| `BUILD_ID` | Required, 1-64 safe identifier chars | Deployment traceability |
| `PUBLIC_ORIGIN` | Required exact `https://` origin, no path/query/credentials | Host/Origin validation, callbacks and same-origin boundary |
| `HOST` | Platform-controlled bind address | Runtime binding only |
| `PORT` | 1-65535 | Bounded listener configuration |
| `MAX_BODY_BYTES` | Default 65536; max 1048576 | Request exhaustion bound |
| `MAX_RESPONSE_BYTES` | Min 786432; default 1048576; max 4194304 | Guarantees one legal Request-v2 projection while byte-aware pages remain below the configured/frontend bound |
| `RATE_LIMIT_MAX` | Default 120 | Process-local defense-in-depth |
| `RATE_LIMIT_WINDOW_MS` | Default 60000 | Bounded rate window |
| `REQUEST_TIMEOUT_MS` | Default 15000; max 120000 | Slow-request bound |
| `HEADERS_TIMEOUT_MS` | Default 10000; max 60000 | Slow-header bound |
| `KEEP_ALIVE_TIMEOUT_MS` | Default 5000; max 60000 | Connection-resource bound |
| `READINESS_TIMEOUT_MS` | Default 1000; max 10000 | Dependency-health bound |
| `SESSION_TTL_SECONDS` | Default 28800; max 86400 | Server-side session lifetime |
| `DATABASE_URL` | Required protected connection value | Authoritative PostgreSQL endpoint and credential reference |
| `DATABASE_SSL` | Exactly `verify-full` | Certificate and hostname verified database TLS |
| `DATABASE_POOL_MAX` | Default 10; max 50 | Database resource bound |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Default 5000; max 30000 | Connect bound |
| `DATABASE_IDLE_TIMEOUT_MS` | Default 30000; max 300000 | Idle connection bound |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Default 10000; max 120000 | Query/resource bound |
| `CSRF_SECRET` | Required, externally managed, 32-512 bytes | Session-bound HMAC synchronizer token |
| `AUDIT_HMAC_SECRET` | Required, externally managed, stable, 32-512 bytes | Audit integrity chain key |
| `ENTRA_CLIENT_ID` | Required GUID | Pilot/Production Entra application identifier |
| `ENTRA_CLIENT_SECRET` | Required protected secret, 32-512 bytes | Confidential-client authentication |
| `OIDC_TRANSACTION_SECRET` | Required protected secret, 32-512 bytes | OIDC browser-transaction binding integrity |
| `OIDC_TRANSACTION_TTL_SECONDS` | Default 600; 120-900 | Bounded one-time authentication transaction |
| `MICROSOFT365_CONSENT_TTL_SECONDS` | Default 600; 120-900 | Bounded actor/Tenant-bound admin-consent state |
| `MICROSOFT365_GRAPH_TIMEOUT_MS` | Default 10000; 1000-30000 | Microsoft identity/Graph outbound request bound |

The Entra authority is fixed to the Microsoft organizational-account authority. The Entra callback URI is derived from `PUBLIC_ORIGIN` as `/api/v1/auth/microsoft/callback`; it is not supplied by the browser. The Microsoft 365 admin-consent callback is likewise fixed under the same public origin.

The checked-in `.env.example` is a development template only. Pilot/Production values must come from the deployment platform's protected configuration or secret mechanism.

## Secrets and credential handling

Secrets include at minimum:

- PostgreSQL credential material;
- `CSRF_SECRET`;
- `AUDIT_HMAC_SECRET`;
- `ENTRA_CLIENT_SECRET`;
- `OIDC_TRANSACTION_SECRET`;
- Microsoft access tokens acquired by the server;
- future signing/private keys.

Rules:

1. Never commit secrets to Git, fixtures, images, workflow YAML, documentation examples, browser code or issue/PR text.
2. Development, Test, Pilot and Production credentials are separate.
3. Logs, metrics, audit metadata and public errors must not contain secrets, raw OIDC state, consent state or provider response bodies.
4. `CSRF_SECRET` rotation invalidates current CSRF material and requires coordinated session handling.
5. `AUDIT_HMAC_SECRET` rotation requires a reviewed integrity checkpoint/migration strategy because existing audit records depend on it.
6. Provider access tokens remain server-side and are never placed in LocalStorage/sessionStorage or returned through public APIs.
7. Secret-store access is least-privilege to the runtime identity and deployment automation that requires it.
8. Entra client-secret rotation must be rehearsed in Pilot and must include provider verification, session/authentication behavior and rollback evidence.

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
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

The API emits JSON, not HTML. Frontend CSP remains owned by the frontend/edge deployment and must not be weakened to satisfy the API.

Request hardening must preserve:

- method allowlist: GET, POST, PUT, PATCH, DELETE;
- rejection of absolute/protocol-relative targets, traversal, malformed percent encoding and encoded path separators;
- strict JSON content type for JSON bodies;
- rejection of compressed request bodies until a bounded decompression policy exists;
- positive-schema validation and unknown-field rejection;
- exact Host match and exact match for any present Origin;
- bounded request, response, header and connection processing.

## Session and CSRF baseline

The `cm_session` cookie must preserve:

- `HttpOnly`;
- `Secure` for Pilot/Production;
- `SameSite=Lax`;
- `Path=/api`;
- no broad `Domain`;
- bounded `Max-Age` backed by the current source-controlled Customer authorization-epoch hash, server-side expiry, revocation and User security version.

Every protected POST, PUT, PATCH and DELETE operation using cookie authentication requires a valid server-generated, session-bound CSRF token unless a reviewed endpoint is explicitly designed without cookie authentication.

The browser may hold the CSRF token in runtime memory. It must not persist the session credential, provider tokens, roles, permissions or Tenant authority in browser storage.

## Customer authorization-epoch rollout and emergency rollback

The Customer session hash namespace is fixed in source as `customer-session:saas-3.6-role-policy-v1:<raw-token>`. The epoch is non-secret application policy, not an environment variable, Tenant setting or secret. Never reuse or move an epoch backward. Per-User assignment changes continue to use `users.security_version`; a global role-policy semantic change advances the source epoch and ships a matching one-way revocation migration.

Forward rollout across migration 034 is a global reauthentication event:

1. block new Customer traffic and drain every old-epoch customer instance;
2. apply the reviewed canonical migration sequence through 042 (including 034 when not already applied) and retain its ledger/checksum plus protected pre/post active-session counts;
3. deploy the whole new-epoch customer fleet; mixed old/new customer instances are prohibited;
4. require exact schema-42 readiness before resuming traffic;
5. prove a captured pre-cutover cookie returns unauthenticated and a fresh sign-in returns only current roles/permissions.

The following schema-33/034 rollback describes the historical authorization-epoch transition only. It is not a supported direct downgrade of the current schema-42 database. Current recovery requires a reviewed immutable schema-compatible binary or forward fix; every required down-migration guard and whole-fleet/session-invalidation check must pass before any separately approved downgrade.

Emergency binary rollback must also block Customer traffic and drain the fleet. Run the migration-034 down bookkeeping step, whose SQL deliberately never clears `revoked_at`, then deploy the schema-33-compatible old binary. Pre-cutover legacy rows remain revoked, and new-epoch rows are unresolvable by the old token hash; users must sign in again after traffic resumes. Before a later forward deploy, block traffic and reapply migration 034 so every rollback-window session is revoked.

A restore or PITR target from before migration 034 must not receive Customer traffic. Apply the complete current canonical migrations through 042, including the 034 revocation boundary, deploy one epoch-consistent fleet and repeat the old-cookie/fresh-login checks first. Clearing revocations, rewriting hashes, serving a mixed fleet or merely redeploying old refs without this procedure is a release blocker.

Migration 034 has no authenticated per-session actor and must not fabricate Tenant `session.revoked` events. Store the migration checksum/ledger, release SHA, active-session counts, traffic-drain approval, negative old-cookie result and fresh-Principal verification in protected deployment evidence.

## Database baseline

- PostgreSQL 18 is authoritative production persistence.
- Pilot/Production use `DATABASE_SSL=verify-full` with a certificate/hostname-valid endpoint.
- SQL application values remain parameterized.
- Deployment automation applies migrations before application rollout; startup does not auto-migrate.
- Readiness requires connectivity and exact repository-defined schema version 42.
- Tenant ownership and referential integrity are reinforced at database level.
- Advisory locks and optimistic versions protect concurrent security/business transitions.
- Migration rollback guards prevent silent removal of security/business evidence.
- Backups, restore tests, retention and point-in-time recovery evidence are deployment responsibilities.

## CORS, redirects and callbacks

Normal browser operation is same-origin and requires no CORS response headers. Cross-origin browser API access is an architecture change.

Entra and Microsoft 365 callbacks use exact server-controlled paths. Browser query/body data cannot select post-authentication authority or an arbitrary redirect destination.

Entra and Microsoft 365 result redirects are fixed same-origin paths. Provider error descriptions are never reflected into redirect URLs or public JSON.

Outbound provider redirects are disabled. Enabling any redirect requires an explicit allowlist and revalidation on every hop.

## Microsoft Entra secure configuration

Pilot and Production require:

- separate Entra application registrations and credentials unless an explicit reviewed exception exists;
- organizational-account support appropriate to the multi-Tenant onboarding model;
- exact environment-specific redirect URI matching `PUBLIC_ORIGIN` plus `/api/v1/auth/microsoft/callback`;
- authorization-code flow with PKCE;
- server-side confidential-client credential from managed secret storage;
- issuer, audience, signature, state, nonce and time validation;
- explicit mapping from validated provider identity to internal Tenant/User records;
- no role derivation from email domain, display name or unreviewed group claims;
- no provider token or application session in browser storage;
- registration owners, credential expiry and rotation alerts recorded in the operational runbook.

Real Tenant acceptance must include independent Entra Tenants, wrong-Tenant and personal-account rejection, invalid/replayed callback behavior and credential revocation/rotation.

## Microsoft 365 and Microsoft Graph secure configuration

The base Microsoft 365 connection uses the same reviewed confidential application registration and verifies only:

- `Place.Read.All` application permission;
- `Calendars.ReadBasic.All` application permission.

Required controls:

- Tenant-specific Microsoft admin-consent endpoint with Microsoft Graph `/.default`;
- exact callback URI under `PUBLIC_ORIGIN`;
- active internal Entra Tenant binding before connection;
- fixed Microsoft identity and Graph origins;
- no user-controlled URL, Tenant, mailbox or provider resource authority;
- actor/Tenant-bound one-time consent state with bounded expiry;
- disabled redirects;
- `MICROSOFT365_GRAPH_TIMEOUT_MS` and bounded response size;
- positive provider response validation;
- stable provider-error classification without raw response disclosure;
- server-side application-token handling only;
- Tenant-scoped connection persistence and audit evidence.

`Calendars.ReadWrite` or another event-write permission must not be added merely to simplify the base connection. Calendar create/update/cancel requires a separate reviewed capability, Exchange Online Application RBAC scoping, Pilot acceptance and activation decision.

Local disconnect invalidates Conference Manager connection state and pending consent transactions. It does not by itself prove that Microsoft administrator consent was externally revoked; the operational runbook must cover service-principal permission revocation.

See `docs/MICROSOFT365-CONNECTION.md`.

## Logging, metrics and audit

Operational logging follows `docs/OBSERVABILITY.md`:

- structured JSON to stdout;
- server-generated correlation ID;
- fixed route keys, not dynamic paths;
- no Tenant ID, User ID, provider Tenant/User ID, session/cookie/CSRF/OIDC/consent values, token, credential, connection string or provider body;
- bounded low-cardinality metrics only.

Business/security audit follows `docs/AUDIT.md` and remains separate from operational logs. Tenant-visible reads are Tenant-scoped and integrity-verified.

Microsoft lifecycle audit metadata may contain only bounded operation and reason codes, never raw provider identifiers, state, tokens or provider messages.

## SAST, SCA, dependency and secret controls

Repository release controls are:

- SAST-oriented checks: `npm run check:static` plus architecture-specific gates;
- high-severity vulnerability blocking: `npm run audit`;
- dependency/lock/license/lifecycle policy: `npm run check:dependencies` and `Dependency Policy` workflow;
- source secret checks: `npm run check:secrets`;
- full-history secret scanning: Gitleaks `Secret Scan` workflow;
- deterministic install: `npm ci --ignore-scripts --no-fund`;
- pinned GitHub Actions by commit SHA;
- provider-boundary unit/API tests and PostgreSQL integration tests.

GitHub-native Dependency Review or CodeQL availability depends on repository/account entitlements. Enforced repository-local gates are the current required controls and must not be removed because a native feature is unavailable.

## Dynamic security testing

Two DAST levels are required:

1. `npm run test:dast` starts the real HTTP server in isolated Test mode and verifies transport/security behavior including Host/Origin, methods, request targets, headers, CSRF, JSON validation, size limits and safe errors.
2. Before external Pilot readiness, run authenticated DAST against the deployed Pilot candidate. It must cover the actual edge/TLS/header configuration, all enabled routes and the Entra/Microsoft consent flows.

High or critical findings block readiness unless an explicit approved risk decision exists. Repository DAST does not prove cloud edge, WAF, shared rate limiting or provider registration is configured correctly.

## Environment separation

- Never copy Production credentials into automated Test or developer environments.
- Pilot and Production use separate provider registrations and secrets unless explicitly reviewed.
- Pilot and Production databases are separate unless a reviewed promotion/migration plan exists.
- Automated tests include at least two independent internal Tenants for cross-Tenant negative coverage.
- Real Microsoft acceptance uses controlled non-production Tenants and non-production mail/resource data.
- Production data is not generic security-test data.
- Pilot/Production entrypoints must not receive `DEMO_*` configuration or import Demo composition,
  persona, fixture, provider or reset modules.
- The Shared Demo Runtime uses only its dedicated `DEMO_*` namespace, distinct origins, secrets and
  an isolated `conference_manager_demo_*` PostgreSQL target. Its parser rejects normal Production,
  database/origin/session/Platform and real-provider configuration that could cross the runtime
  boundary.

The complete Demo configuration and provisioning contract is intentionally separate in
`docs/SHARED-DEMO-RUNTIME.md`. Demo evidence cannot satisfy any Pilot/Production control in this
document.

## Deployment preflight

Before marking a Pilot/Production release candidate ready:

1. Confirm the final commit has all required repository checks green.
2. Run `npm ci --ignore-scripts --no-fund`.
3. Run `npm run check`.
4. Run `npm run audit`.
5. Run PostgreSQL 18 integration and migration tests when persistence changed.
6. Confirm Secret Scan and Dependency Policy passed for the final commit.
7. Supply all required runtime and secret configuration from protected deployment configuration.
8. Confirm exact Entra redirect URI, organizational account model, application owners and credential rotation policy.
9. Confirm only approved Microsoft Graph application permissions are present.
10. Apply migrations before rollout and verify readiness exposes only aggregate state.
11. For an authorization-epoch release, execute the traffic-blocked migration-034 whole-fleet cutover and retain old-cookie/fresh-Principal evidence.
12. Verify edge TLS, HSTS/header preservation, `/api/*` routing, shared rate limiting and no wildcard CORS.
13. Execute independent Tenant sign-in, Tenant claim, admin consent, missing-permission, revocation, reconnect and wrong-Tenant acceptance scenarios.
14. Run deployed-environment DAST and the Pilot penetration-test scope.
15. Record backup/restore evidence and rollback owner/procedure, including the migration-034/PITR reauthentication procedure.
16. For calendar writes, record Exchange Online Application RBAC scope evidence before activation.

## Fail-closed deployment blockers

Do not deploy as Pilot/Production when any of the following is true:

- `PUBLIC_ORIGIN` is missing or not HTTPS;
- PostgreSQL is absent or TLS is not `verify-full`;
- `CSRF_SECRET`, `AUDIT_HMAC_SECRET`, release version or build ID is missing/invalid;
- `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` or `OIDC_TRANSACTION_SECRET` is missing/invalid;
- required migrations/schema readiness are not current;
- an authorization-epoch rollout or rollback would serve mixed epochs, skip migration 034, clear revocations or resume traffic without old-cookie/fresh-Principal evidence;
- repository security/test checks are failing or pending;
- Tenant isolation tests for a changed Tenant-owned resource are absent/failing;
- enabled provider destinations are not fixed or lack timeout/response validation;
- the Entra redirect URI or Microsoft application registration differs from reviewed configuration;
- Microsoft application permissions exceed the enabled capability without explicit review;
- calendar write capability lacks Exchange Application RBAC scope evidence;
- high/critical dependency, DAST or penetration-test findings lack approved risk acceptance;
- deployment would re-enable browser storage, client roles, client Tenant values or provider callback values as authority.
