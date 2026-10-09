# Private media object storage — SaaS 3.8

## Approved destination and current implementation

The owner approved private Neon Object Storage in the existing Frankfurt Demo project,
including usage-based storage and transfer costs, on 7 October 2026. This approval does
not authorize unrelated plan upgrades or paid runner capacity.

The `conference-manager-media` bucket was created on the existing production branch
at 18:54 UTC on that date and independently reread with `access_level: private`.
No application-scoped service credentials were explicitly issued for this foundation change.
The provider also generated its default branch storage/AI credentials when the bucket was
created; their secret values were not retrieved and they were not changed. Operational
credential inventory must account for these defaults separately from scoped application keys.

`src/media/object-storage-contract.js` defines a provider-neutral, URL-free media port.
`src/media/neon-object-storage.js` implements `put(reference, bytes)`, `get(reference)`,
`remove(reference)` and `close()`. It is not yet activated in a runtime entrypoint.
PostgreSQL remains the only active media store until the separately reviewed migration,
backfill, rollback and three-customer/reset acceptance have completed.

The Customer PostgreSQL factory accepts an explicitly injected provider-neutral storage port.
Room and Demo Catalogue repositories register durable intents after owner/actor preflight and
before entering their metadata transaction. They repeat ownership, conflict and quota checks
under the existing authoritative locks, upload and read back the object under the inventory
lock, then publish its key/length/digest and append required audit evidence atomically. In this
injected object mode newly published metadata carries no PostgreSQL blob. Provider or audit
failure rolls back publication while leaving committed inventory custody for cleanup.

Reads apply existing same-Tenant owner, Room attachment and active-room predicates before
provider access. Object mode rejects unbackfilled PostgreSQL-only rows and never falls back
to database bytes after an object failure. Disabled object mode fails closed on external rows.
Catalogue replacement derives a new content-addressed key; deletion removes only authorized
metadata and retains durable object custody. These repository seams remain inactive in all
entrypoints until operator backfill, seed/reset and coordinated restore acceptance exist.

The port requires an internal Tenant ID, internal asset ID, kind (`room` or `catalogue`),
canonical MIME, byte length and lowercase SHA-256 digest from authoritative metadata.
Keys are derived inside the port as `v1/<tenant>/<kind>/<asset>/<digest>`; callers cannot
select a URL or arbitrary key. Different revisions are immutable distinct objects.
The port does not authorize access: the existing application permission and tenant-scoped
repository ownership/attachment checks must run before every storage call.

## Provider boundary

Only a configured Frankfurt Neon branch endpoint of the form
`https://br-….storage.c-5.eu-central-1.aws.neon.tech` is accepted. Bucket and credential
formats are validated. The bucket must be provisioned as private and verified through the
provider control plane before activation. No browser credentials, public bucket, redirects,
presigned browser URLs, SDK payloads or provider errors enter the API contract.

The exact-pinned AWS S3 client uses SigV4, path-style addressing and one attempt. Its Node
HTTP handler does not follow redirects. A one-second connection deadline and five-second
whole-operation deadline include body streaming. Eight in-flight operations and eight
sockets bound concurrency; excess work fails without a waiting queue. Reads enforce exact
MIME and length before streaming, cap accumulated bytes at the expected length (at most
2 MiB), and verify SHA-256 before returning any bytes. Failures expose only stable missing,
integrity or unavailable codes, without SDK causes, credentials or provider messages.

The application must still decode/reencode uploads through the existing image processor.
The storage port verifies digest/length; it is not a replacement image sanitizer.

## Demo seed and reset port

The Demo Platform composition may explicitly receive a reset-only provider-neutral storage port.
Only its distinct reset-role pool registers/publishes objects; ordinary Platform persistence
retains no media inventory/provider authority. Runtime entrypoints still do not activate it.

Object reset validates the canonical fixture/checksum, takes the existing exclusive reset gate
and verifies database identity, sentinel, schema inventory and any concrete live reset session.
After that preflight commits, it independently registers the bounded 34 canonical media intents
without provider I/O. Its authoritative SERIALIZABLE reset starts only after those commits are
visible and rechecks every precondition and the live authority. Revocation between preflight
and reset prevents truncation/provider publication; durable unused intents remain for retention.

Reset locks canonical inventory rows before acquiring exclusive asset-table locks, matching
cleanup's custody-before-reference order. It then performs the unchanged atomic truncate/seed/
semantic-readback sequence. Seed files retain their existing MIME signatures, lengths and
SHA-256 verification before object upload/readback. PostgreSQL stores metadata with NULL blobs
only in explicitly injected object mode. Semantic reconstruction reads and verifies the exact
provider objects and retains the canonical seed version, complete three-customer business state
and semantic checksum. Missing/corrupt objects abort the reset; no PostgreSQL fallback hides them.

