# Microsoft Enterprise Pilot Operations Runbook

This runbook is the operational source for the Microsoft Enterprise Pilot. It does not replace external Microsoft, hosting, restore, penetration-test, or production-HTTPS evidence. A repository test or Demo flow must never be recorded as real Microsoft acceptance evidence.

## Trust boundaries

- The normal customer path never asks for a client secret, application ID, Entra Tenant ID, Graph token, or PowerShell command.
- Tenant and User authority comes from validated server sessions and the claimed Entra binding.
- The Demo onboarding wizard is an in-memory simulation and is presentation evidence only.
- The production HTTP server keeps platform-operator mutation default-deny.
- Pilot operator commands run only inside the trusted backend operations environment with production configuration and database connectivity. Do not expose the operator CLI through a web endpoint or customer shell.
- Invitation tokens are short-lived bearer credentials. Transfer them only through the approved customer onboarding channel and never log them in tickets, chat, analytics, or screenshots.

## Before onboarding a customer

Record a pilot evidence package containing only non-secret identifiers and timestamps. Confirm all of the following before inviting a customer:

1. Current frontend and backend `main` CI/security workflows are green.
2. The target environment is HTTPS and uses the expected same-origin `/api/*` topology.
3. The central Microsoft Entra application is configured as multi-tenant and its redirect URIs exactly match the environment.
4. Production secrets are present in the runtime secret boundary, not source control or browser configuration.
5. PostgreSQL schema readiness is green.
6. Tenant isolation release gate `npm run check:multi-tenant` passes.
7. Hosting, backup/restore, deployment rollback, and penetration-test acceptance items are either evidenced or explicitly recorded as release blockers.

## Create and invite a Tenant

From the trusted backend operations environment:

```text
npm run pilot:operator -- invite --display-name "Customer organization"
```

The command creates the pending Tenant and invitation atomically through the canonical onboarding service and emits a correlation ID. The returned invitation token is sensitive and single-use. Deliver it only through the approved onboarding channel. Do not copy it into long-lived operational records.

The customer starts the existing invitation authentication flow. The server validates the invitation, Entra login, browser binding, claim context, and CSRF before binding the Entra organization. Browser-supplied Tenant IDs are never authoritative.

## Customer Tenant Admin onboarding

After the Entra organization is claimed, the Tenant Admin uses the seven-step onboarding wizard:

1. Organization confirmed.
2. Microsoft 365 connection and admin consent.
3. Connection and required permission verification.
4. Discover Microsoft 365 rooms.
5. Select and import rooms into a server-returned site.
6. Verify Free/Busy against an imported room.
7. Review server-derived pilot readiness.

Production progress is reconstructed from server state. Closing the browser or signing out does not create a trusted client-side progress record. The same seven-step flow is available in Demo, but Demo is visibly simulated and must never be used as provider acceptance evidence.

## Configure pilot capabilities

Use the operator CLI from the trusted operations environment. Required P0 entitlements are independent of the browser role model.

```text
npm run pilot:operator -- entitlement --tenant-id <uuid> --capability microsoft.directory --enabled true
npm run pilot:operator -- entitlement --tenant-id <uuid> --capability microsoft.calendar --enabled true
```

Enable calendar write only when productive external calendar booking is approved for that Tenant:

```text
npm run pilot:operator -- entitlement --tenant-id <uuid> --capability microsoft.calendar.write --enabled true
```

Supported capability IDs are `microsoft.directory`, `microsoft.calendar`, and `microsoft.calendar.write`. Entitlement changes are audit-atomic. Tenant Admins cannot execute this operator path.

## Check readiness and activate

Check server-derived readiness:

```text
npm run pilot:operator -- readiness --tenant-id <uuid>
```

Required readiness includes claimed Entra identity, connected Microsoft 365 integration, required Places/Calendar permissions, at least one active imported room, successful Free/Busy verification, and the required directory/calendar entitlements. Calendar write is intentionally optional for readiness.

When all required checks are true:

```text
npm run pilot:operator -- lifecycle --tenant-id <uuid> --status ready
npm run pilot:operator -- lifecycle --tenant-id <uuid> --status active
```

Lifecycle transitions are audit-atomic and readiness-gated. The normal production server has no Tenant Admin self-activation endpoint.

## Suspend and reactivate a Tenant

Suspend immediately when customer access must stop:

```text
npm run pilot:operator -- lifecycle --tenant-id <uuid> --status suspended
```

A suspended Tenant fails protected business capability checks even if the user still has a cryptographically valid Entra login. Before reactivation, resolve the incident or commercial reason, re-check Microsoft connection/readiness, and then run the `active` lifecycle command. Do not modify Tenant status directly in SQL.

## Consent and permission troubleshooting

Use the Tenant Admin Microsoft 365 status and reconnect flow first.

- `pending`: admin consent has not completed; repeat the guided consent flow.
- `degraded`: one or more required capabilities are missing or verification failed; inspect the non-sensitive capability status and re-consent if required.
- `revoked`: consent/token acquisition is no longer valid; reconnect through the Tenant Admin UI.
- `disconnected`: Graph operations are blocked until a new connection is established.

