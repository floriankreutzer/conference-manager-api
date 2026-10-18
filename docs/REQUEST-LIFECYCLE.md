# Request start and explicit abandonment

## Scope and authority

This additive contract supplies the previously absent pre-submission Request clock. It reuses the
authenticated Employee application, the PostgreSQL Request transaction and the existing HMAC audit
chain. It has no tracking vendor, browser analytics event stream or draft-content upload.

The browser signals the first material edit of a new Request. The server records when that signal
is accepted. Merely opening the editor is not a start. A confirmed **Discard draft** action requests
abandonment. Cancelling that confirmation, navigating between views, reloading, closing a tab,
inactivity and local draft expiry do not imply abandonment. This implementation defines no automatic
expiry transition: no trustworthy server expiry deadline existed to justify one.

An owner resubmission of a `Change Requested` Request uses the existing resubmission contract and
does not start another first-submission lifecycle. Repeating a prior Request starts a new lifecycle
when its new draft is materially edited or explicitly submitted.

## State and identity

| State | Meaning | Permitted next state |
| --- | --- | --- |
| `started` | Server accepted a content-free first-edit signal. | `submitted` or `abandoned` |
| `submitted` | First Request revision and required audit committed. | Terminal |
| `abandoned` | Owner explicitly confirmed discarding the draft. | Terminal |

The server creates one UUID for a workflow. That UUID becomes the actual Request ID on first
submission. `(tenant_id, owner_user_id, idempotency_key)` uniquely identifies a start retry. Tenant,
owner, User security version and clocks come from trusted server context and current locked rows;
the browser never submits them as authority. The idempotency key is an opaque UUID locator, not a
credential or a way to weaken ownership or concurrency checks.

## HTTP contract

`POST /api/v1/application/request-workflows` requires an authenticated Employee allowed to create
Requests, an active Tenant, the session-bound CSRF header, UUID `Idempotency-Key`, and body `{}`.
The first call creates the workflow and `request.started` audit event atomically. A retry with the
same owner-scoped key returns the existing workflow in its current state without another event.

`POST /api/v1/application/request-workflows/{workflowId}/abandon` has the same authority and CSRF
requirements and body `{}`. A started workflow becomes abandoned atomically with its audit event;
an already abandoned workflow is returned unchanged. A submitted workflow returns
`409 REQUEST_STATE_CONFLICT`. Missing, foreign-Tenant and same-Tenant non-owned workflow identifiers
are concealed. Inactive Users, stale security epochs and inactive Tenants cannot mutate the row.

Both endpoints return HTTP 200 with this exact schema-version-1 envelope:

```json
{
  "schemaVersion": 1,
  "workflow": {
    "id": "11111111-1111-4111-8111-111111111111",
    "status": "started",
    "startedAt": "2026-10-18T09:00:00.000Z",
    "endedAt": null
  },
  "requestId": "22222222-2222-4222-8222-222222222222"
}
```

`requestId` is the normal HTTP correlation identifier. The reserved Request ID is `workflow.id`.
`endedAt` is null only while started; terminal timestamps are canonical UTC server instants no
earlier than the start. Unknown body fields, content, actor/scope fields, clocks, state overrides,
queries, malformed UUIDs, non-JSON content and unsupported methods fail the existing bounded HTTP
validation boundary. No client-supplied audit timestamp is accepted.

## Submission, retries and atomicity

The existing create endpoint accepts optional `workflowId` beside `schemaVersion` and `request`.
For a workflow-bound create, the repository first locks and revalidates the active Tenant and the
owner's current User security version, then the owner-scoped workflow row. Normal current
configuration, Room/Site, pricing, allocation and Request validation remain mandatory for first
submission. Request insertion, immutable first revision, `request.created` audit and workflow closure
commit in one transaction. Any required audit failure rolls back every affected row.

The server computes an internal SHA-256 fingerprint of the normalized composition version and
draft. Concurrent identical submissions create one Request; retries return its immutable first
public revision even if later workflow changes have advanced the current Request. Changed normalized
content conflicts instead of silently replacing a committed Request. Fingerprints remain internal;
they are never audit metadata, browser response fields or product-metric dimensions.

