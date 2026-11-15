# Protected SaaS 2 capacity-feedback configuration — 15 November 2026

Tracking: CO-299; live acceptance remains coordinated in CO-320/CO-326.
This configuration selects the shared Employee/Manager confirmed-booking
capacity feedback correction from frontend PR486 and API source PR420.
It is not a deployment receipt or Product Acceptance.

## Immutable selection

| Input | Exact value |
| --- | --- |
| Published API source R | `aa732f9765858343a8f82bff7bb7ed81d780b903` |
| API source tree | `e29e4322ea541aae2086c61e1b39196d6823c8c7` |
| Protected frontend F | `53fa27a6b994f1559327f9764a0825fbee2e2165` |
| Frontend tree | `39350b0361174930766b484cab7b386ca9fe5ddd` |
| Frozen release branch | `release/int-20261115-aa732f9` |
| Exact-branch ruleset | `27320963` |
| Customer manifest SHA256 | `95d3eacd3d92cefad28a597aa3f3219ca459030b8138e9afec2de9f7e323c01e` |
| Platform manifest SHA256 | `3a2a9cab3ab0ada3590e93baa4452a52515e3c76fca5f149a74fc4fbd349b886` |

R is the published source commit from
[API PR420](https://github.com/floriankreutzer/conference-manager-api/pull/420),
not its merge commit, the later configuration commit or current Main.
The [source record](QA-20261115-SAAS2-CAPACITY-RELEASE.md) retains the scoped
comparison with protected API counterpart A529, distinct from complete tree
equality. No application, migration, dependency, wrapper, legacy Demo or
acceptance contract changes are introduced by this configuration.

## Source qualification checkpoint

The following native executions passed before this configuration was prepared:

| Stage | Actual source and native evidence |
| --- | --- |
| Frontend candidate | F53fa; tested checkout `7bcc8ed4ed7fe613c470e21270bafc2500872976` has the same complete frontend tree. [CI43734193644](https://github.com/floriankreutzer/conference-manager/actions/runs/43734193644) and the later ready-state [CI43738270441](https://github.com/floriankreutzer/conference-manager/actions/runs/43738270441) passed. |
| Frontend Main | `058b1d74daad8df6ba7857e7a63ee15d83d1dd7d`, same complete frontend tree; independent [CI43742013237](https://github.com/floriankreutzer/conference-manager/actions/runs/43742013237) completed successfully at 18:07:48 UTC. |
| API source candidate | Raa732; tested checkout `15c686629dc910144ac95b1faf4e8ce4e1c6e3ca` has the same complete API source tree. [CI43736542353](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43736542353) and the later ready-state [CI43739231569](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43739231569) passed. |
| API source Main | `547f751dd51141898df3b6cca61af2f0834e5388`, same complete API source tree; independent [CI43742130008](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43742130008) passed all six CI jobs. |

Native secret scanning, source inventory/attestation and the applicable PR
governance checks passed at these stages. Frontend Main passed 1,092 Quality
tests, 615 cases in each full browser engine, both protected engines and the
permanent shared acceptance gate. The four new capacity cases cover DE/EN and
Employee/Conference Manager in each full engine. The shared acceptance keeps
its existing routing skips and separately executed actual zoom cases; no
blanket no-skip or physical Safari claim is made.

The API candidate passed 2,804 Quality tests, the complete 400-test database
suite and its separate setup, authority and elapsed-expiry checks, plus all
four shared browser/database/object-storage jobs. Its legacy acceptance
frontend remains independently pinned and is not the protected F53fa artifact.

PR420 was merged by concurrent repository work at 17:37:09 UTC, before frontend
Main completed. That chronology did not satisfy the source record's stated
pre-merge sequence and is retained as a deviation, not silently relabeled as
ordered qualification. All named source and Main gates had passed before this
configuration preparation; no check, review or provider gate is waived.

Configuration base `9e63f6b53260a83966448d55a009c6a36fc6ee49` also incorporates
PR421's Jira review-binding tooling, tests and documentation. Its three-file
change from API source Main does not change runtime files or the protected
Gitlink. Preserve that concurrent work and require its actual Main result and
this configuration's own full candidate/Main gates before application.

## Two clean builds and independent artifact checks

Two independent clean R checkouts, each with its own initialized clean F
submodule, ran the unchanged `node scripts/render-build-protected.mjs` under
Node 22.23.4 with locked dependency installs and lifecycle scripts disabled.
Both used the existing INT origins, synthetic mode, owner Customer access and
the existing build-only Microsoft/invitation presentation inputs.

The independent API artifact reader checked all four resulting artifacts:
every inventory entry, served byte sequence, length, SHA256, MIME type and
source/profile binding. Each pair of surface manifests was byte-identical.
Each artifact rejected an incorrect external digest and API identity; an
unlisted path returned no artifact. Source checkouts remained clean.

| Surface | Files per build | Sealed file bytes per build |
| --- | ---: | ---: |
| Customer | 315 | 2,337,930 |
| Platform | 197 | 1,525,393 |

These actual build/reader results do not establish provider delivery, a real
Microsoft/Exchange flow, physical devices, mail delivery or Product Acceptance.
Detailed execution receipts remain in the owning CO-299 evidence.

## Configuration and provider gates

Only five semantic values change on each existing service: release branch,
literal API build guard, API commit, frontend commit and surface manifest digest.
Preserve Free/Frankfurt, one instance, previews and auto-deploy off, origins,
service version, flags, start/readiness paths, all operator-owned `sync: false`
inputs and the unlinked legacy environment group. No resource, secret, reset,
schema change or new presentation capability is added.

Validate the final YAML with the official Render Blueprint schema using YAML
1.2 boolean semantics. Require an exact ten-value before/after semantic diff,
a rejected malformed boolean control and a literal source guard that accepts
R and rejects a different real checkout. Complete this final configuration's
native/security/review gates and separate Main validation before application.

Before a manual sync, re-read the frozen branch at R and its active exact-branch
rule prohibiting updates, deletion and force pushes with no bypass actors.
The existing paused Blueprint `exs-daakihlg1s2s73df6jdg` must continue to own
only the current resources through Main/`render.int.yaml`. Review the actual
provider plan for exactly the intended values on the existing Customer
`srv-daakprhsrm7s73f82deg` and Platform `srv-daakprhsrm7s73f82dg0` services.
Reconcile any unrelated proposed change before applying it.

Observe the actual deployment state before any additional deploy request.
Require both successful provider receipts, exact source identities, readiness
and independent matching of every served sealed byte, length and content type.
Then execute the authenticated DE/EN invalid-capacity/correction journey with
synthetic QA data and cancel the resulting QA booking. Reconcile observer and
live DAST selections separately only after those actual receipts are known.
Recurring observation remains off pending its own qualified selection.

## Rollback and acceptance limits

The complete prior R405/F26 tuple and digests remain in the
[10 November configuration](QA-20261110-SAAS2-CONFIGURATION.md). The actual
matching live receipts observed before this change on 15 November are Customer
`dep-dbsoc767bikc73c1bltg` and Platform `dep-dbsoc767bikc73c1bl00`.
If recovery is needed, first reconcile real provider/data state, restore that
complete tuple on these same services, preserve operator inputs and data, and
verify successful recovery receipts and served bytes. No data rollback or
credential rotation is part of this release.

Real-provider acceptance, independent security, recovery, physical Safari and
actual PDF acceptance keep their separate criteria. The source/configuration
records do not close those items or invent later provider/observer receipts.
