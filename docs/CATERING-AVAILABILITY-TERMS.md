# Supplier availability and business terms — isolated value preparation

This branch normally incorporates accepted API main834e8d1b92ada2527a719cc66430a009bb6caed6
(Employee publication#237, canonical055/Demo021). That exact candidate74e1af19
passed all nine required checks, complete PostgreSQL18.6 actual Employee/query/
lock-fence proof and all four permanent paired browser/storage cases in
CI39334251224 before normal merge. Frontend publication#360 is accepted ascf48df19
after all eight checks and522 complete browser cases. This branch adds isolated
value preparation only; no availability flag, migration, runtime or provider call
is activated. The first value-only complete local check passed1684 native cases,
Customer HTTP DAST and17 Platform HTTP before the request-scope refinement below.

A pure terms policy reuses the existing closed nullable supplier-term normalizer.
Initial and changed orders need known lead time, known minimum order value and a
known full supplier cost in the same currency. Unknown is distinct from known
zero; selling-price totals are not substitutes. Safe aggregate minor-unit bounds
remain separate from unit-price limits. The policy grants no quote provenance,
cost approval, availability, reservation, actor or delivery authority.

Change/cancel deadlines are anchored to the original conference start, so moving
a proposed conference later cannot extend the original supplier deadline. A
change must independently satisfy the new lead time and resulting minimum.
Cancellation applies its own original deadline without inventing a new minimum
order or lead-time check; supplier cancellation fees and explicit Manager review
remain separate. Exact deadline equality is inclusive; one millisecond later is
elapsed. Dates are canonical UTC instants, arithmetic uses elapsed minutes and
returns explicit UTC deadlines for later localized presentation.

Closed operation/context, invalid calendar dates, unknown currencies, unsafe
aggregate values, getters and extra caller authority fail closed. Irrelevant
unknown change/cancel terms do not block an initial order. Results and the reused
normalizer are immutable and expose no supplied quote/cost-approval claim.

Ten new policy cases plus all six existing source-value cases passed16/16;
lint/style passed906 JavaScript files. This is uncomposed preparation. Separate
versioned request-bound supplier availability, actual receipt/query provenance,
expiry and immediate update semantics, current confirmation-time revalidation,
scoped persistence/HTTP, role-owned DE/EN visibility and all exact-head PostgreSQL/
browser/security gates remain required. No provider, release, SLA or complete
SaaS4 acceptance is claimed by this checkpoint.

## Request-bound availability values

A separate pure query/response boundary now binds an independently supplied
Request identity/version, configuration/publication/published-source revisions,
source version, actual site/room, UTC slot, participant count, relevant dietary/
delivery requirements and exact source position quantities. It preserves the existing
100-direct-item plus one package request capacity (500 package participants,
1000 item units); it does not narrow the independent300/100/20 source catalogue.
Opaque query/position identities bind replies. A private SHA-256 context digest
includes independent Tenant/provider scope and every meaningful query value,
while regenerated transport IDs or reordered equivalent positions do not change
business context. Different Request identities/versions, provider scope or
requirements change it. Fingerprints do not replace authorization or query
ownership; Request scope comes from trusted persistence, not provider JSON.

Every response must cover every expected position exactly once with an explicit
available/unavailable/unknown status. Partial, duplicated, swapped or extra
positions and claimed Tenant/price/publication/order authority fail closed.
The trusted use case supplies receipt time and an explicit maximum age (bounded
to one hour); no provider field can extend that policy. Effective expiry is the
earlier of provider validity and observed-time plus that bound, so a late receipt
cannot refresh old facts. Missing validity stays unknown. Expiry is exclusive;
future provider observation is invalid and server time before receipt cannot
make an observation available. Revised configuration/publication/published source
or current Request version invalidates the observation. A later unreviewed catalogue receipt alone has no
role in this published basis. Factual terms/status do not authorize a quote,
publication, reservation or order and cannot alter confirmed orders.

Ten new availability boundary cases plus ten terms and six source cases pass
26/26. Lint/style pass908 files after long-line correction. This remains pure,
uncomposed preparation: durable query/observation revisions, current query nonce
and replay/out-of-order fences, scoped receipt provenance/credential/Manager
attestation, expiry/read projections, final confirmation authority and all
PostgreSQL/browser acceptance are still required. No availability activation or
supplier protocol/access/qualification is claimed here.

The current request-scope refinement passed the same26 native cases and all
lint/style908 checks. Its complete local check passed1684 native cases, Customer HTTP DAST and17 Platform HTTP. Parallel unmerged
Platform/invitation PRs currently propose next migration numbers, so availability
DDL will be registered against the then-current accepted migration ledger; no
conflicting number, schema gap or relaxed readiness/grant/reset check is introduced.

## Uncomposed request/receipt application boundary

The application service now defines explicit transactional `request` and `receive`
ports, without runtime composition, HTTP routes or provider calls. Query authority
uses existing Request scope: Employee owns their Request; a Conference Manager
with request management can operate inside the authenticated Tenant. Technical
administration and catalogue management alone grant no Request authority. Both
ports carry the live session identity and security epoch for persisted revalidation.

Query commands contain only command identity, expected Request version and expected
availability revision. Every provider query must be independently derived from a
locked Request/source basis. Manual receipt requires Request-management authority,
an explicit supplier-receipt attestation, an exact query identity and the expected
query round. Canonical response intent makes reordered equivalent statuses, NFC
text and equivalent UTC forms replay consistently. Replay still validates actor,
security epoch, exact intent, captured query and normalized receipt, invokes no
new planners/audit factories and conveys no current availability decision.

The durable port contract has two independent counters. A new query round advances
both the round and availability revision. Each accepted provider response advances
only the availability revision; independent replies in the same round can coexist.
An older round cannot replace current facts. A response is accepted once per query;
updated supplier facts require a new query identity/round. Acknowledgements expose
only command/revision/recording facts, never an `available`, quote, reservation or
order-success claim. The current service can only accept manual capabilities for
manual receipts; API capability cannot silently fall back to manual authority.

The repository must lock Tenant, actor/security/session and Request ownership,
verify exact replay before current-state CAS, allocate query/position identities,
lock current integration/configuration/publication evidence, invoke every planner
and audit factory inside one transaction, and persist immutable rounds, queries,
observations and heads atomically. Receipts are closed private contracts checked
against independently normalized query/observation values. New receipt freshness
must equal the captured query-policy/current-policy minimum, even if an earlier
provider expiry would hide a changed policy. Clocks are repository-owned. The two
new audit actions retain only Request/revision/operation/manual-source metadata.
No business requirements, source positions, supplier terms, prices or credentials
are copied into audit metadata.

Fifteen application/projection progression and adversarial cases cover minimized
receipts, role/ownership scope, all five stale basis fences, exact replay, forged
private receipts, missing factories, unknown source capability, corrupted clocks,
closed input/getter rejection and no retries. These are port-contract tests; they
do not prove PostgreSQL atomicity, live sessions, HTTP/CSRF or browser acceptance.
The complete local repository check passed1699 native cases, Customer HTTP DAST
and17 Platform HTTP cases for this uncomposed increment. Lint/style passed911 files.
Durable SQL/read/HTTP/UI and captured Request-to-source provenance remain open.

## Saved commercial selection and source query planning

Order snapshot creation and availability query planning now share one pure
commercial-selection policy. It validates a real saved Request against the exact
historical canonical product/variant/component contents and complete same-Tenant
ownership; same IDs with changed names, descriptions, prices or package components
cannot pass. The order wrapper retains its independent Confirmed-state guard and
all five existing order-snapshot regression cases pass unchanged. The shared
selection itself grants no workflow/status authority and allocates no identities.
A preconfirmation availability query therefore uses the actual Submitted Request,
without manufacturing a Confirmed Request or preparing an order.

The separate private query planner maps only those verified commercial positions
to positively validated captured provider/source bindings. It requires one scoped
provider context per selected connection and each selected package variant and
included component to be bound. It allocates unique server query/position UUIDs
and retains the exact saved Request slot, room/site, version, participant count,
requirements and quantities. Included package selections remain descriptive
package detail rather than duplicate inventory quantities. Supplier payload
projection exposes source product/variant IDs and factual query fields only;
customer prices, cost allocations, requester identity and order identities are
excluded. The full101-position/300-component capacities remain supported.

Seven new planner/selection progression and negative cases plus the five unchanged
order cases pass12/12. This planner cannot independently prove that persistence
loaded genuine Request-captured publication/source evidence, that current
configuration/publication authority still matches it or that a legacy Request
has such evidence. Durable captured-source custody and the locked transaction
must prove those facts; no timestamp inference, current-ID-only substitution or
fabricated historical supplier binding is permitted. No runtime is activated.
The complete post-refactor local check passed1706 native cases, Customer HTTP
DAST and17 Platform HTTP; npm audit found0 vulnerabilities. Candidate6747eeef
CI39340056468 quality/full PostgreSQL passed, while the permanent matrices were
still running when self-review found an error-contract regression: the factored
commercial-selection error no longer matched the exact legacy order error caught
by persisted version proposals. The order wrapper now translates that one private
selection error back to CATERING_ORDER_SNAPSHOT_INVALID. A dedicated regression
asserts the exact original error for changed product price, variant and components.
All original five tests remain unchanged; six order cases pass. The corrected
candidate must repeat full local and all exact-head CI checks; prior candidate
results/history remain retained and are not acceptance for the corrected source.
