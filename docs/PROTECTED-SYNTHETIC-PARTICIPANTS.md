# Invited participants in protected synthetic tenants

Status: persistence/session/business ports and implementation design for application
issues351/352/353, not an implemented admission path or operating acceptance.
The active protected runtime composition still permits invitations/email admission
only for REAL tenants. Existing strict REAL predicates and the operator-owned
synthetic handoff remain binding.

## Persistence and protocol foundation

Migration073 adds immutable environment/Tenant/member/origin-invitation bindings
to the exact owned generation and slot. Its registration trigger checks current
deployment epoch, enabled Microsoft Platform owner/security version, active
generation and a fresh unaccepted canonical invitation. Existing history is not
backfilled; nonempty binding history prevents destructive rollback or truncation.
The schema readiness contract advances to73 without changing historical migration
compatibility thresholds or Demo seed/checksum content.

Demo overlay033 grants only TRUNCATE on the new FK child to the existing reset
role. The existing exact reset inventory includes it; its immutable-history
trigger still denies any nonempty participant history. Historical rollback tests
first remove empty073/033 before reaching their unchanged older recovery guards.
This is not the protected generation-replacement implementation.

A separate DEV/INT Platform invitation repository adds the binding within the
canonical authorized invitation/proof/receipt/two-audit transaction. The ordinary
protected repository remains REAL-only. A separate member-qualified SQL locking
port and optional composition reject Tenant-only synthetic eligibility and retain
the original REAL predicate. They require the exact live outer shared execution
scope and its transaction; current generation, epoch and owner remain mandatory.
Human membership does not require a continuously live delegated Owner session.
Canonical challenge, choice, admission and delivery callbacks now pass the
server-derived membership/invitation identifier. Microsoft capture/choice/admission
do the same; account/link flows can use the explicit participant composition's
accepted-member lookup before current session checks. Default REAL ports continue
to reject unqualified targets before reading account or link business state.

These new repositories are not wired into an application composition. No runtime
flag is registered or enabled, no SQL runtime grant is installed, and no endpoint
has acquired participant admission. Current email, Microsoft linking, business
session routing, media/calendar/onboarding and reset behavior remain unchanged. This
foundation alone cannot close any participant or email operating requirement.

Source tests cover exact parameter binding, scope/transaction custody, ambiguous
or accessor metadata, strict boolean/PROD rejection, default REAL behavior and
explicit member qualification. The new native PostgreSQL progression uses actual
Microsoft operation proof and canonical invitations for three isolated slots,
checks foreign/unregistered/ordinary-REAL negatives and immutable history, and
checks owner disablement independently of source-session revocation. It provisions
small isolated registration fixtures; it does not replace the full canonical Demo
progression/two-reset browser gates. Native execution and all required CI results
must be recorded before qualification; writing these tests is not a passing result.

## Inactive participant session ports

Separate DEV/INT access and session repository factories qualify the actual
accepted member under the live shared deployment lease and the same transaction.
The member-qualified scope locks the active generation owner and Tenant before
re-reading the canonical identity binding, User/security version, current role
provenance and exact unexpired, unrevoked session snapshot. REAL and participant
factories share that identity/session query; the existing REAL factory always
binds participant selection to false, regardless of unrelated options.

Only the separate factory can produce `synthetic_participant` custody. Its session
issuer requires an explicitly participant-qualified repository for the same
environment/epoch; qualification failure rolls back session and audit issuance.
The session validator accepts that kind only with explicit boolean opt-in in
DEV/INT and an email-code or Microsoft identity. Omitted configuration stays
strict, and PROD opt-in is rejected. This creates no new authentication endpoint,
SQL runtime grant, application composition or deployed permission.

Native progression additionally performs actual mailbox proof and canonical
invitation admission for all three isolated slots with the participant session
repository, checks CSRF and strict REAL rejection, and verifies independent human
sessions survive owner-session revocation but fail on owner disablement. It uses
fixture codes and sends no mail. This evidence must pass natively; unit query mocks
do not prove PostgreSQL behavior. Full media/calendar/onboarding/write custody,
Microsoft admission/link progression, restricted SQL-role grants, replacement and
operating delivery remain separate required work before runtime activation.

## Inactive synthetic business custody ports

The protected media reader and final calendar authority guard accept the same
explicit default-off DEV/INT participant selection only with owned synthetic
configuration. A shared synthetic custody adapter chooses the current authoritative
member or delegated source and never turns REAL qualification into synthetic
access. Participant final writes retain current owner/generation/Tenant locks,
add ordinary User/session locks, and re-read the complete identity and authorization
snapshot before proceeding. Delegated final writes retain their original source
lock and both current-custody reads. Simulator provider identity remains fixed
metadata; it is independent of a human's email-code/Microsoft login identity.

