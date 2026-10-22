# Independently signed INT Platform audit segments

Schema 66 introduces an explicit, owner-operated cutover for a retained Demo-only
Platform audit history whose original signing key is unavailable. It does not
repair or authenticate that history. Customer/Tenant audit is a separate domain.
No HTTP endpoint administers segments or accepts a caller-selected audit segment.
Segment IDs and deployment epochs must use canonical lowercase UUIDs. Offline
requests (including correlation IDs) and runtime segment configuration reject uppercase spellings before
signing or persistence so PostgreSQL UUID canonicalization cannot change a binding.

## Preserved evidence and signing boundary

Existing event IDs, global sequences, payloads, signatures, previous hashes,
checkpoints and the legacy singleton head remain unchanged. Version 1 rows keep
null segment columns. An owner-observed inventory digest records the retained
prefix at cutover; this digest is not proof of its original authenticity.

The new immutable segment binds its ID, INT environment, deployment epoch,
legacy count and inventory digest into the version 2 signing domain. Events bind
both their global sequence and their segment-local sequence. The canonical
version 1 event payload is embedded inside this separately domain-separated
version 2 envelope. It is never signed as a replacement legacy event.

The signed first event is an audit-only `offline_owner` genesis. It grants no
identity, role, credential, session or browser authority. With 124 retained events,
genesis is global event 125. Local checkpoint 32 refers to global event 156,
irrespective of the legacy checkpoint alignment. New heads/checkpoints live in
separate tables. The old head/checkpoints are frozen after cutover.

## Offline operation

Keep both protected processes closed throughout migration and cutover. Use an
independently authenticated catalog owner connection with verified TLS and the
existing offline configuration contract. Runtime role credentials cannot perform
initialization. Never pass database URLs, keys or request documents as command
arguments, workflow inputs or logged output.

1. Verify the exact immutable API/frontend pair and all required gates. Review
   the exact migration ledger, retained data, backup/restore evidence and every
   affected audit domain independently. Do not infer Tenant-audit readiness from
   Platform-audit verification.
2. Apply canonical migration 66 and Demo overlay 29 using the existing retained
   migration gate. Preserve the canonical Demo seed/checksum and both reset-cycle
   acceptance journeys. The new segment tables are recognized metadata, never
   added to the Demo reset table list or granted Demo reset rights.
3. Obtain a bounded owner inventory with `platform_legacy_audit_inventory()`.
   Reconcile its count/digest with the reviewed cutover request. More than 3,200
   retained events requires a separate reviewed operation; initialization refuses.
4. Run `scripts/platform-audit-segment-initialize.mjs` with its exact request on
   descriptor 3. The request contains `environment`, `segmentId`,
   `deploymentEpoch`, `legacyEventCount`, `inventoryDigest`, `approvalReference`
   and `correlationId`. Independent expected values come from
   `PLATFORM_AUDIT_SEGMENT_ID`, `PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH`,
   `PLATFORM_AUDIT_SEGMENT_LEGACY_EVENT_COUNT` and
   `PLATFORM_AUDIT_SEGMENT_INVENTORY_DIGEST`.
5. Initialization atomically rechecks owner identity, deployment, inventory,
   existing history and absence of real operators, real runtime classifications,
   credentials, enrollment grants and prior bootstrap. An exclusive metadata
   fence excludes legacy appends. It commits metadata, the new head and verified
   signed genesis together. Failure rolls everything back. A second initialization
   cannot append another genesis or replace the segment.
6. Run `scripts/platform-audit-segment-runtime-grants.mjs` with the exact
   `environment`, `securityEpoch`, `segmentId` object on descriptor 3. This
   owner-only operation checks the ledger, active deployment, signed segment,
   existing fixed INT roles and absence of their live connections. It grants only
   the new per-surface rights and revokes Platform UPDATE on the old head and
   INSERT on old checkpoints. Do not rerun the fresh-role installer on existing
   roles. Grant application is transactional and can be retried while services
   remain closed; it does not repeat initialization.
7. Bind the protected Platform profile to `PROTECTED_PLATFORM_AUDIT_SEGMENT_ID`
   and the exact deployment epoch. Readiness verifies the expected segment,
   genesis, current head and bounded checkpoint tail using the current HMAC key.
   Missing metadata, another deployment or a wrong key fails closed.
8. Only then use the existing first-owner bootstrap and offline passkey grant
   procedures, configured for the same segment. Their ordinary audit references
   remain global sequences. Reconcile all remaining identity, two-key enrollment,
   operational and release gates before admitting traffic.

After a segment exists, legacy appends, legacy head/checkpoint mutations,
segment replacement and audit truncation are refused. A legacy audit reference
cannot authorize a new protected synthetic handoff. Empty schema 66 can be
rolled back; a populated segment refuses rollback and requires reviewed recovery.
Do not reset the database or disable integrity triggers to make rollback pass.

## Protected Actions execution option

The owner may select `.github/workflows/protected-int-audit-segment.yml` instead
of an owner-controlled Admin computer. This changes signing-secret custody and
must be explicitly approved. It does not waive restore, independent key recovery,
source qualification, retained migration or closed-traffic requirements.

