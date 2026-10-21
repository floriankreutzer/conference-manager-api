# Owned protected Customer configuration

`loadProtectedCustomerConfiguration` prepares the actual Customer startup bundle
from explicit new-prefix input after the common protected profile envelope. It
does not read inherited configuration implicitly or mutate the supplied input.
It creates no database connection, HTTP listener, worker, provider request or
message. Full owned process roots and INT acceptance remain under SaaS1 issue351.

## Production constraints in every protected environment

The canonical Customer production validator receives a bounded local mapping,
with verified database TLS, required organizational Microsoft credentials, fixed
origin/callback, audit/CSRF material, service/build identity and normal request/
session bounds. Its result retains `mode=production` in DEV, INT and PROD. Only
the already validated protected envelope selects the independent deployment
environment afterward. The ordinary mode/environment validators are unchanged;
no development profile or arbitrary inherited compatibility variable is used.
Business/lease settings retain the separate role-scoped profile configurations.

The actual own Microsoft client ID and explicitly supplied public peer ID must
be valid and different. Customer configuration receives no Platform secret,
session or audit key. Tenant audit and encrypted invitation custody are shared
between the authorized server surfaces; they are separate from Platform audit.
The full loader rejects unknown protected keys, accessors, missing/malformed
values and within-bundle secret reuse, including reuse of the database password.
Only the canonical Microsoft organizational authority/callback is prepared.

## Required and optional inputs

In addition to the envelope keys, required Customer keys use
`PROTECTED_CUSTOMER_` with suffixes `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
`CSRF_SECRET`, `EMAIL_FLOW_SECRET`, `EMAIL_CODE_SECRET`, `EMAIL_SOURCE_SECRET`
and `MICROSOFT_FLOW_SECRET`. Required common keys are
`PROTECTED_TENANT_AUDIT_HMAC_SECRET`, `PROTECTED_PEER_ENTRA_CLIENT_ID`,
`PROTECTED_SERVICE_VERSION`, `PROTECTED_CUSTODY_LOOKUP_SECRET`,
`PROTECTED_CUSTODY_ACTIVE_KEY_ID` and `PROTECTED_CUSTODY_KEYRING`.

The bounded keyring is a JSON array of one to eight exact `id`/`key` entries.
Each key is canonical base64url for32 bytes; IDs and the active selection are
validated by the canonical custody cipher. Duplicate IDs, extra fields,
malformed encodings and reuse of an authentication-purpose value are rejected.
The owned cipher clones keys; temporary decoded copies are wiped on success or
failure. Retained old entries plus a stable lookup key allow decryption/lookup
across active-key rotation. The final root must destroy its cipher on shutdown.

Optional own `HOST`, `PORT` and `SESSION_TTL_SECONDS` retain bounded canonical
validation, with an explicit bind-address allowlist. No catering delivery flag is
enabled by this configuration. Synthetic handoff requires the envelope's explicit
DEV/INT opt-in plus distinct `PROTECTED_HANDOFF_SECRET`. That key is rejected
when handoff is disabled; PROD synthetic configuration remains forbidden.

Own `MAIL_API_KEY` and `MAIL_SENDER` are an optional complete pair. When present,
the existing bounded, fixed-destination Resend adapter validates them without
sending. When absent, the mail port is null. The final runtime must report this
absence honestly and cannot admit mail-dependent traffic as delivery-ready.
Syntactic configuration proves neither provider account/plan nor domain/sender
verification, delivery or recipient authorization. Nothing is inferred from
Microsoft/email claims and no owner/sender/recipient is invented.

## Verification and remaining work

Focused cases cover all three production-mode deployment namespaces, immutable
input/output, secure database/callback defaults, missing/aliased material, peer
identity, wrong-surface/unknown/accessor input, binding/session bounds, canonical
old-key decryption and stable lookup after rotation, invalid rings, explicit
handoff/PROD denial and construction without provider I/O. Native HTTP/profile,
whole-root/SIM/media/browser acceptance, verified sender/explicit owner,
physical keys/recovery and coordinated traffic/drain/credential/UUID cutover
remain required. No old process or credential is revoked by new source alone.
