# Protected SaaS1 QA release candidate — 9 November 2026

Jira: CO-8 / CO-320. Source integration: frontend PR465 and API PR401.
This is the selected release configuration, not a deployment or full product
acceptance receipt. Required source, configuration and Main gates must finish
successfully before applying it.

## Immutable pair and artifact qualification

| Input | Selection |
| --- | --- |
| API | `ee20204999f7f25c868316827eb4a23e795ed50f` |
| Frontend | `75022cbb9e03e8fdef620240c873739f17c27352` |
| Release branch | `release/int-20261109-ee20204` |
| Customer manifest SHA256 | `86d844d09ee6e8dd3f6cde5447b8d61cb586201e2a01db3c5f355d8eb7b33464` |
| Platform manifest SHA256 | `601b5528d82e34b44c70181b187900cc818f6b637f37d4377bcd8d03d4b699da` |

Two real clean-source executions of `scripts/render-build-protected.mjs` on this
pair produced identical manifests. The independent API artifact reader verified
all 311 Customer and 197 Platform files. These local results prove deterministic
builds and reader compatibility, not delivered bytes or provider authentication.
The release API differs from accepted functional Main `95ce22f7` only in the
protected frontend Gitlink and its source-selection documentation. The frontend qualification pins functional API
`2b9a7f4fbeaba3688877d045337a1c00e3eda5de`; that source has the same backend
application, tests and dependency locks as the selected pair.

Require complete candidate and Main checks, including native security gates,
PostgreSQL, both protected browser engines and the permanent three-customer,
two-reset acceptance. Keep failed and superseded runs historical. A local check
or partial engine result cannot replace an outstanding required gate.

## Existing resources and application

1. Re-read Blueprint `exs-daakihlg1s2s73df6jdg` and both actual services:
   Customer `srv-daakprhsrm7s73f82deg`, Platform `srv-daakprhsrm7s73f82dg0`.
   Preserve paused Blueprint synchronization, Free/Frankfurt/one instance,
   disabled automatic deployment/previews and existing origins/readiness/start
   commands. Create no resource and perform no migration, initialization or reset.
2. After source acceptance, create the selected release branch at exactly the API
   SHA above. Verify active rules that prohibit updates, deletion and force pushes
   for that exact branch with no bypass actors. Historical release rules do not
   protect a newly named branch.
3. Use the existing Blueprint's qualified Main `render.int.yaml`. Review its plan:
   only the two services' source branch, literal build guard, API/frontend pins
   and respective manifest digests change. Preserve all secret/operator inputs,
   the unlinked retained legacy environment group, current feature flags and
   service version. Presentation flags remain build-command-only. Reject new or
   replacement resources, unrelated setting changes and any newly required secret.
4. Apply only the verified plan, then inspect actual deployment state before
   triggering any additional deploy. Require both successful provider receipts;
   never infer deployment from a merged YAML or relabel an old receipt.
5. Verify live readiness, API build IDs and every served sealed byte against
   the independently qualified artifacts. Exercise the authenticated Customer
   and Platform screens through normal access, including request editing,
   validation recovery, guest-dialog focus/print and room-plan touch details.
   Do not reset shared Demo data as a live smoke-test shortcut.
6. Record exact deployment IDs/times and source pairs in Jira. Reconcile the
   source-owned observer selection and its pinned frontend in a separately
   qualified change after actual success. Do not claim fresh observer evidence
   while that observer still selects the previous release. Recurring collection
   remains subject to its separate readiness and budget gates.

## Confirmed baseline and rollback

Readback on 9 November confirmed both existing services still live on API
`863e8220b4aa5d3ef58946b1833550f78369dfb7`, branch
`release/int-20261104-863e822`. Customer receipt `dep-dbn0d4ff3r2c73bqeaog`
finished 6 November at 16:56:45.323508Z; Platform receipt
`dep-dbn0c96c6qcc73cnu0o0` finished at 16:54:53.652076Z.
The paired frontend is `17c28fb615264e6a2eccc7ed6e46d20171cb66e3`.
The exact prior build command, flags and manifests are retained in
[the November 4 release runbook](QA-20261104-DAILY-RELEASE.md) and Git history.

If either rollout fails, reconcile actual provider/data state first. Restore the
accepted prior source branch, literal guard, API/frontend runtime pins and both
matching manifest digests together on the existing services. Retain operator
inputs and the daily-insights keys supported by that baseline. No schema rollback,
credential rotation or data reset is part of this release. Verify fresh successful
recovery receipts and live bytes; historical receipt IDs are not recovery proof.

## Acceptance limits

This release delivers the existing integrated QA corrections; it does not prove
all 27 target screens or close every CO-320 criterion. Remaining Manager editor
dirty-state/media usability work, representative screenreader/first-user testing,
real Microsoft/Exchange integration, isolated load and recovery gates require
their own evidence. Preserve those open scopes rather than equating source merge,
artifact integrity or public readiness with complete product acceptance.
