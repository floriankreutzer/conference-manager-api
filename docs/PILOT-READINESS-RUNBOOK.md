# Microsoft Enterprise Pilot Readiness and Operations Runbook

## 1. Authority, scope, and evidence status

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` remain authoritative. This runbook defines the controlled operator procedure for the Conference Manager SaaS 1 Microsoft Enterprise Pilot and the evidence required before a Pilot release decision.

No live Pilot evidence is claimed by this document. Repository tests and CI prove only the code and controls they execute. They do not prove a deployed EU runtime, an accepted cloud provider or region, real Microsoft Entra authentication, Microsoft Graph behavior, HTTPS/browser behavior, backup restoration, deployed DAST, penetration testing, or operational monitoring.

Calendar Write remains an optional per-Tenant capability for the SaaS 2 integration health scope. A readiness document with `calendarWrite` set to `disabled` can validate that declared baseline scope, but it is not evidence for the enabled Calendar Write acceptance criterion in issue `#73`. Issue #73 remains open until the enabled path has real acceptance evidence, or its acceptance criteria are changed through an explicit product decision.

The current provider and region decision remains blocked by the PoC and acceptance work tracked in `floriankreutzer/conference-manager#113`. The Pilot must not be declared ready until that decision is accepted and every required item in the readiness evidence contract is verified.

This runbook covers:

- creation of a pending internal Tenant and a single-use customer invitation;
- per-Tenant Microsoft capability entitlements;
- customer-led Entra claiming, Microsoft 365 consent, room discovery, mapping, and Free/Busy verification;
- server-derived readiness review and controlled Tenant activation;
- suspension, reactivation, reconnect, recovery, audit correlation, rollback, and escalation;
- separation of optional Exchange Application RBAC from the baseline Pilot;
- collection and validation of real release evidence.

## 2. Trust and authorization model

The normal browser application remains untrusted. The browser cannot establish or override:

- the internal Tenant ID;
- Tenant lifecycle state;
- roles, permissions, or commercial entitlements;
- Entra Tenant authority;
- provider destinations or Microsoft Graph scope;
- audit actor, outcome, or correlation data.

The customer HTTP composition keeps Platform/operator mutations default-deny. Normal Pilot operations use the authenticated Platform Control Plane on its dedicated operator origin and Platform API process. Every mutation requires a server-resolved Platform Principal and session, CSRF validation, the exact operation permission, server-owned target-Tenant scope, fresh step-up where policy requires it, positive input and confirmation, concurrency/idempotency controls, and atomic Platform/Tenant audit evidence where applicable.

Readiness is read-only. Tenant Admins may read their own server-derived Pilot readiness through `GET /api/v1/integrations/microsoft365/pilot-readiness`. Authorized Platform operators may read minimized fleet readiness through `GET /api/v1/platform/readiness`. Both routes reject unsafe methods and request bodies. The `pilot:readiness` command validates a protected release-evidence document only; it has no Tenant mutation authority.

The retired Tenant-operator CLI and a process-local object marker are not authentication or authorization and must not be reintroduced. During a Control Plane outage, only the grant-bound Platform recovery fallback documented in `docs/PLATFORM-OPERATIONS-READINESS-RUNBOOK.md` may perform one of its fixed recovery operations. It still requires live Platform sessions, dual control, an exact Tenant/permission-bound one-use grant, canonical application services, audit, alerting, and post-restoration reconciliation.

## 3. Remaining external and manual prerequisites

The following steps cannot be asserted or completed by repository code alone:

1. Accept the EU cloud provider and region after the mandatory PoC in issue `#113`.
2. Provision the approved runtime, PostgreSQL 18 service, network controls, secret management, telemetry destinations, DNS, certificate, and same-origin edge route.
3. Register the central multi-Tenant Microsoft Entra application in the controlled Microsoft environment.
4. Configure the exact HTTPS redirect URI used by the deployed Pilot origin.
5. Store the Entra client secret and application secrets in the approved secret manager.
6. Obtain customer administrator consent in each real Pilot organization.
7. Execute acceptance with two independent Entra organizations and real Exchange Online rooms.
8. Run deployed browser E2E, DAST, penetration testing, redaction verification, backup/restore, rollback, and operational monitoring drills.
9. Record accepted evidence references without copying tokens, secrets, cookies, provider payloads, Tenant identifiers, or personal data into the evidence document.

