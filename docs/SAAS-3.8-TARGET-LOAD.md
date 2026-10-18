# Isolated target-load preparation

Status: preparation for application #269/#270; no target deployment or
capacity acceptance. Accepted operation baselines remain in SAAS-3.8-LOAD-EVIDENCE.md.

## Scope and authority

The installer and Customer may set `LOAD_STORAGE_CLUSTER` to the independently
verified Frankfurt storage cluster string `5` or `7`; omission preserves `5` for
existing callers. Read the actual storage hostname from provider-generated
storage evidence, separately from the database hostname. Never infer one cluster
from the other or supply an arbitrary endpoint. Platform rejects this storage
setting. The pure provider configuration and architecture gate retain exactly one
reviewed endpoint template, closed cluster choices, fixed region and TLS authority.

The existing Render + Neon topology remains the target. The owner's total EUR10
completion authorization does not establish unused budget, recurring-plan authority,
actual monthly cost acceptance or permission to weaken any security/test gate.
Verify attributable accrued usage and conservative additional bounds before allocating
resources. Do not use or reset either existing Hosted Demo for this workload.

The consolidated source candidate synchronizes the hosted frontend submodule,
both immutable Blueprint frontend pins and the separate permanent acceptance pin
to frontend Main `65d46db640aaeffff5b5b5c7776d1a0509afa4fa`. This retains the Provider
insights accepted in frontend #322 and the Manager focus-race correction in #323;
it does not weaken task counts, assertions, timeouts or reset coverage. Independent
frontend Main acceptance and final API candidate/Main gates remain required.
Merging the Blueprint pin can initiate the existing code-only Demo release: inspect
actual selected deploy/source identities and avoid duplicate deployment. No data
reset, schema/seed migration, plan/quota or existing credential change is part of
that frontend synchronization. Existing Demo deployment verification is separate
from the isolated synthetic workload.

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
may retain this setup ownership authority; no surface may retain elevated role attributes.
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
headers and the canonical public-origin Host check; missing or duplicate Host
headers and aliases cannot retrieve observer data even with its credential.
The wrapper replaces the single canonical HTTP listener, so rejected
observer requests cannot fall through into application handlers. Other requests
retain all normal session, Tenant, CSRF, ownership, authorization and workflow checks.

Each surface also reports attempted SQL-call counts and `pg` driver-stream
read/write-byte counters through the shared bounded load meter. It preserves the
driver's original query arguments, callback/Promise results and verified TLS.
Closed clients are retired into aggregate totals instead of retaining them without
bound; at most 64 client references can be observed concurrently. Invalid counters
make observation unavailable. No SQL text, parameter, result, connection string or
client identity enters the report. These are process/driver-stream observations,
not independently measured encrypted-wire bytes or Neon invoice egress. Startup
is outside campaign deltas; separate installer/growth/reconciliation connections
are outside the two runtime meters. Platform counts include its worker and any
Platform HTTP work in that window, rather than claiming exact worker-only cost.
Independent provider usage retains its own measurement boundary.

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

## Local installer preparation

`scripts/target-load-setup.mjs` is a local installer for an already provisioned,
empty target database owned by its separate restricted setup role. It does not
create provider resources, databases or roles. The Customer and Platform roles
must already exist without elevated attributes, memberships, object ownership or
previous table rights. Provider administrator credentials never enter this installer
or either target service. SQL-created limited roles require independent Neon
control-plane and catalog verification; Console/API-created roles normally inherit
`neon_superuser` and are unsuitable runtime principals.

The installer verifies empty-database authority before installing a fixed run marker,
then applies canonical migrations and shares the existing synthetic booking seed:
ten Tenants, one hundred rooms, ten Managers and exactly 100, 1,000 or 10,000
Employees. Session generation uses the canonical session service; synthetic fixture
issuance is not an identity-provider login. Ten private images pass through the
owned loopback Manager/CSRF upload API. Runtime grants are explicit, surface-specific
and preserve immutable media rows. A pre-existing marker prevents reseeding.

