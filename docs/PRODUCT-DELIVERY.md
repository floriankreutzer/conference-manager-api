# Private Product & Delivery projection

Tracking: application #298. This source contract is separate from Provider/FinOps,
technical HTTP availability and release acceptance. A source merge is not evidence
that the view or its data sources are deployed.

## Access and ownership

The Operations Demo owns `GET /api/v1/platform/demo/product-delivery`. The existing
request-bound owner-password capability and traffic gate run first. Customer roles,
role headers, health access and caller-supplied Tenant selectors grant no access.
The route is read-only, no-store and bounded to 64,000 response bytes. Its Demo v2
Product projection reads a closed, bounded database aggregate; it performs no
provider request. Unsupported methods return 405; query/body input returns
400; unavailable projections return a minimized 503. Public Demo mode has no private
projection. Configuring a snapshot without the password perimeter fails startup.

This temporary shared-owner boundary is not Production Platform identity/RBAC.
Production composition and Customer composition do not load this aggregate adapter.
The existing session, CSRF, Tenant and audit authorization boundaries retain their
ownership. The versioned migration and three-customer reset gates remain mandatory.

## Runtime Product v2

`src/demo/platform-main.js` now binds the existing Product route through
`createDemoPlatformComposition` to `createPostgresDemoProductRuntimeRepository`.
The legacy environment snapshot still receives strict configuration validation;
it is no longer the active Product source in this runtime composition. The v1
loader, stored daily reports and offline compiler remain compatible consumers of
the earlier contract.

This is a deliberately closed Demo system aggregate behind the existing private
owner capability. It accepts no Principal, Tenant selector, arbitrary query,
external record or caller-supplied clock. It does not manufacture an operator or
borrow a Tenant User's audit permissions. Its DB binding must match the current
database, the recorded Demo Platform role and the shared-Demo sentinel. It reuses
the already configured Tenant and Platform HMAC keys, without new credentials.

Each GET takes the existing shared reset gate and a read-only Repeatable Read
transaction. It verifies complete retained Tenant chains and the complete retained
Platform sequence, signed checkpoints and terminal chain state. Shared verification
primitives also serve the existing authenticated audit repositories. Source reads
are capped at 100 Tenants and 2,000 retained audit rows in total; Tenant rows consume
that fixed budget first. Revision attribution has a separate 2,000-row ceiling.
SQL reads have a decreasing eight-second budget; connection and reset-gate bounds
remain owned by the existing database configuration. Overflow is reported as
`source_limit`, never as a silently truncated count. Per-source savepoints let a
failed independent source remain unknown while verified sources still contribute.
No long-lived result cache survives a source failure or Demo reset.

Demo overlay 011 grants Ops only `SELECT` on
`demo_product_request_revision_facts`. The view contains Tenant/Request keys,
version, operation, capture time, role-at-action and status, excluding customer
text, names, complete Request records and User identities. Ops gains no base-table
access to `request_revisions` or `request_workflow_starts`. A manager decision must
still match exactly one immutable revision and its verified Tenant audit event.

The same overlay creates `demo_product_source_epoch`, outside the business reset
inventory. An `AFTER TRUNCATE` audit-stream trigger advances this durable singleton
inside the existing reset transaction. Runtime roles cannot update, truncate or
invoke its controlled function. A failed reset rolls back the epoch with the data;
the shared gate prevents combining observations from different reset generations.
Only a digest of the epoch leaves the server. Its initial migration timestamp is
an activation boundary, not the origin of historical events: verified older events
inside the report window remain visible as an observed subset.

The pure wire contract is `src/observability/product-runtime-contract.js`, with
`schemaVersion:2`, `collectionMode:runtime_projection` and
`provenance.mode:retained_runtime`. It contains only Product metrics and their
coverage. `observedAt` is the database snapshot clock, `periodEnd` is that same
instant, and `periodStart` is exactly 28 days earlier, including the current partial
UTC day. Delivery and Feedback retain their own reports and clocks. A fresh
runtime Product read cannot freshen their stored data.

