# Tenant Isolation Model

## Security objective

Tenant identity is a server-side security boundary. A browser-controlled header, route value, query value, JSON field, external provider identifier, email domain, or UI state never establishes tenant authority.

The authenticated server-side principal provides the internal `tenantId`. The backend resolves that identifier to the canonical Tenant record before protected tenant operations are allowed.

## Canonical Tenant entity

The canonical Tenant record contains only:

- `id`: stable internal UUID owned by Conference Manager;
- `displayName`: tenant display name;
- `status`: lifecycle state;
- `createdAt`: UTC creation timestamp;
- `updatedAt`: UTC update timestamp.

Provider identifiers such as a Microsoft Entra tenant ID are deliberately not fields of the canonical Tenant entity. They belong to provider/identity binding records introduced by the owning integration issues and may never replace the internal Tenant ID for ownership or authorization checks.

## Lifecycle states

| State | Session/onboarding context | Productive business operations | Meaning |
| --- | --- | --- | --- |
| `pending` | allowed | denied | Tenant exists but onboarding has not started. |
| `onboarding` | allowed | denied | Tenant setup is in progress. |
| `ready` | allowed | denied | Required setup can be complete but productive activation has not occurred. |
| `active` | allowed | allowed | Productive tenant operations are permitted subject to authorization and entitlements. |
| `suspended` | denied | denied | Tenant is temporarily disabled. Existing data remains retained but inaccessible through normal tenant operations. |
| `archived` | denied | denied | Tenant is logically retired. The state is terminal for normal tenant access and prevents orphan access to retained data. |

Issue #48 defines state semantics, not the future operator transition workflow. Platform/operator lifecycle authorization and recovery are implemented by later control-plane work.

## Tenant context

`createTenantContextGuard` loads the Tenant using only `principal.tenantId`.

Rules:

- missing principal tenant context fails closed;
- unknown Tenant fails closed;
- malformed or mismatched repository results fail closed as an internal contract violation;
- `suspended` and `archived` fail closed;
- `requireKnown` permits only `pending`, `onboarding`, `ready`, or `active` contexts;
- `requireActive` permits only `active` tenants for productive business operations;
- no request object, tenant header, query parameter, route parameter, or body value participates in tenant resolution.

The `/api/v1/session` endpoint resolves the principal first and then verifies the server-side Tenant record. Client-supplied tenant selectors are ignored and cannot override the principal.

## Tenant-owned resource inventory

The following resource classes are tenant-owned and must carry explicit internal Tenant ownership when persisted:

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
- tenant configuration.

Future tenant-owned resource classes inherit the same invariant unless an explicit architecture decision defines them as platform-owned instead.

## Repository contract

`createTenantScopedRepository` provides the mandatory repository boundary pattern for tenant-owned resources before the relational adapter is introduced in #49.

Adapters expose only scoped methods:

- `findByTenantIdAndId(tenantId, resourceId)`;
- `listByTenantId(tenantId)`;
- `insertForTenant(tenantId, value)`;
- `updateByTenantIdAndId(tenantId, resourceId, value)`;
- `deleteByTenantIdAndId(tenantId, resourceId)`.

The wrapper never offers unscoped `findById`, `updateById`, or `deleteById` calls. Tenant ID is supplied separately from mutation data, and client/application payloads that try to set `tenantId` are rejected. Adapter results are revalidated so an adapter cannot silently return another tenant's resource.

A resource identifier that exists only in another tenant resolves as absent inside the caller's tenant scope. This prevents object-existence disclosure while still enforcing BOLA/IDOR protection.

## Persistence requirements for #49

When relational persistence is introduced, tenant ownership must remain reinforced by database design rather than application filters alone. At minimum #49 must assess and implement, where applicable:

- non-null internal `tenant_id` on tenant-owned tables;
- tenant-scoped unique constraints;
- tenant-aware foreign keys or equivalent integrity controls;
- repository queries that include `tenant_id` by construction;
- transactional write behavior that preserves tenant ownership;
- migration checks proving existing and new rows cannot become ownerless;
- backup/restore and retention behavior that does not reactivate archived or suspended tenant data accidentally.

Physical tenant deletion is not implemented by #48. Retained records remain owned by the internal Tenant ID, and logical disable/archive semantics prevent normal access until an explicitly authorized lifecycle/recovery process exists.

## Required negative testing

Tenant isolation tests are mandatory for every tenant-owned repository and endpoint. Required cases include:

- valid resource ID from another tenant;
- guessed or malformed resource IDs;
- cross-tenant read, list, update, and delete attempts;
- client-supplied `tenantId` mutation attempts;
- manipulated tenant headers, query values, and route values;
- suspended and archived tenants;
- mismatched repository results;
- concurrent operations by independent tenants, including identical resource IDs.

These tests are security release evidence for the implemented scope only. They do not replace later database-level isolation tests, RBAC/object-ownership tests, or penetration testing.
