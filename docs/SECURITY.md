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
- The browser session credential is a server-generated 256-bit opaque token. PostgreSQL stores only SHA-256 over the current source-controlled Customer namespace `customer-session:saas-3.6-role-policy-v1:<raw-token>`.
- `cm_session` is `HttpOnly`, `SameSite=Lax`, `Path=/api`, has bounded `Max-Age`, sets no broad `Domain` and is `Secure` for HTTPS.
- Session resolution fails closed for malformed or missing cookies, unknown hashes, expiry, revocation, inactive Users, stale `security_version` and unavailable Tenant lifecycle state.
- Session issuance compares the approved role/permission snapshot's exact `security_version` under the same database locks and transaction as insertion; a concurrent role change cannot install a stale privileged session.
- Logout and session rotation require server authority and commit their audit evidence atomically with the session mutation.
- Stored per-User role changes increment that User's `security_version`, invalidating their stale session authorization snapshots immediately. A global source-code role-policy change instead advances the Customer authorization epoch and requires a one-way global revocation migration; the two controls are complementary.
- Provider access, refresh and ID tokens are not application sessions and never enter LocalStorage or sessionStorage.
- The transient OIDC transaction stores only hashed state and nonce and is additionally bound to the initiating browser through the `cm_oidc_tx` HttpOnly cookie.
- Migration 034 revokes every still-active pre-epoch Customer session and cannot un-revoke it on down/rollback. New-epoch hashes are unresolvable by an old binary; forward, rollback and PITR therefore require a traffic-blocked whole-fleet cutover and fresh authentication.

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
- Conference Manager Request authority, Conference Manager Room/Catalogue business ownership and Tenant Admin technical/administrative authority remain separate.
- Request lookup uses internal Tenant ID plus Request ID; Employee access also requires server-side owner equality.
- Missing, cross-Tenant and same-Tenant non-owned Employee Requests are concealed as `404 NOT_FOUND`.
- Tenant role administration is Tenant-scoped, prevents removal of the final Tenant Admin and invalidates stale sessions through `security_version`.
- Client-controlled Tenant, owner, role, permission and workflow-state fields are rejected as authority.
- State-changing operations require authorization and CSRF.
- An owning Employee may cancel an eligible own Request. A Conference Manager with `request:manage` may cancel another User's same-Tenant Request from `Submitted`, `In Review`, `Confirmed` or `Change Requested`; `Rejected` is ineligible, `Cancelled` retry is idempotent, cross-Tenant access stays concealed, Tenant Admin alone has no management scope and no physical Request delete exists.
- Booking-change read/propose/decision denials record minimized `authorization.denied` evidence in a valid caller Tenant: target Request ID plus fixed operation only. Employee non-owner, Tenant Admin other-user, Conference Manager cross-Tenant and mismatched change-ID probes are direct negative regressions; no probed change ID or foreign Tenant/owner fact is recorded.
- Optimistic predicates and advisory locks prevent stale or concurrent writes from silently overriding newer state.

See `docs/AUTHORIZATION.md`.

## Request composition controls (#126)

- Request create, resubmit and confirmed-change proposal accept only the closed schema-v2 contract;
  unknown versions, authority-shaped fields and partial composition patches fail closed.
- Tenant and requester identity come only from the authenticated Principal. Room, Site, Catalogue,
  cost-center and Request ownership lookups are parameterized by the same internal Tenant ID.
- The browser supplies only stable selection IDs, quantities, percentage basis points and observed
  configuration revisions. Prices, totals, policy results, calculated allocation amounts, workflow
  state, Request version result and snapshot/audit metadata are server authority.
- Create/resubmit/proposal lock and revalidate the active Tenant/User and all five current
  configuration revisions before resolving the active Room/Site, capacity, IANA time zone,
  Catalogue applicability, effective Booking Policy and Cost Allocation configuration.
- Total v2 participants are bounded to 500. Schedule duration, text, selection, quantity and
  allocation collection bounds limit resource-exhaustion and ambiguous-input risk.
- Pricing uses integer minor units, safe-total bounds and a single charge-line currency. Package
  base price is not charged or used for currency resolution, included items are not charged again,
  and an all-zero result uses the Organization default currency.
- Immutable Request snapshots retain selected price, policy, allocation and configuration facts so
  later Tenant administration cannot rewrite historical meaning. `request_revisions` is
  append-only and Tenant-composite scoped.
- Dietary and special requirements may contain confidential business or personal context. They
  remain inside object-authorized Request snapshot/history storage and are not copied to
  operational logs, metric labels or flattened audit metadata.
- Employee resubmission and history access enforce server-side Request ownership. Missing,
  cross-Tenant and same-Tenant non-owned Employee identifiers are concealed consistently.
- Expected Request versions and configuration revisions prevent stale writes. Success Request,
  history and audit mutations commit atomically; failed validation, conflict or audit persistence
  cannot leave a partial authoritative Request.
- Legacy v1 records expose unavailable composition facts as explicit `null`; missing historical
  prices or policy decisions are never reconstructed. A valid owner resubmission is the deliberate
  v1-to-v2 upgrade path.
- A full confirmed-change proposal snapshots current v2 authority. Only a genuinely
  participant-count-only change with unchanged configuration revisions may apply immediately;
  other composition changes or revision-only refreshes retain the original confirmed booking until
  Conference Manager approval and existing provider revalidation/compensation completes.

See `docs/REQUEST-COMPOSITION.md`.

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

## Shared Demo Runtime controls (SaaS 3.5)

- Customer Demo and Platform Demo are separate server processes with separate HTTPS origins,
  cookie namespaces, CSRF/session secrets and database roles.
