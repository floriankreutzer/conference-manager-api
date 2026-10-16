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

## Canonical Request-create write baseline

`tests-db/request-create-load-evidence.test.js` adds isolated 100- and 1,000-User Employee scenarios
across ten synthetic Tenants, using the same ten-connection pool, 16 concurrent HTTP clients and
PostgreSQL 18 disposable-database guard. Each User creates one actual schema-v3 Submitted Request
through `POST /api/v1/application/requests`. This is request submission, not a confirmed booking or
provider calendar write. The unchanged production composition and provider port that rejects every
external operation are reused; no Hosted traffic, provider account or paid resource is used.

Session reads obtain each actual server-issued CSRF token before timing. Pool warmup, synthetic
fixture generation and canonical catalogue revision discovery are also outside the measured interval.
Only the POST phase contributes to its p50/p95/p99, completed operations, throughput, request/response
body bytes and local PostgreSQL query/protocol counters. The shared measurement engine retains the
read baselines' loopback, 8 KiB response, 1–32 clients, five-second socket timeout, bounded scenario
deadline, abort/drain and redirect-denial controls. Creates additionally permit at most 1,000 canonical
v3 drafts, each at most 8 KiB after canonical normalization, and one bounded CSRF token per session.
The HTTP method, route and expected 201 status are fixed. No write is retried. A failed campaign may
have committed individual Requests inside its disposable database; it emits no successful aggregate
and the unchanged runner destroys that database. There is no cross-campaign atomicity claim.

All Tenant-local Room/Site IDs collide while Room prices differ. Every response must retain the exact
User's title, schedule, configuration revisions, server price/allocation, version and public attribution,
without internal owner/Tenant IDs. Outside timing, every created ID is matched to its persisted Tenant
and requester, complete immutable history representation, same-actor audit and shared correlation.
Canonical repository reads verify ownership and cross-Tenant absence. Missing/wrong CSRF, foreign-only
Room, stale configuration and client price injection must fail without adding a Request, revision or
creation audit. HTTP owner reads succeed; foreign-Tenant and same-Tenant other-Employee reads are
concealed. All ten canonical audit chains must still verify. These checks are required before a
scenario's aggregate is published. Protocol fixtures alone are not real PostgreSQL write evidence.

The two populations produce 100 and 1,000 measured writes (1,100 persisted total), not 1,000 concurrent
HTTP requests. This adds a warm write-operation baseline only after successful exact-commit CI; it
does not approve an activity mix, capacity/SLO, cold start, confirmation/provider workflow, worker/media
cost, monthly invoice or topology comparison. The owner targets and the open #269/#270 boundaries below
remain unchanged. Runtime API, schema, canonical Demo seed, dependencies and deployment pins are unchanged.

## Fixed-arrival write sensitivity and warm objectives

The owner-approved warm application objectives are p95 <= 1,000 ms, p99 <= 2,000 ms and technical
error rate <= 0.1%. Cold starts remain separate with no approved cold threshold. These objectives
do not approve a representative operation mix or an arrival rate.

The same write test retains the original unpaced 100/1,000 cases and adds two 1,000-create waves:

| Arrival interval | Offered requests/s | Sensitivity assumption | Concurrent HTTP clients |
| --- | ---: | --- | ---: |
| 15 ms | 66.667 | 1,000 active Users, one aggregate request every 15 seconds | 16 |
| 5 ms | 200 | 1,000 active Users, one aggregate request every 5 seconds | 16 |

Each is one finite all-create stress wave, not sustained monthly traffic or a representative mix.
The four cases persist 3,100 Requests total in the disposable database. Every case independently
retains the complete price, ownership, history, audit-chain, CSRF and adversarial checks above.
Fresh runtimes/rate buckets, pre-timing session/CSRF reads and pool warmup remain unchanged.