A failed or incomplete prerequisite is a release blocker. It must not be converted to `not_applicable` unless the evidence contract explicitly allows that status.

## 4. Secure operator environment

Use the approved Platform operator origin and access layer with:

- controlled named human access and change authorization;
- the exact deployed Platform release under review;
- dedicated operator identity, MFA, server-side Platform session, and fresh step-up for high-impact operations;
- protected configuration defined by `docs/PRODUCTION-SECURE-CONFIGURATION.md`;
- an incident/change record containing bounded correlation and outcome evidence, never credentials;
- an approved one-time secret-delivery channel for invitation credentials.

Do not place invitation credentials, Platform cookies, CSRF values, session tokens, fallback grants, internal Tenant identifiers, or customer data in the repository, chat, email, issue descriptions, CI logs, shell history, or normal application logs.

Before approving the exact release candidate for operation, verify:

```bash
npm run check
npm run audit
npm run test:db
```

These commands validate the repository checkout. They do not replace deployed evidence.

## 5. Operational channel safety contract

All normal mutations use authenticated Platform HTTP through the released Platform UI/API. Tenant creation/invitation and lifecycle operations are under `/api/v1/platform/tenants`; entitlement/package preview and apply operations use the bounded Tenant entitlement routes; approved recovery uses the fixed preview/execution routes. These routes require the dedicated Platform session boundary and never accept a customer session or Tenant role as Platform authority.

Mutation requests require CSRF, positive exact schemas, target confirmation, server-owned target scope, fresh step-up where required, expected revisions, and idempotency keys where applicable. Unknown operations, capabilities, targets, fields, lifecycle transitions, stale revisions, confirmation mismatches, audit failures, or persistence failures fail closed without partial success.

Readiness remains a GET-only operation. It cannot create an invitation, alter entitlement or lifecycle state, execute recovery, or grant authority. The retired Tenant-operator entry point is absent. The only local mutation wrappers are the separately governed Platform recovery fallback and its grant issuer; neither is a normal Pilot operating channel.

## 6. Standard Pilot onboarding procedure

### 6.1 Create the change and correlation context

Create or select the approved operational change record. Use a fresh client idempotency UUID for each independently auditable mutation and retain the server-generated request/correlation UUID returned by the Platform boundary. Store the mapping in the controlled operational system, not in application logs.

Do not reuse an idempotency or correlation UUID as an authentication credential or invitation token.

### 6.2 Create the pending Tenant and invitation

1. authenticate to the approved Platform operator origin as `platform_tenant_operator` and obtain fresh step-up;
2. search the authoritative Tenant directory and resolve any possible duplicate organization before creation;
3. open the create-Tenant operation, enter the bounded display name and approved non-secret reason, and verify the exact action/display-name confirmation;
4. execute once through the authenticated Platform HTTP boundary with its server correlation and idempotency context;
5. verify that the canonical onboarding service atomically creates the pending internal Tenant, invitation, operation receipt, and required audit evidence;
6. reveal the one-time invitation token only from the deliberate first successful response and transfer it immediately through the approved secret-delivery channel;
7. verify the resulting directory/invitation state and audit references without copying the token into the procedure record.

An exact idempotent retry never reveals the token again. If delivery fails after successful creation, follow the authenticated revoke/reissue workflow and its expected revision; do not repeat creation blindly or recover the credential from database rows or logs.

The standard customer never receives or enters:

- the internal Conference Manager Tenant ID;
- the Entra application/client ID;
- the external Entra Tenant ID;
- a client secret;
- a PowerShell command.

### 6.3 Customer claims the organization

The customer administrator enters the invitation token in the Conference Manager onboarding page and continues through the fixed same-origin Microsoft sign-in flow.

Expected server behavior:

