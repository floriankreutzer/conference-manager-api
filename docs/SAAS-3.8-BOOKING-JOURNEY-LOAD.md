# Coherent isolated booking journey

Scope: source tooling for application #269/#270. Retain successful exact-candidate
PostgreSQL execution before reporting numerical measurements. Target Render capacity,
real Graph acceptance and real provider billing remain separate.

The choreography executes exactly sixteen HTTP operations per confirmed Request:
two role-bound session reads, two actual Room pages, three full attached-media reads,
two pre-submission availability POSTs, one schema-v3 create, four Request reads and
manager start-review/confirm transitions. It follows the real first-page continuation,
checks exact Tenant fixture Rooms/prices/media, image digests, session identities,
optimistic versions and immutable Request facts. Failed/late responses stop the
journey without retry or further writes; errors expose a fixed code and allowlisted
operation only. The injected transport must supply bounded I/O and cancellation.

The supplied transport accepts only fixed allowlisted operations on one explicit
loopback HTTP origin. It shares the process fetch pool, refuses redirects, bounds
JSON/images to 8 KiB/2 MiB and sets a five-second complete-operation deadline. It
cannot reach a remote target; do not relax it for deployment. A remote adapter must
separately enforce the target-scope and verified HTTPS-origin guards.

The disposable PostgreSQL18 fixture has ten synthetic Tenants, ten priced Rooms
each, separate Managers and 1,000 generated Employee sessions. Only external calendar
and object-storage ports are in-process fixtures. Actual Customer services, audit,
booking references, capability health and object metadata/integrity paths remain.
Uploads use the normal Manager/CSRF sanitizer/publication path. The retained first
three canonical image sources cycle across Tenants; each journey reads its one
attached image three times with full bodies, without an inferred cache/popularity mix.

The integration test runs 200 distinct-slot journeys with sixteen concurrent clients
and a fixed sixty-second replay deadline. This is a compressed unpaced campaign, not
the actual 900-second peak. It retains 1,000 Employees but only 200 Employees and ten
Managers participate in the measured booking phase. A separate 1,000-session pulse
is excluded from the sixteen-operation count. Neither establishes a cadence or
1,000 simultaneously active Users in the booking phase.

The real projection worker runs concurrently using its durable outbox/LISTEN path
and a separate four-connection pool. Record Customer SQL traffic over the HTTP replay
and worker traffic through its separately named bounded drain. Require an empty
outbox, no worker error, 200 active fixture calendar references, 600 immutable Request
revisions, exact transition actor/target/state correlations and valid Tenant audit
chains. Foreign reads, missing CSRF and stale confirms must not change calendar work.
Worker SQL/dispatch counts do not isolate worker CPU in the shared test process.

Cold starts, actual provider latency/SDK concurrency/egress, hosted process resources,
the paced peak, independent active-User sensitivity and attributable monthly costs
remain required execution work. No normal runtime, business schema, Demo seed,
deployment, provider credential/resource, plan or quota is changed by this tooling.
