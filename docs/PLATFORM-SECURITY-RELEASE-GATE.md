# Platform Control Plane production security release gate

## Authority, scope, and evidence status

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` remain authoritative. This document prepares the internally executable and deployed evidence required by:

- [conference-manager#103](https://github.com/floriankreutzer/conference-manager/issues/103);
- the accepted topology decision in `conference-manager/docs/SAAS3-PLATFORM-CONTROL-PLANE.md` for [#92](https://github.com/floriankreutzer/conference-manager/issues/92);
- the SaaS 3 roadmap in [#75](https://github.com/floriankreutzer/conference-manager/issues/75);
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/THREAT-MODEL.md`, `docs/PRODUCTION-SECURE-CONFIGURATION.md`, `docs/PLATFORM-OPERATIONS-CONTRACTS.md`, and `docs/PILOT-PENETRATION-TEST.md`.

This document is a release-gate specification, not evidence that the gate passed. It records no live operator, customer, identity-provider, cloud, DAST, penetration-test, backup, restore, or Production result. Repository tests prove only the controls they execute.

Issue #113 remains a release blocker until it supplies the accepted provider and EU region, infrastructure as code, distinct customer/operator origins, DNS/TLS and edge routing, operator access layer, managed secrets, separate runtime database grants, shared abuse controls, telemetry, backup, restore, and rollback evidence.

## Release decision

The release decision is one of:

- `PASS`: every required repository and deployed item is verified against the exact candidate, no blocking finding remains, and independent review is recorded;
- `FAIL`: a required control failed or a blocking finding is unresolved;
- `PENDING`: evidence is missing, stale, not independently reviewed, or belongs to a different candidate;
- `NOT_APPLICABLE`: allowed only for an explicitly conditional P1 capability that is absent from the candidate and formally recorded as not delivered.

Missing evidence is `PENDING`, never presumed successful. A repository result cannot replace deployed evidence, and Demo evidence cannot replace Production security evidence.

Issue #103 requires the exact label `external-acceptance-evidence` while deployed DAST, independent penetration testing, real operator identity/MFA/Conditional Access, deployed browser tests, infrastructure isolation, restore/rollback, and the accountable release decision remain pending. The correct issue state after all internally executable work passes is:

`TECHNICALLY COMPLETE — EXTERNAL ACCEPTANCE EVIDENCE PENDING`

## Candidate identity and entry conditions

Record all of the following before executing the gate:

| Candidate field | Required value |
| --- | --- |
| Frontend repository | Exact immutable `conference-manager` commit SHA |
| API repository | Exact immutable `conference-manager-api` commit SHA |
| Platform frontend artifact | Immutable artifact digest for `platform-admin/index.html` composition |
| Customer API artifact | Immutable artifact digest for the `src/index.js` process |
| Platform API artifact | Immutable artifact digest for the separate `src/platform-main.js` process |
| Customer Demo artifact | Immutable artifact digest for the customer Demo composition |
| Platform Demo artifact | Immutable artifact digest for `platform-admin-demo/index.html` composition |
| Demo API artifacts | Immutable customer and Platform Demo process artifacts from the same API commit |
| Shared Demo database | Isolated PostgreSQL reference; canonical schema `38`, Demo overlay `4`, seed version/checksum |
| Deployment/IaC | Reviewed immutable revision from #113 |
| Database | PostgreSQL 18 service reference and exact schema version |
| Operator origin | Exact approved HTTPS origin, recorded only in the protected evidence system |
| Customer origin | Exact approved HTTPS origin, recorded only in the protected evidence system |
| Identity policy | Dedicated operator Entra registration and Conditional Access policy references |
| Test window | UTC start/end, executor, reviewer, and approved change/test record |

The candidate is ineligible when any of the following is true:

