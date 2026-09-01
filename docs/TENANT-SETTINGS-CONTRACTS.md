# Tenant Settings Versioning Contract

## Authority and purpose

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/AUTHORIZATION.md`, `docs/AUDIT.md`, `docs/PERSISTENCE.md` and `docs/SECURITY.md` remain authoritative.

SaaS 2 replaces the legacy tendency to grow `/api/v1/application/configuration` into one mutable document. Mutable Tenant configuration is split into independently owned aggregates. SaaS 3.6 assigns business configuration to Conference Manager and technical/administrative configuration to Tenant Admin without role inheritance. This document defines only the stable cross-aggregate version, concurrency, compatibility and history rules. It does not create a generic settings service, settings repository, settings table or cross-domain mutation API.

## Aggregate ownership

| Aggregate | Owning issue | Permission | HTTP boundary | Application owner | Persistence owner | Revision authority |
| --- | --- | --- | --- | --- | --- | --- |
| Organization | #81 | Tenant Admin + `tenant:configure`; recognized Tenant role for minimized presentation | bounded organization and presentation route modules | organization settings and presentation services | organization repository | `tenants.organization_revision` |
| Locations and rooms | #82 | Tenant Admin + `tenant:configure` for Sites/technical Room assignment; Conference Manager + `tenant:rooms:business:manage` for Room business fields; both for a mixed diff | bounded locations route module | locations settings service | locations repository | `tenants.locations_revision` |
| Service and catering catalogue | #83 | Conference Manager + `tenant:catalogue:manage`; Tenant Admin alone denied | bounded catalogue route module | catalogue settings service | catalogue repository | `tenants.catalog_revision` |
| Booking policies | #84 | Tenant Admin + `tenant:configure` | bounded booking-policy route module | booking-policy settings service | booking-policy repository | `tenants.booking_policies_revision` |
| Cost allocation | #85 | Tenant Admin + `tenant:configure` | bounded cost-allocation route module | cost-allocation settings service | cost-allocation repository | `tenants.cost_allocation_revision` |

An owning module may use the shared primitive in `src/application/tenant-settings-revision.js`. It must not import another aggregate's private service or repository. The shared primitive validates schema/revision syntax and stale-write semantics only; it has no persistence or business fields.

## Public schema and revision envelope

Every mutable aggregate exposes an explicit domain payload and the same outer version semantics:

```json
{
  "schemaVersion": 1,
  "revision": 7,
  "<domain>": {}
}
```

A mutation submits the exact domain schema plus:

```json
{
  "schemaVersion": 1,
  "expectedRevision": 7,
  "<domain>": {}
}
```

Rules:

- `schemaVersion` is exactly integer `1` for this compatibility window. Unknown, missing, string or future values fail closed with `400 VALIDATION_FAILED`.
- `revision` and `expectedRevision` are positive safe integers. The browser cannot choose the resulting revision.
- The server locks/revalidates the owning aggregate's current revision inside the authoritative transaction.
- A matching mutation advances exactly that aggregate revision by one after all domain validation succeeds.
- Another aggregate's revision is not changed as a side effect.
- A stale mutation performs no partial domain write and appends no false success audit event.
- A stale mutation returns `409 TENANT_SETTINGS_REVISION_CONFLICT` and the current safe numeric `currentRevision`. No current configuration data is echoed by the generic conflict mechanism; the client reloads the owning domain through its authorized GET route.
- Revision values are concurrency tokens, not timestamps, authorization evidence or ordering authority across different aggregates.

HTTP modules remain transport-only. They validate bounded shape/query/method constraints, require the existing server session and CSRF for unsafe cookie-authenticated operations, derive Tenant and actor from the Principal, and delegate to the owning application service. The Locations owner compares the proposed document with the persisted current snapshot and derives technical, Room-business or mixed permission requirements itself; a browser cannot label a diff to choose weaker authority.

## Atomic persistence and audit

A successful settings mutation is one PostgreSQL transaction containing:

1. Principal-derived Tenant-scoped aggregate lookup/lock;
2. expected/current revision comparison;
3. domain validation and reference-protection checks based on server state;
4. the authoritative domain mutation;
5. increment of only the owning aggregate revision;
6. append of the required server-generated audit event with correlation ID and bounded previous/new summary;
7. commit.

An audit append failure rolls the domain mutation and revision increment back. A conflict or validation failure does not create success evidence.

The audit summary must describe business-relevant change facts without credentials, provider payloads, raw personal data or a complete mutable document. Tenant, actor, time and correlation ID remain server-derived.

## Delete, deactivate and archive rules

Mutable master data used by Requests, provider mappings, audit evidence or immutable snapshots is not physically removed through Tenant administration APIs while referenced.

Each owner must classify its entities before mutation:

- unreferenced draft/test data may be removed only where the owning issue explicitly permits it;
- referenced or historically relevant data is deactivated/archived with stable IDs preserved;
- provider-owned identifiers remain provider-owned and are never rewritten through local settings fields;
- cross-Tenant identifiers are resolved with the authenticated internal Tenant ID and otherwise appear unavailable.

The owning repository performs reference checks inside the same transaction as the mutation. Browser claims such as `referenced=false` are not authoritative inputs.

## Effective dates and immutable history

Domains whose later changes could reinterpret historical business records must use effective-date or immutable-snapshot semantics in their owning issue:

- catalogue prices/currency and selected service/catering facts are snapshotted onto the Request/booking contract before confirmation;
- cost-allocation values required for historical interpretation are snapshotted;
- booking policy changes apply according to an explicit effective rule and do not retroactively invalidate completed historical Requests;
- Site/room and provider mapping identities retain stable references needed by active/historical Requests.

A revision identifies a configuration state for optimistic concurrency; it is not a substitute for a historical snapshot.

Request composition v2 requires the client-observed revision of all five aggregates, then locks and
revalidates the current values while resolving Room/Catalogue/policy/allocation authority. It
persists the selected facts, not only revision numbers, in the immutable Request snapshot. This
integration consumes each owner's public domain contract and does not introduce cross-owner writes
or a generic settings repository. See `docs/REQUEST-COMPOSITION.md`.

## Existing Site/time-zone migration

Migration 020 adds `locations_revision = 1` without rewriting `sites` or `rooms`. Existing `sites.time_zone` values from migration 018 remain unchanged, including explicit `NULL` for legacy Sites whose authoritative IANA time zone is unknown. No UTC/browser-local/default value is fabricated.

Issue #82 moves Site/room administration to the bounded locations contract using this revision. The compatibility `/api/v1/application/configuration` route remains read-only during the coordinated frontend/backend migration window and must not acquire new SaaS 2 domains.

## Demo contract

The Shared Demo Runtime exercises the canonical backend aggregate services and PostgreSQL adapters
through the dedicated customer Demo process. It does not provide in-memory or browser-owned
aggregate authority. Demo reset restores the source-defined deterministic fixtures and their
documented revisions in the one shared Demo PostgreSQL database.

Demo control routes and the deterministic provider are selected only by the explicit Demo
composition roots. Production must never import or fall back to Demo identity, state or provider
behavior when a backend/domain adapter is absent, unavailable, malformed or version-incompatible.
See `docs/SHARED-DEMO-RUNTIME.md`.

## Compatibility and rollout

Backend changes are additive first. A supported frontend accepts only the explicitly implemented `schemaVersion`; unknown versions fail closed and show a reload/update-required state rather than guessing at fields.

During a coordinated migration window, the old Site-only application configuration read and the new locations endpoint may both exist. They share the same authoritative Site data. All Site writes use the versioned Locations contract; the legacy `PUT` returns `405 METHOD_NOT_ALLOWED` so it cannot bypass optimistic concurrency.

Database rollback from migration 020 is allowed only while all five aggregate revisions remain `1`. Once any versioned settings mutation has advanced a revision, the down migration fails closed because removing the concurrency state would permit silent stale overwrites after rollback. A reviewed forward fix or compatible application rollback is then required.

## Required evidence for each owning issue

Each aggregate implementation must add progression and regression coverage for:

- the owning role(s), exact permission intersection and CSRF requirement, including dual-role authorization for mixed Locations diffs and Tenant Admin-only denial for Catalogue;
- cross-Tenant/object-ID concealment or rejection;
- positive exact schemas and payload bounds;
- current-revision success and stale-revision `409` with no partial write;
- concurrent writers against real PostgreSQL;
- audit-atomic success and audit-failure rollback;
- reference-protected deactivate/archive behavior;
- effective-date/snapshot behavior where applicable;
- unsupported schema/revision values;
- Demo parity, deterministic reset and no Production fallback;
- architecture gates preventing generic settings services/repositories/routes and cross-domain private imports.
