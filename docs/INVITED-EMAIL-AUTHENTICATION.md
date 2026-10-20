# Invited email authentication foundation

## Scope and implementation status

This foundation supports the invitation-only Customer access work in application
issues #351 and #352. Root `AGENTS.md`, the existing session, authorization and
Tenant contracts remain authoritative. This is not an active authentication
endpoint or a completed login flow.

The implementation adds four bounded owners:

- `domain/invitation-recipient.js`: conservative ASCII mailbox validation;
  normalize domain casing only, preserve local-part casing and plus/dot aliases.
  Email equality does not link identities or grant membership.
- `identity/email-code-proof.js`: secure eight-digit codes and 256-bit initiating
  browser tokens, with purpose-separated HMAC verifiers bound to deployment,
  challenge, internal Tenant and internal User. Plaintext values are transient
  outputs for the authorized delivery/cookie orchestration only; persist only
  verifiers and never log either value.
- `integrations/resend-email-client.js`: fixed-destination transactional plain
  text delivery. Sender, credential, environment and deadline are server-owned.
  Application input cannot add recipients, sender, headers, URLs or attachments.
- `integrations/customer-access-email-content.js`: inactive German and English
  plain-text invitations and sign-in-code messages. The factory accepts only a
  canonical server-configured HTTPS Customer origin and a known environment.
  Invitations carry no bearer credential and point to the fixed application
  root; membership admission remains a separate backend requirement. Codes stay
  out of subjects and URLs, preserve leading zeroes and show an explicit UTC
  expiry localized to DE/EN. Non-production messages identify their environment.
  Unknown fields/locales, display-label control characters, malformed timestamps
  and code lifetimes outside 2–15 minutes are rejected. These content checks do
  not enforce actual challenge expiry, single use, browser binding or admission.

## Outbound provider boundary

The approved `transactionalEmail` origin in server configuration is
`https://api.resend.com`. The adapter sends only `POST /emails`, disables
redirects, omits ambient credentials, uses a bounded 1–30 second deadline and
accepts only a bounded JSON receipt with a valid message UUID. Responses are
limited to 4096 bytes and 64 stream chunks. Errors never retain raw provider or
network messages, code content, recipients or API credentials.

An environment-separated hash of the server-owned stable delivery UUID is the
idempotency key. The application must retain the same UUID and exact payload
for a retry. The adapter performs one attempt; a future durable dispatch use
case owns bounded retries, scheduling, expiry and recipient-level abuse limits.
429 and 5xx/network failures are classified as retryable; authorization,
validation and ambiguous 409 conflicts require explicit handling. Bounded
Retry-After guidance is advisory and grants no automatic retry authority.

The receipt means `accepted`, never delivered or read. Provider acceptance must
not issue a session. Actual mail receipt is separately verified with an
authorized recipient. Resend idempotency is time-limited; durable application
state must prevent a later resend after the provider retention window.

Provider references:
- https://resend.com/docs/api-reference/emails/send-email
- https://resend.com/docs/dashboard/emails/idempotency-keys

## Mandatory follow-up before activation

The cryptographic factory does not implement authentication by itself. The
following remain required and must be independently tested:

1. Versioned Tenant-scoped membership/invitation/challenge persistence; expiry,
   bounded attempts and resend limits; atomic single-use redemption across
   instances; verified active User and current authorization snapshot.
2. An authenticated, authorized Tenant Admin/Platform invitation flow; existing
   role separation, last-admin protection, CSRF and server audit authority.
3. Enumeration-resistant HTTP contracts, secure browser-binding cookie and
   durable dispatch/recovery; no silent account linking by email claims.
4. Existing session issuance only after successful proof and membership
   resolution, with audit-atomic persistence and security-version fencing.
5. Verified sender configuration, protected secrets, composition of the DE/EN
   templates only after the durable flow enforces their promises, complete
   login UI/browser tests and actual authorized receipt/client accessibility
   evidence. Plain-text content uses paragraphs and text labels without HTML,
   images, tracking or remote assets; real email-client/screen-reader behavior
   remains an activation check.
6. INT composition with real-user/reset isolation, retaining the existing Demo
   invariants; no Demo fallback or weakening of Platform MFA/step-up.

None of these modules is composed into an entrypoint. No outbound email is sent
by loading configuration or creating a proof. The primitives add no provider SDK/dependency, stored role or change to the
existing login/session contract. The custody candidate below adds schema057.
The module architecture gate also rejects imports of the real delivery adapter
from either synthetic Demo composition.

