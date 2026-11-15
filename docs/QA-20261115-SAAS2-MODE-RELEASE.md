# Protected release source after executable-mode repair — 15 November 2026

Tracking: CO-299, CO-320. This is reversible source preparation, not a
successful provider receipt or Product Acceptance.

## Selected counterpart

Base API Main: `4f52cae617f590c134643d2dd05d846dfca923d1`.
Select frontend `f89a71e7ed590c6fab78423f24d65953cb3f6c3e`
([PR487](https://github.com/floriankreutzer/conference-manager/pull/487)).
Its full tree is `e50b74fba6dfdaa4a801e9e5d830533d5e0789ed`.
The API commit publishing this Gitlink is the prospective runtime R; the later
configuration commit is never a substitute for R.

The frontend restores only the executable metadata of the existing ZAP runner,
strengthens its direct-execution regression and adds dated evidence. Its script
blob remains `4e6d10778344eb14d44fc99ca5c31876f380ae40`; all application
bytes from the qualified capacity-feedback source remain unchanged.
This API change selects that Gitlink and adds this record. It does not change
runtime code, the build guard, dependencies, migrations, legacy Demo bindings,
credentials, flags, provider configuration or observer/DAST selections.

## Superseded attempted selection

API `aa732f9765858343a8f82bff7bb7ed81d780b903` and frontend
`53fa27a6b994f1559327f9764a0825fbee2e2165` passed their recorded source
and artifact gates. Their configuration PR422 also passed candidate and separate
Main qualification. Actual protected INT builds refused the dirty frontend
checkout: the ZAP runner was committed as `100644` and present as `100755`
in the provider checkout. A cache-free attempt also failed. The existing guard
correctly blocked release. No successful deployment of that pair is claimed.

The original provider build command was restored after bounded failure-only
diagnostics. Do not weaken clean-source checks, ignore file modes or rewrite
source before the guard to conceal the mismatch. Keep all failed evidence
historical in the owning Jira work item.

## Remaining qualification

The prepared-source rule in
[the follow-up contract](QA-20261109-SAAS1-FOLLOWUP-RELEASE.md) permits candidate
preparation while frontend checks run. Before API merge, require the exact
frontend candidate/review and independent Main gates, the API base Main and
this candidate's native checks/review. Compare complete source and candidate
trees; legacy shared-Demo browser pins are not this protected frontend identity.

After publication, reproduce two genuinely clean R/F builds and independently
verify the artifacts and negative bindings. Qualify a separate configuration
with a frozen release branch, explicit source/digest pins and both candidate/Main
gates. Review the actual two-service plan, obtain both successful provider
receipts, verify every served artifact byte and finish authenticated live
capacity correction/cancellation before claiming release acceptance.

The prior R405/F26 deployment remains the live baseline until actual successful
replacement. Advance observer and DAST selections only with successful receipts
and separate qualification. Real-provider, independent security, recovery,
physical Safari and actual PDF gates remain independently open.