The CLI reserves `/tmp/cm-saas38-load-RUN.json` exclusively with mode 0600 before
database work. This private intermediate contains raw synthetic session cookies;
never print, commit, publish or attach it to CI evidence. It contains no database
passwords or provider keys. A failed installer removes its reserved file; partial
database/object work remains within the marked target for controlled cleanup.
Absolute expiry stays armed through setup and cleanup. This does not stop billing.

An additional PostgreSQL test uses an actually fresh, installer-owned database and
restricted SQL roles, exercises the installer, media custody, runtime grants and
one complete sixteen-operation booking, verifies Tenant HMAC chains and worker
drain, and checks forbidden runtime schema/marker writes. Only the guarded local
transport is substituted. Successful exact-head CI is required before accepting
that evidence; no remote permission, TLS, provider cost or capacity claim follows.
Privileged control-plane bootstrap and live execution remain unfinished work.

## Bounded replay and population growth preparation

The target-only replay modules retain the existing sixteen-operation choreography
and shared canonical draft fixture. The closed `sample10` profile checks ten
journeys; `target200` schedules two hundred starts 4,500 milliseconds apart with
four journey workers. Queue delay is reported explicitly: worker backpressure must
not be presented as successful open-arrival capacity. The target profile requires
at least one thousand retained Employees but involves exactly two hundred Employees
and ten Managers; it does not establish one thousand simultaneously active users.
Distinct slot offsets prevent the three population stages from booking the same
Tenant/room/time. No normal production route or rate configuration changes.

Private manifests have a closed schema tied to the independent run/source/expiry,
exact Render origins, ten Tenants, actor/session custody, fixed synthetic catalogue,
media ownership and configuration revisions. File reads require the fixed path,
an owned regular file with mode 0600, one link, no symlink, a five-megabyte limit
and unchanged file metadata across reading. Tokens never enter public evidence.

The HTTPS transport fixes destinations and routes, verifies TLS, rejects redirects
and encodings, bounds headers/bodies and cancels each normal operation after five
seconds without retry. A separate first protected probe allows at most sixty
seconds once per surface before business traffic; this is not proof that the
provider was actually cold or suspended. Transport concurrency is capped at sixteen.
Before I/O, its exclusive per-run local journal durably reserves each attempt and
the maximum response bytes. The journal accepts only fixed aggregate fields and
caps ten thousand attempts and two billion reserved response bytes. Failed attempts
consume reservations; an existing journal prevents a controller restart from
receiving a fresh budget. This single-controller/host constraint is not a distributed
or provider-enforced spending limit and cannot replace provider quotas or teardown.
Three closed negative probes require foreign-object 404, missing-CSRF 403 and
stale-version 409 without returning server error details. They are separately
reserved traffic, outside the approved sixteen-operation performance numerator.

Installer-only growth permits exactly 100 to 1,000 and 1,000 to 10,000 Employees.
It validates the manifest and real database marker/privileges, serializes on the
marker, reconciles exact population/session counts and bounded batches of canonical
token hashes and active actor ownership, and inserts only additional sessions in
one transaction. Existing cookies and Managers remain unchanged. A lost post-commit
manifest cannot authorize duplicate growth: mismatched counts fail closed. Growth
does not touch the SDK or provider control plane. New cookies remain private data.
The extended fresh-owner PostgreSQL test must pass before accepting these real SQL
growth contracts; native/mock tests alone are insufficient.

These source preparation modules do not establish a live target result. The
controller below still requires final-head acceptance and actual operator/provider
evidence before execution. Active-user cadence and provider cleanup remain separate.

## One-shot local campaign controller

`scripts/target-load-controller.mjs` is a local operator command using the existing
private LOAD namespace and manifest. It requires at least twenty-five minutes
remaining in the original lifetime, a starting population of exactly one hundred
Employees, separate Customer/Platform processes on the explicit representative1000
profile, and the exclusive run journal. It never allocates or deletes resources,
changes quotas/plans, deploys services or renews expiry. Its hard deadline remains
armed through local cleanup. The default production rate profile is unchanged.