## Unreleased Customer invitation application boundary

The uncomposed `authorization/customer-invitation-policy.js` validates a closed
command UUID and one through20 distinct recipient intents. It reuses the canonical
Customer authorization snapshot: Employee is the implicit baseline; only existing
Conference Manager/Tenant Admin roles are assignable. Platform roles, invented
Tenant Operator roles, permissions, caller-selected Tenant/User/provider identity,
expiry and acceptance are rejected. Domain casing is normalized; local casing,
plus and dot aliases remain distinct. Hidden/symbol/accessor/prototype-bearing or
sparse input is rejected without evaluating accessors. Returned values are copied
and frozen. Validation establishes intent only, never membership or authority.

The uncomposed `application/customer-invitation-service.js` provides Customer
Tenant Admin list, bounded batch issue, exact object/revision reissue and revoke
ports. It uses `tenant:users:manage` plus same-Tenant current Principal context and
rejects suspended/archived/unknown lifecycle states before repository access.
The separate Platform onboarding boundary must use its own current authority; no
Customer Principal is promoted or supplied with Platform permissions.

The repository contract carries environment, current Principal, server-resolved
Tenant, correlation, the command UUID and bounded immutable intent. It must lock
and revalidate live Tenant/User/session/version/role authority, then atomically
persist all invitations, stable encrypted delivery records and required audit.
Exact command replay must return its original result; a changed body/actor/scope
under that command must conflict. Reissue/revoke require the exact current revision
and an eligible unaccepted invitation. Reissue queues a new delivery and expiry;
revocation prevents queued dispatch and pending acceptance. Neither operation
re-enables a disabled User or changes an accepted User's roles. Existing role
administration/lifecycle and last-admin protections remain their sole owners.

The service validates every projected row against the expected Tenant/environment
and a closed metadata schema. Listing is at most100 in strictly increasing UUID
order; duplicate, foreign, private, malformed or stale-result rows fail closed.
Issue requires one matching pending revision1/queued receipt per requested intent.
Mutation receipts must match the exact object and next revision. Audit callbacks
contain invitation ID/revision/operation only, never recipient, code or tokens.
Delivery `accepted` means provider acceptance; no `delivered` state is fabricated.

Historical foundation-only checkpoint: ten focused native progression/negative
cases passed. The first local style check
found overlong test lines, which were wrapped without changing assertions. These
are application/port tests, not real transaction, mail receipt, HTTP/CSRF, replay,
concurrency or activation evidence. At that checkpoint no repository/schema composed these ports. The custody
candidate below now implements invitation persistence. Platform creation, HTTP,
invited-only authentication/linking, dispatch and browser UI are separate follow-up
scopes; no entrypoint activates real Customer access in this custody candidate.

## Unreleased mailbox-proof separation

An email login must work before an unauthenticated browser can safely know its
Tenant memberships. The candidate therefore separates mailbox ownership from
Tenant admission. A stable server-side mailbox identity has no application roles,
Tenant authority or Microsoft identity. `createEmailMailboxProofFactory` binds an
eight-digit code and initiating-browser verifier to that internal mailbox UUID,
challenge UUID, deployment and an independent `email-mailbox-code:v1` HMAC domain.
It shares the existing cryptographic implementation without inventing Tenant/User
IDs. The original three-ID factory and its `email-code:v1` HMAC remain compatible.
Both reject unknown, hidden, accessor and prototype-bearing context shapes.

Only a subsequent authoritative transaction may resolve live eligible invitations/
memberships for the verified mailbox, recheck Tenant lifecycle/User activity and
security versions, accept the stored invitation roles once and issue the existing
Tenant-scoped session. With several organizations, an authenticated pending choice
must select from server-loaded eligible membership references; the browser never
chooses independent Tenant authority. A mailbox proof is insufficient to link a
Microsoft identity; explicit authenticated linking must prove both authorities.
No shared mailbox/global proof may change an existing User's roles or revive a
locally disabled User. Shared recipient-level budgets must survive challenge
replacement/resend. Enumeration-resistant request responses must disclose neither
mailbox existence nor organization names before proof.

The new `mailboxSignInCode` DE/EN plain-text template contains no organization or
membership data. It reuses code formatting, explicit UTC expiry, browser-only use,
non-production labels and the bounded Resend contract. Four additional focused
cases verify mailbox scope/purpose, legacy HMAC compatibility, malformed context
and mailbox template/transport behavior. Durable mailbox custody, expiry/attempts,
HTTP/CSRF/choice/session consumption and actual mail receipt are still open; these
primitives and templates remain uncomposed and send no mail by themselves.

