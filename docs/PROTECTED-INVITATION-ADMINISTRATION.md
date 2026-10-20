# Protected REAL invitation administration

This prepared extension is inactive. It installs no HTTP route or deployment and
sends no message. Full protected-root, browser, sender/recipient and operating
acceptance remain open under SaaS1 issue351. Canonical invitation behavior remains
in CUSTOMER-INVITATION-HTTP.md and PLATFORM-CUSTOMER-ONBOARDING.md.

The owned invited-Customer access composition now constructs its Tenant Admin
invitation service with canonical authorization, encrypted custody, content, audit
and repository components. Every list, batch, resend and revoke entry acquires the
current separate shared deployment lease. Its fixed REAL predicate runs in the
same business transaction before actor locks, recipient decryption or custody.
Because the canonical actor check already needs a Tenant write lock, qualification
takes that lock directly without a shared-to-exclusive upgrade. Actual current
User, session, Tenant role/permission, revision, receipt and object checks remain
mandatory. REAL qualification grants none of those authorities.

The owned Platform invitation repository fixes the same predicate for its
configured environment/UUID epoch. Callers cannot replace it through configuration.
Canonical Platform authorization precedes qualification; mutation retains the
existing receipt-lock order and qualifies immediately before the Tenant write
lock. Sensitive reads qualify before the Tenant read lock and recipient projection.
Exact operation proof (including the existing sensitive-list policy), target
permission, configured environment, idempotent replay,
canonical shared custody and both audit domains remain authoritative. The caller
must already hold the exact enclosing shared deployment lease; this repository
cannot acquire authorization or silently use an ordinary unprotected path.

Unclassified and synthetic targets cannot be listed, decrypted, invited, resent,
revoked or replayed through these protected paths, including old ordinary receipts.
Foreign Tenant/object IDs retain concealed canonical denial. The ordinary generic
repositories keep their default null qualification port for compatibility; closed
Demo composition still cannot import the prepared authority. No retained identity,
invitation, outbox, audit or receipt is reclassified or erased.

All existing invitation limits and message facts are preserved: at most twenty
people per batch, bounded list pages, role allowlists, encrypted recipient/payload
custody, one-minute resend cooldown, revision/expiry checks, and honest queued or
externally accepted delivery state. An immediate resend remains a conflict.
Changing or revoking an invitation does not retract an already accepted provider
request, and no operation here directly sends mail. Standard minimized denial
audits remain possible; denial creates no invitation, User, mailbox grant or session.

Focused tests cover strict qualification before every Customer custody path,
unchanged current-actor checks, current deployment before invitation service work,
and ordinary invitation regression. Native exact-source CI must additionally
exercise protected Customer batch/replay/list/cooldown/revoke and denied modes,
and actual signed Platform proof with max1 pools, REAL batch/replay/revoke,
unchanged cooldown, both audit domains, non-REAL read/write denial and no Customer
User/session creation. Existing canonical native historical resend coverage stays
mandatory; no test sleeps, timestamp editing, proof-row deletion, quota increases
or ordinary retry is introduced. Software fixtures are not physical-key, live mail
or complete protected-runtime acceptance.
