# Tenant Locations and Rooms

## Scope and authority

This document describes the bounded Locations/Rooms aggregate and the SaaS 3.6 field-level ownership split. Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/TENANT-SETTINGS-CONTRACTS.md`, `docs/AUTHORIZATION.md`, `docs/AUDIT.md`, `docs/PERSISTENCE.md` and `docs/SECURITY.md` remain authoritative.

The bounded owner is split across:

- domain validation: `src/domain/tenant-locations.js`;
- application authorization/classification: `src/application/tenant-location-administration-service.js`;
- PostgreSQL persistence: `src/persistence/postgres/tenant-location-repository.js`;
- HTTP transport: `src/http/settings/locations.js`;
- schema migration: `migrations/021_tenant_location_self_service.*.sql`.

No generic Tenant settings service or browser-owned authorization decision is introduced.

## API contract

`GET /api/v1/tenant/settings/locations` returns the current bounded configuration with `schemaVersion`, `revision`, `configuration` and presentation-safe `providerContext`.

`PUT /api/v1/tenant/settings/locations` accepts exactly `schemaVersion`, `expectedRevision` and `configuration`. Tenant and actor are always derived from the authenticated server session. Mutating requests require the existing CSRF guard.

Read/history access is available only to recognized authorized principals that require the aggregate for their role. Mutation authorization is field-level and server-classified from a diff against the locked persisted current snapshot; the client does not select the authorization class.

`GET /api/v1/tenant/settings/locations/history` returns bounded revision metadata. `GET /api/v1/tenant/settings/locations/history/{revision}` returns an immutable local-configuration snapshot. A stale write returns `409 TENANT_SETTINGS_REVISION_CONFLICT` with only the current safe numeric revision. No stale mutation, revision increment or success audit event commits.

## Legacy Room text during Guest rollout

Stored v1/v2 Locations reads and history retain previously accepted bounded Room `floor` and `accessibility` values, even when a value fails the newer public Guest text screen. The public Guest projection validates separately and fails closed for unsafe stored text. New Locations writes still require the strict public-safe Room text shape; an authorized Manager must correct affected legacy values before submitting a new aggregate revision. The Site Guest prose policy in ADR-012 remains a separate release blocker until structured values replace it.

## SaaS 3.6 ownership boundary

Conference Manager owns Room business fields:

- local display `name`;
- approved `capacity`;
- `active` business availability;
- `floor`;
- bounded `equipment` and `accessibility` tags;
- applicable `serviceIds`;
- applicable `cateringPackageIds`;
- local `floorplanAssetId` and `mediaAssetIds`.

Those changes require `conference_manager` plus `tenant:rooms:business:manage`.

Tenant Admin owns technical Location shape:

- Site records, including stable ID, display name, active state, authoritative IANA time zone and bounded postal address metadata;
- Room stable identity;
- Room-to-Site technical assignment (`siteId`);
- provider connection/discovery/import/resync and provider Room identity/resource mapping through the dedicated integration services.

Those Location-shape changes require `tenant_admin` plus `tenant:configure`. Provider mapping operations additionally remain behind their dedicated Tenant Admin integration permissions/services.

A mutation containing both technical and Room-business changes requires both permission classes. In practice this means a dual-role Principal. Tenant Admin does not gain Room-business authority from `tenant:configure`, and Conference Manager cannot change Sites, Room stable identity or provider mapping.

The service supplies a synchronous, side-effect-free field authorizer to the owning repository. After locking and matching the expected revision, the repository invokes it with the exact persisted current aggregate and proposed mutation that will be validated and applied. Classification therefore cannot be weakened by omitting browser fields, submitting a stale UI role label or claiming that a technical change is a business change.

## Provider boundary

Microsoft/provider-owned technical identifiers remain outside the mutable business contract. The read-only provider view exposes only the local Room ID plus provider kind, mapping status, provider display name/capacity and `lastSeenAt`. External Room IDs, resource addresses, Graph URLs, provider Tenant references, tokens and connection secrets are not exposed by the Locations settings endpoint.

In the Microsoft-first path, Rooms cannot be manually created through the Locations business contract. New provider-backed Rooms originate from the Microsoft discovery/import boundary. A future non-provider/manual-Room capability requires explicit product policy and acceptance evidence.

Room business metadata may be changed by Conference Manager without mutating provider identity. Provider import/resync must preserve locally authoritative Room business fields unless an explicitly governed ownership rule says otherwise.

## Time-zone migration rule

Migration 021 does not fabricate `sites.time_zone`. Existing `NULL` values remain unknown. A Site must have an explicit valid IANA time zone before the complete versioned configuration can be written.

This preserves the booking invariant: a Room whose Site time zone is unknown is not considered safely bookable.

## Concurrency, history and audit

The aggregate uses `tenants.locations_revision`. Provider discovery/resync does not advance that revision merely for provider observation. Import advances it when canonical local Room identities are created. Broad aggregate authorization occurs before persistence so unauthorized and cross-Tenant callers cannot learn a revision. For a mutation or rollback, the repository then locks the Tenant revision and rejects a mismatch before field-diff authorization. A matching request is classified synchronously against the same locked current configuration, after which reference validation, the local mutation, revision advancement, immutable snapshots and server-generated success audit evidence commit in one PostgreSQL transaction.

`tenant_location_revisions` is immutable. History contains local configuration only; provider observations are excluded so resync cannot rewrite Tenant-settings history. An already-applied bulk receipt returns its stored response before revision comparison or field authorization; a pending receipt follows the same locked revision and authorization path as a normal mutation.

The persistence-layer write remains the final concurrency authority. A stale optimistic revision or conflicting authoritative change fails closed without field-denial or success audit evidence. If field authorization denies a matching revision, the business transaction rolls back first and the application service then records exactly one denial event outside that aborted transaction.

Historical snapshots can contain both technical and Room-business fields. They are evidence, not an authorization bypass. Reapplying a mixed snapshot requires the same field-level authorization classification as a normal mutation; a single elevated role cannot use history/rollback to gain the other role's field ownership.

## Reference protection

Physical deletion is not part of the public contract. Existing Sites and Rooms are retained/deactivated according to domain rules. Room creation remains blocked in the Microsoft-first Locations path.

Deactivation is rejected when the canonical Room identity is referenced by a non-terminal current/future Request, a non-cancelled provider booking reference or an applying confirmed-booking change. Booking-change approval and Location mutation share the Tenant location-authority lock; whichever starts second revalidates after the first commits. Service and Catering applicability IDs are revalidated inside the Tenant-scoped transaction. Browser claims about references are never authoritative.

A Site cannot be inactive while one of its Rooms remains active.

## Rollout and compatibility

The legacy `/api/v1/application/configuration` Site-only endpoint remains only for coordinated client reads. Its `PUT` method is disabled with `405 METHOD_NOT_ALLOWED`; all supported writes use the versioned Locations endpoint and cannot bypass optimistic concurrency or SaaS 3.6 authorization classification.

Migration rollback is fail-closed after versioned/domain use and requires reviewed forward remediation rather than silent loss of authorization/history evidence.

## Required acceptance evidence

- exact schema and malformed/provider-field rejection tests;
- explicit Employee, Conference Manager, Tenant Admin and dual-role field-ownership tests;
- mixed mutation requiring both elevated capability sets;
- cross-Tenant concealment/denial;
- PostgreSQL tenant isolation, migration, concurrent writer and audit-atomic tests;
- frontend ownership-projection tests showing Conference Manager preserves Sites/`siteId` and Tenant Admin preserves Room business fields;
- shared-Demo browser evidence on the same server-backed API contract;
- provider discovery/import/resync evidence remains separate external acceptance and never substitutes for local authorization tests.

## Explicit version 2 Guest Information

Locations v2 adds nullable Site-owned `guestInformation`; v1 reads omit it and v1 writes, rollbacks and bulk operations preserve it. Guest changes use the same locked revision, Site-field authorization, immutable history and audit transaction. See `docs/SITE-GUEST-INFORMATION.md` for exact configuration, negotiation and migration 037.