Seed publication and semantic media readback process batches of at most four images.
This bounds provider concurrency below its eight-operation limit and avoids serial network
round trips for all 34 canonical images. Every started batch settles before an error is
propagated; no later batch starts after failure and rollback cannot race outstanding uploads.
The existing inventory locks, byte/digest verification, semantic checksum, audit requirements
and transaction isolation remain unchanged. No cache or verification bypass is introduced.

Inventory remains excluded from reset truncation. Provider verification, metadata, semantic
checksum or required success-audit failure rolls database state back while retaining committed
custody. The failure taxonomy adds only the bounded `media_registration_failed` phase; raw
provider/driver details do not enter reset audit evidence. Database integration tests exercise
two full external seed/reset cycles, all three canonical customers, failed verification rollback,
foreign-Tenant denial and preserved orphan custody. Real provider/hosted activation and paired
external-object browser acceptance remain separate deployment gates.

## Isolated external-object browser acceptance

The API CI matrix retains the original PostgreSQL media mode and additionally executes both
Chromium and WebKit with explicitly injected external-object ports. Every row runs the unchanged
immutable shared role/Tenant/CSRF journey and full three-customer progression with two resets.
Customer and Platform remain separate processes with the existing credential exclusions.

`scripts/demo-object-acceptance.mjs` requires `NODE_ENV=test` before activating its isolated
loopback S3 protocol fixture or compositions. Production/Demo entrypoints never import it.
The fixture uses a freshly generated masked authority, fixed loopback destination, bounded
object count/bytes, request deadlines and canonical content-addressed keys. The real pinned
S3 SDK and private adapter serialize/sign requests and verify response integrity; only their
transport is replaced for this test environment. Reset seeds object metadata with NULL database
blobs, so object reads cannot succeed through a PostgreSQL fallback. Fixture roundtrip tests
also cover foreign keys, missing objects, denied authority and invalid-byte rejection before I/O.

These checks prove external-object application integration, not Neon provider availability,
provider credential isolation, hosted deployment or coordinated real-provider restore.
Those operational gates remain separate and must pass before cutover.

## Operator backfill and rollback

`scripts/private-media-migration.mjs` accepts only `--execute copy|rollback|purge room|catalogue`.
It requires a separate `MEDIA_MIGRATION_DATABASE_URL` and exact `MEDIA_MIGRATION_DATABASE_ROLE`,
rejects the ordinary runtime identity, verifies the live maintenance privilege/role and exact schema, and verifies Demo
overlay 009 when Catalogue scope is explicitly selected. It uses separately injected operator
credentials (`MEDIA_OPERATOR_ENDPOINT`, `MEDIA_OPERATOR_REGION`, `MEDIA_OPERATOR_BUCKET`,
`MEDIA_OPERATOR_ACCESS_KEY_ID`, `MEDIA_OPERATOR_SECRET_ACCESS_KEY`). Runtime/reset roles lack
the required inventory maintenance privilege; it is checked before provider allocation or I/O.
The Frankfurt endpoint and credentials are validated before any provider client is allocated.
The command never prints credentials, connection metadata, objects or provider errors.

Each invocation processes at most ten metadata candidates with a 25-second dispatch budget;
each individual database/provider operation retains its own deadline. Metadata candidate reads
exclude blobs; each asset is locked and rechecked before loading its one bounded image. Locked
or changed candidates report incomplete work and are safely retried. There is no drain loop,
automatic migration, deployment hook or schedule. Architecture gates prohibit importing the
operator repository into application/runtime modules.

`copy` registers durable custody before its metadata transaction, verifies the retained blob,
uploads/read-verifies under the inventory lock, and adds the key while retaining PostgreSQL bytes.
`rollback` verifies the exact current provider revision, then atomically restores database bytes
and clears its pointer. Missing/corrupt objects abort without clearing references or fabricating
bytes. Replacement/reset races cannot restore an older revision over a newer row. Both phases
are idempotent and retain object inventory.

`purge` additionally requires `--restore-evidence-sha256=<64 lowercase hex characters>` binding
to the operator's retained successful coordinated restore/rollback acceptance artifact. The digest
records that explicit authority; it is not itself proof that the exercise ran. Before executing,
retain exact API/frontend commits, isolated database/object branch and private bucket, source and
restored digests/lengths, attached/historical/Catalogue reads, missing/corrupt failure checks,
foreign-Tenant denial and full three-customer/two-reset browser results. Purge re-verifies both
database and provider copies immediately before dropping bytes. Retain bounded JSON command
results and the named acceptance artifact as operator execution evidence. No real purge or
restore acceptance is claimed by the test-only evidence hashes in automated tests.

