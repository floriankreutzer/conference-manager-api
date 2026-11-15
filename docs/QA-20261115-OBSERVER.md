# CO-84 — Observer selection for the November 15 INT deployment

Reconcile the fixed observer selection to the existing R405/F26e release.
Provider receipts are Customer dep-dbsoc767bikc73c1bltg and Platform
dep-dbsoc767bikc73c1bl00. Their actual completion times are normalized to the
existing millisecond precision contract. Manifest pins match the independently
qualified configuration and full served-byte verification run 43706058470.
See QA-20261110-SAAS2-CONFIGURATION.md for the immutable release tuple.

The fixed frontend checkout and validator advance together. The prior frontend
is explicitly rejected by regression coverage. Runtime source, observer source
and observation time remain separate identities. This change neither deploys
applications nor creates a persisted observation.

Require candidate review, all native checks and independent merged Main gates
before setting the existing qualified observer SHA. Keep the schedule disabled.
Then execute one bounded owner dispatch and independently verify persistence
and the Runtime UI. Retain all epoch, role, ledger, private receipt, destination,
transaction, freshness and budget restrictions. No migration, reset, new secret,
resource or recurring execution is authorized by this source selection.

DAST, authenticated business journeys and independent product/security/recovery
acceptance remain separate gates. Historical observer records remain historical.
