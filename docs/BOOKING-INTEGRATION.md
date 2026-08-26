# Provider-Neutral Booking and Calendar Integration

## Authority and scope

Root `AGENTS.md` is authoritative. This document defines the provider-neutral booking/calendar boundary introduced by issue #54 and its current production-API composition.

The existing Employee and Conference Manager Request lifecycle remains the owner of business workflow semantics. This boundary does not redefine when a Request is Submitted, Confirmed, Rejected, Change Requested or Cancelled. It translates already-authorized server use cases into provider-neutral availability and calendar operations.

The browser has no direct provider-write endpoint. Availability, final confirmation and cancellation are composed through the server-authoritative application and Request use cases, which reuse the existing authorization/workflow contracts instead of creating a parallel calendar flow.

## Baseline semantics preserved

The current frontend baseline uses these calendar meanings:

- Submitted / resubmitted Request: provisional (`Tentative`);
- confirmed Request: final/busy (`Busy`);
- rejected or cancelled Request: released (`Released`).

Room conflicts treat every overlapping Request as blocking except `Rejected` and `Cancelled`. The PostgreSQL booking repository uses the same overlap rule:

```text
same internal Tenant
AND same internal Room
AND starts_at < candidate.end
AND ends_at > candidate.start
AND status NOT IN (Rejected, Cancelled)
```

Provider adapters must not invent different Employee/Manager workflow states.

## Dependency direction

```text
authorized Request use case
  -> booking integration service
     -> entitlement service
     -> provider-neutral calendar port
     -> booking-reference repository port
        -> provider adapter / PostgreSQL adapter
```

Application/domain code does not import Microsoft Graph SDK types, provider claims, provider URLs or provider response objects.

## Provider-neutral calendar port

A provider adapter must implement:

- `lookupAvailability`;
- `validateReservation`;
- `createCalendarEvent`;
- `updateCalendarEvent`;
- `cancelCalendarEvent`.

Inputs contain only bounded internal booking data: internal Tenant/Request/Room identifiers, UTC start/end instants, provisional/final reservation phase, server correlation ID and, for create, a server-derived idempotency key plus the server-persisted provider resource binding.

Provider-specific room/resource identifiers are resolved inside the provider/integration adapter. They do not become business-domain identifiers.

Provider responses are validated before use. Malformed responses fail closed as `CALENDAR_PROVIDER_RESPONSE_INVALID`.

## Reservation phases

The contract supports two phases:

- `provisional`: tentative reservation semantics;
- `final`: confirmed/final reservation semantics.

Both phases first enforce the local Tenant-scoped overlap rule. When there is a local conflict, provider lookup is not invoked. When no local conflict exists, the configured provider performs its own availability/reservation validation.

The provider-neutral boundary is composed into the production application API in two places: `POST /api/v1/application/room-availability` performs an advisory pre-create check, and the normal Request confirmation use case repeats authoritative local/provider validation before its audit-atomic state transition. `POST /api/v1/application/requests` owns Tenant-scoped Request creation; the browser never invokes a provider or supplies an availability decision.

## Authorization and entitlements

The booking integration service is deny-by-default.

Every operation requires:

1. valid Principal/Tenant/Request binding for the same active internal Tenant;
2. an explicit server-side `authorizeOperation` decision from the owning use case;
3. the configured server-side Tenant entitlement through `entitlementService.requireAccess`.

The browser cannot set the authorization result, capability ID, Tenant ID, integration ID, provider reference or rollout state.

The Microsoft-first Pilot composition uses `microsoft.calendar` for availability and `microsoft.calendar.write` for optional event mutations. Future providers require their own reviewed capability/adapter configuration without changing Employee/Manager workflow rules.

## Provider reference persistence

Migration 006 adds `booking_provider_references`; migration 017 extends it with a create-time provider resource binding and reconciliation states.

Each row contains:

- internal non-null Tenant ID;
- internal Request ID;
- internal Integration ID;
- nullable opaque provider event reference, which is null only while create reconciliation is `pending`;
- positive create-attempt number;
- non-null provider connection identity reference bound before the first external create;
- non-null provider resource reference bound before the first external create;
- deterministic per-attempt create idempotency key;
- state (`pending`, `active`, `compensating`, `compensated` or `cancelled`);
- create correlation ID;
- created/updated timestamps.

Composite Tenant foreign keys bind the reference to a Request and Integration from the same Tenant. The same opaque provider value may exist in another Tenant without sharing ownership.

