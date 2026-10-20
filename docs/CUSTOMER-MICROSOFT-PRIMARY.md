# Fresh invited-Customer Microsoft primary proof preparation

`createFreshCustomerEntraClient` is an inactive, separate adapter factory. The
existing Customer and Platform runtime entrypoints do not select it. A successful
primary proof is not membership, an account link, MFA or a business session.
Invited-only resolution, explicit dual-proof linking and protected INT composition
remain required before activation.

## Protocol and outbound boundary

The factory accepts only the protected organizational Microsoft authority and a
canonical HTTPS Customer origin. The callback is derived from that origin and
fixed to `/api/v1/auth/microsoft/callback`. Authorization uses code flow, S256 PKCE,
server-generated state/nonce, `prompt=login`, `max_age=0` and an essential
`auth_time` request. The pinned SDK requires `max_age` through
`extraQueryParameters`; a mock-only test is insufficient to verify this wiring.

Both authorization and code redemption request only `openid profile`. Optional
SDK telemetry and its added `offline_access` default are removed at the adapter
boundary; unexpected scopes or changed protocol fields are rejected. The token
request must match the configured client/secret/callback and current code/PKCE
verifier. The same bounded Microsoft identity HTTP transport as the existing
integration adapter fixes the approved origin, rejects redirects and caps headers,
bodies and responses. Each operation has one bounded deadline and a new ephemeral
MSAL application, with PII logging disabled and no persistent token cache. No Graph
call, refresh grant, arbitrary destination or raw token reaches application code.

Code redemption requires the independently recovered raw expected nonce and its
stored hash. They must match before provider I/O; the raw nonce is also passed to
MSAL's `acquireTokenByCode`. This is required by the pinned SDK's nonce check, in
addition to the adapter's own nonce-hash validation. The future durable protocol
must derive/recover that nonce from trusted transaction state, never a browser
claim or an ID-token value used as its own expectation.

Issuer, audience, nonce, token version/lifetime and fresh `auth_time` are checked.
The authentication must be recent and no earlier than the server's transaction
start (with bounded clock skew). Consumer Microsoft identities are outside the
organizational path. Email, username, display name, provider roles and groups do
not become identity-link or authorization authority.

## One-use verified context

Only a private WeakMap-backed opaque assertion leaves redemption. Primary
verification consumes it once, checks the same expected nonce hash and freshness,
and returns only stable provider/Tenant/User references and authentication time.
It cannot be cloned, moved to another adapter or serialized into a usable proof.
The downstream durable admission/link transaction must still check environment,
current accepted membership, User/security version and explicit confirmation.
Microsoft login identity and the independently connected Microsoft365 directory
are separate; this adapter does not create a Tenant directory binding.

## Evidence and remaining work

Focused tests cover exact OAuth fields, unexpected SDK output, stale/missing
proof, issuer/audience/nonce mismatch, consumer denial, unknown input/configuration,
opaque-context substitution/replay/expiry and email/role minimization. An actual
pinned MSAL round trip uses an isolated fixed-origin synthetic transport, exercising
real SDK request construction, nonce validation and bounded token-scope handling.
The fixture's synthetic token is not real Microsoft signature/device acceptance.
No real provider request, contact, credential, mail or deployment was performed.

Full current checks, actual CI and live authorized provider/device acceptance
must be reported separately. The legacy Customer/Platform code-flow nonce wiring
is being corrected in a separate focused change; this factory does not silently
replace those paths.

Primary references checked on2026-10-20:

- https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
- Installed exact-pinned MSAL Node7.1.0/Common `AuthorizationCodeRequest` and response-handler source.
