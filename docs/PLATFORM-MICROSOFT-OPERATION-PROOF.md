# Microsoft exact-operation proof (source candidate)

The owner-selected target removes application passkeys from the active Platform
runtime. Microsoft-issued MFA remains mandatory. The accepted Microsoft login
adapter does not by itself authorize a synthetic reset, Customer handoff or
privileged business operation. An ordinary login, browser-selected role/hash or
generic elevated cookie must not substitute for an exact one-use proof.

## Implemented protocol component

`createPlatformMicrosoftOperationService` prepares a bounded source-bound proof
through an explicit repository port. Environment, non-reusable deployment UUID,
integer Platform epoch, source normal session, operator version, exact operation
digest, correlation, nonce and browser custody are server-owned. Its MAC purposes
are independent; provider code exchange uses PKCE and the existing opaque
Microsoft-MFA verifier and closed claim policy. Only the fresh internal Microsoft
context is accepted, with the exact current operator directory/subject and a
fresh authentication time. The separate `createPlatformEntraOperationClient`
accepts only its fixed operation callback and fresh context; ordinary login and
primary-only client factories continue to reject that callback.

The provider callback only verifies the pending proof. It executes no business
operation, issues no application session and returns no elevated principal or
CSRF token. Both transient cookies contain only state and a purpose-bound MAC.
The provider cookie is Secure/HttpOnly/Lax and confined to the fixed operation
callback. A separate Secure/HttpOnly/Strict cookie reaches Platform requests.
Both start with at most120 seconds; callback completion cannot extend the actual
repository deadline. Normal Platform session-cookie policy remains unchanged.

The original page may request only a source/browser-bound pending/verified status.
This read-only projection contains no proof, cookie, identifier or provider data.
The intended browser integration uses an explicit Microsoft-confirmation tab and
bounded status checks, preserving existing COOP same-origin rather than relying
on an opener surviving a different-site provider navigation. No browser storage
or generic command endpoint is introduced.

Final execution independently requires the original current normal-MFA session,
matching MAC/state and exact digest. The repository port must atomically consume
the verified proof with business mutation, required audit and session rotation.
Temporary fresh elevated authority stays private in an instance-bound WeakMap;
wrong-instance, wrong-digest, reused and escaped contexts fail closed. The explicit
continuation variant prepares a distinct normal session inside the same commit
for Customer delegation. No strong cookie or mutation result leaves the service
before that transaction returns successfully.

## Owned HTTP composition

The candidate closed protected Microsoft profile installs the ordinary operation
service and decorates the existing concrete Platform route families. Canonical
bounded request hashing, buffering, original body/target/permission policies and
commit-before-output now share one transport implementation with the unchanged
legacy passkey profile. The Microsoft profile accepts only its own state header;
an application-passkey header cannot substitute. An explicit428 response carries
only status, state, fixed-provider authorization URL and request ID. A final
request uses `X-Platform-Microsoft-Proof` with exactly that state and its original
method, URL, body, idempotency key and source session. It is never retried blindly.

Fixed authentication endpoints under `/api/v1/platform/auth/microsoft/operation`:

- `GET /configuration`: current authenticated capability, mode and environment.
- `GET /callback`: bounded provider response plus callback-only Lax cookie;
  no source Strict cookie is required or elevated application session issued.
- `GET /complete`: fixed neutral script-free bilingual page after query scrub;
  reaching this page makes no verification or business-success claim.
- `POST /status`: exact `{state}` body, current normal Strict source session,
  CSRF/origin and separate Strict operation cookie; only pending/verified plus
  request ID is returned. No generic command is accepted.

The Microsoft login factory permits only normal MFA login transactions and
rejects old/generic step-up transactions before provider exchange. Its route
registry does not expose generic step-up, and its HTTP session resolver accepts
only normal Microsoft MFA. Temporary fresh authority stays inside final owned
transactions. No active WebAuthn service, enrollment route, key secret or
minimum-credential requirement is constructed in this profile. CSP, COOP,
same-origin, no-store and no-referrer policies remain unchanged.

