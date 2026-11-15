# Protected SaaS 2 INT configuration — 10 November 2026

Tracking: CO-320 and CO-322. This configuration binds the existing Customer and
Platform INT services to the prepared immutable source and independently checked
artifacts below. It is not a provider deployment receipt or Product Acceptance.

## Immutable selection

| Input | Exact value |
| --- | --- |
| Published API source R | `405003e9be0c386934ae02be43d57dd12a6d8d6c` |
| API source tree | `14e7f2a8bfd71eee81b716fc64dfc55e9f218b0f` |
| Protected frontend F | `26e3a75bfa15f0a2ea1373e7f8e6ccc61a224dfc` |
| Frontend tree | `e5ff91c2ec543f71d48971f59c2c8484953b7043` |
| Selected release branch | `release/int-20261110-405003e` |
| Customer manifest SHA256 | `016663458140e74636a99ac2c28907aea26ab6634c92f4065181f98c145601d3` |
| Platform manifest SHA256 | `0f2aae70f45ad7be5684c2864c57e9275253438d0e240b7eacf0155a564c0f9b` |

R is the published source in [API PR414](https://github.com/floriankreutzer/conference-manager-api/pull/414),
not the later configuration commit. The complete comparison with native API
counterpart A `529c1fff7982ec334136c3b23ace2a7169dc6cbc` retains all 1,891 existing
entries outside the two changed existing paths. Only the protected Gitlink,
`docs/RENDER-PROTECTED-BUILD.md` and the added dated source record differ.
Application, migrations, scripts, tests, dependencies, API CI, legacy Demo and
acceptance contracts retain their exact blobs and modes.

The actual frontend candidate checkout is
`d4ee97f316ad7a71220dc220359e121fd1d9c474`, with the same complete tree as F.
Native A/checkout-d4ee qualification and derived R/F artifact preparation remain
different evidence. The wrapper does not itself prove A-to-R functional equality.

## Native source qualification checkpoint

At the 10 November 2026, 23:00 UTC configuration-preparation checkpoint, the
following independent executions had completed successfully:

| Source stage | Actual native evidence |
| --- | --- |
| API correction A | [Candidate CI42903780419](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42903780419), actual checkout `f299dd04d94d59ac11cb7411eec0e0e3a8b98e44`, with A's complete tree `451ed24c9b2bef1a99bbf5e1a0eac7618f029593`. All nine required PR contexts passed. |
| API correction Main | Actual `277f0356b2ea607811e5322bbce7206eb31bcb30`, same complete 451ed24c tree; separate [CI42908156540](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42908156540), completed successfully at 22:12:30 UTC. |
| Selected frontend candidate | [CI42906433157](https://github.com/floriankreutzer/conference-manager/actions/runs/42906433157), actual checkout d4ee above, completed successfully at 22:13:34 UTC. Both full regular and protected engines, permanent Shared acceptance and the fail-closed aggregate passed. |
| Frontend Main | Actual `af835e5690c6a6e53498f26e400198b690a2af71`, complete tree e5ff91c2 identical to F and d4ee; separate [CI42913158171](https://github.com/floriankreutzer/conference-manager/actions/runs/42913158171), completed successfully at 22:56:15 UTC. All seven CI jobs, Gitleaks, inventory and Main attestation passed. The protected Main executions bind A529 and actual af835. |
| Release source R candidate | [CI42910778710](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42910778710), actual checkout `b68fb59ab74e0803f4b472a65d8f2f773bfadb2b`, with R's complete 14e7f2a8 tree; completed successfully at 22:35:37 UTC. All six CI jobs and nine current required PR contexts passed. |

The frontend candidate ran 1,086 Quality tests, 611 cases per full regular
engine and five per protected engine, including all four new CO-322 DE/EN
regular-engine cases. The complete three-customer/two-reset gate passed. Its
Shared database step retains four existing zoom-routing skips; the two actual
headed Chromium zoom cases passed separately. Do not describe the entire Shared
suite as having no skips.

The API A, correction Main and R candidate Quality executions each passed
2,775 tests with no failed or skipped cases, the isolated HTTP security smoke,
17 Platform HTTP security tests and dependency audit with no reported
vulnerabilities under Node 22.23.4. R's complete database suite passed 400 tests
across 148 TAP process summaries, followed by its separate actual elapsed
proof-expiry case, 1/1 passed. The older same-source R metadata-triggered run
42910767921 remains cancelled and is excluded from qualification.

After complete frontend Main qualification and a fresh head/base, required-check,
review and unresolved-thread check, PR414 was normally merged. Actual API Main
`6c7b14e75989091ca950a86a17df2adb648134b5` has parents Main277 and R405 and the
same complete 14e7f2a8 tree. Its separate [Main CI42919473144](https://github.com/floriankreutzer/conference-manager-api/actions/runs/42919473144)
was running at this checkpoint. The prepared configuration was fast-forward
reconciled to this actual Main without changing its three-file prepared tree.

This dated source checkpoint does not predeclare R Main's completion or this
configuration's later PR/Main results. Complete those required checks before
release application, and require successful R Main before the configuration
merge. Record later actual results in the owning [CO-320 record](https://acckreutzer-1733338800840.atlassian.net/browse/CO-320)
and the internally maintained SaaS 2 acceptance evidence.
The later Main and configuration commits do not replace R in the immutable
runtime selection above.

## Two actual clean builds and independent reader

Two independent clean API R checkouts, each with its own initialized clean F
submodule, ran the unchanged `node scripts/render-build-protected.mjs` under
Node 22.22.3. The wrapper performed locked installs with lifecycle scripts
disabled. The resulting build receipts were written on 10 November 2026 at
22:07:21.676 UTC and 22:07:22.148 UTC.

Both used the existing explicit INT profile: Customer origin
`https://conference-manager-demo.onrender.com`, Platform origin
`https://conference-manager-ops-demo.onrender.com`, synthetic mode and owner
Customer access enabled, and Microsoft/invitation presentation enabled only for
the build command. The actual full R/F identities were supplied explicitly.

At 22:10:29 UTC the existing independent API artifact reader verified all four
artifacts. Every sealed file, returned byte sequence, length, SHA256, MIME type,
inventory entry and source/profile binding was checked. Customer manifests were
byte-identical between builds, as were Platform manifests. Each artifact rejected
a wrong externally supplied manifest digest and a wrong API source identity.
Both API and frontend source checkouts remained clean afterward.

| Surface | Files per build | Sealed file bytes per build |
| --- | ---: | ---: |
| Customer | 315 | 2,336,220 |
| Platform | 197 | 1,525,010 |

These are actual local R/F build and reader results. They do not establish a
native browser run against R/F, provider delivery, real Microsoft or device
assurance, private-mail delivery, or operational acceptance. The completed native
protected A/checkout-d4ee runs used isolated MSAL/local-calendar fixtures and
explicitly reported `actualMail=false`.

## Configuration validation

The bounded semantic change is exactly five values per existing service:
release branch, literal API build guard, API commit, frontend commit and that
surface's manifest digest. The leading comment selects this dated record.
Preserve existing Free/Frankfurt plans, one instance, automatic deployment and
previews off, origins, service version, feature flags, start commands, readiness
paths, all operator-owned `sync: false` inputs and the unlinked legacy group.
No resource, credential, migration, reset or new presentation capability is added.

At 22:15:24 UTC, a complete parsed before/after comparison confirmed exactly
those ten semantic values across both services and equality of every other
configuration value. Both manifest pins were read from the actual double-build
verification. The retained official Render Blueprint JSON schema accepted the
file with YAML 1.2 boolean semantics (`off` remains a string); a malformed boolean
`autoDeployTrigger` negative control was rejected. The literal shell guard
accepted an actual clean R405 checkout and rejected an actual A529 checkout.

The configuration's full validation and native candidate/Main receipts must be
assessed on its actual final source before application. A valid artifact or YAML
document alone is not sufficient. Do not substitute this later configuration
commit for R in the literal guard or runtime inputs, and do not derive trusted
manifest digests automatically from the running build.

## Required source and provider gates

The [dated source record](QA-20261110-SAAS2-FOLLOWUP-RELEASE.md) retains the exact
A/F identities and source-preparation checkpoint. Require complete frontend
candidate and separate merged Main qualification, including both full regular
and protected engines and permanent three-customer/two-reset acceptance. Retain
the actual frontend Main and its complete tree relationship to F. Require the
API baseline Main, R's current-base review/native qualification and separate
Main, and this configuration's own candidate and independent Main checks.

Before syncing the existing paused Blueprint, verify the actual release branch
at exactly R and an active exact-branch rule prohibiting updates, deletion and
force pushes without bypass actors. Re-read the current provider state and
review a concrete plan containing only the five intended values on each of the
two existing services. If resource, plan, credential, schema or unrelated
changes are proposed, reconcile them before any application.

After an authorized application, observe actual deployment state before any
additional deploy request. Require both successful deployment receipts, exact API
identities, readiness and independent matching of every served sealed byte,
length and content type. Use authorized normal Customer/Platform authentication
and business journeys; do not reset shared data to obtain a passing smoke test.
Only then reconcile observer and live DAST selections through their own required
qualification. The earlier failed live COEP scan remains historical evidence.

## Rollback and acceptance limits

The preceding [R15b/F28a configuration](QA-20261110-SAAS1-CONFIGURATION.md)
retains its actual build identities and matching manifest digests. If recovery
is necessary, reconcile real provider/data state first, restore the complete
prior branch/guard/API/frontend/manifest tuple on the same services, preserve all
operator inputs and data, and verify actual successful recovery receipts and
served bytes. This release contains no schema rollback or credential rotation.

Real Microsoft/Exchange, independent external security intake and the final
provider recovery exercise retain their own existing acceptance criteria. The
separately repaired duration defect does not establish the original Safari
cause. No fabricated provider receipt, live security pass or Product Acceptance
is recorded by this configuration.
