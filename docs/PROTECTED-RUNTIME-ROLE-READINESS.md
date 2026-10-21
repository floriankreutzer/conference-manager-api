# Protected runtime database-role readiness

This prepared adapter observes current schema, UUID and minimal database-role
posture under the existing separate-pool shared lease. It grants no identity,
permission, provider access or reset authority. It performs no GRANT, role change,
migration, deployment or automatic repair. Whole protected INT acceptance remains
under application SaaS1 issue351.

The role name is derived from the fixed environment and surface, never supplied
as an override. The actual current SQL role must match that name, be login-capable,
have no membership or elevated role attributes, and own no database/schema/
relation. Schema creation, database creation/TEMPORARY and public-table TRUNCATE/
TRIGGER powers cause refusal. Existing canonical schema readiness and current
protected UUID checks also remain mandatory. Missing objects/privileges,
dependency errors, reset contention and stale UUID produce false without exposing
driver detail. Readiness is an observation; every actual request/provider statement
still needs ordinary identity, authorization, registry and database enforcement.

The immutable per-surface requirements list contains minimum authentication reads
and ordinary session/ceremony writes. It is not the complete business GRANT
inventory or a role installer. Customer cannot modify Platform identity/session/
audit/key/enrollment/proof custody or protected classification/history. Both
table-level and individual-column grants are inspected. Platform cannot insert
offline enrollment grants. Full role provisioning must additionally preserve
append-only evidence, exact offline issuance restrictions and all ordinary
business/provider permissions without ownership or broad default privileges.

## Restricted-role integration requirement

The existing uncomposed synthetic Customer completion repository uses `FOR SHARE`
on source Platform actor/session rows. PostgreSQL18 also requires UPDATE privilege
for such a lock, even when the statement changes no values. See the official
[SELECT privilege contract](https://www.postgresql.org/docs/18/sql-select.html).
Granting Customer a Platform column-update workaround would violate the posture
above. Before protected roots can enable synthetic access, that lock port needs
a narrow reviewed database implementation which retains same-transaction source
revocation/concurrency fencing without direct Customer update authority. No lock,
source-session validation or isolation contract is relaxed in this change.

## Evidence and operating limits

Three focused tests cover exact surface-derived role/current schema/lease,
minimal closed output, actual boolean semantics, malformed configuration and
dependency cleanup. The new native test is limited to generated test databases
on loopback and creates only fresh fixed fixture roles, refusing to adopt an
existing role. It uses actual PostgreSQL SET ROLE on discarded max1 fixture
connections; metadata and permission results are not mocked. It tests table and
column escalation, missing session-write rights, elevated role/schema powers,
offline-grant insertion and UUID changes, without creating an operator or grant.
SET ROLE is test-only; it is not a production pool option or proof of database
password/TLS authentication. Native execution requires exact-source CI.

No new schema/seed/checksum or closed Demo source is changed. Both closed Demo
graphs remain excluded from these private adapters. Real protected role bootstrap,
complete owned roots, restricted-role handoff, TLS/HTTP/browser/provider/SIM/media
acceptance, key/recovery/sender/owner and coordinated cutover remain necessary.
Passing this minimum posture alone cannot mark an entire deployment ready.
