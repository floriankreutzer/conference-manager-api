# Platform passkey assurance

## Decision and implementation status

Application issue #355 tracks the owner's 2026-10-19 decision to retain Microsoft
primary identity, avoid additional Entra P1 subscription cost and implement
application-enforced WebAuthn assurance for Platform operators. This supersedes
the preceding plan to rely exclusively on Conditional Access contexts.

Root `AGENTS.md` and the existing Platform authorization/session/audit contracts
remain authoritative. The approved replacement is staged work, not an active
login mode. Current compositions still enforce the existing Microsoft MFA and
step-up contexts. This branch adds an uncomposed cryptographic adapter and durable authentication repository;
neither configuration nor token validation accepts weaker assurance.

## Target trust flow — not yet composed

1. Microsoft OIDC validates primary identity with signature, issuer, audience,
   operator directory, subject, nonce, state, PKCE and initiating-browser checks.
   Microsoft sign-in alone grants no Platform business session.
2. Resolve the exact provisioned active operator and current security version.
   Persist a short-lived pre-authentication transaction with no business rights.
3. Verify a passkey assertion with required user verification against that
   operator's active stored credential and the exact Platform origin/RP ID.
4. Atomically redeem the ceremony, update the credential counter and obtain the
   current operator authorization snapshot before audited session issuance.
5. Sensitive actions require a fresh assertion bound to the current Platform
   session and purpose, followed by audited rotation. Customer identities,
   sessions and email codes cannot satisfy this proof.

Microsoft Security Defaults are the directory baseline; they do not attest to
the application's per-action policy. The application must never manufacture a
Microsoft authentication-context claim to make the old policy accept a login.

## Implemented adapter

`src/platform/identity/passkey-verifier.js` owns the private WebAuthn SDK boundary.
It generates 256-bit random challenges and bounded registration/authentication
options. User verification is always required. Registration requests resident
credentials and no attestation, with only ES256/P-256 offered. Credential lists
are bounded to five. RP ID is the exact configured Platform hostname, never a
parent domain, browser header, Customer hostname or tenant-selected value.
Configuration requires a canonical HTTPS origin with no alternate port.

Verification requires canonical bounded base64url encodings and positive response
schemas, the exact origin/RP/challenge/ceremony, user presence, user verification,
the stored public key and valid signature. Cross-origin framing/top origins are
rejected. Stored authentication credentials are checked against the expected
internal operator and environment. A supplied user handle must match the stored
random handle; neither a handle nor a credential ID independently establishes
operator authority. Public COSE keys have exactly the reviewed P-256 fields;
private-key or extra-key data is not accepted for persistence.

Before registration SDK verification, attestation is restricted to `none` with an
empty statement. No certificate trust, metadata-service initialization, external
attestation URL or outbound lookup is exposed. Raw SDK/client errors and payloads
are replaced with one fixed rejection code without a retained cause.

The adapter returns public credential data or a verified assertion result only.
It never returns a trusted Platform identity, assurance level, role, cookie or
session. A `none` registration response alone is not proof of private-key
possession and must never issue a session; a successful assertion is required.

Synced/backup-eligible passkeys and zero counters are supported. Backup eligibility
must not change after registration; backup state can change. Non-increasing
nonzero counters fail verification. Counters alone do not prevent replay:
durable one-time challenges remain mandatory, especially for zero-counter keys.

## Dependency assessment

The adapter uses exact-pinned `@simplewebauthn/server` 14.0.3 (MIT, Node >=20) through
its public server/helper exports. It is an actively maintained standards-focused
verifier rather than a custom implementation of WebAuthn cryptography/CBOR.
Its transitive CBOR/ASN.1/X.509 dependencies increase the locked dependency tree;
that cost is explicit even though this adapter accepts only no-attestation P-256.
All direct/transitive versions and integrity references are retained in the
lockfile. Installation uses `--ignore-scripts`. The dependency-policy gate
continues to reject install scripts, missing licenses, denied licenses and
unreviewed version/range drift. Audit and security results are dated PR evidence,
not permanent vulnerability guarantees.

Only this adapter may import the WebAuthn SDK. Demo code must not reach it,
including through an intermediary. Application services consume its deliberate
contract without SDK types, metadata APIs, certificate providers or browser
credential authority. SDK replacement therefore affects this boundary and its
real signed protocol fixtures, not business authorization.