1. the invitation is resolved server-side by hash;
2. the OIDC transaction binds the trusted invitation context, state, nonce, and PKCE material;
3. Microsoft validates the external organization and user identity;
4. the browser receives only the narrow claim cookie and claim-bound CSRF value;
5. explicit confirmation atomically consumes the claim and invitation, creates the internal Entra binding, changes the Tenant to `onboarding`, and appends audit evidence;
6. the validated claimant receives the one-time first Tenant Admin bootstrap through the existing JIT flow.

Failure or replay must remain fail-closed. Never repair claiming by editing binding, invitation, claim, role, or audit rows manually.

### 6.4 Enable required per-Tenant capabilities

The baseline Microsoft Enterprise Pilot requires these server-side entitlements:

- `microsoft.directory`;
- `microsoft.calendar`.

Calendar Write is optional and remains disabled unless the release decision explicitly enables it.

Through the authenticated Platform Control Plane:

1. select the Tenant from the authoritative directory;
2. read the canonical capability catalogue and current entitlement revision;
3. preview proposals enabling `microsoft.directory` and `microsoft.calendar` while leaving `microsoft.calendar.write` disabled unless separately approved;
4. compare the complete preview with the approved Pilot scope;
5. apply the exact proposal using the displayed revision, target confirmation, fresh step-up, CSRF, and idempotency context;
6. verify the resulting entitlement state, readiness impact, and Platform/Tenant audit evidence.

The service validates each capability, applies server-owned target scope and dependencies, and commits the entitlement, operation receipt, and required audit evidence atomically.

A Tenant Admin cannot grant or alter these commercial/operator entitlements through the browser API.

### 6.5 Connect Microsoft 365 and grant consent

The Tenant Admin performs the guided browser flow:

1. open the Microsoft 365 integration step;
2. start the server-generated admin-consent flow;
3. authenticate as an authorized administrator in the intended customer organization;
4. review the real Microsoft consent screen;
5. complete the callback at the fixed Pilot HTTPS origin;
6. verify the server-derived connection and permission state.

Do not paste Entra application IDs, Tenant IDs, secrets, provider URLs, callback URLs, access tokens, refresh tokens, or raw claims into Conference Manager.

Consent callback failures must be investigated through bounded server error codes and correlation data. Do not retry a callback URL or state value manually.

### 6.6 Discover and map Exchange rooms

The Tenant Admin continues in the browser:

1. discover rooms through the fixed Microsoft Graph Places contract;
2. select rooms returned by the server;
3. map each selected provider room to a valid local site;
4. provide a bounded local name and positive capacity where required;
5. import the selected mappings;
6. review synchronization status.

The browser cannot submit arbitrary Graph URLs, an independent Tenant selector, or a room that was not present in the server-side discovery result.

### 6.7 Verify Free/Busy

Run the guided Free/Busy verification from the onboarding flow. The server selects an active imported room and a bounded future time window; the browser does not choose provider authority for the verification.

Successful verification records server-side capability health. Authorization, throttling, validation, not-found, and availability failures remain bounded and actionable without exposing provider payloads or tokens.

### 6.8 Review server-derived readiness

Select the Tenant from the authenticated Platform directory and load `GET /api/v1/platform/readiness` through the released Platform UI/API. A Tenant Admin may independently load the same Tenant's customer-scoped readiness through `GET /api/v1/integrations/microsoft365/pilot-readiness`. Do not use a copied identifier as independent target authority.

The Platform result contains only the bounded fleet projection authorized for the Platform Principal, including:

- the Tenant identity/display label authorized for the operator scope;
- lifecycle status/revision and onboarding state;
- evaluated readiness state, bounded checks, blockers, and freshness;
- enabled and required-missing entitlement counts;
- bounded repository/deployment/external evidence classifications and timestamps.

It does not expose provider Tenant references, room addresses, user identity, invitation credentials, sessions, CSRF values, provider tokens, secrets, or raw provider responses. The customer result remains scoped to the authenticated Tenant Principal.

Required readiness checks are server-derived from authoritative persistence:

- active internal Entra Tenant binding;
- connected Microsoft 365 integration;
- required Places and calendar permission status;
- at least one active imported room mapping;
- successful Free/Busy capability health;
- enabled directory and calendar entitlements.

Calendar Write is reported separately and is not required for baseline activation.

### 6.9 Mark ready and activate

After the technical and operational review, use the authenticated Platform lifecycle operation to transition the Tenant to `ready`. Verify the directory-selected Tenant, current lifecycle status/revision, fresh readiness snapshot, non-secret reason, and exact Tenant/action confirmation before execution.

Activate only after the same release/change record approves productive Pilot use. Obtain another fresh readiness snapshot, then execute the authenticated Platform transition to `active` using the current lifecycle revision, fresh step-up, CSRF, idempotency key, and exact confirmation.

Both transitions are readiness-gated and audit-atomic. A stale status, failed readiness check, missing entitlement, missing binding, missing room, missing capability health, or persistence/audit failure blocks the transition.

The lifecycle state machine permits only the canonical transitions implemented by the Platform service. `pending` remains owned by the claiming flow and `archived` is terminal. Unsupported or concurrently stale transitions fail without a success receipt or partial lifecycle/audit mutation.

## 7. Optional Calendar Write and Exchange Application RBAC

Calendar Write is not required for the baseline Pilot. It may remain disabled while sign-in, room discovery, mapping, and Free/Busy are enabled.

When Calendar Write remains disabled:

- do not grant `microsoft.calendar.write`;
- mark real calendar-write acceptance and Exchange Application RBAC evidence as `not_applicable` in the release evidence document;
- state explicitly that no create/update/delete calendar operation is enabled.

This disabled state preserves the optional capability model required by SaaS 2 issue `#87`. It does not satisfy issue `#73`'s enabled-calendar-write acceptance criterion. The readiness summary therefore reports `enabledCalendarWriteEvidenceVerified: false`, and #73 must remain open.

When Calendar Write is enabled, all of the following become mandatory release gates:

1. keep `microsoft.calendar.write` disabled while the scope is prepared;
2. implement `docs/EXCHANGE-APPLICATION-RBAC.md`, including removal of the central app registration's static `Calendars.ReadWrite` request and every unscoped customer-Tenant grant;
3. build the protected non-sensitive evidence input from the complete enabled room-mapping inventory and run `npm run pilot:exchange-rbac -- /protected/path/exchange-rbac-evidence.json` from the release commit;
4. verify the exact in-scope inventory and prove that out-of-scope mailboxes are denied through both `Test-ServicePrincipalAuthorization` and a live Graph negative control;
5. only after steps 1–4 pass, enable `microsoft.calendar.write` through the authenticated Platform entitlement preview/apply workflow for the controlled acceptance window;
6. complete the real create/update/delete calendar-write acceptance test in each representative Pilot organization;
7. on any failure, immediately disable the entitlement through the same authenticated Platform workflow, execute the documented rollback, and reconcile every persisted provider reference before retrying;
8. retain rollback and audit evidence;
9. mark both conditional evidence items `verified`.

Exchange Application RBAC guidance is defined in `docs/EXCHANGE-APPLICATION-RBAC.md` and tracked in issue `#69`. Repository documentation and a passing input validator alone are not execution evidence. The operator check must cover the exact complete set of enabled internal room IDs; both `Test-ServicePrincipalAuthorization` and live in-scope/out-of-scope Graph behavior must be recorded before Calendar Write activation. Recheck the central app registration and customer service-principal grant inventory after every consent or reconnect so `/.default` cannot restore unscoped Calendar Write.

## 8. Suspension and reactivation

Suspend a Tenant when access must stop without deleting evidence. Use the authenticated Platform lifecycle operation after selecting the Tenant from the directory, verifying its current revision and impact, obtaining fresh step-up, and confirming the exact `suspended` transition.

Suspension is server-authoritative. Existing sessions and protected business operations must fail closed according to the lifecycle/session contract.

Before reactivation:

