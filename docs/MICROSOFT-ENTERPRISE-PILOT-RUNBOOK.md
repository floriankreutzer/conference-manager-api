# Microsoft Enterprise Pilot Operations Runbook

This runbook is the operational source for the Microsoft Enterprise Pilot. It does not replace external Microsoft, hosting, restore, penetration-test, or production-HTTPS evidence. A repository test or Demo flow must never be recorded as real Microsoft acceptance evidence.

## Trust boundaries

- The normal customer path never asks for a client secret, application ID, Entra Tenant ID, Graph token, or PowerShell command.
- Tenant and User authority comes from validated server sessions and the claimed Entra binding.
- The Demo onboarding wizard is an in-memory simulation and is presentation evidence only.
- The production HTTP server keeps platform-operator mutation default-deny.
- Pilot operator commands run only inside the trusted backend operations environment with production configuration and database connectivity. Do not expose the operator CLI through a web endpoint or customer shell.
- Invitation tokens are short-lived bearer credentials. Transfer them only through the approved customer onboarding channel and never log them in tickets, chat, analytics, or screenshots.

## Pre-onboarding release gate

Before inviting any external customer, record a non-secret evidence package and confirm:

1. Current frontend and backend `main` CI/security workflows are green.
2. The target environment is HTTPS and uses the approved same-origin `/api/*` topology.
3. The central Microsoft Entra application is multi-tenant and redirect URIs exactly match the environment.
4. Runtime secrets are stored in the approved secret boundary and are absent from source/browser configuration.
5. PostgreSQL schema/readiness checks are green.
6. `npm run check:multi-tenant` passes.
7. Hosting, backup/restore, deployment rollback, and penetration-test acceptance are either evidenced or explicitly recorded as release blockers.

## Create and invite a Tenant

Run only from the trusted backend operations environment:

```text
npm run pilot:operator -- invite --display-name "Customer organization"
```

The canonical onboarding service creates the pending Tenant and single-use invitation atomically and records audit evidence. The returned invitation token is sensitive. Deliver it only through the approved onboarding channel and do not retain it in long-lived support records.

The customer then uses the existing invitation/authentication flow. The server validates invitation state, Entra identity, browser binding, claim context, and CSRF before binding the organization. Browser-supplied Tenant IDs are never authoritative.

## Customer Tenant Admin onboarding

The Tenant Admin uses the seven-step wizard:

1. Organization confirmed.
2. Microsoft 365 connection and admin consent.
3. Connection and required permission verification.
4. Discover Microsoft 365 rooms.
5. Select and import rooms into a server-returned site.
6. Verify Free/Busy against an imported room.
7. Review server-derived pilot readiness.

Production progress is reconstructed from server state. Closing the browser or signing out does not create trusted client-side progress. The same flow is available in Demo, but Demo is visibly simulated and must never be used as Microsoft acceptance evidence.

## Configure capabilities

Required pilot entitlements are controlled only through the trusted operator path:

```text
npm run pilot:operator -- entitlement --tenant-id <uuid> --capability microsoft.directory --enabled true
npm run pilot:operator -- entitlement --tenant-id <uuid> --capability microsoft.calendar --enabled true
```

Enable productive calendar writes only when explicitly approved for that Tenant:

```text
npm run pilot:operator -- entitlement --tenant-id <uuid> --capability microsoft.calendar.write --enabled true
```

Supported capability IDs are `microsoft.directory`, `microsoft.calendar`, and `microsoft.calendar.write`. Entitlement mutations are audit-atomic. Tenant Admins cannot execute them through the browser/API.

## Readiness, activation, suspension

Read server-derived readiness:

```text
npm run pilot:operator -- readiness --tenant-id <uuid>
```

Required readiness includes claimed Entra identity, connected Microsoft 365 integration, required Places/Calendar permissions, at least one active imported room, successful Free/Busy verification, and the required directory/calendar entitlements. Calendar write is intentionally optional.

When all required checks are true:

```text
npm run pilot:operator -- lifecycle --tenant-id <uuid> --status ready
npm run pilot:operator -- lifecycle --tenant-id <uuid> --status active
```

Suspend immediately when customer access must stop:

```text
npm run pilot:operator -- lifecycle --tenant-id <uuid> --status suspended
```

A suspended Tenant fails protected business capability checks even if a cryptographically valid Entra login still exists. Before reactivation, resolve the reason, verify integration/readiness again, and use the `active` lifecycle command. Never modify Tenant status directly in SQL.

## Last Tenant Admin recovery

Normal Tenant role administration prevents removing the last viable Tenant Admin. If a Tenant nevertheless has no active viable Tenant Admin, recovery is restricted to the trusted operator environment and an already active JIT-provisioned user:

```text
npm run pilot:operator -- recover-tenant-admin --tenant-id <uuid> --user-id <uuid>
```

