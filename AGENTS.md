# Repository-Wide Agent Instructions

These instructions are mandatory for every human contributor and every AI coding agent that analyzes, reviews, creates, modifies, refactors, or validates code in `conference-manager-api`.

This repository is the trusted production backend for the Conference Manager SaaS product. Security boundaries, tenant isolation, authorization, data integrity, auditability, and production operability are non-negotiable engineering requirements.

## 1. Canonical source of truth

- This root `AGENTS.md` is the mandatory entry point for all repository work.
- The detailed engineering requirements in `docs/CODING-STANDARDS.md` are mandatory and form part of these instructions.
- All repository-wide coding and agent instructions must be written in English.
- `main` is the current functional and architectural source of truth.
- The approved frontend/topology decision in `floriankreutzer/conference-manager` under `docs/SAAS-PRODUCTION-TOPOLOGY.md` defines the cross-repository trust boundary. This repository must remain compatible with that decision.
- If repository documentation conflicts with an assumption from a conversation, the repository documentation wins unless the conflict is explicitly reviewed and changed.
- Agent-specific instruction files may only point to this file and must not define competing requirements.
- If an agent cannot read this file or the referenced coding standards, it must not modify the repository. It must report that the required instructions could not be loaded.

## 2. Mandatory workflow before every change or review

Before writing, editing, refactoring, or reviewing code:

1. Read this `AGENTS.md` completely.
2. Read `docs/CODING-STANDARDS.md` completely.
3. Treat current `main` as the baseline and determine the target/base ref.
4. Read the current version of every existing file before modifying it; when using the GitHub Contents API, use its current blob SHA.
5. Read all architecture, security, API, persistence, identity, tenancy, observability, and testing documentation relevant to the scope.
6. Identify existing components, contracts, schemas, middleware, repositories, services, tests, and infrastructure patterns that can be reused.
7. Assess regression, progression, tenant-isolation, authorization, authentication/session, privacy, audit, data-integrity, availability, and operational impact.
8. Make the smallest coherent, reviewable change required for the issue. Do not combine unrelated architectural migrations or features.
9. Run the repository validation commands defined by `package.json` and CI after the final modification.

Do not bypass branch protection, required reviews, required status checks, security gates, test gates, migration checks, or secret controls.

## 3. Trust boundary and topology

`conference-manager-api` is the first trusted business boundary behind the same-origin `/api/*` route used by the browser application.

The browser is always untrusted. Never accept client-controlled values as authority for:

- tenant identity or tenant lifecycle state;
- authenticated user identity;
- roles or permissions;
- object ownership;
- workflow status or transition authorization;
- prices, entitlements, resource ownership, booking availability, or provider identity;
- audit actor/outcome data.

Production responsibilities owned by this repository include:

- HTTP API and API contract;
- server-side principal/session validation;
- tenant context and hard tenant isolation;
- RBAC, object ownership, and workflow authorization;
- positive-schema request validation and bounded processing;
- authoritative database persistence and migrations;
- audit/security events;
- tenant entitlements;
- transactional booking integrity;
- identity-provider adapters;
- external integration contracts/adapters;
- secret/credential references and secure server-side access;
- health, readiness, observability, and operational diagnostics.

CORS is disabled by default for the normal same-origin deployment. Any proposal to introduce cross-origin browser access, browser-held long-lived bearer tokens, or client-side production authorization is an architecture change and requires explicit review.

## 4. Architecture and dependency direction

Use explicit dependency direction and separation of concerns. The intended backend direction is:

```text
HTTP / transport
  -> application/use-case services
     -> domain and authorization policies
        -> repository / identity / integration ports
           -> infrastructure adapters
```

Rules:

- HTTP handlers must remain thin and must not contain significant business rules.
- Domain/application code must not depend directly on Fastify/HTTP, database drivers, Microsoft Graph SDK types, or deployment/runtime details.
- Provider-specific identity or integration claims/types must be translated at adapter boundaries.
- Persistence implementation must be behind explicit repository contracts.
- Significant business rules, tenant policies, authorization rules, and workflow transitions must be independently testable without network or database access where practical.
- Do not create generic `utils`, `helpers`, `misc`, or `common` dumping grounds.
- Do not create parallel implementations of the same business rule.
- Circular dependencies are prohibited.
- Architecture checks must be automated where practical.

## 5. Tenant isolation is a security invariant

Tenant isolation is mandatory for every tenant-owned resource.

- Use a stable internal tenant ID; external provider tenant identifiers never replace internal ownership checks.
- Resolve tenant context from the authenticated server-side principal/session.
- Never trust a request header, route parameter, query parameter, or body field as independent tenant authority.
- Tenant-owned persistence must be scoped by construction where practical.
- Cross-tenant identifiers must fail as authorization errors even if syntactically valid.
- Missing, unknown, disabled, ambiguous, or mismatched tenant context must fail closed.
- Every new tenant-owned entity or endpoint requires positive same-tenant tests and negative cross-tenant tests.
- Caches, background jobs, audit events, idempotency keys, provider references, and correlation metadata must also preserve tenant boundaries.

