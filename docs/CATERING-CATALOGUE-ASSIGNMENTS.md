# Catering catalogue ownership value policy

Tracking: `floriankreutzer/conference-manager#233`. This independently tested, uncomposed value policy
is not stored catalogue ownership, Manager authorization/publication, provider synchronization,
availability, cost snapshotting or a release acceptance result.

The canonical Tenant catalogue stays authoritative. A Manager use case must independently load its
current revision/catalogue and same-Tenant configured Catering connection identities. Those expected
records are trusted input to this policy, not client-supplied authority; membership alone does not
prove a live connection, capability, provider verification or actor permission. Application and
transaction boundaries must enforce those facts before any later authoritative mutation.

The closed proposed assignment command carries schemaVersion1, catalogueRevision and assignments.
Each assignment contains only kind(item/package), canonical entryId and internal integrationId.
Every canonical Catering item/package, including inactive entries, has exactly one assignment.
Unknown, duplicate, missing, stale/future-revision, foreign/unrecognized-connection and ambiguous
array/property/accessor/prototype inputs fail closed. A package and all of its canonical component
items must belong to the exact same connection, even when inactive. Variants inherit their package;
services/equipment/Room prices are not Catering assignment targets.

Canonical catalogue validation is reused rather than duplicated. Existing limits of300 items and100
packages remain supported in full; no100-position technical receipt limit is imposed on catalogue
ownership. At most400 referenced connection records are needed for the400 possible assigned entries.
Identifiers retain canonical case-sensitive business-ID semantics; internal UUID scope is normalized.
Results are independent immutable values. An empty catalogue creates/activates no artificial provider.

This function has no database, HTTP, network, source registration, browser storage, credential,
activation or seed behavior. Existing unassigned catalogue/Demo behavior is unchanged because no
runtime caller is composed. Persisting assignments, rollout/migration of legacy canonical entries,
Manager-owned review/publication, provider availability/cost/terms and Employee filtering remain
required coordinated follow-up work. The original canonical price/content snapshots remain intact.
