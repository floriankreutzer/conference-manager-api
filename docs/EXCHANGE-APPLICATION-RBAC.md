# Exchange Online Application RBAC for Calendar Write

## Authority and status

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/MICROSOFT365-CALENDAR-WRITE.md`, and `docs/PILOT-READINESS-RUNBOOK.md` remain authoritative.

This document defines the optional Exchange Online Role Based Access Control for Applications hardening path tracked by Conference Manager issue `#69`. It is customer-Tenant configuration guidance and a release-evidence procedure. It does not claim that any real Microsoft Tenant has been configured or verified.

The procedure was checked against the Microsoft Learn sources current on 2026-08-26:

- [Role Based Access Control for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Application Access Policies (legacy)](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies)

Microsoft identifies Application RBAC as the replacement for Application Access Policies. Revalidate the linked Microsoft documentation before every Pilot or Production change because supported roles, commands, caching, and limitations are external platform behavior.

## Conference Manager permission profile

The baseline Pilot keeps Calendar Write disabled. Its central application uses:

- `Place.Read.All` for room discovery;
- `Calendars.ReadBasic.All` for the current Free/Busy verification contract;
- no `microsoft.calendar.write` Tenant entitlement.

When a release explicitly enables Calendar Write, the hardened option is:

- Exchange application role `Application Calendars.ReadWrite`;
- a custom Exchange recipient scope containing only the approved room/resource mailboxes;
- no statically configured Microsoft Graph `Calendars.ReadWrite` entry in the central app registration's `requiredResourceAccess`;
- no unscoped Microsoft Entra `Calendars.ReadWrite` grant in that customer Tenant;
- the server-side `microsoft.calendar.write` entitlement only after live in-scope and out-of-scope evidence passes.

Microsoft Entra grants and Exchange Application RBAC assignments are additive. Leaving the same unscoped `Calendars.ReadWrite` grant on the customer service principal defeats the intended write scope. Keeping that permission in the central app registration's static `requiredResourceAccess` can request the unscoped grant again during a later consent or reconnect. Remove that static request through the central application's approved change process, then remove any existing customer-Tenant grant through the customer's approved Microsoft Entra administration process after the scoped Exchange assignment exists and before Conference Manager Calendar Write is activated.

`Place.Read.All` is not an Exchange mailbox role and is outside this Exchange scope. The current baseline `Calendars.ReadBasic.All` Free/Busy permission also remains a separate, read-only grant. This procedure therefore scopes productive create, update, and delete access; it does not claim that the baseline Free/Busy permission is mailbox-scoped. A customer requiring resource-scoped Free/Busy must use a separately reviewed design and live Microsoft validation rather than treating this Calendar Write procedure as evidence for that control.

## Prerequisites and responsibility

The customer Microsoft administrator must have the Microsoft roles required by the current Microsoft procedure. Microsoft currently documents Exchange Administrator plus Organization Management, or equivalent deliberately delegated Exchange authority, for assignment of application roles.

Before configuration:

1. Keep `microsoft.calendar.write` disabled in Conference Manager.
2. Complete central multi-Tenant Entra application consent so the customer-Tenant service principal exists.
3. Create or select a mail-enabled security group or another supported recipient scope containing only approved room/resource mailboxes.
4. Use direct group membership. Microsoft currently treats nested members as out of scope for this authorization path.
5. Select at least one controlled out-of-scope mailbox/resource for negative verification.
6. Verify that the central app registration's `requiredResourceAccess` does not request Microsoft Graph application permission `Calendars.ReadWrite`.
7. Open an approved customer change record and record only non-secret identifiers and command outcomes.

Do not paste client secrets, access tokens, refresh tokens, certificates, invitation credentials, cookies, or raw provider payloads into PowerShell transcripts, issues, the readiness evidence document, or Conference Manager.

## Configuration procedure

Connect with the supported Exchange Online PowerShell module:

```powershell
Connect-ExchangeOnline
```

