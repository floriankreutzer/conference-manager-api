# Microsoft 365 Room Mapping and Synchronization

## Authority

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/AUTHORIZATION.md`, `docs/MICROSOFT365-CONNECTION.md`, and `docs/MICROSOFT365-ROOM-DISCOVERY.md` remain authoritative.

This capability maps explicitly selected Microsoft 365 room resources into Tenant-owned Conference Manager room master data. It does not make Microsoft Graph the owner of Conference Manager-specific configuration and does not allow the browser to select Tenant or provider authority.

## Ownership model

Microsoft 365 owns the external technical identity and provider snapshot:

- external Microsoft room/place identifier;
- resource mailbox/address;
- Microsoft display name;
- Microsoft capacity snapshot;
- whether the room was present in the latest successful discovery sync.

Conference Manager owns the local room record:

- internal room identifier;
- site assignment;
- local display name;
- local capacity used by Conference Manager;
- local activation policy;
- all existing Conference Manager-only configuration such as pricing, services/catering applicability, floorplan/media and future local metadata.

Provider refresh never overwrites those local fields. A provider rename or capacity change is retained as provider metadata so the Tenant Admin can see the drift without silently mutating local business configuration.

## HTTP contract

Read current mappings:

`GET /api/v1/integrations/microsoft365/room-mappings`

Import explicitly selected discovered rooms:

`POST /api/v1/integrations/microsoft365/room-mappings/import`

```json
{
  "selections": [
    {
      "externalRoomId": "provider-room-id",
      "siteId": "local-site-id",
      "name": "Optional local display name",
      "capacity": 12
    }
  ]
}
```

Synchronize provider-owned metadata for existing mappings:

`POST /api/v1/integrations/microsoft365/room-mappings/sync`

The sync request has no body.

All operations require an authenticated internal Principal and Principal-derived known Tenant context. Import and sync are cookie-authenticated mutations and therefore require the existing session-bound CSRF contract. The browser cannot send an internal Tenant ID, provider Tenant ID, integration ID, provider access token or Graph URL.

## Import semantics

Import is explicit and bounded to 100 selected rooms per request. Every selected external room must be present in a fresh server-side discovery result for the authenticated Tenant. Every selected local site must already belong to that same Tenant.

The stable mapping key is `(tenant_id, integration_id, external_room_id)`. Re-importing an already mapped external room is idempotent: it refreshes provider-owned metadata but does not create another Conference Manager room and does not replace the existing local site/name/capacity/activation state.

An import that creates one or more local Rooms participates in the bounded Locations aggregate transaction. It snapshots the prior local configuration, advances `tenants.locations_revision` exactly once, stores the actual post-import snapshot and commits the existing administrative audit evidence atomically. A provider-metadata-only re-import does not advance the local configuration revision.

The database additionally prevents two mappings within the same Tenant/integration from claiming the same external room or resource address.

## Synchronization semantics

A synchronization first performs the same Tenant-bound Microsoft Graph discovery used by room discovery. Existing mappings are then refreshed transactionally under a Tenant-scoped advisory lock.

When a mapped provider room is still present, only provider-owned snapshot fields are refreshed and the mapping remains `active`.

When a mapped provider room is absent from a successful discovery result, its mapping becomes `missing`. The local Conference Manager room is not deleted or silently deactivated. Existing Requests and bookings therefore retain their internal room foreign key and business history. Recovery or local deactivation remains an explicit administrative decision.

`lastSeenAt` records the last time the provider room was positively observed; marking a mapping missing does not fabricate a later positive sighting.

## Tenant isolation and integrity

All persistence keys include the internal Tenant ID. Foreign keys bind the mapping to a room and integration from the same Tenant. External room identifiers are not globally resolvable and do not authorize access to another Tenant.

Provider identifiers and response fields remain untrusted input and are bounded before persistence. SQL is fixed and parameterized. Import/sync mutations and their administrative audit evidence commit within the same PostgreSQL transaction.

The migration rollback is fail closed while mapping rows exist so a rollback cannot silently discard provider-to-room ownership evidence.

## Failure behavior

- missing or insufficient Tenant Admin permission -> authorization failure;
- absent/degraded connection without verified Places permission -> conflict;
- selected room not present in the authenticated Tenant's discovery result -> conflict;
- unknown local site -> validation failure;
- duplicate provider mapping/address race -> conflict;
- provider/discovery outage -> unavailable/conflict mapping inherited from the discovery boundary;
- database or audit failure -> no successful import/sync response.

No provider token, raw Graph payload, provider Tenant ID or secret is returned by this capability.

## Test evidence required

Automated verification covers HTTP method/query/body/CSRF contracts, explicit-selection behavior, duplicate import/idempotency, provider rename/removal, preservation of local metadata and existing Request references, migration rollback protection and cross-Tenant mapping isolation. Repository quality, dependency, secret and PostgreSQL integration gates remain mandatory.

Real provider behavior still depends on the external Pilot Microsoft 365 acceptance environment and must not be claimed from repository tests alone.
