# Protected integration runtime

## Status and accepted scope

This is the implementation contract for replacing the public Shared Demo with
the protected integration runtime. It is not deployment or migration evidence.
The existing closed Demo and permanent three-customer acceptance remain intact.
The `dev`/`int`/`prod` mapping in `DEPLOYMENT-ENVIRONMENTS.md` is authoritative.
Only INT is initially operated; DEV and PROD are prepared without provisioning
additional resources. Separate them before the first productive customer.

The pure `src/tenancy/protected-tenant-runtime.js` policy validates a closed
registry descriptor against server-selected environment and internal Tenant ID.
It rejects unknown/unclassified modes, foreign scope, malformed epochs, inactive
synthetic generations and every synthetic Tenant in PROD. Real and synthetic
provider branches are disjoint. This classifier itself creates no registry row,
session, role, provider connection or production composition.

The prepared `src/identity/protected-customer-session-service.js` composes the
ordinary session service with a mandatory current-access repository port. It
re-reads custody on every resolution, validates registry scope, permits only
invited email/Microsoft access for real Tenants and a separate operator-delegation
kind/provider for synthetic Tenants. Unknown custody fails closed; repository
availability errors propagate without fallback. Existing issue/CSRF/revoke/rotate
contracts remain with the ordinary service. This uncomposed guard has unit
evidence only; the authoritative PostgreSQL session-access binding repository and
native concurrency/negative acceptance remain required before activation.
The architecture gate excludes the guard from both closed Demo import graphs.

The prepared protected provider gate fixes one adapter mode at composition,
validates current scope inside a mandatory locked-registry callback, permits only
one operation invocation and never retries or falls back. Its repository port
must retain the protected shared lease for the entire bounded provider callback.
The prepared PostgreSQL runtime repository implements that mode-lookup port with
current deployment epoch, immutable registry, Tenant lifecycle, generation and
real operator status/version checks. It is not composed with concrete outbound
adapters. Native tripwire evidence must identify its exact source/run separately;
unit evidence does not establish deployed outbound isolation.

The private PostgreSQL protected-runtime gate provides transaction-scoped shared
HTTP/worker leases and exclusive reset/cutover leases, separated by deployment
environment. It uses fixed two-integer advisory-lock namespace740193 and immediate
try-lock failure, with no wait/retry. Acquire it before ordinary business/proof
locks. Safe same-scope nesting joins the same client; shared-to-exclusive upgrades,
cross-pool/environment nesting, joining unmarked business transactions and reuse
by detached descendants after release are denied. The existing transaction
adapter owns commit/rollback/connection release. The gate is uncomposed; its new
native concurrency test still requires actual PostgreSQL execution before any
concurrency or reset-safety acceptance claim.

Draft canonical059 and closed-Demo overlay025 add four private custody tables:
current deployment epoch, append-only epoch history, retained synthetic
generations and immutable Tenant registry. No existing row is classified or
migrated into a generation. Former epochs cannot be reused; generation owner,
epoch and identity are immutable, only forward lifecycle transitions are allowed,
activation requires all three unique slots and archival requires archived Tenant
rows. Retained generations have a hard32-per-operator/environment bound; the
application reset cooldown and provisioning/audit service remain unimplemented.
Synthetic generation ownership requires a current Microsoft Platform operator,
not a Demo operator. This metadata is not authentication or operation authority.

The protected metadata mutation triggers acquire the same immediate exclusive
lease, so they cannot archive during a provider callback's shared lease. A narrow
read-only SECURITY DEFINER TRUNCATE trigger permits only the exact fixed trigger
path and empty custody. Populated protected custody rejects even an accidentally
invoked legacy Demo reset. All four tables have no Customer/Platform/Reset Demo
CRUD; only the closed Demo reset retains TRUNCATE on empty custody. PUBLIC and
Demo roles have no explicit execution grant on private functions. Populated down
migration requires verified recovery. Accepted058/024 and earlier checksums are
unchanged. Existing rollback probes drain only the new empty059/025 layer before
their unchanged older guards; current readiness/closed reset inventory advance
mechanically. Native migration, privilege, lifecycle, epoch-reuse, provider/reset
contention and retained-history tests require exact-source execution evidence.

On2026-10-20, initial source052d7188 passed the two new native protected lease and
registry suites in CI39444281483/job118702723489. The later unchanged attribution
suite failed its old current-schema58 assertion after the advance to59. Three
remaining current-readiness constants were corrected without changing their
attribution/location/rollback/security assertions. The first full native failure
remains failed; the corrected source needs all nine required current-head checks.
PR251 and frontend SaaS1 issue351 retain current acceptance and failure history.

## Persistent authority to implement

