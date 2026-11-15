# Protected SaaS 2 follow-up source preparation — 10 November 2026

Tracking: CO-320 and CO-322. This source candidate selects the bounded request
duration correction and the API's protected static COEP correction for later
paired delivery. It is preparation evidence, not a release approval, deployment
receipt or completed SaaS 2 acceptance. The original Safari incident's cause is
not established by the independently found frontend/API duration mismatch.

## Prepared source and actual tested identities

The following is the source-preparation checkpoint at 21:53 UTC on 10 November.
Pending gates stay pending here; subsequent outcomes require their own exact
source/run records rather than relabelling this checkpoint.

| Identity | Exact value and evidence |
| --- | --- |
| API baseline Main | `277f0356b2ea607811e5322bbce7206eb31bcb30`, the normal merge of [API PR411](https://github.com/floriankreutzer/conference-manager-api/pull/411) |
| API baseline tree | `451ed24c9b2bef1a99bbf5e1a0eac7618f029593` |
| API qualification counterpart A | `529c1fff7982ec334136c3b23ace2a7169dc6cbc`, with the identical complete tree |
| Selected frontend source F | `26e3a75bfa15f0a2ea1373e7f8e6ccc61a224dfc`, [frontend PR480](https://github.com/floriankreutzer/conference-manager/pull/480) |
| Actual frontend candidate CI checkout | `d4ee97f316ad7a71220dc220359e121fd1d9c474`, the synthetic PR merge checkout |
| Both frontend trees | `e5ff91c2ec543f71d48971f59c2c8484953b7043`; the source head and tested checkout are different commits with identical trees |
| Frontend candidate run | [42906433157](https://github.com/floriankreutzer/conference-manager/actions/runs/42906433157); complete regular/Shared qualification remains pending at this checkpoint |
| Frontend merged Main | Pending; record the actual merge, its tree relationship and independent terminal Main gates |
| API release source R | The actual published commit containing this selection; record its SHA/tree after publication |

The selected Gitlink is the immutable frontend source head F. It is not silently
replaced by the synthetic CI checkout or a future Main SHA. A further frontend
correction requires a new source selection and qualification; older artifacts
cannot be carried over.

## Completed evidence and its limits

API A's [native CI 42903780419](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42903780419)
finished successfully at 21:44:52 UTC, attempt 1. Its actual CI checkout was
`f299dd04d94d59ac11cb7411eec0e0e3a8b98e44`, whose complete tree equals A.
All six CI jobs and the separate Gitleaks, dependency-policy and inventory
contexts passed. Quality ran 2,775 tests, the isolated HTTP security smoke and
17 Platform HTTP security tests, with zero audit vulnerabilities. PostgreSQL
completed its full suite and the separate actual elapsed proof/code-expiry
case. These are repository/native fixture results, not a deployed DAST result.

The merged API baseline has its own
[Main run 42908156540](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42908156540).
Quality has passed; PostgreSQL and all four Shared rows remain pending at this
checkpoint. Its complete source tree is identical to A, but this does not
substitute for the separate Main execution.

The frontend's actual protected pair is A with checkout d4ee97f above.
[Chromium job 130146459400](https://github.com/floriankreutzer/conference-manager/actions/runs/42906433157/job/130146459400)
and [WebKit job 130146459484](https://github.com/floriankreutzer/conference-manager/actions/runs/42906433157/job/130146459484)
each completed five tests successfully. Their participant and owner receipts
bind both full commit SHAs. They exercise the actual protected roots, browser
custody and isolated MSAL/local-calendar fixtures; `actualMail=false` and real
Microsoft/device assurance remains unproved. They do not establish a native
browser run against later R or a real customer onboarding/handover.

The failed live [DAST 42881015589](https://github.com/floriankreutzer/conference-manager/actions/runs/42881015589)
remains failed historical evidence for missing COEP on both protected static
planes. Its finding is not allowlisted. Source/browser correction requires a
qualified immutable deployment and fresh actual live rescanning before that
operational result can be closed.

## Preparation and release gates

The existing [follow-up contract](QA-20261109-SAAS1-FOLLOWUP-RELEASE.md), section
Prepared source candidate, explicitly permits reversible source preparation
while frontend qualification is pending. This record uses that existing rule;
it does not change the acceptance policy or waive any gate. The normal source
PR may execute its own CI in parallel with the remaining frontend/Main work.

Before merging or approving R for release, require the complete frontend
candidate, review and separate merged Main gates, including both full regular
engines, both protected engines and unchanged permanent Shared/reset acceptance.
Retain the actual tested checkout and prove the selected F's complete tree
relationship to the merged Main. Require the API baseline's separate Main
qualification and R's own current-base review and native/security contexts.

Only after R actually exists as a published commit may two genuine clean R/F
wrapper builds and independent reader verification run as preparation. Never
attest a temporary local API commit or invent R's SHA. Record later results
against that actual published source. R's separate Main qualification, the
subsequent configuration candidate/Main, exact release-branch protection and
provider acceptance remain independent gates. A passing prepared artifact
does not authorize configuration or provider application.

## Complete functional comparison to A

The baseline Main and A have the same complete Git tree. Relative to that
baseline, this preparation changes only the protected Gitlink and the two
source-selection documents. Recheck the complete published A-to-R diff, rather
than inferring equality from a passing wrapper.

| Scope | Required comparison for this selection |
| --- | --- |
| Runtime, persistence and all tests | Every existing `src/`, `migrations/`, `demo-migrations/`, `tests/` and `tests-db/` entry remains byte-identical to A |
| Dependencies and sealing contracts | Package/lockfiles, the API wrapper/reader and their tests remain byte-identical; frontend builder source is the selected exact F |
| Existing release and automation inputs | Both render YAML files, observer selections/plans/workflows and all API CI workflows remain unchanged |
| Legacy Demo/acceptance | `vendor/demo-frontend` remains `9158135fbf7db5db4a95a149314c39348c476942`; permanent acceptance remains `3b1ecdf369e6c6daa2ef144f0319b4493a8dfe33` |
| Allowed source-selection delta | `vendor/protected-frontend`, this dated document and `docs/RENDER-PROTECTED-BUILD.md` only |

The wrapper enforces the actual R HEAD, clean API and frontend sources, exact F
Gitlink and explicit profile. It has no A input and does not itself prove A-to-R
equivalence. Any additional runtime drift requires renewed owning qualification;
do not extend the comparison by assumption. Native A/checkout-d4ee evidence plus
the reviewed derivation and R/F sealing must never be described as an executed
native R/F browser run.

## Actual R/F build preparation

Use the unchanged `node scripts/render-build-protected.mjs` in two separate
clean checkouts of actual published R, each with its own initialized clean
frontend submodule at F. Use Node 22 and the existing nonsecret INT profile:

- Customer origin `https://conference-manager-demo.onrender.com`;
- Platform origin `https://conference-manager-ops-demo.onrender.com`;
- synthetic and owner Customer access enabled;
- Microsoft and invitations presentation enabled only for the build command.

Supply the actual full R/F identities explicitly. The existing wrapper installs
locked dependencies with lifecycle scripts disabled. Require identical Customer
and Platform manifest bytes across both builds, then use the existing independent
API reader to verify every sealed file, length, digest, content type, inventory
and source/profile binding in all four artifacts. Wrong external manifest
digests and wrong API identities must fail. Record exact commands, Node version,
times, source clean state and both resulting digests; no new result is asserted
by this preparation document.

## Existing configuration and later delivery

`render.int.yaml` still selects source `15b4f45ccd834548344e3859ef39996a2f885ece`
and frontend `28a864ea6b1d4f5ae0e0066a072f6012e059358d`. The
[existing configuration/build record](QA-20261110-SAAS1-CONFIGURATION.md) retains
that pair's independently verified artifacts. Those old digests cannot qualify
this new selection. This source change makes no provider or observer mutation.

After all applicable source, Main and artifact gates, a separate configuration
change must bind actual R, selected F and both new digests together. Preserve the
existing resources, Free plans, origins, flags, start/readiness commands and
operator-owned inputs. Verify the exact immutable release branch and effective
rules before a reviewed provider plan. Record real deployment receipts and
served-byte/readiness results only after execution, then reconcile observer and
DAST selections through their own qualified changes. The existing release
runbooks retain the complete matching-tuple rollback procedure.

Real Microsoft/Exchange acceptance, the independent external security report
and the final actual provider recovery exercise remain separately tracked
requirements. This prepared source, native fixtures and later local sealing do
not close them or establish complete SaaS 2 Product Acceptance.
