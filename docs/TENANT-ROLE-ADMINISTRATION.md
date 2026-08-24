# Tenant Role Administration

## Authority and scope

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` remain authoritative. This document defines the Tenant-scoped role administration boundary implemented for SaaS 1 issue #61.

The Tenant role model remains separate from platform/operator authorization. `platform_admin` is not a Tenant role and cannot be assigned through this API.

## Role model

Every active local User has the implicit safe Employee baseline after successful JIT resolution. Employee is not stored as a mutable role assignment.

Only these elevated Tenant roles are persistable:

- `conference_manager`;
- `tenant_admin`.

The effective Principal is reconstructed server-side on every successful login from:

1. the implicit `employee` baseline;
2. validated elevated role rows owned by the same internal Tenant/User;
3. the canonical role-to-permission mapping in `src/authorization/policy.js`.

Browser input, email/domain, display name, Entra groups/roles, or other provider claims never establish elevated application authorization.

## First Tenant Admin bootstrap

Tenant claiming already validates the external Entra Tenant and User identity that confirmed the invitation. Migration 010 adds a nullable `claimant_provider_user_reference` to the active Tenant identity binding.

For claims completed after migration 010:

- claim confirmation stores the already validated provider User reference on the Tenant binding;
- JIT compares the current validated Entra User reference with that stored claimant reference;
- only an exact match is eligible for one-time Tenant Admin bootstrap;
- PostgreSQL serializes bootstrap against role administration for the Tenant;
- bootstrap occurs only when no active Tenant Admin already exists;
- User creation, provider-User binding, Tenant Admin role row, provisioning audit and role-change audit commit atomically.

The claimant reference is server-side identity linkage. It is not returned by the public session or Tenant User APIs and is not copied into audit metadata.

A pre-migration Tenant identity binding has no trustworthy durable claimant User reference. It therefore does **not** guess the first Tenant Admin from the first user who logs in. Such a Tenant remains fail-closed and requires the controlled recovery procedure below.

## Tenant Admin API

### List users

`GET /api/v1/tenant/users`

Requirements:

- valid server-side session;
- session-available Tenant context derived from the Principal;
- recognized Tenant authorization snapshot;
- `tenant_admin` role plus `tenant:users:manage` permission.

Optional bounded query parameters:

- `limit` from 1 to 100;
- `afterId` as an internal User UUID cursor.

The endpoint accepts no Tenant selector. Returned data is limited to internal User ID, display name, active state and effective Tenant roles.

### Replace elevated roles

`PUT /api/v1/tenant/users/{userId}/roles`

Request body:

```json
{
  "roles": ["conference_manager", "tenant_admin"]
}
```

Rules:

- CSRF token is mandatory because the application uses cookie authentication;
- the body accepts exactly `roles` and no additional keys;
- only `conference_manager` and `tenant_admin` are accepted;
- `employee` is implicit and cannot be removed or submitted as an elevated role;
- `platform_admin` is rejected;
- the target User is always resolved inside the authenticated Tenant;
- a User cannot change its own elevated roles;
- elevated roles cannot be newly assigned to an inactive User;
- removing the last viable active Tenant Admin fails with `LAST_TENANT_ADMIN_REQUIRED`;
- unchanged requests are idempotent and do not increment `security_version` or append duplicate role-change evidence.

## Session invalidation

Every real role change increments `users.security_version` in the same PostgreSQL transaction as the role mutation and success audit event.

Existing sessions snapshot the prior version in `sessions.principal_version`. Session resolution therefore rejects every stale session immediately after the role transaction commits. The changed User must authenticate again to receive a Principal rebuilt from the new server-side role state.

No browser-controlled session rotation can submit new roles or permissions.

## Concurrency and last-admin invariant

Role mutations acquire a transaction-scoped PostgreSQL advisory lock keyed by the internal Tenant before evaluating or writing Tenant Admin assignments.

The last-admin check counts only active Users with an actual `tenant_admin` assignment in the same Tenant. Concurrent attempts to remove two final administrators serialize; at most one removal can commit if it would otherwise leave no viable active Tenant Admin.

Cross-Tenant User IDs resolve as unavailable and do not reveal whether the User exists elsewhere.

## Audit and privacy

Successful changes use the existing `tenant.user_permissions.changed` audit action and commit atomically with the role/security-version mutation.

Audit state records only role booleans (`conferenceManager`, `tenantAdmin`). It does not copy display names, provider User references, tokens, session IDs or other credentials.

Denied operations and last-admin/inactive conflicts generate Tenant-scoped denial/failure evidence when a valid authenticated Tenant context exists.

## Recovery path

The normal recovery path is to use another viable Tenant Admin. The product prevents removal of the last viable Tenant Admin specifically to keep that path available.

If no viable Tenant Admin exists because of an external operational event such as all administrator Users being disabled, recovery is an exceptional platform-operator procedure, not a browser/API bypass. The operator must:

1. verify the customer organization and intended recovery User out of band;
2. verify the internal Tenant/User mapping from trusted backend data;
3. restore exactly one `tenant_admin` assignment through an approved privileged maintenance path under change control;
4. increment that User's `security_version`;
5. append `tenant.user_permissions.changed` administrative evidence with a non-secret recovery reason classification;
6. require fresh authentication before the recovered authorization is usable.

There is intentionally no Tenant API switch that bypasses the last-admin or authorization rules. A future platform-operator API, if added, belongs to the separate operator authorization domain and must preserve the same mutation/audit invariants.

## Migration and rollback

Migration 010 adds claimant linkage and the `tenant_user_roles` table. Rollback fails closed when either real role rows or claimant references exist. Operational rollback then requires reviewed data handling rather than silent deletion of authorization evidence.

Runtime schema readiness advances to version 10.

## Verification

Required automated evidence includes:

- claimant-only Tenant Admin bootstrap;
- non-claimant safe Employee default;
- persisted Conference Manager/Tenant Admin roles on repeat login;
- unauthorized Employee access;
- self-change denial;
- cross-Tenant target concealment;
- invalid/Platform role rejection;
- inactive User protection;
- last-admin prevention including concurrent removal attempts;
- stale-session invalidation via `security_version`;
- audit-atomic role mutation;
- migration rollback protection;
- API CSRF and positive-schema validation.
