# Identity and Session Contract

## Authority and scope

Root `AGENTS.md` remains authoritative. This document defines the provider-neutral server-side identity/session boundary implemented by SaaS 0 issue #50.

Microsoft Entra ID is intentionally not part of the business-layer contract. A future Entra OIDC adapter validates provider tokens/claims and maps them to a trusted internal identity before calling the session issuance boundary.

The recognized Tenant roles/permissions and object/workflow authorization rules are defined separately by `docs/AUTHORIZATION.md` and implemented by issue #51.

## Trust flow

```text
External identity provider
  -> provider adapter validates protocol, issuer, audience, signature, nonce/state and provider claims
     -> server-side identity mapping resolves internal Tenant/User and approved roles/permissions
        -> normalizeTrustedIdentity(...)
           -> createSessionService.issue(...)
              -> PostgreSQL session record containing only a token hash
                 -> HttpOnly session cookie returned to browser

Browser request
  -> opaque cm_session cookie
     -> SHA-256 token lookup in PostgreSQL
        -> expiry/revocation/user security_version/Tenant lifecycle checks
           -> provider-neutral internal Principal
              -> Tenant context
                 -> deny-by-default authorization/business layer
```

Browser input, provider claims received directly from the browser, email domains, tenant selectors, roles, permissions, or UI visibility never populate the internal Principal directly.

## Trusted identity contract

The trusted identity input contains only normalized server-side values:

- internal User UUID;
- internal Tenant UUID;
- provider identity reference `{ provider, reference }`;
- approved roles;
- approved permissions.

The provider identity reference is evidence/linkage for the identity adapter. It is not a Tenant ownership identifier and is not returned by the public session endpoint.

Provider-specific fields such as Entra `tid`, `oid`, group claim formats, token types, issuer URLs, Graph objects, or Microsoft SDK types must remain inside the future identity adapter. Business services consume only the internal Principal.

The session layer validates syntactic role/permission shape. The authorization layer additionally requires every role/permission value to belong to the recognized Tenant policy. Unknown authorization values fail closed instead of being ignored.

## Session token and persistence

A session uses a server-generated 256-bit random opaque token. The raw token exists only long enough to be placed in the browser cookie.

PostgreSQL stores:

- internal session UUID;
- internal Tenant/User ownership;
- SHA-256 hash of the opaque token;
- normalized provider identity reference;
- server-approved role/permission snapshot;
- User `security_version` snapshot;
- issue/expiry/revocation timestamps.

The raw session token is never persisted, logged, returned in JSON, or exposed to browser JavaScript.

Session lookup hashes the presented cookie token and requires all of the following:

- matching hash;
- session not revoked;
- session not expired;
- User still active;
- session `principal_version` equals the User's current `security_version`;
- Tenant is in a session-available lifecycle state.

Any failure returns no Principal and the request fails closed as unauthenticated.

## Cookie policy

The session cookie is named `cm_session` and uses:

- `HttpOnly`;
- `SameSite=Lax`;
- `Path=/api`;
- `Secure` whenever the configured public origin is HTTPS; Pilot/Production require HTTPS and therefore always use `Secure`;
- bounded `Max-Age` matching the server-side session TTL;
- no broad `Domain` attribute.

Logout clears the same cookie with `Max-Age=0` and an expired timestamp after server-side revocation.

Authentication/access/refresh tokens from an external identity provider are not browser session credentials for this application and must not be stored in LocalStorage or sessionStorage.

## CSRF contract

Cookie-authenticated unsafe requests require a synchronizer token.

The server derives a 256-bit CSRF token as HMAC-SHA-256 over the internal session ID using an external server-side secret. Pilot/Production require `CSRF_SECRET` to be supplied by deployment secret management.

`GET /api/v1/session` returns the current CSRF token in JSON after the session, recognized authorization values and Tenant have been validated. The frontend may hold it in runtime memory and send it as `X-CSRF-Token` for POST/PUT/PATCH/DELETE requests. The existing frontend API client already supports this header contract.

The CSRF token:

- is not stored in PostgreSQL;
- is not written to LocalStorage/sessionStorage;
- is bound to the internal session ID;
- is compared using a timing-safe comparison;
- becomes unusable when the session is replaced/revoked or when the CSRF secret is rotated.

A missing/malformed/mismatched token fails closed before an unsafe protected operation is performed.

## Expiry, revocation, logout, and rotation

Session expiry is enforced by PostgreSQL lookup, not only by cookie expiration.

Logout uses `DELETE /api/v1/session` and requires the authenticated session plus a valid CSRF token. The session row is revoked server-side before the cookie is cleared.

Session rotation creates a new random token/session ID and revokes the previous session in one database transaction. The old cookie cannot resolve after a successful rotation.

Rotation is an internal server operation, not a browser-controlled identity update. The caller must provide a newly validated trusted identity for the same internal User/Tenant.

## Privilege changes and stale-session prevention

Each User has a monotonically increasing `security_version`. Each issued session snapshots that value as `principal_version`.

When an authorized role/permission mapping changes, the responsible server-side operation increments the User `security_version`. Every previously issued session immediately fails resolution because its snapshot no longer matches.

If the user should remain signed in, an authorized identity/session orchestration path may rotate the known current session using the newly approved role/permission snapshot. The new session receives the new `security_version`; the old session remains unusable.

Issue #51 defines the deny-by-default role/permission and object/workflow policy in `docs/AUTHORIZATION.md`. Operations that later mutate User role/permission assignments must use Tenant Admin authorization and increment `security_version`; the browser cannot rotate privileges by submitting new role values.

## Public session endpoint

`GET /api/v1/session` returns only presentation-safe internal context after the role/permission snapshot is recognized by the authorization policy:

- internal User ID;
- internal Tenant ID and lifecycle status;
- approved roles;
- approved permissions;
- session expiration time;
- CSRF token;
- request ID.

It does not return:

- the opaque session token;
- internal session ID;
- token hash;
- provider identity reference;
- provider access/refresh/ID tokens;
- database/security version metadata.

`DELETE /api/v1/session` revokes the server-side session and returns HTTP 204 while clearing the cookie.

## Future Entra OIDC adapter

SaaS 1 will add the Microsoft Entra adapter. That adapter must validate the full OIDC flow and then resolve provider identity into internal Tenant/User records before issuing a session.

The adapter must not allow browser-supplied internal IDs, roles, permissions, or Entra tenant IDs to override server-side mappings. Entra claims remain adapter input; the internal Principal remains the only business identity contract.

The adapter's role/permission mapping output must use only authorization values recognized by `docs/AUTHORIZATION.md`. Unknown mapping output fails closed at the business authorization boundary.

## Operational considerations

Expired/revoked session cleanup is an operational maintenance concern and may be implemented with bounded server-side cleanup once production job scheduling/observability is defined. Removing expired rows is not required for correctness because lookup always enforces expiration and revocation.

CSRF secret rotation invalidates previously issued CSRF tokens but not the underlying authenticated session. A client can retrieve a new CSRF token with authenticated `GET /api/v1/session`.

Session creation, revocation, rotation, authentication failures, authorization decisions and security-version changes are security-relevant events. Persistent audit policy for those events is owned by issue #52.