Optional `arrivalIntervalMs` is an integer 0–1,000; zero preserves the original unpaced result shape.
The last planned arrival must precede the total deadline, otherwise validation fails before I/O.
A monotonic schedule fixes arrival `i` at start + i times interval. Bounded workers wait for that
arrival or dispatch late; they never drop overdue requests or reset the schedule after completion.
`latencyMs` remains dispatch-to-verified-body. Paced diagnostics additionally report `scheduleLagMs`
(planned arrival to dispatch), `scheduledLatencyMs` (planned arrival to verified body), interval and
offered rate. Thus client backlog remains visible instead of hiding overload through slower arrivals.
Abortable timers are drained with the workers; existing request, body, socket and deadline bounds apply.

`warmSlo` compares the approved thresholds to scheduled latency for paced cases and dispatch latency
for unpaced cases. Its zero technical error rate is emitted only after every operation and integrity
check succeeds; failures publish no successful result. A numerical SLO miss is reported as `met: false`.
It does not weaken functional checks or masquerade as performance acceptance because CI is green:
shared-runner timing is evidence, not a deterministic functional CI threshold. Exact-commit results
must retain candidate/Main distinctions. A local protocol fixture is not PostgreSQL evidence.

No production capacity, provider egress, cold-start, invoice, topology or confirmed-booking claim follows.
The warm SLO result applies only to that finite isolated scenario; #269/#270 remain open.

## Empty-selection SQL reduction

The canonical composition resolver skips service, catering-item and Equipment queries only when
that query's normalized ID set is empty. PostgreSQL `id = ANY(empty array)` cannot return or lock
any rows, so the same empty result enters the existing catalogue validator and snapshot builder.
Catering item IDs are the union of direct selections and package-included IDs: a selected package
still resolves its included items even when there are no direct item quantities. Every nonempty
selection retains its original Tenant predicate, parameters, row locks and authoritative validation.
Tenant/User/revision, Room/Site/price, policy, allocation, history and audit checks remain unchanged.
No cache, client authority, new query parallelism, schema or production limit is introduced.

The simple no-extras create fixture now requires exactly 18 client SQL calls per successful request,
compared with the historical 21-call baseline. All four existing unpaced/fixed-arrival cases retain
their full integrity/security checks and now enforce that query budget. This is a deterministic
three-roundtrip reduction; actual latency, protocol bytes and SLO outcomes require new exact-commit
measurements. Earlier candidate/Main results remain historical and must not be relabeled optimized.
A lower query count alone is neither an invoice saving nor proof that the 200 requests/s case passes.

## Monthly workload model

The owner's corrected initial targets (15 October 2026) are **10,000 business bookings per month
system-wide** and **approximately 1,000 simultaneously active Users system-wide**. These replace
the earlier 100-bookings-per-User assumption, its one-million-booking example and the 10,000-active-User
peak. The 10,000-User isolated fixture above remains historical test coverage, not the current peak target.
The earlier 100,000-booking monthly target is superseded for initial planning. The approved booking peak
is 1,000 on a strong day and 200 in the busiest 15 minutes. This produces 3,200 booking-related
HTTP operations across that interval under the 16-operation planning mix, an average of 3.556/s,
not a uniform sub-window distribution or proved capacity. Changing the peak population must not
multiply the approved total monthly bookings.

Run the dependency-free offline sensitivity planner with:

```bash
node scripts/booking-workload-plan.mjs docs/SAAS-3.8-WORKLOAD-EXAMPLE.json
```

The example retains the current 10,000-booking monthly target and independently approved 1,000-active-User target.
The owner approved the existing 16-operation-per-booking base mix for planning on 15 October 2026;
this is not observed demand. The 5/15/60-second request cadences remain illustrative sensitivity
assumptions, not an approved cadence or extra traffic to add to the booking mix. The proposed
doubled-read scenario was not selected.
For each fixed operation, monthly count equals total monthly bookings times its explicit coefficient.
The example yields 160,000 booking-related HTTP operations. Independently, 1,000 active Users making
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

