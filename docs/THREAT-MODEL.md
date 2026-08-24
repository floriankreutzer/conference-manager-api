# SaaS Production Threat Model

## Authority and scope

Root `AGENTS.md` is authoritative. This threat model closes the SaaS 0 security-baseline work tracked by `floriankreutzer/conference-manager#57` and must remain compatible with `conference-manager/docs/SAAS-PRODUCTION-TOPOLOGY.md`.

The model covers the production request path even where a provider adapter is intentionally deferred. It therefore includes the browser, edge/gateway, Conference Manager API, PostgreSQL, managed secret storage, Microsoft Entra ID, Microsoft Graph and the operational telemetry boundary.

Automated tests and repository gates are evidence for the controls they execute. They are not a substitute for the Pilot penetration test or a complete OWASP, regulatory or infrastructure assessment.

## Security objectives

1. Preserve hard Tenant isolation for every Tenant-owned resource and provider reference.
2. Authenticate users through a validated external identity boundary and issue only server-controlled application sessions.
3. Authorize every protected read/write server-side using the internal Principal, Tenant context, permission and object ownership/workflow policy.
4. Preserve confidentiality of credentials, personal data, provider tokens, audit integrity keys and database credentials.
5. Preserve integrity of authoritative Requests, entitlements, sessions, audit evidence and provider references.
6. Fail closed when identity, Tenant, authorization, configuration, persistence, provider or security-control state is missing, invalid or ambiguous.
7. Bound request, response, connection, database and outbound-provider resource consumption.
8. Produce investigation-grade, secret-minimized audit and operational evidence.

## Assets and classifications

| Asset | Authority | Sensitivity / integrity expectation |
| --- | --- | --- |
| Tenant identity and lifecycle | Backend/PostgreSQL | Security-critical ownership boundary |
| Internal User, roles and permissions | Backend/PostgreSQL | Security-critical authorization state |
| Session token / CSRF secret | Backend + browser cookie/runtime protocol | Credential / secret |
| Requests, room allocations and booking state | Backend/PostgreSQL | Authoritative business data |
| Tenant entitlements | Backend/PostgreSQL/operator boundary | Commercial/security capability state |
| Audit events and HMAC key | Backend/PostgreSQL + managed secret store | High-integrity security evidence |
| Database credentials | Managed secret/deployment configuration | Secret |
| Entra client credentials and provider tokens | Managed secret/identity adapter | Secret / external identity authority input |
| Microsoft Graph access/refresh tokens | Server-side provider adapter / credential store | Secret |
| Provider resource references | Backend/PostgreSQL | Tenant-scoped integration metadata |
| Operational logs/metrics | Backend/telemetry platform | Secret-minimized operational evidence |
| Frontend LocalStorage/sessionStorage | Browser only | Never production authority |

## Data-flow and trust-boundary model

```text
Untrusted browser
  |
  | HTTPS, same origin
  | HttpOnly application session cookie
  | runtime CSRF synchronizer token on unsafe requests
  v
Public edge / reverse proxy / gateway
  |
  | fixed /api/* route, HTTPS termination, edge abuse controls
  v
conference-manager-api (first trusted business boundary)
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
  |     DB credentials, CSRF HMAC, audit HMAC, future provider credentials
  |
  +--> Microsoft Entra ID (external / untrusted until validated)
  |     OIDC authorization response / token validation -> identity adapter
  |
  +--> Microsoft Graph (external / untrusted provider)
  |     fixed/allowlisted egress -> provider adapter -> validated provider-neutral result
  |
  +--> Central telemetry platform
        structured low-cardinality logs/metrics without Tenant/User/credential dimensions
```

### Boundary B1 — browser to edge/API

The browser is hostile by default. Client values may express user intent but cannot establish Tenant, User, role, permission, object ownership, workflow status, entitlement, provider identity, idempotency key or audit outcome.

Production browser storage cannot override server state. Frontend feature flags are presentation/rollout controls only.

### Boundary B2 — public edge to API process

The public edge is deployment infrastructure, not an application authorization source. The API validates the configured Host and any present Origin, accepts only fixed request-target forms and applies its own HTTP security controls.

Forwarded client-address headers are not currently trusted by the application. Multi-instance/distributed abuse protection therefore belongs at the trusted edge until a separately reviewed trusted-proxy model exists.

### Boundary B3 — API to PostgreSQL

PostgreSQL is authoritative persistence, but database rows are still validated by domain/repository contracts because older or privileged writes are possible. Tenant ownership is reinforced by Tenant-scoped queries, composite keys/foreign keys and database constraints where practical.

### Boundary B4 — API to managed secret storage

Secrets are supplied through deployment/runtime configuration and are never committed to source. Secret values must not enter public responses, browser storage, audit metadata, metric labels or normal operational logs.

### Boundary B5 — Entra ID to identity adapter

