# Protected runtime role bootstrap

This operator-only preparation installs a positive, source-owned schema62 grant
manifest onto two fresh externally created LOGIN roles. It never creates a role,
password, operator, credential, grant, Tenant, classification or deployment epoch.
The default review contract `protectedRuntimeRoleGrantPlan({environment,
securityEpoch})` is pure and opens no connection. Explicit operator invocation of
`grantProtectedRuntimeRoles(pool, scope)` is separate from runtime startup; normal
processes must never import it. No live database has been contacted or changed.

DEV/INT/PROD derive their exact Customer and Platform role names. Both must lack
memberships, elevated attributes, object ownership, existing table/column/
sequence grants, explicit function grants and default privileges. Existing roles
with permissions are refused rather than adopted, repaired or reset. This is a
one-time fresh-role operation; repeat invocation deliberately fails.

The sequence-right check uses a CASE on the actual relation kind before calling
PostgreSQL's sequence-only privilege function. A plain WHERE filter cannot
guarantee function evaluation order. Existing sequence grants remain a refusal;
the native test explicitly grants/revokes only one fresh fixture permission to
prove that refusal before the real installation.

Current schema ledger names/checksums and the independent current deployment UUID must
match the checked-out canonical source exactly. A bounded transaction takes the
existing exclusive deployment advisory lock, refuses active role connections,
and rolls all changes back on any error. It does not prove that older binaries
or different historical credentials have been drained/revoked.

The manifest grants no ownership, membership, TRUNCATE, TRIGGER, REFERENCES,
wildcard/default privileges or grant option. PUBLIC database CREATE/TEMPORARY
and public-schema CREATE are removed transactionally; existing CONNECT/USAGE and
explicit closed Demo grants remain intact. PostgreSQL configurations where
PUBLIC already confers schema creation require operator hardening before this
fresh-role preflight can pass. Password creation, verified TLS connections,
credential delivery/revocation and a coordinated process cutover remain external
operating steps. Passwords must not be supplied through shell arguments or SQL
captured in application logs.

The schema038 attribution marker and schema041 maintenance procedure remain
owner/maintenance-only and are not granted to either runtime. The existing
SECURITY DEFINER attribution triggers call the marker without a direct grant.

REAL admission/delivery qualification retains its required live outer shared
deployment scope and exact current UUID predicate. It locks the Tenant directly
for admission or shared for delivery. A redundant deployment FOR SHARE was
removed because PostgreSQL would otherwise require forbidden Customer UPDATE
rights. The canonical UUID-rotation trigger already requires the exclusive
deployment advisory lock. Native acceptance also checks actual restricted REAL
qualification while an actual UUID update is denied55P03 and leaves the epoch
unchanged. Qualification without the live outer scope is still refused before
any qualifying query.

Customer business statements retain ordinary canonical authorization and Tenant
scoping. Append-only history receives SELECT/INSERT rather than mutation rights.
`request_workflow_starts` additionally grants UPDATE only on `status`, `ended_at`,
`request_id` and `submission_fingerprint`, the columns required to lock and complete
or abandon a started workflow. Workflow identity, owner, idempotency key, start time
and Tenant remain immutable to the Customer role. Customer cannot modify Platform
identity, sessions, keys, proofs or audit, or the protected deployment/classification/
generation history. Its delegated-session
reader receives only the exact necessary Platform columns; it cannot read source
session hashes or public-key/credential material. The schema062 boolean source
lock port replaces direct Platform row-lock privilege. Both existing061 trigger
parents are already SECURITY DEFINER, so their unchanged private approval check
does not require extra Customer mutation or direct EXECUTE permissions.

Platform cannot issue a Customer session or read Customer code proof/flow tables
or delivery ciphertext. It can append invitation delivery ciphertext and inspect
only delivery-state columns. Offline passkey enrollment-grant INSERT remains
denied; only consumed/revoked columns may change through existing ceremonies.
Platform generation/lifecycle operations retain their canonical fresh exact
assertion, current custody and exclusive-scope checks; database grants do not
replace these controls. Deployment UPDATE is limited to the existing updated_at
locking column, which cannot rotate the UUID under its canonical trigger.

Two local tests check per-surface grant exclusions, three environment mappings,
closed immutable plan output and malformed/getter scope refusal before resources
are acquired. The new native fixture uses generated loopback databases and fresh
roles only. It checks actual installation/refusal, both readiness postures,
denied private columns/mutations/session issuance/enrollment issuance, and an
actual software-P256 approved Customer start/callback/confirmation/CSRF/one-use
completion/resolution/source-revocation/audit journey under the restricted
Customer SQL identity. Platform approval and fixture identity provisioning still
use the migration-owner fixture; this does not establish a restricted Platform
root, password/TLS, live Microsoft, physical devices or cross-site browsers.
Native execution and unchanged permanent four-pair full Demo gates require
exact-source CI before acceptance. No schema, immutable migrations, seed/checksum,
dependencies or normal runtime activation changes. Whole protected roots,
durable SIM/provider/media/frontend and operating acceptance remain open under
application SaaS1 issue351/milestone2.

