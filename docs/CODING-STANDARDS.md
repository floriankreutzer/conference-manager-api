# Coding Standards

This document contains the mandatory detailed engineering standards for `conference-manager-api`. It is referenced by the root `AGENTS.md` and must be followed for every code creation, modification, refactoring, review, test change, migration, and production-facing configuration change.

The repository is the trusted backend boundary for a multi-tenant SaaS product. Security, Tenant isolation, authorization, data integrity, auditability, predictable failure behavior, and production operability take precedence over implementation convenience.

## 1. Scope and authority

- Root `AGENTS.md` is the canonical entry point for repository work.
- This file is the mandatory detailed coding standard referenced by `AGENTS.md`.
- Current `main` is the functional and architectural source of truth.
- Repository-specific architecture, security, API, persistence, tenancy, identity/session, authorization, audit, integration, observability, and deployment documentation is normative for its subject area when consistent with `AGENTS.md` and this file.
- Conversation assumptions, generated suggestions, examples from other repositories, or agent defaults must not override repository standards silently.
- All repository-wide engineering and agent instructions must remain in English.

## 2. Mandatory workflow before implementation

Before changing or reviewing code:

1. Read root `AGENTS.md` completely.
2. Read this `docs/CODING-STANDARDS.md` completely.
3. Use current `main` as the baseline and identify the exact target/base ref.
4. Read the current version of every existing file before modifying it; use its current blob SHA for GitHub Contents API updates.
5. Read the repository documentation relevant to the scope.
6. Identify existing contracts, modules, repositories, policies, schemas, tests, migrations, and security controls that can be reused.
7. Assess regression, progression, Tenant-isolation, authentication, authorization, privacy, audit, persistence, concurrency, integration, operational, and supply-chain impact.
8. Make the smallest coherent and reviewable change that satisfies the requirement.
9. Execute the applicable repository validation and security gates after the final modification.

Do not weaken branch protection, required reviews, required checks, test coverage, security gates, migration checks, secret controls, or production fail-closed behavior to make a change pass.

## 3. Runtime, language, and source conventions

The current runtime is Node.js 22 with native ECMAScript modules.

Mandatory rules:

- Use modern standards-based JavaScript supported by the declared Node.js engine.
- Preserve native ESM unless an explicit architecture decision changes the runtime.
- Do not introduce a framework, transpiler, bundler, ORM, validation framework, provider SDK, or other architectural dependency without explicit need and impact review.
- Keep dependencies minimal and justified.
- Prefer platform APIs and existing repository abstractions over new dependencies.
- Use clear names that expose business/security meaning rather than abbreviated or generic names.
- Avoid magic strings and numbers where stable domain constants or existing identifiers exist.
- Keep functions and modules cohesive, deterministic where practical, and independently testable.
- Avoid generic `utils`, `helpers`, `misc`, or `common` dumping grounds.
- Do not duplicate an existing business rule, authorization decision, validation rule, persistence contract, or provider contract in a second implementation.

## 4. Architecture and dependency direction

Preserve the repository dependency direction:

```text
HTTP / transport
  -> application / use-case services
     -> domain and authorization policies
        -> repository / identity / integration ports
           -> infrastructure adapters
```

Mandatory rules:

- HTTP handlers remain thin and transport-focused.
- Business rules, Tenant policies, authorization decisions, workflow rules, and persistence semantics do not belong in route parsing or response formatting.
- Application/domain/authorization code must not depend on Node HTTP objects, PostgreSQL driver types, migration implementation, identity-provider claims, provider SDK types, or deployment details.
- Infrastructure adapters implement explicit ports/contracts rather than leaking implementation details upward.
- Provider-specific identity and integration data is translated at adapter boundaries.
- Circular dependencies are prohibited.
- Cross-module access must use deliberate public contracts rather than reaching into implementation details.
- Architecture gates must be extended when a new meaningful boundary is introduced.

See `docs/ARCHITECTURE.md` for the current module ownership and dependency model.

## 5. API and HTTP contracts

The API is a security boundary and must be explicit, bounded, and stable.

Mandatory rules:

- Use explicit route, method, content-type, and request-shape contracts.
- Reject unsupported methods and unexpected content types.
- Apply bounded request body, header, URL, collection, string, and complexity limits appropriate to the endpoint.
- Treat all headers, route parameters, query parameters, bodies, cookies, and provider/webhook payloads as untrusted.
- Do not expose stack traces, SQL details, secrets, provider payloads, internal configuration, token material, or implementation details in public errors.
- Use stable machine-readable error codes and deterministic status semantics.
- Do not accept client-controlled fields that duplicate or override server authority such as Tenant identity, user identity, role, permission, ownership, workflow state, entitlement, price, audit actor/outcome, or provider authority.
- Maintain the normal same-origin `/api/*` topology. Cross-origin browser access is an architecture/security change and requires explicit review.
- Preserve HTTPS-only Pilot/Production assumptions and the configured security-header baseline.

