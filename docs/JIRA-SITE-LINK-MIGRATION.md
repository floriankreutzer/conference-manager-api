# Controlled Jira site-link maintenance

Tracking: CO-361. This manual maintenance workflow changes only the hostname in
explicitly selected existing remote links. It does not alter Jira issue status,
acceptance, PR registers, authentication settings, application data or deployments.

The operator inventories the approved work items and retains their link IDs in
the private work item. Supply at most 100 `CO-123:10001` / `KNMCP-12:10002` pairs
and SHA-256 hashes of the exact source and target hostnames. Private URLs, titles,
provider payloads and credentials must not appear in public source or logs.
The target hostname is obtained from authenticated Jira `serverInfo` for the
configured cloud and checked against the approved target hash. All network
requests use the fixed Atlassian API origin; linked URLs are never fetched.

1. Merge and qualify the reviewed workflow with all required checks and reviews.
2. Ensure no concurrent manual edits to the selected links during maintenance.
   The workflow shares the existing Jira writer concurrency group and protected
   environment. It does not create credentials, widen scopes or activate schedules.
3. Run `preview` on main with the approved IDs and hostname hashes. Inspect the
   selected/proposed counts and retain its digest and native run in the work item.
4. Run `apply` with exactly those inputs and the preview digest. The routine
   recollects the complete bounded plan before any write. Changed plans fail closed.
5. Retain the verified count and native run; independently read all selected IDs
   and inventory the remaining old-host links. A preview is never write evidence.

The existing writer must already have permission to read the account, site and
selected links and update remote links. An authorization error is a blocker, not
permission to widen its access. Required environment approvals remain in force.

Jira's documented PUT-by-ID clears omitted fields. The routine preserves all
writable metadata, opaque global IDs, relationship, titles and nested object
fields, changing only `object.url`'s host. Unknown top-level fields fail closed.
Path, query and fragment bytes remain unchanged. Every write has an immediate
source recheck and full readback, followed by a final readback of the entire plan.
Jira exposes no conditional update for this operation: the short interval between
recheck and PUT is not atomic against other editors. The maintenance window is
therefore required; workflow serialization alone cannot exclude interactive edits.

No automatic retry, create, delete or rollback occurs. On partial or uncertain
failure, read the affected links before proceeding. A fresh preview includes
already-current links without writing them. Approve its new digest only after
reconciling the retained successful/uncertain writes. Reversing a migration is a
separate authorized maintenance operation; the target must still match the cloud's
current site URL. Do not replay a stale plan or clear unrelated pending transitions.

Validation: `node --test tests/jira-site-link-migration.test.js`, `npm run check`,
`npm run audit`, and the repository's required CI/security/review gates. Fixtures
prove transport and preservation contracts only; actual provider execution and
independent readback remain separate acceptance evidence.

Provider contract: [Jira remote links REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/).

The existing read-only `Jira Register Diagnostic` also reports a fixed failure
phase and numeric HTTP status. This distinguishes configuration, transport,
response and register-schema failures without exposing provider bodies or
credentials. It does not change register validation or authorize readiness.
