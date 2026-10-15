# SaaS 3.8 load evidence and topology comparison

Tracking: `floriankreutzer/conference-manager#269`. This is the reproducible isolated session-read
baseline, not production capacity acceptance or a provider migration decision.

## Executable workload

`npm run test:db` creates and destroys a fresh PostgreSQL database per test file. The session load
test accepts only that runner's generated database name on literal loopback/localhost and PostgreSQL
18. It applies real canonical migrations, creates ten active synthetic Tenants, and progressively
seeds 100, 1,000 and 10,000 active Users and valid session records. No real identities, provider login,
external integrations, production database or paid resources are used. Fixture generation reuses the
canonical session service's token/hash epoch and the canonical role-permission snapshot; bulk fixture
insertion is explicitly outside the measured login/audit path.
The complete Customer composition receives a test-only provider port that rejects every external
operation. A native construction test catches missing service/configuration prerequisites before
the real database run; the session workload must never invoke that provider port.

| Scenario | Active fixture Users | Tenants | Users per Tenant | Reads | Concurrent HTTP clients | DB pool |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 100 | 10 | 10 | 100 | 16 | 10 |
| Medium | 1,000 | 10 | 100 | 1,000 | 16 | 10 |
| Large | 10,000 | 10 | 1,000 | 10,000 | 16 | 10 |

Every fixture User makes one real `GET /api/v1/session` over loopback HTTP through the production
Customer composition. Every response must be 200 and match that User's ID, Tenant, active state and
canonical role; this includes all three Customer roles. The normal session lookup, Tenant lookup,
authorization policy, CSRF-token generation, HTTP security headers and exact Host validation execute.
The test binds its configured origin to the actual ephemeral loopback port. It does not change any
production security or rate limit. Its own validated test configuration permits 10,000 requests, and
each scenario creates a fresh rate-limit bucket. There is no measured-request warmup or skipped load.

Pool connections are warmed with `SELECT 1` before measurement, excluding connection/startup overhead
from the reported interval. This is a warm-database session-read baseline; cold starts require separate
evidence. SQL calls are counted at the test pool's client boundary without retaining query text or
values. Exactly two canonical queries per successful read are asserted. Socket cumulative bytes are
differenced once per interval across pool clients, avoiding overlap from concurrent queued queries.
These are local PostgreSQL protocol bytes without TLS, provider routing or invoice metering.

Each scenario emits one bounded aggregate JSON diagnostic containing actual completed requests,
concurrency, elapsed time, throughput, p50/p95/p99 latency, HTTP body bytes, PostgreSQL read/write bytes,
SQL calls, fixture size and Node/PostgreSQL versions. Cookies, hashes, tokens, personal data, SQL values,
Tenant/User IDs and database URLs never enter diagnostics. Successful results remain in the actual
GitHub PostgreSQL integration job logs and must be bound to its exact accepted commit. A candidate
test or native protocol-fixture result is not PostgreSQL load evidence.

## Bounds and failure handling

The helper accepts only literal `http://127.0.0.1:<port>/`, the fixed read route, at most 10,000 strictly
formed session cookies, concurrency 1–32, response bodies up to 8 KiB, a five-second socket timeout
and a total scenario deadline of at most 60 seconds (45 seconds in the integration test). It never
follows redirects. Any status, body, identity, timeout, truncated/oversized response or incomplete
scenario fails acceptance; workers are drained, requests aborted and sockets destroyed before exit.
No partial result is published as success. The test runner's unchanged 120-second per-file cap still
applies. Native negative/protocol tests prove destination, cookie and bound rejection, exact body
accounting and redirect denial. They do not substitute for the real PostgreSQL run.

## Populated Room-page baseline

