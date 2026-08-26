# SaaS Production Threat Model

## Authority and scope

Root `AGENTS.md` is authoritative. This threat model covers the implemented SaaS foundation and the Microsoft Enterprise Pilot path and must remain compatible with `conference-manager/docs/SAAS-PRODUCTION-TOPOLOGY.md`.

The model includes the browser, edge/gateway, Conference Manager API, PostgreSQL, managed secret storage, Microsoft Entra ID, the Microsoft identity platform, Microsoft Graph and operational telemetry. It distinguishes implemented controls from capability-specific and deployment acceptance evidence that remains outstanding.

Automated tests and repository gates are evidence for the controls they execute. They are not a substitute for the Pilot penetration test, deployed-environment DAST, Microsoft Tenant acceptance or a complete OWASP, regulatory or infrastructure assessment.

## Security objectives

1. Preserve hard Tenant isolation for every Tenant-owned resource, identity binding, Integration and provider reference.
2. Authenticate organizational users through validated Microsoft Entra OIDC and issue only server-controlled application sessions.
3. Authorize every protected read and write server-side using the internal Principal, Tenant context, permission and object/workflow policy.
4. Preserve confidentiality of credentials, personal data, provider tokens, consent state, audit integrity keys and database credentials.
5. Preserve integrity of Requests, roles, entitlements, sessions, audit evidence, connection state and provider references.
6. Fail closed when identity, Tenant, authorization, configuration, persistence, provider or security-control state is missing, invalid, stale or ambiguous.
7. Bound request, response, connection, database and outbound-provider resource consumption.
8. Produce investigation-grade, secret-minimized audit and operational evidence.

## Assets and classifications

| Asset | Authority | Sensitivity / integrity expectation |
| --- | --- | --- |
| Tenant identity and lifecycle | Backend/PostgreSQL | Security-critical ownership boundary |
| Tenant identity claim and Entra binding | Backend/PostgreSQL | Security-critical external-to-internal mapping |
| Internal User, roles and permissions | Backend/PostgreSQL | Security-critical authorization state |
| Session token / CSRF secret | Backend + HttpOnly cookie/runtime protocol | Credential / secret |
| OIDC transaction, nonce and consent state | Backend/PostgreSQL/secure cookie | Authentication and replay-control secret material |
| Requests, room allocations and booking state | Backend/PostgreSQL | Authoritative business data |
| Tenant entitlements | Backend/PostgreSQL/operator boundary | Commercial/security capability state |
| Microsoft 365 connection state | Backend/PostgreSQL | Tenant-scoped integration authority and health state |
| Audit events and HMAC key | Backend/PostgreSQL + managed secret store | High-integrity security evidence |
| Database credentials | Managed secret/deployment configuration | Secret |
| Entra client credential and provider tokens | Managed secret/provider adapter | Secret / external authority input |
| Microsoft Graph application token | Server-side provider client | Secret |
| Provider resource references | Backend/PostgreSQL | Tenant-scoped integration metadata |
| Operational logs/metrics | Backend/telemetry platform | Secret-minimized operational evidence |
| Frontend LocalStorage/sessionStorage | Browser only | Never production authority |

## Data-flow and trust-boundary model

```text
Untrusted browser
  |
  | HTTPS, same origin
  | HttpOnly application session cookie
  | in-memory CSRF synchronizer token on unsafe requests
  v
Public edge / reverse proxy / gateway
  |
  | fixed /api/* route, HTTPS termination, edge abuse controls
  v
conference-manager-api (first trusted business boundary)
  |-- Entra OIDC protocol validation -> validated external identity
  |-- Tenant claim / JIT User mapping -> internal User and Tenant
  |-- session resolution -> internal Principal
  |-- Principal-derived Tenant context
  |-- deny-by-default RBAC/object ownership/workflow policy
  |-- positive-schema and bounded HTTP input
  |-- application/use-case services
  |-- audit + observability
  |
  +--> PostgreSQL 18
  |     authoritative Tenant-scoped persistence and migrations
  |
  +--> Managed secret store / deployment secret injection
  |     DB, CSRF, audit, OIDC and provider credentials
  |
  +--> Microsoft Entra ID / identity platform (external)
  |     fixed authority, metadata, authorization and token endpoints
  |
  +--> Microsoft Graph (external)
  |     fixed origin and endpoint templates -> validated bounded result
  |
  +--> Central telemetry platform
        structured low-cardinality logs/metrics without Tenant/User/credential dimensions
```

### Boundary B1 — browser to edge/API

