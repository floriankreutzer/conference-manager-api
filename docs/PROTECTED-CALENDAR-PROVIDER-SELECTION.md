# Protected calendar provider selection

This prepared component selects one server-owned calendar factory using current
PostgreSQL registry custody. It introduces no public endpoint, identity, role,
provider credential, migration, timer or runtime activation. Complete protected
INT composition and acceptance remain tracked by SaaS1 application issue351.

## Selection and operation boundaries

`createProtectedCalendarProviderFactory` fixes environment and non-reusable UUID
epoch at composition. It requires the existing current-runtime repository and
its explicit cleanup port. The owned runtime must provide separate bounded
business/lease pools. Classification is read under the retained reset barrier;
the short business read releases its connection before awaited adapter work.

Both factory ports accept closed own-value inputs. The ordinary business use
cases continue to supply authoritative internal Tenant/Room IDs and persisted
Integration/connection/resource references. Browser mode, extra authority ports,
accessors and stale/foreign descriptors cannot select an adapter. The two factory
functions are captured when validated so subsequent property replacement cannot
replace them. Current custody permits at most one callback per selection/attempt.

REAL selects only the configured Microsoft365 adapter. Synthetic selects only
the separately configured network-free simulator. Missing REAL configuration
returns unavailable; registry, adapter and provider failures propagate without
retrying selection or falling back to simulation. Returned metadata must declare
`microsoft365`/`microsoft_entra` for REAL and
`synthetic_calendar`/`platform_delegation` for synthetic. Persisted bindings must
match exactly. Every returned calendar method checks the bound Tenant/Room and
optional persisted metadata, then rechecks its captured mode under a retained
lease. PROD cannot configure a synthetic factory.

The Customer business composition accepts an optional exact two-function
`calendarProviderFactory` with persistence required. Malformed explicit factories
fail before service assembly. The default Microsoft composition is unchanged.
Booking authorization, entitlements, reference persistence, idempotency,
compensation and response validation remain with canonical business services.

## Inactive REAL cancellation

The repository's explicit cleanup lookup additionally permits suspended/archived
REAL Tenants with current deployment classification. Only cancellation uses that
gate on the bound provider. New bindings, availability, validation, creation and
updates still require ordinary eligible lifecycle state. Synthetic cleanup never
admits inactive generations or disabled/stale generation owners. This port grants
no Customer authentication, business mutation or Platform permission. Owning
cancellation/reconciliation services still perform their existing authorization
and exact persisted-reference checks. Normal lookup retains its existing policy.

## Evidence and limits

Focused tests cover fixed mode, every method's current lease, no fallback,
inactive REAL cancellation, cross-Tenant/Room/reference denial, stale/archived
custody, truthful metadata, immutable factory functions, malformed composition
and duplicate callback rejection. The new native PostgreSQL case uses max1 pools,
actual signed software-P256 generation, current registry/operator/epoch changes,
reset contention and business reads inside adapter callbacks. Its adapters are
explicit network-free tripwires, not live Microsoft or durable SIM state. Native
execution requires exact-source CI; source preparation is not execution evidence.

A durable synthetic calendar, synthetic discovery/import and honest readiness/UI
remain separate work. This selector does not gate other Microsoft consent,
discovery, worker, health, catering or mail paths. The final owned root must gate
every outbound-capable path and prove full two-surface progression with reset and
outbound tripwires. Neither supplied adapter labels nor these component tests
prove that an arbitrary supplied implementation is network-free. Existing closed
Demo source, seed/checksum and permanent four-pair acceptance remain mandatory.
No live provider, sender, customer invitation or paid resource is activated.