1. resolve the incident or commercial reason;
2. verify binding, connection, permissions, mappings, capability health, and entitlements again;
3. obtain a new read-only Platform readiness snapshot;
4. use a new idempotency UUID and retain the new server request/correlation UUID;
5. transition to `active` only when readiness is true and change approval exists.

Do not reactivate by editing the Tenant row directly.

## 9. Microsoft 365 reconnect and reconsent

Reconnect is customer-led through the Tenant Admin integration UI.

Use reconnect when consent was revoked, permissions changed, credentials rotated, the connection became degraded, or Graph authorization fails persistently.

Procedure:

1. suspend the Tenant if the condition affects safe business operation;
2. capture bounded connection/capability status and correlation identifiers;
3. have a Tenant Admin disconnect or restart consent through the application UI;
4. complete real Microsoft administrator consent;
5. rediscover/synchronize rooms where required;
6. verify Free/Busy again;
7. confirm readiness;
8. reactivate through the authenticated Platform lifecycle operation.

Never copy a callback URL, state, authorization code, access token, refresh token, or client secret into a ticket or command.

## 10. Role recovery

The normal recovery path is another active Tenant Admin. The application prevents removal of the last viable Tenant Admin.

If no viable Tenant Admin remains because all administrators are disabled or an older binding lacks trustworthy claimant linkage, recovery is an exceptional controlled Platform operation. There is no Tenant Admin/customer bypass and no client-selected role flag.

Required recovery controls are:

1. verify the customer organization and intended recovery user out of band;
2. identify the internal Tenant and user through trusted backend records;
3. obtain approved change and security authorization;
4. preview and execute the fixed last-Tenant-Admin Platform recovery use case, or use the grant-bound fallback only during an approved Control Plane outage;
5. increment the affected user's `security_version` in the same transaction;
6. append `tenant.user_permissions.changed` audit evidence atomically with a non-secret recovery classification;
7. require fresh authentication;
8. confirm that cross-Tenant user identifiers remain unavailable and the last-admin invariant still holds.

Direct ad-hoc SQL is not a recovery mechanism. The released recovery service must preserve target scope, one-use context, security-version/session effects, idempotency, and dual audit, and it must be exercised in a non-production recovery drill before Pilot acceptance.

## 11. Identity unbinding before activation

Identity unbinding is an exceptional pre-activation recovery operation. It must not be used to transfer an active productive Tenant casually. Use the fixed authenticated Platform identity-unbind preview/execution route with a fresh step-up session, exact Tenant confirmation, one-use recovery context, bounded non-secret reason, correlation ID, and idempotency key. During an approved Control Plane outage, the same canonical recovery may be reached only through the dual-control, grant-bound fallback.

The existing onboarding service restricts unbinding by lifecycle state and appends security audit evidence atomically. Create a new single-use invitation only after the unbind result and change approval are confirmed.

Do not place personal data, provider references, tokens, secrets, or incident narrative in the bounded recovery reason.

## 12. Audit and correlation procedure

For each mutation, retain:

- repository and deployed release commit;
- Platform operation type, not a raw request containing customer names, internal identifiers, or credentials;
- server correlation UUID;
- change/incident record reference in the controlled operational system;
- bounded success or failure code;
- expected audit action;
- verification that the Tenant audit chain remains valid.

Expected actions include:

- `tenant.onboarding.invited`;
- `tenant.identity.claimed`;
- `tenant.entitlement.changed`;
- `tenant.lifecycle.changed`;
- `tenant.identity.unbound`;
- Microsoft integration and calendar actions defined in `docs/AUDIT.md`.

Do not store invitation tokens, claim tokens, session IDs, cookies, CSRF values, client secrets, provider tokens, raw claims, provider Tenant references, room addresses, or unnecessary personal data in audit metadata or readiness evidence.

## 13. Troubleshooting matrix