Each of the twelve ordered metrics has a parallel `productCoverage` entry with
`id`, `state`, `reason`, `sourcePeriodStart` and `sourcePeriodEnd`. States are
`complete`, `partial` and `not_collected`. Coverage dates describe the queried
extent; only `complete` asserts continuous source coverage for that extent.
Reasons are closed to `complete_window`, `retained_history`, `source_unavailable`,
`source_limit`, `integrity_failure`, `missing_attribution` and `missing_start_clock`.

| Metric group | Runtime evidence and coverage |
| --- | --- |
| Onboarding and submissions | Verified canonical Tenant claim / request-created / resubmission events and Platform onboarding-to-ready events. The whole queried window can be complete only when the durable source boundary predates it and retained verification succeeds. |
| Starts and explicit abandonment | Server-side `request.started` and `request.abandoned` events, sharing the future Request UUID with the first successful submission. Counts stay partial because older/API clients may omit the explicit start operation; an unfinished request is never inferred to be abandoned. |
| Time to submit | Median start-to-first-successful-create pairs for the same Tenant and Request. A resubmission cannot reuse the first start. Missing pairs keep an available subset explicitly partial with `missing_start_clock`; an empty cohort has no duration. |
| Manager decisions and decision time | Unique immutable Conference Manager role-at-action evidence. Missing attribution limits this group alone. A submission can serve one decision; resubmission starts a new decision clock. Available paired subsets remain explicitly partial when other pairs are missing. |
| Transition failures and recovery | Actual canonical failed transitions and allowlisted targeted Platform recovery executions. Previews, denials, global events and unrelated operations do not count. Recovery failure rate requires both outcome counts and a nonempty denominator. |

A verified empty retained scope can yield a numeric zero with its explicit coverage;
unavailable or unverified sources cannot. Missing group counts are null. A total
Tenant-plus-Platform source failure returns the existing minimized 503 response,
allowing the UI to label an older stored fallback separately. Raw events, actors,
Tenant/Request identifiers and revision records never enter the response; only
bounded metrics, reasons, timestamps and digests do.

Native tests cover positive partial counts, subset durations, missing attribution,
independent failures and the closed v2 wire contract. The PostgreSQL integration
test uses real start/Request repositories and signed audit chains created before
overlay installation, checks Ops grants, HMAC/checkpoint failures, row bounds,
actual shared-lock waiting, trigger rollback, and the real three-customer reset.

## Stored v1 baseline and operator extraction

The v1 implementation is an **operator snapshot**, not an automatic collector.
It does not create tracking events, replay sessions, read customer free text, fetch
arbitrary URLs or introduce another analytics service. Missing sources remain
unknown. In particular, client-only draft starts, abandonment and time-to-submit
have no trustworthy server start clock and cannot be supplied as known v1 values.

An authorized operator obtains normalized records from approved, integrity-verified
server sources. Tenant audit reads retain their complete-chain verification contract;
the compiler does not bypass it or authenticate raw records on the operator's behalf.
Source completeness must be established independently. A limited query, a reset
fixture, an empty newly created register or the first observation in 28 days cannot
establish complete historical coverage.

### Bounded authenticated workflow extraction

`scripts/support/workflow-extractor.mjs` is an operator composition port, not a
Customer/Platform runtime import, browser ingestion API or automatic collector.
It consumes the existing authenticated Tenant audit query, Request history and
Platform audit services; it does not read database tables directly or accept JSON
claims of verified integrity/actor/role. The caller must resolve genuine current
server Principals through their existing session/identity boundaries. Constructing
a Principal from a Demo selector is not Production authentication.

Tenant extraction requires both existing Tenant audit-read and Request-manage
capabilities, preserving their separate role ownership. Complete-chain verification,
Tenant scoping, denial evidence and immutable history cursors remain owned by the
canonical services. The Tenant UUID comes from the authorized Principal/context;
no independent Tenant selector is accepted. Platform extraction separately normalizes
and authorizes the Platform Principal before its independently verified/scoped audit
service reads. Neither domain grants access to the other.

