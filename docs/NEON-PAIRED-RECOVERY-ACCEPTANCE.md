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

### First execution and metadata defect

[Run 38041237794](https://github.com/floriankreutzer/conference-manager-api/actions/runs/38041237794)
on `d3ba6a3f37c68cea156265eb89f8b8960287e042` failed in preflight on
10 October 2026 at 09:25:01 UTC, before API startup, faults, browser acceptance or
positive rollback. Its always-run inventory succeeded; that phase exercised all
four database identities but did not read object storage. The failed run and its
original inventory archive remain failed evidence, retained under SHA-256
`f9927b43d66f4dcb542955c8e1b568b221625e10268aec691c969cc779a11e64`.

Subsequent independent GETs found correct lengths and hashes for all 34 child
objects, but every response had `application/x-www-form-urlencoded` instead of
the expected 11 `image/png` and 23 `image/webp` values. For one Catalogue object,
the protected restore parent returned that same wrong MIME while the independent
backup returned identical bytes with `image/png`. This comparison covers that
sample only; neither protected branch received a complete MIME audit or repair.
The existing application adapter correctly rejects mismatched response metadata.
The generic original failure log does not exclude another preflight error.

Only the disposable child was repaired: 09:44:39–09:48:00 UTC, identical bytes
under the same 34 keys with the canonical MIME, followed by complete size/hash/MIME
GET verification. The operator used official SDK presigns over its existing proxy;
this did not execute the runner's unchanged application adapter or prove complete
recovery. Two earlier operator transport attempts failed and remain recorded.
The first marker window was never renewed. At 09:48:42 UTC, its remaining 29:35
was shorter than the measured 31:15 full reference run, with remote-Neon duration
still unmeasured. No second workflow was started. All three child credentials
were confirmed revoked; the child and its compute were confirmed absent from
independent project inventories after cleanup. Production and all five protected
branches were retained. Issue #264 records the full evidence and cleanup.

### Object metadata prerequisite

Before dispatch, inspect every inherited object against its authoritative
database reference: exact immutable key, length, SHA-256 **and Content-Type**.
An inventory match or correct bytes alone does not verify the restored object.
Read through the unchanged application adapter using the intended child credential
where that execution path is available. An operator GET is useful diagnosis but
does not replace the runner's mandatory adapter preflight.

For any separately authorized transfer or correction on the disposable child,
explicitly set the upload Content-Type from the verified reference and send the
verified binary body. Do not allow an HTTP client's implicit form Content-Type.
GET every written object afterward and verify the same four properties; a PUT
status, object listing or HEAD alone is insufficient. A mismatch blocks dispatch.
Do not infer permission to overwrite protected parents or backup evidence. Resolve
preparation defects before creating the single fixed marker, and preserve failed
attempts without classifying a corrected copy as an originally flawless restore.

## Protected execution

The owner approved one additional disposable child named
`saas38-paired-recovery-browser-20261009`, fixed min/max 0.25 CU, idle pause
300 seconds, at most 60 minutes of live exercise, and complete deletion of that
child including its data/compute afterward. Provision it only when the reviewed
workflow, secrets and execution path are ready. Keep the restored baseline,
production, acceptance, original root and independent backup unchanged.

That one-child authorization was used by `br-weathered-boat-b1fe52yn`, now deleted.
The following procedure is retained for a future separately approved exercise;
it does not authorize a replacement child or a new time window. Finish the
corrective source work and identify the complete next execution scope before
requesting another bounded resource decision.

Create a normal child of the already paired `br-rapid-morning-b1a704p9`, not
another snapshot restore or a schema-only branch. Normal children inherit their
parent's buckets and objects at fork time; independently inspect the child's
private bucket and retained inventory before execution. Missing inherited storage
is a preparation failure, not permission to reseed or repeat the transfer blindly.
See the provider's [bucket branching contract](https://neon.com/docs/storage/buckets#bucket-branching).

Bind protected repository variables `CM_NEON_RECOVERY_BRANCH` and
`CM_NEON_RECOVERY_HOST` to the independently inspected child ID and exact compute
hostname. Never use a preserved branch or production endpoint. No workflow input
can supply a destination. The configuration accepts only the Frankfurt Neon
endpoint format, exact role/database, verified TLS and no connection URL options.

Install `public.neon_recovery_acceptance` ONLY on that verified child as a
**constant ordinary view**, owned by `cm_demo_migration`. An additional table
would fail the existing exact Demo application-table inventory before reset.
Do not change that inventory, add the marker to the truncate list, or use a
materialized view. The recovery guard rejects a wrong relation type or owner
before reading the marker or allocating provider access.

Connect as `cm_demo_migration` to the independently verified child database
`conference_manager_demo_shared`. Substitute only its verified branch ID below.
First inspect both global and `public`-schema default relation ACLs for that owner;
additional grants may be applied when the view is created:

```sql
SELECT pg_get_userbyid(defaults.defaclrole) AS owner,
       CASE WHEN defaults.defaclnamespace = 0 THEN '(global)'
            ELSE namespace.nspname END AS schema_name,
       CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
            ELSE pg_get_userbyid(privilege.grantee) END AS grantee,
       privilege.privilege_type, privilege.is_grantable
FROM pg_catalog.pg_default_acl AS defaults
LEFT JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = defaults.defaclnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS privilege
WHERE defaults.defaclrole = 'cm_demo_migration'::regrole
  AND defaults.defaclobjtype = 'r'
  AND (defaults.defaclnamespace = 0 OR namespace.nspname = 'public')
ORDER BY schema_name, grantee, privilege_type;
```

This is inspection, not permission to change global default privileges or roles.
Create the marker once, immediately before dispatch, after checking that the shared
workflow concurrency group is free. `CREATE VIEW` deliberately fails when the
relation already exists; do not replace an existing marker or extend its expiry.
The SQL captures database time once and stores fixed timestamp literals in the view:

```sql neon-recovery-marker-installation
BEGIN;

DO $operator$
DECLARE
  marker_created_at timestamptz := clock_timestamp();
BEGIN
  IF current_database() <> 'conference_manager_demo_shared'
     OR current_user <> 'cm_demo_migration' THEN
    RAISE EXCEPTION 'RECOVERY_OPERATOR_CONTEXT_INVALID';
  END IF;

  EXECUTE format(
    $view$
      CREATE VIEW public.neon_recovery_acceptance AS
      SELECT
        true AS singleton,
        %L::text AS branch_id,
        %L::text AS source_branch_id,
        %L::text AS snapshot_id,
        %L::text AS object_manifest_sha256,
        %L::timestamptz AS created_at,
        %L::timestamptz AS expires_at
    $view$,
    '<VERIFIED_CHILD_ID>',
    'br-rapid-morning-b1a704p9',
    'snap-fragrant-cell-b1oh6t1r',
    '0d4cece4b98b531c346830164c383a2c6c8a8a324f8990b3c7d50e0f3e4fd39f',
    marker_created_at,
    marker_created_at + interval '60 minutes'
  );
END
$operator$;

REVOKE ALL ON public.neon_recovery_acceptance
  FROM PUBLIC, cm_demo_customer, cm_demo_platform, cm_demo_reset;
GRANT SELECT ON public.neon_recovery_acceptance
  TO cm_demo_customer, cm_demo_platform, cm_demo_reset;

COMMIT;
```

Inspect the complete resulting view ACL; checking PUBLIC alone is insufficient:

```sql
SELECT relation.relkind, pg_get_userbyid(relation.relowner) AS owner,
       CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
            ELSE pg_get_userbyid(privilege.grantee) END AS grantee,
       pg_get_userbyid(privilege.grantor) AS grantor,
       privilege.privilege_type, privilege.is_grantable
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,
  pg_catalog.acldefault('r', relation.relowner))) AS privilege
WHERE namespace.nspname = 'public' AND relation.relname = 'neon_recovery_acceptance'
ORDER BY grantee, privilege_type;

SELECT attribute.attname, privilege.*
FROM pg_catalog.pg_attribute AS attribute
CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
WHERE attribute.attrelid = 'public.neon_recovery_acceptance'::regclass
  AND attribute.attnum > 0 AND NOT attribute.attisdropped;
```

Expected: ordinary view owned by `cm_demo_migration`, its normal owner rights,
and only `cm_demo_customer`, `cm_demo_platform`, `cm_demo_reset` granted SELECT
without grant option. PUBLIC and other non-owner grantees have no privileges;
the column-ACL query returns no rows. If an observed default grant added a role
such as `authenticated`, revoke its privileges **only on this verified child's
marker**, then repeat the full ACL readback. Do not change protected branches,
global defaults, role membership, or the marker definition. Inspect effective
privileges and observed role-inheritance paths with
[`has_table_privilege`, `has_any_column_privilege`, and `pg_has_role`](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE).
For `pg_has_role`, inspect `USAGE` for immediately inherited rights and `SET` for
an allowed role switch; `MEMBER` alone does not establish either access path.
An unexplained inherited or SET ROLE path blocks dispatch; the database-owner
threat-model limit below still applies.

Verify the single `singleton=true` row and exact branch/source/snapshot/manifest
values. Verify all four live principals can read the same fixed `created_at` and
`expires_at`; the maximum difference remains 60 minutes. Never put dynamic
`now()` or `clock_timestamp()` expressions in the view's SELECT: that would
renew the time window on every read. Checkout/install/queue time counts against
this fixed window. The marker prevents accidental endpoint selection; a malicious
database owner can forge it and is outside this operator guard's threat model.

The PostgreSQL regression creates the real view under the migration owner,
checks each role's access, executes two full canonical resets with semantic
readback, and verifies the unchanged marker and application-table inventory.
A table-shaped marker fails the recovery guard and the independent reset gate
without changing the seeded business state. These local/CI checks do not prove
the real Neon restored pair has passed its separate manual gate.

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
The existing semantic-state reader also verifies the complete three-customer
business state against the canonical seed or its supported dated reset generation
in the same read-only transaction. Changed business state fails before any reset;
the report retains its verified semantic checksum.

After both existing Customer/Platform compositions become ready, the mandatory
`faults` phase verifies the missing recovery cases before any browser reset can
hide their effects. It uses the same four live identities, independently bound
child, unexpired marker and exact restored manifest. It never targets a preserved
branch or adds a production API endpoint.

- Select exactly one manifest-verified Room object and one Catalogue object. Read
  and verify their original bytes through the unchanged application storage adapter
  before any fault. Only the isolated operator may temporarily remove an exact
  selected key or replace its contents with a same-length corrupt value. The
  application adapter's normal input and digest validation remains unchanged.
- Read each missing/corrupt object through an authenticated Customer HTTP session.
  Ordinary GET, the previously valid ETag and `If-None-Match: *` must all fail with
  503 and `Cache-Control: no-store`. Retained database bytes must not create a
  fallback response, and conditional requests must not turn the failure into 304.
- Exercise the existing operator rollback with a one-asset limit against the exact
  selected first candidate. A missing/corrupt provider read must fail while all
  authoritative media rows, pointers, database bytes, inventory and Room references
  remain unchanged. This proves failed one-asset rollback integrity; it does not
  establish atomicity across a complete multi-asset batch.
- Restore the verified original provider bytes in cleanup and verify their digest
  through the unchanged adapter. Failure to restore or verify fails the phase.
  Do not begin another fault without sufficient time for restoration inside the
  existing exercise deadline.
- Use the existing authorized Locations history and rollback contracts to detach
  a Room media reference, verify that the detached asset is unavailable through its
  ordinary HTTP route, inspect the immutable historical snapshot, then reattach it
  with the expected current revision. The restored application GET must return the
  exact original bytes and ETag. This is an application read of a historical Room
  reference; it does not invent historical Catalogue-read functionality.

The phase retains minimized source/branch/manifest-bound evidence and re-verifies
all 34 provider objects and canonical business semantics before browser acceptance.
Cookies, CSRF tokens, credentials, connection strings and raw media bytes are not
part of its report. The bounded fault injector belongs only to this isolated
operator phase, not to either application composition or the normal media adapter.

If a history check fails after detachment, the exercise stops without forcing a
rollback from an unverified historical configuration. The unchanged-business-state
claim applies only to each measured failed one-asset rollback, not to an entire
failed exercise. Verified provider-byte restoration is a separate cleanup guarantee;
any failed restoration leaves custody unresolved until the operator completes the
approved child cleanup.

The compositions then execute the complete immutable shared role/Tenant/CSRF
journey and full three-customer/two-reset acceptance in Chromium and WebKit
sequentially. Frontend serving comes from render.yaml's immutable pin; acceptance
is `b2ef694d68632a41ab135ce8a23749a1b9f06c4b`. This reviewed successor preserves
the business scenarios and binds their context explicitly to the selected origin.
The source-commit-verified copy helper transfers the complete six-file Shared
acceptance set (spec and support dependencies); it never replaces the served application. No retries,
deadline changes, assertion weakening or optional test paths are added.
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

Errors caught in the preflight body now retain a separate `neon-recovery-preflight-failure.json`
with `outcome: failed` and scope `restored-pair-preflight-failure-not-acceptance`.
It identifies the failed stage and only stages already completed, using the fixed
sequence `configuration`, `identities`, `schema`, `database-media`, `provider-bytes`,
`semantic-state`, `commit`, `report`. The source SHA is validated or null, durations
are measured monotonically, and error codes come from an exact allowlist with
`UNKNOWN` as the fallback. The report contains no raw messages, stacks, causes,
URLs, credentials, provider payloads or object keys. It is created exclusively
with mode 0600 and retained by the existing always-run artifact step. Failure to
write it emits only `NEON_RECOVERY_DIAGNOSTIC_WRITE_FAILED`; the original failure
status and all cleanup attempts remain. Other modes and successful preflight
reports retain their existing contracts. A cleanup-only failure after a successful
preflight body still emits the existing cleanup error and fails the process; it
does not retrospectively create this failure report. No failure report is a
partial pass.

Successful preflight, provider-fault/history verification, both complete browser
contracts and positive rollback are separate required evidence. None alone is the
full retained restore artifact required by purge. The fault phase must actually
run against the independently verified restored Neon pair and its reports must be
retained; adding the workflow phase or passing native/PostgreSQL fixture tests does
not establish that real-provider execution succeeded.
This prepared workflow is not an executed success, production cutover, FinOps
completion, representative business load or permission to close SaaS 3.8.

## CI image bootstrap evidence

Initial candidate CI run 37992999496 failed before database/browser test execution
when Docker Hub rejected anonymous image pulls with its rate limit. That run
remains failed evidence. Required PostgreSQL services now use Docker's official
Amazon ECR Public repository, pinned to the same PostgreSQL 18.6 Alpine manifest:
`sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873`.
On 9 October both Docker Hub and ECR manifest GETs returned HTTP200 and identical
SHA-256, including Linux amd64. No database version, health check, test, retry,
deadline or paid registry account changes. All required checks must run again
against the successor head; image-source verification is not database acceptance.
