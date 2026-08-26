# Microsoft Enterprise Pilot Readiness and Operations Runbook

## 1. Authority, scope, and evidence status

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` remain authoritative. This runbook defines the controlled operator procedure for the Conference Manager SaaS 1 Microsoft Enterprise Pilot and the evidence required before a Pilot release decision.

No live Pilot evidence is claimed by this document. Repository tests and CI prove only the code and controls they execute. They do not prove a deployed EU runtime, an accepted cloud provider or region, real Microsoft Entra authentication, Microsoft Graph behavior, HTTPS/browser behavior, backup restoration, deployed DAST, penetration testing, or operational monitoring.

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

The production HTTP composition deliberately keeps Platform/operator mutations default-deny. The operator CLI is a separate, local control-plane adapter. It is not imported by `src/index.js`, is not exposed through `/api/*`, and does not create a `platform_admin` Tenant role.

Operator authorization is represented by a process-local object identity that is injected into the existing application services. The object cannot be supplied through a command argument, environment value, browser request, session, Tenant role, Entra claim, or provider response.

Every mutating command requires:

- a Pilot or Production environment that exactly matches `NODE_ENV`;
- the complete secure runtime configuration;
- a ready PostgreSQL connection and current schema;
- a server correlation UUID;
- an explicit `--apply` gate;
- an exact target-bound `--confirm` value;
- successful authorization through the process-local operator context;
- the existing transactional repository and audit path.

The CLI accepts no provider Tenant ID, Microsoft application ID, client secret, role, permission, user identity, access token, refresh token, or arbitrary outbound URL.

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

Run the operator CLI only from an approved administrative execution environment with:

- controlled human access and change authorization;
- no shared shell history or terminal recording that captures sensitive output files;
- the deployed release checkout at the exact backend commit under review;
- Node.js 22 and the locked repository dependencies installed with `npm ci`;
- protected environment variables defined by `docs/PRODUCTION-SECURE-CONFIGURATION.md`;
- network access to the authoritative PostgreSQL service;
- filesystem access to a protected directory for one-time invitation artifacts;
- an incident/change record that stores the server correlation UUID and command outcome.

Do not place invitation artifacts in the repository, source checkout, shared temporary directories, chat, email, issue descriptions, CI logs, or normal application logs.

Before any command, verify:

```bash
npm run check
npm run audit
npm run test:db
```

These commands validate the repository checkout. They do not replace deployed evidence.

## 5. Command safety contract

The command entry point is:

```bash
npm run operator:tenant -- <command> <arguments>
```

Supported commands are:

- `invite`;
- `readiness`;
- `entitlement`;
- `lifecycle`;
- `unbind-identity`.

Unknown commands, duplicate flags, unsupported fields, malformed UUIDs, unsafe text, relative invitation paths, unknown capabilities, unknown lifecycle targets, confirmation mismatches, and missing apply gates fail before mutation.

The CLI emits bounded JSON only. Invitation tokens and internal Tenant IDs are never written to standard output or standard error. The invitation command writes its sensitive result to the explicitly selected protected artifact file.

## 6. Standard Pilot onboarding procedure

### 6.1 Create the change and correlation context

Create or select the approved operational change record. Generate one UUID for each independently auditable mutation. Store the mapping between the change record and correlation UUID in the controlled operational system, not in application logs.

Do not reuse a correlation UUID as an authentication credential or invitation token.

### 6.2 Create the pending Tenant and invitation

Select a new absolute path in a protected directory. The target file must not exist.

```bash
npm run operator:tenant -- invite \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --display-name "<customer-organization-name>" \
  --output /secure/path/customer-invitation.json \
  --confirm invite \
  --apply
```

The command:

1. verifies secure Pilot configuration and database/schema readiness;
2. creates the output file exclusively with mode `0600` and refuses an existing file or symlink;
3. generates the single-use invitation token without printing it;
4. uses the existing `TenantOnboardingService` to create the internal Tenant and invitation atomically with audit evidence;
5. replaces the prepared token artifact atomically with the final artifact containing the internal Tenant ID, token, expiry, and correlation UUID;
6. prints only a non-sensitive completion status and correlation UUID.

If persistence fails, the prepared token file is removed. If final artifact replacement fails after persistence, the original token-only artifact is preserved so the credential is not silently lost. Treat that condition as an operational exception and investigate using the correlation UUID; do not create repeated invitations blindly.

The artifact is an operator credential container. Store it in the approved protected location, transfer only the invitation token to the intended customer administrator through an approved secret-delivery channel, and delete the local artifact after successful claim and evidence capture according to the retention policy.

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

Enable directory discovery:

```bash
npm run operator:tenant -- entitlement \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --tenant-id <internal-tenant-uuid> \
  --capability microsoft.directory \
  --enabled true \
  --confirm "entitlement:<internal-tenant-uuid>:microsoft.directory:true" \
  --apply
```

Enable calendar read/Free-Busy:

```bash
npm run operator:tenant -- entitlement \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --tenant-id <internal-tenant-uuid> \
  --capability microsoft.calendar \
  --enabled true \
  --confirm "entitlement:<internal-tenant-uuid>:microsoft.calendar:true" \
  --apply
```

The service validates the capability, scopes the mutation to the supplied internal Tenant in the trusted operator domain, and commits the entitlement and `tenant.entitlement.changed` audit evidence atomically.

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

Use the internal Tenant UUID from the protected invitation artifact or trusted operational record:

```bash
npm run operator:tenant -- readiness \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --tenant-id <internal-tenant-uuid>
```

The output contains only:

- the Tenant lifecycle status;
- the aggregate ready decision;
- boolean readiness checks;
- boolean entitlement states;
- the supplied correlation UUID.

It does not print the Tenant ID, provider Tenant reference, room address, user identity, invitation token, session, CSRF value, provider token, secret, or raw provider response.

Required readiness checks are server-derived from authoritative persistence:

- active internal Entra Tenant binding;
- connected Microsoft 365 integration;
- required Places and calendar permission status;
- at least one active imported room mapping;
- successful Free/Busy capability health;
- enabled directory and calendar entitlements.

Calendar Write is reported separately and is not required for baseline activation.

### 6.9 Mark ready and activate

After the technical and operational review, mark the Tenant `ready`:

```bash
npm run operator:tenant -- lifecycle \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --tenant-id <internal-tenant-uuid> \
  --target ready \
  --confirm "lifecycle:<internal-tenant-uuid>:ready" \
  --apply
```

Activate only after the same release/change record approves productive Pilot use:

```bash
npm run operator:tenant -- lifecycle \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --tenant-id <internal-tenant-uuid> \
  --target active \
  --confirm "lifecycle:<internal-tenant-uuid>:active" \
  --apply
```

Both transitions are readiness-gated and audit-atomic. A stale status, failed readiness check, missing entitlement, missing binding, missing room, missing capability health, or persistence/audit failure blocks the transition.

## 7. Optional Calendar Write and Exchange Application RBAC

Calendar Write is not required for the baseline Pilot. It may remain disabled while sign-in, room discovery, mapping, and Free/Busy are enabled.

When Calendar Write remains disabled:

- do not grant `microsoft.calendar.write`;
- mark real calendar-write acceptance and Exchange Application RBAC evidence as `not_applicable` in the release evidence document;
- state explicitly that no create/update/delete calendar operation is enabled.

When Calendar Write is enabled, all of the following become mandatory release gates:

1. enable `microsoft.calendar.write` through the operator entitlement command;
2. complete the real calendar-write acceptance test in each representative Pilot organization;
3. implement and verify the approved Exchange Application RBAC scope for the central application;
4. prove that out-of-scope mailboxes are denied;
5. retain rollback and audit evidence;
6. mark both conditional evidence items `verified`.

Exchange Application RBAC guidance and live verification are tracked separately in issue `#69`. Repository documentation alone is not execution evidence.

## 8. Suspension and reactivation

Suspend a Tenant when access must stop without deleting evidence:

```bash
npm run operator:tenant -- lifecycle \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --tenant-id <internal-tenant-uuid> \
  --target suspended \
  --confirm "lifecycle:<internal-tenant-uuid>:suspended" \
  --apply
```

Suspension is server-authoritative. Existing sessions and protected business operations must fail closed according to the lifecycle/session contract.

Before reactivation:

1. resolve the incident or commercial reason;
2. verify binding, connection, permissions, mappings, capability health, and entitlements again;
3. run the readiness command;
4. use a new correlation UUID;
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
8. reactivate through the operator lifecycle command.

Never copy a callback URL, state, authorization code, access token, refresh token, or client secret into a ticket or command.

## 10. Role recovery

The normal recovery path is another active Tenant Admin. The application prevents removal of the last viable Tenant Admin.

If no viable Tenant Admin remains because all administrators are disabled or an older binding lacks trustworthy claimant linkage, recovery is an exceptional controlled maintenance activity. There is intentionally no browser bypass and no role flag in the operator CLI.

Required recovery controls are:

1. verify the customer organization and intended recovery user out of band;
2. identify the internal Tenant and user through trusted backend records;
3. obtain approved change and security authorization;
4. restore exactly one `tenant_admin` assignment through an approved privileged maintenance path that preserves repository invariants;
5. increment the affected user's `security_version` in the same transaction;
6. append `tenant.user_permissions.changed` audit evidence atomically with a non-secret recovery classification;
7. require fresh authentication;
8. confirm that cross-Tenant user identifiers remain unavailable and the last-admin invariant still holds.

Direct ad-hoc SQL is not the normal recovery mechanism. Until a separately reviewed operator recovery service exists, this remains a manual prerequisite under change control and must be exercised in a non-production recovery drill before Pilot acceptance.

## 11. Identity unbinding before activation

Identity unbinding is an exceptional pre-activation recovery operation. It must not be used to transfer an active productive Tenant casually.

```bash
npm run operator:tenant -- unbind-identity \
  --environment pilot \
  --correlation-id <correlation-uuid> \
  --tenant-id <internal-tenant-uuid> \
  --reason "<approved non-secret recovery reason>" \
  --confirm "unbind-identity:<internal-tenant-uuid>" \
  --apply
```

The existing onboarding service restricts unbinding by lifecycle state and appends security audit evidence atomically. Create a new single-use invitation only after the unbind result and change approval are confirmed.

Do not place personal data, provider references, tokens, secrets, or incident narrative in `--reason`.

## 12. Audit and correlation procedure

For each mutation, retain:

- repository and deployed release commit;
- command type, not the raw command line where it contains customer names or internal identifiers;
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
| Tenant access must stop | Incident/change authorization and current lifecycle | Suspend through the operator command | Delete Tenant data or revoke audit rows |
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

A provider statement that backups exist is not restore evidence.

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
3. state, nonce, PKCE, callback replay, claim replay, session rotation, CSRF, logout, and expiry;
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

The validator rejects duplicate or unknown evidence IDs, unverified references, required evidence marked not applicable, partial release commits, unexpected fields, credential-like material, session material, raw token-shaped values, and invalid timestamps.

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
8. confirm that no open material finding or missing acceptance condition is hidden as repository evidence.

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

The Platform operator uses the trusted CLI only for pending Tenant creation, per-Tenant commercial entitlements, readiness review, lifecycle activation/suspension, and exceptional pre-activation identity unbinding. Every mutation remains explicit, bounded, auditable, and server-authoritative.