The recovery service refuses the operation if any active viable Tenant Admin still exists, if the target user is missing/inactive, if the target belongs to another Tenant, or if operator authorization is absent. It preserves existing elevated roles, adds only `tenant_admin`, increments the target user's security version through the canonical repository, and records `tenant.user_permissions.changed` as security-retained audit evidence. Do not recover access by editing LocalStorage, Entra group claims, role payloads, or database rows directly.

## Consent and permission troubleshooting

Use the Tenant Admin Microsoft 365 status and reconnect flow first:

- `pending`: admin consent has not completed; repeat guided consent.
- `degraded`: required capability/verification is missing; inspect sanitized capability status and re-consent if required.
- `revoked`: consent/token acquisition is invalid; reconnect through Tenant Admin UI.
- `disconnected`: Graph operations remain blocked until a new connection is established.

Never request customer secrets or raw tokens and never paste Graph response bodies into support records. Use request/correlation IDs and sanitized application status.

## Room discovery, mapping, and Free/Busy troubleshooting

1. Verify Microsoft 365 connection and `Place.Read.All` status.
2. Run discovery again; discovery never imports automatically.
3. Confirm the target Conference Manager site came from server-returned Tenant catalog data.
4. Import only intended rooms.
5. Synchronize mappings when provider rooms are renamed/removed; local Conference Manager attributes remain locally owned.
6. Never use another Tenant's provider room ID to repair a mapping.

The onboarding Free/Busy action performs a server-selected, read-only check against an active imported room. It accepts no Tenant ID, room ID, mailbox, provider ID, URL, or time range from the browser. Bounded retries apply only to safe reads; authorization failures are not blindly retried. Failed provider checks must never be reported as successful readiness.

## Calendar write troubleshooting

Calendar write requires independent `microsoft.calendar.write` entitlement and provider permission. Confirmation uses idempotency and a persisted provider reference so retries do not create duplicate bookings. Cancellation and approved changes use the existing mapping.

Never manually edit provider references in PostgreSQL. A provider failure must not be represented as successful synchronization; preserve reconciliation and audit evidence until Microsoft confirms the write.

## Audit and incident evidence

Record only the minimum non-secret evidence:

- environment and UTC time window;
- approved internal Tenant ID where permitted;
- request/correlation IDs;
- affected capability and sanitized state;
- actions taken (reconnect, suspend, entitlement change, recovery, rollback);
- linked audit events;
- whether external Microsoft/hosting evidence was actually captured.

Do not add tokens, invitation credentials, raw provider bodies, cookies, CSRF values, or unnecessary PII to incident evidence.

## Deployment rollback and database recovery

Application rollback must preserve the current database contract. Database down migrations include fail-closed evidence guards where rollback could invalidate security/audit evidence; never force through those guards.

Production hosting, PITR/restore, executed restore evidence, edge controls, and deployment rollback are tracked by conference-manager issue #113. Until they are executed in the selected cloud environment, pilot release remains blocked.

## Evidence matrix

| Gate | Repository evidence | External evidence required before pilot release |
| --- | --- | --- |
| Entra multi-tenant OIDC | OIDC/state/nonce/browser-binding/session tests | Real central multi-tenant app login from at least two independent Entra tenants |
| Tenant claim/JIT/RBAC | PostgreSQL, concurrency, role, recovery and session tests | Real customer-admin claim/sign-in sequence |
| Microsoft admin consent | Connection lifecycle, CSRF, replay and permission tests | Real admin consent in target Entra tenant |
| Places / room mapping | Provider validation, pagination, mapping/idempotency tests | Real Graph discovery/import for target Tenant |
| Free/Busy | Provider and onboarding verification tests | Real Graph Free/Busy result for an imported room |
| Calendar write | Idempotency/create/update/cancel/reconciliation tests | Real Microsoft calendar create/update/cancel evidence when enabled |
| Tenant isolation | Mandatory `check:multi-tenant`, adversarial API tests, Chromium/WebKit coverage | Real two-Tenant Microsoft pilot validation remains required for overall release |
| Production session | Server/session/browser regression tests | Real HTTPS production-like browser sign-in/logout evidence (#115) |
| Hosting/restore | Repository topology and PostgreSQL 18 baseline | Selected EU provider, IaC deployment, restore/rollback evidence (#113) |
| Security assessment | Static/SAST-style, dependency, secret, DAST and DB gates | Defined penetration-test scope/results and no unresolved release-blocking findings |
| Optional Exchange Application RBAC | Documentation/configuration checks | Representative Exchange Online in-scope/out-of-scope validation (#69) |

## Pilot release decision

The pilot is **not ready** while any mandatory external evidence row above is missing. Repository CI success, Demo behavior, mocked Microsoft responses, or screenshots without traceable environment/time evidence do not satisfy external acceptance.

When all mandatory evidence exists, record exact frontend/backend commit SHAs, workflow run IDs, environment, UTC evidence timestamps, external Tenant count, restore result, penetration-test disposition, and operator approval. Do not claim broader compliance or production readiness than the evidence supports.