Resolve the enterprise application's service principal for the central Conference Manager application. Use the application/client ID as `AppId` and the service principal Object ID from **Enterprise applications** as `ObjectId`. Do not use the application-registration object ID.

Create the Exchange pointer only when it does not already exist:

```powershell
New-ServicePrincipal `
  -AppId <conference-manager-client-id> `
  -ObjectId <customer-service-principal-object-id> `
  -DisplayName "Conference Manager"
```

Resolve the distinguished name of the approved mail-enabled group and create a bounded recipient scope. Keep customer-specific names and identifiers in the controlled change record, not in this repository.

```powershell
$roomGroup = Get-Group -Identity <approved-room-group>

New-ManagementScope `
  -Name "Conference Manager approved rooms" `
  -RecipientRestrictionFilter "MemberOfGroup -eq '$($roomGroup.DistinguishedName)'"
```

Assign only the calendar-write application role required by Conference Manager:

```powershell
New-ManagementRoleAssignment `
  -Name "Conference Manager room calendar write" `
  -App <customer-service-principal-object-id> `
  -Role "Application Calendars.ReadWrite" `
  -CustomResourceScope "Conference Manager approved rooms"
```

After the scoped assignment exists, remove any unscoped Microsoft Entra `Calendars.ReadWrite` application grant for this customer service principal through the approved Entra administration process. Do not remove unrelated permissions mechanically. Confirm the resulting central app-registration request, customer service-principal grant, and Exchange permission inventories in the change record.

Do not create a new Application Access Policy for this setup. Microsoft classifies that mechanism as legacy and directs new configurations to Application RBAC.

## Mandatory authorization verification

Test an approved room and a controlled out-of-scope resource separately:

```powershell
Test-ServicePrincipalAuthorization `
  -Identity <customer-service-principal-object-id> `
  -Resource <approved-room-resource-address> |
  Format-Table RoleName, GrantedPermissions, AllowedResourceScope, ScopeType, InScope

Test-ServicePrincipalAuthorization `
  -Identity <customer-service-principal-object-id> `
  -Resource <out-of-scope-resource-address> |
  Format-Table RoleName, GrantedPermissions, AllowedResourceScope, ScopeType, InScope
