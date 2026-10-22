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

## Protected Actions execution option

The owner may use `.github/workflows/protected-int-first-owner.yml` with the
existing inspected Main-only `hosted-demo-initialize` environment and serialized
database-operation group. This uses the previously approved signing-key custody;
it does not establish or widen an approval, identity verification or release claim.
Accept the exact immutable source and all required gates before dispatch.
Independently verify the actual Microsoft directory/object identity, matching
Platform profile, signed audit segment and incremental runtime grants first.
Keep both services closed. Never infer the identity from email or a portal label.

The only public input is `expected_main_sha`. Owner actor and triggering actor,
Main, attempt1, ordinary logging, pinned actions, checkout without credentials,
Node22 and locked installation before operation secrets remain mandatory.
The guard binds an exact private request to independently configured identity,
deployment, segment and a protected identity-evidence reference. It attests only
binding/presence, not the truth of identity verification or closed services.
The existing canonical offline CLI remains the only writer and rechecks the
source ledger, owner login/catalog, current deployment, signed segment and absent
real-operator/bootstrap history before its atomic operator/audit/outbox commit.

Reuse environment secrets `CM_INT_AUDIT_OFFLINE_DATABASE_URL` and
`CM_INT_AUDIT_PLATFORM_DATABASE_URL`, `CM_INT_AUDIT_HMAC_SECRET`,
`CM_INT_AUDIT_OFFLINE_ROLE`, `CM_INT_AUDIT_SECURITY_REVISION`,
`CM_INT_AUDIT_SEGMENT_ID`, `CM_INT_AUDIT_DEPLOYMENT_EPOCH`. Add only environment
secrets `CM_INT_OWNER_DIRECTORY_ID`, `CM_INT_OWNER_SUBJECT_ID`,
`CM_INT_OWNER_REQUEST_JSON` (the canonical six-field request above) and
`CM_INT_OWNER_EVIDENCE`. Evidence contains exactly `sourceSha`, `environment`,
`deploymentEpoch`, `segmentId`, `identityReference`, `servicesClosed`;
source/deployment/segment match this operation, environment is `int`, servicesClosed
is true, and identityReference is an actually reviewed bounded evidence reference.
Never put personal directory/object identifiers in source, workflow inputs,
variables, logs or public artifacts. Never invent evidence or reuse it unchecked
after a source/deployment/identity change.

Private CLI output is suppressed; success emits only
`PROTECTED_INT_FIRST_OWNER_SUCCEEDED`. A failure exposes fixed refusal codes.
No automatic retry, migration, role installation, passkey grant, credential,
business session, service start or traffic admission is provided. Inspect actual
operator/audit/outbox state after every result, including failure or lost output,
before any new dispatch; GitHub re-runs are refused. Remove temporary owner
request/identity/evidence secrets after the controlled operation while preserving
required runtime signing/recovery custody. Actual Microsoft application login,
two owner-controlled keys and recovery remain separate mandatory ceremonies.
