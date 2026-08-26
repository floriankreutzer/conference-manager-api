# Versioned Tenant configuration protocol

## Scope

SaaS 2 configuration is split into five independently versioned bounded domains: `organization`, `locations`, `catalog`, `booking_policies`, and `cost_allocation`. The protocol is not a generic settings store. Each domain owns its validator, application service, PostgreSQL projection and route module. Tenant authority is derived exclusively from the authenticated principal and resolved Tenant context.

## HTTP contract

Each domain exposes the same bounded protocol under its own route family:

- `GET /api/v1/tenant/<domain>` returns the current immutable snapshot and revision.
- `PUT /api/v1/tenant/<domain>` accepts exactly `expectedRevision` and `configuration`.
- `GET /api/v1/tenant/<domain>/history?limit=<1..100>` returns recent revisions.
- `GET /api/v1/tenant/<domain>/revisions/<revision>` returns one historical snapshot.
- `POST /api/v1/tenant/<domain>/revisions/<revision>/rollback` accepts exactly `expectedRevision` and appends a new rollback revision.

The concrete route names are `organization`, `locations`, `catalog`, `booking-policies`, and `cost-allocation`. Mutations require the Production session, CSRF validation, resolved Tenant context, and `tenant:configure`. Caller-supplied Tenant selectors are rejected.

The legacy `PUT /api/v1/application/configuration` mutation is retired with `410 APPLICATION_CONFIGURATION_MUTATION_RETIRED`. Its read contract remains temporarily available for SaaS 1 consumers. New mutations must use a versioned domain route so no parallel mutable authority exists.

## Concurrency, atomicity, and audit

Every mutation supplies the exact current `expectedRevision`. The server serializes mutations through a Tenant row lock and compares the expected value inside the transaction. A stale write returns `409 TENANT_CONFIGURATION_REVISION_CONFLICT` and modifies neither projections, history, nor audit evidence.

A successful transaction contains Tenant locking, domain validation and projection, append-only revision insertion, head update, and tamper-evident audit append. Any failure rolls back every step. Audit state contains revision metadata only; full configuration payloads, secrets, and provider data are not copied into audit events.

Rollback copies a historical snapshot into a new revision and reapplies the owning domain projection. Historical rows remain immutable. Database rollback fails closed when non-initial revisions, brand assets, or non-default projections exist.

## Domain invariants

Organization accepts approved locales, currencies, theme accents, and internal brand asset identifiers; remote logo URLs are invalid. Locations use stable IDs, IANA time zones, explicit archive semantics, and reject provider-owned Microsoft mapping fields. Rooms referenced by future non-cancelled requests cannot be deactivated. Catalogue prices use exact integer minor units and stable IDs. Booking policies and cost-allocation limits are bounded server-side.
