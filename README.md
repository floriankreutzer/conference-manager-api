# Conference Manager API

Trusted production backend for the Conference Manager SaaS application.

## Scope

This repository owns the server-side trust boundary defined by `conference-manager/docs/SAAS-PRODUCTION-TOPOLOGY.md`. The browser remains untrusted.

The SaaS 0 foundation through issue #57 now provides:

- Node.js 22 native HTTP API with same-origin request hardening and secure error/health contracts;
- canonical internal Tenant model and hard Tenant isolation;
- PostgreSQL 18 authoritative persistence with versioned/checksummed migrations and Tenant-aware constraints;
- parameterized repositories, explicit transactions and schema readiness;
- provider-neutral trusted-identity/Internal-Principal contracts;
- PostgreSQL-backed opaque server sessions using hash-only token persistence;
- `HttpOnly`, narrow-path, SameSite session cookies with `Secure` enforced by HTTPS Pilot/Production deployment;
- server-side session expiry, revocation and atomic rotation;
- User `security_version` invalidation for stale privilege snapshots;
- HMAC-derived session-bound CSRF tokens compatible with the frontend `X-CSRF-Token` contract;
- authenticated session introspection and server-side logout;
- deny-by-default Tenant RBAC for Employee, Conference Manager and Tenant Admin;
- explicit separation of Platform Admin from the Tenant role model;
- Employee Request ownership checks and concealed BOLA/IDOR failures;
- Tenant-scoped Conference Manager Request access;
- server-authorized Request workflow transitions with optimistic status concurrency;
- PostgreSQL workflow status/reason constraints;
- server-generated tenant audit/security events with explicit retention classes;
- append-only PostgreSQL audit persistence plus per-Tenant HMAC-SHA-256 integrity chains;
- atomic audit persistence for successful Request transitions and session issue/revoke/rotation;
- Tenant Admin audit reads through explicit `tenant:audit:read` authorization and chain verification;
- stable server-side Tenant capability IDs and fail-closed entitlement persistence;
- explicit separation of Tenant entitlements from frontend/browser rollout feature flags;
- effective capability evaluation requiring authorization plus entitlement, with optional server-side rollout disablement;
- deny-by-default internal operator entitlement mutation with atomic `tenant.entitlement.changed` audit evidence;
- provider-neutral availability, provisional/final reservation-validation and calendar create/update/cancel contracts;
- Tenant-scoped opaque provider-reference persistence separated from Employee/Manager workflow semantics;
- deterministic server-side calendar-create idempotency and explicit provider failure/retryability classification;
- recovery semantics that prevent duplicate provider bookings when adapters honor the idempotency contract;
- server-generated request correlation and fixed route-key structured operational logs;
- bounded low-cardinality API/auth/authz/booking/integration/dependency metrics emitted as structured telemetry;
- separate liveness, required-dependency readiness and optional-provider degradation semantics;
- aggregate support health with validated service version/build/environment metadata;
- no browser LocalStorage/sessionStorage authentication, authorization, entitlement or provider authority;
- secret/PII-minimized operational logging and audit payloads;
- a complete browser/edge/API/database/Entra/Graph production threat model with OWASP/CWE mapping;
- a fail-closed Pilot/Production secure-configuration baseline for TLS, headers, cookies, CORS, database TLS, secrets and logging;
- explicit SAST/SCA/dependency/secret controls and a live HTTP DAST smoke release gate;
- a defined independent Pilot penetration-test scope and readiness exit criteria;
- regression/progression/adversarial tests for HTTP, Tenant, persistence, session, authorization, audit, entitlement,
  booking-integration, observability and production-security boundaries.

The SaaS 1 repository implementation now includes the production Entra identity adapter, Tenant claiming and JIT provisioning, Tenant role administration, Microsoft 365 consent lifecycle, room discovery/mapping, Free/Busy, calendar synchronization, integration health, Tenant Pilot lifecycle, adversarial multi-Tenant gates, and controlled Pilot operations/readiness evidence. Real Microsoft, deployment, browser, restore, DAST, penetration-test, and operational evidence remains an external Pilot gate; see `docs/PILOT-READINESS-RUNBOOK.md`. Calendar Write remains disabled unless the release also satisfies `docs/EXCHANGE-APPLICATION-RBAC.md`.

SaaS 3.5 adds an isolated Shared Demo Runtime with separate customer and Platform process entrypoints,
one authoritative PostgreSQL state, deterministic simulated identity/Microsoft scenarios, and a
sentinel/checksum/lock-protected reset. It reuses the canonical server application and authorization
boundaries; Production cannot import or fall back to Demo behavior. See
`docs/SHARED-DEMO-RUNTIME.md`.

## Run locally

```bash
cp .env.example .env
set -a
. ./.env
set +a
npm run db:migrate
npm start
```

