# Microsoft Entra Multi-Tenant Authentication

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document defines the Microsoft Entra authentication boundary introduced for SaaS 1 issue #58.

The browser is not an identity or Tenant authority. Microsoft provider claims become usable by the application only after the complete server-side OIDC flow succeeds and the provider-neutral identity resolver accepts the validated external identity.

## Registration model

Conference Manager uses one Microsoft Entra application registration for enterprise customer sign-in.

The application registration must be configured for **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**. Personal Microsoft accounts are outside the Pilot scope.

The server uses the fixed Microsoft organizational authority:

`https://login.microsoftonline.com/organizations`

The redirect URI is derived from `PUBLIC_ORIGIN` and is fixed to:

`/api/v1/auth/microsoft/callback`

For example, a Pilot deployment at `https://conference.example.com` registers:

`https://conference.example.com/api/v1/auth/microsoft/callback`

The normal customer onboarding path never asks a customer to enter the application ID, client secret, or Entra Tenant ID. The application ID and credential belong to the SaaS deployment, not to each customer.

## Required deployment configuration

Pilot and Production require all of:

- `ENTRA_CLIENT_ID`: application/client ID of the multi-tenant SaaS registration;
- `ENTRA_CLIENT_SECRET`: deployment-managed confidential-client credential;
- `OIDC_TRANSACTION_SECRET`: independent high-entropy server secret used to derive PKCE verifiers;
- `PUBLIC_ORIGIN`: the exact HTTPS origin used to derive the redirect URI;
- PostgreSQL and the existing session/audit secrets required by the production baseline.

`ENTRA_CLIENT_SECRET` and `OIDC_TRANSACTION_SECRET` must be supplied by the deployment secret store. They must not be committed, returned to the browser, logged, placed in URLs, or copied into Tenant configuration.

The authority is intentionally not configurable by browser or Tenant input. Changing the authority is an architecture/security change because it changes the outbound trust destination.

## Protocol flow

### 1. Login start

`GET /api/v1/auth/microsoft/login` accepts no query parameters.

The backend:

1. creates cryptographically random `state` and `nonce` values;
2. stores only SHA-256 hashes of `state` and `nonce` in the short-lived PostgreSQL OIDC transaction table;
3. derives a PKCE verifier using the server-only OIDC transaction secret and the random state;
4. derives the S256 PKCE challenge;
5. asks MSAL Node to generate the authorization URL for `openid profile`;
6. verifies that the resulting authorization URL remains on the configured Microsoft authority and expected authorization path;
7. redirects the browser to Microsoft.

The transaction expires after a bounded interval; the default is 600 seconds and the accepted configuration range is 120-900 seconds.

### 2. Callback

`GET /api/v1/auth/microsoft/callback` accepts only the bounded Microsoft callback fields documented by the HTTP route. Unknown or duplicate fields fail validation.

Before authorization-code redemption, the backend atomically consumes the hashed state from PostgreSQL. A state therefore succeeds at most once across multiple API instances. Expired, unknown, malformed, or replayed states fail closed.

Provider rejection is converted to the fixed same-origin result `/?auth=authentication_failed`; Microsoft error descriptions or provider payloads are not reflected to the browser or logs.

For a successful callback, MSAL Node performs authorization-code redemption using the PKCE verifier. Conference Manager then performs explicit defense-in-depth claim checks on the validated ID-token claims.

## Validated identity claims

The Entra adapter accepts only the provider identity data needed by later Tenant/User resolution:

- `tid` -> external Entra Tenant reference;
- `oid` -> stable external User/object reference;
- `name` -> optional bounded display name.

The adapter explicitly verifies:

- Microsoft/MSAL authorization-code result;
- application audience (`aud`);
- Tenant-specific v2 issuer derived from validated `tid`;
- `nonce` against the stored nonce hash;
- token expiry (`exp`);
- bounded future `nbf`/`iat` skew when present;
- supported v2 token version when present;
- GUID shape for `tid` and `oid`.

