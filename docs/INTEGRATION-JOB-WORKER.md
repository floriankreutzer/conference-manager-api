# Integration job worker lifecycle foundation

`src/integrations/job-worker.js` owns the existing-process polling lifecycle for an injected durable
job service. It is not composed into Customer startup and introduces no table, queue, provider call,
credentials, scheduler, always-on service or delivery deadline. The Owner-approved execution model
remains existing infrastructure only: process while awake and resume after restart/sleep.

The default interval is 60 seconds and the maximum batch is 25 jobs. Starting schedules an immediate
inspection of already-persisted work. Timer ticks and explicit run requests share one active batch;
overlapping ticks cannot create concurrent execution. Each admission goes through the injected
runtime readiness gate, which may invoke the service only once and must return its actual result.
Shutdown stops polling, signals cancellation and awaits active work before the caller closes its
database/provider dependencies. A pending readiness check cannot admit work after shutdown.

The result port contains only closed bounded aggregate completed/deferred/reconciliation/failed
counts whose sum cannot exceed the batch limit. These are job-processing facts, not supplier order
confirmation. No Tenant/order/provider references or raw error payloads enter worker telemetry.
Observer failures cannot change service outcomes. A failed batch surfaces one fixed error and is
never automatically replayed inside the same tick. A later tick invokes the durable service afresh;
that service must reconcile unknown writes rather than blindly dispatching again.

The next persistence/application increment must implement scoped atomic enqueue, unique lease and
attempt ownership, dispatch intent before external I/O, current order/quote/Manager/configuration
revalidation, stale-result fencing and audit-atomic completion. Only that implementation plus actual
PostgreSQL crash/restart/concurrency acceptance can establish durability. This lifecycle component's
native tests establish startup, serialization, readiness, shutdown, bounds and redaction only.

The domain-owned `catering-job-policy.js` derives a canonical idempotency identity from independently
loaded Tenant/connection/order/version/operation references. It rejects unknown or inconsistent
version/operation scope. Lease recovery returns only a proven pre-dispatch lease to queued; an
expired dispatch or reconciliation lease requires reconciliation. Application-owned
`catering-job-failure-policy.js` maps execution failure classification. The existing bounded delivery
policy remains the single retry/backoff rule: unknown writes reconcile even at the attempt limit,
rejected writes stop, and only explicitly proven not-sent writes may retry. These pure decisions
must be enforced by the durable repository and do not themselves prove persistence or authorization.