Before HTTP traffic, the read-only installer reconciliation requires zero Requests,
references and revisions and verifies Tenant audit integrity and population custody.
Two first protected probes retain source/boot/limit identity. Thereafter snapshots
must have a closed aggregate schema, fresh clocks, monotonically increasing
counters, unchanged boot/limits and zero worker/storage failures. A changed boot
invalidates the run; no resumed in-process calendar acceptance is inferred.

The fixed sequence is ten bookings at one hundred retained Employees, growth and
ten bookings at one thousand, growth to ten thousand, one separate one-thousand
session read pulse, and the paced two-hundred-booking peak with the explicitly
modeled recurring-session window described below. Distinct Room slots
preserve earlier confirmed bookings. Sixty-one-second quiet intervals separate the
read pulse from preceding and following business traffic under the explicit global
rate profile. The pulse makes one read per distinct session over sixty seconds;
it is a separately labeled descriptive scenario, not an approved activity cadence
or proof of one thousand simultaneously active users with concurrent bookings.

The subsequent peak runs concurrently with a separately counted **3,000-read
activity scenario** over the same one thousand verified Employee sessions. This
declared modeling assumption uses a five-minute refresh cadence, a ten-minute
rolling inactivity threshold and three closed one-thousand-read waves, each with
200ms intended arrivals at offsets 0/300/600 seconds. The previous pulse provides
initial identity/activity proof, conservatively at most 180 seconds old when the
peak starts. Each wave must reverify all the same session/User/Tenant/role bindings
within 230 seconds. Conservative initial/inter-wave/final bounds then prove rolling
coverage throughout the entire intended 900-second peak without retaining or
publishing per-user activity timestamps. Delays, wave duration and warm objectives
remain actual measured values, not fabricated cadence success.

This defines a reproducible **modeled** active-user scenario, not an approved
universal business-activity definition or one thousand simultaneous HTTP requests.
The evidence retains that distinction and leaves owner approval false. The existing
sixteen booking operations remain unchanged. These additional three thousand reads
are explicitly separate background activity, never multiplied by the booking
coefficients or relabeled as part of that numerator. Twelve refresh workers reserve
four of the transport's sixteen slots for the booking workers. Both operations share
the same run journal, total attempt/body budgets, unchanged representative1000 rate
profile and absolute expiry. Either side's failure cancels and drains its peer before
cleanup or later probes; there is no retry. Whole-process peak deltas are explicitly
marked as including this concurrent session work, not pure booking/worker cost.

Each booking phase reconciles its exact simulated calendar and SDK read counts and
bytes with the manifest. Fixed foreign/CSRF/stale-version probes must return
404/403/409 without calendar/storage work. Final read-only SQL requires all 220
Requests Confirmed at version3, exactly three revisions per Request, active
fixture references, correct transition actor/correlation/price evidence, all ten
Tenant HMAC chains, the exact retained population and a drained projection outbox.
It waits at most thirty one-second drain observations and returns counts only.
The fresh-owner PostgreSQL test covers both empty preflight and post-growth
reconciliation against actual restricted-role booking state.

The fixed mode-0600 evidence file is reserved exclusively before the controller
starts. It contains allowlisted aggregates, exact-source/run/boot identity and
original expiry, without cookies, Tenant/actor/Request IDs, SQL or provider
credentials. Failed execution produces a failure record; missing evidence never
becomes success. New growth cookies remain in controller memory, and neither a
failed run nor its consumed journal may be resumed to obtain a fresh budget.

Warm p95/p99 objectives are evaluated without modifying observed latency. Peak
completion must independently fit inside fifteen minutes; scheduled arrivals alone
are insufficient. CPU deltas cover each whole process, including observation
overhead, not pure worker CPU. The first protected probe is not a verified cold
state. Actual monthly costs, Graph acceptance, simultaneous active-user capacity
and provider cleanup remain explicitly false/unproven in this machine evidence.
Independent control-plane identity, actual provider metering and attributable cost
modeling, owner cost acceptance and final recovery are still required.

