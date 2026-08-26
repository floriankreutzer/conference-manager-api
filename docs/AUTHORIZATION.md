# Server-Side Authorization

## Authority

Root `AGENTS.md` remains the canonical repository instruction source. This document defines the SaaS 0 authorization contract implemented by issue #51 and extended by issue #52 for tenant audit reads.

Authentication proves the internal Principal. Tenant resolution proves the internal Tenant context. Authorization is a separate deny-by-default decision performed after both steps.

The browser never supplies authoritative Tenant, User, role, permission, owner, workflow status, target status or audit scope values.

## Tenant role model

The current Tenant roles are:

| Role | Purpose | Request scope |
| --- | --- | --- |
| `employee` | Employee self-service | Own requests only |
| `conference_manager` | Conference operations | Requests inside the authenticated Tenant |
| `tenant_admin` | Tenant configuration, User/role administration, integrations and authorized Tenant audit reads | No implicit Conference Manager request access |

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
| `tenant:audit:read` | No | No | Tenant audit only |

Roles do not automatically grant permissions, and a permission that is not valid for the assigned role does not grant access.

## Object-level request authorization

Request persistence is always queried with the server-resolved internal `tenant_id` plus request ID. The API never performs an unscoped global request lookup and filters afterwards.

Employee request access additionally requires `request.requester_user_id === principal.userId`.

A missing request, a request from another Tenant and a same-Tenant request owned by another Employee are exposed to an Employee as the same `404 NOT_FOUND` response. This prevents object-existence disclosure through BOLA/IDOR probing.

A Conference Manager with `request:read` may read requests belonging to another Employee only inside the authenticated Tenant.

Tenant Admin has no implicit request-read or Conference Manager workflow capability.

## Tenant audit-read authorization

`GET /api/v1/audit` is a separate Tenant Admin capability. It requires:

- authenticated internal Principal;
- known Tenant context derived from `principal.tenantId`;
- recognized role/permission snapshot;
- `tenant_admin` role;
- explicit `tenant:audit:read` permission.

The endpoint accepts no Tenant selector. The audit repository receives only the authenticated internal Tenant ID. Tenant Admin cannot query another Tenant's audit chain through route/query/body manipulation.

Before events are exposed, the audit service verifies the authenticated Tenant's integrity chain. A verification failure fails closed rather than returning unverified data.

Platform/operator audit remains a separate authorization domain. `tenant_admin` cannot become a platform auditor through this permission.

Successful audit reads and denied Tenant-audit probes with a valid Tenant/actor context create their own correlated security audit events.

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

Confirmed-booking proposals are a separate aggregate and never reuse `request_change`, which remains the pre-confirmation manager transition above. The Requester/Organizer may propose changes only for their own confirmed Request; a Conference Manager with `request:manage` may propose for any confirmed Request in the active Tenant. Only a Conference Manager may approve or reject schedule/room proposals. Self-approval is allowed and the initiator/decider identities remain server-derived and auditable. No decision endpoint permits proposal editing.

Reject/change-request reasons are trimmed server-side, limited to 1-1000 characters and reject control characters. Reasons on transitions that do not use a reason are rejected instead of ignored.

## Concurrency, persistence and audit evidence

Migration 003 constrains persisted request status values and introduces `status_reason` plus `status_changed_at`.

The application service first loads a Tenant-scoped request and authorizes the transition against that exact server-side object state. The PostgreSQL update then includes all three of:

- internal `tenant_id`;
- request ID;
- previously authorized current status.

If another transaction changed the workflow state between read and write, the update affects no row and the API returns `409 REQUEST_STATE_CONFLICT`. It does not silently overwrite the newer state.

Request status values and reason/status combinations are additionally constrained in PostgreSQL as defense in depth. Database constraints do not replace the application authorization policy.

For a successful Request transition, the application constructs the audit event from the server Principal, Tenant context, current Request, authorized transition decision and request correlation ID. PostgreSQL commits that success event in the same transaction as the Request mutation. Audit append failure prevents the transition from committing.

Authorization denials, validation failures and concurrency failures that produce no successful Request mutation are recorded as separate correlated failure/denial events where a valid Tenant/actor context exists.

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

`GET /api/v1/audit` is read-only, accepts only bounded pagination, and returns presentation-safe events for the authenticated Tenant after `tenant:audit:read` authorization and integrity verification.

## Audit boundary

Issue #52 implements server-generated Tenant audit events for the currently supported session, authorization and Request workflow paths. Audit actor/Tenant/time/outcome values are not accepted from browser input.

The audit action taxonomy also reserves identifiers for later Tenant/integration/calendar owning issues. A reserved action name does not imply that the corresponding future workflow is already implemented.

See `docs/AUDIT.md` for the event taxonomy, data-minimization rules, append-only persistence and integrity-chain limitations.

## Required tests

Changes to this policy require, as applicable:

- full role/permission matrix tests;
- unknown-role/permission negative tests;
- Employee owner/non-owner tests;
- Conference Manager same-Tenant/cross-Tenant tests;
- Tenant Admin separation tests;
- Tenant audit-read permission and cross-Tenant isolation tests;
- every privileged workflow transition;
- malformed/manipulated ID and body tests;
- CSRF tests for state changes;
- stale/concurrent workflow-state tests;
- PostgreSQL Tenant-scoping and constraint tests;
- audit denial/success/failure correlation and integrity verification tests.