| Symptom | Required checks | Safe action | Prohibited shortcut |
| --- | --- | --- | --- |
| Invitation rejected | Expiry, replay, exact intended recipient, correlation evidence | Create a new approved invitation when policy allows | Reuse or expose the old token |
| Claim callback rejected | HTTPS origin, fixed redirect URI, state/nonce/PKCE, clock, Entra configuration | Restart the browser flow | Replay callback URL or authorization code |
| No first Tenant Admin | Claimant linkage, JIT audit, binding age/migration state | Follow Role recovery | Infer admin from email/domain or first login |
| Consent blocked | Real customer admin rights, configured redirect, requested permissions | Restart consent with authorized customer admin | Paste app ID, Tenant ID, secret, or token |
| No rooms discovered | Places permission, connection state, Graph response class, capability health | Reconnect/reconsent and retry bounded discovery | Supply arbitrary Graph URL or mailbox |
| Room import rejected | Server discovery set, local site, capacity, duplicate mapping | Correct bounded local mapping input | Insert mapping rows manually |
| Free/Busy fails | Active mapping, calendar permission, throttling/auth status, health timestamp | Reconsent, synchronize, and retry after bounded delay | Treat repository unit tests as live proof |
| Readiness false | Every returned boolean check and entitlement | Resolve the authoritative missing prerequisite | Force lifecycle row to active |
| Tenant access must stop | Incident/change authorization and current lifecycle | Suspend through authenticated Platform lifecycle operation | Delete Tenant data or revoke audit rows |
| Cross-Tenant object appears accessible | Stop testing, preserve correlation and evidence | Escalate as a security incident | Continue with real customer data |

Public errors remain bounded. Investigate internal details only in approved protected diagnostics that preserve redaction and Tenant boundaries.

## 14. Backup, restore, rollback, and escalation

### Backup and restore

Before Pilot acceptance, execute the provider-specific procedure required by issue `#113`:

1. create an encrypted backup or point-in-time recovery point;
2. restore into an isolated approved EU recovery environment;
3. apply the exact release configuration and schema checks;
4. verify Tenant isolation, audit-chain integrity, sessions, entitlements, mappings, and booking references;
5. measure and record RPO and RTO;
6. destroy temporary recovery material according to policy.

A provider statement that backups exist is not restore evidence. Any recovery point predating migration 034 is non-traffic-ready. Keep Customer traffic blocked, apply through schema 34, verify the one-way Customer-session revocation, deploy a single current-epoch fleet and prove a captured legacy cookie is rejected before accepting recovery. Evidence references the result only and never retains the cookie.

### Application and migration rollback

Before deployment:

1. review every migration's down or forward-recovery semantics;
2. confirm whether rollback is fail-closed because real audit/security data exists;
3. capture the pre-deployment backup/restore point;
4. deploy migrations explicitly before application traffic;
5. verify `/health/ready` and the exact schema version;
6. roll back application code only when it remains compatible with the authoritative schema;
7. prefer reviewed forward recovery when a migration correctly prohibits destructive rollback.

Never delete audit, role, binding, entitlement, lifecycle, session, or integration evidence merely to make a down migration pass.

Migration 034 down is bookkeeping-only and must never clear `sessions.revoked_at`. A backend rollback across that boundary requires blocked Customer traffic, complete fleet drain, migration-runner rollback to schema 33, a compatible old fleet and fresh authentication. Re-forwarding must block traffic and reapply migration 034 before the current fleet serves requests, revoking every rollback-window session. Prefer a forward fix whenever the former authorization semantics are unacceptable.

### Escalation

Escalate immediately when:

- Tenant isolation or authorization is uncertain;
- audit append or integrity verification fails;
- provider tokens, secrets, cookies, personal data, or Tenant identifiers appear in logs/evidence;
- state/callback replay succeeds;
- the deployed origin is not HTTPS/same-origin;
- database TLS or schema readiness fails;
- backup restoration or rollback cannot meet the accepted objective;
- a high/critical dependency or penetration-test finding lacks disposition;
- real Microsoft acceptance differs from repository contract tests.

Suspend affected Tenants where required, preserve non-secret correlation evidence, and do not declare readiness while the condition is unresolved.

## 15. Microsoft Entra and Graph acceptance

Repository adapters and contract tests are necessary but insufficient. Real acceptance must be executed against two independent customer organizations.

For each organization, record protected evidence for:

