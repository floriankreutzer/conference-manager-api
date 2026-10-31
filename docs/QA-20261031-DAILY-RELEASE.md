# Protected OPS daily insights and consistent cards

Tracking: frontend #419 and #428; existing infrastructure #432 and observer #113.
Merge the coordinated wrapper selection in API PR366 and the implementation in
API PR365/frontend PR440 before this selection. Reconcile any concurrent provider
activation first. This document selects a candidate pair and its procedure, not a
deployment receipt. The earlier schema75 release and its actual receipts remain
historical evidence in QA-20261031-RELEASE.md and the current observer selection.

## Immutable pair and independently verified artifacts

| Input | Selection |
| --- | --- |
| API | `ded73b39be9101197150091c84ebfa879ec40575` |
| Frontend | `a930bb1fbbda3f3d5037ec9c016c756363c60ae6` |
| Release branch | `release/int-20261031-ded73b3` |
| Customer manifest SHA256 | `4d5a89ae1b429c8b6b0b71a18fc85903dc17b4889035210f0918f26d9f821b5b` |
| Platform manifest SHA256 | `20edadef605b3d6552e75e23b1eabb4870455400c42d1f28aba2d1a1d0c53f8b` |

The real authenticated-build wrapper built 300 Customer and 197 Platform files using these
exact source refs, existing INT origins and unchanged presentation flags. The
selected API artifact reader independently validated every file against these
digests. Actual insight/runtime API-to-production-client wire checks pass. Local
checks pass 991 frontend tests, 2,307 API tests and 17 Platform security tests,
including architecture/static gates and the live HTTP security smoke. Require all
exact candidate and independent Main checks, PostgreSQL and complete permanent
three-customer/two-reset Chromium/WebKit gates before deploying.

The API retains the accepted private-build and bounded-observer preparation from
PR364 and the wrapper path selected in PR366. The protected Gitlink selects the
frontend above. Render initializes it with its existing Git-provider credentials;
there is no anonymous clone/fetch fallback or new build credential store. The two
presentation flags remain build-command-only. Actual private-repository delivery
remains the separate agreed cutover acceptance.

The frontend's complete protected browser matrix is pinned to API d65e5c79. The
selected API ded73b39 differs only in the protected frontend Gitlink and its build
documentation: application, routes, tests, dependencies and build-wrapper code are
byte-identical. Exact selected-pair wrapper builds, artifact validation and actual
insight/runtime wire checks supplement its required API/Main gates. This does not
replace the unchanged permanent Demo counterpart or claim live/private acceptance.

## Coordinated operation

1. Reconcile current provider state and concurrent changes. Use only the existing
   paused Blueprint, its `main`/`render.int.yaml` source and both existing services.
   Preserve Free, Frankfurt, one instance, auto-deploy/previews off, start commands,
   readiness paths, origins, flags, epochs, database roles and secret custody.
2. After qualification, create the selected release branch at the exact API ref.
   Verify active exact-branch rules rejecting update, deletion and force push,
   without bypass actors. Do not deploy a mutable Main or an unprotected release.
3. Reconcile the literal build guards and frontend refs, selected service branch,
   both runtime source pins and each independently verified manifest together.
   Keep Blueprint auto-sync paused. Inspect its proposed changes before any sync;
   do not apply the legacy `render.yaml` or create additional resources.
4. Prepare the separate private daily reader only on OPS. Reuse approved read-only
   custody where available, otherwise issue a distinct branch-anchored
   `storage:read` credential. Do not rotate the existing collector's credential or
   use the default read/write credential. Install the complete five-key group
   documented in PROTECTED-PLATFORM-INSIGHTS.md through the private provider
   configuration, preserving all other values. Existing Blueprint `sync: false`
   keys are not installation instructions: updates retain existing values and do
   not prompt for missing ones.
5. No migration, initialization or reset is needed: schema75/overlay33 is unchanged.
   Apply configuration only when the service selects this qualified new source;
   the previous runtime must not receive unknown optional keys. A provider update
   may start a deployment. Inspect actual state before starting another deploy.
   Deploy the new API before using frontend queries requiring Providers v2 and
   Product v3. Verify both actual successful receipts and readiness.
6. Verify every served sealed byte against the prepared artifacts, then use the
   normally authenticated OPS UI to check current source dates, provider facts,
   independent Delivery/Product clocks and explicit absence of missing sources.
   Test compact Runtime history and aligned DE/EN cards at narrow/wide widths.
   The private raw daily report must not be exported to issues or CI artifacts.
7. Record actual provider IDs/timestamps only after success. Reconcile the observer
   selection and independently qualify its current Main before manual collection.
   Do not reuse old receipts or enable recurring execution merely because this
   deployment or one observation succeeds.

## Source behavior and limits

The existing daily collector and private object remain the source of provider
and global Delivery facts. This change adds bounded authenticated reads, not a
second collector or live browser access to provider APIs. Successful reads are
cached five minutes; a failed read retries no sooner than one minute. Original
observation clocks survive cache hits and failures. Last-good, stale, unavailable
and not-configured states remain distinguishable. See the owned source contract
for 24-hour freshness and 30-day expiry rules.

Only eleven global provider dimensions and the separately compiled Delivery
report enter this adapter. The five Demo activity dimensions cannot become
protected Product outcomes. Independent Product collection/installation, feedback,
missing metering producers and Recovery acceptance remain open until their own
evidence exists. No current collection or live rollout is claimed by this file.

If the new source cannot be read, inspect its minimized unavailable state and
credential scope/configuration. Do not fabricate dates, copy Demo counts, loosen
validation, replace all environment variables or reset business data. A rollback
requires the previous paired source/build/digests and removal of only the five
new reader inputs before starting an older runtime that rejects them. Preserve the authenticated
wrapper for a rollback to a later accepted wrapper release; use its matching
Gitlink and digests instead of reverting infrastructure decisions.