The browser is hostile by default. Client values may express user intent but cannot establish Tenant, User, role, permission, object ownership, workflow status, entitlement, provider identity, provider Tenant, idempotency key or audit outcome.

Production browser storage cannot override server state. Frontend feature flags and permission-aware navigation are presentation controls only.

### Boundary B2 — public edge to API process

The public edge is deployment infrastructure, not an application authorization source. The API validates the configured Host and any present Origin, accepts only fixed request-target forms and applies its own HTTP security controls.

Forwarded client-address headers are not trusted by the application. Multi-instance/distributed abuse protection belongs at the trusted edge until a separately reviewed trusted-proxy model exists.

### Boundary B3 — API to PostgreSQL

PostgreSQL is authoritative persistence, but rows are still validated by domain and repository contracts because older or privileged writes are possible. Tenant ownership is reinforced by Tenant-scoped queries, composite keys/foreign keys, uniqueness rules, checks, advisory locks and optimistic versions.

### Boundary B4 — API to managed secret storage

Secrets are supplied through deployment/runtime configuration and are never committed to source. Secret values must not enter public responses, browser storage, audit metadata, metric labels or normal operational logs.

### Boundary B5 — Microsoft Entra ID to identity adapter

Microsoft Entra ID is external. `src/identity/entra-client.js` validates authorization-code flow state, nonce, PKCE, token signature, issuer, audience, time and organizational-account policy before producing a provider-neutral external identity. The external identity is resolved through a server-side Tenant binding and JIT User persistence before an application session is issued.

Provider-specific claims do not flow directly into business services. Email domains, display names and browser-selected Tenant data are never role or Tenant authority.

### Boundary B6 — API to Microsoft identity platform and Microsoft Graph

Provider responses, throttling and errors are external input. `src/integrations/microsoft365-client.js` uses fixed Microsoft origins and internally constructed paths, disables redirects, bounds time and response size, validates response schemas and maps provider outcomes to stable internal classifications.

The Microsoft 365 lifecycle verifies base Places and Calendar-read permissions. Separate implemented, entitlement-gated adapters provide Places discovery, room mapping, free/busy and calendar-event writes while preserving the same fixed-origin, Tenant-scoped boundary.

### Boundary B7 — API to telemetry

Operational telemetry is not an authorization source and must remain low-cardinality and secret-minimized. Business/security audit evidence is a separate Tenant-scoped data model with its own authorization and integrity controls.

## Threat-to-control matrix

