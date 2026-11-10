# Site Guest Information

Original delivery scope: `conference-manager#185` / `conference-manager-api#70`.
Guest Information belongs to the existing Locations aggregate. It is Site-owned current configuration
for the bounded authenticated presentation, not a historical booking snapshot, anonymous access link
or secret-distribution channel.

## Status and current contract

This document owns the retained Site `guestInformation` configuration introduced in schema `2`.
Current editors and Guest views use schema `3`, whose structured Site/Room `guestPublicValues`
are documented in [Structured public Guest values](STRUCTURED-GUEST-VALUES.md). Schema `3`
retains `guestInformation` for compatibility and separate address/contact/route/Wi-Fi-policy
presentation; stored legacy prose and Wi-Fi network names are not published in Guest responses.
The original schema-42 rollout below is historical, not a current deployment claim.

## Versioned configuration and compatibility

`GET /api/v1/tenant/settings/locations?schemaVersion=2` returns the existing Locations envelope with
`schemaVersion: 2`. Each Site adds exactly `guestInformation`, either `null` or the complete object
below. `GET /api/v1/tenant/settings/locations/history/{revision}?schemaVersion=2` selects the same
explicit projection for an immutable revision. The unparameterized reads remain exact v1.
Unknown, duplicated or additional query parameters are rejected.

`PUT /api/v1/tenant/settings/locations` accepts the existing exact envelope with `schemaVersion: 2`,
`expectedRevision` and complete `configuration`. Every Site must contain `guestInformation`.
`POST /api/v1/tenant/settings/locations/rollback` accepts exactly `schemaVersion: 2`,
`expectedRevision` and `sourceRevision`. Explicit v2 or v3 mutations can replace or clear the
Guest Information value. Existing v1 writes, rollback and bulk operations preserve it without
exposing it. Selecting a legacy revision through v2 returns honest `null` guest configuration.

Schema `3` is selected with `?schemaVersion=3` on current/revision reads and `schemaVersion: 3`
on writes/rollback. It adds nullable `guestPublicValues` to each Site and Room without converting
the legacy values. Schema `1` and `2` writes/rollback preserve structured public values. The
unparameterized read remains v1; unsupported or duplicate version selectors fail closed.

The Site field belongs to Tenant Admin and requires `tenant:configure`. Locked field classification
continues to require Conference Manager authority for Room business changes; a mixed mutation
requires both permissions. Revision conflicts, denied changes and failed required audit writes
commit no configuration or new revision.

## Exact retained Guest Information object

All keys are required; nullable fields use JSON `null`, never omission or an empty string.

| Key | Shape / bound |
| --- | --- |
| `address` | `null` or exactly `{line1, line2, postalCode, city, countryCode}`; line1 160, nullable line2 160, postalCode 32, city 120, uppercase ISO-shaped countryCode 2 |
| `publicTransport`, `arrival`, `parking`, `reception`, `building`, `accessibility` | Nullable plain text, maximum 600 characters each |
| `visitorNotes` | Nullable plain text, maximum 1,200 characters |
| `wifiPolicy` | Exactly `open`, `credentials_on_arrival`, `contact_organizer`, or `not_available` |
| `wifiNetworkName` | Nullable plain text, maximum 64; must be null for `not_available` |
| `contact` | `null` or exactly `{name, email, phone}`; name 160, nullable public email 254, nullable public phone 64 |
| `routeUrl` | Nullable validated public HTTPS route, maximum 2,048 |

The independent domain validator rejects unexpected keys, nested authority/credential fields,
every Unicode control/format/surrogate character and line/paragraph separator, unsafe markup and
embedded URIs in prose.
Its credential-disclosure scan normalizes compatibility forms and combining marks, folds a bounded
set of common cross-script lookalikes and ASCII leetspeak, and accepts separators between label
characters before matching English/German password/passcode, PIN, PSK, voucher, access/door-code,
Wi-Fi/WLAN code/key/secret, API/private/access-key and authentication/token labels. Candidate-bounded
fuzzy matching treats a remaining Latin-script letter as one unknown label character; a remaining
other-script character is considered only in a label candidate that retains at least two exact or
mapped ASCII label letters. It does not apply a blanket mixed-script ban to public prose or routes.

Labels fail closed at a normal boundary, before a numeric or lower-to-upper CamelCase value suffix,
and after a numeric prefix. More specific compact labels of at least six letters also reject any
directly glued letter suffix. The completed word `passwordless` is the narrow exception; short,
ambiguous labels keep ordinary navigation such as `Pine Street`, `Pink parking area` and `Pinneberg`
valid. Natural disclosures such as `Door code 1234`, `Passwort lautet ...` or `Wi-Fi password ...`
therefore fail closed even without `:` or `=`. Public multilingual wayfinding, `Door 4`, and
non-credential network names such as `Conference Guest Wi-Fi` remain valid. This bounded screen is
not a claim that arbitrary unlabeled secret values can be inferred; credentials must never be entered
in these public fields. A configured empty object with all nullable fields null and
`wifiPolicy: not_available` remains configured. Malformed persisted values fail closed; they are not
silently converted to missing configuration.

`routeUrl` permits only the fixed public origins `https://www.google.com` (a `/maps` path),
`https://maps.google.com`, `https://www.openstreetmap.org` and `https://maps.apple.com`.
Userinfo, explicit ports, queries, fragments, unsafe encoding and unsafe paths are rejected. The
server performs no fetch, preview, redirect, remote QR generation or image generation. The source
architecture gate permits URLs in this validator only while forbidding imports and network calls.

