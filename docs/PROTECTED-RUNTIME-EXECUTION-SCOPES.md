# Protected runtime execution scopes

This prepared infrastructure adapter is uncomposed. It creates no HTTP route,
authentication, Platform permission, passkey proof, generation or reset grant.
It performs no migration, deployment, provider activation or external request.
Complete protected INT composition and acceptance remain under SaaS1 issue351.

`createPostgresProtectedRuntimeExecutionScopes` fixes the environment and current
protected UUID epoch at server composition. It requires distinct bounded business
and lease pools. The existing protected advisory-lock namespace and immediate
try-lock behavior are retained; no polling, retry or deadline extension is added.

## Normal request and worker work

`withShared` holds its READ COMMITTED transaction on the separate lease pool,
checks the current deployment epoch and then invokes business work. Existing
repositories can use their ordinary business pool and begin REPEATABLE READ proof
transactions after the shared reset barrier is held. This avoids an isolation
downgrade and avoids holding the business pool's only connection while an ordinary
`pool.query` waits for that same connection. A single connection on each pool is
supported; the additional pool is not an additional database/service resource.
Composition must size the sum of both pools within its actual database limits.

The private shared execution marker identifies the live enclosing lease for the
exact business pool, environment and UUID epoch. A nested business RR transaction
does not replace that outer lease: its separate transaction ALS context can shadow
the lease transaction context without releasing the lease. The marker rejects
foreign or detached scopes and grants no authentication or mutation permission.
Protected real onboarding also locks/rechecks the deployment in its authoritative
business transaction before creating or replaying immutable REAL classification.

Host/origin/target/body/rate validation must precede resource allocation. Acquire
this scope before business transactions. All protected business/provider work
must be awaited before releasing it. It is not a wrapper for public health or
arbitrary malformed requests. Current mode/access repositories remain mandatory;
holding a deployment lease alone proves neither membership nor Tenant authority.

## Exact synthetic mutation

`withSyntheticExclusive` is unavailable in PROD and accepts only an internal
operator ID/security-version candidate. It acquires an exclusive REPEATABLE READ
gate on the business pool, locks/rechecks the deployment row and updates only the
current active Microsoft operator's coordination timestamp before reading its
generation set. Trigger029 preserves the operator security version when only
`updated_at` changes; roles/provider/scope/status are never changed by this stamp.

The advisory SELECT can establish an RR snapshot before acquiring the lock. A
just-committed epoch change must therefore cause a serialization failure when the
deployment row is locked. Likewise, every completed own reset stamps its operator
tuple, so an intervening own reset causes the next stale snapshot to fail on that
tuple rather than miss its newly committed generation/quota row. A40001 remains
a failed operation requiring a fresh reviewed ceremony; this adapter never retries.

Reference: [PostgreSQL18 transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html).

The caller must supply current exact operation proof, target ownership, generation
revision/retention/cooldown checks, transactionally written ordinary lifecycle
archival and both audit domains. The helper itself grants none of those. Integrate
the exclusive scope around the proof repository's transaction before proof
consumption, after initial pending/session reads. Every mutation read/write must
use the supplied client or deliberately join that same transaction. Wrapping the
whole proof service in a max1 business-pool transaction would deadlock its initial
ordinary reads and is not the integration contract.

Shared-to-exclusive, cross-pool/environment and RC-to-RR upgrades remain denied.
The existing default shared/exclusive gate retains READ COMMITTED behavior. Only
the explicit new repeatable-exclusive entry starts RR; its callers must perform
the locked current-custody checks described above. A synthetic reset cannot nest
under the normal shared HTTP scope. Errors preserve original rollback semantics;
the proof repository still owns its authentication-attempt commit/rollback rules.

## Verification limits

Focused tests cover distinct pools, original transaction isolation, current epoch,
closed scope fields, PROD denial, safe nesting and rejected upgrades. The native
test requires actual PostgreSQL and checks max1 pools, same-client RR nesting,
rollback of a failed mutation's stamp, unchanged operator security version, reset
contention, and instrumented real MVCC races for intervening epoch/owner updates.
These new native checks are not local execution evidence: they require exact-head
CI before acceptance. Neither these component tests nor the existing closed Demo
matrix replace full protected root, generation reset, handoff, physical-key and
live provider/deployment acceptance.