| Threat | Primary attack path | Required mitigation | Executable / review evidence | OWASP / CWE | Ownership / residual work |
| --- | --- | --- | --- | --- | --- |
| Tenant escape / BOLA / IDOR | Guess another Tenant's Request, User, Integration or provider reference | Principal-derived Tenant context; Tenant-scoped repositories; object ownership; concealed failures; composite DB constraints | Unit/API/DB cross-Tenant negative suites; architecture gates | Broken Access Control; CWE-639, CWE-862 | Implemented for current resources; every new Tenant resource requires equivalent tests |
| Authentication/session abuse | Forged OIDC callback, invalid claims, stolen/fixed/stale session | One-time OIDC state/nonce; PKCE; signature/issuer/audience/time validation; 256-bit opaque server session; hash-only storage; expiry/revocation; transaction-locked security-version snapshot | Entra client/auth, session, CSRF, role-race and DB tests | Identification and Authentication Failures; CWE-287, CWE-384 | Implemented repository scope; real independent Tenant acceptance remains #58/#59 |
| Tenant-claim takeover | Redeem another invitation or bind a different Entra Tenant | Hashed single-use invitation; explicit confirmation; provider Tenant/user binding; actor-bound claim transaction; uniqueness and audit evidence | Onboarding unit/API/DB concurrency/replay tests | Broken Access Control; CWE-639, CWE-862 | Implemented repository scope; real independent Tenant claim evidence remains #59 |
| CSRF | Cross-site unsafe cookie-authenticated request | SameSite cookie; exact Origin defense-in-depth; session-bound HMAC synchronizer token on unsafe endpoints | Session/API/DAST negative cases | CWE-352 | Implemented; every new unsafe cookie-auth endpoint must opt in |
| XSS / unsafe output | Malicious stored/input text reflected into browser | API emits JSON; safe error envelopes; default-deny API CSP; frontend safe rendering/encoding | HTTP header tests plus frontend browser tests | CWE-79 | Backend implemented; frontend remains a separate enforcement boundary |
| SQL/command injection | Crafted input reaches persistence/runtime execution | Positive schemas; fixed SQL; PostgreSQL parameter binding; no dynamic execution | Static gate, real PostgreSQL tests, malformed-input tests | Injection; CWE-89 | Implemented for current repositories |
| SSRF | Browser-supplied URL or redirect reaches Microsoft/network target | URL-free application contracts; fixed Microsoft origins and endpoint templates; GUID validation; redirects disabled; time/response bounds | Microsoft client, Places, free/busy, calendar-write tests and architecture gate | CWE-918 | Implemented for current Entra and Graph capabilities; every new capability must preserve it |
| Secret/token disclosure | Source, logs, browser, errors or audit payloads | External secret injection; Gitleaks/history scan; local secret gate; minimized logs/audit; fixed public errors; no provider payload reflection | Secret Scan, `check:secrets`, log/audit/API tests | Cryptographic/Information Exposure families; CWE-200 | Implemented baseline; deployment secret-store evidence remains external |
| Privilege escalation / confused deputy | Unknown role, Tenant Admin overreach, self-elevation, client authority fields | Deny-by-default role/permission matrix; independent Conference Manager/Tenant Admin roles; last-admin protection; security-version invalidation; server-derived Tenant | Authorization, role administration, stale-session, cross-Tenant tests | Broken Access Control; CWE-269, CWE-862 | Implemented for Tenant roles; platform administration remains separate |
| Consent callback forgery/replay | Forged state, expired/reused callback, different actor or Tenant | 256-bit state; hash-only persistence; transaction-locked actor/Tenant/provider binding; expiry; one-time consume; redacted durable rejection audit; exact callback allowlist; fixed redirects | Service/API/DB replay, expiry, actor, mismatch and audit tests | CWE-294, CWE-345, CWE-601 | Implemented for Microsoft 365 lifecycle |
| Stale reconnect/disconnect/binding overwrite | Old callback or post-Graph unbind overwrites newer consent, disconnect or binding authority | Tenant advisory lock; connection version; stale-version update guard; new consent deletes prior transaction; active-binding lock at consume and finalization | Service and PostgreSQL concurrency/version/binding-race tests | CWE-362 / business-logic race | Implemented for connection lifecycle |
| Provider permission overreach | Application granted broader Graph access than required | Explicit base permissions; separate write-capability review; Exchange Application RBAC before event writes; entitlement/activation gate | Config, RBAC validator, docs/review plus live Microsoft acceptance | Security Misconfiguration / Excessive Privilege; CWE-250 | Read/write controls implemented; real scoped-tenant evidence remains #68/#69 |
| Replay / duplicate provider writes | Retry after partial external success | Server-derived idempotency key; create-time resource binding; persisted reconciliation state; bounded retry taxonomy | Booking/idempotency/recovery/DB tests | CWE-294 family / business-logic replay | Graph adapter implemented; approved update workflow and live partial-failure acceptance remain #68 |
| Unsafe redirect | Open redirect after auth/consent | Exact registered Entra callback; fixed same-origin post-auth and consent result redirects; no client redirect target | Entra/HTTP/consent callback tests | CWE-601 | Implemented for current callbacks |
| Rate/size/resource exhaustion | Oversized/slow requests, state explosion, provider/database exhaustion | HTTP/body/response/header/time bounds; bounded limiter; DB pool/query bounds; one consent transaction per Tenant; shared Graph deadline and aggregate room bounds; edge distributed rate limit | Config, HTTP/DAST, provider and DB tests | CWE-400 | Application bounds implemented; shared edge evidence required |
| Supply-chain compromise | Vulnerable package/action/lifecycle script | Minimal dependencies; exact versions; lockfile; `npm ci --ignore-scripts`; vulnerability/license policy; pinned Actions; Gitleaks | CI, Dependency Policy, Secret Scan | Software and Data Integrity Failures | Repository-local policy enforced; native GitHub entitlements may vary |
| Insecure deployment configuration | HTTP origin, weak DB TLS, absent credentials or incorrect provider registration | Pilot/Production fail-closed parser; HTTPS; `verify-full`; required secrets/build metadata; fixed authorities/origins | Config tests and security-baseline gate | Security Misconfiguration | Application preflight implemented; edge/IaC/provider-registration evidence remains external |
| Audit tampering / evidence loss | Modify/reorder/delete history or restore stale DB | Append-only trigger; per-Tenant HMAC chain; verified reads; protected key; rollback guards; backup/retention controls | Audit/DB integrity and migration tests | Software/Data Integrity / logging-monitoring failures | Modification/reordering detectable; external completeness/WORM remains operational |
| Diagnostic information leakage | Stack, SQL, provider error/body, identifiers in logs/health | Stable public codes; no stack/message; fixed route/metric keys; aggregate health; provider error concealment | API/observability/redaction/DAST tests | CWE-200 | Implemented for current routes |

