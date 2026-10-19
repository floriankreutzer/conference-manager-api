# Provider-owned Catering catalogues

Tracking: conference-manager#233. Work in progress, not publication, Employee
filtering, availability, ordering or release acceptance. The source-intake runtime is composed behind the existing default-off
configuration flag. It remains unaccepted until its own exact-head database
and paired acceptance passes.

## Implemented value boundary

`normalizeCateringProviderCatalogue` consumes a closed schema1 supplier response
and independently resolved Tenant/Integration scope. It cannot authenticate that
scope or publish anything. Adapters translate protocol-specific references and
payloads before this boundary; REST is not required. Provider identity, URLs,
credentials, publication/approval and availability claims are not payload fields.

A response contains sourceVersion (opaque or explicitly unknown), items,
packages and terms. Catalogue limits remain300 items,100 packages and20
variants per package, with up to300 same-response item references per package.
Duplicate, absent, cross-snapshot, malformed, sparse, accessor, hidden/symbol
and prototype-bearing shapes fail closed. Package components belong to the
same scoped connection by construction. Variants inherit their package scope.
Values are copied, sorted deterministically and deeply frozen. Canonical text
and supported-currency/minor-unit limits are retained; providerPrice is a
supplier unit cost, never a Conference Manager selling price.

Unknown source versions, prices, minimum order value, lead time and change /
cancel cutoffs remain null. They never become zero, free, unrestricted,
available or automatically approved. Explicit zero is a distinct known value.
Durations are nonnegative integer minutes bounded at one year; unsupported
terms must be resolved through explicit review rather than silently truncated.
Minimum order value uses the existing aggregate-money bound; product/variant
prices use the unchanged catalogue unit-price bound. No currency conversion
or implicit supplier-price-to-selling-price mapping is performed.

Nine focused native/architecture tests passed locally: four new value cases
plus the five existing boundary cases with the new contract included. Full
capacity, mutation isolation, unknown values and adversarial schemas passed.
An initial combined invocation lacked installed architecture-parser dependencies;
that failure is retained separately. Locked existing dependencies were then
made available and the whole focused group passed. No new dependency was added.
Full repository, database and browser acceptance has not yet been run for this
work in progress.

## Planned persistence and publication integration

- Store received source revisions immutably per Tenant/connection, with server
  receipt time, source provenance, exact command replay, a bounded head and
  minimized audit. Manual receipt records identify actual Manager provenance;
  they are not cryptographically authenticated supplier submissions. Future
  authenticated adapters/partner identities require their own trusted admission.
- Keep received source and published source separate. New content, package and
  cost changes never update Employee offers or Conference Manager prices until
  explicit Manager review. A rejection retains the earlier published source.
- Publication binds exact source/publication/canonical-catalogue/assignment
  revisions. An authorized Manager explicitly maps selected supplier items,
  packages and variants, selling prices and applicability. A supplier may not
  submit any of those decisions. Unmapped new entries remain unpublished.
- Build the replacement canonical catalogue from independently loaded state,
  preserving services/equipment/Room prices, other providers and historical
  snapshots. Reuse canonical catalogue and assignment validators/repositories
  inside one transaction. Existing scoped transaction nesting may reuse the
  same client; no partly committed catalogue/ownership/publication is allowed.
- Reuse live Tenant/User/session/security-epoch checks, exact CAS, immutable
  completion evidence and HMAC audit. Every package component must have the
  same connection. Remapping an already owned canonical entry to another
  provider cannot silently carry the old provider publication/cost association.
- Previously published entries omitted by a reviewed replacement become
  unavailable for future selection while historical order content/prices
  remain unchanged. If retiring an item would invalidate an active legacy
  package outside the reviewed publication, reject with an actionable conflict
  instead of silently changing unrelated catalogue content.
- Version supplier availability separately from publication. Availability may
  affect future selection immediately and cannot mutate a confirmed order.
  Pre-confirmation availability is advisory. Authoritative confirmation-time
  revalidation, source/version/time binding and Manager conflicts must prevent
  automatic ordering of affected positions. Unknown is never available.
- Resolve supplier cost from the exact published source and selected quantities;
  missing or mixed-currency evidence requires an explicit quote/review. Minimum
  values are constraints, not implicit fees. Lead/change/cancel cutoffs remain
  visible and validated server-side; late exceptions require justification and
  the existing Manager approval flow.
- Keep initial automatic mode subordinate to conference approval, current
  published source, authoritative availability and approved exact cost.
  Changes/cancels/exceptions always retain explicit Manager review. Partial
  confirmation and substitution work must preserve earlier confirmed positions
  and complete receipt/version history.