- One dedicated `DEMO_TENANT_AUDIT_HMAC_SECRET` is shared only for the Tenant audit chain both
  processes access. Platform control-plane audit/cursor integrity remains a distinct secret domain;
  the Tenant-audit key grants no session, CSRF or authorization authority.
- Both processes use one isolated PostgreSQL database so Demo state is server-authoritative and
  shared; browser storage is never Demo identity, authorization, Tenant or business authority.
- Both same-origin browser surfaces emit `Cross-Origin-Embedder-Policy: require-corp` together with
  the existing same-origin opener/resource policies and a CSP that permits no cross-origin network
  dependency.
- Demo configuration rejects Pilot/Production mode, real Entra/Microsoft configuration,
  conflicting normal database/origin/session/Platform configuration, administrative or aliased
  database roles, mismatched database targets, aliased secrets and non-verifying database TLS in a
  deployed Demo.
- Persona names and customer Tenant/persona pairs are bounded presentation intent mapped only to
  source-defined server identities. The browser cannot submit roles, permissions, security
  versions, Platform target scope or assurance authority.
- Customer and Platform session issue/resolve/revoke and CSRF checks reuse the canonical
  PostgreSQL-backed boundaries. Persona switches rotate sessions and fail closed when old-session
  revocation cannot be completed.
- The simulated Microsoft 365 adapter has no outbound network transport. It validates the same
  provider-neutral inputs and produces only deterministic success, conflict or degradation
  outcomes.
- A reset-only database role, separate from the migration owner and both runtime roles, verifies an immutable Demo sentinel, current database/role,
  exact canonical schema `001..034`, exact table inventory and the source fixture checksum before
  destructive work.
- Normal Demo requests hold a shared advisory lock; reset holds the corresponding exclusive lock.
  Truncate, deterministic seed and semantic checksum readback commit in one serializable
  transaction or roll back completely.
- Platform reset additionally requires a valid Platform session, CSRF, exact confirmation and
  fresh step-up `platform:recovery:execute` authorization; success invalidates all Demo sessions
  and clears the caller cookie.
- Production composition cannot import Demo identity, routes, fixture, provider or reset code, and
  Demo composition cannot instantiate the real Entra/Microsoft adapters.

See `docs/SHARED-DEMO-RUNTIME.md`.

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

## SaaS 3.6 authorization hardening regression matrix

| Finding / contract | Fail-closed invariant | Executable evidence |
| --- | --- | --- |
| H-005 Customer session rollback resurrection | The source-controlled hash epoch blocks forward lookup, migration 034 permanently revokes legacy rows, down never clears revocation, and re-forward revokes rollback-window sessions | `tests-db/session-security-epoch-migration.test.js`, `scripts/check-architecture.mjs`, migration 034 up/down |
| H-017 booking-change denial evidence / IDOR | Employee non-owner, Tenant Admin other-user, Conference Manager cross-Tenant and wrong change-ID probes cannot mutate or disclose authority; valid caller-Tenant denials carry only Request ID and fixed operation | `tests/authorization.test.js`, `tests/booking-change.test.js` |
| H-019 inactive current Room context | Drafting catalogue stays active-only; after Request object authorization, a separate Tenant-composite read may present only the server-referenced retained inactive Room/Site, while non-owner, Tenant Admin-only, cross-Tenant and client-selected Room probes remain denied | `tests/request-service.test.js`, `tests/api.test.js`, `tests-db/production-application-persistence.test.js`, `scripts/check-production-application-contract.mjs` |
| Issues #164/#165 foreign-Request cancellation | Conference Manager role plus `request:manage` may cancel only eligible same-Tenant Requests; owner Employee access remains; cross-Tenant, Tenant Admin-only, invalid state, CSRF bypass and physical delete remain denied | `tests/authorization.test.js`, `tests/request-service.test.js`, `tests/api.test.js`, `tests-db/postgres-persistence.test.js` |
| Same-manager confirmed change | One Conference Manager may propose and approve the same change, with equal server-derived initiator/decider IDs and separate audit actor attribution | `tests/booking-change.test.js`, `tests-db/request-composition-v2-persistence.test.js` |
| Normative role/session baseline | API, settings, architecture, persistence, composition, identity/session, security, deployment and audit documents state the same current ownership and epoch contracts | architecture/documentation review plus the repository static/document gates |

## Important limitations and external evidence

- Repository tests do not prove a real Entra app registration, customer administrator consent, Graph call, credential rotation, HTTPS edge or Exchange Online Application RBAC policy.
- Real Pilot acceptance must use controlled independent Entra Tenants and record exact redirect URI, app ownership, permission grants, success, denial, missing-permission, revocation and reconnect evidence.
- The audit chain is tamper-evident but is not external completeness proof against privileged suffix deletion or stale backup restoration.
- The in-process limiter is not a distributed quota solution; Pilot and Production require trusted shared edge abuse controls.
- Places synchronization, room mapping, free/busy and entitlement-gated create/update/cancel adapters are implemented, but repository tests do not prove them against a live customer Microsoft Tenant. Live Graph/Exchange acceptance for the post-confirmation workflow (#68), operational recovery evidence, deployment IaC and independent penetration testing remain completion gates.
- Shared Demo results are simulated product evidence. They do not prove Production identity,
  provider, edge, backup/restore, DAST, penetration-test or external acceptance controls.

## OWASP and CWE mapping

- Broken Access Control, BOLA and IDOR (CWE-639, CWE-862): Principal-derived Tenant context, Tenant-scoped repositories, object ownership, deny-by-default roles and cross-Tenant negative tests.
- Authentication and session weaknesses (CWE-287, CWE-384): validated OIDC, browser-bound one-time transactions, opaque current-epoch hash-only sessions, expiry, one-way global cutover revocation and per-User security-version invalidation.
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
