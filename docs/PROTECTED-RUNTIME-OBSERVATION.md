# Existing INT deployment observation process

## Ownership and boundaries

This implements the deployment-observation writer owned by #113 for the existing
two-service INT topology. It is an offline deployment-owner process, not a new
Platform API mutation, application worker, authentication mode or provider runtime.
The normal Customer/Platform roles retain SELECT-only observation/mapping access.
No schema, grant, credential, lifecycle, entitlement, business or session change is
performed. DEV/PROD and arbitrary hosts are outside this first implementation.

The original `protected-int-runtime-observation.yml` runs only on explicit owner dispatch,
exact accepted Main and first attempt, in the existing protected deployment
environment. Debug logging is refused before private allocation. No schedule or
automatic retry is introduced. Dependencies and sealed browser bytes are prepared
before the existing offline database bindings are allocated; no signing key,
provider credential, customer identity or authentication cookie is needed.

## Approved selection versus observed evidence

The reviewed `selection_json` contains only public deployment metadata:
`environment=int`, exact `apiCommit`/`frontendCommit`, bounded `serviceVersion`,
Customer/Platform `deploymentReference`, `deployedAt`, `frontendSha256`, and the
four approved `evidence` references (`release`, `change`, `rollback`, `runbook`).
Missing evidence references stay null. Obtain deployment IDs/times from actual
successful provider receipts; do not invent them. The current protected epoch is
loaded from the existing private environment binding, never a public workflow
input. There is no Tenant selector, connection, origin, SQL, role or health-state
input. For the original one-shot workflow, the deployed API SHA must equal the exact observer Main SHA. Frontend
selection is additionally locked to qualified immutable commit
`2ddcf3859505fe62a46ac008fb1d6e9059711bbb`; changing that pin requires a reviewed
source change and renewed pair qualification. An arbitrary branch commit cannot
execute browser build code before subsequent offline credential allocation.

The selection declares expected deployments, not successful observations. The
collector rebuilds the immutable qualified frontend and validates both external
manifest digests with the canonical sealed-artifact reader. It then GETs every
allowed file from the two fixed existing HTTPS origins, checks exact bytes,
digest, type and status, and reads each actual API health/status endpoint last.
It rejects redirects, foreign destinations, cold HTML, oversized responses,
malformed/extra fields, wrong builds or versions. No token, cookie or business
request is sent. Four static requests per surface may run concurrently, with a
90-second overall cancellation signal and a 120-second maximum observation age.

The collector uses a private same-process receipt: serialized or fabricated
observations cannot be fed to the persistence port. A successful not-ready health
response remains not_ready. Public aggregate health has no optional-dependency
inventory; ready does not assert healthy Microsoft/mail/provider integrations.
Optional state therefore remains unknown, or degraded when actually reported.

## Persistence and routing

The writer verifies the separate configured offline role is both authenticated
session role and actual table owner; an application role, SET ROLE substitution
or another owner is refused. It compares the complete immutable migration ledger,
not only max(version), and holds the canonical shared INT execution lease plus a
single-observer advisory exclusion lock. Current epoch and DB clock are checked
inside the same transaction. Lock waits, query times and routing cardinality are
bounded. A stale/future observation is rejected without refreshing its timestamp.
The writer also refuses to exceed the existing 50-approved-deployment read
contract. Capacity/retention evolution is separate work, never silent deletion
of retained history or creation of a Runtime list that its reader rejects.

Both observations use the existing Runtime DTO's `test` environment (the mapping
of protected INT), distinct `render:dep-...` references, observed build IDs and
actual schema version. A reference's first deployment time/build identity cannot
silently change. Older/equal observations and superseded references are refused.
Frontend version/build use the verified immutable Git identity; no separately
unobserved semantic frontend release number is invented.
Missing evidence and optional observations still yield unknown in the existing
state model; this process does not manufacture a fully healthy release.

Tenant mappings are copied only from authoritative current INT classification:
REAL records, or active synthetic generations with matching current epoch and
active owner's security version, excluding archived Tenants. Unclassified and
other-environment records are untouched. Tenant traffic maps to the **Customer**
deployment; the Platform deployment is never substituted. Existing history rows
are retained across generation replacement. A mapping from another Runtime
environment is refused. All deployment and mapping writes commit together or
roll back together, including an injected failure after a real mapping write.

