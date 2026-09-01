# Server-Side Authorization

## Authority

Root `AGENTS.md` remains the canonical repository instruction source. This document defines the server-enforced Tenant authorization contract and its SaaS 3.6 role/ownership baseline.

Authentication proves the internal Principal. Tenant resolution proves the internal Tenant context. Authorization is a separate deny-by-default decision performed after both steps.

The browser never supplies authoritative Tenant, User, role, permission, owner, workflow status, target status, configuration ownership or audit scope values.

## Tenant role model

Every active Customer User has the implicit `employee` baseline. Employee is reconstructed server-side and is not stored as a removable elevated role assignment.

The independent elevated Tenant roles are:

- `conference_manager`;
- `tenant_admin`.

A User may hold neither, either or both elevated roles. A dual-role Principal is the exact permission union. Neither elevated role inherits the other.

`platform_admin` is explicitly outside the Tenant authorization model. Supplying it as a Tenant session role is treated as an unknown role and fails closed.

| Role | Purpose | Scope |
| --- | --- | --- |
| `employee` | Customer self-service baseline | Own Requests |
| `conference_manager` | Conference operations and business configuration | Tenant Requests, Room business data, Tenant Catalogue and Room prices |
| `tenant_admin` | Technical/Tenant administration | Organization/policy/cost allocation, Sites/technical Room assignment, Users/roles, provider integrations/mappings and Tenant audit |

## Permission matrix

A Principal must contain only known roles and known permissions. One unknown role or permission invalidates the Principal for business authorization.

A capability is granted only when both conditions are true:

1. the internal Principal contains the required permission;
2. at least one internal Tenant role on that Principal is permitted to use that permission.

| Permission | Employee | Conference Manager | Tenant Admin |
| --- | ---: | ---: | ---: |
| `request:read` | Own | Tenant through Conference Manager scope | Own through implicit Employee baseline |
| `request:cancel` | Own eligible Requests | Own through implicit Employee baseline | Own through implicit Employee baseline |
| `request:manage` | No | Tenant workflow, including cancellation of eligible same-Tenant Requests | No |
| `tenant:rooms:business:manage` | No | Tenant Room business fields | No |
| `tenant:catalogue:manage` | No | Tenant Catalogue and authoritative Room prices | No |
| `tenant:configure` | No | No | Tenant technical/business-policy configuration excluding Conference Manager-owned Catalogue/Room business fields |
| `tenant:users:manage` | No | No | Tenant Users/elevated roles |
| `tenant:integrations:manage` | No | No | Tenant provider integrations/mappings |
| `tenant:audit:read` | No | No | Tenant audit only |

Roles do not automatically grant arbitrary permissions, and a permission that is not valid for an assigned role does not grant access. `requireTenantPermission` derives allowed roles from the canonical role-to-permission mapping; it does not hard-code Tenant Admin as the owner of every Tenant permission.

## Configuration ownership

SaaS 3.6 separates business configuration from technical/provider administration.

Conference Manager owns:

- Room business fields: display name, capacity, active state, floor, equipment/accessibility, applicable Service/Catering IDs and local presentation assets;
- Tenant Catalogue: Services, equipment catalogue, catering items/packages/variants;
- authoritative Room prices.

Tenant Admin owns:

- Site configuration and Room-to-Site technical assignment;
- Organization, Booking Policy and Cost Allocation configuration;
- Tenant User/elevated-role administration;
- provider connection, discovery/import/resync and provider Room identity/resource mapping;
- Tenant audit administration.

The Locations application service classifies every proposed mutation against the persisted current Tenant snapshot. A technical-only mutation requires `tenant:configure`; a Room-business-only mutation requires `tenant:rooms:business:manage`; a mixed mutation requires both capabilities and therefore a dual-role Principal. The browser cannot self-classify a mutation into a weaker authorization path.

Catalogue mutation requires `tenant:catalogue:manage`; Tenant Admin alone is denied.

## Object-level Request authorization

Request persistence is always queried with the server-resolved internal `tenant_id` plus Request ID. The API never performs an unscoped global Request lookup and filters afterwards.

Employee Request access additionally requires `request.requester_user_id === principal.userId`.

Request creation and resubmission use the Employee `request:read` capability. Resubmission additionally requires requester ownership, `Change Requested` status and the expected Request version; a Conference Manager cannot use management scope to impersonate the owning Employee.

A missing Request, a Request from another Tenant and a same-Tenant Request owned by another Employee are exposed to an Employee as the same `404 NOT_FOUND` response. This prevents object-existence disclosure through BOLA/IDOR probing.

A Conference Manager with `request:read` may read Requests belonging to another Employee only inside the authenticated Tenant. Request history and `GET /api/v1/requests/{requestId}/room-context` apply the same object decision as the current Request read. The Room-context lookup occurs only after that decision and uses the server-loaded Request `roomId`; Employee non-owner and cross-Tenant probes cannot select a Room identity. A Conference Manager with `request:manage` may cancel another Employee's eligible same-Tenant Request; cross-Tenant Requests remain concealed.

Tenant Admin has no implicit Conference Manager workflow capability. Its own-Request read and cancellation access comes only from the implicit Employee baseline. Tenant Admin alone cannot cancel another Employee's Request.

`GET /api/v1/application/reports/requests` is a separate Conference Manager read. It requires both `conference_manager` and `request:manage`, derives the active Tenant from the Principal and passes that Tenant ID to a range-bounded repository query. Tenant Admin alone is denied before persistence. The opaque continuation cursor contains no Tenant authority.

