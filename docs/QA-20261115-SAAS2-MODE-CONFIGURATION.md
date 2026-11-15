# Protected SaaS 2 mode-corrected INT configuration — 15 November 2026

Tracking: CO-299 / CO-320 / CO-85. This is a **candidate configuration**, not a successful Render deploy, a fresh runtime observation, security sign-off or Product Acceptance. The earlier [capacity configuration](QA-20261115-SAAS2-CAPACITY-CONFIGURATION.md) and its failed provider builds remain dated evidence.

## Exact immutable source selection

| Input | Selected value |
| --- | --- |
| Published API runtime source R | `671d8837402f8d70b022550321834389132126bd` |
| Protected frontend source F | `f89a71e7ed590c6fab78423f24d65953cb3f6c3e` |
| Frontend complete tree | `e50b74fba6dfdaa4a801e9e5d830533d5e0789ed` |
| Proposed source-only release branch | `release/int-20261115-671d883` |
| Customer sealed manifest SHA256 | `a96511d17cb1836becf265dff0c32b03f2588c7f3540fe20bacfcd1b7b20a342` |
| Platform sealed manifest SHA256 | `1554e3ba6eea91ff0f4ada69ff9182968cde42aa400e6e6103acd7da9efdcfd6` |
| API Main following [source PR423](https://github.com/floriankreutzer/conference-manager-api/pull/423) | `5e86e7cabf5f2c20f86e9761b88aaa7839605880` |
| Frontend Main following [mode PR487](https://github.com/floriankreutzer/conference-manager/pull/487) | `e68ebd4f3dad583353d07ca1a2631637a88f0b3f` |

R is the published source commit containing the exact F Gitlink; the later API merge or this configuration candidate must **not** replace R in the literal provider build guard. The release branch is only a source ref until an active exact-branch immutable ruleset has been independently verified. It must prohibit update, deletion and non-fast-forward changes and have no bypass actors before any provider sync. Do not reuse the rules for the Raa732 branch.

## Source and executable-mode evidence

The native frontend candidate [CI43754681533](https://github.com/floriankreutzer/conference-manager/actions/runs/43754681533) and three-surface DAST [43754681554](https://github.com/floriankreutzer/conference-manager/actions/runs/43754681554) were successful. Separate immutable frontend Main [CI43763884139](https://github.com/floriankreutzer/conference-manager/actions/runs/43763884139) passed all seven jobs, including both full browser engines, both protected browser engines and the permanent shared three-customer/two-reset test. Main DAST [43763884119](https://github.com/floriankreutzer/conference-manager/actions/runs/43763884119), Source Evidence [43763884112](https://github.com/floriankreutzer/conference-manager/actions/runs/43763884112) and Secret Scan [43763884151](https://github.com/floriankreutzer/conference-manager/actions/runs/43763884151) were successful.

The API source candidate's separate CIs [43755316414](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43755316414) and [43755544780](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43755544780) passed six jobs each. Independently merged API Main [CI43764747696](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43764747696) passed all six jobs, including PostgreSQL and all four browser/storage matrices; Main Secret Scan [43764747688](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43764747688) and Source Evidence [43764747755](https://github.com/floriankreutzer/conference-manager-api/actions/runs/43764747755) passed. Native candidate code review without findings is separately recorded in the PR; it does not establish an independent security approval.

Git-tree verification confirms F's ZAP script has mode `100755` and unchanged blob `4e6d10778344eb14d44fc99ca5c31876f380ae40`. The provider failures of Raa732/F53fa remain **build_failed**, not retrospectively successful. The precise step responsible for the earlier mode change on Render remains unproven.

Two independent clean R/F checkout and protected-builder executions, including every inventory entry, exact bytes, lengths, MIME and SHA256, matching manifests, wrong-digest/API rejection and unlisted-path rejection, were recorded in the [CO-299 source evidence](https://acckreutzer-1733338800840.atlassian.net/browse/CO-299?focusedCommentId=10750). Each Customer build included 315 files and each Platform build 197 files. This statement reuses that dated execution record; this configuration change did not itself rerun the builder.

## Ten-value configuration footprint

Only five semantic fields per existing service change in `render.int.yaml`: exact frozen branch, literal API guard, API source SHA, frontend source SHA, and respective surface manifest SHA256. The earlier Raa732/F53fa configuration and its records remain historical. Preserve both service IDs, free/Frankfurt/one-instance plans, preview and auto-deploy settings, environment-group ownership, origins, readiness/start commands, version, unchanged build-only presentation inputs, and every operator-owned `sync: false` input. No schema, migration, recovery, tenant reset, application runtime code or new resource is part of this candidate.

Before merge, qualify this **configuration commit** with the repository's current required PR checks, separate authentic code review, no unresolved threads, a precise semantic 10-field YAML 1.2/schema diff and negative malformed-boolean/source-guard checks. After merge, independently qualify its own Main CI, secret scan and source attestation; never transfer old source-ci results to a new config head.

## Provider plan and acceptance boundaries

The existing paused Blueprint `exs-daakihlg1s2s73df6jdg` follows `main/render.int.yaml` and owns only Customer `srv-daakprhsrm7s73f82deg`, Platform `srv-daakprhsrm7s73f82dg0`, and the existing unlinked legacy group. Its `autoSync=false` remains unchanged. Before applying, verify the release branch's **effective exact ruleset** and source SHA, current service/deployment state, actual provider headroom, and a fresh two-service plan with exactly the ten approved field changes and no unrelated infrastructure change. Provider plan approval must not precede that qualification.

The last independently confirmed live baseline remains API `405003e9be0c386934ae02be43d57dd12a6d8d6c` / frontend `26e3a75bfa15f0a2ea1373e7f8e6ccc61a224dfc`, Customer `dep-dbsoc767bikc73c1bltg`, Platform `dep-dbsoc767bikc73c1bl00`. A source merge or a successful Render plan is not a replacement deployment receipt. Require two new actually live receipts, exact readiness, complete served HTTP bytes/length/SHA256/MIME and source pin reconciliation. Keep R405/F26e as the only observed rollback tuple until independent recovery evidence changes it.

Authenticated Employee/Manager capacity-correction and QA booking cancellation, the original Safari case, actual Microsoft/Exchange, independent security and provider recovery retain separate acceptance requirements. The prior single observer dispatch was already executed; do not repeat it, activate its schedule or reuse its old qualification value on a new runtime pair. No automated Hosted-Demo reset, PROD action, new secrets, budget increase or second provider watch is authorized.