## Unreleased encrypted mailbox and delivery custody

`persistence/customer-access-cipher.js` is a separate server-only mailbox/delivery
custody boundary using Node AES-256-GCM, fresh96-bit nonces and128-bit tags. Bounded
opaque bytes are1..32768; the positive envelope carries only version, key ID,
canonical base64url nonce/tag/ciphertext. Independently loaded environment, mailbox,
record ID, purpose and invitation Tenant form authenticated associated data.
Mailbox recipient/code purposes forbid a Tenant; invitation purpose requires one.
Ciphertext cannot establish its own scope or select an algorithm/key outside the
protected server keyring. This does not relax or repurpose Integration credentials.

A separate HMAC lookup key produces deployment-specific mailbox fingerprints from
the conservative normalized recipient. It preserves local case and plus/dot aliases;
no plaintext recipient is an index, log or public identifier. Up to eight copied
256-bit encryption keys support explicit old-key reads/new-key writes. Lookup-key
rotation is not achieved by changing configuration: it needs an independently
reviewed atomic fingerprint migration to avoid duplicate mailbox identities.
Database/backup custody and encryption/lookup keys must remain separate.

The caller must clear returned plaintext buffers after bounded use. Failure clears
intermediate unverified bytes; destroy clears copied encryption/lookup material and
prevents further use. This is best-effort JavaScript cleanup, not a memory-compromise
guarantee. Cipher validity is not current-record/replay/authorization authority;
current invitation, recipient, version, expiry and lease checks still belong to the
transactional repository and dispatch use case. No runtime loads these keys yet.
Five focused cases passed real encryption, all scope/tamper substitutions, lookup
separation, rotation/retirement, caller mutation, shape bounds and destruction.
The first local style check found overlong test lines; they were wrapped unchanged.

## Current custody candidate — schema057 / Demo023, not activated

The Customer-access migration is057 and its Demo-only overlay is023. It follows
Platform enrollment056/Demo022 and accepted publication055/Demo021. Runtime
readiness requires exact schema57. The migration/repository candidate has passed
native PostgreSQL integration and all four paired Chromium/WebKit × PostgreSQL/
objects permanent three-customer/two-reset-cycle jobs at commit553c39d9951658e662db755289ce32dcc583e3d9
(CI run39397607250). Quality, dependency policy, secret scanning and release-source
inventory also passed for that commit. This qualifies the named candidate's tested
scope; it does not apply migrations to INT or activate a login/sender. Review and
protected deployment acceptance remain separate gates. No ordinary entrypoint or
closed Demo runtime installs real Customer invitation, admission or dispatch.

It defines environment-specific encrypted mailbox custody, Tenant/mailbox/User
memberships, immutable recipient/role invitation intent with revisioned terminal
accept/revoke, exact actor/command receipts, mailbox/browser proof records, encrypted
stable delivery intent and shared opaque recipient/source abuse budgets. Addresses
and codes are not plaintext columns. Delivery ID/payload remain stable through
bounded retries within23 hours, before provider idempotency retention expires.

Mailbox challenges retain a bounded immutable server-loaded admission snapshot.
Code proof does not admit newly added/reissued invitations or revive stale Users:
selection must compare the captured membership, invitation revision and User
security version to live state. No pre-proof organization list is exposed. All
expiry, attempt, shared recipient/source budgets, current authority, lease and
replay checks still require the actual transaction implementation and negative/
concurrency coverage. Successful admission must append Tenant audit and issue the
existing session in the same transaction. Accepted memberships cannot change
existing roles or local disable state through invitation acceptance.

The migration's invitation audit constraint requires the exact Tenant/object/revision/
operation event, and accepted invitations require the matching populated membership.
Cross-mailbox delivery references are constrained together with their scope. The
custody guards preserve identity, purpose, immutable intent and monotonic counters/
versions; populated/evidence-bearing down migration refuses. Native tests cover
these constraints and Demo-only role-denial/reset integration. Real INT reset must
preserve this entire identity/custody domain and remains an activation requirement.

