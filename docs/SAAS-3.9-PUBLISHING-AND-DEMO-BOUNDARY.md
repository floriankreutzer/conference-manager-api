# SaaS 3.9 — Publishing and Hosted Demo Boundary

## Status

The SaaS 3.9 delivery path and application-source visibility cutover are implemented. Both application repositories are private; Website and Developer remain public. Protected post-private CI and the existing Hosted services have verified the approved delivery path. SaaS 3.9 issue #254 and milestone 12 are closed. The independent SaaS 3.6 gate #170 remains open and does not reopen the completed infrastructure/security scope. Dated release evidence remains bound to its exact tested/deployed pair.

## Repository boundary

`conference-manager-api` remains private and remains the trusted backend and canonical source of API contracts. Public partner documentation belongs in `conference-manager-developer` and must contain only explicitly approved external artifacts.

The backend source repository must never be made public merely to publish API documentation.

## Public API publication

SaaS 3.9 issue #250 establishes deterministic publication of approved external API contracts from this private repository. The implementation uses the dedicated `Conference Manager API Publisher` GitHub App (App ID `5173007`) to mint short-lived installation tokens at workflow runtime. The App is installed only on `conference-manager-api` and `conference-manager-developer`; the private key is stored only as an Actions secret in this private repository.

Required properties:
- private backend source remains canonical;
- publication starts from an immutable source commit;
- public material is explicitly allowlisted;
- internal/private endpoints and schemas are excluded by design;
- validation, sanitization or secret-scan failure stops publication;
- public output is versioned and traceable to its source commit;
- contract drift is detected;
- negative tests protect against accidental publication of private-only material.

SaaS 4 #236/#237 own the generic Caterer API contract and documentation content. SaaS 3.9 owns the publication mechanism.

## Hosted Demo transition

Render checks out the immutable `vendor/demo-frontend` Git submodule using its existing authenticated repository integration. `demo:hosted:prepare` verifies that its exact commit equals `DEMO_FRONTEND_REF`, copies only the allowlisted browser artifacts, and excludes Git metadata. Preparation performs no anonymous source fetch and fails closed on a missing or mismatched checkout. Both manifest pins and the Gitlink must identify the same merged frontend commit.

The implemented controlled immutable frontend artifact:
- is traceable to the exact frontend source commit;
- has verifiable integrity;
- fails closed when missing, mismatched or untrusted;
- preserves Customer and Platform same-origin serving and their separate session/API boundaries;
- does not require an ad-hoc long-lived GitHub PAT/deploy key in Render;
- preserves the permanent three-Demo-customer and two-cycle reset acceptance invariant;
- preserves exact immutable cross-repository acceptance.

The prerequisite was satisfied before the visibility cutover. Fresh private-source builds of both existing Hosted services and reciprocal private-source CI succeeded. Updating the frontend requires a protected API pin/Gitlink change and new paired deployment; an earlier successful build does not certify a new pair.

## Cutover gate

SaaS 3.9 #254 records the final application-source visibility cutover and its acceptance after #247–#253 prerequisites. Post-cutover CI, Render, reciprocal acceptance, repository protections, dependency/security gates and anonymous public links are revalidated before closure. Required frontend quality now runs the repository-owned Semgrep CE policy and conservative lockfile/SPDX checks; private CodeQL is unavailable and equivalent full-query coverage is not claimed.

Repository visibility never permits secrets or confidential data in source control. Existing secret, dependency, static/SAST, tenant-isolation and authorization controls remain mandatory.


### Publication execution contract

The workflow is manual and fail-closed. It requires an approved `public-api-release/publication.json` bound to the exact backend commit and requested semantic contract version. Only explicitly allowlisted release files are staged. Obvious credential material is rejected before any cross-repository token is minted. The workflow then requests a short-lived App token scoped to `conference-manager-developer`, creates a deterministic publication branch, copies only the staged artifact into `openapi/`, and opens a pull request. It never pushes directly to Developer `main`.

The Developer repository's independent Public documentation safety workflow remains the publication gate. SaaS 4 #236/#237 still own the first real Caterer API contract/release; SaaS 3.9 does not create a placeholder API solely to exercise the pipeline.
