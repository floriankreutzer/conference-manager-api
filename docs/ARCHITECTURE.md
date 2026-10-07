# Backend Architecture

## Authority

Root `AGENTS.md` is the canonical repository instruction source. This document describes the current implementation and does not override it.

The cross-repository production topology is defined in `floriankreutzer/conference-manager` by `docs/SAAS-PRODUCTION-TOPOLOGY.md`.

## Current foundation

The service uses Node.js 22 native HTTP and ECMAScript modules. The implemented foundation includes:

- a bounded same-origin HTTP boundary;
- hard Tenant isolation and PostgreSQL 18 persistence;
- provider-neutral server-side sessions and CSRF protection;
- Microsoft Entra OIDC authentication, Tenant claiming and JIT User provisioning;
- deny-by-default Tenant roles and permissions;
- Tenant-scoped role administration with stale-session invalidation;
- Tenant-scoped User lifecycle administration with lifecycle revisions and immediate session revocation;
- Tenant-scoped tamper-evident audit evidence;
- bounded Tenant audit queries and an effective capability/readiness view;
- server-side Tenant entitlements;
- provider-neutral booking/calendar contracts and opaque provider references;
- a Tenant-scoped Microsoft 365 admin-consent, verification, reconnect and disconnect lifecycle;
- independent optimistic revision authority for the five SaaS 2 Tenant settings aggregates;
- field-classified Locations ownership, Conference Manager-owned Catalogue/Room business configuration, and Tenant Admin-owned Organization, Booking Policies, Cost Allocation and technical configuration;
- one versioned server-authoritative Request composition model with immutable configuration, price,
  policy and allocation snapshots;
- an isolated two-process Shared Demo Runtime backed by one deterministic PostgreSQL state and a
  network-free simulated Microsoft 365 adapter;
- production observability, threat-model and secure-configuration gates.

Runtime dependencies are limited to exact-pinned `pg`, `@azure/msal-node`, `sharp` and `@aws-sdk/client-s3`. The image decoder is restricted to the managed Room media adapter, where bounded PNG/JPEG/WebP input is decoded and re-encoded without source metadata before storage. Provider-specific Microsoft handling uses bounded native HTTP plus a bounded MSAL transport isolated inside identity/integration adapters; Microsoft SDK types do not enter application or domain contracts. The S3 SDK is restricted to the private media storage adapter. Customer persistence accepts its provider-neutral port through explicit injection; Room and Demo Catalogue repositories authorize before accessing it and publish verified keys audit-atomically. No runtime entrypoint activates it yet, so PostgreSQL remains the active media store. See `PRIVATE-OBJECT-STORAGE.md` for its URL-free port, integrity checks and remaining cutover gates.

```text
Browser (untrusted)
  -> same-origin HTTPS /api/*
     -> src/server.js: bounded Node HTTP server
        -> src/app.js: transport composition and route dispatch
           -> src/identity/session-service.js: session/CSRF/Principal boundary
              -> src/persistence/postgres/session-repository.js
                 -> PostgreSQL 18
           -> src/tenancy/tenant-context.js: Principal-derived Tenant context
              -> application services
                 -> src/authorization/policy.js
                 -> Tenant-scoped PostgreSQL repositories
           -> src/audit/audit-service.js
              -> src/persistence/postgres/audit-repository.js
                 -> PostgreSQL 18 append-only HMAC chain

Microsoft Entra ID (external and untrusted)
  -> src/identity/entra-client.js: OIDC protocol validation
     -> provider-neutral external identity
        -> Tenant claiming or JIT User resolution
           -> provider-neutral application session issuance

Microsoft identity platform / Microsoft Graph (external and untrusted)
  -> src/integrations/microsoft365-client.js: fixed destinations and bounded transport
     -> Tenant-scoped admin consent and base-permission verification
        -> src/application/microsoft365-connection-service.js
           -> PostgreSQL connection/consent state and audit evidence

Microsoft Places, free/busy and calendar capability adapters
  -> fixed Microsoft Graph endpoint templates
     -> validated provider-neutral calendar result
        -> existing booking integration service
```

Provider claims, Microsoft response bodies and provider SDK types do not cross into business services. The Entra adapter validates and maps external identity before session issuance. The Microsoft 365 client positively validates connection, Places, free/busy and calendar-event results before application services see provider-neutral values. New provider capabilities must preserve the URL-free booking contract and outbound controls defined by `docs/THREAT-MODEL.md`.

## Module responsibilities

- `src/config.js` owns runtime, database, Entra, Microsoft 365, session and audit-secret configuration with fail-closed Pilot/Production validation.
- `src/api-error.js` owns safe public error classification, including authorization concealment, audit-integrity failures, Tenant settings revision conflicts, Request composition failures and Microsoft 365 lifecycle errors.
- `src/domain/identifiers.js` owns stable internal UUID validation.
- `src/domain/request-workflow.js` owns canonical Request status and transition identifiers.
- `src/domain/request-composition.js` owns the closed v2 draft, platform participant bound,
  authoritative integer-minor pricing and immutable composition snapshot contract.
- `src/domain/request.js` validates versioned canonical Request records returned from persistence and
  owns the explicit public v1/v2 projection.