The generic offline planner cannot attest owner decisions: its unchanged `activityMixApproved: false`
metadata is not a live governance status. The explicit planning approval above and #269/#270 are the
authority for this example; it remains `planning_only`, with no observed demand, cost or capacity pass.
An active-user population is not the same as simultaneously connected users, requests per second or
business operations per month. Preserve the approved planning mix and separately verify its real
source/traffic representativeness before capacity acceptance.
For independently observed non-booking activity only, the alternative per-User model below requires
monthly distinct active Users, not the simultaneous peak. Do not add it to booking-related counts
unless overlap is excluded. It must not replace the approved 10,000 total bookings with a per-User quota.
For each fixed operation `o`, retain `requests_per_user_day(o)` and `active_days` as assumptions:

`monthly_requests(o) = active_users × requests_per_user_day(o) × active_days`.

Scale the measured per-request HTTP body and PostgreSQL protocol averages independently by that
operation count. Keep payload estimates separate from actual provider billing-window counters, TLS,
transport headers, compression, cache hits, retries and provider-specific units. A session baseline
cannot stand in for catalogue pages, request creation/booking/provider writes or media. The offline
FinOps report's dated rate/allowance contract calculates independent components; it does not add
overlapping transfer boundaries or infer actual monthly compute/storage from local elapsed time.

## Same-workload topology evidence matrix

