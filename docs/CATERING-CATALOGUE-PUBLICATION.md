# Provider catalogue publication — unpublished preparation

Work in progress for application#233, dependent on source intake054/Demo020.
Draft055/Demo021 publication SQL, exact readiness and role/reset integration
are prepared but unexecuted in PostgreSQL. No runtime composition, HTTP/UI,
availability or publication acceptance exists yet. Current preparation is isolated on
feat/saas4-catalogue-publication-recovered on accepted API#229 main5bbe97b.

## Implemented application and persistence draft

A closed review command binds source/configuration/canonical-catalogue/
assignment/publication/review revisions, a command UUID, a justified Manager
publication or rejection, and explicit selected mappings. A rejection carries
no replacement mappings, advances only review state and retains the previous
publication/catalogue/assignment. Reordered equivalent commercial intent is
canonicalized for retained replay; altered prices or source revisions differ.

Catalogue-only Managers require active Tenant, live session/security epoch and
current permission. Employee/Admin-alone/Platform/foreign scope cannot invoke
the port. A successful acknowledgement validates immutable command, actor/epoch,
all resulting counters and server receipt time. Private payloads, justification,
prices and source products remain out of acknowledgement and audit. Three
same-transaction audit factories cover canonical catalogue, assignment and
publication; rejection uses only its review audit. Known CAS conflicts have
closed409 codes; malformed commands map to400. No retries or outbound ports.

The draft repository locks Tenant -> User -> Session, then current connection
and source/review/publication heads. Historical exact command replay precedes
current CAS. New source/configuration or head changes cannot be acknowledged as
a stale review. One same-pool READ COMMITTED transaction reuses existing
canonical and assignment repositories for writes. Their ordinary RR read
contracts remain unchanged. Direct read helpers are exported without changing
their existing bodies and are used only after this composition holds the Tenant
write lock. This avoids establishing a stale RR snapshot while waiting for a
competing Tenant writer; live serialization and original isolation guards stay
intact. Expected failures after the first write throw through the outer rollback
boundary, so a failed assignment/reference/audit cannot commit half a publication.
No SQL/migration execution or transaction proof is claimed by this draft.

## Required database work before composition

- Add immutable review history plus review/publication heads, source/configuration/
  canonical/assignment evidence, canonical command and source-to-canonical bindings.
- Database-clock receipt; active Tenant/User/current connection/head/counter
  fences; closed review/mapping/justification schemas. Exact source/component/
  variant and target ownership must agree with retained source, canonical and
  assignment snapshots. Preserve unrelated providers/services/equipment/Room
  prices and retain inactive historical entries/variants.
- Rejection cannot move publication or mutate canonical/assignment state.
  Publication cannot omit exact canonical, assignment and review audit completion.
  History/head mutation, missing completion and raw cross-provider/foreign-price/
  counter/epoch/provider input must fail closed.
- Add exact Customer append/head-update, Platform denial and Reset TRUNCATE
  privileges; all FK-owning tables in exact inventories/reset. Private guard
  functions remain nonexecutable by runtime roles. Retained-data and audit-only
  rollback must refuse. Reconcile migration numbering with accepted current main.
- Actual PostgreSQL concurrent duplicate/different commands, live revoke/CAS,
  audit and nested-write failure rollback, fresh/empty catalogue, full300/100/20
  capacity, disabled other provider, same-provider component/variant and remapped
  ownership, unchanged confirmed orders and filled reset. Then paired role-owned
  DE/EN UI and all permanent Chromium/WebKit/database/storage gates.

Employee projection and order preparation must later validate current publication
bindings/ownership and separate versioned supplier availability. Confirmation
requires authoritative revalidation; earlier advisory availability cannot grant
an order. Provider costs remain separate from selling prices, unknown terms
remain unknown, and original confirmed orders stay immutable.

## Local evidence

Seven new application cases plus11 value/replay and five contract-boundary cases
passed23/23. The combined existing assignment, Tenant catalogue and PostgreSQL
transaction-native regression group passed51/51. Lint and style pass; initial
long lines were corrected and retained. These are native port/value tests, not
actual PostgreSQL, supplier, migration, publication, browser or release evidence.
There are no new dependencies, role grants, running worker, provider activation
or deployment. Source intake#229 is accepted independently on canonical054/Demo020.

