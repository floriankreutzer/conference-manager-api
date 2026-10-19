# Catering order snapshot foundation

This increment prepares immutable, independent initial-order values for #234.
It is pure policy/projection, not durable order persistence, an HTTP operation,
an approval decision, an outbox or a supplier dispatch. No existing confirmed
conference is activated or retroactively ordered by this code.

## Trusted inputs and ownership

`createCateringOrderSnapshots` requires an independently authorized, loaded
confirmed Request and its existing versioned schema-2/3 business snapshot. It
reuses the canonical Request normalizer. Legacy Requests without a business
snapshot and non-confirmed Requests fail closed.

The use case must load the exact historical canonical catalogue named by that
Request snapshot, a persisted positive assignment revision for that catalogue,
complete ownership and independently verified same-Tenant configured connections.
The existing full-catalogue ownership normalizer validates completeness and
package/component ownership, including inactive entries. Selected item/package/
variant names, descriptions, prices and full package content must match the
historical canonical catalogue. A different catalogue revision, foreign
connection, split package or mismatched business content cannot silently select
a replacement supplier or a newer price. This value function cannot authenticate
the caller or prove the repository loaded the right records; that is the
application/transaction boundary's responsibility.

Source-controlled server factories allocate distinct internal order and position
UUIDs. The future use case/repository must enforce its own idempotent source-event
identity, transaction, authorization, audit and concurrency fences before using
these values. Factories are application ports, never browser-selected plugins.

## Commercial positions and unchanged capacity

A package is one commercial position with the selected variant price and Catering
participant quantity. All its included item snapshots (up to 300) and explicitly
selected included-item quantities are retained as descriptive package detail.
The baseline Request charges those included selections zero separately; this
projection does not duplicate them as another charge or invent their quantities.
Other direct items retain exact snapshot quantities, unit prices and line totals.

The complete Request can therefore produce 100 direct commercial positions plus
one package, including when all belong to one connection. The shared domain limit
and neutral receipt contract now accept 101 positions and reject 102. This is an
explicit correction of the early uncomposed receipt guardrail, not a reduction of
the existing 300-item/100-package catalogue, 100-direct-selection or 300-component
Request bounds. The old valid 100-position receipt test remains unchanged.

An outcome for a package position applies to that commercial package. A supplier
cannot use a partial component response to silently replace the package, change
its price or approve extra cost. Component exceptions/substitutions still require
the later authorized Manager exception workflow; this projection performs none.

## Prices and privacy

Each connection gets its own order identity, positions and exact share of the
conference price, bound to Request/assignment/catalogue revisions and source
capture time. The sum must equal the persisted Catering price breakdown. A
provider cost is explicitly null: CM customer prices never become fabricated
supplier quotes, supplier costs or approved margin evidence.

Order/quote aggregates use the separate closed `normalizeCateringOrderTotal`
contract. It supports safe nonnegative integer totals below MAX_SAFE_INTEGER;
catalogue unit-price validation remains unchanged at MAX_PRICE_MINOR. Existing
quote-approval policy now validates aggregate costs with this contract and still
requires the exact scope, quote revision, amount/currency and approved decider.
Neither that comparison nor a snapshot releases an order.

Only the business delivery fields are projected. Requester display name/user,
cost-center allocations, equipment/services and unrelated Tenant configuration
are not copied into supplier-order values. Business notes remain private order
content, not logs/metrics. No credentials, URLs, network calls or browser storage
are introduced.

## Architecture and remaining integration

Domain owns snapshots, aggregate money and the shared immutable position limit.
The neutral integration receipt consumes only identifiers, the import-free limit
and neutral registration; its boundary gate admits that exact additional module
and retains SDK/runtime/network/persistence/dynamic-import negatives. The limit
module is itself guarded against imports/runtime authority. No provider adapter
or infrastructure enters domain code.

Required next work remains authoritative persisted per-provider order/version/
decision state, renewal of cost/availability approval, atomic durable enqueue,
restart/unknown-outcome reconciliation, safe manual delivery, role-owned UI and
real supplier qualification. Current source tests do not certify any of these or
deployed/live-provider acceptance. Relevant full PostgreSQL/permanent paired Demo
gates remain mandatory before integration of the surrounding feature.
