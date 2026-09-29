# SaaS 3.6 Room media operations (ADR-012 H-034)

Room media is a Tenant-owned private PostgreSQL `bytea` asset, not an external image URL. The service stores reencoded WebP with a 2 MiB input cap, a 4 megapixel cap and an initial 100 MiB payload quota per Tenant. Existing Locations revisions can retain references after a Room detaches the image. The retention query locks the Tenant row and deletes only assets older than 30 days that are referenced neither by current Room state nor by any immutable Locations revision. It processes at most 100 rows per transaction.

## Scheduled retention

Schema 041 installs `public.prune_expired_unreferenced_room_media(uuid,timestamptz,integer)`
as a bounded SECURITY DEFINER procedure owned by the migration role with a fixed
`pg_catalog` search path and fully qualified relations. PUBLIC has no EXECUTE.
The procedure locks the Tenant row, rejects missing Tenant/invalid batch limits,
caps the caller's cutoff to database time, and deletes only assets older than
30 days that are absent from current Rooms and immutable Locations revisions.
Application/runtime roles do not receive EXECUTE. The standalone job calls
only this procedure; it cannot directly delete bytes or update Tenant rows.

After schema 041 is applied on the selected provider, provision a **separate login
role** for the maintenance job (for the Demo, `cm_demo_media_retention`) with
a provider-generated secret. On Neon, the role-creation API can automatically add a new role to `neon_superuser`: this was observed on the isolated SaaS 3.6 acceptance branch on 29 September 2026. Do not use such a role for this job, even after granting only the permissions below. A trusted role administrator must provision a LOGIN role with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, without `neon_superuser` or any migration/reset/runtime membership. Verify these direct attributes in `pg_roles`, the memberships in `pg_auth_members`, and effective `has_table_privilege`/`has_function_privilege` results before providing a connection secret. If that cannot be done in the selected Neon plan, fail this operational gate and use a provider-supported restricted role path. The overprivileged acceptance role was deleted.

Execute these grants through the trusted migration operator; do not grant membership in migration, reset, Customer or Platform roles:

```sql
GRANT USAGE ON SCHEMA public TO cm_demo_media_retention;
GRANT SELECT (id) ON public.tenants TO cm_demo_media_retention;
GRANT SELECT (version) ON public.schema_migrations TO cm_demo_media_retention;
GRANT EXECUTE ON FUNCTION public.prune_expired_unreferenced_room_media(
  uuid, timestamptz, integer
) TO cm_demo_media_retention;
```

Verify the effective role cannot `UPDATE` Tenants, directly `DELETE` media,
read media bytes, or execute unrelated functions. Do not put its connection
string into source control or logs. Supply it from a secret store as
`ROOM_MEDIA_RETENTION_DATABASE_URL` with `DATABASE_SSL=verify-full`, and run
`NODE_ENV=production node scripts/room-media-retention.mjs --execute` once per day through the reviewed `.github/workflows/room-media-retention.yml`
GitHub Actions job on `main` (03:17 UTC, plus manual dispatch). Configure the
repository secret `ROOM_MEDIA_RETENTION_DATABASE_URL` with only that role's
connection string. Missing credentials, schema mismatch and incomplete batches
fail the workflow; monitor GitHub Actions failures and assign an operator. The script checks schema readiness, limits itself
to 10,000 Tenants and at most 1,000 deletions per Tenant per invocation, and
fails on an incomplete pass. Alert on any failure/incomplete status and inspect
retained references before retrying. Logs include aggregate counts and bytes
only. Never pass a browser Tenant ID to the job.

A migration or deployment alone does not prove the job has executed. On the
isolated restore child, use the dedicated role and real script to verify that
an aged unreferenced image is deleted and current/historical references survive;
then record the scheduler run and failure alert behavior.

Do not run this job against an unverified restore, an old binary, a partially migrated fleet, or a database without a recoverable backup. A schema-040 rollback with published structured values and a schema-039 rollback with managed media are guarded: use a forward fix when a down migration would discard live or historical data.

## Backup and restore acceptance procedure

1. Select the actual Production PostgreSQL 18 provider, region, encryption/key handling, retention and PITR policy; record provider service, region, backup schedule and operator. The application code does not provide these controls.
2. In an isolated same-region restore target, start from a provider-created backup containing a known Tenant and managed image. Record source backup ID, creation time, database migration version, asset ID, byte length and `content_sha256` without logging bytes or connection strings.
3. Restore the full database and WAL to a documented target instant. Run schema migration/readiness checks before accepting any traffic. For a restore before the session security epoch (migration 034), apply the documented reauthentication procedure in `PRODUCTION-SECURE-CONFIGURATION.md`.
4. Compare the image's byte length and SHA-256 digest to the source; verify a current attached image and an image retained only through an immutable Locations revision. Prove that the authenticated same-Tenant Manager and active-Room Employee can read the attached image while anonymous, foreign-Tenant and detached reads are concealed. Check that Guest/print never receive private bytes.
5. Run the retention job against the isolated target with a controlled expired detached asset and an expired historically referenced asset. Verify only the eligible asset disappears, the historic asset survives, and the resulting backup/restore target remains consistent. Record elapsed restore time, backup age and objective RPO/RTO comparison.
6. Dispose of the isolated target under the provider retention policy. Store the evidence in the release record without exposing credentials, personal data, image bytes or privileged URLs.

An isolated image-bearing Neon snapshot restore and SQL predicate proof were observed for the Demo in #216. Authenticated HTTP delivery from the isolated restore, actual dedicated-role script/scheduler execution and named #182 acceptance remain open. Production provider/RPO/RTO evidence belongs to the eventual Production deployment. Do not mark H-034 or #170 complete on the isolated SQL proof alone.

## Storage and cost review

At the approved 100 MiB payload cap, 100 Tenants could retain up to 9.77 GiB of image payload; 1,000 Tenants up to 97.66 GiB, before PostgreSQL row/index overhead, WAL, backups, replicas, restore targets and temporary reencoding. These are upper bounds for bytes currently retained under quota, not a bill or a measured workload. Immutable historical references can prevent deletion after detachment. Before Production release, measure `pg_total_relation_size('tenant_room_media_assets')`, WAL growth during uploads/deletions, backup footprint and restore duration on the chosen provider. Apply its current storage, backup, I/O and egress tariffs to the observed profile; record owner, date, region, projected Tenant counts and reviewed monthly range. A quota does not cap backup or PITR costs. Review retention and quota defaults if the measured cost or restore objective is unacceptable.
