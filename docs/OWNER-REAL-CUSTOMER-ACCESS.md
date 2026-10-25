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


The first072 native CI40143761367/job121020948319 failed at the Platform
own-binding lookup: PostgreSQL SELECT FOR SHARE requires an UPDATE privilege,
while that table deliberately grants only SELECT/INSERT. The lookup now uses a
plain SELECT on the immutable attribution row. Its UPDATE/DELETE/TRUNCATE guards
and enclosing owner advisory/current-target locks already serialize creation;
actual mutable source/User/session locks and current qualification remain. The
native fixture explicitly requires readable/creatable but not mutable rights.
No privilege or negative assertion is widened. Renewed native qualification is
required; this failed run remains historical evidence.


The same candidate's four permanent Demo jobs stopped before browser execution
because the independent Demo startup constant still required overlay031 while
migration032 had been applied. The runtime now requires032, retaining exact-ledger
fail-closed readiness. The migration-stream test compares both actual independent
migration tails against their runtime readiness constants, in addition to the
existing explicit version assertions. No startup assertion, wait budget, browser
suite or reset case is relaxed. Those failed startup jobs do not establish any
browser acceptance; all four complete jobs must run again against the correction.


Corrected candidate8f007261e9a50c97cf5c45fd7e7b893118fe3c3f passed the
actual restricted TLS/SCRAM/max-one native owner admission/write-custody test in
CI40144120924/job121022050985, followed by Microsoft group and exact-proof native
coverage. Both synthetic assurance profiles then reached their real lifecycle
paths. The Microsoft profile's old direct populated071 down assertion encountered
new empty072 first, so the run correctly failed the unchanged expected rejection.
That branch now explicitly drains only empty072 before asserting the original
populated071 recovery rejection. No down guard or expected rejection is removed.
Full native and all-browser qualification remain required; the failed run remains
failed evidence even though its new owner-native step passed.


## Explicit process composition candidate (not live)

The separate runtime branch adds default-off PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED
and independent PROTECTED_OWNER_HANDOFF_SECRET / Platform intent secrets. Explicit
MFA Platform configuration alone can enable it; application-passkey profiles,
inactive supplied owner secrets, malformed flags and cross-purpose aliases refuse.
Both surfaces retain their own database roles, client IDs, CSRF, source budgets,
namespace and public origin. No app passkey or credential minimum is constructed
by the Microsoft owner path.

Customer construction owns invited/synthetic fallback and the private owner
issuer. Its five-method HTTP session facade alone reaches business handlers.
The owning outer API execution scope retains the existing shared deployment lease
and a live immutable authority scope. Only the successfully qualified owner
Principal is observed there, before business writes. Fixed actual Microsoft
network methods use the owned write guard; normal provider URL/timeout/retry
contracts remain with the existing client. Readiness requires both private owner
source-lock function grants. The REAL calendar final-authority branch now
independently verifies the same current owner custody before checking the
existing Microsoft Tenant/integration/resource bindings.

Platform construction injects only its actual shared Microsoft operation instance
into the closed owner approval protocol. The original source predicate has a
current-owner half for the bounded directory and an independently locked REAL
target half for preparation/approval, preserving provider/version/time/receipt
checks. No fake target/flow identifier is needed for directory qualification.
Owner-only /api/v1/platform/auth/owner arrive/intent/options/approve routes use a
separate Strict signed intent, bounded UUID keyset target pages and the canonical
normal-source CSRF/operation cookies. The browser may request only REAL target
UUID/selected Customer role; identity, generation, slot and credential-response
fields refuse. Source, actual current registry and exact shared proof remain
independent authorities. An invalid /arrive cannot create an authenticated session.
Native approval remains a top-level fixed Customer303 after committed proof,
audit and normal continuation. Legacy synthetic route/cookie wrappers preserve
their exact namespace and explicit route-module contract without a gate exemption.

Focused source tests cover both process constructions in DEV/INT/PROD without
provider/database I/O, closed flags/secrets, own directory/selection HTTP,
CSRF/account-change/commit/redirect failures and legacy HTTP/cookie regression.
The native owner fixture is extended to start both actual process roots over
restricted max-one TLS/SCRAM roles, read current own session/target intent through
real HTTP, deny injected identity before provider work, and deny the old own
session after source revocation. It retains a deterministic concurrent source-row
lock denial before the final write and restarts the actual Customer process after
revocation. The fixture deliberately does not contact real Microsoft; its positive
exact proof remains the separately identified MSAL fixture. Native execution of
this extension and the paired real frontend/browser journey remain pending.


Candidate64ea688486b47bf3f5dc7b36041921af611ecb1e failed native
CI40145381516/job121025792749 at invitation persistence startup: its explicit
current-ledger readiness probe still requested71 after migration72. The fixture
now probes72; the following explicit empty072 rollback and all populated
invitation custody assertions remain unchanged. The failure is retained and
requires a fresh complete native run; no readiness check or suite is removed.


