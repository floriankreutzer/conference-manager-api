# API Foundation Contract

## Authority and base path

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/AUTHORIZATION.md`, `docs/IDENTITY-SESSION.md`, `docs/AUDIT.md` and `docs/SECURITY.md` are authoritative.

The browser and API share one public HTTPS origin in Pilot and Production. API paths use the `/api/v1` prefix. Normal browser operation is same-origin; CORS is not enabled.

## Common response and authority contract

Successful JSON responses use `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

Every response receives a server-generated `X-Request-Id`. Public errors expose stable machine codes and request IDs only. They do not expose stack traces, SQL, configuration, provider payloads, provider identifiers, credentials, session tokens or consent state.

The browser never establishes Tenant, User, role, permission, object ownership, workflow state, entitlement, provider Tenant or provider destination authority. Protected endpoints derive the internal Tenant from the resolved server session.

Unsafe cookie-authenticated operations require the current session-bound `X-CSRF-Token`, except for separately designed one-time onboarding confirmation that uses its own server-bound claim token and CSRF material.

## Health endpoints

### `GET /api/v1/health/live`

Returns HTTP 200 while the process can handle requests. It exposes no dependency details.

### `GET /api/v1/health/ready`

Returns HTTP 200 with `ready` only when required dependencies complete successfully within their bounds. PostgreSQL deployments require connectivity and the exact repository-defined schema version. The expected version advances only with the reviewed migrations in this repository; stale or partially applied schemas fail readiness. Failure returns HTTP 503 with `not_ready` without naming internal dependencies.

Optional provider degradation does not make core readiness fail while the API can still serve traffic safely.

### `GET /api/v1/health/status`

Returns aggregate `ready`, `degraded` or `not_ready` state plus bounded service version, build ID and environment. It does not expose dependency names, hosts, provider references, Tenant/User context, connection details or failure text.

See `docs/OBSERVABILITY.md`.

## Microsoft Entra authentication

### `GET /api/v1/auth/microsoft/login`

Starts the organizational multi-Tenant Microsoft Entra authorization-code flow.

The route:

- accepts GET only and no query parameters;
- creates random state and nonce plus PKCE S256 material server-side;
- persists only hashed, short-lived OIDC transaction material;
- sets the state-bound `cm_oidc_tx` HttpOnly callback-scoped cookie;
- redirects only to the fixed configured Microsoft authority.

The route accepts no Tenant ID, authority URL, redirect URI, role, permission, email domain or other identity authority from the browser.

### `GET /api/v1/auth/microsoft/callback`

Completes the Entra authorization-code flow. The callback accepts only one copy of bounded documented Microsoft fields. Unknown or duplicate parameters fail validation.

Before shared state is consumed, the callback must present the `cm_oidc_tx` value created in the browser that initiated that state. The server validates the state-bound HMAC, then atomically consumes the transaction before redeeming the authorization code.

The Entra adapter validates provider protocol output and required token claims before producing a provider-neutral external identity. Provider values do not become an internal Principal directly.

Fixed same-origin outcomes are:

- `/` after successful internal Tenant/User resolution and server session issuance;
- `/?auth=tenant_onboarding_required` when a valid external identity has no usable internal mapping;
- `/onboarding?auth=confirm` when explicit Tenant-claim confirmation is required;
- `/?auth=authentication_failed` for safe authentication failure handling.

Provider errors, descriptions, tokens, claims, transient browser-binding values and secrets are not reflected into public output or logs.

See `docs/ENTRA-AUTHENTICATION.md`.

## Invitation-based Tenant onboarding

### `POST /api/v1/onboarding/invitations/start`

Starts onboarding with an exact JSON body:

```json
{
  "invitationToken": "43-character-browser-safe-token"
}
```

The server validates the invitation, starts the Entra flow bound to that invitation and returns only the fixed-origin Microsoft `authorizationUrl` plus `requestId`. Unknown fields, invalid tokens and query parameters are rejected.

### `GET /api/v1/onboarding/claim`

Reads the pending claim represented by the server-issued `cm_tenant_claim` cookie. It returns only the presentation-safe Tenant confirmation data, expiry, claim-bound CSRF token and request ID.

