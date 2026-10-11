# Manual Live media operator

This source adds an execution path; it is not evidence that Live has migrated or
that any provider prerequisite has been met. The approved cutover sequence in
[NEON-DEMO-OBJECT-STORAGE-CUTOVER.md](NEON-DEMO-OBJECT-STORAGE-CUTOVER.md) remains
authoritative. No runtime, deployment, schema, reset, retention or Recovery
acceptance behavior changes. The workflow cannot deploy or reopen either service.

## Authority and prerequisites

The owner dispatches **Live media operator** from `main`, with reruns and debug
logging disabled. Exactly one invocation runs, using the checked-out dispatch
commit. Only `preflight`, `reconcile`, `copy` and `rollback` exist. Copy/rollback
select exactly one of `room` or `catalogue`; read-only actions require `none`.
There is no purge, reset, retry loop or automatic continuation.

Before outage or mutation, independently read provider metadata and retain a
secret-free receipt binding the exact project, Live branch, database endpoint,
database, storage branch/bucket, separate credential identities and deployment
identities. Immediately before each mutation or final reconciliation, the owner
must verify this receipt remains current, both runtimes are closed, **all old
Render instances have retired**, and reset/retention/other writers cannot start
during the operation. A successful deployment, closed HTTP probes, no recent
logs, and a momentary SQL session count do not establish old-instance retirement
or prevent reconnection. If provider evidence cannot establish it, stop before
mutation. The wrapper does not fabricate provider evidence or terminate sessions.

