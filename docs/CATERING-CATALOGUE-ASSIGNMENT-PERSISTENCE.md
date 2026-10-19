# Versioned Manager-owned Catering assignments

Tracking: `floriankreutzer/conference-manager#233`. This component stores canonical ownership; it is
not provider publication/import, availability, cost/terms, ordering, credential/health or deployed
acceptance. No existing catalogue, Integration, Employee behavior or canonical Demo seed is changed.

The current Manager use case requires active Tenant business state and tenant:catalogue:manage.
Employee, Tenant Admin alone, Platform and foreign Tenant contexts are denied. The server loads the
canonical Catalogue revision and only the proposed same-Tenant configured Catering connection
identities. Connection IDs cannot prove their own authority. Technical mode/provider validation
stays at the source registry/configuration boundary. Disabled connections cannot receive a new
assignment; older assignments remain readable as stale rather than being silently rewritten.

Assignment revisions and canonical Catalogue revisions are separate. A command carries the exact
observed values for both. Every canonical item/package, including inactive entries, is assigned
once; all package components must share that exact connection. Existing300-item/100-package limits
remain supported. The canonical normalizer is reused. An empty catalogue needs no artificial
provider. Existing legacy catalogues remain usable until the separate ordering rollout requires
current ownership. A later Catalogue edit makes older assignments stale; its historical price and
content snapshot remains unchanged. This operation does not approve provider content or costs.

## PostgreSQL47 / Demo overlay013

Four Tenant-composite tables contain the current head, immutable revision metadata, typed immutable
entry rows and a completion seal. Each revision references the canonical immutable Catalogue
revision, every entry references an existing same-Tenant Catering configuration, and the changed
actor references the same Tenant User. Entry IDs/kinds, counts and revision ranges are bounded.
Head updates advance exactly once and reference a completed seal through a deferred FK.

The deferred revision trigger checks complete canonical coverage and package/connection consistency
once, then inserts a content-free seal. The ordinary Customer role can insert revisions/entries
and read seals, but cannot insert seals, mutate history or delete/truncate these tables. The entry
trigger locks/requires the parent revision and rejects later inserts after sealing, including an
otherwise plausible extra entry. The fixed trigger functions use schema-qualified tables and
pg_catalog-only search paths. Their tightly bounded SECURITY DEFINER work only validates/seals the
inserted revision or checks its parent; PUBLIC/Customer direct execution is revoked. No arbitrary
SQL, target, URL or credential is accepted. A seal is database completion evidence, not a signature
or independent proof against a privileged database owner or whole-backup rollback.

Writes lock the active Tenant first, then the active User/security version, exact live Manager
session/role/permission, canonical Catalogue revision and referenced configurations/Integrations.
Both optimistic revisions are rechecked under locks. Revision, typed entries, head, seal and the
minimal scoped audit commit atomically. Missing/stale authority, changed Catalogue, CAS loss,
invalid package ownership, failed audit or failed deferred validation cannot become acknowledged
success. Assignment conflict may report currentRevision0 when no assignment exists; this is a
separate CATERING_ASSIGNMENT_REVISION_CONFLICT, not the positive-only legacy aggregate conflict.

A populated downgrade refuses data loss. Empty down/up is repeatable. Demo Customer receives only
scoped application custody, Platform receives none, and reset receives read/truncate on all four
tables. Reset includes populated synthetic ownership and then verifies the original canonical seed
checksum. Current readiness/operator wrappers require exact schema47/overlay13; older supported
migration entry states remain explicit and all role/target/retained-count guards remain.

## Default-off HTTP

The existing CATERING_CONFIGURATION_ENABLED=true server rollout additionally composes these Manager
routes; it remains globally OFF by default and rejects Demo activation. It starts no worker or
provider call. GET/PUT `/api/v1/tenant/catering/catalogue-assignments` reads/replaces assignments.
PUT accepts exactly schemaVersion1, expectedRevision(0 for initial assignment), catalogueRevision
and assignments. GET `/api/v1/tenant/catering/catalogue-connections` returns a20-record safe provider/
connection selector; only one optional internal UUID afterIntegrationId cursor is accepted.
It omits technical modes, initial-order settings, private references, credentials and health claims.

Both routes reuse actual Customer principal/session/CSRF and active-Tenant guards. Manager authority
and source lookup are application-owned; a path/query/body never selects the Tenant. PUT is bounded
by131072 bytes and the stricter configured MAX_BODY_BYTES ceiling; large valid catalogues may require
that existing operator setting to be raised explicitly within its unchanged bounds. Responses are
bounded at262144 bytes or the stricter runtime bound. Unsupported methods, queries, GET bodies,
unknown fields, bad JSON/content type and over-limit data fail through the existing safe API boundary.
A failed/retried write never silently updates a newer revision. No public partner endpoint is added.

## Verification scope

Native policy/service/transport cases cover full400-entry capacity, source/revision/role/Tenant
negatives, exact tuple shapes, unsafe arrays/accessors, corrupted ports, zero/terminal revisions,
CAS/audit outcomes, bounded pagination/transport and default-off404 behavior. Real PostgreSQL tests
are defined for constraints/sealing, late append denial, concurrent CAS, canonical/configuration
staleness, live session/role/security-version fences, audit rollback, full400-entry and empty cases,
role grants, populated reset and guarded rollback. The DB suite includes actual opaque-cookie
issuance/resolution, HMAC CSRF, same-origin HTTP writes, role separation, foreign Tenant denial,
conflicts and revocation over the real repositories. These definitions are not execution evidence;
PostgreSQL18 and all mandatory exact-head paired browser/reset/security gates must pass before merge.
Manager assignment UI and provider publication/availability/cost workflows remain follow-up work.
