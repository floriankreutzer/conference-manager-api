# Tenant effective capability and readiness view

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ENTITLEMENTS.md`,
`docs/TENANCY.md`, `docs/MICROSOFT365-CONNECTION.md` and
`docs/MICROSOFT365-INTEGRATION-HEALTH.md` remain authoritative. This document defines the SaaS 2 read-only
capability view for issue #89.

The view consolidates existing server-derived authorization, Tenant lifecycle, entitlement, rollout,
Microsoft connection and capability-health state. It does not create a commercial/control-plane write path,
accept browser feature flags, or treat provider readiness as an entitlement.

## HTTP contract

`GET /api/v1/tenant/capabilities` requires Tenant Admin configuration authority. It accepts no query, body or
Tenant selector. Every other method returns `METHOD_NOT_ALLOWED`.

The response is read-only and contains server evaluation time, presentation-safe Tenant status and a fixed
capability collection. Each item contains:

- `id`: stable product capability identifier;
- `availability`: `included` or `optional`;
- `state`: `operational`, `blocked`, `degraded`, `not_entitled` or `unavailable`;
- `reasonCodes`: fixed customer-actionable reason identifiers;
- optional fixed self-service `action`;
- optional canonical `lastCheckedAt`.

The fixed capability set is:

- `tenant.user_administration`;
- `tenant.audit_history`;
- `tenant.configuration`;
- `microsoft.directory`;
- `microsoft.calendar`;
- optional `microsoft.calendar.write`.

## Effective evaluation

An operational state requires the server-owned intersection applicable to that capability:

```text
recognized Tenant Admin authority
AND active internal Tenant lifecycle
AND entitlement where commercial access is controlled
AND known enabled/not-controlled server rollout state
AND required Microsoft identity/connection/permission/readiness state
```

Rollout enablement cannot override missing authorization or entitlement. Provider health cannot grant an
entitlement. Browser visibility, query fields, local storage and client-supplied capability values are never
inputs.

Microsoft evaluation reuses the existing Tenant Pilot readiness and Microsoft connection-health services.
Runtime composition must inject the connection service already decorated by
`createMicrosoft365ConnectionHealthView`; the undecorated connection lifecycle response is not sufficient
authority for an operational capability. Missing composed capability health fails closed as
`provider_health_unknown` and must not be replaced with a browser or coarse connection-status fallback.
Healthy evidence older than 24 hours is reported as `degraded` with `readiness_stale`. Unknown, malformed or
materially future health evidence fails closed. A missing optional calendar-write entitlement reports
`not_entitled`; it is not conflated with missing Microsoft permission or readiness.

Fixed reason codes include:

- `tenant_not_active`, `tenant_state_unknown`;
- `authority_missing`;
- `rollout_state_unknown`, `rollout_disabled`;
- `entitlement_missing`;
- `readiness_unknown`, `readiness_stale`;
- `tenant_identity_required`, `microsoft_connection_required`;
- `provider_permission_required`, `verification_required`, `provider_health_unknown`;
- `provider_degraded`, `provider_unavailable`, `microsoft_reconnect_required`.

The only current self-service action is the fixed Microsoft connection-management destination. Missing
commercial entitlement, Tenant lifecycle or rollout authority exposes no write action because those mutations
remain Platform/operator-owned.

## Security and privacy

The response omits internal feature-flag names, Integration IDs, provider Tenant/resource identifiers,
commercial configuration, provider errors/payloads, credentials and tokens. Unknown capability, rollout,
Tenant or health values never appear enabled. Suspended/archived/unknown Tenant state cannot produce an
operational capability even when stale downstream data says healthy.

External Microsoft acceptance must verify real consent, connection recovery and customer-specific health.
Repository tests validate effective evaluation and fail-closed combinations only.