`tests-db/catalog-load-evidence.test.js` adds a separate isolated PostgreSQL 18 workload at the
same three User populations, ten Tenants, 16 HTTP clients and ten-connection pool. Each Tenant has
one active Site and ten active priced Rooms. Room/Site IDs deliberately collide between Tenants;
Room names and prices differ, so every response must match the caller Tenant's exact five Rooms,
including capacity, equipment, media fields and price. All three canonical Customer roles use
real canonical sessions. The fixture generation and SQL/protocol counters are shared with the
unchanged session workload; neither duplicates session hashing or authorization policy.

Before timing, the real repository supplies the configuration generation for each Tenant and the
test warms pool connections. Each User then reads exactly one fixed first Room page through the
complete production Customer HTTP composition. The helper permits only the loopback destination,
five-entry Room route and bounded generation context. Existing 8 KiB, timeout, concurrency and
abort/drain bounds remain unchanged. The response must be schema v2, contain the expected generation,
have five entries and a nonempty continuation cursor, and report incomplete pagination. No
production configuration, migration, Demo fixture, provider adapter or runtime behavior changes.

The measured query count includes session/Tenant lookup and the canonical repeatable-read catalogue
transaction (BEGIN, UTC setup, three context queries, Room query and COMMIT): nine calls per read.
Diagnostics retain completed requests, percentiles, body bytes and local PostgreSQL protocol bytes,
plus `representativeActivityMixApproved: false`. The normal disposable-database, PostgreSQL-version
and unchanged 120-second per-file gates apply independently to both workloads. A failed or partial
run cannot publish a successful population result.

This is a populated read-operation baseline, not an approved monthly business mix, booking/write,
pagination traversal, media download, worker, cold-start, real provider egress or alternative-topology
measurement. Exact successful CI evidence must be retained before calling it measured. It does not
close #269 or #270 or provide additional spending authorization.

## Final Room-page continuation baseline

The same isolated Room fixture additionally measures the final five Rooms for every User at each
population. The first measured page supplies the actual continuation; all fixture responses must
agree on that cursor before the final-page phase can start. The cursor is never fabricated from a
Room ID or supplied as a destination. Its context/generation stays server-derived, and the fixed
five-Room helper accepts exactly one bounded context or cursor, never both.

A fresh HTTP runtime/rate bucket is used for each phase without increasing production limits.
The final response must contain exactly Rooms 5–9 with the caller Tenant's distinct names/prices,
all fields, the same configuration context, complete=true and nextCursor=null. Colliding IDs across
Tenants therefore cannot pass through row-count-only assertions. Both phases independently retain
nine-query, positive protocol-byte, complete-response and abort/deadline checks. Diagnostics identify
first/final page and pageIndex, with 100/1,000/10,000 actual reads per phase, not concurrent Users.

This adds warm continuation-read evidence only after a successful exact-commit PostgreSQL run.
The two phases are separate batches, not a timed per-User end-to-end traversal; no combined journey
percentile or cold-start, write, provider, representative mix or monthly billing claim follows.
The session baseline, existing first-page assertions and unchanged 120-second file cap are retained.
No runtime API, schema, seed, deployment, dependency or provider configuration is changed.

## Monthly workload model

The owner's corrected initial targets (15 October 2026) are **100,000 business bookings per month
system-wide** and **approximately 1,000 simultaneously active Users system-wide**. These replace
the earlier 100-bookings-per-User assumption, its one-million-booking example and the 10,000-active-User
peak. The 10,000-User isolated fixture above remains historical test coverage, not the current peak target.
Changing the peak population must not multiply the approved total monthly bookings.

Run the dependency-free offline sensitivity planner with:

```bash
node scripts/booking-workload-plan.mjs docs/SAAS-3.8-WORKLOAD-EXAMPLE.json
```

The example retains those two owner targets. All operation counts per booking and the 5/15/60-second
request cadences are illustrative sensitivity assumptions, not an approved observed business mix or SLO.
For each fixed operation, monthly count equals total monthly bookings times its explicit coefficient.
The example yields 1,600,000 booking-related HTTP operations. Independently, 1,000 active Users making
one request each every 5/15/60 seconds imply 200/66.67/16.67 aggregate requests per second. The cadence
covers aggregate requests across operations; do not multiply that peak rate by the per-booking count.
Neither calculation estimates simultaneous in-flight requests, session durations, bursts, error rates,
provider calls, background traffic or monthly distinct Users. These require separate evidence.

