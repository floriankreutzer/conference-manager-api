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
execution passed in candidate d2158746fb9ed59c8c32f4378d431eff205f95ce, CI40139954452 and independent Main40141577240. PostgreSQL remains unavailable locally.

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
failed run is retained and the qualified renewed native execution and independent Main passed; the original failed run remains historical evidence.


## Additive owner custody candidate (not activated)

Migration072 adds separate bounded original-browser handoffs and immutable own-User
attribution, without changing any existing migration. The stable predictable User
identifier cannot adopt an existing unbound User, change suspension, or write
ordinary Customer role grants. Initial creation retains its actual consumed shared
Microsoft proof and signed approval sequence. Completed browser flow rows can
later expire without pinning a permanent browser-capacity slot; proof cleanup
excludes both all retained owner flows and stable initial identity attribution.
Destructive down/reset refuses retained owner identity, sessions or history.
Demo032 grants only explicit empty-child TRUNCATE participation in the canonical
reset. All earlier rollback and permanent Demo assertions remain mandatory.
No business seed/checksum change is intended.

Two fixed private wrappers reuse start, cookie, admission, HTTP and owned-session
implementations. Synthetic wire names, cookies, MAC bytes, namespace, error codes
and confirmation shape remain compatible. The owner path uses separate narrow
Lax browser and Strict completion cookies, a fixed /api/v1/auth/owner callback,
and an approved REAL target/role confirmation. Anonymous start looks up no target.
Callback GET never issues a Customer session. Only final same-origin CSRF POST
may consume the approved original browser/code and issue the attributable own
session. An unrelated current account requires explicit logout; a same-owner
role/target switch can revoke its own previous session despite the newly revoked
old Platform source. Issuance and signed Tenant audit commit with flow consumption.

Owner qualification is the exact owner_delegation/platform_owner pair in REAL
runtime only. It independently rereads bootstrap/all-role receipts, current normal
source, shared consumed proof, signed approval and active own User/version on each
resolved request. Invited membership, synthetic custody and unknown provider/kind
pairs cannot inherit owner authority. The private Customer lock port serializes
actor/source, then current Tenant, User and session with NOWAIT. Target UPDATE
locking avoids a SHARE-to-UPDATE upgrade; a conflict denies before business work.

The optional pool-owned transaction authority scope admits only an immutable
already-qualified Principal before business work in the owned request scope.
Every actual write transaction invokes the independent current owner lock/read
precondition before its work callback. Nested work joins only the same transaction;
new transactions recheck even if the physical max-one client is reused. Read-only,
unadmitted, ordinary and unregistered pools keep their existing paths. Conflicting
or expired request scopes, late admission and recursive write preconditions deny.
No SQL inspection, whole-request transaction, isolation change or provider policy
enters the generic transaction adapter. The owner composition wraps only the
actual Microsoft client's fixed network methods to retain this custody during
an external attempt, with existing bounded provider retries re-entering the guard.
External provider effects remain distinct from local transaction atomicity.

The fixed owner_customer grant delta retains exact accepted Main, sole configured
actor, first-run, ordinary logging, offline schema owner, checked source ledger,
segment/deployment, signed audit and both-role drain checks. It grants no Customer
Platform mutation, no runtime bootstrap and no User-identity creation to Customer.
The separate Platform approval adapter alone creates and signs the own identity.

Current limits: these candidate adapters/route factories and the write composition
are inactive until the explicit process roots, fixed configuration and actual
provider/HTTP/browser journey are composed and qualified. Native072 execution,
actual least-privilege TLS/SCRAM, source-revocation/concurrency and full historical
persistence/Demo regression remain required. The early native owner CI step is
additional coverage in the existing job; it replaces no complete release gate.
No live migration, role grant, User/session creation, provider setting or deployment
is established by this source work.
