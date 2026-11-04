# Protected OPS daily-insights release candidate — 4 November 2026

Jira ownership: CO-81 (UI), CO-84 (insights/QA), CO-85 (deployment).
Engineering: frontend PR446 supersedes PR440; API PR376 supersedes PR365.
Both retain the earlier implementation history and integrate current Main's
Jira traceability and protected deployment identity. The October selection in
PR367 is superseded. This file is a candidate runbook, not live acceptance.

## Source pair and reproducible artifacts

| Input | Candidate |
| --- | --- |
| API | `863e8220b4aa5d3ef58946b1833550f78369dfb7` |
| Frontend | `17c28fb615264e6a2eccc7ed6e46d20171cb66e3` |
| Proposed immutable branch | `release/int-20261104-863e822` |
| Customer manifest SHA256 | `273679d3f7f18e8accb5df2aeaa3cf0716641fd7a3676a0cc0a60daa89ba20e6` |
| Platform manifest SHA256 | `7a566a28b8484b0f369d657bbf9feb3a5f6ba35c1559ac8ed36eaac5128858ad` |

Two real clean-source wrapper builds produced these identical manifests. The
independent API artifact reader verified all 300 Customer and 197 Platform files.
These local builds prove reproducibility, not provider authentication or delivery.
Frontend qualification pins API `0ef08b5eaec473a1458b8d22ecc5a798c20a81da`;
the selected API differs only in the protected frontend Gitlink and build document.
Application, tests, dependency locks and wrapper are byte-identical. The selected
pair additionally passed the actual insight API/client wire contract locally.

Merge and qualify both source PRs and independent Main, retaining the complete
PostgreSQL, three-customer/two-reset and Chromium/WebKit gates. Required checks
must finish successfully before release. If source selection changes during
merge, rebuild twice, verify every file, and update all pins together. Never copy
these digests to a different API or frontend SHA. Keep this configuration draft
until source, configuration and Main gates pass; local checks are not a waiver.

## Reconciled live baseline

Read-only provider verification on 4 November found both services on
`release/int-20261102-1b809b8`, API `1b809b8008cbd406172c11e689afea2eb1e72e4f`
and frontend `efe672ebaaa844f6663186b8a5d53a18ebab98a6`.
Customer receipt `dep-dbk82jgn74is73bmthrg` completed at 2026-11-02T12:26:52.752669Z;
OPS receipt `dep-dbk82lh2tl4s73f1mjug` completed at 2026-11-02T12:27:22.258366Z.
CO-294 accepted that pair's normalized Jira deployment evidence. These are the
baseline receipts, not receipts for this candidate.

The provider currently uses the literal inline-clone build, whereas repository
IaC already selects the reviewed submodule wrapper. This drift remains explicit:
do not silently revert the live pair or claim wrapper activation from merged YAML.
The candidate retains the reviewed wrapper decision and requires authenticated
provider/submodule preparation before switching. Preserve the current baseline
configuration for recovery. The connected Render tool cannot edit branch/build
settings; the Dashboard requires an authenticated session for that step.

## Apply only after qualification

1. Re-read the existing Blueprint and both services; retain paused automatic
   sync, Free/Frankfurt/one instance, disabled auto-deploy/previews, origins,
   readiness/start commands, flags, epochs, secret custody and database roles.
   Create no resource and perform no migration, initialization or reset.
2. Create the selected release ref only after source acceptance. Verify its
   exact active protection against updates, deletion and force pushes, with no
   bypass actors. An unused historical ruleset does not protect this new name.
3. Review the existing Blueprint plan. Coordinate the service branch, literal
   source guard, wrapper command, API/frontend runtime pins and each surface's
   manifest. Scope presentation flags to the build command only. Do not apply
   legacy `render.yaml`, replace services or discard omitted environment values.
4. Install the complete five-key daily-insights group on OPS only, as defined in
   `PROTECTED-PLATFORM-INSIGHTS.md`. Use a separate branch-anchored `storage:read`
   credential under approved custody; preserve the collector's credential.
   Never copy secrets into source, comments, artifacts or local report exports.
   `sync: false` does not install missing values on an existing service. Inspect
   current configuration before creating another credential or triggering a deploy.
5. Set the qualified source before adding keys an old runtime would reject.
   Environment updates may deploy even with auto-deploy off: inspect actual
   provider state before another trigger. Require both actual successful receipts.
6. Verify readiness, live source identities and all sealed bytes. In the normally
   authenticated OPS UI verify source dates, independent Delivery/Product clocks,
   last-good/unavailable states, compact Runtime history and aligned DE/EN cards.
   Do not download the private raw daily report for this acceptance.
7. Only after actual pair acceptance, publish normalized Jira deployment evidence
   through the existing fail-closed Main workflow with those exact source SHAs.
   Reconcile actual receipts in the source-owned observer selection; qualify its
   Main before bounded manual collection. Keep recurring observation disabled
   until its separate budget, runtime and schedule gates pass.

## Data behavior and remaining acceptance

The existing daily collector remains authoritative for eleven global provider
dimensions and separately compiled Delivery facts. The new reader checks that
private report at most every five minutes after success or one minute after
failure. It retains original timestamps, last-good data, 24-hour freshness and
30-day expiry. It does not create real-time provider facts between collector runs.

The five Demo activity dimensions never become protected Product usage. Product
collection/installation, feedback coverage, missing metering event producers,
eligible Recovery preview/cancel and the wider fifteen-screen acceptance still
require their own evidence. Do not close those scopes because this reader builds.

If rollback is necessary, re-read live/data state, select the accepted paired
baseline and its matching build/digests, and remove only the five new optional
reader inputs before starting an older runtime. Record fresh recovery receipts;
never relabel historical receipts as current or weaken the source/digest guards.