## 6. Input validation and data models

All data crossing a trust boundary must be positively validated.

Mandatory rules:

- Validate allowed fields, types, formats, ranges, lengths, counts, enum values, and cross-field invariants.
- Reject malformed, ambiguous, unknown, or dangerous values where the contract requires a closed schema.
- Validate database records and provider responses before treating them as trusted domain data.
- Use stable internal identifiers and validate them before persistence or authorization decisions.
- Use standardized machine formats such as ISO 8601/UTC where applicable.
- Keep localized presentation concerns out of backend data contracts.
- Handle `null`, missing, malformed, stale, and unexpected values deliberately.
- Security-sensitive unknown states must fail closed.

## 7. Tenant isolation

Tenant isolation is mandatory for every Tenant-owned resource and is a security invariant.

- Use the stable internal Tenant ID as the authoritative ownership key.
- Resolve Tenant context only from the authenticated internal Principal/session.
- Never trust a request header, route/query parameter, request body field, provider Tenant identifier, or browser state as independent Tenant authority.
- Tenant-owned repository operations must be scoped by Tenant by construction where practical.
- Database constraints must reinforce Tenant ownership and referential integrity where practical.
- Cross-Tenant identifiers must not reveal global object existence.
- Missing, unknown, suspended, archived, ambiguous, or mismatched Tenant context must fail closed.
- Caches, background jobs, idempotency keys, audit events, provider references, correlation metadata, and observability dimensions must preserve Tenant boundaries.
- Every new Tenant-owned entity or access path requires positive same-Tenant tests and negative cross-Tenant tests.

BOLA / IDOR prevention is not optional and must be verified at object level, not only at route or role level.

## 8. Authentication, sessions, and CSRF

Authentication establishes an internal trusted Principal; raw provider or browser claims never become business authority directly.

Mandatory rules:

- Validate external identity-provider protocol and claims before mapping to the internal Principal model.
- Sessions must remain server-generated, expiring, revocable, and rotated after authentication or privilege changes where required.
- Long-lived provider or application bearer/access/refresh tokens must not be exposed to browser storage.
- Production session cookies must use `Secure`, `HttpOnly`, an appropriate `SameSite` policy, and a narrow `Path`.
- Do not add a broad cookie `Domain` without a reviewed requirement.
- Cookie-authenticated state-changing requests require server-generated and server-validated CSRF protection.
- CSRF tokens must be bound to trusted server session state and compared safely.
- Session expiry, revocation, Principal version/security version, Tenant lifecycle state, and privilege changes must be enforced server-side.
- Missing, malformed, expired, revoked, stale, or otherwise invalid authentication state must fail closed.

See `docs/IDENTITY-SESSION.md` and `docs/SECURITY.md` for the normative current contracts.

## 9. Authorization and object ownership

Authorization is deny-by-default.

Mandatory rules:

- Every protected read and write requires an explicit authorization decision.
- Role alone is not sufficient when permission, Tenant, object ownership, entitlement, workflow state, or other scope is also required.
- Unknown roles, permissions, capabilities, or scopes fail closed.
- Object-level checks are mandatory to prevent BOLA / IDOR.
- Tenant Admin, Conference Manager, Employee, and future Platform/operator responsibilities must remain separate authorization domains unless an explicit policy says otherwise.
- Never infer privileged roles from email domains, display names, browser input, or provider group data without an approved mapping policy.
- Workflow transitions are server-defined and server-authorized; clients may request an allowlisted transition but must not define the resulting authoritative state.
- Authorization failures should conceal object existence where required by the established API contract.
- New permissions or role mappings require a reviewed permission matrix and positive/negative tests.

## 10. Persistence, SQL, and migrations

PostgreSQL is authoritative production persistence.

Mandatory rules:

- Use parameterized SQL for all application values. String concatenation or interpolation must not construct SQL from untrusted data.
- Keep SQL inside approved persistence/infrastructure boundaries.
- Persistence APIs must make Tenant scoping and business invariants explicit.
- Transactions must preserve atomic business invariants and must roll back on failure.
- Do not return success when authoritative persistence or required audit evidence failed.
- Schema changes require versioned, reviewable, repeatable migrations with tested up/down or documented recovery semantics as supported by repository policy.
- Migrations must preserve Tenant ownership, referential integrity, and existing production data invariants.
- The application must not silently auto-migrate at runtime when deployment policy requires explicit migration execution.
- Credentials and connection strings must remain externalized.
- Pilot/Production database TLS and schema-readiness requirements must remain fail closed.

## 11. Concurrency, idempotency, and state transitions

Concurrency must be treated as a correctness and security concern where multiple requests can mutate the same state.