- `src/domain/site-time-zone.js` validates bounded server-runtime IANA Site time-zone identifiers.
- `src/domain/tenant-locations.js` owns the provider-neutral Locations/Rooms schema and set-transition rules.
- `src/domain/tenant-organization.js`, `tenant-catalogue.js`, `tenant-booking-policies.js` and `tenant-cost-allocation.js` own their bounded SaaS 2 business representations and validation; none is a generic settings model.
- `src/security.js` owns generic HTTP-boundary validation, security headers, rate limiting, JSON validation and the transport Principal guard.
- `src/identity/principal.js` owns provider-neutral trusted-identity and internal-Principal shapes.
- `src/identity/entra-client.js` owns fixed-authority Entra authorization-code/PKCE handling and positive token/claim validation.
- `src/identity/entra-auth-service.js` owns one-time OIDC transaction orchestration, provider identity resolution and application-session issuance.
- `src/identity/provider-identity-resolver.js` routes validated external identities to Tenant claiming or JIT User resolution without exposing provider claims to business code.
- `src/identity/jit-user-service.js` maps an active Tenant identity binding and validated provider User reference to an internal User and server-controlled role/permission snapshot.
- `src/identity/session-cookie.js` owns strict `cm_session` parsing, serialization and cookie attributes.
- `src/identity/session-service.js` owns opaque token generation, source-controlled Customer authorization-epoch hashing, CSRF derivation/verification, issuance, resolution, rotation and revocation.
- `src/onboarding/tenant-onboarding-service.js` owns invitation redemption, explicit Tenant claim confirmation, binding lifecycle and associated audit evidence.
- `src/tenancy/tenant.js` owns Tenant lifecycle semantics and the Tenant-owned resource inventory.
- `src/tenancy/tenant-context.js` resolves Tenant context exclusively from the authenticated Principal's internal Tenant ID.
- `src/tenancy/tenant-scoped-repository.js` enforces generic Tenant-scoped persistence ports.
- `src/authorization/policy.js` owns recognized Tenant roles/permissions, capability checks, object ownership, Request transition authorization and Tenant audit-read capability.
- `src/application/request-service.js` coordinates Tenant-scoped Request/history loading,
  authorization, optimistic workflow writes and correlated audit outcomes.
- `src/application/booking-change-service.js` coordinates confirmed-change propose/decision progression, including intentional same-manager self-approval, provider compensation and minimized authorization-denial evidence.
- `src/application/production-application-service.js` owns the server-authoritative browser
  application contract, Request v2 create/resubmit use cases, bounded canonical-Request reporting,
  legacy Site reads and the fail-closed Site-time-zone booking gate. `request-report.js` owns only
  the strict UTC range/opaque keyset-cursor value contract.
- `src/application/tenant-settings-revision.js` owns only the shared SaaS 2 schema/revision primitive and deterministic stale-write conflict semantics; aggregate business fields and persistence stay with their bounded owners.
- `src/application/tenant-location-administration-service.js` owns authorized versioned Locations/Rooms administration and rollback orchestration. It classifies persisted diffs into Tenant Admin technical, Conference Manager Room-business or mixed dual-role authority.
- `src/application/tenant-organization-service.js`, `tenant-catalogue-service.js`, `tenant-booking-policy-service.js` and `tenant-cost-allocation-service.js` own their authorized, independently versioned SaaS 2 use cases. Catalogue is Conference Manager-owned; Organization, Booking Policies and Cost Allocation are Tenant Admin-owned.
- `src/application/tenant-presentation-service.js` projects the current Organization revision into an all-role, Tenant-derived, business-metadata-free presentation contract. `managed-brand-preset-policy.js` admits and resolves only fixed code-shipped preset references; it has no upload, URL or storage integration.
- `src/application/tenant-user-administration-service.js` owns authorized Tenant role reads/writes, last-admin protection and stale-session invalidation through User security versions.
- `src/application/tenant-user-lifecycle-service.js` owns Tenant-scoped User listing, disable/reactivate concurrency, last-admin protection and session revocation without duplicating role assignment.
- `src/audit/tenant-audit-query-service.js` owns bounded filtered audit reads while retaining full-chain integrity verification.
- `src/application/tenant-capability-view-service.js` composes server-owned Tenant, authority, entitlement, rollout and provider-readiness state into a read-only customer view.
- `src/application/microsoft365-connection-service.js` owns Tenant Admin authorization, Entra-binding corroboration, one-time consent state, connection verification, reconnect/disconnect and audit-safe public results.
- `src/http/microsoft365-routes.js` owns the strict same-origin Microsoft 365 HTTP contract, callback query allowlist and fixed result redirects.
- `src/http/settings/locations.js` owns the registered bounded Locations/Rooms route module.
- the other modules in `src/http/settings/`, plus `src/http/tenant-audit-query-routes.js`, own the registered Organization, minimized Tenant presentation, Catalogue, Booking Policies, Cost Allocation, User lifecycle, capability-view and audit-query HTTP contracts.
- `src/integrations/microsoft365-client.js` owns fixed Microsoft identity/Graph origins, admin-consent URL construction, application-token acquisition, bounded provider transport and base-permission verification.
- `src/audit/event.js` owns the fixed event taxonomy, bounded secret-minimized event validation and canonical integrity payload.
- `src/audit/audit-service.js` derives Tenant, actor and time from trusted context, authorizes Tenant audit reads and records denial/read evidence.
- `src/entitlements/capabilities.js` owns stable product capability IDs and the authorization/entitlement/rollout intersection.
- `src/entitlements/entitlement-service.js` owns fail-closed Tenant capability evaluation and deny-by-default operator entitlement changes.
- `src/integrations/calendar-contract.js` owns the provider-neutral calendar port, response validation and stable provider failure taxonomy.
- `src/integrations/booking-reference.js` owns the opaque provider-reference persistence model.
- `src/application/booking-integration-service.js` coordinates authorized and entitled availability, reservation validation and idempotent calendar operations without provider-specific types.
- `src/persistence/postgres/pool.js` owns bounded PostgreSQL pooling, TLS policy and exact schema readiness.
- `src/persistence/postgres/session-repository.js` owns session persistence and authoritative expiry, revocation and security-version checks.
- `src/persistence/postgres/request-repository.js` owns Tenant-scoped Request lookup, coherent
  current-configuration evaluation, immutable Request snapshots/history, the request-authorized
  current-Room/Site presentation read and status/version-conditional workflow updates.
