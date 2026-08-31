# Tenant Isolation Model

## Security objective

Tenant identity is a server-side security boundary. A browser-controlled header, route value, query value, JSON field, external provider identifier, email domain, or UI state never establishes Tenant authority.

The authenticated server-side Principal provides the internal `tenantId`. The backend resolves that identifier to the canonical Tenant record before protected Tenant operations are allowed.

## Canonical Tenant entity

The canonical Tenant record contains only:

- `id`: stable internal UUID owned by Conference Manager;
- `displayName`: Tenant display name;
- `status`: lifecycle state;
- `createdAt`: UTC creation timestamp;
- `updatedAt`: UTC update timestamp.

Provider identifiers such as a Microsoft Entra tenant ID are deliberately not fields of the canonical Tenant entity. They belong to provider/identity binding records and may never replace the internal Tenant ID for ownership or authorization checks.

## Lifecycle states

| State | Session/onboarding context | Productive business operations | Meaning |
| --- | --- | --- | --- |
| `pending` | allowed | denied | Tenant exists but onboarding has not started. |
| `onboarding` | allowed | denied | Tenant setup is in progress. |
| `ready` | allowed | denied | Required setup can be complete but productive activation has not occurred. |
| `active` | allowed | allowed | Productive Tenant operations are permitted subject to authorization and entitlements. |
| `suspended` | denied | denied | Tenant is temporarily disabled. Retained data is unavailable to normal Tenant operations. |
| `archived` | denied | denied | Tenant is logically retired and unavailable to normal Tenant operations. |

The authenticated Platform lifecycle contract permits only these state changes:

| Current state | Target state | Purpose |
| --- | --- | --- |
| `onboarding` | `ready` | Record that the server-derived onboarding prerequisites are complete. |
| `ready` | `active` | Enable productive use after the release/change decision. |
| `active` | `suspended` | Stop Tenant access without deleting retained data or evidence. |
| `suspended` | `active` | Reactivate only after readiness and change approval are verified again. |

Repeating the current `ready`, `active`, or `suspended` target is an authorized idempotent no-op. The claiming service, not the Platform lifecycle service, owns the `pending` to `onboarding` transition. `archived` is terminal and cannot be returned to `ready`, `active`, or `suspended` through a Platform lifecycle operation. Every other state pair fails closed as `TENANT_PILOT_LIFECYCLE_CONFLICT`.

Lifecycle persistence uses an expected-current-state condition. A concurrent status change returns the same conflict instead of reporting completion, and no lifecycle audit success is committed for the stale mutation.

## Tenant context

`createTenantContextGuard` loads the Tenant using only `principal.tenantId`.

Rules:

- missing Principal Tenant context fails closed;
- unknown Tenant fails closed;
- malformed or mismatched repository results fail closed as an internal contract violation;
- `suspended` and `archived` fail closed;
- `requireKnown` permits only `pending`, `onboarding`, `ready`, or `active` contexts;
- `requireActive` permits only `active` Tenants for productive business operations;
- no request object, Tenant header, query parameter, route parameter, or body value participates in Tenant resolution.

The `/api/v1/session` endpoint resolves the Principal first and then verifies the server-side Tenant record. Client-supplied Tenant selectors are ignored and cannot override the Principal.

## Tenant-owned resource inventory

The following resource classes are Tenant-owned and carry explicit internal Tenant ownership when persisted:

- users;
- sites;
- rooms;
- Room prices;
- services;
- catering packages and individual catering items;
- requests/bookings, immutable Request revisions and booking-change proposals;
- notifications;
- integrations and provider references;
- entitlements;
- audit events;
- Tenant configuration.

Future Tenant-owned resource classes inherit the same invariant unless an explicit architecture decision defines them as platform-owned instead.

## Repository contract

`createTenantScopedRepository` defines the generic scoped repository pattern. Concrete PostgreSQL adapters preserve the same direction even when a resource has a specialized repository contract.

Generic Tenant-owned adapters expose only scoped methods such as:

- `findByTenantIdAndId(tenantId, resourceId)`;
- `listByTenantId(tenantId)`;
- `insertForTenant(tenantId, value)`;
- `updateByTenantIdAndId(tenantId, resourceId, value)`;
- `deleteByTenantIdAndId(tenantId, resourceId)`.

