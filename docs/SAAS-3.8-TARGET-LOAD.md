# Isolated target-load preparation

Status: preparation for application #269/#270; no target deployment or
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
marker. Missing privilege fields fail closed.
Runtime identities also require explicit negative database/schema/marker ownership,
database/schema CREATE and table/column marker-mutation checks. Only the installer
may retain this local ownership authority; no surface may retain elevated role attributes.
Missing authority fields fail closed. Only the setup identity may accept an
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

## Target-only runtime composition

`scripts/target-load-runtime.mjs` composes the existing Customer or Platform
application using separate limited PostgreSQL principals. It is never imported by
normal entrypoints. The target namespace rejects normal Demo/Customer/Platform
connection and identity variables; Render repository, Main branch, service name and
actual commit must equal the independently configured run binding. The validated
single `sslmode=verify-full` query is removed only before calling the canonical
configuration loader, which receives unchanged verified TLS separately.

Customer storage uses the canonical bounded Neon SDK adapter, exact run bucket and
a verified media probe belonging to one of the ten synthetic fixture Tenants.
Database authority is checked before fixture/object reads. Ten distinct synthetic
Microsoft bindings feed the existing explicit calendar fixture. Platform receives an
explicit unavailable authentication service: login/callback cannot accept an identity,
write an OIDC flow or issue a session. Customer retains its canonical unavailable
identity handling. No real identity or Graph client is created. Any persisted booking reference prevents startup because
a restarted in-process calendar cannot reconstruct its external events. Unexpected
boot changes therefore invalidate a campaign; cold restarts must precede booking
writes. Platform uses its normal projection worker and a separate four-connection
pool and the canonical Platform route-metric validator. Worker/subscription failures are counted without logging their errors.

The protected `GET /__load/observe` endpoint requires the run's independent Bearer
credential and exposes only fixed aggregate metrics, process CPU/memory, boot/source
identity, fixture-call counts and bounded storage activity. It never publishes
metric labels, cookies, SQL details or credentials. Requests use existing security
headers. The wrapper replaces the single canonical HTTP listener, so rejected
observer requests cannot fall through into application handlers. Other requests
retain all normal session, Tenant, CSRF, ownership, authorization and workflow checks.

Admission ends ten seconds before the original absolute expiry; draining starts
before asynchronous startup can extend the lifetime. A separate hard process exit
remains armed through a wedged startup or shutdown. Expiry, backward/invalid clocks
and explicit close permanently reject further admission. This stops process work,
not provider billing or resource custody; independent quotas and cleanup remain
required. Per process, SDK calls are capped at 10,000, requested read bodies at
2,000,000,000 bytes and write bodies at 20,000,000 bytes; failed attempts consume
these bounds. These are process bounds, not durable billing counters across restarts.
The future driver must bound total campaigns/restarts independently.

The default target profile retains 120 requests per minute. The explicitly named
`representative1000` profile configures 1,000 requests per minute for the isolated
workload only; it is not proof of capacity under the canonical 120-request profile.
The normal runtime defaults and existing deployment are unchanged. CPU samples cover
the entire selected process, including observer/HTTP overhead; Platform process CPU
is not an exact worker-only CPU measurement.

## Verification and remaining execution

Native negative tests cover invalid destinations/roles/times/credentials, expiry
across awaited queries, incomplete privilege results, setup-only empty databases,
private error redaction, target-only configuration, protected aggregate observation,
no observer fall-through, irreversible admission closure, asynchronous startup expiry,
a real hard-exit timer during wedged shutdown, concurrent SDK budget reservation,
Tenant-bound calendar inputs, immutable idempotency, exact
UTC and hard event limits. Repository full check and audit remain mandatory before
candidate review; complete required CI and independent Main checks remain separate.
Mocked SQL results do not establish PostgreSQL/provider permission acceptance.
The additional runtime PostgreSQL test composes both canonical surfaces against
separate restricted loopback roles, exercises real marker/privilege SQL, private
media integrity, cross-Tenant/CSRF/Customer-to-Platform denial, actual projection
work and direct database privilege negatives. It explicitly substitutes the
disposable local database name and transport only at the test dependency seam;
it does not establish remote Neon identity, TLS or credential isolation.
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
