# Tenant organization administration

## Authority and boundary

This bounded domain implements roadmap issue #81 and the Organization aggregate from
`TENANT-SETTINGS-CONTRACTS.md`. It owns organization metadata and Tenant presentation defaults. It
does not own User language preference, application translation strings, arbitrary themes, uploads,
object storage or CDN behavior.

The authenticated Principal is the only Tenant and actor authority. Aggregate administration reads
and writes require a recognized Tenant Admin with `tenant:configure`. Cookie-authenticated writes
additionally require the existing session-bound CSRF control. A separate minimized presentation
read is available to every recognized Employee, Conference Manager and Tenant Admin role; it never
grants Organization mutation authority.

## HTTP contract

- `GET /api/v1/tenant/settings/organization` returns the current aggregate.
- `PUT /api/v1/tenant/settings/organization` replaces it using optimistic concurrency.
- `GET /api/v1/tenant/settings/organization/history?limit=25&beforeRevision=8` returns immutable
  historical snapshots newest first. `limit` is 1-100 and the cursor is a positive revision.
- `GET /api/v1/tenant/presentation` returns only the current Tenant presentation needed by an
  authenticated application shell. It accepts no query or request body.

Current responses use:

```json
{
  "schemaVersion": 1,
  "revision": 7,
  "organization": {
    "displayName": "Example GmbH",
    "businessMetadata": {
      "legalName": "Example GmbH",
      "registrationNumber": "HRB 12345",
      "countryCode": "DE"
    },
    "presentation": {
      "defaultLocale": "de-DE",
      "defaultCurrency": "EUR"
    },
    "branding": {
      "logoAssetRef": null,
      "accentToken": "default"
    }
  }
}
```

The mutation replaces `revision` with `expectedRevision`. Objects are exact; unknown fields fail
closed. Text is trimmed, bounded and rejects control characters. Supported locales are `de-DE` and
`en-GB`. Supported currencies are `CHF`, `EUR`, `GBP` and `USD`. Country, when supplied, is an
uppercase two-letter machine identifier.

The all-role presentation response is deliberately smaller:

```json
{
  "schemaVersion": 1,
  "revision": 7,
  "presentation": {
    "displayName": "Example GmbH",
    "defaultLocale": "de-DE",
    "defaultCurrency": "EUR",
    "branding": {
      "logoPreset": "conference-manager-mark",
      "accentToken": "default"
    }
  }
}
```

`revision` is the Organization revision and is suitable for client cache invalidation. The response
omits internal Tenant IDs, legal/registration metadata, raw managed references and audit data.

## Constrained branding and fallback

Schema version 1 intentionally permits only the product-owned `default` accent token. The exact
`managed-brand:conference-manager-mark-v1` reference selects the code-shipped
`conference-manager-mark` logo preset. The reference maps only to a bundled design-system token;
it is not a URL, upload handle or object-store identifier. Arbitrary colors, CSS, HTML, JavaScript,
URLs and other syntactically valid managed references are not accepted.

`logoAssetRef` remains either `null` or an opaque `managed-brand:<reference>` value. Syntax alone is
not authority: composition injects a policy that requires a valid Principal-derived internal Tenant
ID and an exact code-shipped allowlist match. This slice does not implement upload, object storage,
media decoding or a CDN.

Clients use the `product-default` logo preset and default design tokens when the reference is null,
unknown, invalidated, malformed at the resolver boundary or unavailable. The read contract never
returns the raw stored reference. Clients map returned preset tokens only to bundled assets and must
not fetch arbitrary remote resources as a fallback. Canonical DE/EN application localization is
unchanged; Tenant-authored metadata never replaces translation keys.

## Persistence and audit

Migration 022 adds the bounded settings row and immutable revision history. `tenants.display_name`
remains the single display-name authority and `tenants.organization_revision` remains the
concurrency authority.

Before persistence, the application port verifies that a non-null managed reference is currently
active and belongs to the Principal-derived Tenant. The PostgreSQL transaction then locks the Tenant
row, compares the expected revision, persists the profile, advances only `organization_revision`,
appends the immutable snapshot and server-generated `tenant.configuration.changed` event, and
commits. Audit failure rolls back the profile, revision and snapshot. A reference invalidated after a
successful write is handled by the managed resolver and documented fallback; it never becomes a
remote URL. Audit state contains revisions and change flags, not organization text or asset data.

Migration rollback locks the owning tables and refuses once any Organization revision has advanced.

## Integration requirements

The central composition root injects one code-shipped managed-brand policy into both the Tenant
Admin Organization service and the minimized presentation service. It registers their bounded route
modules and logging/metrics route keys. Global schema readiness is version 33. Request composition
uses the current Organization revision and default currency as transactionally revalidated
authority; the shared preset/projection itself still adds no persistence or migration. Uploads,
customer media and arbitrary managed references remain outside this boundary.
