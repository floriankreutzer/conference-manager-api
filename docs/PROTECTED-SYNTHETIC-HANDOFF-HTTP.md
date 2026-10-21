# Protected synthetic handoff transport

This opt-in transport composes the inactive server-side custody described in
PROTECTED-SYNTHETIC-CUSTOMER-HANDOFF.md. It does not install routes, select an
entrypoint/profile, configure actual Microsoft/provider secrets or establish
physical-key or protected INT operating acceptance. No migration is added here.
The full owned runtime must supply the actual protected session services,
qualified repositories, fixed retained-proof port, minimum two passkeys and
current UUID/integer epochs. A mock protocol port is not an authentication grant.

## Customer surface

| Route | Contract |
| --- | --- |
| POST /api/v1/auth/delegation/start | Same-origin empty JSON; observed socket source; bounded server start; fixed Ops303 redirect. |
| GET /api/v1/auth/delegation/callback | Exact state/code query and original browser cookie; issues only short completion;303 to sanitized confirmation URL. |
| GET /api/v1/auth/delegation/confirmation | Both original and signed completion cookies; only known slot/role and bound CSRF. |
| POST /api/v1/auth/delegation/complete | Same-origin empty JSON plus bound CSRF; forwards current ordinary cookie for account recheck; committed Customer cookie plus303 only. |

The original nonce cookie is Secure/HttpOnly/Lax on
/api/v1/auth/delegation for at most600s, allowing the cross-site top-level
callback. The signed completion cookie is Secure/HttpOnly/Strict on that same
narrow path for at most30s. There is no Domain attribute. Duplicate, malformed,
noncanonical and oversized cookies fail closed. Completion never silently logs
out an existing REAL/unknown/foreign account;409 AUTHENTICATION_LOGOUT_REQUIRED
preserves all cookies and requires explicit logout/new start where expired.

Expected invalid callback validation/nonce/code failures redirect to a fixed
sanitized failure URL. Infrastructure failures remain failures; no mutation or
success redirect is manufactured. The outer app retains Host/target/rate/body/
error/security gates. A rejection before the protocol handler (for example a bad
Host) remains an outer error, not a guaranteed browser-history erasure mechanism.

## Platform surface

| Route | Contract |
| --- | --- |
| GET /api/v1/platform/auth/delegation/arrive | Exact flow/state query, no identity grant; short signed Strict intent cookie and sanitized303. |
| GET /api/v1/platform/auth/delegation/intent | Current normal passkey MFA plus signed intent; only static known role/slot choices. |
| POST /api/v1/platform/auth/delegation/options | Same-origin normal-session CSRF; current own generation/slot/role intent; fresh exact proof challenge. |
| POST /api/v1/platform/auth/delegation/approve | Same origin/CSRF/current normal MFA and operation cookie; fresh assertion; committed future MFA plus fixed Customer callback303. |

Cross-site arrival may omit the existing Strict Platform session cookie. It only
preserves a signed, scope-bound opaque intent, allowing real Microsoft/passkey
login and a later same-origin confirmation request without JavaScript storage.
That cookie is Secure/HttpOnly/Strict on the delegation path for at most600s;
it cannot grant identity, a generation, a proof or a Customer session. Its MAC
binds both origins, environment, UUID and Platform epoch, flow, original state,
fresh Ops nonce and expiry. It is never exposed by the intent JSON response.

Browser mutation input contains only a requested generationId, known slot and
role. Operator identity comes from the normalized current server principal.
Neither internal Tenant/User IDs nor arbitrary roles/redirects are accepted.
The original Customer flow state remains inside the signed intent cookie; the
separate assertion state comes from the actual passkey challenge. They are not
interchangeable. An actual private exact-operation context and future normal-MFA
continuation remain authoritative in the core service/repositories.

The protocol coordinator holds the short owned shared preparation lease while
binding intent and creating a challenge. Approval recomputes that binding under
shared custody, releases it, and then lets the actual passkey repository enter
its owner-stamped exclusive RR transaction. It does not retain an outer shared
lease across an exclusive upgrade. Redirect/code and future normal-cookie output
wait for the entire proof/mutation/session/audit commit. Completion validates a
new normal session of the same operator/version, a canonical narrow cookie and
the fixed Customer origin/path with exact original state and canonical code.
No privileged result is serialized as an ordinary JSON receipt.

Both surfaces clear only their own transient cookies after successful completion.
All responses are no-store/no-referrer; telemetry uses fixed route vocabulary,
never raw URL/query, state, code, session IDs/cookies or CSRF. The shared canonical
32-byte browser-value validator is provider-neutral; the previous Customer helper
name remains a compatible re-export, with identical value behavior.

## Evidence and outstanding integration

Unit/loopback fixtures test positive contracts, absent MFA on arrival, strict
subsequent MFA/CSRF/origin checks, closed selections, cookie duplication/scope/
expiry/MAC tampering, unsafe redirects, preserved account-switch errors and
withheld responses on failed/pending commit. These fixtures do not prove WebAuthn
or a real Microsoft login. The separate native two-surface test uses actual
PostgreSQL/max1 scopes, software P256 signatures, continuation, one-use Customer
issuance/audit and source-session revocation; it counts as evidence only after
its exact-source CI executes successfully.