Mandatory rules:

- Identify race conditions for bookings, workflow transitions, session rotation/revocation, entitlement changes, audit sequencing, and other mutable shared resources.
- Use optimistic or pessimistic concurrency controls appropriate to the invariant.
- Do not silently overwrite newer authoritative state.
- Use deterministic, server-derived idempotency keys where duplicate external or internal writes are possible.
- Clients must not be able to select or weaken authoritative idempotency or concurrency controls.
- Retry only operations that are safe to retry according to the contract.
- Do not blindly retry non-idempotent writes.
- Test stale-state, duplicate-request, concurrent-write, and retry/recovery behavior where relevant.

## 12. External integrations and SSRF

Outbound integrations must preserve the server trust boundary.

Mandatory rules:

- User input must never select an arbitrary outbound URL.
- Provider destinations must be fixed or allowlisted in server-controlled configuration.
- Redirect behavior must be constrained or disabled unless explicitly required and validated.
- Apply explicit connection/request timeouts and cancellation.
- Validate provider response status, schema, identifiers, and bounded content before use.
- Translate provider-specific models to provider-neutral internal contracts at the adapter boundary.
- Keep provider credentials, tokens, and secret references server-side.
- Distinguish transient, throttling, authorization, validation, conflict, permanent, and unknown failures.
- Apply bounded retry/backoff only where operation semantics permit it.
- Never log raw provider credentials or sensitive payloads.

SSRF (CWE-918) must be assessed for every new outbound-capable feature.

## 13. Secrets and secure configuration

- Never commit passwords, API keys, access/refresh tokens, session secrets, private keys, production connection strings, or other credentials.
- Supply environment-specific configuration through protected deployment configuration or secret management.
- Separate development, test, Pilot, and Production credentials and data.
- Validate security-sensitive configuration at startup and fail closed for unknown or malformed values.
- Do not silently fall back from production services to demo, in-memory, insecure TLS, browser authority, or default credentials.
- Do not make per-Tenant source-code edits for environment configuration.
- Preserve secure defaults for TLS, HSTS, cookies, CSRF, CORS, CSP/security headers, database TLS, timeouts, request bounds, logging/redaction, and provider destinations.

See `docs/PRODUCTION-SECURE-CONFIGURATION.md` for the Pilot/Production baseline.

## 14. Privacy, logging, audit, and observability

Operational logs and durable audit evidence have different purposes and must remain separate.

Mandatory rules:

- Apply data minimization and purpose limitation.
- Do not log passwords, cookies, raw session IDs, access/refresh tokens, CSRF tokens, private keys, connection strings, or unnecessary personal/confidential data.
- Redact or reject sensitive metadata before it reaches logs, traces, metrics, or audit payloads.
- Keep metric labels and log dimensions bounded and low-cardinality.
- Generate security/workflow audit actor, Tenant, timestamp, action, target, outcome, and correlation data from trusted server context.
- Do not accept client-controlled audit authority.
- Preserve Tenant scoping for Tenant-visible audit access.
- Audit integrity failures must fail closed where the current contract requires verified evidence before read access.
- Correlation IDs are diagnostic identifiers, not authentication or authorization credentials.

## 15. Error handling and failure semantics

Errors must be deterministic, safe, observable, and appropriate to the trust boundary.

Mandatory rules:

- Distinguish validation, authentication, authorization, conflict/concurrency, dependency, availability, throttling, and internal failures where the API contract needs different handling.
- Expose only bounded presentation-safe error information to clients.
- Keep internal stack traces, SQL details, provider payloads, secrets, configuration, and sensitive identifiers out of public responses.
- Log internal failures without leaking secret or excessive personal data.
- Fail closed for security-sensitive unknown states.
- Do not swallow errors that would cause an authoritative mutation, audit event, migration, or external integration to appear successful when it was not.
- Preserve rollback and cleanup semantics on partial failures.

## 16. Dependency and supply-chain security

- Keep runtime and development dependencies minimal, current, and justified.
- Pin direct dependencies through the lockfile according to repository policy.
- Use locked installs in CI.
- Do not enable untrusted lifecycle scripts without explicit review.
- Dependency/SCA policy, vulnerability audit, secret scanning, and SAST/static checks are mandatory gates.
- Do not merge a known unmitigated high/critical vulnerability without an explicit documented risk decision.
- New dependencies require license, maintenance, vulnerability, transitive-risk, runtime-privilege, and replacement-cost assessment.
- When containers or IaC are introduced, add corresponding image/IaC/configuration scanning.

## 17. Testing: regression and progression

Every code change requires test coverage appropriate to its risk.

- Regression tests protect existing behavior affected by a change.
- Progression tests prove newly introduced behavior.
- Security-sensitive behavior requires negative/adversarial coverage in addition to happy paths.
- Do not remove, weaken, skip, narrow, or rewrite valid tests merely to make an incorrect implementation pass.

