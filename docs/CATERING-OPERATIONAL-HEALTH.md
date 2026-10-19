# Catering operational health

Tracking: conference-manager#232. This component reads stored work; it does not
probe a provider, guarantee availability, start work or authorize a delivery.
The implementation is behind the existing default-off Catering configuration
flag. It is not a SaaS4 release, deployment or external provider acceptance.

## Authority and public contract

Tenant Admin with `tenant:integrations:manage` may GET
`/api/v1/integrations/catering/{internal-integration-uuid}/health`. The Customer
principal/session and known-Tenant guards derive authority; the application
policy rejects Manager-only, Employee-only, Platform and foreign scope. A known
onboarding Tenant may see its own disabled business state. Suspended, archived
and unknown Tenants cannot use this read. A missing scoped configuration is
concealed as not found. This endpoint accepts no query, body, provider URL,
credentials, Tenant override or command. Unsafe methods still pass the CSRF
boundary before method denial. JSON success is limited to 16 KiB and any
stricter configured response limit.

The closed schema1 result contains integration/provider identity, matching
configuration revision, UTC observation time, state, dispatch-enabled boolean (server delivery flag and configured support),
connection/Tenant-business availability booleans, bounded coverage, phase
counts, expired-lease count and oldest sampled open-job creation time. It
contains no order IDs, job IDs, actors, receipt/reference text, prices, provider
payloads or credential references. Availability means stored configuration
and Tenant lifecycle only; it is not network reachability.

## Bounded persistence and evidence precedence

A read-only repeatable-read transaction loads one scoped configuration and at
most1001 jobs using the existing Tenant/integration/order/version/operation
index. Every joined version state and manual head is Tenant-qualified. The
physical delivery operation comes from the canonical unsent-replacement helper,
so a new first physical order is counted using initial-order support even when
its business version operation is change. No migration, new index, all-history
COUNT, write, worker, timer, provider request or additional resource is created.

All returned private rows, including the extra coverage row, are validated.
Only the first1000 contribute counts. The stable index prefix is not a list of
the most recent jobs. More than1000 means incomplete coverage; counters and
oldest open time describe only that subset. An incomplete summary cannot be
reported idle. Historical settled work can occupy that subset; no claim about
unobserved backlog is permitted.

Manual transmission/receipt facts and completed delivery results take
precedence over the processing job status. A manually confirmed order whose
zero-attempt job remains queued/deferred is settled, not an unsent backlog.
Transmission without final confirmation is awaiting confirmation; partial or
rejected evidence is a business conflict. Unknown outcomes require
reconciliation. Active/expired reservations, processing failures, paused work
and superseded processing remain distinct. An expired reservation makes the
summary need attention without expiring, claiming or retrying that job.

States are attention, disabled, incomplete, manual_action, working and idle.
Attention takes precedence over disabled configuration so disabling a capability
cannot hide unresolved work. These are evidence summaries, never approval or
retry permissions. There is deliberately no healthy/available-provider claim.
Successful reads add no audit or business mutation; denied access retains the
existing minimized authorization audit behavior.

## Validation boundaries

Native policy/service/HTTP tests cover closed schemas, forged roles and scope,
manual-evidence precedence, incomplete1001-row coverage, impossible evidence,
getter rejection, UTF-8 response limits, default-off routing and bounded
telemetry. The actual PostgreSQL progression uses separate Customer, Platform
and Reset roles, opaque-cookie HTTP, foreign/revoked sessions, manual facts,
withdrawal, expired reservations, no read-side audit/dispatch mutation and the
canonical reset. PostgreSQL and paired browser acceptance must pass for the
exact candidate; test definitions alone are not execution evidence.
