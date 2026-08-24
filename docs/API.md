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

Returns HTTP 200 with `ready` only when registered readiness dependencies complete successfully within their bound. PostgreSQL deployments require connectivity and the exact expected schema version. Failure returns HTTP 503 with `not_ready` without naming internal dependencies.

### `GET /api/v1/session`

Requires a valid `cm_session` HttpOnly cookie. Missing, malformed, expired, revoked or stale-privilege sessions return HTTP 401.

After Principal resolution, the server validates that every role and permission belongs to the recognized Tenant authorization model. Unknown role/permission values fail closed with HTTP 403.

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

The server revokes the session in PostgreSQL, clears `cm_session`, and returns HTTP 204. A cleared client cookie without server-side revocation is not considered logout.

### `GET /api/v1/requests/{requestId}`

Returns one Request after active-Tenant and object-level authorization.

Employee requires `request:read` and server-side ownership (`request.requester_user_id === principal.userId`). Conference Manager requires `request:read` and may read another Employee's Request only inside the authenticated Tenant. Tenant Admin does not inherit this capability.

The authorization snapshot is validated before Request persistence is queried. An unknown role or permission therefore fails closed before object lookup.

The repository lookup is scoped directly by the internal Tenant ID plus Request ID. A client Tenant header/query parameter cannot change the lookup scope.

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

The foundation response omits internal `tenantId` and `requesterUserId` to minimize unnecessary authority/identity metadata in browser output.

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

A valid transition from an ineligible current state or a concurrent status change returns HTTP 409 with `REQUEST_STATE_CONFLICT`.

See `docs/AUTHORIZATION.md` for the role/permission and transition matrix.

## Session issuance

There is intentionally no public client-controlled session-creation endpoint in SaaS 0.

A future identity-provider callback/adapter validates the external authentication protocol and maps the provider identity to an internal trusted identity. Only that trusted server-side adapter calls `createSessionService.issue(...)` and sends its `Set-Cookie` result to the browser.

This keeps Entra-specific claims and provider token formats outside business/API services.

## Tenant-scoped business endpoints

Tenant-owned endpoints derive Tenant context from the server Principal before application/repository access. Productive business operations require an active Tenant unless a narrower onboarding lifecycle rule is explicitly documented.

A valid resource ID belonging to another Tenant must not be globally resolved and filtered afterwards; repository access is scoped by construction.

Roles and permissions are not interchangeable. A business capability requires a recognized permission plus a recognized role allowed to use that permission. `platform_admin` is not a Tenant role.

## Request boundary

- Allowed methods: GET, POST, PUT, PATCH, DELETE.
- TRACE/CONNECT and other methods fail closed.
- Host must match the configured public origin.
- A present browser `Origin` must match the configured public origin exactly.
- Traversal, encoded separators, malformed encoding, backslashes and absolute/protocol-relative targets are rejected before routing.
- JSON state changes use bounded body parsing and positive schemas; unknown fields are rejected.
- Client-controlled Tenant/User/role/permission/provider/owner/workflow-status values never establish server authority.
- Protected POST/PUT/PATCH/DELETE operations require authenticated Principal resolution and session-bound CSRF verification.

See `docs/AUTHORIZATION.md`, `docs/IDENTITY-SESSION.md`, `docs/TENANCY.md`, and `docs/SECURITY.md`.
