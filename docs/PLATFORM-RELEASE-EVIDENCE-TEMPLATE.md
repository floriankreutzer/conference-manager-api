# Platform Control Plane release evidence template

## Template status and handling

This file is a reproducible checklist and blank template for [conference-manager#103](https://github.com/floriankreutzer/conference-manager/issues/103) and [#104](https://github.com/floriankreutzer/conference-manager/issues/104). It is not acceptance evidence and every result below is intentionally `PENDING`.

Copy the template into the approved protected evidence system. Do not commit a completed environment-specific copy automatically. Replace placeholders with non-sensitive immutable references, not embedded reports or credentials.

Allowed result values:

- `PASS` — executed successfully against the exact candidate and independently reviewed;
- `FAIL` — executed and failed, with a finding/reference;
- `PENDING` — not executed, incomplete, stale, mismatched or awaiting review;
- `NOT_APPLICABLE` — only for a conditional P1 capability formally recorded as absent/deferred.

Repository evidence never substitutes for deployed evidence. Demo evidence never substitutes for Production identity, security, provider, audit, break-glass, restore or operations evidence.

## Evidence record metadata

| Field | Value |
| --- | --- |
| Evidence record ID | `<protected-record-reference>` |
| Created at UTC | `<timestamp>` |
| Updated at UTC | `<timestamp>` |
| Candidate environment | `<pilot-candidate-or-production>` |
| Change/release record | `<protected-reference>` |
| Evidence owner | `<role-reference>` |
| Independent security reviewer | `<role-reference>` |
| Independent operations reviewer | `<role-reference>` |
| Test window UTC | `<start>` to `<end>` |
| Final result | `PENDING` |

## Immutable candidate

| Candidate component | Immutable reference | Review result |
| --- | --- | --- |
| `conference-manager` commit | `<full-sha>` | `PENDING` |
| `conference-manager-api` commit | `<full-sha>` | `PENDING` |
| Customer frontend artifact | `<digest-reference>` | `PENDING` |
| Platform frontend artifact | `<digest-reference>` | `PENDING` |
| Customer Demo artifact | `<digest-reference>` | `PENDING` |
| Platform Demo artifact | `<digest-reference>` | `PENDING` |
| Customer API artifact | `<digest-reference>` | `PENDING` |
| Platform API artifact | `<digest-reference>` | `PENDING` |
| Customer Demo API artifact | `<digest-reference>` | `PENDING` |
| Platform Demo API artifact | `<digest-reference>` | `PENDING` |
| Shared Demo PostgreSQL/schema/seed | `<service-schema-42-overlay-7-seed-checksum-reference>` | `PENDING` |
| Deployment/IaC revision | `<immutable-reference>` | `PENDING` |
| PostgreSQL engine/schema | `<protected-service-and-version-reference>` | `PENDING` |
| Operator identity policy | `<registration-and-policy-reference>` | `PENDING` |
| Backup/restore policy | `<protected-policy-reference>` | `PENDING` |

Any partial, mutable, dirty, locally patched or mismatched candidate is `FAIL` or `PENDING`.

## Dependency and scope disposition

| Work item | Requirement | Result | Evidence/decision reference |
| --- | --- | --- | --- |
| #134 | Cross-repository modular architecture gates | `PENDING` | `<reference>` |
| #92 | Accepted Control Plane topology | `PENDING` | `<reference>` |
| #128 | Dedicated operator identity/session/MFA/step-up | `PENDING` | `<reference>` |
| #100 | Separate integrity-protected Platform audit | `PENDING` | `<reference>` |
| #129 | Bounded audited Platform API | `PENDING` | `<reference>` |
| #130 | Separate Platform Admin shell/directory | `PENDING` | `<reference>` |
| #93 | Tenant lifecycle and invitations | `PENDING` | `<reference>` |
| #94 | Fleet readiness | `PENDING` | `<reference>` |
| #95 | Entitlements/packages | `PENDING` | `<reference>` |
| #97 | Microsoft fleet health | `PENDING` | `<reference>` |
| #99 | Privacy-minimized diagnostics | `PENDING` | `<reference>` |
| #101 | Controlled recovery | `PENDING` | `<reference>` |
| #132 | Isolated complete Demo Control Plane | `PENDING` | `<reference>` |
| #96 | Conditional registered-feature rollout | `PENDING` | `<delivered-not-applicable-or-deferral-reference>` |
| #98 | Metering/quota P1 | `PENDING` | `<delivered-or-deferral-reference>` |
| #102 | Runtime/deployment/schema visibility P1 | `PENDING` | `<delivered-or-deferral-reference>` |
| #73 | Microsoft enterprise Pilot foundation | `PENDING` | `<reference>` |
| #91 | SaaS 2 product/self-service gate | `PENDING` | `<reference>` |
| #113 | EU provider/deployment/IaC evidence | `PENDING` | `<reference>` |

## API repository evidence

For each command, attach an immutable protected log that records the exact commit, runner image/runtime, command, UTC time, exit code, test totals, skipped tests and warnings.

| Evidence ID | Exact command | Result | Run/log reference | Reviewer |
| --- | --- | --- | --- | --- |
| API-INSTALL | `npm ci` | `PENDING` | `<reference>` | `<role>` |
| API-CHECK | `npm run check` | `PENDING` | `<reference>` | `<role>` |
| API-AUDIT | `npm run audit` | `PENDING` | `<reference>` | `<role>` |
| API-DB | `npm run test:db` | `PENDING` | `<reference>` | `<role>` |
| API-PLATFORM | `node --test tests/platform-*.test.js` | `PENDING` | `<reference>` | `<role>` |
| API-CUSTOMER-DAST | `npm run test:dast` | `PENDING` | `<reference>` | `<role>` |
| API-PLATFORM-DAST | `npm run test:dast:platform` | `PENDING` | `<reference>` | `<role>` |

Review checklist:

- [ ] No required check was skipped, disabled, narrowed or allowed to fail.
- [ ] Test totals match the candidate inventory and unexpected reductions are resolved.
- [ ] Architecture gates cover separate customer/Platform compositions and dependency direction.
- [ ] Local DAST reaches the real Platform route composition, not only customer routes.
- [ ] PostgreSQL tests cover migrations 029/030 or their final successors, runtime grants, operator/session/grant constraints, Platform audit/checkpoints, rollback guards and cross-Tenant behavior.
- [ ] Customer Employee, Manager and Tenant Admin regression tests remain green.
- [ ] Warnings and pre-existing failures have an explicit release-impact disposition.

## Frontend repository evidence

| Evidence ID | Exact command | Result | Run/log reference | Reviewer |
| --- | --- | --- | --- | --- |
| WEB-INSTALL | `npm ci` | `PENDING` | `<reference>` | `<role>` |
| WEB-CHECK | `npm run check` | `PENDING` | `<reference>` | `<role>` |
| WEB-AUDIT | `npm run audit` | `PENDING` | `<reference>` | `<role>` |
| WEB-E2E | `npm run test:e2e` | `PENDING` | `<reference>` | `<role>` |

Review checklist:

- [ ] Customer Production, Platform Production, customer Demo and Platform Demo composition roots remain independent.
- [ ] Customer `src/app.js` and Tenant Admin cannot import Platform authority.
- [ ] Platform frontend cannot import customer capability/session/storage internals.
- [ ] Production cannot fall back to Demo identity, API adapters, state or storage.
- [ ] Required Chromium and WebKit/iPhone projects ran.
- [ ] Keyboard, focus, label, confirmation, announcement, zoom/reflow and overflow checks are recorded.
- [ ] Demo uses one isolated PostgreSQL state through distinct migration/customer/Platform/reset roles.
- [ ] Demo reset/reseed verifies schema `42`, overlay `7`, sentinel, table inventory and semantic checksum and is external-call free.

## Identity, session, origin, and CSRF evidence

| Evidence ID | Scenario | Environment | Result | Protected reference |
| --- | --- | --- | --- | --- |
| ID-01 | Dedicated operator issuer/audience/Tenant succeeds for a provisioned operator | deployed | `PENDING` | `<reference>` |
| ID-02 | Customer issuer/audience/Tenant and customer claims cannot create Platform authority | deployed | `PENDING` | `<reference>` |
| ID-03 | Disabled/unprovisioned operator fails closed | deployed | `PENDING` | `<reference>` |
| ID-04 | Enterprise MFA/Conditional Access is required | deployed | `PENDING` | `<reference>` |
| ID-05 | High-impact action requires fresh step-up no older than five minutes | deployed | `PENDING` | `<reference>` |
| ID-06 | Privilege removal/security-version change invalidates existing sessions | deployed | `PENDING` | `<reference>` |
| SES-01 | `cm_platform_session` and callback-scoped `cm_platform_oidc_tx` name/path/host-only/Secure/HttpOnly/SameSite/no-Domain verified | deployed browser | `PENDING` | `<reference>` |
| SES-02 | Customer cookie cannot resolve Platform Principal | API/browser | `PENDING` | `<reference>` |
| SES-03 | Platform cookie cannot resolve customer Principal | API/browser | `PENDING` | `<reference>` |
| SES-04 | Expiry, revocation, rotation, logout and stale security epoch fail server-side | API/browser | `PENDING` | `<reference>` |
| CSRF-01 | Missing, malformed and stale Platform CSRF fail every unsafe route | API/DAST | `PENDING` | `<reference>` |
| CSRF-02 | Customer/cross-session CSRF cannot authorize Platform mutation | API/DAST | `PENDING` | `<reference>` |
| ORIGIN-01 | Customer origin does not route Platform namespace | deployed edge | `PENDING` | `<reference>` |
| ORIGIN-02 | Operator origin does not route customer APIs | deployed edge | `PENDING` | `<reference>` |
| ORIGIN-03 | Wrong Host/Origin and credentialed arbitrary CORS fail | deployed edge/DAST | `PENDING` | `<reference>` |

## Authorization and Tenant-target evidence

Execute each relevant operation with permission/assurance/target combinations. A hidden or disabled browser control is not server-side evidence.

| Evidence ID | Scenario | Result | Protected reference |
| --- | --- | --- | --- |
| AUTH-01 | Permission denied, target allowed | `PENDING` | `<reference>` |
| AUTH-02 | Permission allowed, MFA missing | `PENDING` | `<reference>` |
| AUTH-03 | High-impact permission allowed, step-up missing/expired | `PENDING` | `<reference>` |
| TARGET-01 | Permission allowed, Tenant target denied by server allowlist | `PENDING` | `<reference>` |
| TARGET-02 | Tenant-A-only operator submits valid Tenant B identifier | `PENDING` | `<reference>` |
| TARGET-03 | Stale target-scope security version after scope change | `PENDING` | `<reference>` |
| TARGET-04 | Concurrent scope removal during read/mutation | `PENDING` | `<reference>` |
| TARGET-05 | Cross-Tenant cursor/cache/correlation/recovery context replay | `PENDING` | `<reference>` |
| AUTH-04 | Tenant Admin attempts every Platform route/API family | `PENDING` | `<reference>` |
| AUTH-05 | Unknown/forged role, permission or browser authority field | `PENDING` | `<reference>` |

Operations covered:

- [ ] Tenant directory and invitation create/revoke/reissue
- [ ] Readiness and lifecycle transitions
- [ ] Entitlement/package reads/previews/applies
- [ ] Microsoft fleet health
- [ ] Diagnostic summary and sensitive correlation
- [ ] Last-admin, reconsent, mapping, unbind, session and lifecycle recovery
- [ ] Platform audit read/export
- [ ] Metering/quota when delivered
- [ ] Runtime/deployment/schema visibility when delivered

## Audit, mutation, and privacy evidence

| Evidence ID | Scenario | Result | Protected reference |
| --- | --- | --- | --- |
| AUDIT-01 | Platform audit append-only integrity and checkpoint verification | `PENDING` | `<reference>` |
| AUDIT-02 | Tenant Admin/customer runtime/database role cannot read Platform audit | `PENDING` | `<reference>` |
| AUDIT-03 | Audit read/export requires permission, bounds and audit-of-access | `PENDING` | `<reference>` |
| AUDIT-04 | Platform audit failure rolls back privileged mutation | `PENDING` | `<reference>` |
| AUDIT-05 | Tenant audit failure rolls back customer-impacting Platform mutation | `PENDING` | `<reference>` |
| AUDIT-06 | Denied/failed action records bounded evidence without existence leakage | `PENDING` | `<reference>` |
| PRIV-01 | UI/API/log/metric/audit/diagnostic redaction corpus passes | `PENDING` | `<reference>` |
| PRIV-02 | Fleet aggregation, pagination, cache and correlation cannot mix Tenants | `PENDING` | `<reference>` |
| PRIV-03 | Audit/diagnostic export is bounded, authorized, step-up protected and retained | `PENDING` | `<reference>` |
| DATA-01 | Invitation/recovery/idempotency replay and stale concurrency fail closed | `PENDING` | `<reference>` |
| DATA-02 | Database runtime roles enforce least privilege | `PENDING` | `<reference>` |

## Deployed browser, DAST, and penetration evidence

| Evidence ID | Required artifact | Result | Protected reference | Reviewer |
| --- | --- | --- | --- | --- |
| DEPLOY-TOPOLOGY | Distinct origins, routes, processes, secrets and runtime roles | `PENDING` | `<reference>` | `<role>` |
| DEPLOY-ACCESS | Operator network/identity-aware access-layer positive and negative run | `PENDING` | `<reference>` | `<role>` |
| DEPLOY-BROWSER | Critical Production operator flows in required browsers | `PENDING` | `<reference>` | `<role>` |
| DEPLOY-A11Y | Manual and automated accessibility evidence | `PENDING` | `<reference>` | `<role>` |
| DEPLOY-DAST | Authenticated/unauthenticated deployed DAST report and retest | `PENDING` | `<reference>` | `<role>` |
| DEPLOY-PENTEST | Independent privileged Control Plane assessment and retest | `PENDING` | `<reference>` | `<role>` |
| DEPLOY-ALERT | Security/session/break-glass/audit alert delivery drill | `PENDING` | `<reference>` | `<role>` |
| DEPLOY-REDACTION | Deployed logs, traces, metrics and errors inspected | `PENDING` | `<reference>` | `<role>` |

DAST record:

| Field | Value |
| --- | --- |
| Tool and version | `<reference>` |
| Policy/configuration revision | `<reference>` |
| Candidate target reference | `<protected-reference>` |
| Authenticated roles tested | `<role-list>` |
| UTC test window | `<start-end>` |
| Approved exclusions | `<reference-or-none>` |
| Findings/retest | `<protected-reference>` |
| Result | `PENDING` |

Penetration-test record:

| Field | Value |
| --- | --- |
| Independent assessor | `<organization-or-role-reference>` |
| Authorization/rules of engagement | `<protected-reference>` |
| Candidate and scope | `<protected-reference>` |
| Two-Tenant/role matrix completed | `PENDING` |
| Identity/session/CSRF completed | `PENDING` |
| Target manipulation/recovery/audit completed | `PENDING` |
| Information disclosure/resource controls completed | `PENDING` |
| Critical findings open | `<count>` |
| High findings open/accepted | `<count-and-risk-reference>` |
| Retest report | `<protected-reference>` |
| Result | `PENDING` |

## Demo evidence

| Evidence ID | Scenario | Result | Protected reference |
| --- | --- | --- | --- |
| DEMO-01 | Exact customer/Platform frontend and API Demo builds, origins and visible environment identity | `PENDING` | `<reference>` |
| DEMO-02 | Reset/reseed verifies canonical schema `42`, Demo overlay `7` and returns the pinned seed version/checksum | `PENDING` | `<reference>` |
| DEMO-03 | All delivered roles/capabilities and denied paths | `PENDING` | `<reference>` |
| DEMO-04 | Full invitation-to-recovery critical journey | `PENDING` | `<reference>` |
| DEMO-05 | Degraded/stale/concurrent/replay/audit failure simulations | `PENDING` | `<reference>` |
| DEMO-06 | Customer/Platform Demo share PostgreSQL state while their process, role, origin and session authority remain isolated from each other and Production | `PENDING` | `<reference>` |
| DEMO-07 | No real invitation, provider call, customer data or Production credential | `PENDING` | `<reference>` |
| DEMO-08 | Chromium and WebKit/iPhone critical flows | `PENDING` | `<reference>` |

## Operations procedure evidence

For each record, verify environment, role/assurance, preconditions, target confirmation, evidence, failure behavior and escalation are present.

| Evidence ID | Procedure | Result | Protected record | Reviewer |
| --- | --- | --- | --- | --- |
| OPS-01 | Operator authentication/context verification | `PENDING` | `<reference>` | `<role>` |
| OPS-02 | Tenant creation and invitation issue/revoke/reissue | `PENDING` | `<reference>` | `<role>` |
| OPS-03 | Readiness review | `PENDING` | `<reference>` | `<role>` |
| OPS-04 | Activation, suspension, reactivation and archive policy | `PENDING` | `<reference>` | `<role>` |
| OPS-05 | Entitlement/package review and change | `PENDING` | `<reference>` | `<role>` |
| OPS-06 | Microsoft fleet health and Tenant diagnostics | `PENDING` | `<reference>` | `<role>` |
| OPS-07 | Controlled recovery and reconciliation | `PENDING` | `<reference>` | `<role>` |
| OPS-08 | Platform audit read/correlation/export | `PENDING` | `<reference>` | `<role>` |
| OPS-09 | Build/deployment/schema/runtime identification | `PENDING` | `<reference>` | `<role>` |
| OPS-10 | Operator joiner/mover/leaver and periodic review | `PENDING` | `<reference>` | `<role>` |
| OPS-11 | Control-plane outage and compliant grant-bound fallback | `PENDING` | `<reference>` | `<role>` |
| OPS-12 | Last Tenant Admin recovery | `PENDING` | `<reference>` | `<role>` |
| OPS-13 | Pre-activation identity unbind | `PENDING` | `<reference>` | `<role>` |
| OPS-14 | Compromised operator session/identity | `PENDING` | `<reference>` | `<role>` |
| OPS-15 | Platform audit append/integrity incident | `PENDING` | `<reference>` | `<role>` |
| OPS-16 | Encrypted backup and isolated restore | `PENDING` | `<reference>` | `<role>` |
| OPS-17 | Application/schema rollback or forward recovery | `PENDING` | `<reference>` | `<role>` |

## Break-glass evidence

| Check | Result | Protected reference |
| --- | --- | --- |
| Named operator and different named approver | `PENDING` | `<reference>` |
| Exact action/permission and target Tenant | `PENDING` | `<reference>` |
| Bounded reason and approval/change reference | `PENDING` | `<reference>` |
| Externally custodied opaque grant; no shell-history exposure | `PENDING` | `<reference>` |
| One-use/replay protection and expiry no greater than 30 minutes | `PENDING` | `<reference>` |
| Same application service, authorization, target scope and transaction as HTTP | `PENDING` | `<reference>` |
| Platform audit and Tenant audit where applicable | `PENDING` | `<reference>` |
| Issued/used/revoked alert delivery | `PENDING` | `<reference>` |
| Normal UI/API post-restoration reconciliation | `PENDING` | `<reference>` |
| Independent post-action review | `PENDING` | `<reference>` |

If the released fallback wrapper does not enforce every item, break-glass readiness is `FAIL` or `PENDING`; do not execute direct SQL or a generic shell as a substitute.

## Backup, restore, and rollback evidence

| Evidence ID | Required result | Result | Protected reference |
| --- | --- | --- | --- |
| REC-01 | Encrypted backup/PITR point created under accepted policy | `PENDING` | `<reference>` |
| REC-02 | Restore completed in isolated approved environment | `PENDING` | `<reference>` |
| REC-03 | RPO and RTO measured against accepted objectives | `PENDING` | `<reference>` |
| REC-04 | Exact schema/migrations and separate DB grants verified | `PENDING` | `<reference>` |
| REC-05 | Tenant isolation and Platform target negatives pass after restore | `PENDING` | `<reference>` |
| REC-06 | Tenant and Platform audit integrity verified | `PENDING` | `<reference>` |
| REC-07 | Restored sessions/grants revoked or security epoch safely advanced | `PENDING` | `<reference>` |
| REC-08 | Application/schema rollback or reviewed forward recovery succeeds | `PENDING` | `<reference>` |
| REC-09 | Temporary recovery data destroyed per policy | `PENDING` | `<reference>` |

## Findings, limitations, and accepted risk

| Finding/reference | Severity | Affected candidate/control | Owner | Remediation/retest | Risk decision/expiry | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `<reference>` | `<severity>` | `<scope>` | `<owner>` | `<reference>` | `<reference-or-none>` | `PENDING` |

Explicit limitations/non-claims:

- Accepted provider/region and #113 status: `<statement>`
- Delivered P1 capabilities: `<statement>`
- Formally deferred/not-applicable P1 capabilities: `<statement-and-decision-reference>`
- Disabled external/provider capabilities: `<statement>`
- Known availability/accessibility/security limitations: `<statement>`
- Platform audit completeness/WORM/external-anchoring limitation: `<statement>`
- Remaining external acceptance: `<statement>`

## Evidence hygiene review

- [ ] No secret, credential, cookie, session/CSRF/invitation/recovery/break-glass token or token hash is present.
- [ ] No raw OIDC/provider claim or provider payload is present.
- [ ] No connection string, internal host, secret-store path or audit integrity material is present.
- [ ] No naked customer/operator/Tenant/User/provider identifier or unnecessary personal data is present.
- [ ] Every evidence link is access-controlled, immutable or versioned, and available to the named reviewer.
- [ ] Every timestamp is UTC and every run identifies the exact candidate.
- [ ] Every required failure or skipped test is visible and dispositioned.
- [ ] Demo and Production evidence are unmistakably separated.
- [ ] No repository result is described as DAST, penetration, infrastructure, MFA, restore or trained-operator evidence.

## Final reviewer decisions

### #103 production security release gate

| Decision field | Value |
| --- | --- |
| Result | `PENDING` |
| Security reviewer | `<role-reference>` |
| Decision timestamp UTC | `<timestamp>` |
| Blocking evidence IDs | `<list-or-none>` |
| Accepted-risk references | `<list-or-none>` |
| External acceptance complete | `PENDING` |

### #104 operations readiness gate

| Decision field | Value |
| --- | --- |
| Result | `PENDING` |
| Operations reviewer | `<role-reference>` |
| Decision timestamp UTC | `<timestamp>` |
| Blocking procedure IDs | `<list-or-none>` |
| Normal Control Plane operation approved | `PENDING` |
| Grant-bound fallback drill passed | `PENDING` |
| Restore/rollback drill passed | `PENDING` |
| External acceptance complete | `PENDING` |

### GitHub state rule

Until every external item is verified, both issues remain open with `external-acceptance-evidence`. Do not remove the label or close either issue based only on this template, repository tests, simulated Demo results or internally authored review.
