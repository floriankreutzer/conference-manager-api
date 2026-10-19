# Scoped Catering configuration persistence

Tracking: `floriankreutzer/conference-manager#232` (backend component; runtime activation remains open).

Migration 046 introduces typed per-Integration configuration and immutable revision history.
Every key/FK includes the internal Tenant. Modes are six separate closed API/manual/unsupported
columns, not arbitrary JSON. Initial-order mode remains separate from Manager-owned decisions.
Current revisions must advance exactly once; a deferred composite FK requires the matching history
row before commit. History cannot be updated/deleted by ordinary SQL. Populated rollback fails
closed rather than dropping configuration/history. No existing Integration is backfilled or activated.

The application service requires the existing Tenant Admin integration permission for reads and
updates. Employee, Manager-only, Platform and mismatched Tenant contexts cannot access this port.
The provider descriptor comes from the persisted, authorized Integration and source-controlled
registry. Payloads cannot carry provider/Tenant overrides, credentials, URLs, health or approval.
Configuration modes can disable but never upgrade source support. Public results include only
registered provider/Integration identity, revision and validated configuration values.

The PostgreSQL adapter parameterizes all values. Writes lock the available Tenant, active User,
exact non-revoked/non-expired session and source-matching Integration in that order. The User's
security version, session principal version, Tenant Admin role and integration permission are
rechecked using database state/time under locks. Configuration CAS, matching immutable snapshot
and minimized scoped audit append commit together. An audit failure or wrong audit scope aborts
the transaction. Restarted reads use committed rows; no in-memory business authority is introduced.

initialize is an internal setup port for an independently created/authorized existing Integration;
it requires explicit revision zero and the same live actor/session fence. It does not create a
provider connection or establish provider verification. update requires the exact existing revision.
The read port still requires its authorized application/transport caller; passing a UUID to the
repository is not authentication. The service rejects mismatched/altered repository results.

Demo overlay 012 grants Customer configuration read/write plus history append/read, no ordinary
history mutation/delete, and reset-only read/truncate. Platform receives neither table. Supported
reset includes both empty-by-default tables under the existing exclusive reset gate. The canonical
seed version, semantic checksum and three customer scenarios remain unchanged. Exact canonical
readiness becomes 46 and Demo overlay readiness becomes 12; every current-schema operational
check still requires the exact current version and retains its role/target/evidence gates.

No HTTP handler, browser UX, provider verification/health, credential ingestion/store, entitlement
activation, catalogue import or order dispatch is composed by this component. The separately tracked
credential-encryption component is not a deployed secret store. Session/CSRF transport, setup UX,
full role-owned browser flows and external provider qualification remain required follow-up work.

Native tests exercise the real authorization policy, independent providers, stale revisions, denied
roles/Tenants/lifecycle, malformed input, repository corruption and audit failure. PostgreSQL tests
are defined for real constraints, history/snapshot integrity, concurrent CAS, rollback on audit
failure, live session/security-version/role/lifecycle fences, restart reads and guarded migration
rollback. A test definition is not execution evidence; required PostgreSQL 18 and full permanent
Chromium/WebKit × storage/reset CI must pass on the final candidate before merge.