- `src/persistence/postgres/audit-repository.js` owns per-Tenant append serialization, HMAC signing, Tenant-scoped listing and chain verification.
- `src/persistence/postgres/entitlement-repository.js` owns Tenant-scoped entitlement reads and audit-atomic entitlement changes.
- `src/persistence/postgres/booking-reference-repository.js` owns Tenant-scoped room-conflict lookup and audit-atomic opaque provider-reference persistence.
- `src/persistence/postgres/application-repository.js` owns the coherent repeatable-read,
  Tenant-scoped Request-drafting catalogue plus profile and notification persistence. Versioned
  Site/Room writes belong only to the Locations owner.
- `src/persistence/postgres/tenant-onboarding-repository.js` owns Tenant invitation, identity-binding and claim persistence.
- `src/persistence/postgres/jit-user-repository.js` owns internal User/provider binding persistence and profile synchronization.
- `src/persistence/postgres/tenant-user-admin-repository.js` owns Tenant role persistence, concurrency control and last-admin enforcement.
- `src/persistence/postgres/microsoft365-connection-repository.js` owns Tenant-scoped Microsoft 365 connection state, actor-bound one-time consent transactions, optimistic versions and audit-atomic lifecycle changes.
- `src/persistence/postgres/tenant-location-repository.js` owns Tenant-scoped Locations/Rooms snapshots, revision concurrency and audit-atomic mutation.
- the bounded Tenant Organization, Catalogue, Booking Policy, Cost Allocation, User Lifecycle and Audit Query repositories own only their respective Tenant-scoped SQL and transaction contracts.
- `src/persistence/postgres/transaction.js` owns the common commit/rollback transaction boundary.
- `src/persistence/postgres/index.js` composes the PostgreSQL repositories and readiness checks.
- `scripts/db-migrations.mjs` owns source-controlled migration discovery, checksums, advisory locking and transactional up/down execution.
- `src/logger.js` owns bounded non-sensitive operational logs, separate from durable audit evidence.
- `src/app.js` composes transport, session, CSRF, Tenant, audit and application boundaries without importing PostgreSQL or provider SDKs.
- `src/customer-composition.js` composes the reusable customer application/runtime graph from
  injected persistence, identity, provider, HTTP, logging and metrics adapters.
- `src/index.js` is the Production customer entrypoint. It supplies the real Entra/Microsoft
  adapters and owns start, stop and signal handling.
- `src/platform-composition.js` composes the reusable Platform application/runtime graph;
  `src/platform-main.js` supplies Production Platform authentication and owns process lifecycle.
- `src/platform/http/` owns the separate authenticated Platform HTTP boundary. Platform readiness is read-only; Tenant, invitation, lifecycle, entitlement and recovery mutations require the Platform session/Principal, CSRF, operation permission, target scope, step-up and the applicable confirmation, concurrency, idempotency and audit contracts.
- `src/demo/customer-main.js` and `src/demo/platform-main.js` are the independent customer and
  Platform Demo composition roots. They reuse the canonical application/persistence boundaries,
  add only the bounded Demo session/persona/reset routes, and connect through distinct roles to one
  isolated Demo PostgreSQL database.
- `src/demo/provider/microsoft365-client.js` implements deterministic provider-neutral Microsoft
  outcomes without network access. `src/demo/fixture.js` owns the source-defined seed version and
  semantic checksum; `src/persistence/postgres/demo-reset-repository.js` owns the sentinel-verified,
  exclusively locked, transactional reset/readback contract.
- `scripts/demo-db-migrations.mjs` owns the independent checksum-protected Demo overlay migration
  ledger after verifying the exact canonical schema `001..044`.
- `scripts/platform-break-glass-grant.mjs` and `scripts/platform-recovery-fallback.mjs` are the only local privileged mutation wrappers. They accept credentials only through fixed descriptors and require live Platform sessions plus a dual-control, exact Tenant/permission-bound, one-use grant. The retired process-local Tenant-operator runtime and package entry point are prohibited.
- `scripts/check-architecture.mjs` prevents architecture, migration and composition drift.
- `scripts/check-security-baseline.mjs` prevents drift between the documented Pilot/Production security baseline and executable controls.
- `scripts/security-dast.mjs` exercises the real HTTP server in isolated Test mode.
- `docs/ENTRA-AUTHENTICATION.md` defines the Entra authentication and Tenant-claiming contract.
- `docs/MICROSOFT365-CONNECTION.md` defines the Microsoft 365 connection lifecycle and provider trust boundary.
- `docs/TENANT-SETTINGS-CONTRACTS.md` defines the bounded SaaS 2 aggregate versioning, concurrency, history and rollback contract without creating a generic settings owner.
- `docs/REQUEST-COMPOSITION.md` defines Request v2 drafting, pricing, configuration snapshot,
  version/history and legacy compatibility semantics.