Do not request customer secrets or raw tokens. Do not paste Graph response bodies into support records. Use request/correlation IDs and sanitized application status.

## Room discovery and mapping troubleshooting

1. Verify Microsoft 365 connection and `Place.Read.All` status.
2. Run room discovery again; discovery does not import automatically.
3. Confirm the selected Conference Manager site came from server-returned Tenant catalog data.
4. Import only the intended rooms.
5. If a provider room was renamed or removed, synchronize mappings; local Conference Manager attributes remain locally owned.
6. Never use a provider room ID from another Tenant to repair a mapping.

Repeated import/synchronization is designed to be idempotent. Cross-Tenant provider references must fail closed.

## Free/Busy troubleshooting

The onboarding verification action performs a server-selected, read-only Free/Busy check against an active imported room. It sends no Tenant ID, room ID, mailbox, provider ID, or time range from the browser.

For throttling or transient Microsoft failures, bounded retry applies only to safe reads. Authorization failures are not blindly retried. A failed provider check must never be presented as `available` or as successful pilot readiness.

## Calendar write troubleshooting

Calendar write requires the independent `microsoft.calendar.write` entitlement and provider permission. Confirmation creates one authoritative external booking using idempotency and a persisted provider reference. Cancellation and approved changes use that mapping rather than creating unrelated events.

Never manually insert or change provider references in PostgreSQL. If local confirmation succeeds but provider synchronization is unresolved, follow the existing booking reconciliation semantics and preserve audit evidence. Do not claim synchronization success until Microsoft confirms the write.

## Last Tenant Admin and role recovery

Tenant role changes are server-authorized and Tenant-scoped. The service prevents unsafe removal of the last viable Tenant Admin. If administrative access is lost, use the documented operator/support recovery process; do not edit browser LocalStorage, Entra group claims, role payloads, or database rows to elevate a user.

## Audit and incident evidence

Use request/correlation IDs to retrieve sanitized audit and operational evidence. Audit records are Tenant-scoped and append-only through the application repository boundary. Do not add tokens, invitation credentials, raw provider bodies, or unnecessary PII to incident evidence.

For an incident, record:

- environment and UTC time window;
- non-secret Tenant internal ID where access policy permits;
- request/correlation IDs;
- affected capability and sanitized state;
- actions taken (reconnect, suspend, entitlement change, rollback);
- linked audit events;
- whether external Microsoft/hosting evidence was actually captured.

## Deployment rollback and database recovery

Application rollback must preserve the current database contract. Database migrations have explicit down migrations and fail-closed evidence guards where rollback could invalidate security/audit state. Do not force a rollback through a guard.

The production hosting baseline, PITR/restore procedure, executed restore evidence, edge controls, and deployment rollback evidence are tracked by conference-manager issue #113. Until those are executed in the selected cloud environment, the production pilot readiness gate remains blocked.

## Evidence matrix

| Gate | Repository evidence | External evidence required before pilot release |
| --- | --- | --- |
| Entra multi-tenant OIDC | Automated OIDC/state/nonce/browser-binding/session tests | Real central multi-tenant app login from at least two independent Entra tenants |
| Tenant claim/JIT/RBAC | PostgreSQL, concurrency, role and session tests | Real customer-admin claim/sign-in sequence |
| Microsoft admin consent | Connection lifecycle, CSRF, replay and permission tests | Real admin consent in target Entra tenant |
| Places / room mapping | Provider contract, validation, pagination, mapping/idempotency tests | Real Graph discovery/import for target tenant |
| Free/Busy | Provider and onboarding verification tests | Real Graph Free/Busy result for imported room |
| Calendar write | Idempotency/create/update/cancel/reconciliation tests | Real Microsoft calendar create/update/cancel evidence when enabled |
| Tenant isolation | Mandatory `check:multi-tenant`, adversarial API tests, Chromium/WebKit browser coverage | Real two-tenant Microsoft pilot validation remains required for overall release |
| Production session | Server/session/browser regression tests | Real HTTPS production-like browser sign-in/logout evidence (#115) |
| Hosting/restore | Repository topology and PostgreSQL 18 baseline | Selected EU provider, IaC deployment, restore/rollback evidence (#113) |
| Security assessment | SAST-style static gate, dependency, secret, DAST and DB tests | Defined penetration-test scope/results and no unresolved release-blocking findings |
| Optional Exchange Application RBAC | Documentation/configuration checks | Representative Exchange Online in-scope/out-of-scope validation (#69) |

## Pilot release decision

The pilot is **not ready** while any mandatory external evidence row above is missing. Repository CI success, Demo behavior, mocked Microsoft responses, or screenshots without traceable environment/time evidence do not satisfy those rows.

When all mandatory evidence exists, record the exact frontend/backend commit SHAs, workflow run IDs, environment, evidence timestamps, external Tenant count, restore result, penetration-test disposition, and operator approval in the pilot release record. Do not claim broader compliance or production readiness than the evidence supports.
