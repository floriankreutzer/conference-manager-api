# Security Foundation

## Trust statement

The browser is untrusted. This service is the first trusted business boundary for the production SaaS deployment.

Client-controlled tenant IDs, user IDs, roles, permissions, ownership, workflow state, prices, entitlements, provider IDs, provider claims and browser storage never establish authority.

## HTTP boundary controls (#47)

- Pilot/Production require an explicit HTTPS public origin.
- Host and present Origin headers are validated against the configured public origin; normal CORS is disabled.
- Request targets reject traversal, malformed encoding, encoded separators, backslashes and absolute/protocol-relative targets.
- Methods, headers, request/response sizes, timeouts and local rate-limit state are bounded.
- Security headers include default-deny CSP, frame protections, no-sniff/no-referrer, same-origin isolation headers and HSTS in Pilot/Production.
- Correlation IDs are server-generated.
- Public errors expose stable codes/request IDs, not implementation details.
- Operational logs accept bounded metadata and do not copy authorization/cookie/body values.

## Tenant-isolation controls (#48)

- Canonical Tenant ownership uses an internal UUID distinct from provider tenant identifiers.
- Tenant context is derived only from the validated internal Principal.
- Client headers/query/route/body values cannot establish or replace Tenant context.
- Suspended/archived Tenants fail closed.
- Tenant-owned repositories are scoped by construction and revalidate returned ownership.
- Cross-Tenant object identifiers resolve as absent within the caller Tenant scope rather than revealing global existence.

## Persistence controls (#49)

- PostgreSQL 18 is authoritative production persistence; `pg` is pinned as the only runtime dependency.
- Pilot/Production require external DB configuration and `verify-full` TLS.
- SQL application values use PostgreSQL parameters and SQL remains inside PostgreSQL infrastructure adapters.
- Non-null Tenant ownership plus composite Tenant keys/foreign keys reinforce isolation in the database.
- Migration pairs are versioned, checksum-protected, advisory-lock serialized and transactional.
- Runtime readiness requires database connectivity and the expected schema version.
- Transaction helpers commit only after successful work and roll back/discard on failure.
- PostgreSQL integration CI covers migration, cross-Tenant constraints, invalid data, duplicate concurrency and transaction rollback.

## Identity and session controls (#50)

- External identity providers do not define the business Principal directly. A provider adapter must validate provider protocol/claims and map them to internal User/Tenant identity before session issuance.
- The trusted identity contract contains internal User/Tenant UUIDs, a normalized provider identity reference and server-approved role/permission snapshots.
- The browser session credential is a server-generated 256-bit opaque token.
- Only SHA-256 of the session token is stored in PostgreSQL; the raw token is not persisted or returned in JSON.
- `cm_session` is `HttpOnly`, `SameSite=Lax`, `Path=/api`, has bounded `Max-Age`, sets no broad `Domain`, and is `Secure` for HTTPS. Pilot/Production require HTTPS.
- Session resolution fails closed for malformed/missing cookies, unknown token hashes, expired/revoked sessions, inactive Users, stale `security_version`, or unavailable Tenant lifecycle state.
- Session expiration is enforced server-side even if a browser retains a cookie.
- Logout requires authenticated `DELETE /api/v1/session`, valid CSRF verification, server-side revocation and cookie clearing.
- Session rotation creates a new random token/session ID and revokes the old session atomically.
- User `security_version` changes invalidate all older role/permission snapshots immediately; authorized rotation may establish a replacement snapshot.
- Provider identity references are retained server-side for adapter linkage but are not exposed by `GET /api/v1/session`.
- Provider access/refresh/ID tokens are not application session credentials and must not be stored in LocalStorage/sessionStorage.

### CSRF

Cookie-authenticated unsafe operations use a synchronizer token derived as HMAC-SHA-256 over the internal session ID. Pilot/Production require the HMAC secret from external secret management.

`GET /api/v1/session` returns the current token after session/Tenant validation. The frontend may hold it in runtime memory and sends it as `X-CSRF-Token`. The token is not persisted in PostgreSQL or browser storage and comparison is timing-safe.

SameSite and Origin validation are defense in depth; they do not replace CSRF verification for protected state changes.

See `docs/IDENTITY-SESSION.md` for the full contract.

## Authorization controls (#51)

- Business authorization is deny-by-default after session Principal and Tenant resolution.
- Recognized Tenant roles are `employee`, `conference_manager` and `tenant_admin`; `platform_admin` is not a Tenant role.
- Any unknown role or permission invalidates the Principal for business authorization rather than being ignored.
- A capability requires both the corresponding internal permission and a Tenant role allowed to use it.
- Tenant Admin permissions do not imply Conference Manager request access.
- Request lookup uses the authenticated internal Tenant ID plus request ID; there is no unscoped global Request lookup.
- Employee Request reads/cancellation additionally require server-side owner equality with `principal.userId`.
- Missing, cross-Tenant and same-Tenant/non-owned Employee Requests are concealed as `404 NOT_FOUND` to reduce BOLA/IDOR existence disclosure.
- Conference Manager Request access remains restricted to the authenticated Tenant.
- Client-controlled `tenantId`, requester/owner, role, permission, `status` and `nextStatus` fields are not accepted as workflow authority.
- Request workflow transitions are allowlisted server-side with explicit role/permission, current-state, next-state and reason rules.
- State-changing Request transitions require valid CSRF protection in addition to authorization.
- PostgreSQL constrains Request workflow status/reason state and the update includes the previously authorized current status to prevent stale/racing writes from silently winning.
- Public Request output omits internal Tenant ownership and requester User ID in this foundation contract.

