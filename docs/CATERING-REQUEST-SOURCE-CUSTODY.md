# Request-captured Catering source custody — uncomposed preparation

## Status and boundary

Accepted API main remains834e8d1b92ada2527a719cc66430a009bb6caed6,
canonical055/Demo021. Availability foundation PR#239 is independently pending at
6747eeefac2b7bc2329f5a49ea85c4885059ac30; its complete local1706 native,
Customer HTTP DAST and17 Platform HTTP checks pass, audit0. All exact-head CI
PostgreSQL/permanent paired browser/security checks must finish before acceptance.
This follow-on branch adds a pure source-evidence value contract only. It creates
no table, migration, runtime, route, provider call or automatic order.

A saved canonical product ID cannot prove the supplier/source selected when the
Request was composed. Assignment and publication heads may advance independently
of canonical revisions. Source receipt time is not a valid substitute: capture
can occur outside a Tenant lock and several ownership revisions may share one
catalogue revision. Existing Requests therefore must not be assigned invented
historical providers, supplier SKUs or publication references during rollout.

## Immutable private evidence

`createCateringRequestSourceEvidence` consumes an independently loaded saved
Request, its exact historical catalogue/complete ownership and assignment
revision, same-Tenant connections and immutable publication/source references.
It reuses the shared commercial-selection validator. The value records Tenant,
Request/current version, actual origin Request version, catalogue/assignment
revisions, a private business-intent fingerprint and selected per-provider
configuration/review/publication/source references and source bindings.

Only selected direct products, the selected package variant and every package
component binding are retained. Unselected offers and variants are excluded.
The private fingerprint binds exact slot/site/room, Catering participant count,
requirements, saved commercial contents/prices/quantities and selected owners;
it excludes workflow status/version and unrelated Requester/allocations/title.
Hashes are comparison values, never authorization or proof of authentic records.
The evidence JSON itself excludes prices, requirement text, Requester attribution,
order identities, quote/cost decisions and credentials.

The actual immutable origin Request revision must be independently loaded by its
composite foreign key. Normalization reconstructs the captured selection against
that origin and compares the current saved business intent. Source provider,
binding and JSON object ordering are canonicalized, including PostgreSQL JSONB
key order. Extra captured offers, missing components/variants, foreign scope,
invalid references, changed contents or corrupted fingerprints fail closed.

`carryCateringRequestSourceEvidence` accepts only the immediate next real Request
revision with the same business intent, preserving origin and supplier bindings.
Status-only review/confirmation can therefore carry evidence without inventing a
new selection. A changed quantity, slot, requirement, price or owner requires a
new explicit composition/capture. An empty Catering selection has no inferred
provider and can retain the actual zero assignment head. Existing101 independently
owned commercial positions/301 selected bindings remain supported, with the
original300-component/package capacity unchanged.

Checkpoint602a22c0 passed the complete local repository check:1716 native cases,
Customer HTTP DAST and17 Platform HTTP, with all architecture/static/security/
dependency gates. Ten progression/negative cases cover capture, multi-status carry, content/quantity/
slot/owner changes, real origin/version, database JSON ordering, scope/reference/
fingerprint corruption, exact selected binding subsets, closed getters and empty/
101-provider boundaries. Lint/style916 files pass. These are pure value tests,
not evidence that a database FK, current authority or durable transaction exists.

## Required authoritative write/read design

The next persistence increment must implement the following before activation:

- New Request create/resubmit and confirmed-change proposal/application capture
  source references inside the same Tenant/configuration/Request authority fence
  as composition and its audit. No lookup by approximate timestamps is allowed.
- A persisted private required marker distinguishes newly captured lineages from
  legacy Requests. It cannot downgrade after capture. Legacy data is not silently
  backfilled or sent to a newly inferred provider. Empty selected Catering gets
  an explicit empty seal rather than guessed supplier rows.
- Immutable headers are keyed by Tenant/Request/version and retain the true
  origin version plus exact catalogue/assignment references. Per-provider rows
  have composite integration/configuration/review-publication/source FKs. Deferred
  completion/seal checks enforce exact saved selection and full source mapping.
- Every required Request revision has complete evidence before transaction commit.
  Status revisions copy origin references only for unchanged business intent.
  New compositions create their own origin. Proposed booking changes retain their
  separately captured intent and do not pretend to be a current Request revision.
- Query creation loads that actual immutable origin/source evidence, compares
  exact selected content/price and supplier product/variant mappings with current
  published/current ownership, and never routes a saved selection to a replacement
  supplier or SKU through current IDs alone. Unrelated catalogue changes must not
  force a false historical rewrite or fabricated assignment catalogue revision.
- Every query round and per-provider response uses the request/receipt contracts
  from CATERING-AVAILABILITY-TERMS.md, server clocks, live actor/session/ownership
  revalidation, immutable query identities, exact replay, current-round guards,
  state revision increments and atomic minimized audit. No provider quote, order
  reservation or approval can be inferred from an availability fact.

Current parallel Platform/invitation PRs propose the next migration numbers.
Register this schema only against the then-accepted ledger. Do not introduce a
schema gap, number collision, broad privilege, reset/readiness exception, failed
check bypass or weaker rollback. Required actual PostgreSQL Customer/Platform/
Reset roles, retained/audit-only rollback refusal, populated reset, constraint/
concurrency/replay tests and all paired permanent Demo cases remain open.

## Current semantic/source comparison

A separately named shared selection entry point accepts the independently loaded
current catalogue/ownership revision. It compares exact saved product contents,
prices, variant and components without changing the Request's original catalogue
revision or forging an assignment epoch. The existing historical/order entry
point retains its original strict Request-catalogue revision binding.

`revalidateCateringRequestSourceForAvailability` normalizes real captured/origin
proof, compares the saved commercial intent and providers against that actual
current catalogue/ownership, then compares every selected supplier SKU, package
variant and component source binding. Changed provider or SKU is rejected even
when the canonical product ID, name and price are unchanged. Changed product
contents, saved quantities and prices also fail closed. Unrelated current
catalogue/assignment changes and newer publication/source/configuration revisions
are allowed only when every selected business/source binding remains equivalent.
The returned query contexts use those newer real observed revisions; original
captured source records and Request status/content remain unchanged.

This supplies necessary semantic/source consistency only. The transaction must
still prove authentic/current references, active connection/capabilities/current
published eligibility, actual Room/Site applicability, authorization/session,
locks and atomic persistence. Neither this projection nor a hash supplies those
independent authorities. No availability, confirmation or order is released.

Four additional revalidation progression/negative cases pass together with the
ten capture cases, seven availability planner cases and five unchanged order
cases26/26. The successful unrelated-revision case also exercises the actual
source query planner with the original Submitted Request and newer publication/
source revisions. The complete repository gates are being repeated for this
follow-on comparison; no database/runtime activation is claimed.
