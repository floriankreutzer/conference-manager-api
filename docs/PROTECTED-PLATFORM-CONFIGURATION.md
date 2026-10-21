# Owned protected Operations configuration

`loadProtectedPlatformConfiguration` prepares the complete new-prefix Operations
startup bundle after the common protected envelope. It performs no database or
provider request, email, listener, worker, migration, role grant or activation.
Its canonical compatibility input is private and immutable; neither inherited
configuration nor the ordinary conditional-access default is changed.

Production validation remains mandatory in DEV, INT and PROD. Only the validated
protected envelope selects the independent deployment namespace afterward. The
bundle's closed authentication factory owns that mapping, UUID and local input;
callers supply only the two distinct bounded pools. They cannot replace its
environment, session/issuer, identity adapter or pinned passkey verifier. The
existing owned auth factory's explicit namespace mapping is available only with
production validation and no contradictory legacy deployment selector. Existing
legacy callers retain their original strict mode/environment contract.

The public peer client ID must differ from the Operations client. Its authority
is constructed for the exact configured Microsoft directory at the canonical
Microsoft origin. Required assurance is explicitly `passkey_setup` or
`application_passkey`; omitted/conditional-access/unknown values cannot silently
select an alternative. Fresh-primary/protocol bounds remain300 seconds, the
independent integer epoch remains mandatory, and the existing owned verifier and
minimum two actual credentials remain unchanged. Attestation none does not prove
two independent physical devices. Actual keys/recovery and live primary proof
remain separate acceptance.

## Inputs and shared custody

In addition to the envelope, required `PROTECTED_PLATFORM_` suffixes are
`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
`OIDC_TRANSACTION_SECRET`, `CSRF_SECRET`, `AUDIT_HMAC_SECRET`, `CURSOR_SECRET`,
`PASSKEY_TRANSACTION_SECRET`, `ASSURANCE_MODE` and `OWNER_RECIPIENT`.
`OWNER_LOCALE` defaults to de and permits de/en. The owner recipient is explicit
customer-onboarding input; it never grants Platform authority or comes from an
email/Microsoft claim. No actual owner is supplied or inferred by source tests.
Host, port and session lifetime have bounded optional inputs.

Common required input is the public peer ID/service version, Tenant audit value
and retained encrypted-custody keyring/active ID/stable lookup value. The shared
cipher-construction adapter now owns canonical bounded keyring decoding, key
copying and temporary-buffer wiping for both surfaces. The previous Customer
checks and actual old-key decryption/lookup rotation tests remain intact.
Cross-surface tests encrypt/decrypt an actual envelope with shared custody while
keeping Customer and Platform authentication/Platform audit material separate.
Complete deployment must verify all independent per-surface values and allow only
the intentionally shared custody/Tenant-audit/handoff purposes.

Within each bundle all authentication/custody purposes are distinct, including
the database password. DEV/INT synthetic use additionally needs explicit active
application-passkey mode and distinct shared `PROTECTED_HANDOFF_SECRET` plus
own `HANDOFF_INTENT_SECRET`. Inactive extra keys and every PROD synthetic opt-in
are refused. The process root must still omit synthetic route/service activation
when the flag is false. Configuration constructs no generation or delegation.
Operations receives no Customer credential, mail adapter or Customer auth secret.

## Boundaries and verification

The architecture policy classifies this exact top-level config module as an
Operations construction owner. Its own control-plane config import is approved;
Customer composition and all lower layers remain forbidden consumers. Both Demo
graphs stay excluded. Shared custody construction remains a private composition
component. Negative graph tests preserve these restrictions; no prefix-wide
exception is introduced.

Focused tests cover all three production-mode namespaces through the actual
owned auth constructor, closed factory context, explicit setup/active/PROD
posture, input immutability, missing owner, malformed/accessor/unknown/foreign
values, peer/secret aliases, shared cipher compatibility and dependency direction.
They perform no construction-time database/provider work. Full frozen checks and
exact-source CI remain required. Complete process roots, real role bootstrap,
SIM/provider/media/frontend/cross-site browser acceptance and coordinated old
traffic/drain/credential/UUID cutover remain open under SaaS1 issue351.
