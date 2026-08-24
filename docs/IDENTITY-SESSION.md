# Identity and Session Contract

## Authority and scope

Root `AGENTS.md` remains authoritative. This document defines the provider-neutral server-side identity/session boundary implemented by SaaS 0 issue #50 and its durable session-audit integration added by issue #52.

Microsoft Entra ID is implemented as a provider adapter at the edge of this contract. The Entra adapter validates the OIDC protocol and provider claims and emits only a provider-neutral external identity. Tenant claiming and local User provisioning then resolve that external identity into a trusted internal identity before session issuance.

The recognized Tenant roles/permissions and object/workflow authorization rules are defined separately by `docs/AUTHORIZATION.md`. The durable audit event/integrity contract is defined by `docs/AUDIT.md`. The Microsoft protocol-specific boundary is defined by `docs/ENTRA-AUTHENTICATION.md`.

## Trust flow

```text
Microsoft Entra / external identity provider
  -> provider adapter validates protocol, issuer, audience, signature, nonce/state and provider claims
     -> provider-neutral external identity
        -> server-side identity mapping resolves internal Tenant/User and approved roles/permissions
           -> normalizeTrustedIdentity(...)
              -> createSessionService.issue(...)
                 -> one PostgreSQL transaction:
                      session row containing only token hash
                      + session.issued audit event
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

The provider identity reference is evidence/linkage for the identity adapter. It is not a Tenant ownership identifier and is not returned by the public session endpoint or copied into Tenant audit metadata.

Provider-specific fields such as Entra `tid`, `oid`, group claim formats, token types, issuer URLs, Graph objects, or Microsoft SDK types remain inside the identity adapter and identity-mapping boundary. Business services consume only the internal Principal.

The current Entra authentication slice deliberately emits only validated external `tenantReference`, `userReference`, provider and an optional bounded display name. It does not import provider group, role or email claims as Conference Manager authorization. Issues #59 and #60 own the binding of those external references to internal Tenant/User records.

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

The raw session token is never persisted, logged, returned in JSON, exposed to browser JavaScript or copied into audit records.

Session lookup hashes the presented cookie token and requires all of the following:

- matching hash;
- session not revoked;
- session not expired;
- User still active;
- session `principal_version` equals the User's current `security_version`;
- Tenant is in a session-available lifecycle state.

Any failure returns no Principal and the request fails closed as unauthenticated.

The Entra OIDC flow has separate short-lived authentication transactions. PostgreSQL stores only provider, hashed state, hashed nonce, creation time and expiry. It does not store authorization codes, provider tokens, plaintext state or plaintext nonce. A callback atomically consumes its state row before code redemption so the state is one-time across multiple API instances.

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
- becomes unusable when the session is replaced/revoked or when the CSRF secret is rotated;
- is never copied into durable audit evidence.

A missing/malformed/mismatched token fails closed before an unsafe protected operation is performed.

## Expiry, revocation, logout, and rotation

Session expiry is enforced by PostgreSQL lookup, not only by cookie expiration.

Logout uses `DELETE /api/v1/session` and requires the authenticated session plus a valid CSRF token. The session row is revoked and the `session.revoked` success audit event is appended in one PostgreSQL transaction before the cookie is cleared.

Session rotation creates a new random token/session ID, revokes the previous session and appends `session.rotated` audit evidence in one database transaction. The old cookie cannot resolve after a successful rotation.

Session issuance inserts the new session row and `session.issued` success audit event in one transaction. If the required audit append fails, the session mutation does not commit.

Rotation is an internal server operation, not a browser-controlled identity update. The caller must provide a newly validated trusted identity for the same internal User/Tenant.

No-mutation revocation/rotation failures can be recorded separately as failure audit events when a valid internal Principal/Tenant context exists.

## Session audit data minimization

Session lifecycle audit records target the internal User rather than exposing the session credential as an audit target.

Allowed session audit metadata is intentionally limited to non-secret facts such as role/permission counts and abstract session state labels. Audit records do not contain:

- raw session token;
- session token hash;
- internal session ID;
- CSRF token;
- provider subject/reference;
- provider access/refresh/ID token;
- cookie header;
- secret material.

Pre-Tenant Entra authentication failures are not forced into an arbitrary Tenant audit chain. They use bounded operational authentication telemetry without provider payloads or token/claim data. Tenant-scoped claim/provisioning audit begins only when a valid internal Tenant context exists.

See `docs/AUDIT.md` for the common event validation and HMAC-chain contract.

## Privilege changes and stale-session prevention

Each User has a monotonically increasing `security_version`. Each issued session snapshots that value as `principal_version`.

When an authorized role/permission mapping changes, the responsible server-side operation increments the User `security_version`. Every previously issued session immediately fails resolution because its snapshot no longer matches.

If the user should remain signed in, an authorized identity/session orchestration path may rotate the known current session using the newly approved role/permission snapshot. The new session receives the new `security_version`; the old session remains unusable.

Issue #51 defines the deny-by-default role/permission and object/workflow policy in `docs/AUTHORIZATION.md`. Operations that later mutate User role/permission assignments must use Tenant Admin authorization, increment `security_version` and emit the corresponding server-generated audit event; the browser cannot rotate privileges by submitting new role values.

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
- database/security version metadata;
- audit HMAC/integrity data.

`DELETE /api/v1/session` revokes the server-side session, atomically persists its success audit event, and returns HTTP 204 while clearing the cookie.

## Microsoft Entra OIDC adapter

SaaS 1 issue #58 implements the Microsoft Entra OIDC edge adapter using the fixed Microsoft organizational multi-tenant authority and the authorization-code flow with PKCE, state and nonce.

The adapter validates Microsoft protocol output and then resolves provider identity through a provider-neutral resolver before issuing a session. The browser cannot supply internal IDs, roles, permissions, Entra Tenant authority or an alternative provider destination.

A successfully authenticated Entra identity that is not yet claimed/provisioned is returned as `onboarding_required`; it receives no business session. This preserves the ownership split with #59 Tenant claiming and #60 JIT User provisioning.

Any mapping output that eventually reaches session issuance must use only authorization values recognized by `docs/AUTHORIZATION.md`. Unknown mapping output fails closed at the business authorization boundary.

See `docs/ENTRA-AUTHENTICATION.md` for registration, configuration, protocol validation, replay protection and live Pilot verification requirements.

## Operational considerations

Expired/revoked session cleanup is an operational maintenance concern and may be implemented with bounded server-side cleanup once production job scheduling/observability is defined. Removing expired rows is not required for correctness because lookup always enforces expiration and revocation.

Expired OIDC authentication transactions are rejected by the atomic consume query and are opportunistically deleted before new authentication transactions are created. Their lifetime is bounded independently from application sessions.

CSRF secret rotation invalidates previously issued CSRF tokens but not the underlying authenticated session. A client can retrieve a new CSRF token with authenticated `GET /api/v1/session`.

OIDC transaction-secret rotation invalidates PKCE derivation for authentication flows that were already started but not completed. It does not invalidate established application sessions.

Audit HMAC-key rotation requires an explicit integrity-chain/key-version migration or archive design; silently replacing the key would make historical chain verification impossible. Issue #52 therefore fixes integrity version 1 and requires a stable externally managed `AUDIT_HMAC_SECRET` for the deployed chain until a reviewed key-rotation mechanism exists.