The schema contains no password, passphrase, PSK, voucher, PIN, access code, token, provider subject,
internal User/Tenant authority, permissions, price or remote image field. Public contact values are
explicit Site configuration, never a projection of a private User profile. Free prose still requires
appropriate administrative content: schema checks cannot identify every secret disguised as prose.

## Confirmed Request projections

`GET /api/v1/requests/{requestId}/room-context?projection=guest` returns the exact existing envelope
with `schemaVersion: 2` for a legacy Guest client. `currentRoomContext` contains exactly
`locationsRevision`, `room`, `site` and `guestPresentation`. `guestPresentation` is `null` or has the
complete object shape above, with the seven legacy prose fields and `wifiNetworkName` forced to `null` after
validation. Address, contact, route and the fixed Wi-Fi policy remain separately governed public
inputs. `room` adds `floor: null`, `accessibility: []`, `floorplanAssetId` and `mediaAssetIds` to
the existing v1 Room shape. `site` retains exactly `id`, `name`, `active` and `timeZone`.

The current client explicitly requests
`GET /api/v1/requests/{requestId}/room-context?projection=guest&schemaVersion=3`.
That exact schema `3` envelope adds nullable Site `currentRoomContext.guestPublicValues` and
Room `currentRoomContext.room.guestPublicValues`. New Guest UI and detached print use these
structured values for arrival, parking, public transport, floor and accessibility. They do not
republish stored legacy prose. See [Structured public Guest values](STRUCTURED-GUEST-VALUES.md).

Legacy Guest v2 still validates stored Room `floor` and `accessibility` with the Unicode,
embedded-URI and credential-label screen before withholding them; invalid legacy Room text
therefore fails that read. Guest v3 withholds those fields without applying that legacy Room-text
screen. Managed asset fields remain validated opaque IDs in both versions. Authorized Locations
reads/history can retain legacy Room text for correction, while new writes use the stricter input
validator. No new write or authorization authority is introduced.

Room and Site `name` are unchanged fields from the normal schema-v1 room context and from the broader
Tenant catalogue/provider-import contract; this additive Guest contract does not reclassify or selectively
filter them. Administrators must continue to keep those public display names free of secret material.

The service authorizes the Tenant-scoped Request before reading Guest Information. An Employee
can read an owned confirmed Request; a Conference Manager can read a confirmed Request within the
existing same-Tenant management scope. Tenant Admin configuration authority grants no other-user
Request access. Missing, cross-Tenant and same-Tenant non-owned Requests remain concealed as 404.
Authorized non-confirmed Requests return `409 REQUEST_STATE_CONFLICT` with no guest data.

The final parameterized SQL query rebinds Principal Tenant, Request ID, expected Request version
and `Confirmed` state. It obtains Room/Site through Tenant-composite joins from the persisted Request
and returns no data if state/version changed. Retained inactive Room/Site context remains readable.
GET bodies and unknown, duplicate or additional query parameters are rejected. Without the query,
room-context remains exact schema v1 and its prior authorized non-confirmed behavior is unchanged.
The server owns the allowed bindings: `projection=guest` alone selects v2, while adding exactly
`schemaVersion=3` selects v3. Arbitrary versions, a version without `projection=guest`, duplicated
selectors and additional parameters are rejected.

## Persistence and rollout

Migration `037_site_guest_information` follows canonical migrations 035 and 036. It adds nullable
object-or-null JSONB `sites.guest_information` independently of legacy Site `details`, and nullable
object-or-null `tenant_location_revisions.guest_information` for the revision's Site-ID map.
Existing Site rows and historical revisions stay null; no data is inferred or backfilled. Existing
immutable revision triggers protect both configuration and the guest map. All Locations writers,
including provider import, capture the current map when creating a new canonical revision.

Down obtains exclusive locks and refuses before mutation if any Site is populated or any revision
retains a nonempty map. Clearing the current Site does not permit deleting historical evidence.
After use, roll back to a compatible binary or apply a reviewed forward fix.

The original v2 rollout required the combined schema-42 API in both Customer and Platform Demo
before consumers requested that projection. Current schema `3` additionally requires migration
040 and a compatible immutable frontend/API pairing; the complete current migration/readiness
contract remains authoritative. Demo seed includes distinct synthetic Berlin/Paris guest data; semantic readback includes
the complete value, so drift changes the reset checksum. Production has no Demo/browser fallback.
Logs, metrics and audit-chain payloads contain neither accepted nor rejected guest
text/contact/network/route values nor response bodies. Audit retains existing revision and
operation metadata only.

## Evidence

Domain, service, HTTP and Demo fixture tests cover exact schemas, role/ownership negatives, v1
preservation, version/state conflicts, body/query rejection, allowlisted response-version binding,
credential-label obfuscation, Unicode unsafe-character rejection, Room-detail ingestion and legacy-output
fail-closed behavior, log redaction and presentation minimization.
`tests-db/site-guest-information-persistence.test.js` covers real SQL Tenant joins, v1 write/rollback
preservation, v2 clear/restore, immutable snapshots, stale writes and audit-failure rollback.
`tests-db/site-guest-information-migration.test.js` covers null migration, constraints, guarded
down/up, preserved history and concurrent rollback guards. PostgreSQL 18 CI and the full existing
quality/audit/security/browser gates are required before release; local unit tests alone are not
deployment or database proof.

Schema `3` migration, preservation, editor, Guest and print evidence and named product/security
acceptance remain governed by [Structured public Guest values](STRUCTURED-GUEST-VALUES.md).
The residual content risks of Site address/contact/route and Site/Room names are not resolved by
retaining v2 compatibility or by passing repository CI.