Rollback does not delete objects or retire custody. Schema downgrade remains guarded until an
explicit coordinated inventory/retention reconciliation is complete. The unchanged 30-day orphan
policy and retained backups must govern that separate operation.

## Dependency review

The official S3 SDK is pinned to `3.1147.0` in manifest, lockfile and architecture policy.
It provides maintained SigV4 signing and S3 protocol handling instead of an application-owned
cryptographic implementation. AWS/Smithy packages declare Apache-2.0 licenses and Node >=20,
compatible with the application's Node >=22 contract. Dependency policy rejects unlicensed,
denied-license or install-script packages; the installed lockfile passes vulnerability audit.
Explicit credentials disable use of the default credential chain; no SDK credentials, command
types or responses are exposed through the provider-neutral port. Replacement is limited to
this adapter, although the SDK's transitive dependencies increase supply-chain maintenance.

## Migration acceptance still required

1. Accept canonical schema 043 and Demo overlay 008 metadata/inventory foundation and its
   least-privilege grants, then wire runtime publication/read/backfill without changing
   historical migration checksums. Keep the canonical seed semantics/checksum intact.
2. Backfill bounded, idempotent batches, verify every digest and byte count, and retain
   PostgreSQL bytes until a restore/rollback exercise has succeeded.
3. Dual-write only after same-Tenant owner, quota and concurrency checks. Preserve required
   audit atomicity; failed transactions must leave no visible metadata for unpublished objects.
4. Reads first validate current authority in PostgreSQL, then read the exact immutable key.
   Do not hide missing/corrupt storage through an automatic database fallback.
5. Track deletion/replacement/reset orphans durably. The storage provider does not enforce
   S3 lifecycle or versioning configuration; current and immutable historical references must
   protect objects explicitly. Apply the existing 30-day unreferenced retention rule.
6. Prove coordinated database/object restore and rollback on an isolated same-region branch,
   including attached and historically retained images, missing/corrupt objects and foreign
   Tenant denial. Cut over and remove database blobs only after these gates pass.
7. Run the complete shared role/Tenant/CSRF journey, all three canonical customers and two
   reset cycles in Chromium and WebKit against the exact candidate commits.

Neon scoped credentials are branch-bound and apply to descendants; they are not a
bucket-scoped authorization policy. Expiration is not enforced by the provider, so rotation
and explicit revocation are required. Keep read-only runtime and write/maintenance custody
separate where possible and never emit secret material to logs or source control.

Provider contract references inspected on 7 October 2026: Neon `docs/storage/overview`,
`docs/storage/authentication` and `docs/storage/s3-compatibility`. Lifecycle/versioning and
credential limitations above must be reverified before operational cutover.

## Private image revalidation and immutable acceptance

The SaaS 3.8 conditional-image candidate uses frontend acceptance
`195d530cdc97f67512ef9b2d89831e0b1a0f27fb` in all four browser/storage rows.
That frontend binds its own isolated CI to API `87719aaea146ade797273039e03e8406dbcc3e19`,
the initial conditional-image implementation. This successor adds the already accepted
object reset/browser compositions and the matching immutable acceptance pin; image response
implementation is unchanged. Exact final paired heads and gates belong in the PR evidence.

Authorized Room and Catalogue image GETs use an opaque strong ETag, private mandatory
revalidation and Vary: Cookie. Current session, same-Tenant object/attachment authority and
verified bytes are required before every bodyless 304. JSON/session/mutation responses remain
no-store. The permanent journey now explicitly denies conditional requests without a session,
with foreign ownership, after reset revokes the session, and after reset removes the image.
Independent byte hashes, all three customers and both full reset cycles remain mandatory.
Historical old-contract failure is not relabeled. No avoided provider/database read, deployed
cache behavior, hosted/provider restore acceptance or cutover is claimed.

## Current persona-switch acceptance candidate — 9 October 2026

The current CI permanent acceptance pin is frontend
`6228a827502b2cb59c8b9c50adebb9ad6431fe8b` (draft frontend PR #284).
It preserves the complete existing customer/media/security/reset assertions and
adds pointer-actionability preflight plus a single awaited click/response/reload
operation. The two WebKit/PostgreSQL failures on API candidate
`a0bb54986c15388cebfc7958cd5d2eddb132e113` remain failed evidence; their
post-reload response timeout did not establish the underlying pointer cause.
No retries, forced clicks, deadline increase or skipped assertions are introduced.
The served frontend pin, live services, seed and checksum remain unchanged.
All four browser/storage rows must pass against this updated immutable test pin
before API PR #132 can be considered ready. This is still isolated protocol
acceptance, not real-Neon provider or hosted cutover evidence.
