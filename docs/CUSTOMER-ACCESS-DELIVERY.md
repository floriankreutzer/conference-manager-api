# Customer access email dispatch — unreleased

This explicit worker and PostgreSQL port process the encrypted invitation/code
outbox. No entrypoint installs them, creates credentials or sends mail. Both Demo
dependency graphs reject these modules directly and transitively. Retention,
protected INT composition, sender/domain verification and actual authorized mail
receipt remain required before activation. This slice changes no migration,
dependency, Customer identity, membership, role or session contract.

One explicit `runOnce` considers at most 20 due rows in its configured environment
and sends at most one message. Concurrent invocations of the same instance return
`busy`; independent instances use delivery row locks and random lease IDs. Current
Tenant/member/User or invitation authority is checked before taking challenge and
delivery locks. Code dispatch requires a still eligible entry from the immutable
captured snapshot, current active User/security version and email binding, or the
exact pending invitation revision. New memberships cannot expand an old snapshot.
Consumed, verified, exhausted, revoked, suspended or stale proof is ineligible.

Claim commits a 45-second lease and increments the attempt count before exposing
decrypted message bytes to the provider port. The actual Resend adapter has a
maximum 30-second request deadline; composition must retain that relationship.
The final 45 seconds of delivery lifetime are not eligible for a new claim.
Expired/ineligible work is cancelled, or failed when its five attempts are spent.
Queued or expired-lease rows only may be claimed; active leases, terminal rows and
foreign environments cannot dispatch. Decryption uses the persisted independent
mailbox/record/purpose/Tenant scope, checks recipient custody, and clears plaintext
buffers after parsing. JavaScript message strings cannot guarantee memory erasure.

The worker forwards only the closed stable recipient/subject/text/delivery-ID
command. The existing provider adapter owns the fixed destination, sender,
credential, response bounds and redirect prohibition. No URL, provider options,
Tenant authority or credential can be supplied by an HTTP request. No outbound
work occurs while holding the claim transaction open.

Only classified rate-limit/unavailability failures schedule another attempt,
with bounded exponential jitter and at most 60-second provider guidance. At most
five claims occur. Each retry retains the exact encrypted payload and delivery UUID
inside the 23-hour durable window, below the provider idempotency retention window.
Unknown/permanent failures are terminal and raw provider errors are never persisted
or returned. No inline provider retry or automatic retry after settlement failure
occurs. A new explicit run must obtain a valid durable lease again.

Settlement is conditional on environment, delivery ID, claimed state and exact
lease ID. An old worker cannot overwrite a new lease or terminal observation.
Late acceptance may be recorded for the current lease even if authority has since
been revoked: it records an external fact and grants no access. Revocation after
claim cannot retract an already in-flight provider request. Accepted means provider
acceptance, never delivered/read; neither acceptance nor any delivery state issues
a session. Failure to persist a result remains visible; later recovery uses the
same stable provider idempotency key rather than fabricating success.

Six focused worker cases cover stable commands, neutral idle, concurrency,
classification, bounds, exhaustion, lost/failed settlement, malicious contract
fields/accessors and invalid receipts. Architecture cases protect both closed Demo
surfaces. Added native PostgreSQL cases exercise concurrent claims, wrong lease,
terminal replay, environment/Tenant eligibility and code delivery without login.
Native cases and complete current-head CI are required independently of these
focused local tests. Actual provider receipt, edge configuration, rate/quota
observations, real email-client accessibility and bounded retention remain open.