A non-persistent development composition may leave `CSRF_SECRET` and `AUDIT_HMAC_SECRET` empty. Any runtime configured with `DATABASE_URL` must provide a stable `AUDIT_HMAC_SECRET` of at least 32 bytes so persisted audit chains remain verifiable across restarts. Pilot/Production additionally require an externally managed `CSRF_SECRET`, an HTTPS public origin, certificate-verifying database TLS, `SERVICE_VERSION` and `BUILD_ID`.

Do not rotate `AUDIT_HMAC_SECRET` as an ordinary configuration change. Key rotation requires a reviewed audit-integrity migration/checkpoint strategy because existing events were signed with the previous key.

The checked-in `.env.example` is a development template. Pilot/Production configuration and secrets must be supplied by protected deployment configuration according to `docs/PRODUCTION-SECURE-CONFIGURATION.md`.

## Run the Shared Demo Runtime

The Shared Demo uses a dedicated database named `conference_manager_demo_*`, canonical schema
version `34`, Demo overlay version `3`, four distinct database roles and only `DEMO_*`
configuration. After provisioning and applying canonical migrations, run:

```bash
npm run demo:db:migrate
npm run demo:db:reset -- --confirm-seed-version=saas-3.5-shared-demo-v1
npm run start:demo:customer
npm run start:demo:platform
```

The two start commands are independent processes and must be routed through separate HTTPS origins.
Do not supply Production/real-provider credentials. The complete configuration, provisioning,
reset, validation and rollback contract is in `docs/SHARED-DEMO-RUNTIME.md`.

## API foundation

- `GET /api/v1/health/live` — process liveness only.
- `GET /api/v1/health/ready` — required-dependency readiness aggregate including PostgreSQL/schema readiness when configured.
- `GET /api/v1/health/status` — aggregate `ready`/`degraded`/`not_ready` state plus bounded support metadata; no dependency details.
- `GET /api/v1/session` — resolves the server-side session/Tenant context and returns minimized presentation context plus a runtime CSRF token.
- `DELETE /api/v1/session` — CSRF-protected server-side logout/revocation and cookie clearing.
- `GET /api/v1/requests/{requestId}` — active-Tenant and object-authorized Request read.
- `POST /api/v1/requests/{requestId}/transitions` — CSRF-protected, server-authorized Request workflow transition.
- `GET/POST /api/v1/requests/{requestId}/booking-change` — read or create the single open confirmed-booking proposal.
- `POST /api/v1/requests/{requestId}/booking-change/{changeId}/decision` — Conference Manager approve/reject decision with live revalidation.
- `GET /api/v1/audit` — Tenant Admin audit read after Tenant authorization and integrity-chain verification.

There is intentionally no browser-controlled session issuance, entitlement-administration, metrics or direct calendar-provider endpoint. The production Entra OIDC flow validates and maps provider identity server-side before issuing an opaque application session. Normal Platform/operator changes use the separate authenticated Platform HTTP boundary; the only local mutation fallback is the dual-control, grant-bound recovery wrapper. Production Request, availability and calendar synchronization remain composed behind the existing authenticated and object-authorized application use cases.

See:

- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/AUDIT.md`
- `docs/AUTHORIZATION.md`
- `docs/BOOKING-INTEGRATION.md`
- `docs/ENTITLEMENTS.md`
- `docs/ENTRA-AUTHENTICATION.md`
- `docs/ENTRA-PILOT-VALIDATION.md`
- `docs/EXCHANGE-APPLICATION-RBAC.md`
- `docs/IDENTITY-SESSION.md`
- `docs/MICROSOFT365-CALENDAR-WRITE.md`
- `docs/MICROSOFT365-CONNECTION.md`
- `docs/MICROSOFT365-FREE-BUSY.md`
- `docs/MICROSOFT365-INTEGRATION-HEALTH.md`
- `docs/MICROSOFT365-ROOM-DISCOVERY.md`
- `docs/MICROSOFT365-ROOM-MAPPING.md`
- `docs/OBSERVABILITY.md`
- `docs/PERSISTENCE.md`
- `docs/PILOT-PENETRATION-TEST.md`
- `docs/PILOT-READINESS-RUNBOOK.md`
- `docs/PRODUCTION-SECURE-CONFIGURATION.md`
- `docs/SECURITY.md`
- `docs/SHARED-DEMO-RUNTIME.md`
- `docs/TENANCY.md`
- `docs/THREAT-MODEL.md`

## Required validation

```bash
npm run check
npm run audit
npm run test:db
```

`npm run check` includes the security-baseline architecture gate and the live HTTP DAST smoke gate in addition to the existing syntax, architecture, SAST-oriented static, dependency, secret, style, unit, regression, progression and adversarial checks.

CI performs locked installs without lifecycle scripts, high-severity audit, repository quality/security gates and PostgreSQL 18 integration tests. The separate Dependency Policy validates dependency/lock/license/lifecycle policy, and Gitleaks scans repository history.

GitHub-native Dependency Review is unavailable for this private user-owned repository without GitHub Code Security/Advanced Security. The repository-local Dependency Policy remains the enforced supply-chain review control unless equivalent native coverage becomes available.
