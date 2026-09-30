# SaaS 3.7 scenario acceptance corrections

## Scope and authority

Root `AGENTS.md`, the coding standards and the existing Shared Demo topology
remain mandatory. Frontend issue #215 owns full scenario and release acceptance;
this document does not mark that gate complete.

The approved Northwind scenario is a fully configured working booking demo.
Its inherited `provider_degraded` baseline prevented every new availability
check. The corrected fixture uses `booking_success` and healthy provider
projections. The pure simulated-provider tests still explicitly exercise
unavailable discovery, free/busy and calendar writes. The scenario browser
suite must also exercise fail-closed unavailable integration state, rather
than reporting a permanently broken Northwind scenario as a successful demo.

Fabrikam must have no local Sites, Rooms, Requests or imported mappings after
reset. A simulated external directory is a different owner: the source-defined
Fabrikam provider Tenant now offers two immutable synthetic discovery candidates
from `src/demo/provider/onboarding-room-inventory.js`. They do not become
application Rooms until the existing authorized Tenant Admin import commits.
Other and unknown provider Tenants never receive Fabrikam candidates. No new
HTTP control, role, persistence table, network transport or production fallback
is introduced. Existing connection, entitlement, CSRF, import and lifecycle
checks remain the authority.

## Baseline and rollout

The seed wire-contract identifier remains `saas-3.7-three-demo-customers-v1`;
its schema and migration inventory have not changed. This corrective **content
revision changes the canonical semantic checksum**, which is bound to an
immutable runtime commit by hosted acceptance:

- Previous content: `2a15426e761f6efb78409394888d6799e3f00c7e13500d8b937d1d0cece579f6`.
- Corrected content: `7e22005f1e9689fbea4ccfc75084f5f3d224fe10e60a6af23c1cb600f2b70014`.

Deploy mutually compatible Customer/Platform builds, then execute the normal
privileged Demo reset and verify the corrected checksum twice. A deployment
alone does not rewrite previously seeded provider-health rows. Never manually
edit database rows, sentinel, checksum or grants to hide a failed reset. Old
SaaS 3.6/3.7 evidence remains historical and cannot authorize the corrected
candidate. The synthetic external directory is immutable code configuration;
reset removes its imported local mappings through the existing reset inventory.

## Verification

`tests/saas37-onboarding-provider-inventory.test.js` reproduced both blocked
progressions before correction and verifies tenant separation, immutable
candidates, unchanged empty Fabrikam baseline and retained degradation failure
behavior. Existing fixture/provider tests continue to cover their original
contracts except for the explicitly corrected Northwind baseline expectation.
Run the full API quality, audit and PostgreSQL gates and cross-repository
scenario browser suite; retain exact source/runtime refs and actual results.

## Public Room descriptions

The complete visible scenario exposed that the application catalogue omitted
existing Room descriptions. Its public projection now includes only the bounded,
nullable description when the stored details explicitly contain it. The existing
tenant-scoped catalogue read and authorization remain unchanged. No provider or
private settings fields are added, and legacy presentation shapes remain valid.
Invalid stored text becomes null; frontend envelope validation and safe text DOM
rendering are covered independently. Projection bounds and the real ten-room
preview journey protect this correction. No schema or seed checksum change.

## Milestone metadata completion

The GitHub connector cannot patch milestone state. The scoped
`complete-saas37-milestone.yml` workflow handles this release metadata through
the repository's ephemeral `GITHUB_TOKEN`, with only `issues: write`.
It reads API #85–#89 and Frontend #212–#215 and requires every issue to be
`closed:completed`; milestone 1 must retain its SaaS 3.7 identity and have zero
open issues. Missing access or changed metadata fails closed. Pending work exits
without closing anything and is explicitly logged. Serial execution rereads current
state, and an already closed milestone is idempotent. The action does not close
issues, approve acceptance, change runtime data or deploy services. Only the
normal completed-issue event or explicit manual invocation can run it.

The API CI retains the deployed immutable frontend artifact selected from
`render.yaml`. Its shared-Demo test file is read from immutable acceptance source
`3818da326ec6a09e0bc2c72916df1ed97b280bf0`, which explicitly waits for the new
document after a persona/context reload. Only that test file is replaced; no
application module, dependency or static asset is taken from the acceptance
source. This corrects a WebKit test race where an unfinished reload replaced
edited fields before save. Expected branding, persistence and security assertions
remain mandatory. The original failed run is retained in PR #96's evidence.
