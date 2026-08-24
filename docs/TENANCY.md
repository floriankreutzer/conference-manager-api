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

Issue #48 defines Tenant state semantics, not platform/operator transition workflow. Platform/operator lifecycle authorization belongs to later control-plane work.

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
- services;
- catering packages and individual catering items;
- requests/bookings;
- notifications;
- integrations and provider references;
- entitlements;
- audit events;
- Tenant configuration.

Future Tenant-owned resource classes inherit the same invariant unless an explicit architecture decision defines them as platform-owned instead.

## Repository contract

`createTenantScopedRepository` defines the generic scoped repository pattern. Concrete PostgreSQL adapters introduced by #49/#51 preserve the same direction even when a resource has a specialized repository contract.

Generic Tenant-owned adapters expose only scoped methods such as:

- `findByTenantIdAndId(tenantId, resourceId)`;
- `listByTenantId(tenantId)`;
- `insertForTenant(tenantId, value)`;
- `updateByTenantIdAndId(tenantId, resourceId, value)`;
- `deleteByTenantIdAndId(tenantId, resourceId)`.

The generic wrapper never offers unscoped `findById`, `updateById`, or `deleteById` calls. Tenant ID is supplied separately from mutation data, and payloads that try to set `tenantId` are rejected. Adapter results are revalidated so an adapter cannot silently return another Tenant's resource.

The specialized PostgreSQL Request repository follows the same invariant through `findByTenantIdAndId` and `transitionByTenantIdAndId`; its SQL always includes internal `tenant_id`.

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

Physical Tenant deletion is not a normal lifecycle operation. Retained records remain owned by the internal Tenant ID, while suspended/archived semantics prevent normal access until an explicitly authorized recovery/control-plane process exists.

## Object authorization (#51)

Tenant isolation is necessary but not sufficient for object access.

After active Tenant resolution, `src/authorization/policy.js` applies role/permission and object-level rules. Employee Request access additionally requires server-side ownership by the authenticated internal User. Conference Manager may access Request objects only inside the authenticated Tenant. Tenant Admin does not inherit Conference Manager Request authority.

For an Employee, a missing Request, a cross-Tenant Request ID and a same-Tenant Request owned by another User are all exposed as `404 NOT_FOUND`. The API does not reveal which security condition caused the object to be unavailable.

The current Conference Manager scope granularity is the internal Tenant. A finer site/location/department scope requires a future explicit server-side model; it must not be derived from browser values or inferred provider claims.

See `docs/AUTHORIZATION.md`.

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
- stale/concurrent workflow updates.

These tests are security release evidence for the implemented scope only. They do not replace penetration testing or later platform/control-plane authorization testing.
