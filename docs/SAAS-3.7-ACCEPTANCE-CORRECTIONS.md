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

The seed wire-contract identifier remains `saas-3.7-three-demo-customers-v1`.
The current semantic checksum is defined by the source fixture and its tests.
Historical previous/corrected checksum comparisons and rollout execution details
are retained in internal release evidence; they do not replace the current
source-defined reset and immutable acceptance bindings.

Use mutually compatible Customer/Platform builds and the supported privileged
Demo reset, verifying the canonical checksum through both complete reset cycles.
A deployment alone does not rewrite previously seeded provider-health rows.
Never manually edit database rows, sentinel, checksum or grants to hide a failed
reset. Historical acceptance cannot authorize a changed candidate. The synthetic
external directory is immutable code configuration; reset removes its imported
local mappings through the existing reset inventory.

## Verification

`tests/saas37-onboarding-provider-inventory.test.js` protects Tenant separation,
immutable provider candidates, the empty Fabrikam baseline and retained degraded
provider failure behavior. Existing fixture/provider tests remain mandatory.
Run the full API quality, audit and PostgreSQL gates and the cross-repository
scenario browser suite; retain exact source/runtime refs and actual results.

## Public Room descriptions

The public catalogue projection includes only the bounded, nullable Room description
when stored details explicitly contain it. The existing Tenant-scoped catalogue
read and authorization remain unchanged. No provider or private settings fields
are added, and legacy presentation shapes remain valid. Invalid stored text becomes
null; frontend envelope validation and safe text DOM rendering remain required.
Projection bounds and the real ten-room preview journey protect this contract.
This correction does not change the schema or seed checksum.

## Historical completion and acceptance-source binding

The original milestone metadata readback and earlier WebKit reload-race correction
are retained in internal release evidence, including the failed run. Workflow
retirement does not retire the permanent three-customer/two-reset CI contract.
Any future milestone administration requires a fresh issue/evidence review.

Current CI owns the immutable served frontend and acceptance-source bindings.
A separately selected acceptance test file does not authorize taking application
modules, dependencies or static assets from that test source. Persona/context
reload handling must preserve branding, persistence and all security assertions;
historical successful runs do not certify a changed candidate.