Each protected Tenant has one immutable deployment/mode classification. Current
deployment epochs rotate through monotonic revisions with retained non-reuse
history, independently from immutable real Tenant classification.
Existing Demo IDs and display names never infer a classification. Existing real
customers need explicit reviewed classification; unknown records remain hidden
and cannot authenticate in the protected runtime. No automatic whole-database
classification or conversion of fake-persona Users is permitted.

Real Tenant creation registers `real` in the same authorization/audit transaction
as the owner-inclusive invitation batch. Invited email admission and subsequent
explicit Microsoft linking preserve their separate proofs and current accepted
memberships. Microsoft login does not establish a Microsoft365 directory binding
or admin consent. Tenant Operators retain Customer `tenant_admin` authority only.

Synthetic Tenant classification additionally binds an actual Platform operator,
generation UUID and one fixed Northwind/Contoso/Fabrikam slot. A generation has a
monotonic lifecycle and the three new Tenant IDs. The registry cannot switch a
real Tenant to synthetic or attach a retained Tenant to a new generation.
Generation creation/reset has bounded per-operator growth and cooldown; reaching
the bound denies new generations rather than deleting retained evidence.

Canonical custody migrations after the Microsoft integration use the next
unaccepted schema version. Accepted migration/checksum history remains frozen.
The closed Demo overlay must exclude private protected-runtime custody. Its
fixture-only reset can know the empty private tables for referential integrity;
the protected runtime never imports or invokes that TRUNCATE/reset authority.

## Identity and cross-origin handoff

The protected Customer resolver accepts only current invited real memberships or
an explicitly mapped live synthetic delegation. Ordinary session validity is
necessary but not sufficient. It also rechecks registry environment/epoch/mode;
synthetic sessions recheck operator enablement/security version, originating
Platform session, generation activity and their bounded delegation record.
Legacy Demo persona sessions and bare synthetic provider references are denied.
Operator revocation invalidates delegations, without revoking unrelated real
Customer memberships. External credentials are never linked to fake Users.

Customer and Operations remain separate same-origin surfaces with host-only
cookies. A synthetic entry starts on Customer with browser-bound state/cookie,
then navigates to the fixed configured Operations origin. A real current Platform
session and a fresh operation-bound WebAuthn proof authorize only an allowlisted
role/slot/current generation. The fixed Customer callback requires the original
browser cookie and current operator/session/epoch/generation before issuing the
ordinary mapped Customer session. A URL bearer, browser-selected Tenant/role,
forwarding header or reused elevated cookie cannot authorize the handoff.

## Generations, history and providers

A reset archives the old synthetic generation through ordinary lifecycle and
audit transactions, invalidates its sessions, then provisions three new Tenants
from the versioned pure business templates. All old business and audit rows,
real identities, Platform keys, real Tenant/Pilot data and invitations remain.
No lifecycle rewind, broad deletion, TRUNCATE or credential remapping occurs.
The directory exposes authorized real customers and only the operator's current
three synthetic slots; archived/unclassified records are not active choices.

Pure business templates must be shared without importing Demo identity,
provider, runtime, reset or fixed credential authority. Existing closed Demo
semantic seed/version/checksum and full progression remain regression protected.
The synthetic generation receives fresh internal IDs and server-selected dates.
All references must be remapped consistently, with bounded fixture validation.

Every outbound-capable integration, worker and technical configuration path must
recheck registry mode before selecting its provider. Synthetic generations use
only explicitly composed network-free simulators. Real Microsoft365, catering,
mail or other outbound adapters cannot receive synthetic Tenant operations.
Missing real-provider configuration reports unavailable rather than connected
simulation. Archived/unknown generations fail closed even on delayed jobs.

## Whole-fleet activation and evidence

Both public Demo entrypoints must be closed/replaced before any real customer
data is admitted. A mixed deployment with the public Demo all-Tenant Platform
scope is forbidden. Migration, source/artifact pair, session epoch, ordinary and
private runtime roles, both origins, provider-mode policy and worker configuration
are one traffic-blocked coordinated cutover. An old binary or database restore
must not reopen legacy sessions or expose real customers through Demo authority.

Readiness must report the exact schema and protected runtime configuration.
Rollback/recovery keeps traffic closed until compatible custody and both runtime
surfaces are restored and fresh authentication succeeds. No live database,
provider credential or plan is changed by preparing this contract.

Acceptance requires actual PostgreSQL constraints, concurrent generation/reset
and proof fencing, retained real/history rows, old-session/archived-mode denial,
cross-operator/Tenant negative tests, outbound tripwires, authenticating Customer
and Platform HTTP, exact immutable frontend/API counterparts and complete
Northwind/Contoso/Fabrikam progression with two resets in Chromium/WebKit against
PostgreSQL/object persistence. Unit/browser fixtures alone are insufficient.
Physical keys/recovery, verified sender and explicit owner recipient, real
Microsoft proof, protected deployment and operational restore require separate
actual acceptance. No formal accessibility, security or compliance certification
is implied by source preparation or passing configured automated checks.
