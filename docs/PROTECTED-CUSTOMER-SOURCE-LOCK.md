# Restricted Customer source-lock port

Prepared canonical062 adds one private read-lock function. It creates no role,
Tenant, User, session, grant, provider state or new table. Accepted001..061 and
Demo001..027 remain unchanged. No new Demo overlay is needed: there is no new
reset table or public runtime grant. Current readiness/ledger inventories advance
to62/27 while retaining historical upgrade negatives and rollback guards.

PostgreSQL18 requires UPDATE privilege for `FOR SHARE`, even when no value changes
([official SELECT contract](https://www.postgresql.org/docs/18/sql-select.html)).
The protected Customer completion repository previously used that operation
directly on source Platform actor/session rows. Granting a Customer column-update
workaround would violate the prepared protected role posture.

`protected_lock_synthetic_handoff_source(text,uuid,uuid)` instead derives both
lock targets from the exact current-epoch approved handoff. The authenticated
database `session_user` must be the environment-specific protected Customer role
or the function's migration owner; caller SET ROLE cannot replace that identity.
Only DEV/INT are accepted. The fixed-search-path SECURITY DEFINER function uses
qualified tables and no dynamic query or data mutation. It retains actor then
source-session row locks with the original enablement/security-version and
revocation/expiry predicates. It returns only a boolean. PUBLIC/default Demo
execution is explicitly revoked; role bootstrap must grant the narrow Customer
function deliberately. No runtime GRANT or automatic repair occurs here.

The repository still validates the complete current proof, MFA, generation,
browser, cookie and membership custody before and after the locks in the same
transaction. Ordinary Tenant/User/previous-session/handoff locks, exact one-use
consumption, audit-atomic issue/revoke and RR conflict behavior are unchanged.
The function neither performs admission nor verifies a browser claim. Missing,
wrong-environment/epoch/state or revoked source custody returns false. No general
Platform identifier or arbitrary lock target can be supplied by the caller.

Down migration retains the existing handoff-history recovery requirement and
removes only the function when empty. It does not rewind identity/business/audit
state or grant old privileges. Current-schema fixtures/operating readbacks advance
mechanically, with one empty062 drain before unchanged older rollback probes.
Metrics upgrades retain valid61/27 history, add62/27, and still reject incompatible
earlier pairs and future schema/overlay versions. No actual database, deployment,
provider or operating credential is changed by preparation.

The new native test is restricted to generated loopback test databases and fresh
fixture roles. Actual signed software-P256 generation/approval produces the
handoff. A restricted authenticated SQL identity can invoke the port despite
being denied Platform SELECT/UPDATE; an explicitly misgranted Platform identity
is rejected by the function itself. Real concurrent source revocation waits for
the retained transaction lock; that write probe rolls back. Unchanged handoff
suites still cover actual committed source revocation/admission. No Customer
session is issued by this primitive test. Native fixture SET SESSION AUTHORIZATION
is not password/TLS or full restricted-root acceptance. Exact-source native,
migration, actual expiry and all four permanent paired Demo progression/two-reset
gates remain mandatory before acceptance. SaaS1 issue351 remains open for complete
role bootstrap, owned roots, SIM/provider/media/frontend/browser, keys/recovery/
sender/owner and coordinated operational cutover.