### `POST /api/v1/onboarding/claim`

Confirms the pending claim with the same claim cookie, its `X-CSRF-Token` and exact body:

```json
{
  "confirm": true
}
```

The claim token is single-use and actor/provider-bound. The server clears the claim cookie after successful confirmation. Tenant identity and role authority are never accepted from the body.

## Application session

### `GET /api/v1/session`

Requires a valid `cm_session` HttpOnly cookie. Session resolution checks token hash, expiry, revocation, active User, current User `security_version`, Tenant lifecycle and recognized role/permission values.

A successful response contains only presentation-safe context:

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
    "expiresAt": "2026-08-25T14:00:00.000Z"
  },
  "csrfToken": "session-bound-synchronizer-token",
  "requestId": "server-generated-uuid"
}
```

The response omits the raw session token, internal session ID, token hash, provider identity, provider tokens and security-version metadata. Returned Tenant, role and permission values are presentation context and do not become authority when submitted back by the browser.

### `DELETE /api/v1/session`

Requires the authenticated session and valid CSRF. The server revokes the session and appends `session.revoked` evidence in one PostgreSQL transaction, clears the cookie and returns HTTP 204.

See `docs/IDENTITY-SESSION.md`.

## Production application contract

The production browser uses one same-origin, server-authoritative application contract. Successful application responses contain `schemaVersion: 1`; the browser rejects unsupported or malformed envelopes and never falls back to demo storage.

The current routes are:

- `GET/PUT /api/v1/application/profile`;
- `GET /api/v1/application/catalog`;
- `GET /api/v1/application/site-info`;
- `GET/POST /api/v1/application/requests`;
- `POST /api/v1/application/room-availability`;
- `GET /api/v1/application/notifications`;
- `PATCH /api/v1/application/notifications/{notificationId}`;
- `GET/PUT /api/v1/application/configuration`.

All routes derive Tenant and User authority from the resolved Principal. Mutations require CSRF and exact positive-schema bodies. Public representations omit internal Tenant ownership, requester identity, provider identities/references, credentials, audit-chain material and other authority-shaped infrastructure fields.

Employee Request lists are restricted to server-side ownership. Conference Managers with the separate Request management permission receive the Tenant-wide Request list. Tenant configuration requires Tenant Admin permission; Tenant Admin alone does not inherit Conference Manager Request access.

`catalog.sites[]`, `siteInfo.sites[]` and `configuration.sites[]` expose the same minimized Site shape: `id`, `name`, `active` and `timeZone`. `timeZone` is the server-authoritative IANA time-zone identifier for that physical Site, for example `Europe/Berlin`. Existing Sites migrated without an established value expose `timeZone: null`; the server and browser must not replace that unknown state with browser-local time or UTC.

`PUT /api/v1/application/configuration` requires every submitted Site to contain a positively validated `timeZone` in addition to `id`, `name` and `active`. Canonical identifiers recognized by the server IANA/`Intl` database, including `UTC`, are accepted. Unknown fields, missing values, surrounding whitespace and unrecognized identifiers fail with HTTP 400 `VALIDATION_FAILED`. Configuration writes remain Tenant-scoped and audit-atomic.

A Request or room-availability check for an inactive/missing room or Site is concealed as unavailable. A room whose active Site has no valid authoritative time zone is not bookable and returns HTTP 409 `SITE_TIME_ZONE_REQUIRED` before local Request mutation or provider access.

`POST /api/v1/application/requests` accepts the same canonical UTC schedule boundary as room availability: both timestamps must equal their ECMAScript `toISOString()` representation, the end must be later than the start, and the interval must not exceed 24 hours. Offset, local, non-canonical, and longer intervals fail with HTTP 400 `VALIDATION_FAILED` before persistence, preventing Requests that the authoritative availability path could never validate.

### `POST /api/v1/application/room-availability`

This is the advisory production Employee room-search check required before the browser creates a Request. It accepts only:

```json
{
  "roomId": "internal-room-id",
  "startsAt": "2026-09-01T10:00:00.000Z",
  "endsAt": "2026-09-01T11:00:00.000Z"
}
```

The server requires an active Employee Principal, the internal `microsoft.calendar` entitlement, a canonical UTC interval of at most 24 hours, the Tenant-owned local room, its active Site with an authoritative IANA time zone and its active Microsoft mapping. It checks Tenant-scoped local Request overlap first and then performs a live Free/Busy lookup through the fixed Microsoft provider boundary. The browser cannot submit a Tenant, User, provider Tenant, mailbox, Graph URL, token or availability result.

A successful minimized response is:

```json
{
  "schemaVersion": 1,
  "availability": {
    "available": true,
    "conflictCount": 0
  }
}
```

Local or provider busy state returns `available: false`. Missing entitlement/mapping/connection, provider authorization, throttling, timeout or malformed provider data returns the stable HTTP 503 code `ROOM_AVAILABILITY_UNAVAILABLE`; it never produces false availability. The check is advisory: authoritative Conference Manager confirmation still repeats uncached final validation and the local room-lock operation.

## Tenant audit

### `GET /api/v1/audit`

Requires Tenant Admin plus `tenant:audit:read`. The endpoint accepts no Tenant selector.

Optional query parameters are:

- `limit`: integer 1-100, default 50;
- `beforeId`: positive numeric cursor.

Unknown or duplicate fields and malformed values fail validation. Before any events are returned, the server verifies the complete HMAC chain for the authenticated Tenant. Integrity failure returns HTTP 503 `AUDIT_INTEGRITY_UNAVAILABLE`.

Public events omit Tenant ID and HMAC-chain fields. Successful reads append `audit.read`; denied valid-context probes append `authorization.denied`.

See `docs/AUDIT.md`.

## Tenant User role administration

### `GET /api/v1/tenant/users`

Requires Tenant Admin plus `tenant:users:manage`. It accepts no Tenant selector.

Optional query parameters are:

- `limit`: integer 1-100, default 100;
- `afterId`: internal User UUID cursor.

The response contains Tenant-scoped presentation-safe Users and `nextAfterId`. Cross-Tenant Users cannot be resolved through this endpoint.

### `PUT /api/v1/tenant/users/{userId}/roles`

Requires Tenant Admin plus `tenant:users:manage` and valid CSRF. The path User ID is resolved only inside the authenticated Tenant.

Exact body:

```json
{
  "roles": ["conference_manager", "tenant_admin"]
}
```

Only the elevated Tenant roles `conference_manager` and `tenant_admin` are accepted in this administration body. The baseline `employee` role remains server-managed. Duplicate, unknown or oversized role sets fail validation.

The operation prevents removal of the last active Tenant Admin, advances the target User security version and appends `tenant.user_permissions.changed` evidence atomically. Existing sessions with stale authorization snapshots stop resolving.

## Microsoft 365 connection lifecycle

All lifecycle routes require Tenant Admin plus `tenant:integrations:manage`. The Microsoft Tenant is derived from the active server-side Entra Tenant binding of the authenticated internal Tenant.

The public connection shape is:

```json
{
  "status": "connected",
  "placesPermission": "granted",
  "calendarsPermission": "granted",
  "reason": null,
  "lastVerifiedAt": "2026-08-25T10:00:00.000Z",
  "requiredPermissions": [
    "Place.Read.All",
    "Calendars.ReadBasic.All"
  ]
}
```

Status is one of `pending`, `connected`, `degraded`, `revoked` or `disconnected`. Permission indicators and reason values are fixed bounded codes. Internal Integration IDs, internal or provider Tenant IDs, provider User IDs, state, credentials, tokens and provider payloads are omitted.

### `GET /api/v1/integrations/microsoft365`

Returns `{ connection, requestId }`. It accepts no query parameters or body. A browser-supplied Tenant selector is rejected.

### `POST /api/v1/integrations/microsoft365/connect`

Requires valid CSRF, no query parameters and an empty body.

The server authorizes the Tenant Admin, resolves the active Entra Tenant binding, creates an actor/Tenant-bound one-time consent transaction and returns:

```json
{
  "authorizationUrl": "fixed Microsoft admin-consent URL",
  "expiresAt": "2026-08-25T10:10:00.000Z",
  "requestId": "server-generated-uuid"
}
```

The browser navigates to this URL. It must not construct the Microsoft Tenant, scope or callback URL itself.

### `GET /api/v1/integrations/microsoft365/callback`

Accepts only the allowlisted Microsoft admin-consent callback fields. Duplicate fields, unknown fields, malformed state, malformed provider Tenant, inconsistent success/error combinations, control characters and oversized values fail validation.

The route requires the existing authenticated application session. State is hashed and atomically consumed using internal Tenant, actor User and expiry. Replay, expiry, different actor, cross-Tenant use, changed Entra binding, provider-Tenant mismatch and stale connection versions fail closed.

Fixed same-origin result redirects are:

- `/?integration=microsoft365_connected`;
- `/?integration=microsoft365_degraded`;
- `/?integration=microsoft365_revoked`;
- `/?integration=microsoft365_consent_denied`;
- `/?integration=microsoft365_connection_failed`.

Provider error descriptions and raw failure details are never reflected.

### `POST /api/v1/integrations/microsoft365/verify`

Requires valid CSRF, no query parameters and an empty body. The server revalidates the persisted connection against the current Entra Tenant binding and bounded fixed Microsoft endpoints, then returns `{ connection, requestId }`.

The operation can move the lifecycle among `connected`, `degraded` and `revoked`; a disconnected record is not treated as an active provider connection.

### `DELETE /api/v1/integrations/microsoft365`

Requires valid CSRF, no query parameters and an empty body. The server invalidates pending consent state, advances the connection version, clears local verification evidence and returns `{ connection, requestId }` with `disconnected` state.

Local disconnect does not claim that Microsoft administrator consent has been revoked externally in Entra.

See `docs/MICROSOFT365-CONNECTION.md`.

## Request endpoints

### `GET /api/v1/requests/{requestId}`

Returns one Request after active-Tenant and object-level authorization.

Employee access requires `request:read` and server-side ownership. Conference Manager access requires `request:read` and remains limited to the authenticated Tenant. Tenant Admin has no implicit Request access.

Repository lookup uses internal Tenant ID plus Request ID. Missing, cross-Tenant and same-Tenant non-owned Employee Requests are returned as `404 NOT_FOUND`.

The public response omits internal Tenant ownership and requester User ID.

### `POST /api/v1/requests/{requestId}/transitions`

Requires active session, recognized authorization, active Tenant, valid CSRF and an exact positive-schema body.

Examples:

```json
{
  "transition": "confirm"
}
```

```json
{
  "transition": "reject",
  "reason": "No suitable room is available."
}
```

Accepted transitions are `start_review`, `confirm`, `reject`, `request_change` and `cancel`. The browser never supplies target status. Tenant, owner, role, permission and status authority fields are rejected.

Successful transition and `request.transition` evidence commit atomically. Invalid current state or concurrent change returns HTTP 409 `REQUEST_STATE_CONFLICT`.

See `docs/AUTHORIZATION.md`.

## Request-boundary invariants

- Allowed methods are GET, POST, PUT, PATCH and DELETE; unsupported methods fail closed.
- Host must match the configured public origin.
- A present Origin must match exactly.
- Traversal, encoded separators, malformed encoding, backslashes and absolute or protocol-relative targets are rejected before routing.
- JSON state changes use bounded body parsing and positive schemas; unknown fields are rejected.
- Callback routes accept only bounded allowlisted query fields and fixed result destinations.
- Client-controlled Tenant, User, role, permission, provider, owner and workflow values never establish authority.
- Protected unsafe operations require session-bound CSRF.
- Operational logs use fixed route keys rather than dynamic paths.
- Metrics use fixed low-cardinality labels; Tenant, User, Request and provider identifiers are prohibited dimensions.

See `docs/AUDIT.md`, `docs/AUTHORIZATION.md`, `docs/ENTRA-AUTHENTICATION.md`, `docs/IDENTITY-SESSION.md`, `docs/MICROSOFT365-CONNECTION.md`, `docs/OBSERVABILITY.md`, `docs/TENANCY.md` and `docs/SECURITY.md`.