- a critical P0 dependency of #103 is open, unmerged, failing required checks, or lacks its required evidence;
- #134 architecture gates do not pass in both repositories;
- customer and operator origins, processes, cookies, secrets, sessions, or database runtime roles are not distinct;
- Platform routes are registered in the customer process or customer routes are registered in the Platform process;
- the Production composition can load Demo identity, API adapters, state, storage, or credentials;
- either Demo API can load real Entra/Microsoft providers, Production credentials or a non-Demo
  database, or migration/customer/Platform/reset database principals are aliased;
- the Platform API accepts a permission without independently enforcing the operator's server-owned target-Tenant scope;
- the configured step-up lifetime exceeds five minutes without a new accepted architecture/security decision;
- required Platform or Tenant audit evidence can fail without rolling back its authoritative mutation;
- the retired Tenant-operator runtime, package entry point, or process-local authority marker is present, or any local fallback mutation can bypass the approved one-use grant, dual control, Platform authorization, target scope, Platform audit, Tenant audit where applicable, and alerting;
- #113 has not delivered an accepted deployment target on which deployed evidence can be reproduced.

## Test identities and fixtures

Use synthetic, dedicated, non-production test data:

- two independent internal Tenants, Tenant A and Tenant B, with different external identity bindings;
- Employee, Conference Manager, and Tenant Admin identities in each Tenant;
- at least one active operator for each canonical Platform role;
- an allowlist-scoped operator authorized only for Tenant A;
- a fleet-scoped operator where that scope is explicitly approved;
- a disabled operator, an operator with revoked privileges, expired and revoked sessions, an MFA-only session, a fresh step-up session, and an expired step-up session;
- pending, onboarding, ready, active, suspended, and archived Tenant states where the canonical lifecycle permits them;
- open, expired, revoked, and consumed invitation states;
- healthy, degraded, unavailable, revoked, stale, and unknown Microsoft/readiness states;
- deterministic stale revisions, duplicate idempotency keys, replayed recovery contexts, denied targets, and audit-integrity failures;
- separate deterministic Demo fixtures containing no real customer identifiers, credentials, provider tokens, or Production references.
- one isolated Shared Demo database with distinct migration, customer, Platform and reset roles, canonical
  schema `38`, Demo overlay `4`, and the recorded source seed version/checksum.

Do not record raw Tenant/User/operator/provider identifiers, cookies, tokens, claims, secrets, URLs containing credentials, connection strings, invitation artifacts, or customer content in repository evidence.

The candidate's four canonical Platform roles must resolve to this exact server-owned permission matrix. Unknown roles/permissions and any browser/provider-supplied variation fail the complete Principal snapshot.

| Platform role | Exact permissions |
| --- | --- |
| `platform_support_reader` | `platform:tenant:read`, `platform:readiness:read`, `platform:integration-health:read`, `platform:diagnostics:read`, `platform:entitlement:read`, `platform:metering:read`, `platform:runtime:read` |
| `platform_tenant_operator` | Every support-reader permission plus `platform:invitation:manage`, `platform:lifecycle:manage`, `platform:entitlement:manage`, `platform:quota:manage` |
| `platform_security_auditor` | `platform:tenant:read`, `platform:diagnostics:read`, `platform:diagnostics:sensitive`, `platform:audit:read`, `platform:audit:export`, `platform:runtime:read` |
| `platform_security_admin` | `platform:tenant:read`, `platform:diagnostics:read`, `platform:diagnostics:sensitive`, `platform:recovery:execute`, `platform:audit:read`, `platform:session:revoke`, `platform:operator:manage`, `platform:break-glass:manage` |

Invitation, lifecycle, entitlement/quota mutation, sensitive diagnostics, recovery, audit export, session revocation, operator administration and break-glass administration require fresh step-up. `platform_security_admin` is not an unrestricted superuser, and roles do not imply customer authority. P1 permission presence does not claim that its corresponding capability was delivered; #96, #98 and #102 still require the recorded scope disposition below.

## Repository-executable evidence matrix

