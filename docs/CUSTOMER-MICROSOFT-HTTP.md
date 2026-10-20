# Invited Customer Microsoft HTTP preparation

The prepared route module is explicitly injected through
`customerMicrosoftAuthenticationRouteModule` in `createApp`. Its default is null;
existing runtime entrypoints and legacy behavior are unchanged. Closed Demo
composition rejects the option and architecture checks reject importing the real
module from either Demo root. Protected INT composition must explicitly select
the invited resolver and reject legacy authority before activation.

Existing Host, canonical request target, same-origin, source rate, request ID,
security header, safe error and observability guards run first. The injected
module owns only the following fixed Customer paths. It precedes legacy Microsoft
login/callback handling when selected; no provider URL or route comes from the
browser. It is separate from Microsoft365 integration consent and Platform login.

| Path below `/api/v1/auth/microsoft` | Method | Required authority and response |
| --- | --- | --- |
| `/login` | GET | No query/body; observed socket source fingerprint;302 to fixed Microsoft organizational authority with host-only transaction cookie. |
| `/callback` | GET | Strict bounded single-value code/state or provider-denial fields and original browser cookie;303 to a fixed application ceremony, never a session. |
| `/choices` | GET | Rotated verified browser cookie; minimized accepted membership IDs/labels plus bound CSRF. |
| `/selection` | POST | Same-origin JSON containing only membershipId; cookie-bound flow CSRF;204 plus ordinary session only after atomic current admission. |
| `/link/start` | POST | Empty JSON, actual Customer session and its ordinary session CSRF;200 with fixed authorization URL and new transaction cookie. |
| `/link/confirmation` | GET | Rotated flow cookie and actual current Customer session; fixed confirmation status and flow CSRF only. |
| `/link/confirm` | POST | Same-origin JSON containing only confirm:true, actual same Customer session and separate flow CSRF;204 plus replacement session after atomic dual-proof confirmation. |

GET start permits same-origin interaction and a direct user navigation (`none`);
cross-site starts are rejected. Callback is the sole cross-site navigation
exception. All other reads reject foreign Fetch Metadata/Origin; mutations require
the exact configured Origin. Callback state and browser binding are independent;
provider email/name/role, target Tenant/User, arbitrary return URL and grant
parameters cannot be supplied. Provider denial produces only a fixed failed-login
redirect. Metadata descriptions are bounded and ignored, never logged or echoed.

The callback rotates authorization SameSite=Lax custody into SameSite=Strict
choice/confirmation custody. The application receives no protocol/code/nonce in
its redirect URL. Its subsequent same-origin read obtains the next bound CSRF
from server custody. Ordinary session credentials remain in Secure HttpOnly
host-only cookies; successful admission also clears the transaction cookie.
Authentication responses are no-store and no-referrer. Output validation rejects
foreign provider redirects, malformed/duplicate choices and unsafe session-cookie
attributes before releasing them to the browser.

The source-fingerprint port receives only `request.socket.remoteAddress`; trusted
runtime composition must supply its bounded environment-specific HMAC adapter
and separate key custody. Forwarding headers and browser fields cannot select a
budget identity. Link start uses the ordinary session's CSRF; confirmation uses
the independent flow CSRF and rechecks that exact fresh email-session identity in
the repository. A Microsoft-only or stale session cannot authorize link intent.

The email and Microsoft transports share only output-cookie, bounded JSON, empty
body and flow-CSRF parsing contracts. Their proof, session, membership and provider
authority stay with the existing application/repository owners. The email routes
retain their prior contracts; their HTTP regression suite must pass unchanged.

Local socket HTTP tests use only127.0.0.1 and synthetic ports; they do not follow a
Microsoft URL or establish live provider/TLS/device acceptance. They cover the
new exact routes, both CSRF ceremonies, minimized output, Host/Origin/Fetch
Metadata, query/body/cookie rejection, socket-source authority, fixed safe errors,
disabled composition and existing email regression. Actual native/paired CI,
frontend ceremonies and protected INT runtime acceptance remain separate gates.
No real provider, recipient, credential, migration or deployment is activated by
this preparation.
