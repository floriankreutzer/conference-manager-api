# Protected invited Customer session preparation

The explicit protected invited-session factory derives a server-owned namespace
from the deployment environment and security epoch. The normal session service
additionally retains the existing source-controlled role-policy epoch in every
protected hash. Default production/closed Demo hashes remain byte-compatible;
none of their roots selects the new namespace or factory. No schema change,
deployment, revocation, provider activation or real mailbox operation occurs.

The resulting opaque Secure/HttpOnly/host-only cookie retains the existing path,
expiry, rotation, CSRF and audit contracts. Only the token hash is persisted.
Legacy, other-deployment and other protected-epoch cookies cannot resolve in this
factory, even against the same repository/origin. No browser parameter, provider
claim, email domain or arbitrary prefix selects the namespace. Explicit unknown
namespaces fail composition; equivalent UUID case is normalized. The factory
refuses Demo/test/delegated providers at invited issuance/rotation and requires
a repository contract matching the server environment/epoch. The PostgreSQL
protected invited-session repository joins the original admission/link
transaction, issues the ordinary session/audit and qualifies current real
membership on the same client before commit. Denied qualification rolls back
both records and any enclosing admission changes; it cannot leave a latent
cookie that becomes valid after later classification. Rotation uses that same
transactional qualification. Synthetic
delegation requires its separate authorized handoff/issuer and is not supported
by this invited-member repository.

After token resolution, the PostgreSQL access adapter independently verifies the
current deployment epoch, immutable real Tenant classification/lifecycle,
accepted environment/Tenant/User membership, current active User/version,
persisted session ID/provider/reference/times/roles/permissions and exact current
email or Microsoft identity binding. It compares the Principal against the
canonical current stored Customer role/permission policy. Unclassified,
synthetic, foreign, disabled, stale or mismatched custody fails closed. Reads
never merge accounts, create a User/membership, infer a Microsoft365 directory
claim or promote a Tenant Operator to Platform authority.

This repository verifies current custody after the owned namespace factory has
proved the cookie; a supplied Principal/registry descriptor alone is not an
authentication grant. Trusted session issuance still belongs to the existing
verified email/Microsoft admission transactions, with protected custody checked
before commit. Constructing this
factory does not expose an unauthenticated issuer or replace those proofs.
Neither concrete protected-session factory nor access repository may enter a
closed Demo import graph, directly or through a bridge. The pure namespace value
validator is shared by the existing ordinary session implementation; it performs
no provider, membership, persistence or runtime activation.

Unit coverage proves default hash compatibility, environment/epoch separation,
rotation/revocation, CSRF, closed namespace input, rejected Demo issuers and
single-client qualification/rollback orchestration.
Native tests are supplied for actual encrypted email admission, private registry,
current role/session/identity boundaries, same-database cookie isolation, explicit
fresh Microsoft linking through the actual pinned SDK with in-memory provider
responses, old-session invalidation, deployment epoch rotation and User disable.
Their actual execution must be reported against the exact source/CI run; unit
fixtures do not establish native or live provider acceptance.

Whole protected Customer/Platform composition, synthetic handoff/generations,
provider/worker dispatch, audited identity/history-preserving reset, verified
sender/owner, physical recovery keys and traffic-blocked deployment/restore
acceptance remain governed by `PROTECTED-INT-RUNTIME.md`. A public legacy Demo
surface must not coexist with real customer data. No formal security or
accessibility certification is implied by these prepared ports or passing tests.