## Required work before activation

- Independently authorized bootstrap-grant persistence and credential lifecycle/recovery services.
  The authentication persistence described below does not authorize enrollment.
- Bind every ceremony to environment, operator, purpose, initiating browser,
  exact active credential and current security version; additionally bind step-up
  to the current session and sensitive operation. Browser timeout is not expiry.
- First enrollment needs an independently authorized owner bootstrap grant for
  the exact verified Microsoft identity. Primary login is insufficient. Adding
  or revoking passkeys requires existing strong assurance; prepare a second
  credential and audited recovery/session revocation without email bypass.
- Implement the distinct Microsoft-primary/pending-passkey composition and its
  bounded same-origin HTTP/cookie/CSRF contracts. Only then remove Conditional
  Access requests in that complete mode. Retain deny-by-default scope checks.
- Native DE/EN registration/assertion UI and real owner-controlled authenticator
  evidence, plus Chromium/WebKit cancellation, replay, concurrency and recovery
  checks. Automated synthetic EC keys are not a real device enrollment.
- A reviewed Platform security-epoch cutover and rollback policy that cannot
  restore obsolete or primary-only sessions. Document exact RP/domain stability,
  INT deployment, compatible restore/recovery and real acceptance evidence.

References: https://simplewebauthn.dev/docs/packages/server and
https://www.w3.org/TR/webauthn-3/.

## Durable authentication repository — inactive until composition

Migration053 adds separate Platform credential and authentication-ceremony tables.
Only public keys, public credential identifiers, random handles, counters and backup
flags are stored for credentials. No private key, raw session token or browser
secret is stored. Credential identity/public key/owner/environment are immutable;
revocation cannot be undone, counters cannot decrease and history cannot be deleted.
A database trigger serializes enrollment capacity at five active keys per operator
and environment. Adding or revoking a credential increments the existing operator
security version, invalidating older sessions and pending ceremonies. Runtime
lifecycle services must lock the operator before credentials and supply separate
strong enrollment authority; there is deliberately no enrollment HTTP route here.

`platform-passkey-auth-repository.js` creates database-clock ceremonies lasting
60–300 seconds, bound to the initiating browser hash, exact operator/security
version, environment, security epoch and purpose. Step-up also binds the current
session and a server-computed operation hash. Primary Microsoft identity validation
must happen before a future composition calls this port. Creating a record alone
is not evidence of Microsoft authentication and grants no application authority.

Creation is serialized per operator with a fixed-namespace advisory lock. Five
unexpired records, including exhausted and completed ones, bound the number of
ceremonies within their server-chosen 60–300 second lifetime. Each ceremony permits five verification attempts.
Wrong browser or authority bindings cannot burn another browser's attempt budget.
This bound supplements, and does not replace, HTTP/IP abuse controls at activation.

Authentication locks current operator/session authority, the ceremony and the
operator-owned credential. Real SDK signature verification runs against the locked
counter. An invalid assertion commits the attempt and minimized denial audit.
Success rechecks expiry and authority, consumes the ceremony and updates the counter
with the success audit and injected session mutation in the same PostgreSQL
transaction. Existing session repositories reuse this transaction. Audit/session
failure rolls all changes back; concurrent redemption can succeed only once,
including for authenticators whose signature counter stays zero. Returned proof
context contains a locked server-owned operator snapshot for the internal session
mutation, never browser-selected authority or a cookie.

The current repository has no registration, revocation or recovery endpoint and is
not imported by the Platform composition. Synthetic signed fixtures and repository
checks do not prove owner device enrollment or deployed INT behavior. Schema
readiness advances to exact053/019; Customer/Platform Demo roles receive no privileges on these real
Platform tables. Demo overlay019 grants only TRUNCATE to the separate reset role
so the sentinel-checked full reset includes their foreign keys without exposing
keys or enabling enrollment/authentication in the synthetic Demo. Historical schema rollback tests explicitly drain the empty053
migration before exercising their original guards. Populated053 rollback fails
closed and requires a reviewed recovery/cutover plan; the current epoch is unchanged.

## Microsoft primary identity port — inactive until full composition

