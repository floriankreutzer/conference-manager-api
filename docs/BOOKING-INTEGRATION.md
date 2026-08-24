# Provider-Neutral Booking and Calendar Integration

## Authority and scope

Root `AGENTS.md` is authoritative. This document defines the SaaS 0 provider-neutral booking/calendar boundary introduced by issue #54.

The existing Employee and Conference Manager Request lifecycle remains the owner of business workflow semantics. This boundary does not redefine when a Request is Submitted, Confirmed, Rejected, Change Requested or Cancelled. It translates already-authorized server use cases into provider-neutral availability and calendar operations.

No public browser endpoint is introduced by #54. Runtime wiring into Request submission/confirmation/cancellation belongs to the later production API migration and must reuse the existing authorization/workflow contracts rather than create a parallel flow.

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

Inputs contain only bounded internal booking data: internal Tenant/Request/Room identifiers, UTC start/end instants, provisional/final reservation phase, server correlation ID and, for create, a server-derived idempotency key.

Provider-specific room/resource identifiers are resolved inside the provider/integration adapter. They do not become business-domain identifiers.

Provider responses are validated before use. Malformed responses fail closed as `CALENDAR_PROVIDER_RESPONSE_INVALID`.

## Reservation phases

The contract supports two phases:

- `provisional`: tentative reservation semantics;
- `final`: confirmed/final reservation semantics.

Both phases first enforce the local Tenant-scoped overlap rule. When there is a local conflict, provider lookup is not invoked. When no local conflict exists, the configured provider performs its own availability/reservation validation.

This is a validation boundary, not yet a new Request-create endpoint. Atomic persistence of the eventual production Request creation/confirmation flow must be composed with the owning Request use case when #56 moves the frontend from demo storage to API authority.

## Authorization and entitlements

The booking integration service is deny-by-default.

Every operation requires:

1. valid Principal/Tenant/Request binding for the same active internal Tenant;
2. an explicit server-side `authorizeOperation` decision from the owning use case;
3. the configured server-side Tenant entitlement through `entitlementService.requireAccess`.

The browser cannot set the authorization result, capability ID, Tenant ID, integration ID, provider reference or rollout state.

For the Microsoft-first pilot, composition will use the existing `microsoft.calendar` capability. Future providers require their own reviewed capability/adapter configuration without changing Employee/Manager workflow rules.

## Provider reference persistence

Migration 006 adds `booking_provider_references`.

Each row contains:

- internal non-null Tenant ID;
- internal Request ID;
- internal Integration ID;
- opaque provider reference;
- deterministic create idempotency key;
- state (`active` or `cancelled`);
- create correlation ID;
- created/updated timestamps.

Composite Tenant foreign keys bind the reference to a Request and Integration from the same Tenant. The same opaque provider value may exist in another Tenant without sharing ownership.

Provider references are infrastructure data. They are not returned as business authorization data and are not copied into Tenant audit metadata.

## Idempotency and recovery

Calendar create uses a deterministic SHA-256 idempotency key derived server-side from:

```text
calendar-create:v1 + internal Tenant ID + internal Request ID + internal Integration ID
```

The browser cannot supply or override this key.

The provider adapter contract requires create to honor this key: retrying the same logical create must return the already-created provider event reference instead of creating another event.

The PostgreSQL repository also serializes local reference persistence per Tenant/Request/Integration and treats an identical stored idempotency/reference pair as an idempotent repeat.

This specifically handles the important partial-failure case:

1. external provider successfully creates the event;
2. local reference/audit transaction fails;
3. caller receives failure rather than false success;
4. a later retry uses the same deterministic idempotency key;
5. provider returns the existing event;
6. local reference/audit persistence can complete without creating a duplicate event.

A conflicting provider reference for the same logical create fails closed rather than silently replacing the mapping.

## Update and cancellation

Update and cancel require an existing active provider-reference row.

The provider receives only the opaque stored reference and the desired server booking data. A provider is not allowed to replace the reference during update/cancel; a mismatched returned reference is treated as a malformed provider response.

Cancellation persists local state `cancelled` together with its success audit event. Repeating cancellation after local state is already cancelled is a deterministic no-op and does not call the provider again.

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

Creation persists the provider-reference row and success audit evidence in one PostgreSQL transaction after the external provider operation. Update/cancel similarly persist the local reference mutation and success audit evidence atomically.

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

Microsoft Graph URLs, SDK types, OAuth scopes and provider claim structures belong only in the future Microsoft adapter.

## Migration and rollback

Migration 006 advances runtime schema readiness to version 6.

The down migration fails closed when any provider-reference row exists. Production rollback with populated mappings therefore requires a reviewed reconciliation/migration decision; it must not silently discard the only local link to an external calendar event.

## Testing requirements

#54 requires:

- provider-contract unit tests;
- malformed provider response tests;
- timeout/retryability classification tests;
- authorization and Tenant-binding negative tests;
- entitlement-gate coverage;
- deterministic create/retry/idempotency tests;
- local-persistence-failure recovery demonstrating one external create;
- provisional/final phase tests;
- baseline overlap-rule tests;
- PostgreSQL cross-Tenant FK/isolation tests;
- audit-atomic provider-reference persistence tests;
- migration 006 rollback/reapply tests;
- full existing regression/security gates.
