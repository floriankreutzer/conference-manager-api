# Protected Platform session namespace

This prepared factory is uncomposed. It does not activate Microsoft login,
passkeys, a protected runtime, a deployment or an epoch migration. Whole-root
qualification and operational acceptance remain under SaaS1 issue351.

The owned `createProtectedPlatformSessions` factory constructs its hash namespace
from the server-selected dev/int/prod environment and protected deployment UUID
epoch. It additionally retains the existing integer Platform security epoch:

`platform-session:v1:<integer-epoch>:protected-v1:<environment>:<UUID-epoch>:<token>`

The generic Platform service retains its exact legacy default hash bytes. The
protected Customer namespace also retains its exact accepted bytes, including
its independent Customer role-policy epoch. Namespace validation is now a pure
Domain contract shared by the two identity boundaries, rather than a Platform
dependency on Customer session infrastructure.

Only the canonical `microsoft_entra_platform` provider can issue, rotate or resolve
through the owned factory. Customer Microsoft, email and Demo providers fail
closed. The factory exposes no arbitrary hash-prefix override. Current operator,
session expiry/revocation, security version, target scope and role checks remain
with the ordinary authoritative repository. Runtime composition must still hold
the current protected deployment lease and verify its UUID epoch; a hash namespace
alone does not read deployment state or authorize a Platform operation.

Cookie attributes, ordinary CSRF, integer epoch and audit contracts remain
unchanged. Temporary step-up sessions remain internal to existing exact-operation
proof transactions. This change does not make them reusable browser authority or
require two keys for the private temporary session used while enrolling a second
key; the existing passkey service owns business-login and distinct-key policy.

Focused tests cover exact legacy/protected hash bytes, identical-token namespace
separation, DEV/INT/PROD and both epoch changes, provider denial without writes,
CSRF, rotation, revocation and temporary step-up behavior. Closed Demo graph tests
reject direct/transitive imports of the owned protected factory. The native
signed-continuation test additionally exercises it with actual repositories,
max1 pools and the pinned WebAuthn verifier; that extension requires exact-source
CI evidence before acceptance. Software keys do not prove physical-device,
Microsoft-provider, deployed cutover or full protected-root acceptance.

## Prepared owned authentication construction

`createProtectedPlatformAuthentication` parses the existing Platform environment
contract and requires an explicit passkey setup/application profile. Default/live
conditional-access configuration is unchanged. It owns actual audit/operator/
OIDC/session/passkey repositories and the pinned Microsoft primary/WebAuthn
adapters; caller-supplied legacy services or repositories cannot replace them.
It creates no process or installed route. Only the two authentication route
modules are returned; ordinary operations require their separate qualified root.

Both pending Microsoft and pending passkey MAC secrets derive independent fixed
purposes from the external base secret, environment and non-reusable protected
UUID. Integer Platform epoch checks remain independent. This also fences pending
login proofs, whose purpose has no prior-session binding. Persistent audit,
recipient lookup, cipher and abuse-budget keys remain stable. Any operational
profile/integer-epoch cutover must also advance the database UUID and drain old
binaries; new MACs alone cannot stop an old process.

Normal async authentication, enrollment/lifecycle, session resolution/revocation
and operation proof entrypoints acquire/join current shared custody. Their pure
cookie/CSRF/private verified-context functions retain their synchronous contracts.
The public HTTP session service exposes no issuer/rotator and resolves only
current normal application MFA with the configured number of distinct active
credentials: two by default; one only with the explicit protected INT exception.
Optional synthetic generation/delegation remains subject to its separate two-key
custody contract.
It cannot establish independent physical devices with attestation none. Active DEV/INT
add a separate server-only proof service whose mutation transaction uses the
owner-stamped exclusive scope; no outer shared lease may surround that completion.
PROD and setup-only profiles return no synthetic proof service. All protected proof repositories use
fixed referenced-expired-proof retention. No expiry/quota/lifetime is weakened.

The native software acceptance seeds explicitly labelled internal primary
custody, then exercises actual P256 login, max1 shared/RR resolution and UUID
rotation. It must show old pending passkey and Microsoft browser proofs denied
without consumption/provider redemption and old sessions rejected. That fixture
does not prove a real Microsoft sign-in, device/recovery or deployed operation.
Its acceptance remains pending until exact-source CI executes successfully.
