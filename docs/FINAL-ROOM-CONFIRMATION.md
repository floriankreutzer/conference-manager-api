# Final Room Confirmation Consistency

## Authority

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/AUTHORIZATION.md`, `docs/BOOKING-INTEGRATION.md`, `docs/MICROSOFT365-FREE-BUSY.md`, and the canonical Request workflow remain authoritative.

This capability makes the server-side `confirm` transition the final room-allocation authority. Browser availability and earlier provider checks are advisory only.

## Final confirmation sequence

For an eligible `Submitted` or `In Review` Request with a mapped room:

1. load the Request inside the authenticated internal Tenant;
2. authorize the canonical `confirm` transition using the central authorization policy;
3. require the server-side `microsoft.calendar` Tenant entitlement;
4. resolve the Microsoft 365 calendar provider from the Tenant-owned connection and active room mapping;
5. perform a fresh, uncached final free/busy validation for the exact Request UTC interval;
6. if the provider reports conflict or cannot produce a trustworthy result, fail without changing Request state;
7. if provider validation succeeds, enter the PostgreSQL final-confirmation transaction;
8. lock the current Request row and revalidate its expected workflow state and room;
9. acquire a transaction-scoped advisory lock keyed by internal Tenant and internal room;
10. recheck overlapping `Confirmed` Requests for that Tenant/room/time;
11. only when no confirmed overlap exists, change the Request to `Confirmed` and append the successful workflow audit event in the same transaction.

Two concurrent Conference Manager attempts for overlapping Requests can both observe provider availability before either local booking is committed, but the Tenant/room advisory lock serializes the authoritative local decision. After the first commit, the second transaction observes the new `Confirmed` overlap and fails with a conflict.

## Idempotency

A retry for a Request that is already `Confirmed` returns the same authorized Request state without another provider call or database mutation. This avoids duplicate effects when the client retries after losing the successful HTTP response.

This idempotency covers the local confirmation operation. When the optional `microsoft.calendar.write` capability is enabled, the same owning use case also invokes the provider-neutral calendar service with a server-derived idempotency key and a persisted create-time resource binding; create/update/cancel recovery remains server-side.

## Tenant and object ownership

Tenant authority remains the authenticated internal Principal/Tenant context. The browser cannot supply an integration ID, provider Tenant, resource address, provider reference, entitlement, final workflow state, or room lock key.

The provider factory resolves the Microsoft connection and room resource from Tenant-scoped repositories. The final PostgreSQL transaction reselects the Request using internal Tenant + Request ID and derives the lock key from the persisted internal room ID. A cross-Tenant Request identifier therefore cannot confirm another Tenant's resource.

## Failure semantics

- authorization denial -> no provider call and no Request mutation;
- missing Microsoft Calendar entitlement -> no provider call and no Request mutation;
- missing/degraded/revoked provider connection or mapping -> fail closed;
- provider busy result -> Request-state conflict, no mutation;
- provider timeout/throttling/unavailable/malformed result -> availability unavailable, no mutation;
- stale Request workflow state -> Request-state conflict;
- overlapping Request confirmed by a concurrent transaction -> room-availability conflict;
- audit append failure -> transaction rollback; no successful Request confirmation response;
- database failure -> no successful confirmation response.

No provider error body, token, resource address, or provider reference is added to the public workflow result or audit metadata.

## Consistency boundary and residual risk

PostgreSQL and Microsoft Graph cannot participate in one distributed transaction. The implemented optional calendar-write composition therefore persists reconciliation state and a create-time resource binding, uses deterministic provider idempotency, and never reports provider failure as synchronized local success. Partial outcomes remain explicit reconciliation work rather than being hidden as atomicity.

The final live free/busy call reduces stale-provider risk; the local room lock eliminates concurrent Conference Manager double confirmation inside one Tenant. When Calendar Write is enabled, event creation follows that validation through the fixed Microsoft adapter. An external Exchange actor can still create a conflicting event in the remaining network interval because Graph and PostgreSQL provide no shared transaction; this residual race requires real Pilot acceptance and operational reconciliation evidence.

## Verification

Automated coverage includes live-provider-before-mutation ordering, provider conflict/outage fail-closed behavior, entitlement gating, idempotent confirmed retry, delegation from the normal Request `confirm` route, concurrent PostgreSQL attempts for the same Tenant/room/time, cross-Tenant isolation, and stale-state rejection. Standard quality, DAST, PostgreSQL, dependency, and secret gates remain mandatory.
