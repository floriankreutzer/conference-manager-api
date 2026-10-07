# Private media object storage — SaaS 3.8

## Approved destination and current implementation

The owner approved private Neon Object Storage in the existing Frankfurt Demo project,
including usage-based storage and transfer costs, on 7 October 2026. This approval does
not authorize unrelated plan upgrades or paid runner capacity.

The `conference-manager-media` bucket was created on the existing production branch
at 18:54 UTC on that date and independently reread with `access_level: private`.
No scoped service credentials were issued for this foundation change.

`src/media/object-storage-contract.js` defines a provider-neutral, URL-free media port.
`src/media/neon-object-storage.js` implements `put(reference, bytes)`, `get(reference)`,
`remove(reference)` and `close()`. It is not yet wired into the running application.
PostgreSQL remains the only active media store until the separately reviewed migration,
backfill, rollback and three-customer/reset acceptance have completed.

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

1. Add reviewed metadata/lifecycle schema and least-privilege Demo grants without changing
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
