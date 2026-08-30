# Platform Operations Application Contracts

## 1. Scope

This document defines the internal application/use-case boundary for Platform Control Plane operations assigned to SaaS 3 issues
`#93`, `#94`, `#95`, `#97`, `#99`, and `#101`.

The implementation lives under `src/platform/application/`. It deliberately does not provide HTTP routes, PostgreSQL adapters,
migrations, identity/session composition, or audit persistence. Those adapters must depend on these use cases and preserve the
trusted-boundary rules below.

The application layer:

- consumes a server-resolved Platform Principal, never raw identity-provider claims or browser-selected roles;
- authorizes every use case through the canonical `src/platform/identity/policy.js` permission registry;
- returns positive, minimized DTOs rather than persistence or provider records;
- delegates existing Tenant lifecycle, readiness, entitlement, mapping, onboarding, session, and unbind rules to injected canonical
  policies/services;
- requires explicit compare-and-set, evidence, idempotency, and transactional ports for mutations;
- does not expose a generic command, query, SQL, log, Graph, shell, or impersonation surface.

## 2. Canonical authorization mapping

`platformPermissionForOperation` is the only application mapping from a use-case operation to a Platform permission. The mapping is
covered exhaustively by `tests/platform-operations-contract.test.js`.

| Application operation | Canonical permission |
| --- | --- |
| `tenant.directory.read` | `platform:tenant:read` |
| `tenant.invitation.create`, `tenant.invitation.revoke`, `tenant.invitation.reissue` | `platform:invitation:manage` |
| `tenant.lifecycle.transition` | `platform:lifecycle:manage` |
| `tenant.entitlement.read` | `platform:entitlement:read` |
| `tenant.entitlement.apply` | `platform:entitlement:manage` |
| `tenant.readiness.read` | `platform:readiness:read` |
| `tenant.microsoft_health.read` | `platform:integration-health:read` |
| `tenant.diagnostics.summary.read` | `platform:diagnostics:read` |
| `tenant.diagnostics.correlation.read` | `platform:diagnostics:sensitive` |
| Recovery actions other than session revocation | `platform:recovery:execute` |
| Tenant/user session revocation | `platform:session:revoke` |

The canonical policy owns MFA and step-up decisions. A `PlatformAuthorizationError` is deliberately translated to a presentation-safe
`PlatformOperationDeniedError`; policy configuration/programming failures are not hidden as ordinary denials.

## 3. Common port contracts

### 3.1 Authorization

Every factory receives `platformAuthorizationPolicy` with:

```js
platformAuthorizationPolicy.authorize(platformPrincipal, canonicalPermission) -> true | throws
```

`platformPrincipal` must originate from the dedicated Platform session resolver. It is not a Tenant Principal and must never be
synthesized from a customer session.

### 3.2 Evidence factory

Mutation services receive:

```js
operationEvidenceFactory.createMutation({
  authorization,
  operation,
  tenantId,
  correlationId,
  reason,
  target,
  previousState,
  requestedState,
  occurredAt,
}) -> opaqueEvidence
```

Diagnostics and recovery previews also require:

```js
operationEvidenceFactory.createSensitiveRead({
  authorization,
  operation,
  tenantId,
  correlationId,
  target,
  occurredAt,
}) -> opaqueEvidence
```

The integration adapter must create normalized Tenant and/or Platform audit events from these values. `previousState` and
`requestedState` are inputs to the evidence adapter, not permission to store arbitrary nested data in an audit event. The adapter must
apply the Platform audit event's bounded scalar metadata contract.

For every mutation, the transaction port must commit the authoritative state change, Tenant audit where applicable, Platform audit,
and the operation receipt atomically. Returning success before all required evidence is durable is prohibited.

For diagnostics and recovery preview reads, the named `*AndRecordAccess` or preview issue transaction must durably append required
Platform access evidence before returning protected data.

### 3.3 Tenant target policy

Permission authorization is necessary but not sufficient. Every direct Tenant use case also calls the injected server-owned policy:

```js
tenantTargetPolicy.authorize(platformPrincipal, internalTenantId) -> true | throws
```

This happens after permission authorization and before any Tenant reader, receipt, inspector, or transaction. A browser-selected target
never becomes scope authority. Concurrent calls retain independent target decisions; one permitted target cannot authorize another.

