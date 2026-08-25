# Tenant Entitlements and Capability Access

## Authority and scope

Root `AGENTS.md` is authoritative. This document defines the server-side entitlement boundary introduced by issue #53 and extended for the Microsoft Enterprise Pilot.

Entitlements are server-side Tenant product/commercial access controls. They are not authentication, RBAC permissions, UI visibility, provider consent, or rollout feature flags.

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

The Microsoft-first pilot registry contains:

- `microsoft.directory` — Microsoft Places/directory capability;
- `microsoft.calendar` — calendar read/free-busy capability;
- `microsoft.calendar.write` — productive calendar create/update/cancel capability.

Calendar write is deliberately separate from free/busy. A Tenant entitled for `microsoft.calendar` does not receive `microsoft.calendar.write`. This permits real room discovery and availability while productive Exchange mutations remain disabled.

These identifiers describe product capability boundaries, not provider claims, OAuth scopes, UI labels, or feature-flag names. Adding another commercial capability requires a reviewed domain change, database migration, tests and documentation.

Baseline Conference Manager functionality is intentionally not represented as an entitlement merely because persistence moves to the backend.

## Microsoft permission boundary

The entitlement is not the Microsoft consent itself. In the confidential-client/application-permission model, Microsoft Graph access tokens use the configured application roles through the `/.default` scope. Productive calendar writes require the reviewed Microsoft application role `Calendars.ReadWrite` on the central SaaS app registration.

Because application roles are configured on the app registration and administrator-consented at the provider boundary, the backend must not pretend that an internal Tenant entitlement dynamically adds or removes a Microsoft application role. Instead:

1. Microsoft consent establishes the provider permission boundary.
2. `microsoft.calendar.write` independently determines whether Conference Manager is allowed to invoke productive write operations for an internal Tenant.
3. The owning business use case must still pass explicit RBAC/object authorization.
4. Exchange Application RBAC may additionally constrain the central application to intended resource mailboxes where supported.

Provider permission and Tenant entitlement are therefore both necessary controls; neither substitutes for the other.

## Separation from frontend feature flags

The frontend repository keeps its centralized rollout registry in `src/platform/feature-flags.js`. That registry is a browser/UI rollout mechanism and remains untrusted for productive authorization.

This backend deliberately does not duplicate or import the frontend flag registry. `createEntitlementService` accepts an optional server-controlled `rolloutPolicy` port. The default state is `not_controlled`, meaning no additional operational rollout gate is applied at this backend boundary.

When a future backend rollout system is introduced, it may supply `enabled` or `disabled` for a known capability. Browser-supplied flag values, query parameters, headers, LocalStorage or UI visibility must never populate that policy.

## Persistence model

Migration 005 adds `tenant_entitlements` with:

- internal non-null `tenant_id`;
- stable allowlisted `capability_id`;
- explicit boolean `enabled` state;
- server timestamp;
- composite primary key `(tenant_id, capability_id)`;
- Tenant foreign key with `ON DELETE RESTRICT`.

No row means not entitled. This is a fail-closed default.

Migration 013 extends the database capability allowlist with `microsoft.calendar.write`. Application and database allowlists must remain synchronized through architecture/entitlement gates and migration tests. Migration 013 rollback fails closed while a calendar-write entitlement row exists so productive grants cannot be silently reinterpreted or lost.

## Tenant isolation

Entitlement reads and writes are scoped by internal Tenant ID plus capability ID. Same capability IDs can have independent states in separate Tenants.

Runtime capability evaluation additionally requires the authenticated Principal Tenant to equal the active Tenant context. A client Tenant selector is not part of the entitlement contract.

## Operator-controlled changes

Commercial entitlement mutation is not a Tenant Admin permission. The entitlement service exposes a server-internal operator authorization port rather than creating a public Platform Admin HTTP endpoint before the platform-operator authorization domain exists.

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

The Tenant audit actor User ID is null because the platform/operator identity belongs to the separate platform authorization/audit domain. The Tenant model does not pretend that a platform operator is a Tenant User. A future platform audit system must retain the actual operator identity independently.

The entitlement write and Tenant audit append commit in one PostgreSQL transaction. If audit persistence fails, the entitlement change rolls back. Repeating the same effective value is idempotent and does not emit a misleading `changed` event.

## Rollback and recovery

Migration 005 down remains fail-closed when entitlement rows or `tenant.entitlement.changed` events exist. Migration 013 additionally refuses rollback while `microsoft.calendar.write` rows exist. Populated-environment rollback therefore requires an explicit reviewed migration/retention decision rather than silent data or evidence deletion.

## Security properties

- unknown capabilities fail closed;
- missing entitlement fails closed;
- calendar read/free-busy entitlement never implies calendar write;
- provider consent never substitutes for internal Tenant entitlement;
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
- Exchange Application RBAC verification and customer hardening guidance;
- billing/subscription lifecycle.

Future provider endpoints must not treat `evaluateAccess()` as a substitute for business authorization. Their owning use case first determines authorization, then requires the Tenant entitlement, with an optional rollout gate as an additional restriction.