The output is a minimized deployment-process receipt containing observation UTC
time, schema version, counts and a source digest. It contains no routing IDs,
operator identity, epoch, connection or secret and is not presented as a signed
Platform business-action audit. Existing audited Runtime reads remain unchanged.

## Acceptance and limitations

Focused tests cover sealed-byte/API source verification, cold/foreign/malformed
responses, unknown versus not-ready health, schema/owner/custody fencing,
serialized-observation rejection, concurrent duplicate processing, actual rollback,
REAL/unclassified/other-environment separation, global capacity with colliding
references from another environment, reset-history preservation and
epoch rotation. Normal exact-source native and permanent Demo/browser gates remain
mandatory before acceptance. The writer is not activated merely by merging it:
first deploy the qualified pair, reconcile actual provider receipts/manifests, then
dispatch and verify the persisted/UI result.

Freshness remains the existing five-minute policy. The original one-shot process does not
promise continuous monitoring: observations correctly become stale unless a new
approved collection runs. Provider billing dashboards, protected Product/delivery/
feedback sources, invited Demo participants, actual email-code receipt, full
recovery and real Microsoft365/Exchange acceptance remain separate open work.

## Bounded recurring INT profile

Selection reconciliation on 2026-10-30 (INF-02): the checked-in selection now
matches actual live Render receipts `dep-dbibkggu01pc7397eb40` (Customer) and
`dep-dbibkjnlk1mc73fr97gg` (Platform), both on API
`ca1f06b5b5181965f7c3aeffdc235aa44c638771` and frontend
`2ddcf3859505fe62a46ac008fb1d6e9059711bbb`. Receipt completion timestamps are
normalized to JavaScript millisecond precision. Both public health/status routes
returned ready, the matching API build and `cm-int-20261021`. Independent sealed
frontend reconstruction matched both manifest digests in the actual Render build
logs. These are source/deployment observations, not proof of a database write,
scheduled event or current UI freshness. The previous selection is superseded,
not retroactively described as the current deployment. Activation still requires
the separate observer Main qualification and actual execution receipt below.

`protected-int-runtime-recurring.yml` adds a separately qualified, best-effort
operating profile. It uses the same collector, credential binding and transactional
writer; it does not add an HTTP write path, application timer, database role,
migration, provider resource or authentication/signing credential. Existing
one-shot dispatch restrictions remain unchanged.

The fixed reviewed selection in `scripts/data/protected-int-runtime-selection.json`
records the already qualified hosted API/frontend pair and actual provider receipts.
The **observer source commit** is a separate fact from the **observed deployed API
commit**. This allows an independently qualified offline workflow update without
redeploying unchanged application code or claiming the new observer SHA is live.
The collector still refuses any mismatch in actual hosted bytes, health build,
manifest, deployment identity or current database custody. Updating the selection
or frontend pin requires reviewed source and renewed qualification.

Activation is disabled by default. Set the repository variable
`CM_INT_OBSERVER_QUALIFIED_SHA` to the exact observer Main SHA only after the
candidate and separate Main gates, source inventory/attestation and current
deployment selection have been verified. The job refuses another repository,
non-owner actor/triggering actor, non-Main ref, a rerun, debug logging, unknown event,
missing qualification or a moved Main. No supplied selection, host, file path,
Tenant, health status, database selector or signing key is accepted. Clearing the
variable stops further execution; any Main change also requires renewed acceptance.
In-flight operations retain the existing bounded transaction/exclusion semantics.

Main now includes the service-identity migration 075 from API PR359. The observer
verifies the complete current migration ledger before writing; matching public
bytes and deployment receipts alone cannot qualify that database prerequisite.
Confirm the canonical live migration and its coordinated release acceptance before
activating this newer observer. This infrastructure change does not execute a
migration or relax the ledger check. Reconcile the fixed selection again if that
release replaces either deployed source or receipt.

