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
one-time fresh-role operation; repeat invocation deliberately fails. Current
schema ledger names/checksums and the independent current deployment UUID must
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
Customer cannot modify Platform identity, sessions, keys, proofs or audit, or the
protected deployment/classification/generation history. Its delegated-session
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
The module gate rejects every source-runtime import of operator/build scripts,
including static, re-export and literal dynamic paths outside the runtime graph.
