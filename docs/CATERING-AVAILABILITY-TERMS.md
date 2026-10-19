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
