# Combined Customer role sources

## Approved contract

Every active Customer member has Employee as the implicit baseline. Conference
Manager and Tenant Admin are independent elevated roles. Their effective union
comes from direct Tenant Admin assignments and separately approved Microsoft-group
mappings. Removing one source must retain a role still granted by the other.
Suspension blocks authentication/access independently of these assigned roles.
Group display names, domains, raw group claims and browser values grant no roles.

## Implemented policy increment

`authorization/tenant-role-sources.js` owns bounded normalization and the canonical
union of internal elevated-grant projections. Both sources remain separate,
immutable arrays; only their union is projected to the existing public User shape.
The existing User administration service uses this canonical validation for direct
mutations and combines a trusted repository's optional `microsoftGroupRoles` with
its direct `elevatedRoles` when projecting a User. Its authorization, CSRF, self-role,
last-admin, suspension, audit and persistence boundaries remain in their owners.
No API field allows a browser to submit Microsoft-derived roles. Platform roles,
unknown roles/groups, duplicates within a source, sparse arrays and accessors are
rejected. Duplicate roles across the two valid sources combine once.

## Remaining integration — not an active Microsoft role-assignment feature

Current PostgreSQL administration still persists only its original direct role
model and does not provide `microsoftGroupRoles`. Therefore this source increment
preserves current direct-role behavior; it does not synchronize groups or make
production sessions consume group grants. Before activation, implement and qualify:

- Tenant/directory/group-ID/role mappings with Tenant Admin authority and audit.
- Validated, identity-bound provider membership observations including absent,
  incomplete/overage and revoked membership handling; no arbitrary Graph URL.
- Durable separate provenance, atomic effective-role reconciliation, session
  invalidation and last-admin safeguards across both sources.
- Consistent authoritative reads for Microsoft and email-code sessions, User
  lifecycle/suspension, invitation onboarding and protected real membership.
- Administration presentation showing source and effective roles, without letting
  direct removal erase a Microsoft grant or platform authority enter Tenant RBAC.
- Native database, cross-Tenant, concurrency, authentication/CSRF and permanent
  three-customer/reset/browser acceptance bound to immutable counterparts.

The policy tests cover all sixteen elevated-role source combinations and their
permission union, source removal, malformed authority and immutable input/output.
Passing these tests is not provider, database, live role or operating acceptance.