See `docs/AUTHORIZATION.md` for the complete permission/transition matrix.

## Audit and security-event controls (#52)

- Audit tenant, actor, timestamp, correlation, action, outcome and integrity values are produced from trusted server context, not browser authority.
- Audit state/metadata is bounded to flat primitive objects; nested structures and credential-sensitive key names are rejected.
- Session tokens/hashes, internal session IDs, CSRF tokens, provider credentials/subjects, cookies, private keys and connection strings are not included in audit payloads.
- Migration 004 makes `audit_events` append-only with a PostgreSQL trigger rejecting `UPDATE` and `DELETE`.
- Events are HMAC-SHA-256 chained independently per internal Tenant using canonical payloads and the previous event hash.
- Every DB-backed runtime requires a stable `AUDIT_HMAC_SECRET`; Pilot/Production source it from external secret management. The key is not stored in PostgreSQL/source and must not be rotated without a reviewed integrity migration/checkpoint strategy.
- Tenant audit reads verify the full Tenant chain before returning data and fail closed with `AUDIT_INTEGRITY_UNAVAILABLE` if verification fails.
- Tenant-visible reads require Tenant Admin plus explicit `tenant:audit:read`; Platform/operator audit remains outside this Tenant role model.
- Successful Request transitions and session issue/revoke/rotation append their audit success event inside the same PostgreSQL transaction as the authoritative state mutation.
- Authorization denials and supported no-mutation failure paths are recorded separately with the server request correlation ID.
- Public audit output omits Tenant ID and HMAC chain fields.

See `docs/AUDIT.md` for the event taxonomy, integrity model and limitations.

## Supply-chain controls

The repository uses locked installs without lifecycle scripts, `npm audit --audit-level=high`, Dependabot, full-history Gitleaks and the repository-local Dependency Policy gate.

The Dependency Policy gate enforces manifest/lock consistency, exact direct versions, license metadata, GPL-3.0/AGPL-3.0 deny rules, lifecycle-script rejection and high-severity vulnerability blocking.

GitHub-native Dependency Review is unavailable for this private user-owned repository without GitHub Code Security/Advanced Security; the repository-local policy remains the enforced equivalent control.

## Important limitations

Issue #51 establishes the Tenant role/permission and Request object/workflow policy. It does not create a platform-operator authorization model, and it does not infer site/location/department scope from provider or browser data. A finer Manager scope requires a future explicit server-side scope model.

The audit chain is tamper-evident for modified/reordered rows while the HMAC key is protected, but it is not an external completeness proof against privileged deletion of an entire chain suffix or restoration of an older database snapshot. External anchoring/WORM export, independently controlled retention, key-rotation lifecycle and recovery verification remain production-hardening work for the later operational/security baseline.

The local in-process rate limiter is not a distributed production quota solution. Trusted proxy/client-key semantics and shared/edge abuse controls remain operational/security-baseline work.

The Entra OIDC adapter is not implemented in SaaS 0. SaaS 1 must validate OIDC issuer/audience/signature/state/nonce and provider claims before mapping them to the provider-neutral trusted identity contract.

## OWASP/CWE mapping

- Broken Access Control / BOLA / IDOR (CWE-639/CWE-862): Tenant-scoped lookup, Employee ownership, role/permission intersection, concealed non-owned objects, workflow authorization and Tenant-scoped audit reads are implemented and negatively tested.
- Authentication/session weaknesses: opaque high-entropy cookies, server-side expiry/revocation, rotation and security-version invalidation are implemented and negatively tested; session lifecycle mutations carry atomic audit evidence.
- CSRF (CWE-352): unsafe protected cookie-authenticated requests require session-bound HMAC synchronizer tokens, including Request transitions and logout.
- SQL injection (CWE-89): fixed SQL plus PostgreSQL parameter binding; real database integration tests execute Request/session/audit persistence paths.
- XSS (CWE-79): API emits JSON/no HTML and sets default-deny CSP; frontend rendering remains separately governed.
- SSRF (CWE-918): no provider outbound transport exists yet; future destinations remain fixed/allowlisted requirements.
- Information disclosure: session credentials/provider references/DB secrets are excluded from public output; audit metadata rejects sensitive key classes and Employee object probing conceals non-owned Request existence.
- Privilege escalation/confused deputy: unknown roles/permissions fail closed, Tenant Admin does not inherit Manager rights, audit read is a separate permission, and target workflow state is selected only by server policy.
- Replay/stale state: session revocation/security-version checks protect credentials; Request workflow writes use expected-current-state predicates.
- Integrity/tampering: audit writes are append-only, per-Tenant HMAC chained and verified before tenant-visible reads; external completeness anchoring remains explicitly out of scope.
- Resource exhaustion: HTTP, database pool/query, audit payload/page and session TTL bounds are explicit; capacity/load tuning remains operational work.

Automated checks are evidence only for the exercised controls. They are not a penetration test or complete OWASP/regulatory compliance statement.
