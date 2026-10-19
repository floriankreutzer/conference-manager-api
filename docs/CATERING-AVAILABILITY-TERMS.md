# Supplier availability and business terms — isolated value preparation

Stacked on Employee publication candidate API#237 head74e1af19, not accepted
availability/runtime source. Current accepted API main is564ffd32 (canonical055/
Demo021). No new flag, migration, runtime composition or provider call is added.

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

A separate pure query/response boundary now binds configuration/publication/
published-source revisions, source version, actual site/room, UTC slot,
participant count and exact source position quantities. It preserves the existing
100-direct-item plus one package request capacity (500 package participants,
1000 item units); it does not narrow the independent300/100/20 source catalogue.
Opaque query/position identities bind replies. A private SHA-256 context digest
includes independent Tenant/provider scope and every meaningful query value,
while regenerated transport IDs or reordered equivalent positions do not change
business context. Fingerprints do not replace authorization or query ownership.

Every response must cover every expected position exactly once with an explicit
available/unavailable/unknown status. Partial, duplicated, swapped or extra
positions and claimed Tenant/price/publication/order authority fail closed.
The trusted use case supplies receipt time and an explicit maximum age (bounded
to one hour); no provider field can extend that policy. Effective expiry is the
earlier of provider validity and observed-time plus that bound, so a late receipt
cannot refresh old facts. Missing validity stays unknown. Expiry is exclusive;
future provider observation is invalid and server time before receipt cannot
make an observation available. Revised configuration/publication/published source
invalidates the observation. A later unreviewed catalogue receipt alone has no
role in this published basis. Factual terms/status do not authorize a quote,
publication, reservation or order and cannot alter confirmed orders.

Ten new availability boundary cases plus ten terms and six source cases pass
26/26. Lint/style pass908 files after long-line correction. This remains pure,
uncomposed preparation: durable query/observation revisions, current query nonce
and replay/out-of-order fences, scoped receipt provenance/credential/Manager
attestation, expiry/read projections, final confirmation authority and all
PostgreSQL/browser acceptance are still required. No availability activation or
supplier protocol/access/qualification is claimed here.