The review-only CLI is `node scripts/protected-runtime-roles.mjs plan ENV UUID`.
It emits `applied:false` and the redacted fixed manifest; no apply command exists.
The separate `Install protected INT runtime roles` manual Actions workflow invokes
the existing checked `grantProtectedRuntimeRoles` operator port for INT only. It
requires the exact accepted Main SHA, the independently prepared current deployment
UUID, the existing protected migration-secret environment and fresh LOGIN roles.
It validates scope before constructing a verified-TLS, max1 pool, serializes with
the existing hosted database operator workflows, and logs only a bounded receipt
or fixed failure code. It creates no role, password, deployment epoch, operator,
enrollment grant or Tenant; it performs no migration/reset and starts no runtime.
The installer retains its full exact-ledger, epoch, role-posture and atomic grant
checks. Its deliberate fresh-role refusal also makes a repeat run fail closed.
The module gate rejects every source-runtime import of operator/build scripts,
including static, re-export and literal dynamic paths outside the runtime graph.

## Existing INT roles after Microsoft group authority069

The fresh installer must not be rerun on existing roles. The separate operator
port `grantCustomerMicrosoftGroupRuntimeRoles` and CLI
`scripts/customer-microsoft-group-runtime-grants.mjs` apply only the current
Customer manifest entries for `tenant_microsoft_role_settings` (SELECT/INSERT/
UPDATE) and `customer_microsoft_group_observations` (SELECT/INSERT/DELETE).
No Platform, Demo, TRUNCATE, function, ownership or credential rights are added.

The descriptor3 request contains exactly `environment`, `securityEpoch` and
`segmentId`. INT and both fixed runtime role names are source-owned. The same
checked incremental-grant transaction used by audit-segment grants requires the
exact canonical ledger, current deployment and signed segment, catalog-owner
session, nonelevated existing roles and zero connections from both roles. A
wrong epoch/key, failed verification, active connection or malformed request
refuses the operation before grants commit. Environment segment/epoch bindings
must independently match the request. This command performs no migration, reset,
bootstrap, provider operation or runtime activation. Its native fixture checks
actual absent-to-minimal grants, untouched Platform exclusions and rollback on
an audit-verification failure; CI evidence is required before operational use.

The existing Main-only `protected-int-audit-segment.yml` manual workflow exposes
the separate `customer_groups` operation through the same protected environment,
descriptor3 request carrier, exact-source gate and source-bound real recovery/
custody evidence. It neither repeats segment genesis nor changes that workflow's
secret allocation, owner restriction, serialization or private-output policy.

## Existing INT observability readers

The fixed `observability_reads` operator action applies SELECT only to Platform
runtime deployments/mappings, diagnostic events, metering periods and operational
quotas. These are required by the existing authorized read services. Customer
retains no read access to these tables; its diagnostic INSERT remains unchanged.
No metering-event raw read, mutation, ownership, credential or provider authority
is added. The checked incremental transaction retains current ledger, epoch,
signed audit segment, catalog owner, nonelevated roles and both-role drain checks.
The fresh-role manifest includes the same minimal read contract. Existing roles
must use the incremental action, never rerun the fresh installer. Code validation
and native restricted-role CI do not themselves prove a live grant or UI recovery.


## Existing INT Customer request workflows

The Customer manifest grants `request_workflow_starts` SELECT/INSERT plus
column-limited UPDATE on `status`, `ended_at`, `request_id` and
`submission_fingerprint`. The workflow repository locks a started row and changes
only those lifecycle fields. Owner, Tenant, workflow ID, idempotency key and start
time remain outside the UPDATE grant.

For already-created INT roles, use only the
`customer_request_workflows` operation in the existing
`protected-int-audit-segment.yml` workflow. The fixed action checks the exact Main
source, current schema ledger, deployment epoch, signed audit segment, source-bound
recovery/custody evidence, closed services and zero active connections on both
runtime roles. It applies one Customer-column grant, performs no migration, reset
or service activation, and emits no private operation record to public logs.
Never rerun the fresh-role installer on existing roles. This source procedure does
not itself prove that the live operation has been executed or that a new booking
has been accepted through the deployed application.

## Existing INT invited synthetic participants

The separate `synthetic_participants` operation in the existing
`protected-int-audit-segment.yml` workflow calls only
`scripts/synthetic-participant-runtime-grants.mjs`. It applies the already-owned
fixed delta: two Customer member/lifecycle function EXECUTE grants and Platform
SELECT/INSERT on immutable participant bindings. No Customer binding write,
private-helper execution, general lifecycle or Platform mutation right is added.

The action uses the same descriptor3 request, independent expected segment/epoch,
exact qualified Main, owner-only first attempt, ordinary logging, protected
environment and source-bound recovery/custody evidence as the other incremental
operations. The existing installer additionally requires the complete current
ledger, verified signed audit, catalog-owner session, nonelevated roles and both
runtime roles drained. It does not rerun fresh-role installation, migrate/reset,
send mail, start services or enable participant mode. Configure that default-off
mode only after the separate operating prerequisites and acceptance are met.