The invitation repository serializes Tenant/User/session authority before
lookup, replay or mutation, orders global mailbox locks by keyed fingerprint and
queues encrypted stable content inside the invitation/audit transaction. It never
calls the provider. Command digests use another HMAC domain, preventing offline
recipient guessing from an unkeyed command hash. Receipts contain only a closed
metadata schema, enforced in SQL; replay independently decrypts the
immutable recipient instead of storing plaintext addresses in receipts. Expired/
revoked/accepted changes and actor/role/audit failures must remain fail closed.
The native PostgreSQL test exercises these transactions, replay, concurrency,
revocation and audit rollback. Historically, the architecture gate rejected a persistence import of an application error;
the shared conflict value was moved to the domain boundary without a gate exception.

For enumeration resistance, the challenge draft permits a durable unadmitted flow
with no mailbox and an empty admission snapshot, alongside normal admitted flows.
Both need identical bounded pre-proof status/expiry/CSRF behavior and a common
browser-binding port; an unadmitted flow can never be verified or issue authority.
It stores only keyed recipient/source references, not an unknown plaintext address.
Actual request orchestration, shared rate/attempt ceilings, retention/resource
bounds and the common binding implementation remain required before activation.

The current057/023 integration preserves every prior rollback probe by first draining
the empty Customer layer. Demo grants explicitly deny all Customer/Platform CRUD
and permit only the isolated reset role to truncate the seven new tables. The
canonical three-customer seed is unchanged. Upgrade guards retain incompatible
older schema/overlay pair denials and reject future058/024. Historical rollback
assertions are preserved; empty newer layers are drained before older probes and
restored before readiness checks. Native and paired browser/reset qualification
passed at the exact commit above; real INT identity-preserving reset and deployed
TLS/provider/recipient acceptance remain independently required.


## Audit context review correction

The invitation service projects only Principal, verified Tenant context and
correlation into the production audit factory. Extra caller context cannot replace
its derived Tenant or actor. A mismatched Principal/context retains the original
authorization error and writes no Tenant audit against unverified ownership.
Permission/lifecycle and persistence denials within verified scope still require
minimized audit evidence; audit persistence failure remains fail-closed.
Regression cases use the actual AuditService through its existing test harness,
including hostile top-level actor/Tenant overrides, foreign context, and valid-scope
denial. This does not activate invitation HTTP or delivery composition.


## Historical local SQL preflight correction and limits

A scratch-only PGlite0.5.10 engine reports PostgreSQL18.6/WASM. Applying the actual
migration chain exposed PostgreSQL's regular-expression repetition-bound limit in
the envelope check. The draft now independently enforces character length2..43691
and the canonical alphabet, retaining the full maximum and oversize rejection.
No production dependency or lockfile was changed.

Memberships must start pending. Deferred acceptance additionally requires a matching
accepted invitation, newly provisioned active User, exact initial invited roles,
mailbox identity binding and same-correlation User-provisioned Tenant audit. Direct
populated insertion or unsupported pending-to-accepted writes are rejected.
Actual PostgreSQL integration cases cover these guards and envelope boundaries.

Ten local sequential SQL/service preflight checks passed: all56 canonical up
migrations, empty056 down, envelope bounds, encrypted atomic issue/list, replay,
changed intent/early resend, revoke/stale revision, audit integrity, populated-down
refusal and unsupported acceptance. This is partial SQL/transaction evidence only;
it does not qualify native server pools, concurrent operations, TLS, Demo role
privileges, full database integration or Chromium/WebKit/reset acceptance. Those
checks and real INT identity-preserving reset remain open.


## Historical integration checkpoints and superseded draft numbering

Accepted publication055/Demo021 remains unchanged. Integrated unreleased Platform
enrollment now occupies056/Demo022; invited Customer custody is057/Demo023. Earlier
056/022 Customer preflight checkpoints above describe only the former unmerged
candidate. Current exact readiness, reset inventory, media/recovery tools and
upgrade guards require057/023. Historical publication055, catalogue054, passkey053
and older rollback/role-denial probes remain; empty newer layers are drained before
each original probe and restored before current runtime/reset checks. Incompatible
056/023,055/022,054/021,053/020 and future058/024 guards remain explicit.

The integration unions both fixed Customer-invitation conflict and publication
error contracts. Audit context projection corrections and membership acceptance
evidence guards are retained. Seventy-six focused invitation/Demo/reset/media/
recovery checks passed. Full current-tree native database, paired browser/security
qualification and real INT identity-preserving reset remain open. No migration,
mail, provider login or Customer admission has been activated.

