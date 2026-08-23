# Security Foundation

## Trust statement

The browser is untrusted. This service is the first trusted business boundary for the production SaaS deployment.

Client-controlled tenant IDs, user IDs, roles, ownership, workflow state, prices, entitlements, availability, provider IDs, audit actor/outcome information, and browser storage never establish authority.

## Controls implemented by issue #47

- Production/pilot public origin must be explicit HTTPS configuration.
- Host validation mitigates host-header confusion for the configured public origin.
- A present Origin header must match the public origin; normal CORS support is not enabled.
- API request targets reject malformed encoding, dot-segment traversal, backslashes, encoded path separators, and absolute/protocol-relative request targets before routing.
- Only the approved method set is accepted.
- Request header size/count, request timeout, header timeout, keep-alive timeout, JSON body size, response size, rate-limit count, and readiness timeout are bounded.
- Security headers include CSP default deny, frame restrictions, no-sniff, no-referrer, same-origin resource/opener policies, permissions restrictions, no-store, and HSTS in pilot/production.
- Correlation IDs are server-generated; client IDs are not treated as unique/authoritative.
- Errors expose stable codes and request IDs, not implementation details.
- Structured operational logs copy only method/path/status/timing/correlation metadata; authorization/cookie/body values are not logged.
- Protected requests require a validated internal principal resolver.
- The CSRF guard is fail-closed for unsafe methods when a protected route requires CSRF verification.
- JSON request helpers enforce media type, no compression, stream/content-length bounds, object shape, explicit allowed fields, and field validators.
- The in-process rate limiter has a bounded key map and fails closed when exhausted.

## Tenant-isolation controls implemented by issue #48

- The canonical Tenant uses a stable internal UUID that is distinct from any identity-provider or integration-provider tenant identifier.
- Tenant context is loaded exclusively from `principal.tenantId` after the internal principal has been validated.
- Client headers, query parameters, route parameters, body fields, provider identifiers, email domains, and UI state do not participate in tenant resolution.
- The runtime architecture gate rejects trusted-source use of `X-Tenant-Id` or equivalent tenant-context headers.
- The canonical Tenant lifecycle is explicit: `pending`, `onboarding`, `ready`, `active`, `suspended`, and `archived`.
- `suspended` and `archived` tenants fail closed for session and business access.
- Productive tenant operations require an `active` Tenant context; onboarding states do not implicitly grant productive access.
- Tenant-owned resource classes are explicitly inventoried, including users, sites, rooms, services, catering data, requests, notifications, integrations, entitlements, audit events, and tenant configuration.
- Tenant-owned repository adapters expose only tenant-scoped lookup/list/create/update/delete methods.
- Mutation payloads cannot set or replace `tenantId`; ownership comes from the server-resolved Tenant context.
- Repository results are revalidated against the requested Tenant so an adapter cannot silently return another tenant's object.
- A resource ID that exists only in another Tenant resolves as absent inside the caller's Tenant scope, preventing cross-tenant object-existence disclosure.
- Cross-tenant read/update/delete attempts, guessed IDs, payload tenant manipulation, tenant-header/query manipulation, concurrent tenants, and adapter-leakage cases are regression/progression tested.

The relational database does not yet exist. Issue #49 must reinforce these application-level invariants with non-null tenant ownership, tenant-aware constraints/foreign keys where applicable, and tenant-scoped persistence integration tests.

## Supply-chain controls

The repository uses `npm ci --ignore-scripts --no-fund`, `npm audit --audit-level=high`, full-history Gitleaks scanning, Dependabot configuration, and a repository-local Dependency Policy gate.

The Dependency Policy gate enforces:

- package manifest and lockfile dependency sections must match exactly;
- direct dependencies must use exact semantic versions instead of ranges or mutable sources;
- direct dependencies must resolve to the exact version recorded in `package-lock.json`;
- installed packages must expose license metadata in the lockfile;
- GPL-3.0 and AGPL-3.0 variants are denied;
- dependencies declaring install lifecycle scripts are rejected;
- high-severity known vulnerabilities block through `npm audit`.

GitHub's native Dependency Review action is unavailable for this private user-owned repository without GitHub Code Security/Advanced Security. The repository-local Dependency Policy workflow is therefore the enforced dependency-change review control rather than leaving a permanently failing platform-specific check. If native Dependency Review becomes available later, it should be enabled in addition to this gate or replace it only after equivalent coverage is demonstrated.

## Important limitations

The service now has a canonical Tenant model, principal-derived Tenant context and tenant-scoped repository contract, but it does not yet implement relational persistence, a real authenticated session, RBAC/object ownership policy, persistent audit storage, distributed rate limiting, or Microsoft provider connections. Those controls are not simulated and must not be claimed as complete.

The service currently accepts requests without an `Origin` header because non-browser health checks and trusted service probes may not send one. Authentication/authorization and CSRF remain mandatory on protected business operations; Origin checks are defense in depth, not an authorization boundary.

The in-memory rate limiter keys by the Node socket remote address by default. A reverse proxy can cause many users to share that address. Do not switch to `X-Forwarded-For` without an explicit trusted-proxy design because arbitrary forwarded headers are attacker-controlled otherwise.

## OWASP/CWE mapping

- Broken Access Control / BOLA / IDOR (CWE-639/CWE-862): Tenant context is principal-derived and the repository contract is tenant-scoped by construction; database-level ownership constraints arrive in #49 and user/object-role policy arrives in #51.
- Authentication/session weaknesses: internal principal and Tenant context fail closed; real session issuance, rotation, revocation and expiry arrive in #50.
- CSRF (CWE-352): verifier contract and fail-closed unsafe-method guard exist; session binding/issuance arrives in #50.
- Injection (including CWE-89): positive request validation exists; parameterized persistence arrives with #49.
- XSS (CWE-79): API emits JSON, uses no HTML rendering, and sets a default-deny CSP; frontend safe rendering remains separately enforced.
- SSRF (CWE-918): no outbound provider transport exists in this slice; future outbound destinations must be fixed/allowlisted under #54/#57.
- Information disclosure: safe error envelope, bounded health output, metadata-only logs and cross-tenant non-disclosure behavior are regression tested.
- Resource exhaustion: request/response/header/time/rate/readiness bounds are explicit; production capacity/load tuning remains operational work.

Automated checks are evidence only for the exercised controls. They are not a penetration-test or complete OWASP compliance statement.
