# Owned synthetic generation replacement

## Current source and participant safety

Generation replacement is composed into the protected DEV/INT roots. The selected
Microsoft-managed MFA profile uses a fresh, one-use, exact-operation Microsoft
proof; it does not require application passkey enrollment. The legacy application
passkey profile remains separately tested. A source change is not evidence that
the corresponding Hosted deployment has been updated.

Replacement allocates fresh internal Tenant IDs. The default repository still
rejects replacement when any canonical `customer_access_memberships` row belongs
to the owner's generation. Pending, accepted, revoked-invitation and disabled-User
history all block that default path.

An explicitly enabled DEV/INT repository option can archive registered participant
history. Every membership must have an exact immutable
`synthetic_invited_memberships` binding for its environment, Tenant, member,
generation, owner and slot. The original invitation is retained through the
binding's composite foreign key. Any unmapped membership still rejects the entire
replacement before mutation, including when the option is enabled. This option
is not registered in the concrete runtime configuration yet.

The check runs after locking the three owned Tenants and before lifecycle,
Customer-session, generation, business-data or Tenant-audit mutation, inside the
existing owner-stamped exclusive proof transaction. Protected invitation,
admission, dispatch and business work use the mutually exclusive shared deployment
lease. The existing concealed `PLATFORM_SYNTHETIC_GENERATION_DENIED` HTTP403
contract applies. Real-Tenant and foreign-owner memberships do not block an
otherwise eligible owned generation. Cooldown, retention and exact-proof
requirements remain unchanged.

Successful archival retains original Tenants, Users (including current
disablement), roles, provider bindings, mailboxes, memberships, invitations and
immutable registration history. The existing Tenant lifecycle function increments
session revision and revokes old sessions. Archived generation/Tenant scope denies
old member, pending proof, invitation and business authority. No invitation roles
are copied back into current authorization. New Tenants receive fresh business
fixtures without any carried-over human membership; access requires a fresh
explicit Owner invitation. No history is deleted or remapped.

The native fixture covers default denial, unmapped pending/accepted/revoked/disabled
history, a separate empty reset and opt-in archival of registered pending/revoked,
accepted and disabled participants under actual Microsoft exact-operation proof.
It checks retained identity/history rows, revoked sessions, stale-scope denial,
fresh Tenant IDs and no inherited memberships. Registration in this storage-focused
fixture is an isolated database seed between real invitation creation and actual
mailbox-proof admission; the separate participant registration progression proves
the protected Platform invitation transaction. Neither fixture sends operating
mail. Exact-head native and permanent browser/storage gates remain mandatory.

This source option does not complete runtime activation, Microsoft account-link
progression, sender configuration or real delivery acceptance. SaaS1 issues351–353
remain open for their complete scope. Protected-root and permanent closed Demo
acceptance remain distinct release requirements.

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
