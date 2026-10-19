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
context contains no cookie, role or browser-selected authority.

The current repository has no registration, revocation or recovery endpoint and is
not imported by the Platform composition. Synthetic signed fixtures and repository
checks do not prove owner device enrollment or deployed INT behavior. Schema
readiness advances to exact053/018; the Demo receives no privileges on these real
Platform tables. Historical schema rollback tests explicitly drain the empty053
migration before exercising their original guards. Populated053 rollback fails
closed and requires a reviewed recovery/cutover plan; the current epoch is unchanged.
