# Protected real Customer access dispatch

This prepared worker is uncomposed and has sent no real message. Actual sender,
recipient, retention and operating acceptance remain open. It adds no credential,
dependency, schema, timer, service or deployment. See `CUSTOMER-ACCESS-DELIVERY.md`
for the unchanged ordinary encrypted-outbox, provider and honest late-result rules.

The owned factory constructs both the real-mode qualification port and the
ordinary bounded repository/worker. Its environment and UUID epoch are fixed by
server composition. Callers cannot replace its repository, classification mode or
eligibility port. The configured provider still owns the fixed transactional email
destination, sender, credential and bounded transport; the worker forwards only the
existing closed stable message command.

A protected shared deployment lease spans candidate selection, eligibility,
decryption, the bounded provider call and settlement. It runs on the separate
bounded lease pool, leaving a max1 business pool available for ordinary repository
transactions. A concurrent local run returns busy before allocating another lease.
Reset/epoch cutover cannot occur during provider work; no ordinary retry is added.

Invitation dispatch first requires the exact current environment/epoch, immutable
REAL registry and eligible Tenant lifecycle, under the live enclosing scope and
same business transaction. Ordinary pending-member/invitation/revision checks then
remain mandatory. A captured mailbox-code snapshot is checked entry by entry: only
a currently qualified captured REAL membership can make it eligible. Newly added
memberships never expand an older snapshot. Unknown, unclassified, synthetic,
foreign, stale or unavailable custody cannot fall back to ordinary delivery.

Ineligible outbox work follows the existing cancelled/failed contract without
decryption or a provider request. This component does not implement the remaining
real-only anonymous challenge capture/admission or root invitation/configuration
mode guards. Those are required before full protected activation.

The claim transaction still commits its bounded lease before outbound work. A
membership/lifecycle change after claim cannot retract a request already in flight;
late acceptance remains an external fact and never issues access. The deployment
lease is a reset barrier, not a promise that every mutable eligibility row stays
locked through network latency. No new such promise or fake delivery success is made.

Focused tests cover strict qualification before invitation eligibility/decryption,
captured code membership filtering, exact shared/transaction scope, unavailable
custody, provider-call lease lifetime and immediate local busy behavior. A new
native test requires exact-source PostgreSQL acceptance with encrypted actual
outbox, unclassified/synthetic/real candidates, max1 pools, reset/epoch contention
during a paused injected provider, terminal observations, stale epoch denial and
preserved Customer session/audit state. It performs no real outbound request and
does not replace protected-root, physical-key or real email-client acceptance.