After workspace recovery the exact51-case native group, lint and style passed
again. A preparatory invocation named two nonexistent repository test files and
therefore ran28 existing cases; that is not51-case evidence. The corrected
combined command includes assignment service/HTTP/value, Tenant catalogue
administration and transaction-native regressions. All assertions were retained.

Draft055 adds immutable review receipts, review/publication heads, closed SQL
commands, current source/configuration/actor/counter fences, reviewed source to
canonical content/price/ownership checks and deferred completion. It is not
qualified, composed or ready to migrate. Demo021 and exact inventories/readiness are now prepared. Actual PostgreSQL
concurrency/rollback/security and browser acceptance remain required before a
publication claim. No existing migration checksum is changed.

## Coherent055/021 CI preparation

The candidate preserves accepted054/020 and appends055/021. Customer can append
immutable reviews and advance the two heads; Platform cannot read them; Reset
can SELECT/TRUNCATE all three FK-owning tables. Runtime roles cannot execute the
five private review validators/guards. Down migration refuses retained review,
head or published/rejected audit evidence, including audit-only state after a
reset. Exact runtime/operator/media/recovery inventories advance coherently;
legacy44/9 through54/20 compatibility bounds and earlier53/20 rejection remain.
Missing and future ledgers remain invalid. Existing historical probes drain021
before020 and empty055 before their original054/older guards. Source054's own
populated/audit-only rollback proof is preserved, with55/21 restored before reset.
No earlier migration checksum, assertion, timeout, retry or required gate changes.

The actual PostgreSQL case is prepared for Catalogue-only live Manager, restricted
Customer/Platform/Reset roles, foreign Tenant concealment, concurrent identical
and distinct commands, source/CAS/replay, independent DB rejection of a tampered
selling price, rollback after both nested writes and final audit failure, raw
closed-schema/epoch/completion/head/history negatives, rejection retaining the
prior publication, omitted own offers retired with unchanged historical orders,
HMAC/minimized audit, filled reset and audit-only rollback refusal. A separate
subcase prepares first publication from empty assignment revision0 at full300
items/100 packages/20 variants each, then verifies canonical counts and reset.
The test fixture's optional empty-Catering flag defaults false; existing fixture
preparation and all existing callers retain their prior behavior.

Complete local serial check passed1634 native cases, Customer live HTTP DAST and
all17 Platform HTTP security cases. All architecture/static/secret/role gates
passed. The focused migration/reset/media/recovery group passed66/66. Final DB
fixture/test additions have independent syntax/lint/style validation; PostgreSQL
has not executed locally. Initial metadata/DB-test long-line failures are retained
and corrected without assertion changes. Remote exact-head gates remain pending.
This foundation remains uncomposed: no publication HTTP caller, Employee offer
projection, availability, automatic order authority, live supplier or deployment.


## First exact-head PostgreSQL run and retained failure

Candidate4abae961 / tree8f2fe254 passed quality and all security/source gates.
Actual Customer publication proof passed20:53:42UTC in PostgreSQL18.6, including
both nested-write/final-audit rollback, tampered-price rejection, concurrent
replay/CAS, rejection/history/retirement, authority, minimized audit, populated /
audit-only rollback and reset. The separate empty-assignment full300/100/20
subcase passed as well. These are actual SQL results, not complete suite acceptance.

CI39322674133 PostgreSQL job118301072056 subsequently failed at20:54:36 in the
original source054 case: its new initial rollback removed055 before invoking the
second Demo rollback. The unchanged Demo runner correctly requires complete
current055 readiness for every overlay rollback and rejected that order with
DEMO_MIGRATION_PRODUCTION_SCHEMA_NOT_READY. The test now drains021 and020 first,
then empty055 and054. No production readiness check, original source assertion,
DDL checksum, permission, retry, deadline or budget was relaxed. All full-suite
and browser/security gates must rerun on the corrected immutable head. The failed
run remains failed and is retained as evidence; it is not a passing DB suite.


