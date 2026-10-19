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
