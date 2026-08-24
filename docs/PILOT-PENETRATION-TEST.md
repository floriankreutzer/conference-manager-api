# Pilot Penetration Test Scope

## Purpose

This document defines the minimum independent penetration-test scope required before the Conference Manager SaaS is declared ready for an external Pilot. It complements automated SAST/SCA/secret/dependency checks, unit/integration security tests and DAST; it does not duplicate them.

The test target is the deployed non-production/Pilot candidate using the same architecture and security configuration intended for the Pilot. Production data and production credentials must not be used as generic test fixtures.

## In-scope components

- Public frontend origin and browser security boundary.
- Public edge/reverse proxy/gateway and `/api/*` routing.
- `conference-manager-api` externally reachable routes.
- Session cookie, CSRF flow and logout/session invalidation behavior.
- Tenant-owned Request and audit endpoints.
- Tenant entitlement effects exposed through enabled product capabilities.
- PostgreSQL-backed authorization/isolation behavior observable through the API.
- Microsoft Entra OIDC flow when the Pilot build enables it.
- Microsoft Graph/calendar integration when the Pilot build enables it.
- Security headers, TLS/HSTS, CORS behavior, redirects/callbacks and error handling.
- Rate/size/resource controls at the edge and API.
- Operational information exposure through health/status and error responses.

Internal source repositories, CI systems and cloud control planes are reviewed separately unless the assessor is explicitly authorized to test them.

## Required test identities and data

Provide dedicated non-production identities only:

- Tenant A Employee;
- Tenant A Conference Manager;
- Tenant A Tenant Admin;
- Tenant B Employee;
- Tenant B Conference Manager;
- Tenant B Tenant Admin;
- at least one disabled/suspended User or Tenant fixture where operationally practical;
- representative Requests and provider references owned independently by Tenant A and Tenant B.

If Entra is enabled, use dedicated Pilot/test provider identities and application registrations. If Graph is enabled, use non-production calendars/resources with no real customer booking impact.

## Mandatory attack scenarios

### 1. Tenant isolation / BOLA / IDOR

Attempt cross-Tenant access using valid identifiers from another Tenant through path, query, body and replayed browser state.

Verify:

- Tenant IDs supplied by the client do not switch authority;
- Employee ownership checks cannot be bypassed;
- Conference Manager scope cannot cross Tenant boundaries;
- Tenant Admin permissions do not imply unrelated Manager capabilities;
- provider references and integration identifiers cannot be rebound across Tenants;
- missing/cross-Tenant/non-owned object behavior does not leak unnecessary existence data.

### 2. Authentication and session abuse

Test:

- malformed, missing, expired and revoked sessions;
- session fixation attempts;
- replay of a pre-rotation session after privilege/security-version change;
- duplicate/malformed cookies;
- cookie scope and browser accessibility;
- logout revocation versus client-only cookie deletion;
- privilege changes followed by stale-session reuse.

If Entra is enabled, additionally test issuer/audience/signature/time validation, state/nonce handling, account/Tenant mapping and callback tampering.

### 3. CSRF

For every cookie-authenticated unsafe route:

- omit the CSRF token;
- supply a wrong/stale token;
- replay a token from another session;
- attempt cross-origin form/fetch requests;
- verify SameSite/Origin checks are defense in depth and server CSRF validation remains required.

### 4. Authorization and privilege escalation

Attempt:

- unknown/forged roles or permissions from browser state/requests;
- role confusion between Employee, Conference Manager and Tenant Admin;
- workflow transitions from ineligible states;
- target-status or requester/owner manipulation;
- entitlement bypass through frontend feature flags or client request fields;
- platform/operator actions using Tenant Admin authority.

### 5. Input validation and injection

Cover:

- malformed/oversized JSON;
- unknown fields and duplicate query fields;
- boundary-length identifiers and reasons;
- encoded path traversal/separators and malformed percent encoding;
- SQL injection payloads across identifiers/text fields;
- command/template/deserialization payloads where applicable;
- stored/reflected script payloads in data later rendered by the frontend.

### 6. SSRF and outbound integration abuse

If an outbound provider adapter is enabled:

- attempt to influence scheme, host, port, path template or redirect destination;
- attempt redirect chains to non-allowlisted hosts and private/link-local addresses;
- validate provider timeouts and cancellation;
- verify malformed provider responses fail closed;
- verify retry handling does not duplicate non-idempotent writes.

### 7. Replay / idempotency / concurrency

Test:

- repeated calendar create after simulated network ambiguity;
- duplicate workflow requests;
- concurrent Request transitions;
- stale client state after a competing update;
- repeated provider callbacks/messages if such endpoints are introduced.

### 8. Information disclosure

Verify responses, headers, health/status, logs available to the assessor and browser artifacts do not expose:

- stack traces or SQL text;
- database/host/internal network details;
- connection strings;
- session IDs/tokens/cookies/CSRF values outside their intended protocol;
- provider tokens or raw provider responses;
- audit HMAC values/keys;
- Tenant/User/provider-reference metadata beyond authorized presentation needs.

### 9. TLS, headers, CORS and redirects

Verify the deployed edge, not only local application code:

- HTTPS-only behavior and certificate/hostname validity;
- accepted TLS versions/ciphers against the organization baseline;
- HSTS;
- CSP/frame/nosniff/referrer/permissions/cross-origin headers;
- no wildcard/reflected credentialed CORS;
- no open redirect or user-selected callback target;
- secure cookie attributes (`Secure`, `HttpOnly`, `SameSite`, narrow Path, no unjustified Domain).

### 10. Resource exhaustion and abuse controls

Within agreed safe limits, verify:

- body/header/request timeout enforcement;
- rate-limit/edge abuse controls;
- repeated unauthenticated/authentication failure handling;
- expensive query/page bounds;
- database/provider timeout behavior;
- no unbounded retry or response growth.

## Automated evidence supplied to the assessor

The release candidate should provide links/artifacts for:

- final PR/commit and green CI;
- `npm run check` result;
- `npm run audit` result;
- PostgreSQL integration/migration test result where applicable;
- Dependency Policy result;
- Gitleaks Secret Scan result;
- repository `npm run test:dast` result;
- deployed-environment DAST result;
- `docs/THREAT-MODEL.md`;
- `docs/PRODUCTION-SECURE-CONFIGURATION.md`;
- current API, authorization, tenancy, session, audit, observability and booking-integration documentation.

## Rules of engagement

- Test only the explicitly authorized Pilot/non-production target, tenants, provider registrations and network ranges.
- Do not perform destructive denial-of-service, bulk data deletion, uncontrolled external messaging/booking or persistence corruption without a separately approved test plan.
- Do not test unrelated Microsoft, GitHub, database-provider or hosting-provider shared infrastructure.
- If a test could affect real users/provider resources, stop and coordinate a controlled fixture instead.
- Treat captured session/provider/database material as confidential test evidence and destroy it according to the agreed evidence-retention process.

## Finding severity and readiness decision

Use a documented risk methodology such as CVSS plus exploitability/business context. At minimum:

- Critical: blocks Pilot readiness.
- High: blocks Pilot readiness unless explicitly accepted by the accountable security/risk owner with compensating controls and expiry/retest date.
- Medium: remediation plan and owner required; Pilot decision records the residual risk.
- Low/Informational: tracked where useful for hardening.

Any confirmed cross-Tenant data access, authorization bypass, session takeover, provider-token disclosure, SQL injection, exploitable SSRF into protected networks or remote code execution is a Pilot blocker.

## Retest and closure evidence

A finding is closed only when:

1. the remediation is implemented through the normal reviewed PR process;
2. regression/progression security tests are added where feasible;
3. repository security/CI gates pass on the remediation;
4. the assessor or an explicitly accepted independent retest verifies the exploit no longer succeeds;
5. the finding record links the affected release/commit and retest evidence.

## Exit criteria

Pilot penetration-test scope is complete only when:

- all in-scope enabled components were tested;
- two-Tenant isolation scenarios were exercised;
- all enabled roles/session/CSRF paths were exercised;
- Entra/Graph scenarios were tested if those integrations are enabled;
- edge/TLS/header/rate-limit behavior was tested on the deployed candidate;
- no unresolved Critical finding remains;
- no unresolved High finding remains without an explicit time-bounded risk decision;
- remediation/retest evidence is linked to the Pilot readiness record.
