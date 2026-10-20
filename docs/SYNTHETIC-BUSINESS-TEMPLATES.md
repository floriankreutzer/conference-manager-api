# Shared synthetic business templates

`src/synthetic/business-templates.js` supplies independent copies of the three canonical
customers' fixed business facts. The legacy Demo fixture consumes this factory and adds its
own existing provider simulation and persona authority. Protected INT consumers can reuse the
facts without importing the public Demo's identity, reset or runtime graph.

The business template version is `saas-3.7-three-customer-business-v1`; its SHA-256 over
`JSON.stringify` is `f43a3116c7e06df8910d7368d049c30fe0d1efb97a4601157329664aca19dbdd`.
The public factory verifies this digest before returning each mutable clone. Private raw data
is importable only through that factory. The existing complete Demo semantic checksum remains
`7e22005f1e9689fbea4ccfc75084f5f3d224fe10e60a6af23c1cb600f2b70014`;
neither its seed version nor its permanent progression/reset contract changes.

Northwind retains ten rooms and twenty requests. Contoso retains its three authoritative
business requests. Fabrikam retains its empty onboarding catalogue/location/request state.
Settings, cost centers, requests, room/catalogue media metadata and detail content remain
unchanged. Fixed media bytes now live under `src/synthetic/media` and are read through
`src/media/synthetic-template-media.js`. The source adapter selects only known template asset
IDs, resolves filenames exclusively from the checked fixed manifest and verifies byte length,
SHA-256 and PNG/WebP signature. It returns new bytes per read and exposes no filename, provider
destination or Tenant authority. The legacy Demo seeder reuses this source; its persisted
media checksums, routes and object-storage contract remain unchanged. Recovery/load fixtures
read the same moved bytes. Git preserves the original asset blobs without content changes.

Template IDs and requester references are fixed source placeholders, never authenticated
identity or runtime classification. `createSyntheticGenerationPlanner` allocates a fresh
generation ID, three Tenant IDs, independent resource IDs and three Customer User IDs per
Tenant. It remaps requester, room, catalogue applicability, equipment, package/item/variant,
cost-center and media-owner references. Semantic service identifiers stay fixed. Media-source
references retain only their fixed template asset ID for later verified loading; they are not
provider destinations. The planner rejects PROD, extra authority fields, malformed scope and
colliding/invalid allocator output immediately without retry. Its environment, epoch, operator
and captured security version are server-supplied candidates, never proof of current authority.

The shared pure scheduling function retains local start times and request durations in the
next future week across Berlin/Paris summer-time changes. Both the unchanged Demo generation
wrapper and the planner use that same implementation. Frozen UTC expectations and canonical
fixture checks protect the date contract. Each plan contains only business data, internal
synthetic roles/permissions and fresh IDs; no real identity binding, credential or session.

`persistence/postgres/business-fixture-state.js` owns the shared business-only seed SQL.
Callers explicitly provide verified media bytes, same-Tenant media creators and the catalogue
media writer. It does not create identities, classify Tenants, select a provider, reset data
or append Platform authority. The Demo wrapper retains its own identity/provider/Platform
seeding and Demo-only catalogue table. The shared media persistence helpers retain the existing
batch draining and private-object integrity contracts; old Demo exports remain compatibility
aliases. Existing prepared-statement/error names remain stable for legacy diagnostics.
Request seeding selects the actual package variant ID rather than deriving it from a package
ID, allowing fresh independently allocated package/variant IDs while preserving canonical
Demo snapshots. Protected provisioning must still supply its own reviewed catalogue persistence,
authorization, current custody, transactional audit and complete semantic readback.

A future protected provisioning adapter must consume this verified media port and persist
the complete graph transactionally after checking current operator/proof/deployment custody.
It must never accept a caller's arbitrary data plan as authority. Returning templates grants no membership, role,
session, Platform scope, provider configuration or permission to reset customer history.

`check-module-boundaries.mjs` prohibits direct raw-data access and runtime/provider/identity/
persistence imports in the pure template graph, including transitive domain bridges. Its
source checks supplement reviewed dependency direction; they are not a JavaScript sandbox.
Tests pin the old complete checksum, the new business digest, full structural equality,
copy independence and negative direct/transitive dependency cases.

This data-only change introduces no migration, dependency, route, feature activation, sender,
external request or deployment. Operator-owned generation provisioning, audited archival,
browser-bound delegation, provider dispatch and protected composition remain separate work
under frontend issue #351 / SaaS1. Required native database and four paired permanent
progression/two-reset CI gates remain mandatory before accepting this extraction.
