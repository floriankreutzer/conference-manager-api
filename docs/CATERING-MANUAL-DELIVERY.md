# Manual Catering delivery facts

This source increment records external manual facts. It sends no email, performs no
supplier call and offers no automatic fallback for an uncertain API write. The existing
`catering.delivery` gate remains off by default and is unavailable in the shared Demo.

## Manager contract

`GET /api/v1/tenant/catering/orders/{orderId}/manual-delivery` returns the exact current
order version by default. Optional `orderVersion` selects retained immutable history;
`afterSequence` selects consecutive pages of at most twenty facts. The response exposes
only the minimized business facts, current version state and derived effective version.
The effective version is the highest version with a complete immutable confirmation,
from either validated API observations or manual receipts. Proposed, pending, partial,
rejected or substitution-proposed positions do not replace the previous effective version.

`POST` on the same path accepts exactly `schemaVersion: 1`, UUID `commandId`,
`expectedOrderVersion`, `expectedStateRevision`, `kind`, `channel`, `reference`,
`occurredAt`, and `receipt`. `kind` is `transmitted` or `receipt`; transmission has a
null receipt. A receipt contains exactly `orderId`, `orderVersion`, and all sealed
`positions`, each with exactly `positionId` and `outcome`. Outcomes are `pending`,
`confirmed`, `rejected`, or `substitution_proposed`. A substitution proposal never
accepts a replacement item or new cost. Full version/change/cancel commands remain
separate work; this read policy does not implement them.

Channels are `email`, `telephone`, `portal`, `in_person`, or `other`. A reference is a
trimmed ASCII business identifier of 1–200 characters, starting with a letter or digit
and otherwise allowing letters, digits, spaces, period, underscore, slash, hash and
hyphen. It is not a URL, message body, address or credential field. `occurredAt` is an
exact millisecond UTC instant. Transmission must occur after the approved decision and
queued job and before quote expiry. Later recording remains possible after quote expiry
when the actual transmission occurred within that valid interval. Receipt occurrence is
at least the previous fact occurrence and no later than the database recording clock.

The original sealed operation must explicitly use manual mode and have a queued or
deferred job with zero automatic attempts, bound to the same quote/decision. There is
no manual resend of an API attempt with unknown outcome. Transmission, complete receipt,
state revision, consecutive fact head and minimized Tenant audit append commit atomically.
Repeated identical command IDs from the same actor/security epoch replay without another
audit append. Changed commands and stale revisions conflict; writes are never retried.
Confirmed/cancelled versions cannot be downgraded by a later receipt.

## Authority and custody

The HTTP layer uses the canonical session, active Tenant and Origin/CSRF checks.
Employee, technical Tenant Admin and Platform roles gain no Manager write authority.
The repository locks Tenant, User/security epoch, Session and exact order state before
writes; revoked/expired sessions cannot append facts. Actor identity, security version,
correlation and database recording time come from trusted server context. The public DTO
omits Tenant, command/actor/session/security details; audit stores only fixed operation,
version and state summaries, excluding references, channels and receipt contents.

Canonical migration050 introduces two append-only/consecutive custody tables; Demo016
adds narrowly scoped Customer append/head rights and Reset truncate rights. Platform has
no access. Existing rows receive no inferred facts. Empty rollback is supported; any fact,
head or manual audit evidence blocks rollback. Reset includes both tables explicitly and
retains its existing transaction, deterministic fixtures and checksum guards.
