# Conference Manager API

Trusted production backend for the Conference Manager SaaS application.

## Scope

This repository owns the server-side trust boundary defined by `conference-manager/docs/SAAS-PRODUCTION-TOPOLOGY.md`. The browser remains untrusted.

The SaaS 0 foundation through issue #53 now provides:

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
- no browser LocalStorage/sessionStorage authentication, authorization or entitlement authority;
- safe metadata-only operational logging and secret-minimized audit payloads;
- regression/progression/adversarial tests for HTTP, Tenant, persistence, session, authorization, audit and entitlement boundaries.

Booking/provider contracts, full observability and the complete production threat/configuration baseline remain later SaaS 0 issues.

## Run locally

```bash
cp .env.example .env
set -a
. ./.env
set +a
npm run db:migrate
npm start
```

A non-persistent development composition may leave `CSRF_SECRET` and `AUDIT_HMAC_SECRET` empty. Any runtime configured with `DATABASE_URL` must provide a stable `AUDIT_HMAC_SECRET` of at least 32 bytes so persisted audit chains remain verifiable across restarts. Pilot/Production additionally require an externally managed `CSRF_SECRET`, an HTTPS public origin and certificate-verifying database TLS.

Do not rotate `AUDIT_HMAC_SECRET` as an ordinary configuration change. Key rotation requires a reviewed audit-integrity migration/checkpoint strategy because existing events were signed with the previous key.

## API foundation

- `GET /api/v1/health/live` — process liveness only.
- `GET /api/v1/health/ready` — readiness aggregate including PostgreSQL/schema readiness when configured.
- `GET /api/v1/session` — resolves the server-side session/Tenant context and returns minimized presentation context plus a runtime CSRF token.
- `DELETE /api/v1/session` — CSRF-protected server-side logout/revocation and cookie clearing.
- `GET /api/v1/requests/{requestId}` — active-Tenant and object-authorized Request read.
- `POST /api/v1/requests/{requestId}/transitions` — CSRF-protected, server-authorized Request workflow transition.
- `GET /api/v1/audit` — Tenant Admin audit read after Tenant authorization and integrity-chain verification.

There is intentionally no public browser-controlled session issuance or entitlement-administration endpoint in SaaS 0. Future Entra OIDC code validates/maps provider identity server-side before session issuance. Future Platform Admin tooling must use a separately authorized server-side operator contract before changing Tenant entitlements.

See:

- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/AUDIT.md`
- `docs/AUTHORIZATION.md`
- `docs/ENTITLEMENTS.md`
- `docs/IDENTITY-SESSION.md`
- `docs/PERSISTENCE.md`
- `docs/SECURITY.md`
- `docs/TENANCY.md`

## Required validation

```bash
npm run check
npm run audit
npm run test:db
```

CI performs locked installs without lifecycle scripts, high-severity audit, repository quality/security gates and PostgreSQL 18 integration tests. The separate Dependency Policy validates dependency/lock/license/lifecycle policy, and Gitleaks scans repository history.

GitHub-native Dependency Review is unavailable for this private user-owned repository without GitHub Code Security/Advanced Security. The repository-local Dependency Policy remains the enforced supply-chain review control unless equivalent native coverage becomes available.