Microsoft Entra is external. Provider claims are not an internal Principal until the future Entra adapter validates protocol and token requirements including signature, issuer, audience, state, nonce, time validity and approved Tenant/account mapping. Provider-specific claims never flow directly into business services.

### Boundary B6 — API to Microsoft Graph

Graph responses, throttling and errors are external input. Provider adapters must use server-controlled destinations, constrained redirects, explicit timeouts, validated response schemas and operation-specific retry/idempotency rules. Browser-supplied URLs are prohibited.

### Boundary B7 — API to telemetry

Operational telemetry is not an authorization source and must remain low-cardinality and secret-minimized. Business/security audit evidence is a separate data model with its own Tenant authorization and integrity controls.

## Threat-to-control matrix

| Threat | Primary attack path | Required mitigation | Executable / review evidence | OWASP / CWE | Ownership / residual work |
| --- | --- | --- | --- | --- | --- |
| Tenant escape / BOLA / IDOR | Guess another Tenant's Request/provider reference | Principal-derived Tenant context; Tenant-scoped repositories; object ownership; concealed failures; DB Tenant constraints | Unit/API/DB cross-Tenant negative suites, architecture gates | Broken Access Control; CWE-639, CWE-862 | Implemented in #48/#49/#51/#52/#53/#54; new Tenant resources require new negative tests |
| Authentication/session abuse | Stolen/fixed/stale session, invalid provider identity | 256-bit opaque server session; hash-only storage; server expiry/revocation/rotation; User security version; future validated OIDC adapter | Session/CSRF/API/DB tests | Identification and Authentication Failures; CWE-287/384 family | SaaS 0 session controls implemented; Entra protocol adapter belongs to #58 |
| CSRF | Cross-site unsafe cookie-authenticated request | SameSite cookie + exact Origin defense-in-depth + session-bound HMAC synchronizer token on unsafe protected endpoints | Session/API/DAST negative cases | CWE-352 | Implemented; every future unsafe cookie-auth endpoint must opt into CSRF verification |
| XSS / unsafe output | Malicious stored/input text reflected into browser | API emits JSON, no server HTML; default-deny CSP; frontend owns safe rendering/encoding | HTTP security-header tests + frontend browser security tests | CWE-79 | Backend control implemented; frontend remains separate enforcement boundary |
| SQL/NoSQL/command injection | Crafted input reaches persistence/runtime execution | Positive schemas, fixed SQL, PostgreSQL parameter binding, no dynamic code execution | Static gate + real PostgreSQL integration tests + malformed input tests | Injection; CWE-89 | Implemented for current repositories; provider/query builders must preserve binding |
| SSRF | User-controlled URL or redirect reaches provider network | Provider-neutral URL-free application contract; fixed/allowlisted adapter destinations; constrained/disabled redirects; explicit timeouts; response validation | Static architecture gate; provider-contract tests when adapter lands | CWE-918 | No production outbound transport yet; Entra/Graph adapters must satisfy this before enablement |
| Secret/token disclosure | Source, logs, browser, errors, audit payloads | External secret injection; Gitleaks/history scan; repository secret gate; redacted/minimized logs/audit; safe error envelope | Secret Scan, `check:secrets`, log/audit tests | Cryptographic/Information Exposure families | Implemented baseline; provider credentials must use managed secret storage |
| Privilege escalation / confused deputy | Unknown role, Tenant Admin overreach, client-owned authority fields | Deny-by-default recognized role/permission sets; capability intersection; explicit object/workflow policy; separate platform operator boundary | Permission matrix and negative authorization tests | Broken Access Control; CWE-269, CWE-862 | Implemented for current Tenant roles; platform administration remains separate domain |
| Replay / duplicate provider writes | Retry after partial external success | Server-derived idempotency key; provider idempotency contract; Tenant-bound provider reference persistence; optimistic state transitions | Booking/idempotency/recovery/DB tests | CWE-294 family / business-logic replay | Implemented contract in #54; real Graph adapter must preserve idempotency semantics |
| Unsafe redirect/callback | Open redirect or forged OIDC callback | Same-origin browser model; no arbitrary redirect API; future OIDC adapter uses fixed registered redirect URI plus state/nonce validation | DAST request-target checks; future OIDC tests | CWE-601 / authentication failures | No OIDC callback yet; mandatory for #58 |
| Rate/size/resource exhaustion | Oversized bodies/headers, slow requests, key explosion, provider/database exhaustion | HTTP/body/response/header/time bounds; bounded local limiter map; DB pool/query bounds; edge distributed rate limiting for multi-instance deployment | Config tests, HTTP/DAST boundary tests, DB tests | CWE-400 | Application bounds implemented; shared/edge quota evidence required for Pilot deployment |
| Supply-chain compromise | Vulnerable/malicious package/action/lifecycle script | Minimal dependencies; exact direct versions; lockfile; `npm ci --ignore-scripts`; high-severity audit; dependency/license policy; pinned Actions; Gitleaks | CI, Dependency Policy, Secret Scan | Software and Data Integrity Failures | GitHub-native dependency review unavailable on current private user-owned repo; repository-local policy is enforced equivalent |
| Insecure deployment configuration | HTTP origin, weak DB TLS, missing secrets, wrong environment metadata | Pilot/Production fail-closed config parsing; HTTPS; `verify-full`; required secrets/build metadata; deployment checklist | Config regression tests + security-baseline gate | Security Misconfiguration | Implemented application preflight; edge/IaC controls require deployment evidence |
| Audit tampering / evidence loss | Modify/reorder/delete audit history or restore stale DB | Append-only trigger; per-Tenant HMAC chain; verified reads; protected HMAC key; backup/retention controls | Audit/DB integrity tests | Software/Data Integrity / logging-monitoring failures | Modified/reordered rows detectable; external completeness anchoring/WORM retention is a Pilot operations decision |
| Information leakage through diagnostics | Stack, SQL, provider body, object IDs in logs/health | Stable error codes; no stack/message; fixed route keys; aggregate health; bounded telemetry labels | API/observability/log-redaction/DAST checks | CWE-200 | Implemented for current routes |

