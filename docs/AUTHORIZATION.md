# Server-Side Authorization

## Authority

Root `AGENTS.md` remains the canonical repository instruction source. This document defines the SaaS 0 authorization contract implemented by issue #51.

Authentication proves the internal Principal. Tenant resolution proves the active internal Tenant context. Authorization is a separate deny-by-default decision performed after both steps.

The browser never supplies authoritative Tenant, User, role, permission, owner, workflow status or target status values.

## Tenant role model

The current Tenant roles are:

| Role | Purpose | Request scope |
| --- | --- | --- |
| `employee` | Employee self-service | Own requests only |
| `conference_manager` | Conference operations | Requests inside the authenticated Tenant |
| `tenant_admin` | Tenant configuration, User/role administration and integrations | No implicit Conference Manager request access |

`platform_admin` is explicitly outside the Tenant authorization model. Supplying it as a Tenant session role is treated as an unknown role and fails closed.

The current SaaS 0 manager scope is the authenticated internal Tenant. A future requirement for site/location/department assignment requires an explicit server-side scope model and must not be approximated from browser input or provider claims.

## Permission matrix

A Principal must contain only known roles and known permissions. One unknown role or permission invalidates the Principal for business authorization.

A capability is granted only when both conditions are true:

1. the internal Principal contains the required permission;
2. at least one internal Tenant role on that Principal is permitted to use that permission.

| Permission | Employee | Conference Manager | Tenant Admin |
| --- | ---: | ---: | ---: |
| `request:read` | Own | Tenant | No |
| `request:cancel` | Own eligible requests | No | No |
| `request:manage` | No | Tenant workflow | No |
| `tenant:configure` | No | No | Tenant |
| `tenant:users:manage` | No | No | Tenant |
| `tenant:integrations:manage` | No | No | Tenant |

Roles do not automatically grant permissions, and a permission that is not valid for the assigned role does not grant access.

## Object-level request authorization

Request persistence is always queried with the server-resolved internal `tenant_id` plus request ID. The API never performs an unscoped global request lookup and filters afterwards.

Employee request access additionally requires `request.requester_user_id === principal.userId`.

A missing request, a request from another Tenant and a same-Tenant request owned by another Employee are exposed to an Employee as the same `404 NOT_FOUND` response. This prevents object-existence disclosure through BOLA/IDOR probing.

A Conference Manager with `request:read` may read requests belonging to another Employee only inside the authenticated Tenant.

Tenant Admin has no implicit request-read or Conference Manager workflow capability.

## Request workflow authorization

The authoritative server workflow values remain compatible with the functional frontend baseline:

- `Submitted`
- `In Review`
- `Confirmed`
- `Rejected`
- `Change Requested`
- `Cancelled`

Client input selects only a supported transition name. It never supplies the next status.

| Transition | Allowed current status | Next status | Authorized role / permission | Reason |
| --- | --- | --- | --- | --- |
| `start_review` | Submitted | In Review | Conference Manager / `request:manage` | Forbidden |
| `confirm` | Submitted, In Review | Confirmed | Conference Manager / `request:manage` | Forbidden |
| `reject` | Submitted, In Review | Rejected | Conference Manager / `request:manage` | Required |
| `request_change` | Submitted, In Review | Change Requested | Conference Manager / `request:manage` | Required |
| `cancel` | Submitted, In Review, Confirmed, Change Requested | Cancelled | Owning Employee / `request:cancel` | Forbidden |

Unsupported transitions fail validation. Valid transitions from an ineligible current state return `409 REQUEST_STATE_CONFLICT`.

Reject/change-request reasons are trimmed server-side, limited to 1-1000 characters and reject control characters. Reasons on transitions that do not use a reason are rejected instead of ignored.

## Concurrency and persistence

Migration 003 constrains persisted request status values and introduces `status_reason` plus `status_changed_at`.

The application service first loads a Tenant-scoped request and authorizes the transition against that exact server-side object state. The PostgreSQL update then includes all three of:

- internal `tenant_id`;
- request ID;
- previously authorized current status.

If another transaction changed the workflow state between read and write, the update affects no row and the API returns `409 REQUEST_STATE_CONFLICT`. It does not silently overwrite the newer state.

Request status values and reason/status combinations are additionally constrained in PostgreSQL as defense in depth. Database constraints do not replace the application authorization policy.

## HTTP contracts

`GET /api/v1/requests/{requestId}` requires:

- authenticated server-side Principal;
- active Tenant context;
- recognized role/permission set;
- `request:read` plus the applicable object scope.

`POST /api/v1/requests/{requestId}/transitions` additionally requires a valid session-bound CSRF token and an exact JSON body:

```json
{
  "transition": "confirm"
}
```

or, only for a transition that requires it:

```json
{
  "transition": "reject",
  "reason": "No suitable room is available."
}
```

Fields such as `tenantId`, `requesterUserId`, `owner`, `role`, `permission`, `status` or `nextStatus` are not part of the schema and are rejected.

The public Request response deliberately omits internal Tenant ownership and requester User ID in this foundation slice. Later business APIs may expose additional required presentation data only through an explicit reviewed contract.

## Audit boundary

Issue #51 decides authorization but does not claim immutable authorization/security-event auditing. Issue #52 owns server-generated audit events for successful and denied security/workflow-relevant actions, including actor, Tenant, target, transition, outcome and correlation metadata.

## Required tests

Changes to this policy require, as applicable:

- full role/permission matrix tests;
- unknown-role/permission negative tests;
- Employee owner/non-owner tests;
- Conference Manager same-Tenant/cross-Tenant tests;
- Tenant Admin separation tests;
- every privileged workflow transition;
- malformed/manipulated ID and body tests;
- CSRF tests for state changes;
- stale/concurrent workflow-state tests;
- PostgreSQL Tenant-scoping and constraint tests.