If a successful submission response is lost, the browser retains its opaque key and workflow ID.
An unchanged retry is safe. If the user instead confirms discarding the remaining local draft, the
server refuses to abandon the submitted workflow. The browser then retries the same idempotent start
key to confirm that exact UUID is already submitted before clearing local input. This recovery does
not alter the Request or record an abandonment. Transport or authorization failures do not pretend
that the server accepted a transition.

## Browser draft compatibility

The Employee store retains its existing single bounded `sessionStorage` key and exact authenticated
Tenant/User/session-expiry scope. Envelope v5 adds only an untrusted opaque `idempotencyKey` and
nullable `workflowId`; no authoritative clock, workflow status, permission or credential is stored.
The key is retained before transport so interrupted starts retry safely. Reference updates compare
the stored key before writing, preventing a late response from overwriting a replacement draft.

Existing v4 drafts remain readable without a historical start reference. Subsequent material input
or explicit submission may establish a new server start; old local timestamps are not backfilled.
Discarding an untouched form, including an untouched restored v4 draft, invents no start or
abandonment. Session/scope invalidation continues to clear local draft state.

## Audit, privacy and product coverage

The lifecycle ledger stores only Tenant/owner identity, opaque IDs, state, server times and the
internal submission fingerprint. It contains no title, requirements, attendee details or editor
content. Audit uses the existing business retention class and HMAC sequence:

| Action | Target | Successful outcome |
| --- | --- | --- |
| `request.started` | `request`, reserved UUID | One accepted start |
| `request.abandoned` | Same target | One confirmed explicit abandonment |
| `request.created` | Same target | One first submission |

Tenant audit access recognizes the two new actions under the existing Request category and applies
its unchanged Tenant/permission/minimized-output boundary. Product aggregation pairs only verified
events with the same Tenant and target ID. It must not treat old first submissions as observed starts,
resubmissions as new first submissions or unobserved abandonment as measured zero. See
[Product and delivery](PRODUCT-DELIVERY.md) for coverage windows and aggregation semantics.

## Persistence and rollout

Canonical migration **045** creates `request_workflow_starts`, enforces Tenant-composite owner and
Request foreign keys, state/link/time constraints and immutable identity/terminal transitions, and
extends the audit action allowlist. Demo overlay **010** grants Customer only `SELECT/INSERT/UPDATE`
and Reset only `SELECT/TRUNCATE` on that table. Platform/Ops receives no direct lifecycle-table
access; its separate minimized verified aggregation path is defined by overlay **011**.

Apply reviewed migrations before deploying compatible API processes and then the Employee frontend.
Existing exact v2/v3 callers without `workflowId` remain compatible during rollout. The application
does not auto-migrate and current readiness requires canonical 45 and the current Demo overlay.
The lifecycle table participates in the existing exclusive, transactional Demo reset. The separate
product-source epoch remains outside the reset inventory, as described in the product contract.
The migration-only deployment path preserves existing Request and audit history; it does not reset
the Demo dataset. See [Hosted Demo deployment](HOSTED-DEMO-DEPLOYMENT.md).

Migration 045 down refuses before mutation if any lifecycle row or new-action audit evidence exists.
After first use, retain a compatible binary or use a forward repair; do not erase history to force
rollback. On an unused disposable installation, roll back dependent Demo overlays before canonical
045, and reapply both layers if restoring current readiness so table grants are recreated correctly.

## Verification ownership

`tests/request-draft-workflow.test.js` covers the service and HTTP authority/positive-shape boundary;
`tests/production-application-service.test.js` covers create binding and replay projection.
`tests-db/request-draft-workflow-persistence.test.js` verifies real PostgreSQL concurrency, owner and
Tenant isolation, stale security epochs, terminal-state constraints, immutable first-revision replay,
audit-failure rollback, HMAC integrity and guarded downgrade. Frontend draft/transport tests and
Chromium/WebKit Employee journeys cover first edit, navigation/reload, late responses, confirmation,
authority loss, submission and lost-response recovery. Full required CI, security and permanent
three-customer acceptance gates remain separate release requirements.
