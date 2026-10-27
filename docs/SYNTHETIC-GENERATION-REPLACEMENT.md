# Owned synthetic generation replacement

## Current source and participant safety

Generation replacement is composed into the protected DEV/INT roots. The selected
Microsoft-managed MFA profile uses a fresh, one-use, exact-operation Microsoft
proof; it does not require application passkey enrollment. The legacy application
passkey profile remains separately tested. A source change is not evidence that
the corresponding Hosted deployment has been updated.

Replacement allocates fresh internal Tenant IDs. Preserving old database rows
alone would leave invited people attached to archived Tenants. Until a reviewed
membership-continuity implementation exists, the repository therefore rejects
replacement when any canonical `customer_access_memberships` row belongs to the
owner's generation being archived. Pending, accepted, revoked-invitation and
disabled-User history all block replacement. Original invitation roles are never
copied back into current authorization, and no membership is moved or deleted.

The check runs after locking the three owned Tenants and before any lifecycle,
Customer-session, generation, business-data or Tenant-audit mutation, inside the
existing owner-stamped exclusive proof transaction. Protected invitation and
admission work use the mutually exclusive shared deployment lease. The existing
concealed `PLATFORM_SYNTHETIC_GENERATION_DENIED` HTTP403 contract applies; no
recipient, membership count or foreign-Tenant existence is exposed. Real-Tenant
and foreign-owner memberships do not block an otherwise eligible empty owned
generation. Initial creation and normal replacement without invited participants
retain the existing cooldown, retention, proof and regression requirements.

The native integration test uses actual canonical encrypted invitation/admission
custody in an isolated database, including a pending invitation, a revoked
invitation and an accepted then disabled User. It checks unchanged authoritative
state and current sessions after denial, and successful replacement of a separate
empty generation under Microsoft exact-operation proof with zero app passkeys.
Its base invitation fixture deliberately exercises storage safety without enabling
protected Demo invitation eligibility or sending real mail.

This guard is a safety prerequisite. It does not implement invited Demo login,
cross-generation identity/role continuity, sender configuration or real delivery
acceptance. SaaS1 issues351–353 remain open for their full scope. Protected-root
and permanent closed Demo acceptance remain distinct release requirements.

## Historical initial component scope

The following records the original standalone component and its application
passkey profile. Its former uncomposed status and two-credential requirement do
not describe the selected current Microsoft-managed MFA composition above.

## Authority and transaction

Only DEV/INT are accepted. The server fixes environment and deployment UUID epoch.
The closed operation intent contains owner ID, expected generation ID and expected
revision (null/zero for initial creation). Its exact digest includes the operation,
deployment and epoch. The existing passkey service consumes its opaque one-use
proof context for that digest; ordinary elevated sessions, guessed hashes and
cloned contexts do not replace proof. The application requires the actual Platform
Microsoft provider, fresh passkey step-up and canonical lifecycle-manage permission.

Persistence requires the exact live, owner-stamped protected RR execution scope,
including business pool/client, environment, epoch and operator ID/version. An
arbitrary RR transaction, ordinary advisory lease, foreign scope or detached
descendant cannot satisfy that assertion. It grants no operation authority.
The repository independently locks/rechecks the current deployment, Microsoft
operator, current temporary proof session, roles, scope mode, permission, integer
epoch, proof expiry/context and at least two current credentials. No fake global
operator scope or new real-Tenant target grant is inserted. An allowlisted
Platform Tenant Operator may replace only their own synthetic generation.

The complete replacement joins the same proof transaction. It checks the retained
owner history, expected generation/revision, hard32 retained-generation limit and
a10-second cooldown after creation, activation or archival. Contention, stale
authority, serialization failure, cooldown and retention limits are errors; no
automatic retry, deletion or silent quota expansion occurs.

## Retained history and fresh business data

Each owned immutable registry row is checked before archival. An explicit
synthetic-only policy permits onboarding/ready/active/suspended to archive without
pretending the onboarding Tenant was activated. The ordinary real-Tenant lifecycle
policy is unchanged. The existing lifecycle persistence function performs revision
CAS, Customer-session revision increment and session revocation. Both Tenant and
Platform lifecycle audits are written before the generation becomes archived.
Existing captured operator versions and epoch/history rows are never rewritten.

A new plan allocates a generation, three Tenant IDs, nine internal role Users and
fresh business resource IDs. The only User binding is internal
`platform_delegation`, scoped to generation and owner/role; no email, Microsoft
credential, real membership or outbound delivery is placed on a synthetic User.
User provisioning and Tenant registration have transactional audit evidence.
Shared fixed business seeding preserves the three scenarios and remaps request,
catalogue and media ownership. Catalogue media is inserted after its Room,
Catering Package and Item owners to satisfy actual composite foreign keys. The
generation activates only after all three slots and all business data exist.

Only PostgreSQL media bytes are prepared. There is no object-storage port or
fallback: independently durable upload-intent preparation before holding a max1
proof transaction is separate work. This does not narrow the permanent closed
Demo matrix, which retains PostgreSQL and object storage in both browser engines.

## Verification limits

Focused tests cover exact scope/epoch/owner/revision intent, proof-context port,
permission/provider/expiry/foreign-owner denials, the narrow synthetic archival
exception and unchanged real lifecycle policy. Gate tests reject arbitrary RR,
generic leases, foreign pool/client/owner/version and released contexts.

The new native test requires exact-source CI: actual pinned WebAuthn software-key
proof, max1 pools, authoritative business/request/media/identity readback, own and
foreign generations, cooldown/stale/fault rollback, new IDs, preserved old data,
lifecycle revisions, both audit domains, retained quota, stale captured owner
version recovery and retained invited real Customer access.
It is not local PostgreSQL, physical-key, live Microsoft or full protected-root
acceptance.