The native fixture manually wires canonical services. Full entrypoint/operating
configuration, namespace-bound Microsoft/pending Platform login, provider/SIM and
media/directory integration, actual frontend browser journey, recovery and
physical-device acceptance remain separate required work. All closed Demo
three-customer progression and two-reset matrix checks still apply. No default
flag is enabled by adding these adapters.

## Actual elapsed proof acceptance

The additional `test:db:handoff-expiry` command uses a separate, uniquely owned
local PostgreSQL fixture database in the existing integration job. Its CLI
refuses a nonlocal host, different fixture role/database, SSL mode, environment
or extra argument before connection. It creates no managed resource. The
ordinary integration runner and its120s-per-file limit remain unchanged; the
existing CI job and15-minute limit also remain unchanged.

The explicitly named acceptance uses actual database time and software P256
signatures. It waits until both approved flows' actual120s proof and60s code
expiries have passed, without changing clocks, timestamps, rows, quotas or
production lifetimes. A consumed Customer session must still resolve, an unused
code must fail, and ordinary new-challenge cleanup must retain the referenced
expired proof while deleting the expired unreferenced proof. Revocation of the
source normal-MFA session must then deny the Customer session. The named test
has a175s bound and its isolated child process a180s watchdog. This becomes
acceptance evidence only after the added exact-source CI step has passed.

## Native browser navigation

A browser fetch manual redirect is opaque; fetching a cross-origin303 does not
navigate the document. In addition to the unchanged strict JSON API contract,
Customer start accepts an exactly empty native URL-encoded form, Customer
completion accepts only its bound `csrfToken`, and Platform approval accepts
only `csrfToken` plus a serialized exact JSON `payload`. Options remain same-origin
JSON for WebAuthn challenge acquisition. After the actual assertion the browser
submits a top-level native form to its own API origin; the committed303 performs
the intended cross-site navigation without returning a code as JSON.

The common transport parser accepts only bounded, canonical URL-encoding and
exact fields, rejects duplicates/unknown fields/encodings/overflow, and cannot
establish identity or CSRF. Form CSRF uses the same existing principal-bound
Platform verifier or original-flow Customer verifier. A competing CSRF header is
rejected. Host/Origin/site/session/current custody/exact proof, cookie and commit
checks are unchanged; no form can select an operator, Tenant, redirect or grant.
The full frontend must allow only its fixed counterpart origin where its CSP
form-action redirect policy requires it. Actual browser navigation and CSP
acceptance remain required; loopback HTTP serialization alone is insufficient.

## Explicit account logout

Confirmation also exposes a conservative `accountSwitchRequired` boolean when
an ordinary Customer cookie is present. It describes cookie presence only,
never identity or authorization. The final completion still rechecks actual
custody and refuses a REAL/unknown/foreign account, including a new login after
that read. No account is switched or logged out automatically.

A separate same-origin JSON `POST /api/v1/auth/delegation/logout` accepts the
original browser/completion cookies and that flow's bound CSRF. Only an explicit
user action may invoke it. Under current shared custody and one transaction it
rechecks the approved flow/completion/CSRF, revokes the actual current protected
ordinary session through canonical Tenant audit if resolvable, and returns204
with only the canonical ordinary-cookie clear. An unknown/expired cookie has no
authority to revoke a session but can be cleared. This avoids trapping a browser
whose invalid HttpOnly cookie cannot pass ordinary authenticated logout. Other
sessions/identities and the short handoff cookies remain unchanged. No Customer
session is issued and the handoff is not consumed by logout. The frontend may
continue only after a successful acknowledgement and must not blindly replay an
ambiguous logout. Expired flows require a new start and fresh exact approval.


## Login continuation and document policy

An authenticated normal-MFA startup may read intent once after Microsoft/passkey
login has scrubbed the presentation query. GET intent returns only200
`{status: 'none',requestId}` when no valid signed intent is present. This response
creates no cookie, challenge, target, generation or grant. The same current MFA,
provider/epoch, body and Origin/site checks still run first. Every mutation still
requires a valid signed intent and exact operation proof; no query establishes
continuation authority. An expired intent requires restarting from Customer.

Actual native WebKit form acceptance requires the protected HTML document to use
same-origin Referrer-Policy and matching meta, preserving the concrete Origin for
same-origin POST while suppressing external Referer. A no-referrer document
serializes native form Origin as null; the API deliberately continues denying it.
API callbacks/redirects retain no-referrer and scrub code/state before HTML. Both
protected documents must name only their fixed validated counterpart in CSP
form-action; self-only meta and a broader header intersect, never loosen each
other. Ordinary closed Demo HTML/CSP remains unchanged. Frontend365 prepares the
Customer artifact helper and tested native local303; complete two-origin/static
root/real-primary/browser/deployment acceptance remains outstanding.