## Tenant audit-read authorization

`GET /api/v1/audit` requires:

- authenticated internal Principal;
- known Tenant context derived from `principal.tenantId`;
- recognized role/permission snapshot;
- `tenant_admin` role;
- explicit `tenant:audit:read` permission.

The endpoint accepts no Tenant selector. The audit repository receives only the authenticated internal Tenant ID. Tenant Admin cannot query another Tenant's audit chain through route/query/body manipulation.

Before events are exposed, the audit service verifies the authenticated Tenant's integrity chain. A verification failure fails closed rather than returning unverified data.

Platform/operator audit remains a separate authorization domain. `tenant_admin` cannot become a Platform auditor through this permission.

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
| `cancel` | Submitted, In Review, Confirmed, Change Requested | Cancelled | Owning Employee / `request:cancel`, or Conference Manager / `request:manage` inside the same Tenant | Forbidden |

Unsupported transitions fail validation. Valid transitions from an ineligible current state return `409 REQUEST_STATE_CONFLICT`. An authorized retry against an already `Cancelled` Request is an idempotent cancellation-reconciliation read: it returns the unchanged Request, performs any still-required Calendar cleanup and writes no duplicate successful transition evidence. Cancellation is a logical workflow transition only; the public Request API exposes no physical delete operation. A pending booking-change proposal is superseded audit-atomically when its Request is cancelled, while an applying proposal makes cancellation fail with a state conflict.

Confirmed-booking proposals are a separate aggregate. The Requester/Organizer may propose changes only for their own confirmed Request; a Conference Manager with `request:manage` may propose for any confirmed Request in the active Tenant. Only a Conference Manager may approve or reject a pending proposal. Self-approval is allowed and the initiator/decider identities remain server-derived and auditable. No decision endpoint permits proposal editing.

Neither initiator nor decider can submit prices, policy/allocation results, target workflow state or another Tenant's configuration as authority.

## Session invalidation and concurrency

Role administration persists only elevated role rows. Production/JIT and Demo identity resolution prepend the Employee baseline and derive permissions from the canonical policy.

Every stored per-User role change increments that User's `users.security_version` in the same PostgreSQL transaction as the role mutation and success audit event. Sessions snapshot that version. A stale session therefore fails server resolution immediately after a per-User role/security change; browser state cannot keep prior authority alive.

A global source-code change to the meaning of an existing role/permission snapshot uses the separate non-secret Customer authorization epoch embedded in the session-token hash. Migration 034 permanently revokes every still-active pre-epoch Customer session; its down migration never clears `revoked_at`, and current-epoch hashes cannot be resolved by an old unnamespaced binary. Forward rollout, rollback and pre-034 PITR therefore require blocked Customer traffic, one epoch-consistent fleet and fresh authentication as defined by `docs/IDENTITY-SESSION.md` and `docs/PRODUCTION-SECURE-CONFIGURATION.md`.

Request and settings writes use optimistic revisions and Tenant-scoped persistence locks where required. Authorization is revalidated against authoritative persisted state before committing. A stale concurrent mutation fails closed rather than overwriting newer authority/state.

Database constraints and immutable/audit triggers provide defense in depth; they do not replace application authorization.

## HTTP and CSRF contracts

Mutating cookie-authenticated routes require the existing session-bound CSRF token. Request bodies are exact schemas and do not accept Tenant/role/permission authority fields.

Public response contracts deliberately minimize internal Tenant/provider identity and credential data. Historical configuration/Request snapshots are presentation/evidence facts and do not become write authority.

`GET /api/v1/tenant/presentation` is an explicit minimized contract readable by a recognized authenticated Tenant role. Tenant scope is server-derived. Tenant Admin plus `tenant:configure` remains mandatory for Organization administration.

## Audit boundary

Audit actor/Tenant/time/outcome values are server-generated. Tenant-scoped successful, failed and denied privileged operations create correlated evidence where a valid authenticated context exists. Booking-change read/propose/decision denials record only the target Request ID and a fixed operation in the caller Tenant; change IDs, foreign Tenant/owner facts and object-existence details are excluded. Principal/Tenant-context mismatches are not forced into a Tenant chain. Audit writes required by a state mutation commit atomically with that mutation.

See `docs/AUDIT.md` for taxonomy, minimization, append-only persistence and integrity-chain rules.

## Required tests

Changes to this policy require, as applicable:

- full Employee/Conference Manager/Tenant Admin/dual-role matrix tests;
- unknown-role/permission negative tests;
- Employee owner/non-owner and cancellation tests;
- Conference Manager same-Tenant/cross-Tenant Request tests, including foreign-owner cancellation and booking-change denial evidence;
- Tenant Admin separation tests;
- Room-business versus technical Location field-ownership tests, including mixed dual-role writes;
- Catalogue ownership tests that deny Employee, Tenant Admin-only and cross-Tenant mutation;
- Tenant audit-read permission and cross-Tenant isolation tests;
- every privileged workflow transition, including same-manager propose/approve persistence and independent audit attribution;
- malformed/manipulated ID and exact-body tests;
- CSRF tests for state changes;
- stale/concurrent workflow-state and configuration tests;
- PostgreSQL Tenant-scoping/constraint/audit-atomic tests;
- Demo persona parity tests proving the derived dual-role union without introducing a new persisted role.
