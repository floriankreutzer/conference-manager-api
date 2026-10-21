# Protected catalogue media reader

The protected Customer root owns a read-only catalogue image service, HTTP module
and private PostgreSQL repository. Ordinary/Demo composition is unchanged. This
adds no migration, privilege, provider destination, upload, delete or activation.

GET `/api/v1/tenant/catalogue-media` returns at most40 current metadata entries;
GET the same path plus an asset UUID returns verified private PNG/WebP bytes.
Both require normal current Customer authentication, known matching Tenant and
the existing Request read permission. Only the existing Catalogue Manager
permission includes inactive owners. Query/body/cross-site Fetch metadata and
mutating methods are rejected. No browser Tenant, provider or object key is
accepted. Unknown/cross-Tenant/detached assets remain concealed.

The root fixes deployment environment/UUID and optional full synthetic custody
scope. Reads require the actual live shared deployment lease and one joined
transaction, including max1 pools. Current registry selects the canonical REAL
invited membership or full synthetic delegated source/proof reader; no unknown
mode or source failure falls back. Positive REAL returns no synthetic assets and
never queries that table. Synthetic custody is requalified after media loading.
Full canonical checks retain generation/owner security version, source MFA,
session, role, exact operation proof and approval evidence ownership.

Metadata is scoped to the authenticated Tenant and current Room attachment or
Catalogue owner. Room plans require the exact current floorplan UUID plus the
Room and Site; Employee reads require active owners. Server paths are canonical
same-origin values. Length, MIME and SHA-256 are checked before bytes are copied
out. PG-only mode rejects object pointers even if retained database bytes exist.
Object staging/read support remains a separate operating gate; no silent fallback.
The common private image responder derives a Tenant/asset/MIME/content-bound ETag,
requires revalidation and Vary Cookie, and runs only after authority/attachment/
integrity checks, including conditional304. No public bucket or presigned URL.

Local Node22 full check2044 tests plus both HTTP DAST gates passed; six focused
positive/negative cases cover full max1 custody, missing lease, foreign scope,
unknown mode/no fallback, revoked-source recheck, REAL no synthetic reads,
metadata bounds, digest/length corruption, object-pointer refusal, permission
scope and authenticated conditional caching. The first local style check failed
on long test lines and was corrected without changing assertions.

Native acceptance extends the existing actual owned Customer TLS/SCRAM/max1
onboarding case with a fresh canonical Northwind Employee handoff. It is prepared
to verify all seeded PNG plans and WebP catering bytes/digests, ETags/private
headers, anonymous/stale-source conditional refusal, foreign/missing404,
query/method rejection, object-pointer no fallback and corrupt digest503. Local
Docker is unavailable; this new native proof and fresh full unchanged four paired
permanent three-customer/two-reset browser gates remain pending CI. Existing285
onboarding native feature proof passed separately; it does not prove these new
image assertions. No actual browser/two-site RP/physical key/live mail/cloud query
or deployed provider/credential/UUID/artifact cutover is claimed. SaaS1 issue351.