Run commands from a clean checkout of the exact candidate. Capture command, UTC time, runner identity, exit code, test totals, skipped/failed totals, and a protected immutable log reference.

### API repository

| Evidence | Exact command | Minimum pass condition | Primary scope |
| --- | --- | --- | --- |
| Locked install | `npm ci` | Lockfile-only install succeeds; no unreviewed dependency or lifecycle-script drift | Supply chain |
| Full API gate | `npm run check` | Every configured syntax, instruction, architecture, governance, security, unit/API and local DAST gate exits zero | Repository baseline and customer regression |
| Dependency audit | `npm run audit` | No unmitigated high/critical vulnerability under repository policy | SCA |
| PostgreSQL gate | `npm run test:db` | PostgreSQL 18 migrations, constraints, Tenant isolation, Platform identity/session/audit persistence, concurrency, append-only behavior and rollback tests exit zero | Authoritative persistence |
| Focused Platform suite | `node --test tests/platform-*.test.js` | Every Platform test passes with no required skip | Identity, sessions, audit, target scope, operations, recovery, P1 when delivered |
| Local HTTP DAST | `npm run test:dast` | The real local HTTP server passes bounded request, origin, method, CSRF, session and safe-error checks, including Platform routes once implemented | Transport security |

`npm run check` is necessary but not sufficient. Review its output for warnings, ignored failures, unexpected skips, reduced test totals, disabled gates, unrecognized source files, and a local DAST scope that omits `/api/v1/platform/*`.

The focused Platform suite must include, at minimum:

- canonical roles, permissions, wrong issuer/audience/operator Tenant and forbidden customer-authority claims;
- separately provisioned operator lookup and disabled/unprovisioned denial;
- host-only `cm_platform_session`, narrow `/api/v1/platform` path, no customer-cookie acceptance, hash-only persistence, independent CSRF, expiry, rotation, revocation, stale security version and security epoch;
- MFA on all Platform access and a maximum five-minute step-up window for high-impact permissions;
- target-Tenant allowlist/fleet enforcement independently from permission checks;
- separate Platform audit schema, authorization, integrity verification, append-only behavior, bounded read/export and audit of audit access;
- dual-audit atomicity for customer-impacting mutations and rollback when either required audit append fails;
- dual-controlled one-use break-glass grants bound to operator, target Tenant, exact permission, reason and approval reference, with alert outbox behavior;
- bounded invitation, lifecycle, entitlement, readiness, Microsoft health, diagnostics and recovery contracts;
- stale revision, concurrency, idempotency/replay, confused-deputy and cross-Tenant failures;
- last-admin recovery, identity unbind, session revocation, customer reconsent handoff, room-mapping repair and lifecycle recovery constraints;
- privacy-minimized DTO, logs, metrics, errors and audit metadata;
- P1 metering/quota and runtime/deployment visibility only when delivered, with an explicit product disposition otherwise.

### Frontend repository

| Evidence | Exact command | Minimum pass condition | Primary scope |
| --- | --- | --- | --- |
| Locked install | `npm ci` | Lockfile-only install succeeds | Supply chain |
| Full frontend gate | `npm run check` | Syntax, instructions, localization, architecture, persistence, roles, static, secret, design and unit gates exit zero | Frontend baseline and customer regression |
| Dependency audit | `npm run audit` | No unmitigated high/critical vulnerability under repository policy | SCA |
| Browser suite | `npm run test:e2e` | Required Chromium and WebKit/iPhone projects pass for customer regression, Platform Production composition and both server-backed Demo surfaces | Browser/runtime behavior |

The frontend architecture and browser evidence must prove:

- customer `src/app.js` cannot import `src/platform-admin/`;
- Platform Production and Demo have explicit, independent composition roots;
- Platform modules cannot import Employee, Manager, Tenant Admin, customer `src/platform`, customer session or customer storage authority;
- one Production manifest cannot serve customer and Platform entries on one origin;
- Production cannot fall back to Demo after identity, session, API or configuration failure;
- Demo cannot make real provider calls, send invitations, mutate Production Tenants or use Production credentials;
- customer and Platform Demo observe one PostgreSQL state through independent API processes and
  distinct session/database authority;
