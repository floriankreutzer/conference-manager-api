# Durable invited-Customer Microsoft flow preparation

This is an inactive foundation, not an authentication cutover. Existing runtime
entrypoints do not import or select it. The fresh primary adapter is documented in
[CUSTOMER-MICROSOFT-PRIMARY.md](CUSTOMER-MICROSOFT-PRIMARY.md). Organization selection,
atomic session admission and explicit account-link confirmation still require
their own application/HTTP composition and acceptance before activation.

## Protocol and browser custody

The authentication service allocates durable state before constructing the fixed
Microsoft authorization URL. Random state and browser tokens are independent.
Environment-, purpose- and domain-separated HMACs recover nonce and PKCE across
processes while storing only their hashes. No authorization code, raw nonce,
PKCE verifier, token, email claim or browser secret is persisted.

The host-only Secure HttpOnly transaction cookie is restricted to
`/api/v1/auth/microsoft`. Authorization uses SameSite=Lax for the provider return;
a verified callback rotates the browser token and changes the cookie to Strict.
The next step has its own browser- and purpose-bound CSRF proof and five-minute
limit. Callback reservation precedes provider I/O and is one-use across instances.
A failed or interrupted exchange must restart; it is never blindly replayed.

Only the adapter's one-use opaque primary assertion can supply stable Microsoft
directory/subject references and fresh authentication time. Login capture includes
only previously accepted memberships whose existing Microsoft binding, active
User, security version and Tenant lifecycle remain eligible. An unknown identity
captures no choices and creates no User, role, binding or session. Pending email
invitations are not accepted through a matching provider email claim.

Link intent requires an actual accepted email-code membership, matching email
identity and a still-current server session issued within five minutes. Start,
callback reservation and verified capture independently recheck that authority.
The callback returns only a confirmation requirement. It does not link accounts.
The eventual confirmation transaction must lock the same context, consume both
proofs, increment User security version, write the matching identity-link audit
and create the replacement ordinary session atomically. Microsoft login identity
remains separate from the Tenant's Microsoft365 directory connection.

## Persistence and migration boundary

Draft canonical migration058 adds private flow/budget custody and the minimized
`tenant.user.identity_linked` audit action. It does not rewrite accepted057.
Forward-only transitions freeze intent, browser ownership and captured provider
facts. Deferred constraints require matching accepted membership, previous fresh
email session, explicit consumed link proof, identity binding, incremented security
version and audit evidence before an admitted Customer gains a Microsoft binding.
Direct binding mutation/deletion is denied pending a dedicated unlink contract.

The identity constraint must also execute for closed Demo seed bindings without
giving Demo roles SELECT access to private invitation/proof tables. Its narrowly
scoped read-only SECURITY DEFINER function uses only `pg_catalog` search_path,
schema-qualified tables and an exact trigger-context check. PUBLIC execution is
revoked; no dynamic SQL, DML, data-returning API or new caller privilege is added.

Draft Demo overlay024 only extends the existing closed synthetic Demo reset's
private-table inventory and reset-only TRUNCATE grants. It preserves the existing
three-customer seed/checksum. This reset is forbidden for protected real INT;
identity/history-preserving INT generation reset remains separate work.

Flow creation uses a nonblocking environment advisory lock, source five/minute and
global thirty/minute start budgets. The transport must derive the source hash
from trusted socket context; a browser must never provide that authority. Each
allocation cleans at most twenty expired non-link-evidence flows older than one
hour and twenty stale budgets older than twenty-four hours, using indexed bounded
SKIP LOCKED selection. Consumed link evidence and its audit are retained.
Rollback requires empty new custody and no identity-link audit, otherwise verified
recovery is required; runtime never automatically executes migration or recovery.

## Verification scope

Unit tests exercise binding separation, cookie/CSRF custody, opaque proof handling,
wrong state/browser, failed/replayed callback and accepted-only snapshot validation.
Native PostgreSQL tests are supplied for real email admission, cross-instance
one-use callback, source budgets, environment separation, direct-link denial,
session revocation and guarded migration recovery. Synthetic in-memory SDK token
fixtures do not establish live Microsoft, sender, device or signature acceptance.
Execution results and exact CI source pairs must be recorded separately; test
source alone is not a passed database or permanent Demo acceptance claim.
