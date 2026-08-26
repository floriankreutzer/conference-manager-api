# Tenant Invitation and Microsoft Entra Claiming

## Authority and scope

Root `AGENTS.md` and `docs/CODING-STANDARDS.md` remain authoritative. This document defines the SaaS 1 tenant invitation and Microsoft Entra tenant-claiming boundary implemented for conference-manager issue #59.

This document is scoped to binding one validated external Microsoft Entra tenant to one prepared internal Conference Manager Tenant. The repository also implements the adjacent JIT User provisioning (#60), Tenant role administration (#61), Microsoft 365 consent (#62), and bounded operator/Pilot lifecycle paths (#71); their separate authorization and acceptance contracts remain documented in their owning specifications.

## Security objective

An Entra tenant reference is external identity metadata, never Conference Manager Tenant authority.

The internal Tenant UUID remains the authoritative ownership key for all Tenant-owned data. The browser cannot select or override the internal Tenant ID or the validated Microsoft Entra `tid` during claiming.

The normal customer flow requires no client secret, application ID, Entra tenant ID, or PowerShell input.

## Flow

1. An authorized Platform/operator process creates a pending internal Tenant and one short-lived invitation through `TenantOnboardingService.createTenantInvitation(...)`.
2. The raw invitation token is returned once. PostgreSQL stores only its SHA-256 hash.
3. The customer browser submits the invitation token to `POST /api/v1/onboarding/invitations/start`.
4. The API resolves the invitation server-side and starts the existing Microsoft Entra OIDC flow. The internal invitation ID is attached to the server-side OIDC transaction; it is not accepted as browser Tenant authority.
5. Microsoft authentication validates the external identity, including the Entra `tid` and `oid`, through the #58 adapter.
6. The provider-neutral identity resolver passes the validated external identity plus the trusted OIDC invitation context to the onboarding service.
7. The service creates a short-lived claim transaction and sets `cm_tenant_claim`, an HttpOnly claim cookie. No application session or Tenant role is created at this stage.
8. `GET /api/v1/onboarding/claim` returns only the prepared organization display name, claim expiry, and a server-derived CSRF token. It does not return the internal Tenant UUID or Entra tenant reference.
9. `POST /api/v1/onboarding/claim` requires the claim cookie, the matching CSRF token, and body `{ "confirm": true }`.
10. PostgreSQL atomically consumes the invitation and claim transaction, creates the active Entra Tenant binding, advances the internal Tenant from `pending` to `onboarding`, and appends durable `tenant.identity.claimed` audit evidence.

## Public endpoints

### `POST /api/v1/onboarding/invitations/start`

Request body:

```json
{
  "invitationToken": "43-character-single-use-token"
}
```

The endpoint accepts no Tenant ID, provider tenant reference, user ID, role, permission, redirect URI, provider authority, or application ID.

A valid invitation produces the fixed Microsoft authorization URL returned by the existing Entra adapter. The OIDC transaction persists the trusted invitation ID so the callback cannot be redirected to another prepared Tenant by browser input.

Invalid, expired, already-used, malformed, or otherwise unavailable invitations fail closed.

### Microsoft callback

When the OIDC callback completes for an invitation-based flow, the validated Entra identity is converted to a pending claim. The callback sets `cm_tenant_claim` and redirects to the fixed same-origin location:

`/onboarding?auth=confirm`

It does not create a Conference Manager session or role before the organization binding is explicitly confirmed.

### `GET /api/v1/onboarding/claim`

Requires a valid unexpired `cm_tenant_claim` cookie.

Response contains only:

- Tenant display name;
- claim expiry;
- claim-bound CSRF token;
- server request ID.

The internal Tenant UUID, Entra tenant reference, provider user reference, invitation token/hash, claim token/hash, provider tokens and raw claims are not returned.

### `POST /api/v1/onboarding/claim`

Requires:

- valid unexpired `cm_tenant_claim`;
- valid `X-CSRF-Token` derived from the claim transaction;
- exact JSON body `{ "confirm": true }`.

On success the claim cookie is cleared and the response reports only the resulting Tenant lifecycle status. The claim call itself does not issue a business session. The implemented #60 JIT path resolves or creates the local User and issues a session on a subsequent validated normal Entra authentication.

## Cookie and CSRF contract

`cm_tenant_claim` is a temporary onboarding credential, not an application session.

It uses:

- `HttpOnly`;
- `SameSite=Strict`;
- `Path=/api/v1/onboarding/claim`;
- `Secure` for HTTPS and therefore for Pilot/Production;
- bounded `Max-Age` matching claim lifetime;
- no broad `Domain` attribute.

The raw claim token is random and only its SHA-256 hash is persisted. The confirmation CSRF token is HMAC-derived from trusted server state and compared safely. Browser-provided Tenant/provider identity never participates in CSRF derivation.

## Persistence and uniqueness

Migration 008 adds:

- `tenant_onboarding_invitations` for hashed single-use invitations;
- `tenant_identity_bindings` for internal Tenant to provider-Tenant bindings and binding history;
- `tenant_claim_transactions` for short-lived claim confirmation state;
- a trusted invitation reference on OIDC authentication transactions.

Active binding uniqueness is enforced in PostgreSQL so that:

- one internal Tenant has at most one active binding for a provider;
- one external provider Tenant has at most one active Conference Manager Tenant binding.

Concurrent attempts cannot both claim the same Entra tenant. Database uniqueness is an enforcement layer in addition to service validation.

The claim transaction carries the validated provider Tenant/user references only server-side. No provider access, refresh, or ID token is stored by this model.

## Atomic claim transaction

Successful claiming is one PostgreSQL transaction. It performs all of the following or none of them:

- locks and consumes the unexpired claim transaction;
- locks and consumes the matching unexpired invitation;
- validates the internal Tenant lifecycle;
- creates the active provider-Tenant binding;
- changes Tenant status from `pending` to `onboarding`;
- appends the `tenant.identity.claimed` audit event.

If required audit persistence fails, the binding, invitation consumption, claim consumption, and lifecycle change roll back.

## Audit events

The event taxonomy includes:

- `tenant.onboarding.invited`;
- `tenant.identity.claimed`;
- `tenant.identity.unbound`.

Audit records use the internal Tenant ID and trusted server correlation context. Raw invitation/claim credentials, provider tokens, raw claims and browser authority are prohibited audit metadata.

## Operator authorization and recovery

Operator invitation creation and identity unbinding are deliberately not exposed as Tenant Admin browser APIs in this slice.

`TenantOnboardingService` requires an explicit `authorizeOperator` decision for operator mutations. The public HTTP composition denies these operations by default. The implemented `npm run operator:tenant -- ...` path supplies a process-local trusted operator context after production configuration/schema validation; it is deliberately separate from Tenant roles and browser authority.

The supported recovery contract is therefore:

1. identify the internal Tenant through trusted operational records;
2. inspect audit evidence and the current binding state without using customer-supplied Tenant/provider IDs as authority;
3. use the trusted Tenant-operator CLI, which composes `authorizeOperator` without exposing a browser bootstrap API;
4. never edit binding rows manually as the normal recovery mechanism;
5. record an unbind/rebind action through the service so audit evidence is generated;
6. create a new single-use invitation for a new claim when recovery policy allows it.

The current service permits unbinding only while the Tenant is `pending`, `onboarding` or `ready`, before productive activation. The repository serializes the Tenant, Microsoft 365 Integration and active binding and rejects the unbind while any booking-provider reference is `pending`, `active`, `compensating` or `compensated`; only terminal `cancelled` references permit the authority change.

An allowed unbind is audit-atomic with all of its security effects: it marks the Entra binding `unbound`, increments every Tenant User's `security_version`, revokes every active Tenant session, deletes outstanding Microsoft 365 consent transactions, advances/disconnects the Microsoft 365 connection, clears verification time/reason and resets permission indicators to `unknown`. This prevents a session or Graph connection derived from the removed identity authority from remaining usable. Active/production recovery policy remains governed by #71 so support cannot bypass lifecycle controls.

## Failure semantics

The implementation fails closed for:

- malformed invitation or claim credentials;
- expired or replayed invitations;
- expired or replayed claim transactions;
- missing/mismatched claim CSRF;
- unknown or suspended/archived Tenant state;
- duplicate provider-Tenant binding;
- competing concurrent claims;
- unrecognized provider identity;
- missing operator authorization;
- identity unbind with a nonterminal booking-provider reference;
- audit or authoritative persistence failure.

Public errors remain bounded and do not disclose whether a provider Tenant is bound to another customer.

## Testing evidence

Progression and security tests cover:

- raw invitation token returned once and hash-only persistence;
- operator deny-by-default behavior;
- invitation-to-OIDC trusted context propagation;
- claim cookie attributes and parser hardening;
- claim-bound CSRF;
- public response minimization;
- invitation expiry/replay;
- disabled/suspended Tenant behavior;
- duplicate provider-Tenant binding;
- concurrent claim attempts;
- two independent Tenant/provider fixtures;
- pre-activation unbind session invalidation and Microsoft 365 disconnect;
- transaction rollback when audit append fails;
- Migration 008 up/down/reapply behavior;
- legacy migration regression through schema version 8.

These tests demonstrate the repository boundary only. They do not replace the real two-organization Microsoft acceptance evidence required by the SaaS 1 roadmap.
