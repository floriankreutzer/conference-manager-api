# Protected SaaS 2 unused-catering correction source preparation

Tracking: CO-299; acceptance coordination remains in CO-320. This is a prepared
source candidate, not a qualified release or a successful deployment receipt.

## Exact source selection

Initial preparation started at API Main `096a90826861db825d88e5c79a221c430cb99cc8`.
The current candidate integrates subsequent Main
`69bcf28d0714df5b3e18917b3a95d4c2b4500809`, preserving its Jira site-link migration
workflow, bounded operator tooling and tests. No application runtime changed.
The protected frontend Gitlink selects
`dda63bc08bffacc1f80e2681e12bbee59d8fe4f6`, tree
`094e155d812a98f91cc20a70efa28d3b54d928d9`, from
[frontend PR489](https://github.com/floriankreutzer/conference-manager/pull/489).
The published API commit containing this selection is the prospective R.
Do not substitute a temporary local commit or later configuration commit for R.

The frontend corrects inherited, unused catering headcounts when reducing a
booking's participant total. Explicit catering overrides and actual package/item
selections retain strict validation. Its regression fixtures reproduce a persisted
headcount without selected catering in both Requests and Manager paths. This
source selection changes no API runtime, schema, authorization, CSRF, migration,
dependency, seed, reset, legacy Demo Gitlink or browser counterpart pin.

The complete comparison from frontend CI's API counterpart
`529c1fff7982ec334136c3b23ace2a7169dc6cbc` to this preparation base leaves
application `src/`, migrations, dependencies, protected wrapper/reader and API CI
unchanged. Differences concern release selections, observer and Jira tooling,
their tests and documentation. This is functional application equivalence, not
whole-tree equality or a substitute for the candidate's own native gates.

## Frontend qualification

Frontend candidate CI 45199284550 passed all gates, including 617 tests in each
full browser engine, both protected engines and three-customer/two-reset acceptance.
Its authentic review completed without findings. Merged Main
`03d59bfbe11949f12ed91e143e3479e16d1f1290` has the same full tree and independently
passed CI 45206805496, Secret Scan and release source evidence. The earlier API
candidate `3e1b54e0b2523eb0440ce3621a37c47f8124ddad` passed CI 45200491797 and review;
that historical result does not qualify the new Main-integration candidate.

## Qualification boundary

The prepared-source rule in
[the follow-up release contract](QA-20261109-SAAS1-FOLLOWUP-RELEASE.md) permits
reversible preparation while frontend qualification is pending. Before merge,
require the exact frontend candidate and authentic review, separate merged Main
qualification, and this API candidate's required native/security/review gates.
Both full engines, protected engines and three-customer/two-reset acceptance
remain required. A changed frontend source requires a new selection and checks.

Only after publication and qualification perform two clean R/F wrapper builds
under Node 22. Independently verify every artifact file, source/profile binding,
size, MIME type and digest, identical manifests and rejected wrong bindings.
Then qualify a separate configuration with an immutable protected release branch,
literal R guard, exact R/F pins and both verified digests. Review the actual
two-service provider plan and require both successful deployment receipts,
readiness, served-byte equality and authenticated valid-change/history/cancellation
acceptance before claiming delivery.

The existing R671/Ff89 selection and its actual receipts remain current until a
qualified replacement. This candidate leaves `render.int.yaml`, observer and DAST
selections unchanged. Keep Free/Frankfurt resources, paused Blueprint sync,
origins, flags and operator inputs. No paid resources, migration or reset.
Real Microsoft/Exchange, independent security/recovery, physical Safari and
actual PDF gates remain separate; this data-composition fix does not close them.