- `docs/SHARED-DEMO-RUNTIME.md` defines the Shared Demo composition, configuration, migration,
  seed/reset, security and operations contract.
- `docs/THREAT-MODEL.md` is the canonical SaaS threat, control and residual-risk model.
- `docs/PRODUCTION-SECURE-CONFIGURATION.md` is the canonical Pilot/Production deployment security baseline.
- `docs/PILOT-PENETRATION-TEST.md` defines the independent Pilot security-assessment scope and exit criteria.

## Dependency direction

HTTP handlers call security, identity, Tenant, application and audit contracts. Application services call authorization/domain policies and repository/provider ports. Application, domain and authorization code must not depend on Node HTTP objects, `pg`, migrations, raw provider claims or provider SDK types.

PostgreSQL adapters implement repository contracts using fixed source-controlled SQL and parameter binding. Identity-provider adapters translate validated provider claims to internal identity contracts before business/session code sees them. Microsoft provider adapters construct fixed endpoint templates internally and translate validated provider results into bounded internal contracts before application services consume them.

Security governance and test scripts may inspect repository source and configuration, but they do not become runtime dependencies and must not introduce alternate business rules.

Production composition roots must not import `src/demo/`, register Demo routes or instantiate the
simulated provider. Demo composition roots must not instantiate Entra or the real Microsoft client.
Architecture gates enforce both directions so a Production dependency failure cannot select Demo
behavior and a Demo request cannot perform external provider I/O.

## Tenant and identity trust boundary

Tenant identity is never selected from a client header, query parameter, route parameter or body field. Session resolution produces an internal Principal; Tenant context loads the canonical Tenant using only `principal.tenantId`.

The internal Principal contains internal User/Tenant IDs, a normalized provider identity reference, approved roles/permissions and bounded session metadata. Provider-specific claim structures remain outside this contract.

The public session endpoint intentionally omits provider identity references, internal session IDs, token hashes and provider tokens.

Microsoft Entra remains external and untrusted until `src/identity/entra-client.js` validates OIDC signature, issuer, audience, state, nonce, time and organizational-account policy. The validated external Tenant/User references are then resolved through server-side Tenant identity bindings and JIT User persistence before an application session is issued. Email domains, display names, browser-selected Tenant IDs and raw Entra group claims are not authorization authority.

A Microsoft 365 connection is bound to the already claimed Entra Tenant. The callback provider Tenant value corroborates that binding and the one-time consent transaction; it never selects the internal Tenant.

An authorized pre-activation identity unbind is a security-authority revocation, not a metadata edit. In one transaction it requires every booking-provider reference to be terminal `cancelled`, marks the binding unbound, increments Tenant User security versions, revokes active sessions, deletes pending Microsoft consent transactions, disconnects Microsoft 365 and clears its verification/permission state.

## Authorization architecture

Business authorization is deny-by-default and occurs after Principal and Tenant resolution.

The recognized Tenant roles are `employee`, `conference_manager` and `tenant_admin`. `platform_admin` is intentionally outside this Tenant role model. Unknown roles or permissions invalidate the Principal for business authorization.

A capability requires both a recognized permission on the server Principal and a role allowed to use that permission. Role alone and permission alone are insufficient.

Request repositories always receive the server-resolved internal Tenant ID. Employee Request access additionally checks `request.requesterUserId === principal.userId`. Non-owned Employee objects and cross-Tenant IDs are concealed as not found to avoid BOLA/IDOR existence disclosure.

Conference Manager Request scope is the authenticated internal Tenant. Tenant Admin capabilities remain separate from Conference Manager Request operations. Tenant audit access requires `tenant:audit:read`; Tenant role administration requires `tenant:users:manage`; Microsoft 365 connection administration requires `tenant:integrations:manage`.

Request workflow transitions are server-defined. The browser selects only a transition identifier and binds the command to the visible Request version with one strong `If-Match` tag; the policy determines eligible current state, target state, role/permission requirement and reason rule. An owning Employee may cancel an eligible own Request; a Conference Manager with `request:manage` may cancel any eligible same-Tenant Request, including another User's, from `Submitted`, `In Review`, `Confirmed` or `Change Requested`. `Rejected` is ineligible, an already-target read is idempotent only at the exact current version under the original command authority, Tenant Admin alone receives no management scope and no public physical-delete path exists. An immediately preceding version cannot prove which operation or actor produced the terminal state and fails closed. The application rejects stale versions before integration work. Persistence includes both the previously authorized status and exact Request version in its lock check and mutation predicate so same-status ABA and concurrent changes yield a conflict instead of a stale overwrite.

See `docs/AUTHORIZATION.md` for the complete role, permission and workflow matrix.

## Session architecture

The browser receives a 256-bit opaque `cm_session` cookie. PostgreSQL stores SHA-256 over the source-controlled namespace `customer-session:saas-3.6-role-policy-v1:<raw-token>`, never the raw token. Session resolution requires the current namespace hash, a matching non-revoked and non-expired row, active User, current User `security_version`, and session-available Tenant lifecycle state.

Cookie policy is `HttpOnly`, `SameSite=Lax`, `Path=/api`, no broad `Domain`, and `Secure` for HTTPS. Pilot/Production require HTTPS and therefore always use `Secure`.

Cookie-authenticated unsafe operations require an HMAC-derived synchronizer token supplied as `X-CSRF-Token`. Pilot/Production require the HMAC secret from deployment secret management.

