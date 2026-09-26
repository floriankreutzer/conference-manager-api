# Tenant User lifecycle administration

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/IDENTITY-SESSION.md`,
`docs/JIT-USER-PROVISIONING.md` and `docs/TENANT-ROLE-ADMINISTRATION.md` remain authoritative.
This document defines the SaaS 2 lifecycle extension for issue #86.

The existing role API remains the only Tenant contract for assigning `conference_manager` and
`tenant_admin`. This lifecycle boundary does not duplicate role assignment, infer roles from Entra,
or introduce SCIM/directory synchronization.

## Read contract

`GET /api/v1/tenant/users` remains Tenant Admin-only and accepts no Tenant selector. SaaS 2 adds
single-value bounded filters:

- `limit`: 1-100, default 50;
- `afterId`: internal User UUID cursor;
- `search`: trimmed case-insensitive display-name fragment, 1-80 characters;
- `status`: `all`, `active` or `disabled`;
- `role`: `all`, `employee_only`, `conference_manager` or `tenant_admin`;
- `providerLink`: `all`, `linked` or `unlinked`.

The existing `id`, `displayName`, `active` and effective `roles` fields remain. Additional fields are:

- `lifecycle.status`: `active` or `disabled`;
- `lifecycle.version`: a lifecycle-only optimistic revision, never the User security version;
- `identityProvider.linked` and `linkedAt`: minimized linkage state without provider references;
- `lastSignInAt`: the latest local application-session issue time, not provider telemetry;
- `requestOwnership.openRequestCount` and `ownershipPreservedOnDisable`.

Provider Tenant/User references, raw claims, tokens, session identifiers, token hashes, role-table details,
security versions and audit integrity material are never returned.

## Disable and reactivate contract

`PUT /api/v1/tenant/users/{userId}/access` requires the authenticated Tenant Admin, the
`tenant:users:manage` permission and valid session-bound CSRF. It accepts no query and the exact body:

```json
{
  "active": false,
  "expectedVersion": 1
}
```

The target is resolved only inside the Principal's internal Tenant. A missing or cross-Tenant UUID is
concealed as unavailable. A Tenant Admin cannot change its own lifecycle through this route. A disabled
User cannot call the route because local session/JIT resolution already fails closed.

The repository shares the Tenant-scoped advisory lock used by elevated-role administration. Disabling a
User with the last viable active `tenant_admin` assignment returns `LAST_TENANT_ADMIN_REQUIRED`.
Concurrent lifecycle or role mutations serialize, and a stale lifecycle revision returns
`TENANT_USER_LIFECYCLE_VERSION_CONFLICT` with the current lifecycle-only revision.

One successful lifecycle transaction:

1. locks the Tenant/User lifecycle and current elevated roles;
2. checks the last viable Tenant Admin invariant;
3. records the current count of owned nonterminal Requests;
4. changes `users.active`;
5. increments `users.lifecycle_revision` and `users.security_version`;
6. revokes all unrevoked local sessions for the target User;
7. appends minimized `tenant.user_permissions.changed` evidence with `operation=disable|reactivate`;
8. commits only when every required step, including audit append, succeeds.

The established audit action is reused because lifecycle state changes effective application access. Audit
state contains active/lifecycle-version values and bounded counts only. Provider references, session IDs,
display names and tokens remain excluded.

## Entra and offboarding behavior

Successful Entra authentication does not override local lifecycle state. JIT resolution joins the validated
provider binding to the local User and returns `user_disabled`; no Conference Manager session is issued until
an authorized Tenant Admin reactivates the local User.

Disable/reactivate does not delete or transfer Requests, bookings, notifications, identity bindings, role
history or audit evidence. Existing Requests retain their authoritative requester. Authorized Conference
Managers can continue the established Tenant workflow. Any future ownership-transfer feature requires a
separate explicit business workflow and audit design.

## Persistence and rollback

Migration 026 adds `users.lifecycle_revision`, initialized to `1`, plus a database trigger preventing revision
decrease. It does not alter `security_version` semantics. Rollback obtains an exclusive User-table lock and
fails with SQLSTATE `55000` after any lifecycle revision advances. Populated rollback therefore requires a
reviewed forward fix, archive or recovery decision rather than silent removal of concurrency state.

## Operational recovery

Normal recovery uses another viable Tenant Admin. If no viable administrator remains because of an external
operational failure, follow the controlled operator recovery procedure in
`docs/TENANT-ROLE-ADMINISTRATION.md`; there is no Tenant/browser bypass.

For offboarding review:

1. use the bounded User list to review active roles, provider linkage and owned open Request count;
2. decide business ownership handling outside the lifecycle API;
3. disable using the current lifecycle revision;
4. verify the returned disabled state and a fresh list read;
5. confirm stale sessions no longer resolve;
6. retain the correlated Tenant audit evidence.

Live Entra validation remains external acceptance evidence. Repository tests prove local fail-closed behavior
but do not self-approve customer identity-provider acceptance.

## SaaS 3.6 persisted Request attribution

The exact v3 Request response envelopes, relational snapshots, honest legacy-null
semantics, unchanged audit-chain payload, and mandatory staged writer cutover are
defined in [Request Attribution](REQUEST-ATTRIBUTION.md). Existing Tenant, role,
object ownership and session/CSRF boundaries remain required for these reads and writes.
