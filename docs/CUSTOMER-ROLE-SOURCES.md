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

Schema068 adds explicit direct-source, Microsoft directory and bounded group-ID
provenance to effective role rows. Existing rows remain direct grants. PostgreSQL
administration now preserves group sources when changing direct grants and supplies
`microsoftGroupRoles` from stored provenance. No provider synchronization or mapping
endpoint populates those columns yet; database fixture writes are not live group
acceptance. Session security versions advance on group-source mutations. Before activation, implement and qualify:

- Tenant/directory/group-ID/role mappings with Tenant Admin authority and audit.
- Validated, identity-bound provider membership observations including absent,
  incomplete/overage and revoked membership handling; no arbitrary Graph URL.
- Provider-driven atomic source reconciliation and last-admin/recovery safeguards
  across both sources, using the durable provenance and invalidation below.
- Consistent authoritative reads for Microsoft and email-code sessions, User
  lifecycle/suspension, invitation onboarding and protected real membership.
- Administration presentation showing source and effective roles, without letting
  direct removal erase a Microsoft grant or platform authority enter Tenant RBAC.
- Native database, cross-Tenant, concurrency, authentication/CSRF and permanent
  three-customer/reset/browser acceptance bound to immutable counterparts.

The policy tests cover all sixteen elevated-role source combinations and their
permission union, source removal, malformed authority and immutable input/output.
Passing these tests is not provider, database, live role or operating acceptance.

## Schema068 storage and direct-administration qualification

Effective role rows remain the existing `tenant_user_roles` authority consumed by
sessions/admission and business repositories. `direct_grant` defaults true, preserving
old invitation, claimant, recovery and deterministic Demo writes. Group-only rows
require a directory and 1–200 distinct non-null UUID group references; source-less
roles are forbidden. Removing direct grants deletes only direct-only rows, clears
only the direct flag on combined rows, and can subsequently add a direct source
without replacing group provenance. A retained group Tenant Admin is not removed
by direct-source changes. The existing transactional tenant lock, target scope,
active-User checks, role audit and session invalidation remain mandatory.

A database trigger advances the affected User's security version on group-source
addition/change/removal and forbids moving group grants to a different identity or
role. Old Customer sessions consequently fail their existing per-request version
check, including email-code sessions of the same linked User. Assigned roles do not
bypass suspension. Populated group provenance blocks rollback instead of silently
turning derived authority into direct authority. The migration itself creates no
group grant, membership, mapping or provider connection.

Native qualification explicitly seeds internal provenance to test source retention,
audit-failure rollback, cross-Tenant denial, version/session invalidation, retained
last group Admin, invalid duplicate groups and downgrade refusal. It is not proof
of Microsoft identity/membership validation. Provider mapping, reconciliation,
revocation/overage policy, source-aware administration UI and actual protected
operating acceptance remain required before group assignment can be activated.