Per-User role/permission changes increment `users.security_version`; matching sessions immediately fail when their stored `principal_version` becomes stale. A global authorization-map change increments the source-controlled Customer epoch and ships with a one-way revocation migration. Migration 034 revokes every still-active pre-cutover Customer session; its down migration removes bookkeeping only and never clears `revoked_at`. This prevents an old binary from resurrecting legacy unnamespaced cookies after rollback. A server-authorized rotation can create a replacement session with the newly approved snapshot and revoke the previous session atomically.

Session issue, revoke and rotation construct server-controlled security events. The PostgreSQL session repository commits success evidence in the same transaction as the session mutation.

See `docs/IDENTITY-SESSION.md` for the normative flow.

## Audit architecture

Tenant audit evidence is a durable security/business data model, not an operational log stream.

`src/audit/event.js` accepts only a fixed action, outcome and retention taxonomy, server identifiers/timestamps and bounded flat primitive state/metadata. Credential-sensitive field names and nested values are rejected.

`src/persistence/postgres/audit-repository.js` serializes appends per internal Tenant using a transaction-scoped advisory lock. Each event is HMAC-SHA-256 signed over a canonical payload and the previous Tenant event hash. `GET /api/v1/audit` verifies the complete Tenant chain before returning records.

Migration 004 installs a database trigger that rejects `UPDATE` and `DELETE` against `audit_events`. This prevents ordinary mutation while the HMAC chain detects modified or reordered rows if the key remains protected.

The integrity model does not provide external completeness proof against privileged deletion of an entire suffix or restoration of an older database snapshot. External anchoring/WORM export and independent retention remain deployment/governance decisions before stronger completeness claims are made.

See `docs/AUDIT.md` for the normative event/integrity contract.

## Persistence lifecycle

Schema ownership lives in `migrations/`. Migrations are paired up/down files, numerically versioned, checksum protected and serialized by a PostgreSQL advisory lock.

The application never auto-migrates at startup. Deployment automation runs migrations first. Runtime readiness requires database connectivity and exact expected schema version 44.

- Migration 001 establishes Tenant-owned product structures.
- Migration 002 adds User security-version state and server-side sessions.
- Migration 003 constrains authoritative Request workflow state and adds workflow reason/change timestamps.
- Migration 004 upgrades audit storage to the append-only HMAC-chained event contract.
- Migration 005 adds allowlisted Tenant entitlements and entitlement audit taxonomy.
- Migration 006 adds Tenant-scoped opaque booking-provider references.
- Migration 007 adds one-time OIDC authentication transactions.
- Migration 008 adds Tenant onboarding invitations, Tenant identity claims and bindings.
- Migration 009 adds JIT User identity bindings.
- Migration 010 adds Tenant role administration and claimant bootstrap state.
- Migration 011 adds Microsoft 365 connection lifecycle state and actor-bound one-time admin-consent transactions.
- Migration 012 adds Tenant-scoped Microsoft room mappings.
- Migration 013 adds the independent Microsoft calendar-write entitlement.
- Migration 014 adds Microsoft capability-health snapshots.
- Migration 015 adds the fixed Request-created audit action.
- Migration 016 adds the Tenant Pilot lifecycle audit action.
- Migration 017 binds each numbered pending calendar-create attempt to its provider connection/resource and idempotency key before external write.
- Migration 018 adds nullable authoritative Site IANA time zones without inventing values for legacy Sites.
- Migration 019 adds confirmed-booking change persistence and one-open-proposal enforcement.
- Migration 020 adds five independent Tenant settings revision counters and fail-closed rollback after first use, without assigning every aggregate to one role or adding a generic settings datastore.
- Migration 021 adds bounded Site/Room details and immutable Locations revision history without rewriting legacy Site time zones.
- Migration 022 adds bounded Organization settings and immutable Organization revision history, provisioning a neutral initial snapshot for existing and future Tenants.
- Migration 023 adds the bounded service/equipment/catering Catalogue model and immutable Catalogue revision history while retaining existing service identifiers.
- Migration 024 adds effective-dated Booking Policy configuration and immutable policy revision history.
- Migration 025 adds Tenant-scoped Cost Allocation configuration, cost-center master data and immutable allocation revision history.
- Migration 026 adds monotonic User lifecycle revisions without changing the existing security-version authority.
- Migration 027 adds Room pricing, Request schema/version snapshots, append-only Request history and
  full versioned confirmed-change proposal storage while preserving explicit legacy v1 facts.
- Migration 028 adds Tenant- and actor-scoped bulk-transfer validation receipts without persisting
  imported document payloads.
- Migration 029 adds the dedicated Platform operator, target-scope, session and authentication-
  transaction authority.
- Migration 030 adds append-only, HMAC-chained Platform audit evidence and its checkpoint state.
- Migration 031 adds Platform operation revisions, idempotency receipts, entitlement packages,
  recovery contexts, grant/alert state and the canonical transactional operations foundation.
- Migration 032 adds bounded readiness, Microsoft fleet-health and diagnostic projections.
- Migration 033 adds metering, quota and runtime-deployment inventories and their immutable history.
- Migration 034 irreversibly revokes all still-active pre-authorization-epoch Customer sessions. Its down migration cannot restore them, so old binaries cannot resolve superseded legacy cookies after rollback.
- Migration 035 adds exact Request composition v3 Equipment constraints without rewriting v1/v2 evidence.
- Migration 036 persists minimized requester and action attribution snapshots while retaining honest nullable legacy attribution.
- Migration 037 adds nullable Site Guest Information and immutable Locations-revision guest maps without changing exact v1 contracts.
- Migration 038 removes public execution of the Request-attribution marker and confines its migration-owner authority to schema-qualified SECURITY DEFINER triggers.

