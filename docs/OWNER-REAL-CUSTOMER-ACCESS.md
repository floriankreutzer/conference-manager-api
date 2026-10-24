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

The fixed owner protocol and legacy synthetic wrapper share one commit-safe
orchestrator. Preparation releases its short lease before operation execution;
the injected operation instance retains its own shared/exclusive transaction
class. Owner intent rejects generation/slot and credential-response fields. A
failed mutation or commit returns no redirect/normal continuation result.

The private Platform current-source SQL port requires an actual transaction
inside the owned shared deployment lease. It checks the unique bootstrap and
all-role receipts for the actual operator, current all-role/all-scope Microsoft
normal source with exact provider/version/time/expiry and a current REAL target.
It holds actor, source, deployment and Tenant read locks. A separate all-role
operator without the original receipts remains denied. Its native fixture uses
actual bootstrap/upgrade/session/audit adapters and separate max-one pools; native
execution remains pending because PostgreSQL is not available locally.

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


The first native source run40139063843 failed the positive owner read because
Platform sessions use database microsecond timestamps but canonical Principals
expose millisecond ISO values. The source comparison now uses that existing
canonical precision for issued/expiry snapshot equality; actual revocation and
expiry against clock_timestamp() remain exact. Native coverage verifies the
mapper's precision and denies even a one-millisecond change in either supplied
snapshot. No timestamp, TTL, provider, role or receipt check is removed. The
failed run is retained and renewed native execution remains required.
