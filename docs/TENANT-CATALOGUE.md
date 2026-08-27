# Tenant service, equipment and catering catalogue

## Authority and boundary

This bounded domain implements roadmap issue #83 and the Room-price extension required by issue
#126. It owns Tenant Room prices, services, equipment, catering packages, package variants,
individual catering items, applicability and authoritative prices. It does not introduce a catering
provider or external ordering API.

The Principal-derived Tenant is the only ownership authority. Administration requires a recognized
Tenant Admin with `tenant:configure`; writes require session-bound CSRF. The server never accepts a
Tenant, actor, audit outcome or calculated total from the browser.

## HTTP contract

- `GET /api/v1/tenant/settings/catalogue` returns the current aggregate.
- `PUT /api/v1/tenant/settings/catalogue` replaces its bounded representation at an expected
  revision.
- `GET /api/v1/tenant/settings/catalogue/history?limit=25&beforeRevision=8` returns immutable
  historical snapshots newest first.

The current response is:

```json
{
  "schemaVersion": 1,
  "revision": 7,
  "catalogue": {
    "services": [],
    "equipment": [],
    "cateringPackages": [],
    "cateringItems": [],
    "roomPrices": []
  }
}
```

The mutation replaces `revision` with `expectedRevision`. A service, equipment or catering-item
entry has this exact shape:

```json
{
  "id": "video-support",
  "name": "Video support",
  "description": null,
  "price": { "amountMinor": 2500, "currency": "EUR" },
  "active": true,
  "order": 10,
  "siteIds": [],
  "roomIds": []
}
```

An empty applicability list means all resources within the Tenant. Non-empty lists are verified
against same-Tenant Sites and rooms in the mutation transaction. A catering package adds `itemIds`
and `variants`. Variants have exact `id`, `name`, nullable `description`, `price`, `active` and
`order` fields.

IDs are stable Tenant-local identifiers. Existing master entities and package variants cannot be
omitted from an update. They are retained and set `active: false`; this preserves references and
historical interpretation. Active packages cannot reference missing or inactive items. Destructive
Tenant Admin deletion is not exposed.

Each Room-price entry has the exact shape
`{ "roomId": "room-berlin-1", "price": { "amountMinor": 10000, "currency": "EUR" } }`.
Room IDs are resolved through the Principal-derived Tenant inside the mutation transaction. A
missing or cross-Tenant Room is rejected. The current response always includes Room prices in stable
Room-ID order so an administrator can preserve the complete bounded aggregate. Once established, a
Room-price entry cannot be omitted from a replacement mutation; the Tenant Admin may replace its
bounded money value while immutable Request and Catalogue history retain earlier facts.

## Prices and immutable Request snapshots

Prices are non-negative integer minor units capped at `1,000,000,000`; floating-point, non-finite,
negative and excessive values are rejected. Each price carries an explicit supported currency:
`CHF`, `EUR`, `GBP` or `USD`. The browser may format these values but is never total authority.

`snapshotForRequest` is an internal application port, not an HTTP endpoint. It accepts only selected
stable IDs plus a trusted Tenant/Site/room scope, reloads the authoritative current catalogue, and
returns immutable copies of selected identities, names, descriptions and price/currency with the
catalogue revision and server capture time. It rejects inactive, absent, cross-Tenant or inapplicable
entries. Request composition v2 persists that snapshot together with the authoritative Room price
so later Catalogue changes cannot rewrite historical business meaning. Equipment remains outside
the v2 Request selection schema.

## Persistence, concurrency and audit

Migration 023 extends the existing `services`, `catering_packages` and `catering_items` authorities,
adds equipment, variants and Tenant-aware applicability/reference tables, and seeds revision 1
history. It does not create a parallel generic catalogue document store.

Migration 027 adds Tenant/Room-composite Room prices. Existing Rooms receive zero in the
Organization default currency, an immutable Catalogue snapshot with `roomPrices` is appended and
each existing Tenant's Catalogue revision advances once. This compatibility seed is not a customer
price decision; pre-migration editors must reload before their next optimistic mutation.

A successful mutation is one transaction: lock `tenants.catalog_revision`, compare the expected
revision, validate same-Tenant references and archive protection, persist entries and relations,
advance only the catalogue revision, append the immutable snapshot, append the server-generated
audit event, and commit. Stale writes perform no mutation or success audit. Audit failure rolls back
all entry, relation, revision and history changes.

History tables reject update/delete. Migration rollback locks the owning tables and refuses after a
revision advance or introduction of new catalogue data.

## Integration requirements

The central composition root injects the PostgreSQL repository and audit service, registers
`tenantCatalogueRouteModule`, and includes both route keys in the logging/metrics registries.
Global schema readiness is version 27 and the central architecture/API/persistence documents include
this bounded owner and its Request composition integration.
