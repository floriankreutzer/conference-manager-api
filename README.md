# Conference Manager API

Trusted production backend for the Conference Manager SaaS application.

## Scope

This repository owns the server-side trust boundary defined by `conference-manager/docs/SAAS-PRODUCTION-TOPOLOGY.md`. The browser remains untrusted.

The SaaS 0 foundation through issue #52 now provides:

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
- no browser LocalStorage/sessionStorage authentication or authorization authority;
- safe metadata-only operational logging and secret-minimized audit payloads;
- regression/progression/adversarial tests for HTTP, Tenant, persistence, session, authorization and audit boundaries.

Entitlements, booking/provider contracts, full observability and the complete production threat/configuration baseline remain later SaaS 0 issues.

## Run locally

```bash
cp .env.example .env
set -a
. ./.env
set +a
npm run db:migrate
npm start
```

Development may leave `CSRF_SECRET` and `AUDIT_HMAC_SECRET` empty for non-persistent/test composition. Pilot/Production require externally managed values for both secrets, an HTTPS public origin, PostgreSQL and certificate-verifying database TLS.

## API foundation

- `GET /api/v1/health/live` — process liveness only.
- `GET /api/v1/health/ready` — readiness aggregate including PostgreSQL/schema readiness when configured.
- `GET /api/v1/session` — resolves the server-side session/Tenant context and returns minimized presentation context plus a runtime CSRF token.
- `DELETE /api/v1/session` — CSRF-protected server-side logout/revocation and cookie clearing.
- `GET /api/v1/requests/{requestId}` — active-Tenant and object-authorized Request read.
- `POST /api/v1/requests/{requestId}/transitions` — CSRF-protected, server-authorized Request workflow transition.
- `GET /api/v1/audit` — Tenant Admin audit read after Tenant authorization and integrity-chain verification.

There is intentionally no public browser-controlled session issuance endpoint in SaaS 0. Future Entra OIDC code validates/maps provider identity server-side and then calls the provider-neutral session issuance boundary.

See:

- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/AUDIT.md`
- `docs/AUTHORIZATION.md`
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