Participant media reads use a read-write transaction solely to retain PostgreSQL
custody locks; both pre-read and post-read qualification remain mandatory. Actual
bytes, hash checks, asset ownership, active catalogue rules and minimized output
remain unchanged. No external provider, storage fallback or new HTTP surface is
added. Constructor negatives reject malformed selection and missing owned scope.
Native progression adds actual private image bytes, per-slot synthetic calendar
integration/resource qualification, foreign-source denial and owner-disablement
rejection. The full permanent browser/storage matrix remains separate evidence.

These ports do not yet activate application runtime, onboarding lifecycle,
restricted SQL grants, participant write-wide fencing, invitation dispatch or
generation replacement. Those remaining boundaries must be implemented and
qualified before enabling a participant runtime configuration.

## Intended narrow boundary

The new path is limited to explicit DEV/INT configuration and the current owned
synthetic generation and exact slot. It uses the existing verified invitation,
mailbox-code, membership, current-role, opaque session/CSRF and audit protocols.
No client field, display name, email domain or provider group chooses runtime
classification, generation, operator ownership or authority. No new Customer role
or Platform permission is introduced.

Invited human participants are not canonical synthetic personas. Initial
admission creates a separate User and identity binding through the existing
canonical admission transaction. Existing accepted membership checks use current
User enablement/security version and current direct/verified role provenance,
not the original invitation's role snapshot. No external credential is attached
to a seeded fake User.

A generation-bound participant record must join the canonical membership and
originating authorized invitation to its environment, internal Tenant,
operator/generation and slot. Initial mapping is written only by the existing
authorized Platform invitation transaction, retaining its exact operation proof,
immutable command receipt and both audit domains. Customer self-invitation on
synthetic targets is not enabled by this design; its separate REAL-only path
must not be relaxed accidentally.

## End-to-end custody requirements

Tenant classification alone is insufficient. Challenge snapshots, choice,
admission, account linking, dispatch and current business-session resolution must
qualify the actual membership mapping as well as the active generation and current
deployment epoch. An old unregistered canonical synthetic membership must not
become eligible merely because its Tenant now has a supported participant.
Anonymous errors, recipient/challenge budgets, one-use/browser binding, encryption,
expiry and explicit account linking retain their current contracts.

The participant session needs its own validated access kind, distinct from REAL
invited membership and operator delegation. Customer session resolution, media,
calendar commit custody and synthetic onboarding must all select that explicit
current source. Simply accepting a code or issuing a cookie is not completion.
Use narrow current-source lock ports and restricted SQL-role tests; never grant
general Platform mutation privileges to a Customer process.

## Provider and message boundary

Only invitation/sign-in authentication-mail purposes may reach the separately
configured fixed transactional sender through this path. Existing provider
timeouts, receipt validation, encrypted payload/recipient custody, idempotency and
uncertain-delivery state remain. A sender key name does not prove a verified domain
or actual receipt. Sender/recipient setup and real delivery/redemption are separate
operating evidence, never inferred from fixture mail.

Synthetic classification still selects only the network-free synthetic calendar
and approved local media. It cannot reach actual Graph, Exchange, calendar writes,
catering or business notifications. Login-provider identity is distinct from the
fixed simulator's provider-source metadata. REAL paths retain strict eligibility
and never fall back to synthetic data/providers.

## Replacement and history

The latest explicit internal scope requires generation replacement to invalidate
old invitation/challenge/session authority and forbids automatic membership or
invitation carryover into the new generation. Preserve mailbox, identity, role,
invitation, receipt and audit history; preservation is not a new access grant.
Fresh-generation access needs fresh explicit admission.

The conservative reset guard continues denying unsupported canonical membership
history. Only exact newly supported participant bindings may receive a reviewed
generation-invalidating replacement path. Both reset cycles must prove that old
authority fails, all three canonical Demo scenarios remain usable, retained REAL
state is unchanged and no membership is silently rebound to new Tenant IDs.

## Required evidence before completion

Run the full source, security, migration and native PostgreSQL gates plus both
ordinary/protected browser engines and all permanent three-customer/two-reset
browser/storage rows at exact immutable counterparts. Add positive current-owner/
slot cases and negatives for foreign owner/Tenant/slot, unregistered/PROD modes,
revoked/expired/replayed/wrong-browser proof, disabled User/current-role changes,
reset/epoch/concurrent-admission races, fake-persona adoption, audit rollback,
restricted SQL identities and outbound-provider tripwires. Do not substitute
schema shape or WASM database checks for native concurrency or operating evidence.

This draft enables no endpoint, runtime flag, role grant, deployment, live reset,
provider request or mail. Normal Microsoft-managed MFA and the accepted Owner role
baseline remain unchanged. Actual Microsoft365/Exchange acceptance stays later in
the existing owner-directed sequence.