The separate `createPlatformEntraPrimaryClient` factory retains the same fixed
Microsoft authority, confidential code/PKCE exchange, nonce, exact issuer/audience,
operator directory, stable object subject and token-time checks. It requests
`openid profile`, essential `auth_time` and a bounded 60–300 second `max_age`.
It requests no Conditional Access context or offline grant and does not interpret
provider roles, groups, email or incidental MFA claims as application authority.
The existing factory and HTTP redirect validator continue to require their exact
CA contexts; they cannot accept a primary-only result.

Primary assertions are opaque, instance-bound, expiring and one-use. The factory
exposes `verifyPrimary`, never the assurance verifier's `verify` method. The
pending operator service accepts only the exact active provisioned provider
identity, returns operator/version/provider/fresh-primary-time binding and audits
resolution failures. Its output has no roles, permissions, assurance or session;
it cannot satisfy the existing trusted Platform identity schema. No raw Microsoft
token is returned or persisted. No runtime configuration selects this factory yet.
OIDC state/browser transaction composition, independently authorized enrollment,
passkey completion, recovery, native DE/EN UI and epoch cutover remain required.

## Passkey authentication application service — not routed

The uncomposed passkey application service resolves the one-use Microsoft-primary
assertion before starting a login ceremony. Only active stored credentials for the
current operator/version/environment become UV-required browser options. A
Microsoft-only result never calls session issuance; missing credentials require the
separate independently authorized enrollment path rather than implicit registration.

A dedicated narrow-path, Secure, HttpOnly, SameSite=Strict cookie binds the public
state to an environment/epoch-separated HMAC. Only the authenticated initiating
browser can retrieve pending options or complete the ceremony. The completion
body must echo the exact returned state. Cookie duplicates, changed signatures,
wrong epochs and stale database records fail closed. Cookie presence is not proof
of login and does not replace exact-Origin, CSRF and abuse controls in the pending
HTTP routes.

On a verified repository assertion, the service constructs the canonical trusted
identity from the locked current operator snapshot, with explicitly application
passkey assurance. It issues the opaque audited session through the existing
session service inside the same transaction and clears the pre-authentication
cookie. Sensitive step-up binds the live current session and server-computed
operation hash and requires both again at execution. It creates a temporary strong
session only inside the verification transaction, invokes exactly the injected
server-owned mutation, revokes that temporary session and returns a fresh normal
MFA session. The temporary cookie never leaves the server. A generic completion
cannot redeem a step-up ceremony and no reusable strong-session cookie can authorize
a different operation. The mutation port must use the same PostgreSQL transaction
and is not an outbound-provider execution port; callback/audit failure rolls back
redemption, counters, business writes and all session changes together.
It does not mint a Microsoft acrs claim or derive any privilege from browser data.
No normal HTTP route or runtime configuration exposes this service yet. OIDC
pending-flow routing, independent enrollment/recovery, DE/EN UI and epoch-safe
activation remain required; no real owner/device evidence is implied by fixtures.

## Enrollment grant policy and application port — inactive

The enrollment grant policy binds a random 256-bit one-use capability to the exact
internal operator/security version, verified Microsoft directory/object identity,
deployment environment, security epoch and random grant ID. Persistence receives
only its domain-separated SHA-256 hash. A structural grant record is not issuance
authority. Bootstrap/recovery require an independent offline issuer and bounded
approval reference, with no primary-session substitute. Additional-key grants
require an existing strongly verified session and a maximum five-minute lifetime;
offline grants are bounded to fifteen minutes. The unactivated durable repository
below implements database-clock expiry, issuance authorization, one-use redemption
and atomic audit. Its new PostgreSQL integration evidence remains pending.

The inactive enrollment application service resolves the opaque Microsoft-primary
assertion, accepts only a grant ID/token from the browser and supplies all identity
and deployment authority itself. Separate independent 256-bit state/browser values
are hashed under an enrollment-only environment/epoch namespace. The existing
narrow-path Secure/HttpOnly/SameSite=Strict passkey transaction cookie is reused;
starting enrollment replaces a pending login ceremony in that browser. The two
namespaces cannot redeem each other's records. Raw grant/browser tokens are never
sent to the repository. Ceremony lifetime is 120 seconds; browser state must echo
the cookie state on every mutation. Routes must additionally enforce exact Origin,
request/content bounds, abuse limits and the applicable CSRF policy.