- Migration 043 adds canonical private Room-object metadata and immutable durable upload intents. PostgreSQL delivery remains active until the separately accepted backfill/cutover.

- Migration 044 atomically coalesces Platform projection invalidations per Tenant, with protected dispatch, bounded retries and an empty-queue rollback guard.

Every migration that removes security/business evidence includes a fail-closed rollback guard.

## Shared Demo architecture

The Shared Demo Runtime preserves the normal customer/Platform process separation while deliberately
sharing one isolated PostgreSQL state. The customer and Platform processes have separate HTTPS
origins, cookies, CSRF/session secrets and least-privilege database principals. Reset/seed and
migration ownership are separate additional roles; neither serves browser requests.

The customer and Platform compositions receive one dedicated shared Tenant-audit HMAC key because
both may append to or verify the same Tenant audit chains. Platform control-plane audit and cursor
integrity remain separate cryptographic domains derived from the Platform session secret; the
Tenant-audit key does not bridge sessions, CSRF or authorization.

Demo persona selection is presentation intent, not authority. The server maps an exact allowlisted
Tenant/persona or Platform persona to canonical roles, permissions, security version, target scope
and assurance, then issues a normal PostgreSQL-backed session. Persona switches require CSRF and
rotate authority; failure to revoke the prior session also revokes the replacement and fails the
operation. Customer and Platform session namespaces never cross.

Normal Demo requests take a shared PostgreSQL advisory lock. Reset validates the source fixture and
semantic checksum, takes the matching exclusive lock, and then verifies the immutable Demo
sentinel, database/role identity, complete canonical migration ledger and exact table inventory.
Truncate, seed and semantic readback commit together at `SERIALIZABLE` isolation. A reset clears all
sessions and returns only the pinned seed version/checksum; the HTTP route adds its server request
ID.

The Platform Demo composition refreshes its canonical projections under the shared gate before
listening. Its HTTP reset path performs the same bounded refresh after reset commit and before
returning success. Projection failure remains visible and is not represented as a rolled-back
authoritative reset.

The canonical schema now includes migrations `001..044`; the Demo-only overlay is independently tracked
as `demo-migrations/001..009`. Neither application process auto-migrates or auto-seeds. See
`docs/SHARED-DEMO-RUNTIME.md` for provisioning and operations.

## Request composition architecture

Request composition preserves the dependency direction instead of merging the five Tenant settings
owners. HTTP routes parse only closed envelopes. Application services authorize create, resubmit,
history and confirmed-change use cases. `src/domain/request-composition.js` validates and calculates
the provider-neutral business representation. PostgreSQL adapters reload the five independently
versioned authorities and persist the resulting snapshot; aggregate services and private
repositories are not imported across bounded domains.

Create, owner resubmit and confirmed-change proposal obtain one coherent Tenant configuration view
inside the Request transaction. The observed Organization, Locations, Catalogue, Booking Policies
and Cost Allocation revisions are concurrency tokens only. Under the Tenant/configuration locks,
the repository compares all five, resolves the active same-Tenant Room/Site and selected Catalogue
entries, evaluates current policy, calculates pricing and allocation, and persists the immutable
snapshot, append-only Request history and server audit evidence before commit. Stale or unavailable
authority never falls back to a browser-calculated result.

The application drafting catalogue remains active-only. A separate schema-version-1
`GET /api/v1/requests/{requestId}/room-context` read projection first applies the ordinary Request
object authorization and then uses only the server-loaded Room ID to present a retained inactive
current Room/Site. That small current presentation is not a historical snapshot, catalogue entry or
write authority; the five-owner composition transaction remains the sole mutation authority.

Every workflow mutation advances `request_version`; status-only changes retain the selected
composition facts while recording a new complete public history revision. Resubmission and an
applied confirmed change intentionally create a newly evaluated composition snapshot. Migration
027 makes legacy rows explicit schema v1/version 1 records with unavailable composition fields,
rather than fabricating historical price, policy or allocation facts.

See `docs/REQUEST-COMPOSITION.md` for the exact contract.

## Microsoft 365 connection architecture

`src/application/microsoft365-connection-service.js` is the trusted use-case boundary for Microsoft 365 Tenant connection administration. It requires the authenticated internal Tenant Admin role, `tenant:integrations:manage`, the Principal-derived Tenant context and an active Entra Tenant binding.

The browser cannot supply an internal Tenant ID or provider Tenant authority. Consent state is 256-bit random data; only its SHA-256 hash is stored. The transaction is bound to internal Tenant, actor User, Integration, provider Tenant, optimistic connection version and expiry. Starting a new connection invalidates older pending consent state. Callback replay, actor mismatch, expiry, changed binding and stale connection versions fail closed.

The provider client uses fixed Microsoft identity and Graph origins, disables redirects, bounds request time and provider request/response size, validates provider response shapes and maps provider failures to stable internal classifications. The base connection verifies `Place.Read.All` and `Calendars.ReadBasic.All`; it does not claim calendar write access.

See `docs/MICROSOFT365-CONNECTION.md` for the normative contract.

## Booking and calendar integration architecture