Fleet readers call:

```js
tenantTargetPolicy.queryScope(platformPrincipal) -> immutableServerScope
```

The returned scope is passed to the reader inside the authorization envelope. Directory, readiness, health, package/global metadata,
and other fleet adapters must apply the global/allowlist scope in the authoritative SQL query before filtering, pagination, counts,
cursor generation, or caching. Post-query application filtering is prohibited. Cursor signatures and cache keys must bind the scope's
security version/key so a cursor or cached page cannot cross operators or allowlist revisions.

### 3.4 Idempotency receipts

Mutation services call:

```js
operationReceiptReader.find({
  authorization,
  operation,
  tenantId,
  idempotencyKey,
}) -> null | { requestDigest, result }
```

The reader must scope lookup by the authenticated operator identity, operation, target Tenant, and idempotency key. It must not perform
a global key lookup followed by application filtering.

The receipt lookup occurs after authorization but before reading mutable current state. This allows an exact retry after a successful
commit to return its stable receipt instead of incorrectly failing the old expected revision. A matching key with a different request
digest fails with `PLATFORM_IDEMPOTENCY_KEY_CONFLICT`.

Transaction ports receive `requestDigest` and `idempotencyKey`. They must atomically claim the key and re-check its digest to close the
race between receipt lookup and mutation. A racing exact retry returns an `idempotent` safe result. A racing different request fails.

Invitation reissue receipts must never contain the raw invitation token. The first successful call may return
`oneTimeDelivery: { available: true, token, expiresAt }`; all receipt and racing-idempotent responses return only
`oneTimeDelivery: { available: false }`.

### 3.5 Page ports

Fleet and directory readers return:

```js
{
  items: [],
  nextCursor: null | opaqueSignedCursor,
  snapshotAt: canonicalUtcTimestamp,
}
```

Persistence owns signed keyset cursor encoding/verification. A cursor must bind the operator scope, filter set, page direction, and
snapshot/watermark. Pages must not exceed the requested limit.

## 4. Tenant directory, invitation, and lifecycle operations (`#93`)

Factory: `createPlatformTenantOperationsService`.

Public use cases:

- `listDirectory({ operatorContext, query })`
- `createTenantInvitation(input)`
- `revokeInvitation(input)`
- `reissueInvitation(input)`
- `transitionLifecycle(input)`

The directory DTO contains only Tenant ID, display name, lifecycle status/revision, onboarding state, minimized identity state,
invitation ID/state/revision/expiry, and update time. Invitation ID and revision are operator target/concurrency values, not secrets;
both are `null` only for `none`, and all other states require both. Provider Tenant references, provider subjects, invitation tokens or
hashes, claims, customer content, and secret material are discarded even if a reader returns them.

Creation requires a bounded display name, reason, exact action/display-name confirmation, correlation ID, and idempotency key. Its
receipt is checked before IDs or a secret are generated. The injected ID factory generates distinct internal Tenant and invitation
IDs. The purpose-bound `invitationSecretFactory.issue` returns the raw token, hash, and expiry; only the hash and expiry cross the
transaction port. `invitationTransactions.create` must create the pending Tenant and first open invitation, write both audit domains,
and store a secret-free receipt atomically. Generated or persistence identifier collision fails closed rather than silently changing
the target of the request.

Revoke/reissue mutations additionally require Tenant and invitation IDs and expected invitation revision. Reissue must revoke the
previous open invitation, persist the new invitation hash and lineage, write both audit domains, and store the secret-free receipt in
one transaction.

Lifecycle transitions first load authoritative status/revision, delegate normal transition validity to the injected
`lifecyclePolicy.requireTransition`, and use `lifecycleTransactions.compareAndSet`. The only application extension is the explicit
terminal archive policy: `suspended -> archived`; no transition is possible out of `archived`. Archive is logical retention, never
physical deletion.

The lifecycle transaction must re-check expected status/revision and the canonical readiness precondition under its lock. Outcomes are
`updated`, `idempotent`, `stale`, or `not_ready`.

## 5. Entitlement and package operations (`#95`)

Factory: `createPlatformEntitlementOperationsService`.

