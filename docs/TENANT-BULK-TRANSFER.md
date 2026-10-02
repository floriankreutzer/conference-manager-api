# Tenant bulk import and export

Tenant bulk transfer extends the existing Locations, Catalogue and Cost Allocation aggregates. It
does not create a generic settings service, cross-aggregate mutation or alternate source of truth.
Authorization follows the owning aggregate instead of granting a generic bulk-transfer role:
Catalogue operations require Conference Manager plus `tenant:catalogue:manage`; Cost Allocation
remains Tenant Admin plus `tenant:configure`; Locations can be read by either owning role, while an
apply is re-authorized against the actual technical and/or Room-business fields changed and therefore
requires `tenant:configure`, `tenant:rooms:business:manage`, or both. Tenant and actor scope always
come from the server session and unsafe requests use the existing CSRF guard.

## JSON contract

Every template, export and import document has the exact shape:

```json
{"schemaVersion":1,"type":"sites","rows":[]}
```

The only types are `sites`, `rooms`, `services`, `equipment`, `catering-items`, `catering-packages` and
`cost-centers`. A request is limited to 65,536 bytes and 1,024 rows. Validation returns at most 100
presentation-safe errors. Provider identifiers, Tenant identifiers, mailbox and Graph state,
tokens, room mappings, Organization and Booking Policy fields, Users, equipment, allocation policy,
managed assets and room prices are outside this contract.

Imports use patch semantics inside one owned collection. Rows omitted from the document and every
excluded collection are preserved. A Room row may update only an existing Room in the same Tenant;
provider room creation and provider identity changes remain owned by Microsoft 365 room import.
Existing archive-only transition rules remain authoritative.

## Routes

Each aggregate owns the four operations below its existing route family:

```text
GET  /api/v1/tenant/settings/{aggregate}/bulk/{type}/template
GET  /api/v1/tenant/settings/{aggregate}/bulk/{type}/export
POST /api/v1/tenant/settings/{aggregate}/bulk/{type}/validate
POST /api/v1/tenant/settings/{aggregate}/bulk/{type}/apply
```

`export` binds the document to the current stable aggregate revision. `validate` performs the same
domain and transition validation used by normal settings writes. A changed valid document receives
a cryptographically random receipt that expires after 30 minutes and is bound to Tenant, actor,
aggregate, type, source revision and the SHA-256 hash of the exact normalized document. No-change
validation creates no receipt, revision or audit event.

`apply` requires that receipt and the same document. A stale aggregate revision returns the common
settings conflict. A successful apply advances exactly one aggregate revision and produces the
normal settings audit event. Replaying an applied receipt returns its recorded response without a
second mutation or audit event. The owning application service re-applies its normal authorization
rules before persistence, so validation receipts never bypass a later role or field-level permission
check.

## Persistence and rollback

Migration 028 adds only the bounded receipt ledger. It contains no settings payload, provider state
or secret. Pending receipts expire; applied responses are bounded. Migration rollback fails closed
after any receipt exists because removing replay evidence could make a previously accepted apply
unsafe to retry. Remove expired, unused receipts through a reviewed forward operation; never bypass
the rollback guard in production.

## Verification

Internal validation covers exact schemas, size and row bounds, unsupported types, excluded-field
preservation, no-change behavior, actor and Tenant binding, expiry, stale revisions, replay,
authorization denial, CSRF, cross-Tenant isolation, migration rollback and Demo reset parity.
