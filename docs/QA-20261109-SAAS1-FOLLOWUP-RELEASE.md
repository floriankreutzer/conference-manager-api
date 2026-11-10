# Protected SaaS1 QA follow-up release — 9 November 2026

Jira: CO-320, with CO-306, CO-315, CO-317 and CO-296. Frontend PR479 integrated
the scoped PR475–478 changes; PR481 adds the Guest pagination correction.
The current API Main baseline
includes PR404's bounded readiness diagnostics, PR406's Scope Revision source
and PR407's reconciliation of the readiness runbook. This source preparation is
not a live release, a passing Main receipt or full Product Acceptance.

## Prepared source candidate

| Input | Prepared selection |
| --- | --- |
| API source baseline | `4b356b016c2632b5cdfc8a09515e4ffa7179fdd4` |
| API baseline Main qualification | [42720208847](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42720208847); verify its terminal results independently |
| Protected frontend F | `28a864ea6b1d4f5ae0e0066a072f6012e059358d` |
| Frontend tree | `5ec76c98c20bcbbe06cfe582c9578ceeafbccf68` |
| Frontend candidate | [PR481](https://github.com/floriankreutzer/conference-manager/pull/481) |
| Candidate native run | [42759055183](https://github.com/floriankreutzer/conference-manager/actions/runs/42759055183), pending at this source-preparation checkpoint |
| Actual Guest print H | `e815c4669880295aac88429e002742e95ac969c1`, tree `0ee417b9df76258885dd6505dd48db6ff36b4756` |
| H native print evidence | [42760165795](https://github.com/floriankreutzer/conference-manager/actions/runs/42760165795), success on 10 November at 05:10:35 UTC; bounded scope below |
| API release source R | The actual published source commit containing this selection; record after publication |

This candidate changes only `vendor/protected-frontend` and the source-selection
documentation. It may be prepared while qualification is pending; this does not
qualify F or authorize artifact/configuration application. The initialized
frontend must be its own clean checkout at F, not an API-directory fallback or a
copy of another worktree's uncommitted files. Local preparation may use an already
authorized local frontend repository without network access. Provider delivery
still requires the existing authenticated Git-submodule access.

Do not run or attest the two real wrapper builds against a temporary local API
commit. First establish the actual published R, then use clean R/F checkouts for
both executions. A frontend correction changes F and requires a new source
selection and qualification; artifacts from an earlier F cannot be carried over.

The earlier F `88ed5f346ebb9ceb16625b96ebe0b662eeb9637a` remains a failed
qualification: [42722345572](https://github.com/floriankreutzer/conference-manager/actions/runs/42722345572)
passed 599 Chromium cases and 598 of 599 WebKit cases. The remaining Booking
Policies case lost the new numeric input after saving.

The superseded F `79127af1180cde18cb1e26351c74062d1fca4916` completed native
[42740576995](https://github.com/floriankreutzer/conference-manager/actions/runs/42740576995)
with 605 cases per engine, including the six owner-focus and six reflow cases.
Its [authentic P2 review finding](https://github.com/floriankreutzer/conference-manager/pull/479#discussion_r4520403143)
identified independent CSV action state overwritten by Room price-save unlock.
F0b incorporated the correction coordinating that state with the save's
interaction lock. The current F28a selection inherits it and requires its own
candidate, review and separate Main gates.

API candidate `972d0b23368e0dfedf86bd997967ec608d518e0d` completed
[42741215694](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42741215694)
with F791 selected. These historical results do not qualify the new F/R pair;
the actual published successor R requires its own native checks and review.

## Guest pagination correction and bounded native evidence

The superseded F0b `0b89158a98332415a7bdfe4d74c6a6bb945dd055` completed its
candidate and Ready qualification in
[42746409149](https://github.com/floriankreutzer/conference-manager/actions/runs/42746409149)
and [42751385932](https://github.com/floriankreutzer/conference-manager/actions/runs/42751385932).
PR479 merged as `cd935478e9c441e6bbd5bddb36b1090d70554124`, retaining tree
`b962db71e4df7a17dd01139cd4c3f040d38b80ac`; its separate
[Main run 42755296589](https://github.com/floriankreutzer/conference-manager/actions/runs/42755296589)
passed. These frontend results remain historical qualification of that source.

API R6a `6a3d2e9a17299bba31d81e77b6f41d79ec35c91b`, tree
`7cca9a6a4e8a09e98fe4faf16567b07da00edde7`, selected F0b and passed all nine
required contexts in
[42747788349](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42747788349).
The [retained qualification record](https://github.com/floriankreutzer/conference-manager-api/pull/405#issuecomment-6758414597)
records its completed exact-R6a review without findings. These results do not
qualify a successor R/F pair.
No two-wrapper-build or deployment result is claimed for R6a/F0b.

Original H `74589584b5a8c24b6a8120ef20bbf9caf23b6a70` still failed
[42751545181](https://github.com/floriankreutzer/conference-manager/actions/runs/42751545181)
with `PDF_PUBLIC_FIELDS`. Its first actual PDF, SHA256
`ba44a9813239ff23bb9cd34e43c1a46d43c1a165997b89d42a8bb94b5d214da3`,
visibly clipped content at the page boundary. The independent original-PDF
[diagnosis 42756981227](https://github.com/floriankreutzer/conference-manager/actions/runs/42756981227)
found only nine complete fields even in content-stream order. It did not
reclassify H745 or qualify the missing three PDFs.

Current F28a adds print-only grouping and an exact A4 group-height check. The
separate H successor uses content-stream extraction for the unchanged complete
ten-field/whitespace-only predicate; it retains every privacy, A4, nonempty-page,
PDF/raster, source, TLS, sandbox and cleanup gate. H run 42760165795 passed
1086 baseline tests, zero-vulnerability audits, all four original DOM captures,
all six native TLS cases and four actual GTK PDFs, each with two A4 pages.
All eight original page rasters were reviewed for the observed clipping and
complete text/card boundaries. The source-bound Guest receipt SHA256 is
`c5e015e6b70e002bdcf498a754ab223fc3879b9e9944d9960a42c063640261f8`.

That actual GTK evidence has the exact F28a/H sources above. It does not replace
F28a's full candidate/review/separate Main gates, independent Chromium PDF
qualification, the successor R's own checks, two real clean-source builds or
later configuration/provider acceptance. Older artifacts and the unexecuted
build preparation bound to R6a/F0b cannot qualify the new pair.

## Source and configuration sequence

1. Qualify the integrated frontend at its exact published head and its separate
   merged Main. Require quality, dependency/security/source evidence, both full
   browser engines, both protected engines and the permanent three-customer,
   two-reset acceptance. Review the actual DE/EN multipage PDF originals,
   including every page, complete public text and all card/WLAN frame edges.
   Keep actual Chromium and WebKit print/export evidence separate: a WebKit
   print-media screenshot does not prove an actual WebKit or Safari PDF export.
   Preserve failed and superseded runs with their actual results.
2. Commit the protected frontend Gitlink and source-selection documentation as
   an API source candidate. Record the actual published source commit as R and the
   Gitlink's exact frontend commit as F. Do not change the legacy Demo Gitlink,
   counterpart acceptance pins, runtime contracts, dependencies or migrations
   as a release shortcut. A different current Main must be reconciled first.
3. Execute `scripts/render-build-protected.mjs` twice from genuine clean API R
   and initialized frontend F checkouts using Node 22 and the existing explicit
   INT profile. Require identical Customer and Platform manifests. Use the
   independent API artifact reader to verify every sealed file, its length,
   digest, content type, inventory and source/profile binding.
4. Prepare a subsequent configuration commit selecting immutable API R,
   frontend F and both independently verified manifest digests together in
   `render.int.yaml`. The API source cannot contain its own commit hash: do not
   replace R with the later configuration commit or let a mutable Main ref
   satisfy the literal source guard. Complete that candidate's and Main's
   required native gates before applying it.
5. Create a new release branch at exactly R. Verify an active rule for that
   exact branch prohibiting updates, deletion and force pushes, with no bypass
   actors. The rules for earlier release branches do not cover a new branch.

## Exact functional counterpart comparison

Frontend F's CI pins immutable API
`2b9a7f4fbeaba3688877d045337a1c00e3eda5de`. Comparison with the prepared API
baseline `4b356b016c2632b5cdfc8a09515e4ffa7179fdd4` gives:

| Scope | Verified comparison |
| --- | --- |
| Application and migrations | Complete `src/`, `migrations/` and `demo-migrations/` trees are byte-identical. All 167 existing `tests-db/` files retain their content; the separate Scope Revision database case is additional. |
| Dependencies and protected builder | `package.json`, `package-lock.json`, `scripts/render-build-protected.mjs` and `tests/render-build-protected.test.js` are byte-identical. |
| Legacy Demo and acceptance | `render.yaml`, `.github/workflows/ci.yml` and `vendor/demo-frontend` are unchanged. The API CI frontend remains `9158135fbf7db5db4a95a149314c39348c476942`, with permanent acceptance `3b1ecdf369e6c6daa2ef144f0319b4493a8dfe33`; these are distinct from protected frontend F. |
| Jira operator source | Bounded readiness diagnostics and the Scope Revision decision, publication, journal, runner and optional v5 SQL paths differ. Their workflow, restricted SQL activation, native execution and independent qualification remain separate from business application equivalence. |
| Changed tests | Six top-level test files and the Scope Revision fixture differ: readiness sweep/write, recurring observer, Scope Revision, decision reader and runner. `tests-db/jira-scope-revision.test.js` is the additional database case. Other test files retain their original content. |
| Release and observer selection | `render.int.yaml`, the protected frontend Gitlink, observer selection/plan, its recurring workflow and four documentation files differ. These select or document the earlier qualified release and current operator contracts; they are not identical deployment configuration. |

The application/configuration parsers remain identical, while the explicit INT
deployment pins differ. The INT diff preserves resources, origins, flags, start
commands and readiness paths. These comparisons establish functional application
equivalence for the two exact API commits, not repository-wide test equality or
native acceptance. Recheck the complete diff if another change reaches Main
before selecting R. The current source preparation itself changes none of those
runtime, acceptance or observer inputs.

## Existing deployment and rollback baseline

Readback on 9 November confirmed the existing paused Blueprint
`exs-daakihlg1s2s73df6jdg`, following Main at `render.int.yaml`, and both existing
services on branch `release/int-20261109-c146aea`:

| Input | Confirmed deployed baseline |
| --- | --- |
| API | `c146aeab3501b73d71d2fde70cb5b102d4d617a6` |
| Frontend | `83f883dbccd76a28050f1981c8431f18174f04e7` |
| Customer service | `srv-daakprhsrm7s73f82deg` |
| Platform service | `srv-daakprhsrm7s73f82dg0` |
| Customer live receipt | `dep-dbot1d6c6qcc738lsdi0`, 13:56:00.566Z |
| Platform live receipt | `dep-dbot1d6c6qcc738lsdg0`, 13:56:03.168Z |
| Customer manifest | `1ca0d18a0360677e32c1aff7d5e3c2f76b73d0faf4a6e7256adf156293fc5792` |
| Platform manifest | `dddd875ecd4655883452bb3286191df443a910ca5df80360852d876bc0faee28` |

The [earlier release record](QA-20261109-SAAS1-RELEASE.md) retains the actual
qualification and deployment evidence. Its receipts are not receipts for this
follow-up. Re-read actual provider state immediately before applying a new plan;
another task may have changed the deployed source in the meantime.

## Qualified application and verification

Use only the existing paused Blueprint and its two existing Free/Frankfurt
services with one instance, automatic deployment/previews off, current origins,
separate Customer/Platform start commands and their existing readiness paths.
The only intended plan changes are release branch, literal API source guard,
API/frontend runtime pins and the corresponding manifest digest on each service.
Preserve the operator-owned inputs, retained unlinked legacy environment group,
existing flags, service version and private Git-provider access. Presentation
flags remain build-command-only. A new resource, plan, secret requirement,
migration, initialization, reset or unrelated setting change is outside this
release preparation and must not be inferred from its source changes.

After all source, configuration, Main and exact-branch protection gates pass,
review the fresh provider plan and apply the verified changes. Inspect actual
deployment state before any additional deploy. Require both new successful
receipts, readiness and exact API build identities. Independently match every
served sealed byte, length and content type to the qualified Customer/Platform
artifacts. Exercise authorized Customer and Platform business journeys using
normal authentication; do not reset shared data to obtain a passing smoke test.

Record actual deployment IDs/times and the source pair in Jira only after
success. Reconcile the source-owned observer selection and its pinned frontend
in a separately qualified change. Never fabricate receipt IDs, derive runtime
trust automatically from the build output or report public readiness as a
persisted database observation. Observer scheduling, freshness and budget gates
remain independent.

If either rollout fails, reconcile actual provider and data state first. Restore
the accepted prior branch, literal guard, API/frontend pins and both matching
digests together on the existing services. Retain operator inputs and verify
fresh successful recovery receipts and served bytes. This release has no schema
rollback, credential rotation or data reset.

## Acceptance limits

The frontend screen contract maps all 27 design targets to implemented owners,
coverage and explicit contract/presentation differences. Those differences need
their own Jira disposition and actual comparison evidence. A code merge,
successful automated fixture, valid PDF, sealed artifact or live readiness does
not establish full Product Acceptance. Real zoom, representative screen-reader
and first-user checks, authenticated live journeys and the existing external
Microsoft/Exchange, isolated provider-load and final recovery gates retain
their separate acceptance requirements. Preserve already accepted architectural
and ownership decisions; do not invent missing API capabilities from artwork.