Provider references are infrastructure data. They are not returned as business authorization data and are not copied into Tenant audit metadata.

The Microsoft 365 lifecycle's optimistic `connection_version` is deliberately not booking authority and is not stored in this row. Routine verification may advance that version without changing the external Tenant. Booking commits instead compare the exact Integration/provider-Tenant reference, lifecycle status where required, and active identity binding.

## Idempotency and recovery

Calendar create uses a deterministic SHA-256 idempotency key derived server-side from:

```text
calendar-create:v1 + internal Tenant ID + internal Request ID + internal Integration ID + attempt number
```

The browser cannot supply or override this key.

The provider adapter contract requires create to honor this key: retrying the same attempt must return the already-created provider event reference instead of creating another event.

Before the first external write, the PostgreSQL repository serializes and audit-atomically persists attempt 1 as a `pending` row containing the deterministic key, exact provider connection identity and provider resource reference. Reserve and create finalization lock and revalidate that the Integration still has that exact provider reference, is `connected`, and has an exact active identity binding. It never stores a placeholder provider event reference. The persisted create-time resource remains authoritative even if the current room mapping is refreshed or removed before reconciliation. A retry of the same `pending` attempt therefore addresses the same mailbox/idempotency scope as the original attempt.

This specifically handles the important partial-failure case:

1. local persistence binds the create-time resource and key as `pending` before provider access;
2. the external provider successfully creates the event;
3. final event-reference/audit persistence fails;
4. caller receives failure rather than false success;
5. a later retry uses the persisted resource and deterministic key, even after remapping;
6. provider returns the existing event;
7. local finalization stores the real event reference and moves the row to `active` without creating a duplicate event.

A conflicting provider reference for the same logical create fails closed rather than silently replacing the mapping.

If create succeeds externally but the connection/binding authority is no longer current at finalization, the same transaction retains the returned event reference and moves `pending` to `compensating`. The service deletes that event through the trusted persisted provider/resource binding, completes `compensated`, and returns `BOOKING_CREATE_AUTHORITY_LOST`; it does not confirm the Request under stale authority.

`compensated` proves the prior external event was removed, but it is not terminal cleanup. A later authorized confirmation retry increments `attempt_number`, derives a new key/Graph `transactionId`, binds the currently mapped resource, and returns to `pending`. Rotating the key prevents Microsoft Graph from resolving the deleted event from the prior attempt instead of creating the newly required event.

## Update and cancellation

Update requires an existing `active` provider-reference row. It always uses the resource address persisted at create time, not a later room mapping.

The provider receives only the opaque stored reference and the desired server booking data. A provider is not allowed to replace the reference during update/cancel; a mismatched returned reference is treated as a malformed provider response.

Cancellation of an `active` reference persists local state `cancelled` together with its success audit event. Repeating cancellation after local state is already cancelled is a deterministic no-op and does not call the provider again.

If cancellation encounters a `pending` create with unknown provider outcome, it first repeats create idempotently with the persisted resource/key, stores the real returned event reference as `active`, and then cancels it. If no provider event existed this can create at most one event that is immediately deleted; if the prior attempt succeeded it resolves and deletes that same event. Provider or persistence failure remains an explicit reconciliation failure and can be retried without changing mailbox scope.

Cancellation resolves its provider from the persisted Integration, provider-Tenant reference and create-time resource rather than the current room mapping. Local `disconnected`/`degraded` status, cleared permission indicators or a removed room mapping therefore do not by themselves make a known event unreachable. Cleanup still requires the same current Integration/provider-Tenant identity and exact active Entra binding; a different or absent binding fails closed before provider access. Identity unbind is correspondingly blocked while any reference is not terminal `cancelled`.

Parallel final confirmations share the deterministic provider event. After every explicit local conflict, the losing call uses the Request returned by the locked transaction; a confirmed winner is returned idempotently and its event is never compensated. A thrown local commit outcome is not assumed to have rolled back: the service reloads the authoritative Request, returns a confirmed result if visible, and otherwise retains the event while returning an explicit reconciliation error. This avoids both cross-Tenant head-of-line locking and deletion while another commit may still be in flight.

Compensation first moves `active` to `compensating` audit-atomically, then deletes externally, then moves `compensating` to `compensated` with the completion audit. Create is forbidden while `compensating`; cancellation/compensation completion is idempotent so an unknown local finalize response can converge after a repeated provider delete. A later authorized confirmation retry may start a new attempt only from a fully `compensated` row. Provider rebinding is blocked while any reference is not terminal `cancelled`, preventing an old event from becoming unreachable under a new Tenant token.

