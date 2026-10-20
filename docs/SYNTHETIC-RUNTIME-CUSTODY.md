# Private synthetic runtime custody

This prepared component is not a protected INT deployment, full generation reset,
browser handoff or physical-device acceptance. Its factories remain uncomposed.
It adds no live recipient, provider request, secret, migration or resource.

## Platform identity boundary

The canonical Platform Microsoft identity provider is `microsoft_entra_platform`;
Customer Microsoft identities use `microsoft_entra`. The Platform adapter now
shares its existing public constant through a pure contract module. No provider
claim, audience, issuer, nonce or signature-verification rule changes.

Accepted059 originally compared generation owners with the Customer provider
label. Its tests seeded that same label, so they proved component constraints
without admitting an actual Platform-primary identity. This blocked integration
rather than granting Customer identity Platform access. Draft060 replaces only
that guard function with the actual Platform label; accepted059 bytes/checksum
remain unchanged. Runtime lookup and execution scopes consume the canonical
Platform constant. Native fixtures use that same contract and explicitly reject
a Customer-labelled operator as well as a Demo operator.

Empty060 down restores the previous059 function definition and drops only the
empty new media table/functions. The previous provider policy therefore applies
until060 is reapplied; current schema readiness stays closed during that rollback.
The original populated059 recovery guard is still independently exercised before
current060 is restored. No retained generation owner, epoch or history is rewritten.

## Synthetic catalogue media

Canonical060 adds `synthetic_catalogue_media_assets` behind the immutable Tenant
registry. Generated nullable owner columns provide actual composite foreign keys
to the same Tenant's Room, Catering Package or Catering Item; creator ownership
also uses a composite User foreign key. This avoids trusting a polymorphic owner
string without database integrity. Asset/Tenant/owner/creator/creation identity is
immutable on update. Bytes, digest, content type, bounded length and optional
private object key follow the existing private media contract.

Every write takes the protected shared advisory barrier and locks/rechecks the
current generation, deployment epoch, actual active Microsoft Platform operator
and captured version, and eligible Tenant lifecycle. Only dev/int synthetic
preparing/active generations qualify. Ordinary image removal remains possible in
a current eligible generation; archived/stale-generation media cannot be updated
or deleted. Reset must archive the old Tenant lifecycle and preserve its business
data; it must never delete images as a shortcut. Application authorization and
transactional audit remain mandatory above this infrastructure guard.

A narrow read-only SECURITY DEFINER function permits only the exact empty-table
BEFORE/STATEMENT/TRUNCATE trigger path. Populated TRUNCATE and down require verified
recovery. PUBLIC has no explicit function/table access. Overlay026 revokes all
Customer/Platform/Reset Demo CRUD and private function execution; only Reset gets
empty-table TRUNCATE. The ordinary closed Demo reset inventory includes the new
empty child table, without importing protected authority or changing seed facts.

Current readiness and strict maintenance checks advance to60/26. Older rollback
probes drain only this new empty layer before their unchanged historical security
guards. Prior migration files/checksums, permanent Demo semantic checksum/version,
and the four paired progression/two-reset gates remain unchanged.

## Proof transaction and continuing session

The optional server-only `stepUpTransaction` repository port wraps exact step-up
authentication before proof locks/consumption. Ordinary login retains its original
isolation. The port must invoke the proof work exactly once and return its actual
result; missing, repeated, fabricated or failed scope execution has no fallback.
The protected execution scope supplies the exclusive RR transaction and current
deployment/owner rechecks. Initial pending/session reads remain outside that
transaction, avoiding a max1 connection deadlock. See
`PROTECTED-RUNTIME-EXECUTION-SCOPES.md` for lock ordering and snapshot races.

`executeStepUpWithContinuation` is an explicit new service method; no HTTP input
or existing login/operation path activates it. It requires active business login,
an explicit two-key policy and two distinct currently active credentials. After
verified exact proof it privately issues the future ordinary MFA session before
the mutation, inside the same transaction. Its identity/version/epoch/context and
distinct session ID are checked. `verifiedOperationWithContinuation` consumes an
opaque one-use transaction-lifetime context containing the privileged Principal
and future ordinary Principal. A clone, wrong hash, replay, ordinary proof context
or expired callback context is rejected.

The old and temporary sessions cannot back future delegation: rotation revokes
the old session and completion revokes the temporary privileged session. Only the
future normal cookie is returned after commit. Default operation ordering and
credential-lifecycle invalidation remain unchanged. Failure rolls proof/counter,
audit, future session and mutation back together. This is preparation for a
browser-bound one-use handoff, not implementation of that handoff or an elevated
cookie. No raw handoff code is persisted or returned by these component methods.

## Verification and remaining work

Focused tests cover current Platform provider contracts, explicit continuation,
one-use contexts, current distinct-key policy, transaction-port behavior and schema
readiness compatibility. Native cases require exact-source PostgreSQL execution:
max1 lease/business pools; MVCC epoch/owner races; actual signed WebAuthn proof
through the pinned verifier and ordinary session repositories; all-effects
rollback; media owner/creator foreign keys; real-Tenant rejection; archive/owner/
epoch invalidation; private privileges; populated reset/down protection; and
preserved invited Customer User/session/membership/audit state.

Native/whole-package/DAST/four paired browser/security gates are mandatory before
accepting this source. New native cases have not been executed locally. Software
fixtures are not live Microsoft, physical-device or protected-root acceptance.
Actual generation provisioning, audited own-generation archival/cooldown, bounded
browser handoff custody, current delegated sessions, concrete provider/worker mode
dispatch, protected roots/UI and operational cutover remain under SaaS1 issue351.
