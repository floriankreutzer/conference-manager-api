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

## Metadata-triggered cancellation

Ordinary CI keeps title edits and draft-to-ready events, including the existing
Jira title/branch validation and every source/security/browser/database gate.
Those metadata events join the PR concurrency group without cancelling its
running validation. A newer source event can still supersede stale PR work.
Main runs have unique run-ID groups so each merged commit keeps its separate
qualification. GitHub still keeps at most one pending run per group: a later
pending event can replace an earlier pending event. This is not an every-event
delivery guarantee, metadata deduplication, or a measured runner-minute saving.
No successful skipped surrogate or reusable unverified result replaces a gate.

## Browser prerequisite mirror selection

The existing bounded APT preference recognizes the runner image's Azure and
`us-east-2.ec2.archive.ubuntu.com` mirror entries. Exactly one recognized cloud
entry at priority 1 and one existing official Ubuntu HTTPS archive at priority 2
are required before swapping only those two priorities. Duplicate, ambiguous,
commented or unfamiliar entries remain unchanged. The workflow never adds a
repository or changes signatures, keys, suites, components or TLS policy.

The ordinary and two operational browser workflows retain the same policy,
verified by executing their actual Python against isolated mirror-list fixtures.
This handles the observed AWS package-download stall without increasing job
budgets, adding test retries or reducing browser/customer/reset coverage. The
operational workflows remain manually governed; source tests do not claim their
live Neon or restored-pair acceptance has been executed.