The corrected079a13af run again passed both publication cases at20:59:58UTC and
the complete original source receipt case at21:00:44UTC. It subsequently failed
CI39323439541/job118304269944 at21:01:06 on a stale test expectation for Demo
constant20 rather than current21. The exact overlay inventory now appends021;
all old entries/assertions remain. The same real-role test additionally verifies
every privilege on all three new tables and nonexecution of all five private
review functions for Customer, Platform and Reset. Runtime and migration SQL
are unchanged. A broader source scan found no other current54/20 constants;
historical ledgers and genuine20-entry product/history limits remain intact.
This second failure remains retained and is not suite acceptance. The next head
must execute every required database, browser and security gate again.


The third run36a822a7 / CI39324628866 / job118307988049 again passed actual
publication/capacity and source custody. Its fresh-overlay subcase verified all
new table privileges and five private function denials successfully. The older
upgrade-from001..003 subcase then found a second literal expected ledger ending
at20 instead of21. The complete file and every numeric change from the accepted
source054 diff were reviewed; the original full upgrade assertion now appends021.
Historical001..003 denial, original reset privilege assertions, current55 checks,
all old ledger entries and every runtime/migration invariant remain unchanged.
This third failed run stays retained. Documentation now distinguishes the55/21
candidate readiness from accepted main54/20. The next exact head must pass the
entire suite and all browser/security gates; no partial run substitutes for it.


## Separate unpublished HTTP/read preparation

Branch feat/saas4-catalogue-publication-http normally follows the current
publication foundation candidate. It adds Catalogue Manager read context and
justified immutable review history, current publication bindings with a strict
publication-version/keyset cursor, and explicit POST review. Trusted Principal /
active-Tenant/cookie/CSRF guards remain the first boundary. Requests cannot select
Tenant/provider/actor authority. GET forbids bodies and duplicate/foreign queries;
unsupported writes require CSRF before405. All body/response and runtime budgets
remain bounded. The original17 telemetry keys remain plus two fixed review keys.
Composition stays under the existing default-off configuration flag, outside Demo.

The read adapter uses a single RR snapshot, scoped explicit SQL and the existing
assignment reader. It reads at most six bindings or21 historical metadata rows;
private configuration/actor/session/commands/source prices are not returned.
The service validates every row, continuity, counters, scope and hidden shapes
before exposing at most five bindings /20 history records. UTF-8 byte packing
can shorten pages without false EOF or empty nonfinal pages. Disabled or stale
connections retain history without acquiring review authority. Justification is
visible only to the authorized Manager; audit remains minimized separately.

Seventeen focused HTTP/read/default-off/runtime/telemetry cases passed, including
all original runtime and17-route metrics protection extended to19 fixed keys.
Seven read cases cover role/Tenant denial, corrupt sixth row/private fields,
publication-stale cursor, continuous21/20 history, UTF-8 packing across all rows,
unknown/empty state and bounded failure when even one entry cannot fit. Five
transport cases cover scope/CSRF-before405, exact body/query schemas, MIME and
encoding/byte bounds, unavailable service and exact routing. Lint/style pass after
retained long-line corrections. No dependency, retry, timeout or capacity changed.

Actual PostgreSQL/cookie tests are extended, but have not executed on this branch:
context/history bindings, Admin/Employee/foreign/anonymous/revoked cases, Origin /
CSRF, explicit review and replay, and all400 full-capacity bindings through scoped
five-entry HTTP pages. Foundation SQL proof is not HTTP acceptance. The complete
new candidate and all mandatory paired/security gates remain outstanding. No
Manager browser publication form, Employee publication filter, availability or
SaaS4 release is claimed by this preparation.

The complete local HTTP candidate check subsequently passed1646 native tests,
Customer live HTTP DAST and all17 Platform HTTP security cases. The HTTP runtime implementation remained unchanged; the foundation's ledger/documentation corrections were normally
integrated, retaining the HTTP work and every failure record. Actual new HTTP /
PostgreSQL and exact-head remote acceptance remain outstanding.
