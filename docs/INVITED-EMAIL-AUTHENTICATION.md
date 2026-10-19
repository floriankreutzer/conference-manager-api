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
by loading configuration or creating a proof. No provider SDK/dependency,
schema, stored role, existing login or session contract changes in this slice.
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

Ten focused native progression/negative cases passed. The first local style check
found overlong test lines, which were wrapped without changing assertions. These
are application/port tests, not real transaction, mail receipt, HTTP/CSRF, replay,
concurrency or activation evidence. No repository, schema, worker, Customer route
or entrypoint currently composes these ports. Durable implementation, Platform
creation, invited-only authentication/account linking and browser UI remain open.

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