The integrated057/023 custody tree passed the final full local repository check,
including both HTTP security gates, and all76 focused invitation/Demo/reset/media/
recovery cases. Ten scratch-only sequential SQL/service checks passed against the
integrated57-migration chain, including encrypted issue/replay, wrong-scope/version
refusal, audit integrity, acceptance evidence guards and populated-down refusal.
These results do not substitute for native server concurrency/role/TLS or required
paired browser/reset CI. Earlier failed/pending candidate evidence remains above.

## Unreleased browser-bound mailbox challenge implementation

The uncomposed email challenge repository queues an encrypted ten-minute mailbox
code only for a server-loaded eligible membership/invitation snapshot. Unknown or
unadmitted recipients receive the same durable browser/CSRF pending shape, with no
mailbox, no delivery and an unusable random verifier. No fake Tenant/User is used.
Request replacement consumes old challenges and cancels queued old code deliveries.
Code verification checks the initiating browser and CSRF before charging a wrong
code attempt. Wrong proofs commit their challenge/shared counters; the fifth attempt
closes that challenge. A correct proof rotates to an independent five-minute choice
browser token and CSRF domain. Old code/browser proof cannot replay. This stage
creates no User, role, provider link or business session.

The closed immutable admission snapshot fences exact membership/Tenant, pending
invitation/revision or existing User/security version. Choice must compare it with
current locked eligibility before admission; this primitive grants no authority.
The HTTPS-only Strict/HttpOnly cookie is scoped to `/api/v1/auth/email`, with bounded
canonical challenge/browser values and duplicate rejection. These modules are not
connected to HTTP, so Origin checks, edge limits, enumeration timing behavior and
safe public error/cookie orchestration still require implementation and tests.

Shared SQL abuse counters lock source before recipient, before any challenge lock.
Issue limits are30/source/hour and3/recipient/hour with a60-second recipient gap;
wrong-proof ceilings are50/source/hour and10/recipient/hour across challenges and
new sources. Window reset preserves the send cooldown at the hour boundary.
Counters and timestamps are database-owned; failed work rolls back atomically.
Source keys use separate environment-bound HMAC over the server socket address,
canonicalizing IPv6/IPv4-mapped forms and rejecting forwarded lists/ports/zones.
No plaintext address is retained as abuse evidence. Trusted-proxy support is absent.

Twelve focused native primitive tests and fourteen scratch-only PostgreSQL18.6/WASM
sequential SQL/service preflight checks passed. Actual integration cases additionally
cover concurrent issue/verify, persisted failed attempts, cooldown/window boundaries,
rollback, unknown-flow parity, rotated proof and absence of User/session issuance.
Those native-server cases have not executed locally; the WASM preflight cannot
qualify concurrent pools, TLS, roles, full database or browser/reset acceptance.
An initial source-key negative case exposed IPv6 zone handling and was corrected;
initial style failures were wrapped without changing assertions.

Current Tenant choice/atomic provisioning/session issuance, live-eligible dispatch,
retention, sender configuration, explicit dual-proof Microsoft linking, HTTP/UI and
protected INT/reset composition remain required. No provider call or real mail has
been made and no runtime activates this candidate. This slice now follows integrated
057/023 custody; the earlier fourteen-case preflight used the former56-migration
chain and does not by itself qualify this new integrated source tree.

The integrated057/023 mailbox-challenge slice passed twelve focused primitive
cases and fifteen sequential PostgreSQL18.6/WASM SQL/service preflight checks.
The additional boundary case proves that hour-window reset cannot erase a recent
send cooldown. Accepted-User snapshot reads no longer join historical invitations;
only pending memberships resolve a current unaccepted/unrevoked invitation. Actual
native concurrent proof/issue tests and complete current-tree gates remain required.
No admission, HTTP, worker, provider configuration or real message is activated.

The first full challenge check rejected URL construction inside the identity
source-key module under the existing outbound-boundary gate. IPv6 normalization
now uses the data-only Node SocketAddress value class; no gate exception or network
operation was introduced. Existing alternate-spelling/mapped-address and malformed
input assertions are retained. Node22 API reference: https://nodejs.org/docs/latest-v22.x/api/net.html#class-netsocketaddress


## Unreleased current-membership choice and atomic admission

The next uncomposed slice resolves only choices from the verified mailbox's closed
captured snapshot. Names are returned after browser-bound proof; no Tenant/User,
provider reference, roles or recipient enters that public choice projection.
One bounded query rechecks current eligible memberships; selection accepts only an
opaque membership reference already captured by the server. The browser cannot
choose independent Tenant, actor or roles.

