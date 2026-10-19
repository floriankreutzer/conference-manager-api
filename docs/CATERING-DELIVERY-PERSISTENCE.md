# Catering delivery persistence foundation

## Implemented schema scope

Canonical migration 049 and Demo overlay 015 define scoped delivery job, immutable dispatch-intent and immutable
observation tables. Runtime readiness, operator wrappers, migration inventories and reset require
exact 49/15. Installation and reset enqueue or dispatch no orders and change no existing order data.
The worker from INTEGRATION-JOB-WORKER.md remains uncomposed; no delivery HTTP command, repository
processor, provider factory, credential lookup or external delivery is introduced by this schema.
Those application/runtime boundaries remain mandatory next work. No binding delivery window or
additional worker/cron/paid service is established.

## Scope and history

Job uniqueness binds internal Tenant, Integration, Order, order version and operation. Composite
foreign keys bind the exact historical order/operation, connection and Manager decision/quote.
The original order-state revision, source identity, creator and correlation cannot change. Mutable
job state uses positive compare-and-swap revisions; dispatch attempts are limited to 3 and automatic
reconciliation admissions to 10. Terminal evidence is retained. Due times and lease times are stored
as timestamptz; repositories derive them from database time, not browser clocks.

Enqueue requires a current queued order state immediately after the retained source revision and
the exact approved decision/quote, active Tenant/decider/security version, current eligible connection
and unchanged Confirmed future Request. The shared invoker-only
`catering_delivery_authority_current` function repeats source/quote/current-connection validation
before inserting dispatch intent. The application must additionally authenticate/authorize the
Manager and real session/CSRF for enqueue, serialize Tenant ownership and append audit atomically.
A database identity or successful helper call grants no browser capability.

Dispatch intent is inserted before advancing the job to dispatching. Its attempt number and lease
must match the locked job and current source authority. Expired or mismatched leases cannot insert
intent. Completed/failed/retry/reconciliation states must reference the latest immutable observation
for that exact attempt. Retry is structurally limited to retryable not-sent observations; permanent not-sent failures may
stop at the first attempt. An explicit bounded classification never treats unknown as retryable; unknown
dispatch/reconciliation state cannot return directly to queued. Application policy remains the
single owner of bounded backoff and classification and must fence every finish by lease/revision.

## Observations and ambiguous outcomes

Dispatch, reconciliation and expired-lease recovery observations are separate facts. An expired
dispatch lease can record unknown recovery; it cannot record a late ordinary success. A later
reconciliation uses a different live lease, and stale worker responses cannot overwrite it. Factual
observations remain recordable after business authority expires: they describe already-authorized
external work and must not be discarded or cause a new write. New dispatch still requires current
authority. Automatic reconciliation exhaustion retains unknown state. A distinct manual read lease can
record follow-up without resetting that budget or replaying a write. Its authenticated Manager
command and audit boundary remain required next; this schema does not expose such a command.

Normalized receipts contain exactly Order ID/version and the complete bounded position set, with
only pending/confirmed/rejected/substitution-proposed outcomes. Tenant-owned position identity,
count, uniqueness, scope and shape are checked against the sealed source. No price, substitution
approval, raw provider reference, URL, credentials, requester data or arbitrary provider payload
is accepted. Transmission acknowledgement and per-position business confirmation remain distinct.
The application must normalize provider responses before persistence and derive order presentation
from independently verified receipt facts; a succeeded processing job is not global confirmation.

## Custody and recovery

Customer receives job SELECT/INSERT/guarded UPDATE, history SELECT/INSERT and explicit EXECUTE on
the bounded read-only authority helper. Trigger entrypoints have no direct Customer EXECUTE. No
security-definer function is needed. Platform has no job/history/helper access. Reset has explicit
SELECT/TRUNCATE on all three tables, and the canonical reset inventory includes them. These grants
describe database process roles; application Tenant/object/session authorization remains mandatory.

Down takes exclusive locks and refuses any retained job, attempt, observation or delivery audit
action before restoring the exact prior audit allowlist and dropping only the added constraints.
Populated recovery requires a reviewed forward fix or restore decision. No evidence is purged by
runtime code. The existing signed audit taxonomy gains six minimized delivery actions; production
enqueue/claim/intent/result/recovery implementations must commit them with their owning mutation.

## Verification boundaries

The new PostgreSQL test creates actual Customer/Platform/Reset roles. It prepares a future synthetic
order through real application, opaque-session, configuration, Catalogue/ownership and audit
components, then exercises structural SQL custody: missing/stale approvals, foreign references,
duplicate jobs, lease expiry, technical capability loss, committed intent recovery, stale results,
receipt scope/null outcomes, append-only grants, populated/audit-only down refusal and actual
populated reset followed by empty down/up. The confirmed Request and provider outcomes are controlled
test fixtures, not live calendar/supplier acceptance. Presence of tests is not proof of execution;
current-head PostgreSQL 18 and unchanged permanent paired browser gates must pass before merge.
