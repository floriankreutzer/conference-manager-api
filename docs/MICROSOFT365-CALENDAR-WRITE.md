# Microsoft 365 Calendar Write Synchronization

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/BOOKING-INTEGRATION.md` and `docs/ENTITLEMENTS.md` are authoritative. This document records the Microsoft-specific calendar write adapter and synchronization semantics introduced for SaaS 1 issue #68.

The existing Request workflow remains the business authority. Microsoft Graph is an external calendar provider; it does not determine Conference Manager roles, Tenant ownership, workflow state or entitlement.

## Permission model

Productive Graph event create/update/delete requires the Microsoft Graph application permission represented by `Calendars.ReadWrite` for the central confidential-client SaaS application. For a hardened customer Tenant, the approved source is the resource-scoped Exchange role `Application Calendars.ReadWrite`, not an unscoped Entra `Calendars.ReadWrite` grant.

Microsoft provider permissions are acquired through the `/.default` client-credentials scope. They are not dynamically added by an internal Tenant entitlement. Conference Manager therefore enforces a second independent server-side gate:

- `microsoft.calendar` controls read/free-busy use;
- `microsoft.calendar.write` controls productive create/update/cancel use.

Having read/free-busy entitlement never grants write access. Having provider consent never grants internal product entitlement. The owning use case must also pass the central RBAC/object authorization policy.

The complete configuration, positive/negative verification, additive-permission warning, evidence, and rollback procedure is defined in `docs/EXCHANGE-APPLICATION-RBAC.md`. Productive Calendar Write must remain disabled until that procedure and live Microsoft acceptance pass. In particular, leaving an unscoped Entra `Calendars.ReadWrite` grant in place defeats the intended Exchange write scope.

## Trust boundary

The browser cannot provide or override:

- internal Tenant ID;
- provider Tenant ID;
- integration ID;
- room resource address;
- Graph destination;
- access token;
- provider event reference;
- create idempotency key;
- entitlement;
- resulting Request status.

For new availability/write work, the provider adapter resolves the active Microsoft 365 connection, exact active Entra binding and active room mapping from Tenant-scoped server repositories. Cancellation/reconciliation instead resolves the exact persisted Integration, provider-Tenant and create-time resource so cleanup does not depend on a later mapping or healthy local lifecycle status. All Graph calls reuse the fixed `https://graph.microsoft.com` origin and the existing confidential-client token path.

## Graph transport

Calendar writes reuse the hardened Microsoft transport boundary:

- fixed Microsoft Graph origin;
- redirects disabled;
- explicit bounded timeout/cancellation;
- bounded request and response sizes;
- server-only bearer token;
- positive provider response validation;
- provider errors normalized before crossing the adapter boundary;
- no raw Graph error payload in public, audit or business error contracts.

## Event data minimization

The Graph event payload contains only data required to reserve the room:

- fixed subject `Conference Manager room reservation`;
- UTC start timestamp;
- UTC end timestamp;
- `showAs=busy`;
- deterministic `transactionId` on create.

The adapter does not send requester profile data, attendees, Request description, catering, cost, price, service configuration or other unnecessary business fields.

## Create and idempotency

Calendar create uses the provider-neutral booking integration service. Its server-derived SHA-256 idempotency key is based on the internal Tenant, Request, Integration and positive attempt number and is passed to Microsoft Graph as `transactionId`.

Before Graph create, the server audit-atomically persists attempt 1 as a `pending` booking reference containing the exact Microsoft Tenant connection identity, resolved resource address and deterministic key. Reserve and event-reference finalization lock and revalidate the exact Integration/provider-Tenant reference, `connected` status and active Entra binding. The provider event reference remains null; no placeholder event ID is permitted. The opaque Graph event ID is stored only after Graph returns it, moving the reference to `active` under the internal Tenant/Request/Integration composite boundary. Browser input cannot select or replace either reference.

A retry of the same `pending` attempt after an external create/local finalization failure uses both the same deterministic idempotency key and the persisted create-time resource address. A room-mapping refresh cannot move that reconciliation into another mailbox scope. After a completed compensation, a later authorized confirmation instead increments `attempt_number`, binds the current mapping and uses a new `transactionId`; this avoids resolving the already-deleted event from the preceding attempt.

If Graph create returns but provider authority is lost before reference finalization, the server persists the real event ID as `compensating`, deletes it using the trusted persisted binding, completes `compensated`, and returns an explicit authority-loss failure. It never silently installs an active event under stale connection authority.