Runtime candidatec4764e9662bb939acadf83fb3cb10f7fcd594b05 failed
CI40146347767/job121028402596 before tests because the new hosted-manifest
fixture declaration exceeded the canonical140-character style limit. The
declaration is wrapped without changing behavior. That run proves no native
or browser acceptance; all required checks must execute on the correction.


The corrected readiness candidate failed full native CI40146228534 /
job121028666131 at demo-request-attribution-reset-grant.test.js:116: its current
overlay constant assertion still expected31 although the same fixture already
listed032. The constant and complete reapplication list now require32. A full
source search also found four obsolete CURRENT_SCHEMA_VERSION71 assertions in
historical migration fixtures; these now require72. Historical target versions,
role grants, rollback sequencing, negative assertions and time budgets are
unchanged. The complete native run must qualify this correction.


Runtime597b9d20a7e559b88323bb5dab7100b1ba0e9069 passed its early
Owner native step in CI40146508230/job121029135774, including both actual
process roots, current-target HTTP, source-row concurrency denial and actual
Customer process restart after source revocation. Its later full native run
remains distinct. The new fixture extension additionally refuses adoption of
a pre-existing deterministic own User ID and refuses automatic reactivation of
a suspended User. A fresh exact approval is required after fixture-only restore.
It observes an actual SQL source lock held during an isolated provider attempt
and denies the next attempt after revocation before calling that provider port.
These new cases require renewed native execution. No real Graph/Microsoft call,
provider/device acceptance or externally atomic booking claim is made.


The final Owner native fixture additionally drives the actual Platform native
approval POST, committed303, actual Customer cross-site callback/Strict
confirmation, explicit old-account logout, final native completion and replay
denial. The isolated actual MSAL adapter verifies only the exact shared proof
using the same test transaction key; both independently constructed production
roots still own final one-use proof, audit, source continuation and session
admission. Neither root receives an issuer or provider adapter injection. This
is fixture provider verification, not live Microsoft MFA. Full dual-engine
real-root browser navigation remains a separate release gate.


Candidatebc1bb8689f44f2cf81035d01feb9a32df9bdf7c4 failed early native
CI40146997272/job121030787490 at the new fixture-only reactivation assertion.
The fixture changed active directly without the security-version increment
performed by the canonical Tenant User lifecycle repository. Both isolated
state changes now retain that version increment; the assertion that the old
session cannot revive remains unchanged. No production reader, expiry, role
or suspension check is relaxed. New native qualification remains required.


Candidateda05cfd6ce188a3c2d1224cfcaee32425be3fe44 failed early native
CI40147287367/job121031672327 before new HTTP admission: the expanded fixture
requested a sixth proof inside the unchanged five-per120s bound (consumed proofs
also retain that bound). Tenant Admin admission now runs through the actual HTTP
root as the third role case, following two adapter admissions and the two
negative ceremonies. No extra restore admission is needed. The old session after
User lifecycle version change must return401 at actual Customer HTTP startup;
final exact HTTP admission then supplies the new own identity. Wrong-browser,
wrong-CSRF, replay and stable identity/no ordinary-grant assertions cover the
third role there. A sixth start is explicitly required to fail. The limit,
retention, clocks, waits and production protocol remain unchanged.


## Qualified-site Owner browser fixture candidate

A separate fixed test child registers a loader only for the Platform identity
adapter's SDK import. The fixture still uses the actual pinned Microsoft SDK,
with its existing in-memory provider network. It supplies fresh MFA/nonce/time
claims, not a business/session issuer. Production entrypoints never register
the loader and no production configuration/factory injection port is added.
A local Node22 fixture test exercises the actual adapter and claim policy,
one-use assertion and nonce rejection. The first local iteration expected a
normalized identity before invoking the existing claim policy; that test-only
shape mismatch is corrected, with production contracts unchanged.

The paired browser harness starts both actual process roots on restricted
TLS/SCRAM/max-one database roles, exact hosted artifacts and fixed distinct
qualified HTTPS origins. Only the external provider document/network are
isolated; options, callback, status, native approval, current directory,
Customer original-browser completion, explicit account switch and all three
role admissions reach actual roots. Evidence retains only exact source refs,
closed counts, signed-chain results and the fixture-provider classification.
Real Microsoft/device acceptance remains unproved. No app key, ordinary User
role, adopted identity, synthetic target or real external provider request is
created by the harness. Full paired Chromium/WebKit execution remains pending.


Runtime candidated8d1d10d4ca46dd524a808a5b5939f79c34e9638 failed
CI40148068749/job121034089070 at the new actual native approval POST (401).
The fixture used the raw OIDC input for its proof MAC, while the actual root
correctly derives a purpose/environment/UUID-bound authentication-flow key.
The fixture now uses that existing canonical derivation. No root key, MAC,
proof namespace, cookie, CSRF or claim check is weakened. Paired browser
CI40148190764 reached actual approval/callback/completion in both engines,
then failed on the Customer session presentation: the old frontend session
parser accepted UUID1-5 while the stable own identity is the specified UUID8.
That separate frontend contract must align with canonical server UUID1-8 and
retain malformed-ID/role/permission denials. Both failures remain historical.