1. invitation and explicit Tenant claiming;
2. validated `tid` and `oid` behavior without storing raw claims in the evidence document;
3. state, nonce, PKCE, callback replay, claim replay, session rotation, CSRF, logout, expiry, migration-034 epoch cutover/rollback, and pre-034 PITR rejection;
4. Tenant Admin bootstrap and Employee default authorization;
5. customer administrator consent;
6. Places discovery and mapped-room isolation;
7. Free/Busy success plus authorization/throttling/failure behavior;
8. Calendar Write only when enabled;
9. cross-Tenant BOLA/IDOR denial across sessions, objects, mappings, provider identities, and audit;
10. log, trace, metric, and audit redaction.

Evidence references must identify the protected test artifact without embedding Microsoft Tenant IDs, user identifiers, room addresses, tokens, cookies, secrets, or raw provider payloads.

## 16. Readiness evidence contract

`docs/pilot-readiness-evidence.example.json` is a template, not evidence. Its pending entries intentionally prove that repository completion is not equivalent to Pilot readiness.

Create the actual evidence document in an approved protected location. Do not commit environment-sensitive evidence automatically.

Validate structure without claiming readiness:

```bash
node scripts/pilot-readiness.mjs /secure/path/pilot-readiness.json
```

Require the final release decision:

```bash
npm run pilot:readiness -- /secure/path/pilot-readiness.json
```

The ready gate requires:

- final frontend and backend commit SHAs;
- final repository and multi-Tenant gate evidence;
- accepted provider and EU region;
- deployed EU runtime, HTTPS, and PostgreSQL 18 evidence;
- backup/restore and rollback evidence;
- two independent Entra organizations;
- real OIDC/session, Places, Free/Busy, and browser E2E evidence;
- deployed DAST, penetration testing, redaction, and observability evidence;
- Calendar Write and Exchange Application RBAC evidence when Calendar Write is enabled.

The validator rejects duplicate or unknown evidence IDs, unverified references, required evidence marked not applicable, partial release commits, unexpected fields, credential-like material, session material, naked UUID/identity material, raw token-shaped values, and invalid timestamps.

The summary field `enabledCalendarWriteEvidenceVerified` is true only when Calendar Write is enabled and both the real Graph write and Exchange Application RBAC evidence entries are verified. `summary.ready` validates the capability scope declared by the evidence document; it must not be used to claim #73 completion while this explicit field is false.

The validator prints only counts and stable pending evidence IDs. It does not print evidence references or sensitive source material.

## 17. Reproducible release decision

A Pilot release decision is reproducible only when a reviewer can:

1. check out the exact frontend and backend commits;
2. reproduce the repository validation gates;
3. inspect zero unresolved security-relevant review threads;
4. map each required live control to one protected evidence reference;
5. run the readiness validator with `--require-ready` successfully;
6. verify the accepted provider/region and restore/rollback evidence;
7. confirm that optional Calendar Write status matches the actual entitlement and Exchange scope;
8. keep issue `#73` open unless `enabledCalendarWriteEvidenceVerified` is true or its acceptance criterion was explicitly changed;
9. confirm that no open material finding or missing acceptance condition is hidden as repository evidence.

Until all steps succeed, the correct decision is `pending`, not `ready`.

## 18. Standard onboarding acceptance statement

The implementation supports onboarding another Pilot customer without a source-code change once the accepted Pilot runtime and central Entra application exist.

The standard customer flow requires only:

- the single-use Conference Manager invitation token;
- normal browser interaction;
- Microsoft sign-in;
- customer administrator consent;
- selection and mapping of discovered rooms.

The customer does not need an internal Tenant ID, Microsoft application ID, Microsoft Tenant ID, client secret, source-code change, database access, API token, or PowerShell command.

The Platform operator uses authenticated Platform HTTP for pending Tenant creation, commercial entitlement changes, lifecycle transitions, and approved recovery. Readiness remains read-only. The retired Tenant-operator CLI is absent; only the separately governed, grant-bound Platform recovery fallback may mutate during an approved Control Plane outage. Every mutation remains explicit, target-scoped, bounded, auditable, and server-authoritative.
