# Coordinated QA release: canonical schema75 / overlay33

Tracking: frontend #428, #429, #430. This is the operating procedure for the
selected pair, not evidence that it has been deployed. The original schema045
procedure in HOSTED-DEMO-DEPLOYMENT.md is historical; the current executable
migration runner and its native gates explicitly support canonical75/overlay33.

## Selected immutable artifacts

| Input | Selection |
| --- | --- |
| API | `fa488070bd62d677c67b5d266282eecfb007e474` |
| Frontend | `efe672ebaaa844f6663186b8a5d53a18ebab98a6` |
| Release branch | `release/int-20261031-fa48807` |
| Customer manifest SHA256 | `ebb35677f98538094a4eafd9a4c674a8f48828ec7ff5306b36b6fb0790da5e0d` |
| Platform manifest SHA256 | `3f8a7afe18f2fdfeefd33f36bb8aaae5d9117e59700d0750f55f8c7ff48a1a4a` |

The local sealing build produced 300 Customer and 196 Platform files. The actual
API artifact reader validated every file against these independently pinned
manifests. The real Runtime-v2 and Product-v2 API/adapter wire gates passed against
this pair. This evidence does not establish live bytes or current observations.
Require successful candidate and independent Main CI, native PostgreSQL and all
permanent browser/storage acceptance rows before operating the release.

## Coordinated execution

1. Verify the exact release ref and active rules prohibiting updates, deletion and
   force pushes without bypass actors. Keep both existing services, Frankfurt,
   Free plans, origins, flags, secrets and pool limits. Keep automatic deploys and
   Blueprint sync off. Reconcile actual available operating budget before traffic.
2. Review the existing Blueprint's proposed changes against `render.int.yaml`.
   Do not apply the separate legacy `render.yaml`, create resources or replace
   secret environments. Keep the existing inline builder; wrapper activation is
   separate from this release. Inspect both source guards and runtime digests.
3. Drain/close both runtime surfaces before migration. The historical Demo
   migration lock is not the protected INT execution lease; do not claim that it
   excludes current protected traffic. Keep scheduled observation disabled.
4. Run the existing **Migrate Hosted Demo Provider Metrics** workflow on the exact
   accepted Main using its existing protected migration-owner environment. Despite
   its historical name, the reviewed source runner now fixes canonical75/overlay33.
   It verifies sentinel/database/roles/ledger ownership, invokes the canonical
   checksum-verified migration runners and checks retained Tenant, Request,
   revision and audit counts. Never run Initialize Hosted Shared Demo: it resets
   data. Never substitute ad hoc SQL, a runtime credential or restored-target
   migration for this live migration.
5. Require the successful receipt with canonical75, overlay33,
   `resetPerformed: false` and `retainedCountsMatch: true`. A failure can follow
   committed migrations: inspect authoritative state before any next action,
   without an unchanged automatic retry. Strict old-build schema readiness may
   fail during this coordinated transition; do not claim zero downtime.
6. Deploy the frozen pair to both existing services, with all three runtime pins
   (`PROTECTED_API_COMMIT`, `PROTECTED_FRONTEND_COMMIT`, each independent
   `PROTECTED_HOSTED_FRONTEND_SHA256`) and matching build literals. Verify actual
   successful provider receipts, both readiness endpoints and complete sealed
   bytes before reopening admission. Preserve current authentication and custody.
7. Record actual deployment IDs/times and reconcile the observer selection in a
   separate reviewed change. Qualify its exact Main before a bounded manual
   collection. Verify persisted observations and authenticated UI readback. Do not
   enable recurring traffic merely because one manual collection succeeds.
8. Verify session invalidation, Recovery targets/preview/cancel for the intended
   synthetic customers, Runtime grouping/history, all lifecycle counters and DE/EN
   navigation/dialog/copy. No destructive Recovery execution is required by this
   read/preview acceptance. Preserve all original QA findings until their own
   acceptance evidence is complete.

## Recovery and remaining sources

Do not blindly roll back to a schema74 process: strict readiness is incompatible
with schema75. The canonical75 down migration refuses retained service identities.
Keep admission closed on failure and use the documented, reviewed migration or
restore recovery process after reconciling actual data. Do not delete observations
or rewrite migration checksums to make rollback appear successful.

Product collection/private installation, committed Metering producers and audited
reconciliation, actual Delivery/Feedback sources and provider account observations
remain separate QA-09 work. A release, successful CI or synthetic activity cannot
substitute for these sources or real Pilot outcomes. Freshness remains 300 seconds.
