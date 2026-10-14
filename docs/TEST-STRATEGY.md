# Conference Manager cross-repository test strategy

Tracking: `floriankreutzer/conference-manager#297`. This is the single shared strategy for the
application, trusted API and public website. Each repository's root `AGENTS.md`, coding standards,
architecture/security contracts and executable CI remain authoritative. This document organizes
their evidence; it does not replace them, add a parallel quality framework or authorize exceptions.

## Risk, ownership and test selection

Choose tests from the changed responsibility and its trust boundaries, not a coverage percentage.
The change author identifies affected behavior and executes applicable checks; reviewers assess
scope, negative cases and evidence; the release operator verifies actual deployment/recovery facts.

| Layer and owner | Purpose and change trigger | Executable evidence and runtime boundary |
| --- | --- | --- |
| Fast API domain/application tests | Authorization, validation, workflow, errors, concurrency and provider-neutral policy; every affected rule | API `npm run check`, including native tests, architecture/static/secret/dependency gates and loopback HTTP DAST; quality job 10 minutes |
| API HTTP/security integration | Real session, Tenant, CSRF, object ownership, response/error and outbound boundaries; protected API changes | API check plus Platform HTTP security tests; protocol fixtures do not prove live identity/provider acceptance |
| Real PostgreSQL integration | SQL, constraints, transaction/audit atomicity, migrations, rollback and data integrity; persistence/fixture/database changes | API `npm run test:db`, PostgreSQL 18, fresh disposable database per file, unchanged 120-second per-file cap; job 15 minutes |
| Fast application tests/static checks | Capability contracts, browser validation, i18n, state/persistence and architecture; affected app behavior | App `npm run check` and `npm run audit`; CI quality 10 minutes, including repository-owned Semgrep policy |
| Application browser/accessibility | Visible roles/workflows, keyboard/focus, translations, error/loading states, responsive behavior, semantic accessibility | App `npm run test:e2e`, Chromium desktop and WebKit iPhone profile; CI job 20 minutes; isolated transport canary runs before journeys |
| Paired Shared Demo | Genuine PostgreSQL-backed Customer/Platform separation, roles/Tenants/CSRF/media and business CSV | App shared CI: immutable API commit, Chromium/WebKit, 50-minute job; dedicated actual 200% Chromium tab-zoom check is separate from viewport emulation |
| Permanent three-customer/reset | Northwind rich booking, Contoso authoritative work, Fabrikam onboarding; relevant cross-repository/runtime/data changes | App `npm run test:e2e:saas37`; API CI pins the frontend and permanent acceptance source and runs all four Chromium/WebKit × PostgreSQL/object-fixture rows, 30 minutes per row |
| Fast website/render checks | Public content, routing, locale/metadata, handoff allowlist, form-processing policy, assets and static output | Website Astro/TypeScript check, lint, format check, Vitest, font verification, build, static performance budgets and dependency/secret controls |
| Website browser/accessibility | Navigation, EN/DE, mobile, Login handoff, demo publication, route/SEO and Axe checks | Website `npm run test:e2e`: Chromium desktop/mobile projects; this is not WebKit or a physical-device claim; current validate job has no explicit workflow timeout override |
| Delivered/operational acceptance | Actual TLS/edge, identity, provider/storage, deployment, recovery, load and attributable costs | Governed manual/operational workflows and exact release evidence; repository fixtures, elapsed time and local protocol bytes cannot fill missing provider/invoice/recovery gates |

The workflow budgets above describe current source controls, not performance targets or permission
to increase timeouts. Exact counterpart refs are resolved from the reviewed workflow/render source
for each candidate, never inferred from a moving `main` URL in this document. Do not alter source,
seed/checksum, browser coverage, assertions or security limits merely to fit a budget.

Website baseline commands are `npm run check`, `npm run lint`, `npm run format:check`, `npm test`,
`npm run test:fonts`, `npm run build`, `npm run test:performance`, `npm audit --audit-level=high`
and `npm run test:e2e`. API baseline is `npm run check`, `npm run audit`, `npm run test:db`.
Application baseline is `npm run check`, `npm run audit` plus applicable ordinary/shared/scenario E2E.
Use each repository's declared Node version and lockfile; use locked, reviewed installs in CI.

New behavior needs progression coverage. Changed behavior needs regression coverage. Before a
cohesive refactor, characterize the observable behavior being preserved rather than testing private
implementation shape. Security-sensitive changes require negative/adversarial cases for the actual
boundary: same-/cross-Tenant, owner/non-owner, role/permission, expired/revoked session, missing/invalid
CSRF, malformed/oversized/stale input and failure/rollback as applicable. Database substitutions
cannot prove PostgreSQL concurrency or transactional integrity. Browser mocks cannot prove provider
or server authority. Avoid duplicating every domain combination in slow browser journeys.

## Flaky-test and retry policy

- Preserve the application's ordinary, Shared and permanent-scenario `retries: 0`. The API's pinned
  acceptance inherits the same deterministic contract. A CLI override is not an acceptance shortcut.
- The website retains one existing diagnostic retry. Its configuration must fail on flaky tests:
  fail-then-pass still fails the gate and remains an investigation item. A stable first-attempt pass
  is distinguished from recovery on retry. Do not describe a retry pass as stability.
- Record first failure, exact source/pair, run/job/attempt, browser/storage and bounded diagnostic
  evidence. Whole-workflow reruns retain the earlier failed attempt. Do not relabel or delete it.