These steps do not authorize a live provider connection, supplier outreach,
credential creation, paid runtime, deployment or release. The generic partner
API and the common four-candidate/three-adapter qualification gate remain
separate required work. Synthetic fixtures cannot qualify a production adapter.

## Unpublished intake checkpoint

The application service now separates Manager-only manual receipt, source
history, configuration/source CAS, exact normalized replay, minimized audit and
public acknowledgements. Imported source remains unapproved. History validates
contiguous immutable revisions,20-record pages and genuine end-of-history.
Unknown prices/terms and well-formed Unicode are revalidated at both boundaries.

The persistence implementation and draft054 migration add bounded immutable
source/header custody and Tenant/configuration/actor/completion guards. They are
composed behind the existing default-off configuration flag, but not database-qualified. Current main remains canonical052/Demo018;
the draft still requires coherent readiness/inventory/role/reset/upgrade and
rollback integration before any CI candidate. Its version must be reconciled
with then-current main, including independent Platform work. No DB test has
executed for054. Publication, availability, source UI and partner admission remain
unimplemented; source HTTP has native coverage only. The existing Catalogue Manager session SQL and lock order
were extracted unchanged; byte comparison and existing regressions passed.

The final focused intake/architecture/assignment/HTTP/runtime group passed37
cases locally. This is native source evidence only, not PostgreSQL, browser,
provider, migration or complete feature acceptance.

The independent draft Platform passkey PR#227 already uses canonical053 and
Demo019. This unpublished catalogue migration is provisionally054/Demo020 to
preserve that work. It must not be qualified/published until the required
current-main migration chain is integrated and all exact readiness/grant/reset
checks are coherent. The current main is still052/018 at this checkpoint.

History now returns bounded metadata only. Product details are read from an
explicit immutable revision, by items/packages and a scoped entry cursor;
at most five entries fit a page, with dynamic UTF-8 packing inside the runtime
response limit. Metadata reads do not transfer every source document or unit
price. Details retain actual supplier prices for Manager review and never mark
received content published. Closed history/detail/receipt HTTP is composed only
under the existing default-off configuration flag, with Manager service policy,
active-Tenant/session/CSRF guards and bounded transport. These native paths have
focused coverage; actual054 SQL, cookie HTTP, UI and whole-pair qualification
remain pending.

## 19 October focused source checkpoint

The combined native group passed55/55: provider values, service, HTTP,
Catalogue assignments/service/HTTP, operational health/service/HTTP, runtime
default-off composition, fixed telemetry vocabulary and the five Catering
contract boundaries. An earlier50-case invocation referenced a nonexistent
boundary-test filename and therefore did not include those five cases; it
was not treated as55-case evidence. The corrected existing boundary filename
is `tests/catering-contract-boundary.test.js`. PostgreSQL, migration/role/reset,
actual cookie HTTP and paired browser acceptance remain outstanding. No
assertion, deadline or test was weakened.

## Pure publication planner checkpoint

`planCateringCataloguePublication` now builds an immutable candidate from exact
source, configuration, catalogue, assignment and publication revisions. Manager
intent explicitly names source/canonical IDs, selling prices, active state,
order and applicability. Names and descriptions come from the reviewed source;
supplier costs never become selling prices. Every package component needs its
own review mapping. Existing other-provider ownership cannot be taken over.
Other providers, services, equipment and Room prices are preserved. Omitted
previously published own offers and removed variants retain their IDs/history
as inactive. A conflicting active legacy package or exhausted variant history
fails closed instead of deleting or silently modifying unrelated content.
Previously remapped ownership cannot be deactivated through stale bindings.

The first publication can create assignment revision1 from an empty canonical
Catering catalogue at assignment revision0. The full300-item/100-package/
20-variant limits remain supported. Ten new value-policy cases plus the prior55
focused cases passed65/65. Lint and style passed after correcting long lines;
initial style failures are retained. This planner has no runtime caller,
authorization, transaction, audit, publication persistence or availability
authority yet. SQL/UI/provider qualification remains outstanding.

## Source connection discovery and database-test preparation

Manager-only GET collection discovery now includes configured catalogue sources
and retained history, even when all current capabilities are unsupported or the
connection is unavailable. It validates21 scoped rows, returns20 minimized
records and a strict UUID cursor; it cannot activate or admit a source. History,
detail and collection routes are GET-only except the explicit receipt POST on a
selected connection. The fixed telemetry vocabulary retains all14 accepted
routes plus three new source keys. The combined focused group passed67/67.
An initial test-edit error used `status` instead of the actual `ApiError.statusCode`;
that run failed four HTTP cases and is retained. Restoring exact statusCode
assertions made all15 service/HTTP/telemetry cases pass; no runtime policy was
weakened.

