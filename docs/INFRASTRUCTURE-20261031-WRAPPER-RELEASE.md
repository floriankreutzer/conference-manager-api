# Protected INT wrapper activation — 31 October 2026

Tracking: floriankreutzer/conference-manager#432 (INF-04/05), #433 (INF-14)
and #310. API PR364 owns the reviewed provider-authenticated build path.
This page selects a paired release and defines its acceptance; it is not a
successful deployment receipt or proof that either repository is already private.

## Immutable selection

| Input | Selection |
| --- | --- |
| API | `2c67a8f6b7495335357cf60a20f146bf4e10d669` |
| Frontend | `efe672ebaaa844f6663186b8a5d53a18ebab98a6` |
| Release branch | `release/int-20261031-2c67a8f` |
| Customer manifest SHA256 | `244b03caa9fe5076d91741ccaf7ff44c51135446ecd7e3ea738f4e90bece8166` |
| Platform manifest SHA256 | `7c87ab182a43436baf226da63d8a6b492b93ce5d6e3ccf003c0766c82e599846` |

Two actual clean-source wrapper builds on this exact API merge commit, using the
real Git commands, locked installs and frontend sealing builder, produced identical
manifests. The independent API artifact reader verified all 300 Customer and 196
Platform files. The frontend Runtime-v2 API/adapter wire, protected Insight/Product-v2
wire and Product delivery/compiler fixture gates passed against this exact pair.
These local results do not prove deployed bytes, provider authentication in private
state, current database observations or independent Main acceptance.

API364 candidate `05e78f73a79df1828fddb388372a120196309798` passed all nine
required checks, including the complete PostgreSQL and permanent Chromium/WebKit
storage matrix, in CI run41208643049 and the associated required workflows. Its
review finding was checked against a real exact-head build and resolved with
evidence. The merge has the identical tree `69e4b594a78531cf7b1914d251dd3e5bf8f87e53`.
Independent source Main CI run41210895967 and the separate configuration candidate
and Main gates must succeed before live application; do not replace them with the
local builds or the earlier candidate result.

## Existing resources and configuration boundary

Use only Blueprint `exs-daakihlg1s2s73df6jdg`, Main/`render.int.yaml`, with
automatic sync paused. Customer is `srv-daakprhsrm7s73f82deg`; Platform is
`srv-daakprhsrm7s73f82dg0`. Retain Free plans, Frankfurt, one instance each,
disabled previews/auto-deploy, both existing origins/readiness/start commands,
all authentication/custody inputs and the unlinked retained legacy environment
group. Reconcile current provider usage with the privately recorded owner budget.
No new resource, plan, quota, domain or credential is part of this release.

The selected build command first asserts the literal API commit, then invokes
`scripts/render-build-protected.mjs`. Render initializes the committed frontend
Gitlink with its existing connected Git-provider credentials; the wrapper performs
no clone/fetch/checkout or anonymous fallback. Verify the existing Render installation
still selects both repositories. Keep both `PROTECTED_PRESENTATION_*` true flags
scoped to the build command. They must not enter persistent service environments;
the protected runtime rejects them. Existing synthetic and owner-access flags stay
unchanged. Each surface receives its own independently pinned manifest digest.

## Apply and verify

1. Require the exact source and configuration candidate/Main gates, source inventory
   and attestation. Create the selected release branch only at the accepted API
   commit. Independently verify active rules that prohibit update, deletion and
   force-push for exactly that branch, without bypass actors.
2. Keep recurring observation disabled. Schema75/overlay33 is already migrated
   and accepted by the earlier QA release. This change has no schema or business
   data migration: do not rerun initialization, reset or migration workflows.
3. Review the existing Blueprint's freshly calculated plan. Only the two services'
   branch/build command/API pin/manifest pin may change. Preserve all omitted and
   `sync: false` secret inputs; they are not newly supplied by Blueprint sync.
   Reject replacements, new resources, altered origins or unrelated changes.
4. Apply the reviewed plan to the existing services and wait for both actual
   successful deployment receipts. A paired rollout is not an assertion of zero
   downtime. Preserve authentication and current data throughout the transition.
5. Read actual provider configuration, commit, deployment ID/time, successful build
   summaries and readiness independently for both services. Use the canonical
   read-only collector to validate every served sealed byte and both health build
   IDs against the independently rebuilt artifacts. Local manifests alone cannot
   approve a deployment. Keep failures visible; never change the digest to accept
   unexpected bytes.
6. After real success, record the actual receipts in the source-owned observer
   selection through a separate reviewed change. Qualify that exact Main before
   updating the observer SHA. Verify a bounded collection and authenticated
   persistence/UI readback. Private execution and recurring traffic retain their
   separate budget, source, runner-measurement and schedule gates. Public delivery
   does not close the agreed 2 November private-state checks.

## Recovery

The last accepted schema75 pair was API
`fa488070bd62d677c67b5d266282eecfb007e474` / the same frontend, selected by
`release/int-20261031-fa48807`. Its complete configuration and historical manifests
are retained in the earlier QA runbook and Git history. If this rollout fails,
reconcile actual service/data state before restoring that exact prior pair and
its corresponding inline build/runtime pins on both existing services. Do not
restore an old schema74 process or alter migration checksums. A new deployment of
an old source produces new receipts; old receipt IDs must never be relabeled as
current. Keep observation disabled/stale until actual restored receipts are
separately reconciled and qualified.