Owner decision (16 October 2026): SaaS 3.8 acceptance covers the existing Render
application + Neon database/object-storage topology. Its representative workload,
security/integrity, provider-transfer and attributable cost requirements remain
mandatory. Real alternative-topology measurements are transferred to the explicit
open follow-up [application #321](https://github.com/floriankreutzer/conference-manager/issues/321),
not claimed passed or required for SaaS 3.8 closure. The alternative columns below
remain that follow-up's evidence specification. No new resources, plan change or
migration is authorized by this decision.

| Evidence | Current Render + Neon Frankfurt split | Render application + Render PostgreSQL in one region | Application with approved private access to Neon |
| --- | --- | --- | --- |
| Canonical security/workload | Same accepted API, schema, three roles and dataset required | Identical workload and checks required | Identical workload and checks required |
| Application-to-DB bytes | Actual provider egress and public database transfer needed | Private-network bytes and region reachability needed | Private connectivity and provider-metered transfer needed |
| Latency | Actual warm/cold API p50/p95/p99 needed | Same timing mix and pool required | Same timing mix and pool required |
| Media/CDN | Private Neon Object Storage custody and actual cache/egress needed | Identical object workflow and media integrity required | Identical object workflow and media integrity required |
| Worker load | Outbox batch/queue/retry/reconciliation and CPU evidence needed | Same cadence and fault/recovery workload required | Same cadence and fault/recovery workload required |
| Monthly cost | Actual plan generation, window and shared allowance needed | Compute, storage, backups, private egress and migration cost needed | Private access eligibility, connectivity fees and compute needed |
| Recovery | Full real-provider acceptance transferred to final pre-Pilot #318 | Same restore and rollback evidence required | Same restore and rollback evidence required |
| Acceptance status | Isolated baseline only; provider measurements pending | Unprovisioned comparison candidate | Unprovisioned comparison candidate; eligibility unverified |

This matrix is an evidence specification, not a finding that an alternative is viable, free, faster
or cheaper. A benchmark must replay the same approved operation mix and concurrency in each permitted
environment, under the same security gates. Published plan prices alone cannot fill these missing
measurements. Do not provision paid comparison infrastructure or migrate providers automatically.

Select a topology only after comparing measured latency/error objectives, total attributable cost,
data residency, private-network eligibility, backup/restore/rollback, tenant and session integrity,
operational ownership, migration risk and remaining allowance. Record which criteria fail or remain
unknown. SaaS 3.8 #269 and release #270 retain representative business workload, provider transfer,
object/CDN and worker measurements and cost modeling for the existing topology.
Actual alternative-topology measurements remain open under #321 as specified above.
Per-optimization monetary proof from #265–#267 is consolidated there; no invoice savings is implied.
The owner transferred the full actual database/object recovery/rollback exercise to #318 in the
existing Pilot milestone: execute it last immediately before external Pilot release and #73's
final decision. This is unexecuted acceptance, not a recovery pass; source/CI/integrity requirements
remain in force. Actual Pilot outcomes/feedback are tracked separately in #316 and external
security-intake verification in #317. Neither transfer authorizes a new resource or billable test.

## Owned Request-read baseline

The existing create-load fixture additionally measures one owned Request read per User in the
unpaced 100- and 1,000-User scenarios. All requests were actually created through the canonical v3
HTTP route immediately beforehand; the separate read phase never contributes to create timing,
its exact 18-query budget or fixed-arrival create sensitivity results. It uses the same isolated
PostgreSQL 18 database, ten-Tenant colliding Room IDs, ten-connection pool and 16 HTTP clients.

The measurement helper accepts at most 1,000 bounded canonical UUIDs and matching session cookies,
fixes GET /api/v1/requests/{id}, and retains loopback-only routing, 8 KiB response bounds, five-second
socket timeout, overall deadline, abort/drain, no redirects and no retries. Every response must
match that User's actual created ID, status, version, Room, complete details, price and allocations,
without internal Tenant/requester IDs. Existing owner success, foreign-Tenant concealment,
same-Tenant other-Employee concealment, persisted history and all Tenant audit-chain checks remain.

Diagnostics retain a separate request-owned-read record with completed operations, percentiles,
HTTP body bytes and local PostgreSQL query/protocol counters. Native protocol tests additionally
reject route-selected IDs, malformed/mismatched/oversized inputs, redirected/denied/oversized or
malformed responses, wrong identity and stalled requests. A failed/partial phase emits no successful
read aggregate. Exact successful PostgreSQL results are required before calling this measured.

This adds a warm owned-read baseline only. It does not establish the four reads per booking's real
status/size distribution, a mixed booking journey, 1,000 concurrent HTTP requests, cold behavior,
provider-metered egress, complete monthly cost or target capacity. Availability, transitions,
media/cache and background/worker/provider work retain their separate evidence requirements.
No runtime API, schema, seed, dependency, deployment or security-limit change is introduced.

## Manager transition baseline

`tests-db/request-transition-load-evidence.test.js` creates 100 and 1,000 genuine
Submitted Requests through the canonical v3 HTTP create path in its own isolated
PostgreSQL 18 database. Ten synthetic Tenants have colliding Room/Site IDs, separate
Employee sessions and one separately authenticated Conference Manager per Tenant.
Fixture creation, session/CSRF acquisition and pool warmup are outside measured phases.

Each phase uses the same 16 HTTP clients and ten-connection pool: first every
Request transitions from version1 Submitted to version2 In Review, then every
Request transitions to version3 Rejected. Strong If-Match versions, exact server
commands, session cookies and CSRF execute through the complete Customer composition.
Only these two fixed transitions are permitted by the measurement helper; confirmation
and provider work are excluded. The existing loopback-only destination, at-most1,000
operations, 8KiB body, five-second socket/45-second scenario deadlines, abort/drain,
no redirects and no write retries remain enforced. The test file retains the existing
120-second runner cap. It never targets Hosted data or allocates provider resources.

Before publishing either phase's aggregate, all responses must match the Request,
status/version, Room and immutable details without internal Tenant/requester fields.
Database reconciliation requires exactly two corresponding transition revisions and
audit events per Request, the correct Tenant/manager, immutable manager-role attribution,
and matching correlations. All Tenant audit chains must verify. Employee and foreign-Tenant
manager commands, missing CSRF and stale If-Match are checked independently. Both phase
results are withheld until the complete scenario passes; individually committed writes
in a failed scenario remain confined to the disposable test database.

Diagnostics distinguish the phase and report percentiles, both HTTP payload directions,
SQL calls and local PostgreSQL protocol bytes. Approved warm objectives are evaluated
honestly as numerical results, not used as flaky shared-runner CI pass criteria.
Exact successful PostgreSQL runs are required before calling this measured. Native
protocol fixtures are only helper/security evidence. This is a sequential two-phase
manager decision baseline, not a mixed booking journey, confirmed/provider booking,
1,000 simultaneous requests, real egress/cost, cold-start or topology acceptance.
Availability, media and worker evidence remain separately required under #269/#270.
