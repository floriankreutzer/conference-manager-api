# Microsoft 365 Calendar Write Synchronization

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/BOOKING-INTEGRATION.md` and `docs/ENTITLEMENTS.md` are authoritative. This document records the Microsoft-specific calendar write adapter and synchronization semantics introduced for SaaS 1 issue #68.

The existing Request workflow remains the business authority. Microsoft Graph is an external calendar provider; it does not determine Conference Manager roles, Tenant ownership, workflow state or entitlement.

## Permission model

Productive Graph event create/update/delete requires the Microsoft Graph application permission `Calendars.ReadWrite` for the central confidential-client SaaS application.

Microsoft application permissions are configured on the app registration and acquired through the `/.default` client-credentials scope. They are not dynamically added by an internal Tenant entitlement. Conference Manager therefore enforces a second independent server-side gate:

- `microsoft.calendar` controls read/free-busy use;
- `microsoft.calendar.write` controls productive create/update/cancel use.

Having read/free-busy entitlement never grants write access. Having provider consent never grants internal product entitlement. The owning use case must also pass the central RBAC/object authorization policy.

Exchange Application RBAC resource-mailbox scoping is a separate enterprise hardening layer tracked by #69.

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

The provider adapter resolves the active Microsoft 365 connection and active room mapping from Tenant-scoped server repositories. All Graph calls reuse the fixed `https://graph.microsoft.com` origin and the existing confidential-client token path.

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

Calendar create uses the provider-neutral booking integration service. Its server-derived SHA-256 idempotency key is based on the internal Tenant, Request and Integration identity and is passed to Microsoft Graph as `transactionId`.

The opaque Graph event ID is persisted in `booking_provider_references` under the internal Tenant/Request/Integration composite boundary. Browser input cannot select or replace it.

A retry after an external create/local persistence failure uses the same deterministic idempotency key. The provider-neutral contract therefore supports recovery without treating a new browser-generated key as authority.

## Final confirmation and compensation

The final confirmation flow is:

1. authorize Conference Manager confirmation;
2. require `microsoft.calendar` for live final free/busy validation;
3. perform uncached provider final validation;
4. require `microsoft.calendar.write` and create the external event idempotently;
5. execute the PostgreSQL Tenant/room-locked authoritative local confirmation;
6. if local confirmation loses a concurrent race or the local transaction fails, cancel the external event as compensation;
7. if compensation also fails, surface a dedicated synchronization failure rather than claiming success.

PostgreSQL and Microsoft Graph do not share a distributed transaction. The implementation therefore uses explicit idempotency and compensation rather than claiming impossible atomicity across systems.

## Update

The Microsoft adapter and provider-neutral booking contract support updating the persisted event reference with new UTC start/end values. The provider event reference may not be replaced by the update response.

The current product has no accepted server-authoritative approved date/time/room mutation use case yet. Wiring an approved Request change to this adapter belongs to the production application API reconciliation in #114. No parallel or browser-authoritative change workflow is introduced by #68.

## Cancellation and reconciliation

An authorized Request cancellation first commits the local Request workflow transition. The external event is then cancelled through the persisted provider reference.

If Graph cancellation fails, the call does not report synchronized success. The local Request remains `Cancelled`, and a repeated authorized cancel request performs reconciliation again. Once the provider reference is locally marked cancelled, further retries are deterministic no-ops.

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