`src/application/booking-integration-service.js` is an internal use-case boundary, not a browser endpoint. It preserves Employee/Conference Manager workflow semantics and requires same-active-Tenant binding, explicit server authorization and configured Tenant entitlement before provider access.

Availability and provisional/final reservation validation first apply the Tenant-scoped local overlap rule. Provider-specific room/resource mapping remains inside provider adapters. Calendar create uses a deterministic server-derived SHA-256 idempotency key per numbered attempt so recovery of a pending external success can reuse the same provider event, while a retry after completed compensation receives a new key.

Migration 017 extends the migration-006 reference so the attempt number, exact provider connection identity, create-time resource and deterministic key are audit-atomically persisted as `pending` before provider access. The real provider event reference is nullable only in that state and is finalized as `active` after Graph returns. Reserve/finalize and the final Request commit lock and revalidate the exact connected Integration and active Entra binding. A write-enabled final commit also share-locks the exact active provider reference. Compensation and write-disabled pre-confirm cleanup require the exact eligible Request version under a Request share lock before changing `active` to `compensating`; therefore a parallel confirmation either commits while retaining the event or loses to already-owned cleanup. After external delete, write-disabled final confirmation locks the single exact `compensated` reference and changes it to terminal `cancelled` with Calendar audit evidence in the successful Request transaction after its room-conflict check. A conflict retains `compensated` for retry. Authority loss after create likewise moves the reference through `compensating` to `compensated`; a later confirmation starts the next numbered attempt with a new key/current mapping. Pending reconciliation and cancellation keep using the persisted resource even after remapping or local disconnect. External provider work cannot participate in the PostgreSQL transaction; recovery uses persisted binding, idempotency and explicit compensation rather than claiming distributed atomicity.

Migration 018 stores `sites.time_zone` as nullable for pre-existing Sites. Catalog/Site-info/Configuration expose it as `timeZone`; Configuration writes require a valid IANA identifier. Request creation and room availability require the selected active room's active Site to have a valid value and share the exact canonical UTC interval contract with a 24-hour maximum. Request v2 additionally caps total participants at 500 and resolves Room price, service/catering applicability, policy and allocation only from current Tenant-scoped server state. Neither the backend nor browser may substitute browser-local time or UTC for an unknown Site zone or submit a price/policy fallback.

The Microsoft 365 connection lifecycle establishes and verifies the Tenant connection boundary. Separate implemented adapters provide Places discovery, room/resource mapping, free/busy, final availability enforcement and entitlement-gated event create/update/cancel while preserving fixed destinations, bounded transport, positive provider validation, least privilege, Tenant scoping, explicit retry classification and provider-neutral contracts. The post-confirmation proposal aggregate accepts a complete expected-version v2 composition, snapshots current authority and owns participant-only atomic application, manager approval, conflict revalidation, same-room update and compensated room replacement. Live Microsoft acceptance remains an external gate in issues #64, #66, #68 and #69.

See `docs/BOOKING-INTEGRATION.md` and `docs/MICROSOFT365-CONNECTION.md`.

## Foundation endpoints

- `GET /api/v1/health/live` proves only process liveness.
- `GET /api/v1/health/ready` exposes only `ready` or `not_ready`; PostgreSQL connectivity and exact schema version are dependencies.
- `GET /api/v1/health/status` exposes only aggregate operational and bounded build/environment state.
- `GET /api/v1/session` resolves the PostgreSQL-backed session, validates recognized roles/permissions and returns minimized presentation context plus CSRF token.
- `DELETE /api/v1/session` requires Principal and CSRF, revokes the session, persists audit evidence and clears the cookie.
- `GET /api/v1/requests/{requestId}` performs active-Tenant and object-level Request authorization.
- `GET /api/v1/requests/{requestId}/history` applies the same object scope and returns bounded
  append-only Request revisions.
- `GET /api/v1/requests/{requestId}/room-context` applies that object scope before returning the
  current minimized Room/Site presentation for the Request's server-loaded Room ID.
- `POST /api/v1/requests/{requestId}/transitions` additionally requires CSRF and a strong `If-Match` Request-version precondition, then executes only a server-defined authorized transition.
- `POST /api/v1/application/requests` creates only complete schema-v2 Requests from current
  server-authoritative Tenant configuration.
- `POST /api/v1/application/requests/{requestId}/resubmissions` performs owner-only,
  expected-version v2 resubmission from `Change Requested`.
- `GET /api/v1/application/reports/requests` returns Conference-Manager-only, bounded UTC
  range/keyset pages of the same canonical public Request representation with explicit completeness.
- `GET /api/v1/audit` requires Tenant Admin plus `tenant:audit:read` and verifies Tenant audit integrity.
- `GET /api/v1/tenant/users` and `PUT /api/v1/tenant/users/{userId}/roles` expose Tenant-scoped role administration.
- `GET /api/v1/integrations/microsoft365` reads minimized Microsoft 365 connection state.
- `GET/PUT /api/v1/tenant/settings/locations` reads or updates the versioned Locations/Rooms aggregate. Reads accept either owning capability; persisted technical/Room-business/mixed diffs require the corresponding Tenant Admin, Conference Manager or dual-role authority.
- `GET /api/v1/tenant/settings/locations/history` and its revision route expose bounded immutable history to either Locations-owning capability.
- `POST /api/v1/tenant/settings/locations/rollback` creates a new revision from a historical snapshot and authorizes the resulting persisted diff.
- `GET/PUT /api/v1/tenant/settings/catalogue` is Conference Manager-owned through `tenant:catalogue:manage`; Tenant Admin alone is denied.
- `POST /api/v1/integrations/microsoft365/connect` starts actor-bound admin consent.
- `GET /api/v1/integrations/microsoft365/callback` validates and consumes the fixed callback contract.
- `POST /api/v1/integrations/microsoft365/verify` revalidates the base connection.
- `DELETE /api/v1/integrations/microsoft365` disconnects local connection state.

