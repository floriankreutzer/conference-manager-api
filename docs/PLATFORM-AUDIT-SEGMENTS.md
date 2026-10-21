# Independently signed INT Platform audit segments

Schema 66 introduces an explicit, owner-operated cutover for a retained Demo-only
Platform audit history whose original signing key is unavailable. It does not
repair or authenticate that history. Customer/Tenant audit is a separate domain.
No HTTP endpoint administers segments or accepts a caller-selected audit segment.

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