Registration stages only a public candidate key after real SDK validation. A fresh
distinct challenge then requires a signed UV-required assertion from that candidate
key before the repository may atomically consume the grant, insert the active key,
invalidate older operator authority and append audit evidence. A forged `none`
attestation cannot activate a key without private-key possession. Enrollment has
no session-issuance port and returns only `credential_enrolled`; a new complete
Microsoft/passkey login is required afterwards.

The application-port tests use real synthetic P-256 signatures for both stages,
wrong challenges/origins, missing UV, foreign keys, browser/state/environment/epoch
mix-ups, expiry and replay. Their in-memory repository is a port fixture, not
PostgreSQL evidence. The new durable enrollment/lifecycle implementation below
still requires its own complete database/browser CI. HTTP composition, native UI,
deployment configuration and real device acceptance remain incomplete. No
enrollment or recovery is exposed by the current runtime.

## Durable enrollment and lifecycle candidate — not composed

Unmerged migration054 stores immutable, exact-identity grant records and one
browser-bound registration/possession ceremony per grant. Only hashes of opaque
grant/browser values, random challenges/handles and public candidate keys are
stored. Database expiry bounds both phases, each with at most five attempts;
wrong browser/state/deployment authority cannot consume another ceremony's budget.
The registration candidate remains inactive until a separate real signature is
verified. Grant redemption, credential insertion, operator-version invalidation
and minimized HMAC-chain audit commit together. Required audit failure rolls all
of them back. Concurrent completion can succeed once, including zero-counter keys.

The operator is locked before grant/ceremony/credential authority. Existing
operator handles are reused across additions/recovery; inconsistent legacy handles
fail closed. First bootstrap requires no credential history in that environment.
The SQL grant trigger independently checks exact active operator/provider identity,
current version and issuance authority. Grant identity, capability hash, approval,
issuer, expiry and session bindings cannot change, and used/revoked grants cannot
be restored or deleted. Staged candidates and consumed ceremonies are immutable.

Offline bootstrap/recovery requires the authenticated SQL login, effective role,
configured offline role and actual grant-table catalog owner to agree. The offline
issuer is forbidden from HTTP, normal runtime and both Demo dependency graphs.
`scripts/platform-passkey-offline-grant.mjs` currently accepts only pilot/INT and
the explicitly configured security epoch. It requires a separate protected owner
connection to the same database as the Platform runtime, a different SQL username,
verified TLS and bounded single-connection/timeouts. DEV/PROD remain prepared only.
Runtime credentials must never own the grant table or carry offline-owner access.

The CLI reads bounded JSON exclusively from descriptor3, validates the private
descriptor4 before connecting, checks exact schema readiness and prints the opaque
grant exclusively to descriptor4. Ordinary output contains only receipt metadata;
errors contain fixed codes. No token may enter command arguments, URLs, ordinary
logs, email or browser storage. If final descriptor delivery fails after commit,
the protected owner must reissue: issuance revokes older outstanding grants and
records the replacement; it must not pretend an unread token was delivered.

Offline recovery revokes all old keys, sessions and outstanding grants, then adds
a final managed security-version increment even if historical keys were already
revoked. It never reactivates an old key or restores old sessions. An audit-only
`offline_owner` marker identifies this independent owner action with empty actor
roles/permissions and the exact passkey-grant target. It cannot satisfy any trusted
Platform identity/session schema or authorize business operations. Recovery has
no email-code or Microsoft-primary-only bypass.

Additional-key issuance requires a live, current, application-passkey step-up
session, one to four existing active keys and an exact server-computed addition
operation. Its temporary strong cookie never leaves the verification transaction.
The returned session has ordinary MFA; the short-lived grant still requires fresh
Microsoft identity before registration. Revocation binds the exact owned active
key and requires another active key to remain. It invalidates old operator/session
authority, revokes outstanding grants and finishes with cleared session/transaction
cookies and a fresh-login requirement. It never issues an obsolete-version session.

Candidate schema readiness is exact054/020. Demo overlay020 grants only TRUNCATE
on the two new tables to the sentinel-checked reset role; neither synthetic runtime
gets enrollment privileges. Historical rollback probes explicitly drain020/054
before their retained019/053 and older guards. Populated054 or retained offline
audit evidence prevents rollback and requires reviewed recovery. The synthetic
seed checksum, production security epoch and current live CA mode are unchanged.
