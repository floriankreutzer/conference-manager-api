# Isolated restored-pair acceptance

Tracking: frontend issues #264 and #270. This manual gate does not activate
production or authorize blob purge. The existing loopback-database provider
workflow and mandatory four-row CI remain unchanged.

## Retained baseline

On 9 October 2026 snapshot `snap-fragrant-cell-b1oh6t1r` restored the isolated
database into `br-rapid-morning-b1a704p9`. The new branch did not contain its
private bucket. Explicit transfer from independent backup `br-twilight-tree-b18xtqg3`
then restored all 34 canonical objects (5,192,696 bytes). Source and target
length/SHA-256 checks passed for every object; anonymous GET returned 403 and
signed missing-object GET returned 404. Full inventory is retained in issue #264,
comment 6089229185. This transfer is not full application recovery acceptance.

Canonical object manifest SHA-256:
`0d4cece4b98b531c346830164c383a2c6c8a8a324f8990b3c7d50e0f3e4fd39f`.

## Protected execution

The owner approved one additional disposable child named
`saas38-paired-recovery-browser-20261009`, fixed min/max 0.25 CU, idle pause
300 seconds, at most 60 minutes of live exercise, and complete deletion of that
child including its data/compute afterward. Provision it only when the reviewed
workflow, secrets and execution path are ready. Keep the restored baseline,
production, acceptance, original root and independent backup unchanged.

Bind protected repository variables `CM_NEON_RECOVERY_BRANCH` and
`CM_NEON_RECOVERY_HOST` to the independently inspected child ID and exact compute
hostname. Never use a preserved branch or production endpoint. No workflow input
can supply a destination. The configuration accepts only the Frankfurt Neon
endpoint format, exact role/database, verified TLS and no connection URL options.

Install `public.neon_recovery_acceptance` ONLY on that verified child, owned by
`cm_demo_migration`, with one `singleton=true` row containing its `branch_id`,
`source_branch_id=br-rapid-morning-b1a704p9`,
`snapshot_id=snap-fragrant-cell-b1oh6t1r`, the manifest digest above, and
`created_at`/`expires_at` separated by at most 60 minutes. Grant SELECT only to the
three inherited runtime/reset roles in addition to the owner; revoke PUBLIC.
Set the time window immediately before execution, not during PR validation.
The marker prevents accidental endpoint selection; a malicious database owner
can forge it and is outside this operator guard's threat model.

Set these temporary protected Actions secrets without posting their values:

- `CM_NEON_RECOVERY_CUSTOMER_DATABASE_URL` (`cm_demo_customer`)
- `CM_NEON_RECOVERY_PLATFORM_DATABASE_URL` (`cm_demo_platform`)
- `CM_NEON_RECOVERY_RESET_DATABASE_URL` (`cm_demo_reset`)
- `CM_NEON_RECOVERY_MIGRATION_DATABASE_URL` (`cm_demo_migration`)
- `CM_NEON_RECOVERY_ACCESS_KEY_ID`
- `CM_NEON_RECOVERY_SECRET_ACCESS_KEY`

All four URLs must select the same child host and `conference_manager_demo_shared`,
with distinct passwords and no query/fragment. Use the full token ID and S3 secret
from a temporary read/write storage credential anchored to this child. Existing
acceptance or ancestor credentials are not appropriate. Runtime session/CSRF/audit
secrets are independently generated and masked on the runner. Customer and Platform
retain their existing process credential exclusions.

Run **Neon Restored Pair Acceptance** on reviewed main once. It first validates
each live principal, database and unexpired recovery marker, schema 44/overlay 9,
all 34 retained blobs, immutable keys, inventory ownership and the exact manifest.
The unchanged SDK independently reads/verifies every object in batches of at most
four before any application reset. No initial reseed hides an invalid restoration.

The existing Customer/Platform compositions then execute the complete immutable
shared role/Tenant/CSRF journey and full three-customer/two-reset acceptance in
Chromium and WebKit sequentially. Frontend serving comes from render.yaml's
immutable pin; acceptance is `6228a827502b2cb59c8b9c50adebb9ad6431fe8b`.
No retries, deadline changes, assertion weakening or optional test paths are added.
After both browsers pass, APIs stop and the existing operator repository rolls back
Room/Catalogue pointers in at most six existing bounded batches per kind, verifying
all 34 resulting PostgreSQL blobs. It never purges blobs or deletes objects.

An always-run bounded inventory export and full reports retain custody. Export
failure fails the run; expiry, abrupt runner termination or inaccessible artifacts
remain unresolved custody. Revoke the temporary credential, remove all six Actions
secrets and both variables, and delete only the approved disposable child after
evidence retention or on failure. The operator must enforce compute teardown even
if the runner fails; workflow timeout and runtime expiry alone do not delete it.

## Evidence limits

Successful preflight, browsers and positive rollback are separate named evidence;
none alone is the full retained restore artifact required by purge. Real corrupt
object failure, failed rollback preserving its pointer/data, and explicitly retained
historical-revision application reads must additionally be verified and retained.
Unit/provider-fixture tests do not replace those real-provider negative checks.
This prepared workflow is not an executed success, production cutover, FinOps
completion, representative business load or permission to close SaaS 3.8.
