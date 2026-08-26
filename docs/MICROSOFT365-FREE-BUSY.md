# Microsoft 365 Free/Busy Provider

## Authority

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/AUTHORIZATION.md`, `docs/MICROSOFT365-CONNECTION.md`, `docs/MICROSOFT365-ROOM-MAPPING.md`, and the provider-neutral calendar contract remain authoritative.

This capability implements Microsoft 365 room availability behind the existing provider-neutral calendar boundary. It does not make Microsoft Graph or the browser authoritative for Tenant ownership, Request workflow state, local room ownership, or final booking confirmation.

## Microsoft Graph contract

The implementation uses Microsoft Graph v1.0 `getSchedule` with application authentication through the existing Tenant-bound confidential-client Microsoft 365 connection.

The repository retains `Calendars.ReadBasic.All` as the reviewed application permission. Microsoft documentation currently has inconsistent wording between the `getSchedule` method page and the permissions reference; the permissions reference identifies `Calendars.ReadBasic.All` as the application permission while `Calendars.ReadBasic` is delegated. No permission name is changed based on the inconsistent method-page wording.

Outbound behavior is intentionally narrower than the Microsoft maximums:

- fixed Microsoft Graph origin only;
- `POST /v1.0/users/{resource}/calendar/getSchedule` constructed server-side;
- at most 20 schedules per provider request;
- UTC input only;
- seven-day maximum query window, below the Graph maximum window;
- five-minute availability view interval;
- redirects disabled;
- existing configured request timeout and bounded request/response sizes;
- no provider continuation URL, callback URL, or arbitrary browser-selected destination.

## Data minimization

The provider requests and consumes only free/busy information needed for Conference Manager availability semantics. `scheduleItems`, event subjects, organizers, descriptions, locations, attendee data, and raw provider payloads are not returned through the provider-neutral contract.

The normalized result contains only:

```text
schedule
available
conflictCount
```

Graph availability-view state `0` is free. Any state `1` through `4` is treated conservatively as busy. Unknown, malformed, missing, oversized, permission-denied, throttled, timed-out, or otherwise unavailable provider results never become `available=true`.

## Tenant and room binding

`createMicrosoft365CalendarProviderFactory` resolves the provider from server-side repositories only:

1. internal Tenant ID supplied by the trusted application boundary;
2. the Tenant-owned Microsoft 365 connection;
3. positively verified Calendar permission state;
4. the connection's server-stored provider Tenant reference;
5. the Tenant/integration-owned active room mapping;
6. the mapped resource address.

The caller cannot substitute another Tenant, integration, provider Tenant, Graph URL, token, or resource address. A missing/degraded/revoked connection or missing room mapping fails closed.

The bound provider additionally verifies that every operation still carries the expected internal Tenant and room IDs before Graph is called. This is defense in depth around the provider-neutral booking service and does not replace upstream server authorization.

## Time semantics

Conference Manager passes UTC ISO-8601 timestamps to the provider. The provider rejects offset/local timestamps and invalid or reversed windows rather than guessing a time zone. The Graph request explicitly uses `UTC` for both start/end values and the response preference.

This avoids DST ambiguity at the provider boundary. UI-local time-zone conversion remains a presentation/input concern and must reach the authoritative backend as normalized UTC.

## Failure taxonomy

Microsoft errors are translated into the existing provider-neutral calendar taxonomy:

- Graph 401 / invalid token -> authorization failure;
- Graph 403 -> authorization/permission failure;
- Graph 429 -> throttled, retryable;
- Graph 5xx / transport timeout -> unavailable, retryable according to the provider-neutral classification;
- malformed Graph response -> malformed response, not retryable;
- missing mapping -> not found;
- cross-Tenant/cross-room bound-provider use -> authorization failure.

Provider response bodies and Microsoft error text are not propagated to business callers or logs by this adapter.

## Caching and final validation

This implementation introduces no availability cache. Every provider call is live. Advisory room-search availability therefore cannot accidentally be served from an undocumented stale cache.

Final confirmation authority remains a separate concern owned by the subsequent transactional final-availability capability. Browser/advisory availability must never be treated as sufficient evidence for an authoritative confirmation.

## Production Employee room search

`POST /api/v1/application/room-availability` connects the production Employee flow to this provider. The exact request contains only an internal room ID and a canonical UTC start/end interval of at most 24 hours. The route is same-origin, session-bound, active-Tenant-bound, CSRF-protected and rejects unknown or authority-shaped fields.

The application service first requires Employee Request-create authorization and the internal `microsoft.calendar` entitlement. It then checks Tenant-scoped local Request overlap and, when locally free, resolves the Tenant-owned Microsoft connection and active room mapping server-side before performing live Free/Busy. Its versioned response exposes only `available` and `conflictCount`; subjects, schedule items, mailbox addresses, provider identifiers and raw errors never cross the API boundary.

The production browser invalidates a successful check whenever room or time input changes and permits Request creation only for the exact currently verified tuple. Missing provider configuration, authorization, entitlement, throttling, timeout or malformed output returns `ROOM_AVAILABILITY_UNAVAILABLE`, never `available=true`. The explicit demo workflow keeps its simulated occupancy path and never calls this endpoint.

## Verification

Automated progression and negative coverage includes fixed-origin POST behavior, UTC/DST-boundary timestamps, all free/busy states, 20-resource bounds, duplicate/invalid schedule input, oversized time windows, permission/revocation/throttling/unavailable cases, malformed provider payloads, Tenant/room binding, local-overlap short circuit, Employee API CSRF/authority rejection, provider error translation and minimized versioned output.

Real Microsoft 365 behavior against a Pilot customer Tenant remains external acceptance evidence and must not be represented as verified by repository tests alone.