## 6. Authentication, sessions, and authorization

- Business endpoints consume an internal authenticated principal, never raw browser or identity-provider claims.
- Sessions are server-generated, expiring, revocable, and rotated after authentication or privilege changes.
- Production cookies must use `Secure`, `HttpOnly`, an appropriate `SameSite` policy, and a narrow `Path`; do not add a broad `Domain` without a justified requirement.
- Long-lived bearer, access, or refresh tokens must not be exposed to browser storage.
- Cookie-authenticated state-changing requests require server-generated and server-validated CSRF protection.
- Authorization is deny-by-default.
- Unknown roles or permissions fail closed.
- Every protected read and write requires explicit authorization, including object-level authorization to prevent BOLA/IDOR.
- Never infer privileged roles from email domains, display names, client input, or identity-provider groups unless a separately approved mapping policy explicitly defines it.

## 7. Input, output, and API security

Treat all external input as untrusted, including browser payloads, headers, identity-provider claims, webhook payloads, database data written by older versions, and provider API responses.

At every trust boundary:

- validate against positive schemas;
- set explicit length, range, count, and complexity bounds;
- reject unknown or dangerous input where appropriate;
- use standardized machine formats such as ISO 8601/UTC for time and ISO identifiers where applicable;
- keep localized presentation concerns in the frontend;
- use parameterized database queries/ORM binding;
- never dynamically execute code from input;
- do not expose stack traces, SQL details, provider payloads, configuration, secrets, or internal implementation details in API responses.

Same-origin API security must include:

- HTTPS in production;
- fixed API routing;
- redirect controls;
- bounded request/response sizes;
- safe security headers;
- strict content-type handling;
- method allowlists;
- rate/abuse controls appropriate to the endpoint;
- explicit timeouts and cancellation for outbound dependencies.

## 8. SSRF and outbound integration security

- User input must never select arbitrary outbound URLs.
- External provider destinations must be fixed or allowlisted in server-controlled configuration.
- Redirects from outbound requests must be constrained or disabled unless explicitly required and validated.
- Validate provider response shapes before use.
- Apply bounded retries with jitter/backoff only to safe/idempotent operations.
- Distinguish transient, permanent, authorization, throttling, and validation failures.
- Do not blindly retry non-idempotent writes.

## 9. Persistence and migrations

- Production persistence is server-side and transactional.
- Schema changes require versioned, reviewable, repeatable migrations.
- Tenant ownership and referential integrity must be reinforced at database level where practical.
- Transactions must preserve business invariants and must not return success when authoritative persistence failed.
- Concurrency/race conditions must be addressed explicitly for booking and state transitions.
- Use optimistic or pessimistic concurrency controls where appropriate; do not silently overwrite newer state.
- Backup/restore, rollback, and migration recovery must be documented and tested as the persistence layer matures.
- Connection strings and credentials must be externalized.

## 10. Secrets, privacy, and logging

Never store secrets, access tokens, refresh tokens, session IDs, passwords, private keys, or production connection strings in source control.

Logs, traces, metrics, and audit records must exclude or redact:

- passwords and credentials;
- session cookies and session IDs where exposure is unsafe;
- CSRF tokens;
- access/refresh/provider tokens;
- private keys;
- unnecessary personal or confidential business data;
- raw provider payloads unless a specific protected diagnostic need is approved.

Apply data minimization and purpose limitation. Correlation IDs are operational identifiers, not authorization credentials.

## 11. Auditability

Security-relevant and workflow-relevant events must be generated server-side. Do not trust audit actor, timestamp, tenant, or outcome values from the client.

Audit design must support at minimum:

- internal tenant ID;
- authenticated principal;
- action;
- target type/ID;
- previous/new state where applicable;
- UTC timestamp;
- correlation/request ID;
- success/failure outcome;
- non-secret metadata required for investigation.

Tenant-visible audit access must remain tenant-scoped. Platform/operator audit is a separate authorization domain.

## 12. Secure configuration

- Configuration is supplied through environment/deployment configuration, not code edits per tenant or environment.
- Production, pilot, test, and development credentials/data are separated.
- Unknown or malformed security-sensitive configuration must fail closed.
- Do not silently fall back from production services to demo/in-memory/browser authority.
- Security headers, TLS/HSTS, cookie policy, CORS, CSP as applicable, rate/size limits, timeouts, and logging/redaction require explicit production configuration.

## 13. Dependency and supply-chain security

- Keep dependencies minimal and justified.
- Pin direct dependencies through the repository lockfile.
- Use `npm ci` in CI.
- Do not run untrusted lifecycle scripts in CI unless explicitly required and reviewed.
- Dependency audit/SCA, dependency review, SAST/CodeQL or equivalent, and secret scanning are required controls.
- When containers or IaC are introduced, add container/IaC/configuration scanning.
- Do not merge a dependency with a known unmitigated high/critical vulnerability unless an explicit documented risk decision exists.