The closed schema bounds seven fixed operation coefficients to integer 0–1,000, total monthly bookings
to 1–1,000,000,000, peak active Users to 1–1,000,000 and one to ten unique integer cadences to 1–86,400
seconds. Products remain safe integers. The CLI reads at most 16 KiB from a regular local file and emits
only a fixed error on failure. It makes no HTTP, database, deployment or provider call. Reports always
identify planning-only evidence, unapproved activity mix, no accepted capacity and unknown provider
cost/background traffic. The planner complements the FinOps report; it does not calculate billing.

An active-user population is not the same as simultaneously connected users, requests per second or
business operations per month. Record an approved representative activity mix before extrapolating.
For independently observed non-booking activity only, the alternative per-User model below requires
monthly distinct active Users, not the simultaneous peak. Do not add it to booking-related counts
unless overlap is excluded. It must not replace the approved 100,000 total bookings with a per-User quota.
For each fixed operation `o`, retain `requests_per_user_day(o)` and `active_days` as assumptions:

`monthly_requests(o) = active_users × requests_per_user_day(o) × active_days`.

Scale the measured per-request HTTP body and PostgreSQL protocol averages independently by that
operation count. Keep payload estimates separate from actual provider billing-window counters, TLS,
transport headers, compression, cache hits, retries and provider-specific units. A session baseline
cannot stand in for catalogue pages, request creation/booking/provider writes or media. The offline
FinOps report's dated rate/allowance contract calculates independent components; it does not add
overlapping transfer boundaries or infer actual monthly compute/storage from local elapsed time.

## Same-workload topology evidence matrix

| Evidence | Current Render + Neon Frankfurt split | Render application + Render PostgreSQL in one region | Application with approved private access to Neon |
| --- | --- | --- | --- |
| Canonical security/workload | Same accepted API, schema, three roles and dataset required | Identical workload and checks required | Identical workload and checks required |
| Application-to-DB bytes | Actual provider egress and public database transfer needed | Private-network bytes and region reachability needed | Private connectivity and provider-metered transfer needed |
| Latency | Actual warm/cold API p50/p95/p99 needed | Same timing mix and pool required | Same timing mix and pool required |
| Media/CDN | Private Neon Object Storage custody and actual cache/egress needed | Identical object workflow and media integrity required | Identical object workflow and media integrity required |
| Worker load | Outbox batch/queue/retry/reconciliation and CPU evidence needed | Same cadence and fault/recovery workload required | Same cadence and fault/recovery workload required |
| Monthly cost | Actual plan generation, window and shared allowance needed | Compute, storage, backups, private egress and migration cost needed | Private access eligibility, connectivity fees and compute needed |
| Recovery | Restore/reset under current private custody required | Same restore and rollback evidence required | Same restore and rollback evidence required |
| Acceptance status | Isolated baseline only; provider measurements pending | Unprovisioned comparison candidate | Unprovisioned comparison candidate; eligibility unverified |

This matrix is an evidence specification, not a finding that an alternative is viable, free, faster
or cheaper. A benchmark must replay the same approved operation mix and concurrency in each permitted
environment, under the same security gates. Published plan prices alone cannot fill these missing
measurements. Do not provision paid comparison infrastructure or migrate providers automatically.

Select a topology only after comparing measured latency/error objectives, total attributable cost,
data residency, private-network eligibility, backup/restore/rollback, tenant and session integrity,
operational ownership, migration risk and remaining allowance. Record which criteria fail or remain
unknown. SaaS 3.8 #269 and release #270 remain open until representative production/business workload,
provider transfer, object/CDN and worker measurements and the same-workload comparisons are verified.
