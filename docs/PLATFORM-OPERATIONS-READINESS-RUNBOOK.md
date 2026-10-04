# Platform Control Plane operations readiness and runbook

## Authority, scope, and current evidence status

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` remain authoritative. This runbook prepares the repeatable procedures and evidence required by [conference-manager#104](https://github.com/floriankreutzer/conference-manager/issues/104), after the security release gate in [#103](https://github.com/floriankreutzer/conference-manager/issues/103).

It implements the operational consequences of the accepted decision in `conference-manager/docs/SAAS3-PLATFORM-CONTROL-PLANE.md` and reuses the established safety contracts in:

- `docs/PILOT-READINESS-RUNBOOK.md`;
- `docs/PRODUCTION-SECURE-CONFIGURATION.md`;
- `docs/IDENTITY-SESSION.md`;
- `docs/TENANT-ONBOARDING.md`;
- `docs/TENANT-USER-LIFECYCLE.md`;
- `docs/PLATFORM-OPERATIONS-CONTRACTS.md`;
- `docs/AUDIT.md`;
- `docs/THREAT-MODEL.md`.

This document does not claim that any Production procedure, deployment, operator access policy, break-glass drill, backup, restore, rollback, DAST, penetration test, or trained-operator acceptance has occurred. Issue #113 still blocks the concrete provider, region, infrastructure, origins, access layer, secret custody, database grants, telemetry, backup, restore, and rollback implementation.

## Readiness decision

The Control Plane may be approved as the normal operating channel only when:

- #103 passes against the exact deployed candidate;
- the procedures below have been exercised by trained operators against at least two independent non-production Tenants;
- each procedure records environment, role/assurance, preconditions, target confirmation, expected evidence, failure behavior and escalation;
- operator joiner/mover/leaver and periodic access review are operational;
- the outage fallback is grant-bound, dual-controlled, Platform-audited, alerted and reconciled;
- restore and rollback drills cover Platform session and Platform audit persistence;
- the Demo runbook passes independently without Production credentials or external services;
- every delivered P1 capability is included, and every omitted P1 capability is explicitly `not_applicable` or formally deferred;
- no normal or recovery procedure requires source changes, direct SQL, unrestricted shell/provider/log access, raw token manipulation or customer impersonation.

Issue #104 requires `external-acceptance-evidence` until trained-operator, outage/fallback, access-lifecycle, alerting, backup/restore/rollback and accountable operations acceptance evidence is recorded. After all internally executable preparation is complete, use:

`TECHNICALLY COMPLETE — EXTERNAL ACCEPTANCE EVIDENCE PENDING`

## Environments and evidence separation

| Environment | Permitted purpose | Prohibited evidence claim |
| --- | --- | --- |
| `test` | Repository unit/API/security tests with synthetic adapters | Deployed identity, edge, database, alerting or restore proof |
| Shared customer/Platform Demo | Deterministic server-backed product demonstration and browser E2E without external services | Production MFA, step-up, provider, audit-integrity, break-glass or security proof |
| Pilot/release candidate | Real deployment rehearsal with dedicated test Tenants and identities | Production acceptance until every release gate passes |
| Production | Approved normal operations after release decision | Experimentation, destructive testing or use of Demo fixtures/adapters |
| isolated recovery | Restore, rollback and incident-recovery drills | Normal customer operation or reuse of active Production credentials |

Production and Pilot state remain isolated from Demo. Inside Shared Demo, customer and Platform
origins, processes, cookies, sessions, secrets and database roles remain distinct while authorized
business state is deliberately shared through one Demo PostgreSQL database. A Production
authentication, API, configuration or dependency failure must fail closed and must never select
Demo behavior.

## Mandatory procedure record

Create one protected procedure record for every execution. It must contain:

- immutable frontend, API, Platform artifact and IaC revisions;
- environment and logical operator origin;
- procedure identifier and UTC start/end;
- operator and independent approver evidence references, without raw identity claims;
- Platform role, MFA state and step-up expiry classification;
- internal target-Tenant evidence reference and a separately displayed customer organization label;
- expected current revision/state and requested action;
- server-generated correlation/request ID and change/incident reference;
- bounded result code and before/after state classification;
- Platform audit reference and Tenant audit reference when customer state changed;
- alert reference for break-glass or security response;
- follow-up, reconciliation and independent reviewer decision.

Never store cookies, session IDs or hashes, CSRF values, invitation/recovery/break-glass tokens, provider tokens, raw claims, client secrets, database credentials, audit keys/hashes, provider Tenant IDs, personal data or raw customer content in this record.

## Universal operator checks

Before every procedure:

1. confirm the exact environment visually and against the approved deployment/build view;
2. confirm the operator origin uses the expected valid HTTPS hostname;
3. verify the authenticated operator role, MFA state, session expiry and target scope;
4. obtain fresh step-up for any high-impact action; accepted maximum age is five minutes;
5. open the approved change/incident record and use a new server correlation ID;
6. select the Tenant from the authoritative directory, then independently compare the displayed organization and lifecycle facts with the approved target record;
7. never treat a copied browser Tenant ID as authority;
8. review the operation preview, expected revision, impact codes and confirmation text;
9. stop if the environment, target, scope, assurance, revision, preview or evidence is missing or ambiguous.

Every unsafe operation must use the released UI/API and server-side session, CSRF, permission, assurance, target-scope, business-rule, concurrency and audit controls. Browser confirmation is intent, not authorization.

## Normal operations

### Authenticate and verify operator context

| Field | Requirement |
| --- | --- |
| Environment | Approved Pilot/release candidate or Production operator origin |
| Role/assurance | Any provisioned Platform role; enterprise MFA required |
| Preconditions | Dedicated operator Entra registration and Conditional Access active; operator enabled; no shared account |
| Target confirmation | No Tenant target; verify environment, operator role set, target-scope mode and session expiry |
| Expected evidence | Authentication/session-issued Platform audit, policy reference, browser E2E run and correlation ID |
| Failure behavior | No Platform session for wrong issuer/audience/Tenant, customer identity, missing MFA, disabled/unprovisioned operator or stale security version |
| Escalation | Security on-call for unexpected access; identity operations for configuration/policy failures |

Procedure:

1. enter only through the approved operator origin and access layer;
2. complete the dedicated operator identity flow and MFA;
3. verify environment identification, role/permissions, target-scope mode and session expiry in the minimized session view;
4. confirm that no customer role, customer Tenant or provider claim is displayed as Platform authority;
5. sign out and verify server-side revocation during the readiness drill; authenticate again for later procedures.

### Create a pending Tenant and issue, revoke, or reissue an invitation

| Field | Requirement |
| --- | --- |
| Environment | Approved Pilot/release candidate; Production only under an approved onboarding change |
| Role/assurance | `platform_tenant_operator`; fresh step-up |
| Preconditions | Approved customer onboarding record; unique bounded display name; no conflicting Tenant; secret-delivery channel ready |
| Target confirmation | For creation, confirm organization label and action; for revoke/reissue, confirm internal Tenant via directory plus invitation state/revision |
| Expected evidence | Platform audit; Tenant onboarding audit where defined; correlation ID; one-time protected invitation delivery reference |
| Failure behavior | Unknown/duplicate input, stale revision, target denial, audit failure or artifact-delivery failure leaves no falsely successful operation |
| Escalation | Onboarding operations; security immediately if a token is exposed or delivered to the wrong party |

Procedure:

1. search the directory for an existing organization and resolve duplicates before creation;
2. preview the exact operation and verify target, expiry and impact classification;
3. execute once with the server-generated idempotency/correlation context;
4. reveal an invitation credential only through its deliberate one-time response and transfer it through the approved secret channel;
5. never copy the credential to issue comments, chat, email, logs or the procedure record;
6. verify the resulting invitation state and Platform/Tenant audit references;
7. for revoke/reissue, use the current revision and ensure the prior credential becomes unusable before delivering the replacement.

### Review authoritative readiness

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate or Production |
| Role/assurance | `platform_support_reader` or `platform_tenant_operator`; MFA |
| Preconditions | Tenant exists; required onboarding/integration evidence has a freshness classification |
| Target confirmation | Confirm directory-selected internal Tenant, organization label and lifecycle state |
| Expected evidence | Bounded readiness snapshot, freshness time, blockers, release/build reference and read audit where required |
| Failure behavior | Missing, stale, unknown or inconsistent source data remains explicit and cannot be treated as ready |
| Escalation | Owning onboarding, identity, integration or deployment team according to the blocker code |

Procedure:

1. open the Tenant from the authoritative directory rather than a copied URL;
2. review lifecycle, identity binding, entitlements, Microsoft connection/permissions, room mapping, capability health and evidence freshness;
3. distinguish `blocked`, `stale` and `unknown`; none is equivalent to ready;
4. correlate the snapshot with the relevant customer/Pilot evidence without exposing provider identifiers;
5. resolve blockers through their owning workflow and obtain a new snapshot before lifecycle change.

### Activate, suspend, reactivate, or archive a Tenant

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate or Production |
| Role/assurance | `platform_tenant_operator`; fresh step-up |
| Preconditions | Approved change; canonical source/target transition; current lifecycle revision; readiness true where required |
| Target confirmation | Confirm organization, internal Tenant, current state/revision, requested target and impact preview |
| Expected evidence | Atomic Platform and Tenant lifecycle audit, previous/new state, correlation ID and idempotent receipt |
| Failure behavior | Invalid transition, stale revision, lost readiness, target denial or either required audit failure causes no transition |
| Escalation | Operations owner; security/incident response for unexpected access; database on-call for persistence/audit failure |

Procedure:

1. obtain a fresh readiness snapshot immediately before `ready`, activation or reactivation;
2. review the canonical transition and expected session/business-access effect;
3. execute against the displayed lifecycle revision with exact target confirmation;
4. refresh from authoritative persistence and verify the new state and both audit references;
5. for suspension, confirm existing customer sessions and protected operations fail closed;
6. treat archive as terminal and require the separately approved retention/offboarding decision.

### Review or change entitlements and package metadata

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate or Production |
| Role/assurance | Read: `platform_support_reader`; mutation: `platform_tenant_operator` with fresh step-up |
| Preconditions | Canonical capability catalogue; current Tenant lifecycle, package/entitlement revision and approved commercial change |
| Target confirmation | Confirm Tenant, current package/capabilities, proposed exact diff and downstream impact |
| Expected evidence | Versioned preview, atomic Platform/Tenant audit, resulting capabilities and correlation ID |
| Failure behavior | Unknown capability, dependency/lifecycle violation, preview drift, stale revision or audit failure produces no partial capability change |
| Escalation | Product/entitlement owner; security if a browser flag or Tenant Admin action changes commercial authority |

Procedure:

1. review the server-owned capability catalogue and current effective state;
2. preview the complete package/capability diff and dependent restrictions;
3. compare the preview with the approved commercial record;
4. execute the atomic change using the preview revision and idempotency context;
5. verify the resulting state, readiness effects and both audit domains;
6. record quota/metering separately; they never grant authorization, entitlement or billing authority.

### Review Microsoft fleet health and diagnose one Tenant

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate or Production |
| Role/assurance | Fleet health: `platform_support_reader`; sensitive correlation: authorized auditor/security role with fresh step-up |
| Preconditions | Persisted health/readiness observations; approved diagnostic purpose and bounded time window |
| Target confirmation | Select Tenant from fleet result and reconfirm organization, lifecycle and observation freshness |
| Expected evidence | Minimized health/diagnostic result, bounded correlation window, read audit and incident reference |
| Failure behavior | Stale/unknown data remains explicit; target denial or malformed/cross-Tenant repository data returns no result |
| Escalation | Microsoft integration owner, runtime owner or security depending on the failure class |

Procedure:

1. start with the privacy-minimized fleet view; do not query raw logs or provider consoles;
2. classify healthy, degraded, unavailable, revoked, stale or unknown state;
3. open Tenant diagnostics only for an approved purpose and bounded correlation/time window;
4. verify that returned fields omit customer content, provider payloads and credentials;
5. initiate customer reconsent only through the controlled recovery handoff when indicated; the operator never receives provider consent material;
6. record resolution and audit correlation without copying raw provider data.

### Execute an approved recovery

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate or Production under an incident/change record |
| Role/assurance | `platform_security_admin`; fresh step-up; independent approval for high-impact recovery |
| Preconditions | Normal corrective workflow exhausted; specific recovery type eligible; current revisions and impact inspection available |
| Target confirmation | Confirm Tenant, optional target User/mapping, recovery type, reason, expected impact and bounded recovery-context expiry |
| Expected evidence | Preview/context, approval, atomic Platform/Tenant audit, idempotent receipt, alert when policy requires and post-condition check |
| Failure behavior | Expired/replayed/mismatched context, ambiguous mapping, nonterminal provider reference, stale revision, target denial or audit failure produces no mutation |
| Escalation | Security and service owner; incident commander for Production customer impact |

Allowed recovery types are only those owned by the released application service: last Tenant Admin, customer reconsent handoff, deterministic room-mapping repair, eligible pre-activation identity unbind, Tenant/User session revocation, suspension and readiness-gated reactivation.

Procedure:

1. inspect and preview the exact recovery; do not create a generic support action;
2. obtain the independent approval required by policy;
3. re-confirm target and impact immediately before execution;
4. execute with the one-use recovery context, exact reason, idempotency key and correlation ID;
5. verify authoritative post-conditions, revoked sessions where applicable and both audit domains;
6. close only after the normal customer/operator path is restored and reconciled.

### Review Platform audit and correlate an incident

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate or Production |
| Role/assurance | `platform_security_auditor` or approved security role; export requires fresh step-up |
| Preconditions | Approved investigation purpose; bounded time/sequence range and retention authorization |
| Target confirmation | Confirm correlation/change reference and target Tenant where applicable; do not browse customer content |
| Expected evidence | Verified bounded Platform audit result, audit-of-read/export event and matching Tenant audit references where applicable |
| Failure behavior | Integrity failure returns no events and triggers the audit-integrity procedure |
| Escalation | Security incident response and database/on-call owners |

Procedure:

1. query by the minimum bounded criteria required for the investigation;
2. require integrity verification before viewing results;
3. correlate operator, assurance, target, action, outcome and request ID with the controlled incident record;
4. compare customer-impacting mutations with Tenant-visible audit without granting Tenant Admin Platform visibility;
5. export only when authorized, necessary, bounded and retained securely;
6. verify the read/export was itself recorded.

### Identify release, deployment, schema, and runtime status

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate or Production |
| Role/assurance | Approved role with `platform:runtime:read`; MFA |
| Preconditions | Registered deployment inventory and bounded, fresh observations |
| Target confirmation | Confirm expected environment/deployment; Tenant correlation requires independent target-scope authorization |
| Expected evidence | Minimized build, deployment, schema and aggregate dependency classification |
| Failure behavior | Missing/future/stale/mismatched observations are `unknown`, degraded or mismatch, never healthy |
| Escalation | Release or infrastructure owner; security for cross-environment routing or disclosure |

Procedure:

1. compare the displayed immutable frontend/API build and schema with the approved release record;
2. verify environment and deployment identity without exposing hosts, URLs, credentials or topology details;
3. treat schema/build mismatch or stale observation as a stop condition for mutation;
4. use Tenant-to-deployment correlation only after separate target authorization;
5. follow the rollback/escalation procedure for an unexpected candidate.

## Demo operations runbook

| Field | Requirement |
| --- | --- |
| Environment | Dedicated customer and `platform-admin-demo/index.html` origins, both visibly and persistently identified as Demo |
| Role/assurance | Documented simulated Platform roles; simulated MFA/step-up clearly labelled |
| Preconditions | Exact customer/API/Platform Demo builds; canonical schema `42`; Demo overlay `7`; deterministic seed version/checksum; no Production/customer credentials or external provider configuration |
| Target confirmation | Demo Tenant labels and fixture IDs only; verify Demo banner before every mutation |
| Expected evidence | Build IDs, schema versions, reset seed/checksum, scenario list, shared-state/browser run IDs and reset result |
| Failure behavior | Config, sentinel, role, schema, inventory, lock or checksum mismatch fails closed; Demo never calls Production/Microsoft, sends a real invitation or selects Production fallback |
| Escalation | Demo/product owner; security immediately if any external/Production interaction is observed |

Procedure:

1. verify the isolated database name, distinct migration/customer/Platform/reset roles, separate HTTPS origins, and absence of Production/real-provider configuration;
2. apply the canonical `001..042` migrations, then run `npm run demo:db:migrate` for Demo overlay `001..007`;
3. run `npm run demo:db:reset -- --confirm-seed-version=saas-3.7-three-demo-customers-v1` before process start and record the returned source-defined seed version and semantic checksum;
4. start `npm run start:demo:customer` and `npm run start:demo:platform` as independent processes against the same verified database;
5. establish separate customer and Platform sessions without authenticating to the Production identity provider; verify cookie/session namespaces do not cross;
6. demonstrate each representative customer and Platform role and its denied operations, including CSRF, permission and out-of-scope Tenant denials;
7. execute invitation, readiness, lifecycle, entitlement/package, Microsoft health, diagnostics, audit, approved recovery and customer business journeys;
8. verify a customer mutation appears in an authorized Platform read and a Platform mutation appears in the affected customer flow without browser-state synchronization;
9. demonstrate stale revision, concurrent update, degraded provider, expired/stale session, step-up and recovery outcomes using only deterministic simulated state;
10. execute the authorized Platform reset with exact confirmation, verify its post-reset projection refresh, verify all old sessions fail, re-establish both sessions and compare the seed version/checksum with step 3;
11. verify no real invitation, provider request, Production mutation/audit, external credential or Production configuration was used;
12. record P1 metering/quota, rollout and runtime visibility as delivered, `not_applicable`, or formally deferred.

Simulated identity, MFA, step-up, break-glass, provider and audit behavior is product/demo evidence only. It cannot satisfy #103 or #104 Production security and operations evidence.

If reset reports a sentinel, database/role, schema, inventory, advisory-lock or semantic-checksum
failure, stop both processes. Do not use direct SQL or weaken validation. Recreate the isolated Demo
database from canonical migrations and the Demo overlay, then reseed. See
`docs/SHARED-DEMO-RUNTIME.md` for the full configuration and reset contract.

## Operator access lifecycle

| Field | Requirement |
| --- | --- |
| Environment | Dedicated operator identity Tenant plus matching Pilot/release candidate or Production Platform environment |
| Role/assurance | Identity operations and `platform_security_admin` under MFA/fresh step-up; independent manager/security approval |
| Preconditions | Approved joiner/mover/leaver or periodic-review record; canonical role and target-scope decision |
| Target confirmation | Confirm one exact workforce identity and local operator record through protected identity references, never display name/email inference |
| Expected evidence | External identity change, local operator/security-version/session/grant result, Platform audit, negative access test and reviewer closure |
| Failure behavior | Ambiguous identity, excessive role/scope, missing approval or incomplete revocation blocks the change or continued access |
| Escalation | Identity/security owner; incident response for unexpected or orphaned access |

### Joiner

1. require approved employment/contractor identity, business need, role, target scope, manager and security approval;
2. provision the operator in the dedicated internal identity Tenant and server-side Platform operator store;
3. assign the least-privilege canonical role and an explicit Tenant allowlist unless fleet scope is separately approved;
4. require MFA/Conditional Access enrollment and verify the exact operator registration;
5. execute positive access and negative out-of-scope tests;
6. record `platform.operator.changed` evidence without raw claims or personal data beyond the protected identity record.

### Mover or privilege change

1. approve the new duties, roles and target scope independently;
2. update server-owned roles/scope and increment the operator security version atomically;
3. revoke all existing Platform sessions;
4. require fresh authentication/MFA and step-up where applicable;
5. verify removed permissions and targets fail before repository access;
6. review Platform audit and alert delivery.

### Leaver or emergency disable

1. disable the external workforce identity and local Platform operator record;
2. increment the security version and revoke every active Platform session;
3. revoke active break-glass grants and rotate exposed credentials/security epochs when required by the incident;
4. verify authentication, old sessions, old step-up and target access fail;
5. retain the operator/audit record according to policy; do not delete evidence;
6. perform an independent closure review.

### Periodic review

At the approved cadence, reconcile the workforce roster, local Platform operators, canonical roles, target scopes, active sessions, break-glass grants and audit activity. Remove dormant/excess access, revoke sessions after material changes and record reviewer, discrepancies and closure. Shared operators and orphaned fleet scope are release/operations blockers.

## Control-plane outage and break-glass fallback

All normal mutations use authenticated Platform HTTP with the dedicated Platform Principal/session, CSRF, operation permission,
target scope, step-up, confirmation, concurrency/idempotency, and audit controls. The retired Tenant-operator CLI is not a fallback
and must not be restored. The only local mutation wrapper is `npm run operator:platform-recovery`; its dual-control grant is issued
through `npm run operator:platform-grant`.

| Field | Requirement |
| --- | --- |
| Environment | Affected Pilot/release candidate or Production environment, from an approved administrative execution boundary |
| Role/assurance | Named eligible operator plus a different named approver; MFA/fresh assurance per incident policy |
| Preconditions | Confirmed Control Plane outage/exception, healthy owning service/database, incident commander authorization and compliant wrapper |
| Target confirmation | Exact permission/action and internal Tenant independently matched to the incident record and grant |
| Expected evidence | Issued/used/revoked grant state, Platform/Tenant audit, alert delivery, correlation ID and normal-path reconciliation |
| Failure behavior | Any grant, wrapper, target, authorization, audit, alert or persistence uncertainty blocks mutation |
| Escalation | Incident commander, security, service owner and database/infrastructure owner as applicable |

### Entry conditions

- the operator origin or Platform API is unavailable, or an approved runbook explicitly requires fallback;
- the authoritative database and owning application service remain healthy enough for the requested operation;
- an incident commander records why waiting for restoration is unsafe;
- one named operator and a different named approver authorize the exact permission and target Tenant;
- an externally custodied, server-verifiable, one-use grant is issued for no more than the implemented maximum, which must not exceed 30 minutes under the current contract;
- the grant is delivered through the approved secret mechanism, never a command-line argument, environment dump, shell history, ticket or chat;
- the execution environment is the immutable deployed release with protected configuration and no shared terminal capture.

### Permitted adapter scope

Only the eight fixed recovery workflows supported by the released Platform recovery service may be invoked. The wrapper accepts one
bounded, exact-schema JSON request from descriptor 3. The grant issuer accepts two distinct live step-up Platform session credentials
from descriptor 3 and writes the one-time grant token only to descriptor 4. The administrative execution boundary, not the scripts,
must open those descriptors from the approved ephemeral secret channel. Never redirect descriptor 4 to a terminal or ordinary log.

```text
npm run operator:platform-grant 3<protected-grant-request.pipe 4>protected-grant-token.pipe
npm run operator:platform-recovery 3<protected-recovery-request.pipe
```

The recovery request contains `version: 1`, the protected Platform session and grant tokens, one of
`last-tenant-admin`, `microsoft-reconsent`, `room-mapping-repair`, `identity-unbind`, `tenant-session-revocation`,
`user-session-revocation`, `tenant-suspension`, or `tenant-reactivation`, the internal Tenant and optional bounded target,
reason, exact `{ action, tenantId }` confirmation, correlation ID and idempotency key. Grant requests contain two different
Platform session credentials, exact Tenant and permission, reason, approval reference, TTL of 60–1800 seconds and correlation ID.

These examples do not authorize Production use by themselves. Both Platform sessions and the grant are revalidated against current
database authority. The recovery service issues a one-use preview, then grant consumption, mutation, receipt, dual audit and used-alert
outbox join one serializable transaction. Any failure rolls everything back. Direct SQL and any retired process-local authority path
are not substitutes.

### Execution and reconciliation

1. verify release commit, `NODE_ENV`, schema readiness and target from the protected incident record;
2. verify the grant has a different approver, exact action/target, reason/reference, unused state and remaining lifetime;
3. execute exactly once with the normal target confirmation, current revision, new correlation ID and idempotency key;
4. stop on any grant, authorization, target, audit, persistence, revision or output failure;
5. verify Platform audit, Tenant audit where applicable and the issued/used alert;
6. restore the normal Control Plane before further routine operations;
7. reconcile authoritative state through the normal UI/API and compare correlation/audit evidence;
8. revoke unused grants, close the incident and conduct an independent post-action review.

The fallback must never issue another break-glass grant, open a generic shell/SQL/Graph/log console, impersonate a customer, weaken lifecycle/readiness rules or suppress audit.

## Exceptional recovery procedures

### Recover the last viable Tenant Admin

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate drill; Production only under approved security incident/change |
| Role/assurance | `platform_security_admin`, fresh step-up, independent approver |
| Preconditions | No viable Tenant Admin; out-of-band customer and intended User verification; eligible active User; current revisions |
| Target confirmation | Confirm internal Tenant and exact internal User through trusted records; compare approved organization/contact evidence |
| Expected evidence | One-use recovery preview/context, security-version increment, session revocation, atomic Platform/Tenant audit and fresh-login result |
| Failure behavior | Ambiguous identity, viable existing admin, stale/replayed context, cross-Tenant User or audit failure leaves roles unchanged |
| Escalation | Security incident commander and accountable customer operations owner |

Recover exactly one approved Tenant Admin. Never infer the User from email domain/display name, add a role through direct SQL, or leave existing sessions valid. Require fresh customer authentication and verify the last-admin invariant after recovery.

### Pre-activation identity unbind

| Field | Requirement |
| --- | --- |
| Environment | Pilot/release candidate drill; Production only for an eligible pre-activation Tenant |
| Role/assurance | `platform_security_admin`, fresh step-up, independent approval |
| Preconditions | Canonical lifecycle permits unbind; no nonterminal provider booking reference; impact preview current |
| Target confirmation | Confirm Tenant, binding revision, lifecycle revision, active customer session count and expected Microsoft disconnect effects |
| Expected evidence | Binding unbound, User security versions incremented, sessions revoked, consent state cleared, Microsoft connection reset, dual audit |
| Failure behavior | Active/ambiguous binding, nonterminal reference, stale context, target denial or audit failure leaves authority intact |
| Escalation | Security plus Microsoft integration and booking owners |

Issue a new invitation only after the unbind transaction and evidence are confirmed. Never use unbind as a casual active-Tenant transfer.

### Compromised operator session or identity

| Field | Requirement |
| --- | --- |
| Environment | Affected operator environment |
| Role/assurance | Different uncompromised `platform_security_admin`, fresh step-up; identity/security on-call |
| Preconditions | Incident opened; suspected operator/session bounded; evidence preservation authorized |
| Target confirmation | Confirm operator record and affected session/security epoch without copying credentials |
| Expected evidence | Operator disable or security-version change, all-session revocation, grant revocation, alerts, Platform audit and negative reuse test |
| Failure behavior | If revocation cannot be proven, block operator traffic at the access layer and treat every affected privilege as active |
| Escalation | Security incident commander, identity provider owner, infrastructure/database owners |

Procedure:

1. preserve bounded correlation, access and audit evidence;
2. disable the external operator identity and local operator record;
3. increment security version and revoke every operator session atomically where supported;
4. revoke unused break-glass grants and rotate the Platform session security epoch/secrets only under the reviewed rotation procedure;
5. test that the captured old session and old step-up cannot resolve;
6. review all actions/targets during the exposure window and reconcile customer-impacting mutations;
7. restore access only through the joiner/mover process with new assurance.

### Platform audit append or integrity failure

| Field | Requirement |
| --- | --- |
| Environment | Any affected Platform API/database environment |
| Role/assurance | Security incident response, database owner and `platform_security_auditor` when verified reads remain possible |
| Preconditions | Correlation ID, failure classification and affected operation window captured without exposing integrity material |
| Target confirmation | Identify affected process/database/release and possible target Tenants from trusted records |
| Expected evidence | Mutations blocked/rolled back, incident alert, protected database evidence, verified recovery point and post-recovery integrity result |
| Failure behavior | No privileged mutation may report success; unverified audit rows are not returned or repaired in place |
| Escalation | Immediate security incident and database/infrastructure escalation |

Do not update/delete audit rows, regenerate hashes in place, rotate the audit key casually or suppress verification. Stop affected privileged mutations, preserve the database and logs, determine whether the failure is append, key/configuration, chain, checkpoint, grant or storage related, and recover only through a reviewed fix or verified restore/forward recovery. Reconcile all correlated customer mutations before reopening traffic.

## Backup, restore, and rollback

### Backup and isolated restore drill

| Field | Requirement |
| --- | --- |
| Environment | Approved isolated recovery environment in the accepted region/boundary |
| Role/assurance | Infrastructure/database recovery roles under dual control |
| Preconditions | Encrypted backup/PITR point, immutable application/IaC/config references and approved drill plan |
| Target confirmation | Confirm source environment, backup timestamp, expected schema and recovery destination; never restore over Production for a drill |
| Expected evidence | Restore run, measured RPO/RTO, schema readiness, Tenant isolation, Platform session/audit integrity and destruction record |
| Failure behavior | Failed/mismatched restore remains isolated and blocks readiness |
| Escalation | Infrastructure, database, security and release owners |

After restore:

1. verify exact schema and migration history;
2. verify customer and Platform runtime role grants separately;
3. run Tenant isolation and Platform target-scope negatives;
4. verify Platform audit and Tenant audit chains/checkpoints before authorized reads;
5. verify restored session rows contain hashes only and enforce expiry/revocation/security version;
6. revoke restored active Platform/customer sessions or advance the approved security epoch before any recovered environment could receive user traffic;
7. verify break-glass grants and alert outbox state are reconciled, not replayed;
8. measure RPO/RTO and destroy temporary recovery material according to policy.

A provider statement that backups exist is not restore evidence.

### Application and schema rollback

| Field | Requirement |
| --- | --- |
| Environment | Exact affected Pilot/release candidate or Production deployment; validation in an isolated recovery target where possible |
| Role/assurance | Release, infrastructure and database owners under approved change control |
| Preconditions | Known-good artifact, compatibility decision, pre-deployment recovery point, migration down/forward-recovery review |
| Target confirmation | Confirm environment, workload, artifact digests, schema version and traffic state before action |
| Expected evidence | Deployment/migration log, readiness result, audit/session integrity checks, smoke/security gates and reconciliation |
| Failure behavior | Incompatible schema, protected rollback guard or failed verification keeps traffic stopped and triggers forward recovery/escalation |
| Escalation | Release incident commander, database/infrastructure and security owners |

1. capture an encrypted recovery point before deployment;
2. review every migration's down and forward-recovery semantics, including rollback guards for Platform identity/session/audit data;
3. run migrations explicitly and verify exact schema readiness before traffic;
4. stop or drain only the affected workload according to the deployment plan;
5. roll back application artifacts only when compatible with the authoritative schema;
6. never delete or rewrite Platform audit, Tenant audit, operator, session, grant, role, binding, entitlement or lifecycle evidence to make a down migration pass;
7. prefer reviewed forward recovery when the migration correctly prohibits destructive rollback;
8. rerun #103 repository/deployed smoke gates and reconcile alerts/audit before reopening traffic.

## Failure and escalation matrix

| Condition | Immediate action | Required escalation | Release/operations effect |
| --- | --- | --- | --- |
| Customer identity/session reaches Platform authority | Stop testing/traffic, preserve bounded evidence | Security incident commander | Release blocker |
| Operator crosses denied Tenant target | Stop affected operation and preserve correlation | Security and Tenant-isolation owners | Release blocker |
| Wrong origin/routes or CORS accepts credentials | Remove route from service and isolate edge | Security/infrastructure | Release blocker |
| MFA/step-up absent, stale or over five minutes | Deny operation and invalidate affected session | Identity/security | Release blocker |
| Audit append/integrity failure | Roll back/stop mutation; start audit procedure | Security/database | Control Plane unavailable for affected mutation |
| Secret/customer content in UI/API/log/audit/evidence | Restrict artifact, rotate exposed credential, investigate | Security/privacy | Release blocker until disposition/retest |
| Invitation/recovery/break-glass replay succeeds | Revoke credential/grants and suspend related operation | Security/onboarding | Release blocker |
| Control Plane outage | Use approved read-only diagnostics; enter break-glass only if all controls pass | Incident commander/operations | Routine operations paused |
| Fallback wrapper lacks grant/audit/alert enforcement | Do not execute fallback mutation | Operations/security | #104 pending |
| Build/schema/environment mismatch | Stop mutation and drain/rollback per plan | Release/infrastructure | Deployment blocked |
| Restore misses RPO/RTO or integrity | Keep recovery environment isolated | Infrastructure/database/security | #104 pending |
| Critical/High DAST or penetration finding | Stop release; remediate/retest or obtain allowed accountable risk decision | Security/risk owner | #103 pending/failed |

## Reproducible readiness review

A reviewer must be able to:

1. check out exact frontend and API commits;
2. reproduce all repository commands in `docs/PLATFORM-SECURITY-RELEASE-GATE.md`;
3. identify the immutable Platform, Demo and IaC artifacts;
4. map every normal, Demo and exceptional procedure to a protected evidence reference;
5. verify two independent Tenant journeys and target-isolation negatives;
6. verify operator joiner/mover/leaver, compromised-session and break-glass drills;
7. verify Platform/Tenant audit correlation and audit-integrity failure behavior;
8. verify outage fallback and post-restoration reconciliation;
9. verify encrypted backup, isolated restore, measured RPO/RTO and safe rollback/forward recovery;
10. verify P1 dispositions and all known limitations;
11. confirm that no Demo result is represented as Production evidence;
12. record an accountable operations/security `PASS`, `FAIL` or `PENDING` decision using `docs/PLATFORM-RELEASE-EVIDENCE-TEMPLATE.md`.

Until every applicable step is verified, the Control Plane is not the normal Production operations channel and #104 remains open.