Recurring traffic additionally requires repository variable
`CM_INT_OBSERVER_SCHEDULE_ENABLED=true`, checked both before runner allocation
and in the CLI. Missing/empty/false values keep scheduled collection disabled.
This separates exact-source qualification for one bounded manual observation from
permission for ongoing traffic. Set the schedule flag only after current workspace
hours, bandwidth, billing headroom and the existing owner budget are reconciled;
setting the qualified SHA alone must not reactivate a recurring cost source.
Clearing this flag stops new scheduled collection without blocking a separately
qualified owner manual invocation. It does not cancel an already running bounded
transaction or claim provider-level currency enforcement.

Automatic collection runs every five minutes **only from 09:00 inclusive to 19:00
exclusive Europe/Berlin**, daily. A UTC cron envelope and a local-time preflight
cover both daylight-saving offsets. Outside that window the scheduled run ends
before frontend checkout/build, database credential allocation or hosted traffic.
The final collector rechecks the window, so a queued/delayed run cannot start
collection after closing. Owner manual dispatch with the exact qualified Main may
collect outside the window. Do not use repeated manual dispatch to evade the
operating budget.

The job is limited to a public repository on standard GitHub-hosted runners. A
private repository skips it before runner allocation, including after the planned
repository visibility change; do not enable paid private execution as a workaround.
This temporary profile therefore does not provide ongoing private-source operations.
Scheduled Actions can be delayed/dropped and public inactive schedules can be
disabled by GitHub. The five-minute stale policy is unchanged: outside the window,
after provider failure, schedule delay, disabled qualification or a private-source
transition, the UI must show stale/unknown rather than a manufactured healthy state.

The operating window is a resource bound, **not a zero-cost guarantee**. Two Render
Free services awake for ten hours daily consume about 620 shared instance-hours
in a 31-day month before startup/other usage, against the workspace's published
750-hour allowance. The current complete sealed bytes total approximately 3.56 MB
per collection (about 13.3 GB over 31 days at 120 collections/day, before headers).
Verify actual remaining workspace instance-hours, bandwidth/build allowances and
configured spending controls before activation; existing other usage still counts.
No plan, quota, spending limit or resource expansion is authorized by this profile.
Provider billing freshness and protected optional/provider diagnostics remain
independent from successful runtime collection.

Acceptance must distinguish local context/window/credential negative tests, full
native and permanent three-customer browser gates, actual owner-dispatched receipt,
and an actual scheduled-event receipt. Workflow source or manual success alone is
not proof that a cron event ran. Verify observation timestamps, both deployments,
three current-generation Customer mappings and unchanged Demo business baseline
after operating execution. No invitation, email receipt or real-tenant issue is
closed by this runtime-only change.


## QA-10 reconciliation candidate — 30 October 2026

The fixed recurring selection is reconciled to the successful existing-service
receipts recorded in frontend issues #113 and #419: API `ca1f06b5b5181965f7c3aeffdc235aa44c638771`
and frontend `2ddcf3859505fe62a46ac008fb1d6e9059711bbb`. The Customer and Platform
manifest digests and deployment IDs come from those receipts; receipt timestamps
are normalized to the existing millisecond contract. They are deployment times,
not newly collected observation times. The deployed API and qualified observer
source deliberately remain separate identities.

This is a **draft reconciliation for that exact pair**, not collector activation.
The separate Recovery rollout tracked by frontend #426/#400 may supersede the pair.
Before accepting this selection, reconcile it again against the final successful
paired rollout receipts if that happens. Never infer deployed identities from Main.
Require normal candidate and independent Main qualification, then bind the existing
qualified-SHA variable to that accepted observer source. Only an actual successful
collection and independent readback can establish a new observation; a later
`schedule` event is separately required to prove recurring execution.

The five-minute freshness contract, 09:00–19:00 Europe/Berlin window, exact fixed
origins, all-byte evidence checks, shared exclusion, role/epoch custody and
zero-additional-cost boundary remain unchanged. No workflow dispatch, variable,
credential, grant, service, plan or deployment is changed by this source patch.
Provider subscription collection and Product/Feedback source activation are
separate from this runtime collector (see `PROTECTED-PLATFORM-INSIGHTS.md`).
