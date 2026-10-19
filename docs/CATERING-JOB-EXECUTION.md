# Existing-process Catering job execution

## Scope and operating model

The default-off Catering delivery rollout composes the existing-process worker
with durable PostgreSQL claims, intent, recovery, observations and audit. Startup
checks due work immediately and polls every60 seconds while awake, at most25
admissions in a serial batch. Restart reconstructs work from database custody.
There is no paid worker, cron, self-ping, always-on service or delivery deadline.
Demo activation is refused and startup never backfills historical orders.

The production registry still declares only manual Catering. Its explicit empty
API-adapter resolver does not fabricate an adapter or credentials. Manual work
is retained as deferred with zero dispatch attempts; this worker does not export
PDF/CSV, send manual orders or attest actual manual transmission. Those commands
remain separate work. API-path tests use synthetic server descriptors/adapters
in isolated fixtures, never live supplier qualification or calls.

## Claims and authority

The repository locks Tenant before scoped job, using SKIP LOCKED. Enqueue and
configuration/audit writers use the same Tenant-first order. Claims persist a
unique30-second lease and explicit phase; processing is not browser-owned.
The immutable order snapshot and exact approved quote are independently loaded.
Current Tenant, Integration/provider/capability, Request/version/schedule,
approval/quote expiry and decider security version gate each new dispatch intent.
The descriptor and current capability mode must support API dispatch. API status
reads separately require current catering.status API mode and active connection
and Tenant; order API support alone grants no automated status polling.

Intent and attempt are committed before external I/O. The stored attempt budget
is3; network failures never replay the business write inside a batch. Trusted
adapters may classify a demonstrably not-sent failure; arbitrary exceptions and
malformed receipts are unknown. The shared failure/backoff policy schedules only
safe not-sent retries. A failed write is recorded as failed business state even
if approval expires during I/O. A later retry restores queued inside an authority
savepoint and rechecks the same current source at commit; ineligible restoration
is rolled back before job deferral. Known facts do not depend on a still-live
business approval. No fourth write is admitted.

## Recovery and factual observations

Expired pre-I/O leases can queue again. Expired dispatch/reconciliation leases
append unknown recovery and receive a new read lease, never another write.
Status reads send only scoped order identity and idempotency identity, without
conference contents or supplier costs. An unsuccessful read cannot prove that
an earlier write did not occur. Automatic reconciliation is capped10 admissions;
subsequent unknown results are parked for explicit follow-up. Source, capability
or adapter unavailability also parks work without false delivery success. A
parked/corrupt source does not prevent the rest of the bounded batch progressing.

Provider calls receive cancellation and a hard default10-second timeout. Even
an adapter that ignores cancellation produces an unknown observation instead
of an unbounded wait or write retry. Completed external facts are still persisted
when shutdown has already signalled cancellation. Shutdown waits for the active
fenced commit, then closes HTTP and persistence; the existing HTTP deadline is
unchanged. Admission requires actual runtime readiness. Metrics contain only
fixed aggregate processing outcomes and batch failures; logs expose a fixed
unavailability event, no Tenant/order/job references, raw errors or credentials.

Observation, derived order state and signed system-actor audit commit together.
Lease identity, phase, attempt and source scope fence stale results. Receipts
contain exactly the sealed complete position set and known outcomes; costs and
substitution acceptance are not receipt fields. All-confirmed, mixed-confirmed,
all-rejected and pending facts remain distinct business states. Succeeded means
the delivery-processing job obtained a normalized acknowledgement, not that all
positions are confirmed. Later status updates after a successful pending/partial
acknowledgement require separate versioned receipt ingestion; this retry worker
does not yet implement that ongoing polling lifecycle. Change/cancel/exception
version commands and original-effective-order retention remain separate work.

## Verification status

Native processor tests cover intent-before-I/O, no manual fallback, unsafe result
reconciliation at attempt3, proven not-sent retries, read exhaustion, minimized
read payload, cancellation and hard timeout. Runtime tests cover readiness,
aggregate telemetry, disabled dependencies and shutdown ordering. The unchanged
architecture gate rejected a separate concrete error module; delivery failure
classification now belongs to the public Catering provider contract.

The new PostgreSQL test is written and syntax/lint checked, not locally executed.
It uses actual Customer privileges and real configuration/session/audit/source
components, controlled future Request/descriptor/receipt fixtures, confirmed/
partial/pending outcomes, crash-after-intent restart, stale leases, safe due-time
retry, mid-flight quote expiry, audit rollback and actual Customer process startup
with manual deferral. Existing fixture defaults remain unchanged. Full current-
head PostgreSQL18 and permanent paired browser/storage matrices remain mandatory
before acceptance. No deployment or full SaaS4/live-provider acceptance is claimed.