Public use cases:

- `listCapabilities`
- `listPackages`
- `getTenantEntitlements`
- `previewEntitlementChanges`
- `applyEntitlementChanges`
- `previewPackage`
- `applyPackage`

`capabilityPolicy.list()` must adapt the canonical capability registry. Future dependency metadata belongs with the existing
`src/entitlements/capabilities.js` authority; a persistence adapter or Platform-only second capability registry is prohibited.

Packages are versioned descriptive templates. They never become an access-control input. Preview overlays a direct or package proposal
onto the authoritative Tenant entitlement snapshot and verifies:

- capability IDs are known and unique;
- every enabled capability has all dependencies enabled;
- archived Tenants cannot change entitlements;
- pending and suspended Tenants may revoke but cannot gain capabilities;
- onboarding, ready, and active Tenants may grant or revoke;
- package and entitlement revisions match the preview at apply time.

`entitlementTransactions.apply` receives the complete diff and must apply it atomically. Sequential per-capability package writes are
not a conforming adapter. The transaction owns entitlement history/effective-time persistence, both audit domains, receipt persistence,
and compare-and-set checks for Tenant status, entitlement revision, and package revision.

## 6. Shared fleet readiness (`#94`)

Factory: `createPlatformFleetReadinessService`.

`evaluateFleetReadinessSnapshot` is the shared pure readiness/freshness projection. It does not hard-code a second readiness matrix;
the injected canonical `readinessPolicy.requiredCheckIds({ lifecycleStatus })` supplies the authoritative required checks. Activation
composition must use the same evaluator and required-check policy so fleet display and commit-time activation cannot disagree.

Each observation carries a state, observation time, and `freshUntil`. Missing observation/freshness is `unknown`; expired evidence is
`stale`; a failing fresh check is `blocked`. Failure takes precedence over unknown and stale for the overall state.

The fleet reader must batch its projection. Per-Tenant repository loops, Microsoft Graph calls, browser-supplied readiness flags, and
inferences that external evidence passed are prohibited. Evidence is returned as separately identified repository, deployment, and
external records with verification and validity timestamps.

## 7. Microsoft fleet health (`#97`)

Factory: `createPlatformMicrosoftFleetHealthService`.

This factory accepts `healthSnapshotReader` plus an injected presentation-safe `healthPresentationPolicy.contract()`. The latter adapts
the canonical health capability/status vocabulary without importing the customer runtime application boundary or defining a second
Platform-only health registry. There is intentionally no Microsoft client, discovery service, refresh callback, or provider write
port. Dashboard reads therefore cannot cause Graph fanout.

The DTO contains only Tenant display/lifecycle state, safe connection and permission states, aggregate mapping counts, capability
status/reason/freshness, and provider/tenant/unknown incident scope. Integration IDs, Entra Tenant references, room addresses, external
room IDs, raw provider errors, and provider payloads are discarded.

A separate background adapter must persist refreshed snapshots using bounded leases, concurrency, retry/backoff, throttling, and
circuit-breaker policy. Provider-wide incident scope must come from an explicit authoritative incident projection, not inference from
one Tenant or high-cardinality metric labels.

## 8. Support diagnostics (`#99`)

Factory: `createPlatformDiagnosticOperationsService`.

Public use cases:

- `getTenantSummary`
- `lookupCorrelation`

Summary reads call `diagnosticReader.readSummaryAndRecordAccess`. Correlation reads call
`diagnosticReader.queryTenantCorrelationAndRecordAccess` with the internal Tenant ID, searched correlation ID, bounded UTC time range,
and result limit as mandatory storage-query arguments. The adapter must query by all boundaries in SQL; global correlation lookup
followed by in-memory Tenant filtering is prohibited.

Correlation lookup is a sensitive permission. Results contain only source, time, stable action/outcome/category, and target type. They
exclude target IDs, metadata, free text, request/response bodies, customer content, raw log lines, SQL, provider data, and secrets. The
maximum lookup window is 31 days and the maximum result count is 100.

## 9. Controlled recovery (`#101`)

Factory: `createPlatformRecoveryOperationsService`.

The public API is action-specific. There is no generic `execute` or `command` method. Supported pairs are:

- preview/recover last Tenant Admin;
- preview/initiate Microsoft customer reconsent;
- preview/repair one deterministic room mapping;
- preview/execute preactivation identity unbind;
- preview/revoke all customer sessions for a Tenant;
- preview/revoke customer sessions for one User;
- preview/suspend Tenant;
- preview/reactivate Tenant.

Invitation revoke/reissue recovery uses the explicit `#93` methods rather than a duplicate recovery implementation.

Authorization occurs before inspection. A preview inspection returns only revision/state bindings, aggregate counts, eligibility, and
stable impact codes. Room repair requires exactly one deterministic candidate; identity unbind rejects any nonterminal reference;
last-admin recovery is available only when no Tenant Admin remains and the selected existing User has a valid identity state;
Microsoft recovery produces a customer-admin handoff and never performs consent or exposes provider tokens/consent URLs.

`recoveryContextTransactions.issue` stores an expiring context bound to the authenticated operator, assurance/session, operation,
Tenant, target, authoritative state binding, and expiry. Execute first checks an operation receipt, then loads the context through
`recoveryContextReader.findForExecution`, then calls the corresponding explicit transaction method.

Each execute transaction must atomically:

1. lock and validate context owner/session/assurance, action, Tenant, target, unused state, and expiry;
2. revalidate all state revisions and action-specific guards;
3. invoke the existing canonical Tenant service/policy without fabricating a Tenant Principal;
4. perform the recovery mutation and session/security-version consequences;
5. append Tenant and Platform audit evidence;
6. consume the context;
7. persist the idempotency receipt.

The transaction must roll back all seven effects on failure. A consumed context may be retried only through an exact idempotency
receipt. Last-admin recovery must restore exactly one `tenant_admin`; mapping ambiguity must escalate to the customer; Microsoft
reconsent remains a customer action; identity unbind must reuse the existing booking-reference and cleanup invariant; lifecycle
suspend/reactivate must delegate to the canonical lifecycle policy.

## 10. Persistence and production composition

The Platform process is composed separately with `npm run start:platform`. It reads only the validated `PLATFORM_*`
configuration namespace, opens the Platform database identity, starts the bounded projection worker before accepting traffic,
and registers only the Platform route registry. The customer process does not import this composition.

The delivered persistence surface includes:

- minimized keyset Tenant directory reader;
- invitation revision, revocation, reissue lineage, hash-only secret storage, and transactional reissue;
- Tenant lifecycle revision and suspended-to-archived compare-and-set persistence;
- operator/operation/Tenant-scoped durable idempotency receipts with request-digest uniqueness;
- capability dependency metadata in the canonical registry;
- package metadata/version persistence, entitlement aggregate revision/history/effective time, and atomic package apply;
- batched readiness snapshots plus append-only, versioned repository/deployment/external evidence and invalidation;
- batched Microsoft fleet-health snapshots, refresh leases, and provider-incident projection;
- Tenant-bound minimized diagnostic projections populated from the two immutable audit domains, with audited read transactions;
- expiring one-use recovery contexts and every explicit recovery transaction;
- evidence-factory composition with canonical Tenant audit and Platform audit services;
- separate Platform HTTP modules, CSRF/session handling, size/rate limits, strict wire schemas, and a runnable process;
- migrations, rollback/restore documentation, architecture gates, database isolation/concurrency tests, and deployed security evidence.

No adapter may weaken these contracts to preserve compatibility with the earlier process-local operator CLI. The CLI and HTTP adapters
must both call the same canonical application/domain services. A future break-glass CLI adapter must resolve a normalized Platform
Principal and consume a valid grant bound to the exact Tenant and action before invoking a use case. The legacy
`{ source: 'trusted_tenant_operator_cli' }` marker is not authentication or authorization. The delivered SaaS 3 recovery fallback
resolves a current normalized Platform Principal from a protected session credential, consumes a one-use dual-control grant bound to
the exact permission and Tenant, and invokes the same recovery preview and execution services. Nested persistence work joins the
grant transaction, so grant consumption, compare-and-set mutation, receipt, Platform/Tenant audit and alert outbox commit or roll back
together. Credentials are accepted only through fixed descriptors and are never command-line arguments, environment variables or
normal process output.
