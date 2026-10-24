# Microsoft exact-operation proof (uncomposed source candidate)

The owner-selected target removes application passkeys from the active Platform
runtime. Microsoft-issued MFA remains mandatory. The accepted Microsoft login
adapter does not by itself authorize a synthetic reset, Customer handoff or
privileged business operation. An ordinary login, browser-selected role/hash or
generic elevated cookie must not substitute for an exact one-use proof.

## Implemented protocol component

`createPlatformMicrosoftOperationService` prepares a bounded source-bound proof
through an explicit repository port. Environment, non-reusable deployment UUID,
integer Platform epoch, source normal session, operator version, exact operation
digest, correlation, nonce and browser custody are server-owned. Its MAC purposes
are independent; provider code exchange uses PKCE and the existing opaque
Microsoft-MFA verifier and closed claim policy. Only the fresh internal Microsoft
context is accepted, with the exact current operator directory/subject and a
fresh authentication time.

The provider callback only verifies the pending proof. It executes no business
operation, issues no application session and returns no elevated principal or
CSRF token. Both transient cookies contain only state and a purpose-bound MAC.
The provider cookie is Secure/HttpOnly/Lax and confined to the fixed operation
callback. A separate Secure/HttpOnly/Strict cookie reaches Platform requests.
Both start with at most120 seconds; callback completion cannot extend the actual
repository deadline. Normal Platform session-cookie policy remains unchanged.

The original page may request only a source/browser-bound pending/verified status.
This read-only projection contains no proof, cookie, identifier or provider data.
The intended browser integration uses an explicit Microsoft-confirmation tab and
bounded status checks, preserving existing COOP same-origin rather than relying
on an opener surviving a different-site provider navigation. No browser storage
or generic command endpoint is introduced.

Final execution independently requires the original current normal-MFA session,
matching MAC/state and exact digest. The repository port must atomically consume
the verified proof with business mutation, required audit and session rotation.
Temporary fresh elevated authority stays private in an instance-bound WeakMap;
wrong-instance, wrong-digest, reused and escaped contexts fail closed. The explicit
continuation variant prepares a distinct normal session inside the same commit
for Customer delegation. No strong cookie or mutation result leaves the service
before that transaction returns successfully.

## Required integration before activation

This source component is not yet a complete or deployable Microsoft operation
path. Additive durable custody/migration, actual current-source and expiry/CAS
checks, fixed ordinary/shared versus synthetic owner-exclusive transaction
selection, minimal runtime grants, proof retention, callback routes and redirect
registration, business-route protection, browser integration and both native and
different-site browser acceptance remain required. In particular, the intended
callback path is not accepted by the existing Entra factory yet. The new module
is not installed in any runtime or closed Demo graph.

The legacy synthetic handoff proof foreign key, approval trigger, calendar-source
lock and delegated-session reader still require their existing legacy proof.
They must receive a reviewed additive Microsoft branch preserving all existing
history, source/operator/role/epoch/exact-operation/audit constraints. Do not
replace those predicates with an ordinary MFA principal or weaken the legacy
branch. The active no-passkey profile must instantiate no WebAuthn service or
minimum-credential requirement.

Focused in-memory service-port tests cover inert callback, separate cookies,
exact digest/browser/source/version/expiry checks, provider mismatch, callback
replay, private context one-use/instance scope and withheld results on mutation
or simulated commit failure. These are component evidence only, not PostgreSQL
atomicity, real Microsoft/device MFA or deployed acceptance. Full exact-source
quality/security/native, all permanent three-customer/two-reset browser/storage
gates, actual provider evidence and coordinated live acceptance remain mandatory.