Draft Demo020 now grants source append/head advancement only to Customer, no
Platform access and SELECT/TRUNCATE only to Reset. Private validator/trigger
functions remain nonexecutable by runtime roles. Both FK-owning tables are
explicitly added to the reset inventory. The optional manualCatalogue test
fixture flag leaves every existing caller unchanged by default.

A real PostgreSQL integration case is prepared for exact restricted roles,
Catalogue-only Manager sessions, concurrent command replay, source/configuration
CAS, unchanged canonical/assignment/order snapshots, SQL shape/epoch/immutable/
deferred-completion negatives, audit rollback,21-revision history and bounded
UTF-8 product details, disabled-source discovery and replay, actual cookie HTTP,
CSRF/foreign/revoked denial, populated rollback and filled reset. It has not run:
readiness/role/inventory/upgrade/rollback metadata still needs the accepted053/019
Platform baseline before054/020 can become a coherent CI candidate. Neither the
new SQL nor this prepared test is acceptance evidence. Lint/style passed for
this preparation; initial long-line failures were corrected and retained.

## Integrated main and Unicode boundary checkpoint

Accepted main db28f632 (independent invited-email foundation#224) is normally
merged into this work after reviewing all11 changed files. Its inactive code,
fixed Resend origin, conservative recipient/HMAC/content/delivery boundaries and
Demo exclusion remain unchanged; nothing is composed or sent. The focused
catalogue/assignment/health/boundary group plus all14 inherited email tests
passed81/81. The full architecture command passed all existing boundaries for
379 modules. These results do not cover054 SQL or the absent053/019 dependency.

Source text now rejects C1 controls and malformed Unicode at both native wire
boundaries. Draft SQL additionally requires NFC and exact Unicode trimming, with
raw SQL negatives for noncanonical source version and NBSP-padded references.
The PostgreSQL18 `IS NFC NORMALIZED`/btrim syntax was checked against the official
string-function documentation; the actual SQL still requires CI execution:
https://www.postgresql.org/docs/18/functions-string.html . Long test lines were
corrected; final native source cases and style passed. The matching unpublished
frontend has Manager input/history/detail, independent costs/unknown values,
source/configuration CAS, immutable detail consistency, explicit attestation,
preflight duplicate correction, uncertain-write read recovery and minimized
DE/EN audit. Its local751 native/all checks/audit0 and13 WebKit cases passed;
that is not paired backend/Chromium/database acceptance or publication proof.


The exact replay intent for a future publication is now independently normalized
from later source/catalogue state: command/revision fields, source/canonical
mappings, explicit commercial values and applicability are bounded, copied and
sorted canonically. Reordered equivalent input yields the same retained intent;
changed prices or source revisions remain different. Existing planner behavior
and historical/ownership negatives remain unchanged. The focused group now
passes82/82 including inherited email regressions; style passes after a long
import line correction. This does not compose or persist publication.

The prepared PostgreSQL case additionally covers competing distinct commands at
the same source head, raw foreign-provider/head-skip denial, and audit-only
rollback refusal after a filled reset. It remains unexecuted pending the coherent
accepted migration chain, with all original assertions retained.

## Coherent054/020 qualification candidate

Accepted Platform#227 main443e39f59e78ecb4643e39c442ef7578df1c9c34 is now normally
merged, preserving its inactive primary/passkey flows and all earlier email/
Catering boundaries. The source migration chain is contiguous001..054 and the
Demo chain001..020. Exact readiness, reset, operator/media/recovery gates,
retention-preserving metrics upgrades and their current/future fixtures are
advanced to54/20. A retained053 ledger with future020 is explicitly denied.
Historical rollback probes revoke020 before019 and drop empty054 before their
original053/052/051/earlier guards, preserving all original assertions. The
Platform populated053 rollback guard is still exercised and current054 restored.
A configuration TRUNCATE remains at historical046 after054 has already been
dropped; no nonexistent source table is added to that historical statement.

The new actual-role source case also exercises Employee denial and collection
Tenant isolation, real concurrent distinct-command CAS, immutable and raw SQL
negatives, retained-data/audit-only rollback and filled reset. This SQL/cookie
case is prepared, not executed locally. CI must supply the actual proof.

The complete local `taskset -c 0 npm run check` passed1627 native tests, live
Customer HTTP DAST and all17 Platform HTTP security cases, with all existing
syntax/lint/style/instructions/architecture/pilot/Tenant/identity/roles/provider/
observability/dependency/static/secret gates intact. Audit reports0. Only native
file scheduling is serialized; no assertion, budget or deadline is changed.
Initial metadata-style long lines were corrected. Full PostgreSQL18, all four
permanent browser/storage matrices and remote security/source gates remain
required on the published exact head. No source/catalogue or SaaS4 completion,
provider qualification, deployment or release is implied by this checkpoint.