The constructor requires a server-owned immutable source epoch and an authoritative
readback port. Bind that epoch to the actual database instance/reset generation;
never use a moving deployment label, browser value or operator-invented reset clock.
Readback must match before and after collection, otherwise extraction fails. This
detects a reset during pagination when the bound source advances its durable epoch.
The epoch, environment, Tenant and immutable record identity enter hashed source IDs;
actor identity, display names, arbitrary metadata and raw history never enter output.

Collection derives the existing completed-28-day UTC window from its trusted clock.
It admits one collection per instance, at most2,000 source rows in total,100decision
Requests,100-row audit/10-row history pages and a maximum30-second result deadline.
Nondecreasing clocks, strict descending audit IDs/revision versions, stable history
anchors and advancing cursors are mandatory. It never truncates or publishes partial
facts on denial, bad integrity, overflow, ambiguous decision history or changed epoch.
Timeout does not claim cancellation of an admitted service/database operation; the
existing dependency bounds still own cancellation, and another collection is rejected
until all admitted reads settle. No source operation is retried.

Successful request-created and Change Requested→Submitted audit events supply submission
facts; genuine transition failures exclude denials. Manager decisions require a unique
matching immutable `transitioned` revision with Conference Manager role-at-action,
Request identity, version, timestamp and terminal decision status. Cancellation/review
start do not count as decisions. Onboarding starts come from verified Tenant `tenant.identity.claimed` integration audit evidence with the first-entry flag derived atomically under the locked Tenant transaction.
Repeated claims while already onboarding and historical claims without this attribution remain excluded;
missing historical attribution cannot be represented as complete source coverage.
Platform reads apply the same half-open window in the canonical verified repository query,
so older retained history neither contributes facts nor consumes the page budget.
Platform mapping accepts onboarding→ready lifecycle events; reactivation is excluded. Only allowlisted canonical `tenant_recovery` executions count; metering reconciliation and Demo reset are excluded. Only actual targeted
recovery executions with success/failure count; previews, denials and unscoped/global
events do not become per-Tenant outcomes.

The returned closed compiler input always retains `productComplete:false`, no deployment
or feedback authority, and the original observation/window. A complete bounded query
does not prove historical retention, all-Tenant coverage or that every workflow emits
the required event. Existing compiler/conditional source-write contracts still own
aggregation, fact reconciliation and custody; extraction performs no source write.
Actual source-instance/session binding, collection operation and source-completeness
acceptance for real Pilot data remain #316. Native and real PostgreSQL source tests
must pass before accepting this technical extractor; it does not supply actual Pilot
outcomes, a new recurring job or a Production metrics-access permission.

The offline compiler reads at most 256,000 bytes from stdin:

```sh
umask 077
node scripts/compile-product-delivery.mjs < protected-source.json > aggregate.json
```

It accepts only the closed source schema implemented by
`src/observability/product-delivery-report.js`: schemaVersion, environment,
observedAt, periodStart/periodEnd, productComplete/productEvents,
deliveryComplete/deployments, feedbackSource/feedbackComplete/feedback. All timestamps
use exact UTC ISO milliseconds. The window is four consecutive seven-day UTC buckets
over 28 complete days, ending at UTC midnight on the observation date. Completeness
is separate for product, feedback and each application/API/website delivery source.

Limits are 2,000 product events, 2,000 deployment records, 2,000 total commit changes
and 200 feedback records. One deployment may contain up to the same 2,000-change total;
there is no separate 100-change ceiling that would reject a real 194-commit rollout.
The overall change/record ceilings and 256,000-byte CLI input bound remain independent;
never truncate a commit batch, split one deployment into fake deployments or mark a partial
change list complete to fit the limits. Unknown properties, sources, kinds, duplicates, invalid
clocks and contradictory commit/first-success metadata fail compilation without
printing source input or internal error details.

