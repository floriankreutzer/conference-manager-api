# One-time INT owner initialization

This offline-only procedure fills the initial-operator gap. It does not change
the normal two-administrator operator-management policy. It is not recovery,
authentication, a passkey grant, or evidence that INT has been activated.

The independent database owner may initialize exactly one first real Microsoft
operator in INT. The fixed roles are `platform_security_admin` and
`platform_tenant_operator`, with fleet scope `all`; no role/scope selector exists.
The approved directory and object identity must be independently verified through
Microsoft and explicitly supplied in protected operator configuration. Email,
display name, Customer identity and browser claims never establish this mapping.
Personal directory/object values must not enter public source, CI inputs or logs.

Use the existing independent owner database configuration from
`PLATFORM-PASSKEY-ASSURANCE.md`, including separate owner/runtime SQL identities,
verify-full TLS, max1 pool and the stable Platform audit HMAC key. Additionally set
`PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID`, `PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID` and
`PLATFORM_OWNER_BOOTSTRAP_DEPLOYMENT_EPOCH` in the protected administrative process.
The current UUID is independent of the integer Platform authentication epoch.
The CLI also requires `PLATFORM_AUDIT_SEGMENT_ID`. Initialize and independently
verify the matching INT segment using [the audit cutover procedure](PLATFORM-AUDIT-SEGMENTS.md)
before bootstrap. The segment must bind that same deployment epoch; retained
legacy signatures remain explicitly unavailable and must never be resigned.

Run `node scripts/platform-owner-bootstrap.mjs` with a bounded JSON request on
descriptor3 containing exactly `environment`, `deploymentEpoch`, `directoryId`,
`subjectId`, `approvalReference` and a fresh `correlationId`. The first four fields
must match the independently prepared configuration exactly. No command arguments,
HTTP endpoint, runtime switch or Demo entrypoint exposes this operation.

The command requires current schema66 and verifies the configured signed segment
before initialization. The repository takes the existing INT
exclusive deployment lease and a nonwaiting operator-table write lock before
checking actual SQL login/effective role/catalog ownership. It refuses any
existing non-Demo operator, including disabled/history records, and any retained
bootstrap audit. Existing Demo identities are preserved and never adopted.
Operator insertion, the current segment's HMAC audit and change-alert outbox append
commit together. Audit/constraint/commit failure returns a fixed refusal without
partial authority. Concurrent calls can produce at most one initialization.

Migration065 adds only the narrowly scoped offline audit target and its SQL
owner/current-deployment/first-real-operator guard. It provisions no operator and
grants no runtime permission. The immutable audit is a permanent nonreuse fence;
down migration refuses after use. Old migrations/checksums stay frozen. Normal
MFA/step-up principals cannot use the audit-only `offline_owner` marker.

The redacted receipt reports status, internal operator ID, INT and correlation ID.
If output is lost after commit, inspect authoritative operator/audit/outbox state;
do not retry as a repair, delete evidence, or claim that a refusal undid a commit.
The outbox row is not evidence of actual notification delivery. Microsoft login,
independent enrollment grant, two owner-controlled keys and recovery verification
remain separate mandatory ceremonies. No business session or credential is issued.

Keep both services and business admission closed until the coordinated cutover
requirements in `PROTECTED-INT-RUNTIME.md` are met. This document and software
fixtures are source preparation, not live owner/device or restore acceptance.