## Final confirmation and compensation

The final confirmation flow is:

1. authorize Conference Manager confirmation;
2. require `microsoft.calendar` for live final free/busy validation;
3. perform uncached provider final validation;
4. require `microsoft.calendar.write` and create the external event idempotently;
5. execute the Tenant/room-locked authoritative local confirmation, revalidating the exact connected Integration and active Entra binding inside that same PostgreSQL transaction;
6. on a local conflict/error, reload the authoritative Request; a confirmed winner or committed unknown outcome returns without deleting its event;
7. only after an explicit local conflict proves the Request unconfirmed, persist `compensating`, cancel externally and persist `compensated`; a thrown/unknown commit outcome retains the event for reconciliation;
8. if compensation also fails, surface a dedicated synchronization failure rather than claiming success.

PostgreSQL and Microsoft Graph do not share a distributed transaction. The implementation therefore uses explicit idempotency and compensation rather than claiming impossible atomicity across systems.

Successful compensation records `compensating` before Graph delete and `compensated`, not terminal `cancelled`, after delete. Create cannot reactivate an in-flight `compensating` row. Idempotent compensation completion must converge first; a later confirmation retry then starts the next numbered attempt with a new transaction ID. If final-commit authority revalidation fails, any event created by that call is compensated and the Request remains unconfirmed.

## Update

The Microsoft adapter and provider-neutral booking contract support updating the persisted event reference with new UTC start/end values. The provider event reference may not be replaced by the update response.

The current product has no accepted server-authoritative post-confirmation date/time/room mutation use case yet. The adapter is ready, but issue #68 remains blocked on product acceptance of that workflow and its authorization/state-transition contract. Issue #114 covers the current create/list/transition API and does not close this separate acceptance gap. No parallel or browser-authoritative change workflow is invented here.

## Cancellation and reconciliation

An authorized Request cancellation first commits the local Request workflow transition. The external event is then cancelled through the persisted provider reference.

If Graph cancellation fails, the call does not report synchronized success. The local Request remains `Cancelled`, and a repeated authorized cancel request performs reconciliation again. Once the provider reference is locally marked cancelled, further retries are deterministic no-ops.

Failure to look up the persisted reference or construct the cancellation provider is also an explicit reconciliation failure: the API returns the stable retryable 503 contract, records a bounded `calendar.operation` failure audit event, and increments the low-cardinality booking-cancel failure metric. Provider-call failures retain the booking adapter's existing audit and metric evidence without double counting at the orchestration layer.

If the reference is still `pending` because create had an unknown outcome, cancellation repeats create idempotently against the persisted resource/key, finalizes the real event reference, and then deletes that event. This creates at most one immediately deleted event when the earlier attempt never committed, while an earlier successful event is found and removed. Any provider or local-finalization failure remains an explicit reconciliation error rather than a false synchronized success.

Cancellation does not consult the current room mapping and does not require local connection status `connected` or current permission-health flags. It uses the stored Integration, provider-Tenant and resource address, while still requiring that exact Integration/provider identity and an exact active Entra binding. Identity unbind and provider rebinding are blocked while any booking reference is `pending`, `active`, `compensating` or `compensated`, preserving the authority needed to reach and remove the old event.

A provider-side 404 on delete is treated as already cancelled because the desired external absence is satisfied.

## Failure semantics

Microsoft errors map into the provider-neutral taxonomy:

- 401 / invalid token -> authorization/revocation;
- 403 -> missing provider permission;
- 409/412 -> calendar conflict;
- 404 on update -> not found;
- 404 on delete -> already cancelled;
- 429 -> throttled/retryable;
- 5xx/transport failure -> unavailable/retryable;
- malformed/oversized response -> fail-closed malformed response.

No blind automatic retry is introduced for unsafe writes. Create is retryable only through deterministic provider idempotency; cancellation reconciliation is explicit and idempotent. Broader health/retry/reconnect behavior belongs to #70.

## Security assessment

Relevant controls include Broken Access Control/BOLA/IDOR prevention, Tenant-bound provider resolution, CWE-918 SSRF prevention through fixed outbound origin, CWE-400 resource bounds, provider credential secrecy, replay/idempotency safety, conflict/concurrency handling and failure/redaction behavior.

Automated repository gates are engineering evidence for these implemented controls only. They are not evidence of live Microsoft consent, Exchange RBAC, penetration testing or production deployment.