The generic wrapper never offers unscoped `findById`, `updateById`, or `deleteById` calls. Tenant ID is supplied separately from mutation data, and payloads that try to set `tenantId` are rejected. Adapter results are revalidated so an adapter cannot silently return another Tenant's resource.

The specialized PostgreSQL Request repository follows the same invariant through scoped current,
history, create, resubmit and transition methods; its SQL always includes internal `tenant_id`.
Request revisions reference `(tenant_id, request_id)` and Room prices reference
`(tenant_id, room_id)`, preventing a cross-Tenant ID from being attached even when its business ID
is syntactically valid.

The specialized Audit repository similarly appends, lists and verifies events only within an explicit internal Tenant scope. It does not expose a cross-Tenant list API to the Tenant-facing application service.

A resource identifier that exists only in another Tenant resolves as absent inside the caller's Tenant scope. This prevents object-existence disclosure while enforcing BOLA/IDOR protection.

## Database enforcement (#49)

PostgreSQL reinforces Tenant ownership rather than relying only on application filters:

- non-null internal `tenant_id` on Tenant-owned rows;
- Tenant-scoped primary/unique keys;
- Tenant-aware composite foreign keys where Tenant-owned entities reference each other;
- `ON DELETE RESTRICT` for retained ownership chains;
- parameterized repository queries containing `tenant_id` by construction;
- transactional/conditional writes preserving ownership and state invariants;
- versioned migration and schema-readiness checks.

Physical Tenant deletion is not a normal lifecycle operation. Retained records remain owned by the internal Tenant ID. Suspended Tenants can use only the explicit readiness-gated reactivation path above; archived Tenants remain unavailable and cannot be reactivated by a Platform lifecycle operation.

## Object authorization (#51)

Tenant isolation is necessary but not sufficient for object access.

After active Tenant resolution, `src/authorization/policy.js` applies role/permission and object-level rules. Employee Request access additionally requires server-side ownership by the authenticated internal User. Conference Manager may access Request objects only inside the authenticated Tenant. Tenant Admin does not inherit Conference Manager Request authority.

For an Employee, a missing Request, a cross-Tenant Request ID and a same-Tenant Request owned by another User are all exposed as `404 NOT_FOUND`. The API does not reveal which security condition caused the object to be unavailable.

The current Conference Manager scope granularity is the internal Tenant. A finer site/location/department scope requires a future explicit server-side model; it must not be derived from browser values or inferred provider claims.

See `docs/AUTHORIZATION.md`.

## Audit isolation (#52)

Audit evidence preserves the same Tenant boundary as business data.

- Audit event Tenant ID is derived from the authenticated Principal/Tenant context or an already validated internal server identity flow, never from browser input.
- HMAC chains are independent per internal Tenant. The first event of each Tenant starts a separate chain.
- `GET /api/v1/audit` accepts no Tenant selector and passes only `tenantContext.tenantId` to the audit service/repository.
- Tenant-visible audit reads require Tenant Admin plus `tenant:audit:read` and verify only that Tenant's complete integrity chain before returning records.
- A compromised/corrupt chain in one Tenant does not cause another Tenant's chain to be treated as corrupt.
- Platform/operator audit remains a separate authorization domain and cannot be reached through Tenant Admin authorization.

See `docs/AUDIT.md`.

## Required negative testing

Tenant isolation and object-authorization tests are mandatory for every Tenant-owned repository and endpoint. Required cases include, as applicable:

- valid resource ID from another Tenant;
- guessed or malformed resource IDs;
- cross-Tenant read/list/update/delete attempts;
- same-Tenant cross-User object access;
- client-supplied `tenantId`/owner/role/permission mutation attempts;
- manipulated Tenant headers, query values and route values;
- suspended and archived Tenants;
- mismatched repository results;
- unknown role/permission values;
- concurrent operations by independent Tenants, including identical resource IDs;
- stale/concurrent workflow updates;
- Tenant-scoped audit listing and independent HMAC chains;
- audit corruption in one Tenant without cross-Tenant contamination;
- denied audit reads by non-Tenant-Admin or missing `tenant:audit:read` permission.

These tests are security release evidence for the implemented scope only. They do not replace penetration testing, external audit-chain anchoring or later platform/control-plane authorization testing.
