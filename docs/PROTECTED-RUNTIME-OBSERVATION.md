# Existing INT deployment observation process

## Ownership and boundaries

This implements the deployment-observation writer owned by #113 for the existing
two-service INT topology. It is an offline deployment-owner process, not a new
Platform API mutation, application worker, authentication mode or provider runtime.
The normal Customer/Platform roles retain SELECT-only observation/mapping access.
No schema, grant, credential, lifecycle, entitlement, business or session change is
performed. DEV/PROD and arbitrary hosts are outside this first implementation.

`protected-int-runtime-observation.yml` runs only on explicit owner dispatch,
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
input. The deployed API SHA must equal the exact observer Main SHA. Frontend
selection is additionally locked to qualified immutable commit
`2667b0b6df74ffa2632fce4be6f95ef8ef8103ac`; changing that pin requires a reviewed
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

Freshness remains the existing five-minute policy. This one-shot process does not
promise continuous monitoring: observations correctly become stale unless a new
approved collection runs. Provider billing dashboards, protected Product/delivery/
feedback sources, invited Demo participants, actual email-code receipt, full
recovery and real Microsoft365/Exchange acceptance remain separate open work.