Final Request confirmation carries the server-derived provider-authority descriptor into the same PostgreSQL transaction as the Request update. Under row locks it requires the exact Integration provider/reference, `connected` status and exact active identity binding before changing the Request to `Confirmed`. Authority loss after free/busy or event create yields `provider_authority_conflict`; a created event is compensated and stale provider authority cannot commit the business transition.

## Provider failure taxonomy

Provider failures are normalized into stable categories:

- `timeout` — retryable;
- `throttled` — retryable, optionally with bounded retry-after metadata;
- `unavailable` — retryable;
- `authorization` — not retryable without configuration/credential remediation;
- `validation` — not retryable without corrected server/provider data;
- `conflict` — not blindly retryable;
- `duplicate` — not blindly retryable unless the adapter can return the canonical existing reference;
- `not_found` — not blindly retryable;
- `malformed_response` — fail closed, not retryable;
- `unknown` — fail closed, not retryable.

#54 does not add an automatic retry loop. This is deliberate: `AGENTS.md` prohibits blind retries of non-idempotent writes. Callers may retry only from the explicit classification and the operation's idempotency semantics. Create is safe to retry only because the provider contract requires the deterministic idempotency key to be honored.

Raw provider Error messages, payloads and credentials are not propagated through the stable error contract.

## Audit behavior

Calendar write operations use the existing `calendar.operation` action.

Success events record only bounded business metadata such as operation, provisional/final phase and disposition. Provider references and credentials are excluded.

Creation first persists the `pending` connection/resource binding, attempt number and `resource_bound` success evidence in one PostgreSQL transaction. After external create, a second audit-atomic transaction revalidates exact current provider authority, stores the real event reference and moves the row to `active` or, on authority loss, to `compensating`. Update and cancel persist their local reference mutation and success evidence atomically; compensation uses separate audit-atomic `active` to `compensating` and `compensating` to `compensated` transitions around the external delete. A compensated retry audit-atomically increments the attempt and binds its new key/current resource before another create.

External systems cannot participate in the local PostgreSQL transaction. Therefore an external success followed by local transaction failure is handled through idempotent reconciliation rather than by claiming distributed atomicity.

Provider operation failures with valid Tenant/actor context record a failure audit event containing only the stable provider error code and retryable boolean.

## SSRF and outbound security

The provider-neutral application contract contains no outbound URL. User/browser input cannot select a destination.

Future provider adapters must:

- use fixed or server-allowlisted provider origins;
- validate redirects or disable them;
- enforce explicit connect/read/overall timeouts;
- validate response shapes before returning provider-neutral results;
- keep provider credentials/tokens server-side;
- redact raw provider payloads and secrets from logs/audit;
- implement bounded provider-specific retry behavior only where the normalized operation contract permits it.

Microsoft Graph URLs, OAuth scopes and provider response structures are confined to the implemented Microsoft adapter and never enter the provider-neutral application contract.

## Migration and rollback

Migration 017 refuses automatic application when legacy provider-reference rows exist because their create-time connection/resource bindings cannot be inferred safely. It adds `attempt_number`, both non-null bindings, the `pending`/`compensating`/`compensated` states and the state/event-reference invariant. Runtime schema readiness includes this migration.

The migration 006 and 017 down migrations fail closed when any provider-reference row exists. Production rollback with populated mappings therefore requires a reviewed reconciliation/migration decision; it must not silently discard the only local link to an external calendar event or its create-time mailbox binding.

## Testing requirements

#54 requires:

- provider-contract unit tests;
- malformed provider response tests;
- timeout/retryability classification tests;
- authorization and Tenant-binding negative tests;
- entitlement-gate coverage;
- deterministic create/retry/idempotency tests;
- per-attempt key rotation after completed compensation;
- pre-write pending resource-binding and remap-after-failure tests;
- local-persistence-failure recovery demonstrating one external create;
- create/final-confirm authority-loss compensation tests;
- pending-cancellation create reconciliation followed by deterministic delete;
- disconnected/remapped cleanup through the persisted binding;
- compensated-state confirmation with a new attempt/key;
- provisional/final phase tests;
- baseline overlap-rule tests;
- PostgreSQL cross-Tenant FK/isolation tests;
- audit-atomic provider-reference persistence tests;
- migration 006 rollback/reapply tests;
- full existing regression/security gates.
