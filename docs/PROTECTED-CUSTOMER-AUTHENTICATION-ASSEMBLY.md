# Owned protected Customer authentication assembly

`createProtectedCustomerAuthentication` joins the existing protected invited
email/Microsoft factories and the optional consumed-handoff factory with the
normal Customer business authentication port. It constructs those factories
itself; it accepts no arbitrary session service, issuer or membership policy.
No entrypoint, provider, email worker, migration or rollout is activated here.
Whole protected INT acceptance remains under application SaaS1 issue351.

The normal HTTP port contains only resolve, revoke, CSRF verification/projection
and cookie clearing. Generic OIDC/JIT/onboarding and issue/rotate ports remain
unavailable when this port is passed to the canonical Customer composition.
The factory requires the exact original config/persistence objects, fixes the
deployment environment/UUID, and owns separate bounded business/lease scopes.
Normal resolution/revocation acquire or join the current shared lease. The full
HTTP handler must still hold its own shared lease throughout all business work.

REAL admission keeps its invited email/fresh Microsoft proof, explicit linking,
same-transaction membership/session and current REAL qualification. Delegation
keeps its separate signed exact-proof/consumed-code protocol and originating
Platform-session/generation checks. Both use the same protected Customer session
namespace, CSRF secret and ordinary cookie. The delegation factory's existing
combined resolver dispatches to current REAL membership or current synthetic
delegation custody. The assembly exposes neither factory's private issuers.

Email and Customer invitation routes are always included. Microsoft routes are
included only with the explicitly supplied canonical Microsoft client. Synthetic
routes require exact separate handoff configuration and are denied in PROD.
This optional client is a trusted server adapter port, not browser input; the
final process root must construct the actual fresh organizational client itself.
No Platform session or audit secret is required by this Customer assembly.

Architecture gates register the assembly as a production composition root and
protected authority. Domain/application/HTTP/persistence/provider/Platform
imports and either closed Demo import graph cannot consume it. Its production
graph cannot reach Demo or offline passkey issuance. No gate exception is added.

Five focused cases cover closed session output, context identity, no generic
authentication, all three REAL environments, explicit Microsoft routes without
construction-time I/O, malformed scope/pools/configuration and dependency gates.
The existing native two-surface HTTP test now uses this assembly through the
canonical business authentication contract and actual Customer app/shared HTTP
execution handler. It additionally performs actual email HTTP challenge/code/
choice/admission, validates that cookie through the same normal resolver, denies
a legacy cookie and leaves invited access valid after the unrelated signed
delegation/source-revocation/reset journey. All original switch/logout/concurrent
completion, actual P256 proof, retained history and audit assertions remain.
That native test requires exact-source CI execution; prepared source is not a
passing execution claim. Its explicit network-free providers and software keys
are not live Microsoft, physical-device or cross-site browser acceptance.

Complete environment/secret configuration, provider-mode/SIM/media integration,
actual owned process roots, protected frontend serving and browser progression,
verified sender/explicit owner, keys/recovery and coordinated old-process/UUID/
credential cutover remain necessary. Existing closed Demo acceptance and all
four permanent paired three-customer/two-reset gates remain mandatory.
