# Owner REAL Customer access — implementation in progress

The approved Microsoft cutover requires the designated Platform owner to enter a
selected REAL Customer as Employee, Conference Manager or Tenant Admin under an
attributable own identity. This is a separate access path from invitations and
synthetic Demo workspaces. No existing Customer User is impersonated or adopted.
The canonical target remains [Microsoft cutover](MICROSOFT-MFA-CUTOVER.md).

## Current source boundary

The closed domain binds the exact environment, deployment UUID, integer Platform
epoch, both origins, pending original browser, actual operator, Customer and
selected role into one digest. The predictable UUIDv8 own User identifier is
stable across role changes and separated by environment, Customer and operator.
It is an attribution identifier, never a bearer credential or row-adoption grant.

The browser binding reuses the existing bounded MAC implementation through two
fixed wrappers. Legacy synthetic MAC bytes, errors, completion lifetime and CSRF
remain compatible; the owner namespace cannot accept a synthetic state, browser,
approval code, completion or CSRF even with the same root secret and scope.

The Platform policy requires all four roles, all-Customer scope and the exact
Microsoft normal/fresh contexts. A fresh private proof and its independently
issued normal continuation must retain actual provider identity, security
version, roles, authentication time and integer epoch. The application service
uses the existing fresh operator-management permission and consumes only its
injected shared Microsoft operation context. Browser input cannot choose proof
execution class or supply an own Customer User identity.

These are necessary checks only. An all-role principal does not prove designated
ownership. No owner REAL runtime, route, grant, migration, User, Customer session
or provider access is activated by these modules. The redirect result is private
until the enclosing proof/mutation/audit/continuation transaction commits.

## Required continuation

The separate persistence path must verify the original bootstrap and all-role
receipts, exact active operator/source/epochs, immutable REAL registry, actual
shared consumed proof, original digest, active own User/version and bounded
one-use browser/code/completion custody. Stable identity creation must reject an
unbound existing User and must never unsuspend a User or write ordinary elevated
Customer role grants. Every resolved session and final business/provider write
must recheck current owner custody; source logout, role/version changes and
Customer suspension revoke authority. Existing invited Microsoft/email sources,
synthetic custody, independent direct-role recovery and entitlement checks remain.

Anonymous start must not enumerate Customer existence. Native navigation retains
original-browser possession and explicit logout before replacing an unrelated
Customer account. Source/Customer lifetime uses existing session limits. Additive
migration, rollback/retention, minimal existing-role delta, signed attribution,
cross-Tenant/replay/concurrency tests and real paired browser qualification remain
required before runtime composition or any live acceptance claim.