- every delivered operator capability has deterministic Demo coverage;
- keyboard operation, focus order and visibility, labels, semantics, confirmation, error/status announcements, zoom/reflow and page-overflow behavior meet repository requirements.

## Mandatory negative security scenarios

### Customer-to-Platform and Platform-to-customer separation

Verify all combinations, not only hidden UI controls:

1. Employee, Conference Manager and Tenant Admin sessions cannot load authorized Platform UI state or call any `/api/v1/platform/*` endpoint.
2. A customer cookie deliberately injected into the operator request resolves no Platform Principal.
3. A Platform cookie deliberately injected into the customer request resolves no customer Principal.
4. Customer Entra issuer, audience, Tenant, subject, roles, groups, email domain or display name cannot create Platform authority.
5. Platform roles/permissions in browser state or a request body are rejected as authority.
6. The customer origin does not route the Platform namespace; the operator origin does not route customer API paths.
7. Tenant Admin cannot read Platform audit or change Platform operators, sessions, scopes or break-glass grants.
8. Platform access never creates a customer impersonation session.

### Origin, routing, CORS, cookie, and CSRF

Verify on the deployed edge and both processes:

- wrong `Host`, wrong present `Origin`, absolute/protocol-relative targets, encoded separators and malformed targets fail before application dispatch;
- arbitrary or reflected credentialed CORS is absent; normal customer and operator operation remains independently same-origin;
- Platform cookies are `Secure`, `HttpOnly`, host-only, `SameSite=Lax` or stricter as compatible with the reviewed OIDC callback, use the narrow Platform path and set no `Domain`;
- customer `cm_session`/`cm_oidc_tx` and Platform `cm_platform_session`/`cm_platform_oidc_tx` have distinct names; the Platform OIDC transaction cookie is callback-scoped and cannot resolve either application session;
- every unsafe cookie-authenticated Platform route rejects missing, malformed, stale, cross-session and customer-session CSRF tokens;
- SameSite and Origin are treated as defense in depth and never replace the session-bound CSRF decision;
- logout, rotation and step-up revoke or replace the prior credential server-side before success;
- duplicate/malformed cookies, expired sessions, revoked sessions, stale privilege snapshots and an obsolete security epoch fail closed.

### Authorization, assurance, and target Tenant

For every operation, exercise the Cartesian negative cases that matter:

| Permission | Assurance | Target scope | Expected result |
| --- | --- | --- | --- |
| Denied | Valid | Allowed | Denied before business/repository access |
| Allowed | Missing MFA | Allowed | `PLATFORM_MFA_REQUIRED` or the stable concealed wire equivalent |
| Allowed high-impact | MFA only or expired step-up | Allowed | Step-up required; no mutation |
| Allowed | Valid | Denied/stale allowlist | Denied before target data access |
| Allowed | Valid | Allowed | Continue to object, lifecycle, entitlement and concurrency checks |

The target Tenant must be confirmed explicitly for mutations, but the submitted Tenant ID is intent only. The server-owned operator scope is authoritative and must be checked independently. Test wrong, stale, deleted and cross-Tenant targets; a valid Tenant B identifier used by a Tenant-A-only operator; stale scope security version; cached page/cursor reuse; and concurrent scope revocation.

### Privileged operation and audit behavior

For invitation, lifecycle, entitlement/package, readiness, diagnostics and recovery:

- exact positive schemas reject authority-shaped or unknown fields;
- existing application services remain the only business-rule owners;
- stale revisions and concurrent transitions return conflict without partial state;
- idempotency replay returns the original safe outcome and key reuse with changed intent fails;
- invitation/recovery credentials are one-use, bounded and never logged or returned after their deliberate one-time presentation;
- diagnostics and fleet views omit customer content, provider payloads, credentials and unapproved identifiers;
- successful privileged mutations append required Platform evidence atomically;
- customer-impacting mutations also append the required Tenant event in the same transaction;
- either required audit failure rolls back the authoritative mutation;
- Platform audit verification fails closed before data is returned;
- Tenant Admin and customer runtime/database roles cannot read Platform audit;
- audit read/export requires its own permission, bounds and fresh step-up where defined, and records the access itself.

### Information disclosure and resource exhaustion

Test responses, redirects, browser storage, HTML, logs, traces, metrics, audit, exports and support diagnostics for:

- cookies, session IDs/hashes, CSRF values, OIDC/provider tokens, raw claims and provider payloads;
- invitation/recovery/break-glass credentials;
- audit keys/hashes/checkpoints not explicitly part of the authorized safe projection;
- connection strings, secret references, internal hosts, stack traces and SQL;
- unnecessary Tenant/User/operator/provider identifiers and customer content;
- unbounded pagination, correlation windows, audit verification, exports, request bodies, headers, retries and response growth;
- high-cardinality Tenant, User, operator, Request or provider metric labels.

Any secret or cross-Tenant disclosure is a release blocker.

## Deployed browser, API, and infrastructure matrix

| Area | Required deployed evidence | Pass condition |
| --- | --- | --- |
| Topology | DNS/TLS, edge route and process evidence for customer and operator origins | Distinct origins and workloads; wrong routes fail closed; no cross-origin credential path |
| Operator access layer | Approved network/identity-aware access policy and negative access attempt | Edge restriction works and API authentication remains independently enforced |
| Identity | Real dedicated single-Tenant operator registration, issuer/audience/Tenant validation, pre-provisioning and denied customer registration | Only approved operator identity maps; no customer JIT path |
| MFA/step-up | Conditional Access policy plus real MFA, step-up and expired-assurance runs | All access has MFA; high-impact actions require fresh step-up no older than five minutes |
| Sessions | Browser cookie capture, expiry, rotation, revocation, privilege removal and compromised-session drill | Old/stale credentials fail server-side and secret material is not exposed |
| Tenant targeting | Two-Tenant positive/negative operation runs, including allowlist denial | Permission cannot bypass server-owned target scope; no BOLA/IDOR disclosure |
| Audit | Representative read/mutation/denial/recovery events, integrity verification and Tenant Admin denial | Platform chain reconstructs actions and remains authorization-separated |
| Database grants | Executed role/grant inspection and negative SQL capability tests from each runtime identity | Customer role cannot reach Platform tables; Platform role has only approved access; neither owns schema |
| Abuse controls | Edge/API rate, size, timeout and bounded-query tests | Safe limits apply without cross-Tenant/shared-state bypass |
| Observability | Alert delivery and redaction checks | Required alerts fire; telemetry contains no prohibited material |
| Demo isolation | Deployed shared-state journey, reset/reseed and no-fallback/browser-storage tests | Demo is server-backed and deterministic; exact schema/seed/checksum match; no Production authority is reachable |
| Accessibility | Chromium and WebKit/iPhone critical flows plus manual keyboard/zoom review | Required operator flows remain perceivable and operable |
| Restore/rollback | Isolated restore plus application/schema rollback or forward-recovery drill | RPO/RTO measured; Platform sessions/audit and Tenant isolation remain correct |

Use at least two independent Tenants for every scenario where target isolation is meaningful. A UI-only denial is not evidence unless the corresponding API request is also denied server-side.

## Deployed DAST requirements

DAST must target the exact operator candidate origin and `/api/v1/platform/*` process. Record scanner/tool version, policy, authenticated and unauthenticated contexts, target/build, UTC window, exclusions, raw protected report reference, triage, retest and final result.

At minimum cover:

- wrong origin/host/routing and CORS;
- authentication/OIDC callback tampering where safely supported;
- session fixation, stale/revoked cookie, cookie attributes and logout;
- CSRF omission, wrong token, cross-session token and cross-origin request;
- role/permission and customer-session escalation;
- target-Tenant manipulation and identifier substitution;
- input/schema/method/content-type/path/size/rate bounds;
- safe errors, redirects, headers and information disclosure;
- audit read/export authorization and recovery endpoints;
- absence of generic command, SQL, Graph, log-query or impersonation endpoints.

The repository-local `npm run test:dast` result is recorded separately and does not satisfy this deployed requirement.

## Independent penetration-test requirements

The existing `docs/PILOT-PENETRATION-TEST.md` remains the baseline. The independent assessor's authorized scope must additionally include:

- operator origin, edge access layer, Platform API process and Platform frontend artifact;
- dedicated Entra registration, operator provisioning, MFA, Conditional Access and step-up;
- customer-to-operator and operator-to-customer credential confusion;
- all canonical Platform roles, combined-role behavior and privilege removal;
- allowlist/fleet target manipulation, BOLA/IDOR and confused deputy;
- invitation, lifecycle, entitlement, diagnostics, audit/export and recovery operations;
- stale revisions, idempotency, recovery-context replay and concurrent target/scope change;
- audit suppression, tampering, unauthorized visibility and dual-audit rollback;
- break-glass grant theft, replay, target/permission substitution, dual-control bypass and missing alert;
- customer impersonation, generic console, direct-provider and raw-log access attempts;
- privacy/information disclosure and resource exhaustion;
- Demo-to-Production fallback or storage/session namespace confusion.

No unresolved Critical finding is permitted. An unresolved High finding blocks release unless the accountable security/risk owner records an explicit time-bounded acceptance, compensating controls, owner, expiry and mandatory retest; repository authors cannot self-approve that evidence.

## External evidence and non-claims

The following cannot be completed by repository documentation or local tests:

- accepted provider, region and infrastructure from #113;
- actual distinct origin, edge, network, TLS/HSTS, managed-secret and database-role configuration;
- real operator Entra registration, operator roster, MFA/Conditional Access and step-up enforcement;
- live alert routing and break-glass grant custody/approval;
- deployed Chromium/WebKit operator flows and accessibility review;
- deployed DAST and independent penetration test;
- provider/cloud log and metric redaction;
- encrypted backup, isolated restore, RPO/RTO and rollback/forward-recovery drill;
- trained-operator and accountable security/operations acceptance.

The Platform audit chain and checkpoints are tamper-evident integrity controls, not independent completeness proof against privileged suffix deletion or restoration of an older internally consistent backup. No WORM, external anchoring or completeness claim is permitted until #113 or another accepted decision implements and evidences that control.

Do not write environment-sensitive evidence into this repository. Store it in the approved protected evidence system and place only a non-sensitive immutable reference in the release record created from `docs/PLATFORM-RELEASE-EVIDENCE-TEMPLATE.md`.

## Completion rule

The #103 gate passes only when:

1. every P0 dependency is merged and its acceptance criteria are evidenced;
2. both repository command matrices pass on the exact candidate;
3. PostgreSQL and architecture tests prove the separate process, identity/session/audit and database boundaries;
4. customer regression and every customer-to-Platform negative case pass;
5. every delivered operator capability has Shared Demo and applicable deployed coverage;
6. deployed topology, identity, MFA/step-up, routing, session, CSRF, target-Tenant, audit and redaction evidence is verified;
7. deployed DAST and independent penetration-test exit criteria pass;
8. restore/rollback evidence covers Platform sessions and Platform audit;
9. each conditional P1 item is delivered and tested, explicitly not applicable, or formally deferred;
10. an independent reviewer records the final `PASS` against the immutable candidate.

Until then the result is `PENDING` or `FAIL`; no security, accessibility, compliance or Production-readiness claim may exceed the evidence actually recorded.
