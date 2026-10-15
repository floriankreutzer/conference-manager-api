# Private Product & Delivery projection

Tracking: application #298. This source contract is separate from Provider/FinOps,
technical HTTP availability and release acceptance. A source merge is not evidence
that the view or its data sources are deployed.

## Access and ownership

The Operations Demo owns `GET /api/v1/platform/demo/product-delivery`. The existing
request-bound owner-password capability and traffic gate run first. Customer roles,
role headers, health access and caller-supplied Tenant selectors grant no access.
The route is read-only, no-store, bounded to 64,000 response bytes and performs no
database/provider query. Unsupported methods return 405; query/body input returns
400; unavailable projections return a minimized 503. Public Demo mode has no private
projection. Configuring a snapshot without the password perimeter fails startup.

This temporary shared-owner boundary is not Production Platform identity/RBAC.
Production composition and Customer composition do not load this adapter. Existing
session, CSRF, Tenant, audit, migration and three-customer contracts remain unchanged.

## Collection baseline and trust

The initial implementation is an **operator snapshot**, not an automatic collector.
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
| onboarding_started/completed | Platform audit: verified first onboarding entry / initial completion; exclude invitation resends and later reactivation |
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
