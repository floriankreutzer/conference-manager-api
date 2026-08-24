# API Foundation Contract

## Base path

The browser and API share one public HTTPS origin in production. API paths are relative below `/api/`; the current version prefix is `/api/v1`.

CORS is not enabled for the normal application flow. Browser credentials use same-origin cookies.

## Response contract

Successful JSON responses use `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

Every response receives a server-generated `X-Request-Id`. Public errors expose stable machine codes/request IDs only and never include stack traces, SQL, provider payloads, credentials, session tokens or configuration.

## Endpoints

### `GET /api/v1/health/live`

Returns HTTP 200 while the process can handle requests. It exposes no dependency details.

### `GET /api/v1/health/ready`

Returns HTTP 200 with `ready` only when registered readiness dependencies complete successfully within their bound. PostgreSQL deployments require connectivity and the exact expected schema version. Failure returns HTTP 503 with `not_ready` without naming internal dependencies.

### `GET /api/v1/session`

Requires a valid `cm_session` HttpOnly cookie. Missing, malformed, expired, revoked or stale-privilege sessions return HTTP 401.

After Principal resolution, the canonical Tenant is loaded only from the internal `principal.tenantId`. Unknown, suspended or archived Tenant context returns HTTP 403 with `TENANT_UNAVAILABLE`.

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

The response intentionally omits:

- raw session token;
- internal session ID;
- token hash;
- provider identity reference;
- provider tokens/claims;
- security-version/database metadata.

The returned roles/permissions/Tenant values are presentation context. If the browser later sends them back, they do not become authorization input.

`csrfToken` is held in frontend runtime memory and supplied through the existing `X-CSRF-Token` contract on protected unsafe requests. It must not be stored in LocalStorage/sessionStorage.

### `DELETE /api/v1/session`

Logs out the current session.

Requirements:

- valid authenticated `cm_session`;
- valid server-derived Tenant context;
- valid `X-CSRF-Token` for the current session.

The server revokes the session in PostgreSQL, clears `cm_session`, and returns HTTP 204. A cleared client cookie without server-side revocation is not considered logout.

## Session issuance

There is intentionally no public client-controlled session-creation endpoint in SaaS 0.

A future identity-provider callback/adapter validates the external authentication protocol and maps the provider identity to an internal trusted identity. Only that trusted server-side adapter calls `createSessionService.issue(...)` and sends its `Set-Cookie` result to the browser.

This keeps Entra-specific claims and provider token formats outside business/API services.

## Tenant-scoped business endpoints

Tenant-owned endpoints must derive Tenant context from the server Principal before application/repository access. Productive business operations require an active Tenant unless a narrower onboarding lifecycle rule is explicitly documented.

A valid resource ID belonging to another Tenant must not be globally resolved and filtered afterwards; repository access is scoped by construction.

## Request boundary

- Allowed methods: GET, POST, PUT, PATCH, DELETE.
- TRACE/CONNECT and other methods fail closed.
- Host must match the configured public origin.
- A present browser `Origin` must match the configured public origin exactly.
- Traversal, encoded separators, malformed encoding, backslashes and absolute/protocol-relative targets are rejected before routing.
- JSON state changes use bounded body parsing and positive schemas; unknown fields are rejected where the schema requires exact shape.
- Client-controlled Tenant/User/role/permission/provider values never establish server authority.
- Protected POST/PUT/PATCH/DELETE operations require authenticated Principal resolution and session-bound CSRF verification.

See `docs/IDENTITY-SESSION.md`, `docs/TENANCY.md`, and `docs/SECURITY.md`.