## Rate limiting and edge responsibility

`src/transport/conditional-get.js` is an import-free, authority-free shared transport value
contract for bounded conditional GET and public-static encoding negotiation. Customer image
responses use it only after current authorization/verified media loading; both Demo static
surfaces use it through the existing injected filesystem port. It cannot access sessions,
database/provider state, environment, network or application/domain authority. Static digest
verification, bounded compression/cache and copied-HTML fingerprint packaging are described
in `HOSTED-DEMO-DEPLOYMENT.md`; the Customer/Platform identity boundaries remain separate.

The foundation rate limiter is local, in-memory and bounded. It is not a multi-instance quota service. Pilot/Production require trusted edge/shared abuse controls. Forwarded client-address headers are not currently trusted; introducing a trusted-proxy key model requires separate review.

## Production security release boundary

`docs/THREAT-MODEL.md` maps current and remaining Entra/Graph boundaries to concrete threats, OWASP/CWE classes, executable evidence and residual risks.

`docs/PRODUCTION-SECURE-CONFIGURATION.md` defines the Pilot/Production baseline for HTTPS/TLS, headers, cookies/CSRF, CORS, database TLS, secrets, provider egress, environment separation, observability and deployment blockers.

`npm run check` includes architecture, security-baseline, static, secret, dependency, style, unit and live HTTP DAST-smoke gates. PostgreSQL changes additionally require the PostgreSQL 18 integration job. These gates do not replace DAST against the actual Pilot edge or the independent penetration test defined in `docs/PILOT-PENETRATION-TEST.md`.

## Remaining SaaS 1 ownership

- Real independent Entra Tenant authentication and Tenant-claim acceptance evidence remains tracked by #58 and #59; their repository identity/JIT paths are implemented.
- The Microsoft 365 connection API/lifecycle is implemented; #62 retains live admin-consent and cross-repository browser acceptance evidence.
- Places discovery, room/resource mapping, free/busy, final availability and create/update/cancel synchronization are implemented. Issues #64-#68 retain live Microsoft acceptance; #68's remaining external gate is live update/move acceptance rather than an internal workflow gap.
- Exchange Online Application RBAC implementation guidance and evidence tooling exist; real customer-Tenant scope evidence remains #69.
- Issues #70-#73 retain their unproven external/operational acceptance, isolation, recovery and runbook evidence rather than standing for the already implemented provider adapters.
- The #114 backend create/list/transition and room-availability contracts are implemented. Production hosting/IaC, cross-repository frontend acceptance and production-like secure E2E evidence remain external gates across #113-#115; they do not own the missing post-confirmation update workflow.
- Platform Admin/developer operator Principal and audit APIs remain a separate authorization domain.
- External audit anchoring/WORM retention and selected-platform backup/restore evidence remain operational/governance decisions before stronger completeness or recovery claims are made.

## Equipment composition rollout

Migration 035 adds exact Request composition v3 Equipment constraints to the existing Request,
revision and booking-change JSON snapshots. Existing v1/v2 data is not rewritten. Create,
resubmit, transition, history and confirmed-change paths support the accepted nested version,
while the outer response envelopes remain unchanged. Equipment is resolved using existing
Tenant-composite Catalogue tables, charged once and included in allocation.

The `saas-3.6-shared-demo-v5` reset fixture contains distinct priced Northwind/Contoso Equipment
and verifies those identity, price and applicability facts during semantic readback. Demo overlay
004 grants only the reset role's `INSERT` and `TRUNCATE` access to the canonical attribution
migration-state table; customer and Platform roles receive no access. Apply canonical migrations
first, apply Demo overlays 001 through 008, reset/reseed Demo, deploy both API processes at one
compatible SHA, verify Catalogue pages and then pin/deploy the updated frontend. Down 035 refuses
once any v3 snapshot/proposal/history exists; use a compatible binary or a forward fix. Production
never activates Demo authority.

## Site Guest Information boundary

`site-guest-information.js` is a provider-neutral exact-schema public-presentation validator with a fixed public map-origin allowlist and no imports or network transport. Locations v2 owns its Site configuration; the existing Request service authorizes before a final Tenant/Request/version/status-bound repository projection. Separate Site/revision columns preserve v1 writers and immutable history. See `docs/SITE-GUEST-INFORMATION.md`.


## Platform projection invalidation

`platform-projection-repository.js` owns both affected-Tenant outbox dispatch and slow reconciliation;
both reuse the existing authoritative-source projection policy. Migration 044 records demand and
marks snapshots stale in the source transaction. `platform-projection-notifications.js` owns one
optional fixed-channel, empty-payload PostgreSQL LISTEN connection, not business event authority.
`projection-worker.js` serializes bounded dispatch, coalesces wakeups, reconnects at the existing
poll cadence, and awaits pending subscription/release work on shutdown. No HTTP route writes
outbox state and no application/domain module imports the database listener. See
[Platform Projection Outbox](PLATFORM-PROJECTION-OUTBOX.md).