- Investigate application, transport, data, limiter, runner or test-orchestration cause. Polling an
  expected asynchronous state is distinct from replaying a whole test or a non-idempotent mutation.
- Retries, broad sleeps, longer deadlines and relaxed assertions are not generic fixes. A specific
  rate-window wait or aggregate budget change requires demonstrated causality, retained failed
  evidence and reviewed unchanged correctness/security assertions.
- Existing context-specific skips must be named with their purpose and separate executed evidence.
  They cannot hide an unavailable customer/reset/browser/security assertion. Quarantine or removal
  cannot waive a release invariant; any intentional contract change needs its product decision.

Concrete example: app #295/PR #294 retained a failed WebKit CSV bootstrap and its minimal phase/status
diagnostic. Session/Tenant/profile responses succeeded while rooms/requests returned HTTP 429. The
fix applies the existing 61-second real-rate-window wait to both engines and persists diagnostics
by attached file path. It does not add retries, raise quotas, weaken assertions or claim every future
run is stable. The failed history and independently passing candidate/Main results remain linked.

## Execution, evidence and release decisions

For each material acceptance retain: objective/risk, command/environment class and versions, exact
candidate/merge/source trees and immutable counterparts, schema/seed/checksum where applicable,
run/job/attempt, measurement window, actual result (including first failure/retry/skip), minimized
artifact reference and any required cleanup/readback. Link defects to their remediation PR and
regression, then record a fresh execution. Public evidence contains no credentials, cookies/tokens,
customer content, production connection strings or raw private operational payloads.

Distinguish local fixtures, real database tests, isolated paired browsers, deployed acceptance and
actual provider/invoice evidence. Synthetic Demo progression is not Production identity, live
Microsoft, paired database/object recovery, penetration testing or formal accessibility certification.
Manual keyboard/representative screen-reader and targeted release reviews remain applicable; Axe,
emulated devices, static budgets and lab measurements cannot claim those reviews or field metrics.

Checks that are failed, pending, skipped or unavailable remain so. Required branch status/review
enforcement must be independently inspected; workflow source alone does not prove it (#296).
Verify all current-head gates and unresolved review findings before merge, and bind the subsequent
Main/deployment evidence separately. Milestone closure never substitutes for later candidate gates.
Retention follows the actual workflow/provider configuration; export required minimized evidence
before expiry to the approved protected destination. Do not invent a universal retention duration.

No paid QA platform, runner, provider experiment or increased quota is implied. Keep the owner's
zero-additional-spend constraint and avoid unnecessary reruns/Hosted traffic. Missing operational
evidence remains a release gate; cost controls do not create included capacity.

## Product-quality objectives and testing terminology

Use ISO/IEC 25010:2023 as a reference model for these project-specific evidence objectives, not as
certification or an assertion of exhaustive subcharacteristic coverage:

| Characteristic | Conference Manager objective and evidence |
| --- | --- |
| Functional suitability | Role-owned booking, settings, onboarding and decisions; domain/use-case tests plus complete customer progression |
| Performance efficiency | Bounded processing and measured latency/bytes/load; isolated baselines plus separately required provider/workload cost evidence |
| Compatibility | Reviewed API envelopes, immutable paired versions, supported engines, integration contracts; no live-provider claim from fixtures |
| Interaction capability | Semantic UI, keyboard/focus, EN/DE, responsive/zoom and error recovery; browser/Axe evidence plus applicable manual review |
| Reliability | Atomic writes, conflicts/idempotency, visible dependency failures, reset and applicable deployed rollback/recovery; unexecuted recovery stays open |
| Security | Server session/Tenant/role/ownership/CSRF, bounded input, privacy, audit and supply chain; negative HTTP/DB tests, static/SAST/secret/audit gates and applicable deployed assessment |
| Maintainability | Cohesive ownership, architecture/dependency gates, characterization/regression and recorded debt disposition; no arbitrary file-size or percentage target |
| Flexibility | Validated environment/provider ports, migration/version compatibility, responsive contexts and bounded capacity; fixtures do not prove an unprovisioned topology |
| Safety | No safety-critical control, hazard mitigation or functional-safety certification is in the current booking-SaaS scope; reevaluate if the product context changes |

ISO/IEC/IEEE 29119 is the terminology/process reference: strategy and scope are this document plus
the issue/PR risk statement; design/coverage rationale is linked to relevant tests; execution and
evidence are actual commands/CI/artifacts; incidents/defects link to remediation and retest. Existing
repository artifacts provide that lightweight traceability. IEEE 829 is not the normative target;
no heavyweight document count or arbitrary line/branch coverage threshold is introduced.

Quality in use (ISO/IEC 25019:2023) is a separate context-of-use concern owned by #298: real role task
completion and trustworthy time-to-complete/feedback must not be inferred from HTTP availability.
Protect feedback sources and minimize telemetry. This strategy does not implement Product/DORA
metrics or assert a successful Pilot user outcome. Reassess objectives when roles/workflows change.

References: [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html),
[ISO/IEC 25019:2023](https://www.iso.org/standard/78177.html),
[ISO/IEC/IEEE 29119-1:2022](https://www.iso.org/standard/81291.html),
[Playwright flaky-test gate](https://playwright.dev/docs/api/class-testconfig#test-config-fail-on-flaky-tests).
Only the public reference descriptions and verified repository behavior underpin this mapping;
no reproduction of the standards or formal conformance assessment is claimed.
