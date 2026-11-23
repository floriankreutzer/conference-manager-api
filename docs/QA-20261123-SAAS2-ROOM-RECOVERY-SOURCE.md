# Protected SaaS 2 room-change recovery source preparation

Tracking: CO-299; overall acceptance remains in CO-320. This is a prepared
source candidate, not a qualified release or a deployment receipt.

## Exact source selection

The candidate extends API `e3fccfd550af3806761fb36ef082015c8f878f35`
([PR432](https://github.com/floriankreutzer/conference-manager-api/pull/432)),
which binds target calendar creation to the selected provider resource without
weakening the strict adapter. Its composed-adapter regression reproduces the
missing binding, room replacement, rollback and foreign-tenant rejection.
The protected frontend Gitlink selects
`2e452aff6e5d3db6f040065faece0146e1c6ec19`
([PR491](https://github.com/floriankreutzer/conference-manager/pull/491)).
It exposes the existing same-change approval recovery for persisted `applying`
proposals and retains those proposals in Action required. No automatic retry,
new role, endpoint, persistence format or dependency is introduced.

The published API commit containing this Gitlink is prospective source R.
This source selection changes only the protected Gitlink and this record
relative to e3fccfd. Legacy Demo selection, counterpart pins, migrations,
seeds, reset, runtime configuration and observer selection remain unchanged.

## Qualification boundary

Frontend CI `45281672505` pairs F with exact API e3fccfd; it was still running
when this source was prepared. Its exact-head authentic review completed without
findings. API e3fccfd CI `45280481531` was also still running, with its exact
review completed without findings. Neither pending run is a passing receipt.
Local Node 22 checks passed 1,098 frontend and 2,857 API tests, 17 Platform
security tests and API HTTP DAST; both dependency audits reported zero findings.
Local frontend browser execution was blocked by missing binaries and denied
download, so native full Chromium/WebKit evidence remains required.

Require both component candidates and separate merged Main qualification, this
source candidate's own native/security/review gates, and full permanent Demo
progression/reset coverage before application. The source application code is
identical to the exact e3fccfd counterpart used by F; the release Gitlink is a
separate binding, not a replacement for paired tests or its own source gates.

After publication, execute two genuine clean R/F wrapper builds under Node 22.
Independently verify all sealed bytes, lengths, MIME types and source/profile
bindings, identical manifests and rejection of incorrect bindings. Qualify a
separate configuration selecting a frozen protected release branch, literal R
guard, exact R/F pins and both independently verified digests. Keep the existing
paused Blueprint, Free/Frankfurt resources, origins, flags and operator inputs.
Do not reset data, migrate schema or create paid resources.

## Live acceptance still required

Until qualified replacement, the observed deployed pair remains API
`67527b7e054191cd51686d733b9b5575e7beccee` / frontend
`dda63bc08bffacc1f80e2681e12bbee59d8fe4f6`; its receipts are retained in
[the earlier release record](QA-20261123-SAAS2-RELEASE-VERIFICATION.md).
After both successful provider receipts, readiness and served-byte verification,
resume the retained synthetic proposal through normal authenticated controls.
Verify changed room, participants, cost, history and reports, then cancel the
test booking normally and prove released capacity. Do not repair the journal
or booking directly in the database. Employee-only, actual Microsoft/Exchange,
independent security/recovery, physical Safari and actual PDF acceptance remain
separate; this source preparation closes none of those gates.