## Microsoft Entra ID requirements and status

Implemented repository controls:

- fixed organizational authority and server-derived registered redirect URI;
- authorization-code flow with PKCE, state and nonce;
- token signature, issuer, audience and time validation using trusted metadata/keys;
- provider-neutral external identity mapping;
- explicit Tenant claim and active Tenant binding before JIT session issuance;
- no role derivation from email domain or display name;
- server-side confidential-client credential handling;
- safe callback errors without provider payload disclosure;
- one-time OIDC transaction persistence and replay/concurrency tests.

Remaining external Pilot evidence:

- successful sign-in for at least two independent real Entra Tenants;
- wrong-Tenant, personal-account, invalid-consent and revoked-credential behavior;
- actual registration/redirect/secret rotation evidence in the selected environments;
- deployed-environment DAST and independent penetration testing.

Tracking: #58 and #59.

## Microsoft Graph requirements and status

Implemented base connection controls:

- fixed Microsoft identity and Graph origins;
- internally constructed endpoint templates and validated provider GUIDs;
- Tenant Admin authorization plus active Entra Tenant binding;
- one-time actor-bound admin-consent state;
- base `Place.Read.All` and `Calendars.ReadBasic.All` verification;
- server-side application-token handling;
- disabled redirects, explicit timeouts and response-size bounds;
- positive provider response validation and stable error classification;
- Tenant-scoped, versioned connection persistence and audit evidence;
- no raw Graph payload, token, state or provider identifier in public results or telemetry.

Requirements enforced by the implemented Places/free-busy/event adapters and mandatory for extensions:

- least-privilege permission approval for each capability;
- validated paging and bounded caching for Places;
- provider-neutral room/resource identifiers and Tenant-scoped mappings;
- throttling/transient/permanent/auth/validation classification;
- retries only for safe/idempotent operations with bounded backoff and jitter;
- final availability enforcement before confirmation;
- event create/update/cancel preserving server idempotency and Tenant binding;
- Exchange Online Application RBAC scope evidence before write operations;
- no browser-selected URL, mailbox, provider Tenant or resource authority.

Tracking: #64-#70.

## Residual risks and explicit non-claims

1. The in-process limiter is defense-in-depth, not a cluster-wide quota. Pilot/Production must provide shared edge abuse control and evidence it is active.
2. The audit HMAC chain detects modification and reordering while the key remains protected but does not independently prove completeness after privileged suffix deletion or stale backup restoration. External anchoring/WORM retention is a deployment/governance decision.
3. Repository tests do not prove that a real Microsoft application registration, customer consent, Exchange Application RBAC policy or secret rotation is configured correctly. Those are explicit external acceptance gates.
4. The Microsoft 365 base connection does not claim Places synchronization, free/busy, calendar write access or operational recovery completeness. Those remain separate SaaS 1 capabilities.
5. Infrastructure-as-code and container controls must be scanned and validated when introduced by #113.
6. A Pilot penetration test remains required before external Pilot readiness. See `docs/PILOT-PENETRATION-TEST.md`.

## Mandatory release security gates

Every security-relevant release must preserve, as applicable:

- `npm run check`, including architecture, security-baseline, static/SAST-oriented, secret, dependency, style, unit, regression, progression, negative and live HTTP DAST-smoke checks;
- `npm run audit` with high-severity blocking;
- PostgreSQL 18 integration tests for persistence, migrations, Tenant isolation, concurrency and rollback guards;
- repository-local Dependency Policy workflow;
- full-history Gitleaks Secret Scan;
- same-Tenant and cross-Tenant tests for every new Tenant-owned resource;
- malformed, boundary and replay cases for every new trust-boundary input;
- provider SSRF, redirect, timeout, response-bound, retry, consent and idempotency tests for outbound adapters;
- no unresolved required review threads or failing/pending required checks before merge.

Pilot deployment additionally requires the external DAST, Microsoft acceptance, backup/restore and penetration-test evidence defined in `docs/PRODUCTION-SECURE-CONFIGURATION.md`, `docs/MICROSOFT365-CONNECTION.md` and `docs/PILOT-PENETRATION-TEST.md`.
