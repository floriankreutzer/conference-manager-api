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
