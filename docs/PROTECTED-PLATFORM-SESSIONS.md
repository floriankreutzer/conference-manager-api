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
