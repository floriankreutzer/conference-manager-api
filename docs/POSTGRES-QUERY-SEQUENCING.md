# PostgreSQL query sequencing

Catalogue snapshots and reference validation, Tenant activation readiness and
Platform projection sources await each query before submitting the next query
on their existing client. They do not rely on the pg8 client queue to accept
overlapping submissions. The pinned driver warns that this behavior will be
removed in pg9; this change does not upgrade the driver.

The existing transaction, isolation level, Tenant predicates, parameter values,
prepared-statement names, locks, audit and rollback boundaries remain owned by
their current repositories. No connection, privilege, migration or runtime flag
is added. Independent transactions can still execute concurrently. Catalogue
prevalidation through the ordinary pool also reads its two reference sets in
sequence; no latency improvement is claimed.

Business-fixture Room and Catalogue media publication also runs one item at a
time: publication includes database intent locks and metadata writes on the same
client, not just independent provider I/O. The provider-only read batch helper
retains its bounded concurrency and draining behavior. Sequential publication may
increase seed/reset latency; full native reset and object-storage browser gates
must still pass without extending their time budgets or changing seed semantics.

On failure, later reads have not been submitted. The transaction adapter can
roll back after the failed query settles and release the existing client. This
does not justify suppressing driver warnings or moving protected reads to a
second connection outside their enclosing transaction.

`tests/postgres-sequential-queries.test.js` rejects overlapping client queries
and yields every successful query. It covers all four affected paths, exact
query-failure propagation, no later submission, rollback before release,
Tenant parameter binding, missing Tenant and failed readiness. Before the fix,
nine of its ten cases failed; after the fix all ten passed. These adapter tests
do not substitute for real PostgreSQL, migration, restricted-role or paired
three-customer/two-reset browser gates. Those remain required in native CI.
The media-fixture tests additionally use an asynchronous strict client and inject
failures in the upload lock, Room metadata and Catalogue metadata paths, checking
that rollback/release follows the exact error without subsequent publication.