Depending on scope, include:

- unit/domain/policy tests;
- application/use-case tests;
- HTTP/API integration tests;
- PostgreSQL integration tests;
- migration tests;
- Tenant-isolation and BOLA / IDOR tests;
- role/permission/object-ownership tests;
- authentication/session/CSRF tests;
- malformed/boundary/negative input tests;
- concurrency/idempotency tests;
- provider contract tests;
- log/audit redaction and integrity tests;
- live HTTP DAST/integration checks.

Baseline repository gates are defined by `package.json` and CI. Current expected commands include:

```bash
npm run check
npm run audit
npm run test:db
```

Run additional focused commands when required by the scope.

## 18. OWASP/CWE-oriented secure development

Every material change requires an explicit security assessment proportional to the affected trust boundary.

Assess at minimum as applicable:

- Broken Access Control, BOLA, and IDOR (for example CWE-639, CWE-862);
- authentication and session weaknesses;
- CSRF (CWE-352);
- SQL/NoSQL/command injection (for example CWE-89);
- XSS/output injection where HTML or rich output exists (CWE-79);
- SSRF (CWE-918);
- path traversal;
- unsafe redirects;
- unsafe deserialization;
- credential and information disclosure;
- privilege escalation and confused-deputy behavior;
- replay, stale state, and idempotency failures;
- resource exhaustion and missing rate/size bounds;
- insecure configuration;
- software supply-chain risk.

Automated checks are evidence only for the controls they execute. Do not claim full OWASP coverage, penetration-test completion, regulatory compliance, or production security solely from static/unit tests.

## 19. Observability and operational behavior

Production behavior must be diagnosable without exposing sensitive data.

- Preserve separate liveness, readiness, and aggregate operational-status semantics.
- Required dependencies must affect readiness according to the documented contract.
- Optional provider degradation must not be misreported as full process failure unless the product contract requires it.
- Use bounded structured logs and metrics with stable field names.
- Avoid high-cardinality user, Tenant, Request, provider, or arbitrary-input metric labels unless explicitly approved.
- Include server-generated request/correlation identifiers where useful for investigation.
- Define timeouts, cancellation, graceful shutdown, and dependency-failure behavior for new external/runtime dependencies.
- Do not expose internal dependency topology or secrets through public health endpoints.

## 20. Performance and resource bounds

Performance work must not weaken security, correctness, data integrity, or observability.

- Bound request sizes, collection sizes, pagination, database pools, query timeouts, outbound timeouts, retries, in-memory caches, and rate-limit state.
- Avoid unbounded loops, recursion, queues, retry storms, listener accumulation, or memory growth from user-controlled input.
- Prefer efficient database access patterns that preserve Tenant scoping and authorization.
- Measure before introducing complex performance optimizations.
- Treat denial-of-service and resource-exhaustion risks as security concerns.

## 21. Documentation and change discipline

Update documentation when a change alters architecture, trust boundaries, API contracts, authorization, persistence, migrations, identity/session behavior, integrations, security configuration, observability, or operational requirements.

- Keep documentation aligned with executable behavior.
- State limitations and residual risks explicitly.
- Do not claim controls that are only planned or partially implemented.
- Architecture/security PRs must describe responsibility changes, trust-boundary impact, data/migration impact, regression impact, tests, security impact, and architecture-gate impact.
- Keep unrelated migrations, refactors, new features, provider integrations, and policy changes separate when they are independently reviewable.

## 22. Definition of Done

A change is complete only when the concrete scope demonstrates as applicable:

- required behavior is correct;
- existing behavior is regression-protected;
- new behavior has progression coverage;
- Tenant isolation and BOLA / IDOR controls are preserved;
- authentication/session/CSRF behavior is preserved or explicitly updated;
- authorization and object ownership are deny-by-default and tested;
- validation and bounded processing exist at affected trust boundaries;
- persistence, transactions, migrations, concurrency, and idempotency preserve data integrity;
- SSRF/outbound integration controls are addressed where relevant;
- secrets, privacy, logging, and audit handling remain safe;
- architecture/dependency direction is preserved;
- dependency, static/SAST, secret, DAST, and other configured gates pass;
- required documentation is updated;
- no required CI/security check is failing or still pending before a ready/merge claim.

## 23. Required compliance reporting

Every code creation, modification, refactoring, or code-review response must end with the evidence-based compliance checklist required by root `AGENTS.md`.

Use only these statuses:

- ✅ fulfilled
- ⚠️ partial / not fully verifiable
- ➖ not applicable
- ❌ not fulfilled

Only mark a control fulfilled when the concrete implementation and executed verification support that claim. Clearly distinguish implementation evidence from unexecuted, manual, deployed-environment, penetration-test, or operational verification.