An acceptable external retirement assessment can use a documented **provider
lifecycle inference**, without claiming direct process/instance visibility. Bind
both exact new deployment IDs and their expected SHA to terminal successful
`deploy_ended` receipts, observe the old deployments as deactivated, and exclude
new, queued or rollback deployments. From an independently timestamped observation
of routing/current deployment, allow at least 60 seconds plus the known effective
shutdown bound. A 360-second bound is usable only when a shutdown delay at most
300 seconds and absence of a support override are evidenced. Then reread the
provider receipts, require the exact closed gate bodies and zero other database
sessions, and separately exclude all other writers. Record the observation times,
effective bound and inference in the hashed external receipt. Waiting, green SHA,
deactivation or empty logs alone is insufficient. This follows the lifecycle in
[Render deploys](https://render.com/docs/deploys) and terminal event semantics in
[Render webhooks](https://render.com/docs/webhooks), inspected on 11 October 2026;
no automatic wait or weaker gate is added to the operator.

The existing separately approved Recovery acceptance must be complete and its
receipt retained. These prerequisites include any temporary-resource limits and
cleanup authority; this workflow creates no Recovery resource or credentials.

Three separate repository secrets are required, created by the owner only after
their authority and scope have been checked:

- `CM_NEON_LIVE_OPERATOR_DATABASE_URL`: direct TLS URL for a dedicated maintenance
  role on the exact Live database. Never use runtime, reset, retention, Recovery,
  project-owner or provider-admin credentials.
- `CM_NEON_LIVE_OPERATOR_ACCESS_KEY_ID`
- `CM_NEON_LIVE_OPERATOR_SECRET_ACCESS_KEY`: a distinct Live-branch-only operator
  credential pair; never a runtime reader or Recovery credential.

The wrapper rejects known runtime/reset/admin identities, privileged role
attributes or memberships, unexpected database destinations, debug flags and
legacy credential environment aliases. It grants nothing. Missing SELECT,
maintenance or statistics visibility is a blocking prerequisite, not authority to
add broad grants. The maintenance contract reuses the existing migration CLI.
Credential provenance and branch scope still require the external metadata
receipt; a URL or access-key string does not prove them. Secrets are present only
in the execution step, after the locked install with lifecycle scripts disabled.

## Immutable operation record

Set repository variable `CM_NEON_LIVE_OPERATOR_RECORD` to compact JSON (no leading
or trailing whitespace). Its SHA-256 is the explicit `record_sha256` dispatch
input. Hash the exact UTF-8 bytes, without a final newline. Retain the record,
digest, provider receipt and acceptance receipt outside workflow logs. The closed
schema requires every field below and rejects any additional field:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `operationId` | One newly reviewed 32-character lowercase hex operation identifier |
| `direction` | `copy` or `rollback` |
| `sourceSha` | Exact reviewed merged main commit containing this workflow |
| `projectId` | `divine-shape-86658581` |
| `branchId` | `br-summer-rice-b1f8voyp` |
| `databaseEndpointId` | `ep-solitary-thunder-b1ydpuiq` |
| `databaseHost` | `ep-solitary-thunder-b1ydpuiq.c-5.eu-central-1.aws.neon.tech` |
| `databaseName` | `conference_manager_demo_shared` |
| `bucket` / `region` | `conference-manager-media` / `eu-central-1` |
| `deployedApiSha` | `566402fd098c298ff09ec3230ddd0b55d4ea91f6` |
| `servedFrontendSha` | `5d5102b4f9842ec704ff26441ebe96719324ddb0` |
| `operatorRole` | `cm_demo_migration`, independently checked against the actual maintenance identity |
| `issuedAt` / `expiresAt` | Fixed UTC timestamps `YYYY-MM-DDTHH:mm:ss.sssZ`, at most 90 minutes apart |
| `manifestSha256` | Inventory digest from preflight, or `null` for preflight only |
| `externalEvidenceSha256` | SHA-256 of the independently reviewed current provider/retirement receipt |
| `recoveryEvidenceSha256` | SHA-256 of the accepted Recovery receipt |
| `customerDeploymentId` / `platformDeploymentId` | Distinct exact Render deployment identifiers bound in the external receipt |

The API/frontend pins and deployment IDs are **expected externally verified
identities**, not observed facts produced by the wrapper. Its source SHA is
separately checked against Git HEAD and the dispatch SHA. A record digest binds
the evidence references and scope; it does not validate the evidence's contents.

A pre-outage `preflight` with null manifest is read-only and never mutation
authority. It reads bounded metadata, validates every current and historical
Room reference, hashes retained PostgreSQL bytes, and GET-verifies each existing
published object revision. It reports `preflight_only`, even with zero assets.
If no published object exists, `providerReads` is zero and
`providerReadVerified` remains false: storage credentials and provider access
have not been exercised. Do not claim complete operational acceptance from this
case or create a write probe. Use the independently checked credential metadata
and separately approved acceptance evidence; stop if required proof is missing.

After closure and external retirement verification, freeze the final record with
the full inventory digest and current external receipt before the first mutation.
Preserve the **same operation ID, issuedAt and expiresAt** from preparation;
finalization does not restart the clock. Retain both preparation and final record
digests. Every batch and final reconciliation uses the final bytes/digest. Never
edit the record to extend the deadline, refresh a failed run, accept drift, or
change destination/source. Any new scope requires a separately reviewed owner
decision; the workflow cannot authorize one. An expired record always blocks.

## Execution and outcomes

1. Complete read-only preflight while the services can still be open. Resolve
   missing role privileges, malformed historical references, inventory caps or
   unknown credential scope before starting an outage.
2. Follow the cutover runbook to close both runtimes, retire old instances and
   exclude all writers; retain the fresh external evidence. Finalize the record
   within its original deadline. The wrapper independently requires healthy
   deployment probes, closed ordinary readiness/session routes, zero **all other**
   database sessions, zero prepared transactions, exact identity and schema.
3. Dispatch `copy` for one kind. Each run calls the existing CLI once, at most ten
   assets, with a 60-second process bound and no retries. It retains PostgreSQL
   bytes and custody. `incomplete` is an honest successful bounded batch outcome,
   not final migration success. Inspect the evidence before manually deciding on
   another batch of either kind within the same deadline.
4. Dispatch `reconcile`/`none`. Only a complete inventory with all current and
   retained historical rows in the requested state can return `reconciled` and
   `complete:true`. Every published object gets full length/MIME/SHA verification;
   copy requires every retained PostgreSQL blob to remain valid. Both closed HTTP
   and SQL checks repeat, and a final snapshot must match. Service reopening and
   Hosted acceptance remain separate owner steps in the existing runbook.
5. For an authorized rollback, prepare a separately reviewed fixed rollback
   record, close/retire/exclude writers again, and select `rollback` per kind. The
   existing CLI materializes the **current provider revision**, including when
   retained PostgreSQL bytes are missing/stale, then clears its pointer atomically.
   Final rollback reconciliation requires no published pointers and valid bytes
   for every current/historical row. Objects/custody are retained; nothing purges.

A bounded run lasts at most three minutes, with an absolute operation deadline
and 15-second finish reserve. Reads cap at 1,000 asset rows/128 MiB, 10,000 custody
rows, 20,000 current rooms and revision rows, 20,000 total historical room records,
2,000 rooms per historical revision and 20 media IDs per room. Exceeding a cap
fails closed for manual assessment. These are operator limits, not product limits.

The sole uploaded file is `live-media-operator-result.json`: fixed enums, counts,
hashes and approved resource IDs. No row IDs, object keys, URLs, SQL data, raw
errors, provider headers, credentials or signed URLs are logged. An existing
custody-only orphan does not prove a provider object exists and is not GET-read.

Timeout, cancellation, malformed CLI output or nonzero exit after a batch starts
leaves an **unknown mutation outcome**. Missing/incomplete artifacts are also
unknown. Do not rerun or resume mutation automatically; keep services closed,
independently reconcile within the original authority, and investigate. Workflow
reruns are blocked; a fresh dispatch cannot itself supply the missing review.
The concurrency group excludes other instances of this operator only. It does
not stop retention, reset, runtime writers, or provider changes. SQL checks reject
their sessions, but the external exclusion prerequisite remains mandatory.

## Validation and remaining execution gates

`tests/live-media-operator.test.js` covers record/source/deadline boundaries,
single-batch outcome integrity, privacy, partial/unknown outcomes and reconciliation.
`tests-db/live-media-operator.test.js` runs automatically in the normal PostgreSQL
CI job and exercises the actual SQL against current, inactive and historical
references, ownership, corrupt metadata/bytes, custody and extra sessions.
Neither fixture tests nor a green workflow demonstrates Live execution. Review
required CI, owner/provider evidence and real run artifacts before each gate.
