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

This foundation does not yet implement a real authenticated session, tenant lookup, RBAC, database, audit database, distributed rate limiter, or Microsoft provider connection. Those controls are not simulated and must not be claimed as complete.

The service currently accepts requests without an `Origin` header because non-browser health checks and trusted service probes may not send one. Authentication/authorization and CSRF remain mandatory on protected business operations; Origin checks are defense in depth, not an authorization boundary.

The in-memory rate limiter keys by the Node socket remote address by default. A reverse proxy can cause many users to share that address. Do not switch to `X-Forwarded-For` without an explicit trusted-proxy design because arbitrary forwarded headers are attacker-controlled otherwise.

## OWASP/CWE mapping

- Broken Access Control / BOLA / IDOR (CWE-639/CWE-862): principal contract exists; hard tenant/object authorization arrives in #48/#51.
- CSRF (CWE-352): verifier contract and fail-closed unsafe-method guard exist; session binding/issuance arrives in #50.
- Injection (including CWE-89): positive request validation exists; parameterized persistence arrives with #49.
- XSS (CWE-79): API emits JSON, uses no HTML rendering, and sets a default-deny CSP; frontend safe rendering remains separately enforced.
- SSRF (CWE-918): no outbound provider transport exists in this slice; future outbound destinations must be fixed/allowlisted under #54/#57.
- Information disclosure: safe error envelope, bounded health output, and metadata-only logs are regression tested.
- Resource exhaustion: request/response/header/time/rate/readiness bounds are explicit; production capacity/load tuning remains operational work.

Automated checks are evidence only for the exercised controls. They are not a penetration-test or complete OWASP compliance statement.
