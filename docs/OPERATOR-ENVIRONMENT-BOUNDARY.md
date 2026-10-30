# Operator credential boundary

Tracking: floriankreutzer/conference-manager#432, INF-27.

`live-media-operator.yml` and `demo-copy-discard.yml` use the same dedicated
`live-media-operator` GitHub Environment and serialized concurrency group.
Both are manual, canonical-repository, owner-only, first-attempt Main workflows.
Their existing immutable-source, approval-record, deadline and bounded-operation
checks remain mandatory. An infrastructure rollout does not authorize an operator
invocation, data mutation, copy or discard.

## Administration and activation

1. Configure the Environment with exactly the Branch rule `main`, zero tag rules,
   no wildcards and administrator bypass disabled. YAML alone does not create
   these provider-side protections.
2. Move the three existing credentials into this Environment only:
   `CM_NEON_LIVE_OPERATOR_DATABASE_URL`, `CM_NEON_LIVE_OPERATOR_ACCESS_KEY_ID`,
   `CM_NEON_LIVE_OPERATOR_SECRET_ACCESS_KEY`. Preserve their existing recipients,
   scopes and permissions. Never print or recover encrypted GitHub values through
   an Actions job; the credential owner must securely enter write-only values.
3. After verifying the destination names and authorization, remove accessible
   repository/organization fallback copies in a coordinated maintenance window.
   GitHub resolves repository secrets when no Environment secret of that name
   exists, so merely adding `environment:` does not close the finding.
4. Verify actual Environment policy and secret-name readback. A rejected non-main
   Environment job must be secret-free and must not invoke any operator script.
   A real preflight still needs its separately accepted operation record.

Until secret migration and the external policy are verified, INF-27 remains open
and neither operator workflow may be dispatched for this infrastructure task.
`ROOM_MEDIA_RETENTION_DATABASE_URL` belongs to the standalone maintenance CLI in
`scripts/room-media-retention.mjs`; `docs/ROOM-MEDIA-OPERATIONS.md` explicitly
retires its former Actions scheduler. No current workflow consumes it. Retire
the unused repository copy only after its owner confirms the separately secured
maintenance credential remains available; do not invoke the retention CLI to
test this infrastructure change. No credential values or private operation records belong in issues,
pull requests or artifacts.
