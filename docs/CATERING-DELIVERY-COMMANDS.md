# Explicit Catering delivery commands

This slice adds bounded Manager enqueue/read commands on the schema049 custody
foundation. Existing-process execution is described in CATERING-JOB-EXECUTION.md;
an enqueue acknowledgement does not claim supplier transmission/confirmation. Historical released orders remain
untouched until an explicit authorized enqueue command.

`CATERING_DELIVERY_ENABLED` defaults false and accepts only literal true/false.
Enabling it requires `CATERING_ORDERS_ENABLED=true`. Demo activation is refused.
It grants no role or business authority and creates no jobs during startup.

## HTTP contract

- `GET /api/v1/tenant/catering/delivery-jobs`: at most20 jobs ordered by UUID;
  optional unique `afterJobId` and `orderId`,21-row lookahead and explicit cursor.
- `GET /api/v1/tenant/catering/delivery-jobs/{jobId}`: same minimized job projection.
- `POST /api/v1/tenant/catering/delivery-jobs`: closed schemaVersion1,orderId,
  expectedOrderVersion,expectedStateRevision,expectedQuoteRevision. Body4096 bytes;
  response65536 bytes or the smaller configured runtime ceiling. No retries.

All routes use the actual opaque session, active Tenant and Manager request:manage
policy. Unsafe methods require session-bound CSRF and same-origin validation.
Admin technical integration authority does not authorize business enqueue.
Unknown methods, fields, ambiguous selectors and GET bodies are refused.

## Transaction and idempotency

The shared Catering Manager write guard preserves Tenant UPDATE -> User SHARE ->
exact live Session SHARE lock order. The repository then locks the current order
state, checks the exact version/state/quote and approved decision, advances it to
queued, inserts one scoped job and appends signed business audit in one transaction.
The deferred database source predicate rechecks current Tenant/decider/security
version/Request/schedule/technical capability/quote expiry at commit. Failure rolls
back order state, job and audit together. No mutation is blindly retried.

The unique Tenant/Integration/Order/version/operation key converges concurrent or
lost-response enqueue. An authenticated repeat with the stored original state
revision and quote returns the same current job with replayed=true, without
reactivation or a second audit/write. A different source revision conflicts.
A new current order version cannot be confused with an older version's job.

Job responses exclude Tenant, actor, lease IDs, lease expiry, correlation,
credentials, raw provider payload, business content and supplier costs. Counts,
status, revision, source/order references and UTC clocks are positively validated.
Processing status is not delivery confirmation. Latest receipt/history presentation,
manual handoff and ongoing post-transmission receipt/status ingestion remain subsequent work.

## Validation boundary

Native progression/adversarial coverage exercises Manager/session authority,
closed projections, cursor bounds, exact acknowledgements, unsafe command fields,
transport byte/media/method limits, no retry and strict rollout dependencies.
The PostgreSQL integration case uses actual Customer SQL privileges, real session
and audit components and future controlled Confirmed Request fixtures. It covers
atomic audit rollback, concurrent replay, technical revocation, source conflicts,
foreign Tenant concealment and actual HTTP session/CSRF boundaries. It remains
unaccepted until executed in PostgreSQL18 and all configured exact-head gates pass.
No live supplier, paid worker, deployment or delivery-time promise is introduced.

All ten registered Catering routes use explicit bounded telemetry vocabulary.
This also repairs missing completion metrics for the existing configuration,
assignment and order routes; no Tenant/order/job identifiers become labels.
