# Tenant Locations and Rooms

## Scope and authority

This document describes the bounded SaaS 2 Locations/Rooms owner introduced for issue `conference-manager#82`. Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/TENANT-SETTINGS-CONTRACTS.md`, `docs/AUTHORIZATION.md`, `docs/AUDIT.md`, `docs/PERSISTENCE.md` and `docs/SECURITY.md` remain authoritative.

The bounded owner is split across:

- domain validation: `src/domain/tenant-locations.js`;
- application service: `src/application/tenant-location-administration-service.js`;
- PostgreSQL persistence: `src/persistence/postgres/tenant-location-repository.js`;
- HTTP transport: `src/http/settings/locations.js`;
- schema migration: `migrations/021_tenant_location_self_service.*.sql`.

No generic Tenant settings service, repository, route or persistence document is introduced.

## API contract

`GET /api/v1/tenant/settings/locations` returns the current bounded configuration with `schemaVersion`, `revision`, `configuration` and presentation-safe `providerContext`.

`PUT /api/v1/tenant/settings/locations` accepts exactly `schemaVersion`, `expectedRevision` and `configuration`. The Tenant and actor are always derived from the authenticated server session. Unsafe requests require the existing CSRF guard.

Every route requires Tenant Admin plus `tenant:configure`. Server-side authorization denials are recorded through the existing bounded audit service before the request fails.

`GET /api/v1/tenant/settings/locations/history` returns bounded revision metadata. `GET /api/v1/tenant/settings/locations/history/{revision}` returns an immutable local-configuration snapshot. `POST /api/v1/tenant/settings/locations/rollback` creates a new revision from an existing snapshot; it never rewinds the revision counter.

A stale write returns the shared `409 TENANT_SETTINGS_REVISION_CONFLICT` response with only the current safe numeric revision. No stale mutation, revision increment or success audit event is committed.

## Ownership boundaries

Tenant-managed Site fields are stable ID, display name, active state, authoritative IANA time zone and bounded postal address metadata.

Tenant-managed Room fields are stable ID, Site assignment, local display name, approved capacity, active state, floor, bounded equipment/accessibility tags, applicable Service/Catering IDs and local asset references.

Microsoft-owned technical identifiers remain outside the mutable contract. The read-only provider view exposes only the local Room ID plus provider kind, mapping status, provider display name/capacity and `lastSeenAt`. External room IDs, resource addresses, Graph URLs, provider Tenant references, tokens and connection secrets are not exposed by the Locations settings endpoint.

In the Microsoft-first pilot, Rooms cannot be manually created through the Locations contract. New Rooms continue to originate from the existing Microsoft discovery/import boundary. This prevents local data from masquerading as a provider-backed Room. A future non-Microsoft/manual-room capability requires an explicit product policy and its own acceptance evidence.

## Time-zone migration rule

Migration 021 does not update `sites.time_zone`. Existing `NULL` values remain `NULL`; no UTC, browser-local or inferred default is fabricated. Reads can therefore expose legacy Sites with an unknown time zone, but a Site must have an explicit valid IANA time zone before the complete versioned configuration can be written.

This preserves the existing booking invariant: a Room whose Site time zone is unknown is not considered safely bookable.

## Concurrency, history and audit

The aggregate uses only `tenants.locations_revision`. Provider discovery/resync does not advance that revision because provider observations are not Tenant settings. Microsoft room import does advance it once whenever an import creates one or more local Rooms. A successful local mutation or local-room import locks the Tenant revision, validates current server-side references, snapshots the prior local state, applies the local mutation, advances the revision, snapshots the actual resulting state and appends server-generated audit evidence in one PostgreSQL transaction.

`tenant_location_revisions` is immutable. Update and delete triggers reject mutation of historical snapshots. History contains local configuration only; provider observations are deliberately excluded so a Microsoft resync cannot rewrite or reinterpret a Tenant settings revision.

Rollback preserves local identities created after the selected historical revision by deactivating those newer Sites/Rooms. Reference checks still apply. The new rollback revision snapshots the actual post-apply state, including those retained inactive identities, rather than claiming that the older snapshot was restored byte-for-byte.

Rollback also revalidates the complete current writable contract. A legacy history snapshot containing an unknown Site time zone remains readable evidence, but it cannot be reapplied until an administrator submits an explicit valid IANA time zone through a normal Locations update.

## Reference protection

Physical deletion is not part of the public contract. Existing Sites and Rooms must remain present and are deactivated instead. Room creation is blocked in this Microsoft-first path.

Deactivation is rejected when the affected canonical Room identity is referenced by a non-terminal current/future Request, by a non-cancelled provider booking reference or as the target of an applying confirmed-booking change. Booking-change approval and Locations mutation share the Tenant location-authority lock; whichever starts second must revalidate after the first commits. Service and Catering applicability IDs are revalidated inside the Tenant-scoped transaction. Browser claims about references are never authoritative.

A Site cannot be inactive while one of its Rooms remains active.

## Rollout and compatibility

The legacy `/api/v1/application/configuration` Site-only endpoint remains temporarily for coordinated client reads. Its `PUT` method is disabled with `405 METHOD_NOT_ALLOWED`; all supported Tenant Admin writes use the versioned Locations endpoint and cannot bypass optimistic concurrency.

Migration 021 may be rolled back only while `tenant_location_revisions` is empty, every Tenant still has `locations_revision = 1`, and no Site/Room detail value would be discarded. After a versioned mutation, rollback fails closed and requires a reviewed forward fix or compatible application rollback.

## Required acceptance evidence

Before issue #82 is complete:

- unit tests cover exact schemas, missing/invalid time zones, provider-field rejection, manual-room rejection and stale revisions;
- PostgreSQL integration tests cover tenant isolation, migration up/down, concurrent writers, audit rollback and referenced deactivation;
- frontend Production and Shared Demo server-backed journeys exercise the same
  `schemaVersion`/revision/conflict behavior;
- Employee room search, final availability, Manager planning and history continue to use the canonical Room IDs;
- Microsoft discovery/import/resync is externally exercised against the configured Entra development/pilot environment; that evidence is tracked with `external-acceptance-evidence`.