### Product normalization

Each normalized product event contains only source, immutable sourceId, kind,
occurredAt, Tenant UUID and targetId. Identity is derived inside the server-owned
compiler from source/record identity; request correlation is derived from the
normalized Tenant UUID plus targetId. Composite source identities must include the
source-instance/reset epoch where database keys can be reused; hash long composite
keys before import. Duplicate identities are rejected. Identical Request IDs in different Tenants
cannot supply each other's submission clock. These identifiers are never emitted
in the projection or general telemetry labels.

| Kind | Canonical source/context required before enabling completeness |
| --- | --- |
| onboarding_started/completed | Tenant claim audit for start; Platform lifecycle audit for initial completion; exclude invitation resends and later reactivation |
| request_submitted | Tenant audit: successful request.created or verified request_resubmit transition into Submitted |
| manager_decision | Request revision: authoritative Conference Manager actor context and terminal Confirmed/Rejected/Change Requested decision; exclude review-start and Employee cancellation |
| transition_failure | Tenant audit: actual failed workflow transition; do not infer task failure from unrelated HTTP/security errors |
| recovery_completed/failed | Platform audit: actual recovery execution outcome; exclude preview/denial and unrelated provider incidents |

The normalized kind is an extraction contract, not a browser-controlled audit action
or a newly emitted business event. Source mapping/coverage verification remains an
operator obligation until an authenticated collector implements it. The compiler
counts source events and computes median submission-to-decision time only when every
decision has its trusted matching submission clock in the window. A submission can
serve at most one decision; a later resubmission supersedes the earlier clock. Reused
or missing pairs keep the whole duration cohort unknown; the compiler never silently
reports a partial-cohort duration as complete. Product recovery failure rate is failed
recoveries / (completed + failed recoveries), only with complete outcome coverage and
a non-empty denominator; it is independent from deployment change failure rate.

### DORA calculations

