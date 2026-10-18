# Isolated target-load preparation

Status: unmerged preparation for application #269/#270; no target deployment or
capacity acceptance. Accepted operation baselines remain in SAAS-3.8-LOAD-EVIDENCE.md.

## Scope and authority

The existing Render + Neon topology remains the target. The owner's total EUR10
completion authorization does not establish unused budget, recurring-plan authority,
actual monthly cost acceptance or permission to weaken any security/test gate.
Verify attributable accrued usage and conservative additional bounds before allocating
resources. Do not use or reset either existing Hosted Demo for this workload.

A separate empty storage authority boundary is mandatory: existing branch-scoped
service credentials also authorize existing private Operations objects and must never
be installed in a new test service. A fixed SDK bucket name alone does not constrain
credential authority. Independently verify project/branch/endpoint/bucket ownership,
privacy and credential scope through provider control-plane evidence. An ordinary
child branch copying existing data is not an empty-isolation substitute.

## Guard modules

`scripts/support/target-load-guard.mjs` validates one fixed run ID, immutable release
SHA, exact synthetic database/role/bucket/service names and the independently supplied
Frankfurt Neon host. It requires verify-full TLS, rejects duplicate/extra connection
options and confines HTTP origins to the corresponding exact Render service names.
The two-hour maximum lifetime begins at first resource creation, includes setup and
failure paths, and must not be renewed on restart. These configuration guards do not
prove actual provider isolation or provide automatic resource deletion.

Read-only database verification requires PostgreSQL18, exact database/current role,
all seven explicit privilege/membership results false and one matching run/release/time
marker. Missing privilege fields fail closed. Only the setup identity may accept an
actually empty public schema before marker installation, using schema dependencies
to include non-table objects. Catalog reads explicitly use `pg_catalog`; marker
reads explicitly use `public`. Time is checked before and
after every asynchronous query, so an expired result cannot authorize subsequent
setup/runtime work. A hung dependency is not canceled by this guard; the composed
pool's bounded timeouts remain required. All failures expose one fixed safe error,
without PostgreSQL connection/schema details.

`scripts/support/target-load-calendar.mjs` is an explicit in-process external boundary,
not Microsoft acceptance. It binds ten distinct UUID/resource pairs, rejects repeated
addresses and UUID case aliases, validates UTC
intervals, preserves immutable idempotency and caps retained events at1,000. Real
application/repository authorization, entitlements, local conflicts, version/history,
audit and provider-health behavior must remain active in any eventual composition.
Update/cancel/discovery/consent operations are forbidden. These helper modules are
not imported by any normal Customer, Platform or Demo runtime entrypoint.

## Verification and remaining execution

Native negative tests cover invalid destinations/roles/times/credentials, expiry
across awaited queries, incomplete privilege results, setup-only empty databases,
private error redaction, Tenant-bound calendar inputs, immutable idempotency, exact
UTC and hard event limits. Repository full check and audit remain mandatory before
candidate review; complete required CI and independent Main checks remain separate.
Mocked SQL results do not establish PostgreSQL/provider permission acceptance.
The separate PostgreSQL integration test exercises actual role rights/membership,
public-schema relations/types, run markers and a hostile search path in the runner's
disposable loopback database. Retain its successful exact-candidate CI result before
claiming this SQL-contract evidence; it does not verify Neon permissions or remote
connection/control-plane isolation. Marker reads explicitly name the public schema.

Before any actual run, complete and validate synthetic setup, Customer and Platform
compositions, private media delivery and bounded worker observation, the coherent
approved sixteen-operation replay, warm/cold measurement, bytes/request limits,
negative security/integrity reconciliation and retained exact-source evidence.
Distinguish1,000retained Users, active Users, HTTP concurrency and arrival cadence.
Never count fixture Graph calls as real Graph latency/transfer or protocol counters
as invoiced provider egress. No target-host measurement exists from these guards.

Confirm a feasible suspend/teardown path before creation, retain non-secret evidence
and remove only newly marked synthetic resources after the run, including failures,
under the provider's applicable deletion requirements. Existing Demo data, source
registers, roles, credentials, scheduled monitoring and deployments remain outside
scope. Full real-provider recovery/rollback #318 remains the final pre-Pilot gate;
actual Pilot source/outcome acceptance stays #316 and external security intake #317.
