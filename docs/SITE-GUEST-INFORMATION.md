# Site Guest Information

Canonical scope: `conference-manager#185` / `conference-manager-api#70`.
Guest Information belongs to the existing Locations aggregate. It is current approved presentation,
not a historical booking snapshot, anonymous access link or secret-distribution channel.

## Versioned configuration

`GET /api/v1/tenant/settings/locations?schemaVersion=2` returns the existing Locations envelope with
`schemaVersion: 2`. Each Site adds exactly `guestInformation`, either `null` or the complete object
below. `GET /api/v1/tenant/settings/locations/history/{revision}?schemaVersion=2` selects the same
explicit projection for an immutable revision. The unparameterized reads remain exact v1.
Unknown, duplicated or additional query parameters are rejected.

`PUT /api/v1/tenant/settings/locations` accepts the existing exact envelope with `schemaVersion: 2`,
`expectedRevision` and complete `configuration`. Every Site must contain `guestInformation`.
`POST /api/v1/tenant/settings/locations/rollback` accepts exactly `schemaVersion: 2`,
`expectedRevision` and `sourceRevision`. Only those explicit v2 mutations can replace or clear the
Guest Information value. Existing v1 writes, rollback and bulk operations preserve it without
exposing it. Selecting a legacy revision through v2 returns honest `null` guest configuration.

The Site field belongs to Tenant Admin and requires `tenant:configure`. Locked field classification
continues to require Conference Manager authority for Room business changes; a mixed mutation
requires both permissions. Revision conflicts, denied changes and failed required audit writes
commit no configuration or new revision.

## Exact object

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

## Confirmed Request projection

`GET /api/v1/requests/{requestId}/room-context?projection=guest` returns the exact existing envelope
with `schemaVersion: 2`. `currentRoomContext` contains exactly `locationsRevision`, `room`, `site`
and `guestPresentation`. `guestPresentation` is the complete Site object above or `null`. `room`
adds `floor`, `accessibility`, `floorplanAssetId` and `mediaAssetIds` to the existing v1 Room shape.
`site` retains exactly `id`, `name`, `active` and `timeZone`. The newly exposed Room `floor` and
`accessibility` values use the same Unicode, embedded-URI and credential-label scanner as Site Guest
Information at both Locations ingestion and final Guest projection. The narrower Room predicate still
permits conventional labels such as `1. OG`, `B[1]` and public wayfinding; it rejects angle-bracket
markup but does not apply the Site prose Markdown rule. Malformed current or historical persisted Room
details fail the complete read/rollback rather than being removed, replaced with `null` or partially
projected. Managed asset fields remain opaque IDs only. No new write or authorization authority is introduced.

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
The server owns this binding: callers cannot supply a schema version, and `projection=guest` can
produce only the exact v2 envelope.

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

Deploy the combined schema-38 API to both Customer and Platform Demo before consumers request this
projection. Demo seed includes distinct synthetic Berlin/Paris guest data; semantic readback includes
the complete value, so drift changes the reset checksum. Production has no Demo/browser fallback.
Logs, metrics and audit-chain payloads contain neither accepted nor rejected guest
text/contact/network/route values nor response bodies. Audit retains existing revision and
operation metadata only.

## Evidence

Domain, service, HTTP and Demo fixture tests cover exact schemas, role/ownership negatives, v1
preservation, version/state conflicts, body/query rejection, fixed server response-version binding,
credential-label obfuscation, Unicode unsafe-character rejection, Room-detail ingestion and legacy-output
fail-closed behavior, log redaction and presentation minimization.
`tests-db/site-guest-information-persistence.test.js` covers real SQL Tenant joins, v1 write/rollback
preservation, v2 clear/restore, immutable snapshots, stale writes and audit-failure rollback.
`tests-db/site-guest-information-migration.test.js` covers null migration, constraints, guarded
down/up, preserved history and concurrent rollback guards. PostgreSQL 18 CI and the full existing
quality/audit/security/browser gates are required before release; local unit tests alone are not
deployment or database proof.