Admission locks Tenant, membership, User/invitation, then challenge; it never holds
a global challenge/mailbox lock while waiting for a Tenant business lock. It checks
database time after lock acquisition, exact snapshot/current User security version,
active User/Tenant, pending invitation/revision/expiry and browser/choice CSRF again.
Initial acceptance provisions a new User with only stored invited elevated roles,
creates its scoped mailbox identity binding, appends provision/accept audit, accepts
the membership/invitation and issues the existing ordinary session atomically.
Existing accepted Users receive current roles; invitation roles are never regranted
and local disable/security-version changes cannot be undone by a mailbox proof.
One consumed choice cannot admit a second Tenant or replay a business session.

The identity service creates fixed server audit events and delegates session
creation to the existing SessionService. Runtime composition must construct the
admission/session repositories with the exact same pool so the existing transaction
context includes session and audit writes. The existing deferred SQL acceptance
guards verify new User, binding, exact initial roles and matching audit at commit.
Session-result and deferred-commit failures roll back proof consumption, User,
roles, binding, invitations, audit and session together; cookies are returned only
after the enclosing transaction commits. Platform identity remains separate.

Fourteen focused native primitive/service tests and twenty-one scratch-only
PostgreSQL18.6/WASM sequential SQL/service preflight checks passed, including real
ordinary session resolution, changed-role login, stale User version/local disable,
post-proof revocation, rollback after real session issuance and deferred audit
constraint failure. Native integration cases add concurrent first acceptance,
new-Tenant snapshot exclusion, expired/max-attempt/browser-mismatch denial and
cross-Tenant/current-role fences. Those native pool/concurrency/role/TLS and full
paired browser tests remain independently required. No HTTP route, Microsoft
linking, dispatch worker, real recipient/mail, INT reset or identity mode activates
this source candidate; earlier challenge-only scope limits above are historical.

The architecture gate additionally forbids both closed Demo surfaces from reaching
real invitation/challenge/admission authority directly or through an intermediary.
A matrix regression retains direct and transitive boundary checks without changing
provider-neutral primitive reuse or introducing an exception for the new INT path.

## Unreleased HTTP transport slice

The next opt-in transport is specified in `CUSTOMER-EMAIL-HTTP.md`. Its five
browser-bound endpoints use the existing HTTP security/error framework and the
current locked admission use case. They are not installed in a runtime entrypoint.
The first five loopback HTTP cases passed; complete current-tree gates and actual
INT/provider/browser acceptance remain required. Earlier no-HTTP descriptions
above record preceding uncomposed checkpoints rather than deployed behavior.

## Bounded anonymous-proof retention candidate

Before schema057 is accepted or deployed, its custody guard now permits only two
specific disposable cases: an anonymous challenge with no mailbox, an empty
admission snapshot and no verification, more than one hour after proof expiry;
or an abuse-budget window older than24 hours with no send in the past24 hours.
Live cooldown/failure windows and every real mailbox, membership, invitation,
command, delivery, linked proof and audit record remain protected. No trigger is
disabled and no mutable session setting or privileged runtime role bypass exists.
This is not a general identity/history cleanup or INT reset implementation.

`pruneCustomerAnonymousEmailState` performs fixed twenty-row sweeps of each class
with environment predicates, dedicated indexes, SKIP LOCKED and a nonblocking
environment-specific transaction advisory lock. It returns aggregate counts only.
It accepts no caller-selected time, table, retention duration, SQL or batch size.
An overlapping sweep is a neutral no-op; errors and invalid counts roll back both
deletions. The authentication follow-up must invoke this port before new budget/
challenge allocation; a protected periodic caller can use the same bounded port
while traffic is idle. Both closed Demo graphs reject direct/transitive access.

Three local focused contract/architecture cases passed. Added native PostgreSQL
cases cover batch bounds, competing sweeps, fresh anonymous state, grace period,
real-mailbox proof preservation, foreign environment and active/recent abuse
budgets. Those native cases and current-head full/security/browser qualification
remain pending for this changed057 candidate. Earlier named commit qualification
above is historical evidence and does not qualify the new retention revision.

The mailbox challenge composition now invokes the bounded sweep through
`withCustomerEmailBudget` before allocating a new source/recipient window or flow.
Invalid input opens no connection; retention failure creates no new challenge or
budget and fails closed. Native budget concurrency coverage includes real expired
anonymous/stale-window cleanup while retaining the existing cooldown, failure,
window-boundary and rollback assertions. Periodic idle cleanup, edge limits and
retention for real linked custody remain separate activation requirements.
