# Microsoft 365 Tenant Connection

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/AUTHORIZATION.md`, `docs/AUDIT.md`, `docs/IDENTITY-SESSION.md`, `docs/THREAT-MODEL.md`, and `docs/PRODUCTION-SECURE-CONFIGURATION.md` remain authoritative.

This document defines the SaaS 1 Microsoft 365 Tenant connection lifecycle. It covers Tenant Admin consent, bounded provider verification, Tenant-scoped persistence, audit evidence, reconnect, and disconnect. It does not grant the browser authority over Tenant identity, Microsoft Tenant identity, provider destinations, permissions, credentials, or booking/calendar operations.

## Trust boundaries

The Microsoft Tenant used for consent is derived from the active server-side Entra Tenant binding of the authenticated internal Tenant. The application never accepts a browser-selected internal Tenant ID or Microsoft Tenant ID as authority.

A connection lifecycle request requires:

1. an authenticated server Principal;
2. the server-derived Tenant context;
3. the `tenant_admin` role and `tenant:integrations:manage` permission;
4. a valid CSRF token for unsafe same-origin operations;
5. an active Entra Tenant binding for the same internal Tenant.

The Microsoft callback `tenant` parameter is corroborating provider input only. It must match both the trusted Entra Tenant binding and the one-time server-side consent transaction. It never selects the internal Tenant.

## Provider permissions

The base connection verifies only these Microsoft Graph application permissions:

- `Place.Read.All` for organization Places/rooms;
- `Calendars.ReadBasic.All` for basic calendar visibility verification.

The admin-consent URL uses the Tenant-specific Microsoft identity endpoint and the Microsoft Graph `/.default` scope. The configured application registration therefore defines the exact application permissions presented to the customer administrator.

`connected` requires positive bounded verification of both base permissions. If no validated claimant User reference is available, or the claimant does not expose a verifiable Exchange calendar, Calendar permission remains `unverified` and the lifecycle is `degraded` with `calendars_permission_unverified`. The service must not infer Calendar permission from successful token acquisition or Places access.

Calendar event creation, update, and cancellation require a separately reviewed write permission and Exchange Online Application RBAC scoping before those capabilities can be enabled. The base connection lifecycle must not infer or claim write access.

## HTTP contract

All routes are same-origin under `/api/v1/integrations/microsoft365`.

### Read connection state

`GET /api/v1/integrations/microsoft365`

Requires an authenticated Tenant Admin with `tenant:integrations:manage`. No query parameters or request body are accepted.

The response exposes only:

- lifecycle status;
- Places permission status;
- Calendar permission status;
- bounded reason code;
- last verification timestamp;
- required base permission identifiers.

It does not expose internal Integration IDs, internal Tenant IDs, provider Tenant IDs, consent state, credentials, access tokens, provider response bodies, or provider correlation details.

### Start admin consent

`POST /api/v1/integrations/microsoft365/connect`

Requires CSRF and an empty request body. The service:

1. authorizes the Principal against the server-derived Tenant;
2. loads the active Entra Tenant binding;
3. generates a 256-bit browser-safe random state value;
4. persists only SHA-256 of that state in a one-time, actor-bound, expiring transaction;
5. locks and revalidates the active internal Tenant/provider-Tenant binding;
6. advances the connection version with optimistic protection;
7. preserves a healthy verified connection while a same-provider reconnect is outstanding, but uses `pending` for an initial, disconnected, or provider-rebound connection;
8. appends the consent-start audit event in the same PostgreSQL transaction;
9. returns the fixed-origin Microsoft admin-consent URL and transaction expiry.

The raw state is returned only inside the Microsoft authorization URL and is never logged or persisted.

### Complete admin consent

`GET /api/v1/integrations/microsoft365/callback`

The callback accepts only the allowlisted Microsoft response keys. Duplicate keys, unknown keys, malformed state, malformed provider Tenant identifiers, inconsistent approval/error combinations, and overlong provider error fields are rejected.

The route requires the existing authenticated session. The service atomically consumes the one-time state transaction using:

- internal Tenant ID;
- internal actor User ID;
- SHA-256 state hash;
- current server time and expiry.

Replay, expired state, a different Tenant Admin, provider-Tenant mismatch, or a changed Entra binding fails closed. When an authenticated Tenant/actor context exists, malformed, denied, expired, replayed, and provider-binding-mismatch callbacks append durable redacted failure/denial evidence using stable reason codes. Raw state, provider descriptions, Tenant identifiers, and provider payloads are never included.

On approval, the server performs bounded application-permission verification against fixed Microsoft endpoints. On denial, no provider verification occurs. A failed or abandoned same-provider reconnect does not downgrade an already healthy verified connection; its prior status, permission health, reason, and verification timestamp remain authoritative. The browser is redirected only to fixed same-origin result locations; provider errors and descriptions are not reflected.

### Verify connection

`POST /api/v1/integrations/microsoft365/verify`

Requires CSRF and an empty request body. Verification uses the persisted connection plus the current active Entra Tenant binding. A provider-Tenant mismatch fails closed. The result updates status, permission indicators, reason, and `lastVerifiedAt` with optimistic connection-version protection and correlated audit evidence.

### Disconnect

`DELETE /api/v1/integrations/microsoft365`

Requires CSRF and an empty request body. Disconnect invalidates outstanding consent transactions, advances the connection version, clears verification state, and appends the disconnect audit event in the same PostgreSQL transaction.

Disconnecting the local lifecycle record does not claim that Microsoft administrator consent has been revoked in Microsoft Entra. Customer and platform runbooks must distinguish local disconnect from external service-principal permission revocation.

Local disconnect also does not discard persisted booking references or their provider/resource identity. Authorized cancellation reconciliation may use that exact persisted binding while the same Integration/provider-Tenant identity and active Entra binding still exist; it does not require the local connection to be healthy or the room mapping to remain active.

## Lifecycle states

- `disconnected`: no active local connection; permissions are unknown.
- `pending`: no usable verified local connection exists while consent is outstanding or awaiting completion.
- `connected`: both bounded base permission checks succeeded.
- `degraded`: Microsoft responded, but one or more required base permissions are missing, unavailable, or unverified.
- `revoked`: Microsoft rejects the application credential or consent in a way classified as revoked.

Reason values are fixed, bounded machine codes. Provider messages are never stored or exposed.

## Persistence and concurrency

Migration `011_microsoft365_connection_lifecycle` extends the existing Tenant-owned `integrations` table with:

- optimistic `connection_version`;
- bounded lifecycle reason;
- Places and Calendar permission status;
- last verification time.

It also creates the one-time `microsoft365_consent_transactions` table. Every row is bound to internal Tenant, actor User, Integration, provider Tenant, connection version, hashed state, creation time, and expiry.

Tenant-scoped advisory locking serializes lifecycle changes per internal Tenant. Consent start locks and revalidates the active provider-Tenant binding in the same transaction as the connection mutation and consent row. A new consent transaction invalidates an older transaction. Callback consume locks the transaction and connection, validates expiry, actor, callback Tenant, and the still-active provider binding, appends any redacted rejection evidence, and consumes the state within one transaction. After the external Graph check, consent and manual-verification finalization again lock and revalidate that exact active binding in the same transaction as the version-guarded connection update. Binding removal during the provider call therefore yields a conflict and cannot commit `connected` or verified state. Finalization succeeds only for the exact persisted connection version.

A valid active Entra rebinding may replace the connection's provider-Tenant reference only when every persisted booking reference for the connection is terminal `cancelled`. Any `pending`, `active`, `compensating` or `compensated` row blocks consent start with `MICROSOFT365_BOOKING_RECONCILIATION_REQUIRED`, because a new Tenant token cannot safely reconcile the old event. After that guard, recovery advances the connection version, resets verification to `pending`, marks existing Microsoft 365 room mappings `missing`, and clears operational capability-health snapshots in the same transaction. Room discovery, explicit mapping, and capability verification must run again for the rebound connection.

The authorized pre-activation identity-unbind path applies the same nonterminal-reference guard. When allowed, it atomically marks the identity binding unbound, increments every Tenant User security version, revokes active sessions, deletes outstanding consent transactions, advances and disconnects Microsoft 365, clears verification/reason state and resets permission indicators to `unknown`, together with `tenant.identity.unbound` audit evidence. A removed identity authority therefore cannot leave a usable application session or locally connected Graph boundary behind.

Migration rollback fails closed while Microsoft 365 connection or consent rows exist.

## Outbound controls

The provider client must:

- use fixed Microsoft identity and Graph origins;
- use a bounded custom MSAL network client for identity metadata and client-credential token requests;
- accept only validated GUID provider Tenant and User references;
- construct paths internally rather than accepting URLs;
- disable redirects for Microsoft identity and Graph requests;
- use bounded connect/request timeouts and cancellation for Microsoft identity and Graph requests;
- bound outbound identity request headers and bodies;
- bound provider response headers and bodies before parsing;
- validate JSON response shape;
- classify retryable, revoked, degraded, and unavailable failures without exposing provider details;
- use the configured confidential-client credential from deployment secret management only;
- never log credentials, tokens, state, provider response bodies, provider Tenant identifiers, or User identifiers.

The custom MSAL transport rejects every origin other than the fixed Microsoft identity origin before network execution. It applies the configured Microsoft 365 timeout to token POSTs as well as metadata GETs. Microsoft Graph transport separately enforces the fixed Graph origin with the same configured bound.

## Audit evidence

The lifecycle uses the fixed audit taxonomy:

- `integration.admin_consent.changed`;
- `integration.connected`;
- `integration.verified`;
- `integration.disconnected`;
- `authorization.denied`.

Successful persistence mutations and their audit events commit atomically. Audit metadata contains only bounded operation and reason codes. It excludes raw state, credentials, tokens, provider messages, provider Tenant IDs, and provider User IDs.

## Configuration

Pilot/Production require deployment-secret values for the Microsoft confidential client and fixed same-origin callback configuration. Startup must fail closed when required values are absent, malformed, insecure, or inconsistent with `PUBLIC_ORIGIN`.

No Microsoft credential is committed to the repository, supplied by the browser, returned through an API, or written to operational logs.

## Test evidence

Required automated evidence includes:

- Tenant Admin authorization and denial audit;
- CSRF enforcement for connect, verify, and disconnect;
- rejection of browser-selected Tenant authority and request bodies;
- callback query allowlisting, duplicate rejection, state expiry, replay, actor mismatch, and provider-Tenant mismatch;
- durable redacted rejection evidence for malformed, denied, expired, replayed, and binding-mismatch callbacks;
- fixed redirect destinations and provider-error concealment;
- fixed Microsoft identity and Graph destinations;
- custom MSAL transport rejection of foreign origins, overlarge requests/responses, redirects, and unbounded waits;
- bounded provider responses and stable error classification;
- fail-closed Calendar `unverified` behavior;
- Tenant-scoped connection persistence and cross-Tenant isolation;
- reconnect/version races and stale callback rejection;
- provider-binding removal during consent or manual-verification Graph calls;
- healthy reconnect cancellation/expiry preservation and provider-rebinding recovery;
- audit-atomic lifecycle persistence;
- migration up/down and rollback guards;
- dependency, secret, static security, architecture, unit, HTTP, and PostgreSQL integration gates.

Real Microsoft acceptance remains an external Pilot gate. It must validate independent Entra Tenants, actual admin consent, missing permission behavior, consent revocation, credential rotation, reconnect, and Exchange scoping without weakening the automated trust-boundary tests.
