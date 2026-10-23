# Platform passkey assurance

## Bounded primary-failure diagnosis

The server audit distinguishes confidential code-exchange failure from a fixed
allowlist of already normalized token/claim validation failures (including nonce,
issuer, audience, tenant, token times and authentication freshness). Only actual
PlatformIdentityError instances with exact known codes select a fixed reason.
Unknown errors, forged code-bearing objects and SDK/provider messages retain
provider_redeem_failed. Raw tokens, claims, codes, cookies, provider payloads and
exception messages never enter this audit classification or the browser response.

The original exception is rethrown; browser-bound state remains one-use even on
failure, and no retry, passkey flow or session is created. This diagnostic does
not relax any validation or establish the actual deployed failure cause. The
required auth_time ID-token output must be available from the identity provider;
explicit Entra optional-claim configuration is operating evidence, not proof that
a particular received token passed validation.

Primary time diagnostics use fixed classes for the 24-hour future-expiry bound,
negative timestamps, expiry ordering and independent issuance/authentication age.
No timestamp, delta, token or provider payload is logged. Historical general
token-time and authentication/issuance-order reason mappings remain available;
they do not describe the current independent-age predicates.

### Independent primary token and authentication age

[OIDC Core 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
checks issuance age and requested authentication freshness separately relative to
the relying party's current time. It defines no 60-second maximum difference
between `auth_time` and `iat`. Microsoft's
[ID-token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
also does not promise that difference. Do not infer a specific provider backdating
amount or clock defect from an ordering failure.

The primary adapter therefore bounds each of `iat` and `auth_time` independently
to `[now - authenticationMaxAgeSeconds - 60, now + 60]`, with the configured
authentication age still limited to 60–300 seconds (300 in the protected runtime).
The 60 seconds remains clock-skew allowance relative to the RP clock; it is not
an enlarged cross-claim allowance. Issuance now has an explicit lower age bound.
Both timestamps must be safe, nonnegative integers and strictly before `exp`;
expiry must remain future and at most 24 hours ahead. Authentication freshness
is rechecked when the opaque instance-bound assertion is consumed once.

This replaces the extra `auth_time <= iat + 60` assumption, while preserving
state/browser/PKCE/nonce binding, transaction expiry, exact operator mapping and
independent passkey/enrollment authorization. A primary result remains incapable
of issuing a business session. The CA adapter's existing validation is unchanged.
Synthetic contract tests do not prove a real provider round trip or owner device.

## Microsoft callback metadata

The Platform Microsoft callback accepts optional success-response `client_info`
(1–2048 base64url characters) and `session_state` (1–256 base64url characters,
including UUID hyphens). Duplicate, empty, malformed, oversized and unknown fields
remain rejected. Metadata is discarded at the transport boundary: it is never
forwarded to the identity service, persisted, logged or used as operator/session
authority. Required state/code and browser binding, one-time expiry, PKCE, nonce,
provider exchange, exact operator mapping and the independent passkey gate remain
unchanged. Metadata is not accepted on the separate provider-error response.
This compatibility rule does not prove deployed Microsoft or device acceptance.

## Protected INT encrypted initial-grant transport

The optional `protected-int-passkey-bootstrap.yml` workflow calls the unchanged
canonical offline grant CLI for **bootstrap only**, after the first real owner
exists. It does not implement recovery, create an owner, enroll a key, start a
service or issue a business session. Actual Microsoft primary, two owner-controlled
keys and recovery remain separate required operating evidence.

Use the already inspected Main-only environment and serialized database-operation
group. Owner/triggering owner, exact accepted Main, attempt1, ordinary logging,
pinned actions, checkout without credentials and locked Node22 install before
operation-secret allocation are required. Provision the existing dedicated owner
and distinct Platform connections/signing/segment/epoch secrets; preserve Demo
connection carriers. Temporary owner directory/subject bindings are reused.

Add private environment secrets `CM_INT_PASSKEY_OPERATOR_ID`,
`CM_INT_PASSKEY_OPERATOR_VERSION`, `CM_INT_PASSKEY_REQUEST_JSON`,
`CM_INT_PASSKEY_EVIDENCE`, `CM_INT_PASSKEY_RECIPIENT_PUBLIC_KEY` and
`CM_INT_PASSKEY_RECIPIENT_SHA256`. The canonical request is exact, INT, bootstrap,
900 seconds and bound to the independently verified operator/provider identity
and positive integer Platform epoch. Evidence contains exactly sourceSha,
environment, deploymentEpoch, segmentId, operatorId, identityReference,
custodyReference and servicesClosed; reconcile each with actual protected evidence
and keep both services closed during issuance. Binding validation does not prove
that an attested ceremony or closed-service observation actually occurred.

Generate an ephemeral RSA4096 public/private pair in the approved recipient's
private administrative custody. Independently retain its SHA256 SPKI DER fingerprint;
only the public SPKI PEM and fingerprint enter the environment. No private
recipient key enters Actions, source, logs or artifacts. The transport validates
key type, size, exponent, fingerprint and encryption usability before any writer.
RSA-OAEP/SHA256 binds its label to the fixed transport version, accepted source,
request correlation, operator/version, INT/integer epoch, segment, deployment UUID
and recipient fingerprint. Decryption must use that exact privately retained label
and key, then feed the canonical grant only to the same-origin enrollment form.
Never put the raw grant in URLs, browser storage, public logs, email or Confluence.
Loss of the ephemeral private key makes the artifact unusable; it is not recovery
custody or an authenticator.

The canonical FD3 request and FD4 grant use bounded private subprocess pipes.
Standard output/error from the native CLI are suppressed. No plaintext grant file
is written. Only the RSA ciphertext and fixed format marker are written under the
private runner temporary directory and uploaded as `protected-int-passkey-bootstrap`
with one-day retention; the runner copy is removed afterwards. Public output has
only a fixed success/refusal marker. Artifact name/existence or upload success is
not enrollment, delivery to the intended browser, or private-key-possession proof.

If issuance commits but encryption/upload/decryption/delivery fails, inspect actual
grant/audit state first. Do not retry a GitHub run or claim rollback. A separately
reviewed fresh issuance can revoke the older outstanding bootstrap grant through
the existing CLI; it cannot recover or reactivate a credential. Remove temporary
request/evidence/recipient bindings after the controlled ceremony while preserving
required runtime and independent audit-key recovery custody. Dispatch only when
the exact source and all required gates are accepted; source tests use synthetic
transport keys and never establish an owner's real WebAuthn device enrollment.

## Current source status — 21 October 2026

The owned [protected Platform process](PROTECTED-PLATFORM-RUNTIME.md) now composes
the primary, setup, enrollment, lifecycle and exact-operation contracts described
below. The staged implementation notes and candidate schema numbers that follow
are historical checkpoints, not current startup or deployment instructions.
Current configuration and immutable schema authority are defined by
[the protected profile](PROTECTED-RUNTIME-CONFIGURATION.md) and accepted migrations.
Ordinary Conditional Access entrypoints remain unchanged. Actual Microsoft primary,
owner-controlled keys/recovery and the coordinated deployed cutover remain open.

The current MSAL confidential code exchange uses the fixed HTTPS provider endpoint
and explicit protocol/claim checks; it does not independently verify the returned
JWT signature. The historical target below must not be read as evidence of that
verification, an IdP-asserted FAL, hardware attestation or NIST AAL/FAL conformance.
WebAuthn assertion signatures are separately verified by the application adapter.

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
are hashed under an enrollment-only environment/epoch namespace. A dedicated `cm_platform_passkey_enroll` cookie uses the narrower
`/api/v1/platform/auth/passkey/enrollment` path with Secure, HttpOnly and Strict
attributes. Login and enrollment use separate cookies and namespaces; neither
can redeem the other's records. Raw grant/browser tokens are never
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

Unmerged migration055 stores immutable, exact-identity grant records and one
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
The returned session has ordinary MFA. The verified current Microsoft/passkey
identity and fresh addition assertion authorize registration in the same transaction;
the grant is not exposed to the browser or carried through another Microsoft redirect. Revocation binds the exact owned active
key and requires another active key to remain. It invalidates old operator/session
authority, revokes outstanding grants and finishes with cleared session/transaction
cookies and a fresh-login requirement. It never issues an obsolete-version session.

Candidate schema readiness is exact055/021. Demo overlay021 grants only TRUNCATE
on the two new tables to the sentinel-checked reset role; neither synthetic runtime
gets enrollment privileges. Historical rollback probes explicitly drain021/055 and020/054
before their retained019/053 and older guards. Populated055 or retained offline
audit evidence prevents rollback and requires reviewed recovery. The synthetic
seed checksum, production security epoch and current live CA mode are unchanged.


## Pending HTTP and two-key setup candidate — not selected by runtime

The alternative Microsoft route module requests fresh primary identity without CA
contexts and accepts only a browser-bound pending result on callback. It can never
emit a business session. The default CA route registry and runtime composition are
unchanged. This candidate is neither a deployed login mode nor cutover evidence.

Unreleased055 extends pending authentication with an `enroll` purpose carrying the
verified primary authentication time. It has no session or operation hash and cannot
be redeemed by the assertion endpoint. The SQL clock bounds that primary time.
Pending identity is consumed in the same transaction as independently granted
registration creation; a mismatched grant rolls back the consumption. Every stage
rechecks current operator/version/environment/epoch and server expiry.

A setup-only service always rejects normal session issuance. After the independently
granted first key, another fresh Microsoft login and real first-key signature can
create an internal temporary strong session, issue an additional grant and begin
registration of the second key atomically. That temporary session is revoked before
returning registration options. Two completed keys finish setup without a business
session. A separately composed active service must explicitly require two keys.
Setup never produces a reusable strong-session cookie or a Microsoft-only login.

The alternative routes below are bounded to the same origin, exact host, JSON bodies
of at most32768 bytes and30 requests per source address/minute. They reject queries,
unknown fields and unsupported methods. Preauthentication writes require the exact
server-issued state in both body and CSRF header, plus the initiating HttpOnly
cookie. Authenticated key management uses the normal Platform session/CSRF guard.

| Path below `/api/v1/platform/auth/passkey` | Method | Contract |
| --- | --- | --- |
| `/configuration` | GET | Mode, environment, minimum key count only |
| `/pending` | GET | Pending assertion or independently granted enrollment |
| `/authenticate` | POST | Exact state and native assertion |
| `/enrollment/pending` | GET | Resume registration or possession proof |
| `/enrollment/start` | POST | Exact pending state and independent grant ID/token |
| `/enrollment/register` | POST | Stage native registration candidate |
| `/enrollment/complete` | POST | Activate only after actual signed possession |
| `/manage/keys` | GET | Current operator's minimized active key list |
| `/manage/addition/start` | POST | Begin exact addition proof |
| `/manage/addition/complete` | POST | Proof and registration start in one transaction |
| `/manage/revocation/start` | POST | Begin proof bound to owned credential ID |
| `/manage/revocation/complete` | POST | Exact proof, revoke and logout |

Bodies contain no trusted identity, public-key persistence record, session token,
raw grant result or strong cookie. Normal login completion returns only status;
the existing session endpoint supplies its normal minimized session projection.
Public errors and durable denial reasons exclude native/provider payloads. These
HTTP port tests do not substitute for real PostgreSQL, browser/device or deployed
cutover acceptance. Generic business operation step-up, production composition,
native DE/EN UI and owner authenticator verification remain open.


Integration with main5bbe97b preserves the independent supplier catalogue migration054/
Demo020 and assigns the unreleased enrollment migration055/Demo021. Exact readiness
is055/021. Both sets of tables and historical rollback/role-denial probes remain
required. The earlier054/020 enrollment candidate is superseded, not deployed.

## Composition and exact-operation candidate — not deployed

A follow-up candidate introduces the protected `PLATFORM_ASSURANCE_MODE` selector.
Its default remains `conditional_access`, with the existing strict contexts and
identity path. Unknown modes fail closed. `passkey_setup` and `application_passkey`
require a known DEV/INT/PROD environment, an explicit security epoch of at least2,
a separate32–512-byte transaction secret, no CA contexts and fixed300-second primary
OIDC freshness/transaction lifetime. Reusing Platform or Customer identity/session/
audit secret material is rejected. These requirements are rechecked by composition.
An epoch is deployment authority, never a browser or tenant setting.

Setup composes the primary/pending and enrollment HTTP ports but its HTTP session
resolver always returns unauthenticated, including for an old CA session. Its
internal temporary session port exists only for audited second-key setup. Active
mode explicitly requires two keys before login and its HTTP resolver accepts only
application-passkey assurance; primary-only or old CA contexts cannot become an
active Platform principal. No offline issuer is imported by either composition.

Sensitive existing route families are decorated, without a generic command/action
endpoint. The first exact request validates the current Platform session and CSRF
and returns428 with a fresh native assertion challenge. The server hashes canonical
bounded request body, exact method/path/query, idempotency header, current session,
operator/version, environment and epoch. Read-only sensitive diagnostic correlation
and audit export also require CSRF for this deliberate proof exchange.

Retry uses the same request and `X-Platform-Passkey-Proof`, a bounded canonical
base64url JSON object containing only state/native response. The separate transient
`cm_platform_operation_tx` cookie uses `/api/v1/platform` so it reaches that exact
business route; it is Secure, HttpOnly, Strict,120 seconds, and never sufficient
without the live session, CSRF, signature and stored operation hash. Login and
enrollment retain their separate narrower cookies. No reusable elevated cookie
or principal is returned.

Inside the signature transaction, an instance-private, one-use proof context may
supply the strong principal to exactly that internal request. Existing positive
body schemas, role/target checks, idempotency and concrete services still execute.
Exact-operation proof transactions begin at writable `REPEATABLE READ` so the
existing coherent entitlement reader joins the same transaction without requesting
an illegal isolation upgrade. Ordinary login keeps `READ COMMITTED`. Concurrent
snapshot conflicts fail closed and roll back proof, counter, business state and
session together; no implicit retry of the signed operation is introduced.
The temporary request carries only the validated body and idempotency contract;
client cookies, identity headers or arbitrary outbound URLs are not forwarded.
Its bounded JSON response is buffered until proof consumption, counter, business
writes, audit and ordinary MFA session issuance commit. A mutation/audit/commit
failure cannot send business success before rollback. Changed body/target/query/
idempotency/session, clone/reuse of proof context and replay are rejected.

This is an unmerged implementation candidate, not INT activation evidence.
Native operation-proof transport/presentation, authenticated key-management UI,
exact-head database/browser gates, real owner enrollment/recovery rehearsal and
reviewed live epoch cutover remain required. DEV and PROD are prepared in code;
no environment has been activated by this change. Rollback must fail closed or
advance the epoch and revoke affected authority; it must never restore primary-only
or superseded sessions. Populated key/grant migrations cannot be rolled back to
recover access; use the independently audited owner recovery procedure instead.

## Revoked-session review correction

Review of exact integration8e0fedf identified a race after the HTTP principal guard:
if a session was revoked before lifecycle re-resolution, normalizing a missing
principal produced an internal TypeError. The follow-up explicitly rejects null/
undefined re-resolution with the bounded Platform identity error before key reads,
signature work, grant callbacks or mutations. Managed key-list denials now receive
the same minimized denial audit as management POSTs; preauthentication polling
keeps its prior behavior. No successful path, permission, session or key policy is
weakened. Deterministic lifecycle and actual HTTP tests cover listing, addition and
revocation interleavings with fixed403, no cookie, no private cause, three minimized
managed denial events and no verifier/repository effect. The initial style failure
was an overlong fixture-return line, wrapped without changing assertions.


## Current main integration after publication custody

The unmerged enrollment candidate now follows accepted publication055/Demo021
as056/Demo022. Earlier dated055/021 enrollment checkpoints above are historical
candidate numbering and do not describe current deployable schema authority.
Accepted publication files/checksums remain unchanged. Exact readiness, Demo reset
inventory, upgrade guards, media tools and historical rollback tests require the
combined056/022 chain. Original publication055, catalogue054 and credential053
rollback and role-denial assertions remain present; this integration needs its own
full current-tree local, native database and paired browser/security qualification.
No live grant, key, assurance-mode change or INT activation has occurred.

During this integration, the initial focused reset suite exposed a retained055
sentinel constant after the stream had advanced to056. The reset inventory now
requires056, preserving the original sentinel and rollback assertions. The final
66 focused Demo/reset/media/recovery tests passed. A separate scratch-only
PostgreSQL18.6/WASM preflight applied all56 migrations, verified empty056 down and
rollback restoration; it does not qualify native pools, concurrency, TLS, Demo
roles, complete paired browsers or required GitHub checks. Full final validation
and native/paired current-head acceptance remain required for the integrated tree.


The first native integrated enrollment PostgreSQL job failed in the retained
Demo004 upgrade test because an explicit overlay-version expectation still said21
while the ledger contained22. Its full ledger list and upgrade readback now retain
all overlays through22 (Customer descendants extend through23). Four other explicit
current-schema assertions were advanced to the exact integrated version as well;
the historical schema21/33/etc. rollback expectations are unchanged. This is a test
contract correction, not a waived failure, and requires fresh current-head checks.

### Expected nonce at the actual SDK code exchange

The existing CA flow and prepared primary/passkey flow recover the original
nonce from the transaction secret and random state in the distinct
`platform-oidc-nonce:v1` HMAC domain. Only its hash remains in transaction custody.
Code redemption verifies that expectation before provider I/O and supplies the
raw expected nonce to the pinned SDK, as well as retaining independent hash and
claim validation. This fixes the actual SDK's `nonce_mismatch` rejection when no
expected nonce was supplied. It does not relax issuer, audience, context,
freshness, epoch, target/session binding, key count or one-use proof controls.
Old random-nonce pending transactions must restart; ordinary business sessions
and registered keys are preserved. Actual SDK round-trip tests use isolated
synthetic provider responses and do not claim real owner/device acceptance.