## Provider-specific requirements before Microsoft enablement

### Microsoft Entra ID

The Entra adapter may be enabled only after all of the following are implemented and tested:

- fixed authority/issuer and registered redirect URI from server-controlled configuration;
- OIDC authorization-code flow appropriate to the deployment, with state and nonce validation;
- token signature, issuer, audience and time validation using trusted metadata/keys;
- provider Tenant/account allow policy mapped to the internal Tenant/User records;
- no role derivation from email domain/display name;
- provider claims translated into the provider-neutral trusted-identity contract before session issuance;
- server-side handling of provider credentials/tokens with no browser LocalStorage/sessionStorage persistence;
- callback errors mapped to safe public error codes without provider payload disclosure.

Tracking owner: SaaS 1 Entra/Microsoft identity issue #58 and its implementation PRs.

### Microsoft Graph

A Graph adapter may be enabled only after all of the following are implemented and tested:

- fixed Microsoft Graph origin(s) and explicit endpoint templates; no user-selected URL;
- least-privilege scopes/permissions approved for the concrete capability;
- server-side token acquisition/storage and redaction;
- explicit connect/read/write timeouts and cancellation;
- redirect policy disabled or allowlisted and revalidated on every redirect hop;
- positive validation of Graph response bodies and identifiers;
- throttling/transient/permanent/auth/validation errors mapped to the provider-neutral failure taxonomy;
- retries only where the operation is safe/idempotent and bounded with backoff/jitter;
- create/update/cancel semantics preserve the server-derived idempotency and Tenant binding from #54;
- no raw Graph payload, token or opaque provider reference in Tenant audit/operational telemetry.

## Residual risks and explicit non-claims

1. The in-process rate limiter is defense-in-depth, not a cluster-wide quota mechanism. Pilot/Production must provide edge/shared abuse control and evidence it is active.
2. The audit HMAC chain detects modification/reordering while the key remains protected but does not independently prove completeness after privileged suffix deletion or stale backup restoration. External anchoring/WORM retention is a deployment/governance decision before stronger completeness claims are made.
3. Entra OIDC and Graph outbound adapters are not implemented by #57. This document defines their mandatory security boundary; it does not claim those integrations have been penetration-tested.
4. No container or infrastructure-as-code artifact exists in this repository today. Container/IaC scanning becomes mandatory when such artifacts are introduced.
5. A Pilot penetration test remains required before an external Pilot readiness decision. See `docs/PILOT-PENETRATION-TEST.md`.

## Mandatory release security gates

Every security-relevant release must preserve, as applicable:

- `npm run check` including architecture, security-baseline, static/SAST-oriented, secret, dependency, style, unit/regression/progression/negative and live HTTP DAST-smoke checks;
- `npm run audit` with high-severity blocking;
- PostgreSQL 18 integration tests for persistence/migrations/Tenant isolation when database behavior changes;
- repository-local Dependency Policy workflow;
- full-history Gitleaks Secret Scan;
- mandatory same-Tenant and cross-Tenant tests for every new Tenant-owned resource class;
- malformed/boundary/fuzz cases for new trust-boundary input;
- provider SSRF/redirect/timeout/retry/idempotency tests when outbound adapters are introduced;
- no unresolved required review threads or failing/pending required checks before merge.

The Pilot deployment additionally requires the external/non-production DAST and penetration-test evidence defined in `docs/PRODUCTION-SECURE-CONFIGURATION.md` and `docs/PILOT-PENETRATION-TEST.md`.