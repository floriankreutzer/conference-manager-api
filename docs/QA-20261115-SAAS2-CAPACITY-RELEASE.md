# Protected SaaS 2 capacity-feedback source preparation

Tracking: CO-299; live acceptance coordination remains in CO-320/CO-326.
This candidate selects the shared Employee/Manager confirmed-booking capacity
feedback correction in [frontend PR486](https://github.com/floriankreutzer/conference-manager/pull/486).
It is source preparation, not Product Acceptance or a deployment receipt.

## Source identities

| Identity | Immutable source |
| --- | --- |
| API preparation base | `3800f82d7d91e35e2f2385a19cb69c5f159b132d` |
| Native protected API counterpart A | `529c1fff7982ec334136c3b23ace2a7169dc6cbc` |
| Selected frontend F | `53fa27a6b994f1559327f9764a0825fbee2e2165` |
| Frontend candidate CI checkout | `7bcc8ed4ed7fe613c470e21270bafc2500872976` |
| Frontend candidate run | [43734193644](https://github.com/floriankreutzer/conference-manager/actions/runs/43734193644) |

The candidate checkout and F must have the same complete tree. Frontend candidate,
merged Main, published API release source R, R Main and the later configuration
remain separate identities with separate required gates. R is the actual commit
publishing this Gitlink; never substitute a temporary local commit or the later
configuration commit in the runtime pin.

## Scope and qualification boundary

The frontend adds localized capacity feedback before submitting an impossible
room/participant combination. The API remains authoritative for tenant scope,
roles, versions, room prices, capacity and calendar admission. No schema,
provider, credential, feature flag, reset, seed or lifecycle change is included.

The complete A-to-base comparison preserves every application `src/`, migration,
dependency, wrapper/reader, wrapper-test, API CI, legacy `render.yaml` and
`vendor/demo-frontend` entry. Existing changes outside that application boundary
include Jira scope-revision tooling/tests, protected observer tooling/tests and
release/governance documentation. They are not repository-wide tree equality;
the current API base and this candidate require their own full native checks.
Recheck the complete diff if the source changes.

This candidate changes only `vendor/protected-frontend`, this record and the
source-selection paragraph in `docs/RENDER-PROTECTED-BUILD.md`. Existing
`render.int.yaml`, observer selections, workflows and all runtime files stay at
their current values. The protected browser evidence for A/F uses isolated
MSAL/calendar fixtures and does not prove real Microsoft, physical devices or
actual mail delivery.

## Remaining release sequence

Apply the existing [follow-up release contract](QA-20261109-SAAS1-FOLLOWUP-RELEASE.md).
Its explicit prepared-source rule permits this reversible candidate while
frontend qualification is pending; it waives no merge, Main or deployment gate.

Before R merge, require complete frontend candidate/review and independent Main
qualification, including both full engines, both protected engines and the
permanent three-customer/two-reset gate. Require the API base Main and R's own
native/security/review gates. Preserve historical failures and actual checkouts.

After R is published, perform two genuine clean R/F wrapper builds under Node 22
with initialized clean submodules and the existing nonsecret INT profile.
Independently verify all four artifacts, exact inventories/bytes/MIME types,
identical per-surface manifests and rejection of wrong digest/API bindings.
Keep actual commands, source identities and results in the owning Jira record.

Only after R/Main and artifact qualification, prepare and qualify a separate
configuration selecting R/F, both new digests and an exactly protected release
branch. Preserve the two existing Free/Frankfurt services, paused Blueprint
sync, origins, flags and operator-owned inputs. Review the actual provider plan
before application; require both real receipts, readiness, sealed-byte checks
and the authenticated capacity-error/correction journey after deployment.
Reconcile observer/DAST selections separately after actual successful receipts.
The current `405003e9be0c386934ae02be43d57dd12a6d8d6c` /
`26e3a75bfa15f0a2ea1373e7f8e6ccc61a224dfc` configuration and its recorded matching
digests remain the source-owned prior selection until that qualified change.

Real-provider, independent security, recovery, physical Safari and actual PDF
acceptance remain separately tracked. A source or fixture pass cannot close them.