## Required integration before activation

The complete requested release is not yet deployable. The draft070/031 custody
progression passed actual PostgreSQL in CI40130784451 on source
c080dfa14900f0694ade608f218e15c616bd9e20; complete native/browser qualification
is still pending, and this HTTP follow-up requires its own exact-source gates.
The PostgreSQL adapter now implements current-source and expiry/CAS checks,
fixed ordinary/shared versus synthetic owner-exclusive transaction selection,
bounded retention and mandatory audit receipts. Schema070 and Demo031 add the
private proof table, immutable guarded transitions and empty-only reset grant.
The fixed Platform-only incremental grant uses the existing exact-source,
epoch/segment, offline-owner, signed-chain and two-role-drain gate. It never
replays fresh-role installation or adds Customer proof access.

The actual-PostgreSQL progression uses the real session and audit
repositories with independent max-one business/lease pools and isolated actual
MSAL responses. It covers inert callbacks, ordinary and synthetic execution
classes, one-use proof, wrong digest/class, rolled-back business/session writes,
mandatory audit, password-only denial, logout, operator disabling, capacity and retained
history. Synthetic SDK tokens do not prove real provider signatures or physical
MFA. Browser integration and different-site browser acceptance remain required.
Actual provider registration
of the separate fixed callback is operating evidence, not implied by its client
validator. No deployed profile or closed Demo graph has been activated by this change.

The legacy synthetic handoff proof foreign key, approval trigger, calendar-source
lock and delegated-session reader still require their existing legacy proof.
They must receive a reviewed additive Microsoft branch preserving all existing
history, source/operator/role/epoch/exact-operation/audit constraints. Do not
replace those predicates with an ordinary MFA principal or weaken the legacy
branch. The active no-passkey profile must instantiate no WebAuthn service or
minimum-credential requirement.

Focused in-memory service-port tests cover inert callback, separate cookies,
exact digest/browser/source/version/expiry checks, provider mismatch, callback
replay, private context one-use/instance scope and withheld results on mutation
or simulated commit failure. The HTTP follow-up adds original-route exact binding,
source/CSRF/claim-shape failures, withheld output, login-only rejection and real
HTTP host/origin/cookie/CSP/COOP/redaction checks. These are component/transport
evidence only, not real Microsoft/device MFA or deployed acceptance. Full exact-source
quality/security/native, all permanent three-customer/two-reset browser/storage
gates, actual provider evidence and coordinated live acceptance remain mandatory.

## Qualification history

Candidate be0e22aea5aad06d272dab9d239ee14ecff92954 passed quality,
including2151 tests and both HTTP security gates. Its actual native proof
progression reached the final owner-state fence after successfully exercising
callback separation, shared/synthetic execution, rollback, replay and capacity.
The fixture then used unsupported operator status `suspended`; the canonical
operator vocabulary is `active`/`disabled`. The fixture now uses `disabled`;
no schema, runtime predicate or original assertion is weakened. The failed run
remains failed and complete renewed native/browser qualification is required.

Candidate59afd9129e6aff08ca9091d8562cdce271a1f2c8 passed quality and
all native operation/mutation fences, then correctly returned no audit page for
the disabled owner with stale version1. The fixture now verifies the signed
operation receipt before disabling, explicitly requires an empty page afterwards
and independently verifies the retained chain through the offline transaction
port. No disabled-actor exception is introduced. Full renewed gates remain open.

Candidateaed36006ebe617c2d41a0123d294146b2ad4748c completed every
operation/state/retention and active/disabled audit-page assertion, then exposed
a fixture-only adapter mismatch: `verifyWithClient` belongs to the segmented
adapter, while this isolated fixture uses the legacy adapter. It now invokes
that adapter's existing `isReady` verifier, which checks all retained signatures,
row count and terminal hash. The production adapters are unchanged.
