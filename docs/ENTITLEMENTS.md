# Tenant Entitlements and Capability Access

## Authority and scope

Root `AGENTS.md` is authoritative. This document defines the SaaS 0 entitlement boundary introduced by issue #53.

Entitlements are server-side Tenant product/commercial access controls. They are not authentication, RBAC permissions, UI visibility, or rollout feature flags.

## Required access intersection

Effective capability access is an intersection:

```text
server authorization
AND Tenant entitlement
AND optional server-controlled rollout gate
```

A rollout state can disable an otherwise authorized and entitled capability. It can never grant a capability when authorization or entitlement is missing.

Unknown capability identifiers fail closed.

## Stable capability IDs

The initial SaaS 0 registry contains only capabilities needed for the Microsoft-first pilot path:

- `microsoft.directory`
- `microsoft.calendar`

These identifiers describe product capability boundaries, not provider claims, OAuth scopes, UI labels, or feature-flag names. Adding another commercial capability requires a reviewed domain change, database migration, tests and documentation.

Baseline Conference Manager functionality is intentionally not represented as an entitlement merely because persistence moves to the backend.

## Separation from frontend feature flags

The frontend repository keeps its centralized rollout registry in `src/platform/feature-flags.js`. That registry is a browser/UI rollout mechanism and remains untrusted for productive authorization.

This backend deliberately does not duplicate or import the frontend flag registry. `createEntitlementService` accepts an optional server-controlled `rolloutPolicy` port. The default state is `not_controlled`, meaning no additional operational rollout gate is applied at this backend boundary.

When a future backend rollout system is introduced, it may supply `enabled` or `disabled` for a known capability. Browser-supplied flag values, query parameters, headers, LocalStorage or UI visibility must never populate that policy.

## Persistence model

Migration 005 adds `tenant_entitlements`:

- internal non-null `tenant_id`;
- stable allowlisted `capability_id`;
- explicit boolean `enabled` state;
- server timestamp;
- composite primary key `(tenant_id, capability_id)`;
- Tenant foreign key with `ON DELETE RESTRICT`.

No row means not entitled. This is a fail-closed default.

The database allowlist currently accepts only the two registered Microsoft pilot capability IDs. Application and database allowlists must remain synchronized through the entitlement architecture gate and migration tests.

## Tenant isolation

Entitlement reads and writes are scoped by internal Tenant ID plus capability ID. Same capability IDs can have independent states in separate Tenants.

Runtime capability evaluation additionally requires the authenticated Principal Tenant to equal the active Tenant context. A client Tenant selector is not part of the entitlement contract.

## Operator-controlled changes

Commercial entitlement mutation is not a Tenant Admin permission. #53 exposes a server-internal operator authorization port rather than creating a public Platform Admin HTTP endpoint before the platform-operator authorization domain exists.

The default operator authorization is deny-all. A future developer/platform administration service must provide a trusted server-side authorization function before it can call `setEntitlement`.

Tenant Admin, Employee, Conference Manager, browser role values and frontend flags cannot enable an entitlement.

## Audit and atomicity

A real entitlement state change creates `tenant.entitlement.changed` in the Tenant audit chain.

The Tenant-visible event contains:

- target type `entitlement`;
- target ID = stable capability ID;
- previous/new `enabled` state;
- correlation ID;
- administrative retention class;
- non-secret `actorType=platform_operator` metadata.

The Tenant audit actor User ID is null because the platform/operator identity belongs to the separate platform authorization/audit domain. #53 does not pretend that a platform operator is a Tenant User. A future platform audit system must retain the actual operator identity independently.

The entitlement write and Tenant audit append commit in one PostgreSQL transaction. If audit persistence fails, the entitlement change rolls back. Repeating the same effective value is idempotent and does not emit a misleading `changed` event.

## Rollback and recovery

Migration 005 down is fail-closed when entitlement rows or `tenant.entitlement.changed` events exist. Populated-environment rollback therefore requires an explicit reviewed migration/retention decision rather than silent data or evidence deletion.

## Security properties

- unknown capabilities fail closed;
- missing entitlement fails closed;
- unknown/malformed rollout state fails closed;
- unauthorized/cross-Tenant/inactive-Tenant capability evaluation fails closed before entitlement lookup where practical;
- rollout enablement never overrides missing authorization or entitlement;
- operator mutation is deny-by-default;
- no entitlement authority is accepted from browser headers/query/body/storage;
- no secrets or provider tokens are stored in entitlement data or audit metadata;
- PostgreSQL parameter binding and Tenant predicates are mandatory;
- entitlement changes are audit-atomic.

## Deferred ownership

- a public Platform Admin/developer administration API and its operator Principal model;
- a server-side operational rollout service, if needed beyond deployment/configuration controls;
- provider-specific Entra/Microsoft Graph consent and scope mapping;
- capability-specific business endpoints, which must perform their own RBAC/object authorization before entitlement evaluation;
- billing/subscription lifecycle.

Future provider endpoints must not treat `evaluateAccess()` as a substitute for business authorization. Their owning use case first determines authorization, then requires the Tenant entitlement, with an optional rollout gate as an additional restriction.
