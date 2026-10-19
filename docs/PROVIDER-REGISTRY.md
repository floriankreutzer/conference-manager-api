# Provider registration foundation

Tracking: `floriankreutzer/conference-manager#133` (partial foundation).

`src/integrations/provider-registry.js` owns immutable, source-controlled provider descriptors.
This is a metadata contract, not an adapter loader, Tenant integration, entitlement, health report,
credential store or authorization decision. It is not yet composed into any runtime or HTTP route.
Existing Microsoft calendar ports, adapters and booking behavior remain unchanged.

Each descriptor has exactly `id`, `runtime` and `capabilities`. IDs are bounded lowercase source
identifiers. Runtime is explicitly `production` or `demo`; a registry rejects the opposite kind,
with no fallback. Pilot deployments would consume Production adapters, not a third adapter kind.
There are at most 32 descriptors, no duplicate provider IDs, and a closed set of calendar/catering
capability names. Empty registries support deployments without configured extensions.

Each declared capability is `api`, `manual` or `unsupported`. An omitted known capability resolves
to `unsupported`; an unknown capability or provider fails closed. `requireMode` requires an explicit
`api` or `manual` match. It never treats manual availability as API support, and cannot authorize
an unsupported operation. Hybrid providers can therefore expose an API catalogue while retaining
manual ordering. These source declarations do not certify a supplier's actual API or test access.

Inputs are copied into frozen descriptors/capability maps; callers cannot mutate registration via
the source object or returned list. Unknown fields, non-plain objects, accessors, hidden/symbol
properties and unknown modes are rejected. Descriptor envelopes cannot contain endpoint URLs,
credentials, secret references, Tenant IDs, roles or executable factories. Errors use fixed codes
without reflecting supplied values. The architecture gate keeps registration import-free and
prohibits ordinary network/runtime access; tests retain the existing concrete-adapter boundary.

Tenant authority must still be resolved by an authenticated use case. A future registry consumer
must load its integration by internal Tenant and Integration IDs, enforce role/permission and
entitlement, and validate binding/status before invoking an explicitly composed capability port.
Registry membership is never proof that a Tenant has connected, authorized or purchased anything.
Provider configuration schemas, credentials, OAuth/other protocols, outbound allowlists and response
validation remain adapter concerns. Technical configuration remains Tenant Admin-owned; canonical
business catalogue publication/pricing remains Conference Manager-owned.

`src/integrations/delivery-policy.js` supplies a separate pure scheduling decision for later durable
workers. The caller supplies a validated adapter classification, persisted attempt (1–3) and injected
jitter (0–1). Retryable reads and writes proven not sent get bounded exponential backoff with
nonnegative jitter and Retry-After as a floor (maximum accepted floor: five minutes). Permanent
failures, exhausted attempts and rejected writes stop. An ambiguous write always requires
reconciliation, even after the retry budget is exhausted; merely calling a write idempotent never
authorizes replay. Decisions are not timers, durable jobs, authorization or evidence of delivery.
There is no automatic fallback to manual delivery, since the original order could still be effective.
The worker must persist transitions and preserve Tenant/Integration/order/version scope before use.

Remaining #133 work includes capability-specific CateringProvider ports, generic lifecycle/health,
Tenant-scoped configuration and credential contracts, durable execution/reconciliation design,
adapter conformance and a non-Microsoft reference implementation. Unknown-outcome writes must
reconcile before retry; metadata registration does not deliver this behavior. No migration, seed,
HTTP/OpenAPI endpoint, external order, supplier selection or deployed acceptance is introduced here.

Maintainability assessment (#300): keep this responsibility separate from the existing calendar
contract, Microsoft adapter and booking orchestration. Reuse native ESM and the current syntax,
static/security, architecture and style gates; no dependency or bulk formatting is introduced by
this foundation. A general lint/format tooling decision for both repositories is still outstanding.

Validation: `node --test tests/provider-registry*.test.js tests/integration-delivery-policy.test.js`,
`npm run check`, `npm run audit` and the
unchanged CI database and paired Chromium/WebKit acceptance gates. Local unit/static evidence does
not certify real supplier behavior, Tenant runtime integration or deployed acceptance.