```

Required result:

- `Application Calendars.ReadWrite` is present;
- the approved room reports `InScope=True`;
- the negative resource reports `InScope=False`;
- the allowed resource scope is the reviewed Conference Manager scope;
- the central app registration's `requiredResourceAccess` has no Microsoft Graph application permission `Calendars.ReadWrite`;
- the customer service principal has no unscoped Entra `Calendars.ReadWrite` grant.

Microsoft documents that `Test-ServicePrincipalAuthorization` evaluates the Exchange RBAC assignments but excludes permissions granted separately in Microsoft Entra. The Entra grant inventory is therefore a separate mandatory check; a positive `InScope` result alone does not prove that out-of-scope access is denied.

Microsoft documents an authorization cache of approximately 30 minutes to two hours depending on application activity. `Test-ServicePrincipalAuthorization` bypasses that cache, but the real Graph acceptance test might not reflect a new assignment immediately. Do not weaken the scope or add an unscoped grant to work around propagation delay.

## Mandatory live Graph acceptance

PowerShell authorization output is necessary but not sufficient. Before enabling Calendar Write:

1. Keep the Tenant lifecycle non-active or Calendar Write entitlement disabled.
2. Verify the required imported room mappings and resource addresses.
3. Execute Conference Manager create, update, and cancellation against an approved in-scope test room.
4. Confirm that the same server-side path returns the expected permission-denied classification for a controlled out-of-scope resource.
5. Confirm that no duplicate event is created on retry and that cancellation/reconciliation remains deterministic.
6. Confirm that capability health and application output contain no token, raw Graph error body, provider Tenant identifier, event content, or secret.
7. Wait for Microsoft permission propagation and repeat the checks when the assignment was newly changed.
8. Repeat both the central app-registration request inventory and the customer service-principal grant inventory after every consent or reconnect; fail closed if either contains unscoped `Calendars.ReadWrite`.
9. Enable `microsoft.calendar.write` only after the release evidence below is accepted.

The normal browser must never accept a mailbox, provider Tenant, Graph URL, access token, provider event reference, or entitlement as authority. Live acceptance must use the existing Tenant-owned room mapping and server-side provider path.

## Evidence and activation gate

Create a protected, short-lived JSON input for the non-sensitive repository check. `configuredRoomIds` must be the complete set of internal room IDs currently enabled for the Pilot Tenant; copy those IDs from the approved room-mapping inventory, never substitute mailbox addresses. `authorizationChecks` must contain exactly one result for every configured ID. Translate only the role and `InScope` outcome from the corresponding `Test-ServicePrincipalAuthorization` result:

```json
{
  "schemaVersion": 1,
  "verifiedAt": "2026-08-26T10:00:00.000Z",
  "centralAppRegistration": {
    "calendarsReadWriteRequested": false
  },
  "customerServicePrincipal": {
    "unscopedCalendarsReadWriteGranted": false
  },
  "configuredRoomIds": ["internal-room-id"],
  "authorizationChecks": [
    {
      "roomId": "internal-room-id",
      "roleName": "Application Calendars.ReadWrite",
      "inScope": true
    }
  ],
  "negativeControl": {
    "roleName": "Application Calendars.ReadWrite",
    "inScope": false
  }
}
```

Run the fail-closed check from the exact release checkout:

```bash
npm run pilot:exchange-rbac -- /protected/path/exchange-rbac-evidence.json
```

The command accepts one regular file of at most 64 KiB, rejects symlinks, unknown fields, duplicate or missing room checks, an incorrect role, an in-scope negative control, and either form of unscoped Calendar Write. It prints only status and counts; it never prints room IDs or rejected input. A successful result means the supplied non-sensitive evidence is internally complete. It does not contact Microsoft and does not replace the live Graph acceptance below. Delete the short-lived input according to the protected evidence-retention policy after its accepted reference has been recorded.

For a release with Calendar Write enabled, the Pilot readiness document must mark both of these items `verified` with non-secret references and UTC verification times:

- `acceptance.graph_calendar_write`;
- `security.exchange_application_rbac`.

The evidence reference must point to the controlled change/test record and include, outside this repository:

- customer organization and environment by approved internal reference;
- application/client ID and service-principal Object ID as non-secret administrative identifiers;
- scope and role-assignment names;
- direct membership review for every enabled Pilot room;
- the successful `npm run pilot:exchange-rbac` summary from the release commit;
- redacted `Test-ServicePrincipalAuthorization` results for an in-scope and out-of-scope resource;
- proof that central `requiredResourceAccess` does not request Microsoft Graph application permission `Calendars.ReadWrite`;
- proof that unscoped Entra `Calendars.ReadWrite` is absent;
- live create/update/cancel success for an in-scope room;
- live denial for an out-of-scope resource;
- reviewer, timestamp, change reference, and rollback result.

Do not copy mailbox content, event bodies, tokens, secrets, cookies, raw Graph payloads, or personal data into the JSON evidence document.

## Failure, rollback, and periodic review

If any scope or live check fails:

1. keep or set `microsoft.calendar.write` to disabled;
2. do not activate productive Calendar Write;
3. inspect direct group membership, the Exchange service-principal pointer, scope, role assignment, unscoped Entra grants, and propagation time;
4. remove or correct the role assignment through the approved Exchange change path;
5. repeat both positive and negative verification;
6. record the failed outcome and remediation without secrets.

Reverify after any group-membership, role-assignment, service-principal, Entra permission, consent/reconnect, room-mapping, or central application change. This includes rechecking both `requiredResourceAccess` and the customer service-principal grant inventory. A successful historical check is not evidence for the current configuration.
