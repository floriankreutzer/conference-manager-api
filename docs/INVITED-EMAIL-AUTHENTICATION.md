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