The manual workflow uses the existing `hosted-demo-initialize` protected
environment and database-operation concurrency group. Before provisioning its
secrets, independently inspect that environment's actual protection and Main-only
deployment policy; workflow YAML alone does not establish those protections.
Only the repository owner may dispatch attempt 1 on the exact accepted Main SHA.
Pinned actions, disabled checkout credential persistence, Node22 and a locked
install execute before allocation of the operation secrets. Debug logging refuses
execution. Neither request JSON nor credentials are dispatch inputs.

All following values belong in **environment secrets**, including private
metadata. Do not use repository-wide secrets or public workflow variables:

| Environment secret | Contract |
| --- | --- |
| `HOSTED_DEMO_MIGRATION_DATABASE_URL` | Existing independently authenticated catalog-owner URL; verified TLS |
| `CM_INT_AUDIT_PLATFORM_DATABASE_URL` | Existing restricted Platform runtime URL for the same database; distinct role |
| `CM_INT_AUDIT_HMAC_SECRET` | Actual current Platform signing key; not a Tenant key or test/parser key |
| `CM_INT_AUDIT_OFFLINE_ROLE` | Existing catalog-owner role |
| `CM_INT_AUDIT_SECURITY_REVISION` | Existing positive integer Platform security revision |
| `CM_INT_AUDIT_SEGMENT_ID` | Reviewed lowercase UUID |
| `CM_INT_AUDIT_DEPLOYMENT_EPOCH` | Exact existing INT deployment UUID |
| `CM_INT_AUDIT_LEGACY_EVENT_COUNT` | Independently reconciled canonical decimal inventory count |
| `CM_INT_AUDIT_INVENTORY_DIGEST` | Independently reconciled lowercase SHA256 inventory digest |
| `CM_INT_AUDIT_EXPECTED_JSON` | Independent closed object: environment, segmentId, deploymentEpoch, legacyEventCount, inventoryDigest |
| `CM_INT_AUDIT_REQUEST_JSON` | Exact canonical initializer or incremental-grants request, depending on the selected operation |
| `CM_INT_AUDIT_RECOVERY_EVIDENCE` | Closed private attestation described below |

Recovery evidence contains exactly `sourceSha`, `environment`, `deploymentEpoch`,
`restoreReference`, `custodyReference`, `servicesClosed`. Source and epoch must
match the accepted Main and reviewed operation, environment must be `int`,
servicesClosed must be true and both references must identify actually reviewed
protected evidence. References use the existing bounded approval-reference
character set. The gate validates binding and presence, **not the truth of a
restore**. Never populate this attestation from a snapshot receipt, CI fixture,
empty claim or an unexecuted plan. A change in source/epoch requires renewed
evidence reconciliation, not automatic rewriting of the references.

First complete the existing retained66/29 migration and owner inventory gate.
Dispatch `initialize` with only `expected_main_sha` and `operation`. The guard
reuses the canonical closed request validator and invokes the existing initializer
with the private request on FD3. Then reconcile the actual atomic result before
preparing the separate exact three-field grants request and dispatching `grants`.
No batch continuation, automatic retry, fresh-role installation, migration/reset,
owner bootstrap, key generation or service start is performed by this workflow.
The existing CLIs retain owner, ledger, signature, transaction and connection
checks. GitHub re-runs are refused; an uncertain result requires independent
state inspection before any new dispatch.

Private CLI success payloads are suppressed; public logs expose only a fixed
success marker or fixed refusal code. No request, environment dump, key file or
private artifact is created. Success proves only the selected CLI returned
success, not deployed readiness, actual identity/devices or release acceptance.
Keep the protected evidence separately and remove temporary operation-request
secrets after the controlled operation. Do not remove a key's independent recovery
custody or the runtime's required key merely as workflow cleanup.

## Read/export contract

Version 1 responses remain `{schemaVersion: 1, items}` for unchanged legacy/Demo
operation. A configured segment returns version 2 with the same scoped bounded
items plus `audit: {segmentId, verification: 'verified', legacy: {eventCount,
verification: 'unavailable'}}`. Only current-segment events are returned. The
legacy status must remain visible in the UI and present in downloaded JSON.
Neither a current signature nor a successful export authenticates the prefix.

Audit read/export permissions, target scope and fresh export operation proof
remain independently enforced. Page size is at most 100; cursors are global
sequences and cannot select another segment. A read failure returns no successful
page. Appends verify existing signed state before extending it.

## Required evidence

The native PostgreSQL suite covers owner custody, one-winner initialization,
transaction rollback, retained bytes/digest, checkpoint alignment, actual runtime
role grants, wrong keys, mutation/truncation denial and populated rollback denial.
Pure tests cover signature/domain binding, closed offline requests, malformed
verification context and HTTP version/cursor handling. Browser tests must cover
the visible legacy warning, permissions, export context, keyboard use, DE/EN and
small-screen reflow. WASM SQL preflights are useful development checks and are
not native PostgreSQL, concurrency, TLS or deployed acceptance evidence.
