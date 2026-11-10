# SaaS1 QA follow-up INT configuration — 10 November 2026

Tracking: CO-320 and CO-85. This configuration binds the existing protected INT
services to the qualified frontend selection in API PR405. It is a proposed
deployment configuration, not a provider receipt or Product Acceptance.

## Immutable selection

| Input | Exact value |
| --- | --- |
| Published API source R | `15b4f45ccd834548344e3859ef39996a2f885ece` |
| API tree | `43616ea6eb17ea6047776dd74c7d1f93f2c3b4f1` |
| Protected frontend F | `28a864ea6b1d4f5ae0e0066a072f6012e059358d` |
| Frontend tree | `5ec76c98c20bcbbe06cfe582c9578ceeafbccf68` |
| Intended release branch | `release/int-20261110-15b4f45` |
| Customer manifest SHA256 | `553df57678dd87fa6e196167c98a852cba76e2346721a38d4d611a107a4a0133` |
| Platform manifest SHA256 | `9d8643c58e8fb9335f427780af60124d1c2db624b5786632a4a2f3f864dd5c93` |

R reconciles Main `8a83fdf8b5bd96249e46e73a43bb1b594d4d3fa5`, which merged
PR408's bounded ADF node-metadata reader. The merge tree was independently
computed locally and matched the published tree. Relative to that Main, PR405
contains only the protected frontend Gitlink and its two release documents.
Product `src/`, migrations, dependencies and protected build script are unchanged
from R290. The frontend selection is unchanged. The operator-reader change is
separately qualified and does not alter runtime authority.

The configuration commit is later than R. Its own SHA must never replace R in
the source guard, environment pins or artifact profile. A source change requires
new builds and new digests; neither mutable Main nor the earlier R290 manifests
can satisfy this selection.

## Two real builds and independent verification

On 10 November 2026, two separate, clean API checkouts at R, each with its own
initialized clean frontend submodule at F, executed the unchanged
`node scripts/render-build-protected.mjs` using official Node 22.22.3. Both
executions installed their locked dependencies through the existing wrapper.
The explicit profile was:

- environment `int`;
- Customer origin `https://conference-manager-demo.onrender.com`;
- Platform origin `https://conference-manager-ops-demo.onrender.com`;
- synthetic and owner Customer access enabled;
- Microsoft and invitations presentation enabled, supplied only to the build.

Both builds returned the exact digests above. The manifests were byte-identical
per surface. At 17:16:33 UTC, the independent API artifact reader verified every
file, length, digest, content type, inventory and source/profile binding in all
four artifacts. The verification also compared each returned file's actual bytes
and content type against the manifest and expected extension. Wrong manifest
digests and wrong API source identities were rejected. API and frontend Git
working trees remained clean.

| Surface | Files in each build | Total sealed bytes in each build |
| --- | ---: | ---: |
| Customer | 315 | 2,334,767 |
| Platform | 197 | 1,524,705 |

Earlier R290/F28a builds remain historical evidence only. These artifact checks
are preparation evidence for R15b/F28a; they do not replace native source checks,
review, separate Main qualification, provider acceptance or authenticated journeys.

## Local configuration validation

The complete `npm run check` passed with Node 22.22.3: 2,774 tests,
syntax/style/architecture/static-security/secret/dependency checks, the HTTP
security probe and all 17 Platform HTTP security tests. `npm run audit` reported
zero vulnerabilities. The official Render Blueprint JSON schema accepted the
configuration; a parsed before/after comparison allowed exactly the five values
per existing service listed below. The literal shell guard accepted R15b and
rejected the earlier R290 checkout.

The first local check attempt had 23 strict CLI stderr failures caused solely by
the execution environment's injected `UNDICI-EHPA` experimental proxy-agent
warning. The same complete check passed after suppressing that specific warning
with Node's `--disable-warning=UNDICI-EHPA`; network hooks, other warnings, test
assertions and repository sources were retained. This is local toolchain
qualification, not a product fix or replacement for the native GitHub checks.

## Bounded provider change and acceptance

`render.int.yaml` changes exactly five semantic values on each existing service:
branch, literal build source guard, API commit, frontend commit and that surface's
manifest digest. Existing Free/Frankfurt plans, one instance, automatic deployment
and previews off, origins, service version, feature flags, start commands, health
paths, operator-owned `sync: false` values and the unlinked legacy environment
group remain unchanged. No resource, secret, migration or data reset is added.

Before applying the existing paused Blueprint, require:

1. Exact R/F source, review and separate Main qualification, plus this
   configuration candidate's and Main's own required native checks.
2. Actual release branch at R with an active rule targeting that exact branch,
   prohibiting updates, deletion and force pushes, without bypass actors.
3. Fresh provider readback and a plan containing only the bounded changes above
   on the two existing services. Stop if another task changed the baseline or
   the provider proposes resource, plan, secret, schema or unrelated changes.

After application, inspect actual deployment state before requesting any extra
deploy. Record both successful deployment IDs/times, readiness and API identity.
Match every served sealed byte, length and content type to the corresponding
artifact. Use normal authenticated Customer/Platform journeys; an expired owner
session is a test-access blocker, not a successful journey or reason to reset data.
Only then reconcile observer and DAST identity selections in their own qualified
changes. Public readiness alone does not prove a persisted database observation.

The full sequence and acceptance limits remain in
[the follow-up source runbook](QA-20261109-SAAS1-FOLLOWUP-RELEASE.md).
The November 9 source, both manifest pins and provider receipts in
[the prior release record](QA-20261109-SAAS1-RELEASE.md) remain the rollback
baseline. Restore the whole matching branch/guard/API/frontend/digest tuple on
the existing services if rollback is needed, then verify actual recovery receipts
and bytes. Retain all operator-owned inputs and data.

This file intentionally contains no fabricated deployment receipt. Actual
provider, observer, DAST and Product Acceptance outcomes are recorded only after
their separate execution and readback.
