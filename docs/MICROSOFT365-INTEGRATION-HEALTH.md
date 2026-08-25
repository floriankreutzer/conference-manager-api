# Microsoft 365 Integration Health and Recovery

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/MICROSOFT365-CONNECTION.md`, `docs/OBSERVABILITY.md` and the provider-neutral booking contract remain authoritative.

This document defines the SaaS 1 issue #70 diagnostic and recovery boundary. It does not create another connection lifecycle or authorization source.

## Separation of health domains

Platform health remains aggregate and non-Tenant-specific:

- `/api/v1/health/live` is process liveness.
- `/api/v1/health/ready` is required infrastructure readiness.
- `/api/v1/health/status` may report optional provider degradation only as an aggregate state.

Tenant-specific Microsoft diagnostics are available only through the existing Tenant Admin Microsoft 365 connection contract after server-side Tenant and permission authorization. Internal Tenant IDs, Integration IDs, provider Tenant IDs, room addresses, event references and provider payloads are not returned.

## Capability diagnostics

Runtime diagnostics are recorded for:

- `places` — room discovery;
- `free_busy` — Graph schedule lookup/final reservation validation;
- `calendar_write` — create/update/cancel synchronization.

Each row is scoped by internal Tenant plus Microsoft Integration and contains only:

- bounded capability identifier;
- bounded health status;
- bounded reason code;
- last checked UTC timestamp;
- last successful UTC timestamp.

Statuses are `healthy`, `degraded`, `unavailable`, `revoked`, `permission_missing` and `not_configured`.

No diagnostic row is an entitlement, permission or authorization grant. The owning business use case must still pass Tenant, RBAC/object authorization and entitlement checks.

## Persistence and lifecycle

Migration 014 creates `microsoft365_capability_health` with composite Tenant/Integration ownership and a foreign key to the existing integration lifecycle record. A provider operation can update only the row for the already server-resolved internal Tenant and Integration.

The last successful timestamp is preserved across later failures so support can distinguish a never-working capability from a recently degraded one. Diagnostic persistence is not part of the authoritative booking transaction and therefore does not convert an external failure into success.

Rollback fails closed while diagnostic rows exist. Recovery requires an explicit decision to discard those operational diagnostics before removing the schema.

## Retry policy

Automatic retries are allowed only for semantically safe provider operations and only for transient classifications:

- Microsoft Places discovery;
- free/busy and final validation reads;
- other explicitly reviewed read/verification operations.

The default policy attempts at most three calls with bounded exponential backoff. Authorization failures, permission failures, validation failures, malformed responses, conflicts and unknown failures are not retried.

Calendar event create/update/cancel is not blindly retried by this policy. Calendar create already uses deterministic provider idempotency, and cancellation reconciliation is an explicit business retry path. This avoids turning operational retry into duplicate or conflicting business writes.

## Recovery semantics

- Revoked/authorization failures require reconnect or re-consent; retries do not repair them.
- Missing provider permission requires updated Microsoft administrator consent/configuration.
- Transient throttling/unavailability may recover through bounded retry or a later user operation.
- Invalid/missing room mapping is reported as degraded and requires mapping reconciliation.
- A failed calendar write is never reported as synchronized success.

## Privacy and observability

Operational diagnostics use fixed status/reason values. Raw Graph bodies, provider error descriptions, access tokens, credentials, Tenant/User identifiers and provider resource IDs are excluded.

Low-cardinality platform metrics remain governed by `docs/OBSERVABILITY.md`; the new Tenant-specific database rows are support state, not metric dimensions.

## Verification

Automated evidence includes bounded retry behavior, permanent-failure no-retry behavior, capability status mapping, preservation of last-success timestamps, Tenant-isolated persistence, cross-Tenant FK rejection, fail-closed migration rollback and existing Microsoft/booking regression suites.

Real recovery validation against Microsoft remains an external Pilot gate for revoked consent, actual Graph throttling/outages, re-consent and customer-specific Exchange policy behavior.
