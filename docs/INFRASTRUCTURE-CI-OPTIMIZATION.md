# Infrastructure CI optimization

Tracking: floriankreutzer/conference-manager#433 (INF-06–11).

Run local applicable gates before pushing one coherent candidate. Do not rerun an
unchanged complete workflow without diagnosing the previous failure. Required
source, security, browser, three-customer and two-reset gates remain mandatory.

Weekly Dependabot version updates group npm minor/patch changes and GitHub Actions
separately. npm majors stay separate; security updates are not included in these
version-update groups. Existing schedules and five-PR limits remain unchanged.

Multi-checkout jobs cache npm package downloads using all checked-out lockfiles,
not node_modules. Immutable acceptance copying only replaces the explicitly
allowlisted test/support files; it does not mutate package-lock.json. Every checkout
still uses npm ci with lifecycle scripts disabled. Cache misses must work normally.

Release evidence checks out its pinned standalone tool before setup-node hashes
that tool's lockfile. PR updates share a concurrency group; non-PR runs use their
unique run ID so pending main evidence is not replaced by a later commit. Main
attestation permissions, source binding and tamper tests are unchanged.

The separate dependency workflow is retained for now (INF-10): removing a workflow
without a genuinely shared validated result would only rename the same work. A
future consolidation must preserve required status names, license checks and
fail-closed aggregation, with a measured benefit. No required check is removed.

The dated audit is a baseline, not a promised saving. Compare cancelled-run share,
runner minutes per successful candidate, cache hit/miss setup time and dependency
PR count in comparable windows. Current public-runner usage is not an invoice;
private-source restoration requires separately verified quota and read access.
