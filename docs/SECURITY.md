# Security Foundation

## Authority and trust statement

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` are authoritative. This service is the first trusted business boundary for the production SaaS deployment.

The browser and all provider responses are untrusted. Client-controlled Tenant IDs, User IDs, roles, permissions, ownership, workflow state, prices, entitlements, provider identifiers, callback values and browser storage never establish authority.

## HTTP boundary controls (#47)

- Pilot and Production require an explicit HTTPS public origin.
- Host and any present Origin are validated against the configured public origin; normal browser operation is same-origin and CORS is disabled.
- Request targets reject traversal, malformed encoding, encoded separators, backslashes and absolute or protocol-relative targets.
- Methods, headers, request and response sizes, timeouts and local rate-limit state are bounded.
- Security headers include default-deny CSP, frame protection, no-sniff, no-referrer, same-origin isolation headers and HSTS for Pilot and Production.
- Correlation IDs are server-generated.
- Public errors expose stable codes and request IDs, not stack traces, SQL, provider bodies or implementation details.
- Operational logs accept bounded metadata and never copy authorization, cookie, body, Tenant, User, provider or credential values.

## Tenant-isolation controls (#48)

- Canonical Tenant ownership uses an internal UUID distinct from every provider Tenant identifier.
- Tenant context is derived only from the validated internal Principal.
- Client headers, query, route and body values cannot establish or replace Tenant context.
- Suspended or archived Tenants fail closed.
- Tenant-owned repositories are scoped by construction and revalidate returned ownership.
- Composite Tenant keys and foreign keys reinforce ownership in PostgreSQL.
- Cross-Tenant object identifiers resolve as absent within the caller Tenant scope rather than revealing global existence.

## Persistence controls (#49)

- PostgreSQL 18 is authoritative production persistence.
- Exact runtime dependencies are limited to `pg` and `@azure/msal-node`; provider SDK types do not cross into application or domain contracts.
- Pilot and Production require external database configuration and `verify-full` TLS.
- SQL application values use PostgreSQL parameters and SQL remains inside PostgreSQL infrastructure adapters.
- Migration pairs are versioned, checksum-protected, advisory-lock serialized and transactional.
- Runtime readiness requires database connectivity and the exact repository-defined schema version.
- Transaction helpers commit only after successful work and roll back and discard failed work.
- Evidence-bearing migrations include fail-closed rollback guards.
- PostgreSQL integration CI covers migration, rollback, cross-Tenant constraints, invalid data, concurrency and transaction rollback.

## Microsoft Entra identity and session controls (#50, #58-#61)

- The Entra adapter uses the fixed Microsoft organizational multi-Tenant authority and authorization-code flow with PKCE, state and nonce.
- Microsoft protocol output is validated for signature, issuer, audience, time and organizational-account policy before it becomes a provider-neutral external identity.
- External identity is resolved through a server-side Tenant claim or active Tenant binding and JIT User mapping before session issuance.
- Email domains, display names, browser Tenant values, raw Entra roles and group claims are not Conference Manager authorization authority.
- The browser session credential is a server-generated 256-bit opaque token. Only its SHA-256 hash is stored in PostgreSQL.
- `cm_session` is `HttpOnly`, `SameSite=Lax`, `Path=/api`, has bounded `Max-Age`, sets no broad `Domain` and is `Secure` for HTTPS.
- Session resolution fails closed for malformed or missing cookies, unknown hashes, expiry, revocation, inactive Users, stale `security_version` and unavailable Tenant lifecycle state.
- Session issuance compares the approved role/permission snapshot's exact `security_version` under the same database locks and transaction as insertion; a concurrent role change cannot install a stale privileged session.
- Logout and session rotation require server authority and commit their audit evidence atomically with the session mutation.
- Role changes increment User `security_version`, invalidating all stale session authorization snapshots immediately.
- Provider access, refresh and ID tokens are not application sessions and never enter LocalStorage or sessionStorage.
- The transient OIDC transaction stores only hashed state and nonce and is additionally bound to the initiating browser through the `cm_oidc_tx` HttpOnly cookie.

### CSRF

Cookie-authenticated unsafe operations require a synchronizer token derived as HMAC-SHA-256 over the internal session ID. Pilot and Production require the HMAC secret from external secret management.

`GET /api/v1/session` returns the current token only after session, Tenant and authorization validation. The frontend may retain it in runtime memory and send it as `X-CSRF-Token`. It is not persisted in PostgreSQL or browser storage and is compared using a timing-safe operation.

SameSite and Origin validation are defense in depth; they do not replace CSRF verification for protected state changes.

See `docs/IDENTITY-SESSION.md` and `docs/ENTRA-AUTHENTICATION.md`.

## Authorization controls (#51, #61)

- Business authorization is deny-by-default after session Principal and Tenant resolution.
- Recognized Tenant roles are `employee`, `conference_manager` and `tenant_admin`; `platform_admin` is not a Tenant role.
- Any unknown role or permission invalidates the Principal rather than being ignored.
- A capability requires both the corresponding internal permission and a Tenant role allowed to use it.
- Conference Manager Request authority and Tenant Admin configuration authority remain separate.
- Request lookup uses internal Tenant ID plus Request ID; Employee access also requires server-side owner equality.
- Missing, cross-Tenant and same-Tenant non-owned Employee Requests are concealed as `404 NOT_FOUND`.
- Tenant role administration is Tenant-scoped, prevents removal of the final Tenant Admin and invalidates stale sessions through `security_version`.
- Client-controlled Tenant, owner, role, permission and workflow-state fields are rejected as authority.
- State-changing operations require authorization and CSRF.
- Optimistic predicates and advisory locks prevent stale or concurrent writes from silently overriding newer state.

See `docs/AUTHORIZATION.md`.

## Audit and security-event controls (#52)

- Audit Tenant, actor, timestamp, correlation, action, outcome and integrity values come from trusted server context.
- State and metadata are bounded flat primitive objects; nested values and credential-sensitive key names are rejected.
- Session credentials, CSRF, OIDC or consent state, provider credentials and identifiers, cookies, private keys, connection strings and provider payloads are excluded.
- Migration 004 makes `audit_events` append-only with a trigger rejecting `UPDATE` and `DELETE`.
- Events are HMAC-SHA-256 chained independently per internal Tenant.
- Every database runtime requires a stable externally managed `AUDIT_HMAC_SECRET`.
- Tenant-visible reads verify the complete Tenant chain and require Tenant Admin plus `tenant:audit:read`.
- Supported authoritative mutations append their success event in the same PostgreSQL transaction; audit failure rolls the mutation back.
- Migration 011 extends the database taxonomy for `integration.verified` and refuses rollback while verification evidence remains.
- External Microsoft operations are not falsely described as transactionally atomic with local PostgreSQL state.

See `docs/AUDIT.md`.

## Entitlement controls (#53)

- Product access is the server-side intersection of authorization and Tenant entitlement; a trusted rollout gate may only restrict that result.
- The allowlisted capabilities are `microsoft.directory`, `microsoft.calendar` and the independently gated `microsoft.calendar.write`; unknown capabilities fail closed.
- Missing entitlement rows mean disabled. Browser flags, visibility and submitted values cannot grant access.
- Entitlement reads and writes are scoped by internal Tenant ID plus capability ID.
- Commercial entitlement mutation uses a separate deny-by-default operator authorization port; Tenant Admin is not a commercial administrator.
- Real entitlement changes and audit evidence commit atomically.

See `docs/ENTITLEMENTS.md`.

## Booking and calendar integration controls (#54)

- Booking and calendar application code is provider-neutral and accepts no provider URL or SDK type.
- Every provider operation requires same-active-Tenant Principal and Request binding, explicit server authorization and the configured Tenant entitlement.
- PostgreSQL stores only bounded opaque provider connection/resource/event references bound to internal Tenant, Request and Integration, plus a positive create-attempt number and deterministic key.
- Local room-conflict checks are Tenant-scoped.
- Calendar create uses a deterministic server-derived SHA-256 idempotency key per attempt; the browser cannot supply it. A compensated retry increments the attempt and rotates the key.
- A pending attempt keeps its create-time resource through remapping or local disconnect. Cancellation uses that persisted binding and still requires the exact current Integration/provider-Tenant identity and active Entra binding.
- Create reservation/finalization and final Request confirmation revalidate the exact connected Integration plus active Entra binding under the same database locks as their local commit. Authority loss after provider create is explicitly compensated.
- Booking-reference states are `pending`, `active`, `compensating`, `compensated` and terminal `cancelled`; identity/provider rebinding is blocked while any reference is nonterminal.
- Provider responses are positively validated and mapped to stable retryable or non-retryable classifications.
- Raw provider errors, payloads, credentials and references are excluded from Tenant audit metadata.
- Provider write retries must remain bounded and idempotency-aware.

See `docs/BOOKING-INTEGRATION.md`.

## Microsoft 365 connection controls (#62)

- Only an authenticated `tenant_admin` with `tenant:integrations:manage` may read or mutate connection state.
- The provider Tenant is derived from the active server-side Entra Tenant binding. Browser and callback Tenant values never select the internal Tenant.
- Connect, verify and disconnect require CSRF and reject request bodies or Tenant selectors. Read-only Microsoft 365 routes also reject request bodies.
- Admin consent uses a 256-bit state value; only SHA-256 is persisted.
- Consent transactions are bound to internal Tenant, actor User, Integration, provider Tenant, connection version and expiry.
- Callback keys and values are positively allowlisted; duplicates, pollution, control characters and inconsistent provider states fail closed.
- Consent start and callback consume lock and revalidate the active provider-Tenant binding inside their persistence transactions.
- Consent and manual-verification finalization revalidate the exact binding again inside the version-guarded connection-update transaction after Graph I/O.
- State is consumed atomically and once. Replay, expiry, actor mismatch, cross-Tenant use, provider-Tenant mismatch, changed binding and stale version fail closed and are durably audited with redacted reason codes when a trusted Tenant/actor context exists.
- Microsoft identity and Graph origins are fixed in server configuration. Adapter paths are constructed internally and redirects are disabled.
- Provider calls and response bodies are bounded; provider responses are positively validated and raw details are concealed.
- The base lifecycle checks `Place.Read.All` and `Calendars.ReadBasic.All` application access only. It does not claim free/busy or calendar-write authorization.
- Connection states are `pending`, `connected`, `degraded`, `revoked` and `disconnected` with fixed reason and permission indicators.
- Connection, consent and local disconnect state is Tenant-scoped, versioned and audit-atomic.
- A cancelled or expired same-provider reconnect preserves an existing healthy verified connection. Provider rebinding is fail-closed while any booking reference is not terminal `cancelled`; an allowed rebind resets verification and invalidates stale room mappings before recovery.
- Pre-activation Entra identity unbind is fail-closed with any nonterminal booking reference; an allowed unbind invalidates User security versions, revokes sessions, deletes consent state and disconnects/clears Microsoft 365 in the same audited transaction.
- Local disconnect does not claim that Entra administrator consent was externally revoked.

See `docs/MICROSOFT365-CONNECTION.md`.

## Secret, token and PII minimization

- Secrets are supplied only through protected runtime configuration and are environment-separated.
- Source, history, lockfile and workflow secret gates run for every final commit.
- Provider tokens remain in process memory only for the bounded provider operation and are never persisted or returned.
- Public session and integration responses omit provider identity references, internal session IDs, token hashes and provider payloads.
- Logs and metrics use fixed low-cardinality labels and omit Tenant, User, provider and resource identifiers.
- Audit payload validation rejects sensitive concepts and oversized or nested values.
- Provider error descriptions are never reflected into public redirects or JSON.

## Supply-chain controls

The repository uses locked installs without lifecycle scripts, exact direct versions, `npm audit --audit-level=high`, Dependabot, full-history Gitleaks and the repository-local Dependency Policy gate.

The Dependency Policy gate enforces manifest and lock consistency, exact direct versions, license metadata, GPL-3.0 and AGPL-3.0 deny rules, lifecycle-script rejection and high-severity vulnerability blocking.

GitHub-native security feature availability depends on repository/account entitlements. Repository-local required gates remain mandatory regardless of native feature availability.

## Important limitations and external evidence

- Repository tests do not prove a real Entra app registration, customer administrator consent, Graph call, credential rotation, HTTPS edge or Exchange Online Application RBAC policy.
- Real Pilot acceptance must use controlled independent Entra Tenants and record exact redirect URI, app ownership, permission grants, success, denial, missing-permission, revocation and reconnect evidence.
- The audit chain is tamper-evident but is not external completeness proof against privileged suffix deletion or stale backup restoration.
- The in-process limiter is not a distributed quota solution; Pilot and Production require trusted shared edge abuse controls.
- Places synchronization, room mapping, free/busy and entitlement-gated create/cancel adapters are implemented, but repository tests do not prove them against a live customer Microsoft Tenant. Live Graph/Exchange acceptance, the approved post-confirmation update workflow (#68), operational recovery evidence, deployment IaC and independent penetration testing remain completion gates.

## OWASP and CWE mapping

- Broken Access Control, BOLA and IDOR (CWE-639, CWE-862): Principal-derived Tenant context, Tenant-scoped repositories, object ownership, deny-by-default roles and cross-Tenant negative tests.
- Authentication and session weaknesses (CWE-287, CWE-384): validated OIDC, browser-bound one-time transactions, opaque hash-only sessions, expiry, revocation and security-version invalidation.
- CSRF (CWE-352): unsafe cookie-authenticated requests require session-bound HMAC synchronizer tokens.
- Injection (CWE-89): fixed SQL, parameter binding, positive schemas and PostgreSQL integration tests.
- XSS (CWE-79): the API emits JSON and a default-deny CSP; frontend rendering remains separately governed.
- SSRF (CWE-918): fixed provider origins and endpoint templates, validated GUID references, disabled redirects and no browser-supplied URL authority.
- Information disclosure (CWE-200): minimized public contracts, fixed errors and provider, secret and PII redaction.
- Privilege escalation (CWE-269): role and permission intersection, separated administrative domains and stale-session invalidation.
- Replay and race conditions (CWE-294, CWE-362): one-time state, actor/Tenant binding, optimistic versions, advisory locks and idempotency.
- Integrity and logging failures: append-only HMAC-chained Tenant audit and audit-atomic local mutations.
- Resource exhaustion (CWE-400): bounded HTTP, database, provider, audit and pagination resources.

Automated checks are evidence only for exercised controls. They are not a penetration test or a complete OWASP, regulatory or infrastructure compliance statement.
