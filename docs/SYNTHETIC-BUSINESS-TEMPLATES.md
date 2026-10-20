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
unchanged. Media bytes still belong to the existing Demo asset storage; this extraction does
not create a new media loader or alter checksums, filenames or object-storage behavior.

Template IDs and requester references are fixed source placeholders, never authenticated
identity or runtime classification. A future protected provisioning adapter must allocate new
Tenant/User/resource IDs, consistently remap references, provide its own pure media port and
persist the complete graph transactionally. Returning templates grants no membership, role,
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