## Verification and remaining execution

### Optional isolated Render execution host

The local workspace cannot assume direct DNS/TCP access to Neon or the target
services. `scripts/target-load-operator.mjs` supplies an explicit, temporary
execution-host mode on a **third, separately named Free web service**, not a paid
worker or a production topology change. No provider resource is allocated by this
source. Final-head native, PostgreSQL, browser, review and independent Main gates,
private budget/isolation evidence and a feasible suspend/cleanup path remain
mandatory before creating it. Do not upgrade a suspended Free service automatically.

`LOAD_OPERATOR_MODE=render-one-shot-v1` is the only installer exception to local
execution. It validates the real Render repository, Main branch, immutable actual
commit, web-service type, exact `cm-saas38-load-RUN-operator` name, external HTTPS
origin/hostname, original run scope and a distinct 43-character operator Bearer
token. It never strips `RENDER` or changes database TLS. Normal Customer/Platform
target entrypoints explicitly reject this mode and token. Existing Demo and
production entrypoints, credentials, plans, deployments and source pins are outside
this execution host's responsibility.

Only the restricted SQL-created installer role for the new empty target database
enters the operator. It must have no elevated attributes, role memberships or
authority over any existing project. Neither a Neon API/root credential nor either
runtime password is installed there. The original maximum two-hour lifetime begins
at resource creation, includes deployment/setup/waiting and is not renewed on
restart. At least fifty-five minutes must remain at operator startup.

After one canonical setup, the operator retains the synthetic manifest only in
memory and creates the installer-owned temporary
`public.saas38_load_operator_gate` relation. Runtime roles have no grants on it.
It publishes fixed `waiting` status, then polls every five seconds for at most
forty-five minutes, preserving twenty-six minutes for the existing campaign. Before
release, independently verify both new services' actual deploy/source identity,
Free plan, endpoints, limited SQL roles, exact private bucket/credential authority,
media probe, original expiry and representative1000 profile. The separate provider
SQL control plane may then update only the matching unexpired run/release gate's
`ready` flag. No HTTP request can release the gate, mutate data, submit workload
parameters, execute SQL or allocate resources. The marker blocks reseeding after
restart, including loss of the ephemeral journal/manifest. Unexpected restarts
invalidate this one-shot run; no automatic retry or new budget is allowed.

The public exact-Host `GET /__load/health` returns fixed liveness only. Protected
exact-Host `GET /__load/status` reports a fixed phase and, after completion, the
controller's minimized aggregate evidence, bounded at 65,536 bytes. No cookies,
database URLs, provider keys, raw errors or manifest are returned. It uses the
existing production security headers, no-store caching, method/body/header bounds,
five-second HTTP timeouts, sixteen connections and 120 status attempts per minute.
Status reads are legitimate observation of the running experiment, not evidence of
active-user capacity. A failure remains fixed `failed`; a completed measurement
whose objectives are false remains measured with those false outcomes. The
process stays observable until explicit suspension or original expiry. Its hard
exit stays armed through asynchronous setup, campaign and shutdown.

The extended fresh-owner PostgreSQL test must prove the explicit operator setup
path, actual gate release through setup custody, Customer denial of gate read/write,
canonical booking, 100→1,000→10,000 growth and final reconciliation. Native tests
prove configuration negatives, exact Host/auth/method/body/expiry handling, fixed
failure output and one-shot phase/cookie custody. These are source/CI contracts,
not a hosted Render/Neon run or invoiced cost proof.

Before expiry, retain the protected aggregate result privately, read attributable
provider usage, suspend **all three newly marked services**, revoke the new object
credential and suspend the new database endpoint. Never suspend an existing Demo
or raise paid capacity. Resource deletion follows the provider's separate
confirmation requirements after evidence retention. Process expiry does not stop
storage billing; verify provider state independently even after failed execution.

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