Definitions follow [DORA's five measures](https://dora.dev/guides/dora-metrics/).
Calculate each service/environment separately; no developer ranking or blended score.
Only actual deployments reaching the named target environment belong in this input.
CI runs, failed builds and rejected deploy requests do not. A provider live label
alone does not prove healthy application readiness or change-failure causality.

Each deployment supplies source/id, component, artifactCommit, the complete bounded
commit-change list, deployedAt, outcome, failureAt/recoveredAt and rework classification.
Changes provide immutable commit, Git committer timestamp and independently established
firstSuccessfulDeployment (true/false/null). Check source history beyond the window
before claiming the first successful deployment; unknown history keeps lead time unknown.

| Measure | Reproducible calculation in each UTC bucket |
| --- | --- |
| Change lead time | Median commit-to-first verified healthy deployment duration across all qualifying changes, deduplicated by immutable commit |
| Deployment frequency | Count distinct actual target deployments, including impaired deployments; this is not an availability success rate |
| Failed deployment recovery time | Median change-caused impairment-to-verified-recovery duration, attributed to the originating deployment bucket; any unresolved or unclassified case prevents a complete recovery median |
| Change failure rate | Impaired deployments requiring immediate intervention / all target deployments, only with complete outcome classification |
| Deployment rework rate | Explicitly classified unplanned incident-remediation deployments / all target deployments, only with complete rework classification |

Zero denominators are unknown, not zero-percent success. Unresolved recovery counts
are retained separately. External provider outages are not automatically change-caused
failures. Demo observations are labeled Demo and never presented as Production results.

### Feedback and minimization

[Protected Operations source registers](OPERATIONS-SOURCE-REGISTERS.md) implements
the #319 Object Storage custody for normalized manual facts and minimized feedback.
It retains this compiler and its source/completeness rules, conditional writes and
independent provenance; a private local/export file is not the canonical register.

The approved protected operator register is the source of truth; an unconfigured
register remains explicitly unconfigured. Feedback input contains only opaque record
identity, date, closed category/workflow/severity/sentiment/state. Customer free text,
identity, arbitrary payloads and evidence URLs are rejected from the compiler input.
Details/evidence remain in the authorized protected source. Security vulnerabilities
retain the separate stronger security-response/severity process.

Only bounded totals, open/high-impact counts and closed category/workflow/sentiment counts enter
the projection. These remain confidential aggregates, not an anonymity guarantee.
Do not set feedbackComplete on a new/partial register to invent historical zero feedback.

## Snapshot, provenance and retention

Only the compiled aggregate belongs in `DEMO_PRODUCT_DELIVERY_SNAPSHOT`, never a raw
extract, credential or customer record. Source/actor/target identities are discarded
from output. The sourceDigest is SHA-256 of the compiler's JSON serialization of the
validated input object; eventCount is the number of supplied source records. This
matches the represented source-record total exactly when all sources are complete;
partial-source uncertainty is bounded by each source ceiling. The fingerprint
supports reproducibility against protected source evidence, not source authentication,
cryptographic attestation, telemetry completeness or independent verification.

Runtime validates the closed aggregate contract independently. The wire response adds
evaluatedAt, freshness, collectionMode and the explicit shared-owner access mode.
No configured snapshot yields honest unknowns, not fixture data or zero outcomes.
At 24 hours the observation is stale. At 30 days the server stops serving it and
clears its retained in-process aggregate on read. Operators separately remove/rotate
saved exports and deployment configuration within the retention period; no automatic
provider-history purge is claimed. Existing append-only audit retention is unchanged.

The UI uses the separate default-OFF platform.product-delivery flag, enabled only by
the approved Operations Demo presentation override. The flag cannot grant private
read access. Raw source data is never copied into browser storage, logs, public
documentation or metric labels. Refresh retrieves the saved aggregate; it does not
collect new source events or contact providers.

## Acceptance boundaries

### Immutable source and runtime pairing

The hosted frontend Gitlink, both `DEMO_FRONTEND_REF` values in `render.yaml`
and the literal frontend checkout in API CI must identify the same reviewed
Application commit. CI independently resolves and compares those refs; the build
also verifies the actual submodule checkout. The permanent three-customer/two-reset
acceptance checkout remains a separate immutable contract, not a moving branch.

Application CI pins the accepted Product/Delivery API foundation
`b7b4e7fb8a0cd9c47063536aaaf4259101d19942`, whose source tree equals merged API
`52924d9994f4ab08d8bce65b75a2c6153f5ba0c6`. That compiler/wire acceptance ref
has a different purpose from this API release's hosted frontend pin. Keeping these
roles explicit avoids circular cross-repository commit dependencies. A later
runtime-packaging commit must preserve the accepted API contract and pass its own
complete gates with the selected frontend.

After deployment, verify both origins' actual build-bound deployment metadata,
readiness and the private owner projection. Source pins, passed CI and signed
source inventories alone do not prove that either live service serves that pair.

### Functional and operational evidence

Compiler tests exercise all five formulas, empty/missing sources, duplicate/wrong
identities, first-success history, timestamp ties, cross-Tenant collisions, raw-content
rejection and actual bounded CLI failure. Real HTTP negatives exercise the existing
owner/traffic gates, forged Demo roles, fixed GET, query/body rejection and minimized
loader failure. Browser/locale/keyboard/reflow and exact counterpart CI remain required.

A protected feedback source, verified real-source extraction and actual Pilot outcomes
must be recorded separately. An unknown-state UI or synthetic fixture is not real Pilot
measurement, an automatic collector, Production identity, release acceptance or ISO certification.

## Optional daily connector feed

[Daily private Operations metrics](DAILY-LIVE-METRICS.md) defines the default-OFF
private-object feed. When enabled, it supplies both views without daily redeploys.
The legacy environment snapshots above remain rollout fallback; their original
contracts and limitations still apply. Daily Demo stock is not Pilot outcomes.