The adapter does not use email address, display name, groups, application roles, browser parameters, or domain names to grant Conference Manager authorization.

## Provider-neutral identity boundary

After OIDC validation, the adapter emits only a provider-neutral external identity equivalent to:

```json
{
  "provider": "microsoft_entra",
  "tenantReference": "validated-entra-tenant-guid",
  "userReference": "validated-entra-object-guid",
  "displayName": "optional bounded display name"
}
```

Issue #58 deliberately does not claim a SaaS Tenant or create a local User. Those responsibilities belong to the next critical-path issues:

- #59: invitation-based Tenant claiming/binding;
- #60: just-in-time local User provisioning.

Until those policies resolve the external identity, a cryptographically valid Entra login returns the fixed onboarding result `/?auth=tenant_onboarding_required` and no business session is issued.

When the resolver returns a trusted internal identity, the existing `SessionService` issues the server-generated HttpOnly session and persists its audit evidence. Provider access/refresh tokens are not exposed to browser storage.

## Tenant and authorization security

Authentication alone never grants `conference_manager`, `tenant_admin`, or platform privileges.

Internal roles and permissions remain server-side application data. A future resolver may use the validated Entra Tenant/User references only to find the corresponding internal Tenant/User records. It must not make provider groups, email domains, names, or browser input authoritative.

A validated Entra Tenant reference remains external identity metadata; it never replaces the stable internal `tenant_id` used for Tenant ownership and BOLA/IDOR protection.

## Logout

Logout remains `DELETE /api/v1/session` and uses the existing server-side session revocation and CSRF contract. Clearing a browser cookie alone is not considered logout.

## Replay and concurrency properties

`oidc_auth_transactions` is shared PostgreSQL state rather than process-local memory. The callback consumes a transaction with one atomic `DELETE ... RETURNING` statement constrained by provider, state hash, and expiration time.

Consequences:

- the same callback state cannot succeed twice;
- two API instances cannot both consume the same state;
- expired state cannot be redeemed;
- state and nonce plaintext are not persisted;
- no Tenant/User identity is persisted before provider authentication succeeds.

## Operational registration checklist

Before enabling Pilot authentication in a real environment:

1. Create or select the Conference Manager SaaS Entra application registration.
2. Set supported account types to organizational directories, multi-tenant.
3. Register the exact HTTPS callback URI derived from `PUBLIC_ORIGIN`.
4. Create a production credential using the organization's approved secret/certificate lifecycle. The current adapter consumes a client secret.
5. Store the credential only in the deployment secret store.
6. Configure an independent `OIDC_TRANSACTION_SECRET` with at least 32 bytes of entropy-equivalent secret material.
7. Deploy schema migration 007 before routing authentication traffic.
8. Verify login from at least two independent organizational Entra test tenants.
9. Verify wrong-audience, wrong-issuer, expired-token, nonce/state replay, consent/rejection, logout, and unsupported-Tenant behavior.
10. Record the application registration/credential owner, expiry/rotation procedure, and evidence without storing the credential itself.

Steps involving an actual Microsoft tenant/application registration are external operational verification. Repository tests use deterministic provider doubles and do not constitute evidence that a specific production Entra registration is configured correctly.

## Required tests and gates

Repository coverage for this boundary includes:

- authorization URL/PKCE construction;
- wrong audience and issuer;
- expired/not-yet-valid/invalid-version claims;
- nonce mismatch;
- state expiry and replay;
- provider rejection;
- manipulated callback/query values;
- two independent external Tenant identities;
- onboarding-required fail-closed behavior;
- successful handoff to existing SessionService when a trusted resolver is supplied;
- PostgreSQL atomic state consumption and migration rollback;
- dependency, architecture, static security, secret, style, DAST, unit and database gates.

Live authentication against two independent Entra tenants remains a Pilot deployment acceptance check and must not be represented as passed until executed with real tenant registrations.