## 14. Testing requirements

Every code change requires appropriate regression and/or progression coverage.

New functionality requires progression tests. Changes to existing behavior require regression protection. Security-sensitive functionality requires negative/adversarial tests.

Depending on scope, include:

- unit tests;
- application/service tests;
- HTTP/API integration tests;
- repository/database integration tests;
- migration tests;
- tenant-isolation tests;
- permission-matrix/object-ownership tests;
- authentication/session/CSRF tests;
- malformed/boundary/fuzz input tests;
- concurrency/idempotency tests;
- provider contract tests;
- log-redaction tests;
- DAST/integration security checks where deployed runtime is required.

Tests must not be removed, weakened, skipped, or rewritten merely to make an incorrect implementation pass.

## 15. OWASP/CWE-oriented review baseline

For every material change, assess at minimum as applicable:

- Broken Access Control / BOLA / IDOR (for example CWE-639, CWE-862);
- authentication and session weaknesses;
- CSRF (CWE-352);
- XSS/output injection where HTML or rich output exists (CWE-79);
- SQL/NoSQL/command injection (for example CWE-89);
- SSRF (CWE-918);
- path traversal;
- unsafe redirects;
- unsafe deserialization;
- secrets/information disclosure;
- privilege escalation/confused deputy;
- replay/idempotency failures;
- resource exhaustion and missing rate/size bounds;
- insecure configuration and supply-chain risk.

Automated checks are evidence for the controls executed only; never claim complete OWASP, penetration-test, regulatory, or security compliance without the required real verification.

## 16. Git and pull-request discipline

- Do not write directly to protected `main` when pull requests are required.
- Keep changes scoped and reviewable.
- Use the latest current file content/SHA before updates.
- Do not overwrite unrelated work.
- Do not claim a PR is ready while required checks are failing or still pending.
- Review open PR comments and unresolved review threads before finalizing.
- Architecture/security PR descriptions must state responsibility changes, trust-boundary impact, data/migration impact, regression impact, tests, security impact, and architecture-gate impact.

## 17. Definition of Done

A change is complete only when the concrete scope demonstrates:

- behavior is correct;
- tenant isolation and authorization boundaries are preserved;
- input/output validation and secure defaults are implemented;
- data integrity and error behavior are deterministic;
- no secrets or unsafe logging are introduced;
- architecture/dependency direction is preserved;
- appropriate progression/regression/negative tests exist and pass;
- dependency, SAST/static, secret, and configured security gates pass;
- required API/database/migration/security documentation is updated;
- no required check is still pending.

## 18. Required compliance checklist in coding responses

Every code creation, modification, refactoring, or code-review response must end with an evidence-based checklist using only:

- ✅ fulfilled
- ⚠️ partial / not fully verifiable
- ➖ not applicable
- ❌ not fulfilled

Cover at least:

- API/HTTP contract and input validation
- tenant isolation / BOLA / IDOR
- authentication/session/CSRF
- authorization / object ownership
- persistence / migration / data integrity
- SSRF / outbound integration controls
- secrets / privacy / logging
- OWASP/CWE security considerations
- dependency / supply-chain controls
- Clean Code / DRY / SOLID / architecture boundaries
- regression impact
- progression and negative tests
- CI/security gates actually executed

Only mark an item fulfilled when the concrete implementation and executed verification support the statement.

## 19. Permanent three-Demo-customer regression invariant

The SaaS 3.7 Demo dataset is a permanent backend/release invariant. It is not disposable milestone seed data. Every future backend, persistence, migration, authorization, integration, request/booking, media, lifecycle, reset, or Demo-runtime change must keep the data and behavior required for all three canonical Demo customers operational.

- Northwind: active rich customer with ten usable rooms plus equipment, cost centers, catering, media/detail content and the canonical approximately twenty existing booking/request examples.
- Contoso: active smaller customer with genuine Conference Manager work derived from authoritative request, room and catalogue state.
- Fabrikam: onboarding customer with genuine Tenant Admin onboarding work and the provider-discovery/import state required for the onboarding progression.

The canonical seed and reset must remain deterministic, versioned, reproducible and semantically checksummed. Any intentional semantic seed change must update the seed version/checksum and bound cross-repository acceptance evidence in the same reviewed change.

A relevant change is not Definition-of-Done and must not be merged when any canonical customer cannot be provisioned, used through its expected role-owned workflow, isolated from foreign tenants, or restored through the supported reset path. Seed-row existence alone is insufficient evidence.

CI must retain an immutable cross-repository acceptance reference and run the complete three-customer progression plus two canonical reset cycles in Chromium and WebKit against the candidate API. It must also retain the shared role/tenant/CSRF journey. These gates must not be skipped, weakened, reduced to fixture-shape checks, or made optional merely to unblock later development.

If the acceptance contract itself intentionally changes, update the frontend acceptance reference, API seed/reset implementation, checksum/version bindings and documentation together. The exact counterpart frontend commit used for API validation must remain pinned and reviewable.
