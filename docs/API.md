# API Foundation Contract

## Base path

The browser and API share one public HTTPS origin in production. API paths are relative below `/api/`; the current version prefix is `/api/v1`.

CORS is not enabled for the normal application flow. Browser credentials use same-origin cookies.

## Response contract

Successful JSON responses use `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

Every response receives a server-generated `X-Request-Id`. Public errors expose stable machine codes/request IDs only and never include stack traces, SQL, provider payloads, credentials, session tokens or configuration.

Authorization errors use generic responses. Employee access to a missing, cross-Tenant or same-Tenant/non-owned Request is returned as `404 NOT_FOUND` rather than exposing object existence.

## Endpoints

### `GET /api/v1/health/live`

Returns HTTP 200 while the process can handle requests. It exposes no dependency details.

### `GET /api/v1/health/ready`

Returns HTTP 200 with `ready` only when registered required readiness dependencies complete successfully within their bound. PostgreSQL deployments require connectivity and exact schema version 6. Failure returns HTTP 503 with `not_ready` without naming internal dependencies.

Optional provider/dependency degradation does not change this endpoint to 503 while the core API can still safely serve traffic.

### `GET /api/v1/health/status`

Returns an aggregate operational state without revealing dependency names or configuration details.

Possible states are:

- `ready`: required dependencies and registered optional degradation checks are healthy;
- `degraded`: required dependencies are healthy, but at least one optional provider/dependency is degraded;
- `not_ready`: at least one required dependency failed or timed out.

`ready` and `degraded` return HTTP 200. `not_ready` returns HTTP 503.

Example:

```json
{
  "status": "degraded",
  "service": {
    "version": "1.2.3",
    "buildId": "20260824.1",
    "environment": "pilot"
  },
  "requestId": "server-generated-uuid"
}
```

The endpoint does not expose dependency names, hosts, provider references, Tenant/User context, connection information, provider payloads or failure text. Pilot/Production service version and build ID are bounded deployment metadata supplied by trusted configuration.

See `docs/OBSERVABILITY.md` for logging, metrics, SLO candidates and alerting semantics.

### `GET /api/v1/session`

Requires a valid `cm_session` HttpOnly cookie. Missing, malformed, expired, revoked or stale-privilege sessions return HTTP 401.

After Principal resolution, the server validates that every role and permission belongs to the recognized Tenant authorization model. Unknown role/permission values fail closed with HTTP 403. A correlated authorization-denial audit event is recorded when a valid Tenant/actor context exists.

The canonical Tenant is loaded only from the internal `principal.tenantId`. Unknown, suspended or archived Tenant context returns HTTP 403 with `TENANT_UNAVAILABLE`.

A successful response is presentation-safe and minimized:

```json
{
  "user": { "id": "internal-user-uuid" },
  "tenant": {
    "id": "internal-tenant-uuid",
    "status": "active"
  },
  "roles": ["employee"],
  "permissions": ["request:read"],
  "session": {
    "expiresAt": "2026-08-24T14:00:00.000Z"
  },
  "csrfToken": "session-bound-synchronizer-token",
  "requestId": "server-generated-uuid"
}
```

The response intentionally omits raw session token, internal session ID, token hash, provider identity reference, provider tokens/claims and security-version/database metadata.

The returned roles/permissions/Tenant values are presentation context. If the browser later sends them back, they do not become authorization input.

`csrfToken` is held in frontend runtime memory and supplied through `X-CSRF-Token` on protected unsafe requests. It must not be stored in LocalStorage/sessionStorage.

### `DELETE /api/v1/session`

Logs out the current session.

Requirements:

- valid authenticated `cm_session`;
- valid server-derived Tenant context;
- valid `X-CSRF-Token` for the current session.

Logout is credential revocation, not a business authorization grant. A syntactically valid authenticated session can therefore be revoked even if its role/permission snapshot is no longer recognized by the Tenant authorization policy. The same Principal remains denied for session presentation and all business access until a valid authorization mapping exists.

The server revokes the session and appends the correlated `session.revoked` success event in one PostgreSQL transaction, then clears `cm_session` and returns HTTP 204. A cleared client cookie without server-side revocation is not considered logout.

### `GET /api/v1/requests/{requestId}`

Returns one Request after active-Tenant and object-level authorization.

Employee requires `request:read` and server-side ownership (`request.requester_user_id === principal.userId`). Conference Manager requires `request:read` and may read another Employee's Request only inside the authenticated Tenant. Tenant Admin does not inherit this capability.

The authorization snapshot is validated before Request persistence is queried. An unknown role or permission therefore fails closed before object lookup.

The repository lookup is scoped directly by the internal Tenant ID plus Request ID. A client Tenant header/query parameter cannot change the lookup scope. Valid absent/non-owned probes are correlated through server-generated authorization-denial audit evidence where the server has a valid Tenant/actor context.

Response example:

```json
{
  "request": {
    "id": "REQ-1",
    "roomId": "room-a",
    "status": "Submitted",
    "statusReason": null,
    "startsAt": "2026-09-01T10:00:00.000Z",
    "endsAt": "2026-09-01T11:00:00.000Z",
    "internalParticipants": 5,
    "externalParticipants": 1,
    "statusChangedAt": "2026-08-24T08:00:00.000Z",
    "updatedAt": "2026-08-24T08:00:00.000Z"
  },
  "requestId": "server-generated-uuid"
}
```

The response omits internal `tenantId` and `requesterUserId` to minimize unnecessary authority/identity metadata in browser output.

### `POST /api/v1/requests/{requestId}/transitions`

Executes a server-defined Request workflow transition. It requires authenticated Principal, recognized authorization snapshot, active Tenant, valid session-bound CSRF token and explicit transition authorization.

Body without reason:

```json
{
  "transition": "confirm"
}
```

Body for a transition that requires a reason:

```json
{
  "transition": "reject",
  "reason": "No suitable room is available."
}
```

Accepted transition names are `start_review`, `confirm`, `reject`, `request_change` and `cancel`. The browser never sends the target status. Unknown body fields are rejected, including `tenantId`, `requesterUserId`, `owner`, `role`, `permission`, `status` and `nextStatus`.

A successful transition and its `request.transition` audit event are committed in the same PostgreSQL transaction. If required audit persistence fails, the workflow mutation is rolled back. Validation, authorization and concurrent-state failures record correlated no-mutation failure/denial evidence where applicable.

A valid transition from an ineligible current state or a concurrent status change returns HTTP 409 with `REQUEST_STATE_CONFLICT`.

See `docs/AUTHORIZATION.md` for the role/permission and transition matrix.

### `GET /api/v1/audit`

Returns presentation-safe audit/security events for the authenticated Tenant only.

Requirements:

- valid server-side session;
- known Tenant context derived from `principal.tenantId`;
- recognized authorization snapshot;
- Tenant Admin role;
- explicit `tenant:audit:read` permission.

The endpoint never accepts a Tenant ID. Supported optional query parameters are:

- `limit`: integer 1-100, default 50;
- `beforeId`: positive numeric cursor from a previous page.

Unknown query fields, duplicate query fields, malformed limits and malformed cursors return HTTP 400 `VALIDATION_FAILED`.

Before any event is returned, the server verifies the complete HMAC chain for the authenticated Tenant. A verification failure returns HTTP 503 `AUDIT_INTEGRITY_UNAVAILABLE`; unverified events are not exposed.

Example response:

```json
{
  "events": [
    {
      "id": "42",
      "actorUserId": "internal-user-uuid",
      "action": "request.transition",
      "targetType": "request",
      "targetId": "REQ-1",
      "previousState": { "status": "Submitted" },
      "newState": { "status": "Confirmed" },
      "occurredAt": "2026-08-24T09:00:00.000Z",
      "correlationId": "server-request-uuid",
      "outcome": "success",
      "metadata": { "reasonProvided": false, "transition": "confirm" },
      "retentionClass": "business"
    }
  ],
  "nextBeforeId": "42",
  "requestId": "server-generated-uuid"
}
```

Public output intentionally omits Tenant ID, `previousHash`, `eventHash` and `integrityVersion`. Every successful audit read appends an `audit.read` security event. Denied audit-read attempts with a valid Tenant/actor context append `authorization.denied`.

See `docs/AUDIT.md` for the full audit/integrity contract.

## Session issuance

There is intentionally no public client-controlled session-creation endpoint in SaaS 0.

A future identity-provider callback/adapter validates the external authentication protocol and maps the provider identity to an internal trusted identity. Only that trusted server-side adapter calls `createSessionService.issue(...)` and sends its `Set-Cookie` result to the browser.

Successful session issuance and its `session.issued` event are persisted atomically. Provider tokens/subjects and raw session credentials are not audit metadata.

## Tenant-scoped business endpoints

Tenant-owned endpoints derive Tenant context from the server Principal before application/repository access. Productive business operations require an active Tenant unless a narrower onboarding lifecycle rule is explicitly documented.

A valid resource ID belonging to another Tenant must not be globally resolved and filtered afterwards; repository access is scoped by construction.

Roles and permissions are not interchangeable. A business capability requires a recognized permission plus a recognized role allowed to use that permission. `platform_admin` is not a Tenant role.

Tenant-visible audit access follows the same Tenant boundary but uses its own `tenant:audit:read` capability. Platform/operator audit is a separate authorization domain.

## Request boundary

- Allowed methods: GET, POST, PUT, PATCH, DELETE.
- TRACE/CONNECT and other methods fail closed.
- Host must match the configured public origin.
- A present browser `Origin` must match the configured public origin exactly.
- Traversal, encoded separators, malformed encoding, backslashes and absolute/protocol-relative targets are rejected before routing.
- JSON state changes use bounded body parsing and positive schemas; unknown fields are rejected.
- Audit pagination accepts only bounded explicit query fields.
- Client-controlled Tenant/User/role/permission/provider/owner/workflow-status/audit-authority values never establish server authority.
- Protected POST/PUT/PATCH/DELETE operations require authenticated Principal resolution and session-bound CSRF verification.
- Operational request logs use fixed route keys rather than dynamic URL paths.
- Metrics accept only fixed low-cardinality labels; Tenant/User/Request/provider identifiers are prohibited dimensions.

See `docs/AUDIT.md`, `docs/AUTHORIZATION.md`, `docs/IDENTITY-SESSION.md`, `docs/OBSERVABILITY.md`, `docs/TENANCY.md`, and `docs/SECURITY.md`.
