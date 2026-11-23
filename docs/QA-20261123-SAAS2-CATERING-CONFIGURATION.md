# Protected SaaS 2 unused-catering correction configuration

Tracking: CO-299, CO-320, CO-85. This is a configuration candidate, not a live
deployment receipt or Product Acceptance. It changes no application runtime,
schema, migration, tenant data, credentials or ownership boundary.

## Immutable selection

| Input | Value |
| --- | --- |
| Published API runtime R | `67527b7e054191cd51686d733b9b5575e7beccee` |
| Protected frontend F | `dda63bc08bffacc1f80e2681e12bbee59d8fe4f6` |
| API source tree | `c079747ad8c673a5e1cb4ff451314bbdb7c324f6` |
| Frontend tree | `094e155d812a98f91cc20a70efa28d3b54d928d9` |
| Source-only release branch | `release/int-20261123-67527b7` |
| Exact active branch ruleset | `27923248`; updates, deletion and force pushes forbidden, no bypass actors |
| Customer manifest SHA256 | `52e641d94e1284f19b44665fcfe08c1d9343bbfbc3cb4ad779a8b72cd81aca03` |
| Platform manifest SHA256 | `21fefc4a4a50e0bfb3d9175dfc7f14acf9b584559a29c0b59750f7c19b747052` |

R is the published source selection from API PR429, not its later Main merge
`97b429370727a4d223afbdef29ff86cacba00c74` or this configuration commit.
The source record is [retained separately](QA-20261123-SAAS2-CATERING-SOURCE.md).

## Qualification evidence and remaining gates

Frontend PR489 candidate CI 45199284550 and independent Main CI 45206805496
passed, including 617 cases in each full engine, both protected engines and
the three-customer/two-reset progression. Its exact review had no findings.
API source candidate CI 45232591966 passed all six jobs; dependency-policy,
gitleaks and inventory passed, with an authentic no-findings review of R.
Local source `npm run check` passed 2,855 tests, the HTTP DAST smoke and 17
Platform security tests; `npm run audit` reported zero vulnerabilities.
Source Main CI 45237078546 was started after merging PR429 and remains a
separate required gate: inspect its actual terminal result before application.

Two genuine clean checkouts at R with separately initialized F were built with
`scripts/render-build-protected.mjs` under Node 22.23.4. Both used the existing
INT origins and explicit synthetic, Microsoft, invitation and owner-access flags.
The independent API reader verified all four artifacts, every file digest,
length, MIME, inventory and profile binding. Both Customer builds contain 315
files / 2,338,875 bytes; both Platform builds contain 197 files / 1,525,393 bytes.
Each surface produced identical manifest bytes across builds. Wrong manifest
digests and wrong API bindings were rejected in all four cases. No file-mode
guard or source-cleanliness check was disabled.

Qualify this configuration's own exact candidate, authentic review and separate
Main native checks. Preserve any historical failure; earlier source CI is not a
substitute. Verify the precise ten-value YAML/schema diff and malformed-boolean
and wrong-source-guard negative controls before merge.

## Provider application and rollback

Only five semantic fields per existing service change: frozen branch, literal
API build guard, API source pin, frontend source pin and corresponding manifest.
Keep the existing paused Blueprint `exs-daakihlg1s2s73df6jdg`, Customer
`srv-daakprhsrm7s73f82deg`, Platform `srv-daakprhsrm7s73f82dg0` and the retained
unlinked legacy environment group. Preserve Free/Frankfurt/one instance,
auto-deploy/previews off, origins, version, start/readiness paths, build-only
presentation flags and every operator-owned input. No reset or new spending.

The actually observed rollback pair is API
`671d8837402f8d70b022550321834389132126bd` / frontend
`f89a71e7ed590c6fab78423f24d65953cb3f6c3e`, branch
`release/int-20261115-671d883`. Its successful 22 November receipts are Customer
`dep-dc1knbavcj2c73erod00` and Platform `dep-dc1knbavcj2c73eroc50`; matching
manifest digests remain in the historical mode-configuration record.

After all gates, review a fresh actual provider plan for exactly ten intended
field changes, then apply it to these existing resources. Require two fresh
successful receipts, readiness and independent complete served-byte equality.
Exercise the retained synthetic booking's valid reduction, history, reports and
cancellation through normal authenticated controls. Keep Employee-only acceptance
separate from the Conference Manager session. Record results in Jira and reconcile
observer/DAST source selections afterward without dispatching another observer
or enabling its schedule. Actual Microsoft/Exchange, independent security and
recovery, physical Safari and actual PDF acceptance remain separate requirements.
