# Catering provider contract foundation

Tracking: `floriankreutzer/conference-manager#133` (partial capability contract).

`src/integrations/catering-contract.js` defines adapter method conformance and a closed normalized
per-position receipt. It is not yet composed into a runtime, HTTP route, durable job or business
order lifecycle. No supplier or production adapter is selected or certified by reference fixtures.

Source-controlled descriptors declare API, manual and unsupported support independently for each
capability. An API-backed catalogue requires readCatalogue; availability requires lookupAvailability;
order/change/cancel/status require placeOrder/changeOrder/cancelOrder/readOrderStatus respectively.
Manual capabilities require no fabricated API method. assertCateringProvider checks this shape;
it does not wrap calls, confer authorization or expose a generic executable plugin loader. Callers
must still require the descriptor's exact capability mode and pass authorized server-owned context.

normalizeCateringReceipt accepts only orderId, orderVersion and positions. The expected order ID,
version and exact position-ID set come from the authorized use case's persisted snapshot, not from
provider authority. All identifiers are internal UUIDs; adapters map external references before
normalization. Versions are positive safe integers. Receipts contain 1–100 distinct positions, a
bounded contract guardrail rather than a change to any existing conference/catalogue limit.
Missing, extra, duplicate, foreign, sparse or stale positions fail closed, as do unknown fields,
symbols, accessors, hidden properties and unknown outcomes. The output is deeply frozen and copied.

Each position is pending, confirmed, rejected or substitution_proposed. Counts are derived from
validated positions; a provider cannot assert a global confirmed status, price or Manager approval.
Partial rejection/substitution preserves other confirmed positions. A substitution is still only a
proposal; it cannot create a replacement order or accept extra cost. Pending/exported/transmitted
business states are not provider confirmations. No conference cancellation is inferred.

The contract does not authenticate a provider, establish Tenant ownership, validate a signature or
prove that the caller loaded the expected snapshot securely. Those remain mandatory application,
repository and authenticated transport responsibilities in later work. Provider order/reference
binding, catalogue item schemas, prices/limits, availability revalidation, durable revisions,
Manager decisions, partner identity, webhook replay and live provider acceptance remain open.
The response contract must not be presented as a completed Tenant-isolation or security boundary.

The non-Microsoft reference test demonstrates API/manual method conformance and partial receipt
normalization without changing Microsoft calendar semantics. Negative tests cover stale/foreign
order and position references, sparse/incomplete receipts, invented success/cost fields, accessors,
mutation and exact resource bounds. Architecture tests permit only neutral registration/internal
identifier imports and reject concrete SDK/runtime/network access. No seed, schema, workflow,
credentials, provider calls or existing UI behavior changes are introduced by this slice.

## Configuration and approval values

normalizeCateringConfiguration accepts only initialOrderMode and a closed per-capability mode map.
The provider descriptor/identity is selected by server composition, not by client-supplied Tenant,
provider, integration, endpoint or credential fields. Unknown fields and mode upgrades fail closed.
An empty map disables all capabilities; omitted capabilities never become active by inference.
Each normalized provider configuration is an independent immutable snapshot. This validates values,
not the Tenant Admin's right to write them or the connection/entitlement/activation state.

The domain-owned cateringReviewRequirement distinguishes the decision needed for an initial order
from changes, cancellation and exceptions. Only the explicitly configured initial-order mode may
use conference approval; all later operations require Manager review. Unknown modes/operations
fail closed. A requirement is not a recorded decision, actor authorization, cost approval or order
release. Versioned Manager decisions and renewed approval of extra costs remain #234/#235 work.

## Quote cost review policy

The domain policy also identifies extra cost by comparing integer minor-unit amounts only inside
the same supported currency. A higher amount or changed currency requires Manager review. A lower
or equal same-currency amount means no extra cost; it does not waive the separate Manager review
required for every change, cancellation or exception.

cateringQuoteHasCurrentApproval compares independently loaded persisted evidence against the
expected Tenant, Integration, Order and order version, the exact quote revision, amount and currency.
An approved decision must name an internal decider; rejection, no evidence or any changed scope,
revision, amount (including a reduction) or currency cannot match. Exact bounded records reject
unknown/hidden/symbol/accessor fields; costs reuse the existing money contract. Inputs are not mutated.

This is an evidence-consistency rule, not a way to submit or authorize approvals. The trusted use case
must independently authenticate and authorize the Manager, load the correct records, check quote
expiry/availability, persist versioned decisions and audit atomically, and recheck before acceptance.
No caller-supplied approval, matching UUID or pure-policy result can release an order. Persistence,
HTTP, dispatch and renewed-cost-review UX remain open; no live supplier action is performed here.
