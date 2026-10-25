# Combined Customer role sources

## Scope and approved contract

This document describes the schema069 source candidate, not a live activation.
Every active Customer member has Employee as the implicit baseline. Conference
Manager and Tenant Admin are independent elevated roles. Effective roles combine
direct Tenant Admin assignments and separately approved Microsoft-group mappings.
Removing either source retains a role still granted by the other. Suspension
blocks access independently. Platform roles never enter Customer authorization.
Group names, email domains, raw role claims and browser values grant nothing.

## Approved mappings and recovery

The protected REAL Customer composition exposes
`GET/PUT /api/v1/tenant/microsoft-role-mappings`. Current Tenant Admin authority,
server-derived Tenant/User scope, normal session validation, same-origin mutation
and CSRF protection are mandatory. The write accepts exactly directoryId,
mappings and expectedRevision. Mappings contain at most100 distinct group UUIDs,
each with one or both canonical elevated roles. Unknown fields, duplicate groups,
baseline/Platform roles and invalid revisions are rejected. Reads/writes cannot
select another Tenant. Synthetic and unclassified Tenants are excluded by the
current protected REAL classification and deployment lease.

A mapping change requires an active directly assigned Tenant Admin as a recovery
path. It locks Tenant role administration, checks the expected revision, clears
all existing Microsoft-derived sources while preserving direct grants, and stores
the new mapping revision with a mandatory Tenant audit receipt atomically. A new
Microsoft login must establish matching membership under the new policy. No role
is inferred for offline Users simply because a mapping was added. Audit failure
rolls back policy, grants and version changes. Real changes retain minimized
configuration audit evidence; unchanged writes do not duplicate it. External group
revocation is never blocked to retain a last stale group Admin.

## Verified provider observations and bounded cache

The selected fresh Customer Microsoft adapter translates membership only inside
its existing nonce/audience/issuer/freshness-bound, opaque one-use identity proof.
It accepts at most200 distinct group UUIDs. Missing claims are unavailable;
`hasgroups` or `_claim_names.groups` indicates overage, even when a groups array
also appears. Provider-supplied group endpoints, names, wids and role claims are
never followed or used for application authority. No Graph request, additional
Graph consent, application-group assignment or paid P1 requirement is introduced.
Configure the existing application to emit group object IDs; real provider
configuration and claim acceptance still require operating verification.

Only login flows persist a short-lived observation bound to their existing
verified flow, exact directory/subject and database verification timestamp.
Observations are immutable and cascade with the existing expired-login-flow
retention. Link confirmation retains its original exact security-version and
email/Microsoft dual-proof contract; it does not grant group roles. A subsequent
Microsoft login reconciles them. No mailbox, token or group payload is logged.

After explicit membership selection, the same transaction rechecks accepted
identity/User/version and current mapping, then reconciles only the intersection
of the approved directory and groups. Absent, overage, expired or mismatched
observations remove derived sources; direct grants survive. Source changes and
refreshes advance User security versions. Mapping changes, direct/lifecycle
administration and reconciliation lock the Tenant before the Tenant advisory
lock, then Users before role rows. This order avoids a parent/advisory deadlock
with admission and audit FK locks. Native qualification observes the advisory
lock remaining available while a role mutation waits for its locked Tenant. Required grant audit and ordinary session issuance commit in
the same transaction. Browser data cannot submit an observation or derived grant.

Derived membership is valid until the earlier of token expiry and one hour after
verification. Database time enforces expiry on authoritative role reads and existing
Customer sessions, including email-code sessions. An expired derived-only role
cannot remain usable or be copied into a new email-code session. A fresh Microsoft
login is needed to renew it. Refresh invalidates prior sessions, preventing a new
observation from reviving an older expired session. This bounded cache is not a
real-time Microsoft revocation subscription. Complete zero-member observations
and unavailable/overage observations are distinct evidence but grant no group role.

## Persistence and presentation

Schema068 preserves direct-source, directory and bounded group provenance on the
existing role rows; old rows remain direct grants. Schema069 adds expiry, approved
mapping revisions and flow observations. Pure SQL source-validity validation grants
no table authority. Existing accepted migrations are not rewritten. Migration069
refuses pre-existing group provenance without a fresh observation rather than
inventing one. Populated mapping/observation/grant state blocks downgrade. Demo overlay030 grants
only TRUNCATE on the two otherwise inaccessible new tables so the closed Demo
reset can name all FK participants. A trigger-context-bound, read-only definer
guard refuses either table when populated. It cannot erase actual mappings or
observations and grants no Demo CRUD, SELECT or direct function execution. Existing
Demo migrations and seed semantics remain unchanged.

Effective role reads use the same database source-validity predicate. Direct
editing continues to use direct assignments. Lifecycle filters use effective roles.
When group grants exist, optional roleSources exposes only direct and microsoftGroups
elevated-role arrays. Provider identifiers are excluded from User projections.
The paired frontend validates their exact union, shows group roles separately and
edits only direct checkboxes, preventing accidental conversion to permanent direct
authority. Direct-only User responses retain their historical shape.

## Qualification and remaining acceptance

Policy/projection cases cover all sixteen source combinations and permission
unions. Mapping/provider tests cover exact approved intersections, directory
mismatch, missing/empty/overage observations, unsafe endpoint references,
duplicates, excessive inputs, Platform injection and opaque one-use transport.
HTTP cases exercise actual authentication/CSRF/origin guards, current Tenant scope,
strict contracts and optimistic conflicts. Native qualification adds real
invitation/link/selection/session custody, source retention, receipt rollback,
revocation/expiry, REAL classification, refresh fencing and downgrade refusal.

These native and full source-pair/browser checks must pass at the final candidate
before a ready/merge claim. Provider fixtures are explicitly synthetic; they do
not prove real Microsoft membership, MFA, mail delivery or live operating readiness.
Mapping-administration presentation and the actual configured Microsoft round trip
still require final paired UI/live acceptance. Owner access to real Customers,
sole-owner operator lifecycle remain separate cutover dependencies. Synthetic
Microsoft custody is implemented in the071 source candidate and still requires
its own native/paired/elapsed-expiry qualification; see SYNTHETIC-MICROSOFT-CUSTODY.md. No migration, actual role or provider setting is changed by
publishing this source candidate.
